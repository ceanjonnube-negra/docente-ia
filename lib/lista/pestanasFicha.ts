// lib/lista/pestanasFicha.ts
//
// Pestañas de la ficha del alumno sincronizadas con ?tab= (puras, sin
// React ni Next): el Chat IA abre la ficha con ?tab=... aunque ya esté
// montada; la navegación manual escribe ?tab= sin recargar.

export type Pestana = 'resumen' | 'datos' | 'asistencia' | 'incidencias' | 'evaluaciones' | 'evidencias' | 'fichas' | 'historial'
export const PESTANAS: Pestana[] = ['resumen', 'datos', 'asistencia', 'incidencias', 'evaluaciones', 'evidencias', 'fichas', 'historial']
export const esPestana = (v: string | null): v is Pestana => v !== null && (PESTANAS as string[]).includes(v)

// Ajuste durante el render: solo cuando ?tab cambió desde la última vez
// (un valor inválido o ausente no cambia la pestaña actual).
export function ajustarPestana(actual: Pestana, tabSincronizada: string | null, tabUrl: string | null): { pestana: Pestana; tabSincronizada: string | null } {
  if (tabUrl === tabSincronizada) return { pestana: actual, tabSincronizada }
  return { pestana: esPestana(tabUrl) ? tabUrl : actual, tabSincronizada: tabUrl }
}

// Query string con la pestaña elegida, conservando los demás parámetros.
export function consultaConPestana(busqueda: string, p: Pestana): string {
  const params = new URLSearchParams(busqueda)
  params.set('tab', p)
  return `?${params.toString()}`
}
