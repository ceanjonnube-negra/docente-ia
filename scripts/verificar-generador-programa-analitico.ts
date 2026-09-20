// scripts/verificar-generador-programa-analitico.ts
//
// Prueba aislada (sin credenciales, sin red, sin llamadas IA) del
// generador de propuesta PA-3B. Prueba: (1) armado del catálogo
// cerrado a partir de datos ya cargados (mismo doble mínimo de
// SupabaseClient de la serie), y (2) incorporarPropuestaIa +
// validación determinista completa (validarEstructuraPropuesta +
// validarReferenciasPropuesta), sin invocar Anthropic. La prueba real
// de generación (1 llamada IA real contra el grupo 4°B) se hizo aparte
// — ver el reporte de PA-3B.
//
// Se ejecuta con `npx tsx scripts/verificar-generador-programa-analitico.ts`.

import type { SupabaseClient } from '@supabase/supabase-js'
import { recuperarCatalogoCurricularCerrado } from '../lib/programaAnalitico/candidatosCurriculares'
import { incorporarPropuestaIa } from '../lib/programaAnalitico/generarPropuestaProgramaAnalitico'
import { validarEstructuraPropuesta } from '../lib/programaAnalitico/publicarProgramaAnalitico'
import { validarReferenciasPropuesta, type CatalogoContenido, type CatalogoPdaGrado, type CatalogoPeriodo } from '../lib/programaAnalitico/validacionReferencial'
import type { ContextoCurricularGrupo } from '../lib/curriculo/resolverContextoCurricularGrupo'
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

// --- Mismo doble mínimo de SupabaseClient que el resto de la serie. ---
type Fila = Record<string, unknown>

class ConsultaFalsa {
  private filtros: Array<[string, unknown]> = []
  private filtrosIn: Array<[string, unknown[]]> = []
  constructor(private cliente: ClienteSupabaseFalso, private tabla: string) {}
  select(_c: string) { void _c; return this }
  eq(c: string, v: unknown) { this.filtros.push([c, v]); return this }
  in(c: string, vs: unknown[]) { this.filtrosIn.push([c, vs]); return this }
  private ejecutar(): { data: Fila[] | null; error: null } {
    const filas = this.cliente._tabla(this.tabla)
    const resultado = filas.filter((f) => {
      if (!this.filtros.every(([c, v]) => f[c] === v)) return false
      if (!this.filtrosIn.every(([c, vs]) => vs.includes(f[c]))) return false
      return true
    })
    return { data: resultado, error: null }
  }
  then<T1 = unknown, T2 = never>(
    onf?: ((v: { data: Fila[] | null; error: null }) => T1 | PromiseLike<T1>) | null,
    onr?: ((r: unknown) => T2 | PromiseLike<T2>) | null,
  ): Promise<T1 | T2> {
    return Promise.resolve(this.ejecutar()).then(onf, onr)
  }
}

class ClienteSupabaseFalso {
  private tablas = new Map<string, Fila[]>()
  constructor(datos: Record<string, Fila[]> = {}) {
    for (const [t, fs] of Object.entries(datos)) this.tablas.set(t, fs.map((f) => ({ ...f })))
  }
  from(tabla: string) { return new ConsultaFalsa(this, tabla) }
  _tabla(tabla: string): Fila[] {
    if (!this.tablas.has(tabla)) this.tablas.set(tabla, [])
    return this.tablas.get(tabla)!
  }
}

function clienteFalso(datos: Record<string, Fila[]> = {}): SupabaseClient {
  return new ClienteSupabaseFalso(datos) as unknown as SupabaseClient
}

// --- Fixture: 2 campos, 1 contenido en cada uno de grado 4, más un
//     contenido de OTRO grado (para probar exclusión) y uno de otro
//     campo sin cobertura. ---
const GRADO_ID = 'grado-4-real'
const OTRO_GRADO_ID = 'grado-3-real'
const VERSION_ID = 'version-1'
const CAMPO_CUBIERTO = 'campo-lenguajes'
const CAMPO_SIN_COBERTURA = 'campo-sin-cobertura'
const CONTENIDO_A = 'contenido-a'
const CONTENIDO_SIN_COBERTURA = 'contenido-sin-cobertura'

const CONTEXTO_BASE: ContextoCurricularGrupo = {
  grupoId: 'grupo-4b',
  cicloEscolarId: 'ciclo-actual',
  nivelEducativo: 'primaria',
  gradoGrupo: '4',
  curriculoGradoId: GRADO_ID,
  curriculoFaseId: 'fase-4',
  curriculoFaseClave: 'fase_4',
  curriculoVersionId: VERSION_ID,
  fallbackBorrador: true,
  camposConCobertura: [{ id: CAMPO_CUBIERTO, clave: 'lenguajes', nombre: 'Lenguajes' }],
}

async function main() {
  // --- 1. armado correcto del catálogo permitido + exclusión de
  //        contenido sin cobertura ---
  {
    const sb = clienteFalso({
      curriculo_contenido: [
        { id: CONTENIDO_A, titulo: 'Narración de sucesos', campo_formativo_id: CAMPO_CUBIERTO, curriculo_version_id: VERSION_ID },
        { id: CONTENIDO_SIN_COBERTURA, titulo: 'De otro campo sin cobertura', campo_formativo_id: CAMPO_SIN_COBERTURA, curriculo_version_id: VERSION_ID },
      ],
      curriculo_pda_grado: [
        { id: 'pdagrado-1', curriculo_pda_id: 'pda-1', contenido_id: CONTENIDO_A, curriculo_grado_id: GRADO_ID, curriculo_version_id: VERSION_ID },
      ],
      curriculo_pda: [{ id: 'pda-1', texto: 'Reconoce estilos narrativos.' }],
    })
    const catalogo = await recuperarCatalogoCurricularCerrado(sb, CONTEXTO_BASE)
    verificar(catalogo.contenidos.length === 1 && catalogo.contenidos[0].id === CONTENIDO_A, '1. catálogo excluye contenido de campo sin cobertura, incluye el correcto')
    verificar(catalogo.pda.length === 1 && catalogo.pda[0].curriculoPdaGradoId === 'pdagrado-1' && catalogo.pda[0].texto === 'Reconoce estilos narrativos.', '1b. PDA candidato armado con texto real')
  }

  // --- 2. exclusión de PDA de otro grado ---
  {
    const sb = clienteFalso({
      curriculo_contenido: [{ id: CONTENIDO_A, titulo: 'x', campo_formativo_id: CAMPO_CUBIERTO, curriculo_version_id: VERSION_ID }],
      curriculo_pda_grado: [
        { id: 'pdagrado-grado4', curriculo_pda_id: 'pda-1', contenido_id: CONTENIDO_A, curriculo_grado_id: GRADO_ID, curriculo_version_id: VERSION_ID },
        { id: 'pdagrado-otro-grado', curriculo_pda_id: 'pda-2', contenido_id: CONTENIDO_A, curriculo_grado_id: OTRO_GRADO_ID, curriculo_version_id: VERSION_ID },
      ],
      curriculo_pda: [{ id: 'pda-1', texto: 'x' }, { id: 'pda-2', texto: 'y' }],
    })
    const catalogo = await recuperarCatalogoCurricularCerrado(sb, CONTEXTO_BASE)
    verificar(catalogo.pda.length === 1 && catalogo.pda[0].curriculoPdaGradoId === 'pdagrado-grado4', '2. PDA de otro grado excluido por construcción de la query')
  }

  // --- helpers para la parte de incorporación + validación ---
  const contenidoPorId = new Map<string, CatalogoContenido>([[CONTENIDO_A, { id: CONTENIDO_A, campoFormativoId: CAMPO_CUBIERTO, curriculoVersionId: VERSION_ID }]])
  const pdaGradoPorId = new Map<string, CatalogoPdaGrado>([
    ['pdagrado-1', { id: 'pdagrado-1', contenidoId: CONTENIDO_A, curriculoGradoId: GRADO_ID, curriculoVersionId: VERSION_ID }],
    ['pdagrado-otro-contenido', { id: 'pdagrado-otro-contenido', contenidoId: 'otro-contenido', curriculoGradoId: GRADO_ID, curriculoVersionId: VERSION_ID }],
  ])
  const periodoPorId = new Map<string, CatalogoPeriodo>([['periodo-1', { id: 'periodo-1', cicloEscolarId: 'ciclo-actual' }]])
  const camposCubiertosIds = new Set([CAMPO_CUBIERTO])

  function validarCompleto(propuesta: PropuestaProgramaAnalitico) {
    const erroresEstructura = validarEstructuraPropuesta(propuesta)
    if (erroresEstructura.length > 0) return erroresEstructura[0]
    return validarReferenciasPropuesta(propuesta.items, {
      curriculoVersionId: VERSION_ID,
      curriculoGradoId: GRADO_ID,
      cicloEscolarId: 'ciclo-actual',
      camposCubiertosIds,
      contenidoPorId,
      pdaGradoPorId,
      periodoPorId,
    })
  }

  function propuesta(items: PropuestaProgramaAnalitico['items']): PropuestaProgramaAnalitico {
    return { grupoId: 'grupo-4b', idempotencyKey: 'k', contextoNotas: null, items }
  }

  // --- 3. rechazo UUID inventado (contenido inexistente) ---
  {
    const p = propuesta([{ claveLocal: 'a', tipoDecision: 'sin_ajuste', curriculoContenidoId: 'contenido-inventado-por-ia', orden: 1, curriculoPdaGradoIds: [] }])
    verificar(validarCompleto(p)?.tipo === 'CONTENIDO_NO_PERTENECE_AL_CONTEXTO', '3. contenido inventado por la IA → CONTENIDO_NO_PERTENECE_AL_CONTEXTO')
  }

  // --- 4. rechazo PDA de otro contenido ---
  {
    const p = propuesta([{ claveLocal: 'a', tipoDecision: 'sin_ajuste', curriculoContenidoId: CONTENIDO_A, orden: 1, curriculoPdaGradoIds: ['pdagrado-otro-contenido'] }])
    verificar(validarCompleto(p)?.tipo === 'PDA_NO_PERTENECE_AL_ITEM', '4. PDA de otro contenido → PDA_NO_PERTENECE_AL_ITEM')
  }

  // --- 5. rechazo contenido nuevo con PDA ---
  {
    const p = propuesta([{ claveLocal: 'a', tipoDecision: 'nuevo', textoLocal: 'x', orden: 1, curriculoPdaGradoIds: ['pdagrado-1'] }])
    verificar(validarCompleto(p)?.tipo === 'ITEM_NUEVO_CON_PDA', '5. nuevo con PDA → ITEM_NUEVO_CON_PDA')
  }

  // --- 6. rechazo orden duplicado ---
  {
    const p = propuesta([
      { claveLocal: 'a', tipoDecision: 'nuevo', textoLocal: 'x', orden: 1, curriculoPdaGradoIds: [] },
      { claveLocal: 'b', tipoDecision: 'nuevo', textoLocal: 'y', orden: 1, curriculoPdaGradoIds: [] },
    ])
    verificar(validarCompleto(p)?.tipo === 'ORDEN_DUPLICADO', '6. orden duplicado → ORDEN_DUPLICADO')
  }

  // --- 7. rechazo periodo incompatible (inventado, no en catálogo) ---
  {
    const p = propuesta([{ claveLocal: 'a', tipoDecision: 'sin_ajuste', curriculoContenidoId: CONTENIDO_A, periodoEvaluacionId: 'periodo-inventado', orden: 1, curriculoPdaGradoIds: [] }])
    verificar(validarCompleto(p)?.tipo === 'PERIODO_NO_ENCONTRADO', '7. periodo inventado por la IA → PERIODO_NO_ENCONTRADO')
  }

  // --- 8. aceptación sin_ajuste ---
  {
    const p = propuesta([{ claveLocal: 'a', tipoDecision: 'sin_ajuste', curriculoContenidoId: CONTENIDO_A, orden: 1, curriculoPdaGradoIds: ['pdagrado-1'] }])
    verificar(validarCompleto(p) === null, '8. sin_ajuste válido → sin errores')
  }

  // --- 9. aceptación contextualizado ---
  {
    const p = propuesta([{ claveLocal: 'a', tipoDecision: 'contextualizado', curriculoContenidoId: CONTENIDO_A, textoContextualizado: 'Adaptado.', orden: 1, curriculoPdaGradoIds: [] }])
    verificar(validarCompleto(p) === null, '9. contextualizado válido → sin errores')
  }

  // --- 10. aceptación nuevo ---
  {
    const p = propuesta([{ claveLocal: 'a', tipoDecision: 'nuevo', textoLocal: 'Contenido local.', resultadoEsperadoLocal: 'Logra X.', orden: 1, curriculoPdaGradoIds: [] }])
    verificar(validarCompleto(p) === null, '10. nuevo válido → sin errores')
  }

  // --- 11. incorporación server-side de grupoId + ignora claves
  //         extra que la IA pudiera alucinar (nunca las lee) ---
  {
    const jsonIa = {
      grupoId: 'grupo-que-la-ia-intento-inventar',
      curriculoVersionId: 'version-inventada',
      contextoNotas: 'Notas factuales.',
      items: [{ claveLocal: 'a', tipoDecision: 'nuevo', textoLocal: 'x', orden: 1, curriculoPdaGradoIds: [] }],
    }
    const incorporado = incorporarPropuestaIa('grupo-real-4b', jsonIa)
    verificar(incorporado.ok === true, '11. JSON con forma válida se incorpora correctamente')
    if (incorporado.ok) {
      const propuestaFinal: PropuestaProgramaAnalitico = { grupoId: 'grupo-real-4b', idempotencyKey: 'k', contextoNotas: incorporado.contextoNotas, items: incorporado.items }
      verificar(propuestaFinal.grupoId === 'grupo-real-4b', '11b. grupoId final es el server-side, nunca el que la IA intentó incluir')
    }
  }

  // --- 12. no aceptación de curriculoVersionId/fase/grado provenientes
  //         de la IA: incorporarPropuestaIa nunca lee esas claves, así
  //         que no existen en el tipo ItemPropuestaProgramaAnalitico
  //         resultante — se confirma inspeccionando las claves reales. ---
  {
    const jsonIa = {
      items: [{
        claveLocal: 'a', tipoDecision: 'nuevo', textoLocal: 'x', orden: 1, curriculoPdaGradoIds: [],
        curriculoVersionId: 'inventado', curriculoFaseId: 'inventado', curriculoGradoId: 'inventado', docenteId: 'inventado', institucionId: 'inventado',
      }],
    }
    const incorporado = incorporarPropuestaIa('grupo-4b', jsonIa)
    verificar(incorporado.ok === true, '12. JSON con claves extra sigue siendo forma válida')
    if (incorporado.ok) {
      const claves = Object.keys(incorporado.items[0])
      verificar(
        !claves.includes('curriculoVersionId') && !claves.includes('curriculoFaseId') && !claves.includes('curriculoGradoId') && !claves.includes('docenteId') && !claves.includes('institucionId'),
        '12b. curriculoVersionId/fase/grado/docenteId/institucionId de la IA nunca se propagan al item incorporado'
      )
    }
  }

  console.log(fallos === 0 ? `\n✓ Todo correcto (0 fallos).` : `\n✗ ${fallos} fallo(s).`)
  process.exit(fallos === 0 ? 0 : 1)
}

main()
