// lib/seguimiento/capturaAutomatica.ts
//
// Una hoja de evaluación admite captura automática (fotografía → análisis
// → confirmación) solo si tiene su registro de alumnos congelado. Las hojas
// históricas generadas antes de ese registro no lo tienen y nunca lo
// tendrán: su estado es permanente, no un fallo. Una sola regla para el
// listado de proyectos, estado-captura, Evaluación y Planeación.

// Código estable del 409 de estado-captura para ese caso.
export const CODIGO_SIN_CAPTURA_AUTOMATICA = 'sin_captura_automatica'

// Mismo criterio que estado-captura (registro ausente o vacío), leyendo
// solo el primer alumno (roster_congelado->0), nunca la lista completa.
export function admiteCapturaAutomatica(primerAlumno: unknown): boolean {
  return primerAlumno !== null && primerAlumno !== undefined
}

type HojaListada = { identificador_visible: string; storage_path: string | null; generado_en: string; primer_alumno?: unknown }
export type HojaConCaptura = Omit<HojaListada, 'primer_alumno'> & { admite_captura: boolean }
export function conCapturaAutomatica<T extends { hojas_evaluacion?: unknown }>(p: T): Omit<T, 'hojas_evaluacion'> & { hojas_evaluacion: HojaConCaptura | null } {
  const hoja = p.hojas_evaluacion as HojaListada | null | undefined
  if (!hoja) return { ...p, hojas_evaluacion: null }
  const { primer_alumno, ...resto } = hoja
  return { ...p, hojas_evaluacion: { ...resto, admite_captura: admiteCapturaAutomatica(primer_alumno) } }
}
