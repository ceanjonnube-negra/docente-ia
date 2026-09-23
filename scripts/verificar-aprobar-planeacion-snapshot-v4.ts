// scripts/verificar-aprobar-planeacion-snapshot-v4.ts
//
// PLN-1E-B — pruebas deterministas (sin Anthropic, sin tocar DB real)
// de la integración entre aprobarBorradorPlaneacion y el snapshot V4
// (conversaciones_chat.planeacion_activa): recuperación server-side,
// validación, y persistencia de trazabilidadCurricular en
// planeacion_proyectos.evaluacion.trazabilidad_curricular. Mismo doble
// mínimo de SupabaseClient que scripts/verificar-aprobar-borrador-planeacion.ts
// (copiado, no importado — mismo criterio ya establecido en esta serie
// de scripts: cada archivo de prueba mantiene su propio doble mínimo).
//
// Se ejecuta con `npx tsx scripts/verificar-aprobar-planeacion-snapshot-v4.ts`.

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { SupabaseClient } from '@supabase/supabase-js'
import { aprobarBorradorPlaneacion } from '../lib/planeacion/aprobarBorrador'
import { construirPlaneacionActivaCreada, construirPlaneacionActivaAjustada, construirTrazabilidadCurricular, type PlaneacionActivaV4 } from '../lib/planeacion/planeacionActiva'
import type { CandidatoCurricularPlaneacion } from '../lib/planeacion/resolverCurricularPlaneacion'
import type { ResumenBorrador } from '../lib/planeacion/extraerBorrador'
import type { SesionContexto } from '../lib/sesionContexto'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

// ============================================================
// Doble mínimo de SupabaseClient (copiado de
// scripts/verificar-aprobar-borrador-planeacion.ts).
// ============================================================

type Fila = Record<string, unknown>

class ConsultaFalsa {
  private filtros: Array<[string, unknown]> = []
  private operacion: 'consultar' | 'insertar' | 'actualizar' = 'consultar'
  private payload: Fila | Fila[] | null = null

  constructor(private cliente: ClienteSupabaseFalso, private tabla: string) {}

  select(_columnas: string) { void _columnas; return this }
  insert(valores: Fila | Fila[]) { this.operacion = 'insertar'; this.payload = valores; return this }
  update(valores: Fila) { this.operacion = 'actualizar'; this.payload = valores; return this }
  eq(columna: string, valor: unknown) { this.filtros.push([columna, valor]); return this }
  order() { return this }
  gt() { return this }

  private ejecutar(): { data: Fila[] | null; error: { message: string; code?: string } | null } {
    if (this.cliente._debeFallar(this.tabla, this.operacion === 'insertar' ? 'insert' : this.operacion === 'actualizar' ? 'update' : 'select')) {
      return { data: null, error: { message: `Error simulado en ${this.tabla}` } }
    }
    const filas = this.cliente._tabla(this.tabla)

    if (this.operacion === 'insertar') {
      const nuevas = Array.isArray(this.payload) ? this.payload : [this.payload as Fila]
      const insertadas = nuevas.map((f) => ({ id: randomUUID(), creado_en: new Date().toISOString(), actualizado_en: new Date().toISOString(), generado_en: new Date().toISOString(), storage_path: null, ...f }))
      filas.push(...insertadas)
      return { data: insertadas, error: null }
    }
    if (this.operacion === 'actualizar') {
      const coincidentes = filas.filter((f) => this.filtros.every(([c, v]) => f[c] === v))
      coincidentes.forEach((f) => Object.assign(f, this.payload))
      return { data: coincidentes, error: null }
    }
    const resultado = filas.filter((f) => this.filtros.every(([c, v]) => f[c] === v))
    return { data: resultado, error: null }
  }

  async maybeSingle() {
    const { data, error } = this.ejecutar()
    if (error) return { data: null, error }
    return { data: data && data.length > 0 ? data[0] : null, error: null }
  }
  async single() {
    const { data, error } = this.ejecutar()
    if (error) return { data: null, error }
    if (!data || data.length === 0) return { data: null, error: { message: 'no rows' } }
    return { data: data[0], error: null }
  }
  then<T1 = unknown, T2 = never>(
    onf?: ((v: { data: Fila[] | null; error: { message: string; code?: string } | null }) => T1 | PromiseLike<T1>) | null,
    onr?: ((r: unknown) => T2 | PromiseLike<T2>) | null,
  ): Promise<T1 | T2> {
    return Promise.resolve(this.ejecutar()).then(onf, onr)
  }
}

class ClienteSupabaseFalso {
  private tablas = new Map<string, Fila[]>()
  private archivosStorage = new Map<string, Buffer>()
  private fallasForzadas: Array<{ tabla: string; operacion: 'insert' | 'update' | 'select' }> = []

  constructor(private usuario: { id: string } | null, datosIniciales: Record<string, Fila[]> = {}) {
    for (const [tabla, filas] of Object.entries(datosIniciales)) this.tablas.set(tabla, filas.map((f) => ({ ...f })))
  }

  auth = {
    getUser: async () => {
      if (!this.usuario) return { data: { user: null }, error: { message: 'sin sesión' } }
      return { data: { user: this.usuario }, error: null }
    },
  }

  storage = {
    getBucket: async (bucket: string) => ({ data: { name: bucket }, error: null }),
    createBucket: async () => ({ error: null }),
    from: (bucket: string) => ({
      upload: async (ruta: string, buffer: Buffer) => { this.archivosStorage.set(`${bucket}/${ruta}`, buffer); return { error: null } },
      createSignedUrl: async (ruta: string) => {
        if (!this.archivosStorage.has(`${bucket}/${ruta}`)) return { data: null, error: { message: 'archivo no encontrado' } }
        return { data: { signedUrl: `https://fake-storage.local/${bucket}/${ruta}` }, error: null }
      },
      remove: async (rutas: string[]) => { rutas.forEach((r) => this.archivosStorage.delete(`${bucket}/${r}`)); return { error: null } },
    }),
  }

  from(tabla: string) { return new ConsultaFalsa(this, tabla) }
  forzarErrorEn(tabla: string, operacion: 'insert' | 'update' | 'select') { this.fallasForzadas.push({ tabla, operacion }) }
  quitarErrorForzado(tabla: string, operacion: 'insert' | 'update' | 'select') { this.fallasForzadas = this.fallasForzadas.filter((f) => !(f.tabla === tabla && f.operacion === operacion)) }
  _tabla(tabla: string): Fila[] { if (!this.tablas.has(tabla)) this.tablas.set(tabla, []); return this.tablas.get(tabla)! }
  _debeFallar(tabla: string, operacion: 'insert' | 'update' | 'select'): boolean { return this.fallasForzadas.some((f) => f.tabla === tabla && f.operacion === operacion) }
  _rutasStorage(): string[] { return [...this.archivosStorage.keys()] }
}

function clienteFalso(usuario: { id: string } | null, datos: Record<string, Fila[]> = {}): { sb: SupabaseClient; interno: ClienteSupabaseFalso } {
  const interno = new ClienteSupabaseFalso(usuario, datos)
  return { sb: interno as unknown as SupabaseClient, interno }
}

function datosBase(): Record<string, Fila[]> {
  return {
    grupos: [{ id: '11111111-1111-4111-8111-111111111111', docente_id: 'docente-1', ciclo_escolar_id: 'ciclo-1', institucion_id: 'institucion-1' }],
    planeaciones: [],
    planeacion_proyectos: [],
    periodos_evaluacion: [],
    proyectos_seguimiento: [],
    hojas_evaluacion: [],
    inscripciones: [{ grupo_id: '11111111-1111-4111-8111-111111111111', estatus: 'activo', alumnos: { id: 'a1', nombre: 'Beatriz López', curp: null, sexo: 'M', fecha_nacimiento: null } }],
    perfiles_docentes: [{ id: 'docente-1', escuela: 'Escuela de prueba', grado: '4°', grupo: 'B', ciclo_escolar: '2026-2027' }],
    conversaciones_chat: [],
  }
}

function sesion(overrides: Partial<SesionContexto> = {}): SesionContexto {
  return {
    docente_id: 'docente-1',
    institucion_id: 'institucion-1',
    ciclo_escolar_id: 'ciclo-1',
    grupo_activo_id: '11111111-1111-4111-8111-111111111111',
    nivel_educativo_grupo: null,
    grado_grupo: null,
    grupo_letra: null,
    fecha_actual: '2026-08-10',
    alumnos_del_grupo_activo: [],
    ...overrides,
  }
}

// ============================================================
// Fixtures de borrador — mismo texto en todos los casos (misma huella
// docente+grupo+nombre+fechas) salvo donde se indique lo contrario.
// ============================================================

const NOMBRE_PROYECTO = 'Leyendas de mi comunidad'
const CAMPOS_BLOQUE: [string, string][] = [
  ['Nombre', NOMBRE_PROYECTO],
  ['Grupo', 'activo'],
  ['Periodo de evaluación', 'Primer trimestre'],
  ['Fecha de inicio', '2026-08-10'],
  ['Fecha de fin', '2026-08-21'],
  ['Duración', '10 días efectivos'],
  ['Propósito', 'que los alumnos investiguen y compartan leyendas de su comunidad'],
  ['Campos formativos', 'Lenguajes'],
  ['Contenidos', 'tradición oral; tipos de narración'],
  ['PDA', 'identifica elementos de una leyenda; narra una leyenda con sus palabras'],
  ['Ejes articuladores', 'Interculturalidad Crítica'],
  ['Metodología', 'aprendizaje basado en proyectos'],
  ['Producto final', 'antología de leyendas ilustrada'],
  ['Secuencia didáctica', 'Día 1: introducción al tema; Día 2: investigación; Día 3: redacción final'],
  ['Recursos', 'libros de la biblioteca del aula; hojas de rotafolio'],
  ['Evidencias', 'borrador escrito; antología final'],
  ['Indicadores de evaluación', 'identifica estructura narrativa; participa en la investigación; presenta su leyenda; ilustra su leyenda; comparte su trabajo'],
]

function construirBloque(tituloDocumento = 'Aquí está tu borrador completo.'): string {
  const lineas = CAMPOS_BLOQUE.map(([etiqueta, valor]) => `${etiqueta}: ${valor}`)
  return `${tituloDocumento}\n\n📎 RESUMEN PARA GUARDAR\n${lineas.join('\n')}\n\n¿Deseas corregir algo o aprobarla para guardarla?`
}

const BLOQUE_VALIDO = construirBloque()
const HISTORIAL_VALIDO = [{ role: 'assistant', content: BLOQUE_VALIDO }]

function resumenFixture(): ResumenBorrador {
  return {
    nombre: NOMBRE_PROYECTO,
    grupoTexto: 'activo',
    periodoTexto: 'Primer trimestre',
    fechaInicio: '2026-08-10',
    fechaFin: '2026-08-21',
    duracionDias: 10,
    proposito: 'prueba',
    camposFormativos: ['Lenguajes'],
    contenidos: ['x'],
    pda: ['y'],
    ejesArticuladores: ['Interculturalidad Crítica'],
    metodologia: 'proyecto',
    productoFinal: 'antología',
    secuenciaDidactica: [{ dia: 1, resumen: 'x' }],
    recursos: ['x'],
    evidencias: ['x'],
    indicadores: ['i1', 'i2', 'i3', 'i4', 'i5'],
    programaAnaliticoItemIdsPropuestos: [],
  }
}

// ============================================================
// Candidatos curriculares de prueba (mismo shape real que
// resolverCurricularPlaneacion.ts — construidos a mano, sin depender
// de datos reales de PA, consistente con el resto de esta serie).
// ============================================================

const CAMPO_LENGUAJES = { id: 'campo-lenguajes', clave: 'lenguajes', nombre: 'Lenguajes' }

const ITEM_OFICIAL: CandidatoCurricularPlaneacion = {
  programaAnaliticoId: '22222222-2222-4222-8222-222222222222',
  programaAnaliticoVersionId: '33333333-3333-4333-8333-333333333333',
  programaAnaliticoItemId: '44444444-4444-4444-8444-444444444444',
  procedencia: 'oficial',
  curriculoContenidoId: 'contenido-oficial-1',
  campoFormativo: CAMPO_LENGUAJES,
  contenidoOficial: 'Comprensión y producción de cuentos para su disfrute.',
  textoContextualizado: null,
  textoLocal: null,
  pda: [{ programaAnaliticoItemPdaId: '77777777-7777-4777-8777-777777777771', curriculoPdaId: '77777777-7777-4777-8777-777777777772', curriculoPdaGradoId: '77777777-7777-4777-8777-777777777773', texto: 'Selecciona, lee y escucha cuentos de distintos orígenes y autores.' }],
}

const ITEM_CONTEXTUALIZADO: CandidatoCurricularPlaneacion = {
  programaAnaliticoId: '22222222-2222-4222-8222-222222222222',
  programaAnaliticoVersionId: '33333333-3333-4333-8333-333333333333',
  programaAnaliticoItemId: '55555555-5555-4555-8555-555555555555',
  procedencia: 'contextualizado',
  curriculoContenidoId: 'contenido-contextualizado-1',
  campoFormativo: CAMPO_LENGUAJES,
  contenidoOficial: 'Narración de sucesos del pasado y del presente.',
  textoContextualizado: 'Narración de sucesos, con énfasis en tradición oral y leyendas de la comunidad.',
  textoLocal: null,
  pda: [{ programaAnaliticoItemPdaId: '88888888-8888-4888-8888-888888888881', curriculoPdaId: '88888888-8888-4888-8888-888888888882', curriculoPdaGradoId: '88888888-8888-4888-8888-888888888883', texto: 'Reconoce y usa diversos estilos, recursos y estrategias narrativas.' }],
}

const ITEM_LOCAL: CandidatoCurricularPlaneacion = {
  programaAnaliticoId: '22222222-2222-4222-8222-222222222222',
  programaAnaliticoVersionId: '33333333-3333-4333-8333-333333333333',
  programaAnaliticoItemId: '66666666-6666-4666-8666-666666666666',
  procedencia: 'local',
  curriculoContenidoId: null,
  campoFormativo: null,
  contenidoOficial: null,
  textoContextualizado: null,
  textoLocal: 'Desarrollo de la fluidez lectora en voz alta.',
  pda: [],
}

function construirSnapshotV4(candidatos: CandidatoCurricularPlaneacion[], grupoId = '11111111-1111-4111-8111-111111111111', tituloDocumento?: string): PlaneacionActivaV4 {
  const trazabilidad = construirTrazabilidadCurricular('22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', candidatos)
  return construirPlaneacionActivaCreada(resumenFixture(), construirBloque(tituloDocumento).split('\n\n📎')[0].trim(), grupoId, null, trazabilidad)
}

async function main() {
  // CASO A — V4 válido + trazabilidad oficial/contextualizada: persiste exactamente la estructura.
  {
    const { sb, interno } = clienteFalso({ id: 'docente-1' }, datosBase())
    const snapshot = construirSnapshotV4([ITEM_OFICIAL, ITEM_CONTEXTUALIZADO])
    interno._tabla('conversaciones_chat').push({ id: 'conv-a', planeacion_activa: snapshot })

    const r = await aprobarBorradorPlaneacion(sb, sesion(), HISTORIAL_VALIDO, 'conv-a')
    verificar(r.ok === true, 'CASO A. la aprobación con snapshot V4 válido tiene éxito')
    const proyecto = interno._tabla('planeacion_proyectos')[0] as { evaluacion?: { trazabilidad_curricular?: unknown } }
    verificar(JSON.stringify(proyecto?.evaluacion?.trazabilidad_curricular) === JSON.stringify(snapshot.trazabilidadCurricular), 'CASO A. planeacion_proyectos.evaluacion.trazabilidad_curricular es EXACTAMENTE snapshot.trazabilidadCurricular, sin reconstrucción')
  }

  // CASO B — item local: null/null/[] permanece exacto.
  {
    const { sb, interno } = clienteFalso({ id: 'docente-1' }, datosBase())
    const snapshot = construirSnapshotV4([ITEM_LOCAL])
    interno._tabla('conversaciones_chat').push({ id: 'conv-b', planeacion_activa: snapshot })

    const r = await aprobarBorradorPlaneacion(sb, sesion(), HISTORIAL_VALIDO, 'conv-b')
    verificar(r.ok === true, 'CASO B precondición: aprobación exitosa')
    const proyecto = interno._tabla('planeacion_proyectos')[0] as { evaluacion?: { trazabilidad_curricular?: { items: Array<{ procedencia: string; curriculoContenidoId: unknown; campoFormativo: unknown; pda: unknown[] }> } } }
    const item = proyecto?.evaluacion?.trazabilidad_curricular?.items[0]
    verificar(item?.procedencia === 'local' && item?.curriculoContenidoId === null && item?.campoFormativo === null && Array.isArray(item?.pda) && item.pda.length === 0, 'CASO B. item local persiste con curriculoContenidoId=null, campoFormativo=null, pda=[] — exacto')
  }

  // CASO C — V4 version=2: usa exclusivamente la trazabilidad de V2, nunca mezcla con la V1.
  {
    const { sb, interno } = clienteFalso({ id: 'docente-1' }, datosBase())
    const snapshotV1 = construirSnapshotV4([ITEM_OFICIAL])
    const trazabilidadV2 = construirTrazabilidadCurricular('22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', [ITEM_CONTEXTUALIZADO, ITEM_LOCAL])
    const snapshotV2 = construirPlaneacionActivaAjustada(snapshotV1, resumenFixture(), construirBloque().split('\n\n📎')[0].trim(), null, trazabilidadV2)
    verificar(snapshotV2.version === 2, 'CASO C precondición: el ajuste produce version=2')
    // Solo la V2 vive en conversaciones_chat — así es en producción real
    // (una sola fila, sobrescrita en cada turno).
    interno._tabla('conversaciones_chat').push({ id: 'conv-c', planeacion_activa: snapshotV2 })

    const r = await aprobarBorradorPlaneacion(sb, sesion(), HISTORIAL_VALIDO, 'conv-c')
    verificar(r.ok === true, 'CASO C precondición: aprobación exitosa')
    const proyecto = interno._tabla('planeacion_proyectos')[0] as { evaluacion?: { trazabilidad_curricular?: { items: Array<{ programaAnaliticoItemId: string }> } } }
    const idsPersistidos = new Set((proyecto?.evaluacion?.trazabilidad_curricular?.items ?? []).map((i) => i.programaAnaliticoItemId))
    verificar(idsPersistidos.has(ITEM_CONTEXTUALIZADO.programaAnaliticoItemId) && idsPersistidos.has(ITEM_LOCAL.programaAnaliticoItemId), 'CASO C. la trazabilidad persistida es la de V2 (contextualizado + local)')
    verificar(!idsPersistidos.has(ITEM_OFICIAL.programaAnaliticoItemId), 'CASO C. el item de V1 (oficial) NO sobrevive — nunca se mezcla con la versión anterior')
  }

  // CASO D — V3 histórico: fallback existente, sin inventar trazabilidad.
  {
    const { sb, interno } = clienteFalso({ id: 'docente-1' }, datosBase())
    const snapshotV3 = {
      schemaVersion: 3,
      version: 1,
      estado: 'borrador',
      implementadaEn: null,
      contexto: { grupoId: '11111111-1111-4111-8111-111111111111' },
      borrador: resumenFixture(),
      contenidoCompleto: 'texto histórico v3',
      origenMensajeId: null,
      actualizadoEn: new Date().toISOString(),
    }
    interno._tabla('conversaciones_chat').push({ id: 'conv-d', planeacion_activa: snapshotV3 })

    const r = await aprobarBorradorPlaneacion(sb, sesion(), HISTORIAL_VALIDO, 'conv-d')
    verificar(r.ok === true, 'CASO D. un snapshot V3 histórico sigue siendo aprobable (fallback funciona)')
    const proyecto = interno._tabla('planeacion_proyectos')[0] as { evaluacion?: { trazabilidad_curricular?: unknown } }
    verificar(proyecto?.evaluacion?.trazabilidad_curricular === undefined, 'CASO D. NO se inventa trazabilidad_curricular para un snapshot V3 (la clave ni siquiera aparece)')
  }

  // CASO E — snapshot corrupto: fallback/fail-closed, nunca reconstrucción aproximada.
  {
    const { sb, interno } = clienteFalso({ id: 'docente-1' }, datosBase())
    interno._tabla('conversaciones_chat').push({ id: 'conv-e', planeacion_activa: { schemaVersion: 4, estado: 'borrador' /* falta version, contexto, contenidoCompleto, etc. — inválido */ } })

    const r = await aprobarBorradorPlaneacion(sb, sesion(), HISTORIAL_VALIDO, 'conv-e')
    verificar(r.ok === true, 'CASO E. snapshot corrupto → fail-closed silencioso, la aprobación igual funciona vía fallback')
    const proyecto = interno._tabla('planeacion_proyectos')[0] as { evaluacion?: { trazabilidad_curricular?: unknown } }
    verificar(proyecto?.evaluacion?.trazabilidad_curricular === undefined, 'CASO E. ningún dato aproximado/inventado se persiste a partir de un snapshot corrupto')
  }

  // CASO F — grupo del snapshot != grupo activo: no confiar en el snapshot.
  {
    const { sb, interno } = clienteFalso({ id: 'docente-1' }, datosBase())
    const snapshot = construirSnapshotV4([ITEM_OFICIAL], '99999999-9999-4999-8999-999999999999')
    interno._tabla('conversaciones_chat').push({ id: 'conv-f', planeacion_activa: snapshot })

    const r = await aprobarBorradorPlaneacion(sb, sesion(), HISTORIAL_VALIDO, 'conv-f')
    verificar(r.ok === true, 'CASO F precondición: aprobación exitosa (fallback)')
    const proyecto = interno._tabla('planeacion_proyectos')[0] as { evaluacion?: { trazabilidad_curricular?: unknown } }
    verificar(proyecto?.evaluacion?.trazabilidad_curricular === undefined, 'CASO F. snapshot de OTRO grupo nunca se usa como identidad curricular, aunque sea V4/borrador válido')
  }

  // CASO G — documentos definitivos con V4: fuente = snapshot.contenidoCompleto (nunca historial).
  {
    const contenidoRoute = readFileSyncModulo('lib/planeacion/aprobarBorrador.ts')
    const idx = contenidoRoute.indexOf('const textoCompleto = contenidoCompletoDefinitivo ??')
    verificar(idx !== -1, 'CASO G (estructural). el código da prioridad EXPLÍCITA a contenidoCompletoDefinitivo sobre extraerTextoCompletoBorrador(historial) para los documentos definitivos')

    const { sb, interno } = clienteFalso({ id: 'docente-1' }, datosBase())
    const snapshot = construirSnapshotV4([ITEM_OFICIAL], '11111111-1111-4111-8111-111111111111', 'MARCADORSNAPSHOTV4UNICO')
    interno._tabla('conversaciones_chat').push({ id: 'conv-g', planeacion_activa: snapshot })
    await aprobarBorradorPlaneacion(sb, sesion(), HISTORIAL_VALIDO, 'conv-g')
    // Fase 4.5 es "mejor esfuerzo": en este doble de prueba, la subida
    // a Storage sí ocurre (se puede inspeccionar la ruta generada,
    // reflejo real del título derivado del texto fuente) aunque la
    // verificación posterior de URL falle por ser un dominio falso —
    // mismo comportamiento ya tolerado por el resto de esta serie.
    const rutas = interno._rutasStorage()
    verificar(rutas.length > 0, 'CASO G. Fase 4.5 sí llegó a generar/subir un documento (texto fuente no vacío)')
  }

  // CASO H — retry: preserva la misma trazabilidad (nunca la duplica ni la pierde).
  {
    const { sb, interno } = clienteFalso({ id: 'docente-1' }, datosBase())
    const snapshot = construirSnapshotV4([ITEM_OFICIAL])
    interno._tabla('conversaciones_chat').push({ id: 'conv-h', planeacion_activa: snapshot })

    // Primer intento: Fase 6 (confirmarPlaneacion) falla a propósito —
    // Fase 5 ya alcanzó a persistir trazabilidad_curricular antes de
    // eso, la planeación queda version=0 (recuperable).
    interno.forzarErrorEn('planeaciones', 'update')
    const r1 = await aprobarBorradorPlaneacion(sb, sesion(), HISTORIAL_VALIDO, 'conv-h')
    verificar(r1.ok === false, 'CASO H precondición: el primer intento falla (Fase 6 forzada a fallar)')
    const proyectoTrasFallo = interno._tabla('planeacion_proyectos')[0] as { evaluacion?: { trazabilidad_curricular?: unknown } }
    verificar(proyectoTrasFallo?.evaluacion?.trazabilidad_curricular !== undefined, 'CASO H. trazabilidad_curricular YA quedó persistida en Fase 5 aunque Fase 6 fallara')

    // Reintento real: mismo historial/huella, mismo snapshot (sin
    // cambios) — debe recuperar la MISMA fila y terminar con éxito,
    // con la trazabilidad IDÉNTICA (nunca duplicada ni regenerada
    // desde cero).
    interno.quitarErrorForzado('planeaciones', 'update')
    const r2 = await aprobarBorradorPlaneacion(sb, sesion(), HISTORIAL_VALIDO, 'conv-h')
    verificar(r2.ok === true, 'CASO H. el reintento sobre la misma huella tiene éxito')
    verificar(interno._tabla('planeaciones').length === 1, 'CASO H. sigue existiendo UNA sola fila en planeaciones — el reintento nunca duplica')
    const proyectosFinal = interno._tabla('planeacion_proyectos')
    verificar(proyectosFinal.length === 1, 'CASO H. sigue existiendo UN solo planeacion_proyectos — el reintento nunca duplica la relación')
    const trazFinal = (proyectosFinal[0] as { evaluacion?: { trazabilidad_curricular?: unknown } }).evaluacion?.trazabilidad_curricular
    verificar(JSON.stringify(trazFinal) === JSON.stringify(snapshot.trazabilidadCurricular), 'CASO H. la trazabilidad final es IDÉNTICA a la del snapshot original — el reintento la preserva exactamente')
  }

  // CASO I — conflicto: planeacion_proyectos ya tiene una trazabilidad diferente → NO sobrescribir silenciosamente.
  {
    const { sb, interno } = clienteFalso({ id: 'docente-1' }, datosBase())
    const snapshotOriginal = construirSnapshotV4([ITEM_OFICIAL])
    interno._tabla('conversaciones_chat').push({ id: 'conv-i', planeacion_activa: snapshotOriginal })

    interno.forzarErrorEn('planeaciones', 'update')
    const r1 = await aprobarBorradorPlaneacion(sb, sesion(), HISTORIAL_VALIDO, 'conv-i')
    verificar(r1.ok === false, 'CASO I precondición: primer intento falla, trazabilidad ORIGINAL ya persistida en Fase 5')
    interno.quitarErrorForzado('planeaciones', 'update')

    // Entre el primer intento y el reintento, el snapshot de la MISMA
    // conversación cambia a una selección curricular DISTINTA (ej. el
    // docente ajustó de nuevo) — pero la huella (nombre/fechas) del
    // historial sigue siendo la misma.
    const snapshotDistinto = construirSnapshotV4([ITEM_CONTEXTUALIZADO, ITEM_LOCAL])
    interno._tabla('conversaciones_chat')[0].planeacion_activa = snapshotDistinto

    let advertenciaEmitida = false
    const warnOriginal = console.warn
    console.warn = (...args: unknown[]) => { advertenciaEmitida = advertenciaEmitida || String(args[0]).includes('conflicto de trazabilidad_curricular'); warnOriginal(...(args as [unknown])) }
    const r2 = await aprobarBorradorPlaneacion(sb, sesion(), HISTORIAL_VALIDO, 'conv-i')
    console.warn = warnOriginal

    verificar(r2.ok === true, 'CASO I. el reintento con trazabilidad distinta sigue teniendo éxito (nunca bloquea la aprobación)')
    verificar(advertenciaEmitida, 'CASO I. se registra una advertencia explícita del conflicto detectado')
    const proyectoFinal = interno._tabla('planeacion_proyectos')[0] as { evaluacion?: { trazabilidad_curricular?: unknown } }
    verificar(
      JSON.stringify(proyectoFinal?.evaluacion?.trazabilidad_curricular) === JSON.stringify(snapshotOriginal.trazabilidadCurricular),
      'CASO I. la trazabilidad persistida sigue siendo la ORIGINAL — nunca se sobrescribió silenciosamente con la distinta'
    )
  }

  // CASO J — merge de evaluacion: hoja_id/documento_word/documento_pdf sobreviven junto con trazabilidad_curricular.
  {
    const { sb, interno } = clienteFalso({ id: 'docente-1' }, datosBase())
    const snapshot = construirSnapshotV4([ITEM_OFICIAL])
    interno._tabla('conversaciones_chat').push({ id: 'conv-j', planeacion_activa: snapshot })
    await aprobarBorradorPlaneacion(sb, sesion(), HISTORIAL_VALIDO, 'conv-j')
    const proyecto = interno._tabla('planeacion_proyectos')[0] as { evaluacion?: Record<string, unknown> }
    verificar(typeof proyecto?.evaluacion?.hoja_id === 'string', 'CASO J. hoja_id sigue presente junto con trazabilidad_curricular')
    verificar(proyecto?.evaluacion?.trazabilidad_curricular !== undefined, 'CASO J. trazabilidad_curricular está presente en el mismo objeto evaluacion')
    verificar(proyecto?.evaluacion?.indicadores !== undefined && proyecto?.evaluacion?.producto_final !== undefined, 'CASO J. indicadores/producto_final (claves preexistentes) tampoco se pierden')
  }

  // CASO K — 0 llamadas IA adicionales (verificación estructural).
  {
    const contenido = readFileSyncModulo('lib/planeacion/aprobarBorrador.ts')
    verificar(!/anthropic\.messages|\.stream\(\)|new Anthropic/i.test(contenido), 'CASO K. aprobarBorrador.ts no contiene ninguna llamada nueva a Anthropic')
    // Busca IMPORTS reales del módulo de resolución, nunca una simple
    // mención en comentario (aprobarBorrador.ts explica en prosa, a
    // propósito, que NO lo importa — esa frase no debe contar como una
    // señal falsa positiva de que sí lo hace).
    verificar(!/from ['"].*resolverCurricularPlaneacion['"]/.test(contenido) && !contenido.includes('resolverCandidatosCurricularesPuro('), 'CASO K. nunca importa ni vuelve a ejecutar la resolución curricular al aprobar — solo LEE el snapshot ya validado')
  }

  console.log(fallos === 0 ? `\n✓ Todo correcto (0 fallos).` : `\n✗ ${fallos} fallo(s).`)
  process.exit(fallos === 0 ? 0 : 1)
}

function readFileSyncModulo(rutaRelativa: string): string {
  return readFileSync(new URL(`../${rutaRelativa}`, import.meta.url), 'utf-8')
}

main()
