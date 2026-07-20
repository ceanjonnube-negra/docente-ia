// lib/asistente/documentos.ts
//
// Distingue una respuesta conversacional de un documento formal generado
// por el asistente (planeación, rúbrica, examen, citatorio, resumen). El
// system prompt de /api/chat garantiza que todo documento formal empiece
// con uno de estos títulos (ver MODO DOCUMENTO), así que basta con mirar
// el inicio del texto — nada de heurísticas de longitud poco confiables.

const PATRON_TITULO_DOCUMENTO = /^(📋|📊|📝|📨|📄|📖)\s*[A-ZÀ-Ý]/

export function esDocumentoFormal(texto: string): boolean {
  return PATRON_TITULO_DOCUMENTO.test(texto.trim())
}

// Frases que piden la versión final/descargable del documento activo —
// pueden aparecer en cualquier parte del mensaje, porque así se piden de
// verdad: "De manera oficial para imprimir.", "Ahora pásala a Word.",
// "Lista para imprimir.", "Genera el documento.", "Descárgala." Mientras
// exista un documento activo, CUALQUIER mensaje que no aparezca aquí (ni
// nombre un formato real, ver detectarHerramientaDocumento) se entiende
// como una modificación de ESE documento — ver enviarMensaje en
// AsistenteService.ts. "editable" queda fuera a propósito: es una señal
// de edición (el maestro sigue trabajando el contenido), no de
// descarga inmediata.
export const FRASES_FINALIZAR_DOCUMENTO = [
  'en word', 'a word', 'hazla oficial', 'hazlo oficial', 'de manera oficial',
  'formato oficial', 'documento oficial', 'para imprimir', 'lista para imprimir',
  'listo para imprimir', 'genera el documento', 'generar el documento',
  'descárgala', 'descárgalo', 'descargarla', 'descargarlo', 'a pdf', 'documento final',
  'imprímelo', 'imprimelo', 'quiero el word', 'quiero el pdf',
  // Ampliado — el maestro pide el archivo con estas palabras sueltas
  // tan seguido como con las frases de arriba: "mándamelo", "archivo",
  // "documento" (a secas), "descargar", "imprimir" (a secas). Mientras
  // exista un documento activo, cualquiera de estas ya es intención de
  // ENTREGA, no de edición (ver detectarHerramientaDocumento).
  'mándamelo', 'mandamelo', 'mándalo', 'mandalo', 'envíamelo', 'enviamelo',
  'descárgamelo', 'descargamelo', 'descargar', 'imprimir', 'archivo', 'documento',
  // Acciones de continuidad sobre el archivo ya generado ("pásalo",
  // "ábrelo", "compártelo"...) y errores de dictado comunes
  // ("documeto"). A propósito NO se incluye "hazlo" suelto: es
  // demasiado genérico y aparece todo el tiempo en instrucciones de
  // EDICIÓN reales ("hazlo más corto", "hazlo para 4to grado") —
  // agregarlo rompería esa distinción para cualquier documento activo.
  'pásalo', 'pasalo', 'pásamelo', 'pasamelo', 'conviértelo', 'conviertelo', 'ábrelo', 'abrelo',
  'compártelo', 'compartelo', 'bájalo', 'bajalo', 'documeto',
]

// Sistema de prioridades de herramientas de generación de archivos —
// Word > PDF > PowerPoint > Excel > imagen > audio > video. El orden de
// esta lista ES esa prioridad: el primer patrón que coincide gana. Sin
// un formato explícito en el mensaje, cualquier frase de FRASES_
// FINALIZAR_DOCUMENTO (ya usadas arriba para detectar la instrucción)
// cae a Word por default, el formato que más usa un maestro mexicano.
export type TipoHerramienta = 'word' | 'pdf' | 'powerpoint' | 'excel' | 'imagen' | 'audio' | 'video'

// imagen/audio/video exigen un verbo de generación explícito ("genera
// una imagen", "quiero un audio") o "formato/como imagen" — a
// diferencia de word/pdf/powerpoint/excel (sí implementados, por eso
// cualquier mención suelta del nombre del formato es suficiente), un
// mensaje como "agrégale imágenes" es una instrucción de EDICIÓN de
// contenido (íconos/emoji dentro del texto, ver PREFIJOS_EDICION) y
// nunca debe confundirse con pedir el archivo de imagen en sí, que
// además todavía no está implementado (ver HerramientaNoDisponibleError).
const VERBO_GENERAR = /\b(genera|generar|crea|crear|quiero|dame|hazme|necesito)\b/i

// Variantes con error ortográfico/de dictado que de verdad se
// observaron ("eord", "wor", "power poin", "pe de efe", "exel") — una
// lista curada y explícita, no un comparador de distancia aproximada
// genérico: cubre los casos reales sin arriesgar falsos positivos
// sobre palabras normales de una conversación.
const PATRONES_FORMATO: { tipo: TipoHerramienta; patron: RegExp }[] = [
  { tipo: 'word', patron: /\bword\b|\bdocx\b|\bwor\b|\beord\b|\bguord\b|\bdoc\b|documento\s+editable/i },
  { tipo: 'pdf', patron: /\bpdf\b|\bpe\s*de\s*efe\b|documento\s+fijo/i },
  { tipo: 'powerpoint', patron: /power\s*point|power\s*poin\b|presentaci[oó]n(\s+de)?\s+diapositivas|\bdiapositivas\b|\bslides?\b|\bpptx\b|\bppt\b/i },
  { tipo: 'excel', patron: /\bexcel\b|\bexel\b|hoja\s+de\s+c[aá]lculo|\bxlsx\b|\bspreadsheet\b/i },
  { tipo: 'imagen', patron: /\bformato\s+imagen\b|\bcomo\s+imagen\b|\bilustraci[oó]n(es)?\b/i },
  { tipo: 'audio', patron: /\bformato\s+audio\b|\bcomo\s+audio\b/i },
  { tipo: 'video', patron: /\bformato\s+v[ií]deo\b|\bcomo\s+v[ií]deo\b/i },
]

function detectarGeneracionMultimedia(texto: string): TipoHerramienta | null {
  if (!VERBO_GENERAR.test(texto)) return null
  if (/\bimagen(es)?\b/i.test(texto)) return 'imagen'
  if (/\baudio\b/i.test(texto)) return 'audio'
  if (/\bv[ií]deo\b/i.test(texto)) return 'video'
  return null
}

// Solo el formato que el maestro NOMBRÓ de verdad ("en Word", "a PDF",
// "en power poin") — nunca el default de FRASES_FINALIZAR_DOCUMENTO.
// AsistenteService.ts lo usa para distinguir "el maestro pidió un
// formato específico" de "el maestro solo dijo 'descárgalo'/'ábrelo'
// sin nombrar ninguno" — en el segundo caso, reutiliza el ÚLTIMO
// formato generado del documento activo en vez de asumir Word siempre
// (ver resolución del archivo referenciado).
export function detectarFormatoExplicito(texto: string): TipoHerramienta | null {
  for (const { tipo, patron } of PATRONES_FORMATO) {
    if (patron.test(texto)) return tipo
  }
  return detectarGeneracionMultimedia(texto)
}

export function detectarHerramientaDocumento(texto: string): TipoHerramienta | null {
  const explicito = detectarFormatoExplicito(texto)
  if (explicito) return explicito
  const minuscula = texto.toLowerCase()
  return FRASES_FINALIZAR_DOCUMENTO.some((frase) => minuscula.includes(frase)) ? 'word' : null
}
