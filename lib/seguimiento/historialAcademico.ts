// lib/seguimiento/historialAcademico.ts
//
// Hito 3 — lectura del historial académico (server-side) con el MISMO
// modelo para el concentrado grupal, la ficha individual, el Chat IA y
// los reportes: resultados confirmados (seguimiento_resultados, fuente
// canónica) + periodos del ciclo, en exactamente 2 consultas (nunca una
// por proyecto o por alumno), reorganizados por construirHistorialGrupo().
// 0 IA. Un error de consulta se relanza: nunca se confunde con "sin datos".

import type { SupabaseClient } from '@supabase/supabase-js'
import { periodosEvaluacionDeCiclos, resultadosProyectoAlumno, resultadosProyectoGrupo, type ProyectoDeResultado } from '../motorContexto'
import { construirHistorialGrupo, metadataDeProyecto, organizarHistorialAlumno, type FiltroHistorial, type HistorialAlumno, type HistorialGrupo, type InscripcionDelGrupo, type InscripcionHistorial } from './historialGrupo'

// Grupo + ciclo (el grupo ya verificado como del docente por quien llama).
export async function historialAcademicoGrupo(sb: SupabaseClient, grupoId: string, cicloEscolarId: string, filtro: FiltroHistorial = {}): Promise<HistorialGrupo> {
  const [filas, periodos] = await Promise.all([
    resultadosProyectoGrupo(sb, grupoId, cicloEscolarId),
    periodosEvaluacionDeCiclos(sb, [cicloEscolarId]),
  ])
  return construirHistorialGrupo(filas, periodos, filtro)
}

// Alumno: todas sus inscripciones con este docente (cada una con su grupo
// y ciclo); los periodos de esos ciclos en una sola consulta.
export async function historialAcademicoAlumno(sb: SupabaseClient, alumnoId: string, docenteId: string, filtro: FiltroHistorial = {}): Promise<HistorialGrupo> {
  const filas = await resultadosProyectoAlumno(sb, alumnoId, docenteId)
  const ciclos = filas.map((f) => f.proyectos_seguimiento?.ciclo_escolar_id).filter((c): c is string => !!c)
  const periodos = await periodosEvaluacionDeCiclos(sb, ciclos)
  return construirHistorialGrupo(filas, periodos, filtro)
}

// Historial individual completo para la ficha (Hito 3b): inscripciones del
// alumno en grupos de ESTE docente (la propiedad se toma del grupo:
// inscripciones.docente_id no siempre está poblado) + sus resultados
// confirmados; luego periodos de sus ciclos + proyectos confirmados de sus
// grupos (para «sin registro»). 4 consultas en 2 rondas paralelas, nunca
// una por proyecto.
type FilaInscripcion = {
  id: string; grupo_id: string; ciclo_escolar_id: string; estatus: string | null; fecha_inscripcion: string | null
  grupos: { grado: string | null; grupo: string | null; nombre_grupo: string | null } | null
  ciclos_escolares: { nombre: string | null } | null
}
export async function historialAlumnoCompleto(sb: SupabaseClient, alumnoId: string, docenteId: string): Promise<HistorialAlumno> {
  return (await cargarHistorialAlumno(sb, alumnoId, docenteId)).historial
}

// Igual que historialAlumnoCompleto, pero devuelve además los periodos de
// sus ciclos (ya consultados) para el expediente (Hito 4a): sin repetir la
// consulta de periodos.
export async function cargarHistorialAlumno(sb: SupabaseClient, alumnoId: string, docenteId: string) {
  const [{ data: insData, error: insError }, filas] = await Promise.all([
    sb.from('inscripciones')
      .select('id, grupo_id, ciclo_escolar_id, estatus, fecha_inscripcion, grupos!inner(grado, grupo, nombre_grupo, docente_id), ciclos_escolares(nombre)')
      .eq('alumno_id', alumnoId)
      .eq('grupos.docente_id', docenteId),
    resultadosProyectoAlumno(sb, alumnoId, docenteId),
  ])
  if (insError) throw insError
  const inscripciones: InscripcionHistorial[] = ((insData ?? []) as unknown as FilaInscripcion[]).map((i) => ({
    inscripcionId: i.id,
    grupoId: i.grupo_id,
    cicloEscolarId: i.ciclo_escolar_id,
    estatus: i.estatus,
    fechaInscripcion: i.fecha_inscripcion,
    grupoNombre: i.grupos ? (i.grupos.grado ? `${i.grupos.grado}° ${i.grupos.grupo ?? ''}`.trim() : i.grupos.nombre_grupo) : null,
    cicloNombre: i.ciclos_escolares?.nombre ?? null,
  }))
  const ciclos = [...inscripciones.map((i) => i.cicloEscolarId), ...filas.map((f) => f.proyectos_seguimiento?.ciclo_escolar_id ?? '')]
  const grupos = [...new Set(inscripciones.map((i) => i.grupoId))]
  const [periodos, proyectos] = await Promise.all([
    periodosEvaluacionDeCiclos(sb, ciclos),
    grupos.length
      ? sb.from('proyectos_seguimiento')
          .select('id, nombre, docente_id, grupo_id, ciclo_escolar_id, periodo_evaluacion_id, campos_formativos, fecha_inicio, fecha_fin, origen_resultados, confirmado_en')
          .eq('docente_id', docenteId)
          .in('grupo_id', grupos)
          .not('confirmado_en', 'is', null)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (proyectos.error) throw proyectos.error
  const deSusGrupos = ((proyectos.data ?? []) as (ProyectoDeResultado & { id: string })[]).map((p) => metadataDeProyecto(p.id, p, periodos))
  return { historial: organizarHistorialAlumno(construirHistorialGrupo(filas, periodos), inscripciones, deSusGrupos), periodos }
}

// Inscripciones del grupo en el ciclo (todas, con su estatus y el nombre
// del alumno) para el concentrado: nombres y «sin registro». Una consulta.
export async function inscripcionesDelGrupo(sb: SupabaseClient, grupoId: string, cicloEscolarId: string): Promise<InscripcionDelGrupo[]> {
  const { data, error } = await sb
    .from('inscripciones')
    .select('id, alumno_id, estatus, fecha_inscripcion, fecha_baja, alumnos(nombre)')
    .eq('grupo_id', grupoId)
    .eq('ciclo_escolar_id', cicloEscolarId)
  if (error) throw error
  return ((data ?? []) as unknown as { id: string; alumno_id: string; estatus: string | null; fecha_inscripcion: string | null; fecha_baja: string | null; alumnos: { nombre: string | null } | null }[])
    .map((i) => ({ inscripcionId: i.id, alumnoId: i.alumno_id, nombre: i.alumnos?.nombre ?? 'Alumno sin nombre registrado', estatus: i.estatus, fechaInscripcion: i.fecha_inscripcion, fechaBaja: i.fecha_baja }))
}

// Datos del concentrado para el Chat IA (Hito 3d): resultados, periodos
// del ciclo e inscripciones del grupo en 3 consultas paralelas; los
// periodos se devuelven completos para leer «primer trimestre», etc.
export async function datosConcentradoGrupo(sb: SupabaseClient, grupoId: string, cicloEscolarId: string) {
  const [filas, periodos, inscripciones] = await Promise.all([
    resultadosProyectoGrupo(sb, grupoId, cicloEscolarId),
    periodosEvaluacionDeCiclos(sb, [cicloEscolarId]),
    inscripcionesDelGrupo(sb, grupoId, cicloEscolarId),
  ])
  return { historial: construirHistorialGrupo(filas, periodos), periodos, inscripciones }
}
