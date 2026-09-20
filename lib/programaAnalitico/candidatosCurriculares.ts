// lib/programaAnalitico/candidatosCurriculares.ts
//
// PA-3B — recupera el catálogo CERRADO de campos/contenidos/PDA que la
// IA puede usar para proponer un Programa Analítico. Parte SIEMPRE del
// contexto ya resuelto por resolverContextoCurricularGrupo() — nunca
// vuelve a decidir grado/fase/versión por su cuenta. No envía el PDF,
// no usa embeddings/RAG: son selects deterministas y acotados por FK
// (curriculo_pda_grado ya trae contenido_id/curriculo_grado_id/
// curriculo_version_id denormalizados desde el addendum de PA-2A/2C,
// así que "PDA aplicables al grado" es un filtro directo, nunca un
// join que pudiera colar PDA de otro grado).

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ContextoCurricularGrupo } from '../curriculo/resolverContextoCurricularGrupo'

export type CampoCandidato = { id: string; clave: string; nombre: string }
export type ContenidoCandidato = { id: string; titulo: string; campoFormativoId: string }
export type PdaCandidato = { curriculoPdaGradoId: string; curriculoPdaId: string; texto: string; contenidoId: string }

export type CatalogoCurricularCerrado = {
  campos: CampoCandidato[]
  contenidos: ContenidoCandidato[]
  pda: PdaCandidato[]
}

export async function recuperarCatalogoCurricularCerrado(
  sb: SupabaseClient,
  contexto: ContextoCurricularGrupo
): Promise<CatalogoCurricularCerrado> {
  const campos: CampoCandidato[] = contexto.camposConCobertura.map((c) => ({ id: c.id, clave: c.clave, nombre: c.nombre }))
  const idsCampo = new Set(campos.map((c) => c.id))

  const { data: contenidosRaw } = await sb
    .from('curriculo_contenido')
    .select('id, titulo, campo_formativo_id')
    .eq('curriculo_version_id', contexto.curriculoVersionId)

  const contenidos: ContenidoCandidato[] = (contenidosRaw ?? [])
    .filter((c) => idsCampo.has(c.campo_formativo_id as string))
    .map((c) => ({ id: c.id as string, titulo: c.titulo as string, campoFormativoId: c.campo_formativo_id as string }))

  const idsContenido = new Set(contenidos.map((c) => c.id))

  // Filtro por curriculo_grado_id directo en curriculo_pda_grado (columna
  // denormalizada del addendum) — excluye PDA de otro grado por
  // construcción, sin depender de un join adicional que pudiera fallar.
  const { data: pdaGradoRaw } = await sb
    .from('curriculo_pda_grado')
    .select('id, curriculo_pda_id, contenido_id')
    .eq('curriculo_grado_id', contexto.curriculoGradoId)
    .eq('curriculo_version_id', contexto.curriculoVersionId)

  const pdaGradoFiltrado = (pdaGradoRaw ?? []).filter((pg) => idsContenido.has(pg.contenido_id as string))
  const idsPda = [...new Set(pdaGradoFiltrado.map((pg) => pg.curriculo_pda_id as string))]

  const textoPorPdaId = new Map<string, string>()
  if (idsPda.length > 0) {
    const { data: pdaTextos } = await sb.from('curriculo_pda').select('id, texto').in('id', idsPda)
    for (const p of pdaTextos ?? []) textoPorPdaId.set(p.id as string, p.texto as string)
  }

  const pda: PdaCandidato[] = pdaGradoFiltrado.map((pg) => ({
    curriculoPdaGradoId: pg.id as string,
    curriculoPdaId: pg.curriculo_pda_id as string,
    texto: textoPorPdaId.get(pg.curriculo_pda_id as string) ?? '',
    contenidoId: pg.contenido_id as string,
  }))

  return { campos, contenidos, pda }
}
