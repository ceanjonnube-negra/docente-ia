// lib/programaAnalitico/consultarProgramaAnaliticoVigente.ts
//
// PA-4D — lectura del Programa Analítico YA PUBLICADO y vigente de un
// grupo. 0 IA, 0 PDF, 0 RAG: todo sale de las tablas canónicas
// (programa_analitico*, curriculo_contenido, curriculo_pda) — la
// misma promesa arquitectónica que ya motivó PA-1A/PA-2A. Nunca
// vuelve a llamar a Anthropic para "recuperar" hechos que ya están en
// DB.

import type { SupabaseClient } from '@supabase/supabase-js'

export type PdaVigente = { curriculoPdaGradoId: string; texto: string }

export type ItemVigente = {
  curriculoContenidoId: string | null
  tituloOficial: string | null
  campoFormativoClave: string | null
  campoFormativoNombre: string | null
  tipoDecision: 'sin_ajuste' | 'contextualizado' | 'nuevo'
  textoContextualizado: string | null
  textoLocal: string | null
  pda: PdaVigente[]
}

export type ResultadoConsultarPAVigente =
  | { ok: true; existe: true; programaAnaliticoId: string; numeroVersion: number; contextoNotas: string | null; items: ItemVigente[] }
  | { ok: true; existe: false }

export async function consultarProgramaAnaliticoVigente(sb: SupabaseClient, grupoId: string): Promise<ResultadoConsultarPAVigente> {
  const { data: pa } = await sb.from('programa_analitico').select('id, version_vigente_id').eq('grupo_id', grupoId).maybeSingle()
  if (!pa || !pa.version_vigente_id) return { ok: true, existe: false }

  const { data: version } = await sb
    .from('programa_analitico_version')
    .select('numero_version, contexto_notas')
    .eq('id', pa.version_vigente_id)
    .maybeSingle()
  if (!version) return { ok: true, existe: false }

  const { data: itemsRaw } = await sb
    .from('programa_analitico_item')
    .select('id, curriculo_contenido_id, tipo_decision, texto_contextualizado, texto_local, orden')
    .eq('programa_analitico_version_id', pa.version_vigente_id)
    .order('orden', { ascending: true })
  const items = itemsRaw ?? []

  const idsContenido = [...new Set(items.map((i) => i.curriculo_contenido_id as string | null).filter((id): id is string => !!id))]
  const tituloPorContenido = new Map<string, { titulo: string; campoFormativoId: string }>()
  if (idsContenido.length > 0) {
    const { data: contenidos } = await sb.from('curriculo_contenido').select('id, titulo, campo_formativo_id').in('id', idsContenido)
    for (const c of contenidos ?? []) tituloPorContenido.set(c.id as string, { titulo: c.titulo as string, campoFormativoId: c.campo_formativo_id as string })
  }

  const idsCampo = [...new Set([...tituloPorContenido.values()].map((c) => c.campoFormativoId))]
  const campoPorId = new Map<string, { clave: string; nombre: string }>()
  if (idsCampo.length > 0) {
    const { data: campos } = await sb.from('curriculo_campo_formativo').select('id, clave, nombre').in('id', idsCampo)
    for (const c of campos ?? []) campoPorId.set(c.id as string, { clave: c.clave as string, nombre: c.nombre as string })
  }

  const idsItem = items.map((i) => i.id as string)
  const pdaPorItem = new Map<string, PdaVigente[]>()
  if (idsItem.length > 0) {
    const { data: itemPdaRaw } = await sb.from('programa_analitico_item_pda').select('programa_analitico_item_id, curriculo_pda_grado_id').in('programa_analitico_item_id', idsItem)
    const idsPdaGrado = [...new Set((itemPdaRaw ?? []).map((p) => p.curriculo_pda_grado_id as string))]
    const pdaIdPorGrado = new Map<string, string>()
    if (idsPdaGrado.length > 0) {
      const { data: pdaGrados } = await sb.from('curriculo_pda_grado').select('id, curriculo_pda_id').in('id', idsPdaGrado)
      for (const pg of pdaGrados ?? []) pdaIdPorGrado.set(pg.id as string, pg.curriculo_pda_id as string)
    }
    const idsPda = [...new Set([...pdaIdPorGrado.values()])]
    const textoPorPda = new Map<string, string>()
    if (idsPda.length > 0) {
      const { data: pdaTextos } = await sb.from('curriculo_pda').select('id, texto').in('id', idsPda)
      for (const p of pdaTextos ?? []) textoPorPda.set(p.id as string, p.texto as string)
    }
    for (const ip of itemPdaRaw ?? []) {
      const itemId = ip.programa_analitico_item_id as string
      const pdaGradoId = ip.curriculo_pda_grado_id as string
      const pdaId = pdaIdPorGrado.get(pdaGradoId)
      const lista = pdaPorItem.get(itemId) ?? []
      lista.push({ curriculoPdaGradoId: pdaGradoId, texto: (pdaId && textoPorPda.get(pdaId)) ?? '' })
      pdaPorItem.set(itemId, lista)
    }
  }

  const itemsVigentes: ItemVigente[] = items.map((i) => {
    const contenidoId = i.curriculo_contenido_id as string | null
    const info = contenidoId ? tituloPorContenido.get(contenidoId) : undefined
    const campo = info ? campoPorId.get(info.campoFormativoId) : undefined
    return {
      curriculoContenidoId: contenidoId,
      tituloOficial: info?.titulo ?? null,
      campoFormativoClave: campo?.clave ?? null,
      campoFormativoNombre: campo?.nombre ?? null,
      tipoDecision: i.tipo_decision as ItemVigente['tipoDecision'],
      textoContextualizado: i.texto_contextualizado as string | null,
      textoLocal: i.texto_local as string | null,
      pda: pdaPorItem.get(i.id as string) ?? [],
    }
  })

  return {
    ok: true,
    existe: true,
    programaAnaliticoId: pa.id as string,
    numeroVersion: version.numero_version as number,
    contextoNotas: (version.contexto_notas as string | null) ?? null,
    items: itemsVigentes,
  }
}

// Filtro determinista por campo formativo — 0 IA. Empareja por clave
// exacta o por coincidencia simple de palabra dentro del nombre del
// campo (ej. "lenguajes" en "¿qué tenemos en Lenguajes?"). Si no
// encuentra ninguna coincidencia clara, devuelve null (el llamador
// decide si mostrar todo o preguntar).
const CAMPOS_CONOCIDOS: { clave: string; palabras: string[] }[] = [
  { clave: 'lenguajes', palabras: ['lenguaje', 'lenguajes', 'lengua'] },
  { clave: 'saberes_pensamiento_cientifico', palabras: ['saberes', 'pensamiento cientifico', 'pensamiento científico', 'ciencias'] },
  { clave: 'etica_naturaleza_sociedades', palabras: ['etica', 'ética', 'naturaleza', 'sociedades'] },
  { clave: 'lo_humano_lo_comunitario', palabras: ['humano', 'comunitario'] },
]

function normalizarTexto(t: string): string {
  return t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

export function detectarCampoFormativoEnTexto(mensaje: string): string | null {
  const normalizado = normalizarTexto(mensaje)
  for (const c of CAMPOS_CONOCIDOS) {
    if (c.palabras.some((p) => normalizado.includes(normalizarTexto(p)))) return c.clave
  }
  return null
}

export function filtrarItemsPorCampo(items: ItemVigente[], campoFormativoClave: string): ItemVigente[] {
  return items.filter((i) => i.campoFormativoClave === campoFormativoClave)
}
