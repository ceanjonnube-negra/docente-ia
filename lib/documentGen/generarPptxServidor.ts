// lib/documentGen/generarPptxServidor.ts
//
// Genera una presentación PowerPoint real (.pptx) en el servidor —
// convierte el mismo texto estructurado de MODO DOCUMENTO en una
// diapositiva de título más una diapositiva por cada sección principal
// (ver agruparEnDiapositivas en parseContenido.ts), sin que el maestro
// tenga que pedir "una diapositiva por día" explícitamente.

import PptxGenJS from 'pptxgenjs'
import { analizarContenido, agruparEnDiapositivas, extraerTitulo } from './parseContenido'
import { formatearFecha } from '../tiempo/TimeService'

function quitarEmoji(texto: string): string {
  return texto.replace(/\p{Extended_Pictographic}/gu, '').replace(/\s{2,}/g, ' ').trim()
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function generarPptxBuffer(texto: string, perfil: any, zonaHoraria: string | null): Promise<Buffer> {
  const pptx = new PptxGenJS()
  const lineas = analizarContenido(texto)
  const diapositivas = agruparEnDiapositivas(lineas)
  const titulo = quitarEmoji(extraerTitulo(texto))

  // Diapositiva de portada.
  const portada = pptx.addSlide()
  portada.background = { color: '166534' }
  portada.addText(titulo, { x: 0.5, y: 2, w: 9, h: 1.5, fontSize: 32, bold: true, color: 'FFFFFF', align: 'center' })
  portada.addText(
    `${perfil?.escuela || ''}\nDocente: ${perfil?.nombre || ''} · Grado ${perfil?.grado || ''}° Grupo ${perfil?.grupo || ''}\n${formatearFecha(new Date(), zonaHoraria, { day: 'numeric', month: 'long', year: 'numeric' })}`,
    { x: 0.5, y: 4, w: 9, h: 1.5, fontSize: 14, color: 'DCFCE7', align: 'center' }
  )

  // Una diapositiva por sección (DÍA 1, DÍA 2... o CRITERIO 1, CRITERIO 2...).
  for (const d of diapositivas) {
    const slide = pptx.addSlide()
    slide.addText(quitarEmoji(d.titulo), { x: 0.5, y: 0.4, w: 9, h: 0.8, fontSize: 24, bold: true, color: '166534' })
    const contenidoLimpio = d.contenido.map(quitarEmoji).filter(Boolean)
    if (contenidoLimpio.length > 0) {
      slide.addText(
        contenidoLimpio.map(texto => ({ text: texto, options: { bullet: true, breakLine: true } })),
        { x: 0.5, y: 1.4, w: 9, h: 5, fontSize: 16, color: '374151', valign: 'top' }
      )
    }
  }

  const arrayBuffer = await pptx.write({ outputType: 'nodebuffer' })
  return arrayBuffer as Buffer
}

export function nombreArchivoPptx(titulo: string): string {
  const slug = titulo
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'Presentacion'
  return `${slug}.pptx`
}
