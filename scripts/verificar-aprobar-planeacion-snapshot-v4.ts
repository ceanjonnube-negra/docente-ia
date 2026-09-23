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
import { CAMPOS_FORMATIVOS } from '../lib/seguimiento/tipos'

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
    this.cliente._registrarConsulta(this.tabla)
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
  private conteoConsultas = new Map<string, number>()

  constructor(private usuario: { id: string } | null, datosIniciales: Record<string, Fila[]> = {}) {
    for (const [tabla, filas] of Object.entries(datosIniciales)) this.tablas.set(tabla, filas.map((f) => ({ ...f })))
  }

  _registrarConsulta(tabla: string) { this.conteoConsultas.set(tabla, (this.conteoConsultas.get(tabla) ?? 0) + 1) }
  _consultasA(tabla: string): number { return this.conteoConsultas.get(tabla) ?? 0 }

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

  // ============================================================
  // PLN-1E-E — aprobación determinista desde snapshot V4: con un V4
  // válido, resumenDesdeSnapshotV4 (= candidato.borrador) reemplaza a
  // extraerResumenBorrador(historial) — el historial deja de ser
  // requisito para encontrar/reconstruir el borrador. Fixtures nuevas
  // deliberadamente DISTINTAS de resumenFixture()/CAMPOS_BLOQUE en
  // varios campos, para poder demostrar sin ambigüedad cuál fuente
  // ganó en cada caso.
  // ============================================================

  const MENSAJE_ERROR_PRIMER_INTENTO = 'No fue posible guardar la planeación en este momento. Intenta de nuevo en unos segundos.'

  const HISTORIAL_CON_ERROR_INTERMEDIO = [
    { role: 'assistant', content: BLOQUE_VALIDO },
    { role: 'user', content: 'Apruébala.' },
    { role: 'assistant', content: MENSAJE_ERROR_PRIMER_INTENTO },
  ]

  const HISTORIAL_SIN_RESUMEN = [
    { role: 'user', content: 'hola' },
    { role: 'assistant', content: '¿en qué te ayudo hoy?' },
  ]

  const HISTORIAL_VACIO: { role: string; content: string }[] = []

  // Bloque de historial con nombre/fechas/contenidos/PDA/indicadores
  // TOTALMENTE distintos de resumenFixture() — mismo formato real que
  // produce Claude, pero deliberadamente divergente para CASO E.
  const CAMPOS_BLOQUE_DIFERENTE: [string, string][] = [
    ['Nombre', 'Proyecto del historial (NO debe usarse)'],
    ['Grupo', 'activo'],
    ['Periodo de evaluación', 'Segundo trimestre'],
    ['Fecha de inicio', '2099-01-01'],
    ['Fecha de fin', '2099-01-10'],
    ['Duración', '5 días efectivos'],
    ['Propósito', 'propósito del historial, no debe persistirse'],
    ['Campos formativos', 'Ética, Naturaleza y Sociedades'],
    ['Contenidos', 'contenido-del-historial-nunca-debe-persistirse'],
    ['PDA', 'pda-del-historial-nunca-debe-persistirse'],
    ['Ejes articuladores', 'Vida Saludable'],
    ['Metodología', 'metodología del historial'],
    ['Producto final', 'producto del historial'],
    ['Secuencia didáctica', 'Día 1: actividad del historial'],
    ['Recursos', 'recurso-del-historial'],
    ['Evidencias', 'evidencia-del-historial'],
    ['Indicadores de evaluación', 'indicador-historial-1; indicador-historial-2; indicador-historial-3; indicador-historial-4; indicador-historial-5'],
  ]
  function construirBloqueDiferente(): string {
    const lineas = CAMPOS_BLOQUE_DIFERENTE.map(([etiqueta, valor]) => `${etiqueta}: ${valor}`)
    return `Otro borrador distinto.\n\n📎 RESUMEN PARA GUARDAR\n${lineas.join('\n')}\n\n¿Deseas corregir algo o aprobarla para guardarla?`
  }
  const HISTORIAL_DIFERENTE = [{ role: 'assistant', content: construirBloqueDiferente() }]

  // PLN-1E-E CASO A — V4 válido + historial original con RESUMEN → usa candidato.borrador.
  {
    const { sb, interno } = clienteFalso({ id: 'docente-1' }, datosBase())
    const snapshot = construirSnapshotV4([ITEM_OFICIAL])
    interno._tabla('conversaciones_chat').push({ id: 'conv-e2e-a', planeacion_activa: snapshot })

    const r = await aprobarBorradorPlaneacion(sb, sesion(), HISTORIAL_VALIDO, 'conv-e2e-a')
    verificar(r.ok === true, 'PLN-1E-E CASO A. aprobación exitosa con V4 válido + historial original')
    const proyecto = interno._tabla('planeacion_proyectos')[0] as { contenidos?: string[]; pda?: string[] }
    verificar(JSON.stringify(proyecto?.contenidos) === JSON.stringify(resumenFixture().contenidos), 'PLN-1E-E CASO A. contenidos persistidos = candidato.borrador.contenidos (no los del historial)')
    verificar(JSON.stringify(proyecto?.pda) === JSON.stringify(resumenFixture().pda), 'PLN-1E-E CASO A. pda persistido = candidato.borrador.pda (no el del historial)')
  }

  // PLN-1E-E CASO B — V4 válido + último assistant del historial es el error del primer intento → aprueba igual (caso exacto del E2E real / informe PLN-1E-D).
  {
    const { sb, interno } = clienteFalso({ id: 'docente-1' }, datosBase())
    const snapshot = construirSnapshotV4([ITEM_OFICIAL])
    interno._tabla('conversaciones_chat').push({ id: 'conv-e2e-b', planeacion_activa: snapshot })

    const r = await aprobarBorradorPlaneacion(sb, sesion(), HISTORIAL_CON_ERROR_INTERMEDIO, 'conv-e2e-b')
    verificar(r.ok === true, 'PLN-1E-E CASO B. aprobación exitosa aunque el último turno assistant sea el mensaje de error del primer intento (regresión del E2E real)')
    if (r.ok) {
      verificar(r.planeacion.nombre === resumenFixture().nombre, 'PLN-1E-E CASO B. el nombre persistido viene del snapshot V4')
    }
  }

  // PLN-1E-E CASO C — V4 válido + historial sin ningún RESUMEN → aprueba igual.
  {
    const { sb, interno } = clienteFalso({ id: 'docente-1' }, datosBase())
    const snapshot = construirSnapshotV4([ITEM_OFICIAL])
    interno._tabla('conversaciones_chat').push({ id: 'conv-e2e-c', planeacion_activa: snapshot })

    const r = await aprobarBorradorPlaneacion(sb, sesion(), HISTORIAL_SIN_RESUMEN, 'conv-e2e-c')
    verificar(r.ok === true, 'PLN-1E-E CASO C. aprobación exitosa con historial que nunca tuvo bloque RESUMEN')
  }

  // PLN-1E-E CASO D — V4 válido + historial vacío → el V4 sigue siendo suficiente (la firma acepta historial: []).
  {
    const { sb, interno } = clienteFalso({ id: 'docente-1' }, datosBase())
    const snapshot = construirSnapshotV4([ITEM_OFICIAL])
    interno._tabla('conversaciones_chat').push({ id: 'conv-e2e-d', planeacion_activa: snapshot })

    const r = await aprobarBorradorPlaneacion(sb, sesion(), HISTORIAL_VACIO, 'conv-e2e-d')
    verificar(r.ok === true, 'PLN-1E-E CASO D. aprobación exitosa con historial vacío — el snapshot V4 basta por sí solo')
  }

  // PLN-1E-E CASO E — V4 válido + historial con un borrador DIFERENTE → gana SIEMPRE candidato.borrador (nombre/fechas/contenidos/PDA/indicadores).
  {
    const { sb, interno } = clienteFalso({ id: 'docente-1' }, datosBase())
    const snapshot = construirSnapshotV4([ITEM_OFICIAL])
    interno._tabla('conversaciones_chat').push({ id: 'conv-e2e-e', planeacion_activa: snapshot })

    const r = await aprobarBorradorPlaneacion(sb, sesion(), HISTORIAL_DIFERENTE, 'conv-e2e-e')
    verificar(r.ok === true, 'PLN-1E-E CASO E precondición: aprobación exitosa')
    const fila = interno._tabla('planeaciones')[0] as { nombre?: string; fecha_inicio?: string; fecha_fin?: string }
    verificar(fila?.nombre === resumenFixture().nombre && fila?.nombre !== 'Proyecto del historial (NO debe usarse)', 'PLN-1E-E CASO E. nombre persistido = snapshot V4, nunca el del historial')
    verificar(fila?.fecha_inicio === resumenFixture().fechaInicio && fila?.fecha_fin === resumenFixture().fechaFin, 'PLN-1E-E CASO E. fechas persistidas = snapshot V4, nunca las del historial (2099-01-01/10)')
    const proyecto = interno._tabla('planeacion_proyectos')[0] as { contenidos?: string[]; pda?: string[]; evaluacion?: { indicadores?: string[] } }
    verificar(JSON.stringify(proyecto?.contenidos) === JSON.stringify(resumenFixture().contenidos), 'PLN-1E-E CASO E. contenidos = snapshot V4, nunca "contenido-del-historial-nunca-debe-persistirse"')
    verificar(JSON.stringify(proyecto?.pda) === JSON.stringify(resumenFixture().pda), 'PLN-1E-E CASO E. pda = snapshot V4, nunca "pda-del-historial-nunca-debe-persistirse"')
    verificar(JSON.stringify(proyecto?.evaluacion?.indicadores) === JSON.stringify(resumenFixture().indicadores), 'PLN-1E-E CASO E. indicadores = snapshot V4, nunca los "indicador-historial-*"')
  }

  // PLN-1E-E CASO F — V3 (histórico) + historial correcto → SIGUE usando extraerResumenBorrador(historial), nunca snapshot.borrador (el atajo es exclusivo de V4).
  {
    const { sb, interno } = clienteFalso({ id: 'docente-1' }, datosBase())
    const snapshotV3 = {
      schemaVersion: 3, version: 1, estado: 'borrador', implementadaEn: null,
      contexto: { grupoId: '11111111-1111-4111-8111-111111111111' },
      borrador: resumenFixture(), // distinto a propósito del historial
      contenidoCompleto: 'texto histórico v3',
      origenMensajeId: null, actualizadoEn: new Date().toISOString(),
    }
    interno._tabla('conversaciones_chat').push({ id: 'conv-e2e-f', planeacion_activa: snapshotV3 })

    const r = await aprobarBorradorPlaneacion(sb, sesion(), HISTORIAL_VALIDO, 'conv-e2e-f')
    verificar(r.ok === true, 'PLN-1E-E CASO F precondición: V3 histórico sigue siendo aprobable')
    const proyecto = interno._tabla('planeacion_proyectos')[0] as { contenidos?: string[] }
    verificar(JSON.stringify(proyecto?.contenidos) === JSON.stringify(['tradición oral', 'tipos de narración']), 'PLN-1E-E CASO F. para V3 los contenidos vienen del HISTORIAL (comportamiento histórico intacto), no de snapshotV3.borrador')
  }

  // PLN-1E-E CASO G — sin snapshot (conversacionId=null) + historial correcto → comportamiento histórico intacto.
  {
    const { sb } = clienteFalso({ id: 'docente-1' }, datosBase())
    const r = await aprobarBorradorPlaneacion(sb, sesion(), HISTORIAL_VALIDO, null)
    verificar(r.ok === true, 'PLN-1E-E CASO G. sin conversacionId, el fallback histórico (historial) sigue funcionando')
  }

  // PLN-1E-E CASO H — sin V4 + historial sin RESUMEN → sigue devolviendo SIN_BORRADOR.
  {
    const { sb } = clienteFalso({ id: 'docente-1' }, datosBase())
    const r = await aprobarBorradorPlaneacion(sb, sesion(), HISTORIAL_SIN_RESUMEN, null)
    verificar(r.ok === false && r.codigo === 'SIN_BORRADOR', 'PLN-1E-E CASO H. sin V4 y sin bloque RESUMEN en el historial, sigue devolviendo SIN_BORRADOR exactamente como antes')
  }

  // PLN-1E-E CASO I — V4 inválido/corrupto/de otro grupo → nunca se confía en él, fallback histórico (usa el historial, no un borrador inventado).
  {
    const { sb, interno } = clienteFalso({ id: 'docente-1' }, datosBase())
    interno._tabla('conversaciones_chat').push({ id: 'conv-e2e-i', planeacion_activa: { schemaVersion: 4, estado: 'borrador' /* corrupto: faltan campos */ } })

    const r = await aprobarBorradorPlaneacion(sb, sesion(), HISTORIAL_VALIDO, 'conv-e2e-i')
    verificar(r.ok === true, 'PLN-1E-E CASO I precondición: aprobación exitosa vía fallback')
    const proyecto = interno._tabla('planeacion_proyectos')[0] as { contenidos?: string[] }
    verificar(JSON.stringify(proyecto?.contenidos) === JSON.stringify(['tradición oral', 'tipos de narración']), 'PLN-1E-E CASO I. con V4 corrupto, los contenidos vienen del HISTORIAL — nunca se confía en un snapshot inválido')
  }

  // PLN-1E-E CASO J — 0 llamadas IA adicionales (estático, ya cubierto por CASO K pero repetido explícitamente para esta microfase).
  {
    const contenido = readFileSyncModulo('lib/planeacion/aprobarBorrador.ts')
    verificar(!/anthropic\.messages|\.stream\(\)|new Anthropic/i.test(contenido), 'PLN-1E-E CASO J. aprobarBorrador.ts sigue sin ninguna llamada a Anthropic tras el cambio')
  }

  // PLN-1E-E CASO K — 0 SELECT adicionales respecto a PLN-1E-B: exactamente 1 SELECT a conversaciones_chat por llamada (resumenDesdeSnapshotV4 se lee del MISMO candidato ya obtenido).
  {
    const { sb, interno } = clienteFalso({ id: 'docente-1' }, datosBase())
    const snapshot = construirSnapshotV4([ITEM_OFICIAL])
    interno._tabla('conversaciones_chat').push({ id: 'conv-e2e-k', planeacion_activa: snapshot })
    await aprobarBorradorPlaneacion(sb, sesion(), HISTORIAL_CON_ERROR_INTERMEDIO, 'conv-e2e-k')
    verificar(interno._consultasA('conversaciones_chat') === 1, 'PLN-1E-E CASO K. exactamente 1 SELECT a conversaciones_chat por aprobación (sin SELECT adicional para leer candidato.borrador)')
  }

  // PLN-1E-E CASO L — trazabilidad_curricular persistida sigue siendo EXACTAMENTE la del snapshot V4 (el cambio de fuente de `resumen` no afecta la trazabilidad).
  {
    const { sb, interno } = clienteFalso({ id: 'docente-1' }, datosBase())
    const snapshot = construirSnapshotV4([ITEM_OFICIAL, ITEM_CONTEXTUALIZADO])
    interno._tabla('conversaciones_chat').push({ id: 'conv-e2e-l', planeacion_activa: snapshot })
    await aprobarBorradorPlaneacion(sb, sesion(), HISTORIAL_CON_ERROR_INTERMEDIO, 'conv-e2e-l')
    const proyecto = interno._tabla('planeacion_proyectos')[0] as { evaluacion?: { trazabilidad_curricular?: unknown } }
    verificar(JSON.stringify(proyecto?.evaluacion?.trazabilidad_curricular) === JSON.stringify(snapshot.trazabilidadCurricular), 'PLN-1E-E CASO L. trazabilidad_curricular = snapshot.trazabilidadCurricular exacto, incluso con historial terminado en un error intermedio')
  }

  // PLN-1E-E CASO M — Word/PDF definitivo sigue usando candidato.contenidoCompleto y no el historial cuando existe V4 (aunque el último turno assistant sea el mensaje de error).
  {
    const { sb, interno } = clienteFalso({ id: 'docente-1' }, datosBase())
    const snapshot = construirSnapshotV4([ITEM_OFICIAL], '11111111-1111-4111-8111-111111111111', 'MARCADORSNAPSHOTV4UNICO')
    interno._tabla('conversaciones_chat').push({ id: 'conv-e2e-m', planeacion_activa: snapshot })
    await aprobarBorradorPlaneacion(sb, sesion(), HISTORIAL_CON_ERROR_INTERMEDIO, 'conv-e2e-m')
    const rutas = interno._rutasStorage()
    verificar(rutas.some((r) => r.includes('MARCADORSNAPSHOTV4UNICO')), 'PLN-1E-E CASO M. el documento definitivo se generó a partir del texto del snapshot V4 (marcador único presente en la ruta de Storage)')
    verificar(!rutas.some((r) => /no_fue_posible|fue_posible_guardar/i.test(r)), 'PLN-1E-E CASO M. el documento definitivo NO se generó a partir del mensaje de error del historial')
  }

  // ============================================================
  // PLN-1E-F-FIX — campo_formativo persistido al aprobar: la última
  // brecha NOT NULL sin default de `planeaciones` (informe forense
  // PLN-1E-F). Se deriva EXCLUSIVAMENTE de resumen.camposFormativos
  // (a su vez de resumenDesdeSnapshotV4 cuando hay V4 válido, ver
  // PLN-1E-E), filtrado contra CAMPOS_FORMATIVOS_VALIDOS, tomando el
  // PRIMER valor realmente válido — nunca camposFormativos[0] a ciegas.
  // ============================================================

  function construirSnapshotV4ConCampos(camposFormativos: string[], candidatos: CandidatoCurricularPlaneacion[] = [ITEM_OFICIAL]): PlaneacionActivaV4 {
    const trazabilidad = construirTrazabilidadCurricular('22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', candidatos)
    return construirPlaneacionActivaCreada({ ...resumenFixture(), camposFormativos }, construirBloque().split('\n\n📎')[0].trim(), '11111111-1111-4111-8111-111111111111', null, trazabilidad)
  }

  // PLN-1E-F-FIX CASO A — campo formativo válido llega exactamente al INSERT de planeaciones.campo_formativo.
  {
    const { sb, interno } = clienteFalso({ id: 'docente-1' }, datosBase())
    const snapshot = construirSnapshotV4ConCampos(['Lenguajes'])
    interno._tabla('conversaciones_chat').push({ id: 'conv-cf-a', planeacion_activa: snapshot })
    const r = await aprobarBorradorPlaneacion(sb, sesion(), HISTORIAL_VALIDO, 'conv-cf-a')
    verificar(r.ok === true, 'PLN-1E-F-FIX CASO A precondición: aprobación exitosa')
    const fila = interno._tabla('planeaciones')[0] as { campo_formativo?: string }
    verificar(fila?.campo_formativo === 'Lenguajes', 'PLN-1E-F-FIX CASO A. campo_formativo = "Lenguajes" exacto en la fila insertada')
  }

  // PLN-1E-F-FIX CASO B — cada campo permitido por CAMPOS_FORMATIVOS_VALIDOS atraviesa el flujo sin transformación.
  for (const campo of CAMPOS_FORMATIVOS) {
    const { sb, interno } = clienteFalso({ id: 'docente-1' }, datosBase())
    const snapshot = construirSnapshotV4ConCampos([campo])
    interno._tabla('conversaciones_chat').push({ id: `conv-cf-b-${campo}`, planeacion_activa: snapshot })
    const r = await aprobarBorradorPlaneacion(sb, sesion(), HISTORIAL_VALIDO, `conv-cf-b-${campo}`)
    const fila = interno._tabla('planeaciones')[0] as { campo_formativo?: string }
    verificar(r.ok === true && fila?.campo_formativo === campo, `PLN-1E-F-FIX CASO B. "${campo}" atraviesa el flujo sin transformación`)
  }

  // PLN-1E-F-FIX CASO C — un valor no permitido no llega al INSERT.
  {
    const { sb, interno } = clienteFalso({ id: 'docente-1' }, datosBase())
    const snapshot = construirSnapshotV4ConCampos(['Materia inventada'])
    interno._tabla('conversaciones_chat').push({ id: 'conv-cf-c', planeacion_activa: snapshot })
    const filasAntes = interno._tabla('planeaciones').length
    const r = await aprobarBorradorPlaneacion(sb, sesion(), HISTORIAL_VALIDO, 'conv-cf-c')
    verificar(r.ok === false && r.codigo === 'BORRADOR_INCOMPLETO', 'PLN-1E-F-FIX CASO C. un campo formativo no permitido produce BORRADOR_INCOMPLETO')
    verificar(interno._tabla('planeaciones').length === filasAntes, 'PLN-1E-F-FIX CASO C. ningún valor no permitido llega al INSERT (0 filas nuevas)')
  }

  // PLN-1E-F-FIX CASO D — camposFormativos=[] falla antes del INSERT.
  // NOTA: un V4 con camposFormativos=[] nunca puede ser "válido" — la
  // MISMA regla de completitud (validarContenidoBorrador, exigida
  // desde antes de esta microfase) ya invalida un snapshot así en
  // esPlaneacionActivaValida, así que el caso realista y alcanzable es
  // sin V4 (fallback histórico): un bloque de resumen al que le falta
  // por completo la línea "Campos formativos" produce
  // resumen.camposFormativos=[] vía extraerResumenBorrador, y
  // validarContenidoBorrador lo rechaza ANTES de llegar a mi nuevo
  // campoFormativoValidado/crearPlaneacion — mismo código de error,
  // mismo resultado ("falla antes del INSERT").
  {
    const lineasSinCamposFormativos = CAMPOS_BLOQUE.filter(([etiqueta]) => etiqueta !== 'Campos formativos').map(([etiqueta, valor]) => `${etiqueta}: ${valor}`)
    const bloqueSinCamposFormativos = `Borrador sin campos formativos.\n\n📎 RESUMEN PARA GUARDAR\n${lineasSinCamposFormativos.join('\n')}\n\n¿Deseas corregir algo o aprobarla para guardarla?`
    const historialSinCamposFormativos = [{ role: 'assistant', content: bloqueSinCamposFormativos }]

    const { sb, interno } = clienteFalso({ id: 'docente-1' }, datosBase())
    const filasAntes = interno._tabla('planeaciones').length
    const r = await aprobarBorradorPlaneacion(sb, sesion(), historialSinCamposFormativos, null)
    verificar(r.ok === false && r.codigo === 'BORRADOR_INCOMPLETO', 'PLN-1E-F-FIX CASO D. camposFormativos=[] produce BORRADOR_INCOMPLETO (validarContenidoBorrador, antes de mi nuevo chequeo)')
    verificar(interno._tabla('planeaciones').length === filasAntes, 'PLN-1E-F-FIX CASO D. camposFormativos=[] no llega al INSERT')
  }

  // PLN-1E-F-FIX CASO E — un string inventado/no reconocido (único elemento) falla antes del INSERT.
  {
    const { sb, interno } = clienteFalso({ id: 'docente-1' }, datosBase())
    const snapshot = construirSnapshotV4ConCampos(['Ciencias Naturales (no existe en el enum real)'])
    interno._tabla('conversaciones_chat').push({ id: 'conv-cf-e', planeacion_activa: snapshot })
    const filasAntes = interno._tabla('planeaciones').length
    const r = await aprobarBorradorPlaneacion(sb, sesion(), HISTORIAL_VALIDO, 'conv-cf-e')
    verificar(r.ok === false && r.codigo === 'BORRADOR_INCOMPLETO', 'PLN-1E-F-FIX CASO E. un string inventado/no reconocido produce BORRADOR_INCOMPLETO')
    verificar(interno._tabla('planeaciones').length === filasAntes, 'PLN-1E-F-FIX CASO E. el string inventado no llega al INSERT')
  }

  // PLN-1E-F-FIX CASO F — con varios campos donde el primero es inválido, se selecciona el primer valor VÁLIDO (no array[0] a ciegas).
  {
    const { sb, interno } = clienteFalso({ id: 'docente-1' }, datosBase())
    const snapshot = construirSnapshotV4ConCampos(['Materia inventada', 'Saberes y Pensamiento Científico'])
    interno._tabla('conversaciones_chat').push({ id: 'conv-cf-f', planeacion_activa: snapshot })
    const r = await aprobarBorradorPlaneacion(sb, sesion(), HISTORIAL_VALIDO, 'conv-cf-f')
    verificar(r.ok === true, 'PLN-1E-F-FIX CASO F precondición: aprobación exitosa (sí hay un valor válido, aunque no sea el primero)')
    const fila = interno._tabla('planeaciones')[0] as { campo_formativo?: string }
    verificar(fila?.campo_formativo === 'Saberes y Pensamiento Científico', 'PLN-1E-F-FIX CASO F. selecciona el primer valor VÁLIDO ("Saberes y Pensamiento Científico"), nunca camposFormativos[0] ("Materia inventada")')
  }

  // PLN-1E-F-FIX CASO G — el valor persistido proviene de resumen.camposFormativos (estructural: ni del cliente ni de una consulta nueva).
  {
    const contenido = readFileSyncModulo('lib/planeacion/aprobarBorrador.ts')
    verificar(/resumen\.camposFormativos\.find/.test(contenido), 'PLN-1E-F-FIX CASO G. campo_formativo se deriva de resumen.camposFormativos.find(...), no de otra fuente')
    verificar(!/sesion\.\w*campo/i.test(contenido), 'PLN-1E-F-FIX CASO G. campo_formativo nunca se lee desde `sesion` (dato de cliente)')
  }

  // PLN-1E-F-FIX CASO H — V4 sigue usando candidato.borrador como fuente del resumen (campo_formativo Y contenidos/pda del snapshot, nunca del historial).
  {
    const { sb, interno } = clienteFalso({ id: 'docente-1' }, datosBase())
    const snapshot = construirSnapshotV4ConCampos(['De lo Humano y lo Comunitario'])
    interno._tabla('conversaciones_chat').push({ id: 'conv-cf-h', planeacion_activa: snapshot })
    const r = await aprobarBorradorPlaneacion(sb, sesion(), HISTORIAL_DIFERENTE, 'conv-cf-h')
    verificar(r.ok === true, 'PLN-1E-F-FIX CASO H precondición: aprobación exitosa con historial totalmente distinto')
    const fila = interno._tabla('planeaciones')[0] as { campo_formativo?: string }
    verificar(fila?.campo_formativo === 'De lo Humano y lo Comunitario', 'PLN-1E-F-FIX CASO H. campo_formativo viene del snapshot V4 (candidato.borrador), nunca del historial ("Ética, Naturaleza y Sociedades")')
  }

  // PLN-1E-F-FIX CASO I — el caso real de retry con historial terminado en mensaje de error sigue funcionando (con campo_formativo incluido).
  {
    const { sb, interno } = clienteFalso({ id: 'docente-1' }, datosBase())
    const snapshot = construirSnapshotV4ConCampos(['Lenguajes'])
    interno._tabla('conversaciones_chat').push({ id: 'conv-cf-i', planeacion_activa: snapshot })
    const r = await aprobarBorradorPlaneacion(sb, sesion(), HISTORIAL_CON_ERROR_INTERMEDIO, 'conv-cf-i')
    verificar(r.ok === true, 'PLN-1E-F-FIX CASO I. el retry real (historial terminado en el mensaje de error) sigue aprobando correctamente tras agregar campo_formativo')
    const fila = interno._tabla('planeaciones')[0] as { campo_formativo?: string }
    verificar(fila?.campo_formativo === 'Lenguajes', 'PLN-1E-F-FIX CASO I. campo_formativo persistido correctamente incluso en el caso real del retry')
  }

  // PLN-1E-F-FIX CASO J — institucion_id sigue llegando correctamente desde grupos.institucion_id (reconfirmación end-to-end tras este cambio).
  {
    const { sb, interno } = clienteFalso({ id: 'docente-1' }, datosBase())
    const snapshot = construirSnapshotV4ConCampos(['Lenguajes'])
    interno._tabla('conversaciones_chat').push({ id: 'conv-cf-j', planeacion_activa: snapshot })
    await aprobarBorradorPlaneacion(sb, sesion(), HISTORIAL_VALIDO, 'conv-cf-j')
    const fila = interno._tabla('planeaciones')[0] as { institucion_id?: string }
    verificar(fila?.institucion_id === 'institucion-1', 'PLN-1E-F-FIX CASO J. institucion_id sigue llegando de grupos.institucion_id, sin regresión')
  }

  // PLN-1E-F-FIX CASO K — el INSERT resultante satisface todas las columnas NOT NULL sin default conocidas de planeaciones.
  {
    const { sb, interno } = clienteFalso({ id: 'docente-1' }, datosBase())
    const snapshot = construirSnapshotV4ConCampos(['Lenguajes'])
    interno._tabla('conversaciones_chat').push({ id: 'conv-cf-k', planeacion_activa: snapshot })
    await aprobarBorradorPlaneacion(sb, sesion(), HISTORIAL_VALIDO, 'conv-cf-k')
    const fila = interno._tabla('planeaciones')[0] as { id?: string; institucion_id?: string; docente_id?: string; grupo_id?: string; campo_formativo?: string }
    verificar(!!fila?.id && !!fila?.institucion_id && !!fila?.docente_id && !!fila?.grupo_id && !!fila?.campo_formativo, 'PLN-1E-F-FIX CASO K. id/institucion_id/docente_id/grupo_id/campo_formativo (todas las columnas NOT NULL sin default) están presentes')
  }

  // PLN-1E-F-FIX CASO L — 0 llamadas IA nuevas (estático).
  {
    const contenidoAprobar = readFileSyncModulo('lib/planeacion/aprobarBorrador.ts')
    const contenidoPersistencia = readFileSyncModulo('lib/planeacion/persistencia.ts')
    verificar(!/anthropic\.messages|\.stream\(\)|new Anthropic/i.test(contenidoAprobar) && !/anthropic\.messages|\.stream\(\)|new Anthropic/i.test(contenidoPersistencia), 'PLN-1E-F-FIX CASO L. ni aprobarBorrador.ts ni persistencia.ts referencian Anthropic tras este cambio')
  }

  // PLN-1E-F-FIX CASO M — 0 SELECT adicionales: sigue siendo exactamente 1 SELECT a conversaciones_chat y 1 SELECT a grupos por aprobación.
  {
    const { sb, interno } = clienteFalso({ id: 'docente-1' }, datosBase())
    const snapshot = construirSnapshotV4ConCampos(['Lenguajes'])
    interno._tabla('conversaciones_chat').push({ id: 'conv-cf-m', planeacion_activa: snapshot })
    await aprobarBorradorPlaneacion(sb, sesion(), HISTORIAL_VALIDO, 'conv-cf-m')
    verificar(interno._consultasA('conversaciones_chat') === 1, 'PLN-1E-F-FIX CASO M. exactamente 1 SELECT a conversaciones_chat (campo_formativo se deriva en memoria, sin SELECT adicional)')
  }

  // PLN-1E-F-FIX CASO N — la idempotencia existente no cambia: un retry sobre la misma huella recupera la MISMA fila, con el MISMO campo_formativo.
  {
    const { sb, interno } = clienteFalso({ id: 'docente-1' }, datosBase())
    const snapshot = construirSnapshotV4ConCampos(['Lenguajes'])
    interno._tabla('conversaciones_chat').push({ id: 'conv-cf-n', planeacion_activa: snapshot })

    interno.forzarErrorEn('planeaciones', 'update')
    const r1 = await aprobarBorradorPlaneacion(sb, sesion(), HISTORIAL_VALIDO, 'conv-cf-n')
    verificar(r1.ok === false, 'PLN-1E-F-FIX CASO N precondición: primer intento falla (Fase 6 forzada a fallar), fila temporal ya creada con campo_formativo')
    interno.quitarErrorForzado('planeaciones', 'update')

    const r2 = await aprobarBorradorPlaneacion(sb, sesion(), HISTORIAL_VALIDO, 'conv-cf-n')
    verificar(r2.ok === true, 'PLN-1E-F-FIX CASO N. el reintento sobre la misma huella tiene éxito')
    verificar(interno._tabla('planeaciones').length === 1, 'PLN-1E-F-FIX CASO N. sigue existiendo UNA sola fila — el reintento nunca duplica')
    const fila = interno._tabla('planeaciones')[0] as { campo_formativo?: string }
    verificar(fila?.campo_formativo === 'Lenguajes', 'PLN-1E-F-FIX CASO N. el campo_formativo final sigue siendo el mismo tras el reintento — la idempotencia no cambió')
  }

  console.log(fallos === 0 ? `\n✓ Todo correcto (0 fallos).` : `\n✗ ${fallos} fallo(s).`)
  process.exit(fallos === 0 ? 0 : 1)
}

function readFileSyncModulo(rutaRelativa: string): string {
  return readFileSync(new URL(`../${rutaRelativa}`, import.meta.url), 'utf-8')
}

main()
