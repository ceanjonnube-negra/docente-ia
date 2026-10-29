// scripts/verificar-conversacion-remota-e2e.ts
//
// LISTA-P5, etapa 1 — validación E2E de la identidad remota de la
// conversación del Chat IA contra el proyecto Supabase E2E, SOLO con datos
// ficticios. Ejercita el código REAL:
//   - asegurarConversacionRemota (lib/asistente/persistencia.ts) con la
//     sesión del docente en el cliente de la app (lib/supabaseClient);
//   - el POST real de app/api/chat/route.ts con una solicitud de lista
//     oficial SIN foto (responde pidiendo fotos: no llama a la IA) y su
//     log "[LISTA_OFICIAL] conversacion_autorizada=… grupo_fijado=…".
//
// Modos (mismo esquema que verificar-aplicacion-propuesta-lista-e2e.ts):
//   npx tsx scripts/verificar-conversacion-remota-e2e.ts
//     → en seco: sin red; historial local con un localStorage en memoria
//       y prueba del SQL de limpieza.
//   E2E_P5_ESCRIBIR=1 npx tsx scripts/verificar-conversacion-remota-e2e.ts --ejecutar
//     → escribe en E2E (requiere las variables E2E_*).
//   npx tsx scripts/verificar-conversacion-remota-e2e.ts --reanudar-bloque4 <manifiesto.json>
//     → solo lectura: comprueba que los datos de la corrida siguen intactos.
//       Con E2E_P5_ESCRIBIR=1 y E2E_P5_NUEVA_SESION=1 además inicia una
//       sesión nueva por docente (enlace mágico generado por service_role:
//       solo escribe en el esquema auth) y repite ÚNICAMENTE el bloque 4,
//       sin sembrar ni crear conversaciones. No modifica el manifiesto.
//   npx tsx scripts/verificar-conversacion-remota-e2e.ts --limpieza-sql <manifiesto.json>
//     → imprime el SQL de limpieza acotado al manifiesto; no lo ejecuta.
//
// Variables (solo en el shell, nunca en archivos del repo):
//   E2E_SUPABASE_URL, E2E_SUPABASE_ANON_KEY, E2E_SUPABASE_SERVICE_ROLE_KEY,
//   E2E_P5_MANIFIESTO (ruta FUERA del repo; no debe existir).
// Las variables que leen la app y la ruta (NEXT_PUBLIC_SUPABASE_*,
// SUPABASE_SERVICE_ROLE_KEY) se fijan aquí a E2E antes de importarlas; si
// cualquier variable del proceso apunta a Production, no se ejecuta nada.

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const PROYECTO_E2E = 'wxmnnielzngutntdpect'
const PROYECTO_PRODUCTION = 'abdtrkdfobrkramerrrc'

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
// Entorno aislado: localStorage en memoria y variables de la app
// ============================================================

const almacen = new Map<string, string>()
;(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => almacen.get(k) ?? null,
    setItem: (k: string, v: string) => void almacen.set(k, String(v)),
    removeItem: (k: string) => void almacen.delete(k),
  },
}
const clavesLocales = () => [...almacen.keys()].filter((k) => k.startsWith('docente-ia:')).sort()
const fotoLocal = () => JSON.stringify(clavesLocales().map((k) => [k, almacen.get(k)]))

function fijarEntornoApp(url: string, anon: string, service: string) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = url
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = anon
  process.env.SUPABASE_SERVICE_ROLE_KEY = service
  process.env.ANTHROPIC_API_KEY = 'no-se-usa-en-esta-prueba'
  process.env.OPENAI_API_KEY = 'no-se-usa-en-esta-prueba'
  process.env.LISTA_OFICIAL_HMAC_SECRET_KEY = ''
  const aProduction = Object.entries(process.env).filter(([, v]) => v?.includes(PROYECTO_PRODUCTION)).map(([k]) => k)
  if (aProduction.length > 0) throw new Error(`Variables que apuntan a Production: ${aProduction.join(', ')}. No se ejecuta nada.`)
}

// Mismo cálculo que idConversacionRemota (persistencia.ts), recalculado
// aquí para anotar el id en el manifiesto ANTES de crear la fila y para
// comprobar que es determinista.
function idRemotoEsperado(docenteId: string, localId: string): string {
  const b = createHash('sha256').update(`docente-ia:conversacion-remota:${docenteId}:${localId}`).digest().subarray(0, 16)
  b[6] = (b[6] & 0x0f) | 0x80
  b[8] = (b[8] & 0x3f) | 0x80
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

const MENSAJE_LISTA = 'Actualiza la lista oficial de mi grupo'
const mensajeLocal = (id: string, rol: 'usuario' | 'asistente', texto: string, creadoEn: number) => ({ id, rol, texto, creadoEn })

// ============================================================
// Modo en seco
// ============================================================

// Con --ejecutar no se importa aquí el código de la app: debe cargarse
// ya con el entorno E2E (S1–S4 y S8 los cubren los escenarios 4 y 5).
async function enSeco(incluirApp: boolean) {
  console.log('\n— En seco (sin red) —')
  if (incluirApp) await enSecoApp()
  enSecoLimpieza()
}

async function enSecoApp() {
  fijarEntornoApp('http://127.0.0.1:9', 'sin-red', 'sin-red')
  const p = await import('../lib/asistente/persistencia')

  const localId = p.crearNuevaConversacion()
  const mensajes = [mensajeLocal('m1', 'usuario', 'Hola', 1), mensajeLocal('m2', 'asistente', 'Hola, ¿en qué te ayudo?', 2)]
  p.guardarConversacion(localId, mensajes as never, null)
  const antes = fotoLocal()
  const cargada = p.cargarConversacionPorId(localId)
  verificar(JSON.stringify(cargada?.mensajes) === JSON.stringify(mensajes), 'S1. Conversación local guardada y restaurada')
  verificar(clavesLocales().length === 3, 'S2. Solo índice, conversación activa y conversación (sin claves nuevas)')

  // Sin servidor: la creación remota falla, devuelve null y no toca nada local.
  const remoto = await p.asegurarConversacionRemota(localId, randomUUID())
  verificar(remoto === null, 'S3. Sin red: asegurarConversacionRemota devuelve null (el chat sigue sin conversacionId)')
  verificar(fotoLocal() === antes, 'S4. El historial local queda idéntico tras el intento')

  const ruta = await import('../app/api/chat/route')
  verificar(typeof ruta.POST === 'function', 'S8. La ruta /api/chat carga con el entorno aislado')
}

function enSecoLimpieza() {
  const a = idRemotoEsperado('d1', 'conv-1')
  verificar(a === idRemotoEsperado('d1', 'conv-1') && a !== idRemotoEsperado('d2', 'conv-1') && /^[0-9a-f-]{36}$/.test(a), 'S5. Id remoto determinista y distinto por docente')

  const dir = mkdtempSync(join(tmpdir(), 'p5e1-seco-'))
  const ruta = join(dir, 'manifiesto.json')
  const prueba: Manifiesto = {
    etiqueta: 'p5e1-0123abcd', proyecto: PROYECTO_E2E, creadoEn: new Date().toISOString(),
    docentes: { A: randomUUID(), B: randomUUID() },
    correos: { A: correoDocente('p5e1-0123abcd', 'A'), B: correoDocente('p5e1-0123abcd', 'B') },
    instituciones: [randomUUID()], ciclos: [randomUUID()],
    grupos: { GA1: randomUUID(), GA2: randomUUID(), GB1: randomUUID() },
    contextoActivo: [], conversaciones: { E1: randomUUID() }, conversacionesConfirmadas: ['E1'],
  }
  prueba.contextoActivo = [prueba.docentes.A]
  writeFileSync(ruta, JSON.stringify(prueba))
  const sql = limpiezaSql(ruta)
  verificar(sql.includes("borró % de 1.") && sql.includes('docente_contexto_activo') && sql.includes('mensajes_chat'), 'S6. SQL de limpieza con conteos exactos y barrera de mensajes')
  const ajeno = { ...prueba, correos: { ...prueba.correos, A: 'otro@ejemplo.com' } }
  writeFileSync(ruta, JSON.stringify(ajeno))
  let rechazado = false
  try { limpiezaSql(ruta) } catch { rechazado = true }
  verificar(rechazado, 'S7. Un manifiesto con correo ajeno no genera SQL')
  unlinkSync(ruta)
  rmdirSync(dir)
}

// ============================================================
// Manifiesto
// ============================================================

type Manifiesto = {
  etiqueta: string
  proyecto: string
  creadoEn: string
  docentes: Record<string, string>
  correos: Record<string, string>
  instituciones: string[]
  ciclos: string[]
  grupos: Record<string, string>
  // docente_id de cada fila de docente_contexto_activo sembrada.
  contextoActivo: string[]
  // Ids anotados ANTES de crear; confirmadas = las que la prueba vio creadas.
  conversaciones: Record<string, string>
  conversacionesConfirmadas: string[]
}

let manifiesto: Manifiesto
let rutaManifiesto = ''
function guardarManifiesto() {
  writeFileSync(rutaManifiesto, JSON.stringify(manifiesto, null, 2))
}

const DOMINIO_CORREO = 'docente-ia-e2e.test'
const nombreInstitucion = (etiqueta: string) => `P5E1 E2E ${etiqueta}`
const correoDocente = (etiqueta: string, clave: string) => `${etiqueta}-${clave.toLowerCase()}@${DOMINIO_CORREO}`

// ============================================================
// Clientes (mismas guardas que el script E2E de P4B)
// ============================================================

function validarLlave(nombre: string, llave: string, rol: string, prefijo: string) {
  if (llave.startsWith(prefijo) && /^[A-Za-z0-9_-]+$/.test(llave)) return
  const partes = llave.split('.')
  let claims: { role?: string; ref?: string } = {}
  try {
    claims = partes.length === 3 ? JSON.parse(Buffer.from(partes[1], 'base64url').toString('utf8')) : {}
  } catch {}
  if (claims.role !== rol || claims.ref !== PROYECTO_E2E) {
    throw new Error(`${nombre} no tiene la forma esperada (JWT ${rol} de ${PROYECTO_E2E} o ${prefijo}…).`)
  }
}

function leerEntorno() {
  const url = process.env.E2E_SUPABASE_URL ?? ''
  const anon = process.env.E2E_SUPABASE_ANON_KEY ?? ''
  const service = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY ?? ''
  const ruta = process.env.E2E_P5_MANIFIESTO ?? ''
  if (new URL(url).host !== `${PROYECTO_E2E}.supabase.co`) throw new Error(`Solo se permite el proyecto E2E ${PROYECTO_E2E}.`)
  if (!anon || !service) throw new Error('Faltan las llaves E2E.')
  validarLlave('E2E_SUPABASE_ANON_KEY', anon, 'anon', 'sb_publishable_')
  validarLlave('E2E_SUPABASE_SERVICE_ROLE_KEY', service, 'service_role', 'sb_secret_')
  if (!ruta || existsSync(ruta) || resolve(ruta).startsWith(resolve(process.cwd()))) {
    throw new Error('E2E_P5_MANIFIESTO debe ser una ruta nueva fuera del repositorio.')
  }
  return { url, anon, service, ruta }
}

const sinSesion = { auth: { persistSession: false, autoRefreshToken: false } }

async function insertar(admin: SupabaseClient, tabla: string, fila: Record<string, unknown>) {
  const { error } = await admin.from(tabla).insert(fila)
  if (error) throw new Error(`Sembrado de ${tabla}: ${error.message}`)
}

// ============================================================
// Sembrado: 2 docentes, 1 institución, 1 ciclo activo, 3 grupos sin
// alumnos. A tiene dos grupos vigentes y su grupo activo (GA1) en
// docente_contexto_activo; B tiene un solo grupo y ningún puntero
// (camino "único grupo vigente" de fijar_grupo_conversacion).
// ============================================================

async function sembrar(admin: SupabaseClient, url: string, anon: string) {
  const m = manifiesto
  const anotar = (registrar: (id: string) => void) => {
    const id = randomUUID()
    registrar(id)
    guardarManifiesto()
    return id
  }

  const institucionId = anotar((id) => m.instituciones.push(id))
  await insertar(admin, 'instituciones', { id: institucionId, nombre: nombreInstitucion(m.etiqueta) })
  const cicloId = anotar((id) => m.ciclos.push(id))
  await insertar(admin, 'ciclos_escolares', { id: cicloId, institucion_id: institucionId, nombre: `${m.etiqueta} 2026-2027`, activo: true })

  const sesiones: Record<string, { cliente: SupabaseClient; correo: string; password: string; token: string }> = {}
  for (const clave of ['A', 'B']) {
    const correo = correoDocente(m.etiqueta, clave)
    const password = randomBytes(24).toString('base64url')
    m.correos[clave] = correo
    const docenteId = anotar((id) => (m.docentes[clave] = id))
    const creado = await admin.auth.admin.createUser({ id: docenteId, email: correo, password, email_confirm: true })
    if (creado.error || creado.data.user?.id !== docenteId) throw new Error(`Sembrado de usuario ${clave}: ${creado.error?.message ?? 'id distinto'}`)
    await insertar(admin, 'perfiles_docentes', { id: docenteId })
    const cliente = createClient(url, anon, sinSesion)
    const entrada = await cliente.auth.signInWithPassword({ email: correo, password })
    if (entrada.error || entrada.data.user?.id !== docenteId || !entrada.data.session) throw new Error(`Sesión del docente ${clave}: ${entrada.error?.message ?? 'id distinto'}`)
    sesiones[clave] = { cliente, correo, password, token: entrada.data.session.access_token }
  }

  for (const [clave, docente, letra] of [['GA1', 'A', 'A'], ['GA2', 'A', 'B'], ['GB1', 'B', 'C']] as const) {
    const grupoId = anotar((id) => (m.grupos[clave] = id))
    await insertar(admin, 'grupos', {
      id: grupoId, docente_id: m.docentes[docente], institucion_id: institucionId, ciclo_escolar_id: cicloId,
      nivel_educativo: 'primaria', grado: '3', grupo: letra,
    })
  }

  m.contextoActivo.push(m.docentes.A)
  guardarManifiesto()
  await insertar(admin, 'docente_contexto_activo', {
    docente_id: m.docentes.A, institucion_id: institucionId, ciclo_escolar_id: cicloId, grupo_id: m.grupos.GA1,
    actualizado_en: new Date().toISOString(),
  })
  return { A: sesiones.A, B: sesiones.B }
}

// ============================================================
// Ayudas de los escenarios
// ============================================================

type FilaConversacion = { docente_id: string; grupo_id: string | null; grupo_contexto_version: number | null }
async function leerFilaConversacion(admin: SupabaseClient, id: string): Promise<FilaConversacion | null> {
  return (await admin.from('conversaciones_chat').select('docente_id, grupo_id, grupo_contexto_version').eq('id', id).maybeSingle()).data as FilaConversacion | null
}

type PostChat = (req: never) => Promise<Response>
// POST real de /api/chat; devuelve el log de conversación y el texto.
async function llamarChatReal(POST: PostChat, token: string, conversacionId: unknown) {
  const capturados: string[] = []
  const original = console.log
  console.log = (...a: unknown[]) => { const t = a.map(String).join(' '); if (t.includes('[LISTA_OFICIAL] conversacion_autorizada')) capturados.push(t) }
  try {
    const res = await POST(new Request('http://localhost/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mensaje: MENSAJE_LISTA, historial: [], contexto: '', accessToken: token, zonaHoraria: 'America/Mexico_City', conversacionId }),
    }) as never)
    return { log: capturados.join('\n'), texto: await res.text() }
  } finally {
    console.log = original
  }
}
const pideFotos = (t: string) => t.includes('necesito una o varias fotos')

// ============================================================
// Escenarios
// ============================================================

async function ejecutar() {
  if (process.env.E2E_P5_ESCRIBIR !== '1') throw new Error('Falta E2E_P5_ESCRIBIR=1.')
  const { url, anon, service, ruta } = leerEntorno()
  fijarEntornoApp(url, anon, service)
  const admin = createClient(url, service, sinSesion)
  const ajustes = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: anon } })
  if (!ajustes.ok) throw new Error(`E2E_SUPABASE_ANON_KEY rechazada por E2E (HTTP ${ajustes.status}).`)
  const prueba = await admin.auth.admin.listUsers({ page: 1, perPage: 1 })
  if (prueba.error) throw new Error(`E2E_SUPABASE_SERVICE_ROLE_KEY rechazada por E2E: ${prueba.error.message}`)

  // Código real de la app, importado ya con el entorno E2E.
  const p = await import('../lib/asistente/persistencia')
  const { supabase: app } = await import('../lib/supabaseClient')
  const { POST } = await import('../app/api/chat/route')

  rutaManifiesto = ruta
  manifiesto = {
    etiqueta: `p5e1-${randomBytes(4).toString('hex')}`, proyecto: PROYECTO_E2E, creadoEn: new Date().toISOString(),
    docentes: {}, correos: {}, instituciones: [], ciclos: [], grupos: {}, contextoActivo: [],
    conversaciones: {}, conversacionesConfirmadas: [],
  }
  guardarManifiesto()
  console.log(`\nManifiesto: ${ruta}\nEtiqueta: ${manifiesto.etiqueta}`)

  const { A, B } = await sembrar(admin, url, anon)
  const m = manifiesto
  const anotarConversacion = (clave: string, id: string) => { m.conversaciones[clave] = id; guardarManifiesto() }
  const confirmar = async (clave: string) => {
    const { data } = await admin.from('conversaciones_chat').select('id').eq('id', m.conversaciones[clave]).maybeSingle()
    if (data) { m.conversacionesConfirmadas.push(clave); guardarManifiesto() }
    return !!data
  }
  const filaConversacion = (id: string) => leerFilaConversacion(admin, id)
  const llamarChat = (token: string, conversacionId: unknown) => llamarChatReal(POST as PostChat, token, conversacionId)

  // Historial local previo a esta etapa: conversación sin fila remota.
  const localAnterior = p.crearNuevaConversacion()
  p.guardarConversacion(localAnterior, [mensajeLocal('h1', 'usuario', 'Mensaje previo', 1), mensajeLocal('h2', 'asistente', 'Respuesta previa', 2)] as never, null)
  const historialAntes = fotoLocal()

  // ---- 1. Creación con RLS y grupo activo ----
  console.log('\n— 1. Creación real con RLS y grupo activo —')
  const entradaA = await app.auth.signInWithPassword({ email: A.correo, password: A.password })
  if (entradaA.error) throw new Error(`Sesión de la app (A): ${entradaA.error.message}`)
  anotarConversacion('E1', idRemotoEsperado(m.docentes.A, 'conv-e2e-1'))
  const [e1, e1bis] = await Promise.all([p.asegurarConversacionRemota('conv-e2e-1', m.docentes.A), p.asegurarConversacionRemota('conv-e2e-1', m.docentes.A)])
  const e1Confirmada = await confirmar('E1')
  verificar(e1 === m.conversaciones.E1 && e1bis === e1 && e1Confirmada, '1a. Fila creada con el id determinista; dos envíos simultáneos, una sola fila')
  const f1 = await filaConversacion(m.conversaciones.E1)
  verificar(f1?.docente_id === m.docentes.A && f1?.grupo_contexto_version === 1, '1b. docente_id del docente autenticado y grupo_contexto_version = 1')
  verificar(f1?.grupo_id === m.grupos.GA1, '1c. Grupo fijado = grupo activo de A (GA1), aunque A tiene dos grupos vigentes')
  // Negativos: el id se anota antes por si la base lo aceptara (sería un
  // fallo, pero la limpieza lo cubre).
  anotarConversacion('N1', randomUUID())
  const falsa = await A.cliente.from('conversaciones_chat').insert({ id: m.conversaciones.N1, docente_id: m.docentes.B })
  const n1Confirmada = await confirmar('N1')
  verificar(!!falsa.error && !n1Confirmada, '1d. A no puede crear una conversación a nombre de B (RLS)')
  anotarConversacion('N2', randomUUID())
  const conGrupo = await A.cliente.from('conversaciones_chat').insert({ id: m.conversaciones.N2, docente_id: m.docentes.A, grupo_id: m.grupos.GA2 })
  const n2Confirmada = await confirmar('N2')
  verificar(!!conGrupo.error && !n2Confirmada, '1e. El cliente no puede elegir grupo_id al crear (privilegio de columna)')

  // ---- 2. El grupo fijado no cambia ----
  console.log('\n— 2. El grupo fijado no cambia —')
  await admin.from('docente_contexto_activo').update({ grupo_id: m.grupos.GA2 }).eq('docente_id', m.docentes.A)
  await A.cliente.rpc('fijar_grupo_conversacion', { p_conversacion_id: m.conversaciones.E1 })
  const cambio = await A.cliente.from('conversaciones_chat').update({ grupo_id: m.grupos.GA2 }).eq('id', m.conversaciones.E1)
  verificar(!!cambio.error, '2a. El docente no puede actualizar grupo_id directamente')
  verificar((await filaConversacion(m.conversaciones.E1))?.grupo_id === m.grupos.GA1, '2b. Tras cambiar el grupo activo y volver a llamar la RPC, sigue en GA1')

  // ---- 3. Conversaciones de otro docente ----
  console.log('\n— 3. Conversaciones de otro docente —')
  const vistaB = await B.cliente.from('conversaciones_chat').select('id').eq('id', m.conversaciones.E1).maybeSingle()
  verificar(!vistaB.error && vistaB.data === null, '3a. B no ve la conversación de A')
  await B.cliente.rpc('fijar_grupo_conversacion', { p_conversacion_id: m.conversaciones.E1 })
  const robo = await B.cliente.from('conversaciones_chat').insert({ id: m.conversaciones.E1, docente_id: m.docentes.B })
  const f3 = await filaConversacion(m.conversaciones.E1)
  verificar(!!robo.error && f3?.docente_id === m.docentes.A && f3?.grupo_id === m.grupos.GA1, '3b. B no puede apropiarse ni re-fijar la fila de A')
  await app.auth.signOut({ scope: 'local' })
  const entradaB = await app.auth.signInWithPassword({ email: B.correo, password: B.password })
  if (entradaB.error) throw new Error(`Sesión de la app (B): ${entradaB.error.message}`)
  anotarConversacion('EB', idRemotoEsperado(m.docentes.B, 'conv-e2e-1'))
  const eb = await p.asegurarConversacionRemota('conv-e2e-1', m.docentes.B)
  const ebConfirmada = await confirmar('EB')
  verificar(eb === m.conversaciones.EB && eb !== m.conversaciones.E1 && ebConfirmada, '3c. Mismo id local con B → fila propia distinta')
  verificar((await filaConversacion(m.conversaciones.EB))?.grupo_id === m.grupos.GB1, '3d. B sin puntero activo: se fija su único grupo vigente (GB1)')
  await app.auth.signOut({ scope: 'local' })

  // ---- 4. /api/chat ----
  console.log('\n— 4. Resolución de conversacionId en /api/chat —')
  const r4a = await llamarChat(A.token, m.conversaciones.E1)
  verificar(r4a.log.includes('conversacion_autorizada=true grupo_fijado=true') && pideFotos(r4a.texto), '4a. Conversación propia con grupo: autorizada y con grupo; respuesta sin cambios')
  const r4b = await llamarChat(B.token, m.conversaciones.E1)
  verificar(r4b.log.includes('conversacion_autorizada=false') && pideFotos(r4b.texto), '4b. Token de B con la conversación de A: no autorizada')
  const r4c = await llamarChat(A.token, 'conv-123-no-es-uuid')
  const r4d = await llamarChat(A.token, undefined)
  verificar(r4c.log.includes('conversacion_autorizada=false') && r4d.log.includes('conversacion_autorizada=false') && pideFotos(r4d.texto), '4c. Id inválido o ausente: no autorizada y el chat responde igual')

  // Conversación de A creada sin fijar (p. ej. la RPC falló en el cliente):
  // la ruta la fija con el grupo activo vigente (ahora GA2).
  anotarConversacion('E4', randomUUID())
  const sinFijar = await A.cliente.from('conversaciones_chat').insert({ id: m.conversaciones.E4, docente_id: m.docentes.A })
  const e4Confirmada = await confirmar('E4')
  verificar(!sinFijar.error && e4Confirmada && (await filaConversacion(m.conversaciones.E4))?.grupo_id === null, '4d. Conversación propia todavía sin grupo')
  const r4e = await llamarChat(A.token, m.conversaciones.E4)
  verificar(r4e.log.includes('conversacion_autorizada=true grupo_fijado=true') && (await filaConversacion(m.conversaciones.E4))?.grupo_id === m.grupos.GA2, '4e. La ruta fija el grupo pendiente una sola vez (GA2)')

  // Conversación anterior a los snapshots (grupo_contexto_version null).
  anotarConversacion('E5', randomUUID())
  await insertar(admin, 'conversaciones_chat', { id: m.conversaciones.E5, docente_id: m.docentes.A, grupo_contexto_version: null })
  await confirmar('E5')
  const r4f = await llamarChat(A.token, m.conversaciones.E5)
  const f5 = await filaConversacion(m.conversaciones.E5)
  verificar(r4f.log.includes('conversacion_autorizada=false') && f5?.grupo_id === null && f5?.grupo_contexto_version === null, '4f. Conversación legacy: no autorizada y no se le fija grupo')

  // ---- 5. Historial local ----
  console.log('\n— 5. Conservación del historial local —')
  const entradaA2 = await app.auth.signInWithPassword({ email: A.correo, password: A.password })
  if (entradaA2.error) throw new Error(`Sesión de la app (A): ${entradaA2.error.message}`)
  anotarConversacion('EH', idRemotoEsperado(m.docentes.A, localAnterior))
  const eh = await p.asegurarConversacionRemota(localAnterior, m.docentes.A)
  const ehConfirmada = await confirmar('EH')
  verificar(eh === m.conversaciones.EH && ehConfirmada, '5a. Conversación local anterior: obtiene su fila al primer envío')
  verificar(fotoLocal() === historialAntes, '5b. Mensajes, índice y conversación activa locales intactos; sin claves nuevas')
  const { data: mensajesRemotos } = await admin.from('mensajes_chat').select('id').in('conversacion_id', Object.values(m.conversaciones))
  verificar((mensajesRemotos ?? []).length === 0, '5c. Ningún mensaje se copió a mensajes_chat')
  await app.auth.signOut({ scope: 'local' })

  console.log(`\nLimpieza: npx tsx scripts/verificar-conversacion-remota-e2e.ts --limpieza-sql ${ruta}`)
}

// ============================================================
// Reanudación del bloque 4 sobre los datos de una corrida existente
// ============================================================

async function reanudarBloque4(rutaManifiesto: string) {
  const url = process.env.E2E_SUPABASE_URL ?? ''
  const anon = process.env.E2E_SUPABASE_ANON_KEY ?? ''
  const service = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY ?? ''
  if (new URL(url).host !== `${PROYECTO_E2E}.supabase.co`) throw new Error(`Solo se permite el proyecto E2E ${PROYECTO_E2E}.`)
  if (!anon || !service) throw new Error('Faltan las llaves E2E.')
  validarLlave('E2E_SUPABASE_ANON_KEY', anon, 'anon', 'sb_publishable_')
  validarLlave('E2E_SUPABASE_SERVICE_ROLE_KEY', service, 'service_role', 'sb_secret_')
  if (!rutaManifiesto || !existsSync(rutaManifiesto) || resolve(rutaManifiesto).startsWith(resolve(process.cwd()))) {
    throw new Error('El manifiesto debe existir y estar fuera del repositorio.')
  }
  // El SQL de limpieza valida el manifiesto completo (proyecto, etiqueta,
  // correos, UUID); si no lo acepta, tampoco se reanuda.
  limpiezaSql(rutaManifiesto)
  const m = JSON.parse(readFileSync(rutaManifiesto, 'utf8')) as Manifiesto
  fijarEntornoApp(url, anon, service)
  const admin = createClient(url, service, sinSesion)
  const D = Object.values(m.docentes)
  const C = m.conversaciones

  // ---- Precondiciones (solo lectura) ----
  console.log(`\n— Precondiciones de solo lectura (${m.etiqueta}) —`)
  const pre: [boolean, string][] = []
  for (const [clave, id] of Object.entries(m.docentes)) {
    const u = await admin.auth.admin.getUserById(id)
    pre.push([u.data.user?.email === m.correos[clave], `P1${clave}. Usuario ${clave} existe con su correo ficticio`])
  }
  const perfiles = await admin.from('perfiles_docentes').select('id').in('id', D)
  pre.push([perfiles.data?.length === D.length, 'P2. Perfiles de ambos docentes'])
  const grupos = await admin.from('grupos').select('id, docente_id').in('id', Object.values(m.grupos))
  const duenoGrupo = new Map((grupos.data ?? []).map((g) => [g.id as string, g.docente_id as string]))
  pre.push([duenoGrupo.get(m.grupos.GA1) === m.docentes.A && duenoGrupo.get(m.grupos.GA2) === m.docentes.A && duenoGrupo.get(m.grupos.GB1) === m.docentes.B, 'P3. Grupos GA1, GA2 (A) y GB1 (B)'])
  const dca = await admin.from('docente_contexto_activo').select('docente_id, grupo_id').in('docente_id', D)
  pre.push([dca.data?.length === 1 && dca.data[0].docente_id === m.docentes.A && dca.data[0].grupo_id === m.grupos.GA2, 'P4. Grupo activo de A = GA2 (cambiado en el bloque 2)'])
  const todas = await admin.from('conversaciones_chat').select('id').in('docente_id', D)
  const ids = new Set((todas.data ?? []).map((c) => c.id as string))
  const confirmadas = m.conversacionesConfirmadas.map((k) => C[k])
  pre.push([ids.size === confirmadas.length && confirmadas.every((id) => ids.has(id)), `P5. Exactamente las ${confirmadas.length} conversaciones confirmadas del manifiesto`])
  const f = async (k: string) => leerFilaConversacion(admin, C[k])
  const [e1, e4, e5, eb] = [await f('E1'), await f('E4'), await f('E5'), await f('EB')]
  pre.push([e1?.docente_id === m.docentes.A && e1?.grupo_id === m.grupos.GA1 && e1?.grupo_contexto_version === 1, 'P6. E1: A, GA1, versión 1'])
  pre.push([e4?.docente_id === m.docentes.A && e4?.grupo_id === null && e4?.grupo_contexto_version === 1, 'P7. E4: A, sin grupo, versión 1 (pendiente de fijar)'])
  pre.push([e5?.docente_id === m.docentes.A && e5?.grupo_id === null && e5?.grupo_contexto_version === null, 'P8. E5: A, legacy (versión nula)'])
  pre.push([eb?.docente_id === m.docentes.B && eb?.grupo_id === m.grupos.GB1, 'P9. EB: B, GB1'])
  const msgs = await admin.from('mensajes_chat').select('id').in('docente_id', D)
  pre.push([!msgs.error && (msgs.data ?? []).length === 0, 'P10. Sin mensajes en mensajes_chat'])
  for (const [ok, texto] of pre) verificar(ok, texto)
  console.log('  Sesiones: las de la corrida se revocaron con signOut() global y sus contraseñas no se conservaron; no hay sesión renovable. Reanudar exige una sesión nueva por docente.')
  if (pre.some(([ok]) => !ok)) throw new Error('Precondición fallida: no se escribe nada.')
  if (process.env.E2E_P5_ESCRIBIR !== '1' || process.env.E2E_P5_NUEVA_SESION !== '1') {
    console.log('\n(Solo lectura: faltan E2E_P5_ESCRIBIR=1 y E2E_P5_NUEVA_SESION=1 para iniciar sesiones y ejecutar el bloque 4.)')
    return
  }

  // ---- Sesiones nuevas (solo esquema auth; se borran con el usuario) ----
  const sesionNueva = async (clave: string) => {
    const enlace = await admin.auth.admin.generateLink({ type: 'magiclink', email: m.correos[clave] })
    const hash = enlace.data?.properties?.hashed_token
    if (enlace.error || !hash || enlace.data.user?.id !== m.docentes[clave]) throw new Error(`Enlace de ${clave}: ${enlace.error?.message ?? 'sin token'}`)
    const cliente = createClient(url, anon, sinSesion)
    const r = await cliente.auth.verifyOtp({ token_hash: hash, type: 'magiclink' })
    if (r.error || r.data.user?.id !== m.docentes[clave] || !r.data.session) throw new Error(`Sesión de ${clave}: ${r.error?.message ?? 'id distinto'}`)
    return { cliente, token: r.data.session.access_token }
  }
  const A = await sesionNueva('A')
  const B = await sesionNueva('B')
  const { POST } = await import('../app/api/chat/route')
  const llamarChat = (token: string, conversacionId: unknown) => llamarChatReal(POST as PostChat, token, conversacionId)

  // ---- Bloque 4 ----
  console.log('\n— 4. Resolución de conversacionId en /api/chat (reanudación) —')
  const r4a = await llamarChat(A.token, C.E1)
  verificar(r4a.log.includes('conversacion_autorizada=true grupo_fijado=true') && pideFotos(r4a.texto), '4a. Conversación propia con grupo: autorizada y con grupo; respuesta sin cambios')
  const r4b = await llamarChat(B.token, C.E1)
  verificar(r4b.log.includes('conversacion_autorizada=false') && pideFotos(r4b.texto), '4b. Token de B con la conversación de A: no autorizada')
  const r4c = await llamarChat(A.token, 'conv-123-no-es-uuid')
  const r4d = await llamarChat(A.token, undefined)
  verificar(r4c.log.includes('conversacion_autorizada=false') && r4d.log.includes('conversacion_autorizada=false') && pideFotos(r4d.texto), '4c. Id inválido o ausente: no autorizada y el chat responde igual')
  verificar((await f('E4'))?.grupo_id === null, '4d. Conversación propia todavía sin grupo (E4, ya creada en la corrida)')
  const r4e = await llamarChat(A.token, C.E4)
  verificar(r4e.log.includes('conversacion_autorizada=true grupo_fijado=true') && (await f('E4'))?.grupo_id === m.grupos.GA2, '4e. La ruta fija el grupo pendiente una sola vez (GA2)')
  const r4f = await llamarChat(A.token, C.E5)
  const e5d = await f('E5')
  verificar(r4f.log.includes('conversacion_autorizada=false') && e5d?.grupo_id === null && e5d?.grupo_contexto_version === null, '4f. Conversación legacy: no autorizada y no se le fija grupo')

  // ---- Sin otros cambios ----
  const despues = await admin.from('conversaciones_chat').select('id').in('docente_id', D)
  const [e1d, ebd] = [await f('E1'), await f('EB')]
  verificar((despues.data ?? []).length === confirmadas.length && e1d?.grupo_id === m.grupos.GA1 && ebd?.grupo_id === m.grupos.GB1,
    'Post. Sin conversaciones nuevas; E1 y EB sin cambios (solo cambió el grupo de E4)')
  await A.cliente.auth.signOut({ scope: 'local' })
  await B.cliente.auth.signOut({ scope: 'local' })
}

// ============================================================
// Limpieza (SQL para revisar y ejecutar a mano en E2E)
// ============================================================

function limpiezaSql(ruta: string): string {
  const m = JSON.parse(readFileSync(ruta, 'utf8')) as Manifiesto
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  const lista = (v: string[]) => {
    if (v.some((x) => !uuid.test(x))) throw new Error('El manifiesto contiene un id que no es UUID.')
    return `'{${v.join(',')}}'::uuid[]`
  }
  if (m.proyecto !== PROYECTO_E2E || !/^p5e1-[0-9a-f]{8}$/.test(m.etiqueta)) throw new Error('El manifiesto no es de una corrida P5E1 en E2E.')
  const correos = Object.entries(m.correos)
  if (correos.some(([clave, correo]) => correo !== correoDocente(m.etiqueta, clave))) throw new Error('El manifiesto contiene un correo ajeno.')
  if (m.contextoActivo.some((d) => !Object.values(m.docentes).includes(d))) throw new Error('docente_contexto_activo ajeno al manifiesto.')
  const D = lista(Object.values(m.docentes))
  const I = lista(m.instituciones)
  const CI = lista(m.ciclos)
  const G = lista(Object.values(m.grupos))
  const C = lista(Object.values(m.conversaciones))
  const CC = lista(m.conversacionesConfirmadas.map((k) => m.conversaciones[k]))
  const DCA = lista(m.contextoActivo)
  const CO = `array[${correos.map(([, c]) => `'${c}'`).join(',')}]::text[]`
  const INST = `'${nombreInstitucion(m.etiqueta)}'`
  const n = (o: Record<string, string>) => Object.keys(o).length
  // Guarda de FK con ON DELETE CASCADE / SET NULL / SET DEFAULT, ANTES de
  // cualquier DELETE: ningún padre que esta limpieza borra puede arrastrar
  // ni modificar una fila que no sea de la corrida. Como las filas propias
  // todavía existen, cada tabla hija reconoce las suyas con un predicado
  // explícito (sin suponer una columna id); cualquier otra hija no tiene
  // filas propias. RESTRICT/NO ACTION no se evalúan: abortan solos.
  // Parámetros: $1 padres de esa FK, $2 D, $3 CI, $4 I, $5 G, $6 CC, $7 DCA.
  const GUARDA_CASCADA = `do $$
declare n integer; r record; padres uuid[]; propias text;
begin
  for r in
    select c.conname, c.conrelid::regclass as hija, c.confrelid::regclass as padre,
           c.conkey, ha.attname as col, pa.attname as col_padre
    from pg_constraint c
    join pg_attribute ha on ha.attrelid = c.conrelid and ha.attnum = c.conkey[1]
    join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = c.confkey[1]
    where c.contype = 'f' and c.confdeltype in ('c', 'n', 'd')
      and c.confrelid in ('auth.users'::regclass, 'public.perfiles_docentes'::regclass,
                          'public.instituciones'::regclass, 'public.ciclos_escolares'::regclass,
                          'public.grupos'::regclass, 'public.conversaciones_chat'::regclass)
      and not (c.confrelid = 'auth.users'::regclass and c.connamespace = 'auth'::regnamespace)
  loop
    if cardinality(r.conkey) <> 1 or r.col_padre <> 'id' then
      raise exception 'LIMPIEZA_ABORTADA: FK % no evaluable (compuesta o no apunta a id).', r.conname;
    end if;
    padres := case r.padre
      when 'auth.users'::regclass then ${D}
      when 'public.perfiles_docentes'::regclass then ${D}
      when 'public.instituciones'::regclass then ${I}
      when 'public.ciclos_escolares'::regclass then ${CI}
      when 'public.grupos'::regclass then ${G}
      else ${C} end;
    propias := case r.hija
      when 'public.perfiles_docentes'::regclass then 'id = any($2)'
      when 'public.ciclos_escolares'::regclass then 'id = any($3)'
      when 'public.instituciones'::regclass then 'id = any($4)'
      when 'public.grupos'::regclass then 'id = any($5)'
      when 'public.conversaciones_chat'::regclass then 'id = any($6)'
      when 'public.docente_contexto_activo'::regclass then 'docente_id = any($7)'
      when 'public.docente_grupos'::regclass then '(grupo_id = any($5) and docente_id = any($2))'
      else 'false' end;
    execute format('select count(*) from %s where %I = any($1) and not (%s)', r.hija, r.col, propias)
      into n using padres, ${D}, ${CI}, ${I}, ${G}, ${CC}, ${DCA};
    if n > 0 then
      raise exception 'LIMPIEZA_ABORTADA: % tiene % fila(s) ajenas que % borraría o modificaría (FK %).', r.hija, n, r.padre, r.conname;
    end if;
  end loop;
end $$;
`
  return `-- Limpieza LISTA-P5 etapa 1 — ${m.etiqueta} (${m.proyecto}). Revisar antes de ejecutar.
begin;
do $$
begin
  -- Barrera: nada ajeno cuelga de lo creado, ni lo creado cuelga de algo ajeno.
  if exists (select 1 from auth.users where id = any(${D}) and coalesce(email, '') <> all(${CO}))
     or exists (select 1 from public.instituciones where id = any(${I}) and nombre <> ${INST})
     or exists (select 1 from public.perfiles_docentes where institucion_id = any(${I}) and id <> all(${D}))
     or exists (select 1 from public.docente_instituciones where institucion_id = any(${I}) or docente_id = any(${D}))
     or exists (select 1 from public.ciclos_escolares where institucion_id = any(${I}) and id <> all(${CI}))
     or exists (select 1 from public.ciclos_escolares where id = any(${CI}) and institucion_id <> all(${I}))
     or exists (select 1 from public.grupos where (docente_id = any(${D}) or institucion_id = any(${I}) or ciclo_escolar_id = any(${CI})) and id <> all(${G}))
     or exists (select 1 from public.grupos where id = any(${G}) and docente_id <> all(${D}))
     or exists (select 1 from public.docente_grupos where (grupo_id = any(${G}) and docente_id <> all(${D})) or (docente_id = any(${D}) and grupo_id <> all(${G})))
     or exists (select 1 from public.docente_contexto_activo where (docente_id = any(${D}) or grupo_id = any(${G}) or institucion_id = any(${I}) or ciclo_escolar_id = any(${CI})) and docente_id <> all(${DCA}))
     or exists (select 1 from public.conversaciones_chat where (docente_id = any(${D}) or grupo_id = any(${G})) and id <> all(${C}))
     or exists (select 1 from public.conversaciones_chat where id = any(${C}) and docente_id <> all(${D}))
     or exists (select 1 from public.mensajes_chat where docente_id = any(${D}) or conversacion_id = any(${C}))
     or exists (select 1 from public.alumnos where docente_id = any(${D}) or institucion_id = any(${I}))
     or exists (select 1 from public.inscripciones where grupo_id = any(${G}) or ciclo_escolar_id = any(${CI}))
     or exists (select 1 from public.correcciones_alumno where docente_id = any(${D}) or conversacion_id = any(${C}))
     or exists (select 1 from public.propuestas_correccion_consumidas where docente_id = any(${D}) or conversacion_id = any(${C}))
     or exists (select 1 from public.propuestas_lista_oficial where docente_id = any(${D}) or conversacion_id = any(${C}) or grupo_id = any(${G})) then
    raise exception 'LIMPIEZA_ABORTADA: hay registros fuera del manifiesto.';
  end if;
end $$;
${GUARDA_CASCADA}do $$
declare n integer;
begin
  -- Cada delete debe tocar exactamente las filas del manifiesto; si no, se revierte todo.
${[
    ['public.docente_contexto_activo', `docente_id = any(${DCA})`, m.contextoActivo.length],
    ['public.conversaciones_chat', `id = any(${CC}) and docente_id = any(${D})`, m.conversacionesConfirmadas.length],
    ['public.docente_grupos', `grupo_id = any(${G}) and docente_id = any(${D})`, n(m.grupos)],
    ['public.grupos', `id = any(${G}) and docente_id = any(${D})`, n(m.grupos)],
    ['public.ciclos_escolares', `id = any(${CI}) and institucion_id = any(${I})`, m.ciclos.length],
    ['public.perfiles_docentes', `id = any(${D})`, n(m.docentes)],
    ['public.instituciones', `id = any(${I}) and nombre = ${INST}`, m.instituciones.length],
    ['auth.users', `id = any(${D}) and email = any(${CO})`, n(m.docentes)],
  ].map(([tabla, filtro, esperado]) => `  delete from ${tabla} where ${filtro};
  get diagnostics n = row_count;
  if n <> ${esperado} then raise exception 'LIMPIEZA_ABORTADA: ${tabla} borró % de ${esperado}.', n; end if;`).join('\n')}
  -- Ninguna conversación anotada debe quedar (las no confirmadas nunca existieron).
  if exists (select 1 from public.conversaciones_chat where id = any(${C})) then
    raise exception 'LIMPIEZA_ABORTADA: quedó una conversación anotada sin confirmar.';
  end if;
end $$;
commit;
`
}

// ============================================================

async function main() {
  const args = process.argv.slice(2)
  if (args[0] === '--limpieza-sql') {
    console.log(limpiezaSql(args[1]))
    return
  }
  if (args[0] === '--reanudar-bloque4') {
    await reanudarBloque4(args[1])
    if (fallos > 0) {
      console.error(`\n${fallos} comprobación(es) fallaron.`)
      process.exit(1)
    }
    console.log('\nTodas las comprobaciones pasaron.')
    process.exit(0)
  }
  const ejecutarE2E = args[0] === '--ejecutar'
  await enSeco(!ejecutarE2E)
  if (ejecutarE2E) {
    if (fallos > 0) throw new Error('El modo en seco falló; no se ejecuta en E2E.')
    await ejecutar()
  } else {
    console.log('\n(En seco: no se contactó ningún servicio.)')
  }
  if (fallos > 0) {
    console.error(`\n${fallos} comprobación(es) fallaron.`)
    process.exit(1)
  }
  console.log('\nTodas las comprobaciones pasaron.')
  process.exit(0)
}

main().catch((e) => {
  console.error(`\n✗ ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
