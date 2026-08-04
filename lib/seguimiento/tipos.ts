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

// Escala numérica 1-4 (ver "AJUSTE DE DISEÑO Y MODELO DE EVALUACIÓN —
// sustituir letras por escala numérica simple"): reemplaza la escala
// de letras D/L/E/R/N — una marca de posición (X, círculo, palomita)
// sobre una de 4 casillas es más fácil de capturar a mano y de
// reconocer por fotografía (se identifica QUÉ casilla quedó marcada,
// nunca un carácter escrito). No existe un valor para "no evaluado":
// una fila/indicador sin ninguna casilla marcada ES "no evaluado" —
// la ausencia de nivel (null) representa ese estado en todo el
// sistema, nunca un valor numérico como 0.
export type NivelEvaluacion = 1 | 2 | 3 | 4

export const NIVELES_EVALUACION: { valor: NivelEvaluacion; etiqueta: string }[] = [
  { valor: 4, etiqueta: 'Dominio destacado' },
  { valor: 3, etiqueta: 'Logro esperado' },
  { valor: 2, etiqueta: 'En proceso' },
  { valor: 1, etiqueta: 'Requiere apoyo' },
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
