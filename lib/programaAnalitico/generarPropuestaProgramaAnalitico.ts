// lib/programaAnalitico/generarPropuestaProgramaAnalitico.ts
//
// PA-3B — prepara una PropuestaProgramaAnalitico con exactamente 1
// llamada IA (o 0 si falta información indispensable). NUNCA publica:
// no llama publicarProgramaAnalitico(), no escribe programa_analitico*.
// La salida es una propuesta validada en memoria — publicarla queda
// para un paso explícito posterior, todavía no conectado.
//
// Flujo (ver informe PA-3B):
//   grupo real → resolverContextoCurricularGrupo() → catálogo
//   curricular cerrado (candidatosCurriculares.ts) → contexto interno
//   real (contextoInterno.ts) → contexto explícito del docente
//   (parámetro opcional) → 1 llamada Anthropic → JSON → validación
//   determinista (misma validarEstructuraPropuesta de PA-3A +
//   validarReferenciasPropuesta compartida) → PropuestaProgramaAnalitico.
//
// Mismo patrón real ya usado en el proyecto para generación JSON
// aislada (ver lib/calendario/analisisCalendario.ts): el cliente
// Anthropic se recibe como parámetro (nunca se instancia aquí, nunca
// se duplica), sin streaming, JSON en texto + limpieza de markdown +
// validación rigurosa post-parseo — nunca se confía en el JSON solo
// porque parseó.

import { randomUUID } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolverContextoCurricularGrupo } from '../curriculo/resolverContextoCurricularGrupo'
import { recuperarCatalogoCurricularCerrado, type CatalogoCurricularCerrado } from './candidatosCurriculares'
import { recopilarContextoInternoGrupo, type ContextoInternoGrupo } from './contextoInterno'
import { validarEstructuraPropuesta } from './publicarProgramaAnalitico'
import { validarReferenciasPropuesta, type CatalogoContenido, type CatalogoPdaGrado, type CatalogoPeriodo } from './validacionReferencial'
import type { ItemPropuestaProgramaAnalitico, PropuestaProgramaAnalitico, ResultadoGenerarPropuesta, TipoDecisionItem } from './tipos'

const MODELO = 'claude-sonnet-4-6'

function limpiarJson(texto: string): string {
  return texto.replace(/```json/g, '').replace(/```/g, '').trim()
}

function escaparComillas(texto: string): string {
  return texto.replace(/"/g, "'")
}

function construirBloqueCatalogo(catalogo: CatalogoCurricularCerrado): string {
  const lineasCampos = catalogo.campos.map((c) => `- id=${c.id} clave=${c.clave} nombre="${c.nombre}"`).join('\n')
  const lineasContenidos = catalogo.contenidos
    .map((c) => `- id=${c.id} campoFormativoId=${c.campoFormativoId} titulo="${escaparComillas(c.titulo)}"`)
    .join('\n')
  const lineasPda = catalogo.pda
    .map((p) => `- curriculoPdaGradoId=${p.curriculoPdaGradoId} contenidoId=${p.contenidoId} texto="${escaparComillas(p.texto)}"`)
    .join('\n')

  return [
    'CAMPOS FORMATIVOS DISPONIBLES:',
    lineasCampos || '(ninguno)',
    '',
    'CONTENIDOS OFICIALES DISPONIBLES (usa curriculoContenidoId EXACTAMENTE como aparece aquí, nunca inventes uno):',
    lineasContenidos || '(ninguno)',
    '',
    'PDA OFICIALES APLICABLES AL GRADO DE ESTE GRUPO (usa curriculoPdaGradoId EXACTAMENTE como aparece aquí; cada PDA solo es válido para el contenidoId que se indica junto a él, nunca lo uses con otro contenido):',
    lineasPda || '(ninguno)',
  ].join('\n')
}

function construirBloqueContextoInterno(interno: ContextoInternoGrupo): string {
  const eventos =
    interno.calendarioRelevante.length > 0
      ? interno.calendarioRelevante.map((e) => `- ${e.fecha} (${e.tipo}): ${e.titulo}`).join('\n')
      : '(sin eventos de calendario registrados)'
  const necesidades =
    interno.necesidadesApoyo.length > 0
      ? interno.necesidadesApoyo.map((n) => `- ${n.tipo}: ${n.descripcion}`).join('\n')
      : '(sin necesidades de apoyo registradas para este grupo)'

  return [
    'CONTEXTO INTERNO CONFIRMADO (único contexto real disponible del sistema, nunca inventes nada adicional):',
    `- Nivel educativo: ${interno.nivelEducativo}`,
    `- Grado: ${interno.gradoGrupo}`,
    `- Institución: ${interno.institucionNombre ?? '(no registrada)'}`,
    `- Alumnos activos en el grupo: ${interno.totalAlumnosActivos}`,
    '- Calendario:',
    eventos,
    '- Necesidades de apoyo registradas:',
    necesidades,
  ].join('\n')
}

function construirBloquePeriodos(periodos: CatalogoPeriodo[], nombresPorId: Map<string, string>): string {
  if (periodos.length === 0) {
    return 'PERIODOS DE EVALUACIÓN DISPONIBLES: no hay ningún periodo de evaluación registrado para el ciclo escolar actual de este grupo — usa null en periodoEvaluacionId para TODOS los items. Nunca inventes un id de trimestre/periodo.'
  }
  const lineas = periodos.map((p) => `- id=${p.id} nombre="${nombresPorId.get(p.id) ?? ''}"`).join('\n')
  return `PERIODOS DE EVALUACIÓN DISPONIBLES (usa periodoEvaluacionId EXACTAMENTE como aparece aquí, o null si no corresponde):\n${lineas}`
}

const INSTRUCCIONES = `Eres un asistente pedagógico que ayuda a un docente mexicano de educación básica a construir la propuesta de un Programa Analítico (segundo nivel de concreción del currículo, Programa Sintético SEP 2022) para su grupo real.

Se te entrega: 1) el catálogo CERRADO de campos formativos, contenidos oficiales y PDA aplicables al grado de este grupo — es la ÚNICA fuente permitida de contenido oficial; 2) contexto interno confirmado del grupo/institución; 3) contexto explícito que el docente proporcionó (si lo hay); 4) los periodos de evaluación reales disponibles.

REGLAS ABSOLUTAS:
- Solo puedes usar curriculoContenidoId que aparezcan EXACTAMENTE en el catálogo de contenidos entregado. Nunca inventes un id.
- Solo puedes usar curriculoPdaGradoIds que aparezcan EXACTAMENTE en el catálogo de PDA entregado, y SOLO los que pertenezcan al mismo contenidoId de ese item.
- Nunca inventes un contenido o PDA y lo presentes como si fuera oficial/SEP.
- tipoDecision="sin_ajuste": usa el contenido oficial TAL CUAL, sin reescribirlo. curriculoContenidoId obligatorio. No escribas textoContextualizado ni textoLocal (déjalos null).
- tipoDecision="contextualizado": el contenido sigue siendo el mismo oficial (curriculoContenidoId obligatorio, del catálogo), pero redactas tu propia versión adaptada al contexto real en textoContextualizado (obligatorio, no vacío). No uses textoLocal (null).
- tipoDecision="nuevo": SOLO cuando el contexto real (interno o explícito del docente) justifique claramente un contenido local/regional que NO está en el catálogo oficial. curriculoContenidoId debe ser null. Redacta el contenido en textoLocal (obligatorio, no vacío) y puedes proponer resultadoEsperadoLocal — esto NUNCA se llama ni se presenta como PDA oficial, es tu propia propuesta pedagógica local. Un item "nuevo" NUNCA lleva curriculoPdaGradoIds (arreglo vacío obligatorio).
- periodoEvaluacionId: solo un id EXACTO de la lista de periodos entregada, o null si no corresponde o la lista está vacía. Nunca inventes un id.
- orden: numera los items secuencialmente empezando en 1, sin repetir ningún número.
- contextoNotas: sintetiza en un párrafo breve el contexto real y confirmado (interno + explícito del docente) que usaste para tus decisiones. Nunca incluyas razonamiento interno, nunca inventes datos que no se te dieron, nunca repitas este prompt. Usa null si no hay nada factual que sintetizar.
- No tienes que usar todos los contenidos del catálogo — selecciona los pedagógicamente pertinentes para este grupo real ahora. No satures la propuesta con contenidos "nuevos" sin justificación real en el contexto entregado.
- Responde ÚNICAMENTE con un JSON válido (sin explicación, sin markdown, sin backticks), exactamente con esta forma:
{
  "contextoNotas": "..." o null,
  "items": [
    {
      "claveLocal": "item-1",
      "tipoDecision": "sin_ajuste" | "contextualizado" | "nuevo",
      "curriculoContenidoId": "..." o null,
      "textoContextualizado": "..." o null,
      "textoLocal": "..." o null,
      "resultadoEsperadoLocal": "..." o null,
      "periodoEvaluacionId": "..." o null,
      "orden": 1,
      "curriculoPdaGradoIds": ["..."]
    }
  ]
}`

// ============================================================
// Parseo/incorporación puros — separados de la llamada IA para poder
// testear sin credenciales (ver scripts/verificar-generador-programa-analitico.ts).
// ============================================================

type ItemCrudoIa = {
  claveLocal?: unknown
  tipoDecision?: unknown
  curriculoContenidoId?: unknown
  textoContextualizado?: unknown
  textoLocal?: unknown
  resultadoEsperadoLocal?: unknown
  periodoEvaluacionId?: unknown
  orden?: unknown
  curriculoPdaGradoIds?: unknown
}

const TIPOS_DECISION_VALIDOS: TipoDecisionItem[] = ['sin_ajuste', 'contextualizado', 'nuevo']

// Extrae ÚNICAMENTE las claves esperadas del JSON de la IA — cualquier
// otra clave que el modelo pudiera alucinar (p.ej. grupoId,
// curriculoVersionId) nunca se lee, nunca se propaga (mismo principio
// que public.importar_alumnos_a_grupo, ver PA-3A).
export function incorporarPropuestaIa(
  grupoId: string,
  jsonCrudo: unknown
): { ok: true; items: ItemPropuestaProgramaAnalitico[]; contextoNotas: string | null } | { ok: false } {
  if (typeof jsonCrudo !== 'object' || jsonCrudo === null) return { ok: false }
  const obj = jsonCrudo as Record<string, unknown>
  if (!Array.isArray(obj.items)) return { ok: false }

  const contextoNotas = typeof obj.contextoNotas === 'string' ? obj.contextoNotas : null

  const items: ItemPropuestaProgramaAnalitico[] = []
  for (const crudo of obj.items as ItemCrudoIa[]) {
    if (typeof crudo !== 'object' || crudo === null) return { ok: false }
    const tipoDecision = crudo.tipoDecision
    if (typeof tipoDecision !== 'string' || !TIPOS_DECISION_VALIDOS.includes(tipoDecision as TipoDecisionItem)) return { ok: false }
    if (typeof crudo.claveLocal !== 'string' || !Array.isArray(crudo.curriculoPdaGradoIds)) return { ok: false }
    if (!crudo.curriculoPdaGradoIds.every((v) => typeof v === 'string')) return { ok: false }
    if (typeof crudo.orden !== 'number') return { ok: false }

    items.push({
      claveLocal: crudo.claveLocal,
      tipoDecision: tipoDecision as TipoDecisionItem,
      curriculoContenidoId: typeof crudo.curriculoContenidoId === 'string' ? crudo.curriculoContenidoId : null,
      textoContextualizado: typeof crudo.textoContextualizado === 'string' ? crudo.textoContextualizado : null,
      textoLocal: typeof crudo.textoLocal === 'string' ? crudo.textoLocal : null,
      resultadoEsperadoLocal: typeof crudo.resultadoEsperadoLocal === 'string' ? crudo.resultadoEsperadoLocal : null,
      periodoEvaluacionId: typeof crudo.periodoEvaluacionId === 'string' ? crudo.periodoEvaluacionId : null,
      orden: crudo.orden,
      curriculoPdaGradoIds: crudo.curriculoPdaGradoIds as string[],
    })
  }

  return { ok: true, items, contextoNotas }
}

export type GenerarPropuestaInput = {
  grupoId: string
  // Texto libre proporcionado explícitamente por el docente — nunca
  // obligatorio (ver informe PA-3B §6/§7). Este mismo contrato se
  // reutilizará desde el Chat en una fase futura, todavía no conectada.
  contextoDocente?: string | null
}

export async function generarPropuestaProgramaAnalitico(
  sb: SupabaseClient,
  anthropic: Anthropic,
  input: GenerarPropuestaInput
): Promise<ResultadoGenerarPropuesta> {
  const requestId = randomUUID()
  const inicio = Date.now()

  const resultadoContexto = await resolverContextoCurricularGrupo(sb, input.grupoId)
  if (!resultadoContexto.ok) {
    return { ok: false, error: { tipo: 'CONTEXTO_CURRICULAR_NO_RESUELTO', detalle: resultadoContexto.error } }
  }
  const contexto = resultadoContexto.contexto

  const catalogo = await recuperarCatalogoCurricularCerrado(sb, contexto)
  if (catalogo.contenidos.length === 0) {
    return { ok: false, requiereInformacion: true, faltantes: ['CATALOGO_CURRICULAR_VACIO'] }
  }

  const interno = await recopilarContextoInternoGrupo(sb, input.grupoId, contexto)

  const periodosCatalogo: CatalogoPeriodo[] = interno.periodosDisponibles.map((p) => ({ id: p.id, cicloEscolarId: contexto.cicloEscolarId }))
  const nombresPeriodoPorId = new Map(interno.periodosDisponibles.map((p) => [p.id, p.nombre]))

  const mensajeContexto = [
    construirBloqueCatalogo(catalogo),
    '',
    construirBloqueContextoInterno(interno),
    '',
    construirBloquePeriodos(periodosCatalogo, nombresPeriodoPorId),
    '',
    input.contextoDocente && input.contextoDocente.trim() !== ''
      ? `CONTEXTO EXPLÍCITO PROPORCIONADO POR EL DOCENTE:\n"${escaparComillas(input.contextoDocente.trim())}"`
      : 'CONTEXTO EXPLÍCITO PROPORCIONADO POR EL DOCENTE: (el docente no proporcionó contexto adicional para esta versión)',
    '',
    INSTRUCCIONES,
  ].join('\n')

  let respuesta: Anthropic.Messages.Message
  try {
    // Una llamada sin streaming con max_tokens alto y un prompt grande
    // (currículo completo de un grado) supera el timeout del SDK
    // incluso ampliándolo explícitamente — confirmado empíricamente
    // ("Request timed out.") en dos intentos reales de PA-3B contra el
    // grupo 4°B real. Se usa el helper de streaming del SDK para
    // transportar la respuesta (recomendación oficial de Anthropic
    // para generaciones largas) pero se espera el mensaje completo
    // antes de continuar — sigue siendo 1 sola llamada IA, el
    // contrato de esta función (devolver el resultado completo, nunca
    // eventos parciales) no cambia.
    respuesta = await anthropic.messages
      .stream({
        model: MODELO,
        // 16000 resultó insuficiente en la prueba real de PA-3B: con
        // el currículo completo de 4° (85 contenidos candidatos) el
        // modelo generó una propuesta extensa (decidió usar casi todos
        // los contenidos) y la respuesta se cortó a medias
        // (stop_reason="max_tokens", confirmado empíricamente).
        max_tokens: 32000,
        messages: [{ role: 'user', content: mensajeContexto }],
      })
      .finalMessage()
  } catch (e) {
    return { ok: false, error: { tipo: 'ERROR_GENERACION', mensaje: e instanceof Error ? e.message : 'Error desconocido al generar la propuesta.' } }
  }

  // Diagnóstico explícito en vez de dejar que un JSON incompleto caiga
  // en el genérico "JSON_INVALIDO" — confirmado empíricamente en la
  // prueba real de PA-3B (stop_reason="max_tokens" con 85 contenidos
  // candidatos) que esto sí puede ocurrir en la práctica.
  if (respuesta.stop_reason === 'max_tokens') {
    return { ok: false, error: { tipo: 'ERROR_GENERACION', mensaje: 'La respuesta se truncó por límite de max_tokens antes de completar el JSON.' } }
  }

  const bloqueTexto = respuesta.content.find((b) => b.type === 'text')
  const textoRespuesta = bloqueTexto && 'text' in bloqueTexto ? bloqueTexto.text : ''

  let parseado: unknown
  try {
    parseado = JSON.parse(limpiarJson(textoRespuesta))
  } catch {
    return { ok: false, error: { tipo: 'PROPUESTA_IA_INVALIDA', diagnostico: { tipo: 'JSON_INVALIDO' } } }
  }

  const incorporado = incorporarPropuestaIa(input.grupoId, parseado)
  if (!incorporado.ok) {
    return { ok: false, error: { tipo: 'PROPUESTA_IA_INVALIDA', diagnostico: { tipo: 'FORMA_INESPERADA' } } }
  }

  // grupoId se incorpora AQUÍ, server-side — el JSON de la IA nunca lo
  // trae porque nunca se le pidió (ver INSTRUCCIONES: el formato
  // esperado no incluye grupoId/curriculoVersionId/fase/grado/docente/
  // institución en ningún punto).
  const propuesta: PropuestaProgramaAnalitico = {
    grupoId: input.grupoId,
    idempotencyKey: requestId,
    contextoNotas: incorporado.contextoNotas,
    items: incorporado.items,
  }

  const erroresEstructura = validarEstructuraPropuesta(propuesta)
  if (erroresEstructura.length > 0) {
    return { ok: false, error: { tipo: 'PROPUESTA_IA_INVALIDA', diagnostico: erroresEstructura[0] } }
  }

  const camposCubiertosIds = new Set(contexto.camposConCobertura.map((c) => c.id))
  const contenidoPorId = new Map<string, CatalogoContenido>(
    catalogo.contenidos.map((c) => [c.id, { id: c.id, campoFormativoId: c.campoFormativoId, curriculoVersionId: contexto.curriculoVersionId }])
  )
  const pdaGradoPorId = new Map<string, CatalogoPdaGrado>(
    catalogo.pda.map((p) => [
      p.curriculoPdaGradoId,
      { id: p.curriculoPdaGradoId, contenidoId: p.contenidoId, curriculoGradoId: contexto.curriculoGradoId, curriculoVersionId: contexto.curriculoVersionId },
    ])
  )
  const periodoPorId = new Map<string, CatalogoPeriodo>(periodosCatalogo.map((p) => [p.id, p]))

  const errorReferencial = validarReferenciasPropuesta(propuesta.items, {
    curriculoVersionId: contexto.curriculoVersionId,
    curriculoGradoId: contexto.curriculoGradoId,
    cicloEscolarId: contexto.cicloEscolarId,
    camposCubiertosIds,
    contenidoPorId,
    pdaGradoPorId,
    periodoPorId,
  })
  if (errorReferencial) {
    return { ok: false, error: { tipo: 'PROPUESTA_IA_INVALIDA', diagnostico: errorReferencial } }
  }

  return {
    ok: true,
    propuesta,
    observabilidad: {
      requestId,
      grupoId: input.grupoId,
      modelo: MODELO,
      cantidadCandidatosContenido: catalogo.contenidos.length,
      cantidadCandidatosPda: catalogo.pda.length,
      cantidadItemsPropuestos: propuesta.items.length,
      duracionMs: Date.now() - inicio,
      tokensEntrada: respuesta.usage?.input_tokens,
      tokensSalida: respuesta.usage?.output_tokens,
      exito: true,
    },
  }
}
