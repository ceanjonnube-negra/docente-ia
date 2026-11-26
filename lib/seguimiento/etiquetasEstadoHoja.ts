// lib/seguimiento/etiquetasEstadoHoja.ts
//
// Lenguaje llano del estado real de una hoja de evaluación (el que
// devuelve /api/proyectos-seguimiento/[id]/estado-captura) — nunca el enum
// técnico ni el estado interno de proyectos_seguimiento. Una sola fuente
// para Evaluación y Planeación.

import type { EstadoCapturaHoja } from './estadoCapturaHoja'

export const ETIQUETA_ESTADO_HOJA: Record<EstadoCapturaHoja, string> = {
  sin_fotografia: 'Pendiente de resultados',
  captura_incompleta: 'Captura incompleta',
  lista_para_analizar: 'Lista para analizar',
  identidad_no_valida: 'Foto incorrecta',
  revision_pendiente: 'Requiere revisión',
  lista_para_confirmar: 'Lista para confirmar',
  confirmado: 'Resultados registrados',
}

export const COLOR_ESTADO_HOJA: Record<EstadoCapturaHoja, string> = {
  sin_fotografia: 'text-gray-500',
  captura_incompleta: 'text-amber-600',
  lista_para_analizar: 'text-blue-600',
  identidad_no_valida: 'text-amber-600',
  revision_pendiente: 'text-amber-600',
  lista_para_confirmar: 'text-blue-600',
  confirmado: 'text-green-600',
}
