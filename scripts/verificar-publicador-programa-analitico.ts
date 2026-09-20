// scripts/verificar-publicador-programa-analitico.ts
//
// Prueba aislada (sin credenciales, sin red) del publicador canónico
// del Programa Analítico — PA-3A. Mismo doble mínimo de SupabaseClient
// que scripts/verificar-resolver-contexto-curricular.ts (extendido con
// .in()). La ejecución real de la RPC transaccional
// (public.programa_analitico_publicar) se prueba aparte, contra
// Supabase real dentro de BEGIN...ROLLBACK — ver el reporte de PA-3A.
//
// Se ejecuta con `npx tsx scripts/verificar-publicador-programa-analitico.ts`.

import type { SupabaseClient } from '@supabase/supabase-js'
import { publicarProgramaAnalitico, validarEstructuraPropuesta } from '../lib/programaAnalitico/publicarProgramaAnalitico'
import type { PropuestaProgramaAnalitico } from '../lib/programaAnalitico/tipos'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

// --- Mismo doble mínimo de SupabaseClient que los demás scripts de esta serie. ---
type Fila = Record<string, unknown>

class ConsultaFalsa {
  private filtros: Array<[string, unknown]> = []
  private filtrosIn: Array<[string, unknown[]]> = []
  constructor(private cliente: ClienteSupabaseFalso, private tabla: string) {}
  select(_c: string) { void _c; return this }
  eq(c: string, v: unknown) { this.filtros.push([c, v]); return this }
  in(c: string, vs: unknown[]) { this.filtrosIn.push([c, vs]); return this }
  private ejecutar(): { data: Fila[] | null; error: { message: string } | null } {
    const filas = this.cliente._tabla(this.tabla)
    const resultado = filas.filter((f) => {
      if (!this.filtros.every(([c, v]) => f[c] === v)) return false
      if (!this.filtrosIn.every(([c, vs]) => vs.includes(f[c]))) return false
      return true
    })
    return { data: resultado, error: null }
  }
  async maybeSingle() {
    const { data, error } = this.ejecutar()
    if (error) return { data: null, error }
    return { data: data && data.length > 0 ? data[0] : null, error: null }
  }
  then<T1 = unknown, T2 = never>(
    onf?: ((v: { data: Fila[] | null; error: { message: string } | null }) => T1 | PromiseLike<T1>) | null,
    onr?: ((r: unknown) => T2 | PromiseLike<T2>) | null,
  ): Promise<T1 | T2> {
    return Promise.resolve(this.ejecutar()).then(onf, onr)
  }
}

class ClienteSupabaseFalso {
  private tablas = new Map<string, Fila[]>()
  public rpcLlamado: { nombre: string; params: Record<string, unknown> } | null = null
  private rpcRespuesta: { data: unknown; error: { message: string } | null }
  constructor(datos: Record<string, Fila[]> = {}, rpcRespuesta?: { data: unknown; error: { message: string } | null }) {
    for (const [t, fs] of Object.entries(datos)) this.tablas.set(t, fs.map((f) => ({ ...f })))
    this.rpcRespuesta = rpcRespuesta ?? { data: { programaAnaliticoId: 'pa-1', programaAnaliticoVersionId: 'v-1', numeroVersion: 1, reutilizadaPorIdempotencia: false }, error: null }
  }
  from(tabla: string) { return new ConsultaFalsa(this, tabla) }
  async rpc(nombre: string, params: Record<string, unknown>) {
    this.rpcLlamado = { nombre, params }
    return this.rpcRespuesta
  }
  _tabla(tabla: string): Fila[] {
    if (!this.tablas.has(tabla)) this.tablas.set(tabla, [])
    return this.tablas.get(tabla)!
  }
}

function clienteFalso(datos: Record<string, Fila[]> = {}): { sb: SupabaseClient; interno: ClienteSupabaseFalso } {
  const interno = new ClienteSupabaseFalso(datos)
  return { sb: interno as unknown as SupabaseClient, interno }
}

// --- Fixture: mismo contexto curricular real ya usado en PA-2B/2C
//     (grado 4 primaria, fase_4, versión vigente para simplificar). ---
const GRADO_ID = 'grado-4-real'
const FASE_ID = 'fase-4-real'
const VERSION_ID = 'version-1'
const CONTENIDO_ID = 'contenido-narracion'
const CONTENIDO_OTRA_VERSION_ID = 'contenido-otra-version'
const CAMPO_ID = 'campo-lenguajes'
const PDA_GRADO_1 = 'pda-grado-1'
const PDA_GRADO_OTRO_GRADO = 'pda-grado-otro-grado'
const PDA_GRADO_OTRO_CONTENIDO = 'pda-grado-otro-contenido'
const CICLO_ID = 'ciclo-actual'
const PERIODO_MISMO_CICLO = 'periodo-mismo-ciclo'
const PERIODO_OTRO_CICLO = 'periodo-otro-ciclo'

function fixtureBase(overrides: Partial<Record<string, Fila[]>> = {}): Record<string, Fila[]> {
  return {
    grupos: [{ id: 'grupo-4b', ciclo_escolar_id: CICLO_ID, nivel_educativo: 'primaria', grado: '4' }],
    curriculo_grado: [{ id: GRADO_ID, nivel_educativo: 'primaria', clave: '4' }],
    curriculo_fase_grado: [{ curriculo_grado_id: GRADO_ID, curriculo_fase_id: FASE_ID }],
    curriculo_fase: [{ id: FASE_ID, clave: 'fase_4', curriculo_version_id: VERSION_ID }],
    curriculo_version: [{ id: VERSION_ID, estado: 'vigente' }],
    curriculo_campo_formativo: [{ id: CAMPO_ID, clave: 'lenguajes', nombre: 'Lenguajes', curriculo_version_id: VERSION_ID }],
    curriculo_cobertura: [{ curriculo_version_id: VERSION_ID, fase_id: FASE_ID, grado_id: GRADO_ID, campo_formativo_id: CAMPO_ID }],
    curriculo_contenido: [
      { id: CONTENIDO_ID, campo_formativo_id: CAMPO_ID, curriculo_version_id: VERSION_ID },
      { id: CONTENIDO_OTRA_VERSION_ID, campo_formativo_id: CAMPO_ID, curriculo_version_id: 'otra-version' },
    ],
    curriculo_pda_grado: [
      { id: PDA_GRADO_1, contenido_id: CONTENIDO_ID, curriculo_grado_id: GRADO_ID, curriculo_version_id: VERSION_ID },
      { id: PDA_GRADO_OTRO_GRADO, contenido_id: CONTENIDO_ID, curriculo_grado_id: 'otro-grado', curriculo_version_id: VERSION_ID },
      { id: PDA_GRADO_OTRO_CONTENIDO, contenido_id: 'otro-contenido', curriculo_grado_id: GRADO_ID, curriculo_version_id: VERSION_ID },
    ],
    periodos_evaluacion: [
      { id: PERIODO_MISMO_CICLO, ciclo_escolar_id: CICLO_ID },
      { id: PERIODO_OTRO_CICLO, ciclo_escolar_id: 'otro-ciclo' },
    ],
    ...overrides,
  }
}

function propuestaBase(items: PropuestaProgramaAnalitico['items']): PropuestaProgramaAnalitico {
  return { grupoId: 'grupo-4b', idempotencyKey: 'key-test-1', contextoNotas: null, items }
}

async function main() {
  // --- 1. sin_ajuste válido ---
  {
    const { sb, interno } = clienteFalso(fixtureBase())
    const propuesta = propuestaBase([
      { claveLocal: 'a', tipoDecision: 'sin_ajuste', curriculoContenidoId: CONTENIDO_ID, orden: 1, curriculoPdaGradoIds: [PDA_GRADO_1] },
    ])
    const r = await publicarProgramaAnalitico(sb, propuesta)
    verificar(r.ok === true, '1. sin_ajuste válido publica ok:true')
    verificar(interno.rpcLlamado?.nombre === 'programa_analitico_publicar', '1b. invoca la RPC correcta')
  }

  // --- 2. contextualizado válido ---
  {
    const { sb } = clienteFalso(fixtureBase())
    const propuesta = propuestaBase([
      { claveLocal: 'a', tipoDecision: 'contextualizado', curriculoContenidoId: CONTENIDO_ID, textoContextualizado: 'Ajustado al contexto local.', orden: 1, curriculoPdaGradoIds: [] },
    ])
    const r = await publicarProgramaAnalitico(sb, propuesta)
    verificar(r.ok === true, '2. contextualizado válido publica ok:true')
  }

  // --- 3. nuevo válido ---
  {
    const { sb } = clienteFalso(fixtureBase())
    const propuesta = propuestaBase([
      { claveLocal: 'a', tipoDecision: 'nuevo', textoLocal: 'Contenido local de la región.', resultadoEsperadoLocal: 'El alumno identifica X.', orden: 1, curriculoPdaGradoIds: [] },
    ])
    const r = await publicarProgramaAnalitico(sb, propuesta)
    verificar(r.ok === true, '3. nuevo válido publica ok:true')
  }

  // --- 4. contenido de otra versión → rechazo ---
  {
    const { sb } = clienteFalso(fixtureBase())
    const propuesta = propuestaBase([
      { claveLocal: 'a', tipoDecision: 'sin_ajuste', curriculoContenidoId: CONTENIDO_OTRA_VERSION_ID, orden: 1, curriculoPdaGradoIds: [] },
    ])
    const r = await publicarProgramaAnalitico(sb, propuesta)
    verificar(!r.ok && r.error.tipo === 'CONTENIDO_NO_PERTENECE_AL_CONTEXTO', '4. contenido de otra versión → CONTENIDO_NO_PERTENECE_AL_CONTEXTO')
  }

  // --- 5. PDA de otro grado → rechazo ---
  {
    const { sb } = clienteFalso(fixtureBase())
    const propuesta = propuestaBase([
      { claveLocal: 'a', tipoDecision: 'sin_ajuste', curriculoContenidoId: CONTENIDO_ID, orden: 1, curriculoPdaGradoIds: [PDA_GRADO_OTRO_GRADO] },
    ])
    const r = await publicarProgramaAnalitico(sb, propuesta)
    verificar(!r.ok && r.error.tipo === 'PDA_NO_PERTENECE_AL_ITEM', '5. PDA de otro grado → PDA_NO_PERTENECE_AL_ITEM')
  }

  // --- 6. PDA de otro contenido → rechazo ---
  {
    const { sb } = clienteFalso(fixtureBase())
    const propuesta = propuestaBase([
      { claveLocal: 'a', tipoDecision: 'sin_ajuste', curriculoContenidoId: CONTENIDO_ID, orden: 1, curriculoPdaGradoIds: [PDA_GRADO_OTRO_CONTENIDO] },
    ])
    const r = await publicarProgramaAnalitico(sb, propuesta)
    verificar(!r.ok && r.error.tipo === 'PDA_NO_PERTENECE_AL_ITEM', '6. PDA de otro contenido → PDA_NO_PERTENECE_AL_ITEM')
  }

  // --- 7. nuevo con PDA → rechazo (estructura pura) ---
  {
    const propuesta = propuestaBase([
      { claveLocal: 'a', tipoDecision: 'nuevo', textoLocal: 'x', orden: 1, curriculoPdaGradoIds: [PDA_GRADO_1] },
    ])
    const errores = validarEstructuraPropuesta(propuesta)
    verificar(errores.some((e) => e.tipo === 'ITEM_NUEVO_CON_PDA'), '7. nuevo con PDA → ITEM_NUEVO_CON_PDA')
  }

  // --- 8. periodo de otro ciclo → rechazo ---
  {
    const { sb } = clienteFalso(fixtureBase())
    const propuesta = propuestaBase([
      { claveLocal: 'a', tipoDecision: 'sin_ajuste', curriculoContenidoId: CONTENIDO_ID, periodoEvaluacionId: PERIODO_OTRO_CICLO, orden: 1, curriculoPdaGradoIds: [] },
    ])
    const r = await publicarProgramaAnalitico(sb, propuesta)
    verificar(!r.ok && r.error.tipo === 'PERIODO_DE_OTRO_CICLO', '8. periodo de otro ciclo → PERIODO_DE_OTRO_CICLO')
  }
  {
    const { sb } = clienteFalso(fixtureBase())
    const propuesta = propuestaBase([
      { claveLocal: 'a', tipoDecision: 'sin_ajuste', curriculoContenidoId: CONTENIDO_ID, periodoEvaluacionId: PERIODO_MISMO_CICLO, orden: 1, curriculoPdaGradoIds: [] },
    ])
    const r = await publicarProgramaAnalitico(sb, propuesta)
    verificar(r.ok === true, '8b. periodo del mismo ciclo se acepta')
  }

  // --- 9. texto contextualizado vacío → rechazo (estructura pura) ---
  {
    const propuesta = propuestaBase([
      { claveLocal: 'a', tipoDecision: 'contextualizado', curriculoContenidoId: CONTENIDO_ID, textoContextualizado: '   ', orden: 1, curriculoPdaGradoIds: [] },
    ])
    const errores = validarEstructuraPropuesta(propuesta)
    verificar(errores.some((e) => e.tipo === 'ITEM_CONTEXTUALIZADO_TEXTO_VACIO'), '9. texto contextualizado vacío/blanco → ITEM_CONTEXTUALIZADO_TEXTO_VACIO')
  }

  // --- 10. texto local vacío → rechazo (estructura pura) ---
  {
    const propuesta = propuestaBase([
      { claveLocal: 'a', tipoDecision: 'nuevo', textoLocal: '', orden: 1, curriculoPdaGradoIds: [] },
    ])
    const errores = validarEstructuraPropuesta(propuesta)
    verificar(errores.some((e) => e.tipo === 'ITEM_NUEVO_TEXTO_VACIO'), '10. texto local vacío → ITEM_NUEVO_TEXTO_VACIO')
  }

  // --- 11. orden duplicado → rechazo (estructura pura) ---
  {
    const propuesta = propuestaBase([
      { claveLocal: 'a', tipoDecision: 'nuevo', textoLocal: 'x', orden: 1, curriculoPdaGradoIds: [] },
      { claveLocal: 'b', tipoDecision: 'nuevo', textoLocal: 'y', orden: 1, curriculoPdaGradoIds: [] },
    ])
    const errores = validarEstructuraPropuesta(propuesta)
    verificar(errores.some((e) => e.tipo === 'ORDEN_DUPLICADO'), '11. orden duplicado → ORDEN_DUPLICADO')
  }

  // --- 12. contextoNotas vacío → rechazo (contrato elegido: null o
  //         texto explícito no vacío, nunca cadena en blanco). ---
  {
    const propuesta: PropuestaProgramaAnalitico = {
      grupoId: 'grupo-4b', idempotencyKey: 'k', contextoNotas: '   ',
      items: [{ claveLocal: 'a', tipoDecision: 'nuevo', textoLocal: 'x', orden: 1, curriculoPdaGradoIds: [] }],
    }
    const errores = validarEstructuraPropuesta(propuesta)
    verificar(errores.some((e) => e.tipo === 'CONTEXTO_NOTAS_VACIO'), '12. contextoNotas en blanco → CONTEXTO_NOTAS_VACIO (rechazo, no normalización silenciosa)')
    const propuestaNull: PropuestaProgramaAnalitico = { ...propuesta, contextoNotas: null }
    verificar(validarEstructuraPropuesta(propuestaNull).length === 0, '12b. contextoNotas=null se acepta')
  }

  // --- refuerzos: resultado_esperado_local fuera de 'nuevo', y
  //     resultado_esperado_local vacío. ---
  {
    const propuesta = propuestaBase([
      { claveLocal: 'a', tipoDecision: 'sin_ajuste', curriculoContenidoId: CONTENIDO_ID, resultadoEsperadoLocal: 'no permitido aquí', orden: 1, curriculoPdaGradoIds: [] },
    ])
    const errores = validarEstructuraPropuesta(propuesta)
    verificar(errores.some((e) => e.tipo === 'ITEM_RESULTADO_ESPERADO_NO_PERMITIDO'), 'extra. resultado_esperado_local en sin_ajuste → rechazo')
  }
  {
    const propuesta = propuestaBase([
      { claveLocal: 'a', tipoDecision: 'nuevo', textoLocal: 'x', resultadoEsperadoLocal: '  ', orden: 1, curriculoPdaGradoIds: [] },
    ])
    const errores = validarEstructuraPropuesta(propuesta)
    verificar(errores.some((e) => e.tipo === 'ITEM_RESULTADO_ESPERADO_VACIO'), 'extra. resultado_esperado_local en blanco → rechazo')
  }

  console.log(fallos === 0 ? `\n✓ Todo correcto (0 fallos).` : `\n✗ ${fallos} fallo(s).`)
  process.exit(fallos === 0 ? 0 : 1)
}

main()
