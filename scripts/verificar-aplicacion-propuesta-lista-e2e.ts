// scripts/verificar-aplicacion-propuesta-lista-e2e.ts
//
// LISTA-P4B — validación funcional E2E de registrar_propuesta_lista_oficial
// y aplicar_propuesta_lista_oficial (migración
// 20261027120000_lista_oficial_propuestas_aplicacion.sql) contra el
// proyecto Supabase E2E, SOLO con datos ficticios.
//
// Las propuestas se construyen con el pipeline REAL (comparación → plan →
// construirPropuestaActualizacionLista), igual que
// verificar-propuesta-actualizacion-lista.ts; solo se alteran a mano los
// casos negativos.
//
// Modos:
//   npx tsx scripts/verificar-aplicacion-propuesta-lista-e2e.ts
//     → en seco: sin red; valida datos ficticios y propuestas localmente.
//   E2E_P4B_ESCRIBIR=1 npx tsx scripts/verificar-aplicacion-propuesta-lista-e2e.ts --ejecutar
//     → escribe en E2E (requiere SEMBRADO_CONFIRMADO y las variables E2E_*).
//   npx tsx scripts/verificar-aplicacion-propuesta-lista-e2e.ts --limpieza-sql <manifiesto.json>
//     → imprime el SQL de limpieza acotado al manifiesto; no lo ejecuta.
//
// Variables (solo en el shell, nunca en archivos del repo):
//   E2E_SUPABASE_URL, E2E_SUPABASE_ANON_KEY, E2E_SUPABASE_SERVICE_ROLE_KEY,
//   E2E_P4B_MANIFIESTO (ruta FUERA del repo; no debe existir).

import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { compararListaOficial } from '../lib/listaOficial/matchingListaOficial'
import { clasificarPropuestasReparacionCurp } from '../lib/listaOficial/propuestasReparacionCurp'
import { construirPlanDeActualizacionLista } from '../lib/listaOficial/planActualizacionLista'
import { calcularRosterFingerprint } from '../lib/listaOficial/rosterFingerprint'
import { validarEstructuraCurp } from '../lib/motorContexto'
import type { RegistroExtraidoListaOficial } from '../lib/listaOficial/analisisListaOficial'
import {
  construirPropuestaActualizacionLista,
  esPayloadPropuestaActualizacionListaValido,
  type AlumnoRosterPropuesta,
  type OperacionPropuestaLista,
  type PayloadPropuestaActualizacionLista,
  type SolicitudBajaLista,
} from '../lib/listaOficial/propuestaActualizacionLista'

const PROYECTO_E2E = 'wxmnnielzngutntdpect'

// El sembrado depende del esquema base, que no está versionado en esta
// rama. sembrar() quedó ajustado al catálogo de E2E (consultas de
// inspección de solo lectura): columnas requeridas, CHECK, UNIQUE
// (alumnos (nombre, docente_id); inscripciones (alumno_id,
// ciclo_escolar_id) parcial en estatus 'activo') y FK de la limpieza.
const SEMBRADO_CONFIRMADO = true

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
// Datos ficticios
// ============================================================

// CURP ficticias, estructuralmente válidas (mismas del verificador P4A
// más una propia). Los docentes son nuevos en cada corrida, así que no
// chocan con nada existente.
const CURP = {
  ana: 'BARO880214HSPLNT05',
  beto: 'LOGA120909MVZPQR07',
  karla: 'RUME080505HQRSTN08',
  elena: 'DEXE141015MOCGRN09',
  gil: 'JULO100101HDFPRN03',
  lalo: 'ROIS990909HGTSLP01',
  mona: 'VIXO030303MDGLPT06',
  fer: 'RALF100512MDFMNR04',
} as const

type AlumnoSemilla = { clave: string; nombre: string; curp: string | null }

const GA1: AlumnoSemilla[] = [
  { clave: 'ana', nombre: 'Ana Torres Vega', curp: CURP.ana },
  { clave: 'beto', nombre: 'Beto Lopez Garcia', curp: null },
  { clave: 'karla', nombre: 'Karla Ruiz Mendez', curp: CURP.karla },
  { clave: 'dario', nombre: 'Dario Morales Paz', curp: null },
  { clave: 'elena', nombre: 'Elena Ruiz Soto', curp: CURP.elena },
  { clave: 'gil', nombre: 'Gil Perez Lopez', curp: CURP.gil },
  { clave: 'lalo', nombre: 'Lalo Gomez Ruiz', curp: null },
  { clave: 'mona', nombre: 'Mona Hernandez Diaz', curp: null },
]
const GA2: AlumnoSemilla[] = [{ clave: 'nora', nombre: 'Nora Vidal Paz', curp: null }]
// Mismo CURP que Ana, pero de otro docente: debe permanecer intacto.
const GB1: AlumnoSemilla[] = [{ clave: 'omar', nombre: 'Omar Rios Leal', curp: CURP.ana }]

const registro = (nombreLeido: string, curpLeida: string | null): RegistroExtraidoListaOficial => ({
  nombreLeido,
  nombreConfianza: 'alta',
  curpLeida,
  curpLegible: true,
  curpConfianza: 'alta',
})

// ============================================================
// Construcción de propuestas con el pipeline real
// ============================================================

function propuestaDe(params: {
  docenteId: string
  conversacionId: string
  grupoId: string
  roster: AlumnoRosterPropuesta[]
  documento: RegistroExtraidoListaOficial[]
  solicitudesBaja?: SolicitudBajaLista[]
  vigenciaMinutos?: number
  generadoEn?: string
}): PayloadPropuestaActualizacionLista {
  const generadoEn = params.generadoEn ?? new Date().toISOString()
  const rosterMatching = params.roster.map((a) => ({ id: a.alumnoId, nombre: a.nombre, curp: a.curp }))
  const comparacion = compararListaOficial(params.documento, rosterMatching)
  const reparacion = clasificarPropuestasReparacionCurp(comparacion, rosterMatching)
  const plan = construirPlanDeActualizacionLista({
    grupoId: params.grupoId,
    rosterFingerprint: calcularRosterFingerprint(params.roster.map((a) => ({ inscripcionId: a.inscripcionId, estatus: a.estatus, curp: a.curp }))),
    generadoEn,
    comparacion,
    propuestasReparacionCurp: { candidatos: reparacion.candidatos, totalCurpDiferente: reparacion.totalCurpDiferente, totalNoAccionables: reparacion.totalNoAccionables },
    roster: params.roster.map((a) => ({ id: a.alumnoId, inscripcionId: a.inscripcionId })),
  })
  const payload = construirPropuestaActualizacionLista({
    propuestaId: randomUUID(),
    docenteId: params.docenteId,
    conversacionId: params.conversacionId,
    grupoId: params.grupoId,
    generadoEn,
    vigenciaMinutos: params.vigenciaMinutos,
    roster: params.roster,
    comparacion,
    plan,
    solicitudesBaja: params.solicitudesBaja,
  })
  if (!payload || !esPayloadPropuestaActualizacionListaValido(payload)) {
    throw new Error('La propuesta ficticia no cumple el contrato.')
  }
  return payload
}

// Eco exacto que espera aplicar_propuesta_lista_oficial (mismo
// recorte/mayúsculas que registrar_propuesta_lista_oficial al guardar).
function ecoDe(op: OperacionPropuestaLista): Record<string, unknown> {
  const nombre = op.valorPropuesto?.nombre?.trim() ?? null
  const curp = op.valorPropuesto?.curp ? op.valorPropuesto.curp.trim().toUpperCase() : null
  switch (op.tipo) {
    case 'alta':
      return curp ? { nombre, curp } : { nombre, curp: null, sinCurp: true }
    case 'correccion_curp':
      return { alumnoId: op.alumnoId, curpActual: op.valorActual?.curp ?? null, curpNueva: curp }
    case 'correccion_nombre':
      return { alumnoId: op.alumnoId, nombreActual: op.valorActual?.nombre ?? null, nombreNuevo: nombre }
    case 'baja':
      return { alumnoId: op.alumnoId, inscripcionId: op.inscripcionId, autorizaBaja: true }
    default:
      throw new Error(`Operación no aplicable: ${op.tipo}`)
  }
}

const confirmar = (op: OperacionPropuestaLista) => ({ llaveOperacion: op.llaveOperacion, eco: ecoDe(op) })

function opUnica(p: PayloadPropuestaActualizacionLista, tipo: string, alumnoId?: string | null): OperacionPropuestaLista {
  const ops = p.operaciones.filter((o) => o.tipo === tipo && (alumnoId === undefined || o.alumnoId === alumnoId))
  if (ops.length !== 1) throw new Error(`Se esperaba exactamente una operación ${tipo}; hay ${ops.length}.`)
  return ops[0]
}

const clonar = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

// ============================================================
// Modo en seco: sin red
// ============================================================

function enSeco() {
  console.log('\n— En seco (sin red) —')
  const todas = [...GA1, ...GA2, ...GB1].map((a) => a.curp).concat(CURP.fer).filter((c): c is string => c !== null)
  verificar(todas.every((c) => validarEstructuraCurp(c).valido), 'S1. Todas las CURP ficticias son estructuralmente válidas')
  verificar(new Set(GA1.map((a) => a.curp).filter(Boolean)).size === GA1.filter((a) => a.curp).length, 'S2. Sin CURP repetidas dentro del docente A')

  const fx = { docenteId: randomUUID(), conversacionId: randomUUID(), grupoId: randomUUID() }
  const roster: AlumnoRosterPropuesta[] = GA1.map((a) => ({ alumnoId: randomUUID(), inscripcionId: randomUUID(), nombre: a.nombre, curp: a.curp, estatus: 'activo' }))
  const id = (clave: string) => roster[GA1.findIndex((a) => a.clave === clave)]
  const p1 = propuestaDe({ ...fx, roster, documento: documentoP1(), solicitudesBaja: [{ alumnoId: id('dario').alumnoId, inscripcionId: id('dario').inscripcionId }] })
  verificar(p1.operaciones.length === 4 && p1.operaciones.every((o) => o.clasificacion === 'seguro'), 'S3. P1: cuatro operaciones seguras (alta, CURP, nombre, baja)')
  verificar(opUnica(p1, 'correccion_nombre', id('karla').alumnoId).valorPropuesto?.nombre === 'Carla Ruiz Mendez', 'S4. P1: corrección de nombre Karla → Carla')
  const p7 = propuestaDe({ ...fx, roster, documento: documentoP7() })
  verificar(
    p7.operaciones.length === 3 && opUnica(p7, 'alta').clasificacion === 'requiere_revision' && opUnica(p7, 'alta').motivos.join() === 'ALTA_SIN_CURP_VERIFICABLE',
    'S5. P7: CURP de Lalo, nombre de Elena y alta sin CURP de Iván (aplicable)'
  )
  const p3 = propuestaDe({ ...fx, roster, documento: [registro('Mona Hernandez Diaz', CURP.mona)], vigenciaMinutos: 20 / 60 })
  verificar(Date.parse(p3.expiraEn) - Date.parse(p3.generadoEn) === 20_000, 'S6. P3: vigencia de 20 s')
  verificar(JSON.stringify(ecoDe(opUnica(p1, 'baja'))).includes('"autorizaBaja":true'), 'S7. Eco de baja con autorización expresa')
}

const documentoP1 = () => [
  registro('Fernanda Ramirez Luna', CURP.fer), // alta con CURP
  registro('Beto Lopez Garcia', CURP.beto), // CURP faltante
  registro('Carla Ruiz Mendez', CURP.karla), // nombre por identidad CURP
]
const documentoP7 = () => [
  registro('Lalo Gomez Ruiz', CURP.lalo), // orden 1: corrección de CURP (escribe)
  registro('Elena Maria Ruiz Soto', CURP.elena), // orden 2: corrección de nombre (escribe)
  registro('Ivan Salas Ortiz', null), // orden 3: alta que fallará con NAME_DUPLICATE
]

// ============================================================
// Manifiesto de UUID ficticios — se escribe tras CADA creación
// ============================================================

// Cada id se genera aquí y se anota ANTES de crear la fila: si el proceso
// cae a la mitad, el manifiesto ya cubre lo que pudo haberse creado.
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
  propuestas: Record<string, string>
}

let manifiesto: Manifiesto
let rutaManifiesto = ''
function guardarManifiesto() {
  writeFileSync(rutaManifiesto, JSON.stringify(manifiesto, null, 2))
}

// ============================================================
// Clientes y llamadas
// ============================================================

type Resultado = { ok: true; data: unknown } | { ok: false; codigo: string }

function leerEntorno() {
  const url = process.env.E2E_SUPABASE_URL ?? ''
  const anon = process.env.E2E_SUPABASE_ANON_KEY ?? ''
  const service = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY ?? ''
  const ruta = process.env.E2E_P4B_MANIFIESTO ?? ''
  if (new URL(url).host !== `${PROYECTO_E2E}.supabase.co`) throw new Error(`Solo se permite el proyecto E2E ${PROYECTO_E2E}.`)
  if (!anon || !service) throw new Error('Faltan las llaves E2E.')
  if (!ruta || existsSync(ruta) || resolve(ruta).startsWith(resolve(process.cwd()))) {
    throw new Error('E2E_P4B_MANIFIESTO debe ser una ruta nueva fuera del repositorio.')
  }
  return { url, anon, service, ruta }
}

const sinSesion = { auth: { persistSession: false, autoRefreshToken: false } }

async function rpc(sb: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<Resultado> {
  const { data, error } = await sb.rpc(fn, args)
  if (error) return { ok: false, codigo: error.code === 'P0001' ? error.message : error.code ?? error.message }
  return { ok: true, data }
}

const codigo = (r: Resultado) => (r.ok ? 'OK' : r.codigo)

// ============================================================
// Foto acotada a los docentes ficticios
// ============================================================

type Foto = { alumnos: Map<string, string>; inscripciones: Map<string, string>; correcciones: Map<string, string> }

async function foto(admin: SupabaseClient, docentes: string[]): Promise<Foto> {
  const al = await admin.from('alumnos').select('id, docente_id, nombre, curp').in('docente_id', docentes)
  if (al.error) throw new Error(`Foto de alumnos: ${al.error.message}`)
  const ids = (al.data ?? []).map((a) => a.id as string)
  const ins = await admin.from('inscripciones').select('id, alumno_id, grupo_id, estatus').in('alumno_id', ids)
  if (ins.error) throw new Error(`Foto de inscripciones: ${ins.error.message}`)
  const co = await admin.from('correcciones_alumno').select('id, alumno_id, campo, valor_anterior, valor_nuevo').in('docente_id', docentes)
  if (co.error) throw new Error(`Foto de correcciones: ${co.error.message}`)
  const mapa = (filas: { id: string }[]) => new Map(filas.map((f) => [f.id, JSON.stringify(f)]))
  return { alumnos: mapa(al.data ?? []), inscripciones: mapa(ins.data ?? []), correcciones: mapa(co.data ?? []) }
}

function iguales(a: Foto, b: Foto): boolean {
  const igual = (x: Map<string, string>, y: Map<string, string>) => x.size === y.size && [...x].every(([k, v]) => y.get(k) === v)
  return igual(a.alumnos, b.alumnos) && igual(a.inscripciones, b.inscripciones) && igual(a.correcciones, b.correcciones)
}

const filaAlumno = (f: Foto, id: string) => JSON.parse(f.alumnos.get(id) ?? 'null') as { nombre: string; curp: string | null } | null
const inscripcionDe = (f: Foto, id: string) => JSON.parse(f.inscripciones.get(id) ?? 'null') as { estatus: string } | null
const correccionesDe = (f: Foto, alumnoId: string) =>
  [...f.correcciones.values()].map((v) => JSON.parse(v) as { alumno_id: string; campo: string }).filter((c) => c.alumno_id === alumnoId)
const nuevos = (antes: Map<string, string>, despues: Map<string, string>) => [...despues.keys()].filter((k) => !antes.has(k))

async function rosterDe(admin: SupabaseClient, grupoId: string): Promise<AlumnoRosterPropuesta[]> {
  const r = await admin.from('inscripciones').select('id, alumno_id, estatus, alumnos(nombre, curp)').eq('grupo_id', grupoId).eq('estatus', 'activo')
  if (r.error) throw new Error(`Roster: ${r.error.message}`)
  return (r.data ?? []).map((f) => {
    const a = f.alumnos as unknown as { nombre: string; curp: string | null }
    return { alumnoId: f.alumno_id as string, inscripcionId: f.id as string, nombre: a.nombre, curp: a.curp, estatus: f.estatus as string }
  })
}

// ============================================================
// Sembrado — columnas según la consulta de inspección del proyecto E2E:
//   grupos: docente_id, institucion_id, ciclo_escolar_id, nivel_educativo,
//           grado, grupo (docente_grupos lo crea trg_sync_docente_grupo).
//   ciclos_escolares: institucion_id, nombre.
//   conversaciones_chat: id, docente_id (+ grupo_id que exigen las RPC;
//           grupo_contexto_version DEFAULT 1).
//   inscripciones: alumno_id, grupo_id, ciclo_escolar_id (+ estatus).
//   perfiles_docentes: id (FK a auth.users; no hay trigger que lo cree).
//   instituciones: nombre. alumnos: id, docente_id, nombre (+ curp).
// Solo se escriben columnas confirmadas. No se ejecuta mientras
// SEMBRADO_CONFIRMADO sea false.
// ============================================================

const DOMINIO_CORREO = 'docente-ia-e2e.test'
const nombreInstitucion = (etiqueta: string) => `P4B E2E ${etiqueta}`
const correoDocente = (etiqueta: string, clave: string) => `${etiqueta}-${clave.toLowerCase()}@${DOMINIO_CORREO}`

async function insertar(admin: SupabaseClient, tabla: string, fila: Record<string, unknown>) {
  const { error } = await admin.from(tabla).insert(fila)
  if (error) throw new Error(`Sembrado de ${tabla}: ${error.message}`)
}

async function sembrar(admin: SupabaseClient, url: string, anon: string): Promise<{
  sesionA: SupabaseClient
  sesionB: SupabaseClient
}> {
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
  await insertar(admin, 'ciclos_escolares', { id: cicloId, institucion_id: institucionId, nombre: `${m.etiqueta} 2026-2027` })

  const sesiones: Record<string, SupabaseClient> = {}
  for (const clave of ['A', 'B']) {
    const correo = correoDocente(m.etiqueta, clave)
    const password = randomBytes(24).toString('base64url')
    m.correos[clave] = correo
    const docenteId = anotar((id) => (m.docentes[clave] = id))
    const creado = await admin.auth.admin.createUser({ id: docenteId, email: correo, password, email_confirm: true })
    if (creado.error || creado.data.user?.id !== docenteId) throw new Error(`Sembrado de usuario ${clave}: ${creado.error?.message ?? 'id distinto'}`)
    await insertar(admin, 'perfiles_docentes', { id: docenteId })

    const sesion = createClient(url, anon, sinSesion)
    const entrada = await sesion.auth.signInWithPassword({ email: correo, password })
    if (entrada.error || entrada.data.user?.id !== docenteId) throw new Error(`Sesión del docente ${clave}: ${entrada.error?.message ?? 'id distinto'}`)
    sesiones[clave] = sesion
  }

  const grupos: { clave: string; docente: string; conversacion: string; grupo: string; alumnos: AlumnoSemilla[] }[] = [
    { clave: 'GA1', docente: 'A', conversacion: 'A1', grupo: 'A', alumnos: GA1 },
    { clave: 'GA2', docente: 'A', conversacion: 'A2', grupo: 'B', alumnos: GA2 },
    // Letra distinta a GA1 aunque sea de otro docente: no depende de si la
    // unicidad de grupos incluye o no al docente.
    { clave: 'GB1', docente: 'B', conversacion: 'B1', grupo: 'C', alumnos: GB1 },
  ]
  for (const g of grupos) {
    const docenteId = m.docentes[g.docente]
    const grupoId = anotar((id) => (m.grupos[g.clave] = id))
    await insertar(admin, 'grupos', {
      id: grupoId, docente_id: docenteId, institucion_id: institucionId, ciclo_escolar_id: cicloId,
      nivel_educativo: 'primaria', grado: '3', grupo: g.grupo,
    })
    const conversacionId = anotar((id) => (m.conversaciones[g.conversacion] = id))
    await insertar(admin, 'conversaciones_chat', { id: conversacionId, docente_id: docenteId, grupo_id: grupoId })

    for (const a of g.alumnos) {
      const alumnoId = anotar((id) => (m.alumnos[a.clave] = id))
      await insertar(admin, 'alumnos', { id: alumnoId, docente_id: docenteId, nombre: a.nombre, curp: a.curp })
      const inscripcionId = anotar((id) => (m.inscripciones[a.clave] = id))
      await insertar(admin, 'inscripciones', {
        id: inscripcionId, alumno_id: alumnoId, grupo_id: grupoId, ciclo_escolar_id: cicloId, estatus: 'activo',
      })
    }
  }

  // docente_grupos lo genera trg_sync_docente_grupo: una fila por grupo,
  // del mismo docente. La limpieza la borra por (grupo_id, docente_id).
  const dg = await admin.from('docente_grupos').select('docente_id, grupo_id').in('grupo_id', Object.values(m.grupos))
  if (dg.error) throw new Error(`docente_grupos: ${dg.error.message}`)
  const esperadas = grupos.map((g) => `${m.docentes[g.docente]}:${m.grupos[g.clave]}`).sort().join()
  const reales = (dg.data ?? []).map((f) => `${f.docente_id}:${f.grupo_id}`).sort().join()
  if (reales !== esperadas) throw new Error('docente_grupos no coincide con los grupos sembrados.')

  return { sesionA: sesiones.A, sesionB: sesiones.B }
}

// ============================================================
// Escenarios
// ============================================================

async function ejecutar() {
  if (process.env.E2E_P4B_ESCRIBIR !== '1') throw new Error('Falta E2E_P4B_ESCRIBIR=1.')
  if (!SEMBRADO_CONFIRMADO) throw new Error('SEMBRADO_CONFIRMADO es false: no se escribe nada.')
  const { url, anon, service, ruta } = leerEntorno()
  rutaManifiesto = ruta
  manifiesto = {
    etiqueta: `p4b-${randomBytes(4).toString('hex')}`,
    proyecto: PROYECTO_E2E,
    creadoEn: new Date().toISOString(),
    docentes: {}, correos: {}, instituciones: [], ciclos: [], grupos: {}, conversaciones: {}, alumnos: {}, inscripciones: {}, propuestas: {},
  }
  guardarManifiesto()

  const admin = createClient(url, service, sinSesion)
  const anonimo = createClient(url, anon, sinSesion)
  const { sesionA, sesionB } = await sembrar(admin, url, anon)
  const A = manifiesto.docentes.A
  const B = manifiesto.docentes.B
  const docentes = [A, B]
  const al = manifiesto.alumnos
  const ins = manifiesto.inscripciones
  const ctxA1 = { docenteId: A, conversacionId: manifiesto.conversaciones.A1, grupoId: manifiesto.grupos.GA1 }
  const ctxA2 = { docenteId: A, conversacionId: manifiesto.conversaciones.A2, grupoId: manifiesto.grupos.GA2 }
  const ctxB1 = { docenteId: B, conversacionId: manifiesto.conversaciones.B1, grupoId: manifiesto.grupos.GB1 }

  const registrar = async (nombre: string, p: PayloadPropuestaActualizacionLista, docente = p.docenteId) => {
    const r = await rpc(admin, 'registrar_propuesta_lista_oficial', { p_docente_id: docente, p_propuesta: p })
    if (r.ok) {
      manifiesto.propuestas[nombre] = p.propuestaId
      guardarManifiesto()
    }
    return r
  }
  const aplicar = (sb: SupabaseClient, p: PayloadPropuestaActualizacionLista, confs: unknown) =>
    rpc(sb, 'aplicar_propuesta_lista_oficial', { p_propuesta_id: p.propuestaId, p_confirmaciones: confs })
  const registrarAltas = (r: Resultado, prefijo: string) => {
    if (!r.ok) return
    const altas = (r.data as { altas: { alumnoId: string }[] }).altas
    altas.forEach((a, i) => (manifiesto.alumnos[`${prefijo}_alta${i + 1}`] = a.alumnoId))
    guardarManifiesto()
  }

  const fotoInicial = await foto(admin, docentes)
  const fotoInicialB = await foto(admin, [B])

  // --- 0. Registros inválidos ---------------------------------------
  console.log('\n— 0. Registros inválidos —')
  {
    const roster = await rosterDe(admin, ctxA1.grupoId)
    const base = propuestaDe({ ...ctxA1, roster, documento: documentoP1(), solicitudesBaja: [{ alumnoId: al.dario, inscripcionId: ins.dario }] })
    verificar(codigo(await rpc(sesionA, 'registrar_propuesta_lista_oficial', { p_docente_id: A, p_propuesta: base })) === '42501', '0a. Un docente autenticado no puede registrar')

    const dupNombre = clonar(base)
    opUnica(dupNombre, 'alta').valorPropuesto!.nombre = 'Ana Torres Vega'
    verificar(codigo(await registrar('x', { ...dupNombre, propuestaId: randomUUID() })) === 'NAME_DUPLICATE', '0b. Alta duplicada por nombre')

    const dupCurp = clonar(base)
    opUnica(dupCurp, 'alta').valorPropuesto!.curp = CURP.ana
    verificar(codigo(await registrar('x', { ...dupCurp, propuestaId: randomUUID() })) === 'CURP_DUPLICATE', '0c. Alta duplicada por CURP')

    const bajaDoc = clonar(base)
    opUnica(bajaDoc, 'baja').evidencia.fuente = 'documento'
    verificar(codigo(await registrar('x', { ...bajaDoc, propuestaId: randomUUID() })) === 'INVALID_OPERATION', '0d. Una baja que no es solicitud del docente se rechaza')

    const vencida = propuestaDe({ ...ctxA1, roster, documento: documentoP1(), generadoEn: new Date(Date.now() - 90_000).toISOString(), vigenciaMinutos: 1 / 60 })
    verificar(codigo(await registrar('x', vencida)) === 'PROPOSAL_EXPIRED', '0e. Una propuesta ya vencida no se registra')

    const bConConvA = propuestaDe({ ...ctxA1, docenteId: B, roster, documento: documentoP1() })
    verificar(codigo(await registrar('x', bConConvA)) === 'CONVERSATION_NOT_AUTHORIZED', '0f. Docente B con la conversación y el grupo de A')

    const bConGrupoA = propuestaDe({ ...ctxB1, grupoId: ctxA1.grupoId, roster, documento: documentoP1() })
    verificar(codigo(await registrar('x', bConGrupoA)) === 'CONVERSATION_NOT_AUTHORIZED', '0g. Docente B con su conversación y el grupo de A')

    const rosterB = await rosterDe(admin, ctxB1.grupoId)
    const bSobreAlumnoA = propuestaDe({ ...ctxB1, roster: rosterB, documento: [], solicitudesBaja: [{ alumnoId: rosterB[0].alumnoId, inscripcionId: rosterB[0].inscripcionId }] })
    const op = opUnica(bSobreAlumnoA, 'baja')
    op.alumnoId = al.beto
    op.inscripcionId = ins.beto
    verificar(codigo(await registrar('x', bSobreAlumnoA)) === 'INVALID_OPERATION', '0h. Docente B no puede proponer sobre un alumno de A')

    verificar(iguales(fotoInicial, await foto(admin, docentes)), '0z. Ningún registro rechazado dejó cambios')
  }

  // --- 1. P1: alta, CURP, nombre; baja NO confirmada ----------------
  console.log('\n— 1. P1 —')
  const p1 = propuestaDe({ ...ctxA1, roster: await rosterDe(admin, ctxA1.grupoId), documento: documentoP1(), solicitudesBaja: [{ alumnoId: al.dario, inscripcionId: ins.dario }] })
  verificar((await registrar('P1', p1)).ok, '1. P1 registrada')
  const alta1 = opUnica(p1, 'alta')
  const curp1 = opUnica(p1, 'correccion_curp', al.beto)
  const nombre1 = opUnica(p1, 'correccion_nombre', al.karla)
  const baja1 = opUnica(p1, 'baja', al.dario)
  const confs1 = [confirmar(alta1), confirmar(curp1), confirmar(nombre1)]
  const f1 = await foto(admin, docentes)

  verificar(codigo(await aplicar(sesionB, p1, confs1)) === 'PROPOSAL_NOT_FOUND', '1a. Docente B no puede aplicar la propuesta de A')
  verificar(codigo(await aplicar(anonimo, p1, confs1)) === '42501', '1b. Sin sesión no se puede aplicar')
  const alterada = clonar(confs1)
  ;(alterada[1].eco as Record<string, unknown>).curpNueva = CURP.lalo
  verificar(codigo(await aplicar(sesionA, p1, alterada)) === 'INVALID_CONFIRMATION', '1c. Eco alterado')
  verificar(codigo(await aplicar(sesionA, p1, [confs1[0], confs1[0]])) === 'INVALID_CONFIRMATION', '1d. Llave repetida')
  verificar(codigo(await aplicar(sesionA, p1, [{ llaveOperacion: randomUUID(), eco: confs1[0].eco }])) === 'INVALID_CONFIRMATION', '1e. Llave ajena a la propuesta')
  verificar(codigo(await aplicar(sesionA, p1, [{ ...confs1[0], extra: true }])) === 'INVALID_CONFIRMATION', '1f. Claves extra en la confirmación')
  verificar(codigo(await aplicar(sesionA, p1, [])) === 'INVALID_CONFIRMATION', '1g. Sin confirmaciones')
  verificar(iguales(f1, await foto(admin, docentes)), '1h. Ningún intento rechazado dejó cambios')

  const r1 = await aplicar(sesionA, p1, confs1)
  registrarAltas(r1, 'P1')
  verificar(r1.ok && (r1.data as { aplicadas: number }).aplicadas === 3, '1i. P1 aplicada con tres operaciones confirmadas')
  const f1b = await foto(admin, docentes)
  verificar(filaAlumno(f1b, al.beto)?.curp === CURP.beto && correccionesDe(f1b, al.beto).some((c) => c.campo === 'curp'), '1j. CURP de Beto corregida con trazabilidad')
  verificar(filaAlumno(f1b, al.karla)?.nombre === 'Carla Ruiz Mendez' && correccionesDe(f1b, al.karla).some((c) => c.campo === 'nombre'), '1k. Nombre corregido, mismo alumno, con trazabilidad')
  verificar(nuevos(f1.alumnos, f1b.alumnos).length === 1 && filaAlumno(f1b, manifiesto.alumnos.P1_alta1)?.curp === CURP.fer, '1l. Alta de Fernanda creada')
  verificar(inscripcionDe(f1b, ins.dario)?.estatus === 'activo', '1m. La baja no confirmada NO se aplicó')
  verificar(codigo(await aplicar(sesionA, p1, confs1)) === 'PROPOSAL_ALREADY_USED', '1n. Reaplicar P1 se rechaza')
  verificar(codigo(await aplicar(sesionA, p1, [confirmar(baja1)])) === 'PROPOSAL_ALREADY_USED', '1o. La baja descartada no puede aplicarse después')

  // --- 2. P2: baja expresamente confirmada --------------------------
  console.log('\n— 2. P2 —')
  const p2 = propuestaDe({ ...ctxA1, roster: await rosterDe(admin, ctxA1.grupoId), documento: [], solicitudesBaja: [{ alumnoId: al.dario, inscripcionId: ins.dario }] })
  verificar((await registrar('P2', p2)).ok, '2. P2 registrada')
  const baja2 = opUnica(p2, 'baja')
  verificar(codigo(await aplicar(sesionA, p2, [{ llaveOperacion: baja1.llaveOperacion, eco: ecoDe(baja2) }])) === 'INVALID_CONFIRMATION', '2a. Llave de otra propuesta (P1)')
  verificar(codigo(await aplicar(sesionA, p2, [{ llaveOperacion: baja2.llaveOperacion, eco: { ...ecoDe(baja2), autorizaBaja: false } }])) === 'INVALID_CONFIRMATION', '2b. Baja sin autorización expresa')
  verificar((await aplicar(sesionA, p2, [confirmar(baja2)])).ok, '2c. Baja confirmada aplicada')
  const f2 = await foto(admin, docentes)
  verificar(inscripcionDe(f2, ins.dario)?.estatus === 'baja' && filaAlumno(f2, al.dario) !== null, '2d. Baja lógica: el alumno y su historial se conservan')

  // --- 3. P3: caducidad ---------------------------------------------
  console.log('\n— 3. P3 —')
  const p3 = propuestaDe({ ...ctxA1, roster: await rosterDe(admin, ctxA1.grupoId), documento: [registro('Mona Hernandez Diaz', CURP.mona)], vigenciaMinutos: 20 / 60 })
  verificar((await registrar('P3', p3)).ok, '3. P3 registrada con 20 s de vigencia')
  await new Promise((r) => setTimeout(r, 25_000))
  const f3 = await foto(admin, docentes)
  verificar(codigo(await aplicar(sesionA, p3, p3.operaciones.map(confirmar))) === 'PROPOSAL_EXPIRED', '3a. Propuesta caducada')
  verificar(iguales(f3, await foto(admin, docentes)), '3b. Sin cambios')

  // --- 4. Cambio concurrente del grupo ------------------------------
  console.log('\n— 4. P4/P5/P6 —')
  const roster4 = await rosterDe(admin, ctxA1.grupoId)
  const p4 = propuestaDe({ ...ctxA1, roster: roster4, documento: [registro('Gilberto Perez Lopez', CURP.gil)] })
  const p5 = propuestaDe({ ...ctxA1, roster: roster4, documento: [registro('Hugo Castro Nava', null)] })
  verificar((await registrar('P4', p4)).ok && (await registrar('P5', p5)).ok, '4. P4 y P5 registradas sobre la misma foto')
  verificar((await aplicar(sesionA, p4, p4.operaciones.map(confirmar))).ok, '4a. P4 aplicada (cambia el grupo)')
  const f4 = await foto(admin, docentes)
  verificar(codigo(await aplicar(sesionA, p5, p5.operaciones.map(confirmar))) === 'ROSTER_CHANGED', '4b. P5 detecta el cambio del grupo')
  verificar(iguales(f4, await foto(admin, docentes)), '4c. Hugo no se dio de alta')

  const p6 = propuestaDe({ ...ctxA1, roster: await rosterDe(admin, ctxA1.grupoId), documento: [registro('Mona Hernandez Diaz', CURP.mona)] })
  verificar((await registrar('P6', p6)).ok, '4d. P6 registrada')
  const paralelo = await Promise.all([aplicar(sesionA, p6, p6.operaciones.map(confirmar)), aplicar(sesionA, p6, p6.operaciones.map(confirmar))])
  verificar(paralelo.filter((r) => r.ok).length === 1 && paralelo.some((r) => codigo(r) === 'PROPOSAL_ALREADY_USED'), '4e. Dos aplicaciones simultáneas: una sola gana')
  verificar(correccionesDe(await foto(admin, docentes), al.mona).length === 1, '4f. Una sola corrección de CURP para Mona')

  // --- 6. Atomicidad ------------------------------------------------
  console.log('\n— 6. Atomicidad (P7/P8) —')
  const p7 = propuestaDe({ ...ctxA1, roster: await rosterDe(admin, ctxA1.grupoId), documento: documentoP7() })
  const p8 = propuestaDe({ ...ctxA2, roster: await rosterDe(admin, ctxA2.grupoId), documento: [registro('Ivan Salas Ortiz', null)] })
  verificar((await registrar('P7', p7)).ok && (await registrar('P8', p8)).ok, '6a. P7 (GA1) y P8 (GA2) registradas')
  const r8 = await aplicar(sesionA, p8, p8.operaciones.map(confirmar))
  registrarAltas(r8, 'P8')
  verificar(r8.ok, '6b. P8 aplicada: Iván existe en GA2 (fuera de la foto de GA1)')
  const f6 = await foto(admin, docentes)
  const curp7 = opUnica(p7, 'correccion_curp', al.lalo)
  const nombre7 = opUnica(p7, 'correccion_nombre', al.elena)
  verificar(codigo(await aplicar(sesionA, p7, p7.operaciones.map(confirmar))) === 'NAME_DUPLICATE', '6c. P7 falla en su tercera operación (alta) con NAME_DUPLICATE')
  const f6b = await foto(admin, docentes)
  verificar(iguales(f6, f6b), '6d. Se revirtieron la CURP de Lalo, el nombre de Elena y sus correcciones')
  verificar((await aplicar(sesionA, p7, [confirmar(curp7), confirmar(nombre7)])).ok, '6e. Control: P7 seguía pendiente, con la misma foto y llaves sin consumir')
  const f6c = await foto(admin, docentes)
  verificar(
    filaAlumno(f6c, al.lalo)?.curp === CURP.lalo && filaAlumno(f6c, al.elena)?.nombre === 'Elena Maria Ruiz Soto' && nuevos(f6b.correcciones, f6c.correcciones).length === 2,
    '6f. Las dos correcciones se aplican una sola vez en el control'
  )

  // --- Aislamiento final ---------------------------------------------
  const fFinalB = await foto(admin, [B])
  verificar(iguales(fotoInicialB, fFinalB) && filaAlumno(fFinalB, al.omar)?.curp === CURP.ana, 'Z. Los datos del docente B quedaron intactos')
  console.log(`\nManifiesto: ${rutaManifiesto}`)
}

// ============================================================
// SQL de limpieza (solo se imprime)
// ============================================================

function limpiezaSql(ruta: string): string {
  const m = JSON.parse(readFileSync(ruta, 'utf8')) as Manifiesto
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  const lista = (v: string[]) => {
    if (v.some((x) => !uuid.test(x))) throw new Error('El manifiesto contiene un id que no es UUID.')
    // Arreglo, no IN (...): con una lista vacía, NOT IN (null) nunca es
    // verdadero y la barrera no se activaría.
    return `'{${v.join(',')}}'::uuid[]`
  }
  // La etiqueta y los correos entran como literales: solo se aceptan con
  // la forma exacta que genera el script.
  if (m.proyecto !== PROYECTO_E2E || !/^p4b-[0-9a-f]{8}$/.test(m.etiqueta)) throw new Error('El manifiesto no es de una corrida P4B en E2E.')
  const correos = Object.entries(m.correos)
  if (correos.some(([clave, correo]) => correo !== correoDocente(m.etiqueta, clave))) throw new Error('El manifiesto contiene un correo ajeno.')
  const D = lista(Object.values(m.docentes))
  const I = lista(m.instituciones)
  const CI = lista(m.ciclos)
  const AL = lista(Object.values(m.alumnos))
  const G = lista(Object.values(m.grupos))
  const C = lista(Object.values(m.conversaciones))
  const P = lista(Object.values(m.propuestas))
  const CO = `array[${correos.map(([, c]) => `'${c}'`).join(',')}]::text[]`
  const INST = `'${nombreInstitucion(m.etiqueta)}'`
  // Orden por FK: consumidas y correcciones (RESTRICT hacia alumnos y
  // conversaciones) → propuestas (CASCADE a operaciones) → inscripciones →
  // alumnos → conversaciones → docente_grupos (trigger) → grupos → ciclos →
  // perfiles → institución → auth.users. Cada delete exige además el
  // vínculo con los docentes del manifiesto.
  return `-- Limpieza LISTA-P4B — ${m.etiqueta} (${m.proyecto}). Revisar antes de ejecutar.
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
     or exists (select 1 from public.conversaciones_chat where docente_id = any(${D}) and id <> all(${C}))
     or exists (select 1 from public.alumnos where (docente_id = any(${D}) or institucion_id = any(${I})) and id <> all(${AL}))
     or exists (select 1 from public.alumnos where id = any(${AL}) and docente_id <> all(${D}))
     or exists (select 1 from public.inscripciones where (alumno_id = any(${AL}) or grupo_id = any(${G}) or ciclo_escolar_id = any(${CI}))
                  and not (alumno_id = any(${AL}) and grupo_id = any(${G})))
     or exists (select 1 from public.correcciones_alumno where (docente_id = any(${D}) or alumno_id = any(${AL})) and not (docente_id = any(${D}) and alumno_id = any(${AL})))
     or exists (select 1 from public.propuestas_correccion_consumidas where (docente_id = any(${D}) or alumno_id = any(${AL})) and not (docente_id = any(${D}) and alumno_id = any(${AL})))
     or exists (select 1 from public.propuestas_lista_oficial where docente_id = any(${D}) and propuesta_id <> all(${P})) then
    raise exception 'LIMPIEZA_ABORTADA: hay registros fuera del manifiesto.';
  end if;
end $$;
delete from public.propuestas_correccion_consumidas where alumno_id = any(${AL}) and docente_id = any(${D});
delete from public.correcciones_alumno where alumno_id = any(${AL}) and docente_id = any(${D});
delete from public.propuestas_lista_oficial where propuesta_id = any(${P}) and docente_id = any(${D});
delete from public.inscripciones where alumno_id = any(${AL}) and grupo_id = any(${G});
delete from public.alumnos where id = any(${AL}) and docente_id = any(${D});
delete from public.conversaciones_chat where id = any(${C}) and docente_id = any(${D});
delete from public.docente_grupos where grupo_id = any(${G}) and docente_id = any(${D});
delete from public.grupos where id = any(${G}) and docente_id = any(${D});
delete from public.ciclos_escolares where id = any(${CI}) and institucion_id = any(${I});
delete from public.perfiles_docentes where id = any(${D});
delete from public.instituciones where id = any(${I}) and nombre = ${INST};
delete from auth.users where id = any(${D}) and email = any(${CO});
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
  enSeco()
  if (args[0] === '--ejecutar') {
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
}

main().catch((e) => {
  console.error(`\n✗ ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
