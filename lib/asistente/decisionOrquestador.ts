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

import type { ReferenteContextualMetadata, TipoReferenteContextual } from './contextoConversacional'

// V3-A (ver "referente visual histórico") — 'reutilizar_imagen_subida'
// agregado AQUÍ (única fuente real del tipo, ver import en
// clasificadorNivel0.ts) para que capacidad_contextual pueda expresar
// la nueva capacidad. Deliberadamente NO se agrega a
// CAPACIDADES_VALIDAS/esCandidataAShortCircuitCliente más abajo en
// este mismo archivo: esta capacidad nunca pasa por el transporte de
// header ni por el short-circuit de cliente — su activación y
// ejecución son 100% server-side, dentro de la misma request (ver
// app/api/chat/route.ts). validarDecisionOrquestador ya la descarta
// sola (no está en el Set), así que decisionOrquestadorParaHeader
// simplemente nunca se llena para este valor — comportamiento
// correcto y ya cubierto sin tocar nada más aquí.
export type CapacidadContextual = 'transformar_texto' | 'generar_imagen' | 'editar_imagen' | 'convertir_documento' | 'reutilizar_imagen_subida'
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

// FASE 2B2A — SHORT-CIRCUIT + EJECUCIÓN DE CAPACIDADES DE RECURSO. Una
// decisión "informativa" (Fase 2B1) puede llegar a transportarse sin
// que nada la ejecute; "ejecutar_cliente" es la señal explícita de que
// el servidor YA decidió no hacer la segunda llamada Sonnet
// conversacional y espera que el cliente dispare el pipeline real.
// Nunca viaja en el body/texto — segundo header interno, ver
// HEADER_DECISION_ORQUESTADOR_MODO.
export type ModoDecisionOrquestador = 'informativa' | 'ejecutar_cliente'

export const HEADER_DECISION_ORQUESTADOR_MODO = 'X-Docente-IA-Decision-Mode'

// Fuente única de verdad para "¿esta decisión es candidata a
// ejecutarse en el cliente?" — la llaman TANTO route.ts (para decidir
// si omite la segunda llamada Sonnet) COMO el cliente (defense in
// depth: nunca confía solo en que el servidor haya marcado
// modo='ejecutar_cliente', vuelve a exigir lo mismo aquí antes de
// ejecutar nada, ver motorTextoClaude.ts/AsistenteService.ts). Pura:
// nunca llama IA, nunca muta nada.
//
// Fase 2B2A SOLO conecta generar_imagen y editar_imagen (ver auditoría
// "convertir_documento + documento_activo resultó inalcanzable con el
// enrutamiento actual de enviarMensaje" — enviarComoEdicion nunca
// manda referentesContextuales, así que ese candidato nunca llega
// aquí en la práctica; queda pendiente de una decisión aparte).
// transformar_texto se resolverá SERVER-SIDE dentro del mismo request
// en una fase futura — nunca short-circuit de cliente.
export function esCandidataAShortCircuitCliente(
  decision: DecisionOrquestador,
  referentesValidados: ReferenteContextualMetadata[]
): boolean {
  if (decision.confianza !== 'alta') return false
  const referenteReal = referentesValidados.find((r) => r.id === decision.referente.id && r.tipo === decision.referente.tipo)
  if (!referenteReal) return false
  if (decision.capacidad === 'generar_imagen') {
    return referenteReal.tipo === 'texto' || referenteReal.tipo === 'documento'
  }
  if (decision.capacidad === 'editar_imagen') {
    return referenteReal.tipo === 'imagen' && referenteReal.origen === 'material_visual_activo'
  }
  return false
}
