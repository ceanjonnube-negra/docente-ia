// lib/listaFiltrada.ts
// Fuente única de verdad para los 5 filtros de Lista (todos / ninas /
// ninos / presentes / ausentes) — ver "ventana contextual de Lista
// filtrada desde el Chat IA". Lista completa (app/dashboard/lista/
// page.tsx) y la sheet del Chat IA (VentanaListaFiltrada) comparten
// esta misma lógica; ninguna de las dos mantiene una copia paralela
// de estos criterios.

import type { SupabaseClient } from '@supabase/supabase-js'
import { clasificarEstadoAsistencia, type EstadoAsistenciaOficial } from './motorContexto'

export type FiltroLista = 'todos' | 'ninas' | 'ninos' | 'presentes' | 'ausentes'

// Único lugar que decide quién pertenece a cada filtro. Semántica
// EXACTA de siempre (ver auditoría previa, app/dashboard/lista/
// page.tsx):
//   ninas      -> sexo === 'M'
//   ninos      -> sexo === 'H'
//   presentes  -> estado === 'presente'
//   ausentes   -> estado === 'falta'  (retardo y sin_registrar NUNCA
//                 cuentan como ausente)
//   todos      -> sin filtro
// No se cambia ningún significado existente.
export function filtrarAlumnosPorCriterio<T extends { id: string; sexo: string | null }>(
  alumnos: T[],
  estados: Record<string, EstadoAsistenciaOficial>,
  filtro: FiltroLista
): T[] {
  return alumnos.filter((a) => {
    if (filtro === 'ninas' && a.sexo !== 'M') return false
    if (filtro === 'ninos' && a.sexo !== 'H') return false
    if (filtro === 'presentes' && estados[a.id] !== 'presente') return false
    if (filtro === 'ausentes' && estados[a.id] !== 'falta') return false
    return true
  })
}

// Carga los estados de asistencia de HOY para un conjunto de alumnos
// — mismo patrón de consulta y misma clasificación
// (clasificarEstadoAsistencia, lib/motorContexto.ts) que ya usa Lista
// para calcular estadoHoy: trae el historial de asistencia_registro
// para esas inscripciones y filtra fecha===hoy en el cliente.
// Deliberadamente SIN optimizar la consulta (ver "no aproveches esta
// tarea para cambiar query, índices ni performance de Supabase" —
// eso queda para una tarea independiente). Distinto del bloque de
// carga de Lista en que esta versión NO trae el historial completo
// (Lista lo necesita además para sus tarjetas de Asist/Faltas
// acumulado; la sheet del Chat solo necesita el estado de hoy).
export async function cargarEstadosAsistenciaHoy(
  sb: SupabaseClient,
  grupoId: string,
  alumnoIds: string[],
  hoy: string
): Promise<Record<string, EstadoAsistenciaOficial>> {
  if (alumnoIds.length === 0) return {}

  const { data: inscripcionesActivas } = await sb
    .from('inscripciones')
    .select('id, alumno_id')
    .eq('grupo_id', grupoId)
    .eq('estatus', 'activo')

  const inscripcionPorAlumno = new Map(
    (inscripcionesActivas || []).map((i: { id: string; alumno_id: string }) => [i.alumno_id, i.id])
  )
  const inscripcionIds = Array.from(inscripcionPorAlumno.values())

  const { data: registrosHoyCandidatos } = inscripcionIds.length > 0
    ? await sb
        .from('asistencia_registro')
        .select('inscripcion_id, fecha, estatus')
        .in('inscripcion_id', inscripcionIds)
    : { data: [] as { inscripcion_id: string; fecha: string; estatus: string }[] }

  const estatusPorInscripcion = new Map(
    (registrosHoyCandidatos || [])
      .filter((r: { inscripcion_id: string; fecha: string; estatus: string }) => r.fecha === hoy)
      .map((r: { inscripcion_id: string; estatus: string }) => [r.inscripcion_id, r.estatus])
  )

  const estados: Record<string, EstadoAsistenciaOficial> = {}
  alumnoIds.forEach((alumnoId) => {
    const inscripcionId = inscripcionPorAlumno.get(alumnoId)
    estados[alumnoId] = clasificarEstadoAsistencia(inscripcionId ? estatusPorInscripcion.get(inscripcionId) : null)
  })
  return estados
}
