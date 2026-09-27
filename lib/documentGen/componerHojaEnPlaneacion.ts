// lib/documentGen/componerHojaEnPlaneacion.ts
//
// COMPOSICIÓN CANÓNICA — "Planeación + hoja de evaluación al final del
// mismo archivo". Anexa la MISMA hoja de evaluación ya congelada en
// hojas_evaluacion al final del documento descargable de la
// planeación (PDF: copia de páginas reales; Word: sección nativa
// nueva) — nunca genera una hoja nueva, nunca reconstruye roster
// desde alumnos actuales, nunca reconstruye indicadores desde la
// planeación vigente. La hoja independiente (Storage, captura,
// análisis, confirmación) sigue exactamente igual — este archivo
// nunca escribe en hojas_evaluacion ni en seguimiento_resultados,
// solo lee.
//
// Reutiliza DatosHojaSeguimiento (generarHojaSeguimientoPdf.ts) como
// único modelo de entrada — el mismo que ya consume el renderer PDF
// —, hidratado aquí una sola vez desde las columnas canónicas.

import type { SupabaseClient } from '@supabase/supabase-js'
import { PDFDocument } from 'pdf-lib'
import {
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  ShadingType,
  AlignmentType,
  PageOrientation,
  type ISectionOptions,
} from 'docx'
import { prepararEncabezado } from './encabezadoDocumento'
import { descargarBuffer, BUCKET_HOJAS_SEGUIMIENTO } from './almacenamiento'
import { NIVELES_EVALUACION, type IndicadorProyecto, type AlumnoRosterCongelado, type IndicadorCongelado } from '../seguimiento/tipos'
import type { DatosHojaSeguimiento } from './generarHojaSeguimientoPdf'

export class ErrorComposicionHoja extends Error {}

// ============================================================
// Hidratación — DatosHojaSeguimiento EXCLUSIVAMENTE desde la hoja
// canónica ya congelada y los metadatos ya persistidos del proyecto.
// Nunca consulta alumnos actuales (roster) ni la planeación vigente
// (indicadores) — ambos ya viven congelados en hojas_evaluacion.
// ============================================================
export type HojaCanonicaParaComposicion = {
  identificador_visible: string
  roster_congelado: AlumnoRosterCongelado[] | null
  indicadores: IndicadorCongelado[] | null
  storage_path: string | null
}

export type ProyectoParaComposicion = {
  nombre: string
  campos_formativos: string[]
  fecha_inicio: string | null
  fecha_fin: string | null
  periodo_evaluacion_id: string | null
}

export async function hidratarDatosHojaSeguimiento(
  sb: SupabaseClient,
  hoja: HojaCanonicaParaComposicion,
  proyecto: ProyectoParaComposicion
): Promise<DatosHojaSeguimiento> {
  // Si no hay periodo_evaluacion_id real, trimestreNombre permanece
  // null — NUNCA se inventa un trimestre (mismo criterio ya usado en
  // aprobarBorrador.ts/generarYGuardarHoja.ts para proyectos sin
  // periodo configurado).
  let trimestreNombre: string | null = null
  if (proyecto.periodo_evaluacion_id) {
    const { data } = await sb
      .from('periodos_evaluacion')
      .select('nombre')
      .eq('id', proyecto.periodo_evaluacion_id)
      .maybeSingle()
    trimestreNombre = data?.nombre ?? null
  }

  // numero_indicador ya define el orden real congelado — se ordena de
  // forma defensiva (el jsonb debería venir ya ordenado) y se
  // proyecta a IndicadorProyecto (sin numero_indicador), la forma
  // exacta que espera DatosHojaSeguimiento.
  const indicadores: IndicadorProyecto[] = (hoja.indicadores ?? [])
    .slice()
    .sort((a, b) => a.numero_indicador - b.numero_indicador)
    .map((i) => ({ indicador_especifico: i.indicador_especifico, aspecto_general: i.aspecto_general }))

  const alumnos = (hoja.roster_congelado ?? [])
    .slice()
    .sort((a, b) => a.posicion - b.posicion)
    .map((a) => ({ nombre: a.nombre, posicion: a.posicion }))

  return {
    nombreProyecto: proyecto.nombre,
    camposFormativos: proyecto.campos_formativos,
    trimestreNombre,
    fechaInicio: proyecto.fecha_inicio,
    fechaFin: proyecto.fecha_fin,
    identificadorVisible: hoja.identificador_visible,
    indicadores,
    alumnos,
  }
}

// ============================================================
// PDF — copia de páginas reales, nunca regeneración.
// ============================================================

// Recupera el PDF YA existente de la hoja canónica exclusivamente por
// storage_path (nunca por URL firmada, nunca regenerando) — fail
// closed: sin storage_path o sin archivo real en Storage, lanza en
// vez de intentar cualquier sustituto.
export async function descargarPdfHojaCanonica(sb: SupabaseClient, hoja: { storage_path: string | null }): Promise<Buffer> {
  if (!hoja.storage_path) {
    throw new ErrorComposicionHoja('La hoja canónica todavía no tiene un archivo PDF en Storage (storage_path ausente).')
  }
  return descargarBuffer(sb, hoja.storage_path, BUCKET_HOJAS_SEGUIMIENTO)
}

// pdf-lib@1.17.1 — copia TODAS las páginas de la hoja (1, 2 o N, ver
// calcularCantidadPaginasHoja en generarHojaSeguimientoPdf.ts), nunca
// asume una sola. Preserva el contenido real de cada página (no es un
// re-render): mismo archivo, mismos trazos, mismo SG-XXXX impreso.
export async function componerPdfPlaneacionConHoja(bufferPlaneacion: Buffer, bufferHoja: Buffer): Promise<Buffer> {
  const pdfPlaneacion = await PDFDocument.load(bufferPlaneacion)
  const pdfHoja = await PDFDocument.load(bufferHoja)

  const paginasCopiadas = await pdfPlaneacion.copyPages(pdfHoja, pdfHoja.getPageIndices())
  for (const pagina of paginasCopiadas) {
    pdfPlaneacion.addPage(pagina)
  }

  const bytes = await pdfPlaneacion.save()
  return Buffer.from(bytes)
}

// ============================================================
// Word — sección landscape NATIVA (tabla real, nunca una imagen
// rasterizada), consumiendo EXCLUSIVAMENTE DatosHojaSeguimiento —
// mismo modelo que ya usa el renderer PDF, sin una segunda fuente de
// datos.
// ============================================================
const COLOR_TITULO = '1F2937'
const COLOR_TEXTO = '374151'
const COLOR_TEXTO_SUAVE = '6B7280'
const BORDE_CELDA = { style: BorderStyle.SINGLE, size: 4, color: '9CA3AF' }
const BORDES_TODOS = { top: BORDE_CELDA, bottom: BORDE_CELDA, left: BORDE_CELDA, right: BORDE_CELDA }

function celda(texto: string, opciones: { anchoPct?: number; bold?: boolean; encabezado?: boolean } = {}): TableCell {
  return new TableCell({
    width: opciones.anchoPct !== undefined ? { size: opciones.anchoPct, type: WidthType.PERCENTAGE } : undefined,
    borders: BORDES_TODOS,
    shading: opciones.encabezado ? { type: ShadingType.CLEAR, color: 'auto', fill: 'F3F4F6' } : undefined,
    children: [new Paragraph({ children: [new TextRun({ text: texto, bold: opciones.bold ?? opciones.encabezado, size: 18, color: opciones.encabezado ? COLOR_TITULO : COLOR_TEXTO })] })],
  })
}

// Construye la sección Word completa de la hoja de evaluación — misma
// información pedagógica real que generarHojaSeguimientoPdfBuffer,
// nunca copiada dos veces desde una fuente distinta: ambos renderers
// reciben el MISMO DatosHojaSeguimiento ya hidratado desde el
// snapshot canónico.
export function construirSeccionHojaEvaluacionWord(
  datos: DatosHojaSeguimiento,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  perfil: any,
  zonaHoraria: string | null
): ISectionOptions {
  const enc = prepararEncabezado(perfil, zonaHoraria)
  const cantidadIndicadores = datos.indicadores.length

  const metaPartes = [
    datos.camposFormativos.join(' / '),
    datos.trimestreNombre ? `Trimestre: ${datos.trimestreNombre}` : null,
    datos.fechaInicio && datos.fechaFin ? `${datos.fechaInicio} — ${datos.fechaFin}` : null,
  ].filter(Boolean)

  const encabezado: (Paragraph | Table)[] = [
    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: enc.escuela, bold: true, size: 22, color: COLOR_TITULO })] }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: `Docente: ${enc.docente}    Grado: ${enc.grado}    Grupo: ${enc.grupo}    Ciclo: ${enc.cicloEscolar}`, size: 16, color: COLOR_TEXTO_SUAVE })],
      spacing: { after: 160 },
    }),
    new Paragraph({
      children: [
        new TextRun({ text: datos.nombreProyecto, bold: true, size: 24, color: COLOR_TITULO }),
        new TextRun({ text: `    ${datos.identificadorVisible}`, bold: true, size: 22, color: COLOR_TITULO }),
      ],
    }),
    new Paragraph({
      children: [new TextRun({ text: metaPartes.join('    ·    '), size: 16, color: COLOR_TEXTO })],
      spacing: { after: 100 },
    }),
    new Paragraph({
      children: [new TextRun({ text: NIVELES_EVALUACION.map((n) => `${n.valor} ${n.etiqueta}`).join(' · ') + ' · Vacío No evaluado', size: 16, color: COLOR_TEXTO_SUAVE })],
      spacing: { after: 100 },
    }),
    ...datos.indicadores.map(
      (ind, i) =>
        new Paragraph({
          children: [new TextRun({ text: `${i + 1}. ${ind.indicador_especifico}`, size: 16, color: COLOR_TEXTO })],
          spacing: { after: 40 },
        })
    ),
  ]

  // Anchos: # angosto, Alumno el más ancho, indicadores comparten el
  // resto en partes iguales (usa la cantidad REAL, nunca asume 5), y
  // Nivel final ligeramente más ancho que un indicador — mismo
  // criterio proporcional que la hoja PDF.
  const anchoNum = 5
  const anchoAlumno = 32
  const anchoFinal = 10
  const anchoIndicadores = Math.max(0, 100 - anchoNum - anchoAlumno - anchoFinal)
  const anchoPorIndicador = cantidadIndicadores > 0 ? anchoIndicadores / cantidadIndicadores : 0

  const filaEncabezado = new TableRow({
    tableHeader: true,
    children: [
      celda('#', { anchoPct: anchoNum, encabezado: true }),
      celda('Alumno', { anchoPct: anchoAlumno, encabezado: true }),
      ...datos.indicadores.map((_, i) => celda(`I${i + 1}`, { anchoPct: anchoPorIndicador, encabezado: true })),
      celda('Nivel final', { anchoPct: anchoFinal, encabezado: true }),
    ],
  })

  // Una fila por alumno del roster CONGELADO (nunca alumnos actuales)
  // — celdas de evaluación vacías, listas para llenado físico a mano,
  // exactamente igual que la hoja PDF.
  const filasAlumnos = datos.alumnos.map(
    (alumno) =>
      new TableRow({
        children: [
          celda(String(alumno.posicion), { anchoPct: anchoNum }),
          celda(alumno.nombre, { anchoPct: anchoAlumno }),
          ...Array.from({ length: cantidadIndicadores }, () => celda('', { anchoPct: anchoPorIndicador })),
          celda('', { anchoPct: anchoFinal }),
        ],
      })
  )

  const tabla = new Table({ rows: [filaEncabezado, ...filasAlumnos], width: { size: 100, type: WidthType.PERCENTAGE } })

  return {
    properties: {
      page: {
        size: { orientation: PageOrientation.LANDSCAPE },
        margin: { top: 700, right: 700, bottom: 700, left: 700 },
      },
    },
    children: [...encabezado, tabla],
  }
}
