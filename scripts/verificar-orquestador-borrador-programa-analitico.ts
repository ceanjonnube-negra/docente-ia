// scripts/verificar-orquestador-borrador-programa-analitico.ts
//
// Prueba aislada (sin credenciales, sin red, sin IA) del orquestador
// server-side de borradores — PA-4C
// (lib/programaAnalitico/orquestarBorrador.ts). Cubre la lógica de
// negocio pura con un doble mínimo de SupabaseClient extendido con
// insert/update/auth.getUser(). Los casos que dependen de garantías
// REALES de Postgres (RLS entre docentes distintos, UNIQUE parcial
// bajo concurrencia real, atomicidad de la RPC, grants) se probaron
// aparte contra Supabase real dentro de BEGIN...ROLLBACK — ver el
// reporte de PA-4C.
//
// Se ejecuta con `npx tsx scripts/verificar-orquestador-borrador-programa-analitico.ts`.

import { readFileSync } from 'node:fs'
import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  ajustarBorradorProgramaAnalitico,
  confirmarBorradorProgramaAnalitico,
  descartarBorradorProgramaAnalitico,
  obtenerBorradorProgramaAnalitico,
  prepararBorradorProgramaAnalitico,
} from '../lib/programaAnalitico/orquestarBorrador'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

// --- Doble mínimo de SupabaseClient, extendido con insert/update/delete
//     encadenables y auth.getUser() — mismo espíritu que el resto de
//     la serie, mínimo necesario para este módulo. ---
type Fila = Record<string, unknown>

class ConsultaFalsa {
  private filtros: Array<[string, unknown]> = []
  private filtrosIn: Array<[string, unknown[]]> = []
  private modo: 'select' | 'insert' | 'update' = 'select'
  private payload: Fila | null = null
  private pideCount = false
  constructor(private cliente: ClienteSupabaseFalso, private tabla: string) {}

  select(_c: string, opciones?: { count?: string; head?: boolean }) {
    void _c
    if (opciones?.count) this.pideCount = true
    return this
  }
  eq(c: string, v: unknown) {
    this.filtros.push([c, v])
    return this
  }
  in(c: string, vs: unknown[]) {
    this.filtrosIn.push([c, vs])
    return this
  }
  order(_c: string, _o?: unknown) {
    void _c
    void _o
    return this
  }
  insert(payload: Fila) {
    this.modo = 'insert'
    this.payload = payload
    return this
  }
  update(payload: Fila) {
    this.modo = 'update'
    this.payload = payload
    return this
  }

  private ejecutarSelect(): Fila[] {
    return this.cliente._tabla(this.tabla).filter((f) => {
      if (!this.filtros.every(([c, v]) => f[c] === v)) return false
      if (!this.filtrosIn.every(([c, vs]) => vs.includes(f[c]))) return false
      return true
    })
  }

  private ejecutarEscritura(): { data: Fila[]; error: { code?: string; message: string } | null } {
    const tabla = this.cliente._tabla(this.tabla)
    if (this.modo === 'insert') {
      if (this.cliente.errorSimuladoInsert) return { data: [], error: this.cliente.errorSimuladoInsert }
      const nueva = { id: `fila-${tabla.length + 1}-${Date.now()}`, ...this.payload }
      tabla.push(nueva)
      return { data: [nueva], error: null }
    }
    // update
    const afectadas: Fila[] = []
    for (const f of tabla) {
      if (this.filtros.every(([c, v]) => f[c] === v)) {
        Object.assign(f, this.payload)
        afectadas.push(f)
      }
    }
    return { data: afectadas, error: null }
  }

  async maybeSingle() {
    if (this.modo === 'select') {
      const filas = this.ejecutarSelect()
      return { data: filas[0] ?? null, error: null }
    }
    const { data, error } = this.ejecutarEscritura()
    return { data: data[0] ?? null, error }
  }

  async single() {
    const { data, error } = this.modo === 'select' ? { data: this.ejecutarSelect(), error: null } : this.ejecutarEscritura()
    return { data: (data as Fila[])[0] ?? null, error }
  }

  then<T1 = unknown, T2 = never>(
    onf?: ((v: { data: Fila[] | null; error: { code?: string; message: string } | null; count?: number }) => T1 | PromiseLike<T1>) | null,
    onr?: ((r: unknown) => T2 | PromiseLike<T2>) | null
  ): Promise<T1 | T2> {
    if (this.modo === 'select') {
      const filas = this.ejecutarSelect()
      const resultado = { data: filas, error: null, ...(this.pideCount ? { count: filas.length } : {}) }
      return Promise.resolve(resultado).then(onf, onr)
    }
    return Promise.resolve(this.ejecutarEscritura()).then(onf, onr)
  }
}

class ClienteSupabaseFalso {
  private tablas = new Map<string, Fila[]>()
  public errorSimuladoInsert: { code?: string; message: string } | null = null
  constructor(datos: Record<string, Fila[]> = {}, private docenteId = 'docente-real') {
    for (const [t, fs] of Object.entries(datos)) this.tablas.set(t, fs.map((f) => ({ ...f })))
  }
  auth = { getUser: async () => ({ data: { user: { id: this.docenteId } } }) }
  from(tabla: string) {
    return new ConsultaFalsa(this, tabla)
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

const GRADO_ID = 'grado-4-real'
const VERSION_ID = 'version-1'
const CAMPO_ID = 'campo-lenguajes'
const CONTENIDO_A = 'contenido-a'

function fixtureCurricular(overrides: Partial<Record<string, Fila[]>> = {}): Record<string, Fila[]> {
  return {
    grupos: [{ id: 'grupo-4b', ciclo_escolar_id: 'ciclo-actual', nivel_educativo: 'primaria', grado: '4' }],
    curriculo_grado: [{ id: GRADO_ID, nivel_educativo: 'primaria', clave: '4' }],
    curriculo_fase_grado: [{ curriculo_grado_id: GRADO_ID, curriculo_fase_id: 'fase-4' }],
    curriculo_fase: [{ id: 'fase-4', clave: 'fase_4', curriculo_version_id: VERSION_ID }],
    curriculo_version: [{ id: VERSION_ID, estado: 'vigente' }],
    curriculo_campo_formativo: [{ id: CAMPO_ID, clave: 'lenguajes', nombre: 'Lenguajes', curriculo_version_id: VERSION_ID }],
    curriculo_cobertura: [{ curriculo_version_id: VERSION_ID, fase_id: 'fase-4', grado_id: GRADO_ID, campo_formativo_id: CAMPO_ID }],
    curriculo_contenido: [{ id: CONTENIDO_A, titulo: 'Narración de sucesos', campo_formativo_id: CAMPO_ID, curriculo_version_id: VERSION_ID }],
    curriculo_pda_grado: [{ id: 'pdagrado-1', curriculo_pda_id: 'pda-1', contenido_id: CONTENIDO_A, curriculo_grado_id: GRADO_ID, curriculo_version_id: VERSION_ID }],
    curriculo_pda: [{ id: 'pda-1', texto: 'Reconoce estilos narrativos.' }],
    ...overrides,
  }
}

function filaBorrador(overrides: Partial<Fila> = {}): Fila {
  return {
    id: 'borrador-1',
    docente_id: 'docente-real',
    grupo_id: 'grupo-4b',
    idempotency_key: 'key-1',
    curriculo_version_id: VERSION_ID,
    curriculo_fase_id: 'fase-4',
    curriculo_grado_id: GRADO_ID,
    contexto_docente: 'Contexto real de prueba con suficiente longitud.',
    contexto_notas: 'Notas de contexto.',
    deltas: [],
    estado: 'pendiente',
    programa_analitico_version_id: null,
    ...overrides,
  }
}

const anthropicNuncaLlamado = {
  messages: {
    stream: () => {
      throw new Error('anthropic.messages.stream NO debía invocarse en este caso — se esperaban 0 llamadas IA.')
    },
  },
} as unknown as Anthropic

async function main() {
  // --- 1. sin contexto → requiereContexto, 0 IA, 0 borrador ---
  {
    const { sb, interno } = clienteFalso(fixtureCurricular())
    const r = await prepararBorradorProgramaAnalitico(sb, anthropicNuncaLlamado, { grupoId: 'grupo-4b', contextoDocente: null })
    verificar(!r.ok && 'requiereContexto' in r && r.requiereContexto === true, '1. sin contexto → requiereContexto:true')
    verificar(interno._tabla('programa_analitico_borrador').length === 0, '1b. 0 borradores creados (0 IA, confirmado por el fake que lanza si se llama)')
  }

  // --- 4. segundo pendiente mismo grupo bloqueado (chequeo temprano, sin llegar a generar) ---
  {
    const { sb } = clienteFalso(fixtureCurricular({ programa_analitico_borrador: [filaBorrador()] }))
    const r = await prepararBorradorProgramaAnalitico(sb, anthropicNuncaLlamado, { grupoId: 'grupo-4b', contextoDocente: 'Contexto real suficiente de prueba.' })
    verificar(!r.ok && 'error' in r && r.error.tipo === 'YA_HAY_BORRADOR_PENDIENTE', '4. ya hay un pendiente → YA_HAY_BORRADOR_PENDIENTE, 0 IA (chequeo antes de generar)')
  }

  // --- 3/8. identidad curricular fijada correcta + recuperación reconstruye mismo resultado ---
  {
    const { sb } = clienteFalso(fixtureCurricular({ programa_analitico_borrador: [filaBorrador()] }))
    const r = await obtenerBorradorProgramaAnalitico(sb, 'borrador-1')
    verificar(r.ok === true, '3/8. recuperación de borrador pendiente sin deltas → ok')
    if (r.ok) {
      verificar(r.resumen.totalItems === 1 && r.resumen.sinAjuste.cantidad === 1, '8b. resumen reconstruido: 1 item sin_ajuste (base completa, sin deltas)')
    }
  }

  // --- 9. delta JSON inválido en DB → fail closed ---
  {
    const { sb } = clienteFalso(
      fixtureCurricular({ programa_analitico_borrador: [filaBorrador({ deltas: [{ decision: 'contextualizar' /* falta curriculoContenidoId/texto */ }] })] })
    )
    const r = await obtenerBorradorProgramaAnalitico(sb, 'borrador-1')
    verificar(!r.ok && r.error.tipo === 'BORRADOR_CORRUPTO', '9. deltas JSON con forma inválida → BORRADOR_CORRUPTO (fail-closed, nunca se intenta reparar)')
  }

  // --- 10. ajuste estructurado válido persiste ---
  {
    const { sb, interno } = clienteFalso(fixtureCurricular({ programa_analitico_borrador: [filaBorrador()] }))
    const r = await ajustarBorradorProgramaAnalitico(sb, 'borrador-1', { tipo: 'excluir', curriculoContenidoId: CONTENIDO_A })
    verificar(r.ok === true, '10. excluir contenido válido → ok')
    const filaActualizada = interno._tabla('programa_analitico_borrador')[0]
    verificar(Array.isArray(filaActualizada.deltas) && (filaActualizada.deltas as unknown[]).length === 1, '10b. el UPDATE persistió el nuevo delta en la tabla')
    if (r.ok) verificar(r.resumen.excluidos.length === 1, '10c. resumen refleja la exclusión')
  }

  // --- 11. ajuste inválido no persiste (contenido inexistente en la base) ---
  {
    const { sb, interno } = clienteFalso(fixtureCurricular({ programa_analitico_borrador: [filaBorrador()] }))
    const r = await ajustarBorradorProgramaAnalitico(sb, 'borrador-1', { tipo: 'excluir', curriculoContenidoId: 'contenido-inventado' })
    verificar(!r.ok, '11. excluir un contenido que no está en la base → error')
    const filaActualizada = interno._tabla('programa_analitico_borrador')[0]
    verificar(Array.isArray(filaActualizada.deltas) && (filaActualizada.deltas as unknown[]).length === 0, '11b. NO persistió — deltas siguen vacíos tras el intento fallido')
  }

  // --- 12/13. excluir/restaurar + nuevo conserva claveLocal (a través del orquestador) ---
  {
    const { sb } = clienteFalso(fixtureCurricular({ programa_analitico_borrador: [filaBorrador()] }))
    const paso1 = await ajustarBorradorProgramaAnalitico(sb, 'borrador-1', { tipo: 'agregarNuevo', textoLocal: 'Contenido local de prueba.' })
    verificar(paso1.ok === true && !!paso1.claveLocalNueva, '13. agregarNuevo devuelve claveLocalNueva estable')
    if (paso1.ok && paso1.claveLocalNueva) {
      const paso2 = await ajustarBorradorProgramaAnalitico(sb, 'borrador-1', { tipo: 'eliminarNuevo', claveLocal: paso1.claveLocalNueva })
      verificar(paso2.ok === true && paso2.resumen.nuevos.length === 0, '13b. eliminarNuevo con la claveLocal exacta lo quita correctamente')
    }
    const paso3 = await ajustarBorradorProgramaAnalitico(sb, 'borrador-1', { tipo: 'excluir', curriculoContenidoId: CONTENIDO_A })
    const paso4 = paso3.ok ? await ajustarBorradorProgramaAnalitico(sb, 'borrador-1', { tipo: 'restaurar', curriculoContenidoId: CONTENIDO_A }) : paso3
    verificar(paso4.ok === true && paso4.resumen.excluidos.length === 0 && paso4.resumen.sinAjuste.cantidad === 1, '12. excluir luego restaurar via orquestador → vuelve a sin_ajuste')
  }

  // --- 15. cambio de identidad curricular → fail closed antes de reconstruir ---
  {
    const { sb } = clienteFalso(fixtureCurricular({ programa_analitico_borrador: [filaBorrador({ curriculo_version_id: 'version-vieja-distinta' })] }))
    const r = await obtenerBorradorProgramaAnalitico(sb, 'borrador-1')
    verificar(!r.ok && r.error.tipo === 'IDENTIDAD_CURRICULAR_CAMBIO', '15. identidad curricular del borrador ya no coincide con la vigente → IDENTIDAD_CURRICULAR_CAMBIO')

    const ajuste = await ajustarBorradorProgramaAnalitico(sb, 'borrador-1', { tipo: 'excluir', curriculoContenidoId: CONTENIDO_A })
    verificar(!ajuste.ok && ajuste.error.tipo === 'IDENTIDAD_CURRICULAR_CAMBIO', '15b. lo mismo aplica al intentar ajustar')
  }

  // --- descartar libera + no se puede ajustar/confirmar después ---
  {
    const { sb, interno } = clienteFalso(fixtureCurricular({ programa_analitico_borrador: [filaBorrador()] }))
    const r = await descartarBorradorProgramaAnalitico(sb, 'borrador-1')
    verificar(r.ok === true, '14. descartar un pendiente → ok')
    verificar(interno._tabla('programa_analitico_borrador')[0].estado === 'descartado', '14b. estado queda en descartado (trazabilidad ligera, no se borra físicamente)')

    const ajusteTrasDescartar = await ajustarBorradorProgramaAnalitico(sb, 'borrador-1', { tipo: 'excluir', curriculoContenidoId: CONTENIDO_A })
    verificar(!ajusteTrasDescartar.ok && ajusteTrasDescartar.error.tipo === 'BORRADOR_DESCARTADO', '6. ajustar un borrador descartado → BORRADOR_DESCARTADO')

    const confirmarTrasDescartar = await confirmarBorradorProgramaAnalitico(sb, 'borrador-1')
    verificar(!confirmarTrasDescartar.ok && confirmarTrasDescartar.error.tipo === 'BORRADOR_DESCARTADO', '7. confirmar un borrador descartado → BORRADOR_DESCARTADO')
  }

  // --- confirmar ya publicado es idempotente a nivel de orquestador (no repite trabajo) ---
  {
    const { sb } = clienteFalso(
      fixtureCurricular({
        programa_analitico_borrador: [filaBorrador({ estado: 'publicado', programa_analitico_version_id: 'version-publicada-1' })],
        programa_analitico_version: [{ id: 'version-publicada-1', programa_analitico_id: 'pa-1', numero_version: 1 }],
      })
    )
    const r = await confirmarBorradorProgramaAnalitico(sb, 'borrador-1')
    verificar(r.ok === true && r.resultado.reutilizadaPorIdempotencia === true && r.resultado.numeroVersion === 1, '19. confirmar un borrador ya publicado devuelve la misma versión sin volver a publicar')
  }

  // --- 17. confirmar no acepta propuesta del cliente (estructural: la firma no tiene ese parámetro) ---
  verificar(confirmarBorradorProgramaAnalitico.length === 2, '17. confirmarBorradorProgramaAnalitico solo acepta (sb, borradorId) — estructuralmente no puede recibir una propuesta del cliente')

  // --- 26. cero dependencia de mensajes_chat (código real, no comentarios
  //         explicativos que mencionen por qué NO se usa) ---
  {
    const codigo = readFileSync(new URL('../lib/programaAnalitico/orquestarBorrador.ts', import.meta.url), 'utf-8')
    const codigoSinComentarios = codigo
      .split('\n')
      .map((l) => l.replace(/\/\/.*/, ''))
      .join('\n')
    verificar(
      !codigoSinComentarios.includes(".from('mensajes_chat')") && !codigoSinComentarios.includes(".from('conversaciones_chat')"),
      '26. orquestarBorrador.ts nunca hace .from(mensajes_chat) ni .from(conversaciones_chat) en código real'
    )
  }

  console.log(fallos === 0 ? `\n✓ Todo correcto (0 fallos).` : `\n✗ ${fallos} fallo(s).`)
  process.exit(fallos === 0 ? 0 : 1)
}

main()
