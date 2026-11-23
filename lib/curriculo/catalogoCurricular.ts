// lib/curriculo/catalogoCurricular.ts
//
// Catálogo CERRADO de campos, contenidos y PDA de un grupo, a partir del
// contexto ya resuelto por resolverContextoCurricularGrupo() — nunca
// vuelve a decidir grado, fase ni versión por su cuenta. Recuperado de
// test/images-v1 (lib/programaAnalitico/candidatosCurriculares.ts,
// PA-3B) con dos ajustes para no mezclar grados ni fases:
// - los contenidos se filtran también por la fase del grupo (una misma
//   versión puede traer varias fases);
// - un contenido sin ningún PDA para el grado del grupo no se ofrece:
//   en este grado no tiene proceso de desarrollo que planear.
// Selects deterministas y acotados por FK; sin embeddings ni RAG.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ContextoCurricularGrupo } from './resolverContextoCurricularGrupo'

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

  const [{ data: contenidosRaw }, { data: pdaGradoRaw }] = await Promise.all([
    sb
      .from('curriculo_contenido')
      .select('id, titulo, campo_formativo_id')
      .eq('curriculo_version_id', contexto.curriculoVersionId)
      .eq('fase_id', contexto.curriculoFaseId),
    // curriculo_grado_id es columna directa de curriculo_pda_grado: los
    // PDA de otro grado quedan fuera por construcción.
    sb
      .from('curriculo_pda_grado')
      .select('id, curriculo_pda_id, contenido_id')
      .eq('curriculo_grado_id', contexto.curriculoGradoId)
      .eq('curriculo_version_id', contexto.curriculoVersionId),
  ])

  const contenidosDelCampo = (contenidosRaw ?? []).filter((c) => idsCampo.has(c.campo_formativo_id as string))
  const idsContenidoDelCampo = new Set(contenidosDelCampo.map((c) => c.id as string))
  const pdaGradoFiltrado = (pdaGradoRaw ?? []).filter((pg) => idsContenidoDelCampo.has(pg.contenido_id as string))

  const idsPda = [...new Set(pdaGradoFiltrado.map((pg) => pg.curriculo_pda_id as string))]
  const textoPorPdaId = new Map<string, string>()
  if (idsPda.length > 0) {
    const { data: pdaTextos } = await sb.from('curriculo_pda').select('id, texto').in('id', idsPda)
    for (const p of pdaTextos ?? []) {
      const texto = String(p.texto ?? '').trim()
      if (texto) textoPorPdaId.set(p.id as string, texto)
    }
  }

  // Fail-closed: un PDA sin texto real no se ofrece (nunca un PDA vacío).
  const pda: PdaCandidato[] = pdaGradoFiltrado
    .filter((pg) => textoPorPdaId.has(pg.curriculo_pda_id as string))
    .map((pg) => ({
      curriculoPdaGradoId: pg.id as string,
      curriculoPdaId: pg.curriculo_pda_id as string,
      texto: textoPorPdaId.get(pg.curriculo_pda_id as string)!,
      contenidoId: pg.contenido_id as string,
    }))

  const contenidosConPda = new Set(pda.map((p) => p.contenidoId))
  const contenidos: ContenidoCandidato[] = contenidosDelCampo
    .filter((c) => contenidosConPda.has(c.id as string) && String(c.titulo ?? '').trim())
    .map((c) => ({ id: c.id as string, titulo: String(c.titulo).trim(), campoFormativoId: c.campo_formativo_id as string }))

  return { campos, contenidos, pda }
}
