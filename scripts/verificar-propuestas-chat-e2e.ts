// scripts/verificar-propuestas-chat-e2e.ts
//
// LISTA-P5, etapa 2a — validación E2E del registro de propuestas desde el
// flujo del Chat IA y de su aplicación por POST /api/lista-oficial/aplicar,
// contra el proyecto Supabase E2E, SOLO con datos ficticios nuevos.
// Ejercita el código REAL:
//   - responderListaOficialConPropuesta (lib/listaOficial/flujoChatListaOficial.ts)
//     con la sesión del docente y el cliente del servidor de E2E; la lectura
//     de las fotos usa un doble (sin IA real);
//   - el POST real de app/api/lista-oficial/aplicar/route.ts, con los dos
//     formatos: { sobre, confirmaciones } (2a, bloques 2-5) y el token
//     cifrado de 2b { token, operacionIds } (bloque 6);
//   - registrar_propuesta_lista_oficial y aplicar_propuesta_lista_oficial.
//
// Modos (mismo esquema que los scripts E2E de P4B y P5 etapa 1):
//   npx tsx scripts/verificar-propuestas-chat-e2e.ts
//     → en seco: sin red; módulos y SQL de limpieza.
//   E2E_P5E2_ESCRIBIR=1 npx tsx scripts/verificar-propuestas-chat-e2e.ts --ejecutar
//     → escribe en E2E (requiere las variables E2E_*).
//   npx tsx scripts/verificar-propuestas-chat-e2e.ts --limpieza-sql <manifiesto.json>
//     → imprime el SQL de limpieza acotado al manifiesto; no lo ejecuta.
//
// Variables (solo en el shell, nunca en archivos del repo):
//   E2E_SUPABASE_URL, E2E_SUPABASE_ANON_KEY, E2E_SUPABASE_SERVICE_ROLE_KEY,
//   E2E_P5E2_MANIFIESTO (ruta FUERA del repo; no debe existir).
// El secreto HMAC se genera al azar en memoria para cada corrida: nunca se
// imprime ni se guarda. Las variables de la app se fijan a E2E antes de
// importar su código; si alguna variable apunta a Production, no se
// ejecuta nada.

import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const PROYECTO_E2E = 'wxmnnielzngutntdpect'
const PROYECTO_PRODUCTION = 'abdtrkdfobrkramerrrc'

let fallos = 0
let aprobadas = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
    aprobadas++
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

function fijarEntornoApp(url: string, anon: string, service: string) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = url
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = anon
  process.env.SUPABASE_SERVICE_ROLE_KEY = service
  process.env.ANTHROPIC_API_KEY = 'no-se-usa-en-esta-prueba'
  process.env.OPENAI_API_KEY = 'no-se-usa-en-esta-prueba'
  // Secreto solo de esta corrida: aleatorio, en memoria.
  process.env.LISTA_OFICIAL_HMAC_SECRET_KEY = randomBytes(32).toString('base64url')
  const aProduction = Object.entries(process.env).filter(([, v]) => v?.includes(PROYECTO_PRODUCTION)).map(([k]) => k)
  if (aProduction.length > 0) throw new Error(`Variables que apuntan a Production: ${aProduction.join(', ')}. No se ejecuta nada.`)
}

// ============================================================
// Datos ficticios
// ============================================================

const CURP = {
  ana: 'FIUA150101MDFCNN01',
  betoNueva: 'FIDB150303HDFCNN05',
  carla: 'FITC150505MJCCRR02',
  dani: 'FICD150707HDFCNN04',
  elena: 'FICE150909MDFCNN06',
  omar: 'FIRO150202HDFCNN07',
  fede: 'FISF150404HDFCNN08',
}
type AlumnoSemilla = { clave: string; nombre: string; curp: string | null }
// GA1: Beto sin CURP (corrección aplicable); Carla y Dani no vendrán en la
// foto (nunca deben darse de baja).
const GA1: AlumnoSemilla[] = [
  { clave: 'ana', nombre: 'Ana Ficticia Uno', curp: CURP.ana },
  { clave: 'beto', nombre: 'Beto Ficticio Dos', curp: null },
  { clave: 'carla', nombre: 'Carla Ficticia Tres', curp: CURP.carla },
  { clave: 'dani', nombre: 'Dani Ficticio Cuatro', curp: CURP.dani },
]
const GB1: AlumnoSemilla[] = [{ clave: 'omar', nombre: 'Omar Ficticio Siete', curp: CURP.omar }]

const reg = (nombre: string, curp: string | null) => ({ nombreLeido: nombre, nombreConfianza: 'alta', curpLeida: curp, curpLegible: curp !== null, curpConfianza: 'alta' })
// Foto: Ana igual, Beto con CURP nueva, Elena posible alta; Carla y Dani ausentes.
const DOCUMENTO = [reg('Ana Ficticia Uno', CURP.ana), reg('Beto Ficticio Dos', CURP.betoNueva), reg('Elena Ficticia Cinco', CURP.elena)]
const FOTO = [{ base64: 'iVBORw0KGgo=', tipo: 'image/png' }]

// Doble de la IA: devuelve los registros como si los hubiera leído.
function iaFalsa(registros: unknown[]) {
  const estado = { llamadas: 0 }
  const anthropic = { messages: { create: async () => { estado.llamadas++; return { content: [{ type: 'text', text: JSON.stringify({ registros }) }] } } } }
  return { anthropic, estado }
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
  conversaciones: Record<string, string>
  alumnos: Record<string, string>
  inscripciones: Record<string, string>
  // Solo las que registrar_propuesta_lista_oficial aceptó.
  propuestas: Record<string, string>
}

let manifiesto: Manifiesto
let rutaManifiesto = ''
function guardarManifiesto() {
  writeFileSync(rutaManifiesto, JSON.stringify(manifiesto, null, 2))
}

const DOMINIO_CORREO = 'docente-ia-e2e.test'
const nombreInstitucion = (etiqueta: string) => `P5E2 E2E ${etiqueta}`
const correoDocente = (etiqueta: string, clave: string) => `${etiqueta}-${clave.toLowerCase()}@${DOMINIO_CORREO}`

// ============================================================
// Clientes (mismas guardas que los scripts E2E anteriores)
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
  const ruta = process.env.E2E_P5E2_MANIFIESTO ?? ''
  if (new URL(url).host !== `${PROYECTO_E2E}.supabase.co`) throw new Error(`Solo se permite el proyecto E2E ${PROYECTO_E2E}.`)
  if (!anon || !service) throw new Error('Faltan las llaves E2E.')
  validarLlave('E2E_SUPABASE_ANON_KEY', anon, 'anon', 'sb_publishable_')
  validarLlave('E2E_SUPABASE_SERVICE_ROLE_KEY', service, 'service_role', 'sb_secret_')
  if (!ruta || existsSync(ruta) || resolve(ruta).startsWith(resolve(process.cwd()))) {
    throw new Error('E2E_P5E2_MANIFIESTO debe ser una ruta nueva fuera del repositorio.')
  }
  return { url, anon, service, ruta }
}

const sinSesion = { auth: { persistSession: false, autoRefreshToken: false } }

async function insertar(admin: SupabaseClient, tabla: string, fila: Record<string, unknown>) {
  const { error } = await admin.from(tabla).insert(fila)
  if (error) throw new Error(`Sembrado de ${tabla}: ${error.message}`)
}

// ============================================================
// Sembrado: A con GA1 (4 alumnos) y GA2 (vacío), B con GB1 (1 alumno).
// Conversaciones con grupo fijado: A1→GA1, A2→GA2, B1→GB1.
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

  const sesiones: Record<string, { cliente: SupabaseClient; token: string }> = {}
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
    sesiones[clave] = { cliente, token: entrada.data.session.access_token }
  }

  const grupos: { clave: string; docente: string; conversacion: string; letra: string; alumnos: AlumnoSemilla[] }[] = [
    { clave: 'GA1', docente: 'A', conversacion: 'A1', letra: 'A', alumnos: GA1 },
    { clave: 'GA2', docente: 'A', conversacion: 'A2', letra: 'B', alumnos: [] },
    { clave: 'GB1', docente: 'B', conversacion: 'B1', letra: 'C', alumnos: GB1 },
  ]
  for (const g of grupos) {
    const docenteId = m.docentes[g.docente]
    const grupoId = anotar((id) => (m.grupos[g.clave] = id))
    await insertar(admin, 'grupos', {
      id: grupoId, docente_id: docenteId, institucion_id: institucionId, ciclo_escolar_id: cicloId,
      nivel_educativo: 'primaria', grado: '3', grupo: g.letra,
    })
    const conversacionId = anotar((id) => (m.conversaciones[g.conversacion] = id))
    await insertar(admin, 'conversaciones_chat', { id: conversacionId, docente_id: docenteId, grupo_id: grupoId })
    for (const a of g.alumnos) await sembrarAlumno(admin, anotar, a, docenteId, grupoId, cicloId)
  }
  return { A: sesiones.A, B: sesiones.B, cicloId }
}

async function sembrarAlumno(admin: SupabaseClient, anotar: (r: (id: string) => void) => string, a: AlumnoSemilla, docenteId: string, grupoId: string, cicloId: string) {
  const m = manifiesto
  const alumnoId = anotar((id) => (m.alumnos[a.clave] = id))
  await insertar(admin, 'alumnos', { id: alumnoId, docente_id: docenteId, nombre: a.nombre, curp: a.curp })
  const inscripcionId = anotar((id) => (m.inscripciones[a.clave] = id))
  await insertar(admin, 'inscripciones', { id: inscripcionId, alumno_id: alumnoId, grupo_id: grupoId, ciclo_escolar_id: cicloId, estatus: 'activo' })
}

// ============================================================
// Escenarios
// ============================================================

type Sobre = { payload: { propuestaId: string; docenteId: string; conversacionId: string; grupoId: string; generadoEn: string; expiraEn: string; operaciones: Array<{ operacionId: string; tipo: string; clasificacion: string; alumnoId: string | null; inscripcionId: string | null }> }; firma: string }
type RespuestaAplicar = { status: number; cuerpo: { exito: boolean; codigo?: string; aplicadas?: number } }

async function ejecutar() {
  if (process.env.E2E_P5E2_ESCRIBIR !== '1') throw new Error('Falta E2E_P5E2_ESCRIBIR=1.')
  const { url, anon, service, ruta } = leerEntorno()
  fijarEntornoApp(url, anon, service)
  const admin = createClient(url, service, sinSesion)
  const ajustes = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: anon } })
  if (!ajustes.ok) throw new Error(`E2E_SUPABASE_ANON_KEY rechazada por E2E (HTTP ${ajustes.status}).`)
  const prueba = await admin.auth.admin.listUsers({ page: 1, perPage: 1 })
  if (prueba.error) throw new Error(`E2E_SUPABASE_SERVICE_ROLE_KEY rechazada por E2E: ${prueba.error.message}`)

  // Código real, importado ya con el entorno E2E.
  const flujo = await import('../lib/listaOficial/flujoChatListaOficial')
  const contrato = await import('../lib/listaOficial/propuestaActualizacionLista')
  const { obtenerRosterParaPropuesta } = await import('../lib/rosterGrupo')
  const { compararListaOficial } = await import('../lib/listaOficial/matchingListaOficial')
  const { clasificarPropuestasReparacionCurp } = await import('../lib/listaOficial/propuestasReparacionCurp')
  const { construirPlanDeActualizacionLista } = await import('../lib/listaOficial/planActualizacionLista')
  const { calcularRosterFingerprint } = await import('../lib/listaOficial/rosterFingerprint')
  const { POST } = await import('../app/api/lista-oficial/aplicar/route')
  const cifrado = await import('../lib/listaOficial/sobreCifrado')
  const secreto = process.env.LISTA_OFICIAL_HMAC_SECRET_KEY!

  rutaManifiesto = ruta
  manifiesto = {
    etiqueta: `p5e2-${randomBytes(4).toString('hex')}`, proyecto: PROYECTO_E2E, creadoEn: new Date().toISOString(),
    docentes: {}, correos: {}, instituciones: [], ciclos: [], grupos: {}, conversaciones: {}, alumnos: {}, inscripciones: {}, propuestas: {},
  }
  guardarManifiesto()
  console.log(`\nManifiesto: ${ruta}\nEtiqueta: ${manifiesto.etiqueta}`)
  // Barrido final (también si algo falla): anota cualquier alumno o
  // inscripción de los docentes de la corrida que no esté en el manifiesto
  // (p. ej. un alta aplicada por error), para que la limpieza los cubra.
  const barrerNoAnotados = async () => {
    const m = manifiesto
    const docentes = Object.values(m.docentes)
    if (docentes.length === 0) return
    const { data: alumnos } = await admin.from('alumnos').select('id').in('docente_id', docentes)
    const conocidos = new Set(Object.values(m.alumnos))
    let k = 0
    for (const a of alumnos ?? []) {
      if (conocidos.has(a.id as string)) continue
      m.alumnos[`noAnotado${++k}`] = a.id as string
      console.error(`  ! alumno no anotado agregado al manifiesto: noAnotado${k}`)
    }
    const ids = Object.values(m.alumnos)
    const { data: insc } = ids.length ? await admin.from('inscripciones').select('id, alumno_id').in('alumno_id', ids) : { data: [] }
    const inscConocidas = new Set(Object.values(m.inscripciones))
    let j = 0
    for (const i of insc ?? []) {
      if (inscConocidas.has(i.id as string)) continue
      m.inscripciones[`noAnotada${++j}`] = i.id as string
      console.error(`  ! inscripción no anotada agregada al manifiesto: noAnotada${j}`)
    }
    guardarManifiesto()
  }
  try {
    await escenarios(admin, url, anon, { flujo, contrato, obtenerRosterParaPropuesta, compararListaOficial, clasificarPropuestasReparacionCurp, construirPlanDeActualizacionLista, calcularRosterFingerprint, POST, cifrado, secreto })
  } finally {
    await barrerNoAnotados()
    console.log(`\nLimpieza: npx tsx scripts/verificar-propuestas-chat-e2e.ts --limpieza-sql ${ruta}`)
  }
}

type Modulos = {
  flujo: typeof import('../lib/listaOficial/flujoChatListaOficial')
  contrato: typeof import('../lib/listaOficial/propuestaActualizacionLista')
  obtenerRosterParaPropuesta: typeof import('../lib/rosterGrupo').obtenerRosterParaPropuesta
  compararListaOficial: typeof import('../lib/listaOficial/matchingListaOficial').compararListaOficial
  clasificarPropuestasReparacionCurp: typeof import('../lib/listaOficial/propuestasReparacionCurp').clasificarPropuestasReparacionCurp
  construirPlanDeActualizacionLista: typeof import('../lib/listaOficial/planActualizacionLista').construirPlanDeActualizacionLista
  calcularRosterFingerprint: typeof import('../lib/listaOficial/rosterFingerprint').calcularRosterFingerprint
  POST: typeof import('../app/api/lista-oficial/aplicar/route').POST
  cifrado: typeof import('../lib/listaOficial/sobreCifrado')
  secreto: string
}

async function escenarios(admin: SupabaseClient, url: string, anon: string, mod: Modulos) {
  const { flujo, contrato, obtenerRosterParaPropuesta, compararListaOficial, clasificarPropuestasReparacionCurp, construirPlanDeActualizacionLista, calcularRosterFingerprint, POST, cifrado, secreto } = mod
  const { A, B, cicloId } = await sembrar(admin, url, anon)
  const m = manifiesto
  const anotar = (registrar: (id: string) => void) => { const id = randomUUID(); registrar(id); guardarManifiesto(); return id }

  // Propuesta desde el flujo real del chat (A, conversación A1, grupo GA1).
  const proponer = async (nombre: string, extra: Record<string, unknown> = {}) => {
    const ia = iaFalsa(DOCUMENTO)
    const r = await flujo.responderListaOficialConPropuesta({
      anthropic: ia.anthropic as never, sb: A.cliente, docenteId: m.docentes.A, mensaje: 'Actualiza la lista oficial de mi grupo', fotos: FOTO, esPdf: false,
      conversacion: { id: m.conversaciones.A1, grupoId: m.grupos.GA1 }, grupoActivoSesion: m.grupos.GA1, sbServicio: admin, ...extra,
    })
    if (r.sobre) { m.propuestas[nombre] = r.sobre.payload.propuestaId; guardarManifiesto() }
    return { ...r, sobre: r.sobre as unknown as Sobre | null, llamadasIa: ia.estado.llamadas }
  }
  // POST real de /api/lista-oficial/aplicar.
  const enviar = async (cuerpo: Record<string, unknown>): Promise<RespuestaAplicar> => {
    const res = await POST(new Request('http://localhost/api/lista-oficial/aplicar', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo),
    }) as never)
    return { status: res.status, cuerpo: await res.json() }
  }
  // Formato 2a.
  const aplicar = (token: string, sobre: unknown, confirmaciones: unknown) => enviar({ sobre, confirmaciones, accessToken: token })
  const confirmar = (op: Sobre['payload']['operaciones'][number]) => ({ operacionId: op.operacionId, alumnoId: op.alumnoId, inscripcionId: op.inscripcionId, autorizaBaja: false })
  const op = (s: Sobre, tipo: string) => s.payload.operaciones.find((o) => o.tipo === tipo && o.clasificacion === 'seguro')!
  const leerAlumno = async (clave: string) => (await admin.from('alumnos').select('nombre, curp').eq('id', m.alumnos[clave]).maybeSingle()).data as { nombre: string; curp: string | null } | null
  const estatusDe = async (clave: string) => ((await admin.from('inscripciones').select('estatus').eq('id', m.inscripciones[clave]).maybeSingle()).data as { estatus: string } | null)?.estatus
  const alumnosDeA = async () => (await admin.from('alumnos').select('id').eq('docente_id', m.docentes.A)).data?.length ?? -1
  const correccionesDe = async (clave: string) => (await admin.from('correcciones_alumno').select('id').eq('alumno_id', m.alumnos[clave])).data?.length ?? -1
  // Firma local SIN registro, desde la lista actual (para casos de rechazo).
  const firmarSinRegistrar = async (cambios: { conversacionId?: string; grupoId?: string; docenteId?: string }) => {
    const grupoId = cambios.grupoId ?? m.grupos.GA1
    const { data: roster } = await obtenerRosterParaPropuesta(admin, m.grupos.GA1)
    const rosterMatching = roster.map((a) => ({ id: a.alumnoId, nombre: a.nombre, curp: a.curp }))
    const comparacion = compararListaOficial(DOCUMENTO as never, rosterMatching)
    const reparacion = clasificarPropuestasReparacionCurp(comparacion, rosterMatching)
    const generadoEn = new Date().toISOString()
    const plan = construirPlanDeActualizacionLista({
      grupoId, generadoEn, comparacion,
      rosterFingerprint: calcularRosterFingerprint(roster.map((a) => ({ inscripcionId: a.inscripcionId, estatus: a.estatus, curp: a.curp }))),
      propuestasReparacionCurp: { candidatos: reparacion.candidatos, totalCurpDiferente: reparacion.totalCurpDiferente, totalNoAccionables: reparacion.totalNoAccionables },
      roster: roster.map((a) => ({ id: a.alumnoId, inscripcionId: a.inscripcionId })),
    })
    const payload = contrato.construirPropuestaActualizacionLista({
      propuestaId: randomUUID(), docenteId: cambios.docenteId ?? m.docentes.A, conversacionId: cambios.conversacionId ?? m.conversaciones.A1,
      grupoId, generadoEn, vigenciaMinutos: 20, roster, comparacion, plan, solicitudesBaja: [],
    })
    return contrato.firmarPropuestaActualizacionConSecreto(payload!, secreto) as unknown as Sobre
  }

  // ---- 1. Registro ----
  console.log('\n— 1. Registro desde el flujo del chat —')
  const r1 = await proponer('P1')
  const p1 = r1.sobre
  verificar(!!p1 && p1.payload.docenteId === m.docentes.A && p1.payload.conversacionId === m.conversaciones.A1 && p1.payload.grupoId === m.grupos.GA1, '1a. Propuesta registrada con docente, conversación y grupo fijado correctos')
  verificar(!!p1 && Date.parse(p1.payload.expiraEn) - Date.parse(p1.payload.generadoEn) === 20 * 60_000 && r1.llamadasIa === 1, '1b. Vigencia de 20 minutos y una sola lectura de fotos')
  const tipos = (p1?.payload.operaciones ?? []).filter((o) => o.clasificacion === 'seguro').map((o) => o.tipo).sort().join(',')
  verificar(tipos === 'alta,correccion_curp' && !(p1?.payload.operaciones ?? []).some((o) => o.tipo === 'baja'), `1c. Aplicables: ${tipos}; ninguna baja aunque Carla y Dani no vienen en la foto`)
  const r1b = await proponer('P1-discrepante', { grupoActivoSesion: m.grupos.GA2 })
  verificar(r1b.sobre === null && r1b.llamadasIa === 0 && r1b.texto.includes('grupo distinto de tu grupo activo'), '1d. Grupo activo distinto del fijado: se detiene sin leer fotos ni registrar')
  if (!p1) throw new Error('Sin P1 no se puede continuar.')

  // ---- 2. Rechazos sin escritura ----
  console.log('\n— 2. Rechazos antes de escribir —')
  const alumnosAntes = await alumnosDeA()
  const cBeto = confirmar(op(p1, 'correccion_curp'))
  const alterada = await aplicar(A.token, p1, [{ ...cBeto, alumnoId: m.alumnos.carla }])
  verificar(alterada.cuerpo.codigo === 'CONFIRMACIONES_INVALIDAS', `2a. Confirmación alterada (otro alumno): ${alterada.cuerpo.codigo}`)
  const inexistente = await aplicar(A.token, p1, [{ ...cBeto, operacionId: 'no-existe' }])
  verificar(inexistente.cuerpo.codigo === 'CONFIRMACIONES_INVALIDAS', `2b. Operación no incluida en la propuesta: ${inexistente.cuerpo.codigo}`)
  const vacia = await aplicar(A.token, p1, [])
  verificar(vacia.cuerpo.codigo === 'SIN_CONFIRMACIONES', `2c. Sin autorización explícita: ${vacia.cuerpo.codigo}`)
  const sobreAlterado = JSON.parse(JSON.stringify(p1)); sobreAlterado.payload.grupoId = m.grupos.GA2
  const alterado = await aplicar(A.token, sobreAlterado, [cBeto])
  verificar(alterado.cuerpo.codigo === 'FIRMA_INVALIDA', `2d. Sobre alterado (grupo): ${alterado.cuerpo.codigo}`)
  const deB = await aplicar(B.token, p1, [cBeto])
  verificar(deB.cuerpo.codigo === 'DOCENTE_NO_CORRESPONDE', `2e. Otro docente (token de B): ${deB.cuerpo.codigo}`)
  const convB = await aplicar(A.token, await firmarSinRegistrar({ conversacionId: m.conversaciones.B1 }), [cBeto])
  verificar(convB.cuerpo.codigo === 'CONVERSACION_NO_CORRESPONDE', `2f. Conversación ajena (de B): ${convB.cuerpo.codigo}`)
  const grupoOtro = await aplicar(A.token, await firmarSinRegistrar({ conversacionId: m.conversaciones.A2 }), [cBeto])
  verificar(grupoOtro.cuerpo.codigo === 'GRUPO_NO_CORRESPONDE', `2g. Conversación de A fijada a otro grupo (GA2): ${grupoOtro.cuerpo.codigo}`)
  const sinRegistro = await firmarSinRegistrar({})
  const noRegistrada = await aplicar(A.token, sinRegistro, [confirmar(op(sinRegistro, 'correccion_curp'))])
  verificar(noRegistrada.cuerpo.codigo === 'PROPOSAL_NOT_FOUND', `2h. Firma válida pero no registrada: ${noRegistrada.cuerpo.codigo}`)
  const sinToken = await aplicar('token-invalido', p1, [cBeto])
  verificar(sinToken.status === 401, `2i. Sesión inválida: HTTP ${sinToken.status}`)
  verificar((await leerAlumno('beto'))?.curp === null && await alumnosDeA() === alumnosAntes && await correccionesDe('beto') === 0, '2j. Nada cambió tras los rechazos')

  // ---- 3. Aplicación autorizada y doble aplicación ----
  console.log('\n— 3. Aplicación de una operación autorizada —')
  const [x, y] = await Promise.all([aplicar(A.token, p1, [cBeto]), aplicar(A.token, p1, [cBeto])])
  const exitos = [x, y].filter((r) => r.cuerpo.exito)
  const otro = [x, y].find((r) => !r.cuerpo.exito)
  verificar(exitos.length === 1 && exitos[0].cuerpo.aplicadas === 1, '3a. Dos envíos simultáneos: exactamente uno aplica 1 cambio')
  verificar(!!otro && ['PROPOSAL_ALREADY_USED', 'ROSTER_CAMBIO'].includes(otro.cuerpo.codigo ?? ''), `3b. El otro se rechaza: ${otro?.cuerpo.codigo}`)
  verificar((await leerAlumno('beto'))?.curp === CURP.betoNueva && await correccionesDe('beto') === 1, '3c. CURP de Beto corregida una sola vez, con trazabilidad')
  verificar(await alumnosDeA() === alumnosAntes, '3d. El alta no confirmada (Elena) no se aplicó')
  verificar(await estatusDe('carla') === 'activo' && await estatusDe('dani') === 'activo', '3e. Carla y Dani siguen activos: ausencia en la foto ≠ baja')
  const tercera = await aplicar(A.token, p1, [confirmar(op(p1, 'alta'))])
  verificar(!tercera.cuerpo.exito && await alumnosDeA() === alumnosAntes, `3f. Reusar la propuesta para otra operación: ${tercera.cuerpo.codigo}`)

  // ---- 4. Lista modificada ----
  console.log('\n— 4. Lista modificada después de la propuesta —')
  const r4 = await proponer('P2')
  const p2 = r4.sobre
  verificar(!!p2 && !!op(p2, 'alta'), '4a. Nueva propuesta registrada (solo queda el alta de Elena)')
  await sembrarAlumno(admin, anotar, { clave: 'fede', nombre: 'Fede Ficticio Seis', curp: CURP.fede }, m.docentes.A, m.grupos.GA1, cicloId)
  const cambiada = p2 ? await aplicar(A.token, p2, [confirmar(op(p2, 'alta'))]) : null
  verificar(cambiada?.cuerpo.codigo === 'ROSTER_CAMBIO' && await alumnosDeA() === alumnosAntes + 1, `4b. Lista cambiada: ${cambiada?.cuerpo.codigo}; no se aplicó el alta`)

  // ---- 5. Propuesta vencida ----
  console.log('\n— 5. Propuesta vencida —')
  // Registrada directamente con 20 s de vigencia (el chat usa 20 min).
  const { data: roster5 } = await obtenerRosterParaPropuesta(A.cliente, m.grupos.GA1)
  const rm5 = roster5.map((a) => ({ id: a.alumnoId, nombre: a.nombre, curp: a.curp }))
  const comp5 = compararListaOficial(DOCUMENTO as never, rm5)
  const rep5 = clasificarPropuestasReparacionCurp(comp5, rm5)
  const gen5 = new Date().toISOString()
  const plan5 = construirPlanDeActualizacionLista({
    grupoId: m.grupos.GA1, generadoEn: gen5, comparacion: comp5,
    rosterFingerprint: calcularRosterFingerprint(roster5.map((a) => ({ inscripcionId: a.inscripcionId, estatus: a.estatus, curp: a.curp }))),
    propuestasReparacionCurp: { candidatos: rep5.candidatos, totalCurpDiferente: rep5.totalCurpDiferente, totalNoAccionables: rep5.totalNoAccionables },
    roster: roster5.map((a) => ({ id: a.alumnoId, inscripcionId: a.inscripcionId })),
  })
  const pay5 = contrato.construirPropuestaActualizacionLista({
    propuestaId: randomUUID(), docenteId: m.docentes.A, conversacionId: m.conversaciones.A1, grupoId: m.grupos.GA1,
    generadoEn: gen5, vigenciaMinutos: 20 / 60, roster: roster5, comparacion: comp5, plan: plan5, solicitudesBaja: [],
  })!
  const reg5 = await admin.rpc('registrar_propuesta_lista_oficial', { p_docente_id: m.docentes.A, p_propuesta: pay5 })
  if (!reg5.error) { m.propuestas.P3 = pay5.propuestaId; guardarManifiesto() }
  verificar(!reg5.error, '5a. Propuesta de 20 s registrada')
  console.log('  (esperando 25 s a que venza…)')
  await new Promise((r) => setTimeout(r, 25_000))
  const s5 = contrato.firmarPropuestaActualizacionConSecreto(pay5, secreto) as unknown as Sobre
  const vencida = await aplicar(A.token, s5, [confirmar(op(s5, 'alta'))])
  verificar(vencida.cuerpo.codigo === 'PROPUESTA_CADUCADA' && await alumnosDeA() === alumnosAntes + 1, `5b. Ruta: vencida por la vigencia firmada (${vencida.cuerpo.codigo}); nada aplicado`)
  // La ruta rechaza antes de la RPC; se comprueba aparte la vigencia que
  // guardó la base, con la sesión del docente (como en P4B).
  const directa = await A.cliente.rpc('aplicar_propuesta_lista_oficial', { p_propuesta_id: pay5.propuestaId, p_confirmaciones: [contrato.confirmacionParaRpc(pay5.operaciones.find((o) => o.tipo === 'alta' && o.clasificacion === 'seguro')!)] })
  verificar(directa.error?.message === 'PROPOSAL_EXPIRED' && await alumnosDeA() === alumnosAntes + 1, `5c. RPC: vigencia persistida vencida (${directa.error?.message ?? 'sin error'}); nada aplicado`)

  // ---- 6. Contrato con token cifrado (2b) ----
  console.log('\n— 6. Token cifrado y vista mínima (formato del chat) —')
  const r6 = await proponer('P4')
  const p4 = r6.sobre
  const cliente = p4 ? cifrado.prepararPropuestaParaCliente(p4 as never) : null
  const textoCliente = JSON.stringify(cliente ?? {})
  verificar(!!cliente && cliente.operaciones.some((o) => o.aplicable && o.etiqueta.includes('Elena Ficticia Cinco')) && cliente.expiraEn === p4?.payload.expiraEn,
    '6a. El navegador recibe token, vencimiento y vista con el alta de Elena')
  verificar(!!cliente && !Object.values(m.alumnos).some((id) => textoCliente.includes(id)) && !Object.values(m.inscripciones).some((id) => textoCliente.includes(id)) &&
    !textoCliente.includes(m.docentes.A) && !textoCliente.includes(m.grupos.GA1) && !/curpLeida|nombreConfianza|evidencia|valorActual|firma/.test(textoCliente),
    '6b. Sin identificadores internos, docente, grupo, firma ni lecturas de la foto')
  if (!cliente || !p4) throw new Error('Sin P4 no se puede continuar.')
  const idAlta = cliente.operaciones.find((o) => o.aplicable)!.operacionId
  const partes = cliente.token.split('.')
  const alterarUno = (t: string) => (t[0] === 'A' ? 'B' : 'A') + t.slice(1)
  const tokenAlterado = [partes[0], partes[1], alterarUno(partes[2]), partes[3]].join('.')
  const t1 = await enviar({ token: tokenAlterado, operacionIds: [idAlta], accessToken: A.token })
  verificar(t1.cuerpo.codigo === 'FIRMA_INVALIDA', `6c. Token alterado: ${t1.cuerpo.codigo}`)
  const t2 = await enviar({ token: cifrado.cifrarSobrePropuesta(p4 as never, randomBytes(32).toString('base64url')), operacionIds: [idAlta], accessToken: A.token })
  verificar(t2.cuerpo.codigo === 'FIRMA_INVALIDA', `6d. Token cifrado con otra clave: ${t2.cuerpo.codigo}`)
  const t3 = await enviar({ token: cliente.token, operacionIds: ['no-existe'], accessToken: A.token })
  verificar(t3.cuerpo.codigo === 'CONFIRMACIONES_INVALIDAS', `6e. Operación que no está en la propuesta: ${t3.cuerpo.codigo}`)
  const t4 = await enviar({ token: cliente.token, operacionIds: [], accessToken: A.token })
  verificar(t4.cuerpo.codigo === 'SIN_CONFIRMACIONES', `6f. Sin operaciones elegidas: ${t4.cuerpo.codigo}`)
  const t5 = await enviar({ token: cliente.token, operacionIds: [idAlta, idAlta], accessToken: A.token })
  verificar(t5.cuerpo.codigo === 'CONFIRMACIONES_INVALIDAS', `6g. Operación repetida: ${t5.cuerpo.codigo}`)
  const t6 = await enviar({ token: cliente.token, sobre: p4, operacionIds: [idAlta], accessToken: A.token })
  verificar(t6.cuerpo.codigo === 'SOLICITUD_INVALIDA', `6h. Token y sobre a la vez: ${t6.cuerpo.codigo}`)
  const t7 = await enviar({ token: cliente.token, operacionIds: [idAlta], accessToken: B.token })
  verificar(t7.cuerpo.codigo === 'DOCENTE_NO_CORRESPONDE', `6i. Token con la sesión de B: ${t7.cuerpo.codigo}`)
  const antes6 = await alumnosDeA()
  verificar(antes6 === alumnosAntes + 1, '6j. Nada cambió tras los rechazos con token')
  const t8 = await enviar({ token: cliente.token, operacionIds: [idAlta], accessToken: A.token })
  // Anotar el alta antes de cualquier otra comprobación (la limpieza la cubre).
  const { data: elena } = await admin.from('alumnos').select('id').eq('docente_id', m.docentes.A).eq('nombre', 'Elena Ficticia Cinco').maybeSingle()
  if (elena) {
    m.alumnos.elena = elena.id as string
    const { data: ie } = await admin.from('inscripciones').select('id').eq('alumno_id', elena.id).maybeSingle()
    if (ie) m.inscripciones.elena = ie.id as string
    guardarManifiesto()
  }
  verificar(t8.cuerpo.exito === true && t8.cuerpo.aplicadas === 1 && !!elena && await alumnosDeA() === antes6 + 1, '6k. Alta autorizada con token: aplicada una vez')
  const t9 = await enviar({ token: cliente.token, operacionIds: [idAlta], accessToken: A.token })
  verificar(!t9.cuerpo.exito && ['PROPOSAL_ALREADY_USED', 'ROSTER_CAMBIO'].includes(t9.cuerpo.codigo ?? '') && await alumnosDeA() === antes6 + 1, `6l. Segunda aplicación con el mismo token: ${t9.cuerpo.codigo}`)
  verificar(await estatusDe('carla') === 'activo' && await estatusDe('dani') === 'activo', '6m. Carla y Dani siguen activos')

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
  if (m.proyecto !== PROYECTO_E2E || !/^p5e2-[0-9a-f]{8}$/.test(m.etiqueta)) throw new Error('El manifiesto no es de una corrida P5E2 en E2E.')
  const correos = Object.entries(m.correos)
  if (correos.some(([clave, correo]) => correo !== correoDocente(m.etiqueta, clave))) throw new Error('El manifiesto contiene un correo ajeno.')
  const n = (o: Record<string, string>) => Object.keys(o).length
  const D = lista(Object.values(m.docentes))
  const I = lista(m.instituciones)
  const CI = lista(m.ciclos)
  const G = lista(Object.values(m.grupos))
  const C = lista(Object.values(m.conversaciones))
  const AL = lista(Object.values(m.alumnos))
  const P = lista(Object.values(m.propuestas))
  const CO = `array[${correos.map(([, c]) => `'${c}'`).join(',')}]::text[]`
  const INST = `'${nombreInstitucion(m.etiqueta)}'`
  // Guarda de FK con ON DELETE CASCADE / SET NULL / SET DEFAULT ANTES de
  // cualquier DELETE (mismo diseño que la limpieza v2 de P5 etapa 1): cada
  // hija reconoce sus filas de la corrida con un predicado explícito, sin
  // suponer una columna id; cualquier otra hija no tiene filas propias.
  // Parámetros: $1 padres, $2 D, $3 CI, $4 I, $5 G, $6 C, $7 AL, $8 P.
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
                          'public.grupos'::regclass, 'public.conversaciones_chat'::regclass,
                          'public.alumnos'::regclass, 'public.propuestas_lista_oficial'::regclass)
      and not (c.confrelid = 'auth.users'::regclass and c.connamespace = 'auth'::regnamespace)
  loop
    if cardinality(r.conkey) <> 1 or (r.col_padre <> 'id' and r.col_padre <> 'propuesta_id') then
      raise exception 'LIMPIEZA_ABORTADA: FK % no evaluable (compuesta o columna padre inesperada).', r.conname;
    end if;
    padres := case r.padre
      when 'auth.users'::regclass then ${D}
      when 'public.perfiles_docentes'::regclass then ${D}
      when 'public.instituciones'::regclass then ${I}
      when 'public.ciclos_escolares'::regclass then ${CI}
      when 'public.grupos'::regclass then ${G}
      when 'public.conversaciones_chat'::regclass then ${C}
      when 'public.alumnos'::regclass then ${AL}
      else ${P} end;
    propias := case r.hija
      when 'public.perfiles_docentes'::regclass then 'id = any($2)'
      when 'public.ciclos_escolares'::regclass then 'id = any($3)'
      when 'public.instituciones'::regclass then 'id = any($4)'
      when 'public.grupos'::regclass then 'id = any($5)'
      when 'public.conversaciones_chat'::regclass then 'id = any($6)'
      when 'public.alumnos'::regclass then 'id = any($7)'
      when 'public.docente_grupos'::regclass then '(grupo_id = any($5) and docente_id = any($2))'
      when 'public.inscripciones'::regclass then '(alumno_id = any($7) and grupo_id = any($5))'
      when 'public.correcciones_alumno'::regclass then '(alumno_id = any($7) and docente_id = any($2))'
      when 'public.propuestas_correccion_consumidas'::regclass then '(alumno_id = any($7) and docente_id = any($2))'
      when 'public.propuestas_lista_oficial'::regclass then 'propuesta_id = any($8)'
      when 'public.operaciones_propuesta_lista'::regclass then 'propuesta_id = any($8)'
      else 'false' end;
    execute format('select count(*) from %s where %I = any($1) and not (%s)', r.hija, r.col, propias)
      into n using padres, ${D}, ${CI}, ${I}, ${G}, ${C}, ${AL}, ${P};
    if n > 0 then
      raise exception 'LIMPIEZA_ABORTADA: % tiene % fila(s) ajenas que % borraría o modificaría (FK %).', r.hija, n, r.padre, r.conname;
    end if;
  end loop;
end $$;
`
  return `-- Limpieza LISTA-P5 etapa 2a — ${m.etiqueta} (${m.proyecto}). Revisar antes de ejecutar.
begin;
do $$
begin
  -- Barrera: nada ajeno cuelga de lo creado, ni lo creado cuelga de algo ajeno.
  if exists (select 1 from auth.users where id = any(${D}) and coalesce(email, '') <> all(${CO}))
     or exists (select 1 from public.instituciones where id = any(${I}) and nombre <> ${INST})
     or exists (select 1 from public.perfiles_docentes where institucion_id = any(${I}) and id <> all(${D}))
     or exists (select 1 from public.docente_instituciones where institucion_id = any(${I}) or docente_id = any(${D}))
     or exists (select 1 from public.docente_contexto_activo where docente_id = any(${D}) or grupo_id = any(${G}) or institucion_id = any(${I}) or ciclo_escolar_id = any(${CI}))
     or exists (select 1 from public.ciclos_escolares where institucion_id = any(${I}) and id <> all(${CI}))
     or exists (select 1 from public.ciclos_escolares where id = any(${CI}) and institucion_id <> all(${I}))
     or exists (select 1 from public.grupos where (docente_id = any(${D}) or institucion_id = any(${I}) or ciclo_escolar_id = any(${CI})) and id <> all(${G}))
     or exists (select 1 from public.grupos where id = any(${G}) and docente_id <> all(${D}))
     or exists (select 1 from public.docente_grupos where (grupo_id = any(${G}) and docente_id <> all(${D})) or (docente_id = any(${D}) and grupo_id <> all(${G})))
     or exists (select 1 from public.conversaciones_chat where (docente_id = any(${D}) or grupo_id = any(${G})) and id <> all(${C}))
     or exists (select 1 from public.conversaciones_chat where id = any(${C}) and docente_id <> all(${D}))
     or exists (select 1 from public.mensajes_chat where docente_id = any(${D}) or conversacion_id = any(${C}))
     or exists (select 1 from public.alumnos where (docente_id = any(${D}) or institucion_id = any(${I})) and id <> all(${AL}))
     or exists (select 1 from public.alumnos where id = any(${AL}) and docente_id <> all(${D}))
     or exists (select 1 from public.inscripciones where (alumno_id = any(${AL}) or grupo_id = any(${G}) or ciclo_escolar_id = any(${CI}))
                  and not (alumno_id = any(${AL}) and grupo_id = any(${G})))
     or exists (select 1 from public.correcciones_alumno where (docente_id = any(${D}) or alumno_id = any(${AL}) or conversacion_id = any(${C})) and not (docente_id = any(${D}) and alumno_id = any(${AL})))
     or exists (select 1 from public.propuestas_correccion_consumidas where (docente_id = any(${D}) or alumno_id = any(${AL}) or conversacion_id = any(${C})) and not (docente_id = any(${D}) and alumno_id = any(${AL})))
     or exists (select 1 from public.propuestas_lista_oficial where (docente_id = any(${D}) or conversacion_id = any(${C}) or grupo_id = any(${G})) and propuesta_id <> all(${P})) then
    raise exception 'LIMPIEZA_ABORTADA: hay registros fuera del manifiesto.';
  end if;
end $$;
${GUARDA_CASCADA}do $$
declare n integer;
begin
  -- Cada delete debe tocar exactamente las filas del manifiesto; si no, se revierte todo.
  -- Trazabilidad de la corrida (sin conteo fijo: la barrera ya garantiza que son solo de la corrida).
  delete from public.propuestas_correccion_consumidas where alumno_id = any(${AL}) and docente_id = any(${D});
  delete from public.correcciones_alumno where alumno_id = any(${AL}) and docente_id = any(${D});
${[
    ['public.propuestas_lista_oficial', `propuesta_id = any(${P}) and docente_id = any(${D})`, n(m.propuestas)],
    ['public.inscripciones', `alumno_id = any(${AL}) and grupo_id = any(${G})`, n(m.inscripciones)],
    ['public.alumnos', `id = any(${AL}) and docente_id = any(${D})`, n(m.alumnos)],
    ['public.conversaciones_chat', `id = any(${C}) and docente_id = any(${D})`, n(m.conversaciones)],
    ['public.docente_grupos', `grupo_id = any(${G}) and docente_id = any(${D})`, n(m.grupos)],
    ['public.grupos', `id = any(${G}) and docente_id = any(${D})`, n(m.grupos)],
    ['public.ciclos_escolares', `id = any(${CI}) and institucion_id = any(${I})`, m.ciclos.length],
    ['public.perfiles_docentes', `id = any(${D})`, n(m.docentes)],
    ['public.instituciones', `id = any(${I}) and nombre = ${INST}`, m.instituciones.length],
    ['auth.users', `id = any(${D}) and email = any(${CO})`, n(m.docentes)],
  ].map(([tabla, filtro, esperado]) => `  delete from ${tabla} where ${filtro};
  get diagnostics n = row_count;
  if n <> ${esperado} then raise exception 'LIMPIEZA_ABORTADA: ${tabla} borró % de ${esperado}.', n; end if;`).join('\n')}
end $$;
commit;
`
}

// ============================================================
// Modo en seco
// ============================================================

async function enSeco() {
  console.log('\n— En seco (sin red) —')
  fijarEntornoApp('http://127.0.0.1:9', 'sin-red', 'sin-red')
  const flujo = await import('../lib/listaOficial/flujoChatListaOficial')
  const ruta = await import('../app/api/lista-oficial/aplicar/route')
  verificar(typeof flujo.responderListaOficialConPropuesta === 'function' && typeof ruta.POST === 'function', 'S1. Flujo del chat y ruta de aplicación cargan con el entorno aislado')

  const dir = mkdtempSync(join(tmpdir(), 'p5e2-seco-'))
  const archivo = join(dir, 'manifiesto.json')
  const prueba: Manifiesto = {
    etiqueta: 'p5e2-0123abcd', proyecto: PROYECTO_E2E, creadoEn: new Date().toISOString(),
    docentes: { A: randomUUID(), B: randomUUID() },
    correos: { A: correoDocente('p5e2-0123abcd', 'A'), B: correoDocente('p5e2-0123abcd', 'B') },
    instituciones: [randomUUID()], ciclos: [randomUUID()],
    grupos: { GA1: randomUUID(), GA2: randomUUID(), GB1: randomUUID() },
    conversaciones: { A1: randomUUID(), A2: randomUUID(), B1: randomUUID() },
    alumnos: { ana: randomUUID(), omar: randomUUID() }, inscripciones: { ana: randomUUID(), omar: randomUUID() },
    propuestas: { P1: randomUUID() },
  }
  writeFileSync(archivo, JSON.stringify(prueba))
  const sql = limpiezaSql(archivo)
  const iGuarda = sql.indexOf('for r in'), iDelete = sql.indexOf('  delete from')
  verificar(iGuarda > 0 && iGuarda < iDelete && sql.includes("borró % de 1.") && sql.includes('mensajes_chat'), 'S2. SQL de limpieza: guarda de cascadas antes de cualquier DELETE, conteos exactos y barrera')
  writeFileSync(archivo, JSON.stringify({ ...prueba, correos: { ...prueba.correos, A: 'otro@ejemplo.com' } }))
  let rechazado = false
  try { limpiezaSql(archivo) } catch { rechazado = true }
  verificar(rechazado, 'S3. Un manifiesto con correo ajeno no genera SQL')
  unlinkSync(archivo)
  rmdirSync(dir)
}

// ============================================================

async function main() {
  const args = process.argv.slice(2)
  if (args[0] === '--limpieza-sql') {
    console.log(limpiezaSql(args[1]))
    return
  }
  const ejecutarE2E = args[0] === '--ejecutar'
  if (ejecutarE2E) {
    await ejecutar()
  } else {
    await enSeco()
    console.log('\n(En seco: no se contactó ningún servicio.)')
  }
  console.log(`\n${aprobadas} aprobada(s), ${fallos} fallida(s).`)
  process.exit(fallos > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(`\n✗ ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
