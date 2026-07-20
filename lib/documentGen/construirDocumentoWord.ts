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
import { prepararEncabezado } from './encabezadoDocumento'

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

// "EQUIPO 1", "EQUIPO 2"... — un tipo de sección aparte del título
// genérico: cada uno abre con una línea divisoria real (no caracteres
// Unicode de caja, que ni pdf-lib ni todas las fuentes de Word
// soportan) y sus integrantes se cuentan aparte para el resumen final
// automático — nunca se le pide a la IA que reporte cuántos hay, se
// cuenta de verdad a partir de las viñetas reales debajo de cada uno.
const EQUIPO_REGEX = /^EQUIPO\s+(\d+)/i
const esEquipo = (linea: string): RegExpMatchArray | null => linea.match(EQUIPO_REGEX)

// Paleta discreta — nunca fondos de color ni acentos brillantes, solo
// texto en tonos gris/verde oscuro institucional, igual en título,
// secciones y equipos.
const COLOR_TITULO = '1F2937' // gris oscuro, casi negro — nunca verde brillante
const COLOR_TEXTO = '374151'
const COLOR_TEXTO_SUAVE = '6B7280'
const COLOR_BORDE = 'D1D5DB' // gris claro, discreto

const CURP_REGEX = /[A-Z]{4}\d{6}[A-Z]{6}[A-Z0-9]\d/i
const esListaConCurp = (lineas: string[]): boolean => {
  const conCurp = lineas.filter(l => CURP_REGEX.test(l))
  return conCurp.length >= 2
}

const generarTablaAlumnos = (lineas: string[]): Table => {
  const filas: TableRow[] = []

  filas.push(new TableRow({
    children: [
      new TableCell({ width: { size: 70, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text: 'Nombre', bold: true, size: 20, color: COLOR_TITULO })] })], shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F3F4F6' } }),
      new TableCell({ width: { size: 30, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text: 'CURP', bold: true, size: 20, color: COLOR_TITULO })] })], shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F3F4F6' } }),
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
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: resto, size: 20, color: COLOR_TEXTO })] })] }),
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: curp, size: 20, color: COLOR_TEXTO })] })] }),
      ]
    }))
  }

  return new Table({ rows: filas, width: { size: 100, type: WidthType.PERCENTAGE } })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function construirDocumentoWord(texto: string, perfil?: any, zonaHoraria?: string | null): Document {
  const enc = prepararEncabezado(perfil, zonaHoraria)

  // Encabezado institucional — UNO solo, siempre igual, nunca lo
  // escribe la IA en el cuerpo (ver regla 9 de MODO DOCUMENTO en
  // app/api/chat/route.ts). Cada dato en su propia línea, centrado,
  // para que nunca se vea partido a la mitad ni desalineado.
  const encabezado = new Header({
    children: [
      new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: enc.escuela, bold: true, size: 22, color: COLOR_TITULO })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `Docente: ${enc.docente}`, size: 18, color: COLOR_TEXTO_SUAVE })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `Grado: ${enc.grado}    Grupo: ${enc.grupo}`, size: 18, color: COLOR_TEXTO_SUAVE })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `${enc.lugar ? enc.lugar + '   ·   ' : ''}Fecha: ${enc.fecha}`, size: 18, color: COLOR_TEXTO_SUAVE })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `Ciclo Escolar: ${enc.cicloEscolar}`, size: 18, color: COLOR_TEXTO_SUAVE })], spacing: { after: 160 } }),
    ]
  })

  const lineas = preprocesarTexto(texto)
  const elementos: (Paragraph | Table)[] = []
  let tituloPrincipalUsado = false

  // Conteo real de integrantes por equipo — nunca reportado por la IA,
  // siempre contado aquí a partir de las viñetas reales bajo cada
  // "EQUIPO N" (ver RESUMEN FINAL más abajo).
  const integrantesPorEquipo: { numero: string; total: number }[] = []
  let equipoActual: { numero: string; total: number } | null = null
  let primerEquipo = true

  if (esListaConCurp(lineas)) {
    elementos.push(generarTablaAlumnos(lineas))
  } else {
    for (const linea of lineas) {
      const matchEquipo = esEquipo(linea)
      if (matchEquipo) {
        equipoActual = { numero: matchEquipo[1], total: 0 }
        integrantesPorEquipo.push(equipoActual)
        elementos.push(new Paragraph({
          children: [new TextRun({ text: linea, bold: true, size: 24, color: COLOR_TITULO })],
          spacing: { before: primerEquipo ? 320 : 400, after: 160 },
          border: { top: { color: COLOR_BORDE, space: 8, style: BorderStyle.SINGLE, size: 6 } }
        }))
        primerEquipo = false
      } else if (esTitulo(linea)) {
        if (!tituloPrincipalUsado) {
          elementos.push(new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: linea, bold: true, size: 32, color: COLOR_TITULO })],
            spacing: { before: 120, after: 280 },
            border: { bottom: { color: COLOR_BORDE, space: 6, style: BorderStyle.SINGLE, size: 8 } }
          }))
          tituloPrincipalUsado = true
        } else {
          elementos.push(new Paragraph({
            children: [new TextRun({ text: linea, bold: true, size: 24, color: COLOR_TITULO })],
            spacing: { before: 320, after: 160 }
          }))
        }
      } else if (esBullet(linea)) {
        if (equipoActual) equipoActual.total += 1
        elementos.push(new Paragraph({
          children: [new TextRun({ text: linea.trim().replace(/^-\s+/, ''), size: 22, color: COLOR_TEXTO })],
          bullet: { level: 0 },
          spacing: { after: 80 }
        }))
      } else {
        elementos.push(new Paragraph({
          alignment: AlignmentType.JUSTIFIED,
          children: [new TextRun({ text: linea, size: 22, color: COLOR_TEXTO })],
          spacing: { after: 120 }
        }))
      }
    }
  }

  // RESUMEN FINAL — solo cuando de verdad hay equipos detectados; se
  // calcula de los datos reales contados arriba, nunca de un texto que
  // la IA haya escrito por su cuenta.
  if (integrantesPorEquipo.length > 0) {
    elementos.push(new Paragraph({
      children: [new TextRun({ text: 'RESUMEN', bold: true, size: 24, color: COLOR_TITULO })],
      spacing: { before: 400, after: 160 },
      border: { top: { color: COLOR_BORDE, space: 8, style: BorderStyle.SINGLE, size: 6 } }
    }))
    elementos.push(new Paragraph({
      children: [new TextRun({ text: `Total de equipos: ${integrantesPorEquipo.length}`, size: 22, color: COLOR_TEXTO })],
      spacing: { after: 80 }
    }))
    for (const eq of integrantesPorEquipo) {
      elementos.push(new Paragraph({
        children: [new TextRun({ text: `Equipo ${eq.numero}: ${eq.total} integrante(s)`, size: 22, color: COLOR_TEXTO })],
        spacing: { after: 60 }
      }))
    }
  }

  const piePagina = [
    new Paragraph({ children: [new TextRun('')], spacing: { before: 480 } }),
    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: '______________________________', size: 20, color: COLOR_TEXTO_SUAVE })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: enc.docente, bold: true, size: 20, color: COLOR_TEXTO })], spacing: { before: 80 } }),
    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'Docente de grupo', size: 18, color: COLOR_TEXTO_SUAVE })] }),
  ]

  return new Document({
    sections: [{
      headers: { default: encabezado },
      properties: { page: { margin: { top: 1400, right: 900, bottom: 900, left: 900 } } },
      children: [...elementos, ...piePagina]
    }]
  })
}

// Nombre de archivo consistente entre cliente y servidor.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function nombreArchivoWord(perfil?: any): string {
  return `Planeacion_${perfil?.nombre?.split(' ')[0] || 'Docente'}_${perfil?.grado || ''}${perfil?.grupo || ''}_${Date.now()}.docx`
}
