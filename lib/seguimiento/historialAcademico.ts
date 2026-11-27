// lib/seguimiento/historialAcademico.ts
//
// Hito 3 — lectura del historial académico (server-side) con el MISMO
// modelo para el concentrado grupal, la ficha individual, el Chat IA y
// los reportes: resultados confirmados (seguimiento_resultados, fuente
// canónica) + periodos del ciclo, en exactamente 2 consultas (nunca una
// por proyecto o por alumno), reorganizados por construirHistorialGrupo().
// 0 IA. Un error de consulta se relanza: nunca se confunde con "sin datos".

import type { SupabaseClient } from '@supabase/supabase-js'
import { periodosEvaluacionDeCiclos, resultadosProyectoAlumno, resultadosProyectoGrupo } from '../motorContexto'
import { construirHistorialGrupo, type FiltroHistorial, type HistorialGrupo } from './historialGrupo'

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
