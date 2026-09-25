// lib/seguimiento/analisisHojaEvaluacion.ts
//
// EVAL-1D — extracción visual ESTRUCTURADA (transcripción, nunca
// interpretación) de la fotografía de una hoja de evaluación de
// Seguimiento ya impresa y contestada a mano. Mismo patrón real ya
// probado en lib/listaOficial/analisisListaOficial.ts: llamada
// NO-streaming, respuesta forzada a JSON (sin tool_use), validación
// server-side estricta de cada registro — nunca confía ciegamente en
// lo que el modelo devuelve. El cliente Anthropic se recibe como
// parámetro (igual que analizarImagenesListaOficial) — esta función
// nunca crea su propia instancia ni lee ANTHROPIC_API_KEY.
//
// Esta fase es SOLO extracción. Deliberadamente NO hace: matching
// contra alumnos/inscripciones reales, escritura en
// seguimiento_resultados, confirmación, ni conversión de la escala
// 1-4 al enum textual canónico (eso pertenece a persistencia real,
// fuera de alcance aquí) — ver informe EVAL-1D.
//
// Geometría real de la hoja (lib/documentGen/generarHojaSeguimientoPdf.ts,
// verificada antes de escribir este archivo): columnas de izquierda a
// derecha — "#" (posición IMPRESA, nunca manuscrita), "Alumno"
// (nombre impreso — deliberadamente IGNORADO aquí, ver regla D del
// informe: la posición física ya es suficiente, no hace falta pedirle
// a la IA que lea nombres), "I1".."I5" (una celda vacía por
// indicador, el docente escribe a mano un solo dígito 1-4 o la deja
// vacía = no evaluado), "Nivel final" (sexta columna, más ancha —
// EXPLÍCITAMENTE FUERA DE ALCANCE de esta fase, nunca se le pide a la
// IA que la transcriba).
//
// Reutiliza LecturaMarca/interpretarMarcas de conversionCalificacion.ts
// (ya diseñados para este problema exacto, sin conexión real hasta
// ahora): la IA solo reporta qué dígitos percibió en cada celda —
// interpretarMarcas() decide, de forma determinista y sin ninguna
// llamada adicional, si eso es un nivel limpio, una celda vacía, o
// una lectura dudosa (más de un dígito, o un dígito fuera de 1-4).

import Anthropic from '@anthropic-ai/sdk'
import convertirHeic from 'heic-convert'
import { interpretarMarcas, type LecturaMarca } from './conversionCalificacion'
import { CANTIDAD_INDICADORES_HOJA, type NivelEvaluacion } from './tipos'

export type ConfianzaLecturaHoja = 'alta' | 'media' | 'baja'
const CONFIANZAS_VALIDAS: ConfianzaLecturaHoja[] = ['alta', 'media', 'baja']

function normalizarConfianza(valor: unknown): ConfianzaLecturaHoja {
  // Fail-closed: cualquier valor fuera del enum conocido (ausente, mal
  // escrito, de otro tipo) se trata como la opción MENOS confiable —
  // nunca se asume "alta" por defecto. Mismo criterio ya usado en
  // analisisListaOficial.ts.
  return typeof valor === 'string' && CONFIANZAS_VALIDAS.includes(valor as ConfianzaLecturaHoja) ? (valor as ConfianzaLecturaHoja) : 'baja'
}

export type CeldaHojaEvaluacion = {
  numeroIndicador: number
  lectura: LecturaMarca
  confianza: ConfianzaLecturaHoja
  // true si lectura.estado !== 'nivel' (vacío o dudosa) O la confianza
  // reportada no es 'alta' — determinista, calculado aquí, NUNCA
  // decidido por la IA. Es la única señal que una fase posterior debe
  // usar para decidir qué mostrarle al docente para revisión.
  dudoso: boolean
}

export type FilaHojaEvaluacion = {
  // Posición física observada tal como aparece impresa en la columna
  // "#" — deliberadamente SIN reconciliar con alumno_id/inscripcion_id
  // todavía (regla E del informe EVAL-1D): eso es responsabilidad de
  // una fase posterior (matching), que cruzará esta posición contra
  // hojas_evaluacion.roster_congelado.
  posicion: number
  // Exactamente CANTIDAD_INDICADORES_HOJA celdas, una por cada
  // numeroIndicador 1..N — nunca menos, nunca duplicadas (validado
  // server-side, ver validarResultadoExtraccionHoja).
  celdas: CeldaHojaEvaluacion[]
}

export type ResultadoExtraccionHojaEvaluacion = {
  filas: FilaHojaEvaluacion[]
  observacionGeneral?: string
}

export type MediaTypeImagenHoja = 'image/jpeg' | 'image/png' | 'image/webp'
const MEDIA_TYPES_VALIDOS: MediaTypeImagenHoja[] = ['image/jpeg', 'image/png', 'image/webp']

function esMediaTypeValido(valor: unknown): valor is MediaTypeImagenHoja {
  return typeof valor === 'string' && (MEDIA_TYPES_VALIDOS as string[]).includes(valor)
}

export type ImagenHojaEvaluacion = {
  base64: string
  mediaType: MediaTypeImagenHoja
}

// Extensiones que ya llegan en un mediaType soportado directamente
// por la API de visión — pasan sin ningún trabajo adicional.
const MIME_POR_EXTENSION_DIRECTA: Record<string, MediaTypeImagenHoja> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

// EVAL-1D.1 — extensiones que EVAL-1C ya acepta en la carga
// (foto-hoja/route.ts) pero que la API de visión de Anthropic NO
// soporta directamente — el formato por defecto de fotos de iPhone.
// Aquí, y solo aquí, se normalizan a JPEG ANTES de la única llamada
// de visión — nunca se envían tal cual.
const EXTENSIONES_HEIC = new Set(['heic', 'heif'])

// Calidad de recompresión JPEG tras decodificar el HEIC original —
// deliberadamente alta (heic2any, la conversión ya existente del lado
// del cliente, usa 0.9; aquí se usa un punto más para no perder
// nitidez en los dígitos manuscritos, el único dato que de verdad
// importa leer). Nunca cambia las dimensiones/resolución del píxel
// original — heic-convert solo recodifica, no reescala.
const CALIDAD_JPEG_DESDE_HEIC = 0.92

// Firma mínima del único método de heic-convert que se usa — extraída
// aparte para poder inyectar un doble determinista en pruebas (mismo
// criterio ya usado en todo el proyecto para el cliente Anthropic/
// Supabase: nunca se crea la dependencia real dentro de la función,
// siempre se recibe, con un default real para no obligar a los
// llamadores de producción a pasarla).
export type ConvertidorHeic = (opciones: { buffer: Buffer; format: 'JPEG'; quality: number }) => Promise<Uint8Array>

// EVAL-1D.1 — punto único de normalización de imagen ANTES de
// analizarImagenHojaEvaluacion(). JPG/PNG/WEBP pasan tal cual (0
// trabajo adicional, 0 recompresión). HEIC/HEIF se decodifican y
// recodifican a JPEG server-side, en memoria — nunca se sube el
// resultado a Storage, nunca se toca el archivo original
// (captura_pendiente.fotoStoragePath sigue apuntando al HEIC
// original tal como EVAL-1C lo dejó). La conversión NUNCA cuenta como
// llamada IA — es decodificación/recompresión pura, determinista, sin
// ningún modelo de por medio. Fail-closed: si el HEIC está corrupto o
// heic-convert no logra decodificarlo, se relanza el error tal cual —
// el llamador nunca debe alcanzar analizarImagenHojaEvaluacion() en
// ese caso (0 llamadas IA ante una conversión fallida).
export async function normalizarImagenHojaParaVision(
  buffer: Buffer,
  extension: string,
  convertidorHeic: ConvertidorHeic = convertirHeic
): Promise<ImagenHojaEvaluacion> {
  const ext = extension.toLowerCase()

  const mediaTypeDirecto = MIME_POR_EXTENSION_DIRECTA[ext]
  if (mediaTypeDirecto) {
    return { base64: buffer.toString('base64'), mediaType: mediaTypeDirecto }
  }

  if (EXTENSIONES_HEIC.has(ext)) {
    let convertido: Uint8Array
    try {
      convertido = await convertidorHeic({ buffer, format: 'JPEG', quality: CALIDAD_JPEG_DESDE_HEIC })
    } catch (e) {
      throw new Error(`No se pudo convertir la fotografía HEIC para analizarla: ${e instanceof Error ? e.message : 'archivo no decodificable'}.`)
    }
    const bufferConvertido = Buffer.from(convertido)
    if (bufferConvertido.length === 0) {
      throw new Error('La conversión de la fotografía HEIC produjo un archivo vacío.')
    }
    return { base64: bufferConvertido.toString('base64'), mediaType: 'image/jpeg' }
  }

  throw new Error('Formato de imagen no soportado para el análisis.')
}

// EVAL-1D.2 — versión plural de normalizarImagenHojaParaVision: una
// entrada por página, en el MISMO orden en que se reciben (el
// llamador es responsable de ordenarlas por número de página ANTES de
// llamar aquí — ver extraerFotosCapturaPendiente más abajo). Cada foto
// pasa exactamente UNA vez por la normalización (nunca se reconvierte
// una imagen ya convertida, nunca se llama esta función más de una
// vez por foto en todo el flujo). Fail-closed por lote completo: si
// CUALQUIER página falla al normalizarse (HEIC corrupto, formato no
// soportado), el error se relanza de inmediato y NINGUNA imagen del
// lote llega a analizarImagenesHojaEvaluacion — nunca se analiza un
// subconjunto de páginas disponibles ni se completa con las que sí se
// pudieron convertir.
export async function normalizarImagenesHojaParaVision(
  fotos: { buffer: Buffer; extension: string }[],
  convertidorHeic: ConvertidorHeic = convertirHeic
): Promise<ImagenHojaEvaluacion[]> {
  const resultado: ImagenHojaEvaluacion[] = []
  for (const foto of fotos) {
    resultado.push(await normalizarImagenHojaParaVision(foto.buffer, foto.extension, convertidorHeic))
  }
  return resultado
}

// EVAL-1D.2 — una entrada del arreglo ordenado
// proyectos_seguimiento.captura_pendiente.fotos: una fotografía por
// página física de la hoja. `pagina` es 1-indexada y se declara
// explícitamente en la carga (foto-hoja/route.ts) — nunca se infiere
// del orden de llegada del arreglo ni del orden de subida.
export type FotoCapturaHoja = {
  storagePath: string
  pagina: number
  subidaEn: string
}

// Forma real (parcial) de captura_pendiente que necesita
// extraerFotosCapturaPendiente — deliberadamente mínima y local a este
// archivo, para no acoplar este módulo puro al tipo completo de la
// fila de proyectos_seguimiento (que vive en el route handler).
type CapturaPendienteConFotos = {
  fotos?: unknown
  // Forma histórica, escrita por EVAL-1C antes de que existiera el
  // soporte multipágina — una sola fotografía, sin número de página
  // explícito porque en ese momento solo existía una página posible.
  fotoStoragePath?: unknown
  fotoSubidaEn?: unknown
} | null | undefined

// EVAL-1D.2 — único punto de lectura de "qué fotografías tiene esta
// captura en curso", con compatibilidad retroactiva TOTAL: si existe
// el arreglo nuevo captura_pendiente.fotos (toda captura escrita desde
// este cambio en adelante, incluidas las de 1 sola página), se usa tal
// cual, validando cada entrada — fail-closed sobre el arreglo COMPLETO
// ante cualquier forma inesperada o página duplicada, nunca un
// subconjunto. Si no existe ese arreglo pero SÍ existe el campo
// histórico fotoStoragePath (toda captura_pendiente escrita antes de
// este cambio), se envuelve como una sola foto de página 1 — ninguna
// captura previa deja de funcionar. Devuelve SIEMPRE ordenado por
// pagina ascendente.
export function extraerFotosCapturaPendiente(capturaPendiente: unknown): FotoCapturaHoja[] {
  const cp = capturaPendiente as CapturaPendienteConFotos
  if (!cp || typeof cp !== 'object') return []

  if (Array.isArray(cp.fotos)) {
    const fotos: FotoCapturaHoja[] = []
    for (const f of cp.fotos) {
      if (typeof f !== 'object' || f === null) return []
      const obj = f as Record<string, unknown>
      if (typeof obj.storagePath !== 'string' || !obj.storagePath) return []
      if (typeof obj.pagina !== 'number' || !Number.isInteger(obj.pagina) || obj.pagina < 1) return []
      if (typeof obj.subidaEn !== 'string' || !obj.subidaEn) return []
      fotos.push({ storagePath: obj.storagePath, pagina: obj.pagina, subidaEn: obj.subidaEn })
    }
    const paginasVistas = new Set(fotos.map((f) => f.pagina))
    // Páginas duplicadas: fail-closed sobre el arreglo completo — nunca
    // se adivina cuál de las dos copias de una misma página es la
    // buena.
    if (paginasVistas.size !== fotos.length) return []
    return fotos.sort((a, b) => a.pagina - b.pagina)
  }

  if (typeof cp.fotoStoragePath === 'string' && cp.fotoStoragePath) {
    const subidaEn = typeof cp.fotoSubidaEn === 'string' && cp.fotoSubidaEn ? cp.fotoSubidaEn : new Date(0).toISOString()
    return [{ storagePath: cp.fotoStoragePath, pagina: 1, subidaEn }]
  }

  return []
}

// Único dato dinámico que entra al prompt además de las propias
// imágenes (regla B/C del informe: contexto mínimo, nunca historial ni
// datos de alumnos) — cuántas filas se esperan en TOTAL (sumando todas
// las páginas), para que la IA tenga una referencia real contra la
// cual no quedarse corta ni inventar filas de más. Nunca nombres,
// nunca IDs, nunca el roster.
//
// EVAL-1D.2 — cantidadImagenes ajusta el prompt para el caso
// multipágina: cuando hay más de una fotografía, se le aclara
// EXPLÍCITAMENTE al modelo que son páginas CONSECUTIVAS de la MISMA
// hoja física (en el orden en que se le entregan los bloques de
// imagen), nunca hojas de alumnos distintos ni fotos repetidas de la
// misma página — para que nunca transcriba dos veces la misma fila ni
// mezcle posiciones entre páginas.
function construirInstrucciones(cantidadFilasEsperadas: number, cantidadImagenes: number): string {
  const contextoPaginas = cantidadImagenes > 1
    ? `Recibirás ${cantidadImagenes} fotografías. Son páginas CONSECUTIVAS de la MISMA hoja física, en orden (la primera imagen es la página 1, la segunda es la página 2, y así sucesivamente) — nunca hojas de alumnos distintos, nunca la misma página repetida. Cada página tiene su propio encabezado de tabla, pero las posiciones "#" NUNCA se repiten entre páginas — continúan la numeración de la hoja completa. Transcribe cada página tal como la ves, sin mezclar filas entre páginas.`
    : 'Recibirás 1 sola fotografía con toda la hoja.'

  return `Eres un asistente que transcribe con extremo cuidado la(s) fotografía(s) de una hoja de evaluación escolar mexicana ya impresa y contestada a mano.

${contextoPaginas}

Tu ÚNICA tarea es TRANSCRIBIR lo que ves — nunca decidir un nivel, nunca inferir, nunca completar nada, nunca identificar quién es cada alumno.

Estructura real de la hoja (de izquierda a derecha):
- Una columna angosta "#" con un número IMPRESO (no manuscrito) — la posición física de cada fila.
- Una columna "Alumno" con un nombre impreso — IGNÓRALA POR COMPLETO, nunca la transcribas, no es tu tarea.
- Cinco columnas angostas "I1" a "I5" — cada una es una celda vacía donde el docente escribió A MANO un solo dígito (4, 3, 2 o 1), o la dejó en blanco.
- Una última columna más ancha "Nivel final" — IGNÓRALA POR COMPLETO, no la transcribas, no pertenece a esta tarea.

La hoja tiene aproximadamente ${cantidadFilasEsperadas} filas de alumnos EN TOTAL (sumando todas las páginas). Úsalo solo como referencia para no perder ni inventar filas — si las fotos muestran menos filas legibles de las esperadas, reporta solo las que realmente puedas leer.

Reglas estrictas, en orden de prioridad:
1. Para cada fila que puedas identificar por su número "#" impreso, reporta el número EXACTO que ves impreso ahí — nunca lo infieras por el orden ni lo asumas consecutivo.
2. Para cada una de las 5 celdas I1-I5 de esa fila, reporta en "digitosDetectados" TODOS los dígitos que realmente percibas escritos en esa celda: [] si está vacía, [un número] si hay un solo dígito claro, o varios números si ves más de un trazo/corrección/dígito superpuesto — nunca decidas tú cuál es el correcto, solo reporta lo que ves.
3. Solo reporta dígitos 1, 2, 3 o 4. Si ves un trazo que no puedas identificar con seguridad como uno de esos 4 dígitos, NO lo incluyas en digitosDetectados — en vez de eso, baja tu "confianza" de esa celda.
4. "confianza" es independiente por cada celda — "alta" solo si el dígito es completamente inequívoco; "media" o "baja" ante cualquier duda real, sin importar cuántos dígitos reportaste.
5. NUNCA infieras el valor de una celda por el rendimiento de otras celdas de la misma fila, por el nombre del alumno, por un promedio, ni por ningún patrón — cada celda se lee de forma completamente independiente.
6. NUNCA transcribas la columna "Alumno" ni la columna "Nivel final" — no forman parte de esta tarea.
7. Si alguna de las fotografías es demasiado borrosa, está cortada, muestra un documento distinto, o por cualquier razón no puedes transcribir esa página con una confianza razonable, responde "hojaLegible": false y NO incluyas ninguna fila de NINGUNA página — nunca fabriques una tabla que parezca completa a partir de fotos que en realidad no puedes leer todas.
8. Nunca reportes la misma posición "#" dos veces, aunque aparezca en dos fotografías distintas por error — cada posición existe una sola vez en la hoja completa.

Responde ÚNICAMENTE con un JSON válido (sin explicación, sin markdown, sin backticks), con este formato exacto:
{
  "hojaLegible": true | false,
  "filas": [
    {
      "posicion": <número impreso real>,
      "celdas": [
        { "numeroIndicador": 1, "digitosDetectados": [<0 o más números>], "confianza": "alta" | "media" | "baja" },
        { "numeroIndicador": 2, "digitosDetectados": [], "confianza": "alta" | "media" | "baja" },
        { "numeroIndicador": 3, "digitosDetectados": [], "confianza": "alta" | "media" | "baja" },
        { "numeroIndicador": 4, "digitosDetectados": [], "confianza": "alta" | "media" | "baja" },
        { "numeroIndicador": 5, "digitosDetectados": [], "confianza": "alta" | "media" | "baja" }
      ]
    }
  ],
  "observacionGeneral": "<opcional, muy breve, solo si algo relevante aplica a toda la hoja>"
}

Si "hojaLegible" es false, responde { "hojaLegible": false, "filas": [] }.`
}

function limpiarJson(texto: string): string {
  return texto.replace(/```json/g, '').replace(/```/g, '').trim()
}

// Valida UNA celda cruda del modelo y produce la celda final ya
// interpretada de forma determinista (0 IA en este paso). Devuelve
// null ante cualquier forma inesperada — la fila completa se
// descartará más arriba si esto ocurre (fail-closed: nunca se
// "completa" una celda rota con un valor aproximado).
function validarCelda(c: unknown): CeldaHojaEvaluacion | null {
  if (typeof c !== 'object' || c === null) return null
  const obj = c as Record<string, unknown>

  const numeroIndicador = obj.numeroIndicador
  if (typeof numeroIndicador !== 'number' || !Number.isInteger(numeroIndicador) || numeroIndicador < 1 || numeroIndicador > CANTIDAD_INDICADORES_HOJA) return null

  const digitosBrutos = obj.digitosDetectados
  if (!Array.isArray(digitosBrutos)) return null
  // Fail-closed por celda: cualquier dígito fuera de 1-4 (o de tipo
  // incorrecto) NUNCA se descarta en silencio manteniendo el resto —
  // convierte la celda entera en una lectura dudosa, igual que un
  // segundo dígito contradictorio (ver interpretarMarcas).
  let huboRuido = false
  const digitosValidos: NivelEvaluacion[] = []
  for (const d of digitosBrutos) {
    if (typeof d === 'number' && Number.isInteger(d) && d >= 1 && d <= 4) {
      digitosValidos.push(d as NivelEvaluacion)
    } else {
      huboRuido = true
    }
  }
  // Si hubo CUALQUIER dígito fuera de 1-4 (ruido), la celda se trata
  // como dudosa sin importar cuántos dígitos válidos también vinieran
  // — nunca se descarta el ruido en silencio para quedarse con una
  // lectura que en realidad no fue limpia. Sin ruido, interpretarMarcas
  // decide: 0 dígitos => no_evaluado, 1 => nivel, 2+ => dudosa.
  const lecturaFinal: LecturaMarca = huboRuido ? { estado: 'lectura_dudosa' } : interpretarMarcas(digitosValidos)

  const confianza = normalizarConfianza(obj.confianza)
  const dudoso = lecturaFinal.estado !== 'nivel' || confianza !== 'alta'

  return { numeroIndicador, lectura: lecturaFinal, confianza, dudoso }
}

// Valida UNA fila cruda del modelo. Exige EXACTAMENTE el conjunto
// {1..CANTIDAD_INDICADORES_HOJA} de numeroIndicador, sin duplicados y
// sin faltantes — una fila con un indicador repetido o ausente se
// rechaza por completo (null), nunca se "completa" con una celda
// inventada ni se ignora silenciosamente el duplicado.
function validarFila(f: unknown, posicionesMaximas: number): FilaHojaEvaluacion | null {
  if (typeof f !== 'object' || f === null) return null
  const obj = f as Record<string, unknown>

  const posicion = obj.posicion
  if (typeof posicion !== 'number' || !Number.isInteger(posicion) || posicion < 1 || posicion > posicionesMaximas) return null

  const celdasBrutas = obj.celdas
  if (!Array.isArray(celdasBrutas)) return null
  const celdas = celdasBrutas.map(validarCelda)
  if (celdas.some((c) => c === null)) return null
  const celdasValidas = celdas as CeldaHojaEvaluacion[]

  const numerosVistos = new Set(celdasValidas.map((c) => c.numeroIndicador))
  if (numerosVistos.size !== celdasValidas.length) return null // duplicado dentro de la fila
  for (let n = 1; n <= CANTIDAD_INDICADORES_HOJA; n++) {
    if (!numerosVistos.has(n)) return null // faltante — nunca se rellena
  }

  return { posicion, celdas: celdasValidas.sort((a, b) => a.numeroIndicador - b.numeroIndicador) }
}

// Punto de entrada puro y determinista de validación — exportado para
// poder probarlo aislado, sin credenciales de Anthropic (mismo
// criterio que validarRegistroExtraido en analisisListaOficial.ts).
// Fail-closed en TODO el resultado (nunca solo por fila) ante:
// hojaLegible=false, JSON con forma inesperada, cualquier fila
// inválida, o posiciones duplicadas entre filas — nunca se devuelve
// una matriz parcial que aparente estar completa.
export function validarResultadoExtraccionHoja(parseado: unknown, posicionesMaximas: number): ResultadoExtraccionHojaEvaluacion {
  if (typeof parseado !== 'object' || parseado === null) {
    throw new Error('No pude interpretar el análisis de la hoja. Intenta de nuevo con una foto más clara.')
  }
  const obj = parseado as Record<string, unknown>

  if (obj.hojaLegible !== true) {
    throw new Error('La fotografía no es suficientemente legible para transcribir la hoja. Intenta con mejor luz o encuadre.')
  }

  if (!Array.isArray(obj.filas)) {
    throw new Error('No pude interpretar el análisis de la hoja. Intenta de nuevo con una foto más clara.')
  }
  if (obj.filas.length === 0) {
    throw new Error('No se detectó ninguna fila legible en la fotografía. Intenta de nuevo con una foto más clara.')
  }

  const filas = obj.filas.map((f) => validarFila(f, posicionesMaximas))
  if (filas.some((f) => f === null)) {
    throw new Error('La transcripción de la hoja tiene una estructura inválida. Intenta de nuevo con una foto más clara.')
  }
  const filasValidas = filas as FilaHojaEvaluacion[]

  const posicionesVistas = new Set(filasValidas.map((f) => f.posicion))
  if (posicionesVistas.size !== filasValidas.length) {
    throw new Error('La transcripción de la hoja reportó la misma posición más de una vez. Intenta de nuevo con una foto más clara.')
  }

  const observacionGeneralBruta = obj.observacionGeneral
  const observacionGeneral = typeof observacionGeneralBruta === 'string' && observacionGeneralBruta.trim() ? observacionGeneralBruta.trim().slice(0, 200) : undefined

  return { filas: filasValidas.sort((a, b) => a.posicion - b.posicion), observacionGeneral }
}

// EVAL-1D.2 — límite defensivo de páginas/fotografías por hoja. Un
// grupo escolar real en México prácticamente nunca excede ~45-50
// alumnos (calcularCantidadPaginasHoja(50) = 2 páginas) — este máximo
// deja margen amplio por encima de cualquier grupo real
// (calcularCantidadPaginasHoja(150) = 5) sin dejar de acotar un abuso
// claro (una hoja no puede, en la práctica, requerir docenas de
// fotografías). No reutiliza MAXIMO_IMAGENES_LISTA_OFICIAL (=4, de
// lib/listaOficial/analisisListaOficial.ts) porque ese límite responde
// a un producto distinto (reutilización de imágenes históricas en
// Chat) sin relación con la paginación real de este documento.
export const MAXIMO_PAGINAS_HOJA = 6

// Única llamada real a Anthropic de todo este archivo (regla A/L del
// informe EVAL-1D: máximo 1 llamada de visión, 0 llamadas de texto
// adicionales, 0 IA para matching o conversión de escala) — incluso
// cuando la hoja tiene varias páginas: EVAL-1D.2 envía TODAS las
// fotografías dentro del MISMO mensaje/llamada, mismo patrón ya
// probado en analizarImagenesListaOficial
// (lib/listaOficial/analisisListaOficial.ts) — nunca una llamada por
// fotografía.
export async function analizarImagenesHojaEvaluacion(
  anthropic: Anthropic,
  imagenes: ImagenHojaEvaluacion[],
  cantidadFilasEsperadas: number
): Promise<ResultadoExtraccionHojaEvaluacion> {
  if (imagenes.length === 0) {
    throw new Error('No se recibió ninguna fotografía de la hoja para analizar.')
  }
  // Fail-closed por límite: nunca se procesa un subconjunto silencioso
  // de las fotografías recibidas — igual que en
  // analizarImagenesListaOficial, si vienen más páginas de las
  // soportadas se rechaza la operación completa.
  if (imagenes.length > MAXIMO_PAGINAS_HOJA) {
    throw new Error(`Se recibieron demasiadas fotografías (máximo ${MAXIMO_PAGINAS_HOJA} páginas por hoja).`)
  }
  if (imagenes.some((img) => !esMediaTypeValido(img.mediaType))) {
    throw new Error('Una o más fotografías tienen un formato no soportado.')
  }
  if (!Number.isInteger(cantidadFilasEsperadas) || cantidadFilasEsperadas < 1) {
    throw new Error('No hay un roster congelado válido para interpretar esta hoja.')
  }

  const bloquesImagen = imagenes.map((img) => ({
    type: 'image' as const,
    source: { type: 'base64' as const, media_type: img.mediaType, data: img.base64 },
  }))

  const respuesta = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8000,
    messages: [
      {
        role: 'user',
        content: [...bloquesImagen, { type: 'text', text: construirInstrucciones(cantidadFilasEsperadas, imagenes.length) }],
      },
    ],
  })

  const bloqueTexto = respuesta.content.find((b) => b.type === 'text')
  const textoRespuesta = bloqueTexto && 'text' in bloqueTexto ? bloqueTexto.text : ''

  let parseado: unknown
  try {
    parseado = JSON.parse(limpiarJson(textoRespuesta))
  } catch {
    throw new Error('No pude interpretar el análisis de la hoja. Intenta de nuevo con una foto más clara.')
  }

  return validarResultadoExtraccionHoja(parseado, cantidadFilasEsperadas)
}
