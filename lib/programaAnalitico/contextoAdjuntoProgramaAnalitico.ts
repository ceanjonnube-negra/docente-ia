// lib/programaAnalitico/contextoAdjuntoProgramaAnalitico.ts
//
// PA-5B — extracción PEDAGÓGICA VISUAL acotada de un adjunto que el
// docente aporta en el mismo turno donde pide/ajusta su Programa
// Analítico (diagnóstico real: imagen + "Hay que fortalecer siempre
// esos puntos" nunca llegaba más allá de `mensaje: string` — ver
// informe PA-5A/diagnóstico). Mismo patrón real ya usado dos veces en
// este módulo (generarPropuestaProgramaAnalitico.ts,
// interpretarAjusteBorrador.ts: `anthropic.messages.stream(...).finalMessage()`,
// JSON forzado, validación server-side estricta, fail-closed) — no se
// inventa una arquitectura nueva.
//
// Esta fase es SOLO extracción — nunca decide deltas, nunca escribe
// nada. El contexto que produce es UNA fuente más (distinta del texto
// explícito del docente y del currículo oficial, ver §5 del informe
// PA-5B) que generarPropuestaProgramaAnalitico.ts consume ya
// etiquetada como "aportado por el docente mediante un adjunto, no
// oficial SEP".
//
// Contrato deliberadamente extensible: AdjuntoProgramaAnalitico es un
// discriminated union con un único miembro implementado hoy
// (origen='imagen'); un futuro origen='documento' (PDF/Word) se agrega
// sin tocar generarPropuestaProgramaAnalitico.ts, que solo conoce la
// forma neutral ContextoPedagogicoAdjunto.

import type Anthropic from '@anthropic-ai/sdk'

export type MediaTypeImagenAdjuntoPA = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

const MEDIA_TYPES_VALIDOS: MediaTypeImagenAdjuntoPA[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']

function esMediaTypeValido(valor: unknown): valor is MediaTypeImagenAdjuntoPA {
  return typeof valor === 'string' && (MEDIA_TYPES_VALIDOS as string[]).includes(valor)
}

// Mismo tope ya probado E2E para una llamada de visión acotada en este
// repo (analizarImagenesListaOficial, lib/listaOficial/analisisListaOficial.ts)
// — controla tokens/latencia de ESTA llamada puntual; no es el límite
// general del Chat (ese sigue siendo MAXIMO_IMAGENES_POR_MENSAJE=12 en
// lib/asistente/comprimirImagen.ts).
export const MAXIMO_IMAGENES_CONTEXTO_PA = 4

export type AdjuntoProgramaAnalitico =
  | { origen: 'imagen'; imagenes: { base64: string; mediaType: MediaTypeImagenAdjuntoPA }[] }
// futuro, NO implementado en PA-5B (ver informe §11):
// | { origen: 'documento'; texto: string }

export type ContextoPedagogicoAdjunto = {
  hayContextoPedagogico: boolean
  observaciones: string[]
  lecturasDudosas: string[]
}

export type ObservabilidadContextoAdjunto = {
  requestId: string
  duracionMs: number
  tokensEntrada?: number
  tokensSalida?: number
}

export type ResultadoExtraccionContextoAdjunto =
  | { ok: true; contexto: ContextoPedagogicoAdjunto; llamadaIa: true; observabilidad: ObservabilidadContextoAdjunto }
  | { ok: false; error: { tipo: 'SIN_IMAGENES' | 'DEMASIADAS_IMAGENES' | 'FORMATO_NO_SOPORTADO' }; llamadaIa: false }
  | { ok: false; error: { tipo: 'ERROR_IA' | 'JSON_INVALIDO' | 'FORMA_INESPERADA'; mensaje?: string }; llamadaIa: true; observabilidad: ObservabilidadContextoAdjunto }

const MAX_OBSERVACIONES = 12
const MAX_LECTURAS_DUDOSAS = 8
const MAX_LONGITUD_ITEM = 220
const MODELO = 'claude-sonnet-4-6'

const INSTRUCCIONES = `Eres un asistente que revisa UNA o varias fotografías que un docente mexicano de educación básica aporta como contexto para su Programa Analítico (segundo nivel de concreción del currículo, Programa Sintético SEP 2022, llevado a su grupo real).

Tu ÚNICA tarea es extraer, de forma MUY acotada, la información pedagógica que el docente parece estar aportando como contexto real de su grupo — nunca transcribir el documento completo, nunca opinar, nunca decidir nada del Programa Analítico.

Busca EXCLUSIVAMENTE, si están presentes:
- necesidades observadas del grupo;
- fortalezas del grupo;
- dificultades o áreas a reforzar;
- indicadores diagnósticos (evaluaciones, resultados, observaciones registradas);
- situaciones relevantes del grupo o la comunidad;
- características del contexto (recursos, limitaciones);
- prioridades pedagógicas que el docente parece señalar.

Ignora cualquier otro contenido visual (decoración, membretes, datos administrativos sin relación pedagógica, personas, paisajes, etc.) — no lo transcribas ni lo menciones.

REGLAS ABSOLUTAS DE CERTEZA:
1. Nunca completes ni infieras una parte ilegible o ambigua. Si algo no se lee con certeza razonable, va en "lecturasDudosas" (breve, indicando qué es dudoso), NUNCA en "observaciones" como si fuera un hecho.
2. Nunca inventes un dato que no esté realmente en la imagen.
3. "observaciones" debe ser una lista de frases MUY breves (una idea por frase, sin párrafos largos) — nunca una transcripción extensa.
4. Si la imagen no contiene ninguna información pedagógica utilizable para este propósito (una foto irrelevante, un paisaje, un documento sin relación), responde hayContextoPedagogico=false con observaciones=[] — nunca fuerces una observación para "tener algo que decir".
5. Máximo ${MAX_OBSERVACIONES} observaciones y ${MAX_LECTURAS_DUDOSAS} lecturas dudosas — prioriza lo más claro y relevante.

REGLAS ABSOLUTAS DE PRIVACIDAD (el Programa Analítico es un documento de planeación GRUPAL, nunca un registro individual):
6. NUNCA devuelvas el nombre completo de ningún alumno, ni en "observaciones" ni en "lecturasDudosas" — ni aunque la imagen lo muestre con claridad junto a un dato pedagógico.
7. NUNCA devuelvas CURP, matrícula, número de lista ligado a un nombre, ni ningún otro identificador personal de un alumno.
8. Si la imagen presenta un hallazgo de un alumno identificado individualmente (por nombre, número o cualquier identificador), conviértelo en una observación PEDAGÓGICA AGREGADA/GRUPAL, nunca lo atribuyas a esa persona — ejemplo: en vez de "Juan Pérez presenta dificultades en X", escribe "Se identifican dificultades en X en un caso del grupo" o "Una parte del grupo requiere reforzar X".
9. No inventes porcentajes, cantidades ni generalizaciones ("la mayoría", "todos") que no estén respaldados por lo que realmente se ve en la imagen — si no puedes determinar el alcance, descríbelo sin cuantificar en vez de adivinar una proporción.

Responde ÚNICAMENTE con JSON válido (sin explicación, sin markdown, sin backticks), exactamente con esta forma:
{
  "hayContextoPedagogico": true | false,
  "observaciones": ["...", "..."],
  "lecturasDudosas": ["...", "..."]
}`

function limpiarJson(texto: string): string {
  return texto.replace(/```json/g, '').replace(/```/g, '').trim()
}

function normalizarLista(valor: unknown, max: number): string[] {
  if (!Array.isArray(valor)) return []
  return valor
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .map((v) => v.trim().slice(0, MAX_LONGITUD_ITEM))
    .slice(0, max)
}

// Exportada para poder probarse aislada, sin credenciales de Anthropic
// (mismo criterio que validarRegistroExtraido en analisisListaOficial.ts).
export function validarContextoPedagogicoAdjunto(json: unknown): ContextoPedagogicoAdjunto | null {
  if (typeof json !== 'object' || json === null) return null
  const obj = json as Record<string, unknown>
  if (typeof obj.hayContextoPedagogico !== 'boolean') return null
  const observaciones = normalizarLista(obj.observaciones, MAX_OBSERVACIONES)
  const lecturasDudosas = normalizarLista(obj.lecturasDudosas, MAX_LECTURAS_DUDOSAS)
  // Fail-closed por contradicción: si el modelo no dejó ninguna
  // observación concreta, nunca se trata como "hay contexto útil"
  // aunque hayContextoPedagogico venga en true — nunca se inventa una
  // observación de la nada, y nunca se usa un true "de sobra".
  const hayContextoPedagogico = obj.hayContextoPedagogico === true && observaciones.length > 0
  return { hayContextoPedagogico, observaciones: hayContextoPedagogico ? observaciones : [], lecturasDudosas }
}

export async function extraerContextoPedagogicoAdjunto(anthropic: Anthropic, adjunto: AdjuntoProgramaAnalitico): Promise<ResultadoExtraccionContextoAdjunto> {
  if (adjunto.origen !== 'imagen') {
    // Contrato preparado para 'documento' en una fase futura (§11) —
    // PA-5B solo implementa 'imagen', el soporte real ya disponible.
    return { ok: false, error: { tipo: 'FORMATO_NO_SOPORTADO' }, llamadaIa: false }
  }
  if (adjunto.imagenes.length === 0) return { ok: false, error: { tipo: 'SIN_IMAGENES' }, llamadaIa: false }
  // Fail-closed por límite: nunca se procesa un subconjunto silencioso
  // — si vienen más de las soportadas, se rechaza la operación
  // completa (mismo criterio que analizarImagenesListaOficial).
  if (adjunto.imagenes.length > MAXIMO_IMAGENES_CONTEXTO_PA) return { ok: false, error: { tipo: 'DEMASIADAS_IMAGENES' }, llamadaIa: false }
  if (adjunto.imagenes.some((img) => !esMediaTypeValido(img.mediaType))) return { ok: false, error: { tipo: 'FORMATO_NO_SOPORTADO' }, llamadaIa: false }

  const requestId = crypto.randomUUID()
  const inicio = Date.now()

  const bloquesImagen = adjunto.imagenes.map((img) => ({
    type: 'image' as const,
    source: { type: 'base64' as const, media_type: img.mediaType, data: img.base64 },
  }))

  let respuesta: Anthropic.Messages.Message
  try {
    respuesta = await anthropic.messages
      .stream({
        model: MODELO,
        max_tokens: 2000,
        messages: [{ role: 'user', content: [...bloquesImagen, { type: 'text', text: INSTRUCCIONES }] }],
      })
      .finalMessage()
  } catch (e) {
    return {
      ok: false,
      error: { tipo: 'ERROR_IA', mensaje: e instanceof Error ? e.message : 'desconocido' },
      llamadaIa: true,
      observabilidad: { requestId, duracionMs: Date.now() - inicio },
    }
  }

  const observabilidad: ObservabilidadContextoAdjunto = {
    requestId,
    duracionMs: Date.now() - inicio,
    tokensEntrada: respuesta.usage?.input_tokens,
    tokensSalida: respuesta.usage?.output_tokens,
  }

  const bloqueTexto = respuesta.content.find((b) => b.type === 'text')
  const texto = bloqueTexto && 'text' in bloqueTexto ? bloqueTexto.text : ''

  let parseado: unknown
  try {
    parseado = JSON.parse(limpiarJson(texto))
  } catch {
    return { ok: false, error: { tipo: 'JSON_INVALIDO' }, llamadaIa: true, observabilidad }
  }

  const contexto = validarContextoPedagogicoAdjunto(parseado)
  if (!contexto) return { ok: false, error: { tipo: 'FORMA_INESPERADA' }, llamadaIa: true, observabilidad }

  return { ok: true, contexto, llamadaIa: true, observabilidad }
}
