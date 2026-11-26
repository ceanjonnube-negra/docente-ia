// scripts/verificar-turnos-chat-cliente.ts
//
// Turnos duraderos del Chat IA, etapa del cliente, sin IA ni red: el
// AsistenteService y el MotorTextoClaude REALES contra un servidor simulado
// (/api/chat y /api/chat/turno con las reglas de lib/chat/turnosChat.ts) y
// un Supabase en memoria (mensajes_chat). Cubre: identidad persistente antes
// de enviar, adopción del id canónico sin escrituras duplicadas, corte de
// red, final sin confirmación de guardado, inactividad del stream, doble
// envío, turno fallido con reintento explícito, conversación ocupada,
// mensaje que nunca llegó, recarga y recuperación desde otro dispositivo
// sin estado local. "Generaciones" cuenta las llamadas que en el servidor
// real irían a la IA.
//   npx tsx scripts/verificar-turnos-chat-cliente.ts

export {}

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  console.log(`${condicion ? '✓' : '✗'} ${mensaje}`)
  if (!condicion) fallos++
}

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://supabase.invalid'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'clave-ficticia'
const DISPOSITIVO_A = new Map<string, string>()
const DISPOSITIVO_B = new Map<string, string>()
let almacen = DISPOSITIVO_A
const g = globalThis as unknown as Record<string, unknown>
const oyentes: Record<string, ((e: unknown) => void)[]> = {}
const escuchar = (tipo: string, f: (e: unknown) => void) => { (oyentes[tipo] ??= []).push(f) }
g.window = { localStorage: { getItem: (k: string) => almacen.get(k) ?? null, setItem: (k: string, v: string) => { almacen.set(k, v) }, removeItem: (k: string) => { almacen.delete(k) } }, addEventListener: escuchar, removeEventListener() {} }
g.localStorage = (g.window as { localStorage: unknown }).localStorage
g.document = { hidden: false, addEventListener: escuchar }

type Fila = Record<string, unknown>
type Mensaje = { id: string; rol: 'usuario' | 'asistente'; texto: string; creadoEn: number; turno?: { requestId: string; intento: number }; turnoServidor?: { requestId: string; estado: string }; requestId?: string }
const DOCENTE = '11111111-1111-4111-8111-111111111111'
const esperar = (ms = 50) => new Promise((r) => setTimeout(r, ms))
async function hasta(condicion: () => boolean, ms = 4000) {
  const fin = Date.now() + ms
  while (!condicion() && Date.now() < fin) await esperar(20)
  return condicion()
}

async function main() {
  const { supabase } = await import('../lib/supabaseClient')
  const p = await import('../lib/asistente/persistencia')
  const tfc = await import('../lib/asistente/textoFinalChat')

  // ---------------- Supabase en memoria (RLS por docente) ----------------
  const tablas: Record<string, Fila[]> = { conversaciones_chat: [], mensajes_chat: [], perfiles_docentes: [{ id: DOCENTE, docente_id: DOCENTE }] }
  const escrituras: { tabla: string; op: string; ids: string[]; t: number }[] = []
  class Consulta {
    private filtros: ((f: Fila) => boolean)[] = [(f) => f.docente_id === DOCENTE]
    private op = 'select'
    private datos: unknown = null
    private unica = false
    private orden: { c: string; asc: boolean } | null = null
    private tope = Infinity
    private opciones: { ignoreDuplicates?: boolean } = {}
    constructor(private tabla: string) {}
    select() { return this }
    maybeSingle() { this.unica = true; return this }
    single() { this.unica = true; return this }
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
    then(ok: (r: unknown) => unknown, ko?: (e: unknown) => unknown) { return Promise.resolve().then(() => this.ejecutar()).then(ok, ko) }
    private ejecutar() {
      const filas = (tablas[this.tabla] ??= [])
      const coinciden = () => filas.filter((f) => this.filtros.every((x) => x(f)))
      if (this.op === 'select') {
        let datos = coinciden().map((f) => JSON.parse(JSON.stringify(f))) as Fila[]
        if (this.orden) { const { c, asc } = this.orden; datos.sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : 1) * (asc ? 1 : -1)) }
        datos = datos.slice(0, this.tope)
        return { data: this.unica ? (datos[0] ?? null) : datos, error: null }
      }
      if (this.op === 'update') {
        const afectadas = coinciden()
        for (const f of afectadas) Object.assign(f, this.datos as Fila)
        escrituras.push({ tabla: this.tabla, op: 'update', ids: afectadas.map((f) => String(f.id)), t: Date.now() })
        return { data: afectadas.map((f) => ({ id: f.id })), error: null }
      }
      if (this.op === 'insert') {
        const d = this.datos as Fila
        if (filas.some((f) => f.id === d.id)) return { data: null, error: { code: '23505', message: 'duplicado' } }
        filas.push({ titulo: 'Nueva conversación', documento_activo: null, actualizado_en: new Date().toISOString(), eliminada_en: null, ...d })
        escrituras.push({ tabla: this.tabla, op: 'insert', ids: [String(d.id)], t: Date.now() })
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
      escrituras.push({ tabla: this.tabla, op: 'upsert', ids, t: Date.now() })
      return { data: ids.map((id) => ({ id })), error: null }
    }
  }
  const s = supabase as unknown as Record<string, unknown>
  const auth = s.auth as Record<string, unknown>
  auth.getSession = async () => ({ data: { session: { user: { id: DOCENTE }, access_token: 'token' } }, error: null })
  auth.getUser = async () => ({ data: { user: { id: DOCENTE } }, error: null })
  s.rpc = async () => ({ data: null, error: null })
  s.from = (tabla: string) => new Consulta(tabla)
  p.establecerPropietarioLocal(DOCENTE)

  // ---------------- Servidor simulado ----------------
  type Modo = 'normal' | 'corte' | 'sin_marcador' | 'colgado' | 'fallido' | 'ocupada' | 'sin_llegar'
  type TurnoSim = { estado: 'generating' | 'completed' | 'failed'; crudo: string; mensajeId: string | null; cuerpo: Record<string, unknown> }
  const turnos = new Map<string, TurnoSim>()
  const servidor = { modo: 'normal' as Modo, completaEnMs: 0, generaciones: 0, llamadasChat: [] as Record<string, unknown>[], consultas: [] as { requestId: string; t: number }[], usuarioGuardadoAntes: [] as boolean[] }
  let secuencia = 0
  const encoder = new TextEncoder()
  const RESPUESTA = (n: number) => `Respuesta número ${n} del asistente.`
  function materializar(t: TurnoSim): void {
    const conv = String(t.cuerpo.conversacionId)
    const id = `${conv}:turno-sim-${++secuencia}`
    tablas.mensajes_chat.push({ id, conversacion_id: conv, docente_id: DOCENTE, rol: 'asistente', texto: t.crudo, contenido: { turnoId: `sim-${secuencia}`, requestId: t.cuerpo.requestId, mensajeUsuarioId: t.cuerpo.mensajeUsuarioId }, creado_en: new Date().toISOString() })
    t.mensajeId = id
    t.estado = 'completed'
  }
  function completarLuego(t: TurnoSim, ms: number) {
    if (ms <= 0) materializar(t)
    else setTimeout(() => { if (t.estado === 'generating') materializar(t) }, ms)
  }
  // Igual que un fetch real: abortar la petición corta la lectura del cuerpo.
  let senalActual: AbortSignal | undefined
  function flujo(partes: string[], fin: 'cerrar' | 'error' | 'colgar'): ReadableStream<Uint8Array> {
    const senal = senalActual
    return new ReadableStream({
      async start(c) {
        senal?.addEventListener('abort', () => { try { c.error(new DOMException('The operation was aborted.', 'AbortError')) } catch { /* ya cerrado */ } })
        for (const parte of partes) { await esperar(5); c.enqueue(encoder.encode(parte)) }
        if (fin === 'cerrar') c.close()
        else if (fin === 'error') c.error(new TypeError('network connection was lost'))
      },
    })
  }
  const json = (d: unknown, status: number) => new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json' } })
  g.fetch = async (url: string, init: { body?: string; signal?: AbortSignal }) => {
    const cuerpo = JSON.parse(init.body ?? '{}') as Record<string, unknown>
    senalActual = init.signal
    if (url === '/api/chat/turno') {
      const requestId = String(cuerpo.requestId)
      servidor.consultas.push({ requestId, t: Date.now() })
      const t = turnos.get(requestId)
      if (!t) return json({ turno: null }, 404)
      return json({ turno: { estado: t.estado, mensaje_asistente_id: t.mensajeId, codigo_error: t.estado === 'failed' ? 'error_generacion' : null } }, 200)
    }
    if (url !== '/api/chat') throw new Error(`fetch inesperado: ${url}`)
    servidor.llamadasChat.push(cuerpo)
    const requestId = String(cuerpo.requestId)
    if (servidor.modo === 'sin_llegar') throw new TypeError('Failed to fetch')
    servidor.usuarioGuardadoAntes.push(tablas.mensajes_chat.some((f) => f.id === cuerpo.mensajeUsuarioId && (f.contenido as { turno?: { requestId: string } })?.turno?.requestId === requestId))
    const existente = turnos.get(requestId)
    if (existente) {
      // Mismo envío: nunca se vuelve a generar.
      if (existente.estado === 'completed') return new Response(flujo([existente.crudo, tfc.marcadorTurno({ estado: 'completado', requestId, mensajeAsistenteId: existente.mensajeId })], 'cerrar'), { status: 200 })
      return json({ estadoTurno: existente.estado === 'failed' ? 'fallido' : 'en_proceso' }, 409)
    }
    if (servidor.modo === 'ocupada') return json({ estadoTurno: 'ocupada' }, 409)
    servidor.generaciones++
    const t: TurnoSim = { estado: 'generating', crudo: RESPUESTA(servidor.generaciones), mensajeId: null, cuerpo }
    turnos.set(requestId, t)
    const [a, b] = [t.crudo.slice(0, 10), t.crudo.slice(10)]
    switch (servidor.modo) {
      case 'normal':
        materializar(t)
        return new Response(flujo([a, b, tfc.marcadorTurno({ estado: 'completado', requestId, mensajeAsistenteId: t.mensajeId })], 'cerrar'), { status: 200 })
      case 'corte':
        completarLuego(t, servidor.completaEnMs)
        return new Response(flujo([a], 'error'), { status: 200 })
      case 'sin_marcador':
        completarLuego(t, servidor.completaEnMs)
        return new Response(flujo([a, b], 'cerrar'), { status: 200 })
      case 'colgado':
        completarLuego(t, servidor.completaEnMs)
        return new Response(flujo([a], 'colgar'), { status: 200 })
      default:
        t.estado = 'failed'
        return new Response(flujo([a], 'error'), { status: 200 })
    }
  }

  // ---------------- Servicio real ----------------
  await p.guardarMensajesRemotos('conv-base-a', DOCENTE, [])
  const servicio = await import('../lib/asistente/AsistenteService')
  const motorMod = await import('../lib/asistente/motores/motorTextoClaude')
  const chat = servicio.AsistenteService as unknown as {
    conversacionActivaId: string | null; mensajes: Mensaje[]; avisoGeneracion: string | null; generando: boolean
    nuevaConversacion(): void; abrirConversacion(id: string): void; enviarMensaje(texto: string): Promise<string>; reintentarGeneracion(): Promise<void>; guardarInmediatamente(): void
    obtenerEstado(): { recuperandoRespuesta: boolean }
  }
  const interno = chat as unknown as Record<string, unknown>
  const estado = () => (interno.construirSnapshot as () => { recuperandoRespuesta: boolean }).call(chat)
  motorMod.LIMITES_TURNO.inactividadStreamMs = 300
  servicio.ESPERAS_RECUPERACION_MS.splice(0, servicio.ESPERAS_RECUPERACION_MS.length, 150, 200, 250)
  const asistentes = () => chat.mensajes.filter((m) => m.rol === 'asistente')
  const ultimoUsuario = () => [...chat.mensajes].reverse().find((m) => m.rol === 'usuario')!
  const filasAsistente = (conv: string) => tablas.mensajes_chat.filter((f) => f.conversacion_id === conv && f.rol === 'asistente')
  const nueva = async (modo: Modo, texto: string, completaEnMs = 0) => {
    chat.nuevaConversacion()
    servidor.modo = modo
    servidor.completaEnMs = completaEnMs
    const antes = { chat: servidor.llamadasChat.length, gen: servidor.generaciones, consultas: servidor.consultas.length }
    const resultado = await chat.enviarMensaje(texto)
    return { resultado, antes, conv: async () => p.idRemotoDe(DOCENTE, chat.conversacionActivaId!) }
  }

  // ============================================================
  // 1. Turno normal: identidad antes de enviar y adopción del id canónico
  // ============================================================
  {
    const x = await nueva('normal', 'Hola, ¿qué tal?')
    const conv = await x.conv()
    const usuario = ultimoUsuario()
    const cuerpo = servidor.llamadasChat[servidor.llamadasChat.length - 1]
    verificar(x.resultado === 'enviado' && usuario.turno?.requestId === usuario.id && usuario.turno.intento === 1, '1a. El mensaje del docente lleva su identidad de turno (requestId) desde antes de enviarse')
    verificar(servidor.usuarioGuardadoAntes[servidor.usuarioGuardadoAntes.length - 1] === true, '1b. El mensaje del docente, con su turno, ya estaba guardado en Supabase cuando llegó la petición')
    verificar(cuerpo.requestId === usuario.id && cuerpo.mensajeUsuarioId === `${conv}:${usuario.id}` && cuerpo.protocoloTurno === 1, '1c. La petición viaja con la identidad del turno y del mensaje (protocolo 1)')
    const respuesta = asistentes()[asistentes().length - 1]
    verificar(respuesta.id === `turno-sim-${secuencia}` && respuesta.turnoServidor?.estado === 'guardado' && respuesta.texto === RESPUESTA(servidor.generaciones) && !respuesta.texto.includes('[[TURNO'),
      '1d. La respuesta adopta el id canónico del mensaje que creó el servidor (sin el marcador)')
    chat.guardarInmediatamente()
    await esperar(2400)
    const escriturasAsistente = escrituras.filter((e) => e.tabla === 'mensajes_chat' && e.ids.some((id) => id.startsWith(`${conv}:turno-`)))
    verificar(filasAsistente(conv).length === 1 && escriturasAsistente.length === 0, '1e. Sin escrituras duplicadas: el cliente no crea ni reescribe la fila del asistente (la escribió el servidor)')
  }

  // ============================================================
  // 2. Corte de red a mitad del stream: recuperación, no regeneración
  // ============================================================
  {
    const x = await nueva('corte', 'Prepárame una actividad', 200)
    const conv = await x.conv()
    const recuperado = await hasta(() => asistentes().some((m) => m.id.startsWith('turno-sim-') && m.requestId === ultimoUsuario().turno?.requestId) && !estado().recuperandoRespuesta)
    const delTurno = asistentes().filter((m) => m.requestId === ultimoUsuario().turno?.requestId || m.turnoServidor?.requestId === ultimoUsuario().turno?.requestId)
    verificar(recuperado && delTurno.length === 1 && delTurno[0].texto === RESPUESTA(servidor.generaciones), '2a. La conexión se cortó: se consulta el turno y aparece la respuesta completa guardada por el servidor (una sola)')
    verificar(servidor.generaciones === x.antes.gen + 1 && servidor.llamadasChat.length === x.antes.chat + 1 && servidor.consultas.length > x.antes.consultas, '2b. Sin regenerar: una sola generación y una sola petición al chat; solo consultas')
    verificar(!chat.avisoGeneracion && filasAsistente(conv).length === 1, '2c. Sin error para el docente y una sola fila de la respuesta')
  }

  // ============================================================
  // 3. Final recibido ANTES de la confirmación de guardado
  // ============================================================
  {
    const x = await nueva('sin_marcador', 'Dame una idea para la clase', 500)
    const respuestaInicial = asistentes()[asistentes().length - 1]
    verificar(respuestaInicial?.turnoServidor?.estado === 'pendiente' && !respuestaInicial.id.startsWith('turno-'), '3a. Un final sin la confirmación del servidor no se da por guardado: la respuesta queda pendiente')
    const consultasAntes = servidor.consultas.length
    await hasta(() => !estado().recuperandoRespuesta, 5000)
    const delTurno = asistentes().filter((m) => m.turnoServidor?.requestId === ultimoUsuario().turno?.requestId || m.requestId === ultimoUsuario().turno?.requestId)
    verificar(delTurno.length === 1 && delTurno[0].id.startsWith('turno-sim-'), '3b. Al guardarse en el servidor, la respuesta pendiente se reemplaza por la canónica (sin duplicado)')
    const propias = servidor.consultas.slice(x.antes.consultas)
    const espacios = propias.slice(1).map((c, i) => c.t - propias[i].t)
    verificar(propias.length >= 2 && espacios.every((e) => e >= 140) && servidor.consultas.length > consultasAntes - 1, '3c. Las consultas de recuperación son espaciadas')
    const total = servidor.consultas.length
    await esperar(700)
    verificar(servidor.consultas.length === total && servidor.generaciones === x.antes.gen + 1, '3d. Las consultas se detienen al terminar el turno; ninguna generación extra')
  }

  // ============================================================
  // 4. Límite de inactividad del stream
  // ============================================================
  {
    const x = await nueva('colgado', 'Explícame fracciones', 600)
    const ok = await hasta(() => asistentes().some((m) => m.id.startsWith('turno-sim-') && m.requestId === ultimoUsuario().turno?.requestId) && !estado().recuperandoRespuesta, 5000)
    verificar(ok && servidor.generaciones === x.antes.gen + 1 && servidor.llamadasChat.length === x.antes.chat + 1 && !chat.avisoGeneracion,
      '4a. Stream sin datos: al vencer la inactividad se recupera la respuesta del servidor; nunca una generación nueva')
  }

  // ============================================================
  // 5. Doble envío
  // ============================================================
  {
    chat.nuevaConversacion()
    servidor.modo = 'normal'
    const antes = servidor.llamadasChat.length
    const [r1, r2] = await Promise.all([chat.enviarMensaje('Hola dos veces'), chat.enviarMensaje('Hola dos veces')])
    verificar([r1, r2].sort().join(',') === 'enviado,no_enviado' && servidor.llamadasChat.length === antes + 1 && chat.mensajes.filter((m) => m.rol === 'usuario').length === 1, '5a. Doble toque: un solo mensaje y una sola petición')
    // El mismo envío repetido (p. ej. un reintento de red del mismo requestId).
    const usuario = ultimoUsuario()
    const gen = servidor.generaciones
    const motor = interno.motorTexto as { enviarTexto: (...a: unknown[]) => Promise<void> }
    interno.marcarSolicitud = interno.marcarSolicitud ?? (() => {})
    await motor.enviarTexto(usuario.texto, undefined, undefined, undefined, undefined, 'texto', undefined, undefined, undefined, { requestId: usuario.turno!.requestId, mensajeUsuarioLocalId: usuario.id })
    await esperar(100)
    verificar(servidor.generaciones === gen && asistentes().length === 1 && asistentes()[0].id.startsWith('turno-sim-'), '5b. El mismo requestId reenviado: el servidor devuelve la respuesta guardada (sin generar) y no se duplica en pantalla')
  }

  // ============================================================
  // 6. Turno fallido: reintento explícito y controlado
  // ============================================================
  {
    const x = await nueva('fallido', 'Hazme un resumen')
    const usuario = ultimoUsuario()
    const aviso = await hasta(() => chat.avisoGeneracion === servicio.MENSAJE_TURNO_FALLIDO)
    const llamadas = servidor.llamadasChat.length
    await esperar(400)
    verificar(aviso && servidor.llamadasChat.length === llamadas && servidor.generaciones === x.antes.gen + 1, '6a. Turno fallido: se ofrece reintentar y nunca se reintenta solo')
    servidor.modo = 'normal'
    await chat.reintentarGeneracion()
    await hasta(() => asistentes().some((m) => m.id.startsWith('turno-sim-') && m.requestId === `${usuario.id}:r2`))
    const cuerpo = servidor.llamadasChat[servidor.llamadasChat.length - 1]
    const delMensaje = chat.mensajes.filter((m) => m.rol === 'usuario')
    verificar(cuerpo.requestId === `${usuario.id}:r2` && cuerpo.reintentoDe === usuario.id && cuerpo.mensajeUsuarioId === `${await x.conv()}:${usuario.id}` && ultimoUsuario().turno?.intento === 2,
      '6b. El reintento explícito es un intento nuevo del MISMO mensaje, ligado al turno fallido')
    verificar(delMensaje.length === 1 && asistentes().filter((m) => m.turnoServidor?.requestId === usuario.id).length === 0 && asistentes().length === 1, '6c. Sin mensaje nuevo del docente; la respuesta parcial del intento fallido se retira')
  }

  // ============================================================
  // 7. Conversación ocupada y mensaje que nunca llegó
  // ============================================================
  {
    const x = await nueva('ocupada', 'Otra pregunta')
    verificar(chat.avisoGeneracion === servicio.MENSAJE_TURNO_OCUPADO && servidor.generaciones === x.antes.gen && asistentes().length === 0, '7a. Conversación con otro turno activo: aviso y nada se ejecuta')
    const y = await nueva('sin_llegar', 'Mensaje sin red')
    const aviso = await hasta(() => chat.avisoGeneracion === servicio.MENSAJE_TURNO_NO_ENVIADO)
    verificar(aviso && servidor.generaciones === y.antes.gen, '7b. La petición no llegó (el turno no existe): se ofrece enviarlo')
    servidor.modo = 'normal'
    const usuario = ultimoUsuario()
    await chat.reintentarGeneracion()
    await hasta(() => asistentes().some((m) => m.id.startsWith('turno-sim-')))
    const cuerpo = servidor.llamadasChat[servidor.llamadasChat.length - 1]
    verificar(cuerpo.requestId === `${usuario.id}:r2` && cuerpo.reintentoDe === undefined && servidor.generaciones === y.antes.gen + 1, '7c. Enviarlo es un intento nuevo sin reintento_de (no había turno que repetir)')
  }

  // ============================================================
  // 8. Recarga (estado en memoria perdido, copia local conservada)
  // ============================================================
  {
    servicio.ESPERAS_RECUPERACION_MS.splice(0, servicio.ESPERAS_RECUPERACION_MS.length, 5000)
    const x = await nueva('colgado', 'Pregunta antes de recargar', 900)
    const local = chat.conversacionActivaId!
    await hasta(() => servidor.consultas.length > x.antes.consultas)
    // "Recarga": se pierde todo lo que estaba en memoria.
    chat.guardarInmediatamente()
    for (const r of (interno.recuperaciones as Map<string, { timer: ReturnType<typeof setTimeout> | null }>).values()) if (r.timer) clearTimeout(r.timer)
    ;(interno.recuperaciones as Map<string, unknown>).clear()
    chat.nuevaConversacion()
    servicio.ESPERAS_RECUPERACION_MS.splice(0, servicio.ESPERAS_RECUPERACION_MS.length, 150, 200, 250)
    chat.abrirConversacion(local)
    const ok = await hasta(() => asistentes().filter((m) => m.id.startsWith('turno-sim-')).length === 1 && !estado().recuperandoRespuesta, 5000)
    verificar(ok && servidor.generaciones === x.antes.gen + 1 && servidor.llamadasChat.length === x.antes.chat + 1 && asistentes().length === 1,
      '8a. Al recargar y abrir la conversación, el turno pendiente se recupera del servidor (sin generar otra vez, una sola respuesta)')
  }

  // ============================================================
  // 9. Otro dispositivo sin estado local
  // ============================================================
  {
    const x = await nueva('colgado', 'Pregunta desde el iPhone', 1500)
    const remoto = await x.conv()
    await hasta(() => servidor.consultas.length > x.antes.consultas)
    chat.nuevaConversacion()
    // Dispositivo B: sin nada local; solo lo guardado en Supabase.
    almacen = DISPOSITIVO_B
    p.establecerPropietarioLocal(DOCENTE)
    await p.guardarMensajesRemotos('conv-base-b', DOCENTE, [])
    await p.descargarConversacionRemota(DOCENTE, remoto)
    const enB = p.cargarConversacionPorId(remoto)!
    const usuarioEnB = enB.mensajes.find((m) => m.rol === 'usuario') as Mensaje | undefined
    verificar(!!usuarioEnB?.turno?.requestId && !enB.mensajes.some((m) => m.rol === 'asistente'), '9a. En el otro dispositivo llega el mensaje con su turno; la respuesta pendiente del primero nunca se escribió')
    chat.abrirConversacion(remoto)
    const ok = await hasta(() => asistentes().filter((m) => m.id.startsWith('turno-sim-')).length === 1 && !estado().recuperandoRespuesta, 6000)
    verificar(ok && servidor.generaciones === x.antes.gen + 1 && filasAsistente(remoto).length === 1, '9b. Sin estado local: se consulta el turno, aparece la respuesta del servidor y no se genera otra vez')
    const consultas = servidor.consultas.length
    chat.nuevaConversacion()
    chat.abrirConversacion(remoto)
    await esperar(400)
    verificar(servidor.consultas.length === consultas && servidor.generaciones === x.antes.gen + 1, '9c. Con la respuesta ya presente, volver a abrir la conversación no consulta ni genera nada')
    almacen = DISPOSITIVO_A
  }

  // ============================================================
  // 10. Piezas puras
  // ============================================================
  {
    const marca = tfc.marcadorTurno({ estado: 'completado', requestId: 'msg-1', turnoId: 't', mensajeAsistenteId: 'c:turno-t' })
    const { texto, turno } = tfc.extraerMarcadorTurno(`Hola${marca}`)
    verificar(texto === 'Hola' && turno?.mensajeAsistenteId === 'c:turno-t' && tfc.sinTextoFinalParcial('Hola [[TUR') === 'Hola ' && tfc.sinTextoFinalParcial(`Hola${marca}`) === 'Hola', '10a. Marcador de turno: se extrae y nunca se ve, ni a medias')
    const u = { id: 'u1', rol: 'usuario' as const, texto: 'x', creadoEn: 1, turno: { requestId: 'u1', intento: 1 } }
    const pend = { id: 'a1', rol: 'asistente' as const, texto: 'y', creadoEn: 2, turnoServidor: { requestId: 'u1', estado: 'pendiente' as const } }
    const canon = { id: 'turno-9', rol: 'asistente' as const, texto: 'y', creadoEn: 3, requestId: 'u1' }
    verificar(p.turnosPorRecuperar([u]).join() === 'u1' && p.turnosPorRecuperar([u, pend]).join() === 'u1' && p.turnosPorRecuperar([u, pend, canon]).length === 0 && p.sinRespuestasPendientesResueltas([u, pend, canon]).map((m) => m.id).join() === 'u1,turno-9',
      '10b. Qué turnos consultar y la sustitución de la respuesta pendiente por la canónica')
  }

  console.log('')
  if (fallos > 0) { console.error(`${fallos} prueba(s) fallaron.`); process.exit(1) }
  console.log('Todas las pruebas pasaron.')
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
