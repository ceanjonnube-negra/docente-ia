// lib/turnosChat.ts
//
// ARQUITECTURA DURABLE — Vercel Workflow + Supabase turnos_chat (ver
// migración supabase/migrations/20260808000000_crear_turnos_chat.sql).
//
// Fuente de verdad de un turno del Chat IA — sobrevive a que el
// navegador se desconecte, se suspenda o se cierre por completo. El
// stream visual hacia el navegador (cuando está conectado) sigue
// existiendo como transporte, pero esta tabla es lo único que decide
// si un turno está en cola, generando, terminado o falló de verdad.
//
// Nunca usa service_role: cada función recibe el cliente de Supabase
// YA autenticado con el access_token real del docente (mismo patrón
// que autenticarRequestApi en todo el resto de la aplicación) — RLS
// ("solo titular") es quien de verdad impide el acceso cruzado entre
// docentes, este archivo no reimplementa esa regla.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ArchivoGeneradoInfo } from './asistente/tipos'

export type EstadoTurnoChat = 'queued' | 'generating' | 'completed' | 'failed'

export type TurnoChat = {
  id: string
  docenteId: string
  conversacionId: string | null
  requestId: string
  estado: EstadoTurnoChat
  textoParcial: string
  textoFinal: string | null
  archivos: ArchivoGeneradoInfo[]
  error: string | null
  creadoEn: string
  actualizadoEn: string
}

type FilaTurnoChat = {
  id: string
  docente_id: string
  conversacion_id: string | null
  request_id: string
  estado: EstadoTurnoChat
  texto_parcial: string
  texto_final: string | null
  archivos: ArchivoGeneradoInfo[]
  error: string | null
  creado_en: string
  actualizado_en: string
}

function desdeFila(fila: FilaTurnoChat): TurnoChat {
  return {
    id: fila.id,
    docenteId: fila.docente_id,
    conversacionId: fila.conversacion_id,
    requestId: fila.request_id,
    estado: fila.estado,
    textoParcial: fila.texto_parcial,
    textoFinal: fila.texto_final,
    archivos: Array.isArray(fila.archivos) ? fila.archivos : [],
    error: fila.error,
    creadoEn: fila.creado_en,
    actualizadoEn: fila.actualizado_en,
  }
}

// FASE 3 — IDEMPOTENCIA: mismo request_id -> mismo turnId, nunca una
// segunda ejecución. `request_id UNIQUE` en la base es la protección
// real (a nivel de constraint, no solo de código) — este INSERT ...
// ON CONFLICT DO NOTHING seguido de un SELECT es el patrón atómico
// recomendado por Postgres para "insertar o recuperar" sin condición
// de carrera (a diferencia de "SELECT primero, INSERT si no existe",
// que sí tiene ventana de carrera entre dos peticiones simultáneas
// con el mismo request_id — ej. doble tap real en el botón Enviar).
export async function crearOTurnoRecuperarPorRequestId(
  sb: SupabaseClient,
  docenteId: string,
  conversacionId: string | null,
  requestId: string
): Promise<{ turno: TurnoChat; creadoAhora: boolean }> {
  const { error: errorInsert } = await sb
    .from('turnos_chat')
    .insert({ docente_id: docenteId, conversacion_id: conversacionId, request_id: requestId, estado: 'queued' })
    .select('id')
    .single()

  // 23505 = unique_violation — el request_id ya existía (recuperación,
  // no error real). Cualquier otro error sí se propaga.
  const creadoAhora = !errorInsert
  if (errorInsert && (errorInsert as { code?: string }).code !== '23505') {
    throw new Error(`No se pudo crear el turno: ${errorInsert.message}`)
  }

  const { data, error: errorSelect } = await sb
    .from('turnos_chat')
    .select('*')
    .eq('request_id', requestId)
    .single()
  if (errorSelect || !data) {
    throw new Error(`No se pudo recuperar el turno para request_id=${requestId}: ${errorSelect?.message ?? 'sin fila'}`)
  }
  return { turno: desdeFila(data as FilaTurnoChat), creadoAhora }
}

export async function obtenerTurnoPorId(sb: SupabaseClient, turnoId: string): Promise<TurnoChat | null> {
  const { data, error } = await sb.from('turnos_chat').select('*').eq('id', turnoId).maybeSingle()
  if (error) throw new Error(`No se pudo consultar el turno ${turnoId}: ${error.message}`)
  return data ? desdeFila(data as FilaTurnoChat) : null
}

// FASE 5, paso 3 — marca generating. Idempotente a propósito: si el
// turno ya estaba en 'generating' (un step del Workflow se reintentó),
// no pasa nada — sigue en el mismo estado, sin duplicar ningún efecto.
export async function marcarGenerando(sb: SupabaseClient, turnoId: string): Promise<void> {
  const { error } = await sb
    .from('turnos_chat')
    .update({ estado: 'generating', actualizado_en: new Date().toISOString() })
    .eq('id', turnoId)
    .in('estado', ['queued', 'generating'])
  if (error) throw new Error(`No se pudo marcar generating el turno ${turnoId}: ${error.message}`)
}

// FASE 6 — actualización de texto_parcial POR BLOQUES (nunca token por
// token, ver la instrucción explícita de esta fase) — quien llama
// decide el throttling real (ver generarTurnoChat.ts); esta función
// solo hace la escritura en sí.
export async function actualizarTextoParcial(sb: SupabaseClient, turnoId: string, textoParcial: string): Promise<void> {
  const { error } = await sb
    .from('turnos_chat')
    .update({ texto_parcial: textoParcial, actualizado_en: new Date().toISOString() })
    .eq('id', turnoId)
  if (error) throw new Error(`No se pudo actualizar texto_parcial del turno ${turnoId}: ${error.message}`)
}

// FASE 5, paso 7 — cierre exitoso. texto_final es la fuente definitiva
// de la respuesta (ver FASE 6) — texto_parcial deja de importar en
// cuanto esto se escribe.
export async function marcarCompletado(
  sb: SupabaseClient,
  turnoId: string,
  textoFinal: string,
  archivos: ArchivoGeneradoInfo[]
): Promise<void> {
  const { error } = await sb
    .from('turnos_chat')
    .update({ estado: 'completed', texto_final: textoFinal, archivos, actualizado_en: new Date().toISOString() })
    .eq('id', turnoId)
  if (error) throw new Error(`No se pudo marcar completed el turno ${turnoId}: ${error.message}`)
}

// TRATAMIENTO DEL ERROR (B) — falla real del backend/proveedor, nunca
// una desconexión del cliente (eso ni siquiera llega hasta aquí, ver
// generarTurnoChat.ts: el Workflow sigue corriendo sin importar si
// Safari sigue conectado). `error` es siempre un mensaje técnico
// controlado, nunca el stack completo ni datos sensibles.
export async function marcarFallido(sb: SupabaseClient, turnoId: string, error: string): Promise<void> {
  const { error: errorUpdate } = await sb
    .from('turnos_chat')
    .update({ estado: 'failed', error, actualizado_en: new Date().toISOString() })
    .eq('id', turnoId)
  if (errorUpdate) throw new Error(`No se pudo marcar failed el turno ${turnoId}: ${errorUpdate.message}`)
}
