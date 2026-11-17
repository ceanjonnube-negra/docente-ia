// scripts/verificar-cierre-sesion.ts
//
// Etapa 3 del aislamiento por docente: cerrar sesión guarda lo pendiente en
// memoria en la copia local y en la cola del docente actual, lo intenta
// enviar con el mecanismo de siempre durante un tiempo limitado y solo
// entonces llama a signOut. Si signOut falla, la sesión y el chat siguen
// igual y se avisa; si tiene éxito, la puerta queda cerrada y la memoria
// vacía. Nada local se borra; lo no enviado se envía en la próxima sesión
// del mismo docente y nunca con otra cuenta.
//
// Se ejecuta con `npx tsx scripts/verificar-cierre-sesion.ts`.

// Módulo (no script global): sus nombres no chocan con otros scripts.
export {}

const PATRON_DOCUMENTO = /^\s*(📋|📊|📝|📨|📄|📖)\s*[A-ZÀ-Ý]/
function esEventoDocumental(f: Record<string, unknown>): boolean {
  const k = (f.contenido ?? {}) as Record<string, unknown>
  if (f.rol === 'usuario') return k.documentoDestinoId != null
  return PATRON_DOCUMENTO.test(String(f.texto)) || (k.contenidoDocumento != null && (k.archivo != null || k.archivos != null)) || k.restauraVersion != null
}

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
  let sesion: string | null = DOCENTE_A
  const tablas: Record<string, Fila[]> = { conversaciones_chat: [], mensajes_chat: [] }
  const escrituras: { tabla: string; op: string; ids?: string[] }[] = []
  const lecturas: { tabla: string; columnas: string; ids?: string[] }[] = []
  const fallarPorId = false
  const fallarIndice = false
  const alLeer: ((tabla: string, columnas: string) => void) | null = null
  const retrasoLecturas = 0
  let retrasoEscrituras = 0
  let fallarEscrituras = false
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
    // Índice documental (P3b): misma semántica que el filtro de PostgREST
    // (verificada contra Supabase E2E con GET reales).
    or(expr: string) { if (!expr.includes('texto.match')) throw new Error('filtro desconocido'); this.filtros.push(esEventoDocumental); return this }
    gt(c: string, v: string) { this.filtros.push((f) => String(f[c]) > v); return this }
    is(c: string, v: null) { this.filtros.push((f) => f[c] === v || f[c] === undefined); return this }
    not(c: string) { this.filtros.push((f) => f[c] != null); return this }
    lt(c: string, v: string) { this.filtros.push((f) => Date.parse(String(f[c])) < Date.parse(v)); return this }
    update(c: Fila) { this.op = 'update'; this.datos = c; return this }
    insert(d: Fila) { this.op = 'insert'; this.datos = d; return this }
    upsert(d: Fila[], o: { ignoreDuplicates?: boolean }) { this.op = 'upsert'; this.datos = d; this.opciones = o ?? {}; return this }
    then(ok: (r: unknown) => unknown, ko?: (e: unknown) => unknown) {
      const retraso = this.op === 'select' ? retrasoLecturas : retrasoEscrituras
      return new Promise((r) => setTimeout(r, retraso)).then(() => this.ejecutar()).then(ok, ko)
    }
    private ejecutar() {
      const filas = tablas[this.tabla]
      const coinciden = () => filas.filter((f) => this.filtros.every((x) => x(f)))
      if (this.op === 'select') {
        lecturas.push({ tabla: this.tabla, columnas: this.columnas, ids: this.idsPedidos })
        if (fallarPorId && this.porId && this.tabla === 'mensajes_chat') return { data: null, error: { message: 'fallo simulado de red' } }
        if (fallarLecturas) return { data: null, error: { message: 'fallo simulado de red' } }
        if (fallarIndice && this.columnas.includes('raiz:')) return { data: null, error: { message: 'fallo simulado del índice' } }
        let datos = coinciden().map((f) => JSON.parse(JSON.stringify(f))) as Fila[]
        if (this.orden) { const { c, asc } = this.orden; datos.sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : 1) * (asc ? 1 : -1)) }
        datos = datos.slice(0, this.tope)
        if (this.columnas.includes('raiz:')) {
          const k = (f: Fila) => (f.contenido ?? {}) as Record<string, unknown>
          datos = datos.map((f) => ({ id: f.id, rol: f.rol, creado_en: f.creado_en, raiz: k(f).documentoRaizId ?? null, restaura: k(f).restauraVersion ?? null, destino: k(f).documentoDestinoId ?? null }))
        }
        alLeer?.(this.tabla, this.columnas)
        return { data: this.unica ? (datos[0] ?? null) : datos, error: null }
      }
      if (fallarEscrituras) return { data: null, error: { message: 'fallo simulado de red' } }
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
  ;(s.auth as Record<string, unknown>).getSession = async () => ({ data: { session: sesion ? { user: { id: sesion } } : null }, error: null })
  // Eventos de sesión controlados por la prueba (el listener del servicio se captura al importarlo).
  let oyenteAuth: ((evento: string, session: unknown) => void) | null = null
  ;(s.auth as Record<string, unknown>).onAuthStateChange = (cb: (evento: string, session: unknown) => void) => { oyenteAuth = cb; return { data: { subscription: { unsubscribe() {} } } } }
  const evento = (nombre: string, docente: string | null) => { sesion = docente; oyenteAuth?.(nombre, docente ? { user: { id: docente } } : null) }
  // signOut simulado: con error de red no cambia nada; si tiene éxito, emite SIGNED_OUT.
  let fallarSignOut = false
  let llamadasSignOut = 0
  ;(s.auth as Record<string, unknown>).signOut = async () => { llamadasSignOut++; await esperar(30); if (fallarSignOut) return { error: { message: 'Failed to fetch' } }; evento('SIGNED_OUT', null); return { error: null } }
  s.rpc = async () => ({ data: null, error: null })
  s.from = (tabla: string) => new Consulta(tabla)

  const DOCENTE_B = '22222222-2222-4222-8222-222222222222'
  const crudo = (k: string) => almacen.get(k) ?? null
  almacen = DISPOSITIVO_A
  const { AsistenteService } = await import('../lib/asistente/AsistenteService')
  const chat = AsistenteService as unknown as {
    conversacionActivaId: string | null; mensajes: Mensaje[]; listaConversaciones: { id: string }[]; sincronizadaEn: Map<string, number>
    nuevaConversacion(): void; abrirConversacion(id: string): void; enviarMensaje(texto: string): Promise<string>; manejarEventoMotor(e: unknown): void
    cerrarSesion(): Promise<{ ok: true } | { ok: false; mensaje: string }>
    panelAbierto: boolean; abrirPanel(): void
  }
  const interno = chat as unknown as Record<string, unknown>
  let retener = false
  let pendienteIA: (() => void) | null = null
  const motor = {
    establecerHistorial: () => {},
    establecerConversacion: () => {},
    enviarTexto: async () => {
      const responder = () => { chat.manejarEventoMotor({ tipo: 'respuesta-parcial', texto: 'Respuesta' }); chat.manejarEventoMotor({ tipo: 'respuesta-final', texto: 'Respuesta' }) }
      if (retener) pendienteIA = responder
      else responder()
    },
  }
  interno.motorTexto = motor
  interno.motor = motor
  interno.asegurarMotor = async () => {}
  interno.asegurarMotorTexto = async () => motor
  const pedir = async (texto: string) => {
    chat.sincronizadaEn.set(chat.conversacionActivaId ?? '', Date.now())
    return chat.enviarMensaje(texto)
  }
  const enSupabase = (localId: string, remoto: string) => tablas.mensajes_chat.some((f) => f.id === `${remoto}:${localId}` && f.docente_id === DOCENTE_A)
  const cola = (d: string) => (JSON.parse(crudo(`docente-ia:mensajes-remotos:${d}`) ?? '{"pendientes":[]}') as { pendientes: { fila: { id: string; docente_id: string } }[] }).pendientes

  // ---- 1. Salida justo después de crear un mensaje (debounces pendientes) ----
  evento('SIGNED_IN', DOCENTE_A)
  chat.nuevaConversacion()
  const convA = chat.conversacionActivaId!
  await pedir('Primer mensaje')
  const ultimo = chat.mensajes[chat.mensajes.length - 1].id
  const remotoA = await p.idRemotoDe(DOCENTE_A, convA)
  const r1 = await chat.cerrarSesion()
  verificar(r1.ok && llamadasSignOut === 1 && JSON.parse(crudo(`docente-ia:conversacion:${convA}`) ?? '{"mensajes":[]}').mensajes.some((m: { id: string }) => m.id === ultimo) && enSupabase(ultimo, remotoA) && cola(DOCENTE_A).length === 0,
    '1a. Salida inmediata tras escribir: lo último queda en la copia local de A y llega a Supabase antes de cerrar la sesión')
  verificar(p.propietarioLocal() === null && chat.mensajes.length === 0 && chat.conversacionActivaId === null && chat.listaConversaciones.length === 0 && p.listarConversaciones().length === 0, '1b. Tras signOut: puerta cerrada y memoria vacía')
  verificar(crudo(`docente-ia:conversacion:${convA}`) !== null && crudo(`docente-ia:mensajes-remotos:${DOCENTE_A}`) !== null, '1c. Copia local, cola y huellas de A se conservan')

  // ---- 2. Error de red en signOut ----
  evento('SIGNED_IN', DOCENTE_A)
  chat.abrirConversacion(convA)
  await esperar(200)
  await pedir('Mensaje antes de un fallo')
  const antesFallo = chat.mensajes.length
  fallarSignOut = true
  const r2 = await chat.cerrarSesion()
  fallarSignOut = false
  verificar(!r2.ok && /No se pudo cerrar la sesión/.test(r2.ok ? '' : r2.mensaje) && p.propietarioLocal() === DOCENTE_A && chat.conversacionActivaId === convA && chat.mensajes.length === antesFallo && p.listarConversaciones().some((c) => c.id === convA),
    '2a. signOut falla: aviso breve; la sesión, la conversación abierta y la lista siguen igual (sin salida falsa)')

  // ---- 3. Doble pulsación ----
  const llamadasAntes = llamadasSignOut
  const [d1, d2] = await Promise.all([chat.cerrarSesion(), chat.cerrarSesion()])
  verificar(d1.ok && d2.ok && llamadasSignOut === llamadasAntes + 1, '3a. Doble pulsación: un solo signOut y el mismo resultado')

  // ---- 4. Envío que excede el tiempo límite ----
  evento('SIGNED_IN', DOCENTE_A)
  chat.abrirConversacion(convA)
  await esperar(200)
  await pedir('Pendiente sin red')
  const sinRed = chat.mensajes[chat.mensajes.length - 1].id
  retrasoEscrituras = 8000
  fallarEscrituras = true
  const t0 = Date.now()
  const r4 = await chat.cerrarSesion()
  const duracion = Date.now() - t0
  verificar(r4.ok && duracion < 6000 && JSON.parse(crudo(`docente-ia:conversacion:${convA}`) ?? '{"mensajes":[]}').mensajes.some((m: { id: string }) => m.id === sinRed) && cola(DOCENTE_A).some((x) => x.fila.id === `${remotoA}:${sinRed}`),
    `4a. El envío excede el tiempo límite: la salida no se bloquea (${duracion} ms) y lo pendiente queda en la copia y en la cola de A`)
  await esperar(8500)
  retrasoEscrituras = 0
  verificar(!enSupabase(sinRed, remotoA) && cola(DOCENTE_A).some((x) => x.fila.id === `${remotoA}:${sinRed}`), '4b. El envío que no terminó falla después: lo pendiente sigue solo en la cola de A')
  fallarEscrituras = false

  // ---- 5. Otra cuenta: sin acceso cruzado y sin enviar lo de A ----
  evento('SIGNED_IN', DOCENTE_B)
  await esperar(300)
  verificar(p.listarConversaciones().length === 0 && p.cargarConversacionPorId(convA) === null && !tablas.mensajes_chat.some((f) => String(f.id).startsWith(`${remotoA}:`) && f.docente_id === DOCENTE_B) && cola(DOCENTE_B).every((x) => !x.fila.id.startsWith(`${remotoA}:`)),
    '5a. B no ve ni carga lo de A, y la cola de A nunca se envía con la cuenta de B')
  await chat.cerrarSesion()

  // ---- 6. El mismo docente vuelve: se envía lo pendiente ----
  evento('SIGNED_IN', DOCENTE_A)
  await esperar(500)
  chat.abrirConversacion(convA)
  await esperar(300)
  verificar(enSupabase(sinRed, remotoA) && cola(DOCENTE_A).every((x) => x.fila.id !== `${remotoA}:${sinRed}`) && chat.mensajes.some((m) => m.id === sinRed), '6a. Al volver A: lo pendiente se envía con su cuenta y la conversación muestra todo')

  // ---- 7. Respuesta de la IA que llega después de salir ----
  retener = true
  const envio = pedir('Pregunta con respuesta lenta')
  await esperar(50)
  const r7 = await chat.cerrarSesion()
  ;(pendienteIA as (() => void) | null)?.()
  retener = false
  await envio
  await esperar(100)
  const copia7 = JSON.parse(crudo(`docente-ia:conversacion:${convA}`) ?? '{"mensajes":[]}') as { mensajes: Mensaje[] }
  verificar(r7.ok && chat.mensajes.length === 0 && copia7.mensajes.some((m) => m.texto === 'Pregunta con respuesta lenta') && !copia7.mensajes.some((m, i) => m.texto === 'Respuesta' && copia7.mensajes[i - 1]?.texto === 'Pregunta con respuesta lenta'),
    '7a. La pregunta se guarda antes de salir; la respuesta que llega después no se muestra ni se escribe sin sesión')

  // ---- 8. Página: solo navega si el cierre se confirmó ----
  const { readFileSync } = await import('node:fs')
  const pagina = readFileSync('app/dashboard/inicio/page.tsx', 'utf8')
  verificar(/const resultado = await AsistenteService\.cerrarSesion\(\)\s*\n\s*if \(resultado\.ok\) \{\s*\n\s*router\.push\('\/bienvenida'\)/.test(pagina) && /setAvisoSalida\(resultado\.mensaje\)/.test(pagina) && !/supabase\.auth\.signOut\(\)/.test(pagina) && /disabled=\{saliendo\}/.test(pagina),
    '8a. salir(): usa el cierre seguro, solo va a la bienvenida si se confirmó, muestra el aviso si falla y evita la doble pulsación')
  const panel = readFileSync('components/Asistente/AsistentePanel.tsx', 'utf8')
  const menu = panel.slice(panel.indexOf('{menuConfigAbierto && ('), panel.indexOf('Docente <span'))
  verificar(/const resultado = await AsistenteService\.cerrarSesion\(\)\s*\n\s*if \(resultado\.ok\) \{[^}]*router\.push\('\/bienvenida'\)/.test(panel) && /setAvisoSalida\(resultado\.mensaje\)/.test(panel) && !/supabase\.auth\.signOut\(\)/.test(panel)
    && /📤 Subir documentos/.test(menu) && /onClick=\{cerrarSesion\} disabled=\{saliendo\}/.test(menu) && /Cerrar sesión/.test(menu) && /role="alert"/.test(menu) && !/dashboard\/configuracion|Configuración/.test(menu)
    && menu.indexOf('Subir documentos') < menu.indexOf('Cerrar sesión') && /<a href="\/"[^>]*>[\s\S]{0,200}Inicio/.test(panel),
    '8b. Menú de la manzana: «Subir documentos» y luego «Cerrar sesión» con el mismo flujo seguro (deshabilitado mientras sale, aviso si falla); sin el enlace 404 a Configuración; «Inicio» sigue en el Chat IA')

  // ---- 9. El panel no queda encima de la bienvenida ----
  evento('SIGNED_IN', DOCENTE_A)
  await esperar(300)
  chat.abrirPanel()
  chat.abrirConversacion(convA)
  await esperar(200)
  const r9 = await chat.cerrarSesion()
  verificar(r9.ok && chat.panelAbierto === false && chat.listaConversaciones.length === 0 && chat.mensajes.length === 0, '9a. Cierre exitoso con el panel abierto: el panel se cierra (sin capa encima de /bienvenida) y no queda ninguna conversación visible')
  verificar(/if \(!asistente\.panelAbierto\) \{\s*\n\s*return \(\s*\n\s*<button/.test(pagina.length ? panel : '') && /setMenuConfigAbierto\(false\)\s*\n\s*setMenuAbierto\(false\)\s*\n\s*setSaliendo\(false\)\s*\n\s*router\.push\('\/bienvenida'\)/.test(panel),
    '9b. Con el panel cerrado solo queda la burbuja; antes de ir a /bienvenida se cierran ambos menús y se restablece «Cerrando sesión…»')
  evento('SIGNED_IN', DOCENTE_A)
  await esperar(300)
  chat.abrirPanel()
  chat.abrirConversacion(convA)
  await esperar(200)
  evento('SIGNED_OUT', null)
  verificar(chat.panelAbierto === false && chat.mensajes.length === 0 && chat.listaConversaciones.length === 0 && p.propietarioLocal() === null, '9c. Sesión cerrada en otro dispositivo (SIGNED_OUT): el panel se cierra y no quedan conversaciones visibles')
  evento('SIGNED_IN', DOCENTE_A)
  await esperar(300)
  chat.abrirPanel()
  chat.abrirConversacion(convA)
  await esperar(200)
  fallarSignOut = true
  const r9d = await chat.cerrarSesion()
  fallarSignOut = false
  verificar(!r9d.ok && chat.panelAbierto === true && chat.conversacionActivaId === convA && chat.mensajes.length > 0 && p.propietarioLocal() === DOCENTE_A, '9d. signOut falla: el panel y la conversación siguen abiertos, la sesión intacta y se devuelve el aviso')
  await chat.cerrarSesion()
  evento('SIGNED_IN', DOCENTE_A)
  await esperar(400)
  chat.abrirPanel()
  verificar(chat.panelAbierto === true && p.listarConversaciones().some((c) => c.id === convA) && chat.listaConversaciones.some((c) => c.id === convA), '9e. Reingreso posterior: el panel se abre normalmente y la lista vuelve a mostrar la conversación de A')

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
