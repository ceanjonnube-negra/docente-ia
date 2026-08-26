// FASE 2B1 — TRANSPORTE INTERNO DE LA DECISIÓN DEL ORQUESTADOR (ver
// "contrato del router semántico unificado + transporte de referentes
// contextuales", Fase 2A). Fuente de verdad ÚNICA para la FORMA de la
// decisión contextual que Nivel0 (lib/clasificadorNivel0.ts) ya calcula
// y normaliza — usada tanto por el servidor (app/api/chat/route.ts, para
// codificarla en un header HTTP interno) como por el cliente
// (lib/asistente/motores/motorTextoClaude.ts, para decodificarla y
// validarla). Esta fase SOLO transporta: nada en la aplicación ejecuta
// todavía ninguna capacidad a partir de este valor (ver Fase 2A: "validar
// el cerebro antes de conectarle las manos" — sigue aplicando aquí, un
// paso más adelante en la tubería, todavía sin manos).

import type { TipoReferenteContextual } from './contextoConversacional'

export type CapacidadContextual = 'transformar_texto' | 'generar_imagen' | 'editar_imagen' | 'convertir_documento'
export type ConfianzaContextual = 'alta' | 'media' | 'baja'

export type DecisionOrquestador = {
  capacidad: CapacidadContextual
  referente: { tipo: TipoReferenteContextual; id: string }
  confianza: ConfianzaContextual
}

// Nombre único del header interno — nunca contenido, nunca datos de
// alumnos/institución/sesión: el payload transportado bajo este header
// es EXACTAMENTE la forma de DecisionOrquestador de arriba (capacidad +
// referente.tipo + referente.id + confianza), nada más. Exportado desde
// aquí para que servidor y cliente usen literalmente el mismo string,
// nunca dos copias que puedan divergir.
export const HEADER_DECISION_ORQUESTADOR = 'X-Docente-IA-Decision'

const CAPACIDADES_VALIDAS = new Set<string>(['transformar_texto', 'generar_imagen', 'editar_imagen', 'convertir_documento'])
const CONFIANZAS_VALIDAS = new Set<string>(['alta', 'media', 'baja'])
const TIPOS_REFERENTE_VALIDOS = new Set<string>(['texto', 'documento', 'imagen', 'lista_filtrada'])

// Pura — nunca confía en la forma del valor recibido (puede venir de un
// header HTTP decodificado, potencialmente manipulado o corrupto en
// tránsito). Cualquier campo faltante, de tipo incorrecto o fuera de las
// listas conocidas descarta el valor COMPLETO (todo-o-nada, mismo
// criterio que ya usa normalizarClasificacionNivel0 en
// clasificadorNivel0.ts para estos mismos tres datos). Nunca lanza.
export function validarDecisionOrquestador(valor: unknown): DecisionOrquestador | null {
  if (!valor || typeof valor !== 'object') return null
  const v = valor as Record<string, unknown>
  if (typeof v.capacidad !== 'string' || !CAPACIDADES_VALIDAS.has(v.capacidad)) return null
  if (typeof v.confianza !== 'string' || !CONFIANZAS_VALIDAS.has(v.confianza)) return null
  const referente = v.referente
  if (!referente || typeof referente !== 'object') return null
  const r = referente as Record<string, unknown>
  if (typeof r.tipo !== 'string' || !TIPOS_REFERENTE_VALIDOS.has(r.tipo)) return null
  if (typeof r.id !== 'string' || r.id.length === 0) return null
  return {
    capacidad: v.capacidad as CapacidadContextual,
    referente: { tipo: r.tipo as TipoReferenteContextual, id: r.id },
    confianza: v.confianza as ConfianzaContextual,
  }
}
