// lib/planeacion/resolverCurricularPlaneacion.ts
//
// Resolución curricular DETERMINISTA para Planeación (Hito 1, Parte 1).
// Recuperado de test/images-v1 (PLN-1B/PLN-1C) y adaptado a main:
//
// - Dos fuentes con el MISMO tipo de candidato:
//     1. el Programa Analítico PUBLICADO del grupo (versión vigente), si
//        existe y es compatible con el grado, la fase y la versión
//        curricular del grupo;
//     2. si no, el catálogo curricular de la app para el grado y la fase
//        del grupo (lib/curriculo/catalogoCurricular.ts).
//   Sin ninguna de las dos (nivel o grado sin catálogo, como preescolar
//   o secundaria hoy), el resultado es "no disponible" con su motivo:
//   la planeación sigue, pero nada se presenta como verificado.
// - Procedencia (de dónde sale el candidato) y estado de verificación
//   (si el currículo de referencia es oficial vigente o está pendiente
//   de validación) van separados: una versión curricular en 'borrador'
//   se usa como referencia provisional, nunca como oficial.
// - Las referencias explícitas del docente se respetan: si no coinciden
//   con el catálogo, se conservan tal cual como "indicadas por el
//   docente", nunca se sustituyen ni se descartan.
//
// 0 IA, 0 embeddings, 0 RAG. Siempre con el cliente autenticado del
// docente (RLS), nunca service_role. Nada aquí escribe en la base de
// datos ni depende del flujo de generación o aprobación.

import type { SupabaseClient } from '@supabase/supabase-js'
import { resolverContextoCurricularGrupo, type ContextoCurricularGrupo, type ErrorContextoCurricular } from '../curriculo/resolverContextoCurricularGrupo'
import { recuperarCatalogoCurricularCerrado } from '../curriculo/catalogoCurricular'
import { rotuloFuenteCurricular, ROTULO_PROPUESTA_NO_VERIFICADA } from './identidadCurricularVisibleBorrador'

// ============================================================
// 1. Contrato — tipos públicos.
// ============================================================

export type FuenteCurricular = 'programa_analitico' | 'catalogo_app'

// Decisión del docente sobre un contenido de su Programa Analítico.
// null en candidatos del catálogo (no hubo decisión).
export type DecisionProgramaAnalitico = 'sin_ajuste' | 'contextualizado' | 'local'

// 'oficial_vigente'          → versión curricular 'vigente'.
// 'pendiente_validacion_oficial' → única versión 'borrador' usada como
//                              referencia provisional (fallbackBorrador).
// 'local_del_docente'        → contenido local del Programa Analítico:
//                              nunca lleva identidad curricular oficial.
export type EstadoVerificacionCurricular = 'oficial_vigente' | 'pendiente_validacion_oficial' | 'local_del_docente'

export type PdaCandidatoPlaneacion = {
  // Fila real que respalda el PDA: programa_analitico_item_pda.id (PA)
  // o curriculo_pda_grado.id (catálogo). Nunca inventada.
  id: string
  curriculoPdaGradoId: string
  curriculoPdaId: string
  texto: string
}

export type CampoFormativoCandidato = { id: string; clave: string; nombre: string }

export type CandidatoCurricularPlaneacion = {
  // programa_analitico_item.id (PA) o curriculo_contenido.id (catálogo).
  id: string
  fuente: FuenteCurricular
  decision: DecisionProgramaAnalitico | null
  estadoVerificacion: EstadoVerificacionCurricular
  programaAnalitico: { id: string; versionId: string } | null
  // null EXCLUSIVAMENTE en contenidos locales del PA.
  curriculoVersionId: string | null
  curriculoContenidoId: string | null
  campoFormativo: CampoFormativoCandidato | null
  tituloContenido: string | null
  textoContextualizado: string | null
  textoLocal: string | null
  // [] SIEMPRE en contenidos locales.
  pda: PdaCandidatoPlaneacion[]
}

export type NivelResolucionCurricular = 1 | 2 | 3 | 4
export type EstadoResolucionCurricular = 'resuelto' | 'requiere_seleccion' | 'sin_correspondencia'
export type ConfianzaResolucionCurricular = 'alta' | 'media' | 'ninguna'

export type ReferenciaDocente = { tipo: 'contenido' | 'pda'; texto: string }

export type ResultadoResolucionCurricular = {
  estado: EstadoResolucionCurricular
  confianza: ConfianzaResolucionCurricular
  nivel: NivelResolucionCurricular
  candidatos: CandidatoCurricularPlaneacion[]
  // Conjunto cerrado de frases (MOTIVO_*), nunca texto de IA ni datos
  // del docente o de alumnos.
  motivoResolucion: string
  // Referencias explícitas del docente sin correspondencia exacta en el
  // catálogo disponible: se conservan literalmente.
  referenciasDocente: ReferenciaDocente[]
}

export type SolicitudResolucionCurricular = {
  tema: string | null
  campoExplicito?: string | null
  contenidoExplicito?: string | null
  pdaExplicito?: string | null
  // Mensaje del docente en este turno: solo para detectar, de forma
  // determinista, contenidos o PDA del catálogo citados literalmente y
  // un campo formativo nombrado. Nunca se envía al modelo desde aquí.
  mensajeDocente?: string | null
}

export type MotivoProgramaAnaliticoNoUsado =
  | 'SIN_PROGRAMA_ANALITICO'
  | 'PROGRAMA_ANALITICO_SIN_VERSION_VIGENTE'
  | 'PROGRAMA_ANALITICO_INCOMPATIBLE'
  | 'PROGRAMA_ANALITICO_SIN_CONTENIDOS_VALIDOS'

export type MotivoSinCatalogo = ErrorContextoCurricular | 'CATALOGO_VACIO' | 'CARGA_FALLIDA'

// ============================================================
// 2. Normalización y tokenización — deterministas, sin IA.
// ============================================================

export function normalizarTexto(texto: string): string {
  return texto
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[°º]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Lista cerrada y mínima de palabras funcionales que diluyen la señal.
const PALABRAS_VACIAS = new Set([
  'de', 'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas', 'en', 'y', 'o', 'del', 'al',
  'su', 'sus', 'para', 'con', 'que', 'se', 'lo', 'a', 'por', 'es', 'como', 'sobre', 'entre',
  'este', 'esta', 'estos', 'estas', 'sin', 'más', 'mas', 'ya', 'muy', 'le', 'les',
])

// Sin stemming a propósito: mejor declarar que no hubo señal que
// aproximar con falsos positivos difíciles de auditar.
function tokenizarSignificativo(texto: string): string[] {
  const normalizado = normalizarTexto(texto)
  if (!normalizado) return []
  return normalizado.split(' ').filter((t) => t.length >= 3 && !PALABRAS_VACIAS.has(t))
}

// Proporción de tokens de la CONSULTA presentes en el candidato
// (asimétrica: un texto largo que contiene toda la consulta puntúa 1).
function calcularCoberturaLexica(tokensConsulta: string[], textoCandidato: string): number {
  if (tokensConsulta.length === 0) return 0
  const tokensCandidato = new Set(tokenizarSignificativo(textoCandidato))
  if (tokensCandidato.size === 0) return 0
  return tokensConsulta.filter((t) => tokensCandidato.has(t)).length / tokensConsulta.length
}

// ============================================================
// 3. Umbrales y motivos — únicos y nombrados.
// ============================================================

const UMBRAL_COINCIDENCIA_FUERTE = 0.6
const UMBRAL_COINCIDENCIA_DEBIL = 0.25
const MAXIMO_CANDIDATOS_DEVUELTOS = 8

const MOTIVO_EXACTO_TITULO = 'coincidencia exacta con el título del contenido'
const MOTIVO_EXACTO_CONTEXTUALIZADO = 'coincidencia exacta con texto contextualizado'
const MOTIVO_EXACTO_LOCAL = 'coincidencia exacta con contenido local'
const MOTIVO_EXACTO_PDA = 'coincidencia exacta con PDA'
const MOTIVO_EXACTO_AMBIGUO = 'coincidencia exacta con más de un contenido — requiere selección'
const MOTIVO_LEXICO_FUERTE_UNICO = 'coincidencia léxica fuerte con un único candidato'
const MOTIVO_LEXICO_FUERTE_VARIOS = 'varios candidatos léxicamente relacionados con coincidencia fuerte'
const MOTIVO_LEXICO_DEBIL = 'relación léxica parcial — requiere decisión pedagógica'
const MOTIVO_SIN_TEMA = 'no se proporcionó tema ni referencia explícita para resolver currículo'
const MOTIVO_SIN_COINCIDENCIA = 'sin coincidencia curricular suficiente en el catálogo disponible del grupo'
const MOTIVO_MENCION_LITERAL = 'el docente citó literalmente contenidos o PDA del catálogo'

// Un texto del catálogo cuenta como citado solo si aparece COMPLETO en el
// mensaje (normalizado) y es lo bastante largo para no coincidir por azar.
const LONGITUD_MINIMA_CITA = 20

// ============================================================
// 4. Algoritmo puro — 0 I/O.
// ============================================================

function textosBuscables(c: CandidatoCurricularPlaneacion): string[] {
  return [c.tituloContenido, c.textoContextualizado, c.textoLocal].filter((t): t is string => !!t)
}

// Nivel 1 — referencia explícita EXACTA (normalizada) contra el texto
// completo de un contenido o de uno de sus PDA.
function resolverNivel1(candidatosBase: CandidatoCurricularPlaneacion[], referencia: string): { candidatos: CandidatoCurricularPlaneacion[]; motivo: string } | null {
  const ref = normalizarTexto(referencia)
  if (!ref) return null
  const iguales = (t: string | null) => !!t && normalizarTexto(t) === ref

  const porTitulo = candidatosBase.filter((c) => iguales(c.tituloContenido))
  if (porTitulo.length > 0) return { candidatos: porTitulo, motivo: porTitulo.length === 1 ? MOTIVO_EXACTO_TITULO : MOTIVO_EXACTO_AMBIGUO }
  const porContextualizado = candidatosBase.filter((c) => iguales(c.textoContextualizado))
  if (porContextualizado.length > 0) return { candidatos: porContextualizado, motivo: porContextualizado.length === 1 ? MOTIVO_EXACTO_CONTEXTUALIZADO : MOTIVO_EXACTO_AMBIGUO }
  const porLocal = candidatosBase.filter((c) => iguales(c.textoLocal))
  if (porLocal.length > 0) return { candidatos: porLocal, motivo: porLocal.length === 1 ? MOTIVO_EXACTO_LOCAL : MOTIVO_EXACTO_AMBIGUO }
  const porPda = candidatosBase.filter((c) => c.pda.some((p) => iguales(p.texto)))
  if (porPda.length > 0) return { candidatos: porPda, motivo: porPda.length === 1 ? MOTIVO_EXACTO_PDA : MOTIVO_EXACTO_AMBIGUO }
  return null
}

// Nivel 2/3/4 — cobertura léxica del tema contra cada candidato (el
// MEJOR score entre sus textos y sus PDA, nunca el promedio).
function resolverPorTema(candidatosBase: CandidatoCurricularPlaneacion[], tema: string, referenciasDocente: ReferenciaDocente[]): ResultadoResolucionCurricular {
  const tokensConsulta = tokenizarSignificativo(tema)
  if (tokensConsulta.length === 0) {
    return { estado: 'sin_correspondencia', confianza: 'ninguna', nivel: 4, candidatos: [], motivoResolucion: MOTIVO_SIN_TEMA, referenciasDocente }
  }

  const puntuados = candidatosBase.map((c) => {
    const textos = [...textosBuscables(c), ...c.pda.map((p) => p.texto)]
    return { candidato: c, score: textos.reduce((max, t) => Math.max(max, calcularCoberturaLexica(tokensConsulta, t)), 0) }
  })

  const fuertes = puntuados.filter((p) => p.score >= UMBRAL_COINCIDENCIA_FUERTE).sort((a, b) => b.score - a.score)
  if (fuertes.length === 1) {
    return { estado: 'resuelto', confianza: 'alta', nivel: 2, candidatos: [fuertes[0].candidato], motivoResolucion: MOTIVO_LEXICO_FUERTE_UNICO, referenciasDocente }
  }
  if (fuertes.length > 1) {
    return { estado: 'requiere_seleccion', confianza: 'media', nivel: 2, candidatos: fuertes.slice(0, MAXIMO_CANDIDATOS_DEVUELTOS).map((p) => p.candidato), motivoResolucion: MOTIVO_LEXICO_FUERTE_VARIOS, referenciasDocente }
  }
  const debiles = puntuados.filter((p) => p.score >= UMBRAL_COINCIDENCIA_DEBIL).sort((a, b) => b.score - a.score)
  if (debiles.length > 0) {
    return { estado: 'requiere_seleccion', confianza: 'media', nivel: 3, candidatos: debiles.slice(0, MAXIMO_CANDIDATOS_DEVUELTOS).map((p) => p.candidato), motivoResolucion: MOTIVO_LEXICO_DEBIL, referenciasDocente }
  }
  return { estado: 'sin_correspondencia', confianza: 'ninguna', nivel: 4, candidatos: [], motivoResolucion: MOTIVO_SIN_COINCIDENCIA, referenciasDocente }
}

// Candidatos cuyo título, texto propio o algún PDA aparece completo en el
// mensaje del docente. Determinista; sin IA.
export function detectarMencionesLiterales(candidatosBase: CandidatoCurricularPlaneacion[], mensaje: string | null | undefined): CandidatoCurricularPlaneacion[] {
  const m = normalizarTexto(mensaje ?? '')
  if (m.length < LONGITUD_MINIMA_CITA) return []
  const citado = (t: string | null) => {
    const n = t ? normalizarTexto(t) : ''
    return n.length >= LONGITUD_MINIMA_CITA && m.includes(n)
  }
  return candidatosBase.filter((c) => textosBuscables(c).some(citado) || c.pda.some((p) => citado(p.texto)))
}

// Campo formativo nombrado en el mensaje (nombre completo, normalizado).
// Con más de uno nombrado no se elige ninguno.
export function detectarCampoNombrado(candidatosBase: CandidatoCurricularPlaneacion[], mensaje: string | null | undefined): string | null {
  const m = ` ${normalizarTexto(mensaje ?? '')} `
  const nombres = [...new Set(candidatosBase.map((c) => c.campoFormativo?.nombre).filter((n): n is string => !!n))]
  const nombrados = nombres.filter((n) => m.includes(` ${normalizarTexto(n)} `))
  return nombrados.length === 1 ? nombrados[0] : null
}

function filtrarPorCampo(candidatosBase: CandidatoCurricularPlaneacion[], campo: string | null): CandidatoCurricularPlaneacion[] {
  if (!campo) return candidatosBase
  const filtrados = candidatosBase.filter((c) => c.campoFormativo && normalizarTexto(c.campoFormativo.nombre) === normalizarTexto(campo))
  return filtrados.length > 0 ? filtrados : candidatosBase
}

// Punto de entrada puro. Orden: referencias explícitas (PDA y luego
// contenido); citas literales del catálogo en el mensaje del docente;
// tema (acotado al campo formativo que el docente nombró, si nombró
// uno). Toda referencia explícita sin coincidencia exacta se devuelve en
// referenciasDocente, literal.
export function resolverCandidatosCurricularesPuro(candidatosBase: CandidatoCurricularPlaneacion[], solicitud: SolicitudResolucionCurricular): ResultadoResolucionCurricular {
  const referenciasDocente: ReferenciaDocente[] = []

  const pda = solicitud.pdaExplicito?.trim()
  const porPda = pda ? resolverNivel1(candidatosBase, pda) : null
  if (pda && !porPda) referenciasDocente.push({ tipo: 'pda', texto: pda })

  const contenido = solicitud.contenidoExplicito?.trim()
  let porContenido: { candidatos: CandidatoCurricularPlaneacion[]; motivo: string } | null = null
  if (contenido) {
    const campo = solicitud.campoExplicito?.trim()
    const baseFiltrada = campo ? candidatosBase.filter((c) => c.campoFormativo && normalizarTexto(c.campoFormativo.nombre) === normalizarTexto(campo)) : candidatosBase
    porContenido = resolverNivel1(baseFiltrada.length > 0 ? baseFiltrada : candidatosBase, contenido)
    if (!porContenido) referenciasDocente.push({ tipo: 'contenido', texto: contenido })
  }

  const nivel1 = porPda ?? porContenido
  if (nivel1) {
    const unico = nivel1.candidatos.length === 1
    return { estado: unico ? 'resuelto' : 'requiere_seleccion', confianza: unico ? 'alta' : 'media', nivel: 1, candidatos: nivel1.candidatos, motivoResolucion: nivel1.motivo, referenciasDocente }
  }

  const citados = detectarMencionesLiterales(candidatosBase, solicitud.mensajeDocente)
  if (citados.length > 0) {
    const unico = citados.length === 1
    return { estado: unico ? 'resuelto' : 'requiere_seleccion', confianza: unico ? 'alta' : 'media', nivel: 1, candidatos: citados.slice(0, MAXIMO_CANDIDATOS_DEVUELTOS), motivoResolucion: MOTIVO_MENCION_LITERAL, referenciasDocente }
  }

  if (!solicitud.tema?.trim()) {
    return { estado: 'sin_correspondencia', confianza: 'ninguna', nivel: 4, candidatos: [], motivoResolucion: MOTIVO_SIN_TEMA, referenciasDocente }
  }
  const campo = solicitud.campoExplicito?.trim() || detectarCampoNombrado(candidatosBase, solicitud.mensajeDocente)
  return resolverPorTema(filtrarPorCampo(candidatosBase, campo), solicitud.tema, referenciasDocente)
}

// ============================================================
// 5. Carga real (I/O, RLS) — siempre el cliente del docente.
// ============================================================

function estadoDeVersion(contexto: ContextoCurricularGrupo): EstadoVerificacionCurricular {
  return contexto.fallbackBorrador ? 'pendiente_validacion_oficial' : 'oficial_vigente'
}

type FilaItem = {
  id: string
  curriculo_contenido_id: string | null
  curriculo_version_id: string | null
  curriculo_grado_id: string | null
  tipo_decision: 'sin_ajuste' | 'contextualizado' | 'nuevo'
  texto_contextualizado: string | null
  texto_local: string | null
}

// Programa Analítico vigente del grupo, SOLO si su versión se construyó
// sobre el mismo grado, fase y versión curricular que el grupo resuelve
// hoy (contexto). Cualquier diferencia → no se usa (fail-closed): nunca
// se mezclan contenidos de otro grado, otra fase u otra versión.
export async function cargarCandidatosProgramaAnaliticoVigente(
  sb: SupabaseClient,
  grupoId: string,
  contexto: ContextoCurricularGrupo
): Promise<{ ok: true; programaAnaliticoId: string; programaAnaliticoVersionId: string; candidatos: CandidatoCurricularPlaneacion[] } | { ok: false; motivo: MotivoProgramaAnaliticoNoUsado }> {
  const { data: pa } = await sb.from('programa_analitico').select('id, version_vigente_id').eq('grupo_id', grupoId).maybeSingle()
  if (!pa) return { ok: false, motivo: 'SIN_PROGRAMA_ANALITICO' }
  if (!pa.version_vigente_id) return { ok: false, motivo: 'PROGRAMA_ANALITICO_SIN_VERSION_VIGENTE' }
  const programaAnaliticoId = pa.id as string
  const programaAnaliticoVersionId = pa.version_vigente_id as string

  const { data: version } = await sb
    .from('programa_analitico_version')
    .select('id, curriculo_version_id, curriculo_fase_id, curriculo_grado_id')
    .eq('id', programaAnaliticoVersionId)
    .eq('programa_analitico_id', programaAnaliticoId)
    .maybeSingle()
  if (!version) return { ok: false, motivo: 'PROGRAMA_ANALITICO_SIN_VERSION_VIGENTE' }
  if (version.curriculo_version_id !== contexto.curriculoVersionId || version.curriculo_fase_id !== contexto.curriculoFaseId || version.curriculo_grado_id !== contexto.curriculoGradoId) {
    return { ok: false, motivo: 'PROGRAMA_ANALITICO_INCOMPATIBLE' }
  }

  const { data: itemsRaw } = await sb
    .from('programa_analitico_item')
    .select('id, curriculo_contenido_id, curriculo_version_id, curriculo_grado_id, tipo_decision, texto_contextualizado, texto_local')
    .eq('programa_analitico_version_id', programaAnaliticoVersionId)
  // Un item que declara otro grado u otra versión curricular no se usa.
  const items = ((itemsRaw ?? []) as FilaItem[]).filter((i) =>
    (i.curriculo_grado_id == null || i.curriculo_grado_id === contexto.curriculoGradoId)
    && (i.curriculo_version_id == null || i.curriculo_version_id === contexto.curriculoVersionId))

  // Contenidos SOLO de estos items y de la versión y fase del grupo
  // (nunca el catálogo completo: el PA es la fuente cuando existe).
  const idsContenido = [...new Set(items.map((i) => i.curriculo_contenido_id).filter((id): id is string => !!id))]
  const contenidoPorId = new Map<string, { titulo: string; campoFormativoId: string }>()
  if (idsContenido.length > 0) {
    const { data: contenidos } = await sb
      .from('curriculo_contenido')
      .select('id, titulo, campo_formativo_id')
      .in('id', idsContenido)
      .eq('curriculo_version_id', contexto.curriculoVersionId)
      .eq('fase_id', contexto.curriculoFaseId)
    for (const c of contenidos ?? []) {
      const titulo = String(c.titulo ?? '').trim()
      if (titulo) contenidoPorId.set(c.id as string, { titulo, campoFormativoId: c.campo_formativo_id as string })
    }
  }
  const campoPorId = new Map(contexto.camposConCobertura.map((c) => [c.id, { id: c.id, clave: c.clave, nombre: c.nombre }]))

  // PDA reales de estos items: relación + PDA del MISMO grado + texto.
  const idsItem = items.map((i) => i.id)
  type FilaItemPda = { id: string; programa_analitico_item_id: string; curriculo_pda_grado_id: string }
  let itemPda: FilaItemPda[] = []
  if (idsItem.length > 0) {
    const { data } = await sb
      .from('programa_analitico_item_pda')
      .select('id, programa_analitico_item_id, curriculo_pda_grado_id')
      .in('programa_analitico_item_id', idsItem)
      .eq('curriculo_grado_id', contexto.curriculoGradoId)
    itemPda = (data ?? []) as FilaItemPda[]
  }
  const pdaIdPorGradoId = new Map<string, string>()
  const idsPdaGrado = [...new Set(itemPda.map((p) => p.curriculo_pda_grado_id))]
  if (idsPdaGrado.length > 0) {
    const { data } = await sb.from('curriculo_pda_grado').select('id, curriculo_pda_id').in('id', idsPdaGrado).eq('curriculo_grado_id', contexto.curriculoGradoId)
    for (const p of data ?? []) pdaIdPorGradoId.set(p.id as string, p.curriculo_pda_id as string)
  }
  const textoPorPdaId = new Map<string, string>()
  const idsPda = [...new Set(pdaIdPorGradoId.values())]
  if (idsPda.length > 0) {
    const { data } = await sb.from('curriculo_pda').select('id, texto').in('id', idsPda)
    for (const p of data ?? []) {
      const texto = String(p.texto ?? '').trim()
      if (texto) textoPorPdaId.set(p.id as string, texto)
    }
  }
  const pdaPorItemId = new Map<string, PdaCandidatoPlaneacion[]>()
  for (const rel of itemPda) {
    const curriculoPdaId = pdaIdPorGradoId.get(rel.curriculo_pda_grado_id)
    const texto = curriculoPdaId ? textoPorPdaId.get(curriculoPdaId) : undefined
    if (!curriculoPdaId || !texto) continue // relación inconsistente: se omite, nunca se aproxima
    const lista = pdaPorItemId.get(rel.programa_analitico_item_id) ?? []
    lista.push({ id: rel.id, curriculoPdaGradoId: rel.curriculo_pda_grado_id, curriculoPdaId, texto })
    pdaPorItemId.set(rel.programa_analitico_item_id, lista)
  }

  const estado = estadoDeVersion(contexto)
  const programaAnalitico = { id: programaAnaliticoId, versionId: programaAnaliticoVersionId }
  const candidatos: CandidatoCurricularPlaneacion[] = []
  for (const item of items) {
    if (item.tipo_decision === 'nuevo') {
      const textoLocal = item.texto_local?.trim()
      if (!textoLocal) continue
      candidatos.push({
        id: item.id, fuente: 'programa_analitico', decision: 'local', estadoVerificacion: 'local_del_docente', programaAnalitico,
        curriculoVersionId: null, curriculoContenidoId: null, campoFormativo: null,
        tituloContenido: null, textoContextualizado: null, textoLocal, pda: [],
      })
      continue
    }
    const contenido = item.curriculo_contenido_id ? contenidoPorId.get(item.curriculo_contenido_id) : undefined
    if (!contenido) continue // referencia inconsistente o de otra versión/fase
    const decision: DecisionProgramaAnalitico = item.tipo_decision === 'contextualizado' ? 'contextualizado' : 'sin_ajuste'
    candidatos.push({
      id: item.id, fuente: 'programa_analitico', decision, estadoVerificacion: estado, programaAnalitico,
      curriculoVersionId: contexto.curriculoVersionId, curriculoContenidoId: item.curriculo_contenido_id,
      campoFormativo: campoPorId.get(contenido.campoFormativoId) ?? null,
      tituloContenido: contenido.titulo,
      textoContextualizado: decision === 'contextualizado' ? item.texto_contextualizado?.trim() || null : null,
      textoLocal: null,
      pda: pdaPorItemId.get(item.id) ?? [],
    })
  }
  return { ok: true, programaAnaliticoId, programaAnaliticoVersionId, candidatos }
}

// Catálogo de la app para el grado y la fase del grupo.
export async function cargarCandidatosCatalogo(sb: SupabaseClient, contexto: ContextoCurricularGrupo): Promise<CandidatoCurricularPlaneacion[]> {
  const catalogo = await recuperarCatalogoCurricularCerrado(sb, contexto)
  const campoPorId = new Map(catalogo.campos.map((c) => [c.id, c]))
  const estado = estadoDeVersion(contexto)
  return catalogo.contenidos.map((c) => ({
    id: c.id, fuente: 'catalogo_app', decision: null, estadoVerificacion: estado, programaAnalitico: null,
    curriculoVersionId: contexto.curriculoVersionId, curriculoContenidoId: c.id,
    campoFormativo: campoPorId.get(c.campoFormativoId) ?? null,
    tituloContenido: c.titulo, textoContextualizado: null, textoLocal: null,
    pda: catalogo.pda.filter((p) => p.contenidoId === c.id).map((p) => ({ id: p.curriculoPdaGradoId, curriculoPdaGradoId: p.curriculoPdaGradoId, curriculoPdaId: p.curriculoPdaId, texto: p.texto })),
  }))
}

export type CargaCurricularGrupo =
  | {
      ok: true
      fuente: FuenteCurricular
      // Estado de la versión curricular de referencia (los contenidos
      // locales llevan además 'local_del_docente' en su candidato).
      estadoVerificacion: Exclude<EstadoVerificacionCurricular, 'local_del_docente'>
      contexto: ContextoCurricularGrupo
      programaAnalitico: { id: string; versionId: string } | null
      // Por qué no se usó el PA (null si se usó o si el grupo no tiene).
      programaAnaliticoNoUsado: Exclude<MotivoProgramaAnaliticoNoUsado, 'SIN_PROGRAMA_ANALITICO'> | null
      candidatos: CandidatoCurricularPlaneacion[]
    }
  | { ok: false; motivo: MotivoSinCatalogo }

// PA publicado y compatible → PA; si no, catálogo; si no, motivo.
export async function cargarCandidatosCurricularesGrupo(sb: SupabaseClient, grupoId: string): Promise<CargaCurricularGrupo> {
  const resuelto = await resolverContextoCurricularGrupo(sb, grupoId)
  if (!resuelto.ok) return { ok: false, motivo: resuelto.error }
  const contexto = resuelto.contexto
  const estadoVerificacion = contexto.fallbackBorrador ? 'pendiente_validacion_oficial' : 'oficial_vigente'

  const pa = await cargarCandidatosProgramaAnaliticoVigente(sb, grupoId, contexto)
  const candidatosPa = pa.ok ? pa.candidatos : []
  if (pa.ok && candidatosPa.length > 0) {
    return { ok: true, fuente: 'programa_analitico', estadoVerificacion, contexto, programaAnalitico: { id: pa.programaAnaliticoId, versionId: pa.programaAnaliticoVersionId }, programaAnaliticoNoUsado: null, candidatos: candidatosPa }
  }
  const programaAnaliticoNoUsado = pa.ok ? 'PROGRAMA_ANALITICO_SIN_CONTENIDOS_VALIDOS' : pa.motivo === 'SIN_PROGRAMA_ANALITICO' ? null : pa.motivo

  const candidatos = await cargarCandidatosCatalogo(sb, contexto)
  if (candidatos.length === 0) return { ok: false, motivo: 'CATALOGO_VACIO' }
  return { ok: true, fuente: 'catalogo_app', estadoVerificacion, contexto, programaAnalitico: null, programaAnaliticoNoUsado, candidatos }
}

// ============================================================
// 6. Contexto compacto para el prompt. Solo textos literales (ningún
//    identificador: el modelo los copia y el servidor los reconoce por
//    texto) y, en modo A, los PDA reales de los pocos candidatos resueltos. El catálogo del modo B va agrupado por campo
//    formativo y sin PDA, con un presupuesto de caracteres determinista.
// ============================================================

export type ItemCerradoPlaneacion = { campoFormativo: string | null; texto: string; pda: string[] }
export type ItemCatalogoPlaneacion = { texto: string }
export type GrupoCatalogoPlaneacion = { campoFormativo: string; contenidos: ItemCatalogoPlaneacion[] }

// Texto que el docente reconocería como "el contenido":
// contextualizado > título; los locales llevan el prefijo "[LOCAL] ".
export function textoEfectivoCandidato(c: CandidatoCurricularPlaneacion): string {
  if (c.decision === 'local') return `[LOCAL] ${c.textoLocal ?? ''}`
  if (c.decision === 'contextualizado') return c.textoContextualizado ?? c.tituloContenido ?? ''
  return c.tituloContenido ?? ''
}

export function construirItemsCerrados(candidatos: CandidatoCurricularPlaneacion[]): ItemCerradoPlaneacion[] {
  return candidatos.map((c) => ({ campoFormativo: c.campoFormativo?.nombre ?? null, texto: textoEfectivoCandidato(c), pda: c.pda.map((p) => p.texto) }))
}

// Presupuesto del catálogo del modo B: hoy un grado completo (~84
// contenidos, ~10 mil caracteres) cabe entero; un catálogo mayor se
// recorta de forma determinista (primero lo más relacionado con el tema,
// luego campo y texto) y se marca como recortado.
export const PRESUPUESTO_CARACTERES_CATALOGO = 12_000
const CAMPO_SIN_NOMBRE = 'Contenidos propios del Programa Analítico'

export function construirCatalogoPorCampo(candidatos: CandidatoCurricularPlaneacion[], tema: string | null, presupuesto = PRESUPUESTO_CARACTERES_CATALOGO): { catalogo: GrupoCatalogoPlaneacion[]; incluidos: CandidatoCurricularPlaneacion[]; recortado: boolean } {
  const tokens = tokenizarSignificativo(tema ?? '')
  const puntuar = (c: CandidatoCurricularPlaneacion) => [...textosBuscables(c), ...c.pda.map((p) => p.texto)].reduce((max, t) => Math.max(max, calcularCoberturaLexica(tokens, t)), 0)
  const campoDe = (c: CandidatoCurricularPlaneacion) => c.campoFormativo?.nombre ?? CAMPO_SIN_NOMBRE
  const ordenados = candidatos
    .map((c) => ({ c, score: puntuar(c), texto: textoEfectivoCandidato(c) }))
    .sort((a, b) => b.score - a.score || campoDe(a.c).localeCompare(campoDe(b.c), 'es') || a.texto.localeCompare(b.texto, 'es') || a.c.id.localeCompare(b.c.id))

  const incluidos: CandidatoCurricularPlaneacion[] = []
  let usados = 0
  for (const { c, texto } of ordenados) {
    const costo = texto.length + 16
    if (usados + costo > presupuesto) break
    usados += costo
    incluidos.push(c)
  }

  const porCampo = new Map<string, ItemCatalogoPlaneacion[]>()
  for (const c of [...incluidos].sort((a, b) => campoDe(a).localeCompare(campoDe(b), 'es') || textoEfectivoCandidato(a).localeCompare(textoEfectivoCandidato(b), 'es'))) {
    const lista = porCampo.get(campoDe(c)) ?? []
    lista.push({ texto: textoEfectivoCandidato(c) })
    porCampo.set(campoDe(c), lista)
  }
  return { catalogo: [...porCampo].map(([campoFormativo, contenidos]) => ({ campoFormativo, contenidos })), incluidos, recortado: incluidos.length < candidatos.length }
}

// Lo ÚNICO de la resolución curricular que viaja al prompt.
export type ContextoCurricularParaPrompt =
  | { disponible: false; motivo: MotivoSinCatalogo; rotuloFuente: string; referenciasDocente: ReferenciaDocente[] }
  | ({
      disponible: true
      fuente: FuenteCurricular
      estadoVerificacion: Exclude<EstadoVerificacionCurricular, 'local_del_docente'>
      rotuloFuente: string
      referenciasDocente: ReferenciaDocente[]
    } & ({ modo: 'A'; candidatosCerrados: ItemCerradoPlaneacion[] } | { modo: 'B'; catalogoPorCampo: GrupoCatalogoPlaneacion[]; catalogoRecortado: boolean }))

export type ResultadoContextoCurricularPlaneacion = {
  paraPrompt: ContextoCurricularParaPrompt
  // Conjunto EXACTO ofrecido al modelo (vacío sin catálogo). Nunca va
  // al prompt: es para validar en el servidor.
  candidatosOfrecidos: CandidatoCurricularPlaneacion[]
  // Todo el catálogo ya cargado del grupo (su PA vigente compatible o el
  // catálogo de su grado y fase). Con él se reconoce, por texto exacto, lo
  // que el borrador tomó del catálogo — la misma regla que aplicará la
  // aprobación al recargarlo. Nunca va al prompt.
  candidatosGrupo: CandidatoCurricularPlaneacion[]
  resolucion: ResultadoResolucionCurricular | null
  programaAnalitico: { id: string; versionId: string } | null
  programaAnaliticoNoUsado: Exclude<MotivoProgramaAnaliticoNoUsado, 'SIN_PROGRAMA_ANALITICO'> | null
}

// A: la resolución ya dio un conjunto cerrado no vacío. B: cualquier
// otro caso (el modelo elige dentro del catálogo compacto del grupo).
export function decidirModo(resolucion: ResultadoResolucionCurricular): 'A' | 'B' {
  return (resolucion.estado === 'resuelto' || resolucion.estado === 'requiere_seleccion') && resolucion.candidatos.length > 0 ? 'A' : 'B'
}

function referenciasSolicitud(solicitud: SolicitudResolucionCurricular): ReferenciaDocente[] {
  const refs: ReferenciaDocente[] = []
  if (solicitud.pdaExplicito?.trim()) refs.push({ tipo: 'pda', texto: solicitud.pdaExplicito.trim() })
  if (solicitud.contenidoExplicito?.trim()) refs.push({ tipo: 'contenido', texto: solicitud.contenidoExplicito.trim() })
  return refs
}

export function contextoSinCobertura(motivo: MotivoSinCatalogo, solicitud: SolicitudResolucionCurricular): ResultadoContextoCurricularPlaneacion {
  return {
    paraPrompt: { disponible: false, motivo, rotuloFuente: ROTULO_PROPUESTA_NO_VERIFICADA, referenciasDocente: referenciasSolicitud(solicitud) },
    candidatosOfrecidos: [],
    candidatosGrupo: [],
    resolucion: null,
    programaAnalitico: null,
    programaAnaliticoNoUsado: null,
  }
}

export async function prepararContextoCurricularPlaneacion(sb: SupabaseClient, grupoId: string, solicitud: SolicitudResolucionCurricular): Promise<ResultadoContextoCurricularPlaneacion> {
  const carga = await cargarCandidatosCurricularesGrupo(sb, grupoId)
  // Sin catálogo, todo lo que el docente indicó se conserva literal.
  if (!carga.ok) return contextoSinCobertura(carga.motivo, solicitud)

  const resolucion = resolverCandidatosCurricularesPuro(carga.candidatos, solicitud)
  const base = {
    disponible: true as const,
    fuente: carga.fuente,
    estadoVerificacion: carga.estadoVerificacion,
    rotuloFuente: rotuloFuenteCurricular(carga.fuente, carga.estadoVerificacion),
    referenciasDocente: resolucion.referenciasDocente,
  }
  const comun = { resolucion, candidatosGrupo: carga.candidatos, programaAnalitico: carga.programaAnalitico, programaAnaliticoNoUsado: carga.programaAnaliticoNoUsado }
  if (decidirModo(resolucion) === 'A') {
    return { paraPrompt: { ...base, modo: 'A', candidatosCerrados: construirItemsCerrados(resolucion.candidatos) }, candidatosOfrecidos: resolucion.candidatos, ...comun }
  }
  const campo = solicitud.campoExplicito?.trim() || detectarCampoNombrado(carga.candidatos, solicitud.mensajeDocente)
  const { catalogo, incluidos, recortado } = construirCatalogoPorCampo(filtrarPorCampo(carga.candidatos, campo), solicitud.tema)
  return { paraPrompt: { ...base, modo: 'B', catalogoPorCampo: catalogo, catalogoRecortado: recortado }, candidatosOfrecidos: incluidos, ...comun }
}
