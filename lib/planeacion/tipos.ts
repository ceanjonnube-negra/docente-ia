// lib/planeacion/tipos.ts
//
// Fuente única de los tipos de Planeación (C-005, Fase 1). Los 4 campos
// formativos vigentes NO se redefinen aquí — se reutilizan de
// lib/seguimiento/tipos.ts (misma fuente que MARCO_CURRICULAR_VIGENTE)
// para que Planeación y Seguimiento nunca diverjan sobre qué campos
// formativos son válidos.

export { CAMPOS_FORMATIVOS, type CampoFormativo } from '@/lib/seguimiento/tipos'

export type EstadoPlaneacion = 'borrador' | 'publicada' | 'archivada'

export const ESTADOS_PLANEACION: { valor: EstadoPlaneacion; etiqueta: string }[] = [
  { valor: 'borrador', etiqueta: 'Borrador' },
  { valor: 'publicada', etiqueta: 'Publicada' },
  { valor: 'archivada', etiqueta: 'Archivada' },
]

export type Planeacion = {
  id: string
  docente_id: string
  grupo_id: string
  ciclo_escolar_id: string
  periodo_evaluacion_id: string | null
  nombre: string
  proposito: string | null
  fecha_inicio: string | null
  fecha_fin: string | null
  estado: EstadoPlaneacion
  version: number
  creado_en: string
  actualizado_en: string
}

// Fase 1 no tiene todavía ningún endpoint que escriba aquí — el tipo
// se define desde ahora porque la tabla ya existe en la migración,
// preparado para cuando una fase posterior (integración con el Chat
// IA) empiece a poblarla. Ver migrations/planeacion_fase1.sql.
export type PlaneacionProyecto = {
  id: string
  planeacion_id: string
  nombre: string
  campos_formativos: string[]
  contenidos: string[]
  pda: string[]
  ejes_articuladores: string[]
  metodologia: string | null
  duracion_dias: number | null
  actividades: unknown[]
  recursos: unknown[]
  evaluacion: Record<string, unknown>
  orden: number
  creado_en: string
  actualizado_en: string
}
