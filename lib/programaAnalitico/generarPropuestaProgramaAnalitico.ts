// lib/programaAnalitico/generarPropuestaProgramaAnalitico.ts
//
// PA-3B1 — optimización de PA-3B: separa la ESTRUCTURA CURRICULAR
// OFICIAL (determinista, sin IA) de las DECISIONES PEDAGÓGICAS que
// realmente requieren IA. La prueba real de PA-3B demostró que pedirle
// al modelo el snapshot completo (84 items, 241 PDA) gastaba ~18,155
// tokens de salida en ~374s para terminar reproduciendo, literal y
// mecánicamente, IDs y valores null que el propio código ya conocía —
// la única decisión genuina fue "cuáles conservar", no los datos en sí.
//
// Arquitectura nueva:
//   1. construirBaseProgramaAnalitico(catalogo) — TODOS los contenidos
//      candidatos como sin_ajuste con sus PDA completos, sin IA.
//   2. Si no hay contexto pedagógico real (ni contextoDocente ni
//      necesidades de apoyo) → requiereContexto:true, 0 llamadas IA
//      (Programa Sintético ≠ Programa Analítico: no se asume que la
//      base oficial completa deba publicarse tal cual sin que exista
//      contexto real que lo justifique como decisión — ver PA-3B1 §3).
//   3. Si hay contexto → 1 llamada IA que devuelve solo DELTAS
//      (excluir/contextualizar/nuevo) sobre esa base, nunca el
//      snapshot completo.
//   4. aplicarDeltasSobreBase(base, decisiones) combina server-side.
//   5. Misma validación de siempre (validarEstructuraPropuesta +
//      validarReferenciasPropuesta) sobre la propuesta final
//      combinada — sin fuzzy matching, sin autocorrección.
//
// Sigue NUNCA publicando: no llama publicarProgramaAnalitico(), no
// escribe programa_analitico*.

import { randomUUID } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolverContextoCurricularGrupo } from '../curriculo/resolverContextoCurricularGrupo'
import { recuperarCatalogoCurricularCerrado, type CatalogoCurricularCerrado } from './candidatosCurriculares'
import { recopilarContextoInternoGrupo, type ContextoInternoGrupo } from './contextoInterno'
import { validarEstructuraPropuesta } from './publicarProgramaAnalitico'
import { validarReferenciasPropuesta, type CatalogoContenido, type CatalogoPdaGrado, type CatalogoPeriodo } from './validacionReferencial'
import {
  aplicarDeltasSobreBase,
  contextoDocenteEsSuficiente,
  normalizarDecisionesIa,
  type DecisionDeltaIa,
  type DeltaBorrador,
  type IdentidadCurricularFijada,
} from './borradorProgramaAnalitico'
import type { CategoriaContextoPedagogico, ItemPropuestaProgramaAnalitico, PropuestaProgramaAnalitico, ResultadoGenerarPropuesta } from './tipos'
import type { ContextoPedagogicoAdjunto } from './contextoAdjuntoProgramaAnalitico'

// PA-4C — superset de ResultadoGenerarPropuesta: en la rama ok:true
// expone también lo que un orquestador de borrador necesita para
// persistir sin repetir ninguna consulta ya hecha aquí (identidad
// curricular fijada, deltas ya normalizados con claveLocal estable, y
// el catálogo ya recuperado — solo para construir el resumen
// server-side, nunca se expone tal cual a un futuro cliente). El resto
// de las ramas (requiereContexto/requiereInformacion/error) quedan
// exactamente iguales.
export type ResultadoGenerarPropuestaDetallado =
  | (Extract<ResultadoGenerarPropuesta, { ok: true }> & {
      identidadCurricular: IdentidadCurricularFijada
      deltas: DeltaBorrador[]
      catalogo: CatalogoCurricularCerrado
    })
  | Exclude<ResultadoGenerarPropuesta, { ok: true }>

const MODELO = 'claude-sonnet-4-6'

function limpiarJson(texto: string): string {
  return texto.replace(/```json/g, '').replace(/```/g, '').trim()
}

function escaparComillas(texto: string): string {
  return texto.replace(/"/g, "'")
}

// ============================================================
// 1. Base curricular oficial determinista — sin IA (PA-3B1 §2).
// ============================================================

export function construirBaseProgramaAnalitico(catalogo: CatalogoCurricularCerrado): ItemPropuestaProgramaAnalitico[] {
  const pdaPorContenido = new Map<string, string[]>()
  for (const p of catalogo.pda) {
    const lista = pdaPorContenido.get(p.contenidoId) ?? []
    lista.push(p.curriculoPdaGradoId)
    pdaPorContenido.set(p.contenidoId, lista)
  }
  return catalogo.contenidos.map((c, idx) => ({
    claveLocal: `contenido:${c.id}`,
    tipoDecision: 'sin_ajuste' as const,
    curriculoContenidoId: c.id,
    textoContextualizado: null,
    textoLocal: null,
    resultadoEsperadoLocal: null,
    periodoEvaluacionId: null,
    orden: idx + 1,
    curriculoPdaGradoIds: pdaPorContenido.get(c.id) ?? [],
  }))
}

// ============================================================
// Regla exacta de requiereContexto (PA-3B1 §3/§4/§5, refinada en
// PA-4B §2/§3): sin NINGÚN contexto pedagógico real accionable (ni
// explícito del docente ni necesidades de apoyo confirmadas), publicar
// la base oficial completa tal cual sería una decisión no fundamentada
// tomada por código, no codiseño real — se detiene ANTES de gastar
// ninguna llamada IA. Calendario/periodos no cuentan: son datos
// operativos, no contexto de codiseño pedagógico. "Suficiente" ya no
// es solo "no vacío" — reutiliza contextoDocenteEsSuficiente
// (borradorProgramaAnalitico.ts) para filtrar respuestas triviales
// ("ok", "hazlo", "4°B") sin necesitar otra llamada IA; una decisión
// explícita larga del docente de "no ajustar nada" sigue contando
// como contexto suficiente — nunca se infiere esa decisión por su
// ausencia.
// ============================================================

const TODAS_LAS_CATEGORIAS: CategoriaContextoPedagogico[] = [
  'CARACTERISTICAS_GRUPO',
  'NECESIDADES_PRIORIDADES',
  'PROBLEMATICA_COMUNIDAD',
  'INTERESES',
  'RECURSOS',
  'PRIORIDADES_PEDAGOGICAS',
]

// PA-5B §D/§E: un adjunto (imagen hoy, documento en el futuro) es una
// TERCERA fuente de contexto pedagógico, independiente del texto
// explícito — el docente puede aportar contexto suficiente solo con un
// adjunto (ver informe §9, "el adjunto actual constituye evidencia
// suficiente del referente en ese mismo turno"). Solo cuenta si el
// extractor ya lo marcó hayContextoPedagogico=true CON observaciones
// reales (fail-closed ya aplicado en validarContextoPedagogicoAdjunto
// — nunca lecturas dudosas sueltas).
export function evaluarRequiereContexto(
  contextoDocente: string | null | undefined,
  interno: ContextoInternoGrupo,
  contextoAdjunto?: ContextoPedagogicoAdjunto | null
): { requiereContexto: true; categorias: CategoriaContextoPedagogico[] } | { requiereContexto: false } {
  const hayContextoDocente = contextoDocenteEsSuficiente(contextoDocente)
  const hayNecesidadesConfirmadas = interno.necesidadesApoyo.length > 0
  const hayContextoAdjunto = Boolean(contextoAdjunto?.hayContextoPedagogico && contextoAdjunto.observaciones.length > 0)
  if (hayContextoDocente || hayNecesidadesConfirmadas || hayContextoAdjunto) return { requiereContexto: false }
  return { requiereContexto: true, categorias: TODAS_LAS_CATEGORIAS }
}

// ============================================================
// Prompt compacto — solo pide deltas, nunca el snapshot completo.
// ============================================================

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
    'CONTENIDOS OFICIALES DISPONIBLES — TODOS ya están incluidos por defecto en la base con tipoDecision="sin_ajuste" y TODOS sus PDA oficiales (usa curriculoContenidoId EXACTAMENTE como aparece aquí, nunca inventes uno):',
    lineasContenidos || '(ninguno)',
    '',
    'PDA OFICIALES APLICABLES AL GRADO DE ESTE GRUPO (usa curriculoPdaGradoId EXACTAMENTE como aparece aquí; cada PDA solo es válido para el contenidoId que se indica junto a él, nunca lo uses con otro contenido):',
    lineasPda || '(ninguno)',
  ].join('\n')
}

function construirBloqueContextoInterno(interno: ContextoInternoGrupo): string {
  const necesidades =
    interno.necesidadesApoyo.length > 0
      ? interno.necesidadesApoyo.map((n) => `- ${n.tipo}: ${n.descripcion}`).join('\n')
      : '(sin necesidades de apoyo registradas para este grupo)'

  return [
    'CONTEXTO INTERNO CONFIRMADO (nunca inventes nada adicional):',
    `- Nivel educativo: ${interno.nivelEducativo}`,
    `- Grado: ${interno.gradoGrupo}`,
    `- Institución: ${interno.institucionNombre ?? '(no registrada)'}`,
    `- Alumnos activos en el grupo: ${interno.totalAlumnosActivos}`,
    '- Necesidades de apoyo registradas:',
    necesidades,
  ].join('\n')
}

function construirBloquePeriodos(periodos: CatalogoPeriodo[], nombresPorId: Map<string, string>): string {
  if (periodos.length === 0) {
    return 'PERIODOS DE EVALUACIÓN DISPONIBLES: no hay ninguno registrado para el ciclo escolar actual de este grupo.'
  }
  const lineas = periodos.map((p) => `- id=${p.id} nombre="${nombresPorId.get(p.id) ?? ''}"`).join('\n')
  return `PERIODOS DE EVALUACIÓN DISPONIBLES:\n${lineas}`
}

const INSTRUCCIONES_DELTAS = `Eres un asistente pedagógico que ayuda a un docente mexicano de educación básica a codiseñar el Programa Analítico (segundo nivel de concreción del currículo, Programa Sintético SEP 2022) de su grupo real.

Ya existe una BASE determinista: TODOS los contenidos oficiales del catálogo entregado están incluidos por defecto con tipoDecision="sin_ajuste" y TODOS sus PDA oficiales aplicables. NO necesitas reproducir esa base — el sistema ya la construyó. Tu única tarea es proponer los AJUSTES (deltas) que el contexto real entregado (interno + explícito del docente) realmente justifique.

Tipos de decisión posibles, SOLO sobre contenidos que de verdad quieras ajustar:
- "excluir": un contenido oficial no debe incluirse para este grupo/momento, con justificación real en el contexto entregado (nunca arbitrario). Solo curriculoContenidoId.
- "contextualizar": un contenido oficial debe redactarse distinto para adaptarlo al contexto real. curriculoContenidoId (el mismo del catálogo) y textoContextualizado (tu redacción adaptada, obligatoria, no vacía) son obligatorios. curriculoPdaGradoIdsSeleccionados es OPCIONAL — solo inclúyelo si decides enfocar el contenido en un subconjunto de sus PDA oficiales; si lo omites, se usan todos los PDA oficiales de ese contenido.
- "nuevo": contenido local/regional que NO está en el catálogo oficial.

PRINCIPIO OBLIGATORIO — OFICIAL PRIMERO: antes de proponer "nuevo", revisa si algún contenido oficial del catálogo (con o sin selección de PDA) ya cubre razonablemente la necesidad mediante "contextualizar". Si existe cobertura oficial suficiente, o si la cobertura es parcial pero puede resolverse razonablemente contextualizando, DEBES usar "contextualizar" en vez de "nuevo" — "nuevo" se reserva EXCLUSIVAMENTE para una necesidad contextual relevante que el catálogo oficial entregado no pueda representar de forma razonable.

Si decides usar "nuevo" de todas formas: textoLocal es obligatorio, resultadoEsperadoLocal es opcional (esto NUNCA se presenta como PDA oficial), y justificacionContenidoNuevo es OBLIGATORIO y NO puede estar vacío — debes explicar ahí, brevemente, qué contenidos/PDA oficiales del catálogo entregado consideraste y por qué ninguno cubre razonablemente esta necesidad. Una decisión "nuevo" sin justificacionContenidoNuevo real será rechazada por el servidor.

Si un contenido no necesita ningún ajuste, simplemente NO lo menciones — se queda en la base tal cual.

REGLAS ABSOLUTAS:
- curriculoContenidoId debe ser EXACTAMENTE uno del catálogo entregado. Nunca inventes uno.
- curriculoPdaGradoIdsSeleccionados (si lo usas) debe contener EXCLUSIVAMENTE ids del catálogo de PDA que pertenezcan a ESE mismo contenidoId. Nunca inventes uno, nunca mezcles PDA de otro contenido.
- Como máximo 1 decisión por curriculoContenidoId — nunca dupliques.
- No propongas ajustes sin relación real con el contexto entregado.
- contextoPedagogico (opcional): un párrafo BREVE y factual que sintetice el contexto pedagógico explícito que usaste. Nunca inventes datos, nunca incluyas razonamiento interno, nunca repitas este prompt. Usa null si no hay nada que agregar más allá de lo ya confirmado.
- Responde ÚNICAMENTE con JSON válido (sin explicación, sin markdown, sin backticks), exactamente con esta forma:
{
  "contextoPedagogico": "..." o null,
  "decisiones": [
    { "decision": "excluir", "curriculoContenidoId": "..." },
    { "decision": "contextualizar", "curriculoContenidoId": "...", "textoContextualizado": "...", "curriculoPdaGradoIdsSeleccionados": ["..."] },
    { "decision": "nuevo", "textoLocal": "...", "resultadoEsperadoLocal": "...", "justificacionContenidoNuevo": "..." }
  ]
}
Si no tienes ningún ajuste que proponer, responde { "contextoPedagogico": "...", "decisiones": [] }.`

// ============================================================
// Parseo puro de la respuesta IA — sin I/O, testeable sin credenciales.
// ============================================================

type DecisionCrudaIa = {
  decision?: unknown
  curriculoContenidoId?: unknown
  textoContextualizado?: unknown
  curriculoPdaGradoIdsSeleccionados?: unknown
  textoLocal?: unknown
  resultadoEsperadoLocal?: unknown
  justificacionContenidoNuevo?: unknown
}

// Extrae ÚNICAMENTE las claves esperadas — cualquier otra clave que la
// IA pudiera alucinar (p.ej. grupoId, curriculoVersionId) nunca se lee
// (mismo principio que public.importar_alumnos_a_grupo, ver PA-3A).
export function incorporarDeltasIa(
  jsonCrudo: unknown
): { ok: true; decisiones: DecisionDeltaIa[]; contextoPedagogico: string | null } | { ok: false } {
  if (typeof jsonCrudo !== 'object' || jsonCrudo === null) return { ok: false }
  const obj = jsonCrudo as Record<string, unknown>
  if (!Array.isArray(obj.decisiones)) return { ok: false }

  const contextoPedagogico = typeof obj.contextoPedagogico === 'string' ? obj.contextoPedagogico : null

  const decisiones: DecisionDeltaIa[] = []
  for (const crudo of obj.decisiones as DecisionCrudaIa[]) {
    if (typeof crudo !== 'object' || crudo === null) return { ok: false }
    if (crudo.decision === 'excluir') {
      if (typeof crudo.curriculoContenidoId !== 'string') return { ok: false }
      decisiones.push({ decision: 'excluir', curriculoContenidoId: crudo.curriculoContenidoId })
    } else if (crudo.decision === 'contextualizar') {
      if (typeof crudo.curriculoContenidoId !== 'string' || typeof crudo.textoContextualizado !== 'string') return { ok: false }
      const seleccion = crudo.curriculoPdaGradoIdsSeleccionados
      if (seleccion !== undefined && (!Array.isArray(seleccion) || !seleccion.every((v) => typeof v === 'string'))) return { ok: false }
      decisiones.push({
        decision: 'contextualizar',
        curriculoContenidoId: crudo.curriculoContenidoId,
        textoContextualizado: crudo.textoContextualizado,
        curriculoPdaGradoIdsSeleccionados: Array.isArray(seleccion) ? (seleccion as string[]) : undefined,
      })
    } else if (crudo.decision === 'nuevo') {
      if (typeof crudo.textoLocal !== 'string') return { ok: false }
      // PA-5J — "OFICIAL PRIMERO": nunca se confía en que el prompt por
      // sí solo evite un contenido local redundante — un "nuevo" sin
      // justificación real (no solo presente, con contenido real tras
      // trim) se rechaza aquí, fail-closed, igual que cualquier otro
      // campo obligatorio ausente de excluir/contextualizar arriba.
      // Deliberadamente NO se valida el CONTENIDO semántico de la
      // justificación (eso requeriría otra llamada IA o un motor
      // semántico — fuera de alcance, ver informe PA-5J §7): solo que
      // exista y no sea trivial/vacía.
      if (typeof crudo.justificacionContenidoNuevo !== 'string' || crudo.justificacionContenidoNuevo.trim().length < 10) return { ok: false }
      decisiones.push({
        decision: 'nuevo',
        textoLocal: crudo.textoLocal,
        resultadoEsperadoLocal: typeof crudo.resultadoEsperadoLocal === 'string' ? crudo.resultadoEsperadoLocal : null,
      })
    } else {
      return { ok: false }
    }
  }

  return { ok: true, decisiones, contextoPedagogico }
}

// PA-5B §E: contextoDocente (fuente A, texto explícito) y
// contextoAdjunto (fuente B, derivado de un adjunto) se etiquetan por
// SEPARADO aquí — nunca se concatenan de forma que después sea
// imposible distinguir su procedencia. El texto resultante puede
// terminar en programa_analitico_borrador.contexto_notas, pero la
// etiqueta "mediante un adjunto del docente" deja claro que NO es
// currículo oficial SEP (fuente C, siempre aparte, ver
// construirBloqueCatalogo).
function construirContextoNotasBase(interno: ContextoInternoGrupo, contextoDocente: string | null | undefined, contextoAdjunto?: ContextoPedagogicoAdjunto | null): string {
  const partes = [
    `Grupo de ${interno.gradoGrupo}.° grado de ${interno.nivelEducativo} en ${interno.institucionNombre ?? 'la institución registrada'}, con ${interno.totalAlumnosActivos} alumnos activos.`,
  ]
  if (contextoDocente && contextoDocente.trim() !== '') {
    partes.push(`Contexto proporcionado por el docente: "${contextoDocente.trim()}"`)
  }
  if (contextoAdjunto?.hayContextoPedagogico && contextoAdjunto.observaciones.length > 0) {
    partes.push(`Contexto pedagógico proporcionado mediante un adjunto del docente (no es información oficial SEP): ${contextoAdjunto.observaciones.join('; ')}.`)
  }
  return partes.join(' ')
}

export type GenerarPropuestaInput = {
  grupoId: string
  // Texto libre proporcionado explícitamente por el docente — nunca
  // obligatorio. Este mismo contrato se reutilizará desde el Chat en
  // una fase futura, todavía no conectada.
  contextoDocente?: string | null
  // PA-5B — contexto pedagógico YA extraído (0 o 1 llamada IA previa,
  // fuera de este módulo, ver contextoAdjuntoProgramaAnalitico.ts) de
  // un adjunto (imagen) que el docente aportó en el mismo turno. Nunca
  // se recibe aquí una imagen cruda — este módulo nunca hace vision,
  // solo consume la extracción ya estructurada y validada.
  contextoAdjunto?: ContextoPedagogicoAdjunto | null
}

export async function generarPropuestaProgramaAnalitico(
  sb: SupabaseClient,
  anthropic: Anthropic,
  input: GenerarPropuestaInput
): Promise<ResultadoGenerarPropuestaDetallado> {
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

  const evaluacionContexto = evaluarRequiereContexto(input.contextoDocente, interno, input.contextoAdjunto)
  if (evaluacionContexto.requiereContexto) {
    return { ok: false, requiereContexto: true, categorias: evaluacionContexto.categorias }
  }

  const base = construirBaseProgramaAnalitico(catalogo)

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
      : 'CONTEXTO EXPLÍCITO PROPORCIONADO POR EL DOCENTE: (ninguno; hay necesidades de apoyo confirmadas que sí justifican evaluar ajustes)',
    '',
    // PA-5B §5/§7 — fuente SEPARADA del texto explícito de arriba: ya
    // viene extraída y validada (0/1 llamada IA previa, nunca una
    // imagen cruda aquí). Etiquetada explícitamente como NO oficial
    // SEP y las lecturas dudosas se marcan como tal — nunca se
    // presentan como hechos.
    input.contextoAdjunto?.hayContextoPedagogico && input.contextoAdjunto.observaciones.length > 0
      ? [
          'CONTEXTO PEDAGÓGICO DERIVADO DE UN ADJUNTO DEL DOCENTE (aportado por el docente mediante una imagen/adjunto; NO es currículo oficial SEP; trátalo con el mismo criterio que el contexto explícito de arriba, nunca como dato curricular oficial):',
          ...input.contextoAdjunto.observaciones.map((o) => `- ${escaparComillas(o)}`),
          input.contextoAdjunto.lecturasDudosas.length > 0
            ? `Lecturas dudosas del adjunto (NO son hechos confirmados — ignóralas salvo que el resto del contexto ya sea suficiente sin ellas): ${input.contextoAdjunto.lecturasDudosas.map(escaparComillas).join('; ')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n')
      : '',
    '',
    INSTRUCCIONES_DELTAS,
  ].join('\n')

  let respuesta: Anthropic.Messages.Message
  try {
    // Streaming interno por robustez (mismo hallazgo de PA-3B: una
    // llamada sin streaming con prompt grande puede exceder el
    // timeout del SDK) — el contrato externo sigue siendo 1 resultado
    // completo, nunca eventos parciales expuestos al llamador.
    respuesta = await anthropic.messages
      .stream({
        model: MODELO,
        // La salida ahora son solo deltas (excluir/contextualizar/
        // nuevo), nunca el snapshot completo — 8000 es holgado para
        // decenas de decisiones con texto, muy por debajo de los
        // 32000 que PA-3B necesitaba para reproducir 84 items enteros.
        max_tokens: 8000,
        messages: [{ role: 'user', content: mensajeContexto }],
      })
      .finalMessage()
  } catch (e) {
    return { ok: false, error: { tipo: 'ERROR_GENERACION', mensaje: e instanceof Error ? e.message : 'Error desconocido al generar la propuesta.' } }
  }

  if (respuesta.stop_reason === 'max_tokens') {
    return { ok: false, error: { tipo: 'ERROR_GENERACION', mensaje: 'La respuesta se truncó por límite de max_tokens antes de completar el JSON de deltas.' } }
  }

  const bloqueTexto = respuesta.content.find((b) => b.type === 'text')
  const textoRespuesta = bloqueTexto && 'text' in bloqueTexto ? bloqueTexto.text : ''

  let parseado: unknown
  try {
    parseado = JSON.parse(limpiarJson(textoRespuesta))
  } catch {
    return { ok: false, error: { tipo: 'PROPUESTA_IA_INVALIDA', diagnostico: { tipo: 'JSON_INVALIDO' } } }
  }

  const incorporado = incorporarDeltasIa(parseado)
  if (!incorporado.ok) {
    return { ok: false, error: { tipo: 'PROPUESTA_IA_INVALIDA', diagnostico: { tipo: 'FORMA_INESPERADA' } } }
  }

  // claveLocal de cada "nuevo" se asigna AQUÍ, server-side, nunca
  // depende de la posición ni proviene de la IA (PA-4B §8).
  const deltasNormalizados = normalizarDecisionesIa(incorporado.decisiones)
  const combinado = aplicarDeltasSobreBase(base, deltasNormalizados)
  if (!combinado.ok) {
    return { ok: false, error: { tipo: 'PROPUESTA_IA_INVALIDA', diagnostico: combinado.error } }
  }

  const contextoNotas = [construirContextoNotasBase(interno, input.contextoDocente, input.contextoAdjunto), incorporado.contextoPedagogico]
    .filter((p): p is string => !!p && p.trim() !== '')
    .join(' ')

  // grupoId se incorpora AQUÍ, server-side — el JSON de la IA nunca lo
  // trae porque nunca se le pidió.
  const propuesta: PropuestaProgramaAnalitico = {
    grupoId: input.grupoId,
    idempotencyKey: requestId,
    contextoNotas,
    items: combinado.items,
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
    identidadCurricular: { curriculoVersionId: contexto.curriculoVersionId, curriculoFaseId: contexto.curriculoFaseId, curriculoGradoId: contexto.curriculoGradoId },
    deltas: deltasNormalizados,
    catalogo,
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
