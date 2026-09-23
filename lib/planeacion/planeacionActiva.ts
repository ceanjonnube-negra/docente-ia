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
// Fase 2 (creación, SOLO ESCRITURA) construye y persiste el snapshot
// cuando una generación NUEVA ('crear') termina con un borrador
// completo y válido. Fase 3B.3 (ver bloque más abajo) agrega el ajuste
// sobre un snapshot V3 ya existente — ver construirPlaneacionActivaAjustada.
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
// en runtime, ahora reforzada también por el tipo. Esta fase (3B.1/3B.2)
// SOLO cambia el shape que escribe una CREACIÓN nueva (siempre nace
// 'borrador', version=1) — 'implementar'/'descartar'/'finalizar' quedan
// fuera de alcance. 'ajustar' se agrega en la fase siguiente (ver abajo).
//
// Fase 3B.3 (ajustar, ver decisión arquitectónica "planeacion_activa
// como fuente de verdad de continuidad" aprobada por separado) — agrega
// construirPlaneacionActivaAjustada: permite ajustar una
// PlaneacionActivaV3 YA EXISTENTE. El ajuste parte EXCLUSIVAMENTE del
// snapshot V3 previamente leído y validado por el llamador (route.ts) —
// nunca se reconstruye desde el historial de la conversación, Word/PDF
// ni ningún marcador de texto. Conserva contexto.grupoId, estado e
// implementadaEn exactamente como estaban en el snapshot anterior (un
// ajuste nunca implementa, desimplementa ni cambia de grupo);
// incrementa version en +1 y sustituye borrador/contenidoCompleto por
// los nuevos. La creación V3 (arriba) sigue existiendo sin cambios.
// 'implementar'/'descartar'/'finalizar' siguen fuera de esta fase.
//
// schemaVersion 4 (PLN-1D — "trazabilidad curricular validada en el
// snapshot") — agrega trazabilidadCurricular: la ÚNICA identidad
// curricular que este snapshot considera confiable, producida
// EXCLUSIVAMENTE server-side (ver route.ts, bloque PLN-1D) después de
// validar contra el Programa Analítico vigente real
// (lib/planeacion/validarSeleccionCurricularPlaneacion.ts) — NUNCA la
// propuesta cruda de Claude (ResumenBorrador.programaAnaliticoItemIdsPropuestos,
// que sigue existiendo solo como dato transitorio de parseo, nunca se
// persiste con contenido real en el snapshot: route.ts la vacía antes
// de construir V4, ver informe PLN-1D §8 opción B). null cuando el
// grupo no tenía Programa Analítico publicado ese turno (comportamiento
// sin cambios respecto a PLN-1C); no-null con items=[] cuando SÍ había
// Programa Analítico pero ningún item propuesto sobrevivió la
// validación — nunca se inventa una selección para rellenar. Los
// snapshots V1/V2/V3 ya persistidos NUNCA se migran ni se completan en
// caliente — construirPlaneacionActivaCreada/Ajustada ahora producen
// SIEMPRE V4, pero esPlaneacionActivaValida sigue aceptando V1/V2/V3
// para lectura, exactamente igual que V2 nunca dejó de aceptar V1.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ResumenBorrador } from './extraerBorrador'
import { validarContenidoBorrador } from './validarContenidoBorrador'
import type { CandidatoCurricularPlaneacion } from './resolverCurricularPlaneacion'

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

// PLN-1D — contrato de trazabilidad curricular. `campoFormativo` y
// `curriculoContenidoId` son null EXCLUSIVAMENTE cuando
// procedencia==='local' (mismo invariante que CandidatoCurricularPlaneacion
// en resolverCurricularPlaneacion.ts, reforzado aquí también en
// runtime por trazabilidadCurricularValida — nunca solo confiado por
// construcción). pda=[] siempre que procedencia==='local'.
export type PdaTrazabilidadCurricular = {
  programaAnaliticoItemPdaId: string
  curriculoPdaId: string
  curriculoPdaGradoId: string
  texto: string
}

export type ItemTrazabilidadCurricular = {
  programaAnaliticoItemId: string
  procedencia: 'oficial' | 'contextualizado' | 'local'
  curriculoContenidoId: string | null
  campoFormativo: { id: string; nombre: string } | null
  pda: PdaTrazabilidadCurricular[]
}

export type TrazabilidadCurricularPlaneacion = {
  programaAnaliticoId: string
  programaAnaliticoVersionId: string
  items: ItemTrazabilidadCurricular[]
}

type CamposV4Base = CamposComunesPlaneacionActiva & { schemaVersion: 4; contenidoCompleto: string; trazabilidadCurricular: TrazabilidadCurricularPlaneacion | null }
export type PlaneacionActivaV4Borrador = CamposV4Base & { estado: 'borrador'; implementadaEn: null }
export type PlaneacionActivaV4Implementada = CamposV4Base & { estado: 'implementada'; implementadaEn: string }
export type PlaneacionActivaV4 = PlaneacionActivaV4Borrador | PlaneacionActivaV4Implementada

export type PlaneacionActiva = PlaneacionActivaV1 | PlaneacionActivaV2 | PlaneacionActivaV3 | PlaneacionActivaV4

// V3 y V4 comparten exactamente la misma forma de ciclo de vida
// (estado/implementadaEn) — un ajuste puede partir de CUALQUIERA de
// los dos (un V3 histórico todavía en DB, o un V4 ya creado por esta
// fase), la salida de construirPlaneacionActivaAjustada siempre es V4.
export type PlaneacionActivaAjustable = PlaneacionActivaV3 | PlaneacionActivaV4

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
  origenMensajeId: string | null,
  trazabilidadCurricular: TrazabilidadCurricularPlaneacion | null
): PlaneacionActivaV4Borrador {
  return {
    schemaVersion: 4,
    version: 1,
    estado: 'borrador',
    contexto: { grupoId },
    borrador: resumen,
    contenidoCompleto,
    trazabilidadCurricular,
    origenMensajeId,
    actualizadoEn: new Date().toISOString(),
    implementadaEn: null,
  }
}

// PLN-1D §5 — construye trazabilidadCurricular EXCLUSIVAMENTE a partir
// de candidatos YA VALIDADOS server-side (ver
// validarSeleccionItemsProgramaAnalitico) y de
// programaAnaliticoId/programaAnaliticoVersionId que el LLAMADOR debe
// tomar del mismo contexto server-side usado para cargar esos
// candidatos (cargarCandidatosProgramaAnaliticoVigente) — nunca de
// nada que Claude haya escrito. Pura, 0 I/O.
export function construirTrazabilidadCurricular(
  programaAnaliticoId: string,
  programaAnaliticoVersionId: string,
  candidatosAceptados: CandidatoCurricularPlaneacion[]
): TrazabilidadCurricularPlaneacion {
  return {
    programaAnaliticoId,
    programaAnaliticoVersionId,
    items: candidatosAceptados.map((c) => ({
      programaAnaliticoItemId: c.programaAnaliticoItemId,
      procedencia: c.procedencia,
      curriculoContenidoId: c.curriculoContenidoId,
      campoFormativo: c.campoFormativo ? { id: c.campoFormativo.id, nombre: c.campoFormativo.nombre } : null,
      pda: c.pda.map((p) => ({
        programaAnaliticoItemPdaId: p.programaAnaliticoItemPdaId,
        curriculoPdaId: p.curriculoPdaId,
        curriculoPdaGradoId: p.curriculoPdaGradoId,
        texto: p.texto,
      })),
    })),
  }
}

// Construye el snapshot de un AJUSTE sobre una planeación V3 YA
// existente (Fase 3B.3) — pura, sin I/O. Preserva estrictamente lo que
// un ajuste NUNCA debe tocar: contexto.grupoId (siempre el mismo grupo
// del snapshot anterior — invariante multigrupo, nunca se re-deriva de
// otra fuente aquí), estado y implementadaEn (copiados literalmente,
// tanto si es null como si es una fecha real) — un ajuste jamás
// implementa ni desimplementa. Solo version (+1), borrador,
// contenidoCompleto y actualizadoEn cambian. Construida por rama de
// `estado` (nunca spread + cast) para que TypeScript garantice en
// compilación que el resultado sigue siendo un PlaneacionActivaV3
// coherente, sin depender de una aserción de tipo.
// PLN-1D §9 — snapshotAnterior puede ser V3 (histórico, sin
// trazabilidadCurricular) o V4 — en AMBOS casos la salida es V4 y
// trazabilidadCurricular viene SIEMPRE del parámetro nuevo, NUNCA de
// snapshotAnterior (aunque fuera V4 con una selección distinta) — un
// ajuste nunca mezcla silenciosamente identidad curricular vieja con
// nueva. Si el llamador no tiene contexto curricular disponible este
// turno (grupo sin PA, o una condición excepcional real), debe pasar
// null explícitamente — fail-closed, nunca se hereda la trazabilidad
// anterior "por si acaso".
export function construirPlaneacionActivaAjustada(
  snapshotAnterior: PlaneacionActivaAjustable,
  nuevoBorrador: ResumenBorrador,
  nuevoContenidoCompleto: string,
  origenMensajeId: string | null,
  trazabilidadCurricular: TrazabilidadCurricularPlaneacion | null
): PlaneacionActivaV4 {
  const base = {
    schemaVersion: 4 as const,
    version: snapshotAnterior.version + 1,
    contexto: { grupoId: snapshotAnterior.contexto.grupoId },
    borrador: nuevoBorrador,
    contenidoCompleto: nuevoContenidoCompleto,
    trazabilidadCurricular,
    origenMensajeId,
    actualizadoEn: new Date().toISOString(),
  }
  if (snapshotAnterior.estado === 'borrador') {
    return { ...base, estado: 'borrador', implementadaEn: null }
  }
  return { ...base, estado: 'implementada', implementadaEn: snapshotAnterior.implementadaEn }
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

// Compartida por schemaVersion 3 y 4 (ambos tienen exactamente la
// misma forma de ciclo de vida) — refuerza en runtime la misma
// coherencia que la unión discriminada de PlaneacionActivaV3/V4 ya
// exige en tiempo de compilación: 'borrador' exige implementadaEn
// EXACTAMENTE null (nunca un string, ni siquiera vacío); 'implementada'
// exige implementadaEn como fecha ISO 8601 ESTRICTA (ver
// esFechaIsoEstricta arriba), no cualquier valor meramente parseable
// por Date.parse. Cualquier otro valor de `estado`, o cualquier
// combinación cruzada, es inválido — fail-closed, nunca se aproxima ni
// se corrige el valor.
//
// NOTA — actualizadoEn (camposComunesValidos, compartido por v1/v2/v3/v4)
// sigue validándose solo con Date.parse, el mismo criterio laxo de
// siempre: NO se amplió a esFechaIsoEstricta en esta ronda porque no
// pude confirmar sin riesgo que TODOS los snapshots v1/v2 ya
// persistidos cumplan exactamente ese formato estricto (nunca
// inspeccioné el string crudo, solo su valor ya interpretado como
// fecha) — endurecerlo aquí podría invalidar un snapshot histórico
// real. Queda señalado como pendiente, no corregido.
function estadoCicloVidaValido(v: Record<string, unknown>): boolean {
  if (v.estado === 'borrador') return v.implementadaEn === null
  if (v.estado === 'implementada') return esFechaIsoEstricta(v.implementadaEn)
  return false
}

const PROCEDENCIAS_TRAZABILIDAD_VALIDAS = new Set(['oficial', 'contextualizado', 'local'])

// null es válido (campo formativo de un item local) — cuando SÍ viene
// un objeto, id y nombre deben ser strings reales no vacíos, nunca
// aproximados.
function campoFormativoTrazabilidadValido(v: unknown): boolean {
  if (v === null) return true
  if (typeof v !== 'object') return false
  const c = v as Record<string, unknown>
  return typeof c.id === 'string' && c.id.trim() !== '' && typeof c.nombre === 'string' && c.nombre.trim() !== ''
}

function pdaTrazabilidadValido(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false
  const p = v as Record<string, unknown>
  return (
    typeof p.programaAnaliticoItemPdaId === 'string' &&
    REGEX_UUID.test(p.programaAnaliticoItemPdaId) &&
    typeof p.curriculoPdaId === 'string' &&
    REGEX_UUID.test(p.curriculoPdaId) &&
    typeof p.curriculoPdaGradoId === 'string' &&
    REGEX_UUID.test(p.curriculoPdaGradoId) &&
    typeof p.texto === 'string' &&
    p.texto.trim() !== ''
  )
}

// Refuerza en runtime, en la última barrera antes de confiar en un
// snapshot leído de DB, el MISMO invariante que ya garantiza la
// construcción (construirTrazabilidadCurricular) y el propio PA-3A:
// un item con procedencia 'local' NUNCA tiene curriculoContenidoId,
// campoFormativo ni PDA — y un item oficial/contextualizado SIEMPRE
// tiene curriculoContenidoId real. Nunca confía en que el JSONB de DB
// ya venga bien formado solo porque esta misma función lo escribió
// alguna vez.
function itemTrazabilidadValido(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false
  const it = v as Record<string, unknown>
  if (typeof it.programaAnaliticoItemId !== 'string' || !REGEX_UUID.test(it.programaAnaliticoItemId)) return false
  if (typeof it.procedencia !== 'string' || !PROCEDENCIAS_TRAZABILIDAD_VALIDAS.has(it.procedencia)) return false
  if (!campoFormativoTrazabilidadValido(it.campoFormativo)) return false
  if (!Array.isArray(it.pda) || !it.pda.every(pdaTrazabilidadValido)) return false

  if (it.procedencia === 'local') {
    return it.curriculoContenidoId === null && it.campoFormativo === null && (it.pda as unknown[]).length === 0
  }
  return typeof it.curriculoContenidoId === 'string' && it.curriculoContenidoId.trim() !== ''
}

// SOLO para schemaVersion=4. null es válido (grupo sin Programa
// Analítico publicado ese turno). Cuando no es null: ids reales de
// programa_analitico/programa_analitico_version (nunca aproximados) e
// items[] (puede estar vacío — "PA disponible pero ninguna selección
// sobrevivió la validación" es un estado real y válido, nunca se trata
// como error).
function trazabilidadCurricularValida(v: Record<string, unknown>): boolean {
  const t = v.trazabilidadCurricular
  if (t === null) return true
  if (typeof t !== 'object') return false
  const tt = t as Record<string, unknown>
  if (typeof tt.programaAnaliticoId !== 'string' || !REGEX_UUID.test(tt.programaAnaliticoId)) return false
  if (typeof tt.programaAnaliticoVersionId !== 'string' || !REGEX_UUID.test(tt.programaAnaliticoVersionId)) return false
  if (!Array.isArray(tt.items) || !tt.items.every(itemTrazabilidadValido)) return false
  return true
}

export function esPlaneacionActivaValida(valor: unknown): valor is PlaneacionActiva {
  if (typeof valor !== 'object' || valor === null) return false
  const v = valor as Record<string, unknown>

  if (!camposComunesValidos(v)) return false

  if (v.schemaVersion === 1) return true
  if (v.schemaVersion === 2) return contenidoCompletoValido(v)
  if (v.schemaVersion === 3) return contenidoCompletoValido(v) && estadoCicloVidaValido(v)
  if (v.schemaVersion === 4) return contenidoCompletoValido(v) && estadoCicloVidaValido(v) && trazabilidadCurricularValida(v)
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
