// lib/asistente/copiarRespuesta.ts
//
// "Copiar" de una respuesta del Chat IA: qué texto se copia
// (textoParaCopiar) y cómo llega al portapapeles (copiarAlPortapapeles).
// Solo el texto de ESA respuesta — nunca botones, tarjetas, URLs firmadas
// de archivos (viven en `archivo`/`archivos`, no en `texto`) ni
// marcadores internos ([[...]], que el motor ya quita; aquí se quitan de
// nuevo por seguridad).

import { esAvisoTecnicoDeArchivo, esDocumentoFormal } from './documentos'
import type { MensajeConversacion } from './tipos'

const MARCADOR_INTERNO = /\[\[[A-Z_]+(:[^\]]*)?\]\]/g
// URL firmada de Storage (Supabase): técnica, nunca contenido del docente.
const URL_FIRMADA = /https?:\/\/\S+\/storage\/v1\/object\/sign\/\S+/g

function sinElementosInternos(texto: string): string {
  return texto.replace(MARCADOR_INTERNO, '').replace(URL_FIRMADA, '')
}

function ordenarEspacios(texto: string): string {
  return texto.split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

// Markdown → texto legible, línea por línea: conserva párrafos, saltos
// de línea y listas ("- ", "1. "); quita la sintaxis de énfasis,
// encabezados, citas y enlaces (queda el texto del enlace). Los bloques
// de código y las filas de tabla se conservan tal cual (solo se quitan
// las líneas de cercas ``` y las de separación |---|).
export function markdownATexto(markdown: string): string {
  const salida: string[] = []
  let enCodigo = false
  for (const linea of markdown.split('\n')) {
    if (/^\s*```/.test(linea)) {
      enCodigo = !enCodigo
      continue
    }
    if (enCodigo) {
      salida.push(linea)
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(linea)) {
      if (!/^\s*\|[\s:|-]+\|\s*$/.test(linea)) salida.push(linea.trim())
      continue
    }
    const sinBloque = linea
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s*>\s?/, '')
      .replace(/^(\s*)[*+]\s+/, '$1- ')
    // El código en línea (`...`) se copia intacto: el énfasis solo se
    // quita fuera de él.
    salida.push(sinBloque.split(/(`[^`]+`)/).map((parte, i) => (i % 2 === 1 ? parte.slice(1, -1) : sinEnfasis(parte))).join(''))
  }
  return salida.join('\n')
}

// Énfasis y enlaces fuera del código. El énfasis exige contenido real
// (no solo "_" o "*"): "______" (espacio para completar) y "3 * 4" no se
// tocan.
function sinEnfasis(texto: string): string {
  return texto
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(?=[^\s*_])(.*?[^\s*_])\1/g, '$2')
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^_\w])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1$2')
}

// Texto que copia "Copiar" para un mensaje, o null si no hay contenido
// útil (mensaje del docente, vacío, o documento entregado solo como
// archivo sin su contenido guardado — nunca se reconstruye ni inventa).
export function textoParaCopiar(mensaje: Pick<MensajeConversacion, 'rol' | 'texto' | 'contenidoDocumento'>): string | null {
  if (mensaje.rol !== 'asistente') return null
  const contenidoDocumento = mensaje.contenidoDocumento?.trim()
  if (contenidoDocumento) return ordenarEspacios(sinElementosInternos(contenidoDocumento)) || null
  const texto = sinElementosInternos(mensaje.texto ?? '')
  if (!texto.trim() || esAvisoTecnicoDeArchivo(texto)) return null
  // Un documento formal ya es texto plano estructurado (MODO DOCUMENTO):
  // se copia tal cual. El resto de respuestas viene en Markdown.
  const plano = esDocumentoFormal(texto) ? texto : markdownATexto(texto)
  return ordenarEspacios(plano) || null
}

type EntornoPortapapeles = {
  navigator?: { clipboard?: { writeText(texto: string): Promise<void> } }
  isSecureContext?: boolean
  document?: {
    body: { appendChild(n: unknown): unknown; removeChild(n: unknown): unknown } | null
    createElement(etiqueta: 'textarea'): {
      value: string
      style: Record<string, string>
      setAttribute(nombre: string, valor: string): void
      focus(): void
      select(): void
      setSelectionRange(inicio: number, fin: number): void
    }
    execCommand(comando: string): boolean
  }
}

// Alternativa para navegadores sin Clipboard API (o fuera de HTTPS): un
// textarea temporal + execCommand('copy'), de forma síncrona, dentro del
// mismo toque. Letra de 16px para que iOS no haga zoom al enfocarlo.
function copiarConAreaTemporal(texto: string, doc: EntornoPortapapeles['document']): boolean {
  if (!doc?.body) return false
  const area = doc.createElement('textarea')
  area.value = texto
  area.setAttribute('readonly', '')
  Object.assign(area.style, { position: 'fixed', top: '0', left: '0', opacity: '0', fontSize: '16px' })
  doc.body.appendChild(area)
  try {
    area.focus()
    area.select()
    area.setSelectionRange(0, texto.length)
    return doc.execCommand('copy') === true
  } catch {
    return false
  } finally {
    doc.body.removeChild(area)
  }
}

// Copia `texto`. Debe llamarse directo desde el toque del botón (sin
// esperar nada antes), para que Safari conserve la activación del usuario.
// true solo si la copia se confirmó.
export async function copiarAlPortapapeles(texto: string, entorno: EntornoPortapapeles = globalThis as unknown as EntornoPortapapeles): Promise<boolean> {
  const portapapeles = entorno.navigator?.clipboard
  if (portapapeles?.writeText && entorno.isSecureContext !== false) {
    try {
      await portapapeles.writeText(texto)
      return true
    } catch {
      // Sigue con la alternativa.
    }
  }
  return copiarConAreaTemporal(texto, entorno.document)
}
