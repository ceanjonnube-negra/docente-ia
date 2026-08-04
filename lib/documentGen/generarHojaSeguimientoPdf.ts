// lib/documentGen/generarHojaSeguimientoPdf.ts
//
// Dibuja la hoja de seguimiento imprimible: una tabla real (alumno ×
// indicador) con una casilla por celda para marcar el nivel — a
// diferencia de generarPdfServidor.ts, que dibuja texto en prosa
// (títulos/párrafos/viñetas) para las planeaciones/rúbricas del Chat
// IA, esto es un formulario tabular pensado para imprimirse, marcarse a
// mano y volver a fotografiarse (spec del módulo Seguimiento, sección
// "Una única hoja de evaluación por proyecto"). Reutiliza de
// generarPdfServidor.ts solo lo que sí aplica: pdf-lib como librería,
// prepararEncabezado() para el encabezado institucional, y la misma
// paleta discreta (gris/oscuro, sin fondos de color).
//
// Orientación horizontal (carta apaisada) — da más ancho por columna
// para que las casillas sean legibles a simple vista y en foto, que es
// justo lo que pide el spec ("espacios suficientes para marcar",
// "diseño compatible con reconocimiento mediante cámara").
//
// MODELO COMPACTO ("AJUSTE DEFINITIVO C-005 — modelo compacto de hoja
// de evaluación con 5 indicadores y escala 1-4"): reemplaza el diseño
// anterior de 4 sub-casillas por indicador. Ahora cada hoja evalúa
// EXACTAMENTE 5 indicadores esenciales (ver CANTIDAD_INDICADORES_HOJA
// en lib/seguimiento/tipos.ts) y cada uno ocupa UNA sola columna: el
// docente escribe a mano un único dígito (4, 3, 2 o 1) dentro de una
// celda cuadrada vacía — nunca marca una de varias casillas por
// posición. Una celda vacía sigue significando "no evaluado" (igual
// que antes), solo que ahora la ausencia es la de un dígito escrito,
// no la de una marca de posición. La tabla agrega además una columna
// "Nivel final" (más ancha, también un solo dígito 1-4 o vacía) que el
// docente puede llenar o dejar en blanco para que la app sugiera un
// nivel más adelante — nunca se le llama "Calificación" en esta hoja
// ni se muestra aquí la conversión a escala 5-10 (ver
// lib/seguimiento/conversionCalificacion.ts).

import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib'
import { prepararEncabezado } from './encabezadoDocumento'
import { NIVELES_EVALUACION, CANTIDAD_INDICADORES_HOJA, type IndicadorProyecto } from '../seguimiento/tipos'

const ANCHO_PAGINA = 792 // carta apaisada (11in), en puntos
const ALTO_PAGINA = 612 // carta apaisada (8.5in)
const MARGEN = 26
const ANCHO_CONTENIDO = ANCHO_PAGINA - MARGEN * 2

const COLOR_TITULO = rgb(0.122, 0.161, 0.216) // #1F2937
const COLOR_TEXTO = rgb(0.216, 0.255, 0.318) // #374151
const COLOR_TEXTO_SUAVE = rgb(0.42, 0.447, 0.502) // #6B7280
const COLOR_BORDE = rgb(0.62, 0.64, 0.67) // más marcado que generarPdfServidor — necesita verse bien en foto

function sanearParaWinAnsi(texto: string): string {
  return texto
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7E -ÿ]/g, '')
}

function truncarConEllipsis(texto: string, font: PDFFont, tamano: number, anchoMax: number): string {
  const limpio = sanearParaWinAnsi(texto)
  if (font.widthOfTextAtSize(limpio, tamano) <= anchoMax) return limpio
  let resultado = limpio
  while (resultado.length > 1 && font.widthOfTextAtSize(resultado + '…', tamano) > anchoMax) {
    resultado = resultado.slice(0, -1)
  }
  return resultado + '…'
}

export type AlumnoHoja = { nombre: string; posicion: number }

export type DatosHojaSeguimiento = {
  nombreProyecto: string
  camposFormativos: string[]
  trimestreNombre: string | null
  fechaInicio: string | null
  fechaFin: string | null
  identificadorVisible: string
  indicadores: IndicadorProyecto[]
  alumnos: AlumnoHoja[]
}

export async function generarHojaSeguimientoPdfBuffer(
  datos: DatosHojaSeguimiento,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  perfil: any,
  zonaHoraria: string | null
): Promise<Buffer> {
  const enc = prepararEncabezado(perfil, zonaHoraria)
  const pdfDoc = await PDFDocument.create()
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const negrita = await pdfDoc.embedFont(StandardFonts.HelveticaBold)

  // Nunca más de CANTIDAD_INDICADORES_HOJA (5) columnas de indicador —
  // la consolidación a exactamente 5 ya ocurre antes de llegar aquí
  // (ver construirIndicadoresSeguimiento en lib/planeacion/aprobarBorrador.ts);
  // este límite es solo una defensa estructural, nunca rellena con
  // indicadores inventados si llegaran menos de 5.
  const indicadoresUsados = datos.indicadores.slice(0, CANTIDAD_INDICADORES_HOJA)

  const ANCHO_NUM = 20
  const ANCHO_IND = 22 // celda cuadrada (ver ALTO_FILA) para un solo dígito 1-4 escrito a mano
  const ANCHO_FINAL = 38 // "Nivel final" — ligeramente más ancha que una celda de indicador
  const ANCHO_NOMBRE = 240
  const ALTO_FILA = 15
  const ALTO_ENCABEZADO_TABLA = 18 // una sola fila: # | Alumno | I1..I5 | Nivel final — nunca repite la escala aquí

  const anchoTabla = ANCHO_NUM + ANCHO_NOMBRE + indicadoresUsados.length * ANCHO_IND + ANCHO_FINAL
  const X_TABLA = MARGEN + Math.max(0, (ANCHO_CONTENIDO - anchoTabla) / 2)

  let pagina: PDFPage = pdfDoc.addPage([ANCHO_PAGINA, ALTO_PAGINA])
  let y = ALTO_PAGINA - MARGEN

  function nuevaPagina() {
    pagina = pdfDoc.addPage([ANCHO_PAGINA, ALTO_PAGINA])
    y = ALTO_PAGINA - MARGEN
  }

  function asegurarEspacio(alturaNecesaria: number) {
    if (y - alturaNecesaria < MARGEN) nuevaPagina()
  }

  function dibujarEncabezadoInstitucional() {
    const lineas = [
      { texto: enc.escuela, font: negrita, tamano: 10, color: COLOR_TITULO },
      { texto: `Docente: ${enc.docente}    Grado: ${enc.grado}    Grupo: ${enc.grupo}    Ciclo: ${enc.cicloEscolar}`, font: regular, tamano: 8, color: COLOR_TEXTO_SUAVE },
    ]
    for (const l of lineas) {
      const limpio = sanearParaWinAnsi(l.texto)
      pagina.drawText(limpio, { x: MARGEN, y: y - l.tamano, size: l.tamano, font: l.font, color: l.color })
      y -= l.tamano * 1.4
    }
  }

  function dibujarIdentificador() {
    const texto = datos.identificadorVisible
    const tamano = 14
    const ancho = negrita.widthOfTextAtSize(texto, tamano)
    pagina.drawRectangle({
      x: ANCHO_PAGINA - MARGEN - ancho - 14,
      y: ALTO_PAGINA - MARGEN - 20,
      width: ancho + 14,
      height: 22,
      borderColor: COLOR_TITULO,
      borderWidth: 1,
    })
    pagina.drawText(texto, {
      x: ANCHO_PAGINA - MARGEN - ancho - 7,
      y: ALTO_PAGINA - MARGEN - 15,
      size: tamano,
      font: negrita,
      color: COLOR_TITULO,
    })
  }

  function dibujarMetadatosProyecto() {
    y -= 4
    pagina.drawText(sanearParaWinAnsi(datos.nombreProyecto), { x: MARGEN, y: y - 12, size: 12, font: negrita, color: COLOR_TITULO })
    y -= 15
    const metaPartes = [
      datos.camposFormativos.join(' / '),
      datos.trimestreNombre ? `Trimestre: ${datos.trimestreNombre}` : null,
      datos.fechaInicio && datos.fechaFin ? `${datos.fechaInicio} — ${datos.fechaFin}` : null,
    ].filter(Boolean)
    pagina.drawText(sanearParaWinAnsi(metaPartes.join('    ·    ')), { x: MARGEN, y: y - 9, size: 8.5, font: regular, color: COLOR_TEXTO })
    y -= 12
  }

  // Leyenda ÚNICA y compacta — nunca se repite dentro de la tabla
  // (justamente porque cada indicador ya es una sola columna, no hace
  // falta reexplicar la escala en cada celda). Incluye "Vacío No
  // evaluado" para dejar ese significado explícito sin necesidad de
  // otra leyenda aparte.
  function dibujarLeyenda() {
    const etiqueta = NIVELES_EVALUACION.map(n => `${n.valor} ${n.etiqueta}`).join(' · ') + ' · Vacío No evaluado'
    pagina.drawText(sanearParaWinAnsi(etiqueta), { x: MARGEN, y: y - 8, size: 8, font: regular, color: COLOR_TEXTO_SUAVE })
    y -= 12
  }

  // Lista numerada de los indicadores (1 a 5) en dos columnas, para no
  // consumir una línea completa por indicador — el texto completo vive
  // aquí, la tabla de abajo solo repite "I1".."I5" como referencia a
  // esta lista.
  function dibujarListaIndicadores() {
    pagina.drawText('Indicadores', { x: MARGEN, y: y - 9, size: 9, font: negrita, color: COLOR_TITULO })
    y -= 11
    const yListaInicio = y
    const anchoColumna = ANCHO_CONTENIDO / 2 - 8
    let filasIzquierda = 0
    let filasDerecha = 0
    indicadoresUsados.forEach((ind, i) => {
      const esIzquierda = i % 2 === 0
      const fila = esIzquierda ? filasIzquierda++ : filasDerecha++
      const x = esIzquierda ? MARGEN : MARGEN + ANCHO_CONTENIDO / 2 + 8
      const texto = `${i + 1}. ${ind.indicador_especifico}`
      pagina.drawText(truncarConEllipsis(texto, regular, 8, anchoColumna), {
        x,
        y: yListaInicio - fila * 10 - 8,
        size: 8,
        font: regular,
        color: COLOR_TEXTO,
      })
    })
    const filas = Math.max(filasIzquierda, filasDerecha, 1)
    y = yListaInicio - filas * 10 - 6
  }

  function dibujarEncabezadoTabla() {
    asegurarEspacio(ALTO_ENCABEZADO_TABLA + ALTO_FILA)
    const yInicio = y
    let x = X_TABLA
    pagina.drawRectangle({ x, y: yInicio - ALTO_ENCABEZADO_TABLA, width: ANCHO_NUM, height: ALTO_ENCABEZADO_TABLA, borderColor: COLOR_BORDE, borderWidth: 1 })
    pagina.drawText('#', { x: x + 6, y: yInicio - 13, size: 8.5, font: negrita, color: COLOR_TITULO })
    x += ANCHO_NUM
    pagina.drawRectangle({ x, y: yInicio - ALTO_ENCABEZADO_TABLA, width: ANCHO_NOMBRE, height: ALTO_ENCABEZADO_TABLA, borderColor: COLOR_BORDE, borderWidth: 1 })
    pagina.drawText('Alumno', { x: x + 5, y: yInicio - 13, size: 8.5, font: negrita, color: COLOR_TITULO })
    x += ANCHO_NOMBRE
    indicadoresUsados.forEach((_, i) => {
      pagina.drawRectangle({ x, y: yInicio - ALTO_ENCABEZADO_TABLA, width: ANCHO_IND, height: ALTO_ENCABEZADO_TABLA, borderColor: COLOR_BORDE, borderWidth: 1 })
      const etiqueta = `I${i + 1}`
      const anchoEtiqueta = negrita.widthOfTextAtSize(etiqueta, 8)
      pagina.drawText(etiqueta, { x: x + (ANCHO_IND - anchoEtiqueta) / 2, y: yInicio - 13, size: 8, font: negrita, color: COLOR_TITULO })
      x += ANCHO_IND
    })
    pagina.drawRectangle({ x, y: yInicio - ALTO_ENCABEZADO_TABLA, width: ANCHO_FINAL, height: ALTO_ENCABEZADO_TABLA, borderColor: COLOR_BORDE, borderWidth: 1 })
    const etiquetaFinal = 'Nivel final'
    const anchoFinal = regular.widthOfTextAtSize(etiquetaFinal, 6.5)
    pagina.drawText(etiquetaFinal, { x: x + Math.max(2, (ANCHO_FINAL - anchoFinal) / 2), y: yInicio - 13, size: 6.5, font: negrita, color: COLOR_TITULO })
    y -= ALTO_ENCABEZADO_TABLA
  }

  // Una fila por alumno: una celda cuadrada VACÍA por indicador (para
  // un solo dígito escrito a mano, nunca varias casillas de posición)
  // más una celda "Nivel final" al final, también vacía.
  function dibujarFilaAlumno(alumno: AlumnoHoja) {
    asegurarEspacio(ALTO_FILA)
    const yInicio = y
    let x = X_TABLA
    pagina.drawRectangle({ x, y: yInicio - ALTO_FILA, width: ANCHO_NUM, height: ALTO_FILA, borderColor: COLOR_BORDE, borderWidth: 0.75 })
    pagina.drawText(String(alumno.posicion), { x: x + 5, y: yInicio - 11, size: 7.5, font: regular, color: COLOR_TEXTO })
    x += ANCHO_NUM
    pagina.drawRectangle({ x, y: yInicio - ALTO_FILA, width: ANCHO_NOMBRE, height: ALTO_FILA, borderColor: COLOR_BORDE, borderWidth: 0.75 })
    pagina.drawText(truncarConEllipsis(alumno.nombre, regular, 8, ANCHO_NOMBRE - 8), { x: x + 4, y: yInicio - 11, size: 8, font: regular, color: COLOR_TEXTO })
    x += ANCHO_NOMBRE
    indicadoresUsados.forEach(() => {
      pagina.drawRectangle({ x, y: yInicio - ALTO_FILA, width: ANCHO_IND, height: ALTO_FILA, borderColor: COLOR_BORDE, borderWidth: 0.75 })
      x += ANCHO_IND
    })
    pagina.drawRectangle({ x, y: yInicio - ALTO_FILA, width: ANCHO_FINAL, height: ALTO_FILA, borderColor: COLOR_BORDE, borderWidth: 0.75 })
    y -= ALTO_FILA
  }

  dibujarEncabezadoInstitucional()
  dibujarIdentificador()
  dibujarMetadatosProyecto()
  dibujarLeyenda()
  dibujarListaIndicadores()
  dibujarEncabezadoTabla()
  for (const alumno of datos.alumnos) {
    // Si la página cambió a media tabla, repite el encabezado de
    // columnas antes de seguir — nunca deja una fila sin saber a qué
    // indicador corresponde cada casilla. División a 2 páginas solo
    // ocurre aquí, cuando de verdad no cabe otra fila completa.
    if (y - ALTO_FILA < MARGEN) {
      nuevaPagina()
      dibujarEncabezadoTabla()
    }
    dibujarFilaAlumno(alumno)
  }

  const bytes = await pdfDoc.save()
  return Buffer.from(bytes)
}

export function nombreArchivoHoja(identificadorVisible: string): string {
  return `hoja-seguimiento-${identificadorVisible}.pdf`
}
