// scripts/verificar-respuesta-tardia.ts
//
// Respuestas tardías ligadas a la conversación que las pidió: cada
// solicitud guarda la vista (conversación y turno) en que se hizo y
// manejarEventoMotor descarta las de otra vista (solo libera el estado de
// generación); el motor de texto solo emite los eventos de su solicitud
// vigente. Conversión y generación directa (CASO 3) con cambio de
// conversación, ida y vuelta, otra solicitud iniciada mientras tanto
// (motor real con fetch simulado), conversación eliminada con una
// respuesta pendiente y conversión normal sin cambios.
//
// Sin red, sin credenciales, sin IA. Se ejecuta con
// `npx tsx scripts/verificar-respuesta-tardia.ts`.

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
  const lecturas: { tabla: string; columnas: string }[] = []
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
    private opciones: { ignoreDuplicates?: boolean } = {}
    constructor(private tabla: string) {}
    select(c = '') { if (this.op === 'select') this.columnas = c; return this }
    maybeSingle() { this.unica = true; return this }
    order(c: string, o: { ascending: boolean }) { this.orden = { c, asc: o.ascending }; return this }
    limit(n: number) { this.tope = n; return this }
    in(c: string, v: unknown[]) { this.filtros.push((f) => v.includes(f[c])); return this }
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
        lecturas.push({ tabla: this.tabla, columnas: this.columnas })
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
  ;(s.auth as Record<string, unknown>).getUser = async () => ({ data: { user: null }, error: null })
  ;(s.auth as Record<string, unknown>).getSession = async () => ({ data: { session: sesionVigente ? { user: { id: sesion } } : null }, error: null })
  s.rpc = async () => ({ data: null, error: null })
  s.from = (tabla: string) => new Consulta(tabla)

  const LISTO = 'Ya puedes abrirlo, compartirlo o descargarlo.'
  const AVISO = '📨 AVISO DE EXCURSIÓN ESCOLAR\n\nTexto ficticio sin datos de alumnos.'
  const EXAMEN = '📝 EXAMEN DE FRACCIONES\n\nPregunta 1. Texto ficticio.'
  const archivo = (tipo: string) => ({ tipo, nombre: `AVISO.${tipo}`, url: `https://proyecto.supabase.co/storage/v1/object/sign/documentos-generados-ia/d/AVISO.${tipo}?token=firma` })

  // ---- A. Motor real: una solicitud superada ya no emite nada ----
  type Pendiente = { resolver: (texto: string) => void; signal: AbortSignal }
  const pendientes: Pendiente[] = []
  ;(globalThis as Record<string, unknown>).fetch = (_url: string, init: { signal: AbortSignal }) => new Promise((resolve) => {
    pendientes.push({ resolver: (texto) => resolve(new Response(texto, { status: 200 })), signal: init.signal })
  })
  const { MotorTextoClaude } = await import('../lib/asistente/motores/motorTextoClaude')
  const motorA = new MotorTextoClaude()
  const eventosA: { tipo: string; texto?: string; mensaje?: string }[] = []
  motorA.suscribir((e) => eventosA.push(e as never))
  const p1 = motorA.enviarTexto('uno')
  for (let i = 0; i < 100 && pendientes.length < 1; i++) await esperar(10)
  const p2 = motorA.enviarTexto('dos')
  for (let i = 0; i < 100 && pendientes.length < 2; i++) await esperar(10)
  pendientes[1].resolver('Respuesta a dos')
  await p2
  pendientes[0].resolver('Respuesta tardía a uno')
  await p1
  const textosA = eventosA.map((e) => e.texto ?? e.mensaje ?? '')
  verificar(textosA.every((x) => !x.includes('uno')) && eventosA.filter((e) => e.tipo === 'respuesta-final').length === 1 && textosA.includes('Respuesta a dos'), 'A1. Dos solicitudes superpuestas: solo la vigente emite eventos (la tardía nunca llega)')
  verificar(pendientes[0].signal !== pendientes[1].signal && !pendientes[1].signal.aborted, 'A2. Cada solicitud tiene su propio controlador (la anterior no aborta la vigente)')
  pendientes.length = 0

  // ---- B. Servicio ----
  almacen = DISPOSITIVO_A
  await p.guardarMensajesRemotos('conv-x', DOCENTE_A, []) // línea base de la etapa 1
  const ahora = Date.now()
  const docX = { id: 'msg-doc-x', rol: 'asistente' as const, texto: AVISO, creadoEn: ahora - 5000 }
  const docY = { id: 'msg-doc-y', rol: 'asistente' as const, texto: EXAMEN, creadoEn: ahora - 5000 }
  const reiniciarConversaciones = () => {
    p.guardarConversacion('conv-x', [{ id: 'msg-x0', rol: 'usuario', texto: 'Haz un aviso', creadoEn: ahora - 6000 }, docX] as never, { id: docX.id, texto: AVISO })
    p.guardarConversacion('conv-y', [{ id: 'msg-y0', rol: 'usuario', texto: 'Haz un examen', creadoEn: ahora - 6000 }, docY] as never, { id: docY.id, texto: EXAMEN })
  }
  reiniciarConversaciones()
  const { AsistenteService } = await import('../lib/asistente/AsistenteService')
  type Doc = { id: string; texto: string } | null
  const chat = AsistenteService as unknown as {
    conversacionActivaId: string | null; mensajes: Mensaje[]; documentoActivo: Doc; generando: boolean
    sincronizadaEn: Map<string, number>; abrirConversacion(id: string): void; enviarMensaje(texto: string): Promise<string>; manejarEventoMotor(e: unknown): void; alRetirarConversacion(id: string): void; guardarInmediatamente(): void
  }
  const interno = chat as unknown as Record<string, unknown>
  let pendiente: (() => void) | null = null
  const motorB = {
    establecerHistorial: () => {},
    establecerConversacion: () => {},
    enviarTexto: async (_texto: string, _adj: unknown, fin?: { tipo: string }) => {
      // Respuesta del "servidor" retenida hasta que la prueba la suelte.
      pendiente = fin
        ? () => { const a = archivo(fin.tipo); chat.manejarEventoMotor({ tipo: 'respuesta-parcial', texto: 'Documento generado correctamente.' }); chat.manejarEventoMotor({ tipo: 'respuesta-final', texto: 'Documento generado correctamente.', archivo: a, archivos: [a] }) }
        : () => { const a = archivo('word'); chat.manejarEventoMotor({ tipo: 'respuesta-parcial', texto: 'Documento generado correctamente.' }); chat.manejarEventoMotor({ tipo: 'respuesta-final', texto: 'Documento generado correctamente.', archivo: a, archivos: [a], contenidoOriginal: AVISO }) }
    },
  }
  const usarMotor = (m: unknown) => { interno.motorTexto = m; interno.motor = m }
  usarMotor(motorB)
  interno.asegurarMotor = async () => {}
  interno.asegurarMotorTexto = async () => interno.motorTexto
  const soltar = () => { const f = pendiente; pendiente = null; f?.() }
  const copia = (id: string) => JSON.stringify(p.cargarConversacionPorId(id)?.mensajes)
  const preparar = async () => {
    reiniciarConversaciones()
    interno.conversacionActivaId = null
    chat.abrirConversacion('conv-x')
    chat.sincronizadaEn.set('conv-x', Date.now())
    chat.sincronizadaEn.set('conv-y', Date.now())
    await esperar()
  }

  // 1. Conversión en curso y cambio de conversación.
  await preparar()
  await chat.enviarMensaje('Conviértelo a PDF')
  chat.abrirConversacion('conv-y')
  const y1 = JSON.stringify(chat.mensajes)
  const xGuardada1 = copia('conv-x')
  soltar()
  verificar(JSON.stringify(chat.mensajes) === y1 && chat.documentoActivo?.id === docY.id && !chat.generando, '1a. Conversión tardía tras cambiar de conversación: nada aparece en la otra, su documento activo no cambia y se libera la generación')
  chat.guardarInmediatamente()
  verificar(copia('conv-x') === xGuardada1 && p.cargarConversacionPorId('conv-x')!.mensajes.some((x) => x.texto === 'Conviértelo a PDF') && p.cargarConversacionPorId('conv-x')!.documentoActivo?.id === docX.id, '1b. La conversación original conserva sus mensajes (incluida la solicitud) y su documento activo, sin corrupción')
  // Ida y vuelta antes de que llegue la respuesta.
  await preparar()
  await chat.enviarMensaje('Conviértelo a PDF')
  chat.abrirConversacion('conv-y')
  chat.abrirConversacion('conv-x')
  const x1c = JSON.stringify(chat.mensajes)
  soltar()
  verificar(JSON.stringify(chat.mensajes) === x1c && chat.mensajes.find((x) => x.id === docX.id)?.texto === AVISO && !chat.generando, '1c. Ida y vuelta antes de la respuesta: la respuesta de la vista anterior se descarta sin tocar el documento')

  // 2. Generación directa CASO 3 y cambio de conversación.
  await preparar()
  chat.documentoActivo = null
  await chat.enviarMensaje('Genera directamente un Word con un aviso de excursión')
  chat.abrirConversacion('conv-y')
  const y2 = JSON.stringify(chat.mensajes)
  soltar()
  verificar(JSON.stringify(chat.mensajes) === y2 && (chat.documentoActivo as Doc)?.id === docY.id && !chat.mensajes.some((x) => x.texto === 'Documento generado correctamente.') && !chat.generando, '2a. CASO 3 tardío: sin burbuja ni archivo en la otra conversación y su documento activo no cambia')

  // 3. Respuesta tardía después de iniciar otra solicitud (motor real).
  await preparar()
  const motorReal = new MotorTextoClaude()
  motorReal.suscribir((e) => chat.manejarEventoMotor(e))
  usarMotor(motorReal)
  chat.documentoActivo = null
  void chat.enviarMensaje('Pregunta en X')
  for (let i = 0; i < 100 && pendientes.length < 1; i++) await esperar(10)
  chat.abrirConversacion('conv-y')
  chat.documentoActivo = null
  const enviadoY = chat.enviarMensaje('Pregunta en Y')
  for (let i = 0; i < 100 && pendientes.length < 2; i++) await esperar(10)
  pendientes[1].resolver('Respuesta para Y')
  await enviadoY
  for (let i = 0; i < 50; i++) await esperar(5)
  pendientes[0].resolver('Respuesta tardía para X')
  for (let i = 0; i < 50; i++) await esperar(5)
  const textosY = chat.mensajes.map((x) => x.texto)
  chat.guardarInmediatamente()
  verificar(textosY.includes('Respuesta para Y') && !textosY.some((x) => x.includes('tardía para X')) && textosY.filter((x) => x === 'Respuesta para Y').length === 1, '3a. Otra solicitud iniciada mientras tanto: la conversación nueva recibe solo su respuesta')
  verificar(!(p.cargarConversacionPorId('conv-x')?.mensajes ?? []).some((x) => x.texto.includes('tardía para X') || x.texto.includes('Respuesta para Y')), '3b. Ninguna respuesta se cruza a la conversación original')
  usarMotor(motorB)

  // 4. Conversación eliminada con una respuesta pendiente.
  await preparar()
  await chat.enviarMensaje('Conviértelo a PDF')
  p.eliminarConversacion('conv-x')
  chat.alRetirarConversacion('conv-x')
  soltar()
  verificar(chat.conversacionActivaId === null && chat.mensajes.length === 0 && chat.documentoActivo === null && p.cargarConversacionPorId('conv-x') === null && !chat.generando, '4a. Eliminada con respuesta pendiente: no reaparece, no se agrega nada a la vista inicial y se libera la generación')
  const r4 = await chat.enviarMensaje('Hola, empiezo de nuevo')
  const activa4 = chat.conversacionActivaId as string | null
  verificar(r4 === 'enviado' && activa4 !== null && activa4 !== 'conv-x', '4b. Después se puede escribir de nuevo (conversación nueva)')
  soltar()

  // 5. Conversión normal sin cambio de conversación.
  await preparar()
  chat.documentoActivo = { id: docX.id, texto: AVISO }
  await chat.enviarMensaje('Conviértelo a PDF')
  soltar()
  const ultimo = chat.mensajes[chat.mensajes.length - 1]
  verificar(ultimo.texto === LISTO && (ultimo.archivo as { tipo?: string } | undefined)?.tipo === 'pdf' && chat.mensajes.find((x) => x.id === docX.id)?.texto === AVISO && chat.documentoActivo?.id === docX.id && !chat.generando, '5a. Conversión normal: la entrega llega en su mensaje nuevo y el documento activo no cambia')

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
