// lib/programaAnalitico/publicarProgramaAnalitico.ts
//
// PA-3A — Única puerta server-side autorizada para publicar/ajustar una
// versión canónica de Programa Analítico. La IA futura (todavía no
// conectada) nunca escribirá directamente programa_analitico*: solo
// producirá una PropuestaProgramaAnalitico (ver tipos.ts) que este
// módulo valida antes de invocar la RPC real
// public.programa_analitico_publicar (ver migración
// 20260922000000_publicador_programa_analitico.sql).
//
// División de responsabilidades (ver informe PA-3A §6): este módulo
// hace la VALIDACIÓN DE DOMINIO (mensajes de error específicos, por
// item) — la base de datos sigue siendo la última barrera real (las
// FKs compuestas de PA-2A ya hacen estructuralmente imposible, por
// ejemplo, que un item referencie un contenido de otra versión, o que
// un item_pda referencie un PDA de otro grado/contenido — esta función
// no reimplementa esa integridad, solo la revalida donde no hay FK que
// la cubra: cobertura del campo concreto y pertenencia del periodo al
// ciclo del grupo).
//
// Recibe el cliente autenticado normal del servidor — nunca
// service_role. RLS de `grupos` (dentro de resolverContextoCurricularGrupo)
// y las policies de programa_analitico* (dentro de la RPC, SECURITY
// INVOKER) son la única barrera de propiedad real.

import type { SupabaseClient } from '@supabase/supabase-js'
import { resolverContextoCurricularGrupo } from '../curriculo/resolverContextoCurricularGrupo'
import type {
  ErrorValidacionPropuesta,
  PropuestaProgramaAnalitico,
  ResultadoPublicarProgramaAnalitico,
} from './tipos'

// ============================================================
// Validación pura de estructura — sin I/O, testeable con propuestas
// construidas a mano (ver scripts/verificar-publicador-programa-analitico.ts).
// No conoce el contexto curricular real: solo la forma de la propuesta.
// ============================================================

export function validarEstructuraPropuesta(propuesta: PropuestaProgramaAnalitico): ErrorValidacionPropuesta[] {
  const errores: ErrorValidacionPropuesta[] = []

  if (!propuesta.grupoId) errores.push({ tipo: 'GRUPO_SIN_ID' })
  if (!propuesta.idempotencyKey || propuesta.idempotencyKey.trim() === '') errores.push({ tipo: 'IDEMPOTENCY_KEY_VACIA' })
  if (propuesta.contextoNotas != null && propuesta.contextoNotas.trim() === '') errores.push({ tipo: 'CONTEXTO_NOTAS_VACIO' })
  if (!propuesta.items || propuesta.items.length === 0) {
    errores.push({ tipo: 'PROPUESTA_SIN_ITEMS' })
    return errores
  }

  const ordenesVistos = new Set<number>()
  for (const item of propuesta.items) {
    if (!Number.isInteger(item.orden) || item.orden <= 0) {
      errores.push({ tipo: 'ITEM_ORDEN_INVALIDO', claveLocal: item.claveLocal })
    } else if (ordenesVistos.has(item.orden)) {
      errores.push({ tipo: 'ORDEN_DUPLICADO', orden: item.orden })
    } else {
      ordenesVistos.add(item.orden)
    }

    if (item.tipoDecision !== 'sin_ajuste' && item.tipoDecision !== 'contextualizado' && item.tipoDecision !== 'nuevo') {
      errores.push({ tipo: 'ITEM_TIPO_DECISION_INVALIDO', claveLocal: item.claveLocal })
      continue
    }

    const contenidoPresente = !!item.curriculoContenidoId
    const textoContextualizadoPresente = !!item.textoContextualizado && item.textoContextualizado.trim() !== ''
    const textoLocalPresente = !!item.textoLocal && item.textoLocal.trim() !== ''
    const resultadoEsperadoPresente = item.resultadoEsperadoLocal != null

    if (item.tipoDecision === 'sin_ajuste') {
      if (!contenidoPresente) errores.push({ tipo: 'ITEM_SIN_AJUSTE_CONTENIDO_FALTANTE', claveLocal: item.claveLocal })
      if (textoContextualizadoPresente || textoLocalPresente) errores.push({ tipo: 'ITEM_SIN_AJUSTE_TEXTO_NO_PERMITIDO', claveLocal: item.claveLocal })
    }

    if (item.tipoDecision === 'contextualizado') {
      if (!contenidoPresente) errores.push({ tipo: 'ITEM_CONTEXTUALIZADO_CONTENIDO_FALTANTE', claveLocal: item.claveLocal })
      if (!textoContextualizadoPresente) errores.push({ tipo: 'ITEM_CONTEXTUALIZADO_TEXTO_VACIO', claveLocal: item.claveLocal })
      if (textoLocalPresente) errores.push({ tipo: 'ITEM_CONTEXTUALIZADO_TEXTO_LOCAL_NO_PERMITIDO', claveLocal: item.claveLocal })
    }

    if (item.tipoDecision === 'nuevo') {
      if (contenidoPresente) errores.push({ tipo: 'ITEM_NUEVO_CONTENIDO_NO_PERMITIDO', claveLocal: item.claveLocal })
      if (!textoLocalPresente) errores.push({ tipo: 'ITEM_NUEVO_TEXTO_VACIO', claveLocal: item.claveLocal })
      if (item.curriculoPdaGradoIds.length > 0) errores.push({ tipo: 'ITEM_NUEVO_CON_PDA', claveLocal: item.claveLocal })
    }

    // resultado_esperado_local: el CHECK real de la DB solo lo permite
    // en items 'nuevo' (ver programa_analitico_item_check1) — se
    // revalida aquí para dar un error de dominio claro, no un error de
    // constraint.
    if (item.tipoDecision !== 'nuevo' && resultadoEsperadoPresente) {
      errores.push({ tipo: 'ITEM_RESULTADO_ESPERADO_NO_PERMITIDO', claveLocal: item.claveLocal })
    }
    if (resultadoEsperadoPresente && item.resultadoEsperadoLocal!.trim() === '') {
      errores.push({ tipo: 'ITEM_RESULTADO_ESPERADO_VACIO', claveLocal: item.claveLocal })
    }
  }

  return errores
}

// ============================================================
// Orquestador real (I/O contra Supabase, respeta RLS).
// ============================================================

export async function publicarProgramaAnalitico(
  sb: SupabaseClient,
  propuesta: PropuestaProgramaAnalitico
): Promise<ResultadoPublicarProgramaAnalitico> {
  const erroresEstructura = validarEstructuraPropuesta(propuesta)
  if (erroresEstructura.length > 0) return { ok: false, error: erroresEstructura[0] }

  const resultadoContexto = await resolverContextoCurricularGrupo(sb, propuesta.grupoId)
  if (!resultadoContexto.ok) {
    return { ok: false, error: { tipo: 'CONTEXTO_CURRICULAR_NO_RESUELTO', detalle: resultadoContexto.error } }
  }
  const contexto = resultadoContexto.contexto
  const camposCubiertosIds = new Set(contexto.camposConCobertura.map((c) => c.id))

  // --- Validar contenidos oficiales referenciados (sin_ajuste/contextualizado) ---
  const idsContenido = [...new Set(propuesta.items.map((i) => i.curriculoContenidoId).filter((id): id is string => !!id))]
  const contenidoPorId = new Map<string, { id: string; campo_formativo_id: string; curriculo_version_id: string }>()
  if (idsContenido.length > 0) {
    const { data: contenidos } = await sb
      .from('curriculo_contenido')
      .select('id, campo_formativo_id, curriculo_version_id')
      .in('id', idsContenido)
    for (const c of contenidos ?? []) {
      contenidoPorId.set(c.id as string, c as { id: string; campo_formativo_id: string; curriculo_version_id: string })
    }
  }

  for (const item of propuesta.items) {
    if (!item.curriculoContenidoId) continue
    const contenido = contenidoPorId.get(item.curriculoContenidoId)
    if (!contenido || contenido.curriculo_version_id !== contexto.curriculoVersionId) {
      return { ok: false, error: { tipo: 'CONTENIDO_NO_PERTENECE_AL_CONTEXTO', claveLocal: item.claveLocal } }
    }
    // Revalidación puntual del campo concreto — resolverContextoCurricularGrupo
    // ya exigió cobertura completa (todos los campos de la versión),
    // pero se revalida aquí explícitamente por si un futuro cambio de
    // esa función relajara esa garantía global.
    if (!camposCubiertosIds.has(contenido.campo_formativo_id)) {
      return { ok: false, error: { tipo: 'CONTENIDO_SIN_COBERTURA', claveLocal: item.claveLocal } }
    }
  }

  // --- Validar PDA ---
  const idsPdaGrado = [...new Set(propuesta.items.flatMap((i) => i.curriculoPdaGradoIds))]
  const pdaGradoPorId = new Map<string, { id: string; contenido_id: string; curriculo_grado_id: string; curriculo_version_id: string }>()
  if (idsPdaGrado.length > 0) {
    const { data: pdaGrados } = await sb
      .from('curriculo_pda_grado')
      .select('id, contenido_id, curriculo_grado_id, curriculo_version_id')
      .in('id', idsPdaGrado)
    for (const p of pdaGrados ?? []) {
      pdaGradoPorId.set(p.id as string, p as { id: string; contenido_id: string; curriculo_grado_id: string; curriculo_version_id: string })
    }
  }

  for (const item of propuesta.items) {
    for (const pdaGradoId of item.curriculoPdaGradoIds) {
      const pdaGrado = pdaGradoPorId.get(pdaGradoId)
      if (!pdaGrado) return { ok: false, error: { tipo: 'PDA_NO_ENCONTRADO', claveLocal: item.claveLocal, curriculoPdaGradoId: pdaGradoId } }
      const perteneceAlItem =
        pdaGrado.contenido_id === item.curriculoContenidoId &&
        pdaGrado.curriculo_grado_id === contexto.curriculoGradoId &&
        pdaGrado.curriculo_version_id === contexto.curriculoVersionId
      if (!perteneceAlItem) {
        return { ok: false, error: { tipo: 'PDA_NO_PERTENECE_AL_ITEM', claveLocal: item.claveLocal, curriculoPdaGradoId: pdaGradoId } }
      }
    }
  }

  // --- Validar periodo (mismo ciclo del grupo; "mismo docente" ya lo
  //     garantiza RLS de periodos_evaluacion sobre esta misma query). ---
  const idsPeriodo = [...new Set(propuesta.items.map((i) => i.periodoEvaluacionId).filter((id): id is string => !!id))]
  const periodoPorId = new Map<string, { id: string; ciclo_escolar_id: string }>()
  if (idsPeriodo.length > 0) {
    const { data: periodos } = await sb.from('periodos_evaluacion').select('id, ciclo_escolar_id').in('id', idsPeriodo)
    for (const p of periodos ?? []) periodoPorId.set(p.id as string, p as { id: string; ciclo_escolar_id: string })
  }

  for (const item of propuesta.items) {
    if (!item.periodoEvaluacionId) continue
    const periodo = periodoPorId.get(item.periodoEvaluacionId)
    if (!periodo) return { ok: false, error: { tipo: 'PERIODO_NO_ENCONTRADO', claveLocal: item.claveLocal, periodoEvaluacionId: item.periodoEvaluacionId } }
    if (periodo.ciclo_escolar_id !== contexto.cicloEscolarId) {
      return { ok: false, error: { tipo: 'PERIODO_DE_OTRO_CICLO', claveLocal: item.claveLocal, periodoEvaluacionId: item.periodoEvaluacionId } }
    }
  }

  // --- Todo válido: publicación atómica real vía RPC. ---
  const { data, error } = await sb.rpc('programa_analitico_publicar', {
    p_grupo_id: propuesta.grupoId,
    p_idempotency_key: propuesta.idempotencyKey,
    p_curriculo_version_id: contexto.curriculoVersionId,
    p_curriculo_fase_id: contexto.curriculoFaseId,
    p_curriculo_grado_id: contexto.curriculoGradoId,
    p_contexto_notas: propuesta.contextoNotas ?? null,
    p_items: propuesta.items.map((item) => ({
      orden: item.orden,
      tipoDecision: item.tipoDecision,
      curriculoContenidoId: item.curriculoContenidoId ?? null,
      textoContextualizado: item.textoContextualizado ?? null,
      textoLocal: item.textoLocal ?? null,
      resultadoEsperadoLocal: item.resultadoEsperadoLocal ?? null,
      periodoEvaluacionId: item.periodoEvaluacionId ?? null,
      curriculoPdaGradoIds: item.curriculoPdaGradoIds,
    })),
  })

  if (error) return { ok: false, error: { tipo: 'ERROR_PUBLICACION', mensaje: error.message } }

  return {
    ok: true,
    resultado: {
      programaAnaliticoId: data.programaAnaliticoId,
      programaAnaliticoVersionId: data.programaAnaliticoVersionId,
      numeroVersion: data.numeroVersion,
      reutilizadaPorIdempotencia: data.reutilizadaPorIdempotencia,
    },
  }
}
