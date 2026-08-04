// lib/seguimiento/conversionCalificacion.ts
//
// Modelo desacoplado de conversión de la escala numérica 1-4 a
// calificación (ver "AJUSTE DE DISEÑO Y MODELO DE EVALUACIÓN —
// sustituir letras por escala numérica simple"). Nada de esto vive
// inline en la hoja de evaluación ni en ningún otro lugar: siempre se
// pasa por una ReglaConversionCalificacion, para que agregar una regla
// distinta (escala 5-10, porcentaje, niveles solo cualitativos, una
// regla particular de una escuela) sea agregar una regla nueva, nunca
// tocar el código que ya calcula promedios.
//
// El nivel 1-4 ORIGINAL siempre se conserva completo — nunca se
// guarda únicamente la calificación ya convertida (ver
// ResultadoIndicadorEvaluado) — para poder recalcular con otra regla
// más adelante sin perder información.

import type { NivelEvaluacion } from './tipos'

export type ReglaConversionCalificacion = {
  id: string
  nombre: string
  convertir: (nivel: NivelEvaluacion) => number
}

// Única regla implementada hoy — la que se aplica por defecto a menos
// que el docente/escuela configure otra en el futuro.
export const REGLA_CONVERSION_PREDETERMINADA: ReglaConversionCalificacion = {
  id: 'predeterminada_4_10',
  nombre: 'Predeterminada (4=10, 3=8, 2=6, 1=5)',
  convertir: (nivel) => {
    const tabla: Record<NivelEvaluacion, number> = { 4: 10, 3: 8, 2: 6, 1: 5 }
    return tabla[nivel]
  },
}

// Registro de reglas disponibles — hoy solo la predeterminada; una
// regla nueva se agrega aquí, nunca reemplazando esta constante ni
// duplicando la lógica de conversión en otro archivo.
export const REGLAS_CONVERSION_DISPONIBLES: ReglaConversionCalificacion[] = [REGLA_CONVERSION_PREDETERMINADA]

// Un indicador evaluado — el nivel original SIEMPRE se conserva junto
// con la calificación convertida y la regla usada para obtenerla,
// nunca solo el resultado final. nivelOriginal=null representa "no
// evaluado" (nunca 0) y calificacionConvertida también queda null en
// ese caso — un indicador sin evaluar no tiene calificación, ni
// siquiera una calificación de cero.
export type ResultadoIndicadorEvaluado = {
  indicador: string
  proyecto: string
  alumno: string
  fecha: string
  nivelOriginal: NivelEvaluacion | null
  calificacionConvertida: number | null
  reglaConversion: string
}

export function evaluarIndicador(
  datos: { indicador: string; proyecto: string; alumno: string; fecha: string; nivelOriginal: NivelEvaluacion | null },
  regla: ReglaConversionCalificacion = REGLA_CONVERSION_PREDETERMINADA
): ResultadoIndicadorEvaluado {
  return {
    indicador: datos.indicador,
    proyecto: datos.proyecto,
    alumno: datos.alumno,
    fecha: datos.fecha,
    nivelOriginal: datos.nivelOriginal,
    calificacionConvertida: datos.nivelOriginal == null ? null : regla.convertir(datos.nivelOriginal),
    reglaConversion: regla.id,
  }
}

// Promedio de calificaciones YA convertidas — los indicadores sin
// evaluar (calificacionConvertida null) se EXCLUYEN por completo, no
// cuentan como cero ni reducen el promedio de los que sí se marcaron.
// null solo si NINGÚN indicador del grupo fue evaluado todavía.
export function calcularPromedio(resultados: ResultadoIndicadorEvaluado[]): number | null {
  const evaluados = resultados.filter(
    (r): r is ResultadoIndicadorEvaluado & { calificacionConvertida: number } => r.calificacionConvertida != null
  )
  if (evaluados.length === 0) return null
  const suma = evaluados.reduce((acc, r) => acc + r.calificacionConvertida, 0)
  return suma / evaluados.length
}

// Reconocimiento por fotografía — contrato puro para la posición de
// la(s) marca(s) detectadas en una fila/indicador (ver "diseño de la
// hoja": la lectura identifica la posición de la marca, nunca
// caracteres escritos). Ninguna marca -> no evaluado; exactamente una
// -> ese nivel; más de una en la misma fila/indicador -> lectura
// dudosa que requiere revisión manual, nunca se adivina cuál es la
// correcta.
export type LecturaMarca =
  | { estado: 'nivel'; nivel: NivelEvaluacion }
  | { estado: 'no_evaluado' }
  | { estado: 'lectura_dudosa' }

export function interpretarMarcas(columnasMarcadas: NivelEvaluacion[]): LecturaMarca {
  if (columnasMarcadas.length === 0) return { estado: 'no_evaluado' }
  if (columnasMarcadas.length > 1) return { estado: 'lectura_dudosa' }
  return { estado: 'nivel', nivel: columnasMarcadas[0] }
}
