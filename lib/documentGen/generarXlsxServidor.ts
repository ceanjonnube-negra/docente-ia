// lib/documentGen/generarXlsxServidor.ts
//
// Genera un Excel real (.xlsx) en el servidor con exceljs. Dos modos,
// detectados automáticamente por el contenido:
// - Datos tabulares reales (listas de alumnos, calificaciones, horarios
//   — ver EXCEPCION A LA REGLA 3 en app/api/chat/route.ts, formato
//   "campo1|campo2|campo3"): se vuelcan como filas/columnas reales.
// - Documentos de prosa (planeación, resumen, cuento...) sin formato
//   tabular: una fila por línea, con títulos y secciones resaltados,
//   igual que el PDF, para que el maestro tenga una copia editable.

import ExcelJS from 'exceljs'
import { analizarContenido, extraerFilasTabulares, extraerTitulo } from './parseContenido'
import { formatearFecha } from '../tiempo/TimeService'

const VERDE_ENCABEZADO = 'FF166534'
const VERDE_CLARO = 'FFDCFCE7'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function generarXlsxBuffer(texto: string, perfil: any, zonaHoraria: string | null): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const titulo = extraerTitulo(texto)
  const hoja = workbook.addWorksheet(nombreHoja(titulo))

  const filasTabulares = extraerFilasTabulares(texto)

  hoja.addRow([titulo]).font = { bold: true, size: 14, color: { argb: VERDE_ENCABEZADO } }
  hoja.addRow([
    `${perfil?.escuela || ''}   Docente: ${perfil?.nombre || ''}   Grado ${perfil?.grado || ''}° Grupo ${perfil?.grupo || ''}   ${formatearFecha(new Date(), zonaHoraria, { day: 'numeric', month: 'long', year: 'numeric' })}`,
  ]).font = { italic: true, size: 10, color: { argb: 'FF6B7280' } }
  hoja.addRow([])

  if (filasTabulares) {
    for (const fila of filasTabulares) {
      hoja.addRow(fila)
    }
    hoja.columns.forEach((columna) => {
      columna.width = 22
    })
  } else {
    const lineas = analizarContenido(texto)
    for (const l of lineas) {
      const fila = hoja.addRow([l.tipo === 'bullet' ? `• ${l.texto}` : l.texto])
      if (l.tipo === 'titulo') {
        fila.font = { bold: true, size: 13, color: { argb: VERDE_ENCABEZADO } }
      } else if (l.tipo === 'seccion') {
        fila.font = { bold: true, size: 12, color: { argb: VERDE_ENCABEZADO } }
        fila.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: VERDE_CLARO } }
      }
    }
    hoja.getColumn(1).width = 90
    hoja.getColumn(1).alignment = { wrapText: true, vertical: 'top' }
  }

  const arrayBuffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(arrayBuffer)
}

function nombreHoja(titulo: string): string {
  // Excel prohíbe : \ / ? * [ ] en nombres de hoja y limita a 31 caracteres.
  const limpio = titulo.replace(/[:\\/?*[\]]/g, '').slice(0, 31).trim()
  return limpio || 'Documento'
}

export function nombreArchivoXlsx(titulo: string): string {
  const slug = titulo
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'Documento'
  return `${slug}.xlsx`
}
