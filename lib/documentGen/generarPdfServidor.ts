// lib/documentGen/generarPdfServidor.ts
//
// Genera un PDF real en el servidor con pdfkit — reemplaza el mecanismo
// anterior (window.print() del navegador, que no es un archivo real,
// solo el diálogo de impresión del sistema) para cuando el maestro pide
// el documento específicamente en PDF a través del Chat IA.

import PDFDocument from 'pdfkit'
import { analizarContenido } from './parseContenido'
import { formatearFecha } from '../tiempo/TimeService'

// La fuente base de pdfkit (Helvetica) no tiene glifos para emoji —
// sin esto, cada emoji del formato MODO DOCUMENTO (📋, 🎯, 📅...) sale
// como bytes ilegibles en el PDF en vez de simplemente no imprimirse.
// Se quitan del texto visible; el contenido real (títulos, secciones)
// se sigue leyendo perfecto sin ellos.
function quitarEmoji(texto: string): string {
  return texto.replace(/\p{Extended_Pictographic}/gu, '').replace(/\s{2,}/g, ' ').trim()
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function generarPdfBuffer(texto: string, perfil: any, zonaHoraria: string | null): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50, size: 'letter' })
      const chunks: Buffer[] = []
      doc.on('data', (chunk: Buffer) => chunks.push(chunk))
      doc.on('end', () => resolve(Buffer.concat(chunks)))
      doc.on('error', reject)

      // Encabezado — mismos datos reales que el Word.
      doc.fontSize(10).fillColor('#374151')
        .text(perfil?.escuela || 'Escuela', { align: 'center' })
        .text(
          `Docente: ${perfil?.nombre || ''}   Grado: ${perfil?.grado || ''}°   Grupo: ${perfil?.grupo || ''}   Fecha: ${formatearFecha(new Date(), zonaHoraria, { day: 'numeric', month: 'numeric', year: 'numeric' })}`,
          { align: 'left' }
        )
      doc.moveDown(1)

      const lineas = analizarContenido(texto)
      let primerTitulo = true
      for (const l of lineas) {
        const texto = quitarEmoji(l.texto)
        if (!texto) continue
        if (l.tipo === 'titulo') {
          doc.fontSize(primerTitulo ? 18 : 14).fillColor('#166534').font('Helvetica-Bold')
            .text(texto, { align: primerTitulo ? 'center' : 'left' })
          doc.moveDown(0.5)
          primerTitulo = false
        } else if (l.tipo === 'seccion') {
          doc.moveDown(0.3)
          doc.fontSize(13).fillColor('#166534').font('Helvetica-Bold').text(texto)
          doc.moveDown(0.3)
        } else if (l.tipo === 'bullet') {
          doc.fontSize(11).fillColor('#374151').font('Helvetica').list([texto], { bulletRadius: 2 })
        } else {
          doc.fontSize(11).fillColor('#374151').font('Helvetica').text(texto, { align: 'justify' })
          doc.moveDown(0.3)
        }
      }

      doc.moveDown(2)
      doc.fontSize(10).fillColor('#666666')
        .text('______________________________', { align: 'center' })
        .text(perfil?.nombre || 'Docente', { align: 'center' })
        .text('Firma del Docente', { align: 'center' })

      doc.end()
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

export function nombreArchivoPdf(titulo: string): string {
  const slug = titulo
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'Documento'
  return `${slug}.pdf`
}
