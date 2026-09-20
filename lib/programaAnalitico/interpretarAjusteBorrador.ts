// lib/programaAnalitico/interpretarAjusteBorrador.ts
//
// PA-4D — traduce una instrucción de ajuste en lenguaje natural (con
// borrador pendiente) a UNA operación estructurada de PA-4B/PA-4C.
// Nunca interpreta lenguaje libre en el orquestador ni en la DB — esta
// es la única capa que lo hace, y siempre entrega una operación ya
// resuelta (nunca reenvía texto libre a las funciones puras).
//
// Dos rutas (ver informe PA-4D §10):
//   A. Determinista (0 IA) — solo cuando el candidato es único e
//      inequívoco dentro del resumen actual (ej. "quita el nuevo" con
//      exactamente 1 contenido nuevo).
//   B. Con IA (máximo 1 llamada, prompt acotado) — recibe el resumen
//      actual + la lista de contenidos oficiales (solo id+título, sin
//      PDA ni texto oficial largo — nunca el catálogo completo de
//      36K tokens) + la instrucción del docente.
// Si hay 2+ candidatos razonables, nunca se elige arbitrariamente
// (§11) — se devuelve "ambiguo" con las opciones para preguntar.

import type Anthropic from '@anthropic-ai/sdk'
import type { ResumenPropuesta } from './borradorProgramaAnalitico'

export type OperacionInterpretada =
  | { tipo: 'excluir'; curriculoContenidoId: string }
  | { tipo: 'restaurar'; curriculoContenidoId: string }
  | { tipo: 'contextualizar'; curriculoContenidoId: string; textoContextualizado: string }
  | { tipo: 'agregarNuevo'; textoLocal: string; resultadoEsperadoLocal: string | null }
  | { tipo: 'eliminarNuevo'; claveLocal: string }

export type ResultadoInterpretarAjuste =
  | { ok: true; operacion: OperacionInterpretada; llamadaIa: boolean }
  | { ok: false; ambiguo: true; opciones: string[]; llamadaIa: boolean }
  | { ok: false; noReconocido: true; llamadaIa: boolean }
  | { ok: false; error: { tipo: 'JSON_INVALIDO' | 'FORMA_INESPERADA' | 'ERROR_IA'; mensaje?: string }; llamadaIa: boolean }

function normalizar(t: string): string {
  return t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

// Ruta A — casos MUY acotados y seguros: solo se resuelven sin IA
// cuando existe EXACTAMENTE 1 candidato del tipo correcto en el
// resumen actual. Con 2+ candidatos, "ambiguo" (nunca elige al azar);
// con 0, cae a la ruta B (podría referirse a un contenido sin_ajuste
// no listado en el resumen).
function intentarRutaDeterminista(mensaje: string, resumen: ResumenPropuesta): OperacionInterpretada | 'ambiguo' | null {
  const m = normalizar(mensaje)

  const pideQuitarNuevo = /\b(quita|quítalo|elimina|borra|remueve)\b[^.]*\b(nuevo|local|agregaste|agregado)\b/.test(m)
  if (pideQuitarNuevo) {
    if (resumen.nuevos.length === 1) return { tipo: 'eliminarNuevo', claveLocal: resumen.nuevos[0].claveLocal }
    if (resumen.nuevos.length > 1) return 'ambiguo'
  }

  const pideRestaurar = /\b(no excluyas|no lo excluyas|restaura|regresa|incluye de nuevo|vuelve a incluir|deja(lo)? como estaba)\b/.test(m)
  if (pideRestaurar) {
    if (resumen.excluidos.length === 1) return { tipo: 'restaurar', curriculoContenidoId: resumen.excluidos[0].curriculoContenidoId }
    if (resumen.excluidos.length > 1) return 'ambiguo'
  }

  return null
}

type CandidatoContenido = { id: string; titulo: string }

const INSTRUCCIONES_AJUSTE = `Eres un asistente que traduce UNA instrucción de ajuste del docente sobre una propuesta de Programa Analítico ya generada, a UNA operación estructurada. No generas el Programa Analítico, solo interpretas esta instrucción puntual.

Se te entrega: 1) el estado actual de la propuesta (contenidos contextualizados, nuevos/locales, y excluidos — con sus datos); 2) la lista de TODOS los contenidos oficiales disponibles (id + título, para poder referenciar uno que hoy sigue sin ajuste); 3) la instrucción del docente.

Responde ÚNICAMENTE con JSON válido (sin markdown, sin texto adicional), exactamente con esta forma:
{
  "tipo": "excluir" | "restaurar" | "contextualizar" | "agregarNuevo" | "eliminarNuevo" | "ambiguo" | "no_reconocido",
  "curriculoContenidoId": "..." o ausente,
  "textoContextualizado": "..." o ausente,
  "textoLocal": "..." o ausente,
  "resultadoEsperadoLocal": "..." o ausente,
  "claveLocal": "..." o ausente,
  "opciones": ["..."] o ausente,
  "mensajeParaDocente": "..." o ausente
}

REGLAS:
- curriculoContenidoId debe ser EXACTAMENTE un id de la lista de contenidos oficiales entregada. Nunca inventes uno.
- claveLocal (solo para "eliminarNuevo") debe ser EXACTAMENTE una claveLocal de los "nuevos" actuales entregados. Nunca inventes una.
- "excluir"/"restaurar": el docente pide quitar/regresar un contenido oficial — usa curriculoContenidoId.
- "contextualizar": el contenido oficial sigue siendo el mismo, pero se redacta distinto para adaptarlo al contexto que el docente menciona — usa curriculoContenidoId y redacta tú textoContextualizado, breve y claro.
- "agregarNuevo": SOLO si el docente pide claramente un contenido local/regional nuevo que no está en el catálogo oficial — usa textoLocal (y resultadoEsperadoLocal si aplica).
- "eliminarNuevo": el docente pide quitar un contenido local que él mismo agregó antes — usa claveLocal.
- "ambiguo": la instrucción podría referirse a 2 o más contenidos con confianza similar — nunca elijas arbitrariamente; en "opciones" lista sus títulos exactos (2-5 opciones) y en mensajeParaDocente una pregunta breve para que el docente elija.
- "no_reconocido": no puedes identificar con confianza razonable a qué se refiere la instrucción — en mensajeParaDocente explica brevemente qué no entendiste.`

export async function interpretarAjusteBorrador(
  anthropic: Anthropic,
  mensaje: string,
  resumen: ResumenPropuesta,
  candidatosContenido: CandidatoContenido[]
): Promise<ResultadoInterpretarAjuste> {
  const determinista = intentarRutaDeterminista(mensaje, resumen)
  if (determinista === 'ambiguo') {
    const opciones = resumen.nuevos.length > 1 ? resumen.nuevos.map((n) => n.textoLocal.slice(0, 60)) : resumen.excluidos.map((e) => e.tituloOficial)
    return { ok: false, ambiguo: true, opciones, llamadaIa: false }
  }
  if (determinista) return { ok: true, operacion: determinista, llamadaIa: false }

  const bloqueEstado = [
    `Contextualizados actuales: ${resumen.contextualizados.length === 0 ? '(ninguno)' : resumen.contextualizados.map((c) => `id=${c.curriculoContenidoId} titulo="${c.tituloOficial}"`).join('; ')}`,
    `Nuevos/locales actuales: ${resumen.nuevos.length === 0 ? '(ninguno)' : resumen.nuevos.map((n) => `claveLocal=${n.claveLocal} texto="${n.textoLocal.slice(0, 80)}"`).join('; ')}`,
    `Excluidos actuales: ${resumen.excluidos.length === 0 ? '(ninguno)' : resumen.excluidos.map((e) => `id=${e.curriculoContenidoId} titulo="${e.tituloOficial}"`).join('; ')}`,
  ].join('\n')

  const bloqueCatalogo = `CONTENIDOS OFICIALES DISPONIBLES:\n${candidatosContenido.map((c) => `- id=${c.id} titulo="${c.titulo}"`).join('\n')}`

  const mensajeCompleto = `ESTADO ACTUAL DE LA PROPUESTA:\n${bloqueEstado}\n\n${bloqueCatalogo}\n\nINSTRUCCIÓN DEL DOCENTE:\n"${mensaje}"\n\n${INSTRUCCIONES_AJUSTE}`

  let respuesta
  try {
    respuesta = await anthropic.messages.stream({ model: 'claude-sonnet-4-6', max_tokens: 2000, messages: [{ role: 'user', content: mensajeCompleto }] }).finalMessage()
  } catch (e) {
    return { ok: false, error: { tipo: 'ERROR_IA', mensaje: e instanceof Error ? e.message : 'desconocido' }, llamadaIa: true }
  }

  const bloqueTexto = respuesta.content.find((b) => b.type === 'text')
  const texto = bloqueTexto && 'text' in bloqueTexto ? bloqueTexto.text : ''

  let parseado: unknown
  try {
    parseado = JSON.parse(texto.replace(/```json/g, '').replace(/```/g, '').trim())
  } catch {
    return { ok: false, error: { tipo: 'JSON_INVALIDO' }, llamadaIa: true }
  }

  if (typeof parseado !== 'object' || parseado === null) return { ok: false, error: { tipo: 'FORMA_INESPERADA' }, llamadaIa: true }
  const obj = parseado as Record<string, unknown>
  const idsValidos = new Set(candidatosContenido.map((c) => c.id))
  const clavesNuevosValidas = new Set(resumen.nuevos.map((n) => n.claveLocal))

  if (obj.tipo === 'excluir' || obj.tipo === 'restaurar') {
    if (typeof obj.curriculoContenidoId !== 'string' || !idsValidos.has(obj.curriculoContenidoId)) return { ok: false, error: { tipo: 'FORMA_INESPERADA' }, llamadaIa: true }
    return { ok: true, operacion: { tipo: obj.tipo, curriculoContenidoId: obj.curriculoContenidoId }, llamadaIa: true }
  }
  if (obj.tipo === 'contextualizar') {
    if (typeof obj.curriculoContenidoId !== 'string' || !idsValidos.has(obj.curriculoContenidoId) || typeof obj.textoContextualizado !== 'string' || obj.textoContextualizado.trim() === '') {
      return { ok: false, error: { tipo: 'FORMA_INESPERADA' }, llamadaIa: true }
    }
    return { ok: true, operacion: { tipo: 'contextualizar', curriculoContenidoId: obj.curriculoContenidoId, textoContextualizado: obj.textoContextualizado }, llamadaIa: true }
  }
  if (obj.tipo === 'agregarNuevo') {
    if (typeof obj.textoLocal !== 'string' || obj.textoLocal.trim() === '') return { ok: false, error: { tipo: 'FORMA_INESPERADA' }, llamadaIa: true }
    return { ok: true, operacion: { tipo: 'agregarNuevo', textoLocal: obj.textoLocal, resultadoEsperadoLocal: typeof obj.resultadoEsperadoLocal === 'string' ? obj.resultadoEsperadoLocal : null }, llamadaIa: true }
  }
  if (obj.tipo === 'eliminarNuevo') {
    if (typeof obj.claveLocal !== 'string' || !clavesNuevosValidas.has(obj.claveLocal)) return { ok: false, error: { tipo: 'FORMA_INESPERADA' }, llamadaIa: true }
    return { ok: true, operacion: { tipo: 'eliminarNuevo', claveLocal: obj.claveLocal }, llamadaIa: true }
  }
  if (obj.tipo === 'ambiguo') {
    const opciones = Array.isArray(obj.opciones) ? obj.opciones.filter((o): o is string => typeof o === 'string') : []
    return { ok: false, ambiguo: true, opciones, llamadaIa: true }
  }
  // "no_reconocido" o cualquier valor no reconocido → fail-closed, nunca autocorrige.
  return { ok: false, noReconocido: true, llamadaIa: true }
}
