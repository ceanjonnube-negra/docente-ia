// lib/planeacion/consultaContextual.ts
//
// Hito 2 — consulta CONTEXTUAL de una planeación guardada, sin nombrarla
// ("Muéstrame la planeación", "Enséñamela", "Muéstramelo"). Determinista y
// sin IA: el referente es conversaciones_chat.planeacion_activa (la
// planeación guardada de esta conversación) y la respuesta es su versión
// canónica VIGENTE, con el mecanismo de consulta de siempre
// ({ tipo: 'version', version: 'vigente' }). Un borrador ya publicado nunca
// prevalece sobre ella.
//
// Se decide por el último documento de la conversación:
// - versión guardada mostrada, borrador ya aprobado (o ajuste publicado u
//   obsoleto): la versión vigente;
// - ajuste realmente pendiente (su base sigue vigente): ambigüedad real
//   entre la versión guardada y el borrador → se pide aclaración;
// - borrador nuevo sin guardar u otro documento (un examen): no es una
//   planeación guardada → null (sigue el camino de siempre).

import type { SupabaseClient } from '@supabase/supabase-js'
import { esDocumentoFormal } from '../asistente/documentos'
import { cicloDelAjuste } from './aprobarAjuste'
import { leerReferenciaPlaneacion } from './consultaPlaneaciones'
import { esBorradorDeAjuste, esBorradorPlaneacion, esVersionGuardadaMostrada } from './extraerBorrador'
import { esPlaneacionYaGuardada } from './detectarConsultaPlaneacion'
import { ajustePublicable } from './modificarPlaneacion'

export type ConsultaContextual = { tipo: 'vigente' } | { tipo: 'aclaracion'; texto: string }

export const mensajeAclaracionContextual = (nombre: string, vigente: number) =>
  `Tienes un borrador de ajuste de «${nombre}» que todavía no apruebas. El borrador está más arriba en esta conversación; si quieres la versión guardada (la ${vigente}), dime «muéstrame la versión vigente».`

const esPlaneacion = (t: string) => esBorradorPlaneacion(t) || esVersionGuardadaMostrada(t)

export async function resolverConsultaContextual(sb: SupabaseClient, docenteId: string, conversacionId: string | null, historial: { role: string; content: string }[]): Promise<ConsultaContextual | null> {
  const referencia = await leerReferenciaPlaneacion(sb, conversacionId)
  if (!referencia?.planeacionId) return null
  const respuestas = historial.filter((h) => h.role === 'assistant').map((h) => h.content)
  const i = respuestas.map((t) => esPlaneacion(t) || esDocumentoFormal(t)).lastIndexOf(true)
  // Sin documento en el historial: la referencia persistida es el único referente.
  if (i === -1) return { tipo: 'vigente' }
  const documento = respuestas[i]
  if (!esPlaneacion(documento)) return null
  if (esPlaneacionYaGuardada(documento, respuestas.slice(i + 1))) return { tipo: 'vigente' }
  if (!esBorradorDeAjuste(documento)) return null
  // Borrador de ajuste sin confirmación en el historial: su estado real lo
  // dice la versión canónica (pudo publicarse en otro dispositivo).
  const ajuste = ajustePublicable(documento, referencia)
  if (!ajuste || ajuste.planeacionId !== referencia.planeacionId) return null
  const ciclo = await cicloDelAjuste(sb, docenteId, ajuste)
  if (ciclo.estado === 'pendiente') return { tipo: 'aclaracion', texto: mensajeAclaracionContextual(ciclo.nombre, ciclo.vigente) }
  return ciclo.estado === 'sin_planeacion' ? null : { tipo: 'vigente' }
}
