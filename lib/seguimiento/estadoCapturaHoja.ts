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
  // Todas las páginas están cargadas pero analizar-hoja rechazó la
  // fotografía por identidad (ver captura_pendiente.validacionIdentidad
  // — auditoría "Los Insectos y su Papel en la Naturaleza"). Estado
  // deliberadamente DISTINTO de 'lista_para_analizar': evita que el
  // cliente vuelva a auto-analizar la misma fotografía rechazada al
  // recargar, sin necesidad de borrar la foto ni de falsear
  // extraidoBruto con una extracción vacía. Desaparece solo, en cuanto
  // el docente sube una fotografía nueva (foto-hoja/route.ts reemplaza
  // captura_pendiente por completo).
  | 'identidad_no_valida'
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
  // true únicamente cuando captura_pendiente.validacionIdentidad.estado
  // === 'rechazada' para la captura ACTUAL (nunca inferido de otra
  // cosa) — ver analizar-hoja/route.ts. Opcional/aditivo: ausente
  // equivale a false, así cualquier llamador que todavía no lo pase
  // conserva el comportamiento exacto de siempre.
  identidadRechazada?: boolean
}): ResultadoEstadoCapturaHoja {
  const base = { paginasEsperadas: params.paginasEsperadas, paginasCargadas: params.paginasCargadas }

  if (ESTADOS_CONFIRMADOS.has(params.estadoProyecto)) {
    return { estado: 'confirmado', ...base }
  }

  if (!params.extraidoBruto) {
    if (params.paginasCargadas === 0) return { estado: 'sin_fotografia', ...base }
    if (params.paginasCargadas < params.paginasEsperadas) return { estado: 'captura_incompleta', ...base }
    // Todas las páginas cargadas pero sin extraidoBruto: o bien nunca
    // se analizó (caso normal, 'lista_para_analizar'), o bien SÍ se
    // analizó y el servidor rechazó la fotografía por identidad —
    // nunca se confunden entre sí.
    if (params.identidadRechazada) return { estado: 'identidad_no_valida', ...base }
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
