import { Document, Packer, Paragraph, TextRun, Header, AlignmentType, ShadingType, BorderStyle } from 'docx'
import { saveAs } from 'file-saver'

const preprocesarTexto = (texto: string): string[] => {
  return texto
    .split('\n')
    .filter(linea => {
      const l = linea.trim()
      if (!l) return false
      if (l.startsWith('|')) return false
      if (/^[-|:\s]+$/.test(l)) return false
      if (l === '---') return false
      if (/^-{2,}$/.test(l)) return false
      return true
    })
    .map(linea =>
      linea
        .replace(/\*\*(.*?)\*\*/g, '$1')
        .replace(/\*(.*?)\*/g, '$1')
        .replace(/^#{1,6}\s+/, '')
        .replace(/^>\s+/, '')
        .trim()
    )
    .filter(l => l.length > 0)
}

const esTitulo = (linea: string): boolean => {
  return linea === linea.toUpperCase() && linea.length > 3
}

const esBullet = (linea: string): boolean => {
  return /^-\s+/.test(linea.trim())
}

export const generarWord = async (texto: string, perfil?: any) => {
  const fecha = new Date().toLocaleDateString('es-MX')

  const encabezado = new Header({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: perfil?.escuela || 'Escuela', bold: true, size: 20 })]
      }),
      new Paragraph({
        alignment: AlignmentType.LEFT,
        children: [new TextRun({ text: `Docente: ${perfil?.nombre || ''}   Grado: ${perfil?.grado || ''}°   Grupo: ${perfil?.grupo || ''}   Fecha: ${fecha}`, size: 20 })]
      }),
    ]
  })

  const lineas = preprocesarTexto(texto)
  const elementos: Paragraph[] = []
  let tituloPrincipalUsado = false

  for (const linea of lineas) {
    if (esTitulo(linea)) {
      if (!tituloPrincipalUsado) {
        elementos.push(new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: linea, bold: true, size: 32, color: '166534' })],
          spacing: { before: 120, after: 200 },
          border: { bottom: { color: '16A34A', space: 4, style: BorderStyle.SINGLE, size: 12 } }
        }))
        tituloPrincipalUsado = true
      } else {
        elementos.push(new Paragraph({
          children: [new TextRun({ text: linea, bold: true, size: 24, color: '166534' })],
          spacing: { before: 280, after: 140 },
          shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'DCFCE7' }
        }))
      }
    } else if (esBullet(linea)) {
      elementos.push(new Paragraph({
        children: [new TextRun({ text: linea.trim().replace(/^-\s+/, ''), size: 22, color: '374151' })],
        bullet: { level: 0 },
        spacing: { after: 60 }
      }))
    } else {
      elementos.push(new Paragraph({
        alignment: AlignmentType.JUSTIFIED,
        children: [new TextRun({ text: linea, size: 22, color: '374151' })],
        spacing: { after: 100 }
      }))
    }
  }

  const piePagina = [
    new Paragraph({ children: [new TextRun('')], spacing: { before: 400 } }),
    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: '______________________________', size: 20 })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: perfil?.nombre || 'Docente', bold: true, size: 20 })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'Firma del Docente', size: 18, color: '666666' })] }),
  ]

  const doc = new Document({
    sections: [{
      headers: { default: encabezado },
      properties: { page: { margin: { top: 1000, right: 900, bottom: 900, left: 900 } } },
      children: [...elementos, ...piePagina]
    }]
  })

  const blob = await Packer.toBlob(doc)
  saveAs(blob, `Planeacion_${perfil?.nombre?.split(' ')[0] || 'Docente'}_${perfil?.grado}${perfil?.grupo}_${Date.now()}.docx`)
}
