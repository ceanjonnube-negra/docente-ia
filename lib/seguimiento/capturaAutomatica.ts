// lib/seguimiento/capturaAutomatica.ts
//
// Una hoja de evaluación admite captura automática (fotografía → análisis
// → confirmación) solo si tiene su registro de alumnos congelado. Las hojas
// históricas generadas antes de ese registro no lo tienen y nunca lo
// tendrán: su estado es permanente, no un fallo. UNA sola regla para
// estado-captura, el listado de proyectos, Evaluación y Planeación.
//
// Se evalúa sobre la columna roster_congelado tal cual la devuelve
// Supabase (jsonb → arreglo JSON), nunca con una ruta JSON por índice
// (roster_congelado->0): en la selección embebida del listado esa ruta
// llegó null en todas las hojas (el índice se resolvió como clave de texto,
// que en un arreglo jsonb siempre es null).

// Código estable del 409 de estado-captura para ese caso.
export const CODIGO_SIN_CAPTURA_AUTOMATICA = 'sin_captura_automatica'

// Criterio de estado-captura: sin registro o con registro vacío, no admite.
export function admiteCapturaAutomatica(rosterCongelado: unknown): boolean {
  if (rosterCongelado === null || rosterCongelado === undefined) return false
  return !(Array.isArray(rosterCongelado) && rosterCongelado.length === 0)
}

// Hoja embebida en GET /api/proyectos-seguimiento: se calcula admite_captura
// en el servidor y el registro de alumnos NO se envía al cliente.
type HojaListada = { identificador_visible: string; storage_path: string | null; generado_en: string; roster_congelado?: unknown }
export type HojaConCaptura = Omit<HojaListada, 'roster_congelado'> & { admite_captura: boolean }
export function conCapturaAutomatica<T extends { hojas_evaluacion?: unknown }>(p: T): Omit<T, 'hojas_evaluacion'> & { hojas_evaluacion: HojaConCaptura | null } {
  const hoja = p.hojas_evaluacion as HojaListada | null | undefined
  if (!hoja) return { ...p, hojas_evaluacion: null }
  const { roster_congelado, ...resto } = hoja
  return { ...p, hojas_evaluacion: { ...resto, admite_captura: admiteCapturaAutomatica(roster_congelado) } }
}
