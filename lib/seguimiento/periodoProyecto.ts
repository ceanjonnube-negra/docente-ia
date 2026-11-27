// lib/seguimiento/periodoProyecto.ts
//
// Hito 3 — periodo de evaluación de un proyecto de seguimiento, resuelto
// de forma determinista y SIN modificar registros:
//   1. el periodo registrado (periodo_evaluacion_id), si es válido: existe
//      entre los periodos del ciclo del proyecto;
//   2. si no, el ÚNICO periodo que contiene las fechas del proyecto
//      (misma regla compartida que la aprobación de planeaciones:
//      resolverPeriodoPorFechaInicio) — y, si el proyecto tiene fecha de
//      fin, ese mismo periodo debe contenerla (un proyecto que cruza dos
//      periodos es ambiguo);
//   3. en cualquier otro caso, ninguno («Sin periodo asignado»).
// Pura: 0 I/O, 0 IA.

import { resolverPeriodoPorFechaInicio } from '../planeacion/curricularAprobacion'

export type PeriodoReferencia = { id: string; nombre: string; numero_periodo: number; fecha_inicio: string | null; fecha_fin: string | null }

export type PeriodoResuelto = {
  id: string
  nombre: string
  numero: number
  // 'registrado': el proyecto ya lo tenía; 'fechas': deducido sin ambigüedad.
  origen: 'registrado' | 'fechas'
}

export function resolverPeriodoDeProyecto(
  proyecto: { periodoEvaluacionId: string | null; fechaInicio: string | null; fechaFin: string | null },
  periodosDelCiclo: PeriodoReferencia[]
): PeriodoResuelto | null {
  const registrado = proyecto.periodoEvaluacionId ? periodosDelCiclo.find((p) => p.id === proyecto.periodoEvaluacionId) : undefined
  if (registrado) return { id: registrado.id, nombre: registrado.nombre, numero: registrado.numero_periodo, origen: 'registrado' }
  const referencia = proyecto.fechaInicio ?? proyecto.fechaFin
  if (!referencia) return null
  const candidato = resolverPeriodoPorFechaInicio(periodosDelCiclo, referencia)
  if (!candidato) return null
  if (proyecto.fechaFin && !(candidato.fecha_inicio! <= proyecto.fechaFin && proyecto.fechaFin <= candidato.fecha_fin!)) return null
  return { id: candidato.id, nombre: candidato.nombre, numero: candidato.numero_periodo, origen: 'fechas' }
}
