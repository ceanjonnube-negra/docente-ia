// lib/seguimiento/tipos.ts
//
// Fuente única de los enums de Seguimiento (aspectos generales, niveles,
// estados de proyecto y campos formativos) — los mismos valores que ya
// viven en los CHECK constraints de proyectos_seguimiento/
// seguimiento_resultados (ver migrations/seguimiento_fase3.sql), para que
// frontend y backend nunca diverjan sobre qué valores son válidos.

export type AspectoGeneral =
  | 'logro_aprendizaje'
  | 'aplicacion_aprendizajes'
  | 'participacion_colaboracion'
  | 'producto_evidencia'
  | 'autonomia'

export const ASPECTOS_GENERALES: { valor: AspectoGeneral; etiqueta: string }[] = [
  { valor: 'logro_aprendizaje', etiqueta: 'Logro del aprendizaje' },
  { valor: 'aplicacion_aprendizajes', etiqueta: 'Aplicación de los aprendizajes' },
  { valor: 'participacion_colaboracion', etiqueta: 'Participación y colaboración' },
  { valor: 'producto_evidencia', etiqueta: 'Producto o evidencia' },
  { valor: 'autonomia', etiqueta: 'Autonomía' },
]

export type NivelSeguimiento = 'destacado' | 'logrado' | 'en_proceso' | 'requiere_apoyo' | 'no_evaluado'

export const NIVELES_SEGUIMIENTO: { valor: NivelSeguimiento; etiqueta: string }[] = [
  { valor: 'destacado', etiqueta: 'Destacado' },
  { valor: 'logrado', etiqueta: 'Logrado' },
  { valor: 'en_proceso', etiqueta: 'En proceso' },
  { valor: 'requiere_apoyo', etiqueta: 'Requiere apoyo' },
  { valor: 'no_evaluado', etiqueta: 'No evaluado' },
]

// Los 4 campos formativos oficiales (Plan de Estudio 2022 / NEM) — ver
// lib/asistente/marcoCurricular.ts, MARCO_CURRICULAR_VIGENTE. Mismo texto
// exacto, para que un proyecto de Seguimiento nunca guarde un campo fuera
// de estos 4.
export const CAMPOS_FORMATIVOS = [
  'Lenguajes',
  'Saberes y Pensamiento Científico',
  'Ética, Naturaleza y Sociedades',
  'De lo Humano y lo Comunitario',
] as const

export type CampoFormativo = (typeof CAMPOS_FORMATIVOS)[number]

// Solo los estados que Fase 2 realmente usa. El CHECK de la base admite
// 10 valores en total (ver migrations/seguimiento_fase3.sql) — el resto
// ('pendiente_captura', 'fotografia_cargada', 'en_procesamiento',
// 'requiere_revision', 'confirmado', 'corregido', 'sustituido', 'cerrado')
// se agregan cuando se construyan las fases que los usan (spec §16: la
// interfaz solo muestra los estados relevantes en cada momento).
export type EstadoProyectoFase2 = 'planeado' | 'hoja_generada'

export type IndicadorProyecto = {
  indicador_especifico: string
  aspecto_general: AspectoGeneral
}
