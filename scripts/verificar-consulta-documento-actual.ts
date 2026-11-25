// scripts/verificar-consulta-documento-actual.ts
//
// "Muéstrame el documento actual" y frases parecidas muestran la versión
// vigente del documento activo (también una restaurada), como una consulta
// de versiones: sin IA, sin archivo y sin cambiar el documento activo. Las
// conversiones con formato, las entregas ("mándame", "el archivo",
// "ábrelo"), las ediciones y las solicitudes de versiones siguen igual.
//
// Se ejecuta con `npx tsx scripts/verificar-consulta-documento-actual.ts`.

// Módulo (no script global): sus nombres no chocan con otros scripts.
export {}

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  console.log(`${condicion ? '✓' : '✗'} ${mensaje}`)
  if (!condicion) fallos++
}

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://supabase.invalid'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'clave-ficticia'
const DISPOSITIVO_A = new Map<string, string>()
let almacen = DISPOSITIVO_A
const g = globalThis as unknown as Record<string, unknown>
// Oyentes reales de la página: document (visibilitychange) y window (pageshow).
const oyentes: Record<string, ((e: unknown) => void)[]> = {}
const escuchar = (tipo: string, f: (e: unknown) => void) => { (oyentes[tipo] ??= []).push(f) }
g.window = { localStorage: { getItem: (k: string) => almacen.get(k) ?? null, setItem: (k: string, v: string) => { almacen.set(k, v) }, removeItem: (k: string) => { almacen.delete(k) } }, addEventListener: escuchar, removeEventListener() {} }
g.localStorage = (g.window as { localStorage: unknown }).localStorage
const documento = { hidden: false, addEventListener: escuchar }
g.document = documento

type Fila = Record<string, unknown>
type Mensaje = { id: string; rol: 'usuario' | 'asistente'; texto: string; creadoEn: number; [k: string]: unknown }
const DOCENTE_A = '11111111-1111-4111-8111-111111111111'
const esperar = (ms = 50) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const { supabase } = await import('../lib/supabaseClient')
  const p = await import('../lib/asistente/persistencia')

  // ---- Doble de Supabase con RLS por docente ----
  const sesion = DOCENTE_A
  const tablas: Record<string, Fila[]> = { conversaciones_chat: [], mensajes_chat: [] }
  const escrituras: { tabla: string; op: string; ids?: string[] }[] = []
  const lecturas: { tabla: string; columnas: string; ids?: string[] }[] = []
  const fallarPorId = false
  const alLeer: ((tabla: string, columnas: string) => void) | null = null
  const retrasoLecturas = 0
  const fallarLecturas = false
  class Consulta {
    private filtros: ((f: Fila) => boolean)[] = [(f) => f.docente_id === sesion]
    private op = 'select'
    private datos: unknown = null
    private columnas = ''
    private unica = false
    private orden: { c: string; asc: boolean } | null = null
    private tope = Infinity
    private porId = false
    private idsPedidos: string[] = []
    private opciones: { ignoreDuplicates?: boolean } = {}
    constructor(private tabla: string) {}
    select(c = '') { if (this.op === 'select') this.columnas = c; return this }
    maybeSingle() { this.unica = true; return this }
    order(c: string, o: { ascending: boolean }) { this.orden = { c, asc: o.ascending }; return this }
    limit(n: number) { this.tope = n; return this }
    in(c: string, v: unknown[]) { this.porId = true; this.idsPedidos = v as string[]; this.filtros.push((f) => v.includes(f[c])); return this }
    eq(c: string, v: unknown) { this.filtros.push((f) => f[c] === v); return this }
    gt(c: string, v: string) { this.filtros.push((f) => String(f[c]) > v); return this }
    is(c: string, v: null) { this.filtros.push((f) => f[c] === v || f[c] === undefined); return this }
    not(c: string) { this.filtros.push((f) => f[c] != null); return this }
    lt(c: string, v: string) { this.filtros.push((f) => Date.parse(String(f[c])) < Date.parse(v)); return this }
    update(c: Fila) { this.op = 'update'; this.datos = c; return this }
    insert(d: Fila) { this.op = 'insert'; this.datos = d; return this }
    upsert(d: Fila[], o: { ignoreDuplicates?: boolean }) { this.op = 'upsert'; this.datos = d; this.opciones = o ?? {}; return this }
    then(ok: (r: unknown) => unknown, ko?: (e: unknown) => unknown) {
      const retraso = this.op === 'select' ? retrasoLecturas : 0
      return new Promise((r) => setTimeout(r, retraso)).then(() => this.ejecutar()).then(ok, ko)
    }
    private ejecutar() {
      const filas = tablas[this.tabla]
      const coinciden = () => filas.filter((f) => this.filtros.every((x) => x(f)))
      if (this.op === 'select') {
        lecturas.push({ tabla: this.tabla, columnas: this.columnas, ids: this.idsPedidos })
        if (fallarPorId && this.porId && this.tabla === 'mensajes_chat') return { data: null, error: { message: 'fallo simulado de red' } }
        if (fallarLecturas) return { data: null, error: { message: 'fallo simulado de red' } }
        let datos = coinciden().map((f) => JSON.parse(JSON.stringify(f))) as Fila[]
        if (this.orden) { const { c, asc } = this.orden; datos.sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : 1) * (asc ? 1 : -1)) }
        datos = datos.slice(0, this.tope)
        alLeer?.(this.tabla, this.columnas)
        return { data: this.unica ? (datos[0] ?? null) : datos, error: null }
      }
      if (this.op === 'update') {
        const afectadas = coinciden()
        for (const f of afectadas) Object.assign(f, this.datos as Fila)
        escrituras.push({ tabla: this.tabla, op: 'update', ids: afectadas.map((f) => String(f.id)) })
        return { data: afectadas.map((f) => ({ id: f.id })), error: null }
      }
      if (this.op === 'insert') {
        const d = this.datos as Fila
        if (filas.some((f) => f.id === d.id)) return { data: null, error: { code: '23505', message: 'duplicado' } }
        filas.push({ titulo: 'Nueva conversación', documento_activo: null, actualizado_en: new Date().toISOString(), eliminada_en: null, ...d })
        escrituras.push({ tabla: this.tabla, op: 'insert', ids: [String(d.id)] })
        return { data: null, error: null }
      }
      const ids: string[] = []
      for (const f of this.datos as Fila[]) {
        const existente = filas.find((x) => x.id === f.id)
        if (existente && this.opciones.ignoreDuplicates) continue
        if (existente) Object.assign(existente, f)
        else filas.push({ ...f })
        ids.push(String(f.id))
      }
      escrituras.push({ tabla: this.tabla, op: 'upsert', ids })
      return { data: ids.map((id) => ({ id })), error: null }
    }
  }
  const s = supabase as unknown as Record<string, unknown>
  const sesionVigente = true
  ;(s.auth as Record<string, unknown>).getSession = async () => ({ data: { session: sesionVigente ? { user: { id: sesion } } : null }, error: null })
  s.rpc = async () => ({ data: null, error: null })
  s.from = (tabla: string) => new Consulta(tabla)
  // Aislamiento por docente: la sesión simulada abre la puerta de las copias locales.
  p.establecerPropietarioLocal(sesion)

  const DOC = (n: number) => `📨 CITATORIO A PADRES DE FAMILIA\n\nTexto ficticio sin datos de alumnos. Versión ${n}.`
  const d = await import('../lib/asistente/documentos')

  // ---- 1. Detector ----
  const si = ['Muéstrame el documento actual', 'Muéstrame el citatorio', 'Quiero ver el documento', 'Enséñame cómo quedó el citatorio', 'Muéstramelo', '¿Cómo va quedando el documento?', 'Muéstrame el documento']
  const no = [
    'Muéstrame el documento en PDF', 'Pásalo a Word', 'Conviértelo a PowerPoint', 'Mándame el documento', 'Dame el archivo', 'Muéstrame el archivo', 'Ábrelo', 'Descárgalo', 'Compártelo',
    'Agrégale una conclusión', 'Cambia la fecha del citatorio', 'Muéstrame la versión anterior', 'Muéstrame la primera versión del citatorio', 'Muéstrame un ejemplo de rúbrica', 'Hazme otro citatorio',
    'Quiero ver la lista de asistencia', 'Muéstrame los alumnos', 'Hola',
  ]
  const fallidos = [...si.filter((f) => !d.esConsultaDocumentoActual(f)), ...no.filter((f) => d.esConsultaDocumentoActual(f))]
  for (const f of fallidos) console.log('   detector:', f)
  verificar(fallidos.length === 0, `1a. Detector: ${si.length} consultas reconocidas y ${no.length} frases que no lo son (formato, entrega, archivo, edición, versiones, algo nuevo, otras)`)

  // ---- 2. Servicio ----
  almacen = DISPOSITIVO_A
  await p.guardarMensajesRemotos('conv-base-a', DOCENTE_A, [])
  const { AsistenteService } = await import('../lib/asistente/AsistenteService')
  type Doc = { id: string; texto: string; archivosGenerados?: Record<string, unknown>; noRecuperado?: true } | null
  const chat = AsistenteService as unknown as {
    conversacionActivaId: string | null; mensajes: Mensaje[]; documentoActivo: Doc; archivoReutilizadoId: string | null; avisoGeneracion: string | null
    sincronizadaEn: Map<string, number>; abrirConversacion(id: string): void; nuevaConversacion(): void; enviarMensaje(texto: string): Promise<string>; manejarEventoMotor(e: unknown): void; guardarInmediatamente(): void
  }
  const interno = chat as unknown as Record<string, unknown>
  let respuesta: { texto: string } | null = null
  const llamadas: { texto: string; finalizar?: { tipo: string; documentoTexto: string }; edicion?: boolean }[] = []
  const motor = {
    establecerHistorial: () => {},
    establecerConversacion: () => {},
    enviarTexto: async (texto: string, _adj: unknown, finalizar?: { tipo: string; documentoTexto: string }, edicion?: boolean) => {
      llamadas.push({ texto, finalizar, edicion })
      if (finalizar || !respuesta) return
      chat.manejarEventoMotor({ tipo: 'respuesta-parcial', texto: respuesta.texto })
      chat.manejarEventoMotor({ tipo: 'respuesta-final', texto: respuesta.texto })
    },
  }
  interno.motorTexto = motor
  interno.motor = motor
  interno.asegurarMotor = async () => {}
  interno.asegurarMotorTexto = async () => motor
  const ultimo = () => chat.mensajes[chat.mensajes.length - 1]
  const pedir = async (texto: string, r: { texto: string } | null = null) => {
    respuesta = r
    llamadas.length = 0
    interno.editandoDocumentoId = null
    interno.documentoFinalizandoId = null
    chat.sincronizadaEn.set(chat.conversacionActivaId ?? '', Date.now())
    const resultado = await chat.enviarMensaje(texto)
    return { resultado, m: ultimo() }
  }

  chat.nuevaConversacion()
  const conv = chat.conversacionActivaId!
  const v1 = (await pedir('Haz un citatorio', { texto: DOC(1) })).m
  const v2 = (await pedir('Agrégale la hora', { texto: DOC(2) })).m
  const v3 = (await pedir('Agrégale la tercera versión', { texto: DOC(3) })).m
  const restaurada = await pedir('Regresa a la versión anterior')
  verificar(restaurada.m.restauraVersion === v2.id && chat.documentoActivo?.id === v2.id && v3.versionDe === v2.id && v2.versionDe === v1.id, '2a. Preparación: V3 → V2 restaurada (marcador de P2)')
  const docAntes = JSON.stringify(chat.documentoActivo)
  const c = await pedir('Muéstrame el documento actual')
  verificar(c.resultado === 'enviado' && llamadas.length === 0 && c.m.texto === 'Este es el documento actual; lo resalté más arriba.' && !c.m.archivo && !c.m.restauraVersion, '2b. "Muéstrame el documento actual": responde sin IA y sin generar archivos')
  verificar(chat.archivoReutilizadoId === v2.id && JSON.stringify(chat.documentoActivo) === docAntes && p.documentoVigente(chat.mensajes as never)?.id === v2.id, '2c. Se resalta exactamente la versión vigente restaurada (V2); el documento activo y su caché no cambian')
  await pedir('Pásalo a Word')
  verificar(llamadas.length === 1 && llamadas[0].finalizar?.tipo === 'word' && llamadas[0].finalizar.documentoTexto === DOC(2), '2d. "Pásalo a Word" después sigue convirtiendo V2')
  interno.documentoFinalizandoId = null
  interno.editandoDocumentoId = null

  // ---- 3. Regresiones de conversión, entrega y edición ----
  await pedir('Muéstrame el documento en PDF')
  verificar(llamadas[0]?.finalizar?.tipo === 'pdf', '3a. "Muéstrame el documento en PDF": conversión a PDF')
  await pedir('Mándame el documento')
  verificar(llamadas[0]?.finalizar?.tipo === 'word', '3b. "Mándame el documento": entrega (Word), como antes')
  await pedir('Muéstrame el archivo')
  verificar(llamadas[0]?.finalizar !== undefined, '3c. "Muéstrame el archivo": entrega, como antes')
  await pedir('Conviértelo a PowerPoint')
  verificar(llamadas[0]?.finalizar?.tipo === 'powerpoint', '3d. "Conviértelo a PowerPoint": conversión')
  await pedir('Agrégale una conclusión', null)
  verificar(llamadas[0]?.edicion === true && !llamadas[0].finalizar, '3e. "Agrégale una conclusión": edición')
  interno.editandoDocumentoId = null
  await pedir('Muéstrame la primera versión')
  verificar(llamadas.length === 0 && chat.archivoReutilizadoId === v1.id && chat.documentoActivo?.id === v2.id, '3f. "Muéstrame la primera versión" sigue siendo la consulta de versiones de P2')

  // ---- 4. Versión vigente fuera de la memoria: se trae por id ----
  chat.guardarInmediatamente()
  await esperar(2300) // copia remota de la etapa 1
  const remoto = await p.idRemotoDe(DOCENTE_A, conv)
  chat.mensajes = chat.mensajes.filter((x) => x.id !== v2.id) // como si V2 quedara fuera de la ventana
  lecturas.length = 0
  await pedir('Muéstrame el citatorio')
  verificar(chat.mensajes.some((x) => x.id === v2.id) && chat.archivoReutilizadoId === v2.id && lecturas.some((l) => (l.ids ?? []).includes(`${remoto}:${v2.id}`)) && llamadas.length === 0, '4a. Fuera de la memoria, la versión vigente se trae por su id y se resalta')

  // ---- 5. Sincronización previa: se muestra la versión más reciente de otro dispositivo ----
  const v4 = { id: 'msg-v4-iphone', rol: 'asistente' as const, texto: DOC(4), creadoEn: Date.now() + 1000, versionDe: v2.id, documentoRaizId: v1.id }
  tablas.mensajes_chat.push(p.mensajeAFilaRemota(remoto, DOCENTE_A, v4 as never) as unknown as Fila)
  chat.sincronizadaEn.set(conv, Date.now()) // reciente: aun así se sincroniza antes de consultar
  respuesta = null
  llamadas.length = 0
  await chat.enviarMensaje('¿Cómo va quedando el documento?')
  verificar(chat.documentoActivo?.id === v4.id && chat.archivoReutilizadoId === v4.id && llamadas.length === 0, '5a. Antes de mostrar se sincroniza: aparece la V4 escrita en otro dispositivo')

  // ---- 6. Sin documento activo o con la versión no recuperada ----
  chat.documentoActivo = { id: 'msg-no-esta', texto: '', noRecuperado: true }
  const nr = await pedir('Muéstrame el documento actual')
  verificar(nr.resultado === 'no_enviado' && llamadas.length === 0 && chat.avisoGeneracion?.includes('no está disponible') === true, '6a. Con la versión restaurada no recuperada: la protección existente bloquea, sin IA')
  chat.nuevaConversacion()
  await pedir('Muéstrame el documento actual', { texto: 'Todavía no hay un documento en esta conversación.' })
  verificar(llamadas.length === 1 && !llamadas[0].finalizar, '6b. Sin documento activo: sigue el camino normal del chat')

  // ---- 7. Regresión (Preview 786d720): planeación guardada consultada y luego OTRA por su nombre ----
  // 1) Conversación nueva: "Muéstrame la planeación de cuentos propios" → el servidor muestra su texto.
  // 2) "Muéstrame la planeación de las leyendas" → antes: "Este es el documento actual" (el cliente
  //    la tomaba por el documento activo). Debe llegar al servidor como mensaje normal.
  {
    const CUENTOS = '📋 PLANEACIÓN DIDÁCTICA\nProyecto: ¡A contar historias! Elaboración de cuentos propios\nSesión 1: Escuchar cuentos y reconocer su estructura.\n\nVersión 1 · 24 nov – 30 nov 2026'
    chat.nuevaConversacion()
    const consulta = await pedir('Muéstrame la planeación de cuentos propios', { texto: CUENTOS })
    verificar(consulta.resultado === 'enviado' && llamadas.length === 1 && !llamadas[0].edicion && !llamadas[0].finalizar && chat.documentoActivo?.texto === CUENTOS,
      '7a. Paso 1: la consulta llega al servidor y la planeación mostrada queda como documento activo')
    const leyendas = await pedir('Muéstrame la planeación de las leyendas', { texto: 'Encontré 3 planeaciones que coinciden:\n1. Las Leyendas de Nuestra Comunidad · 23 nov – 4 dic 2026\n¿Cuál quieres ver? Responde con su número.' })
    verificar(leyendas.resultado === 'enviado' && llamadas.length === 1 && llamadas[0].texto === 'Muéstrame la planeación de las leyendas' && !llamadas[0].edicion && !llamadas[0].finalizar
      && leyendas.m.texto.startsWith('Encontré 3 planeaciones') && !chat.mensajes.some((x) => x.texto === 'Este es el documento actual; lo resalté más arriba.'),
      '7b. Paso 2: otra planeación por su nombre tiene prioridad sobre el documento activo — va al servidor como mensaje normal (ni consulta local, ni edición, ni archivo)')
    // Las demás intenciones sobre el documento activo no cambian.
    chat.documentoActivo = { id: consulta.m.id, texto: CUENTOS }
    const actual = await pedir('Muéstrame la planeación de cuentos propios')
    const actualSinNombre = await pedir('Muéstrame la planeación')
    verificar(llamadas.length === 0 && actual.m.texto === 'Este es el documento actual; lo resalté más arriba.' && actualSinNombre.m.texto === 'Este es el documento actual; lo resalté más arriba.',
      '7c. Mostrar el documento actual (por su propio nombre o solo por su tipo): local, sin IA')
    interno.documentoFinalizandoId = null
    await pedir('Dame el Word')
    verificar(llamadas.length === 1 && llamadas[0].finalizar?.tipo === 'word' && llamadas[0].finalizar.documentoTexto === CUENTOS, '7d. Recuperar un archivo del documento actual: sigue siendo del documento activo (el servidor entrega su original)')
    interno.documentoFinalizandoId = null
    await pedir('Cámbiale la sesión 2', null)
    verificar(llamadas.length === 1 && llamadas[0].edicion === true && llamadas[0].texto.includes(CUENTOS), '7e. Modificar el documento actual: edición del documento activo (el servidor la bloquea para una planeación guardada)')
    interno.editandoDocumentoId = null
    await pedir('Agrégale una actividad a la planeación de las leyendas', null)
    verificar(llamadas.length === 1 && !llamadas[0].edicion && llamadas[0].texto === 'Agrégale una actividad a la planeación de las leyendas', '7f. Modificar OTRA planeación nombrada no edita el documento activo: va al servidor')
    verificar(d.identificadorDeDocumento('Muéstrame la planeación de las leyendas').join() === 'leyendas' && d.identificadorDeDocumento('Muéstrame la planeación').length === 0
      && d.identificadorDeDocumento('El oficio de la semana pasada').length === 0 && d.identificadorDeDocumento('Haz un resumen del examen').length === 0 && d.identificadorDeDocumento('muéstrame la planeación de nuevo').length === 0
      && d.identificadorDeDocumento('Convierte el documento de excursión escolar más reciente a Word').join() === 'excursion,escolar',
      '7g. Identificador genérico: nombre o tema tras el tipo; nunca el tipo solo, un tiempo, un orden ("más reciente"), una versión o una parte de otro documento')
  }

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  }
  console.log('Todas las pruebas pasaron.')
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
