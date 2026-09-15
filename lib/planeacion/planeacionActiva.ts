// lib/planeacion/planeacionActiva.ts
//
// Snapshot mínimo de "planeación en edición" por conversación — C-005,
// arquitectura de planeación activa, Fase 2 (SOLO ESCRITURA, ver diseño
// aprobado por separado). Vive en conversaciones_chat.planeacion_activa
// (jsonb, columna agregada en la migración
// 20260914000000_agregar_planeacion_activa_conversaciones_chat.sql),
// mismo rol arquitectónico que documento_activo/material_visual_activo
// de esa misma tabla.
//
// Esta fase NUNCA lee el snapshot para heredar/ajustar (eso es una fase
// posterior no autorizada todavía) — solo lo construye y lo persiste
// cuando una generación NUEVA ('crear') terminó con un borrador
// completo y válido.
//
// Contrato aprobado — nunca duplica datos institucionales derivables
// (grado, grupo, ciclo, institución, docente): contexto.grupoId es la
// única ancla, todo lo demás se resuelve en vivo desde ahí cuando haga
// falta (ver diseño aprobado, "grupoId como ancla").

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ResumenBorrador } from './extraerBorrador'
import { validarContenidoBorrador } from './validarContenidoBorrador'

export type PlaneacionActiva = {
  schemaVersion: 1
  version: number
  contexto: {
    grupoId: string
  }
  borrador: ResumenBorrador
  origenMensajeId: string | null
  actualizadoEn: string
}

const REGEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Construye el snapshot de una CREACIÓN nueva — version siempre 1 en
// esta fase (heredar/incrementar desde un ajuste es una fase posterior
// no autorizada todavía). Pura, sin I/O.
export function construirPlaneacionActivaCreada(
  resumen: ResumenBorrador,
  grupoId: string,
  origenMensajeId: string | null
): PlaneacionActiva {
  return {
    schemaVersion: 1,
    version: 1,
    contexto: { grupoId },
    borrador: resumen,
    origenMensajeId,
    actualizadoEn: new Date().toISOString(),
  }
}

// Validación defensiva mínima, fail-closed: cualquier campo ausente o
// mal formado invalida el snapshot COMPLETO — nunca se aproxima, nunca
// se completa con un valor inventado. Reutiliza validarContenidoBorrador
// (lib/planeacion/validarContenidoBorrador.ts) como única fuente de
// verdad sobre qué hace válido un ResumenBorrador, en vez de duplicar
// esas reglas aquí.
export function esPlaneacionActivaValida(valor: unknown): valor is PlaneacionActiva {
  if (typeof valor !== 'object' || valor === null) return false
  const v = valor as Record<string, unknown>

  if (v.schemaVersion !== 1) return false
  if (typeof v.version !== 'number' || !Number.isInteger(v.version) || v.version <= 0) return false

  const contexto = v.contexto as Record<string, unknown> | null | undefined
  if (typeof contexto !== 'object' || contexto === null) return false
  if (typeof contexto.grupoId !== 'string' || !REGEX_UUID.test(contexto.grupoId)) return false

  if (typeof v.borrador !== 'object' || v.borrador === null) return false
  if (!validarContenidoBorrador(v.borrador as ResumenBorrador).ok) return false

  if (v.origenMensajeId !== null && typeof v.origenMensajeId !== 'string') return false
  if (typeof v.actualizadoEn !== 'string' || Number.isNaN(Date.parse(v.actualizadoEn))) return false

  return true
}

// Categorías técnicas CERRADAS — nunca el texto crudo de un error de
// Supabase (message/details/hint) ni una excepción completa. Un log con
// esta categoría es suficiente para diagnosticar SIN poder filtrar
// nunca contenido de borrador, IDs ni PII (mismo criterio ya usado en
// /api/importar-alumnos/corregir-curp/route.ts: comparación exacta
// contra un conjunto fijo, nunca "lo que diga Postgres").
export type CategoriaFalloPlaneacionActiva =
  | 'VALIDACION_SNAPSHOT'
  | 'UPDATE_FALLIDO'
  | 'EXCEPCION_PERSISTENCIA'

export type ResultadoGuardarPlaneacionActiva = { ok: true } | { ok: false; motivo: CategoriaFalloPlaneacionActiva }

// Único punto de escritura de esta fase — UPDATE simple sobre la fila
// de conversaciones_chat ya autorizada por el llamador.
//
// PRECONDICIÓN DE AUTORIZACIÓN (la garantía real de esta arquitectura,
// no una comprobación adicional dentro de esta función):
//   1) conversacionId debe venir de obtenerConversacionIdAutorizada()
//      (app/api/chat/route.ts) — ya demostrado contra RLS antes de
//      llegar aquí (conversaciones_chat_select_propio, docente_id =
//      auth.uid()).
//   2) `supabaseAutenticado` debe ser el cliente RLS-scoped del docente
//      real (supabaseUser en route.ts) — NUNCA un cliente service_role.
//      El nombre del parámetro documenta esta precondición, pero
//      TypeScript no puede distinguir en tiempo de compilación un
//      SupabaseClient con service_role de uno con el token del docente
//      — ambos comparten el mismo tipo; esta función no finge una
//      garantía runtime que no existe, la disciplina de qué cliente se
//      pasa es responsabilidad exclusiva del llamador.
//   3) El UPDATE queda además sujeto en runtime a la política RLS real
//      conversaciones_chat_update_propio (docente_id = auth.uid()) —
//      segunda capa, no solo la #1.
// Sin lógica de autorización propia aquí a propósito: duplicarla
// introduciría una segunda fuente de verdad que podría divergir de RLS.
//
// Nunca lanza y nunca expone detalle crudo de Supabase ni una
// excepción hacia el llamador — solo una de las 3 categorías cerradas
// de arriba. Valida el snapshot antes de escribir — nunca persiste un
// objeto mal formado, sin importar quién lo haya construido.
export async function guardarPlaneacionActivaCreada(
  supabaseAutenticado: SupabaseClient,
  conversacionId: string,
  snapshot: PlaneacionActiva
): Promise<ResultadoGuardarPlaneacionActiva> {
  if (!esPlaneacionActivaValida(snapshot)) {
    return { ok: false, motivo: 'VALIDACION_SNAPSHOT' }
  }
  try {
    const { error } = await supabaseAutenticado
      .from('conversaciones_chat')
      .update({ planeacion_activa: snapshot })
      .eq('id', conversacionId)
    if (error) {
      return { ok: false, motivo: 'UPDATE_FALLIDO' }
    }
    return { ok: true }
  } catch {
    return { ok: false, motivo: 'EXCEPCION_PERSISTENCIA' }
  }
}
