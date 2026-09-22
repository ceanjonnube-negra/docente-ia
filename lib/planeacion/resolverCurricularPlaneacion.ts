// lib/planeacion/resolverCurricularPlaneacion.ts
//
// PLN-1B — resolución curricular determinista para Planeación (§1-5).
// PLN-1C (§6) añade prepararContextoCurricularPlaneacion, el punto de
// entrada real que sí integra esto con
// lib/planeacion/generarBorrador.ts — MODO A (candidatos cerrados ya
// resueltos) / MODO B (catálogo compacto para que Claude elija dentro
// de un conjunto cerrado, en la MISMA llamada de generación, 0 IA
// adicional). La validación de lo que Claude selecciona vive aparte,
// en lib/planeacion/validarSeleccionCurricularPlaneacion.ts.
//
// Objetivo: dado un grupo y una solicitud del docente (tema libre y/o
// referencias explícitas de campo/contenido/PDA), resolver
// determinísticamente contra el Programa Analítico PUBLICADO del
// grupo — nunca contra el currículo oficial suelto, nunca inventando
// una identidad. 0 IA, 0 embeddings, 0 RAG (ver informe PLN-1A §D/§E).
//
// Reutiliza, nunca reimplementa:
//   - la identidad de versión ya resuelta y publicada por PA-3A/PA-4C
//     (programa_analitico.version_vigente_id) — la MISMA fuente de
//     verdad que ya usa confirmarBorradorProgramaAnalitico.
//   - el mismo patrón de "seleccionar ids, batch-seleccionar catálogo
//     relacionado, armar con Maps" que ya usa
//     lib/programaAnalitico/publicarProgramaAnalitico.ts — nunca un
//     JOIN embebido de PostgREST nuevo, nunca una segunda arquitectura
//     de resolución de grupo/fase/grado/versión (esa vive únicamente
//     en lib/curriculo/resolverContextoCurricularGrupo.ts, y aquí ni
//     se toca: la versión curricular ya quedó fijada al publicar el
//     PA — ver programa_analitico_version.curriculo_version_id/
//     curriculo_fase_id/curriculo_grado_id — nunca se vuelve a
//     resolver desde el grupo).
//
// Por qué "cargar los 86 items completos y rankear en memoria" (opción
// B del informe PLN-1A §10) y no un ranking en SQL: 86 filas (y su PDA
// asociado, ~250 filas) es un volumen trivial para Postgres/Node, y
// mantener el algoritmo de coincidencia léxica en TypeScript puro lo
// hace testeable sin DB (ver scripts/verificar-resolver-curricular-
// planeacion.ts) y evita reimplementar normalización de acentos/tokens
// dentro de SQL. Lo que NUNCA se envía a ningún lado son los 86 items
// completos al modelo — eso sigue prohibido (PLN-1C, fuera de
// alcance).

import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// 1. Contrato — tipos públicos.
// ============================================================

export type ProcedenciaCandidatoPlaneacion = 'oficial' | 'contextualizado' | 'local'

export type PdaCandidatoPlaneacion = {
  // Identidad real de la fila de relación (programa_analitico_item_pda.id)
  // — nunca inventada, siempre trazable a la fila real.
  programaAnaliticoItemPdaId: string
  curriculoPdaGradoId: string
  curriculoPdaId: string
  texto: string
}

export type CampoFormativoCandidato = { id: string; clave: string; nombre: string }

export type CandidatoCurricularPlaneacion = {
  programaAnaliticoId: string
  programaAnaliticoVersionId: string
  programaAnaliticoItemId: string

  procedencia: ProcedenciaCandidatoPlaneacion

  // null EXCLUSIVAMENTE cuando procedencia==='local' — un item local
  // nunca lleva identidad oficial, ni real ni aproximada (PA-3A ya lo
  // garantiza estructuralmente: 'nuevo' nunca persiste
  // curriculo_contenido_id).
  curriculoContenidoId: string | null

  campoFormativo: CampoFormativoCandidato | null
  contenidoOficial: string | null
  textoContextualizado: string | null
  textoLocal: string | null

  // [] SIEMPRE que procedencia==='local' — un contenido local nunca
  // tiene PDA oficiales asociados (mismo invariante que PA-3A exige en
  // incorporarDeltasIa: ITEM_NUEVO_CON_PDA).
  pda: PdaCandidatoPlaneacion[]
}

export type NivelResolucionCurricular = 1 | 2 | 3 | 4

export type EstadoResolucionCurricular = 'resuelto' | 'requiere_seleccion' | 'sin_correspondencia'
export type ConfianzaResolucionCurricular = 'alta' | 'media' | 'ninguna'

export type ResultadoResolucionCurricular = {
  estado: EstadoResolucionCurricular
  confianza: ConfianzaResolucionCurricular
  nivel: NivelResolucionCurricular
  candidatos: CandidatoCurricularPlaneacion[]
  // SIEMPRE producido por el algoritmo determinista de abajo — nunca
  // un texto libre de IA. Fijo a un conjunto cerrado de frases (ver
  // MOTIVO_* más abajo), nunca interpolación de datos reales del
  // borrador ni de nombres de alumnos.
  motivoResolucion: string
}

export type SolicitudResolucionCurricular = {
  tema: string | null
  campoExplicito?: string | null
  contenidoExplicito?: string | null
  pdaExplicito?: string | null
}

export type ErrorResolucionCurricular = { tipo: 'SIN_PROGRAMA_ANALITICO' } | { tipo: 'PROGRAMA_ANALITICO_SIN_VERSION_VIGENTE' }

export type ResultadoResolverCurricularPlaneacion = { ok: true; resultado: ResultadoResolucionCurricular } | { ok: false; error: ErrorResolucionCurricular }

// ============================================================
// 2. Normalización y tokenización — deterministas, sin IA. Mismo
//    patrón ya usado 3 veces en el proyecto (borradorProgramaAnalitico.ts,
//    interpretarAjusteBorrador.ts, consultarProgramaAnaliticoVigente.ts):
//    minúsculas + NFD + quitar diacríticos — nunca se centraliza en un
//    util compartido a propósito (mismo criterio ya aplicado ahí: cada
//    módulo mantiene su copia mínima y local).
// ============================================================

function normalizarTexto(texto: string): string {
  return texto
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // acentos
    .replace(/[°º]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // puntuación → espacio
    .replace(/\s+/g, ' ')
    .trim()
}

// Lista CERRADA y mínima — nunca pretende ser un stopword list
// lingüístico completo, solo las palabras funcionales más frecuentes
// que diluirían la señal léxica real (PLN-1B §5, Nivel 2: "no uses
// únicamente %palabra%, calcula una señal determinista y explicable").
const PALABRAS_VACIAS = new Set([
  'de', 'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas', 'en', 'y', 'o', 'del', 'al',
  'su', 'sus', 'para', 'con', 'que', 'se', 'lo', 'a', 'por', 'es', 'como', 'sobre', 'entre',
  'este', 'esta', 'estos', 'estas', 'sin', 'más', 'mas', 'ya', 'muy', 'le', 'les',
])

// Tokens significativos: normalizados, sin palabras vacías, longitud
// mínima 3 (descarta ruido de preposiciones/artículos cortos que
// PALABRAS_VACIAS no cubra). Deliberadamente SIN stemming/plural
// (PLN-1B §5/§11: "no necesitamos un algoritmo sofisticado" y "no
// fuerces resultados si el algoritmo determinista no puede
// justificarlos") — un stemmer casero introduciría falsos positivos
// silenciosos difíciles de auditar; se prefiere que el resolver
// declare honestamente que no encontró señal antes que aproximar.
function tokenizarSignificativo(texto: string): string[] {
  const normalizado = normalizarTexto(texto)
  if (!normalizado) return []
  return normalizado.split(' ').filter((t) => t.length >= 3 && !PALABRAS_VACIAS.has(t))
}

// Cobertura de la consulta dentro de un texto candidato: proporción de
// tokens significativos de la CONSULTA que aparecen literalmente entre
// los tokens del candidato. Deliberadamente asimétrica (no Jaccard) —
// un texto oficial largo que contiene TODOS los tokens de una consulta
// corta debe puntuar 1.0 aunque tenga muchos tokens propios que la
// consulta no menciona; lo que importa es "¿el candidato cubre lo que
// el docente pidió?", no "¿son del mismo tamaño?".
function calcularCoberturaLexica(tokensConsulta: string[], textoCandidato: string): number {
  if (tokensConsulta.length === 0) return 0
  const tokensCandidato = new Set(tokenizarSignificativo(textoCandidato))
  if (tokensCandidato.size === 0) return 0
  const coincidencias = tokensConsulta.filter((t) => tokensCandidato.has(t)).length
  return coincidencias / tokensConsulta.length
}

// ============================================================
// 3. Umbrales — únicos, nombrados, documentados. Nunca mágicos/
//    repetidos inline.
// ============================================================

const UMBRAL_COINCIDENCIA_FUERTE = 0.6 // Nivel 2 — "cubre la mayoría del tema pedido"
const UMBRAL_COINCIDENCIA_DEBIL = 0.25 // Nivel 3 — "relación léxica parcial, no descartable"
const MAXIMO_CANDIDATOS_DEVUELTOS = 8 // conjunto cerrado, nunca los 86 completos

const MOTIVO_EXACTO_TITULO = 'coincidencia exacta con título oficial'
const MOTIVO_EXACTO_CONTEXTUALIZADO = 'coincidencia exacta con texto contextualizado'
const MOTIVO_EXACTO_LOCAL = 'coincidencia exacta con contenido local'
const MOTIVO_EXACTO_PDA = 'coincidencia exacta con PDA'
const MOTIVO_EXACTO_AMBIGUO = 'coincidencia exacta con más de un item — requiere selección'
const MOTIVO_LEXICO_FUERTE_UNICO = 'coincidencia léxica fuerte con un único candidato'
const MOTIVO_LEXICO_FUERTE_VARIOS = 'varios candidatos léxicamente relacionados con coincidencia fuerte'
const MOTIVO_LEXICO_DEBIL = 'relación léxica parcial — requiere decisión pedagógica'
const MOTIVO_SIN_TEMA = 'no se proporcionó tema ni referencia explícita para resolver currículo'
const MOTIVO_SIN_COINCIDENCIA = 'sin coincidencia curricular suficiente en el Programa Analítico vigente'

// ============================================================
// 4. Algoritmo puro — 0 I/O, testeable con fixtures (ver
//    scripts/verificar-resolver-curricular-planeacion.ts). Recibe la
//    lista YA cargada de candidatos base (los items del PA vigente,
//    sin filtrar) y la solicitud; nunca toca la red.
// ============================================================

function textosBuscables(c: CandidatoCurricularPlaneacion): string[] {
  const textos: string[] = []
  if (c.contenidoOficial) textos.push(c.contenidoOficial)
  if (c.textoContextualizado) textos.push(c.textoContextualizado)
  if (c.textoLocal) textos.push(c.textoLocal)
  return textos
}

// Nivel 1 — referencia explícita EXACTA (normalizada) contra alguno de
// los textos del item, o contra el texto de uno de sus PDA. "Exacta"
// aquí significa "el texto normalizado de la referencia es
// literalmente igual al texto normalizado del campo completo" — nunca
// una coincidencia parcial (eso es Nivel 2).
function resolverNivel1(candidatosBase: CandidatoCurricularPlaneacion[], referencia: string): { candidatos: CandidatoCurricularPlaneacion[]; motivo: string } | null {
  const ref = normalizarTexto(referencia)
  if (!ref) return null

  const porTitulo = candidatosBase.filter((c) => c.contenidoOficial && normalizarTexto(c.contenidoOficial) === ref)
  if (porTitulo.length > 0) return { candidatos: porTitulo, motivo: porTitulo.length === 1 ? MOTIVO_EXACTO_TITULO : MOTIVO_EXACTO_AMBIGUO }

  const porContextualizado = candidatosBase.filter((c) => c.textoContextualizado && normalizarTexto(c.textoContextualizado) === ref)
  if (porContextualizado.length > 0) return { candidatos: porContextualizado, motivo: porContextualizado.length === 1 ? MOTIVO_EXACTO_CONTEXTUALIZADO : MOTIVO_EXACTO_AMBIGUO }

  const porLocal = candidatosBase.filter((c) => c.textoLocal && normalizarTexto(c.textoLocal) === ref)
  if (porLocal.length > 0) return { candidatos: porLocal, motivo: porLocal.length === 1 ? MOTIVO_EXACTO_LOCAL : MOTIVO_EXACTO_AMBIGUO }

  const porPda = candidatosBase.filter((c) => c.pda.some((p) => normalizarTexto(p.texto) === ref))
  if (porPda.length > 0) return { candidatos: porPda, motivo: porPda.length === 1 ? MOTIVO_EXACTO_PDA : MOTIVO_EXACTO_AMBIGUO }

  return null
}

// Nivel 2/3 — cobertura léxica del `tema` libre contra cada candidato
// (título/contextualizado/local + todos sus PDA) — se toma el MEJOR
// score entre esas fuentes por candidato, nunca se promedia (un item
// puede tener un PDA muy específico que coincide fuerte aunque su
// título oficial sea genérico).
function resolverPorTema(candidatosBase: CandidatoCurricularPlaneacion[], tema: string): ResultadoResolucionCurricular {
  const tokensConsulta = tokenizarSignificativo(tema)
  if (tokensConsulta.length === 0) {
    return { estado: 'sin_correspondencia', confianza: 'ninguna', nivel: 4, candidatos: [], motivoResolucion: MOTIVO_SIN_TEMA }
  }

  const puntuados = candidatosBase.map((c) => {
    const textos = [...textosBuscables(c), ...c.pda.map((p) => p.texto)]
    const score = textos.reduce((max, t) => Math.max(max, calcularCoberturaLexica(tokensConsulta, t)), 0)
    return { candidato: c, score }
  })

  const fuertes = puntuados.filter((p) => p.score >= UMBRAL_COINCIDENCIA_FUERTE).sort((a, b) => b.score - a.score)
  if (fuertes.length === 1) {
    return { estado: 'resuelto', confianza: 'alta', nivel: 2, candidatos: [fuertes[0].candidato], motivoResolucion: MOTIVO_LEXICO_FUERTE_UNICO }
  }
  if (fuertes.length > 1) {
    return {
      estado: 'requiere_seleccion',
      confianza: 'media',
      nivel: 2,
      candidatos: fuertes.slice(0, MAXIMO_CANDIDATOS_DEVUELTOS).map((p) => p.candidato),
      motivoResolucion: MOTIVO_LEXICO_FUERTE_VARIOS,
    }
  }

  const debiles = puntuados.filter((p) => p.score >= UMBRAL_COINCIDENCIA_DEBIL).sort((a, b) => b.score - a.score)
  if (debiles.length > 0) {
    return {
      estado: 'requiere_seleccion',
      confianza: 'media',
      nivel: 3,
      candidatos: debiles.slice(0, MAXIMO_CANDIDATOS_DEVUELTOS).map((p) => p.candidato),
      motivoResolucion: MOTIVO_LEXICO_DEBIL,
    }
  }

  return { estado: 'sin_correspondencia', confianza: 'ninguna', nivel: 4, candidatos: [], motivoResolucion: MOTIVO_SIN_COINCIDENCIA }
}

// Punto de entrada puro — combina Nivel 1 (referencias explícitas, en
// orden de especificidad: pda > contenido[+campo] > campo solo no
// aplica sin contenido) con el fallback de Nivel 2/3/4 sobre `tema`.
// Nunca mezcla ambas señales en un mismo score — Nivel 1 manda en
// cuanto produce un resultado (aunque sea "ambiguo": 2+ coincidencias
// EXACTAS siguen siendo mejor señal que un tema libre y deben
// resolverse como requiere_seleccion, nunca caer a Nivel 2/3).
export function resolverCandidatosCurricularesPuro(candidatosBase: CandidatoCurricularPlaneacion[], solicitud: SolicitudResolucionCurricular): ResultadoResolucionCurricular {
  if (solicitud.pdaExplicito) {
    const r = resolverNivel1(candidatosBase, solicitud.pdaExplicito)
    if (r) return { estado: r.candidatos.length === 1 ? 'resuelto' : 'requiere_seleccion', confianza: r.candidatos.length === 1 ? 'alta' : 'media', nivel: 1, candidatos: r.candidatos, motivoResolucion: r.motivo }
  }

  if (solicitud.contenidoExplicito) {
    const baseFiltrada = solicitud.campoExplicito ? candidatosBase.filter((c) => c.campoFormativo && normalizarTexto(c.campoFormativo.nombre) === normalizarTexto(solicitud.campoExplicito!)) : candidatosBase
    const r = resolverNivel1(baseFiltrada.length > 0 ? baseFiltrada : candidatosBase, solicitud.contenidoExplicito)
    if (r) return { estado: r.candidatos.length === 1 ? 'resuelto' : 'requiere_seleccion', confianza: r.candidatos.length === 1 ? 'alta' : 'media', nivel: 1, candidatos: r.candidatos, motivoResolucion: r.motivo }
  }

  if (!solicitud.tema) {
    return { estado: 'sin_correspondencia', confianza: 'ninguna', nivel: 4, candidatos: [], motivoResolucion: MOTIVO_SIN_TEMA }
  }

  return resolverPorTema(candidatosBase, solicitud.tema)
}

// ============================================================
// 5. Carga real (I/O, RLS) — SIEMPRE supabaseUser, nunca service_role
//    (PLN-1B §13). Mismo patrón de "recolectar ids, batch-seleccionar
//    catálogo relacionado con Maps" que publicarProgramaAnalitico.ts —
//    nunca un embed de PostgREST nuevo.
// ============================================================

type FilaItem = {
  id: string
  curriculo_contenido_id: string | null
  tipo_decision: 'sin_ajuste' | 'contextualizado' | 'nuevo'
  texto_contextualizado: string | null
  texto_local: string | null
}

function procedenciaDesdeTipoDecision(tipo: FilaItem['tipo_decision']): ProcedenciaCandidatoPlaneacion {
  if (tipo === 'sin_ajuste') return 'oficial'
  if (tipo === 'contextualizado') return 'contextualizado'
  return 'local'
}

export async function cargarCandidatosProgramaAnaliticoVigente(sb: SupabaseClient, grupoId: string): Promise<{ ok: true; programaAnaliticoId: string; programaAnaliticoVersionId: string; candidatos: CandidatoCurricularPlaneacion[] } | { ok: false; error: ErrorResolucionCurricular }> {
  // 1) PA del grupo — RLS (programa_analitico_select: grupos.docente_id
  //    = auth.uid()) es la única barrera real, igual que en PA-3A/PA-5K.
  //    NUNCA se asume numeroVersion=1: siempre se sigue
  //    version_vigente_id, sea cual sea el número real (PLN-1B §8).
  const { data: pa } = await sb.from('programa_analitico').select('id, version_vigente_id').eq('grupo_id', grupoId).maybeSingle()
  if (!pa) return { ok: false, error: { tipo: 'SIN_PROGRAMA_ANALITICO' } }
  if (!pa.version_vigente_id) return { ok: false, error: { tipo: 'PROGRAMA_ANALITICO_SIN_VERSION_VIGENTE' } }

  const programaAnaliticoId = pa.id as string
  const programaAnaliticoVersionId = pa.version_vigente_id as string

  // 2) Items de ESA versión únicamente — nunca de una versión anterior
  //    (PLN-1B §8/CASO H): el filtro es programa_analitico_version_id,
  //    nunca "el item más reciente por contenido" ni ningún otro
  //    criterio que pudiera colar una versión vieja.
  const { data: itemsRaw } = await sb
    .from('programa_analitico_item')
    .select('id, curriculo_contenido_id, tipo_decision, texto_contextualizado, texto_local')
    .eq('programa_analitico_version_id', programaAnaliticoVersionId)
  const items = (itemsRaw ?? []) as FilaItem[]

  // 3) Catálogo oficial relacionado — SOLO de los contenidos que
  //    realmente aparecen en estos items (nunca el catálogo completo
  //    del currículo: el PA vigente es la única fuente de verdad,
  //    PLN-1B §7 — el currículo oficial completa identidad/texto/PDA
  //    de un item PA, nunca se usa para saltarse el PA).
  const idsContenido = [...new Set(items.map((i) => i.curriculo_contenido_id).filter((id): id is string => !!id))]
  const contenidoPorId = new Map<string, { titulo: string; campoFormativoId: string }>()
  if (idsContenido.length > 0) {
    const { data: contenidos } = await sb.from('curriculo_contenido').select('id, titulo, campo_formativo_id').in('id', idsContenido)
    for (const c of contenidos ?? []) contenidoPorId.set(c.id as string, { titulo: c.titulo as string, campoFormativoId: c.campo_formativo_id as string })
  }

  const idsCampo = [...new Set([...contenidoPorId.values()].map((c) => c.campoFormativoId))]
  const campoPorId = new Map<string, CampoFormativoCandidato>()
  if (idsCampo.length > 0) {
    const { data: campos } = await sb.from('curriculo_campo_formativo').select('id, clave, nombre').in('id', idsCampo)
    for (const c of campos ?? []) campoPorId.set(c.id as string, { id: c.id as string, clave: c.clave as string, nombre: c.nombre as string })
  }

  // 4) PDA reales de estos items — vía la tabla de relación
  //    programa_analitico_item_pda (identidad real, ver §1) + el texto
  //    oficial del PDA (curriculo_pda, vía curriculo_pda_grado).
  const idsItem = items.map((i) => i.id)
  type FilaItemPda = { id: string; programa_analitico_item_id: string; curriculo_pda_grado_id: string }
  let itemPdaRaw: FilaItemPda[] = []
  if (idsItem.length > 0) {
    const { data } = await sb.from('programa_analitico_item_pda').select('id, programa_analitico_item_id, curriculo_pda_grado_id').in('programa_analitico_item_id', idsItem)
    itemPdaRaw = (data ?? []) as FilaItemPda[]
  }

  const idsPdaGrado = [...new Set(itemPdaRaw.map((p) => p.curriculo_pda_grado_id))]
  const pdaIdPorGradoId = new Map<string, string>()
  if (idsPdaGrado.length > 0) {
    const { data: pdaGrados } = await sb.from('curriculo_pda_grado').select('id, curriculo_pda_id').in('id', idsPdaGrado)
    for (const p of pdaGrados ?? []) pdaIdPorGradoId.set(p.id as string, p.curriculo_pda_id as string)
  }

  const idsPda = [...new Set([...pdaIdPorGradoId.values()])]
  const textoPorPdaId = new Map<string, string>()
  if (idsPda.length > 0) {
    const { data: pdas } = await sb.from('curriculo_pda').select('id, texto').in('id', idsPda)
    for (const p of pdas ?? []) textoPorPdaId.set(p.id as string, p.texto as string)
  }

  const pdaPorItemId = new Map<string, PdaCandidatoPlaneacion[]>()
  for (const rel of itemPdaRaw) {
    const curriculoPdaId = pdaIdPorGradoId.get(rel.curriculo_pda_grado_id)
    if (!curriculoPdaId) continue // fail-closed: relación inconsistente, se omite en vez de aproximar (PLN-1B §13)
    const texto = textoPorPdaId.get(curriculoPdaId)
    if (!texto) continue
    const lista = pdaPorItemId.get(rel.programa_analitico_item_id) ?? []
    lista.push({ programaAnaliticoItemPdaId: rel.id, curriculoPdaGradoId: rel.curriculo_pda_grado_id, curriculoPdaId, texto })
    pdaPorItemId.set(rel.programa_analitico_item_id, lista)
  }

  // 5) Ensamblado final — fail-closed por item: un item 'sin_ajuste'/
  //    'contextualizado' sin su contenido oficial resuelto (referencia
  //    inconsistente) se omite en vez de devolver un candidato con
  //    datos aproximados o inventados.
  const candidatos: CandidatoCurricularPlaneacion[] = []
  for (const item of items) {
    const procedencia = procedenciaDesdeTipoDecision(item.tipo_decision)
    const pda = pdaPorItemId.get(item.id) ?? []

    if (procedencia === 'local') {
      candidatos.push({
        programaAnaliticoId,
        programaAnaliticoVersionId,
        programaAnaliticoItemId: item.id,
        procedencia,
        curriculoContenidoId: null,
        campoFormativo: null,
        contenidoOficial: null,
        textoContextualizado: null,
        textoLocal: item.texto_local,
        pda: [], // invariante — un local nunca tiene PDA oficiales (§1)
      })
      continue
    }

    if (!item.curriculo_contenido_id) continue // fail-closed
    const contenido = contenidoPorId.get(item.curriculo_contenido_id)
    if (!contenido) continue // fail-closed: referencia inconsistente

    candidatos.push({
      programaAnaliticoId,
      programaAnaliticoVersionId,
      programaAnaliticoItemId: item.id,
      procedencia,
      curriculoContenidoId: item.curriculo_contenido_id,
      campoFormativo: campoPorId.get(contenido.campoFormativoId) ?? null,
      contenidoOficial: contenido.titulo,
      textoContextualizado: procedencia === 'contextualizado' ? item.texto_contextualizado : null,
      textoLocal: null,
      pda,
    })
  }

  return { ok: true, programaAnaliticoId, programaAnaliticoVersionId, candidatos }
}

// Orquestador completo — I/O + algoritmo puro. Reutilizado por
// prepararContextoCurricularPlaneacion (§6, PLN-1C) como primer paso.
export async function resolverCurricularPlaneacion(sb: SupabaseClient, grupoId: string, solicitud: SolicitudResolucionCurricular): Promise<ResultadoResolverCurricularPlaneacion> {
  const cargado = await cargarCandidatosProgramaAnaliticoVigente(sb, grupoId)
  if (!cargado.ok) return cargado
  return { ok: true, resultado: resolverCandidatosCurricularesPuro(cargado.candidatos, solicitud) }
}

// ============================================================
// 6. PLN-1C — construcción del contexto curricular que SÍ se envía al
//    prompt (MODO A/B, ver informe PLN-1C §D/§E). Deliberadamente un
//    tipo DISTINTO del array completo de candidatos: nunca incluye
//    `candidatosDisponibles` — eso viviría 86 objetos con PDA en el
//    prompt incluso en MODO A, exactamente lo que PLN-1C §11 prohíbe.
//    La validación posterior a la respuesta de Claude vuelve a cargar
//    los candidatos reales (cargarCandidatosProgramaAnaliticoVigente)
//    server-side — nunca reutiliza lo que se mandó al modelo como si
//    fuera confiable por haber salido de ahí.
// ============================================================

// Catálogo MODO B — compacto a propósito (PLN-1C §11): ni PDA
// completos ni resultado_esperado_local ni metadata que no sirva para
// elegir. `textoEfectivo` es SIEMPRE el texto que un docente
// reconocería como "el contenido" — contextualizado si existe, oficial
// en otro caso, local si es local — con el prefijo "[LOCAL] " cuando
// procedencia==='local' para que quede inequívoco incluso leyendo solo
// ese campo, nunca solo confiando en que el modelo mire "procedencia".
export type ItemCatalogoCompactoPlaneacion = {
  id: string
  procedencia: ProcedenciaCandidatoPlaneacion
  campoFormativo: string | null
  textoEfectivo: string
}

function construirTextoEfectivo(c: CandidatoCurricularPlaneacion): string {
  if (c.procedencia === 'local') return `[LOCAL] ${c.textoLocal ?? ''}`
  if (c.procedencia === 'contextualizado') return c.textoContextualizado ?? c.contenidoOficial ?? ''
  return c.contenidoOficial ?? ''
}

export function construirCatalogoCompactoPlaneacion(candidatos: CandidatoCurricularPlaneacion[]): ItemCatalogoCompactoPlaneacion[] {
  return candidatos.map((c) => ({
    id: c.programaAnaliticoItemId,
    procedencia: c.procedencia,
    campoFormativo: c.campoFormativo?.nombre ?? null,
    textoEfectivo: construirTextoEfectivo(c),
  }))
}

// Forma que SÍ viaja dentro de contextoEnriquecido (JSON.stringify del
// resultado de prepararContextoGeneracionPlaneacion, ver
// lib/planeacion/generarBorrador.ts) — nunca candidatosDisponibles.
export type ContextoCurricularParaPrompt =
  | { modo: 'A'; candidatosCerrados: CandidatoCurricularPlaneacion[] }
  | { modo: 'B'; catalogoCompacto: ItemCatalogoCompactoPlaneacion[] }

export type ResultadoContextoCurricularPlaneacion =
  | { disponible: false }
  | { disponible: true; contexto: ContextoCurricularParaPrompt; idsOfrecidos: string[]; resolucion: ResultadoResolucionCurricular }

// Deriva el mismo `idsOfrecidos` a partir de SOLO lo que viajó al
// prompt (contextoCurricularPlaneacion, ya serializado y de vuelta en
// route.ts tras prepararContextoGeneracionPlaneacion) — evita que
// route.ts necesite ramificar por `modo` dos veces (una al generar,
// otra al validar la respuesta) y garantiza que ambos lados usan
// EXACTAMENTE la misma noción de "lo que se ofreció".
export function idsOfrecidosDesdeContexto(contexto: ContextoCurricularParaPrompt | null): string[] {
  if (!contexto) return []
  if (contexto.modo === 'A') return contexto.candidatosCerrados.map((c) => c.programaAnaliticoItemId)
  return contexto.catalogoCompacto.map((c) => c.id)
}

// MODO A cuando la resolución determinista (PLN-1B) ya entregó un
// conjunto cerrado no vacío (resuelto, o requiere_seleccion con
// candidatos) — MODO B en cualquier otro caso (sin_correspondencia, o
// defensivamente si requiere_seleccion viniera con candidatos vacíos,
// lo cual PLN-1B nunca produce hoy pero no se asume aquí).
export function decidirModo(resolucion: ResultadoResolucionCurricular): 'A' | 'B' {
  if ((resolucion.estado === 'resuelto' || resolucion.estado === 'requiere_seleccion') && resolucion.candidatos.length > 0) return 'A'
  return 'B'
}

// Punto de entrada real usado por prepararContextoGeneracionPlaneacion
// (PLN-1C §3). Grupos SIN Programa Analítico publicado todavía
// (disponible:false) dejan el comportamiento actual sin cambios: el
// llamador simplemente no inyecta contextoCurricularPlaneacion, y
// Claude sigue con MARCO_CURRICULAR_VIGENTE + su criterio, exactamente
// como antes de PLN-1C.
export async function prepararContextoCurricularPlaneacion(sb: SupabaseClient, grupoId: string, solicitud: SolicitudResolucionCurricular): Promise<ResultadoContextoCurricularPlaneacion> {
  const cargado = await cargarCandidatosProgramaAnaliticoVigente(sb, grupoId)
  if (!cargado.ok) return { disponible: false }

  const resolucion = resolverCandidatosCurricularesPuro(cargado.candidatos, solicitud)
  const modo = decidirModo(resolucion)

  if (modo === 'A') {
    return {
      disponible: true,
      contexto: { modo: 'A', candidatosCerrados: resolucion.candidatos },
      idsOfrecidos: resolucion.candidatos.map((c) => c.programaAnaliticoItemId),
      resolucion,
    }
  }

  const catalogoCompacto = construirCatalogoCompactoPlaneacion(cargado.candidatos)
  return {
    disponible: true,
    contexto: { modo: 'B', catalogoCompacto },
    idsOfrecidos: cargado.candidatos.map((c) => c.programaAnaliticoItemId),
    resolucion,
  }
}
