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
//
// schemaVersion 2 (Fase 3A.1/3A.2, ver auditoría "fuente canónica
// completa" aprobada por separado) — agrega contenidoCompleto: el
// string canónico completo de la planeación (extraerTextoCompletoBorrador,
// lib/planeacion/extraerBorrador.ts), la MISMA fuente que ya alimenta
// Word/PDF en app/api/chat/route.ts — nunca una transformación nueva.
// Contrato discriminado por schemaVersion a propósito: un snapshot
// schemaVersion=2 sin contenidoCompleto (o vacío) NUNCA es un
// PlaneacionActiva válido — TypeScript lo rechaza en tiempo de
// compilación (unión discriminada), y esPlaneacionActivaValida lo
// rechaza en runtime. Los snapshots schemaVersion=1 ya persistidos
// siguen siendo válidos tal cual, sin contenidoCompleto — NUNCA se
// migran ni se completan en caliente; heredar/ajustar sobre un v1 queda
// fuera de alcance (Fase 3, no autorizada todavía).
//
// schemaVersion 3 (Fase 3B.1/3B.2, ver decisión arquitectónica
// "planeacion_activa como fuente de verdad de continuidad" aprobada por
// separado) — agrega el ciclo de vida borrador/implementada. Discriminado
// dos veces a propósito: primero por schemaVersion (igual que v1/v2),
// y DENTRO de v3, otra vez por `estado`, para que sea IMPOSIBLE en
// tiempo de compilación construir un v3 con estado='borrador' e
// implementadaEn distinto de null, o estado='implementada' con
// implementadaEn null — la misma garantía que ya usa esPlaneacionActivaValida
// en runtime, ahora reforzada también por el tipo. Esta fase SOLO cambia
// el shape que escribe una CREACIÓN nueva (siempre nace 'borrador',
// version=1) — 'ajustar'/'implementar'/'descartar'/'finalizar' quedan
// fuera de alcance, no autorizados todavía.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ResumenBorrador } from './extraerBorrador'
import { validarContenidoBorrador } from './validarContenidoBorrador'

type CamposComunesPlaneacionActiva = {
  version: number
  contexto: {
    grupoId: string
  }
  borrador: ResumenBorrador
  origenMensajeId: string | null
  actualizadoEn: string
}

export type PlaneacionActivaV1 = CamposComunesPlaneacionActiva & { schemaVersion: 1 }
export type PlaneacionActivaV2 = CamposComunesPlaneacionActiva & { schemaVersion: 2; contenidoCompleto: string }

type CamposV3Base = CamposComunesPlaneacionActiva & { schemaVersion: 3; contenidoCompleto: string }
export type PlaneacionActivaV3Borrador = CamposV3Base & { estado: 'borrador'; implementadaEn: null }
export type PlaneacionActivaV3Implementada = CamposV3Base & { estado: 'implementada'; implementadaEn: string }
export type PlaneacionActivaV3 = PlaneacionActivaV3Borrador | PlaneacionActivaV3Implementada

export type PlaneacionActiva = PlaneacionActivaV1 | PlaneacionActivaV2 | PlaneacionActivaV3

const REGEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Construye el snapshot de una CREACIÓN nueva — version siempre 1,
// estado siempre 'borrador' e implementadaEn siempre null (una creación
// NUNCA nace implementada; 'implementar' es una transición aparte, no
// autorizada todavía). Pura, sin I/O. `contenidoCompleto` debe ser la
// MISMA cadena ya calculada por el llamador (route.ts) para Word/PDF —
// esta función nunca la reconstruye ni vuelve a llamar
// extraerTextoCompletoBorrador por su cuenta.
export function construirPlaneacionActivaCreada(
  resumen: ResumenBorrador,
  contenidoCompleto: string,
  grupoId: string,
  origenMensajeId: string | null
): PlaneacionActivaV3Borrador {
  return {
    schemaVersion: 3,
    version: 1,
    estado: 'borrador',
    contexto: { grupoId },
    borrador: resumen,
    contenidoCompleto,
    origenMensajeId,
    actualizadoEn: new Date().toISOString(),
    implementadaEn: null,
  }
}

// Validación defensiva mínima, fail-closed: cualquier campo ausente o
// mal formado invalida el snapshot COMPLETO — nunca se aproxima, nunca
// se completa con un valor inventado. Reutiliza validarContenidoBorrador
// (lib/planeacion/validarContenidoBorrador.ts) como única fuente de
// verdad sobre qué hace válido un ResumenBorrador, en vez de duplicar
// esas reglas aquí. Acepta schemaVersion 1 (histórico, sin
// contenidoCompleto), schemaVersion 2 (exige contenidoCompleto no
// vacío) y schemaVersion 3 (exige además estado/implementadaEn
// coherentes) — cualquier otro valor de schemaVersion se rechaza.
function camposComunesValidos(v: Record<string, unknown>): boolean {
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

// Compartida entre v2 y v3 — mismo criterio exacto en ambas, nunca dos
// implementaciones que puedan divergir.
function contenidoCompletoValido(v: Record<string, unknown>): boolean {
  return typeof v.contenidoCompleto === 'string' && v.contenidoCompleto.trim().length > 0
}

// Formato EXACTO que produce new Date().toISOString() en JS —
// YYYY-MM-DDTHH:mm:ss.sssZ (milisegundos siempre a 3 dígitos, siempre
// terminado en Z) — la MISMA forma que ya usa
// construirPlaneacionActivaCreada() para actualizadoEn/implementadaEn.
// Deliberadamente MÁS estricto que Date.parse() a secas: Date.parse
// acepta "September 16, 2026", "09/16/2026" o "2026-09-16" como fechas
// válidas, ninguna de las cuales es el contrato real que este código
// escribe — fail-closed, nunca aproxima un formato "parecido" a ISO.
const REGEX_ISO_8601_ESTRICTO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

// La forma sola no basta: Date.parse/new Date() NORMALIZAN fechas
// calendáricamente imposibles con forma correcta (ej. "2026-02-31" se
// interpreta como "3 de marzo", "2026-04-31" como "1 de mayo") en vez
// de rechazarlas. El roundtrip exacto — reconstruir la fecha desde el
// timestamp parseado y exigir que produzca el MISMO string de vuelta —
// es lo único que garantiza que `valor` sea literalmente un timestamp
// canónico real, no una fecha imposible "corregida" en silencio por el
// motor de fechas.
function esFechaIsoEstricta(valor: unknown): valor is string {
  if (typeof valor !== 'string' || !REGEX_ISO_8601_ESTRICTO.test(valor)) return false
  const timestamp = Date.parse(valor)
  if (Number.isNaN(timestamp)) return false
  return new Date(timestamp).toISOString() === valor
}

// SOLO para schemaVersion=3 — refuerza en runtime la misma coherencia
// que la unión discriminada de PlaneacionActivaV3 ya exige en tiempo de
// compilación: 'borrador' exige implementadaEn EXACTAMENTE null (nunca
// un string, ni siquiera vacío); 'implementada' exige implementadaEn
// como fecha ISO 8601 ESTRICTA (ver esFechaIsoEstricta arriba), no
// cualquier valor meramente parseable por Date.parse. Cualquier otro
// valor de `estado`, o cualquier combinación cruzada, es inválido —
// fail-closed, nunca se aproxima ni se corrige el valor.
//
// NOTA — actualizadoEn (camposComunesValidos, compartido por v1/v2/v3)
// sigue validándose solo con Date.parse, el mismo criterio laxo de
// siempre: NO se amplió a esFechaIsoEstricta en esta ronda porque no
// pude confirmar sin riesgo que TODOS los snapshots v1/v2 ya
// persistidos cumplan exactamente ese formato estricto (nunca
// inspeccioné el string crudo, solo su valor ya interpretado como
// fecha) — endurecerlo aquí podría invalidar un snapshot histórico
// real. Queda señalado como pendiente, no corregido.
function estadoV3Valido(v: Record<string, unknown>): boolean {
  if (v.estado === 'borrador') return v.implementadaEn === null
  if (v.estado === 'implementada') return esFechaIsoEstricta(v.implementadaEn)
  return false
}

export function esPlaneacionActivaValida(valor: unknown): valor is PlaneacionActiva {
  if (typeof valor !== 'object' || valor === null) return false
  const v = valor as Record<string, unknown>

  if (!camposComunesValidos(v)) return false

  if (v.schemaVersion === 1) return true
  if (v.schemaVersion === 2) return contenidoCompletoValido(v)
  if (v.schemaVersion === 3) return contenidoCompletoValido(v) && estadoV3Valido(v)
  return false
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
