// lib/listaOficial/analisisListaOficial.ts
//
// V1-A — extracción estructurada de una lista oficial (fotografía de un
// documento con nombres y CURP de alumnos) vía Claude Vision. Mismo
// patrón real ya probado en lib/calendario/analisisCalendario.ts:
// llamada NO-streaming, respuesta forzada a JSON (sin tool_use),
// validación server-side estricta de cada registro — nunca confía
// ciegamente en lo que el modelo devuelve.
//
// Esta fase es SOLO extracción visual. Deliberadamente NO hace:
// matching contra alumnos reales, comparación con la base de datos,
// decisión de qué actualizar, ni ninguna escritura — eso pertenece a
// V1-B (matching/diff) y fases posteriores. Independiente del
// streaming principal del Chat — no importa nada de app/api/chat/
// route.ts ni de clasificadorNivel0.ts, y no es importada por ellos
// todavía.

import Anthropic from '@anthropic-ai/sdk'

export type ConfianzaLecturaLista = 'alta' | 'media' | 'baja'

export type RegistroExtraidoListaOficial = {
  nombreLeido: string | null
  nombreConfianza: ConfianzaLecturaLista

  curpLeida: string | null
  curpLegible: boolean
  curpConfianza: ConfianzaLecturaLista

  observacion?: string
}

export type ResultadoExtraccionListaOficial = {
  registros: RegistroExtraidoListaOficial[]
  observacionGeneral?: string
}

// Una imagen de la fuente visual — deliberadamente un tipo propio y
// mínimo (no AdjuntoImagen de lib/asistente/tipos.ts): esta fase no
// necesita ningún otro campo de ese tipo (nombreArchivo, etc.) y evita
// crear una dependencia de ida y vuelta con un archivo que esta fase
// no debe tocar.
export type MediaTypeImagenListaOficial = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

export type ImagenListaOficial = {
  base64: string
  mediaType: MediaTypeImagenListaOficial
}

// Whitelist runtime — el tipo de arriba solo protege en tiempo de
// compilación; un caller futuro (ej. datos ya deserializados de un
// request) puede traer un mediaType que TypeScript no puede impedir en
// runtime. Nunca se aproxima un formato no reconocido a otro.
const MEDIA_TYPES_VALIDOS: MediaTypeImagenListaOficial[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']

function esMediaTypeValido(valor: unknown): valor is MediaTypeImagenListaOficial {
  return typeof valor === 'string' && (MEDIA_TYPES_VALIDOS as string[]).includes(valor)
}

// Mismo máximo ya validado E2E para V3-A (reutilizar_imagen_subida,
// ver app/api/chat/route.ts MAXIMO_IMAGENES_HISTORICAS) — deliberadamente
// unificado: una lista analizada aquí en el mismo turno y una
// reutilizada después desde el historial deben compartir exactamente
// el mismo límite, para que nunca exista un caso donde 5-6 imágenes se
// puedan analizar ahora pero no puedan reutilizarse más tarde.
const MAXIMO_IMAGENES_LISTA_OFICIAL = 4

const CONFIANZAS_VALIDAS: ConfianzaLecturaLista[] = ['alta', 'media', 'baja']

const INSTRUCCIONES = `Eres un asistente que transcribe con extremo cuidado una fotografía de una lista oficial de alumnos (lista de asistencia, boletín, constancia, listado con CURP, o documento similar) para un docente mexicano.

Tu ÚNICA tarea es TRANSCRIBIR lo que ves — nunca decidir nada, nunca comparar contra ningún alumno real, nunca completar ni corregir nada.

Reglas estrictas, en orden de prioridad:
1. Transcribe SOLO datos realmente visibles en la imagen. Nunca inventes ni completes un nombre o una CURP que no puedas leer con seguridad.
2. NUNCA completes una CURP parcialmente visible con caracteres que no veas — si faltan o no se distinguen caracteres, dejar curpLeida en null o marcar curpLegible=false, nunca rellenar.
3. NUNCA infieras un carácter dudoso por parecido o por contexto (ej. nunca decidas que una letra borrosa "debe ser" una O porque el resto de la CURP parece válida).
4. NUNCA fabriques ni derives una CURP a partir del nombre, fecha o cualquier otro dato — una CURP solo cuenta si está escrita en el documento y la puedes leer.
5. NUNCA "corrijas" en silencio una CURP que te parezca mal formada — transcribe exactamente lo que ves, incluso si el resultado no parece una CURP válida.
6. Si un carácter de la CURP no se distingue con seguridad: curpLegible=false, curpConfianza="baja" o "media" según qué tan cerca estuviste de leerla completa, y curpLeida puede ser null si no puedes transcribir el resto con seguridad.
7. nombreConfianza y curpConfianza son INDEPENDIENTES uno del otro — evalúa cada uno por separado, nunca copies el mismo valor entre ambos por costumbre.
8. Es válido y esperado que el nombre tenga confianza "alta" mientras la CURP del mismo registro tenga confianza "baja", o viceversa.
9. Si la CURP parece completa pero tienes duda real sobre uno o más caracteres, NUNCA marques curpConfianza="alta" — usa "media" o "baja".
10. NO decidas si la persona pertenece a algún grupo o lista de la aplicación — no tienes esa información y no es tu tarea aquí.
11. NO decidas ni sugieras qué dato debería actualizarse en ningún sistema — solo transcribes lo que ves.
12. Mantén el ORDEN de aparición del documento tal como lo ves (de arriba hacia abajo, y en el mismo orden si son varias imágenes de la misma lista).
13. Si una fila del documento no tiene ni nombre ni CURP legibles en absoluto, ignórala — no generes un registro vacío.

Responde ÚNICAMENTE con un JSON válido (sin explicación, sin markdown, sin backticks), con este formato exacto:
{
  "registros": [
    {
      "nombreLeido": "<nombre exactamente como aparece, o null si no es legible>",
      "nombreConfianza": "alta" | "media" | "baja",
      "curpLeida": "<CURP exactamente como aparece, o null si no es legible con seguridad>",
      "curpLegible": true | false,
      "curpConfianza": "alta" | "media" | "baja",
      "observacion": "<opcional, muy breve, solo si algo relevante amerita nota>"
    }
  ],
  "observacionGeneral": "<opcional, muy breve, solo si algo relevante aplica a todo el documento>"
}

Si no encuentras ningún registro legible, responde { "registros": [] }.`

function limpiarJson(texto: string): string {
  return texto.replace(/```json/g, '').replace(/```/g, '').trim()
}

// Trim + mayúsculas únicamente — normalización NO destructiva. Nunca
// intercambia caracteres visualmente parecidos (0/O, 1/I, 5/S...): esa
// clase de "corrección" pertenece exactamente al tipo de invención que
// esta fase tiene prohibido hacer.
function normalizarCurpNoDestructivo(valor: string): string {
  return valor.trim().toUpperCase()
}

function normalizarConfianza(valor: unknown): ConfianzaLecturaLista {
  // Fail-closed: cualquier valor fuera del enum conocido (ausente,
  // mal escrito, de otro tipo) se trata como la opción MENOS
  // confiable — nunca se asume "alta" por defecto.
  return typeof valor === 'string' && CONFIANZAS_VALIDAS.includes(valor as ConfianzaLecturaLista) ? (valor as ConfianzaLecturaLista) : 'baja'
}

// Única barrera real contra un JSON con forma inesperada devuelto por
// el modelo — mismo criterio que validarDiferencia en
// analisisCalendario.ts (exportada para poder probarla aislada, sin
// credenciales de Anthropic). Un registro gravemente mal formado
// (nombreLeido de un tipo que no sea string/null) se descarta por
// completo en vez de intentar salvarlo — nunca se inventa nada para
// "completar" un registro roto.
export function validarRegistroExtraido(r: unknown): RegistroExtraidoListaOficial | null {
  if (typeof r !== 'object' || r === null) return null
  const obj = r as Record<string, unknown>

  const nombreLeidoBruto = obj.nombreLeido
  if (nombreLeidoBruto !== null && typeof nombreLeidoBruto !== 'string') return null
  const nombreLeido = typeof nombreLeidoBruto === 'string' && nombreLeidoBruto.trim() ? nombreLeidoBruto.trim() : null

  const curpLeidaBruta = obj.curpLeida
  if (curpLeidaBruta !== null && curpLeidaBruta !== undefined && typeof curpLeidaBruta !== 'string') return null
  const curpLeida = typeof curpLeidaBruta === 'string' && curpLeidaBruta.trim() ? normalizarCurpNoDestructivo(curpLeidaBruta) : null

  let curpLegible = typeof obj.curpLegible === 'boolean' ? obj.curpLegible : false
  // Contradicción defensiva: no puede ser "legible" sin contenido
  // transcrito — degradar en vez de confiar en la bandera sola.
  if (curpLegible && !curpLeida) curpLegible = false

  let curpConfianza = normalizarConfianza(obj.curpConfianza)
  // Misma defensa que la regla 9 del prompt, ahora también aplicada
  // server-side: nunca "alta" si la CURP no se marcó legible.
  if (!curpLegible && curpConfianza === 'alta') curpConfianza = 'media'

  const nombreConfianza = normalizarConfianza(obj.nombreConfianza)

  const observacionBruta = obj.observacion
  const observacion = typeof observacionBruta === 'string' && observacionBruta.trim() ? observacionBruta.trim().slice(0, 200) : undefined

  return { nombreLeido, nombreConfianza, curpLeida, curpLegible, curpConfianza, observacion }
}

export async function analizarImagenesListaOficial(anthropic: Anthropic, imagenes: ImagenListaOficial[]): Promise<ResultadoExtraccionListaOficial> {
  if (imagenes.length === 0) {
    throw new Error('No se recibió ninguna imagen de la lista oficial para analizar.')
  }
  // Fail-closed por límite: nunca se procesa un subconjunto silencioso
  // de las imágenes recibidas — si vienen más de las soportadas en
  // esta fase, se rechaza la operación completa en vez de analizar
  // solo una parte y reportar un resultado parcial como si fuera
  // completo.
  if (imagenes.length > MAXIMO_IMAGENES_LISTA_OFICIAL) {
    throw new Error(`Se recibieron demasiadas imágenes (máximo ${MAXIMO_IMAGENES_LISTA_OFICIAL} por análisis).`)
  }
  // Validación runtime del formato — el tipo de ImagenListaOficial solo
  // protege en compilación; un caller que reciba datos ya deserializados
  // (ej. de un request) podría traer un mediaType fuera de la whitelist.
  // Fail-closed por lote completo: nunca se aproxima un formato no
  // reconocido a otro, ni se procesan las demás imágenes válidas del
  // mismo lote si una sola trae un formato no soportado.
  if (imagenes.some((img) => !esMediaTypeValido(img.mediaType))) {
    throw new Error('Una o más imágenes tienen un formato no soportado.')
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
        content: [...bloquesImagen, { type: 'text', text: INSTRUCCIONES }],
      },
    ],
  })

  const bloqueTexto = respuesta.content.find((b) => b.type === 'text')
  const textoRespuesta = bloqueTexto && 'text' in bloqueTexto ? bloqueTexto.text : ''

  let parseado: unknown
  try {
    parseado = JSON.parse(limpiarJson(textoRespuesta))
  } catch {
    throw new Error('No pude interpretar el análisis de la lista oficial. Intenta de nuevo con una foto más clara.')
  }

  if (typeof parseado !== 'object' || parseado === null || !Array.isArray((parseado as Record<string, unknown>).registros)) {
    throw new Error('No pude interpretar el análisis de la lista oficial. Intenta de nuevo con una foto más clara.')
  }

  const bruto = (parseado as { registros: unknown[] }).registros
  const registros = bruto.map(validarRegistroExtraido).filter((r): r is RegistroExtraidoListaOficial => r !== null)

  const observacionGeneralBruta = (parseado as Record<string, unknown>).observacionGeneral
  const observacionGeneral = typeof observacionGeneralBruta === 'string' && observacionGeneralBruta.trim() ? observacionGeneralBruta.trim().slice(0, 200) : undefined

  return { registros, observacionGeneral }
}
