// lib/seguimiento/estadoCapturaHoja.ts
//
// EVAL-1G — lógica pura (sin Supabase, sin IA, 0 red) que determina un
// ÚNICO estado discreto y legible para el cliente (CapturaHoja.tsx) a
// partir de datos ya conocidos: cuántas páginas se esperan, cuántas se
// cargaron, si ya existe una transcripción, y el estado real del
// proyecto. Existe para que el cliente NUNCA tenga que reconstruir o
// adivinar un estado a partir de un código HTTP — revisar-hoja
// responde 409 cuando no hay extraidoBruto (comportamiento correcto
// para SU propósito: dar la matriz de revisión), pero ese 409 no
// distingue "sin fotografía todavía" de "fotografía parcial" de
// "todas las páginas listas, falta analizar" — tres estados reales que
// la tarjeta del Chat sí necesita mostrar de forma distinta y honesta.
//
// Reutiliza construirMatrizRevision (ya probada en EVAL-1F) para la
// única parte que de verdad requiere lógica — nunca reimplementa
// esCeldaBloqueante ni el cálculo de bloqueantes/cobertura aparte.

import { construirMatrizRevision } from './confirmarResultadosHoja'
import type { ResultadoExtraccionHojaEvaluacion } from './analisisHojaEvaluacion'
import type { AlumnoRosterCongelado, IndicadorCongelado } from './tipos'

export type EstadoCapturaHoja =
  | 'sin_fotografia'
  | 'captura_incompleta'
  | 'lista_para_analizar'
  | 'revision_pendiente'
  | 'lista_para_confirmar'
  | 'confirmado'

export type ResultadoEstadoCapturaHoja = {
  estado: EstadoCapturaHoja
  paginasEsperadas: number
  paginasCargadas: number
  // Solo tiene sentido (y solo se incluye) cuando estado es
  // 'revision_pendiente' o 'lista_para_confirmar' — en cualquier otro
  // estado todavía no existe ninguna transcripción que contar.
  totalBloqueantes?: number
}

// Mismos 4 valores ya usados en el resto de esta familia de rutas
// (foto-hoja/analizar-hoja/corregir-celda) para "ya pasó por
// confirmación, en cualquiera de sus variantes" — nunca se re-ofrece
// subir/analizar/confirmar una vez que el proyecto llegó aquí.
const ESTADOS_CONFIRMADOS = new Set(['confirmado', 'corregido', 'sustituido', 'cerrado'])

export function determinarEstadoCapturaHoja(params: {
  estadoProyecto: string
  paginasEsperadas: number
  paginasCargadas: number
  extraidoBruto: ResultadoExtraccionHojaEvaluacion | null
  rosterCongelado: AlumnoRosterCongelado[]
  indicadoresCongelados: IndicadorCongelado[]
}): ResultadoEstadoCapturaHoja {
  const base = { paginasEsperadas: params.paginasEsperadas, paginasCargadas: params.paginasCargadas }

  if (ESTADOS_CONFIRMADOS.has(params.estadoProyecto)) {
    return { estado: 'confirmado', ...base }
  }

  if (!params.extraidoBruto) {
    if (params.paginasCargadas === 0) return { estado: 'sin_fotografia', ...base }
    if (params.paginasCargadas < params.paginasEsperadas) return { estado: 'captura_incompleta', ...base }
    // paginasCargadas >= paginasEsperadas (nunca debería ser mayor —
    // foto-hoja ya rechaza pagina > paginasEsperadas al subir — pero
    // >= es la comparación defensiva correcta, nunca ===).
    return { estado: 'lista_para_analizar', ...base }
  }

  const matriz = construirMatrizRevision(params.extraidoBruto, params.rosterCongelado, params.indicadoresCongelados)
  return {
    estado: matriz.listaParaConfirmar ? 'lista_para_confirmar' : 'revision_pendiente',
    ...base,
    totalBloqueantes: matriz.totalBloqueantes,
  }
}
