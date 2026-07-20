// lib/documentGen/extraerTextoDocumento.ts
//
// Convierte un documento adjunto (Word/Excel/PowerPoint) en texto plano
// para dárselo a Claude como contexto — a diferencia de una imagen o un
// PDF, Claude no puede leer estos formatos directamente (ver
// app/api/chat/route.ts, bloque de contenido del mensaje). Se usa
// exclusivamente para el menú de adjuntos del Chat IA (RFC-CHAT-
// ADJUNTOS-003); no se tocó app/api/importar-alumnos/route.ts, que
// tiene su propia extracción por extensión de archivo para un flujo no
// relacionado (importar la lista de alumnos).

import * as XLSX from 'xlsx'
import mammoth from 'mammoth'
import JSZip from 'jszip'

export type TipoDocumentoAdjunto = 'pdf' | 'docx' | 'xlsx' | 'pptx' | null

const MIME_A_TIPO: Record<string, TipoDocumentoAdjunto> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.ms-powerpoint': 'pptx',
}

export function clasificarTipoDocumento(mime: string | null | undefined): TipoDocumentoAdjunto {
  if (!mime) return null
  return MIME_A_TIPO[mime] || null
}

async function extraerTextoXlsx(buffer: Buffer): Promise<string> {
  const libro = XLSX.read(buffer, { type: 'buffer' })
  return libro.SheetNames
    .map((nombre) => `--- Hoja: ${nombre} ---\n${XLSX.utils.sheet_to_csv(libro.Sheets[nombre])}`)
    .join('\n\n')
}

async function extraerTextoDocx(buffer: Buffer): Promise<string> {
  const resultado = await mammoth.extractRawText({ buffer })
  return resultado.value
}

// Un .pptx es un zip con una entrada XML por diapositiva
// (ppt/slides/slideN.xml); el texto visible vive en nodos <a:t>. No hay
// una librería de lectura de pptx entre las dependencias del proyecto
// (pptxgenjs solo genera), así que se extrae directo del XML — mismo
// enfoque que cualquier lector de OOXML simple.
async function extraerTextoPptx(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer)
  const nombresDiapositivas = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)\.xml/)?.[1] || '0', 10)
      const nb = parseInt(b.match(/slide(\d+)\.xml/)?.[1] || '0', 10)
      return na - nb
    })

  const textos: string[] = []
  for (const nombre of nombresDiapositivas) {
    const xml = await zip.files[nombre].async('text')
    const texto = Array.from(xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)).map((m) => m[1]).join(' ')
    textos.push(texto)
  }
  return textos.map((t, i) => `--- Diapositiva ${i + 1} ---\n${t}`).join('\n\n')
}

// Nunca se llama con tipo 'pdf': un PDF se envía a Claude como bloque
// binario nativo (document, media_type application/pdf), no se
// extrae texto aquí — ver app/api/chat/route.ts.
export async function extraerTextoDocumento(buffer: Buffer, tipo: Exclude<TipoDocumentoAdjunto, 'pdf' | null>): Promise<string> {
  if (tipo === 'xlsx') return extraerTextoXlsx(buffer)
  if (tipo === 'docx') return extraerTextoDocx(buffer)
  return extraerTextoPptx(buffer)
}
