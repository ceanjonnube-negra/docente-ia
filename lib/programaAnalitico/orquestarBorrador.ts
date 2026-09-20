// lib/programaAnalitico/orquestarBorrador.ts
//
// PA-4C — servicio server-side que conserva y opera un borrador de
// Programa Analítico en la tabla dedicada
// public.programa_analitico_borrador (ver migración
// 20260923000000_crear_programa_analitico_borrador.sql — auditoría de
// opciones de persistencia en el informe PA-4C §B/§C). El cliente
// futuro nunca transporta el borrador completo, solo `borradorId`; la
// fuente autoritativa siempre es esta tabla, revalidada en cada
// operación.
//
// Todas las funciones reciben el cliente autenticado normal del
// servidor — nunca service_role. Ownership se deriva SIEMPRE de RLS
// (docente_id = auth.uid()), nunca de un docente_id que el llamador
// pudiera pasar.

import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolverContextoCurricularGrupo } from '../curriculo/resolverContextoCurricularGrupo'
import { recuperarCatalogoCurricularCerrado, type CatalogoCurricularCerrado } from './candidatosCurriculares'
import {
  agregarContenidoLocal,
  construirResumenPropuesta,
  eliminarContenidoNuevo,
  excluirContenido,
  reconstruirPropuesta,
  reemplazarContextualizacion,
  restaurarContenido,
  type BorradorProgramaAnalitico,
  type DeltaBorrador,
  type ErrorReconstruccion,
  type IdentidadCurricularFijada,
  type ResumenPropuesta,
} from './borradorProgramaAnalitico'
import { construirBaseProgramaAnalitico, generarPropuestaProgramaAnalitico, type GenerarPropuestaInput } from './generarPropuestaProgramaAnalitico'
import { publicarProgramaAnalitico } from './publicarProgramaAnalitico'
import type { CategoriaContextoPedagogico, DiagnosticoPropuestaIaInvalida, FaltanteInformacionGeneracion, ResultadoPublicacion } from './tipos'

export type EstadoBorrador = 'pendiente' | 'publicado' | 'descartado'

export type ErrorOrquestacionBorrador =
  | { tipo: 'NO_AUTENTICADO' }
  | { tipo: 'BORRADOR_NO_ENCONTRADO' }
  | { tipo: 'BORRADOR_CORRUPTO' }
  | { tipo: 'BORRADOR_YA_PUBLICADO'; programaAnaliticoVersionId: string | null }
  | { tipo: 'BORRADOR_DESCARTADO' }
  | { tipo: 'YA_HAY_BORRADOR_PENDIENTE'; borradorId: string }
  | { tipo: 'CONTEXTO_CURRICULAR_NO_RESUELTO'; detalle: string }
  | ErrorReconstruccion
  | { tipo: 'ERROR_PERSISTENCIA'; mensaje: string }
  | { tipo: 'ERROR_PUBLICACION'; mensaje: string }

// ============================================================
// Acceso a datos — únicamente esta tabla; nunca mensajes_chat como
// almacén del borrador (PA-4C §21).
// ============================================================

type FilaBorrador = {
  id: string
  grupo_id: string
  idempotency_key: string
  curriculo_version_id: string
  curriculo_fase_id: string
  curriculo_grado_id: string
  contexto_docente: string | null
  contexto_notas: string | null
  deltas: unknown
  estado: EstadoBorrador
  programa_analitico_version_id: string | null
}

const COLUMNAS_BORRADOR =
  'id, grupo_id, idempotency_key, curriculo_version_id, curriculo_fase_id, curriculo_grado_id, contexto_docente, contexto_notas, deltas, estado, programa_analitico_version_id'

async function cargarFilaBorrador(sb: SupabaseClient, borradorId: string): Promise<FilaBorrador | null> {
  const { data } = await sb.from('programa_analitico_borrador').select(COLUMNAS_BORRADOR).eq('id', borradorId).maybeSingle()
  return (data as FilaBorrador | null) ?? null
}

// PA-4D — "el estado manda, no la IA" (ver informe PA-4D §4): dado un
// grupo, resuelve DETERMINÍSTICAMENTE si existe un borrador pendiente,
// sin depender de que el clasificador de Nivel 0 lo recuerde. RLS ya
// filtra a los propios; solo devuelve id/estado, nunca el JSONB
// completo (el llamador usa obtenerBorradorProgramaAnalitico si
// necesita el resumen real).
export async function buscarBorradorPendientePorGrupo(sb: SupabaseClient, grupoId: string): Promise<{ id: string } | null> {
  const { data } = await sb.from('programa_analitico_borrador').select('id').eq('grupo_id', grupoId).eq('estado', 'pendiente').maybeSingle()
  return (data as { id: string } | null) ?? null
}

// Nunca se asume que el JSONB leído de DB es válido solo porque vino
// de ahí (PA-4C §20) — se revalida la forma completa de cada delta,
// igual de estricto que al incorporar la respuesta cruda de la IA.
function parsearDeltasPersistidos(json: unknown): DeltaBorrador[] | null {
  if (!Array.isArray(json)) return null
  const deltas: DeltaBorrador[] = []
  for (const d of json as Record<string, unknown>[]) {
    if (typeof d !== 'object' || d === null) return null
    if (d.decision === 'excluir') {
      if (typeof d.curriculoContenidoId !== 'string') return null
      deltas.push({ decision: 'excluir', curriculoContenidoId: d.curriculoContenidoId })
    } else if (d.decision === 'contextualizar') {
      if (typeof d.curriculoContenidoId !== 'string' || typeof d.textoContextualizado !== 'string') return null
      const seleccion = d.curriculoPdaGradoIdsSeleccionados
      if (seleccion !== undefined && (!Array.isArray(seleccion) || !seleccion.every((v) => typeof v === 'string'))) return null
      deltas.push({
        decision: 'contextualizar',
        curriculoContenidoId: d.curriculoContenidoId,
        textoContextualizado: d.textoContextualizado,
        curriculoPdaGradoIdsSeleccionados: Array.isArray(seleccion) ? (seleccion as string[]) : undefined,
      })
    } else if (d.decision === 'nuevo') {
      if (typeof d.claveLocal !== 'string' || typeof d.textoLocal !== 'string') return null
      deltas.push({
        decision: 'nuevo',
        claveLocal: d.claveLocal,
        textoLocal: d.textoLocal,
        resultadoEsperadoLocal: typeof d.resultadoEsperadoLocal === 'string' ? d.resultadoEsperadoLocal : null,
      })
    } else {
      return null
    }
  }
  return deltas
}

function parsearBorradorDesdeFila(fila: FilaBorrador): BorradorProgramaAnalitico | null {
  const deltas = parsearDeltasPersistidos(fila.deltas)
  if (deltas === null) return null
  return {
    grupoId: fila.grupo_id,
    idempotencyKey: fila.idempotency_key,
    identidadCurricular: { curriculoVersionId: fila.curriculo_version_id, curriculoFaseId: fila.curriculo_fase_id, curriculoGradoId: fila.curriculo_grado_id },
    contextoDocente: fila.contexto_docente,
    contextoNotas: fila.contexto_notas,
    deltas,
  }
}

// Resuelve identidad curricular ACTUAL + catálogo + base — mismo
// costo en cada operación posterior a la creación (recuperar/ajustar/
// confirmar), nunca se cachea entre requests distintos (cada request
// es su propia resolución fresca, fail-closed si el currículo cambió
// mientras el borrador estaba pendiente).
async function resolverIdentidadCatalogoYBase(
  sb: SupabaseClient,
  grupoId: string
): Promise<{ ok: true; identidad: IdentidadCurricularFijada; catalogo: CatalogoCurricularCerrado; base: ReturnType<typeof construirBaseProgramaAnalitico> } | { ok: false; error: { tipo: 'CONTEXTO_CURRICULAR_NO_RESUELTO'; detalle: string } }> {
  const contexto = await resolverContextoCurricularGrupo(sb, grupoId)
  if (!contexto.ok) return { ok: false, error: { tipo: 'CONTEXTO_CURRICULAR_NO_RESUELTO', detalle: contexto.error } }
  const identidad: IdentidadCurricularFijada = {
    curriculoVersionId: contexto.contexto.curriculoVersionId,
    curriculoFaseId: contexto.contexto.curriculoFaseId,
    curriculoGradoId: contexto.contexto.curriculoGradoId,
  }
  const catalogo = await recuperarCatalogoCurricularCerrado(sb, contexto.contexto)
  const base = construirBaseProgramaAnalitico(catalogo)
  return { ok: true, identidad, catalogo, base }
}

// ============================================================
// 1. Crear/generar.
// ============================================================

export type ResultadoPrepararBorrador =
  | { ok: true; borradorId: string; estado: 'pendiente'; resumen: ResumenPropuesta }
  | { ok: false; requiereContexto: true; categorias: CategoriaContextoPedagogico[] }
  | { ok: false; requiereInformacion: true; faltantes: FaltanteInformacionGeneracion[] }
  | { ok: false; error: ErrorOrquestacionBorrador | { tipo: 'PROPUESTA_IA_INVALIDA'; diagnostico: DiagnosticoPropuestaIaInvalida } | { tipo: 'ERROR_GENERACION'; mensaje: string } }

export async function prepararBorradorProgramaAnalitico(
  sb: SupabaseClient,
  anthropic: Anthropic,
  input: GenerarPropuestaInput
): Promise<ResultadoPrepararBorrador> {
  const { data: userData } = await sb.auth.getUser()
  const docenteId = userData?.user?.id
  if (!docenteId) return { ok: false, error: { tipo: 'NO_AUTENTICADO' } }

  // Chequeo temprano (server-side, antes de gastar ninguna llamada IA)
  // — el UNIQUE índice parcial de DB es la garantía REAL contra una
  // carrera; esto solo da un error claro en el caso normal (no
  // concurrente) de "ya hay uno pendiente".
  const pendienteExistente = await buscarBorradorPendientePorGrupo(sb, input.grupoId)
  if (pendienteExistente) return { ok: false, error: { tipo: 'YA_HAY_BORRADOR_PENDIENTE', borradorId: pendienteExistente.id } }

  // Una sola resolución lógica: reutiliza TODO el pipeline existente
  // (resolver contexto, catálogo, contexto interno, evaluar
  // suficiencia, generar deltas) sin repetir ningún SELECT — el
  // resultado detallado ya expone identidadCurricular/deltas/catalogo
  // (PA-4C §J).
  const resultado = await generarPropuestaProgramaAnalitico(sb, anthropic, input)
  if (!resultado.ok) return resultado

  const { data: fila, error } = await sb
    .from('programa_analitico_borrador')
    .insert({
      docente_id: docenteId,
      grupo_id: input.grupoId,
      idempotency_key: resultado.propuesta.idempotencyKey,
      curriculo_version_id: resultado.identidadCurricular.curriculoVersionId,
      curriculo_fase_id: resultado.identidadCurricular.curriculoFaseId,
      curriculo_grado_id: resultado.identidadCurricular.curriculoGradoId,
      contexto_docente: input.contextoDocente ?? null,
      contexto_notas: resultado.propuesta.contextoNotas,
      deltas: resultado.deltas,
    })
    .select('id')
    .single()

  if (error || !fila) {
    // El UNIQUE parcial pudo dispararse aquí por una carrera real
    // (dos requests casi simultáneas pasaron el chequeo temprano) —
    // se reporta igual como YA_HAY_BORRADOR_PENDIENTE en vez de un
    // error de persistencia genérico, ya que es semánticamente lo que
    // ocurrió.
    if (error?.code === '23505') return { ok: false, error: { tipo: 'YA_HAY_BORRADOR_PENDIENTE', borradorId: '' } }
    return { ok: false, error: { tipo: 'ERROR_PERSISTENCIA', mensaje: error?.message ?? 'No se pudo crear el borrador.' } }
  }

  const borrador: BorradorProgramaAnalitico = {
    grupoId: input.grupoId,
    idempotencyKey: resultado.propuesta.idempotencyKey,
    identidadCurricular: resultado.identidadCurricular,
    contextoDocente: input.contextoDocente ?? null,
    contextoNotas: resultado.propuesta.contextoNotas ?? null,
    deltas: resultado.deltas,
  }
  const resumen = construirResumenPropuesta(resultado.catalogo, borrador, resultado.propuesta)

  return { ok: true, borradorId: fila.id as string, estado: 'pendiente', resumen }
}

// ============================================================
// 2. Recuperar. 0 IA.
// ============================================================

export type ResultadoObtenerBorrador =
  | { ok: true; borradorId: string; estado: EstadoBorrador; resumen: ResumenPropuesta }
  | { ok: false; error: ErrorOrquestacionBorrador }

export async function obtenerBorradorProgramaAnalitico(sb: SupabaseClient, borradorId: string): Promise<ResultadoObtenerBorrador> {
  const fila = await cargarFilaBorrador(sb, borradorId)
  if (!fila) return { ok: false, error: { tipo: 'BORRADOR_NO_ENCONTRADO' } }

  const borrador = parsearBorradorDesdeFila(fila)
  if (!borrador) return { ok: false, error: { tipo: 'BORRADOR_CORRUPTO' } }

  const resuelto = await resolverIdentidadCatalogoYBase(sb, fila.grupo_id)
  if (!resuelto.ok) return { ok: false, error: resuelto.error }

  const reconstruido = reconstruirPropuesta(resuelto.base, resuelto.identidad, borrador)
  if (!reconstruido.ok) return { ok: false, error: reconstruido.error }

  const resumen = construirResumenPropuesta(resuelto.catalogo, borrador, reconstruido.propuesta)
  return { ok: true, borradorId: fila.id, estado: fila.estado, resumen }
}

// ============================================================
// 3. Ajustar — solo operaciones estructuradas ya resueltas, nunca
//    interpreta lenguaje natural (PA-4C §13, responsabilidad de una
//    capa conversacional futura). 0 IA.
// ============================================================

export type OperacionAjusteBorrador =
  | { tipo: 'excluir'; curriculoContenidoId: string }
  | { tipo: 'restaurar'; curriculoContenidoId: string }
  | { tipo: 'contextualizar'; curriculoContenidoId: string; textoContextualizado: string; curriculoPdaGradoIdsSeleccionados?: string[] }
  | { tipo: 'agregarNuevo'; textoLocal: string; resultadoEsperadoLocal?: string | null }
  | { tipo: 'eliminarNuevo'; claveLocal: string }

export type ResultadoAjustarBorrador =
  | { ok: true; borradorId: string; resumen: ResumenPropuesta; claveLocalNueva?: string }
  | { ok: false; error: ErrorOrquestacionBorrador }

export async function ajustarBorradorProgramaAnalitico(
  sb: SupabaseClient,
  borradorId: string,
  operacion: OperacionAjusteBorrador
): Promise<ResultadoAjustarBorrador> {
  const fila = await cargarFilaBorrador(sb, borradorId)
  if (!fila) return { ok: false, error: { tipo: 'BORRADOR_NO_ENCONTRADO' } }
  if (fila.estado === 'publicado') return { ok: false, error: { tipo: 'BORRADOR_YA_PUBLICADO', programaAnaliticoVersionId: fila.programa_analitico_version_id } }
  if (fila.estado === 'descartado') return { ok: false, error: { tipo: 'BORRADOR_DESCARTADO' } }

  const borrador = parsearBorradorDesdeFila(fila)
  if (!borrador) return { ok: false, error: { tipo: 'BORRADOR_CORRUPTO' } }

  const resuelto = await resolverIdentidadCatalogoYBase(sb, fila.grupo_id)
  if (!resuelto.ok) return { ok: false, error: resuelto.error }

  if (
    resuelto.identidad.curriculoVersionId !== borrador.identidadCurricular.curriculoVersionId ||
    resuelto.identidad.curriculoFaseId !== borrador.identidadCurricular.curriculoFaseId ||
    resuelto.identidad.curriculoGradoId !== borrador.identidadCurricular.curriculoGradoId
  ) {
    return { ok: false, error: { tipo: 'IDENTIDAD_CURRICULAR_CAMBIO', esperada: borrador.identidadCurricular, actual: resuelto.identidad } }
  }

  let claveLocalNueva: string | undefined
  let borradorActualizado: BorradorProgramaAnalitico
  switch (operacion.tipo) {
    case 'excluir':
      borradorActualizado = excluirContenido(borrador, operacion.curriculoContenidoId)
      break
    case 'restaurar':
      borradorActualizado = restaurarContenido(borrador, operacion.curriculoContenidoId)
      break
    case 'contextualizar':
      borradorActualizado = reemplazarContextualizacion(borrador, operacion.curriculoContenidoId, operacion.textoContextualizado, operacion.curriculoPdaGradoIdsSeleccionados)
      break
    case 'agregarNuevo': {
      const r = agregarContenidoLocal(borrador, operacion.textoLocal, operacion.resultadoEsperadoLocal)
      borradorActualizado = r.borrador
      claveLocalNueva = r.claveLocal
      break
    }
    case 'eliminarNuevo':
      borradorActualizado = eliminarContenidoNuevo(borrador, operacion.claveLocal)
      break
  }

  // Reconstruye y valida ANTES de persistir — si falla, el borrador en
  // DB queda exactamente como estaba (fail-closed, nunca se guarda un
  // estado a medias).
  const reconstruido = reconstruirPropuesta(resuelto.base, resuelto.identidad, borradorActualizado)
  if (!reconstruido.ok) return { ok: false, error: reconstruido.error }

  const { error } = await sb
    .from('programa_analitico_borrador')
    .update({ deltas: borradorActualizado.deltas, actualizado_en: new Date().toISOString() })
    .eq('id', borradorId)
    .eq('estado', 'pendiente')
  if (error) return { ok: false, error: { tipo: 'ERROR_PERSISTENCIA', mensaje: error.message } }

  const resumen = construirResumenPropuesta(resuelto.catalogo, borradorActualizado, reconstruido.propuesta)
  return { ok: true, borradorId, resumen, claveLocalNueva }
}

// ============================================================
// 4. Descartar — libera el slot "1 pendiente por grupo". Conserva el
//    registro (trazabilidad ligera, PA-4C §14) — nunca borrado físico.
// ============================================================

export type ResultadoDescartarBorrador = { ok: true } | { ok: false; error: ErrorOrquestacionBorrador }

export async function descartarBorradorProgramaAnalitico(sb: SupabaseClient, borradorId: string): Promise<ResultadoDescartarBorrador> {
  const { data, error } = await sb
    .from('programa_analitico_borrador')
    .update({ estado: 'descartado', actualizado_en: new Date().toISOString() })
    .eq('id', borradorId)
    .eq('estado', 'pendiente')
    .select('id')
  if (error) return { ok: false, error: { tipo: 'ERROR_PERSISTENCIA', mensaje: error.message } }
  if (!data || data.length === 0) {
    // Puede ser: no existe, es de otro docente (RLS ya lo ocultó), o
    // ya no está pendiente — se audita cuál con una lectura adicional
    // solo para dar un error preciso.
    const fila = await cargarFilaBorrador(sb, borradorId)
    if (!fila) return { ok: false, error: { tipo: 'BORRADOR_NO_ENCONTRADO' } }
    if (fila.estado === 'publicado') return { ok: false, error: { tipo: 'BORRADOR_YA_PUBLICADO', programaAnaliticoVersionId: fila.programa_analitico_version_id } }
    return { ok: false, error: { tipo: 'BORRADOR_DESCARTADO' } }
  }
  return { ok: true }
}

// ============================================================
// 5. Confirmar/publicar — única operación que escribe programa_analitico*.
//    Nunca recibe la propuesta del cliente; reconstruye 100%
//    server-side. 0 IA.
// ============================================================

export type ResultadoConfirmarBorrador =
  | { ok: true; resultado: ResultadoPublicacion }
  | { ok: false; error: ErrorOrquestacionBorrador | { tipo: 'PROPUESTA_INVALIDA_AL_CONFIRMAR'; diagnostico: unknown } }

export async function confirmarBorradorProgramaAnalitico(sb: SupabaseClient, borradorId: string): Promise<ResultadoConfirmarBorrador> {
  const fila = await cargarFilaBorrador(sb, borradorId)
  if (!fila) return { ok: false, error: { tipo: 'BORRADOR_NO_ENCONTRADO' } }

  // Idempotente a nivel de orquestador: confirmar dos veces el mismo
  // borrador ya publicado no vuelve a llamar nada — devuelve
  // directamente lo que ya se sabe (PA-4C §17). La RPC (PA-3A) sigue
  // siendo, además, idempotente por su propia idempotency_key si de
  // todos modos se reintentara.
  if (fila.estado === 'publicado') {
    if (!fila.programa_analitico_version_id) return { ok: false, error: { tipo: 'BORRADOR_CORRUPTO' } }
    const { data: version } = await sb
      .from('programa_analitico_version')
      .select('programa_analitico_id, numero_version')
      .eq('id', fila.programa_analitico_version_id)
      .maybeSingle()
    if (!version) return { ok: false, error: { tipo: 'BORRADOR_CORRUPTO' } }
    return {
      ok: true,
      resultado: {
        programaAnaliticoId: version.programa_analitico_id as string,
        programaAnaliticoVersionId: fila.programa_analitico_version_id,
        numeroVersion: version.numero_version as number,
        reutilizadaPorIdempotencia: true,
      },
    }
  }
  if (fila.estado === 'descartado') return { ok: false, error: { tipo: 'BORRADOR_DESCARTADO' } }

  const borrador = parsearBorradorDesdeFila(fila)
  if (!borrador) return { ok: false, error: { tipo: 'BORRADOR_CORRUPTO' } }

  const resuelto = await resolverIdentidadCatalogoYBase(sb, fila.grupo_id)
  if (!resuelto.ok) return { ok: false, error: resuelto.error }

  const reconstruido = reconstruirPropuesta(resuelto.base, resuelto.identidad, borrador)
  if (!reconstruido.ok) return { ok: false, error: reconstruido.error }

  // publicarProgramaAnalitico (PA-3A) revalida estructura + referencias
  // de nuevo — defensa en profundidad, nunca se salta por venir de un
  // borrador ya construido aquí.
  const resultadoPublicacion = await publicarProgramaAnalitico(sb, reconstruido.propuesta, { borradorId })
  if (!resultadoPublicacion.ok) {
    return { ok: false, error: { tipo: 'PROPUESTA_INVALIDA_AL_CONFIRMAR', diagnostico: resultadoPublicacion.error } }
  }

  return { ok: true, resultado: resultadoPublicacion.resultado }
}
