// scripts/verificar-manejar-turno-programa-analitico.ts
//
// Prueba aislada (sin credenciales, sin red) de la integración
// Programa Analítico ↔ Chat — PA-4D
// (lib/programaAnalitico/manejarTurnoChat.ts). Cubre los casos
// deterministas de la lista de PA-4D §19. Los casos que dependen del
// PROMPT real de Nivel 0 (clasificación de intención/continuidad) se
// prueban aparte con llamadas reales — ver
// scripts/verificar-clasificador-programa-analitico.ts y el reporte
// de PA-4D.
//
// Se ejecuta con `npx tsx scripts/verificar-manejar-turno-programa-analitico.ts`.

import { readFileSync } from 'node:fs'
import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { manejarTurnoProgramaAnalitico } from '../lib/programaAnalitico/manejarTurnoChat'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

// --- Doble mínimo de SupabaseClient (mismo patrón de la serie,
//     extendido con insert/update/auth.getUser — ver
//     verificar-orquestador-borrador-programa-analitico.ts). ---
type Fila = Record<string, unknown>

class ConsultaFalsa {
  private filtros: Array<[string, unknown]> = []
  private filtrosIn: Array<[string, unknown[]]> = []
  private modo: 'select' | 'insert' | 'update' = 'select'
  private payload: Fila | null = null
  constructor(private cliente: ClienteSupabaseFalso, private tabla: string) {}
  select(_c: string) { void _c; return this }
  eq(c: string, v: unknown) { this.filtros.push([c, v]); return this }
  in(c: string, vs: unknown[]) { this.filtrosIn.push([c, vs]); return this }
  order(_c: string, _o?: unknown) { void _c; void _o; return this }
  insert(payload: Fila) { this.modo = 'insert'; this.payload = payload; return this }
  update(payload: Fila) { this.modo = 'update'; this.payload = payload; return this }
  private ejecutarSelect(): Fila[] {
    return this.cliente._tabla(this.tabla).filter((f) => {
      if (!this.filtros.every(([c, v]) => f[c] === v)) return false
      if (!this.filtrosIn.every(([c, vs]) => vs.includes(f[c]))) return false
      return true
    })
  }
  private ejecutarEscritura(): { data: Fila[]; error: null } {
    const tabla = this.cliente._tabla(this.tabla)
    if (this.modo === 'insert') {
      const nueva = { id: `fila-${tabla.length + 1}-${Date.now()}-${Math.random()}`, ...this.payload }
      tabla.push(nueva)
      return { data: [nueva], error: null }
    }
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
    onf?: ((v: { data: Fila[] | null; error: null }) => T1 | PromiseLike<T1>) | null,
    onr?: ((r: unknown) => T2 | PromiseLike<T2>) | null
  ): Promise<T1 | T2> {
    const resultado = this.modo === 'select' ? { data: this.ejecutarSelect(), error: null } : this.ejecutarEscritura()
    return Promise.resolve(resultado).then(onf, onr)
  }
}

class ClienteSupabaseFalso {
  private tablas = new Map<string, Fila[]>()
  constructor(datos: Record<string, Fila[]> = {}, private docenteId = 'docente-real') {
    for (const [t, fs] of Object.entries(datos)) this.tablas.set(t, fs.map((f) => ({ ...f })))
  }
  auth = { getUser: async () => ({ data: { user: { id: this.docenteId } } }) }
  from(tabla: string) { return new ConsultaFalsa(this, tabla) }
  _tabla(tabla: string): Fila[] {
    if (!this.tablas.has(tabla)) this.tablas.set(tabla, [])
    return this.tablas.get(tabla)!
  }
}

function clienteFalso(datos: Record<string, Fila[]> = {}): { sb: SupabaseClient; interno: ClienteSupabaseFalso } {
  const interno = new ClienteSupabaseFalso(datos)
  return { sb: interno as unknown as SupabaseClient, interno }
}

// Anthropic que NUNCA debe llamarse — para los casos de 0 IA esperada.
const anthropicNuncaLlamado = {
  messages: { stream: () => { throw new Error('anthropic.messages.stream NO debía invocarse — se esperaban 0 llamadas IA.') } },
} as unknown as Anthropic

// Anthropic controlado — devuelve exactamente el JSON dado, y registra
// el prompt recibido para poder inspeccionarlo (caso 15).
function anthropicControlado(jsonRespuesta: object): { anthropic: Anthropic; promptRecibido: { valor: string } } {
  const promptRecibido = { valor: '' }
  const anthropic = {
    messages: {
      stream: (params: { messages: { content: string }[] }) => {
        promptRecibido.valor = params.messages[0].content
        return {
          finalMessage: async () => ({
            content: [{ type: 'text', text: JSON.stringify(jsonRespuesta) }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 10 },
          }),
        }
      },
    },
  } as unknown as Anthropic
  return { anthropic, promptRecibido }
}

// Anthropic secuencial — PA-5B: una llamada visual + una de generación
// pueden ocurrir en el MISMO turno con formas de respuesta distintas
// (una espera {hayContextoPedagogico,...}, la otra {contextoPedagogico,
// decisiones}) — devuelve cada JSON de `jsonsRespuesta` en orden de
// llamada y registra el `content` completo recibido en cada una
// (string o array de bloques, según venga) para poder inspeccionar si
// una llamada trajo bloques type:'image' (casos 4/5/6/7).
function anthropicSecuencial(jsonsRespuesta: object[]): { anthropic: Anthropic; llamadasRecibidas: { content: unknown }[] } {
  const llamadasRecibidas: { content: unknown }[] = []
  let indice = 0
  const anthropic = {
    messages: {
      stream: (params: { messages: { content: unknown }[] }) => {
        llamadasRecibidas.push({ content: params.messages[0].content })
        const jsonRespuesta = jsonsRespuesta[Math.min(indice, jsonsRespuesta.length - 1)]
        indice++
        return {
          finalMessage: async () => ({
            content: [{ type: 'text', text: JSON.stringify(jsonRespuesta) }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 10 },
          }),
        }
      },
    },
  } as unknown as Anthropic
  return { anthropic, llamadasRecibidas }
}

const GRADO_ID = 'grado-4-real'
const VERSION_ID = 'version-1'
const CAMPO_ID = 'campo-lenguajes'
const CONTENIDO_A = 'contenido-a'
const CONTENIDO_B = 'contenido-b'
const GRUPO_ID = 'grupo-4b'

function fixtureCurricular(overrides: Partial<Record<string, Fila[]>> = {}): Record<string, Fila[]> {
  return {
    grupos: [{ id: GRUPO_ID, ciclo_escolar_id: 'ciclo-actual', nivel_educativo: 'primaria', grado: '4' }],
    curriculo_grado: [{ id: GRADO_ID, nivel_educativo: 'primaria', clave: '4' }],
    curriculo_fase_grado: [{ curriculo_grado_id: GRADO_ID, curriculo_fase_id: 'fase-4' }],
    curriculo_fase: [{ id: 'fase-4', clave: 'fase_4', curriculo_version_id: VERSION_ID }],
    curriculo_version: [{ id: VERSION_ID, estado: 'vigente' }],
    curriculo_campo_formativo: [{ id: CAMPO_ID, clave: 'lenguajes', nombre: 'Lenguajes', curriculo_version_id: VERSION_ID }],
    curriculo_cobertura: [{ curriculo_version_id: VERSION_ID, fase_id: 'fase-4', grado_id: GRADO_ID, campo_formativo_id: CAMPO_ID }],
    curriculo_contenido: [
      { id: CONTENIDO_A, titulo: 'Narración de sucesos', campo_formativo_id: CAMPO_ID, curriculo_version_id: VERSION_ID },
      { id: CONTENIDO_B, titulo: 'Descripción de personas', campo_formativo_id: CAMPO_ID, curriculo_version_id: VERSION_ID },
    ],
    curriculo_pda_grado: [{ id: 'pdagrado-1', curriculo_pda_id: 'pda-1', contenido_id: CONTENIDO_A, curriculo_grado_id: GRADO_ID, curriculo_version_id: VERSION_ID }],
    curriculo_pda: [{ id: 'pda-1', texto: 'Reconoce estilos narrativos.' }],
    ...overrides,
  }
}

function filaBorrador(overrides: Partial<Fila> = {}): Fila {
  return {
    id: 'borrador-1',
    docente_id: 'docente-real',
    grupo_id: GRUPO_ID,
    idempotency_key: 'key-1',
    curriculo_version_id: VERSION_ID,
    curriculo_fase_id: 'fase-4',
    curriculo_grado_id: GRADO_ID,
    contexto_docente: 'Al grupo le cuesta comprender textos largos.',
    contexto_notas: 'Notas.',
    deltas: [],
    estado: 'pendiente',
    programa_analitico_version_id: null,
    ...overrides,
  }
}

const NOMBRE_ALUMNO_ROSTER = 'Halit Eduardo Trejo Álvarez'
const sesion = {
  grupo_activo_id: GRUPO_ID,
  grado_grupo: '4',
  nivel_educativo_grupo: 'primaria',
  alumnos_del_grupo_activo: [{ nombre_completo: NOMBRE_ALUMNO_ROSTER }, { nombre_completo: 'Ana Sofía Ramírez Cortés' }],
}

async function main() {
  // --- 2. sin contexto → pregunta contextual, 0 generación ---
  {
    const { sb } = clienteFalso(fixtureCurricular())
    const r = await manejarTurnoProgramaAnalitico(sb, anthropicNuncaLlamado, sesion, 'gestionar', 'ok', null, 'req-test')
    verificar(r.llamadasIa === 0, '2. sin contexto suficiente → 0 llamadas IA')
    verificar(r.texto.includes('Ya tengo identificado') || r.texto.toLowerCase().includes('cuéntame'), '2b. respuesta es la pregunta de contexto')
  }

  // --- 4. respuesta trivial "ok" mientras espera contexto → NO genera ---
  {
    const { sb, interno } = clienteFalso(fixtureCurricular())
    await manejarTurnoProgramaAnalitico(sb, anthropicNuncaLlamado, sesion, 'gestionar', 'ok', null, 'req-test')
    verificar(interno._tabla('programa_analitico_borrador').length === 0, '4. "ok" no crea ningún borrador (no se generó nada)')
  }

  // --- 5. respuesta explícita "usa el currículo oficial tal cual" → válida ---
  {
    const { anthropic } = anthropicControlado({ contextoPedagogico: null, decisiones: [] })
    const { sb, interno } = clienteFalso(fixtureCurricular())
    const r = await manejarTurnoProgramaAnalitico(sb, anthropic, sesion, 'gestionar', 'No tengo nada particular que agregar, usa el currículo oficial tal cual por ahora.', null, 'req-test')
    verificar(r.llamadasIa === 1, '5. decisión explícita de "tal cual" es contexto suficiente → SÍ genera (1 IA)')
    verificar(interno._tabla('programa_analitico_borrador').length === 1, '5b. se creó el borrador')
  }

  // --- 6. generación → borradorId persistido server-side ---
  {
    const { anthropic } = anthropicControlado({ contextoPedagogico: 'Síntesis.', decisiones: [] })
    const { sb, interno } = clienteFalso(fixtureCurricular())
    await manejarTurnoProgramaAnalitico(sb, anthropic, sesion, 'gestionar', 'Al grupo le cuesta comprender textos largos y quiero reforzar lectura.', null, 'req-test')
    // Nota: 'estado' no se comprueba aquí porque el INSERT real confía
    // en el DEFAULT 'pendiente' de la columna en Postgres (nunca lo
    // fija explícitamente en el código) — ver prueba real de PA-4C
    // para la garantía de ese default en DB real; este fake no simula
    // column defaults.
    const filas = interno._tabla('programa_analitico_borrador')
    verificar(filas.length === 1 && typeof filas[0].id === 'string', '6. borradorId persistido server-side (exactamente 1 fila nueva)')
  }

  // --- 7. respuesta usa resumen, no 85 items ---
  {
    const { anthropic } = anthropicControlado({ contextoPedagogico: null, decisiones: [{ decision: 'excluir', curriculoContenidoId: CONTENIDO_B }] })
    const { sb } = clienteFalso(fixtureCurricular())
    const r = await manejarTurnoProgramaAnalitico(sb, anthropic, sesion, 'gestionar', 'Al grupo le cuesta comprender textos largos.', null, 'req-test')
    verificar(!r.texto.includes(CONTENIDO_A) && !r.texto.includes(CONTENIDO_B), '7. la respuesta nunca imprime IDs de contenido crudos')
    verificar(r.texto.length < 2000, '7b. la respuesta es un resumen breve, no un volcado completo')
  }

  // --- 8. "sí" sin borrador → NO publica ---
  {
    const { sb, interno } = clienteFalso(fixtureCurricular())
    const r = await manejarTurnoProgramaAnalitico(sb, anthropicNuncaLlamado, sesion, 'confirmar', 'sí', null, 'req-test')
    verificar(interno._tabla('programa_analitico').length === 0, '8. "sí" sin borrador pendiente → no publica nada')
    verificar(r.texto.toLowerCase().includes('no tengo ninguna propuesta'), '8b. respuesta indica que no hay nada pendiente')
  }

  // --- 10. confirmar usa borradorId, nunca propuesta cliente (estructural) ---
  verificar(manejarTurnoProgramaAnalitico.length === 7, '10. manejarTurnoProgramaAnalitico no acepta una propuesta del cliente como parámetro (sb, anthropic, sesion, accion, mensaje, adjunto, requestId — nunca una propuesta)')

  // --- 12. ajuste determinista inequívoco → 0 IA ---
  {
    const { sb, interno } = clienteFalso(
      fixtureCurricular({ programa_analitico_borrador: [filaBorrador({ deltas: [{ decision: 'excluir', curriculoContenidoId: CONTENIDO_B }] })] })
    )
    const r = await manejarTurnoProgramaAnalitico(sb, anthropicNuncaLlamado, sesion, 'gestionar', 'no excluyas ese contenido', null, 'req-test')
    verificar(r.llamadasIa === 0, '12. "no excluyas ese" con 1 solo excluido → 0 llamadas IA (ruta determinista)')
    const fila = interno._tabla('programa_analitico_borrador')[0]
    verificar(Array.isArray(fila.deltas) && (fila.deltas as unknown[]).length === 0, '12b. el ajuste se aplicó (restaurado) sin usar IA')
  }

  // --- 13. ajuste ambiguo → pregunta, no modifica ---
  {
    const { sb, interno } = clienteFalso(
      fixtureCurricular({
        programa_analitico_borrador: [
          filaBorrador({
            deltas: [
              { decision: 'excluir', curriculoContenidoId: CONTENIDO_A },
              { decision: 'excluir', curriculoContenidoId: CONTENIDO_B },
            ],
          }),
        ],
      })
    )
    const r = await manejarTurnoProgramaAnalitico(sb, anthropicNuncaLlamado, sesion, 'gestionar', 'no excluyas ese contenido', null, 'req-test')
    verificar(r.llamadasIa === 0, '13. 2 excluidos candidatos → ambiguo, sigue 0 IA (ruta determinista detecta la ambigüedad sin gastar IA)')
    const fila = interno._tabla('programa_analitico_borrador')[0]
    verificar((fila.deltas as unknown[]).length === 2, '13b. no se modificó el borrador — sigue con los 2 deltas originales')
    verificar(r.texto.includes('?'), '13c. la respuesta es una pregunta de aclaración')
  }

  // --- 14. ajuste con redacción → máximo 1 IA ---
  {
    const { anthropic } = anthropicControlado({ tipo: 'contextualizar', curriculoContenidoId: CONTENIDO_A, textoContextualizado: 'Adaptado al agua.' })
    const { sb, interno } = clienteFalso(fixtureCurricular({ programa_analitico_borrador: [filaBorrador()] }))
    const r = await manejarTurnoProgramaAnalitico(sb, anthropic, sesion, 'gestionar', 'relaciona el contenido de narración con el cuidado del agua', null, 'req-test')
    verificar(r.llamadasIa === 1, '14. ajuste con redacción → exactamente 1 llamada IA')
    const fila = interno._tabla('programa_analitico_borrador')[0]
    verificar((fila.deltas as { decision: string }[])[0]?.decision === 'contextualizar', '14b. el delta se persistió como contextualizar')
  }

  // --- 15. ajuste IA usa contexto curricular acotado (nunca el catálogo completo) ---
  {
    const { anthropic, promptRecibido } = anthropicControlado({ tipo: 'no_reconocido' })
    const { sb } = clienteFalso(fixtureCurricular({ programa_analitico_borrador: [filaBorrador()] }))
    await manejarTurnoProgramaAnalitico(sb, anthropic, sesion, 'gestionar', 'quiero cambiar algo pero no sé qué', null, 'req-test')
    verificar(promptRecibido.valor.length < 5000, '15. el prompt de interpretación de ajuste es acotado (no incluye PDA/textos oficiales largos)')
    verificar(!promptRecibido.valor.includes('Reconoce estilos narrativos'), '15b. el prompt de ajuste NO incluye el texto de PDA oficiales')
  }

  // --- 16. ajuste inválido → no persiste ---
  {
    const { anthropic } = anthropicControlado({ tipo: 'excluir', curriculoContenidoId: 'contenido-inexistente-inventado' })
    const { sb, interno } = clienteFalso(fixtureCurricular({ programa_analitico_borrador: [filaBorrador()] }))
    await manejarTurnoProgramaAnalitico(sb, anthropic, sesion, 'gestionar', 'excluye ese contenido raro', null, 'req-test')
    const fila = interno._tabla('programa_analitico_borrador')[0]
    verificar((fila.deltas as unknown[]).length === 0, '16. un id inventado por la IA (fuera del catálogo real) nunca se persiste')
  }

  // --- 17/18. consulta PA vigente → datos canónicos / PDA correctos ---
  {
    const { sb } = clienteFalso(
      fixtureCurricular({
        programa_analitico: [{ id: 'pa-1', grupo_id: GRUPO_ID, version_vigente_id: 'v-1' }],
        programa_analitico_version: [{ id: 'v-1', numero_version: 1, contexto_notas: 'x' }],
        programa_analitico_item: [{ id: 'item-1', programa_analitico_version_id: 'v-1', curriculo_contenido_id: CONTENIDO_A, tipo_decision: 'sin_ajuste', texto_contextualizado: null, texto_local: null, orden: 1 }],
        programa_analitico_item_pda: [{ programa_analitico_item_id: 'item-1', curriculo_pda_grado_id: 'pdagrado-1' }],
      })
    )
    const r = await manejarTurnoProgramaAnalitico(sb, anthropicNuncaLlamado, sesion, 'consultar', '¿qué tenemos en el Programa Analítico?', null, 'req-test')
    verificar(r.llamadasIa === 0, '17. consulta del PA vigente → 0 llamadas IA')
    verificar(r.texto.includes('Narración de sucesos'), '17b. usa el título oficial real del contenido (dato canónico, no inventado)')
    verificar(r.texto.includes('versión 1'), '18. la respuesta referencia la versión vigente real')
  }

  // --- 19. no mezcla otro grado ---
  {
    const OTRO_GRADO_ID = 'grado-3-otro'
    const { sb, interno } = clienteFalso(
      fixtureCurricular({
        curriculo_pda_grado: [
          { id: 'pdagrado-1', curriculo_pda_id: 'pda-1', contenido_id: CONTENIDO_A, curriculo_grado_id: GRADO_ID, curriculo_version_id: VERSION_ID },
          { id: 'pdagrado-otro-grado', curriculo_pda_id: 'pda-2', contenido_id: CONTENIDO_A, curriculo_grado_id: OTRO_GRADO_ID, curriculo_version_id: VERSION_ID },
        ],
        curriculo_pda: [{ id: 'pda-1', texto: 'x' }, { id: 'pda-2', texto: 'y' }],
      })
    )
    const { anthropic } = anthropicControlado({ contextoPedagogico: null, decisiones: [] })
    await manejarTurnoProgramaAnalitico(sb, anthropic, sesion, 'gestionar', 'Al grupo le cuesta comprender textos largos.', null, 'req-test')
    const items = interno._tabla('programa_analitico_borrador') // el borrador no lo revela, pero confirmamos indirectamente vía candidatos del catálogo usado por el generador (ya probado en PA-3B1/PA-4B) — aquí solo confirmamos que el flujo corrió sin mezclar (sin excepción ni error).
    verificar(items.length === 1, '19. la generación con PDA de otro grado en la tabla no revienta ni mezcla — el catálogo ya filtra por grado (ver PA-3B1)')
  }

  // --- 20. no mezcla otro grupo (grupoId siempre viene de sesion, nunca del mensaje) ---
  {
    const codigo = readFileSync(new URL('../lib/programaAnalitico/manejarTurnoChat.ts', import.meta.url), 'utf-8')
    verificar(codigo.includes('sesion.grupo_activo_id') && !codigo.match(/grupoId\s*=\s*mensaje/), '20. grupoId se resuelve exclusivamente desde sesion, nunca se parsea del mensaje del docente')
  }

  // --- 25. turno normal no carga currículo completo ---
  {
    const codigoRoute = readFileSync(new URL('../app/api/chat/route.ts', import.meta.url), 'utf-8')
    const idxLlamada = codigoRoute.indexOf('manejarTurnoProgramaAnalitico(supabaseUser')
    const idxGuard = codigoRoute.indexOf("clasificacion.intencion_principal === 'programa_analitico'")
    // PA-5B amplió el bloque entre el guard y la llamada (normalización
    // del adjunto ya validado) y PA-5F lo amplió de nuevo (enrutamiento
    // durable + after() completo, ver route.ts) — el tope sube de 2000
    // a 10000 para dar cabida a ese código legítimo, pero la prueba
    // real (que ningún currículo se cargue SINCRÓNICAMENTE en este
    // turno, ni se reclasifique con Nivel0) se sigue verificando de
    // forma directa sobre el texto del bloque intermedio: nunca debe
    // mencionar la recuperación del catálogo curricular completo ni
    // una segunda llamada a clasificarNivel0 (ver también
    // verificar-trabajo-durable-programa-analitico.ts, que ya prueba
    // esto mismo con más detalle sobre el bloque after()).
    const bloqueIntermedio = idxGuard > -1 && idxLlamada > idxGuard ? codigoRoute.slice(idxGuard, idxLlamada) : ''
    verificar(
      idxLlamada > -1 &&
        idxGuard > -1 &&
        idxGuard < idxLlamada &&
        idxLlamada - idxGuard < 10000 &&
        !bloqueIntermedio.includes('recuperarCatalogoCurricularCerrado') &&
        !bloqueIntermedio.includes('clasificarNivel0('),
      '25. manejarTurnoProgramaAnalitico solo se invoca dentro del guard de intencion_principal==="programa_analitico", y el bloque intermedio (normalización de imagen + enrutamiento durable) nunca carga el catálogo curricular ni reclasifica con Nivel0 — ningún otro turno lo dispara'
    )
  }

  // --- 26. no segunda IA para resumen (construirResumenPropuesta es síncrona/pura) ---
  {
    const codigo = readFileSync(new URL('../lib/programaAnalitico/textosProgramaAnalitico.ts', import.meta.url), 'utf-8')
    verificar(!codigo.includes('Anthropic') && !codigo.includes('anthropic'), '26. textosProgramaAnalitico.ts no importa ni usa Anthropic — la redacción del resumen es 100% determinista')
  }

  // --- 27. no segunda IA para confirmación ---
  {
    const codigo = readFileSync(new URL('../lib/programaAnalitico/orquestarBorrador.ts', import.meta.url), 'utf-8')
    const bloqueConfirmar = codigo.slice(codigo.indexOf('export async function confirmarBorradorProgramaAnalitico'))
    verificar(!bloqueConfirmar.includes('Anthropic') && !bloqueConfirmar.includes('anthropic'), '27. confirmarBorradorProgramaAnalitico nunca invoca Anthropic')
  }

  // --- 28. recarga/continuación puede recuperar borrador desde DB ---
  {
    const { sb } = clienteFalso(fixtureCurricular({ programa_analitico_borrador: [filaBorrador()] }))
    const r = await manejarTurnoProgramaAnalitico(sb, anthropicNuncaLlamado, sesion, 'consultar', '¿cómo va mi Programa Analítico?', null, 'req-test')
    verificar(r.llamadasIa === 0 && r.texto.toLowerCase().includes('pendiente'), '28. una consulta nueva (conversación reiniciada) recupera el borrador pendiente desde DB, no de memoria')
  }

  // --- 29. mensajes_chat no contiene snapshot completo del PA ---
  {
    const codigo = readFileSync(new URL('../lib/programaAnalitico/manejarTurnoChat.ts', import.meta.url), 'utf-8')
    const sinComentarios = codigo.split('\n').map((l) => l.replace(/\/\/.*/, '')).join('\n')
    verificar(!sinComentarios.includes("from('mensajes_chat')") && !sinComentarios.includes("from('conversaciones_chat')"), '29. manejarTurnoChat.ts nunca escribe en mensajes_chat/conversaciones_chat — la persistencia de mensajes sigue el protocolo genérico ya existente del Chat')
  }

  // --- 30. borrador sigue siendo fuente de verdad (siempre se consulta DB al inicio, nunca un estado pasado por el llamador) ---
  {
    const codigo = readFileSync(new URL('../lib/programaAnalitico/manejarTurnoChat.ts', import.meta.url), 'utf-8')
    const primeraLineaUtil = codigo.indexOf('const pendiente = await buscarBorradorPendientePorGrupo')
    verificar(primeraLineaUtil > -1 && primeraLineaUtil < codigo.indexOf('if (accion ==='), '30. el estado pendiente se resuelve desde DB ANTES de cualquier rama de decisión — nunca se asume desde fuera')
  }

  // ============================================================
  // PA-5B — contexto multimodal del Programa Analítico.
  // ============================================================

  const IMAGEN_FALSA = { base64: 'BASE64FAKE_DATA_XYZ_NUNCA_DEBE_PERSISTIRSE', mediaType: 'image/jpeg' as const }
  const adjuntoConImagen = { origen: 'imagen' as const, imagenes: [IMAGEN_FALSA] }

  // --- PA5B-1. PA sin imagen (adjunto=null) → comportamiento actual intacto ---
  {
    const { anthropic } = anthropicControlado({ contextoPedagogico: null, decisiones: [] })
    const { sb, interno } = clienteFalso(fixtureCurricular())
    const r = await manejarTurnoProgramaAnalitico(sb, anthropic, sesion, 'gestionar', 'Al grupo le cuesta comprender textos largos.', null, 'req-test')
    verificar(r.llamadasIa === 1, 'PA5B-1. sin adjunto → exactamente 1 llamada IA (generación), igual que antes de PA-5B')
    verificar(interno._tabla('programa_analitico_borrador').length === 1, 'PA5B-1b. se creó el borrador normalmente sin adjunto')
  }

  // --- PA5B-4. imagen + "Hay que fortalecer siempre esos puntos" → extracción visual utilizada como contexto ---
  let llamadasRecibidasCaso4: { content: unknown }[] = []
  {
    const { anthropic, llamadasRecibidas } = anthropicSecuencial([
      { hayContextoPedagogico: true, observaciones: ['Dificultad de comprensión lectora observada en el diagnóstico.'], lecturasDudosas: [] },
      { contextoPedagogico: 'Se usó el diagnóstico aportado.', decisiones: [] },
    ])
    llamadasRecibidasCaso4 = llamadasRecibidas
    const { sb, interno } = clienteFalso(fixtureCurricular())
    const r = await manejarTurnoProgramaAnalitico(sb, anthropic, sesion, 'gestionar', 'Hay que fortalecer siempre esos puntos', adjuntoConImagen, 'req-test')
    verificar(r.llamadasIa === 2, 'PA5B-4. imagen + texto → exactamente 2 llamadas IA (1 visual acotada + 1 generación), nunca más')
    verificar(llamadasRecibidas.length === 2, 'PA5B-4b. se hicieron exactamente 2 llamadas reales a anthropic.messages.stream')
    const contenidoLlamadaVisual = llamadasRecibidas[0]?.content
    verificar(
      Array.isArray(contenidoLlamadaVisual) && contenidoLlamadaVisual.some((b: { type?: string }) => b?.type === 'image'),
      'PA5B-4c. la primera llamada (visual) SÍ recibió un bloque type=image — la imagen real llegó al extractor'
    )
    const contenidoLlamadaGeneracion = llamadasRecibidas[1]?.content
    verificar(
      typeof contenidoLlamadaGeneracion === 'string' && contenidoLlamadaGeneracion.includes('Dificultad de comprensión lectora observada en el diagnóstico.'),
      'PA5B-4d. la observación extraída de la imagen SÍ llegó al prompt de generación — ya no se pierde (causa raíz del diagnóstico real corregida)'
    )
    verificar(interno._tabla('programa_analitico_borrador').length === 1, 'PA5B-4e. se creó el borrador usando el contexto combinado (texto + imagen)')
  }

  // --- PA5B-5. imagen irrelevante (sin contexto pedagógico) + texto trivial → NO inventa contexto, no genera ---
  {
    const { anthropic, llamadasRecibidas } = anthropicSecuencial([{ hayContextoPedagogico: false, observaciones: [], lecturasDudosas: [] }])
    const { sb, interno } = clienteFalso(fixtureCurricular())
    const r = await manejarTurnoProgramaAnalitico(sb, anthropic, sesion, 'gestionar', 'ok', adjuntoConImagen, 'req-test')
    verificar(r.llamadasIa === 1, 'PA5B-5. imagen irrelevante + texto trivial → solo 1 llamada (visual, que no encontró nada) — NUNCA llega a generación')
    verificar(llamadasRecibidas.length === 1, 'PA5B-5b. la generación NUNCA se llamó (no hay 2ª llamada)')
    verificar(interno._tabla('programa_analitico_borrador').length === 0, 'PA5B-5c. no se creó ningún borrador — nunca se inventó contexto de una imagen sin contenido pedagógico')
    verificar(r.texto.toLowerCase().includes('cuéntame') || r.texto.toLowerCase().includes('características'), 'PA5B-5d. la respuesta sigue siendo la pregunta de contexto normal')
  }

  // --- PA5B-6/PA5B-15. imagen con SOLO lecturas dudosas → nunca se convierte en hecho, pide aclaración ---
  {
    const { anthropic } = anthropicSecuencial([{ hayContextoPedagogico: false, observaciones: [], lecturasDudosas: ['un texto manuscrito parcialmente ilegible'] }])
    const { sb, interno } = clienteFalso(fixtureCurricular())
    const r = await manejarTurnoProgramaAnalitico(sb, anthropic, sesion, 'gestionar', 'ok', adjuntoConImagen, 'req-test')
    verificar(r.llamadasIa === 1, 'PA5B-6. imagen con solo lecturas dudosas → 1 llamada (visual), nunca genera con eso como hecho')
    verificar(interno._tabla('programa_analitico_borrador').length === 0, 'PA5B-15. ninguna lectura dudosa se convirtió en hecho — no se creó ningún borrador a partir de ella')
    verificar(r.texto.includes('no pude leer con claridad'), 'PA5B-6b. la respuesta pide una aclaración breve específica sobre la imagen, en vez de la pregunta genérica sola')
  }

  // --- PA5B-7. contexto visual nunca etiquetado como SEP ---
  {
    const contenidoLlamadaGeneracion = llamadasRecibidasCaso4[1]?.content
    verificar(
      typeof contenidoLlamadaGeneracion === 'string' &&
        contenidoLlamadaGeneracion.includes('NO es currículo oficial SEP') &&
        contenidoLlamadaGeneracion.includes('ADJUNTO DEL DOCENTE'),
      'PA5B-7. el bloque de contexto derivado de la imagen queda etiquetado explícitamente como NO oficial SEP, aportado por el docente'
    )
  }

  // --- PA5B-13/14. nunca se persiste el base64 de la imagen ni el catálogo completo en el borrador ---
  {
    const { anthropic } = anthropicSecuencial([
      { hayContextoPedagogico: true, observaciones: ['Necesidad de refuerzo en lectura.'], lecturasDudosas: [] },
      { contextoPedagogico: null, decisiones: [] },
    ])
    const { sb, interno } = clienteFalso(fixtureCurricular())
    await manejarTurnoProgramaAnalitico(sb, anthropic, sesion, 'gestionar', 'Hay que reforzar esos puntos', adjuntoConImagen, 'req-test')
    const filaCreada = interno._tabla('programa_analitico_borrador')[0]
    const filaComoTexto = JSON.stringify(filaCreada)
    verificar(!filaComoTexto.includes(IMAGEN_FALSA.base64), 'PA5B-13. el base64 de la imagen NUNCA se persiste en programa_analitico_borrador')
    verificar(!filaComoTexto.includes(CONTENIDO_A) && !filaComoTexto.includes(CONTENIDO_B), 'PA5B-14. el catálogo curricular completo (ids de contenidos) nunca se persiste en el borrador — solo deltas/contexto')
  }

  // --- PA5B-9/10. no-regresión estructural: el bloque nuevo de route.ts está aislado dentro del guard de programa_analitico, nunca toca planeación ni lista oficial ---
  {
    const codigoRoute = readFileSync(new URL('../app/api/chat/route.ts', import.meta.url), 'utf-8')
    const idxGuard = codigoRoute.indexOf("clasificacion.intencion_principal === 'programa_analitico'")
    const idxLlamada = codigoRoute.indexOf('manejarTurnoProgramaAnalitico(supabaseUser')
    const bloqueIntermedio = idxGuard > -1 && idxLlamada > idxGuard ? codigoRoute.slice(idxGuard, idxLlamada) : ''
    verificar(
      !bloqueIntermedio.includes('analizarImagenesListaOficial') && !bloqueIntermedio.includes('aprobarBorradorPlaneacion') && !bloqueIntermedio.includes('generarBorradorPlaneacion'),
      'PA5B-9/10. el bloque nuevo de normalización de adjunto no toca planeacion_generar ni actualizar_lista_oficial — ambos short-circuits siguen construyendo sus propias imágenes de forma independiente, sin regresión'
    )
  }

  // ============================================================
  // PA-5D — sanitización de contexto pedagógico individual (integración
  // end-to-end dentro de manejarTurnoProgramaAnalitico, con persistencia
  // real en el borrador falso). La lógica pura de sanitizarContextoIndividual.ts
  // se prueba aparte en verificar-sanitizar-contexto-individual.ts (H1-H7).
  // ============================================================
  {
    const { anthropic, llamadasRecibidas } = anthropicSecuencial([
      {
        hayContextoPedagogico: true,
        observaciones: [
          `${NOMBRE_ALUMNO_ROSTER} presenta niveles 2 en comprensión lectora, indicando que requiere orientación.`,
          'El resto del grupo muestra niveles 3 y 4 en la mayoría de las áreas evaluadas.',
        ],
        lecturasDudosas: [`No queda claro si ${NOMBRE_ALUMNO_ROSTER} alcanzó el nivel 3 en escritura.`],
      },
      // Realista: si la sanitización de la fase visual funciona, la
      // llamada de generación NUNCA ve el nombre crudo en su prompt de
      // entrada — por lo tanto un modelo real jamás podría reproducirlo
      // en su propia síntesis. Esta 2ª respuesta simula exactamente eso
      // (nunca menciona el nombre), a diferencia del turno real
      // auditado en PA-5C §J (antes de esta corrección), donde SÍ lo
      // repetía porque el nombre crudo llegaba sin sanitizar.
      { contextoPedagogico: 'Se atendieron las necesidades observadas en comprensión lectora identificadas en el diagnóstico.', decisiones: [] },
    ])
    const { sb, interno } = clienteFalso(fixtureCurricular())
    const mensajeDocente = 'Hay que fortalecer esos indicadores'
    const r = await manejarTurnoProgramaAnalitico(sb, anthropic, sesion, 'gestionar', mensajeDocente, adjuntoConImagen, 'req-test')

    // --- PA5D-11/13. 0 llamadas IA adicionales por la sanitización — sigue siendo exactamente 2 (visual + generación) ---
    verificar(r.llamadasIa === 2, 'PA5D-11/13. la sanitización no agrega ninguna llamada IA — sigue siendo exactamente 2 (1 visual + 1 generación) aun con un nombre real presente')
    verificar(llamadasRecibidas.length === 2, 'PA5D-11b. exactamente 2 llamadas reales a anthropic.messages.stream, ninguna adicional para anonimizar')

    const filaCreada = interno._tabla('programa_analitico_borrador')[0] as { contexto_docente?: string; contexto_notas?: string }

    // --- PA5D-8. contexto_docente explícito del maestro no se confunde con currículo oficial (y no lo toca la sanitización de B) ---
    verificar(filaCreada?.contexto_docente === mensajeDocente, 'PA5D-8. contexto_docente persiste exactamente el texto A del docente, sin alterar ni mezclar con el contexto sanitizado del adjunto')

    // --- PA5D-10. ningún nombre del roster termina en contexto_notas persistido ---
    const notas = filaCreada?.contexto_notas ?? ''
    verificar(!notas.includes(NOMBRE_ALUMNO_ROSTER), 'PA5D-10. el nombre completo del alumno del roster NUNCA queda en contexto_notas, el campo que se volvería permanente al publicar')
    verificar(!notas.includes('Halit') && !notas.includes('Álvarez') && !notas.includes('Alvarez'), 'PA5D-10b. tampoco quedan fragmentos reconocibles del nombre (nombre o apellido sueltos) en contexto_notas')

    // --- PA5D-9. el contexto visual (ya sanitizado) sigue etiquetado explícitamente como NO oficial SEP ---
    verificar(
      notas.includes('no es información oficial SEP') && notas.includes('mediante un adjunto del docente'),
      'PA5D-9. la sanitización no borra la etiqueta "no es información oficial SEP" — la fuente B sigue distinguida de C en contexto_notas'
    )

    // --- PA5D-6 (integración). la información pedagógica alrededor del nombre sobrevive en el contexto real persistido ---
    verificar(notas.includes('niveles 2 en comprensión lectora') || notas.includes('requiere orientación'), 'PA5D-6b. el contenido pedagógico real (niveles/necesidad) sobrevive la sanitización en el flujo completo, no solo en la prueba unitaria')

    // --- PA5D-7 (integración). lecturasDudosas también se sanitizó antes de llegar a cualquier lado (no se puede inspeccionar directo, pero al menos confirmamos que ninguna mención del nombre en dudosas contaminó el resto del flujo) ---
    verificar(!JSON.stringify(filaCreada).includes(NOMBRE_ALUMNO_ROSTER), 'PA5D-7b. ninguna referencia al alumno sobrevive en ninguna columna de la fila persistida, incluida la proveniente de lecturasDudosas')
  }

  // --- PA5D-12. flujo SIN imagen no cambia — la sanitización nunca se ejecuta si no hubo extracción visual ---
  {
    const { anthropic } = anthropicControlado({ contextoPedagogico: null, decisiones: [] })
    const { sb, interno } = clienteFalso(fixtureCurricular())
    const r = await manejarTurnoProgramaAnalitico(sb, anthropic, sesion, 'gestionar', 'Al grupo le cuesta comprender textos largos.', null, 'req-test')
    verificar(r.llamadasIa === 1, 'PA5D-12. sin adjunto, el turno sigue costando exactamente 1 llamada IA (generación) — idéntico a antes de PA-5D')
    verificar(interno._tabla('programa_analitico_borrador').length === 1, 'PA5D-12b. el flujo sin imagen sigue creando el borrador con normalidad')
  }
  {
    const codigo = readFileSync(new URL('../lib/programaAnalitico/manejarTurnoChat.ts', import.meta.url), 'utf-8')
    const idxIf = codigo.indexOf("adjunto && adjunto.origen === 'imagen' && adjunto.imagenes.length > 0")
    const idxSanitizar = codigo.indexOf('sanitizarContextoPedagogicoAdjunto(')
    // La llamada a sanitizarContextoPedagogicoAdjunto vive DENTRO del
    // mismo bloque condicional que exige un adjunto real — nunca se
    // ejecuta cuando adjunto es null.
    verificar(idxIf > -1 && idxSanitizar > idxIf && idxSanitizar - idxIf < 1200, 'PA5D-12c. la llamada a sanitizarContextoPedagogicoAdjunto está anidada dentro del guard "hay adjunto real" — nunca corre en un turno sin imagen')
  }

  // --- PA5D-14. currículo/PDA no cambian por esta corrección — los módulos que resuelven el catálogo oficial no fueron tocados por PA-5D ---
  {
    const candidatos = readFileSync(new URL('../lib/programaAnalitico/candidatosCurriculares.ts', import.meta.url), 'utf-8')
    const resolver = readFileSync(new URL('../lib/curriculo/resolverContextoCurricularGrupo.ts', import.meta.url), 'utf-8')
    verificar(
      !candidatos.includes('sanitizarContextoIndividual') && !resolver.includes('sanitizarContextoIndividual'),
      'PA5D-14. los módulos que resuelven currículo/PDA oficiales (candidatosCurriculares.ts, resolverContextoCurricularGrupo.ts) no importan ni fueron modificados por la sanitización — el catálogo canónico queda intacto'
    )
  }

  // --- extra. nunca se loguea el nombre del alumno (§B "no loguees el nombre encontrado") ---
  {
    const codigo = readFileSync(new URL('../lib/programaAnalitico/sanitizarContextoIndividual.ts', import.meta.url), 'utf-8')
    verificar(!codigo.includes('console.log') && !codigo.includes('console.error'), 'PA5D-extra. sanitizarContextoIndividual.ts no tiene ningún console.log/console.error — nunca puede filtrar un nombre encontrado a los logs')
  }

  // ============================================================
  // PA-5F §4/§9 — "Continua" con borrador pendiente: resumen
  // determinista, 0 IA. Nunca interceptar un ajuste real.
  // ============================================================

  // --- CASO G. borrador pendiente + continuación trivial → resumen determinista, 0 IA ---
  for (const mensajeTrivial of ['Continua', 'continúa', 'sigue', 'seguir', 'ok', 'de acuerdo']) {
    const { sb, interno } = clienteFalso(fixtureCurricular({ programa_analitico_borrador: [filaBorrador({ deltas: [{ decision: 'excluir', curriculoContenidoId: CONTENIDO_A }] })] }))
    const r = await manejarTurnoProgramaAnalitico(sb, anthropicNuncaLlamado, sesion, 'gestionar', mensajeTrivial, null, 'req-test')
    verificar(r.llamadasIa === 0, `CASO-G. "${mensajeTrivial}" con borrador pendiente → 0 llamadas IA, nunca gasta IA adivinando contenidos (ver geometría ofrecida en el caso real de PA-5E)`)
    verificar(r.texto.toLowerCase().includes('pendiente'), `CASO-G2. "${mensajeTrivial}" devuelve el resumen determinista del borrador pendiente (textoYaHayBorradorPendiente)`)
    const fila = interno._tabla('programa_analitico_borrador')[0]
    verificar((fila.deltas as unknown[]).length === 1, `CASO-G3. "${mensajeTrivial}" no modifica el borrador — sigue con su único delta original`)
  }

  // --- CASO H. borrador pendiente + continuación CON instrucción real → ajuste real, NUNCA interceptado por la guarda trivial ---
  // Mensaje literal del ejemplo de la tarea ("continúa pero quita el
  // contenido de..."), y deliberadamente SIN "nuevo/local/agregaste"
  // cerca de "quita" — así tampoco activa la ruta determinista 0-IA de
  // interpretarAjusteBorrador (ver intentarRutaDeterminista), y prueba
  // de verdad que llega hasta la Ruta B (1 llamada IA real).
  {
    const { anthropic, llamadasRecibidas } = anthropicSecuencial([{ tipo: 'excluir', curriculoContenidoId: CONTENIDO_A }])
    const { sb, interno } = clienteFalso(
      fixtureCurricular({ programa_analitico_borrador: [filaBorrador({ deltas: [{ decision: 'contextualizar', curriculoContenidoId: CONTENIDO_A, textoContextualizado: 'Texto contextualizado de prueba.' }] })] })
    )
    const r = await manejarTurnoProgramaAnalitico(sb, anthropic, sesion, 'gestionar', 'continúa pero quita el contenido de narración', null, 'req-test')
    verificar(llamadasRecibidas.length === 1, 'CASO-H. "continúa pero quita el contenido de..." SÍ llega a interpretarAjusteBorrador (1 llamada real) — la guarda trivial nunca la intercepta')
    verificar(r.llamadasIa === 1, 'CASO-H2. exactamente 1 llamada IA — el ajuste real se procesa con normalidad')
    const fila = interno._tabla('programa_analitico_borrador')[0]
    const deltasFinales = fila.deltas as { decision: string; curriculoContenidoId?: string }[]
    verificar(
      deltasFinales.length === 1 && deltasFinales[0].decision === 'excluir' && deltasFinales[0].curriculoContenidoId === CONTENIDO_A,
      'CASO-H3. el ajuste real SÍ se aplicó (contextualizar → excluir para el contenido real) — prueba que no fue interceptado como continuación vacía'
    )
  }
  {
    // Variantes adicionales del ejemplo dado explícitamente en la tarea — todas deben evitar la guarda (mensaje NO trivial tras normalizar).
    for (const mensajeConInstruccion of ['sigue y agrega un contenido sobre fracciones', 'ok, cambia el texto del segundo contenido', 'de acuerdo, pero modifica la redacción']) {
      const codigo = readFileSync(new URL('../lib/programaAnalitico/borradorProgramaAnalitico.ts', import.meta.url), 'utf-8')
      const inicioSet = codigo.indexOf('const RESPUESTAS_TRIVIALES = new Set([')
      const finSet = codigo.indexOf('])', inicioSet)
      const cuerpoSet = codigo.slice(inicioSet, finSet)
      const normalizado = mensajeConInstruccion
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
      verificar(!cuerpoSet.includes(`'${normalizado}'`), `CASO-H4. "${mensajeConInstruccion}" normalizado no coincide con ninguna entrada literal de RESPUESTAS_TRIVIALES (coincidencia EXACTA requerida, nunca substring) — seguirá el flujo real de ajuste`)
    }
  }

  console.log(fallos === 0 ? `\n✓ Todo correcto (0 fallos).` : `\n✗ ${fallos} fallo(s).`)
  process.exit(fallos === 0 ? 0 : 1)
}

main()
