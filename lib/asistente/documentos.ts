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

// Normaliza para comparar por sinónimo/palabra, no por texto exacto:
// minúsculas + sin acentos. Con esto una sola entrada ("mandamelo")
// cubre tanto "mándamelo" como "mandamelo" sin duplicar la lista, y
// "Envíamelo en Word" coincide igual que "en Word, envíamelo" (el
// orden de las palabras deja de importar porque se compara por
// inclusión, no por posición). Sigue siendo un diccionario curado y
// explícito (ver nota en PATRONES_FORMATO más abajo), no un
// comparador de distancia aproximada genérico — evita falsos
// positivos sobre palabras normales de una conversación.
function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

// Frases que piden la versión final/descargable del documento activo, o
// que piden explícitamente NO repetir/explicar su contenido de nuevo —
// pueden aparecer en cualquier parte del mensaje, porque así se piden de
// verdad: "De manera oficial para imprimir.", "Ahora pásala a Word.",
// "Entrégalo.", "No lo vuelvas a explicar." Mientras exista un documento
// activo, CUALQUIER mensaje que no aparezca aquí (ni nombre un formato
// real, ver detectarHerramientaDocumento) se entiende como una
// modificación de ESE documento — ver enviarMensaje en
// AsistenteService.ts. "editable" queda fuera a propósito: es una señal
// de edición (el maestro sigue trabajando el contenido), no de
// descarga inmediata. Comparadas ya sin acentos, ver normalizar().
export const FRASES_FINALIZAR_DOCUMENTO = [
  'en word', 'a word', 'a pdf', 'hazla oficial', 'hazlo oficial', 'de manera oficial',
  'formato oficial', 'documento oficial', 'para imprimir', 'lista para imprimir',
  'listo para imprimir', 'genera el documento', 'generar el documento',
  'genera el archivo', 'generar el archivo', 'documento final',
  'quiero el word', 'quiero el pdf',
  // Verbos sueltos y sus conjugaciones/variantes de dictado más
  // comunes: mandar, enviar, descargar, imprimir, pasar, convertir,
  // abrir, compartir, bajar, entregar. Mientras exista un documento
  // activo, cualquiera de estas ya es intención de ENTREGA, no de
  // edición (ver detectarHerramientaDocumento). A propósito NO se
  // incluye "hazlo" suelto: es demasiado genérico y aparece todo el
  // tiempo en instrucciones de EDICIÓN reales ("hazlo más corto",
  // "hazlo para 4to grado") — agregarlo rompería esa distinción.
  'mandamelo', 'mandalo', 'enviamelo', 'descargamelo', 'descargala', 'descargalo',
  'descargarla', 'descargarlo', 'descargar', 'imprimelo', 'imprimir',
  'pasalo', 'pasamelo', 'conviertelo', 'abrelo', 'compartelo', 'comparte', 'compartir',
  'bajalo', 'entregalo', 'entrega', 'entregar', 'documeto',
  // Nombra el resultado sin verbo ("solo el archivo", "mándame el
  // documento", "dame el link/liga de descarga")
  'archivo', 'documento', 'descarga', 'link', 'liga de descarga',
  // Pide que no se repita/explique de nuevo el documento activo — no es
  // una instrucción de EDICIÓN real (cambiar contenido), sino la misma
  // intención de ENTREGA que "descárgalo": dar el resultado sin volver
  // a narrarlo. Sin esto caería en enviarComoEdicion (ver
  // AsistenteService.ts) y confundiría al modelo con una frase que no
  // pide ningún cambio de contenido.
  'no lo repitas', 'no la repitas', 'no repitas nada', 'no repitas el contenido',
  'no vuelvas a explicarlo', 'no vuelvas a explicarla', 'no lo vuelvas a explicar', 'no la vuelvas a explicar',
  'no lo expliques de nuevo', 'no la expliques de nuevo', 'no escribas nada',
  'no me lo repitas', 'no me lo vuelvas a explicar',
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
  const normalizado = normalizar(texto)
  return FRASES_FINALIZAR_DOCUMENTO.some((frase) => normalizado.includes(frase)) ? 'word' : null
}

// Qué pide un mensaje que ya nombra un formato (detectarHerramientaDocumento):
// - 'nuevo': un documento distinto, con una construcción explícita de
//   generación ("genera un documento PDF con el título...", "crea una
//   presentación sobre...", "hazme otro oficio") o un marcador
//   inequívoco ("un documento nuevo").
// - 'editar': cambiar el contenido y entregarlo ("agrega una conclusión y
//   guárdalo en PDF", "corrige la ortografía y pásalo a Word"): se edita el
//   texto real y con el resultado se genera el archivo (esEdicionConFormato).
// - 'convertir': todo lo demás ("pásalo a PDF", "hazme un PDF",
//   "pásalo otra vez a PDF") — el archivo del contenido que ya existe.
// Nombrar el formato nunca basta para decidir, y tampoco una palabra
// suelta ("sobre", "nueva"): "agrega información sobre las leyendas" o
// "agrega una sección nueva" siguen siendo ediciones.
const GENERACION = /\b(genera|generame|crea|creame|haz|hazme|elabora|elaborame|redacta|redactame|escribe|escribeme|prepara|preparame)\s+(un|una|otro|otra)\b/
const DETALLE_DOCUMENTO_NUEVO = /\bcon\s+(el\s+)?titulo\b|\btitulad[oa]\b|\bsobre\b|\bacerca\s+de\b|\bnuev[oa]\b/
const DOCUMENTO = '(documento|archivo|oficio|examen|presentacion|carta|ficha|circular|citatorio|reporte|informe)'
const DOCUMENTO_NUEVO = new RegExp(`\\b${DOCUMENTO}\\s+(\\w+\\s+)?nuev[oa]\\b|\\bnuev[oa]\\s+${DOCUMENTO}\\b`)
const VERBO_EDICION = /\b(agrega|agregale|anade|anadele|quita|quitale|elimina|cambia|cambiale|corrige|corrigele|modifica|reemplaza|amplia|resume|acorta)\b/

// Construcción explícita de creación: un verbo de creación, "un/una"
// (u "otro/otra") y LO QUE SE CREA. Lo creado es una lista ABIERTA —
// cualquier sustantivo ("citatorio", "examen", "instrumento", "rúbrica"...)
// — salvo los que no son un documento nuevo: un formato o archivo ("un
// PDF", "un documento") pide convertir, y un cambio o una parte del
// documento existente ("una versión más corta", "un resumen", "una
// conclusión", "otro igual") pide editarlo.
const VERBO_CREACION = '(genera|generame|crea|creame|haz|hazme|elabora|elaborame|redacta|redactame|escribe|escribeme|prepara|preparame|disena|disename|arma|armame|construye|construyeme|quiero|necesito)'
const CREACION = new RegExp(`\\b${VERBO_CREACION}\\s+(?:un|una|unos|unas|otro|otra|otros|otras)\\s+(?:(?:nuev[oa]s?|breve|corto|corta|pequen[oa])\\s+)?([a-z]+)`, 'g')
const FORMATO_O_ARCHIVO = new Set(['pdf', 'word', 'docx', 'doc', 'excel', 'xlsx', 'powerpoint', 'power', 'ppt', 'pptx', 'archivo', 'archivos', 'documento', 'documentos', 'copia', 'vez'])
const CAMBIO_O_PARTE = new Set([
  'version', 'resumen', 'adaptacion', 'traduccion', 'revision', 'correccion', 'mejora', 'ajuste', 'cambio', 'cambios', 'modificacion',
  'conclusion', 'introduccion', 'seccion', 'parrafo', 'apartado', 'titulo', 'encabezado', 'cierre', 'despedida', 'saludo', 'firma', 'pregunta', 'preguntas', 'tabla',
  'igual', 'parecido', 'parecida', 'similar', 'mas', 'asi',
])
function sustantivosCreados(normalizado: string): string[] {
  return [...normalizado.matchAll(CREACION)].map((m) => m[2])
}

// Referencia EXPLÍCITA al documento que ya existe ("este examen", "de
// esto", "el documento anterior"): tiene prioridad sobre la creación. No
// cuentan los pronombres ("entrégamelo"), que también se usan con lo que
// se está pidiendo crear, ni "este viernes".
const REFERENCIA_EXPLICITA = /\b(este|esta|ese|esa)\s+(documento|archivo|texto|contenido|oficio|examen|citatorio|planeacion|rubrica|resumen|carta|circular|ficha|reporte|informe|presentacion|borrador|version|aviso|actividad|instrumento|lista)\b|\b(de|con|a\s+partir\s+de)\s+(esto|eso)\b|\b(lo|el|la)\s+anterior\b|\b(documento|archivo|texto|contenido|oficio|examen|citatorio|resumen|borrador|version)\s+anterior\b/

// Pide crear un documento NUEVO (con o sin formato): una construcción
// explícita de creación de algo que no es un formato ni un cambio del
// documento existente, o los marcadores de siempre ("nuevo", "con el
// título..."), y sin referencia explícita al documento existente.
export function esPedidoDocumentoNuevo(texto: string): boolean {
  const normalizado = normalizar(texto)
  if (REFERENCIA_EXPLICITA.test(normalizado)) return false
  if (sustantivosCreados(normalizado).some((s) => !FORMATO_O_ARCHIVO.has(s) && !CAMBIO_O_PARTE.has(s))) return true
  return (GENERACION.test(normalizado) && DETALLE_DOCUMENTO_NUEVO.test(normalizado)) || DOCUMENTO_NUEVO.test(normalizado)
}

export type IntencionConFormato = 'convertir' | 'nuevo' | 'editar'

export function clasificarIntencionConFormato(texto: string): IntencionConFormato {
  const normalizado = normalizar(texto)
  if (esPedidoDocumentoNuevo(texto)) return 'nuevo'
  // No es un documento nuevo y aun así pide "crear" algo que no es un
  // formato ("hazme una síntesis de este documento", "una versión más
  // corta en PDF"): es una transformación del documento existente. Solo
  // "un PDF", "un documento"... siguen siendo conversión.
  if (VERBO_EDICION.test(normalizado) || sustantivosCreados(normalizado).some((s) => !FORMATO_O_ARCHIVO.has(s))) return 'editar'
  return 'convertir'
}

// Pide un archivo de un documento NUEVO: nunca se responde convirtiendo
// el documento activo (cliente) ni el último del historial (servidor) —
// se redacta desde cero (CASO 3 de FINALIZAR ARCHIVO en /api/chat).
export function esDocumentoNuevoConFormato(texto: string): boolean {
  return detectarHerramientaDocumento(texto) !== null && clasificarIntencionConFormato(texto) === 'nuevo'
}

// Editar el documento y entregarlo en un formato ("agrega una conclusión y
// guárdalo en PDF"): pide un cambio de contenido, no un documento nuevo.
export function esEdicionConFormato(texto: string): boolean {
  return detectarHerramientaDocumento(texto) !== null && clasificarIntencionConFormato(texto) === 'editar'
}

// Formatos que una edición puede entregar como archivo. El servidor solo
// acepta un formatoEntrega de esta lista (nunca confía en el cliente).
export const FORMATOS_ENTREGA = ['word', 'pdf', 'powerpoint', 'excel'] as const
export type FormatoEntrega = (typeof FORMATOS_ENTREGA)[number]
export function esFormatoEntrega(valor: unknown): valor is FormatoEntrega {
  return typeof valor === 'string' && (FORMATOS_ENTREGA as readonly string[]).includes(valor)
}

// Separa, dentro del prompt de edición (construirPromptEdicion en
// AsistenteService.ts), la instrucción real del maestro del documento que
// la precede — así nada se calcula sobre el texto del documento.
export const MARCADOR_INSTRUCCION_EDICION = 'INSTRUCCIÓN DEL MAESTRO:'
export function instruccionDeEdicion(promptEdicion: string): string | null {
  const i = promptEdicion.lastIndexOf(MARCADOR_INSTRUCCION_EDICION)
  return i === -1 ? null : promptEdicion.slice(i + MARCADOR_INSTRUCCION_EDICION.length).trim() || null
}

// Prompt de edición del documento: lo usan el cliente (documento activo,
// AsistenteService.ts) y el servidor (documento recuperado del historial,
// /api/chat) — un solo texto para los dos.
// Ampliado (ver "Motor de interpretación de intención y edición del
// Documento Activo") con dos párrafos nuevos: completado profesional
// ante instrucciones vagas, e interpretación de una foto adjunta
// como el mismo documento en vez de un tema nuevo. El resto del
// prompt (formato de salida, MODO DOCUMENTO) queda intacto a
// propósito — sigue siendo el mismo camino de edición que ya
// funciona, solo con más criterio para decidir QUÉ escribir.
export function construirPromptEdicion(documentoTexto: string, instruccion: string): string {
  return `El maestro pidió modificar/convertir el siguiente documento que ya se venía trabajando en esta conversación (aunque todavía no estuviera en el formato final de documento). Devuelve el documento COMPLETO ya actualizado, empezando DIRECTAMENTE con su título en mayúsculas y emoji (MODO DOCUMENTO) — nunca antes con una frase de confirmación, ni narrando de nuevo el contenido en prosa conversacional, ni explicando qué vas a hacer: la respuesta ES el documento, de principio a fin, sin nada más. Si la instrucción pide imágenes o ilustraciones, usa íconos y emoji relevantes para dar esa sensación visual dentro del texto — nunca respondas que no puedes generar imágenes.

Si la instrucción es vaga o pide completar/mejorar el documento en general ("complétalo", "llénalo", "hazlo formal", "termínalo", "arréglalo", "redáctalo", "pon lo que falta", "hazlo mejor", "corrígelo", "ponlo bonito", "perfecciónalo", "actualízalo", "modifícalo", o equivalentes): redacta tú mismo cualquier campo institucional que siga vacío o incompleto (observaciones, acuerdos, comentarios, seguimiento, conclusiones, recomendaciones, fundamento legal, etc.), con estilo profesional/institucional, coherente con el resto del documento (mismo alumno, incidente, fecha, materia y hechos ya presentes — nunca inventes datos que no estén ahí ni en la conversación). Nunca dejes marcadores genéricos como "Pendiente", "Opcional", "Escriba aquí" o similar, y nunca preguntes qué escribir — el maestro espera que completes esas partes con tu propio criterio profesional, no que se lo devuelvas sin terminar.

Si el mensaje trae una foto adjunta, en la gran mayoría de los casos esa foto ES este mismo documento (una captura de pantalla, una foto del papel ya impreso o firmado, una foto de lo que el maestro escribió a mano) — a menos que el maestro claramente esté pidiendo comparar o analizar algo distinto, interprétala como parte de este documento (para copiar datos que aparecen en ella, verificar que coincide, o completar/corregir con base en lo que se ve) y no como un tema nuevo e independiente.

DOCUMENTO/CONTENIDO ACTUAL:
${documentoTexto}

${MARCADOR_INSTRUCCION_EDICION}
${instruccion}`
}

// A qué documento se refiere un pedido de editar y entregar:
// - 'otro': nombra un documento distinto al último ("el oficio de la
//   semana pasada", "el primer examen", "el otro documento") — nunca se
//   sustituye por el más reciente.
// - 'reciente': se refiere sin ambigüedad al documento de la
//   conversación ("guárdalo", "agrégale", "el documento anterior",
//   "este documento").
// - 'ninguna': no se refiere a ningún documento.
// Sin búsqueda por título o fecha (eso es del futuro historial canónico).
export type ReferenciaDocumento = 'reciente' | 'otro' | 'ninguna'
// Solo palabras que nombran el documento, no su tema ("de la lectura",
// "la lista de útiles" suelen ser el tema de un pedido nuevo).
const DOCUMENTOS = '(documento|archivo|texto|contenido|oficio|examen|citatorio|planeacion|rubrica|resumen|carta|circular|ficha|reporte|informe|presentacion)'
const OTRO_DOCUMENTO = new RegExp(`\\bsemana\\s+pasada\\b|\\bmes\\s+pasado\\b|\\b(ayer|anteayer|antier)\\b|\\bhace\\s+(unos?|unas?|dos|tres|varios|varias|\\d+)\\b|\\b(del|el)\\s+(lunes|martes|miercoles|jueves|viernes)\\b|\\b(primer|primero|primera|penultimo|penultima|viejo|vieja|antiguo|antigua)\\s+${DOCUMENTOS}\\b|\\b(el|la)\\s+otr[oa]\\b|\\botr[oa]\\s+${DOCUMENTOS}\\b`)
const REFERENCIA_RECIENTE = new RegExp(`\\b(guarda|pasa|convierte|entrega|descarga|manda|envia|haz|pon|deja|exporta|genera|imprime|comparte|dame|resume|corrige|amplia|agrega|anade|quita|cambia|modifica)(l[oae]|mel[oa]|selo|sela)\\b|\\b(este|esta|ese|esa|el|la|mi)\\s+${DOCUMENTOS}\\b|\\b(lo|el|la)\\s+(anterior|ultimo|ultima)\\b|\\b${DOCUMENTOS}\\s+anterior\\b`)
export function referenciaDocumento(texto: string): ReferenciaDocumento {
  const n = normalizar(texto)
  if (OTRO_DOCUMENTO.test(n)) return 'otro'
  if (REFERENCIA_RECIENTE.test(n)) return 'reciente'
  return 'ninguna'
}
export function refiereDocumentoExistente(texto: string): boolean {
  return referenciaDocumento(texto) !== 'ninguna'
}

// ¿El documento que se tiene corresponde a lo que el docente nombró? Si
// nombra un tipo cuyo título lo dice siempre ("el oficio", "el examen",
// "el citatorio"...) y el título del documento no lo dice, no es ese.
const TIPO_CON_TITULO = /\b(el|la|este|esta|ese|esa|mi)\s+(oficio|examen|citatorio|planeacion|rubrica|resumen|carta|circular)\b/
export function referenciaCompatibleConDocumento(mensaje: string, documentoTexto: string): boolean {
  if (referenciaDocumento(mensaje) === 'otro') return false
  const tipo = normalizar(mensaje).match(TIPO_CON_TITULO)?.[2]
  if (!tipo) return true
  return normalizar(documentoTexto.trim().split('\n')[0] ?? '').includes(tipo)
}

// --- Decisión de /api/chat sobre el archivo pedido (pura, sin red) ---

type FinalizarArchivoCliente = { tipo: TipoHerramienta; documentoTexto: string }
function esFinalizarArchivo(valor: unknown): valor is FinalizarArchivoCliente {
  return typeof valor === 'object' && valor !== null && typeof (valor as { documentoTexto?: unknown }).documentoTexto === 'string'
}

// Qué archivo pide este turno (null: ninguno). Una edición nunca se
// detecta por su texto (es un prompt interno): solo cuenta formatoEntrega,
// y solo si está en FORMATOS_ENTREGA.
export function tipoArchivoSolicitado(e: { mensaje: string; esEdicionDocumento: boolean; formatoEntrega: unknown; finalizarArchivo: unknown }): TipoHerramienta | null {
  if (e.esEdicionDocumento) return esFormatoEntrega(e.formatoEntrega) ? e.formatoEntrega : null
  if (esFinalizarArchivo(e.finalizarArchivo)) return e.finalizarArchivo.tipo
  const tipo = detectarHerramientaDocumento(e.mensaje)
  // Una transformación textual sin formato NOMBRADO ("hazme una síntesis
  // de este documento") no pide archivo: "documento" no implica Word.
  if (tipo && !detectarFormatoExplicito(e.mensaje) && clasificarIntencionConFormato(e.mensaje) === 'editar') return null
  return tipo
}

// De dónde sale el contenido del archivo (fuera de una edición del
// documento activo, que ya trae su texto completo desde el cliente):
// - 'cliente' / 'historial': texto ya hecho, se convierte tal cual.
// - 'edicion-historial': editar Y entregar sin documento activo — el
//   documento a editar es, de forma explícita, el más reciente del
//   historial; su texto va dentro del prompt de edición (el modelo nunca
//   elige entre varios documentos).
// - 'ninguna': nada que convertir — el CASO 3 lo redacta (documento
//   nuevo; o edición cuyo referente es el adjunto de este mismo turno).
// - 'sin-documento': editar algo que ya no está disponible — no se
//   convierte una versión anterior ni se inventa.
// - 'aclarar': no se sabe con seguridad qué documento editar (nombra otro
//   documento, no corresponde al último o no se refiere a ninguno).
export type ContenidoParaArchivo =
  | { fuente: 'cliente' | 'historial' | 'edicion-historial'; texto: string }
  | { fuente: 'ninguna' | 'sin-documento' | 'aclarar' }

// Texto que queda en el historial cuando un documento se generó directo
// como archivo (CASO 3 en /api/chat): su contenido no está en el historial.
export const AVISO_ARCHIVO_GENERADO = 'Documento generado correctamente.'
// Texto técnico del mensaje que entrega el archivo de un documento ya
// existente (conversión o archivo reutilizado). Se guarda y sincroniza con
// el mensaje (un turno del asistente nunca puede ir vacío en el historial
// del modelo), pero el panel no lo muestra: solo la tarjeta del archivo.
export const AVISO_ARCHIVO_LISTO = 'Ya puedes abrirlo, compartirlo o descargarlo.'

export function contenidoParaArchivo(e: { mensaje: string; finalizarArchivo: unknown; historial: { role: 'user' | 'assistant'; content: string }[]; adjuntoPresente?: boolean }): ContenidoParaArchivo {
  if (esFinalizarArchivo(e.finalizarArchivo)) return { fuente: 'cliente', texto: e.finalizarArchivo.documentoTexto }
  if (esDocumentoNuevoConFormato(e.mensaje)) return { fuente: 'ninguna' }
  const ultimoDocumento = [...e.historial].reverse().find((h) => h.role === 'assistant' && esDocumentoFormal(h.content))
  if (esEdicionConFormato(e.mensaje)) {
    if (e.adjuntoPresente) return { fuente: 'ninguna' }
    const referencia = referenciaDocumento(e.mensaje)
    if (referencia === 'otro') return { fuente: 'aclarar' }
    if (referencia === 'reciente') {
      // El documento más reciente pudo generarse directo como archivo: en
      // el historial solo dejó "Documento generado correctamente." (sin su
      // texto). Entonces el último documento CON texto no es el reciente.
      const ultimoTurnoDeDocumento = [...e.historial].reverse().find((h) => h.role === 'assistant' && (esDocumentoFormal(h.content) || h.content.trim().startsWith(AVISO_ARCHIVO_GENERADO)))
      if (!ultimoDocumento || ultimoTurnoDeDocumento !== ultimoDocumento) return { fuente: 'sin-documento' }
      return referenciaCompatibleConDocumento(e.mensaje, ultimoDocumento.content) ? { fuente: 'edicion-historial', texto: ultimoDocumento.content } : { fuente: 'aclarar' }
    }
    // Sin referencia: con construcción de creación es un pedido nuevo
    // ("haz un PowerPoint de la lectura y agrega imágenes"); si no, no se
    // sabe qué editar.
    if (GENERACION.test(normalizar(e.mensaje))) return { fuente: 'ninguna' }
    return ultimoDocumento ? { fuente: 'aclarar' } : { fuente: 'sin-documento' }
  }
  return ultimoDocumento ? { fuente: 'historial', texto: ultimoDocumento.content } : { fuente: 'ninguna' }
}

// Pedir un archivo de documento (Word, PDF, PowerPoint, Excel) sin
// docente autenticado: nunca se redacta ni se convierte nada — /api/chat
// responde este aviso antes de cualquier llamada al modelo, y el cliente
// lo muestra tal cual (también en modo conversión).
export const MENSAJE_ARCHIVO_SIN_SESION = 'Tu sesión no está activa. Inicia sesión para generar el archivo; no se creó ningún archivo.'
export function archivoSinSesion(tipo: TipoHerramienta | null, userId: string | null): boolean {
  return !userId && esFormatoEntrega(tipo)
}
