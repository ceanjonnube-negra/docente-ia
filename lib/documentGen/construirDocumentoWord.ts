// lib/documentGen/construirDocumentoWord.ts
//
// Construcción del documento Word (objeto `Document` de la librería
// `docx`) — compartida entre el generador de cliente (utils/generarWord.ts,
// que lo empaqueta a Blob y lo descarga con file-saver) y el generador de
// servidor (lib/documentGen/generarWordServidor.ts, que lo empaqueta a
// Buffer y lo sube a Storage). La construcción del documento es idéntica
// en ambos lados — la única diferencia es cómo se empaqueta y entrega el
// resultado, que SÍ es específico de cada entorno (navegador vs Node).

import { Document, Paragraph, TextRun, Header, AlignmentType, ShadingType, BorderStyle, Table, TableRow, TableCell, WidthType } from 'docx'
import { formatearFecha, obtenerZonaHorariaDispositivo, ZONA_HORARIA_RESPALDO } from '../tiempo/TimeService'

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

const CURP_REGEX = /[A-Z]{4}\d{6}[A-Z]{6}[A-Z0-9]\d/i
const esListaConCurp = (lineas: string[]): boolean => {
  const conCurp = lineas.filter(l => CURP_REGEX.test(l))
  return conCurp.length >= 2
}

const generarTablaAlumnos = (lineas: string[]): Table => {
  const filas: TableRow[] = []

  filas.push(new TableRow({
    children: [
      new TableCell({ width: { size: 70, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text: 'Nombre', bold: true, size: 20, color: 'FFFFFF' })] })], shading: { type: ShadingType.CLEAR, color: 'auto', fill: '16A34A' } }),
      new TableCell({ width: { size: 30, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text: 'CURP', bold: true, size: 20, color: 'FFFFFF' })] })], shading: { type: ShadingType.CLEAR, color: 'auto', fill: '16A34A' } }),
    ]
  }))

  for (const linea of lineas) {
    const l = linea.trim()
    const curpMatch = l.match(CURP_REGEX)
    if (!curpMatch) continue
    const curp = curpMatch[0]
    let resto = l.replace(curp, '')
    resto = resto.replace(/^\d+\s*/, '').replace(/[|—:-]/g, ' ').replace(/\s+/g, ' ').trim()
    filas.push(new TableRow({
      children: [
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: resto, size: 20, color: '374151' })] })] }),
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: curp, size: 20, color: '374151' })] })] }),
      ]
    }))
  }

  return new Table({ rows: filas, width: { size: 100, type: WidthType.PERCENTAGE } })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function construirDocumentoWord(texto: string, perfil?: any, zonaHoraria?: string | null): Document {
  const fecha = formatearFecha(new Date(), zonaHoraria || ZONA_HORARIA_RESPALDO, { day: 'numeric', month: 'numeric', year: 'numeric' })

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
  const elementos: (Paragraph | Table)[] = []
  let tituloPrincipalUsado = false

  if (esListaConCurp(lineas)) {
    elementos.push(generarTablaAlumnos(lineas))
  } else {
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
  }

  const piePagina = [
    new Paragraph({ children: [new TextRun('')], spacing: { before: 400 } }),
    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: '______________________________', size: 20 })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: perfil?.nombre || 'Docente', bold: true, size: 20 })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'Firma del Docente', size: 18, color: '666666' })] }),
  ]

  return new Document({
    sections: [{
      headers: { default: encabezado },
      properties: { page: { margin: { top: 1000, right: 900, bottom: 900, left: 900 } } },
      children: [...elementos, ...piePagina]
    }]
  })
}

// Nombre de archivo consistente entre cliente y servidor.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function nombreArchivoWord(perfil?: any): string {
  return `Planeacion_${perfil?.nombre?.split(' ')[0] || 'Docente'}_${perfil?.grado || ''}${perfil?.grupo || ''}_${Date.now()}.docx`
}
