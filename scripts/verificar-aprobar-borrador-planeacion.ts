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
import { aprobarBorradorPlaneacion as aprobarReal, resolverIdentidadBorrador } from '../lib/planeacion/aprobarBorrador'
import { createHash } from 'node:crypto'
import { configurarClienteRegistroArchivos } from '../lib/documentGen/registroArchivos'
import { listarPlaneaciones } from '../lib/planeacion/persistencia'
import type { SesionContexto } from '../lib/sesionContexto'
import { prepararContextoCurricularPlaneacion, cargarCandidatosCurricularesGrupo } from '../lib/planeacion/resolverCurricularPlaneacion'
import { completarBorradorCurricular } from '../lib/planeacion/completarBorradorCurricular'
import { decidirCurricularAprobacion, resolverPeriodoPorFechaInicio, type TrazabilidadCurricularAprobada } from '../lib/planeacion/curricularAprobacion'
import { ENCABEZADO_IDENTIDAD_VISIBLE, ROTULO_PENDIENTE_VALIDACION } from '../lib/planeacion/identidadCurricularVisibleBorrador'
import { documentoParaHistorial } from '../lib/asistente/documentos'
import { baseCurricular, conProgramaAnalitico } from './fixtures/curriculoPlaneacionFicticio'

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
  private limite: number | null = null
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

  // Carga curricular (Hito 1, Parte 3): .in(col, valores).
  in(columna: string, valores: unknown[]) {
    this.condiciones.push((f) => valores.includes(f[columna]))
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
      // Concesión de la aprobación: "col.eq.valor" y "col.lt.valor" (fecha ISO).
      const comparacion = parte.match(/^(\w+)\.(eq|lt)\.(.+)$/)
      if (comparacion) {
        const [, col, op, valor] = comparacion
        return op === 'eq' ? (f: Fila) => String(f[col]) === valor : (f: Fila) => f[col] != null && String(f[col]) < valor
      }
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

  // Identidad del borrador: el mensaje persistido más reciente (.limit).
  limit(n: number) {
    this.limite = n
    return this
  }

  private ejecutar(): { data: Fila[] | null; error: { message: string; code?: string } | null } {
    if (this.cliente._debeFallar(this.tabla, this.operacion === 'insertar' ? 'insert' : this.operacion === 'actualizar' ? 'update' : 'select')) {
      return { data: null, error: { message: `Error simulado en ${this.tabla}` } }
    }

    const filas = this.cliente._tabla(this.tabla)

    if (this.operacion === 'insertar') {
      const nuevas = Array.isArray(this.payload) ? this.payload : [this.payload as Fila]
      // Mismos índices únicos que la migración 20261125000000.
      const UNICOS: Record<string, string[][]> = {
        planeaciones: [['docente_id', 'borrador_clave']],
        planeacion_proyectos: [['planeacion_id', 'orden']],
        proyectos_seguimiento: [['planeacion_proyecto_id']],
        documentos_generados: [['archivo_id']],
      }
      for (const columnas of UNICOS[this.tabla] ?? []) {
        for (const nueva of nuevas) {
          const valores = columnas.map((c) => nueva[c] ?? (c === 'orden' && this.tabla === 'planeacion_proyectos' ? 1 : null))
          if (valores.some((v) => v == null)) continue
          if (filas.some((f) => columnas.every((c, k) => (f[c] ?? (c === 'orden' ? 1 : null)) === valores[k]))) {
            return { data: null, error: { message: `duplicate key value violates unique constraint (${columnas.join(', ')})`, code: '23505' } }
          }
        }
      }
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
      this.condiciones.every((p) => p(f)) &&
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
    if (this.limite !== null) resultado = resultado.slice(0, this.limite)
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

  // Emula public.consolidar_aprobacion_planeacion (ver la migración): en
  // una transacción, renueva la concesión solo con el token propio y
  // escribe evaluación + Historial; sin el token, no escribe nada.
  public antesDeConsolidarFinal: (() => void) | null = null
  async rpc(nombre: string, argumentos: Record<string, unknown>) {
    if (nombre === 'publicar_version_planeacion') return this._publicarVersion(argumentos as never)
    const args = argumentos as { p_planeacion_id: string; p_token: string; p_evaluacion: Record<string, unknown>; p_historial: Record<string, unknown> | null }
    if (nombre !== 'consolidar_aprobacion_planeacion') return { data: null, error: { message: `rpc desconocida ${nombre}` } }
    if (this._debeFallar('planeacion_proyectos', 'update')) return { data: null, error: { message: 'Error simulado en consolidar' } }
    if (args.p_historial && this.antesDeConsolidarFinal) { const g = this.antesDeConsolidarFinal; this.antesDeConsolidarFinal = null; g() }
    const pl = this._tabla('planeaciones').find((f) => f.id === args.p_planeacion_id && f.version === 0 && f.aprobacion_token === args.p_token)
    if (!pl) return { data: false, error: null }
    pl.aprobacion_expira_en = new Date(Date.now() + 120_000).toISOString()
    this._registrarEscritura('planeaciones', 'update')
    this._tabla('planeacion_proyectos').filter((f) => f.planeacion_id === args.p_planeacion_id).forEach((f) => { f.evaluacion = args.p_evaluacion; f.actualizado_en = new Date().toISOString() })
    this._registrarEscritura('planeacion_proyectos', 'update')
    if (args.p_historial) {
      const hist = this._tabla('documentos_generados')
      if (!hist.some((f) => f.archivo_id === args.p_historial!.archivo_id)) hist.push({ id: `doc-${hist.length + 1}`, user_id: this.usuario?.id, ...args.p_historial })
      this._registrarEscritura('documentos_generados', 'insert')
    }
    return { data: true, error: null }
  }

  // Emula public.publicar_version_planeacion, versión base 0 (primera
  // aprobación): con la concesión propia crea la versión 1 y confirma en
  // un solo paso; el mismo borrador otra vez → ya_publicada.
  _publicarVersion(a: { p_planeacion_id: string; p_version_base: number; p_borrador_clave: string; p_contenido: string; p_estructura: Record<string, unknown>; p_trazabilidad: unknown; p_documento_word: string | null; p_documento_pdf: string | null; p_token: string }) {
    const versiones = this._tabla('planeacion_versiones')
    const previa = versiones.find((v) => v.borrador_clave === a.p_borrador_clave)
    if (previa) return { data: { estado: previa.planeacion_id === a.p_planeacion_id ? 'ya_publicada' : 'conflicto', numero: previa.numero }, error: null }
    const pl = this._tabla('planeaciones').find((f) => f.id === a.p_planeacion_id && f.docente_id === this.usuario?.id)
    if (!pl) return { data: { estado: 'no_encontrada' }, error: null }
    if (a.p_version_base !== 0 || pl.version !== 0 || pl.aprobacion_token !== a.p_token || pl.borrador_clave !== a.p_borrador_clave) return { data: { estado: 'conflicto', numero: pl.version }, error: null }
    if (!a.p_contenido?.trim()) return { data: { estado: 'datos_invalidos' }, error: null }
    const idMensaje = a.p_borrador_clave.slice(4)
    if (!this._tabla('mensajes_chat').some((m) => m.id === idMensaje && m.rol === 'asistente' && idMensaje.startsWith(`${m.conversacion_id}:`))) return { data: { estado: 'borrador_no_valido' }, error: null }
    versiones.push({ id: `version-${versiones.length + 1}`, planeacion_id: pl.id, docente_id: pl.docente_id, grupo_id: pl.grupo_id, numero: 1, origen: 'aprobacion', borrador_clave: a.p_borrador_clave, contenido: a.p_contenido, estructura: a.p_estructura, trazabilidad_curricular: a.p_trazabilidad, documento_word_archivo_id: a.p_documento_word, documento_pdf_archivo_id: a.p_documento_pdf })
    this._registrarEscritura('planeacion_versiones', 'insert')
    Object.assign(pl, { version: 1, estado: 'publicada', aprobacion_token: null, aprobacion_expira_en: null, actualizado_en: new Date().toISOString() })
    this._registrarEscritura('planeaciones', 'update')
    return { data: { estado: 'publicada', numero: 1 }, error: null }
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
// Gancho de prueba: se ejecuta cuando un archivo se CONFIRMA (estado
// 'activo'), justo antes de que la aprobación intente consolidarlo.
let alConfirmarArchivo: (() => void) | null = null
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
        // CHECK archivos_generados_activo_con_fecha: estado 'activo' ⇔ activado_en.
        if (cambios && afectadas.some((f) => { const r = { ...f, ...cambios }; return (r.estado === 'activo') !== (r.activado_en != null) })) return Promise.resolve({ data: null, error: { code: '23514', message: 'archivos_generados_activo_con_fecha' } }).then(ok)
        if (cambios) afectadas.forEach((f) => Object.assign(f, cambios))
        if (cambios && (cambios as { estado?: string }).estado === 'activo' && afectadas.length > 0 && alConfirmarArchivo) { const g = alConfirmarArchivo; alConfirmarArchivo = null; g() }
        return Promise.resolve({ data: afectadas.map((f) => ({ id: f.id, estado: f.estado })), error: null }).then(ok)
      },
    }
    return consulta
  },
} as never)

// Conversación de prueba: el mensaje de cada borrador se persiste con un id
// estable (el mismo texto → el mismo mensaje), como hace el cliente antes
// de aprobar (AsistenteService.confirmarPersistenciaConversacion).
const CONV_PRUEBA = '0c000000-0000-4000-8000-0000000000cc'
const idMensajePrueba = (texto: string) => `${CONV_PRUEBA}:msg-${createHash('sha1').update(texto).digest('hex').slice(0, 12)}`
const claveDePrueba = (texto: string) => `msg:${idMensajePrueba(texto)}`
function persistirMensajesDePrueba(sb: SupabaseClient, historial: { role: string; content: string }[]) {
  const tabla = (sb as unknown as ClienteSupabaseFalso)._tabla('mensajes_chat')
  historial.forEach((h, n) => {
    if (h.role !== 'assistant' || tabla.some((f) => f.id === idMensajePrueba(h.content))) return
    tabla.push({ id: idMensajePrueba(h.content), conversacion_id: CONV_PRUEBA, docente_id: 'docente-1', rol: 'asistente', texto: h.content, creado_en: new Date(Date.UTC(2026, 7, 10, 10, 0, n + tabla.length)).toISOString() })
  })
}
function aprobarBorradorPlaneacion(sb: SupabaseClient, s: SesionContexto, historial: { role: string; content: string }[], mensaje = '', conversacionId?: string | null) {
  if (conversacionId !== undefined) return aprobarReal(sb, s, historial, mensaje, conversacionId)
  persistirMensajesDePrueba(sb, historial)
  return aprobarReal(sb, s, historial, mensaje, CONV_PRUEBA)
}

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
    verificar(r1.ok && r2.ok && r2.planeacion.id === r1.planeacion.id && interno._tabla('planeaciones').length === 1, '5b/19. Una segunda aprobación del mismo borrador (identidad de su mensaje) recupera la misma planeación y no duplica')
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
      tablasEscritas.size === 6 &&
        tablasEscritas.has('planeacion_versiones') &&
        tablasEscritas.has('planeaciones') &&
        tablasEscritas.has('planeacion_proyectos') &&
        tablasEscritas.has('proyectos_seguimiento') &&
        tablasEscritas.has('hojas_evaluacion') &&
        tablasEscritas.has('documentos_generados'),
      '23b. Las únicas tablas escritas son planeaciones, planeacion_proyectos, proyectos_seguimiento, hojas_evaluacion, documentos_generados (registro canónico en Historial) y planeacion_versiones (versión 1) — ninguna otra'
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
    verificar(r3.ok && r2.ok && r3.planeacion.id === r2.planeacion.id && interno._tabla('planeaciones').length === 1, 'V2. Un borrador ya aprobado no se aprueba de nuevo: se recupera la misma planeación')
    verificar(interno.escrituras.length === escriturasAntes, 'V2b. Ninguna escritura al detectar la aprobación previa')
  }

  // Ya aprobado SIN la confirmación en el historial: la huella lo protege.
  {
    const { sb, interno } = clienteFalso(DOCENTE_1, datosBase())
    await aprobarBorradorPlaneacion(sb, sesion(), [{ role: 'assistant', content: BLOQUE_VALIDO }])
    const r = await aprobarBorradorPlaneacion(sb, sesion(), [{ role: 'assistant', content: BLOQUE_VALIDO }, { role: 'user', content: '¿Y el horario?' }, { role: 'assistant', content: 'El horario se ajusta después.' }], 'Apruébala')
    verificar(r.ok && interno._tabla('planeaciones').length === 1 && interno._tabla('hojas_evaluacion').length === 1, 'V2c. Sin confirmación en el historial, la identidad del borrador recupera la planeación existente y no duplica')
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

  // ================================================================
  // HITO 1, PARTE 3 — aprobación curricular, trazabilidad, vínculos con
  // evaluación y periodo, y archivos originales Word/PDF (B1/B2).
  // ================================================================
  {
    const TITULO = 'Cuerpo humano: estructura externa, acciones para su cuidado'
    const PDA_CUERPO = 'Reconoce la estructura externa del cuerpo humano y acciones para cuidarlo.'
    const REGEX_TECNICO = /\bC-[0-9A-Z]{7}\b|sello|REFERENCIAS_CURRICULARES|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}|📎|¿Deseas/i
    // Datos: los base + el currículo ficticio; los grupos ficticios son del docente 1.
    const datosCurriculares = (curriculo: Record<string, Fila[]>, periodos: Fila[] = []): Record<string, Fila[]> => {
      const d = datosBase()
      const extra = Object.fromEntries(Object.entries(curriculo).filter(([t]) => t !== 'grupos'))
      return {
        ...d,
        ...extra,
        grupos: [...d.grupos, ...curriculo.grupos.map((g) => ({ ...g, docente_id: 'docente-1', ciclo_escolar_id: 'ciclo-1', institucion_id: 'institucion-1' }))],
        inscripciones: [...d.inscripciones, { grupo_id: 'grupo-3a', estatus: 'activo', alumnos: { id: 'a3', nombre: 'Carla Ruiz', curp: null, sexo: 'M', fecha_nacimiento: null } }, { grupo_id: 'grupo-4b', estatus: 'activo', alumnos: { id: 'a4', nombre: 'Diego Sol', curp: null, sexo: 'H', fecha_nacimiento: null } }, { grupo_id: 'grupo-sec', estatus: 'activo', alumnos: { id: 'a5', nombre: 'Elena Mar', curp: null, sexo: 'M', fecha_nacimiento: null } }],
        periodos_evaluacion: periodos,
      }
    }
    const PERIODOS = [
      { id: 'p1', ciclo_escolar_id: 'ciclo-1', numero_periodo: 1, nombre: 'Primer trimestre', fecha_inicio: '2026-08-01', fecha_fin: '2026-11-30' },
      { id: 'p2', ciclo_escolar_id: 'ciclo-1', numero_periodo: 2, nombre: 'Segundo trimestre', fecha_inicio: '2026-12-01', fecha_fin: '2027-03-15' },
    ]
    // Borrador de la Parte 2: el modelo copió el título del catálogo y la
    // sección la añadió el servidor (con sus PDA reales).
    const borradorParte2 = async (datos: Record<string, Fila[]>, grupo: string, contenidos: string, pda = 'ninguno', nombre = 'Cuidamos nuestro cuerpo') => {
      const textoModelo = construirBloque([], { Nombre: nombre, Contenidos: contenidos, PDA: pda, 'Campos formativos': 'Saberes y Pensamiento Científico' }).replace(/\n\n¿Deseas corregir algo o aprobarla para guardarla\?$/, '')
      const { sb } = clienteFalso(DOCENTE_1, datos)
      const ctx = await prepararContextoCurricularPlaneacion(sb, grupo, { tema: 'cuerpo humano' })
      const completado = completarBorradorCurricular({ textoModelo, curricular: ctx, textosDocente: ['Planeación del cuerpo humano'] })!
      return completado.textoFinal
    }
    const ses = (grupo: string) => sesion({ grupo_activo_id: grupo, grupo_activo_datos: { grado: '3', grupo: 'A' } })

    // H1. Catálogo provisional: aprobación completa con vínculos y originales.
    {
      const datos = datosCurriculares(baseCurricular(), PERIODOS)
      const mensaje = await borradorParte2(datos, 'grupo-3a', TITULO)
      const { sb, interno } = clienteFalso(DOCENTE_1, datos)
      const r = await aprobarBorradorPlaneacion(sb, ses('grupo-3a'), [{ role: 'user', content: 'Planeación del cuerpo humano' }, { role: 'assistant', content: mensaje }], 'Apruébala')
      verificar(r.ok === true, 'H1a. Borrador de la Parte 2 (catálogo provisional) se aprueba')
      const pp = interno._tabla('planeacion_proyectos')[0] as { id: string; contenidos: string[]; pda: string[]; evaluacion: Record<string, unknown> }
      const ps = interno._tabla('proyectos_seguimiento')[0] as { id: string; planeacion_proyecto_id: string | null; periodo_evaluacion_id: string | null; hoja_id: string | null }
      const pl = interno._tabla('planeaciones')[0] as { periodo_evaluacion_id: string | null }
      const traz = pp?.evaluacion?.trazabilidad_curricular as TrazabilidadCurricularAprobada | undefined
      verificar(traz?.esquema === 'planeacion-curricular-v1' && traz.fuente === 'catalogo_app' && traz.estadoVerificacion === 'pendiente_validacion_oficial' && traz.grupoId === 'grupo-3a'
        && traz.nivelEducativo === 'primaria' && traz.gradoClave === '3' && traz.curriculoFaseClave === 'fase_4' && traz.curriculoVersionId === 'version-curricular' && traz.programaAnaliticoId === null,
        'H1b. Trazabilidad: grupo, nivel, grado, fase, versión, fuente y estado (pendiente de validación)')
      verificar(traz?.items.length === 1 && traz.items[0].curriculoContenidoId != null && traz.items[0].texto === TITULO && traz.items[0].pda.map((p) => p.texto).join() === PDA_CUERPO && !!traz.items[0].pda[0].curriculoPdaId,
        'H1c. Trazabilidad: ids reales del contenido y de sus PDA')
      verificar(pp.contenidos.join() === TITULO && pp.pda.join() === PDA_CUERPO, 'H1d. planeacion_proyectos guarda los contenidos y PDA validados (no "ninguno")')
      verificar(ps.planeacion_proyecto_id === pp.id && ps.periodo_evaluacion_id === 'p1' && pl.periodo_evaluacion_id === 'p1' && ps.hoja_id === (pp.evaluacion.hoja_id as string),
        'H1e. Vínculos: proyecto de seguimiento → proyecto de planeación, periodo por fecha de inicio y su hoja canónica')
      const ev = pp.evaluacion as { documento_word?: { archivo_id?: string }; documento_pdf?: { archivo_id?: string } }
      verificar(r.ok && !!r.documentoPlaneacion?.word.archivoId && r.documentoPlaneacion.word.archivoId === ev.documento_word?.archivo_id && !!r.documentoPlaneacion.pdf.archivoId && r.documentoPlaneacion.pdf.archivoId === ev.documento_pdf?.archivo_id
        && registroArchivos.some((f) => f.id === r.documentoPlaneacion?.word.archivoId) && registroArchivos.some((f) => f.id === r.documentoPlaneacion?.pdf.archivoId),
        'H1f. Word y PDF conservan su archivoId real (registrados) en la respuesta y en los metadatos persistidos')
      const def = r.ok ? r.documentoPlaneacion?.contenidoDefinitivo ?? '' : ''
      verificar(def.split(ENCABEZADO_IDENTIDAD_VISIBLE).length === 2 && def.split(PDA_CUERPO).length === 2 && def.includes(`Fuente: ${ROTULO_PENDIENTE_VALIDACION}`) && !REGEX_TECNICO.test(def),
        'H1g. Documento definitivo: una sola sección de contenidos y PDA, rótulo correcto, sin resumen, pregunta ni datos técnicos')
      verificar(def.startsWith('Aquí está tu borrador completo.') && def.indexOf(ENCABEZADO_IDENTIDAD_VISIBLE) > 0, 'H1h. El documento definitivo conserva el cuerpo aprobado, con la sección después de él')
      const archivos = interno['archivosStorage'] as Map<string, Buffer>
      const planWord = [...archivos].find(([k]) => k.startsWith('documentos-generados-ia/') && k.endsWith('.docx'))
      const xml = planWord ? await (await JSZip.loadAsync(planWord[1])).file('word/document.xml')!.async('string') : ''
      verificar(xml.split('CONTENIDOS Y PDA DE ESTA PLANEACIÓN').length === 2 && xml.includes(PDA_CUERPO.slice(0, 40)) && !/RESUMEN PARA GUARDAR|Deseas corregir/.test(xml), 'H1i. Word real: una sola sección curricular, sin resumen ni pregunta')
      const hist = documentoParaHistorial('Listo, guardé la planeación de Cuidamos nuestro cuerpo.', { contenidoOriginal: def, archivos: [{ tipo: 'word', nombre: 'a.docx', url: 'x', archivoId: r.ok ? r.documentoPlaneacion?.word.archivoId : undefined, grupoAcademico: { grado: '3°', grupo: 'A' } }, { tipo: 'pdf', nombre: 'a.pdf', url: 'x', archivoId: r.ok ? r.documentoPlaneacion?.pdf.archivoId : undefined }] })
      verificar(hist?.origen === 'archivo' && hist.archivo?.formato === 'word' && hist.archivo.id === (r.ok ? r.documentoPlaneacion?.word.archivoId : '') && hist.contenido === def,
        'H1j. Historial (B2): un solo registro de la planeación aprobada, vinculado al Word original; el PDF queda recuperable por su archivoId')

      // H2. Reintento: sin duplicados ni sobrescritura.
      const conteos = () => ['planeaciones', 'planeacion_proyectos', 'proyectos_seguimiento', 'hojas_evaluacion'].map((t) => interno._tabla(t).length).join()
      const antes = conteos()
      const registrosAntes = registroArchivos.length
      const r2 = await aprobarBorradorPlaneacion(sb, ses('grupo-3a'), [{ role: 'assistant', content: mensaje }], 'Apruébala')
      verificar(r2.ok && r2.planeacion.id === (r.ok ? r.planeacion.id : '') && conteos() === antes && registroArchivos.length === registrosAntes, 'H2. Reintento: recupera la misma planeación, sin filas, hojas ni archivos duplicados')
    }

    // H3. Recuperación de un intento incompleto: trazabilidad consolidada intacta y vínculo legado completado.
    {
      const datos = datosCurriculares(baseCurricular(), PERIODOS)
      const mensaje = await borradorParte2(datos, 'grupo-3a', TITULO)
      const consolidada = { esquema: 'planeacion-curricular-v1', marca: 'consolidada-antes' }
      datos.planeaciones.push({ id: 'pl-prev', docente_id: 'docente-1', grupo_id: 'grupo-3a', nombre: 'Cuidamos nuestro cuerpo', fecha_inicio: '2026-08-10', fecha_fin: '2026-08-21', version: 0, estado: 'borrador', institucion_id: 'institucion-1', ciclo_escolar_id: 'ciclo-1', campo_formativo: 'Saberes y Pensamiento Científico', borrador_clave: claveDePrueba(mensaje), aprobacion_token: null, aprobacion_expira_en: null })
      datos.planeacion_proyectos.push({ id: 'pp-prev', planeacion_id: 'pl-prev', nombre: 'Cuidamos nuestro cuerpo', evaluacion: { trazabilidad_curricular: consolidada } })
      datos.proyectos_seguimiento.push({ id: 'ps-prev', docente_id: 'docente-1', grupo_id: 'grupo-3a', nombre: 'Cuidamos nuestro cuerpo', fecha_inicio: '2026-08-10', fecha_fin: '2026-08-21', hoja_id: null, planeacion_proyecto_id: 'pp-prev', periodo_evaluacion_id: null })
      const { sb, interno } = clienteFalso(DOCENTE_1, datos)
      const r = await aprobarBorradorPlaneacion(sb, ses('grupo-3a'), [{ role: 'assistant', content: mensaje }], 'Apruébala')
      const pp = interno._tabla('planeacion_proyectos') as { id: string; evaluacion: Record<string, unknown> }[]
      const ps = interno._tabla('proyectos_seguimiento') as { id: string; planeacion_proyecto_id: string | null; periodo_evaluacion_id: string | null }[]
      verificar(r.ok && pp.length === 1 && ps.length === 1 && interno._tabla('planeaciones').length === 1, 'H3a. Recupera el intento anterior sin crear filas nuevas')
      verificar(JSON.stringify(pp[0].evaluacion.trazabilidad_curricular) === JSON.stringify(consolidada), 'H3b. La trazabilidad ya consolidada no se sobrescribe')
      verificar(ps[0].planeacion_proyecto_id === 'pp-prev' && ps[0].periodo_evaluacion_id === 'p1', 'H3c. Intento anterior del mismo borrador: su seguimiento se reutiliza y se completa el periodo que faltaba')
    }
    // H3d. Un vínculo existente con otra planeación nunca se reasigna.
    {
      const datos = datosCurriculares(baseCurricular(), PERIODOS)
      const mensaje = await borradorParte2(datos, 'grupo-3a', TITULO)
      datos.proyectos_seguimiento.push({ id: 'ps-otro', docente_id: 'docente-1', grupo_id: 'grupo-3a', nombre: 'Cuidamos nuestro cuerpo', fecha_inicio: '2026-08-10', fecha_fin: '2026-08-21', hoja_id: null, planeacion_proyecto_id: 'pp-de-otra', periodo_evaluacion_id: 'p2' })
      const { sb, interno } = clienteFalso(DOCENTE_1, datos)
      await aprobarBorradorPlaneacion(sb, ses('grupo-3a'), [{ role: 'assistant', content: mensaje }], 'Apruébala')
      const ps = interno._tabla('proyectos_seguimiento')[0] as { planeacion_proyecto_id: string; periodo_evaluacion_id: string }
      verificar(ps.planeacion_proyecto_id === 'pp-de-otra' && ps.periodo_evaluacion_id === 'p2', 'H3d. Un vínculo o periodo ya asignados nunca se reasignan')
    }

    // H4. Periodo: sin periodos, sin coincidencia o solapados → ninguno, sin bloquear.
    for (const [periodos, etiqueta] of [
      [[], 'sin periodos configurados'],
      [[{ id: 'p9', ciclo_escolar_id: 'ciclo-1', nombre: 'Tercer trimestre', fecha_inicio: '2027-03-16', fecha_fin: '2027-07-15' }], 'sin periodo que contenga la fecha'],
      [[...PERIODOS, { id: 'p-solapado', ciclo_escolar_id: 'ciclo-1', nombre: 'Periodo solapado', fecha_inicio: '2026-08-05', fecha_fin: '2026-09-30' }], 'periodos solapados (ambigüedad)'],
      [[{ ...PERIODOS[0], id: 'p-otro-ciclo', ciclo_escolar_id: 'ciclo-2' }], 'periodo de otro ciclo'],
    ] as [Fila[], string][]) {
      const datos = datosCurriculares(baseCurricular(), periodos)
      const mensaje = await borradorParte2(datos, 'grupo-3a', TITULO)
      const { sb, interno } = clienteFalso(DOCENTE_1, datos)
      const r = await aprobarBorradorPlaneacion(sb, ses('grupo-3a'), [{ role: 'assistant', content: mensaje }], 'Apruébala')
      const ps = interno._tabla('proyectos_seguimiento')[0] as { periodo_evaluacion_id: string | null } | undefined
      verificar(r.ok && ps?.periodo_evaluacion_id === null && (interno._tabla('planeaciones')[0] as { periodo_evaluacion_id: string | null }).periodo_evaluacion_id === null, `H4. ${etiqueta}: se aprueba sin periodo (nunca uno arbitrario)`)
    }
    verificar(resolverPeriodoPorFechaInicio(PERIODOS, '2026-12-01')?.id === 'p2' && resolverPeriodoPorFechaInicio(PERIODOS, '2026-11-30')?.id === 'p1' && resolverPeriodoPorFechaInicio(PERIODOS, '2027-04-01') === null,
      'H4b. El periodo se decide por la fecha de inicio, con límites inclusivos')

    // H5. Programa Analítico, docente, propuestas, cambios y alteraciones (regla pura).
    const ctxCarga = async (curriculo: Record<string, Fila[]>, grupo: string) => cargarCandidatosCurricularesGrupo(clienteFalso(DOCENTE_1, datosCurriculares(curriculo)).sb, grupo)
    {
      const datos = datosCurriculares(conProgramaAnalitico(baseCurricular()), PERIODOS)
      const mensaje = await borradorParte2(datos, 'grupo-4b', 'Historias del barrio contadas por las familias; Huerto escolar de la comunidad')
      const r = decidirCurricularAprobacion(await ctxCarga(conProgramaAnalitico(baseCurricular()), 'grupo-4b'), 'grupo-4b', mensaje, extraerResumenBorrador([{ role: 'assistant', content: mensaje }])!, [])
      verificar(r.trazabilidad.fuente === 'programa_analitico' && r.trazabilidad.programaAnaliticoId === 'pa-4b' && r.trazabilidad.programaAnaliticoVersionId === 'pav-2'
        && r.trazabilidad.items.map((i) => i.decision).sort().join() === 'contextualizado,local' && r.trazabilidad.items.every((i) => i.programaAnaliticoItemId === i.id),
        'H5a. PA: fuente, PA y versión, items con su decisión e id del item del PA')
    }
    {
      const resumen = { contenidos: [TITULO, 'Educación financiera para niños (indicado por el docente)', 'Hábitos de higiene en casa (indicado por el docente)'], pda: ['Explica cómo ahorra su familia'] }
      const mensaje = `Borrador\n\n📎 RESUMEN PARA GUARDAR\nNombre: X\nContenidos: ${resumen.contenidos.join('; ')}\nPDA: ${resumen.pda.join('; ')}`
      const r = decidirCurricularAprobacion(await ctxCarga(baseCurricular(), 'grupo-3a'), 'grupo-3a', mensaje, resumen, ['Agrega Educación financiera para niños y el PDA Explica cómo ahorra su familia'])
      verificar(r.trazabilidad.delDocente.map((d) => d.texto).join() === 'Educación financiera para niños,Explica cómo ahorra su familia' && r.trazabilidad.propuestasNoVerificadas.map((d) => d.texto).join() === 'Hábitos de higiene en casa',
        'H5b. Lo del docente se conserva como suyo; la etiqueta "(indicado por el docente)" escrita por el modelo no cuenta si el docente no lo dijo')
      verificar(r.trazabilidad.items.length === 1 && r.trazabilidad.items[0].pda.length === 0, 'H5c. Historial anterior sin sección y sin PDA del catálogo en el resumen: no se añaden PDA que el docente no vio')
    }
    {
      // Catálogo cambió (nueva versión vigente con otro texto de PDA): el PDA revisado no se sustituye.
      const nueva = baseCurricular('vigente')
      nueva.curriculo_pda = nueva.curriculo_pda.map((p) => (p.id === 'pda-2' ? { ...p, texto: 'Texto nuevo del PDA en la versión vigente.' } : p))
      const datos = datosCurriculares(baseCurricular(), PERIODOS)
      const mensaje = await borradorParte2(datos, 'grupo-3a', TITULO)
      const r = decidirCurricularAprobacion(await ctxCarga(nueva, 'grupo-3a'), 'grupo-3a', mensaje, extraerResumenBorrador([{ role: 'assistant', content: mensaje }])!, [])
      verificar(r.trazabilidad.estadoVerificacion === 'oficial_vigente' && r.trazabilidad.items[0]?.pda.length === 0 && r.trazabilidad.propuestasNoVerificadas.some((p) => p.tipo === 'pda' && p.texto === PDA_CUERPO)
        && !r.textoDefinitivo.includes('Texto nuevo del PDA'),
        'H5d. Cambio de versión: el PDA revisado ya no existe → se conserva como no verificado; el nuevo nunca se añade en silencio')
    }
    {
      // Historial alterado: un contenido inexistente o con etiqueta de verificación escrita a mano.
      const datos = datosCurriculares(baseCurricular(), PERIODOS)
      const original = await borradorParte2(datos, 'grupo-3a', TITULO)
      const alterado = original.replace(`Contenidos: ${TITULO}`, 'Contenidos: Programa oficial SEP verificado: Robótica cuántica').replace(PDA_CUERPO, 'PDA inventado verificado por la SEP')
      const r = decidirCurricularAprobacion(await ctxCarga(baseCurricular(), 'grupo-3a'), 'grupo-3a', alterado, extraerResumenBorrador([{ role: 'assistant', content: alterado }])!, [])
      verificar(r.trazabilidad.items.length === 0 && r.trazabilidad.propuestasNoVerificadas.length === 2, 'H5e. Textos alterados o con etiquetas de verificación escritas a mano nunca se verifican')
    }
    {
      const resumen = { contenidos: ['Fracciones equivalentes'], pda: ['Compara fracciones'] }
      const sinCobertura = decidirCurricularAprobacion(await ctxCarga(baseCurricular(), 'grupo-sec'), 'grupo-sec', 'x', resumen, [])
      verificar(sinCobertura.trazabilidad.motivoSinCatalogo === 'GRADO_CURRICULAR_NO_ENCONTRADO' && sinCobertura.trazabilidad.items.length === 0 && sinCobertura.trazabilidad.propuestasNoVerificadas.length === 2 && sinCobertura.trazabilidad.fuente === null,
        'H5f. Sin cobertura: motivo registrado, todo como propuesta no verificada')
      const ajeno = decidirCurricularAprobacion(await ctxCarga(baseCurricular(), 'grupo-de-otro-docente'), 'grupo-de-otro-docente', 'x', { contenidos: [TITULO], pda: [] }, [])
      verificar(ajeno.trazabilidad.items.length === 0 && ajeno.trazabilidad.motivoSinCatalogo === 'GRUPO_NO_ENCONTRADO', 'H5g. Grupo que RLS no devuelve: el catálogo de otro grupo nunca verifica nada')
      const fallo = decidirCurricularAprobacion({ ok: false, motivo: 'CARGA_FALLIDA' }, 'grupo-3a', 'x', { contenidos: [TITULO], pda: [] }, [])
      verificar(fallo.trazabilidad.items.length === 0 && fallo.trazabilidad.motivoSinCatalogo === 'CARGA_FALLIDA', 'H5h. Si falla la carga del catálogo, nada se marca como verificado')
    }

    // H6. Borrador histórico (anterior al Hito 1) sigue aprobándose.
    {
      const datos = datosCurriculares(baseCurricular(), PERIODOS)
      const { sb, interno } = clienteFalso(DOCENTE_1, datos)
      const r = await aprobarBorradorPlaneacion(sb, ses('grupo-3a'), [{ role: 'assistant', content: BLOQUE_VALIDO }], 'Apruébala')
      const pp = interno._tabla('planeacion_proyectos')[0] as { contenidos: string[]; evaluacion: { trazabilidad_curricular?: TrazabilidadCurricularAprobada } }
      verificar(r.ok && pp.contenidos.join() === 'tradición oral,tipos de narración' && pp.evaluacion.trazabilidad_curricular?.items.length === 0
        && pp.evaluacion.trazabilidad_curricular.propuestasNoVerificadas.length === 4,
        'H6. Borrador histórico: se aprueba; sus contenidos y PDA se conservan literales como no verificados')
    }

    // H8. Reintento tras un cambio curricular: la fuente es la trazabilidad consolidada.
    {
      const datosViejos = datosCurriculares(baseCurricular(), PERIODOS)
      const mensaje = await borradorParte2(datosViejos, 'grupo-3a', TITULO)
      const resumen = extraerResumenBorrador([{ role: 'assistant', content: mensaje }])!
      const primera = decidirCurricularAprobacion(await ctxCarga(baseCurricular(), 'grupo-3a'), 'grupo-3a', mensaje, resumen, [])
      // Catálogo actual: versión vigente con otro texto para ese PDA.
      const nueva = baseCurricular('vigente')
      nueva.curriculo_pda = nueva.curriculo_pda.map((x) => (x.id === 'pda-2' ? { ...x, texto: 'Texto nuevo del PDA en la versión vigente.' } : x))
      const datos = datosCurriculares(nueva, PERIODOS)
      const WORD_PREVIO = '7a1b2c3d-0000-4000-8000-00000000aaaa'
      datos.planeaciones.push({ id: 'pl-h8', docente_id: 'docente-1', grupo_id: 'grupo-3a', nombre: 'Cuidamos nuestro cuerpo', fecha_inicio: '2026-08-10', fecha_fin: '2026-08-21', version: 0, estado: 'borrador', institucion_id: 'institucion-1', ciclo_escolar_id: 'ciclo-1', campo_formativo: 'Saberes y Pensamiento Científico', borrador_clave: claveDePrueba(mensaje), aprobacion_token: null, aprobacion_expira_en: null })
      datos.planeacion_proyectos.push({ id: 'pp-h8', planeacion_id: 'pl-h8', nombre: 'Cuidamos nuestro cuerpo', contenidos: [TITULO], pda: [PDA_CUERPO], evaluacion: { trazabilidad_curricular: primera.trazabilidad, documento_word: { nombre: 'Plan.docx', url: 'https://fake-storage.local/previo.docx', archivo_id: WORD_PREVIO, grupo_academico: { grado: '3', grupo: 'A' } } } })
      const { sb, interno } = clienteFalso(DOCENTE_1, datos)
      const registrosAntes = registroArchivos.length
      const r = await aprobarBorradorPlaneacion(sb, ses('grupo-3a'), [{ role: 'assistant', content: mensaje }], 'Apruébala')
      const pp = interno._tabla('planeacion_proyectos') as { evaluacion: { trazabilidad_curricular: unknown; documento_word: { archivo_id: string }; documento_pdf?: { archivo_id: string } } }[]
      const def = r.ok ? r.documentoPlaneacion?.contenidoDefinitivo ?? '' : ''
      verificar(r.ok && JSON.stringify(pp[0].evaluacion.trazabilidad_curricular) === JSON.stringify(primera.trazabilidad), 'H8a. Reintento: la trazabilidad consolidada se conserva intacta')
      verificar(def.includes(PDA_CUERPO) && !def.includes('Texto nuevo del PDA') && def.includes('Fuente: Catálogo curricular de la app — pendiente de validación oficial'),
        'H8b. El documento que faltaba usa la identidad persistida, nunca la del catálogo posterior')
      const traz = primera.trazabilidad
      verificar(traz.items.every((i) => def.includes(i.texto) && i.pda.every((x) => def.includes(x.texto))) && def.split(ENCABEZADO_IDENTIDAD_VISIBLE).length === 2,
        'H8c. Consistencia: cada contenido y PDA de la trazabilidad está en el documento, en una sola sección')
      verificar(pp.length === 1 && interno._tabla('planeaciones').length === 1 && interno._tabla('proyectos_seguimiento').length === 1 && interno._tabla('hojas_evaluacion').length === 1,
        'H8d. Sin proyectos, planeaciones ni hojas duplicados')
      verificar(pp[0].evaluacion.documento_word.archivo_id === WORD_PREVIO && registroArchivos.length === registrosAntes + 1 && !!pp[0].evaluacion.documento_pdf?.archivo_id
        && r.ok && r.documentoPlaneacion?.word.archivoId === WORD_PREVIO && r.documentoPlaneacion.pdf.archivoId === pp[0].evaluacion.documento_pdf?.archivo_id,
        'H8e. El Word ya registrado se reutiliza; solo se genera y registra el PDF que faltaba')
      const reg = registroArchivos[registroArchivos.length - 1] as { docente_id?: string; clase?: string }
      verificar(reg.docente_id === 'docente-1' && reg.clase === 'conservar', 'H8f. El archivo nuevo queda registrado a nombre del docente y protegido (conservar)')
    }
    // H9. Proyecto anterior sin trazabilidad y con otros contenidos: no se reconstruye por aproximación.
    for (const [contenidosPrevios, coincide, etiqueta] of [[['Otro contenido distinto'], false, 'no coincide'], [[TITULO], true, 'coincide']] as [string[], boolean, string][]) {
      const datos = datosCurriculares(baseCurricular(), PERIODOS)
      const mensaje = await borradorParte2(datos, 'grupo-3a', TITULO)
      datos.planeaciones.push({ id: 'pl-h9', docente_id: 'docente-1', grupo_id: 'grupo-3a', nombre: 'Cuidamos nuestro cuerpo', fecha_inicio: '2026-08-10', fecha_fin: '2026-08-21', version: 0, estado: 'borrador', institucion_id: 'institucion-1', ciclo_escolar_id: 'ciclo-1', campo_formativo: 'Saberes y Pensamiento Científico', borrador_clave: claveDePrueba(mensaje), aprobacion_token: null, aprobacion_expira_en: null })
      datos.planeacion_proyectos.push({ id: 'pp-h9', planeacion_id: 'pl-h9', nombre: 'Cuidamos nuestro cuerpo', contenidos: contenidosPrevios, pda: coincide ? [PDA_CUERPO] : [], evaluacion: {} })
      const { sb, interno } = clienteFalso(DOCENTE_1, datos)
      const registrosAntes = registroArchivos.length
      const r = await aprobarBorradorPlaneacion(sb, ses('grupo-3a'), [{ role: 'assistant', content: mensaje }], 'Apruébala')
      const ev = (interno._tabla('planeacion_proyectos')[0] as { evaluacion: { trazabilidad_curricular?: unknown } }).evaluacion
      if (coincide) verificar(r.ok && !!r.documentoPlaneacion && !!ev.trazabilidad_curricular && registroArchivos.length === registrosAntes + 2, 'H9b. Proyecto anterior sin trazabilidad que coincide: se consolida y se generan los documentos')
      else verificar(r.ok && r.documentoPlaneacion === null && ev.trazabilidad_curricular === undefined && registroArchivos.length === registrosAntes, `H9a. Proyecto anterior sin trazabilidad que ${etiqueta}: ni documentos ni trazabilidad por aproximación (la aprobación sigue)`)
    }

    // I. Identidad del borrador e idempotencia de la aprobación (migración
    //    20261125000000): mensaje persistido, concesión atómica y relaciones únicas.
    {
      const MSG = BLOQUE_VALIDO
      const mensajeChat = (conv: string, id: string, creado: string) => ({ id: `${conv}:${id}`, conversacion_id: conv, docente_id: 'docente-1', rol: 'asistente', texto: MSG, creado_en: creado })
      const conteo = (interno: ClienteSupabaseFalso) => ['planeaciones', 'planeacion_proyectos', 'proyectos_seguimiento', 'hojas_evaluacion'].map((t) => interno._tabla(t).length).join(',')
      const aprobar = (sb: SupabaseClient, conv: string | null) => aprobarBorradorPlaneacion(sb, sesion(), [{ role: 'assistant', content: MSG }], 'Apruébala', conv)
      const CONV_A = '0a000000-0000-4000-8000-00000000000a', CONV_B = '0b000000-0000-4000-8000-00000000000b'

      // I1. Borradores independientes con igual nombre, fechas y contenido (dos conversaciones).
      {
        const datos = datosBase()
        ;(datos as Record<string, Fila[]>).mensajes_chat = [mensajeChat(CONV_A, 'msg-1', '2026-08-10T10:00:00Z'), mensajeChat(CONV_B, 'msg-1', '2026-08-10T11:00:00Z')]
        const { sb, interno } = clienteFalso(DOCENTE_1, datos)
        const r1 = await aprobar(sb, CONV_A)
        const r2 = await aprobar(sb, CONV_B)
        const claves = (interno._tabla('planeaciones') as { borrador_clave: string }[]).map((p) => p.borrador_clave).sort()
        verificar(r1.ok && r2.ok && conteo(interno) === '2,2,2,2' && JSON.stringify(claves) === JSON.stringify([`msg:${CONV_A}:msg-1`, `msg:${CONV_B}:msg-1`]),
          'I1. Dos borradores idénticos (nombre, fechas y contenido) de conversaciones distintas → dos planeaciones completas, cada una con la identidad de su mensaje')
        // I1b. Misma conversación: el modelo vuelve a presentar el MISMO texto como un borrador nuevo.
        ;(interno._tabla('mensajes_chat') as Fila[]).push(mensajeChat(CONV_A, 'msg-9', '2026-08-10T12:00:00Z'))
        const r3 = await aprobar(sb, CONV_A)
        verificar(r3.ok && conteo(interno) === '3,3,3,3', 'I1b. Un borrador nuevo con el mismo texto en la misma conversación (otro mensaje) es otra planeación')
        // I2. Reintento del mismo borrador.
        const archivosAntes = registroArchivos.length
        const r4 = await aprobar(sb, CONV_A)
        verificar(r4.ok && r4.planeacion.id === (r3.ok ? r3.planeacion.id : '') && conteo(interno) === '3,3,3,3' && registroArchivos.length === archivosAntes, 'I2. Reintento del mismo borrador → la misma planeación con sus tarjetas, sin filas, hojas ni archivos nuevos')
      }

      // I2b. Mensaje aún no persistido: no se aprueba todavía ni se escribe nada; ya persistido, sí.
      {
        const datos = datosBase()
        ;(datos as Record<string, Fila[]>).mensajes_chat = []
        const { sb, interno } = clienteFalso(DOCENTE_1, datos)
        const r1 = await aprobar(sb, CONV_A)
        const sinEscrituras = conteo(interno) === '0,0,0,0' && interno._tabla('documentos_generados').length === 0
        ;(interno._tabla('mensajes_chat') as Fila[]).push(mensajeChat(CONV_A, 'msg-1', '2026-08-10T10:00:00Z'))
        const r2 = await aprobar(sb, CONV_A)
        const pl = interno._tabla('planeaciones') as { borrador_clave: string; version: number; aprobacion_token: string | null }[]
        verificar(!r1.ok && r1.codigo === 'BORRADOR_NO_PERSISTIDO' && sinEscrituras && r2.ok && pl.length === 1 && pl[0].borrador_clave === `msg:${CONV_A}:msg-1` && pl[0].aprobacion_token === null,
          'I2b. Sin el mensaje persistido no se aprueba ni se escribe (nunca identidad por texto); ya persistido, se aprueba y libera la concesión')
      }

      // I3. Aprobaciones concurrentes del mismo borrador.
      {
        const datos = datosBase()
        ;(datos as Record<string, Fila[]>).mensajes_chat = [mensajeChat(CONV_A, 'msg-1', '2026-08-10T10:00:00Z')]
        const { sb, interno } = clienteFalso(DOCENTE_1, datos)
        const archivosAntes = registroArchivos.length
        const resultados = await Promise.all([aprobar(sb, CONV_A), aprobar(sb, CONV_A), aprobar(sb, CONV_A)])
        const exitos = resultados.filter((r) => r.ok).length
        const otros = resultados.filter((r) => !r.ok).map((r) => (r as { codigo: string }).codigo)
        verificar(exitos === 1 && otros.every((c) => c === 'EN_PROCESO' || c === 'YA_GUARDADA') && conteo(interno) === '1,1,1,1' && registroArchivos.length === archivosAntes + 2,
          `I3. Tres aprobaciones simultáneas: una guarda; las demás esperan (${otros.join(', ')}); 1 planeación, 1 proyecto, 1 seguimiento, 1 hoja y 2 archivos`)
      }

      // I4. Recuperación tras una aprobación interrumpida (concesión de otro proceso).
      for (const [vencida, etiqueta] of [[false, 'vigente'], [true, 'vencida']] as [boolean, string][]) {
        const datos = datosBase()
        ;(datos as Record<string, Fila[]>).mensajes_chat = [mensajeChat(CONV_A, 'msg-1', '2026-08-10T10:00:00Z')]
        datos.planeaciones.push({ id: 'pl-i4', docente_id: 'docente-1', grupo_id: 'grupo-1', nombre: 'Leyendas de mi comunidad', fecha_inicio: '2026-08-10', fecha_fin: '2026-08-21', version: 0, estado: 'borrador', institucion_id: 'institucion-1', ciclo_escolar_id: 'ciclo-1', campo_formativo: 'Lenguajes',
          borrador_clave: `msg:${CONV_A}:msg-1`, aprobacion_token: 'otro-proceso', aprobacion_expira_en: new Date(Date.now() + (vencida ? -1000 : 60_000)).toISOString() })
        const { sb, interno } = clienteFalso(DOCENTE_1, datos)
        const r = await aprobar(sb, CONV_A)
        const pl = interno._tabla('planeaciones') as { version: number; aprobacion_token: string | null }[]
        if (vencida) verificar(r.ok && pl.length === 1 && pl[0].version === 1 && pl[0].aprobacion_token === null && conteo(interno) === '1,1,1,1', 'I4b. Concesión vencida (proceso interrumpido): se reanuda y completa sin duplicar')
        else verificar(!r.ok && r.codigo === 'EN_PROCESO' && pl[0].version === 0 && pl[0].aprobacion_token === 'otro-proceso' && conteo(interno) === '1,0,0,0', `I4a. Concesión ${etiqueta} de otra solicitud: no se toca nada`)
      }

      // I5. Registros históricos (sin identidad) con el mismo nombre y fechas no bloquean.
      {
        const datos = datosBase()
        ;(datos as Record<string, Fila[]>).mensajes_chat = [mensajeChat(CONV_A, 'msg-1', '2026-08-10T10:00:00Z')]
        datos.planeaciones.push({ id: 'pl-hist', docente_id: 'docente-1', grupo_id: 'grupo-1', nombre: 'Leyendas de mi comunidad', fecha_inicio: '2026-08-10', fecha_fin: '2026-08-21', version: 1, estado: 'publicada', institucion_id: 'institucion-1', ciclo_escolar_id: 'ciclo-1', campo_formativo: 'Lenguajes' })
        datos.planeaciones.push({ id: 'pl-hist-0', docente_id: 'docente-1', grupo_id: 'grupo-1', nombre: 'Leyendas de mi comunidad', fecha_inicio: '2026-08-10', fecha_fin: '2026-08-21', version: 0, estado: 'borrador', institucion_id: 'institucion-1', ciclo_escolar_id: 'ciclo-1', campo_formativo: 'Lenguajes' })
        const { sb, interno } = clienteFalso(DOCENTE_1, datos)
        const r = await aprobar(sb, CONV_A)
        const pl = interno._tabla('planeaciones') as { id: string; version: number }[]
        verificar(r.ok && pl.length === 3 && pl.find((p) => p.id === 'pl-hist')?.version === 1 && pl.find((p) => p.id === 'pl-hist-0')?.version === 0,
          'I5. Planeaciones anteriores con el mismo nombre y fechas (publicada o a medias, sin identidad) no bloquean ni se modifican')
      }

      // I6. La identidad por mensaje exige la conversación validada.
      {
        const { sb } = clienteFalso(DOCENTE_1, { ...datosBase(), mensajes_chat: [{ id: `${CONV_B}:msg-1`, conversacion_id: CONV_A, docente_id: 'docente-1', rol: 'asistente', texto: MSG, creado_en: '2026-08-10T10:00:00Z' }] })
        verificar(await resolverIdentidadBorrador(sb, CONV_A, MSG) === null && await resolverIdentidadBorrador(sb, null, MSG) === null,
          'I6. Un id de mensaje que no pertenece a la conversación, o la falta de conversación, no dan identidad')
      }

      // I8. Aprobación terminada cuya respuesta se perdió: el reintento entrega lo mismo, sin regenerar.
      {
        const datos = datosBase()
        ;(datos as Record<string, Fila[]>).mensajes_chat = [mensajeChat(CONV_A, 'msg-1', '2026-08-10T10:00:00Z')]
        const { sb, interno } = clienteFalso(DOCENTE_1, datos)
        const r1 = await aprobar(sb, CONV_A)
        const antes = { conteo: conteo(interno), archivos: registroArchivos.length, storage: (interno['archivosStorage'] as Map<string, Buffer>).size, historial: interno._tabla('documentos_generados').length }
        const r2 = await aprobar(sb, CONV_A) // mismo historial: el docente no recibió la confirmación
        verificar(r1.ok && r2.ok && r2.planeacion.id === r1.planeacion.id && r2.documentoPlaneacion?.word.archivoId === r1.documentoPlaneacion?.word.archivoId && r2.documentoPlaneacion?.pdf.archivoId === r1.documentoPlaneacion?.pdf.archivoId
          && r2.hoja.identificadorVisible === r1.hoja.identificadorVisible && !!r2.hoja.url && r2.documentoPlaneacion?.contenidoDefinitivo === r1.documentoPlaneacion?.contenidoDefinitivo,
          'I8a. El reintento recupera la planeación existente con sus tarjetas originales (mismos archivoId, hoja y contenido)')
        verificar(conteo(interno) === antes.conteo && registroArchivos.length === antes.archivos && (interno['archivosStorage'] as Map<string, Buffer>).size === antes.storage && interno._tabla('documentos_generados').length === antes.historial,
          'I8b. Sin regenerar: ni filas, ni archivos, ni objetos en Storage, ni registros de Historial nuevos')

        // I9. Historial canónico escrito por el servidor, una sola vez.
        const doc1 = r1.ok ? r1.documentoPlaneacion : null
        const hist = interno._tabla('documentos_generados') as { archivo_id: string; archivo_formato: string; origen: string; user_id: string; contenido: string }[]
        verificar(hist.length === 1 && hist[0].archivo_id === doc1?.word.archivoId && hist[0].archivo_formato === 'word' && hist[0].origen === 'archivo' && hist[0].user_id === 'docente-1' && hist[0].contenido === doc1?.contenidoDefinitivo,
          'I9a. El servidor registra la planeación en Historial (vinculada a su Word), sin depender de que el cliente reciba la respuesta')
        const { error } = await sb.from('documentos_generados').insert({ user_id: 'docente-1', contenido: 'x', archivo_id: doc1?.word.archivoId, archivo_formato: 'word', origen: 'archivo' }) as { error: { code?: string } | null }
        verificar(error?.code === '23505' && interno._tabla('documentos_generados').length === 1, 'I9b. Un segundo registro del mismo original (p. ej. el del cliente) choca con el índice único: nunca hay duplicados')
      }

      // I10. Ejecución lenta que pierde la concesión mientras genera archivos.
      {
        const datos = datosBase()
        ;(datos as Record<string, Fila[]>).mensajes_chat = [mensajeChat(CONV_A, 'msg-1', '2026-08-10T10:00:00Z')]
        const { sb, interno } = clienteFalso(DOCENTE_1, datos)
        // Justo cuando su Word queda confirmado, su concesión venció y otra solicitud tomó un token nuevo.
        alConfirmarArchivo = () => {
          const fila = (interno._tabla('planeaciones') as Fila[])[0]
          Object.assign(fila, { aprobacion_token: 'token-de-la-nueva-ejecucion', aprobacion_expira_en: new Date(Date.now() + 60_000).toISOString() })
        }
        const archivosAntes = registroArchivos.length
        const r = await aprobar(sb, CONV_A)
        alConfirmarArchivo = null
        const pl = (interno._tabla('planeaciones') as { version: number; aprobacion_token: string | null }[])[0]
        const ev = (interno._tabla('planeacion_proyectos') as { evaluacion: Record<string, unknown> }[])[0]?.evaluacion ?? {}
        const generado = registroArchivos.slice(archivosAntes) as { estado: string; activado_en?: string | null; ultimo_error?: string }[]
        verificar(!r.ok && r.codigo === 'EN_PROCESO' && pl.version === 0 && pl.aprobacion_token === 'token-de-la-nueva-ejecucion',
          'I10a. La ejecución que perdió la concesión no confirma ni toca la concesión de la nueva')
        verificar(!('documento_word' in ev) && interno._tabla('documentos_generados').length === 0,
          'I10b. No consolida su archivo en el proyecto ni en Historial (no sobrescribe a la nueva ejecución)')
        verificar(generado.length === 1 && generado[0].estado === 'fallido' && generado[0].activado_en === null && !!generado[0].ultimo_error?.includes('perdió su concesión'),
          'I10c. Su archivo queda "fallido" con activado_en nulo (cumple el CHECK activo ⇔ activado_en): auditado y jamás recuperable')
      }

      // I11. La concesión se pierde JUSTO entre la última renovación y la consolidación final.
      {
        const datos = datosBase()
        ;(datos as Record<string, Fila[]>).mensajes_chat = [mensajeChat(CONV_A, 'msg-1', '2026-08-10T10:00:00Z')]
        const { sb, interno } = clienteFalso(DOCENTE_1, datos)
        interno.antesDeConsolidarFinal = () => {
          Object.assign((interno._tabla('planeaciones') as Fila[])[0], { aprobacion_token: 'token-nuevo', aprobacion_expira_en: new Date(Date.now() + 60_000).toISOString() })
        }
        const r = await aprobar(sb, CONV_A)
        const pl = (interno._tabla('planeaciones') as { version: number; aprobacion_token: string | null }[])[0]
        const ev = (interno._tabla('planeacion_proyectos') as { evaluacion: Record<string, unknown> }[])[0]?.evaluacion ?? {}
        verificar(!r.ok && r.codigo === 'EN_PROCESO' && pl.version === 0 && pl.aprobacion_token === 'token-nuevo' && !('hoja_id' in ev) && interno._tabla('documentos_generados').length === 0,
          'I11. Sin margen: la consolidación final (vínculo + Historial) es atómica con el token; perdida la concesión, no escribe ni confirma')
      }

      // I13. El historial ya muestra la confirmación (caso real de Preview): se comprueba el estado
      //      persistido por la identidad del borrador y se entregan las tarjetas originales.
      {
        const datos = datosBase()
        ;(datos as Record<string, Fila[]>).mensajes_chat = [mensajeChat(CONV_A, 'msg-1', '2026-08-10T10:00:00Z')]
        const { sb, interno } = clienteFalso(DOCENTE_1, datos)
        const r1 = await aprobar(sb, CONV_A)
        const confirmacion = `Listo, guardé la planeación de ${r1.ok ? r1.planeacion.nombre : ''} para 5 días efectivos.`
        const historialConfirmado = [{ role: 'assistant', content: MSG }, { role: 'user', content: 'Apruébala' }, { role: 'assistant', content: confirmacion }]
        const antes = { conteo: conteo(interno), archivos: registroArchivos.length, storage: (interno['archivosStorage'] as Map<string, Buffer>).size, historial: interno._tabla('documentos_generados').length, escrituras: interno.escrituras.length }
        const r2 = await aprobarBorradorPlaneacion(sb, sesion(), historialConfirmado, 'Aprueba y guarda esta planeación.', CONV_A)
        verificar(r1.ok && r2.ok && r2.planeacion.id === r1.planeacion.id && r2.documentoPlaneacion?.word.archivoId === r1.documentoPlaneacion?.word.archivoId
          && r2.documentoPlaneacion?.pdf.archivoId === r1.documentoPlaneacion?.pdf.archivoId && r2.hoja.identificadorVisible === r1.hoja.identificadorVisible && !!r2.hoja.url
          && r2.documentoPlaneacion?.contenidoDefinitivo === r1.documentoPlaneacion?.contenidoDefinitivo,
          'I13a. Con la confirmación en el historial, se recuperan las tarjetas originales (misma planeación, Word, PDF, hoja y contenido)')
        verificar(conteo(interno) === antes.conteo && registroArchivos.length === antes.archivos && (interno['archivosStorage'] as Map<string, Buffer>).size === antes.storage
          && interno._tabla('documentos_generados').length === antes.historial && interno.escrituras.length === antes.escrituras,
          'I13b. Sin regenerar ni escribir nada: ni filas, ni archivos, ni Storage, ni Historial')

        // I14. Confirmación en el historial pero planeación persistida aún sin confirmar: manda el estado persistido.
        ;(interno._tabla('planeaciones') as Fila[])[0].version = 0
        const r3 = await aprobarBorradorPlaneacion(sb, sesion(), historialConfirmado, 'Apruébala', CONV_A)
        verificar(!r3.ok && r3.codigo === 'EN_PROCESO' && interno.escrituras.length === antes.escrituras,
          'I14. La confirmación textual no sustituye al estado persistido: sin confirmar en la base → "en proceso", sin escribir')
      }

      // I15. Planeación histórica sin identidad + confirmación en el historial: el mensaje de siempre, sin asociar nada.
      {
        const datos = datosBase()
        ;(datos as Record<string, Fila[]>).mensajes_chat = [mensajeChat(CONV_A, 'msg-1', '2026-08-10T10:00:00Z')]
        const { sb, interno } = clienteFalso(DOCENTE_1, { ...datos, planeaciones: [{ id: 'pl-historica', docente_id: 'docente-1', grupo_id: 'grupo-1', nombre: 'X', version: 1, estado: 'publicada', borrador_clave: null }] })
        const historial = [{ role: 'assistant', content: MSG }, { role: 'user', content: 'Apruébala' }, { role: 'assistant', content: 'Listo, guardé la planeación de X para 5 días.' }]
        const r = await aprobarBorradorPlaneacion(sb, sesion(), historial, 'Apruébala', CONV_A)
        const sinBorrador = await aprobarBorradorPlaneacion(sb, sesion(), [{ role: 'assistant', content: 'Listo, guardé la planeación de X para 5 días.' }], 'Apruébala', CONV_A)
        verificar(!r.ok && r.codigo === 'YA_GUARDADA' && !sinBorrador.ok && sinBorrador.codigo === 'YA_GUARDADA' && interno.escrituras.length === 0 && interno._tabla('planeaciones').length === 1,
          'I15. Sin identidad persistida (planeación histórica) o sin el borrador en el historial: "ya está guardada", sin crear registros ni asociar documentos')
      }

      // V. Hito 2, etapa 1 — la primera aprobación publica su versión 1 (fuente canónica única).
      {
        const datos = datosBase()
        ;(datos as Record<string, Fila[]>).mensajes_chat = [mensajeChat(CONV_A, 'msg-1', '2026-08-10T10:00:00Z')]
        const { sb, interno } = clienteFalso(DOCENTE_1, datos)
        const r1 = await aprobar(sb, CONV_A)
        const versiones = interno._tabla('planeacion_versiones') as { planeacion_id: string; numero: number; origen: string; borrador_clave: string; contenido: string; documento_word_archivo_id: string; documento_pdf_archivo_id: string; trazabilidad_curricular: { esquema?: string }; estructura: { planeacion?: { nombre?: string }; proyecto?: { contenidos?: unknown } } }[]
        const pl = (interno._tabla('planeaciones') as { version: number; aprobacion_token: string | null }[])[0]
        verificar(r1.ok && versiones.length === 1 && versiones[0].planeacion_id === r1.planeacion.id && versiones[0].numero === 1 && versiones[0].origen === 'aprobacion'
          && versiones[0].borrador_clave === `msg:${CONV_A}:msg-1` && pl.version === 1 && pl.aprobacion_token === null,
          'VA. La primera aprobación confirma publicando la versión 1 en el mismo paso (identidad del borrador, concesión liberada)')
        verificar(r1.ok && versiones[0].contenido === r1.documentoPlaneacion?.contenidoDefinitivo && versiones[0].documento_word_archivo_id === r1.documentoPlaneacion?.word.archivoId
          && versiones[0].documento_pdf_archivo_id === r1.documentoPlaneacion?.pdf.archivoId && versiones[0].trazabilidad_curricular?.esquema === 'planeacion-curricular-v1'
          && versiones[0].estructura.planeacion?.nombre === r1.planeacion.nombre && Array.isArray(versiones[0].estructura.proyecto?.contenidos),
          'VB. La versión 1 guarda el mismo texto, Word, PDF, trazabilidad y estructura que se entregaron: una sola fuente canónica')
        const r2 = await aprobar(sb, CONV_A)
        verificar(r2.ok && r2.planeacion.id === (r1.ok ? r1.planeacion.id : '') && interno._tabla('planeacion_versiones').length === 1, 'VC. El reintento recupera la misma planeación sin otra versión')
      }
      {
        // Concesión perdida antes de confirmar: ni confirma ni publica versión.
        const datos = datosBase()
        ;(datos as Record<string, Fila[]>).mensajes_chat = [mensajeChat(CONV_A, 'msg-1', '2026-08-10T10:00:00Z')]
        const { sb, interno } = clienteFalso(DOCENTE_1, datos)
        interno.antesDeConsolidarFinal = () => { Object.assign((interno._tabla('planeaciones') as Fila[])[0], { aprobacion_token: 'token-nuevo', aprobacion_expira_en: new Date(Date.now() + 60_000).toISOString() }) }
        const r = await aprobar(sb, CONV_A)
        verificar(!r.ok && r.codigo === 'EN_PROCESO' && interno._tabla('planeacion_versiones').length === 0, 'VD. Sin la concesión no se publica ninguna versión')
      }
      {
        const codigo = readFileSync(join(__dirname, '..', 'lib', 'planeacion', 'aprobarBorrador.ts'), 'utf-8')
        const migracion = readFileSync(join(__dirname, '..', 'supabase', 'migrations', '20261126000000_planeacion_versiones.sql'), 'utf-8')
        verificar(/if \(contenidoDefinitivoFinal && canonico\)/.test(codigo) && /p_version_base: 0/.test(codigo) && /create trigger planeaciones_deriva_version after update of version/.test(migracion) && /security definer/.test(migracion),
          'VE. Sin texto canónico no se inventa contenido: confirmación directa y la base deriva la versión de lo guardado')
      }

      // I12. Ninguna escritura de consolidación fuera de la función atómica.
      {
        const codigo = readFileSync(join(__dirname, '..', 'lib', 'planeacion', 'aprobarBorrador.ts'), 'utf-8')
        const migracion = readFileSync(join(__dirname, '..', 'supabase', 'migrations', '20261125000000_identidad_aprobacion_planeacion.sql'), 'utf-8')
        verificar(!/from\('planeacion_proyectos'\)\s*\.update/.test(codigo) && !/from\('documentos_generados'\)\.insert/.test(codigo)
          && /aprobacion_token = p_token/.test(migracion) && /security invoker/.test(migracion) && /auth\.uid\(\)/.test(migracion),
          'I12. Evaluación e Historial de una aprobación en curso solo se escriben con consolidar_aprobacion_planeacion (token comprobado en la misma transacción); la recuperación no escribe')
      }

      // I7. Ruta y cliente.
      const ruta = readFileSync(join(__dirname, '..', 'app', 'api', 'chat', 'route.ts'), 'utf-8')
      const motor = readFileSync(join(__dirname, '..', 'lib', 'asistente', 'motores', 'motorTextoClaude.ts'), 'utf-8')
      const aprobarCodigo = readFileSync(join(__dirname, '..', 'lib', 'planeacion', 'aprobarBorrador.ts'), 'utf-8')
      verificar(ruta.includes("aprobarBorradorPlaneacion(supabaseUser, sesion, historialMensajes, esEdicionDocumento ? '' : String(mensaje ?? ''), conversacionAprobacion)")
        && !/buscarPorHuella|eq\('nombre', resumen\.nombre\)|claveDeTextoBorrador|txt:/.test(aprobarCodigo) && motor.includes("error.code !== '23505'"),
        'I7. La ruta pasa la conversación validada; ya no hay identidad por nombre y fechas; un registro de Historial repetido (índice único) no es un error')
    }

    // H7. Ruta del Chat: tarjetas con archivoId y contenido definitivo para el historial.
    {
      const ruta = readFileSync(join(__dirname, '..', 'app', 'api', 'chat', 'route.ts'), 'utf-8')
      verificar(ruta.includes("archivoId: word.archivoId, grupoAcademico: word.grupoAcademico, tipoDocumento: 'planeacion'") && ruta.includes("archivoId: pdf.archivoId, grupoAcademico: pdf.grupoAcademico, tipoDocumento: 'planeacion'")
        && ruta.includes('if (word.archivoId && contenidoDefinitivo) marcadores.push(`[[DOCUMENTO_CONTENIDO:'),
        'H7. Tarjetas de la planeación aprobada con archivoId (B1) y contenido definitivo para el registro del historial (B2)')
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
