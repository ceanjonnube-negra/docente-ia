import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Header } from 'docx'
import { saveAs } from 'file-saver'

export const generarWord = async (texto: string, perfil: any) => {
  const fecha = new Date().toLocaleDateString('es-MX', { year: 'numeric', month: 'long', day: 'numeric' })

  const encabezado = new Header({
    children: [
      new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'SECRETARÍA DE EDUCACIÓN PÚBLICA', bold: true, size: 20 })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: perfil?.escuela?.toUpperCase() || 'ESCUELA PRIMARIA', bold: true, size: 20 })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `${perfil?.municipio || ''}, ${perfil?.estado || ''} | Ciclo Escolar 2024-2025`, size: 18, color: '666666' })] }),
      new Paragraph({ children: [new TextRun('')] }),
    ]
  })

  const lineas = texto.split('\n').filter(l => l.trim())
  const parrafos: any[] = []

  for (const linea of lineas) {
    const l = linea.trim()
    if (!l) { parrafos.push(new Paragraph({ children: [new TextRun('')] })); continue }
    if (l.startsWith('# ')) {
      parrafos.push(new Paragraph({ text: l.replace(/^#+\s/, ''), heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER, spacing: { before: 200, after: 100 } }))
    } else if (l.startsWith('## ')) {
      parrafos.push(new Paragraph({ text: l.replace(/^#+\s/, ''), heading: HeadingLevel.HEADING_2, spacing: { before: 160, after: 80 } }))
    } else if (l.startsWith('### ')) {
      parrafos.push(new Paragraph({ text: l.replace(/^#+\s/, ''), heading: HeadingLevel.HEADING_3, spacing: { before: 120, after: 60 } }))
    } else if (l.startsWith('- ') || l.startsWith('* ')) {
      parrafos.push(new Paragraph({ children: [new TextRun({ text: l.replace(/^[-*]\s/, '') })], bullet: { level: 0 }, spacing: { before: 40, after: 40 } }))
    } else {
      const runs: TextRun[] = []
      const partes = l.split(/\*\*(.*?)\*\*/g)
      partes.forEach((parte, i) => {
        if (i % 2 === 1) runs.push(new TextRun({ text: parte, bold: true }))
        else if (parte) runs.push(new TextRun({ text: parte }))
      })
      parrafos.push(new Paragraph({ children: runs.length > 0 ? runs : [new TextRun({ text: l })], spacing: { before: 60, after: 60 } }))
    }
  }

  const piePagina = [
    new Paragraph({ children: [new TextRun('')] }),
    new Paragraph({ alignment: AlignmentType.LEFT, children: [new TextRun({ text: `Docente: ${perfil?.nombre || ''}     Grado: ${perfil?.grado || ''}° Grupo: ${perfil?.grupo || ''}     Fecha: ${fecha}`, size: 20 })] }),
    new Paragraph({ children: [new TextRun('')] }),
    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: '_______________________________', size: 20 })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: perfil?.nombre || 'Docente', bold: true, size: 20 })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'Firma del Docente', size: 18, color: '666666' })] }),
  ]

  const doc = new Document({
    sections: [{
      headers: { default: encabezado },
      properties: { page: { margin: { top: 1000, right: 900, bottom: 900, left: 900 } } },
      children: [...parrafos, ...piePagina]
    }]
  })

  const blob = await Packer.toBlob(doc)
  saveAs(blob, `Planeacion_${perfil?.nombre?.split(' ')[0] || 'Docente'}_${perfil?.grado}${perfil?.grupo}_${Date.now()}.docx`)
}
