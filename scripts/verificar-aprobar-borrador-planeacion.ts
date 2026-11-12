// scripts/verificar-aprobar-borrador-planeacion.ts
//
// Prueba aislada (sin credenciales, sin red, sin datos reales) de
// C-005 Paso 3C — extracción determinista del borrador
// (lib/planeacion/extraerBorrador.ts), validación estructural
// (lib/planeacion/validarContenidoBorrador.ts) y orquestación de la
// aprobación real en dos fases (lib/planeacion/aprobarBorrador.ts),
// con un doble en memoria de SupabaseClient. No prueba la
// clasificación real de Claude ni el texto que redacta el modelo
// grande — misma limitación ya documentada en los Pasos 1-3B. Se
// ejecuta con `npx tsx scripts/verificar-aprobar-borrador-planeacion.ts`.

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import JSZip from 'jszip'
import { PDFArray, PDFDocument, PDFName, type PDFRawStream, type PDFStream } from 'pdf-lib'
import type { SupabaseClient } from '@supabase/supabase-js'
import { extraerResumenBorrador, tieneBloqueResumen, type ResumenBorrador } from '../lib/planeacion/extraerBorrador'
import { validarContenidoBorrador } from '../lib/planeacion/validarContenidoBorrador'
import { aprobarBorradorPlaneacion } from '../lib/planeacion/aprobarBorrador'
import { configurarClienteRegistroArchivos } from '../lib/documentGen/registroArchivos'
import { listarPlaneaciones } from '../lib/planeacion/persistencia'
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

// --- Doble mínimo de SupabaseClient (mismo patrón de los pasos previos,
//     con soporte para .gt() y para forzar un error en una tabla/operación) ---

type Fila = Record<string, unknown>
type Escritura = { tabla: string; tipo: 'insert' | 'update' | 'delete' }

class ConsultaFalsa {
  private filtros: Array<[string, unknown]> = []
  private condiciones: Array<(f: Fila) => boolean> = []
  private rangos: Array<['gt', string, unknown]> = []
  private orden: { columna: string; ascendente: boolean } | null = null
  private operacion: 'consultar' | 'insertar' | 'actualizar' = 'consultar'
  private payload: Fila | Fila[] | null = null

  constructor(private cliente: ClienteSupabaseFalso, private tabla: string) {}

  select(_columnas: string) {
    void _columnas
    return this
  }

  insert(valores: Fila | Fila[]) {
    this.operacion = 'insertar'
    this.payload = valores
    this.cliente._registrarEscritura(this.tabla, 'insert')
    return this
  }

  update(valores: Fila) {
    this.operacion = 'actualizar'
    this.payload = valores
    this.cliente._registrarEscritura(this.tabla, 'update')
    return this
  }

  eq(columna: string, valor: unknown) {
    this.filtros.push([columna, valor])
    return this
  }

  // UPDATE condicional del generador de hojas (vincularHojaAlProyecto):
  // .is(col, null) y .or("col.is.null,col.not.in.(a,b)").
  is(columna: string, valor: unknown) {
    this.condiciones.push((f) => (valor === null ? f[columna] == null : f[columna] === valor))
    return this
  }

  or(expresion: string) {
    const alternativas = (expresion.match(/[^,(]+(\([^)]*\))?/g) ?? []).map((parte) => {
      const m = parte.match(/^(\w+)\.(?:is\.null|not\.in\.\((.*)\))$/)
      if (!m) throw new Error(`or() no soportado: ${parte}`)
      const [, columna, lista] = m
      return lista === undefined ? (f: Fila) => f[columna] == null : (f: Fila) => f[columna] != null && !lista.split(",").includes(String(f[columna]))
    })
    this.condiciones.push((f) => alternativas.some((alternativa) => alternativa(f)))
    return this
  }

  gt(columna: string, valor: unknown) {
    this.rangos.push(['gt', columna, valor])
    return this
  }

  order(columna: string, opciones?: { ascending?: boolean }) {
    this.orden = { columna, ascendente: opciones?.ascending ?? true }
    return this
  }

  private ejecutar(): { data: Fila[] | null; error: { message: string; code?: string } | null } {
    if (this.cliente._debeFallar(this.tabla, this.operacion === 'insertar' ? 'insert' : this.operacion === 'actualizar' ? 'update' : 'select')) {
      return { data: null, error: { message: `Error simulado en ${this.tabla}` } }
    }

    const filas = this.cliente._tabla(this.tabla)

    if (this.operacion === 'insertar') {
      const nuevas = Array.isArray(this.payload) ? this.payload : [this.payload as Fila]
      if (this.tabla === 'hojas_evaluacion') {
        for (const nueva of nuevas) {
          if (filas.some((f) => f.identificador_visible === nueva.identificador_visible)) {
            return { data: null, error: { message: 'duplicate key value violates unique constraint', code: '23505' } as { message: string; code?: string } }
          }
        }
      }
      const insertadas = nuevas.map((f) => ({ id: randomUUID(), creado_en: new Date().toISOString(), actualizado_en: new Date().toISOString(), generado_en: new Date().toISOString(), storage_path: null, ...f }))
      filas.push(...insertadas)
      return { data: insertadas, error: null }
    }

    if (this.operacion === 'actualizar') {
      const coincidentes = filas.filter((f) => this.filtros.every(([c, v]) => f[c] === v) && this.condiciones.every((p) => p(f)))
      coincidentes.forEach((f) => Object.assign(f, this.payload))
      return { data: coincidentes, error: null }
    }

    let resultado = filas.filter((f) =>
      this.filtros.every(([c, v]) => f[c] === v) &&
      this.rangos.every(([, c, v]) => Number(f[c]) > Number(v))
    )
    if (this.orden) {
      const { columna, ascendente } = this.orden
      resultado = [...resultado].sort((a, b) => {
        const av = String(a[columna] ?? '')
        const bv = String(b[columna] ?? '')
        if (av < bv) return ascendente ? -1 : 1
        if (av > bv) return ascendente ? 1 : -1
        return 0
      })
    }
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

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: { data: Fila[] | null; error: { message: string; code?: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.ejecutar()).then(onfulfilled, onrejected)
  }
}

class ClienteSupabaseFalso {
  private tablas = new Map<string, Fila[]>()
  private archivosStorage = new Map<string, Buffer>()
  public escrituras: Escritura[] = []
  private fallasForzadas: Array<{ tabla: string; operacion: 'insert' | 'update' | 'select' }> = []
  private fallaStorageForzada = false

  constructor(private usuario: { id: string } | null, datosIniciales: Record<string, Fila[]> = {}) {
    for (const [tabla, filas] of Object.entries(datosIniciales)) {
      this.tablas.set(tabla, filas.map((f) => ({ ...f })))
    }
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
      upload: async (ruta: string, buffer: Buffer) => {
        if (this.fallaStorageForzada) return { error: { message: 'Error simulado subiendo a Storage' } }
        this.archivosStorage.set(`${bucket}/${ruta}`, buffer)
        return { error: null }
      },
      createSignedUrl: async (ruta: string) => {
        if (!this.archivosStorage.has(`${bucket}/${ruta}`)) return { data: null, error: { message: 'archivo no encontrado' } }
        return { data: { signedUrl: `https://fake-storage.local/${bucket}/${ruta}` }, error: null }
      },
      remove: async (rutas: string[]) => {
        rutas.forEach((r) => this.archivosStorage.delete(`${bucket}/${r}`))
        return { error: null }
      },
    }),
  }

  forzarErrorStorage() {
    this.fallaStorageForzada = true
  }

  from(tabla: string) {
    return new ConsultaFalsa(this, tabla)
  }

  forzarErrorEn(tabla: string, operacion: 'insert' | 'update' | 'select') {
    this.fallasForzadas.push({ tabla, operacion })
  }

  quitarErrorForzado(tabla: string, operacion: 'insert' | 'update' | 'select') {
    this.fallasForzadas = this.fallasForzadas.filter((f) => !(f.tabla === tabla && f.operacion === operacion))
  }

  _tabla(tabla: string): Fila[] {
    if (!this.tablas.has(tabla)) this.tablas.set(tabla, [])
    return this.tablas.get(tabla)!
  }

  _registrarEscritura(tabla: string, tipo: 'insert' | 'update' | 'delete') {
    this.escrituras.push({ tabla, tipo })
  }

  _debeFallar(tabla: string, operacion: 'insert' | 'update' | 'select'): boolean {
    return this.fallasForzadas.some((f) => f.tabla === tabla && f.operacion === operacion)
  }
}

function clienteFalso(usuario: { id: string } | null, datos: Record<string, Fila[]> = {}): { sb: SupabaseClient; interno: ClienteSupabaseFalso } {
  const interno = new ClienteSupabaseFalso(usuario, datos)
  return { sb: interno as unknown as SupabaseClient, interno }
}

const DOCENTE_1 = { id: 'docente-1' }
const DOCENTE_2 = { id: 'docente-2' }

function datosBase(): Record<string, Fila[]> {
  return {
    grupos: [
      { id: 'grupo-1', docente_id: 'docente-1', ciclo_escolar_id: 'ciclo-1', institucion_id: 'institucion-1' },
      { id: 'grupo-2', docente_id: 'docente-2', ciclo_escolar_id: 'ciclo-2', institucion_id: 'institucion-2' },
    ],
    planeaciones: [],
    planeacion_proyectos: [],
    periodos_evaluacion: [],
    proyectos_seguimiento: [],
    hojas_evaluacion: [],
    inscripciones: [
      { grupo_id: 'grupo-1', estatus: 'activo', alumnos: { id: 'a1', nombre: 'Beatriz López', curp: null, sexo: 'M', fecha_nacimiento: null } },
      { grupo_id: 'grupo-2', estatus: 'activo', alumnos: { id: 'a2', nombre: 'Andrés Pérez', curp: null, sexo: 'H', fecha_nacimiento: null } },
    ],
    perfiles_docentes: [
      { id: 'docente-1', escuela: 'Escuela de prueba', grado: '4°', grupo: 'B', ciclo_escolar: '2026-2027' },
      { id: 'docente-2', escuela: 'Escuela de prueba', grado: '5°', grupo: 'A', ciclo_escolar: '2026-2027' },
    ],
  }
}

function sesion(overrides: Partial<SesionContexto> = {}): SesionContexto {
  return {
    docente_id: 'docente-1',
    institucion_id: 'institucion-1',
    ciclo_escolar_id: 'ciclo-1',
    grupo_activo_id: 'grupo-1',
    fecha_actual: '2026-08-10',
    alumnos_del_grupo_activo: [],
    ...overrides,
  }
}

// --- Constructor de bloques de resumen (permite omitir/sobrescribir
//     campos para probar cada validación por separado) ---

const CAMPOS_BLOQUE: [string, string][] = [
  ['Nombre', 'Leyendas de mi comunidad'],
  ['Grupo', 'activo'],
  ['Periodo de evaluación', 'Primer trimestre'],
  ['Fecha de inicio', '2026-08-10'],
  ['Fecha de fin', '2026-08-21'],
  ['Duración', '10 días efectivos'],
  ['Propósito', 'que los alumnos investiguen y compartan leyendas de su comunidad'],
  ['Campos formativos', 'Lenguajes; De lo Humano y lo Comunitario'],
  ['Contenidos', 'tradición oral; tipos de narración'],
  ['PDA', 'identifica elementos de una leyenda; narra una leyenda con sus palabras'],
  ['Ejes articuladores', 'Interculturalidad Crítica'],
  ['Metodología', 'aprendizaje basado en proyectos'],
  ['Producto final', 'antología de leyendas ilustrada'],
  ['Secuencia didáctica', 'Día 1: introducción al tema; Día 2: investigación; Día 3: redacción final'],
  ['Recursos', 'libros de la biblioteca del aula; hojas de rotafolio'],
  ['Evidencias', 'borrador escrito; antología final'],
  ['Indicadores de evaluación', 'identifica estructura narrativa; participa en la investigación; presenta su leyenda'],
]

function construirBloque(omitir: string[] = [], overrides: Record<string, string> = {}): string {
  const lineas = CAMPOS_BLOQUE.filter(([etiqueta]) => !omitir.includes(etiqueta)).map(
    ([etiqueta, valorDefault]) => `${etiqueta}: ${overrides[etiqueta] ?? valorDefault}`
  )
  return `Aquí está tu borrador completo.\n\n📎 RESUMEN PARA GUARDAR\n${lineas.join('\n')}\n\n¿Deseas corregir algo o aprobarla para guardarla?`
}

const BLOQUE_VALIDO = construirBloque()
const BLOQUE_INCOMPLETO = `Aquí está tu borrador.\n\n📎 RESUMEN PARA GUARDAR\nNombre: Leyendas de mi comunidad\nGrupo: activo\nFecha de inicio: 2026-08-10\n\n¿Deseas corregir algo o aprobarla para guardarla?`
const BLOQUE_CORREGIDO = construirBloque([], { 'Fecha de fin': '2026-08-28', Nombre: 'Leyendas de mi comunidad (ampliada)' })

// Red simulada para toda la suite: ejecutarHerramientaDocumento comprueba
// con HEAD la URL firmada de cada archivo subido; el Storage simulado
// devuelve https://fake-storage.local/…, así que solo esos HEAD reciben un
// 200 simulado. Cualquier otra solicitud se rechaza: la prueba nunca sale
// a la red.
const fetchSimulado: typeof fetch = async (entrada, init) => {
  const url = new URL(typeof entrada === 'string' ? entrada : entrada instanceof URL ? entrada.href : entrada.url)
  const metodo = (init?.method ?? (entrada instanceof Request ? entrada.method : 'GET')).toUpperCase()
  if (url.hostname === 'fake-storage.local' && metodo === 'HEAD') return new Response(null, { status: 200 })
  throw new Error(`Red bloqueada en esta prueba: ${metodo} ${url.hostname}`)
}

// Registro de archivos (etapa 3B-2A): en producción lo escribe el servidor
// con la llave de servicio; aquí, un doble en memoria que solo acepta lo
// que acepta la tabla real (sin conversación salvo 'efimero').
const registroArchivos: Record<string, unknown>[] = []
configurarClienteRegistroArchivos({
  from: () => {
    let fila: Record<string, unknown> | null = null
    let cambios: Record<string, unknown> | null = null
    const filtros: [string, unknown][] = []
    const consulta = {
      insert: (d: Record<string, unknown>) => { fila = d; return consulta },
      update: (d: Record<string, unknown>) => { cambios = d; return consulta },
      select: () => consulta,
      eq: (c: string, v: unknown) => { filtros.push([c, v]); return consulta },
      maybeSingle: () => consulta,
      then: (ok: (r: unknown) => unknown) => {
        if (fila) {
          if ((fila.clase === 'efimero') !== (fila.conversacion_id != null)) return Promise.resolve({ error: { code: '23514', message: 'check' } }).then(ok)
          registroArchivos.push({ estado: 'subiendo', ...fila })
          return Promise.resolve({ error: null }).then(ok)
        }
        const afectadas = registroArchivos.filter((f) => filtros.every(([c, v]) => f[c] === v))
        if (cambios) afectadas.forEach((f) => Object.assign(f, cambios))
        return Promise.resolve({ data: afectadas.map((f) => ({ id: f.id, estado: f.estado })), error: null }).then(ok)
      },
    }
    return consulta
  },
} as never)

async function main() {
  const fetchOriginal = globalThis.fetch
  globalThis.fetch = fetchSimulado
  try {
  // --- extraerResumenBorrador / tieneBloqueResumen ---

  {
    const historial = [{ role: 'user', content: 'guárdala' }]
    verificar(extraerResumenBorrador(historial) === null, '6. Sin ningún turno de asistente al final: extraerResumenBorrador devuelve null')
    verificar(!tieneBloqueResumen(historial), '6b. tieneBloqueResumen también es false en ese caso')
  }
  {
    const historial = [{ role: 'assistant', content: 'Hola, ¿en qué te ayudo hoy?' }]
    verificar(extraerResumenBorrador(historial) === null, '6c. Turno de asistente sin bloque de resumen: null')
  }
  {
    const historial = [{ role: 'assistant', content: BLOQUE_INCOMPLETO }]
    verificar(extraerResumenBorrador(historial) === null, '7. Bloque presente pero sin fecha_fin: extraerResumenBorrador devuelve null')
    verificar(tieneBloqueResumen(historial), '7b. tieneBloqueResumen SÍ detecta que el bloque existe (distingue de "inexistente")')
  }
  {
    const historial = [{ role: 'assistant', content: BLOQUE_VALIDO }]
    const r = extraerResumenBorrador(historial)
    verificar(r !== null && r.nombre === 'Leyendas de mi comunidad', 'Extrae el nombre correctamente')
    verificar(r !== null && r.fechaInicio === '2026-08-10' && r.fechaFin === '2026-08-21', 'Extrae las fechas correctamente')
    verificar(r !== null && r.duracionDias === 10, 'Extrae la duración en días efectivos')
    verificar(r !== null && r.secuenciaDidactica.length === 3 && r.secuenciaDidactica[0].dia === 1, 'Extrae la secuencia didáctica día por día')
    verificar(r !== null && r.indicadores.length === 3, 'Extrae los 3 indicadores de evaluación')
  }
  {
    const historial = [{ role: 'assistant', content: BLOQUE_VALIDO }, { role: 'user', content: 'amplíala una semana' }, { role: 'assistant', content: BLOQUE_CORREGIDO }]
    const r = extraerResumenBorrador(historial)
    verificar(r !== null && r.fechaFin === '2026-08-28', '15. Se usa el resumen del último turno (corregido), no uno anterior')
  }

  // --- validarContenidoBorrador — casos 6 a 12 del bloque de cierre técnico ---

  const resumenBase = extraerResumenBorrador([{ role: 'assistant', content: BLOQUE_VALIDO }]) as ResumenBorrador
  verificar(validarContenidoBorrador(resumenBase).ok === true, 'Un borrador completo pasa la validación estructural')

  const camposObligatoriosParaProbarFaltantes: Array<[string, string]> = [
    ['Campos formativos', '6. Borrador sin campos_formativos es rechazado'],
    ['Contenidos', '7. Borrador sin contenidos es rechazado'],
    ['PDA', '8. Borrador sin PDA es rechazado'],
    ['Secuencia didáctica', '9. Borrador sin secuencia didáctica es rechazado'],
    ['Indicadores de evaluación', '10/11. Borrador sin indicadores (y por lo tanto sin hoja de evaluación provisional válida) es rechazado'],
  ]
  for (const [campo, etiquetaPrueba] of camposObligatoriosParaProbarFaltantes) {
    const bloque = construirBloque([campo])
    const resumen = extraerResumenBorrador([{ role: 'assistant', content: bloque }])
    const validacion = resumen ? validarContenidoBorrador(resumen) : { ok: false as const, elementosFaltantes: [], mensaje: '' }
    verificar(validacion.ok === false, etiquetaPrueba)
  }

  // 12. Tipo inválido dentro del contenido estructurado (se construye
  //     directo, sin pasar por el parser, para simular un tipo incorrecto)
  {
    const resumenTipoInvalido: ResumenBorrador = {
      ...resumenBase,
      duracionDias: 'diez' as unknown as number,
    }
    const validacion = validarContenidoBorrador(resumenTipoInvalido)
    verificar(validacion.ok === false && validacion.elementosFaltantes.includes('duración calculada'), '12. Un tipo inválido en el contenido estructurado es rechazado (duración no numérica)')
  }

  // --- aprobarBorradorPlaneacion: flujo completo en dos fases ---

  // 1/2/3. Guardado con un borrador activo válido y completo
  {
    const { sb, interno } = clienteFalso(DOCENTE_1, datosBase())
    const r = await aprobarBorradorPlaneacion(sb, sesion(), [{ role: 'assistant', content: BLOQUE_VALIDO }])
    verificar(r.ok === true, '1/2/3. Con un borrador activo válido y completo, la aprobación guarda con éxito')
    if (r.ok) {
      verificar(r.planeacion.nombre === 'Leyendas de mi comunidad', '1b. La planeación guardada tiene el nombre correcto')
      verificar(r.duracionDias === 10, '1c. Se conserva la duración para el mensaje de confirmación')
      verificar(r.planeacion.version === 1, '1d. La versión final es 1 (promovida desde el centinela 0)')
    }
    verificar(interno._tabla('planeaciones').length === 1, '8. Se insertó exactamente 1 fila en planeaciones')
    const proyectos = interno._tabla('planeacion_proyectos')
    verificar(proyectos.length === 1, '9. Se insertó exactamente 1 fila en planeacion_proyectos')
    const proyecto = proyectos[0] as { nombre: string; actividades: unknown; evaluacion: { indicadores?: unknown; proyecto_seguimiento_id?: unknown; hoja_id?: unknown; hoja_identificador_visible?: unknown } }
    verificar(proyecto.nombre === 'Leyendas de mi comunidad', '9b. El proyecto guardado tiene el nombre correcto')
    verificar(Array.isArray(proyecto.actividades) && (proyecto.actividades as unknown[]).length === 3, '13. La secuencia didáctica se mapea a planeacion_proyectos.actividades (día por día, sin duplicar toda la planeación)')
    const evaluacion = proyecto.evaluacion
    verificar(Array.isArray(evaluacion?.indicadores) && (evaluacion.indicadores as unknown[]).length === 3, 'Los indicadores de evaluación quedan guardados en la relación')
    verificar(!!evaluacion?.proyecto_seguimiento_id && !!evaluacion?.hoja_id, '11. El vínculo real con proyectos_seguimiento/hojas_evaluacion queda guardado en la relación (sustituye la estructura provisional)')

    // Integración con Seguimiento (corrección funcional): la hoja
    // DEFINITIVA (real, con PDF e identificador SG-XXXX) queda creada
    // como parte de la MISMA aprobación — nunca una segunda operación.
    verificar(interno._tabla('proyectos_seguimiento').length === 1, 'Se creó exactamente 1 proyecto de Seguimiento vinculado')
    verificar(interno._tabla('hojas_evaluacion').length === 1, 'Se creó exactamente 1 hoja de evaluación definitiva')
    const hoja = interno._tabla('hojas_evaluacion')[0] as { identificador_visible: string; storage_path: string | null }
    verificar(hoja.identificador_visible.startsWith('SG-'), 'La hoja definitiva tiene un identificador real (SG-XXXX), no "VISTA PREVIA"')
    verificar(!!hoja.storage_path, 'La hoja definitiva quedó realmente subida a Storage (storage_path no nulo)')
    const proyectoSeguimiento = interno._tabla('proyectos_seguimiento')[0] as { estado: string; hoja_id: string | null }
    verificar(proyectoSeguimiento.estado === 'hoja_generada' && !!proyectoSeguimiento.hoja_id, 'El proyecto de Seguimiento queda en estado hoja_generada, vinculado a su hoja')
  }

  // 14. Estado final compatible con el esquema/interfaz real
  {
    const { sb } = clienteFalso(DOCENTE_1, datosBase())
    const r = await aprobarBorradorPlaneacion(sb, sesion(), [{ role: 'assistant', content: BLOQUE_VALIDO }])
    verificar(r.ok === true && r.planeacion.estado === 'publicada', '14. El estado final es uno de los valores reales del esquema (\'publicada\'), nunca uno inventado')
  }

  // 4. "Ok" sin borrador activo
  {
    const { sb, interno } = clienteFalso(DOCENTE_1, datosBase())
    const r = await aprobarBorradorPlaneacion(sb, sesion(), [{ role: 'user', content: 'ok' }])
    verificar(!r.ok && r.codigo === 'SIN_BORRADOR', '4. "Ok" sin un borrador activo produce SIN_BORRADOR, sin guardar nada')
    verificar(interno.escrituras.length === 0, '4b. Ninguna escritura se ejecuta cuando no hay borrador')
  }

  // 5/7. Bloque incompleto
  {
    const { sb } = clienteFalso(DOCENTE_1, datosBase())
    const r = await aprobarBorradorPlaneacion(sb, sesion(), [{ role: 'assistant', content: BLOQUE_INCOMPLETO }])
    verificar(!r.ok && r.codigo === 'BORRADOR_INCOMPLETO', '5/7. Bloque incompleto produce BORRADOR_INCOMPLETO')
  }

  // 6-11 (nivel orquestación completa, no solo el validador aislado):
  // un borrador sin un elemento obligatorio nunca llega a escribir nada.
  {
    const { sb, interno } = clienteFalso(DOCENTE_1, datosBase())
    const bloqueSinPda = construirBloque(['PDA'])
    const r = await aprobarBorradorPlaneacion(sb, sesion(), [{ role: 'assistant', content: bloqueSinPda }])
    verificar(!r.ok && r.codigo === 'BORRADOR_INCOMPLETO', 'Un borrador sin PDA es rechazado también a nivel de orquestación completa')
    verificar(interno.escrituras.length === 0, 'Ninguna escritura se ejecuta si el contenido estructurado está incompleto')
  }

  // 1. planeaciones creada y planeacion_proyectos fallida (fallo parcial)
  // 2. Confirmación de que no se informa éxito parcial
  // 3. Confirmación de que una planeación incompleta no aparece en consultas
  {
    const { sb, interno } = clienteFalso(DOCENTE_1, datosBase())
    interno.forzarErrorEn('planeacion_proyectos', 'insert')
    const r = await aprobarBorradorPlaneacion(sb, sesion(), [{ role: 'assistant', content: BLOQUE_VALIDO }])
    verificar(r.ok === false && r.codigo === 'ERROR_GUARDADO', '1. Si falla planeacion_proyectos, la aprobación completa se reporta como fallo controlado')
    verificar(interno._tabla('planeaciones').length === 1, '1b. La fila de planeaciones sí quedó creada (fase 1 del commit en dos fases)')
    verificar((interno._tabla('planeaciones')[0] as { version: number }).version === 0, '1c. Pero permanece en version=0 — nunca se promovió, nunca es válida')
    verificar(r.ok === false, '2. NUNCA se reporta éxito parcial (ok:false, sin importar que la fila exista)')

    const consulta = await listarPlaneaciones({ supabase: sb }, { grupo_id: 'grupo-1' })
    verificar(consulta.ok === true && consulta.datos.length === 0, '3/15. La planeación incompleta NO aparece en planeacion_consultar (listarPlaneaciones la oculta por version=0)')

    // 4. Reintento después de fallo parcial — recupera el proceso, no duplica
    interno.quitarErrorForzado('planeacion_proyectos', 'insert')
    const r2 = await aprobarBorradorPlaneacion(sb, sesion(), [{ role: 'assistant', content: BLOQUE_VALIDO }])
    verificar(r2.ok === true, '4. El reintento después del fallo parcial ahora sí completa el guardado')
    verificar(interno._tabla('planeaciones').length === 1, '4b. Sigue existiendo exactamente 1 fila de planeaciones — el reintento reutilizó la misma, no creó otra')
    verificar(interno._tabla('planeacion_proyectos').length === 1, '4c. Sigue existiendo exactamente 1 proyecto vinculado')

    const consultaFinal = await listarPlaneaciones({ supabase: sb }, { grupo_id: 'grupo-1' })
    verificar(consultaFinal.ok === true && consultaFinal.datos.length === 1, '15b. Una vez confirmada, la planeación SÍ aparece en planeacion_consultar')
  }

  // 5. Doble aprobación consecutiva sobre un borrador YA guardado con éxito
  // 19. Duplicado detectado por huella estable (docente + grupo + nombre + fechas)
  {
    const { sb, interno } = clienteFalso(DOCENTE_1, datosBase())
    const r1 = await aprobarBorradorPlaneacion(sb, sesion(), [{ role: 'assistant', content: BLOQUE_VALIDO }])
    const r2 = await aprobarBorradorPlaneacion(sb, sesion(), [{ role: 'assistant', content: BLOQUE_VALIDO }])
    verificar(r1.ok === true, '5. El primer intento de guardado tiene éxito')
    verificar(!r2.ok && r2.codigo === 'YA_GUARDADA', '5b/19. Una segunda aprobación consecutiva del mismo borrador detecta la huella estable y no duplica')
    verificar(interno._tabla('planeaciones').length === 1, '5c. Dos aprobaciones consecutivas producen un único resultado lógico — solo 1 planeación')
  }

  // Error al crear la fila temporal (fase 1 del commit)
  {
    const { sb, interno } = clienteFalso(DOCENTE_1, datosBase())
    interno.forzarErrorEn('planeaciones', 'insert')
    const r = await aprobarBorradorPlaneacion(sb, sesion(), [{ role: 'assistant', content: BLOQUE_VALIDO }])
    verificar(!r.ok && r.codigo === 'ERROR_GUARDADO', 'Error al crear la fila temporal de planeaciones se reporta como fallo controlado, sin excepción')
    verificar(interno._tabla('planeacion_proyectos').length === 0, 'Si falla la fase 1, nunca se intenta la fase 2 (crear el proyecto)')
  }

  // Error al confirmar (fase 3 del commit) — la fila queda creada pero sin promover
  {
    const { sb, interno } = clienteFalso(DOCENTE_1, datosBase())
    interno.forzarErrorEn('planeaciones', 'update')
    const r = await aprobarBorradorPlaneacion(sb, sesion(), [{ role: 'assistant', content: BLOQUE_VALIDO }])
    verificar(!r.ok && r.codigo === 'ERROR_GUARDADO', 'Error al confirmar (promover version 0→1) se reporta como fallo controlado, nunca como éxito')
    verificar((interno._tabla('planeaciones')[0] as { version: number }).version === 0, 'Sin confirmación exitosa, la fila permanece en version=0 (invisible)')
  }

  // 16/17/18. Protección de docente_id y grupo_id (reutiliza crearPlaneacion del Paso 2)
  {
    const { sb } = clienteFalso(DOCENTE_1, datosBase())
    const r = await aprobarBorradorPlaneacion(sb, sesion({ grupo_activo_id: 'grupo-2' }), [{ role: 'assistant', content: BLOQUE_VALIDO }])
    verificar(r.ok === false, '16/17. No se puede guardar en un grupo que no pertenece al docente autenticado')
  }
  {
    const { sb: sb1 } = clienteFalso(DOCENTE_1, datosBase())
    const { sb: sb2 } = clienteFalso(DOCENTE_2, datosBase())
    const r1 = await aprobarBorradorPlaneacion(sb1, sesion({ docente_id: 'docente-1', grupo_activo_id: 'grupo-1' }), [{ role: 'assistant', content: BLOQUE_VALIDO }])
    const r2 = await aprobarBorradorPlaneacion(sb2, sesion({ docente_id: 'docente-2', grupo_activo_id: 'grupo-2' }), [{ role: 'assistant', content: BLOQUE_VALIDO }])
    verificar(r1.ok === true && r2.ok === true, '18. Cada docente guarda correctamente en su propio grupo, sin mezclar datos')
    if (r1.ok && r2.ok) verificar(r1.planeacion.docente_id !== r2.planeacion.docente_id, '18b. Las planeaciones quedan asociadas a docentes distintos')
  }

  // 16/17/20/21/22/23. Seguridad: cliente exclusivo, sin service_role, sin DELETE, solo INSERT/UPDATE autorizados
  {
    const contenidoAprobar = readFileSync(join(__dirname, '..', 'lib', 'planeacion', 'aprobarBorrador.ts'), 'utf-8')
    const contenidoExtraer = readFileSync(join(__dirname, '..', 'lib', 'planeacion', 'extraerBorrador.ts'), 'utf-8')
    const contenidoValidar = readFileSync(join(__dirname, '..', 'lib', 'planeacion', 'validarContenidoBorrador.ts'), 'utf-8')
    const contenidoPersistencia = readFileSync(join(__dirname, '..', 'lib', 'planeacion', 'persistencia.ts'), 'utf-8')
    verificar(![contenidoAprobar, contenidoExtraer, contenidoValidar, contenidoPersistencia].some((c) => c.includes('createClient(')), 'Ningún archivo del Paso 3C crea su propio cliente de Supabase')
    verificar(![contenidoAprobar, contenidoExtraer, contenidoValidar, contenidoPersistencia].some((c) => c.includes('SERVICE_ROLE')), '17/21. Ningún archivo del Paso 3C referencia SERVICE_ROLE')
    verificar(![contenidoAprobar, contenidoExtraer, contenidoValidar, contenidoPersistencia].some((c) => c.includes('.delete(')), '16/22. Ningún archivo del Paso 3C ejecuta .delete()')

    const contenidoGenerarHoja = readFileSync(join(__dirname, '..', 'lib', 'seguimiento', 'generarYGuardarHoja.ts'), 'utf-8')
    verificar(!contenidoGenerarHoja.includes('createClient(') && !contenidoGenerarHoja.includes('SERVICE_ROLE'), 'generarYGuardarHoja.ts (reutilizado en la aprobación) tampoco usa SERVICE_ROLE ni crea cliente propio')

    const { sb, interno } = clienteFalso(DOCENTE_1, datosBase())
    await aprobarBorradorPlaneacion(sb, sesion(), [{ role: 'assistant', content: BLOQUE_VALIDO }])
    const tablasEscritas = new Set(interno.escrituras.map((e) => e.tabla))
    verificar(interno.escrituras.every((e) => e.tipo === 'insert' || e.tipo === 'update'), '23. Solo se ejecutan operaciones insert/update (nunca delete) durante una aprobación exitosa')
    verificar(
      tablasEscritas.size === 4 &&
        tablasEscritas.has('planeaciones') &&
        tablasEscritas.has('planeacion_proyectos') &&
        tablasEscritas.has('proyectos_seguimiento') &&
        tablasEscritas.has('hojas_evaluacion'),
      '23b. Las únicas tablas escritas son planeaciones, planeacion_proyectos, proyectos_seguimiento y hojas_evaluacion — ninguna otra'
    )
  }

  // 20. Voz confirma únicamente después del guardado completo — verificación estructural de route.ts
  {
    const rutaChat = readFileSync(join(__dirname, '..', 'app', 'api', 'chat', 'route.ts'), 'utf-8')
    const indiceAprobar = rutaChat.indexOf("clasificacion.accion_planeacion_generar === 'aprobar'")
    const indiceIfOk = rutaChat.indexOf('if (!resultado.ok)', indiceAprobar)
    const indiceMensajeVoz = rutaChat.indexOf('mensajeVoz', indiceAprobar)
    verificar(indiceAprobar > -1 && indiceIfOk > indiceAprobar && indiceMensajeVoz > indiceIfOk, '20. El mensaje de voz se construye DESPUÉS de confirmar que el guardado tuvo éxito, nunca antes')
    verificar(rutaChat.includes("channel === 'voice' ? mensajeVoz : mensajeTexto"), '20b. route.ts responde con un mensaje más breve específico para el canal de voz al aprobar')
  }

  // Confirmación previa de que las demás ramas siguen intactas (regresión completa por ejecución se corre aparte)
  {
    const clasificador = readFileSync(join(__dirname, '..', 'lib', 'clasificadorNivel0.ts'), 'utf-8')
    verificar(clasificador.includes('accion_planeacion_generar'), 'Confirmación previa: el clasificador conoce accion_planeacion_generar')
    verificar(clasificador.includes('intencion_principal="ficha_descriptiva"'), '27. La regla de ficha_descriptiva sigue presente')
    verificar(clasificador.includes('intencion_principal="consultar_calendario"'), '28. La regla de consultar_calendario sigue presente')
    verificar(clasificador.includes('intencion_principal="consultar_asistencia_grupo"') && clasificador.includes('intencion_principal="registrar_incidencia"'), '29. Las reglas de asistencia e incidencias siguen presentes')
    verificar(clasificador.includes('requiere_consulta_oficial=true SOLO cuando'), '30. La regla de consultas SEP sigue presente')
  }

  // --- Borrador vigente con respuestas intermedias (seleccionarBorradorVigente) ---

  // Error de guardado y reintento: el borrador ya no es el último turno.
  {
    const { sb, interno } = clienteFalso(DOCENTE_1, datosBase())
    interno.forzarErrorEn('planeacion_proyectos', 'insert')
    const r1 = await aprobarBorradorPlaneacion(sb, sesion(), [{ role: 'assistant', content: BLOQUE_VALIDO }], 'Apruébala y guárdala')
    verificar(!r1.ok && r1.codigo === 'ERROR_GUARDADO', 'V1. Primer intento falla de forma controlada')
    interno.quitarErrorForzado('planeacion_proyectos', 'insert')
    const historial = [
      { role: 'assistant', content: BLOQUE_VALIDO },
      { role: 'user', content: 'Apruébala y guárdala' },
      { role: 'assistant', content: 'No fue posible guardar la planeación en este momento. Intenta de nuevo en unos segundos.' },
    ]
    const r2 = await aprobarBorradorPlaneacion(sb, sesion(), historial, 'Apruébala y guárdala')
    verificar(r2.ok === true && r2.planeacion.nombre === 'Leyendas de mi comunidad', 'V1b. Tras el error, el reintento recupera el borrador vigente y guarda')
    verificar(interno._tabla('planeaciones').length === 1 && interno._tabla('planeacion_proyectos').length === 1, 'V1c. Sin duplicados: 1 planeación y 1 proyecto (reutiliza la fila version=0)')
    verificar(interno._tabla('proyectos_seguimiento').length === 1 && interno._tabla('hojas_evaluacion').length === 1, 'V1d. Sin duplicados: 1 proyecto de Seguimiento y 1 hoja')

    // Ya aprobado: la confirmación queda en el historial.
    const conConfirmacion = [...historial, { role: 'user', content: 'Apruébala' }, { role: 'assistant', content: 'Listo, guardé la planeación de Leyendas de mi comunidad para 10 días efectivos.' }]
    const escriturasAntes = interno.escrituras.length
    const r3 = await aprobarBorradorPlaneacion(sb, sesion(), conConfirmacion, 'Apruébala')
    verificar(!r3.ok && r3.codigo === 'YA_GUARDADA', 'V2. Un borrador ya aprobado no se aprueba de nuevo')
    verificar(interno.escrituras.length === escriturasAntes, 'V2b. Ninguna escritura al detectar la aprobación previa')
  }

  // Ya aprobado SIN la confirmación en el historial: la huella lo protege.
  {
    const { sb, interno } = clienteFalso(DOCENTE_1, datosBase())
    await aprobarBorradorPlaneacion(sb, sesion(), [{ role: 'assistant', content: BLOQUE_VALIDO }])
    const r = await aprobarBorradorPlaneacion(sb, sesion(), [{ role: 'assistant', content: BLOQUE_VALIDO }, { role: 'user', content: '¿Y el horario?' }, { role: 'assistant', content: 'El horario se ajusta después.' }], 'Apruébala')
    verificar(!r.ok && r.codigo === 'YA_GUARDADA' && interno._tabla('planeaciones').length === 1, 'V2c. Sin confirmación en el historial, la huella estable sigue impidiendo duplicar')
  }

  // Aclaración intermedia.
  {
    const { sb } = clienteFalso(DOCENTE_1, datosBase())
    const r = await aprobarBorradorPlaneacion(sb, sesion(), [
      { role: 'assistant', content: BLOQUE_VALIDO },
      { role: 'user', content: '¿Cuántos días dura?' },
      { role: 'assistant', content: 'Dura 10 días efectivos.' },
    ], 'Apruébala')
    verificar(r.ok === true, 'V3. Con una aclaración intermedia se aprueba el borrador vigente')
  }

  // Dos borradores: siempre el vigente, nunca el anterior.
  {
    const { sb, interno } = clienteFalso(DOCENTE_1, datosBase())
    const historial = [
      { role: 'assistant', content: BLOQUE_VALIDO },
      { role: 'user', content: 'amplíala una semana' },
      { role: 'assistant', content: BLOQUE_CORREGIDO },
      { role: 'user', content: 'Apruébala' },
      { role: 'assistant', content: 'No fue posible guardar la planeación en este momento. Intenta de nuevo en unos segundos.' },
    ]
    const r = await aprobarBorradorPlaneacion(sb, sesion(), historial, 'Apruébala')
    verificar(r.ok === true && r.planeacion.nombre === 'Leyendas de mi comunidad (ampliada)', 'V4. Con dos borradores se aprueba el vigente (el más reciente)')
    const rRef = await aprobarBorradorPlaneacion(clienteFalso(DOCENTE_1, datosBase()).sb, sesion(), historial, 'Aprueba la planeación Leyendas de mi comunidad')
    verificar(!rRef.ok && rRef.codigo === 'BORRADOR_NO_DETERMINADO' && rRef.mensaje.includes('Leyendas de mi comunidad (ampliada)'), 'V4b. Una referencia ambigua o a un borrador anterior no aprueba nada y nombra el vigente')
    verificar(interno._tabla('planeaciones').length === 1, 'V4c. Solo se guardó la planeación vigente')
  }

  // Otro documento después del borrador.
  {
    const { sb, interno } = clienteFalso(DOCENTE_1, datosBase())
    const r = await aprobarBorradorPlaneacion(sb, sesion(), [
      { role: 'assistant', content: BLOQUE_VALIDO },
      { role: 'user', content: 'Hazme un examen de leyendas' },
      { role: 'assistant', content: '📝 EXAMEN DE LEYENDAS\n\n1. ¿Qué es una leyenda?' },
    ], 'Apruébala')
    verificar(!r.ok && r.codigo === 'BORRADOR_NO_DETERMINADO' && interno.escrituras.length === 0, 'V5. Con otro documento después del borrador no se aprueba nada y se explica')
  }

  // Borrador vigente incompleto: nunca se cae a uno anterior completo.
  {
    const { sb, interno } = clienteFalso(DOCENTE_1, datosBase())
    const r = await aprobarBorradorPlaneacion(sb, sesion(), [
      { role: 'assistant', content: BLOQUE_VALIDO },
      { role: 'user', content: 'cámbiale el nombre' },
      { role: 'assistant', content: BLOQUE_INCOMPLETO },
    ], 'Apruébala')
    verificar(!r.ok && r.codigo === 'BORRADOR_INCOMPLETO' && interno.escrituras.length === 0, 'V6. Un borrador vigente incompleto no recurre a uno anterior')
  }

  // Bloque antiguo tras una conversación que cambió de tema: no basta.
  {
    const { sb, interno } = clienteFalso(DOCENTE_1, datosBase())
    const r = await aprobarBorradorPlaneacion(sb, sesion(), [
      { role: 'assistant', content: BLOQUE_VALIDO },
      { role: 'user', content: '¿Cuántos faltaron hoy?' },
      { role: 'assistant', content: 'Hoy faltaron 2 alumnos.' },
      { role: 'user', content: 'Registra a Juan con retardo' },
      { role: 'assistant', content: 'Listo, Juan quedó registrado con retardo el día de hoy.' },
      { role: 'user', content: '¿Y la reunión?' },
      { role: 'assistant', content: 'La reunión es el viernes.' },
      { role: 'user', content: 'Gracias' },
      { role: 'assistant', content: 'Con gusto.' },
    ], 'Apruébala')
    verificar(!r.ok && r.codigo === 'BORRADOR_NO_DETERMINADO' && interno.escrituras.length === 0, 'V8. Un bloque antiguo, con la conversación ya en otros temas, no autoriza ningún guardado')
  }

  // Sin borrador.
  {
    const { sb, interno } = clienteFalso(DOCENTE_1, datosBase())
    const r = await aprobarBorradorPlaneacion(sb, sesion(), [{ role: 'user', content: 'Hola' }, { role: 'assistant', content: 'Hola, ¿en qué te ayudo?' }], 'Apruébala')
    verificar(!r.ok && r.codigo === 'SIN_BORRADOR' && interno.escrituras.length === 0, 'V7. Sin borrador no se guarda ni se genera nada')
  }

  // AB. Contraste A/B de encabezados: perfil "4° A" (desactualizado) y
  // grupo efectivo de la sesión 4 B. Recorrido completo de la aprobación
  // con los generadores reales; se lee el contenido de los 3 archivos que
  // quedaron en el Storage simulado.
  {
    const datos = datosBase()
    datos.perfiles_docentes[0] = { id: 'docente-1', escuela: 'Escuela Contraste AB', nombre: 'Docente Contraste', grado: '4°', grupo: 'A', ciclo_escolar: '2026-2027' }
    const { sb, interno } = clienteFalso(DOCENTE_1, datos)
    const r = await aprobarBorradorPlaneacion(sb, sesion({ grupo_activo_datos: { grado: '4', grupo: 'B' } }), [{ role: 'assistant', content: BLOQUE_VALIDO }], 'Apruébala')
    verificar(r.ok === true, 'AB1. La aprobación con perfil 4° A y grupo efectivo 4 B se completa')
    const archivos = interno['archivosStorage'] as Map<string, Buffer>
    const hojaPdf = [...archivos].find(([k]) => k.startsWith('hojas-seguimiento/') && k.endsWith('.pdf'))
    const planWord = [...archivos].find(([k]) => k.startsWith('documentos-generados-ia/') && k.endsWith('.docx'))
    const planPdf = [...archivos].find(([k]) => k.startsWith('documentos-generados-ia/') && k.endsWith('.pdf'))
    verificar(!!hojaPdf && !!planWord && !!planPdf, 'AB2. Se subieron los 3 archivos: hoja PDF, Word y PDF de la planeación')
    const registrados = registroArchivos.filter((f) => [planWord?.[0], planPdf?.[0]].includes(`documentos-generados-ia/${f.ruta}`))
    verificar(registrados.length === 2 && registrados.every((f) => f.clase === 'conservar' && f.conversacion_id == null && f.estado === 'activo'), 'AB2b. Word y PDF de la planeación quedan registrados como conservar (protegidos), sin conversación')
    const textoWord = async (b: Buffer) => {
      const zip = await JSZip.loadAsync(b)
      const partes = Object.keys(zip.files).filter((n) => /^word\/(document|header\d*)\.xml$/.test(n))
      return (await Promise.all(partes.map((n) => zip.file(n)!.async('string')))).join(' ').replace(/<w:tab\/>/g, ' ').replace(/<\/w:p>/g, ' ').replace(/<[^>]+>/g, '')
    }
    const textoPdf = async (b: Buffer) => {
      const doc = await PDFDocument.load(b)
      const partes: string[] = []
      for (const p of doc.getPages()) {
        const c = p.node.Contents()
        const flujos = (c instanceof PDFArray ? c.asArray().map((x) => doc.context.lookup(x)) : [c]) as PDFStream[]
        for (const f of flujos) {
          const crudo = (f as PDFRawStream).contents
          const contenido = Buffer.from(f.dict.get(PDFName.of('Filter')) ? inflateSync(crudo) : crudo).toString('latin1')
          for (const m of contenido.matchAll(/<([0-9A-Fa-f]*)> Tj/g)) partes.push(Buffer.from(m[1], 'hex').toString('latin1'))
        }
      }
      return partes.join(' ')
    }
    // null = el archivo no existe: ninguna comprobación de contenido puede
    // pasar sobre un archivo ausente o un texto vacío.
    const textos: [string, string | null][] = [
      ['Word de la planeación', planWord ? await textoWord(planWord[1]) : null],
      ['PDF de la planeación', planPdf ? await textoPdf(planPdf[1]) : null],
      ['PDF de la hoja de evaluación', hojaPdf ? await textoPdf(hojaPdf[1]) : null],
    ]
    for (const [nombre, texto] of textos) {
      const t = (texto ?? '').replace(/\s+/g, ' ')
      const real = texto !== null && t.trim().length > 0
      verificar(real, `AB3a. ${nombre}: el archivo existe y tiene texto real`)
      verificar(real && /Grado: 4° +Grupo: B(\s|$)/.test(t), `AB3. ${nombre}: "Grado: 4° Grupo: B"`)
      verificar(real && !/Grupo: A(\s|$)/.test(t), `AB4. ${nombre}: nunca "Grupo: A" (el del perfil)`)
      verificar(real && t.includes('Escuela Contraste AB'), `AB5. ${nombre}: conserva la escuela del perfil`)
    }
  }
  } finally {
    globalThis.fetch = fetchOriginal
  }

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
