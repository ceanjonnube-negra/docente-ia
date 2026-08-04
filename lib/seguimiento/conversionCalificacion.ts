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

// Reconocimiento por fotografía — contrato puro para el/los nivel(es)
// detectados en una celda (indicador o "Nivel final"). Con el modelo
// compacto ("AJUSTE DEFINITIVO C-005") cada celda es un solo dígito
// escrito a mano, no una de varias casillas de posición — pero el
// contrato de salida es el mismo en ambos casos: ninguna lectura ->
// no evaluado; exactamente un dígito 1-4 -> ese nivel; más de un
// dígito, una corrección o un dígito fuera de 1-4 dentro de la misma
// celda -> lectura dudosa que requiere revisión manual, nunca se
// adivina cuál es la correcta.
export type LecturaMarca =
  | { estado: 'nivel'; nivel: NivelEvaluacion }
  | { estado: 'no_evaluado' }
  | { estado: 'lectura_dudosa' }

export function interpretarMarcas(digitosDetectados: NivelEvaluacion[]): LecturaMarca {
  if (digitosDetectados.length === 0) return { estado: 'no_evaluado' }
  if (digitosDetectados.length > 1) return { estado: 'lectura_dudosa' }
  return { estado: 'nivel', nivel: digitosDetectados[0] }
}

// Modelo de datos a conservar por indicador evaluado (ver "AJUSTE
// DEFINITIVO C-005 — modelo compacto de hoja de evaluación", sección
// "Datos que deben conservarse en el modelo"). Son solo TIPOS por
// ahora — no se ejecutan migraciones ni se persiste nada real
// mientras la hoja siga en vista previa; describen la forma que
// tendrá cada resultado una vez que exista la captura real (manual o
// por fotografía).
export type NumeroIndicadorHoja = 1 | 2 | 3 | 4 | 5

export type EvaluacionIndicadorHoja = {
  proyectoId: string
  alumnoId: string
  indicadorId: string
  numeroIndicador: NumeroIndicadorHoja
  // El nivel tal como quedó escrito en la celda del indicador (o null
  // si la celda quedó vacía = no evaluado). Nunca se sobrescribe con
  // el nivel final.
  nivelOriginal: NivelEvaluacion | null
  // El nivel final que el propio docente escribió en la columna
  // "Nivel final" de la hoja — null si la dejó en blanco.
  nivelFinalDocente: NivelEvaluacion | null
  // Sugerencia que la app puede calcular a partir de los indicadores
  // evaluados cuando "Nivel final" quedó en blanco (ver
  // calcularNivelFinalSugerido) — nunca sustituye lo que el docente
  // ya escribió a mano.
  nivelFinalSugerido: NivelEvaluacion | null
  fueCapturadoPorFotografia: boolean
  // true si esta lectura (indicador o nivel final) quedó marcada como
  // "lectura_dudosa" por interpretarMarcas y todavía no fue revisada
  // manualmente — la app debe mostrar solo estos casos, nunca todos.
  requiereRevision: boolean
  fechaEvaluacion: string
}

// Sugerencia de "Nivel final" a partir de los indicadores YA
// evaluados de un alumno — promedia solo los niveles no nulos
// (ninguno cuenta como cero, igual que calcularPromedio) y redondea
// al entero más cercano dentro de 1-4. Nunca decide por el docente:
// es solo lo que la app puede ofrecer cuando la columna "Nivel final"
// quedó en blanco.
export function calcularNivelFinalSugerido(niveles: (NivelEvaluacion | null)[]): NivelEvaluacion | null {
  const evaluados = niveles.filter((n): n is NivelEvaluacion => n != null)
  if (evaluados.length === 0) return null
  const promedio = evaluados.reduce((acc, n) => acc + n, 0) / evaluados.length
  return Math.max(1, Math.min(4, Math.round(promedio))) as NivelEvaluacion
}
