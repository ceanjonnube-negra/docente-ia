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
  LineRuleType,
  TableLayoutType,
  Header,
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
// Carta (8.5 × 11in) en twips, en su orientación PORTRAIT — ver el
// comentario en construirSeccionHojaEvaluacionWord sobre cómo
// PageOrientation.LANDSCAPE los intercambia al serializar.
const ANCHO_CARTA_PORTRAIT_TWIPS = 12240
const ALTO_CARTA_PORTRAIT_TWIPS = 15840

const COLOR_TITULO = '1F2937'
const COLOR_TEXTO = '374151'
const COLOR_TEXTO_SUAVE = '6B7280'
const BORDE_CELDA = { style: BorderStyle.SINGLE, size: 4, color: '9CA3AF' }
const BORDES_TODOS = { top: BORDE_CELDA, bottom: BORDE_CELDA, left: BORDE_CELDA, right: BORDE_CELDA }

// AJUSTE DE MAQUETACIÓN — "la hoja de 27 alumnos se derramaba a una
// segunda página en Word": causa raíz demostrada por auditoría real
// (word/styles.xml del .docx generado tiene <w:docDefaults> vacío y
// ninguna definición de estilo "Normal" — la app que abre el archivo
// le aplica SU PROPIO espaciado "Normal" incorporado, típicamente
// ~10pt después de cada párrafo, a cada uno de los ~28 párrafos de la
// tabla — un desperdicio que se multiplica por fila). Nunca se debe
// depender de ese default: todo párrafo de esta sección fija su
// espaciado explícitamente.
//
// interlineadoExacto: line/lineRule NUNCA arbitrarios — se derivan
// directamente del tamaño de fuente real de ese párrafo (en
// medios-puntos, el mismo valor que ya recibe TextRun.size), con un
// factor de 1.2 (interlineado estándar mínimo para legibilidad de
// impresión, el mismo criterio tipográfico que ya usa
// generarHojaSeguimientoPdf.ts al espaciar líneas de texto en el PDF
// — ver ahí *1.3/*1.4 sobre el tamaño de fuente). lineRule 'exact'
// (no 'auto'): fija la altura de línea al valor calculado sin permitir
// que el visor la agrande por su cuenta — es lo que garantiza que el
// ahorro de espacio sea real y predecible en cualquier aplicación.
function interlineadoExacto(tamanoMedioPunto: number): { line: number; lineRule: (typeof LineRuleType)[keyof typeof LineRuleType] } {
  const tamanoPunto = tamanoMedioPunto / 2
  return { line: Math.round(tamanoPunto * 1.2 * 20), lineRule: LineRuleType.EXACT }
}

// Tamaño de fuente real de cada celda de la tabla (medios-puntos) —
// una sola constante para que TextRun.size y el interlineado
// calculado nunca puedan desalinearse entre sí.
const TAMANO_CELDA_TABLA = 18

// Márgenes de celda explícitos (twips) — mismo motivo que el spacing
// del párrafo: sin esto, cada celda usa el margen por defecto del
// visor (indeterminado), otra variable multiplicada por 28 filas.
// Valores pequeños pero no extremos (1pt arriba/abajo, 4pt a los
// lados) — suficientes para separar visualmente el texto del borde de
// celda sin agregar alto innecesario; nunca se tocó para "que quepa",
// se fijaron ANTES de medir si hacía falta reducir la fuente (nunca
// hizo falta).
const MARGEN_CELDA_TABLA = { top: 20, bottom: 20, left: 80, right: 80 }

// AJUSTE — "la hoja de 27 alumnos se derramaba pese al presupuesto
// vertical porque los nombres se envolvían en 2 líneas": causa raíz
// real, demostrada por inspección OOXML — sin table layout FIXED ni
// columnWidths explícitos, docx emite un <w:tblGrid> de RELLENO (100
// twips por columna, sin relación con el ancho real), y Word queda
// libre de recalcular anchos por AutoFit según el contenido, sin
// respetar el 32% declarado por celda. La corrección: UNA sola fuente
// canónica de anchos absolutos en twips, nunca porcentajes como
// segunda fuente contradictoria — tanto Table.columnWidths como cada
// TableCell.width (WidthType.DXA, no PERCENTAGE) leen de este mismo
// array, así que <w:tblGrid> y cada <w:tcW> son consistentes entre sí
// por construcción.
//
// Ancho usable real de la sección landscape: 15840 (ancho de página
// ya en landscape) − 700 (margen izquierdo) − 700 (margen derecho) =
// 14440 twips — el mismo par de márgenes ya declarado más abajo en
// properties.page.margin, nunca un segundo valor que pudiera
// desalinearse.
const ANCHO_USABLE_TABLA_TWIPS = 14440

// Construye los anchos absolutos (twips) de las 3+N columnas reales
// (#, Alumno, I1..IN, Nivel final), derivados TODOS de
// ANCHO_USABLE_TABLA_TWIPS con las mismas proporciones ya usadas
// (5% / 32% / resto entre indicadores / 10%). Suma SIEMPRE exacta:
// el remanente de redondeo (si N no divide limpio el espacio de
// indicadores) se absorbe de forma determinista en la ÚLTIMA columna
// ("Nivel final"), nunca repartido al azar ni ignorado.
function construirAnchosColumnasTwips(cantidadIndicadores: number): number[] {
  const anchoNum = Math.round(ANCHO_USABLE_TABLA_TWIPS * 0.05)
  const anchoAlumno = Math.round(ANCHO_USABLE_TABLA_TWIPS * 0.32)
  const anchoFinalBase = Math.round(ANCHO_USABLE_TABLA_TWIPS * 0.1)
  const anchoIndicadoresTotal = ANCHO_USABLE_TABLA_TWIPS - anchoNum - anchoAlumno - anchoFinalBase
  const anchoPorIndicador = cantidadIndicadores > 0 ? Math.floor(anchoIndicadoresTotal / cantidadIndicadores) : 0
  const anchosIndicadores = Array<number>(cantidadIndicadores).fill(anchoPorIndicador)

  const sumaParcial = anchoNum + anchoAlumno + anchosIndicadores.reduce((a, b) => a + b, 0) + anchoFinalBase
  const remanente = ANCHO_USABLE_TABLA_TWIPS - sumaParcial
  const anchoFinal = anchoFinalBase + remanente // absorbe SIEMPRE el remanente, incluso 0

  return [anchoNum, anchoAlumno, ...anchosIndicadores, anchoFinal]
}

function celda(texto: string, opciones: { anchoTwips?: number; bold?: boolean; encabezado?: boolean } = {}): TableCell {
  return new TableCell({
    width: opciones.anchoTwips !== undefined ? { size: opciones.anchoTwips, type: WidthType.DXA } : undefined,
    borders: BORDES_TODOS,
    margins: MARGEN_CELDA_TABLA,
    shading: opciones.encabezado ? { type: ShadingType.CLEAR, color: 'auto', fill: 'F3F4F6' } : undefined,
    children: [
      new Paragraph({
        // before/after=0 explícitos (nunca heredados del visor) — el
        // único espaciado visual entre filas es el propio borde de
        // celda (BORDES_TODOS), igual que en la hoja PDF, que tampoco
        // deja hueco extra entre filas.
        spacing: { before: 0, after: 0, ...interlineadoExacto(TAMANO_CELDA_TABLA) },
        children: [new TextRun({ text: texto, bold: opciones.bold ?? opciones.encabezado, size: TAMANO_CELDA_TABLA, color: opciones.encabezado ? COLOR_TITULO : COLOR_TEXTO })],
      }),
    ],
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

  // Espaciado del encabezado de la hoja — mismo principio que celda():
  // before=0 e interlineado derivado del tamaño real de fuente de CADA
  // párrafo (nunca un valor heredado del visor). Los `after` que ya
  // existían se CONSERVAN sin cambio: son la separación visual
  // deliberada entre bloques (institucional → proyecto/SG → metadatos
  // → leyenda → lista de indicadores) — "no eliminar separación visual
  // necesaria entre bloques". Solo se agrega un `after` explícito
  // donde antes dependía del default del visor (línea del proyecto/SG,
  // que antes no tenía ningún spacing propio).
  const encabezado: (Paragraph | Table)[] = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 0, ...interlineadoExacto(22) },
      children: [new TextRun({ text: enc.escuela, bold: true, size: 22, color: COLOR_TITULO })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 160, ...interlineadoExacto(16) },
      children: [new TextRun({ text: `Docente: ${enc.docente}    Grado: ${enc.grado}    Grupo: ${enc.grupo}    Ciclo: ${enc.cicloEscolar}`, size: 16, color: COLOR_TEXTO_SUAVE })],
    }),
    new Paragraph({
      spacing: { before: 0, after: 100, ...interlineadoExacto(24) },
      children: [
        new TextRun({ text: datos.nombreProyecto, bold: true, size: 24, color: COLOR_TITULO }),
        new TextRun({ text: `    ${datos.identificadorVisible}`, bold: true, size: 22, color: COLOR_TITULO }),
      ],
    }),
    new Paragraph({
      spacing: { before: 0, after: 100, ...interlineadoExacto(16) },
      children: [new TextRun({ text: metaPartes.join('    ·    '), size: 16, color: COLOR_TEXTO })],
    }),
    new Paragraph({
      spacing: { before: 0, after: 100, ...interlineadoExacto(16) },
      children: [new TextRun({ text: NIVELES_EVALUACION.map((n) => `${n.valor} ${n.etiqueta}`).join(' · ') + ' · Vacío No evaluado', size: 16, color: COLOR_TEXTO_SUAVE })],
    }),
    ...datos.indicadores.map(
      (ind, i) =>
        new Paragraph({
          spacing: { before: 0, after: 40, ...interlineadoExacto(16) },
          children: [new TextRun({ text: `${i + 1}. ${ind.indicador_especifico}`, size: 16, color: COLOR_TEXTO })],
        })
    ),
  ]

  // Fuente ÚNICA de anchos (twips) — # / Alumno / I1..IN / Nivel final.
  // La MISMA lista alimenta Table.columnWidths (define <w:tblGrid>) y
  // cada TableCell.width (define <w:tcW>) — nunca dos fuentes (% y
  // twips) que pudieran desalinearse entre sí.
  const anchosColumnas = construirAnchosColumnasTwips(cantidadIndicadores)
  const [anchoNum, anchoAlumno, ...anchosIndicadoresYFinal] = anchosColumnas
  const anchosIndicadores = anchosIndicadoresYFinal.slice(0, cantidadIndicadores)
  const anchoFinal = anchosIndicadoresYFinal[cantidadIndicadores]

  const filaEncabezado = new TableRow({
    tableHeader: true,
    children: [
      celda('#', { anchoTwips: anchoNum, encabezado: true }),
      celda('Alumno', { anchoTwips: anchoAlumno, encabezado: true }),
      ...datos.indicadores.map((_, i) => celda(`I${i + 1}`, { anchoTwips: anchosIndicadores[i], encabezado: true })),
      celda('Nivel final', { anchoTwips: anchoFinal, encabezado: true }),
    ],
  })

  // Una fila por alumno del roster CONGELADO (nunca alumnos actuales)
  // — celdas de evaluación vacías, listas para llenado físico a mano,
  // exactamente igual que la hoja PDF.
  const filasAlumnos = datos.alumnos.map(
    (alumno) =>
      new TableRow({
        children: [
          celda(String(alumno.posicion), { anchoTwips: anchoNum }),
          celda(alumno.nombre, { anchoTwips: anchoAlumno }),
          ...Array.from({ length: cantidadIndicadores }, (_, i) => celda('', { anchoTwips: anchosIndicadores[i] })),
          celda('', { anchoTwips: anchoFinal }),
        ],
      })
  )

  // layout: FIXED — obliga a Word a respetar columnWidths/tcW tal
  // cual, sin AutoFit ni redistribución por contenido (la causa real
  // del wrap de nombres ya demostrada). width en DXA (no PERCENTAGE)
  // porque ya viaja en twips absolutos desde la misma fuente única.
  const tabla = new Table({
    rows: [filaEncabezado, ...filasAlumnos],
    width: { size: ANCHO_USABLE_TABLA_TWIPS, type: WidthType.DXA },
    columnWidths: anchosColumnas,
    layout: TableLayoutType.FIXED,
  })

  return {
    properties: {
      page: {
        // Carta explícita (8.5 × 11in), no el default de la librería
        // (A4) — la misma corrección real de tamaño de página que
        // hojas_evaluacion/generarHojaSeguimientoPdf.ts ya usa
        // (ANCHO_PAGINA=792pt=11in, ALTO_PAGINA=612pt=8.5in). width/
        // height se pasan en su orientación PORTRAIT (12240×15840
        // twips = 8.5×11in); PageOrientation.LANDSCAPE hace que la
        // librería los intercambie al serializar, dando un pgSz final
        // de w:w=15840 w:h=12240 (11×8.5in) — Carta apaisada real.
        size: { width: ANCHO_CARTA_PORTRAIT_TWIPS, height: ALTO_CARTA_PORTRAIT_TWIPS, orientation: PageOrientation.LANDSCAPE },
        margin: { top: 700, right: 700, bottom: 700, left: 700 },
      },
    },
    // Header PROPIO vacío — nunca hereda el header institucional de la
    // sección de planeación (construirDocumentoWord.ts), que hoy
    // duplicaba la misma información ya presente en `encabezado` (más
    // arriba, dentro del cuerpo) y consumía espacio vertical real en
    // cada página landscape sin haber sido contemplado en ningún
    // presupuesto. La API de docx exige al menos un Paragraph para un
    // Header válido — se usa uno vacío, nunca contenido copiado del
    // header de la planeación.
    headers: { default: new Header({ children: [new Paragraph({ children: [] })] }) },
    children: [...encabezado, tabla],
  }
}
