// scripts/verificar-grupo-conversacion.ts
//
// El grupo fijado de la conversación del Chat (conversaciones_chat.grupo_id)
// es el grupo efectivo de toda la sesión (lib/sesionContexto.ts) cuando
// existe y sigue autorizado; si ya no es válido, la sesión queda sin grupo
// (nunca otro); conversación no autorizada o error de lectura: sin grupo;
// sin conversación, sin grupo fijado o antigua: la resolución normal
// (lib/grupoActivo.ts). La lectura del vínculo es de solo lectura
// (lib/vinculoConversacion.ts). Base en memoria; sin red ni credenciales.
//
// Se ejecuta con `npx tsx scripts/verificar-grupo-conversacion.ts`.

import { readFileSync } from 'node:fs'
import { leerVinculoConversacion, type VinculoConversacion } from '../lib/vinculoConversacion'
import { obtenerSesionContexto, mensajeGrupoNoDisponible } from '../lib/sesionContexto'
import { resolverGrupoActivo } from '../lib/grupoActivo'
import { aprobarBorradorPlaneacion } from '../lib/planeacion/aprobarBorrador'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

type Fila = Record<string, unknown>
const DOC = 'doc-a', OTRO = 'doc-b'
const ciclos: Record<string, boolean> = { 'ciclo-activo': true, 'ciclo-viejo': false }
const grupo = (id: string, docente: string, ciclo: string, creado: string): Fila => ({ id, nombre_grupo: id, institucion_id: `inst-${id}`, docente_id: docente, ciclo_escolar_id: ciclo, creado_en: creado })
const G_ACTIVO = grupo('g-activo', DOC, 'ciclo-activo', '2026-10-01T00:00:00Z') // contexto y más reciente
const G_FIJADO = grupo('g-fijado', DOC, 'ciclo-activo', '2026-08-01T00:00:00Z') // autorizado, distinto
const G_VIEJO = grupo('g-viejo', DOC, 'ciclo-viejo', '2025-08-01T00:00:00Z')
const G_AJENO = grupo('g-ajeno', OTRO, 'ciclo-activo', '2026-09-01T00:00:00Z')
const inscripcion = (grupoId: string, alumno: string, nombre: string, n: number): Fila => ({ grupo_id: grupoId, estatus: 'activo', alumno_id: alumno, numero_lista: n, alumnos: { nombre, sexo: 'M' } })
const conversacion = (id: string, version: number | null, grupoId: string | null, docente = DOC): Fila => ({ id, docente_id: docente, grupo_contexto_version: version, grupo_id: grupoId })

let falla: string | null = null
const efectos: string[] = []
const lecturas: string[] = []
const db: Record<string, Fila[]> = {
  grupos: [G_ACTIVO, G_FIJADO, G_VIEJO, G_AJENO],
  docente_contexto_activo: [{ docente_id: DOC, grupo_id: 'g-activo', ciclo_escolar_id: 'ciclo-activo' }],
  inscripciones: [inscripcion('g-activo', 'alu-activo', 'Ana Activo', 1), inscripcion('g-fijado', 'alu-fijado', 'Fer Fijado', 1)],
  // RLS: la conversación de otro docente no se devuelve (ver consulta()).
  conversaciones_chat: [
    conversacion('c-igual', 1, 'g-activo'), conversacion('c-fijada', 1, 'g-fijado'), conversacion('c-ajeno', 1, 'g-ajeno'),
    conversacion('c-vieja', 1, 'g-viejo'), conversacion('c-sin-grupo', 1, null), conversacion('c-antigua', null, null),
    conversacion('c-de-otro', 1, 'g-ajeno', OTRO),
  ],
}

function consulta(tabla: string) {
  lecturas.push(tabla)
  const filtros: ((f: Fila) => boolean)[] = []
  const ordenes: [string, boolean][] = []
  let limite = Infinity
  const valor = (f: Fila, c: string) => { const [a, b] = c.split('.'); return b ? (f[a] as Fila | undefined)?.[b] : f[a] }
  const filas = () => {
    let base = (db[tabla] ?? []).map((f) => (tabla === 'grupos' ? { ...f, ciclos_escolares: { activo: ciclos[f.ciclo_escolar_id as string] } } : f))
    if (tabla === 'conversaciones_chat') base = base.filter((f) => f.docente_id === DOC)
    const r = base.filter((f) => filtros.every((p) => p(f)))
    r.sort((a, b) => { for (const [c, asc] of ordenes) { const x = String(a[c]), y = String(b[c]); if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1) } return 0 })
    return r.slice(0, limite)
  }
  const resultado = () => (falla === tabla ? { data: null, error: { code: 'XX000' } } : { data: filas(), error: null })
  const b: Record<string, unknown> = {
    select: () => b,
    eq: (c: string, v: unknown) => { filtros.push((f) => valor(f, c) === v); return b },
    order: (c: string, o: { ascending: boolean }) => { ordenes.push([c, o.ascending]); return b },
    limit: (n: number) => { limite = n; return b },
    maybeSingle: async () => { const r = resultado(); return r.error ? r : { data: (r.data as Fila[])[0] ?? null, error: null } },
    then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(resultado()).then(ok, ko),
  }
  for (const m of ['insert', 'update', 'upsert', 'delete']) b[m] = () => { efectos.push(`${tabla}.${m}`); return b }
  return b
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = { from: (t: string) => consulta(t), rpc: (nombre: string) => { efectos.push(`rpc ${nombre}`); return Promise.resolve({ error: null }) } } as any

async function sesionCon(conversacionId: string | null) {
  const vinculo = await leerVinculoConversacion(sb, conversacionId)
  return { vinculo, sesion: await obtenerSesionContexto(sb, DOC, 'America/Mexico_City', vinculo) }
}

async function main() {
  // 1. Lectura del vínculo (solo lectura).
  const estados: [string | null, VinculoConversacion['estado']][] = [
    [null, 'sin_conversacion'], ['c-fijada', 'con_grupo'], ['c-sin-grupo', 'sin_grupo'], ['c-antigua', 'antigua'], ['c-de-otro', 'no_autorizada'], ['c-inexistente', 'no_autorizada'],
  ]
  for (const [id, esperado] of estados) verificar((await leerVinculoConversacion(sb, id)).estado === esperado, `1. Vínculo ${id ?? '(sin conversacionId)'} → ${esperado}`)
  falla = 'conversaciones_chat'
  verificar((await leerVinculoConversacion(sb, 'c-fijada')).estado === 'error', '1. Error de lectura del vínculo → error')
  falla = null

  // 2. Grupo efectivo de la sesión.
  let r = await sesionCon('c-igual')
  verificar(r.sesion.grupo_activo_id === 'g-activo' && !r.sesion.grupo_no_disponible, '2a. Grupo fijado igual al activo → g-activo')

  r = await sesionCon('c-fijada')
  verificar(r.sesion.grupo_activo_id === 'g-fijado' && r.sesion.institucion_id === 'inst-g-fijado' && r.sesion.ciclo_escolar_id === 'ciclo-activo', '2b. Grupo fijado distinto pero autorizado → toda la sesión usa g-fijado (grupo, institución y ciclo)')
  verificar(r.sesion.alumnos_del_grupo_activo.map((a) => a.alumno_id).join() === 'alu-fijado', '2c. Resolución de alumnos: solo los alumnos del grupo fijado, no los del activo')
  const activoGeneral = await resolverGrupoActivo(sb, DOC)
  verificar(activoGeneral.ok && activoGeneral.grupo.id === 'g-activo', '2d. El grupo activo general (Lista/Evaluación) sigue siendo g-activo')

  for (const [id, etiqueta] of [['c-ajeno', 'ajeno'], ['c-vieja', 'de ciclo inactivo']] as const) {
    lecturas.length = 0
    r = await sesionCon(id)
    verificar(r.sesion.grupo_activo_id === null && r.sesion.alumnos_del_grupo_activo.length === 0 && r.sesion.grupo_no_disponible === 'grupo_fijado_no_valido', `2e. Grupo fijado ${etiqueta} → sesión SIN grupo (motivo grupo_fijado_no_valido), nunca g-activo`)
    verificar(lecturas.filter((t) => t === 'grupos').length === 1 && !lecturas.includes('docente_contexto_activo'), `2f. Grupo fijado ${etiqueta}: una sola validación, sin fallback al contexto ni al más reciente`)
  }

  r = await sesionCon('c-sin-grupo')
  verificar(r.sesion.grupo_activo_id === 'g-activo' && !r.sesion.grupo_no_disponible, '2g. Conversación sin grupo fijado → resolución normal (g-activo)')
  r = await sesionCon('c-antigua')
  verificar(r.sesion.grupo_activo_id === 'g-activo' && !r.sesion.grupo_no_disponible, '2h. Conversación antigua → resolución normal (g-activo)')
  r = await sesionCon(null)
  verificar(r.sesion.grupo_activo_id === 'g-activo' && !r.sesion.grupo_no_disponible, '2i. Solicitud sin conversacionId → resolución normal (g-activo)')

  lecturas.length = 0
  r = await sesionCon('c-de-otro')
  verificar(r.sesion.grupo_activo_id === null && r.sesion.grupo_no_disponible === 'conversacion_no_autorizada' && !lecturas.includes('grupos'), '2j. Conversación no autorizada → sin grupo, sin consultar ningún grupo')
  falla = 'conversaciones_chat'
  r = await sesionCon('c-fijada')
  falla = null
  verificar(r.sesion.grupo_activo_id === null && r.sesion.grupo_no_disponible === 'error_vinculo', '2k. Error al leer el vínculo → sin grupo (error_vinculo), sin fallback')
  falla = 'grupos'
  const vFijado = await leerVinculoConversacion(sb, 'c-fijada')
  const sesionErrorGrupo = await obtenerSesionContexto(sb, DOC, null, vFijado)
  falla = null
  verificar(sesionErrorGrupo.grupo_activo_id === null && sesionErrorGrupo.grupo_no_disponible === 'error_vinculo', '2l. Error al validar el grupo fijado → sin grupo, sin fallback')

  // 3. Mensajes breves al docente.
  for (const motivo of ['grupo_fijado_no_valido', 'conversacion_no_autorizada', 'error_vinculo'] as const) {
    const m = mensajeGrupoNoDisponible({ grupo_no_disponible: motivo })
    verificar(!!m && m.length < 260, `3a. Mensaje específico y breve para ${motivo}`)
  }
  verificar(mensajeGrupoNoDisponible({}) === null, '3b. Sin motivo (sin grupo "normal"): se conservan los mensajes de siempre')

  // 4. Aprobación de planeación: sin grupo válido no guarda nada; con el
  //    grupo fijado guarda en ese grupo (aprobarBorrador usa sesion.grupo_activo_id).
  efectos.length = 0
  r = await sesionCon('c-vieja')
  const aprobacion = await aprobarBorradorPlaneacion(sb, r.sesion, [], 'Apruébala')
  verificar(!aprobacion.ok && aprobacion.codigo === 'GRUPO_NO_DISPONIBLE' && aprobacion.mensaje === mensajeGrupoNoDisponible(r.sesion) && efectos.length === 0, '4a. Aprobación con grupo fijado no válido: no guarda y responde el mensaje específico')
  const aprobar = readFileSync('lib/planeacion/aprobarBorrador.ts', 'utf8')
  verificar(/grupo_id: sesion\.grupo_activo_id/.test(aprobar) && !/resolverGrupoActivo|docente_contexto_activo/.test(aprobar), '4b. aprobarBorrador guarda en sesion.grupo_activo_id (el grupo fijado) y no resuelve el grupo por su cuenta')

  // 5. /api/chat: un único punto (sesión) y la misma lectura para Lista Oficial.
  const ruta = readFileSync('app/api/chat/route.ts', 'utf8')
  verificar((ruta.match(/leerVinculoConversacion\(/g) ?? []).length === 1, '5a. /api/chat lee el vínculo una sola vez por turno')
  verificar(/obtenerSesionContexto\(supabaseUser, userId, zonaHoraria, await vinculoConversacionPromise\)/.test(ruta), '5b. La sesión se construye con el vínculo de la conversación')
  verificar(/const vinculo = await vinculoConversacionPromise/.test(ruta) && (ruta.match(/rpc\('fijar_grupo_conversacion'/g) ?? []).length === 1 && /if \(vinculo\.estado !== 'sin_grupo'\) return null/.test(ruta), '5c. Lista Oficial reutiliza la misma lectura y solo pide fijar cuando no hay grupo fijado (como antes)')
  verificar(/escribirAsistencia\(supabaseUser, \[\{ alumno_id: alumnoId, estado \}\], sesion\.fecha_actual, sesion\.grupo_activo_id\)/.test(ruta) && /registrarAsistenciaMasiva\(supabaseUser, sesion\.grupo_activo_id/.test(ruta), '5d. Asistencia individual y masiva escriben en sesion.grupo_activo_id (el grupo efectivo)')
  verificar(/sesion\?\.grupo_activo_id\s*\n?\s*\? await ejecutarRegistroEscolar/.test(ruta), '5e. Registro escolar no se ejecuta sin grupo en la sesión')

  // 6. La resolución del contexto no escribe nada ni llama RPC.
  efectos.length = 0
  for (const id of [null, 'c-igual', 'c-fijada', 'c-ajeno', 'c-sin-grupo', 'c-antigua', 'c-de-otro']) await sesionCon(id)
  verificar(efectos.length === 0, '6. Vínculo + sesión en todos los casos: 0 escrituras y 0 RPC (fijar_grupo_conversacion no se invoca)')

  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
    process.exit(0)
  }
}

main()
