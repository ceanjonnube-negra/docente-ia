// lib/programaAnalitico/validacionReferencial.ts
//
// PA-3B — reglas de pertenencia referencial extraídas de PA-3A
// (publicarProgramaAnalitico.ts) para reutilizarlas también en el
// generador (generarPropuestaProgramaAnalitico.ts) sin duplicarlas.
// Puras: reciben catálogos YA CARGADOS en memoria (Maps/Sets armados
// por el llamador a partir de sus propias queries), nunca hacen I/O
// ellas mismas — así sirven tanto para validar contra un catálogo leído
// de Supabase (publicador) como contra el mismo catálogo cerrado que ya
// se le entregó a la IA (generador), sin repetir queries.
//
// El publicador sigue haciendo su propia consulta + esta misma
// validación cuando efectivamente publique (defensa en profundidad,
// ver informe PA-3A §6) — este módulo no cambia esa garantía, solo evita
// que la lógica de pertenencia viva duplicada en dos archivos.

import type { ErrorValidacionPropuesta, ItemPropuestaProgramaAnalitico } from './tipos'

export type CatalogoContenido = { id: string; campoFormativoId: string; curriculoVersionId: string }
export type CatalogoPdaGrado = { id: string; contenidoId: string; curriculoGradoId: string; curriculoVersionId: string }
export type CatalogoPeriodo = { id: string; cicloEscolarId: string }

export type ContextoValidacionReferencial = {
  curriculoVersionId: string
  curriculoGradoId: string
  cicloEscolarId: string
  camposCubiertosIds: Set<string>
  contenidoPorId: Map<string, CatalogoContenido>
  pdaGradoPorId: Map<string, CatalogoPdaGrado>
  periodoPorId: Map<string, CatalogoPeriodo>
}

// Devuelve el primer error de pertenencia referencial encontrado en
// TODA la propuesta (contenido → cobertura → PDA → periodo, en ese
// orden, item por item) o null si todos los items son referencialmente
// válidos contra el catálogo dado. No valida la FORMA de la propuesta
// (eso es validarEstructuraPropuesta, en publicarProgramaAnalitico.ts)
// — asume que ya pasó esa validación.
export function validarReferenciasPropuesta(
  items: ItemPropuestaProgramaAnalitico[],
  ctx: ContextoValidacionReferencial
): ErrorValidacionPropuesta | null {
  for (const item of items) {
    if (item.curriculoContenidoId) {
      const contenido = ctx.contenidoPorId.get(item.curriculoContenidoId)
      if (!contenido || contenido.curriculoVersionId !== ctx.curriculoVersionId) {
        return { tipo: 'CONTENIDO_NO_PERTENECE_AL_CONTEXTO', claveLocal: item.claveLocal }
      }
      if (!ctx.camposCubiertosIds.has(contenido.campoFormativoId)) {
        return { tipo: 'CONTENIDO_SIN_COBERTURA', claveLocal: item.claveLocal }
      }
    }

    for (const pdaGradoId of item.curriculoPdaGradoIds) {
      const pdaGrado = ctx.pdaGradoPorId.get(pdaGradoId)
      if (!pdaGrado) return { tipo: 'PDA_NO_ENCONTRADO', claveLocal: item.claveLocal, curriculoPdaGradoId: pdaGradoId }
      const perteneceAlItem =
        pdaGrado.contenidoId === item.curriculoContenidoId &&
        pdaGrado.curriculoGradoId === ctx.curriculoGradoId &&
        pdaGrado.curriculoVersionId === ctx.curriculoVersionId
      if (!perteneceAlItem) {
        return { tipo: 'PDA_NO_PERTENECE_AL_ITEM', claveLocal: item.claveLocal, curriculoPdaGradoId: pdaGradoId }
      }
    }

    if (item.periodoEvaluacionId) {
      const periodo = ctx.periodoPorId.get(item.periodoEvaluacionId)
      if (!periodo) return { tipo: 'PERIODO_NO_ENCONTRADO', claveLocal: item.claveLocal, periodoEvaluacionId: item.periodoEvaluacionId }
      if (periodo.cicloEscolarId !== ctx.cicloEscolarId) {
        return { tipo: 'PERIODO_DE_OTRO_CICLO', claveLocal: item.claveLocal, periodoEvaluacionId: item.periodoEvaluacionId }
      }
    }
  }
  return null
}
