// lib/trabajosDocumento.ts
//
// Persistencia server-only de trabajos_documento (ver "corrección:
// timeout en documentos ilustrados largos" — generar una guía
// ilustrada + Word + PDF puede tardar más que lo que Safari/iPhone
// espera en una sola respuesta bloqueante). Un trabajo vive fuera del
// ciclo request/response normal: se crea, se procesa en segundo plano
// (ver app/api/chat/trabajo-documento/route.ts, after()), y el cliente
// consulta su estado por polling (ver
// lib/asistente/trabajoDocumentoCliente.ts).
//
// Deliberadamente NO es turnos_chat/Vercel Workflow (esa arquitectura
// pertenece a test/chat-durable-v1, rama que no se mezcla con esta) —
// esta es una versión acotada, propia de este uso, con after() en vez
// de Workflow: suficiente para un trabajo con techo de tiempo real
// (maxDuration de la función), sin la garantía de sobrevivir un
// redeploy que si necesitaría el chat completo.
//
// Idempotencia real: INSERT directo con request_id UNIQUE, nunca
// "SELECT primero, INSERT después" (condición de carrera real ante
// doble tap) — mismo criterio que lib/turnosChat.ts / lib/assetsVisuales.ts.
// Usa siempre el cliente AUTENTICADO del docente (RLS ya exige
// docente_id = auth.uid()), nunca service_role.

import type { SupabaseClient } from '@supabase/supabase-js'

export type EstadoTrabajoDocumento = 'queued' | 'generando' | 'completado' | 'fallido'

export type ResultadoTrabajoDocumento = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  archivos: any[]
  mensaje: string
  // Texto REAL del documento (ver [[DOCUMENTO_CONTENIDO:...]] en
  // app/api/chat/route.ts, CASO 3) — `mensaje` es solo el envoltorio
  // ("Documento generado correctamente."), nunca el contenido; sin
  // esto, el cliente no puede fijar documentoActivo.texto para
  // ediciones futuras ("agrégale una sección al final").
  contenidoOriginal?: string
}

export type TrabajoDocumento = {
  id: string
  docenteId: string
  conversacionId: string | null
  requestId: string
  estado: EstadoTrabajoDocumento
  resultado: ResultadoTrabajoDocumento | null
  error: string | null
  actualizadoEn: string
}

function desdeFila(fila: {
  id: string
  docente_id: string
  conversacion_id: string | null
  request_id: string
  estado: string
  resultado: unknown
  error: string | null
  actualizado_en: string
}): TrabajoDocumento {
  return {
    id: fila.id,
    docenteId: fila.docente_id,
    conversacionId: fila.conversacion_id,
    requestId: fila.request_id,
    estado: fila.estado as EstadoTrabajoDocumento,
    resultado: (fila.resultado as ResultadoTrabajoDocumento | null) ?? null,
    error: fila.error,
    actualizadoEn: fila.actualizado_en,
  }
}

// Idempotente: si ya existe una fila con este request_id (doble tap,
// reintento del cliente), la regresa tal cual en vez de crear otra —
// nunca vuelve a arrancar la generación de un trabajo que ya existe.
export async function crearOTrabajoRecuperarPorRequestId(
  sb: SupabaseClient,
  docenteId: string,
  conversacionId: string | null,
  requestId: string
): Promise<{ trabajo: TrabajoDocumento; yaExistia: boolean }> {
  const { data: creado, error: errorInsert } = await sb
    .from('trabajos_documento')
    .insert({ docente_id: docenteId, conversacion_id: conversacionId, request_id: requestId, estado: 'queued' })
    .select('id, docente_id, conversacion_id, request_id, estado, resultado, error, actualizado_en')
    .single()

  if (!errorInsert && creado) return { trabajo: desdeFila(creado), yaExistia: false }

  // 23505 = unique_violation — RECUPERACIÓN real (ya existía), nunca
  // una falla. Cualquier otro código sí se propaga como error real.
  if (errorInsert && errorInsert.code === '23505') {
    const { data: existente, error: errorSelect } = await sb
      .from('trabajos_documento')
      .select('id, docente_id, conversacion_id, request_id, estado, resultado, error, actualizado_en')
      .eq('request_id', requestId)
      .single()
    if (errorSelect || !existente) throw new Error(`No se pudo recuperar el trabajo existente para request_id=${requestId}: ${errorSelect?.message || 'sin fila'}`)
    return { trabajo: desdeFila(existente), yaExistia: true }
  }

  throw new Error(`Error creando el trabajo de documento: ${errorInsert?.message || 'sin fila devuelta'}`)
}

export async function obtenerTrabajoPorId(sb: SupabaseClient, trabajoId: string): Promise<TrabajoDocumento | null> {
  const { data, error } = await sb
    .from('trabajos_documento')
    .select('id, docente_id, conversacion_id, request_id, estado, resultado, error, actualizado_en')
    .eq('id', trabajoId)
    .maybeSingle()
  if (error || !data) return null
  return desdeFila(data)
}

export async function marcarGenerando(sb: SupabaseClient, trabajoId: string): Promise<void> {
  await sb.from('trabajos_documento').update({ estado: 'generando', actualizado_en: new Date().toISOString() }).eq('id', trabajoId)
}

export async function marcarCompletado(sb: SupabaseClient, trabajoId: string, resultado: ResultadoTrabajoDocumento): Promise<void> {
  await sb.from('trabajos_documento').update({ estado: 'completado', resultado, actualizado_en: new Date().toISOString() }).eq('id', trabajoId)
}

export async function marcarFallido(sb: SupabaseClient, trabajoId: string, error: string): Promise<void> {
  await sb.from('trabajos_documento').update({ estado: 'fallido', error, actualizado_en: new Date().toISOString() }).eq('id', trabajoId)
}
