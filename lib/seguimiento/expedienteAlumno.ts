// lib/seguimiento/expedienteAlumno.ts
//
// Hito 4a — expediente académico tipado (v1) sobre el contrato del
// historial (contratoHistorial.ts). Reúne, con separación estricta por
// inscripción, grupo, ciclo y periodo:
//   - resultados confirmados (el contrato v1, tal cual);
//   - asistencia CANÓNICA (asistencia_registro, por inscripción; la tabla
//     legada «asistencias» no se lee);
//   - incidencias del alumno en ESE grupo;
//   - observaciones reales (notas confirmadas, observaciones de la
//     inscripción y de los resultados);
//   - estado de atención (misma regla de siempre, con datos ya separados);
//   - faltantes (lo que no existe se declara, nunca se rellena: «sin
//     registros» no es 0);
//   - avisos SOLO para el docente (p. ej. CURP ≠ fecha de nacimiento): nunca
//     van al documento pedagógico.
// Determinista, serializable, sin IA ni escrituras. Válido para preescolar,
// primaria y secundaria (nada depende del grado o nivel).

import type { SupabaseClient } from '@supabase/supabase-js'
import { cargarHistorialAlumno, datosConcentradoGrupo } from './historialAcademico'
import { construirConcentradoGrupo, type FiltroHistorial } from './historialGrupo'
import { contratoAlumno, contratoGrupo, type HistorialAcademicoAlumnoV1, type HistorialAcademicoGrupoV1, type PeriodoContrato } from './contratoHistorial'

export const VERSION_EXPEDIENTE = 1 as const

// ------------------------------------------------------------------
// Reglas puras compartidas (ficha del alumno y expediente)
// ------------------------------------------------------------------
export type EstadoRegistroAsistencia = 'presente' | 'retardo' | 'falta' | 'justificada' | 'otro'
export const estadoDeRegistro = (estatus: string | null | undefined): EstadoRegistroAsistencia =>
  estatus === 'presente' || estatus === 'retardo' || estatus === 'falta' || estatus === 'justificada' ? estatus : 'otro'

// registros = 0 significa «sin registros»: el porcentaje es null, nunca 0 %.
export type ConteoAsistenciaExpediente = { registros: number; presentes: number; retardos: number; faltas: number; justificadas: number; otros: number; porcentajeAsistencia: number | null }
export function contarAsistencia(registros: { estatus: string | null }[]): ConteoAsistenciaExpediente {
  const c = { registros: registros.length, presentes: 0, retardos: 0, faltas: 0, justificadas: 0, otros: 0 }
  for (const r of registros) {
    const e = estadoDeRegistro(r.estatus)
    if (e === 'presente') c.presentes++
    else if (e === 'retardo') c.retardos++
    else if (e === 'falta') c.faltas++
    else if (e === 'justificada') c.justificadas++
    else c.otros++
  }
  // Asistió = presente o retardo (mismo criterio que calcularPorcentajeAsistencia).
  return { ...c, porcentajeAsistencia: c.registros ? Math.round(((c.presentes + c.retardos) / c.registros) * 100) : null }
}

// «Requiere atención» (regla de siempre: faltas > 20 % o una incidencia en
// los últimos 30 días), ahora SOLO con registros de la inscripción/grupo.
export type EstadoAtencion = { estado: 'sin_datos' | 'requiere_atencion' | 'al_corriente'; motivos: ('faltas' | 'incidencia_reciente')[]; tasaFaltas: number | null }
// Sin registros de asistencia NO es asistencia perfecta ni desempeño
// favorable: «sin datos» (salvo una incidencia reciente real, que sí se
// señala). Nunca «al corriente» sin registros.
export function estadoAtencion(asistencia: { estatus: string | null }[], incidencias: { fecha: string }[], hoy: string): EstadoAtencion {
  const limite = new Date(`${hoy}T12:00:00`)
  limite.setDate(limite.getDate() - 30)
  const desde = limite.toISOString().slice(0, 10)
  const reciente = incidencias.some((i) => i.fecha >= desde && i.fecha <= hoy)
  if (!asistencia.length) return reciente ? { estado: 'requiere_atencion', motivos: ['incidencia_reciente'], tasaFaltas: null } : { estado: 'sin_datos', motivos: [], tasaFaltas: null }
  const c = contarAsistencia(asistencia)
  const tasaFaltas = c.faltas / c.registros
  const motivos: EstadoAtencion['motivos'] = []
  if (tasaFaltas > 0.2) motivos.push('faltas')
  if (reciente) motivos.push('incidencia_reciente')
  return { estado: motivos.length ? 'requiere_atencion' : 'al_corriente', motivos, tasaFaltas }
}

// Vigencia de una inscripción (y de su ciclo, si tiene fechas): una
// incidencia cuenta solo si es de ESA inscripción (o no tiene inscripción
// registrada) y su fecha cae dentro de la vigencia.
export type Vigencia = { inscripcionId: string; desde: string | null; hasta: string | null; cicloInicio?: string | null; cicloFin?: string | null }
export function enVigencia(i: { fecha: string; inscripcionId?: string | null }, v: Vigencia): boolean {
  const f = i.fecha.slice(0, 10)
  if (i.inscripcionId && i.inscripcionId !== v.inscripcionId) return false
  if (v.desde && f < v.desde.slice(0, 10)) return false
  if (v.hasta && f > v.hasta.slice(0, 10)) return false
  if (v.cicloInicio && f < v.cicloInicio) return false
  if (v.cicloFin && f > v.cicloFin) return false
  return true
}

// Fecha de nacimiento codificada en la CURP (posiciones 5–10, AAMMDD; el
// carácter 17 indica el siglo: dígito = 1900, letra = 2000). null si la
// CURP no tiene un formato válido.
export function fechaNacimientoDeCurp(curp: string | null | undefined): string | null {
  const c = (curp ?? '').trim().toUpperCase()
  const m = c.match(/^[A-Z]{4}(\d{2})(\d{2})(\d{2})[HMX][A-Z]{5}([A-Z0-9])\d$/)
  if (!m) return null
  const anio = (/\d/.test(m[4]) ? 1900 : 2000) + Number(m[1])
  const fecha = `${anio}-${m[2]}-${m[3]}`
  const d = new Date(`${fecha}T12:00:00Z`)
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === fecha ? fecha : null
}

export type AvisoDocente =
  | { codigo: 'curp_fecha_nacimiento_distinta'; fechaRegistrada: string; fechaSegunCurp: string }

// Advertencia discreta para el docente; nunca modifica datos.
export function avisoIdentidad(curp: string | null | undefined, fechaNacimiento: string | null | undefined): AvisoDocente | null {
  const segunCurp = fechaNacimientoDeCurp(curp)
  if (!segunCurp || !fechaNacimiento || fechaNacimiento === segunCurp) return null
  return { codigo: 'curp_fecha_nacimiento_distinta', fechaRegistrada: fechaNacimiento, fechaSegunCurp: segunCurp }
}

// Periodos del ciclo; solo los que tienen ambas fechas delimitan registros.
export type PeriodoExpediente = PeriodoContrato & { fechaInicio: string | null; fechaFin: string | null; delimitado: boolean }
export type PeriodoReferencia = { id: string; nombre: string; numero_periodo: number; fecha_inicio: string | null; fecha_fin: string | null }
const aPeriodoExpediente = (p: PeriodoReferencia): PeriodoExpediente => ({ id: p.id, nombre: p.nombre, numero: p.numero_periodo, fechaInicio: p.fecha_inicio, fechaFin: p.fecha_fin, delimitado: !!(p.fecha_inicio && p.fecha_fin) })

// Único periodo delimitado que contiene la fecha; si ninguno o varios, null.
export function periodoDeFecha(fecha: string, periodos: PeriodoExpediente[]): PeriodoExpediente | null {
  const c = periodos.filter((p) => p.delimitado && p.fechaInicio! <= fecha && fecha <= p.fechaFin!)
  return c.length === 1 ? c[0] : null
}

// Reparte registros con fecha por periodo; los que no caen en un periodo
// delimitado van a «sin periodo» (null).
function porPeriodo<T extends { fecha: string }>(items: T[], periodos: PeriodoExpediente[]): { periodo: PeriodoContrato | null; items: T[] }[] {
  const grupos = new Map<string, { periodo: PeriodoContrato | null; items: T[] }>()
  for (const p of periodos) if (p.delimitado) grupos.set(p.id, { periodo: { id: p.id, nombre: p.nombre, numero: p.numero }, items: [] })
  for (const it of items) {
    const p = periodoDeFecha(it.fecha, periodos)
    const clave = p?.id ?? ''
    if (!grupos.has(clave)) grupos.set(clave, { periodo: null, items: [] })
    grupos.get(clave)!.items.push(it)
  }
  return [...grupos.values()].filter((g) => g.periodo || g.items.length).sort((a, b) => (a.periodo?.numero ?? Infinity) - (b.periodo?.numero ?? Infinity))
}

// ------------------------------------------------------------------
// Expediente individual
// ------------------------------------------------------------------
export type IncidenciaExpediente = { id: string; fecha: string; tipo: string | null; descripcion: string | null; periodoId: string | null }
export type ObservacionExpediente =
  | { origen: 'nota'; fecha: string; tipo: string | null; texto: string }
  | { origen: 'inscripcion'; texto: string }
  | { origen: 'resultado'; proyectoId: string; indicador: number; texto: string }

export type FaltanteExpediente =
  | { codigo: 'sin_resultados_confirmados' }
  | { codigo: 'sin_registros_asistencia' }
  | { codigo: 'sin_observaciones' }
  | { codigo: 'periodos_sin_fechas'; periodos: string[] }
  | { codigo: 'sin_periodos_registrados' }
  | { codigo: 'registros_fuera_de_periodo'; asistencia: number; incidencias: number }

export type ExpedienteAlumnoV1 = {
  version: typeof VERSION_EXPEDIENTE
  alcance: HistorialAcademicoAlumnoV1['alcance'] & { nivelEducativo: string | null; grado: string | null; grupo: string | null }
  alumno: { nombre: string; sexo: string | null; fechaNacimiento: string | null }
  periodos: PeriodoExpediente[]
  historial: HistorialAcademicoAlumnoV1
  asistencia: { total: ConteoAsistenciaExpediente; porPeriodo: { periodo: PeriodoContrato | null; conteo: ConteoAsistenciaExpediente }[] }
  incidencias: { total: number; items: IncidenciaExpediente[]; porPeriodo: { periodo: PeriodoContrato | null; total: number }[] }
  observaciones: ObservacionExpediente[]
  atencion: EstadoAtencion
  faltantes: FaltanteExpediente[]
  // Solo para el docente: nunca se trasladan al documento pedagógico.
  avisosDocente: AvisoDocente[]
}

export type EntradaExpedienteAlumno = {
  historial: HistorialAcademicoAlumnoV1
  alumno: { nombre: string; sexo: string | null; fechaNacimiento: string | null; curp: string | null }
  grupo: { nivelEducativo: string | null; grado: string | null; grupo: string | null }
  inscripcion: { observaciones: string | null; fechaInscripcion: string | null; fechaBaja: string | null; cicloInicio?: string | null; cicloFin?: string | null }
  periodos: PeriodoReferencia[]
  asistencia: { fecha: string; estatus: string | null }[]
  incidencias: { id: string; fecha: string; tipo: string | null; descripcion: string | null; inscripcionId?: string | null }[]
  notas: { fecha: string; tipo: string | null; contenido: string | null }[]
  hoy: string
}

function faltantesComunes(periodos: PeriodoExpediente[], asistenciaFuera: number, incidenciasFuera: number): FaltanteExpediente[] {
  const f: FaltanteExpediente[] = []
  if (!periodos.length) f.push({ codigo: 'sin_periodos_registrados' })
  const sinFechas = periodos.filter((p) => !p.delimitado).map((p) => p.nombre)
  if (sinFechas.length) f.push({ codigo: 'periodos_sin_fechas', periodos: sinFechas })
  if (asistenciaFuera || incidenciasFuera) f.push({ codigo: 'registros_fuera_de_periodo', asistencia: asistenciaFuera, incidencias: incidenciasFuera })
  return f
}

export function construirExpedienteAlumno(e: EntradaExpedienteAlumno): ExpedienteAlumnoV1 {
  const periodos = e.periodos.map(aPeriodoExpediente).sort((a, b) => a.numero - b.numero)
  const asistenciaOrdenada = e.asistencia.slice().sort((a, b) => a.fecha.localeCompare(b.fecha))
  const asisPorPeriodo = porPeriodo(asistenciaOrdenada, periodos)
  const vigencia: Vigencia = { inscripcionId: e.historial.alcance.inscripcionId, desde: e.inscripcion.fechaInscripcion, hasta: e.inscripcion.fechaBaja, cicloInicio: e.inscripcion.cicloInicio, cicloFin: e.inscripcion.cicloFin }
  const incidencias: IncidenciaExpediente[] = e.incidencias.filter((i) => enVigencia(i, vigencia)).sort((a, b) => a.fecha.localeCompare(b.fecha) || a.id.localeCompare(b.id))
    .map((i) => ({ id: i.id, fecha: i.fecha, tipo: i.tipo, descripcion: i.descripcion, periodoId: periodoDeFecha(i.fecha, periodos)?.id ?? null }))
  const incPorPeriodo = porPeriodo(incidencias, periodos)
  // Observaciones: solo texto real, sin inventar ni resumir.
  const observaciones: ObservacionExpediente[] = [
    ...e.notas.filter((n) => n.contenido?.trim() && enVigencia({ fecha: n.fecha }, vigencia))
      .sort((a, b) => a.fecha.localeCompare(b.fecha)).map((n) => ({ origen: 'nota' as const, fecha: n.fecha, tipo: n.tipo, texto: n.contenido!.trim() })),
    ...(e.inscripcion.observaciones?.trim() ? [{ origen: 'inscripcion' as const, texto: e.inscripcion.observaciones.trim() }] : []),
    ...e.historial.periodos.flatMap((g) => g.proyectos).flatMap((r) => (r.estado === 'con_resultados' ? r.indicadores.filter((i) => i.observacion).map((i) => ({ origen: 'resultado' as const, proyectoId: r.proyecto.proyectoId, indicador: i.numero, texto: i.observacion! })) : [])),
  ]
  const fuera = (g: { periodo: PeriodoContrato | null; items: unknown[] }[]) => g.filter((x) => !x.periodo).reduce((s, x) => s + x.items.length, 0)
  const faltantes: FaltanteExpediente[] = [
    ...(e.historial.resumen.proyectosConResultados ? [] : [{ codigo: 'sin_resultados_confirmados' as const }]),
    ...(asistenciaOrdenada.length ? [] : [{ codigo: 'sin_registros_asistencia' as const }]),
    ...(observaciones.length ? [] : [{ codigo: 'sin_observaciones' as const }]),
    ...faltantesComunes(periodos, periodos.some((p) => p.delimitado) ? fuera(asisPorPeriodo) : 0, periodos.some((p) => p.delimitado) ? fuera(incPorPeriodo) : 0),
  ]
  const aviso = avisoIdentidad(e.alumno.curp, e.alumno.fechaNacimiento)
  return {
    version: VERSION_EXPEDIENTE,
    alcance: { ...e.historial.alcance, nivelEducativo: e.grupo.nivelEducativo, grado: e.grupo.grado, grupo: e.grupo.grupo },
    alumno: { nombre: e.alumno.nombre, sexo: e.alumno.sexo, fechaNacimiento: e.alumno.fechaNacimiento },
    periodos,
    historial: e.historial,
    asistencia: { total: contarAsistencia(asistenciaOrdenada), porPeriodo: asisPorPeriodo.map((g) => ({ periodo: g.periodo, conteo: contarAsistencia(g.items) })) },
    incidencias: { total: incidencias.length, items: incidencias, porPeriodo: incPorPeriodo.map((g) => ({ periodo: g.periodo, total: g.items.length })) },
    observaciones,
    atencion: estadoAtencion(asistenciaOrdenada, incidencias, e.hoy),
    faltantes,
    avisosDocente: aviso ? [aviso] : [],
  }
}

// ------------------------------------------------------------------
// Expediente grupal (reportes trimestrales)
// ------------------------------------------------------------------
export type AlumnoEnExpedienteGrupo = {
  alumnoId: string
  inscripcionId: string
  asistencia: { total: ConteoAsistenciaExpediente; porPeriodo: { periodo: PeriodoContrato | null; conteo: ConteoAsistenciaExpediente }[] }
  incidencias: number
  atencion: EstadoAtencion
}
export type ExpedienteGrupoV1 = {
  version: typeof VERSION_EXPEDIENTE
  periodos: PeriodoExpediente[]
  historial: HistorialAcademicoGrupoV1
  alumnos: AlumnoEnExpedienteGrupo[]
  asistencia: ConteoAsistenciaExpediente
  incidencias: number
  faltantes: FaltanteExpediente[]
}

export function construirExpedienteGrupo(e: {
  historial: HistorialAcademicoGrupoV1
  periodos: PeriodoReferencia[]
  // Vigencia de cada inscripción del grupo (fechas de alta/baja).
  vigencias: Vigencia[]
  asistencia: { inscripcionId: string; fecha: string; estatus: string | null }[]
  incidencias: { alumnoId: string; fecha: string; inscripcionId?: string | null }[]
  hoy: string
}): ExpedienteGrupoV1 {
  const periodos = e.periodos.map(aPeriodoExpediente).sort((a, b) => a.numero - b.numero)
  const vigenciaDe = new Map(e.vigencias.map((v) => [v.inscripcionId, v]))
  const incidenciasValidas: { alumnoId: string; fecha: string }[] = []
  const alumnos = e.historial.alumnos.map((a) => {
    const asis = e.asistencia.filter((r) => r.inscripcionId === a.inscripcionId).sort((x, y) => x.fecha.localeCompare(y.fecha))
    const v = vigenciaDe.get(a.inscripcionId) ?? { inscripcionId: a.inscripcionId, desde: null, hasta: null }
    const inc = e.incidencias.filter((i) => i.alumnoId === a.alumnoId && enVigencia(i, v))
    incidenciasValidas.push(...inc)
    return {
      alumnoId: a.alumnoId,
      inscripcionId: a.inscripcionId,
      asistencia: { total: contarAsistencia(asis), porPeriodo: porPeriodo(asis, periodos).map((g) => ({ periodo: g.periodo, conteo: contarAsistencia(g.items) })) },
      incidencias: inc.length,
      atencion: estadoAtencion(asis, inc, e.hoy),
    }
  })
  const delimitado = periodos.some((p) => p.delimitado)
  const asisFuera = delimitado ? e.asistencia.filter((r) => !periodoDeFecha(r.fecha, periodos)).length : 0
  const incFuera = delimitado ? incidenciasValidas.filter((i) => !periodoDeFecha(i.fecha, periodos)).length : 0
  return {
    version: VERSION_EXPEDIENTE,
    periodos,
    historial: e.historial,
    alumnos,
    asistencia: contarAsistencia(e.asistencia),
    incidencias: incidenciasValidas.length,
    faltantes: [
      ...(e.historial.resumen.proyectos ? [] : [{ codigo: 'sin_resultados_confirmados' as const }]),
      ...(e.asistencia.length ? [] : [{ codigo: 'sin_registros_asistencia' as const }]),
      ...faltantesComunes(periodos, asisFuera, incFuera),
    ],
  }
}

// ------------------------------------------------------------------
// Obtención (reutiliza las lecturas existentes; 2 rondas paralelas)
// ------------------------------------------------------------------
type FilaDetalle = {
  observaciones: string | null; fecha_inscripcion: string | null; fecha_baja: string | null
  alumnos: { nombre: string | null; sexo: string | null; fecha_nacimiento: string | null; curp: string | null } | null
  grupos: { grado: string | null; grupo: string | null; nivel_educativo: string | null } | null
  ciclos_escolares: { fecha_inicio: string | null; fecha_fin: string | null } | null
}

export async function obtenerExpedienteAlumno(sb: SupabaseClient, alumnoId: string, docenteId: string, grupoId: string, cicloEscolarId: string, hoy: string): Promise<ExpedienteAlumnoV1 | null> {
  const [cargado, detalle, asistencia, incidencias, notas] = await Promise.all([
    cargarHistorialAlumno(sb, alumnoId, docenteId),
    // Inscripción del grupo y ciclo (propiedad por el grupo del docente).
    sb.from('inscripciones')
      .select('observaciones, fecha_inscripcion, fecha_baja, alumnos(nombre, sexo, fecha_nacimiento, curp), grupos!inner(grado, grupo, nivel_educativo, docente_id), ciclos_escolares(fecha_inicio, fecha_fin)')
      .eq('alumno_id', alumnoId).eq('grupo_id', grupoId).eq('ciclo_escolar_id', cicloEscolarId).eq('grupos.docente_id', docenteId)
      .maybeSingle(),
    // Asistencia canónica de ESA inscripción (nunca la tabla legada).
    sb.from('asistencia_registro')
      .select('fecha, estatus, inscripciones!inner(alumno_id, grupo_id, ciclo_escolar_id)')
      .eq('inscripciones.alumno_id', alumnoId).eq('inscripciones.grupo_id', grupoId).eq('inscripciones.ciclo_escolar_id', cicloEscolarId),
    // Incidencias del alumno en ESE grupo (el grupo pertenece a un ciclo).
    sb.from('incidencias').select('id, fecha, tipo, descripcion, inscripcion_id').eq('alumno_id', alumnoId).eq('grupo_id', grupoId),
    sb.from('perfil_alumno_notas').select('fecha, tipo, contenido').eq('alumno_id', alumnoId).eq('docente_id', docenteId).eq('estado', 'confirmado'),
  ])
  for (const r of [detalle, asistencia, incidencias, notas]) if (r.error) throw r.error
  const det = detalle.data as FilaDetalle | null
  const historial = contratoAlumno(cargado.historial, alumnoId, grupoId, cicloEscolarId)
  if (!det || !historial) return null
  return construirExpedienteAlumno({
    historial,
    alumno: { nombre: det.alumnos?.nombre ?? 'Alumno', sexo: det.alumnos?.sexo ?? null, fechaNacimiento: det.alumnos?.fecha_nacimiento ?? null, curp: det.alumnos?.curp ?? null },
    grupo: { nivelEducativo: det.grupos?.nivel_educativo ?? null, grado: det.grupos?.grado ?? null, grupo: det.grupos?.grupo ?? null },
    inscripcion: { observaciones: det.observaciones, fechaInscripcion: det.fecha_inscripcion, fechaBaja: det.fecha_baja, cicloInicio: det.ciclos_escolares?.fecha_inicio ?? null, cicloFin: det.ciclos_escolares?.fecha_fin ?? null },
    periodos: cargado.periodos.filter((p) => p.ciclo_escolar_id === cicloEscolarId),
    asistencia: (asistencia.data ?? []) as { fecha: string; estatus: string | null }[],
    incidencias: ((incidencias.data ?? []) as { id: string; fecha: string; tipo: string | null; descripcion: string | null; inscripcion_id: string | null }[]).map((i) => ({ id: i.id, fecha: i.fecha, tipo: i.tipo, descripcion: i.descripcion, inscripcionId: i.inscripcion_id })),
    notas: (notas.data ?? []) as EntradaExpedienteAlumno['notas'],
    hoy,
  })
}

export async function obtenerExpedienteGrupo(sb: SupabaseClient, alcance: { grupoId: string; grupoNombre: string | null; cicloEscolarId: string }, hoy: string, filtro: FiltroHistorial = {}): Promise<ExpedienteGrupoV1> {
  const [d, asistencia, incidencias] = await Promise.all([
    datosConcentradoGrupo(sb, alcance.grupoId, alcance.cicloEscolarId),
    sb.from('asistencia_registro')
      .select('inscripcion_id, fecha, estatus, inscripciones!inner(grupo_id, ciclo_escolar_id)')
      .eq('inscripciones.grupo_id', alcance.grupoId).eq('inscripciones.ciclo_escolar_id', alcance.cicloEscolarId),
    sb.from('incidencias').select('alumno_id, fecha, inscripcion_id').eq('grupo_id', alcance.grupoId),
  ])
  if (asistencia.error) throw asistencia.error
  if (incidencias.error) throw incidencias.error
  return construirExpedienteGrupo({
    historial: contratoGrupo(construirConcentradoGrupo(d.historial, d.inscripciones, filtro), { ...alcance, filtro }),
    periodos: d.periodos,
    vigencias: d.inscripciones.map((i) => ({ inscripcionId: i.inscripcionId, desde: i.fechaInscripcion ?? null, hasta: i.fechaBaja ?? null })),
    asistencia: ((asistencia.data ?? []) as { inscripcion_id: string; fecha: string; estatus: string | null }[]).map((r) => ({ inscripcionId: r.inscripcion_id, fecha: r.fecha, estatus: r.estatus })),
    incidencias: ((incidencias.data ?? []) as { alumno_id: string; fecha: string; inscripcion_id: string | null }[]).map((i) => ({ alumnoId: i.alumno_id, fecha: i.fecha, inscripcionId: i.inscripcion_id })),
    hoy,
  })
}
