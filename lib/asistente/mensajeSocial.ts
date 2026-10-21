// lib/asistente/mensajeSocial.ts
//
// RAG — omisión para mensajes PURAMENTE sociales. Determinista, sin IA.
// Si el mensaje completo del docente es solo un saludo, un agradecimiento o
// un acuse de recibo trivial ("Hola", "Gracias", "Ok, perfecto"), no hay nada
// que buscar en sus documentos: se omiten la consulta de existencia, el
// embedding y la RPC (la respuesta conversacional de Sonnet no cambia).
//
// Conservador por diseño:
// - Lista CERRADA de expresiones inequívocas; nunca coincidencias parciales.
// - Solo se normalizan mayúsculas/minúsculas, espacios y puntuación simple.
// - El mensaje se parte por esa puntuación y CADA parte debe ser,
//   completa, una expresión de la lista ("Hola, buenas noches" sí;
//   "Hola, ¿qué dice el reglamento?" no).
// - Se excluyen a propósito los asentimientos que suelen aceptar una oferta
//   del asistente ("sí", "claro", "dale", "hazlo"): pueden referirse a un
//   documento y, ante la duda, el RAG se ejecuta como siempre.

const EXPRESIONES_SOCIALES: ReadonlySet<string> = new Set([
  // Saludos
  'hola', 'hola de nuevo', 'buenas', 'buenos dias', 'buenos días', 'buen dia', 'buen día',
  'buenas tardes', 'buenas noches', 'saludos', 'que tal', 'qué tal',
  'como estas', 'cómo estás', 'como esta', 'cómo está', 'como te va', 'cómo te va',
  // Agradecimientos
  'gracias', 'muchas gracias', 'mil gracias', 'muchisimas gracias', 'muchísimas gracias',
  'gracias de nuevo', 'gracias por tu ayuda', 'gracias por la ayuda', 'te lo agradezco', 'se agradece',
  // Acuses de recibo y cierres triviales
  'ok', 'okay', 'oki', 'vale', 'perfecto', 'excelente', 'genial', 'muy bien', 'de acuerdo',
  'entendido', 'listo', 'eso es todo', 'es todo', 'por ahora es todo', 'nada mas', 'nada más',
  'hasta luego', 'hasta mañana', 'nos vemos', 'adios', 'adiós',
])

// Puntuación simple que separa expresiones; todo lo demás (emojis, comillas,
// dígitos, símbolos) se conserva y hace que el mensaje NO coincida.
const PUNTUACION_SIMPLE = /[.,;:!¡?¿…]+/g
const MAX_LONGITUD = 80
const MAX_PARTES = 3

export function esMensajePuramenteSocial(mensaje: string): boolean {
  if (typeof mensaje !== 'string') return false
  const texto = mensaje.trim()
  if (!texto || texto.length > MAX_LONGITUD) return false
  const partes = texto
    .toLowerCase()
    .split(PUNTUACION_SIMPLE)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p !== '')
  if (partes.length === 0 || partes.length > MAX_PARTES) return false
  return partes.every((p) => EXPRESIONES_SOCIALES.has(p))
}
