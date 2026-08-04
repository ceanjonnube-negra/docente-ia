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
// Escala numérica 1-4 (ver "AJUSTE DE DISEÑO Y MODELO DE EVALUACIÓN —
// sustituir letras por escala numérica simple"): cada indicador ocupa
// un bloque de 4 casillas (columnas "4", "3", "2", "1") — el docente
// marca UNA sola con X, círculo o palomita, nunca escribe una letra ni
// un número a mano. Una fila sin ninguna marca se interpreta como "no
// evaluado" (ver lib/seguimiento/conversionCalificacion.ts). El
// reconocimiento por fotografía identifica QUÉ casilla quedó marcada
// (posición), nunca un carácter escrito — de ahí que cada nivel sea su
// propia casilla vacía en vez de una sola celda con una letra dentro.

import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib'
import { prepararEncabezado } from './encabezadoDocumento'
import { NIVELES_EVALUACION, type IndicadorProyecto } from '../seguimiento/tipos'

const ANCHO_PAGINA = 792 // carta apaisada (11in), en puntos
const ALTO_PAGINA = 612 // carta apaisada (8.5in)
const MARGEN = 36
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

  const numIndicadores = Math.max(datos.indicadores.length, 1)
  const ANCHO_NUM = 22
  const ANCHO_NOMBRE = 190
  const anchoRestante = ANCHO_CONTENIDO - ANCHO_NUM - ANCHO_NOMBRE
  // Cada indicador ocupa un bloque de 4 casillas (niveles 4/3/2/1) —
  // por debajo de ~16pt por casilla dejan de ser legibles en foto ni
  // caben un dígito + una marca a mano; con muchos indicadores la
  // tabla se saldrá del margen derecho antes que encogerse más.
  const ANCHO_NIVEL_MINIMO = 16
  const ANCHO_INDICADOR = Math.max(anchoRestante / numIndicadores, ANCHO_NIVEL_MINIMO * NIVELES_EVALUACION.length)
  const ANCHO_NIVEL = ANCHO_INDICADOR / NIVELES_EVALUACION.length
  const ALTO_FILA = 20
  const ALTO_ENCABEZADO_INDICADOR = 14 // fila superior: número del indicador, centrado sobre sus 4 casillas
  const ALTO_ENCABEZADO_NIVELES = 14 // fila inferior: etiquetas "4  3  2  1"
  const ALTO_ENCABEZADO_TABLA = ALTO_ENCABEZADO_INDICADOR + ALTO_ENCABEZADO_NIVELES

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
      { texto: enc.escuela, font: negrita, tamano: 12, color: COLOR_TITULO },
      { texto: `Docente: ${enc.docente}    Grado: ${enc.grado}    Grupo: ${enc.grupo}    Ciclo: ${enc.cicloEscolar}`, font: regular, tamano: 9, color: COLOR_TEXTO_SUAVE },
    ]
    for (const l of lineas) {
      const limpio = sanearParaWinAnsi(l.texto)
      pagina.drawText(limpio, { x: MARGEN, y: y - l.tamano, size: l.tamano, font: l.font, color: l.color })
      y -= l.tamano * 1.5
    }
  }

  function dibujarIdentificador() {
    const texto = datos.identificadorVisible
    const tamano = 16
    const ancho = negrita.widthOfTextAtSize(texto, tamano)
    pagina.drawRectangle({
      x: ANCHO_PAGINA - MARGEN - ancho - 16,
      y: ALTO_PAGINA - MARGEN - 22,
      width: ancho + 16,
      height: 24,
      borderColor: COLOR_TITULO,
      borderWidth: 1,
    })
    pagina.drawText(texto, {
      x: ANCHO_PAGINA - MARGEN - ancho - 8,
      y: ALTO_PAGINA - MARGEN - 16,
      size: tamano,
      font: negrita,
      color: COLOR_TITULO,
    })
  }

  function dibujarMetadatosProyecto() {
    y -= 6
    pagina.drawText(sanearParaWinAnsi(datos.nombreProyecto), { x: MARGEN, y: y - 15, size: 15, font: negrita, color: COLOR_TITULO })
    y -= 22
    const metaPartes = [
      datos.camposFormativos.join(' / '),
      datos.trimestreNombre ? `Trimestre: ${datos.trimestreNombre}` : null,
      datos.fechaInicio && datos.fechaFin ? `${datos.fechaInicio} — ${datos.fechaFin}` : null,
    ].filter(Boolean)
    pagina.drawText(sanearParaWinAnsi(metaPartes.join('    ·    ')), { x: MARGEN, y: y - 10, size: 9.5, font: regular, color: COLOR_TEXTO })
    y -= 20
  }

  function dibujarLeyenda() {
    // Escala numérica 1-4 (nunca letras D/L/E/R/N) — mismo orden que
    // las columnas de la tabla (4 a la izquierda, 1 a la derecha).
    const etiqueta = NIVELES_EVALUACION.map(n => `${n.valor} ${n.etiqueta}`).join('  ·  ')
    pagina.drawText(sanearParaWinAnsi(etiqueta), { x: MARGEN, y: y - 10, size: 9, font: regular, color: COLOR_TEXTO_SUAVE })
    y -= 18
  }

  function dibujarLeyendaIndicadores() {
    pagina.drawText('Indicadores', { x: MARGEN, y: y - 10, size: 9.5, font: negrita, color: COLOR_TITULO })
    y -= 15
    datos.indicadores.forEach((ind, i) => {
      const texto = `${i + 1}. ${ind.indicador_especifico}`
      asegurarEspacio(13)
      pagina.drawText(truncarConEllipsis(texto, regular, 9, ANCHO_CONTENIDO), { x: MARGEN, y: y - 9, size: 9, font: regular, color: COLOR_TEXTO })
      y -= 13
    })
    y -= 8
  }

  // Encabezado en DOS filas: arriba el número del indicador (una sola
  // celda que abarca visualmente sus 4 casillas), abajo la etiqueta de
  // cada nivel (4/3/2/1, mismo orden que la leyenda) — así cada
  // columna de la tabla queda identificada sin repetir texto dentro de
  // cada fila de alumno.
  function dibujarEncabezadoTabla() {
    asegurarEspacio(ALTO_ENCABEZADO_TABLA + ALTO_FILA)
    const yInicio = y
    let x = MARGEN
    pagina.drawRectangle({ x, y: yInicio - ALTO_ENCABEZADO_TABLA, width: ANCHO_NUM, height: ALTO_ENCABEZADO_TABLA, borderColor: COLOR_BORDE, borderWidth: 1 })
    pagina.drawText('#', { x: x + 7, y: yInicio - 16, size: 9, font: negrita, color: COLOR_TITULO })
    x += ANCHO_NUM
    pagina.drawRectangle({ x, y: yInicio - ALTO_ENCABEZADO_TABLA, width: ANCHO_NOMBRE, height: ALTO_ENCABEZADO_TABLA, borderColor: COLOR_BORDE, borderWidth: 1 })
    pagina.drawText('Alumno', { x: x + 6, y: yInicio - 16, size: 9, font: negrita, color: COLOR_TITULO })
    x += ANCHO_NOMBRE
    datos.indicadores.forEach((_, i) => {
      const xBloque = x
      // Fila superior — número del indicador, centrado sobre el
      // bloque completo de 4 casillas.
      pagina.drawRectangle({ x: xBloque, y: yInicio - ALTO_ENCABEZADO_INDICADOR, width: ANCHO_INDICADOR, height: ALTO_ENCABEZADO_INDICADOR, borderColor: COLOR_BORDE, borderWidth: 1 })
      const num = String(i + 1)
      const anchoNum = negrita.widthOfTextAtSize(num, 9)
      pagina.drawText(num, { x: xBloque + (ANCHO_INDICADOR - anchoNum) / 2, y: yInicio - 11, size: 9, font: negrita, color: COLOR_TITULO })
      // Fila inferior — una casilla por nivel (4, 3, 2, 1).
      NIVELES_EVALUACION.forEach((nivel, j) => {
        const xNivel = xBloque + j * ANCHO_NIVEL
        pagina.drawRectangle({ x: xNivel, y: yInicio - ALTO_ENCABEZADO_TABLA, width: ANCHO_NIVEL, height: ALTO_ENCABEZADO_NIVELES, borderColor: COLOR_BORDE, borderWidth: 1 })
        const etiquetaNivel = String(nivel.valor)
        const anchoEtiqueta = negrita.widthOfTextAtSize(etiquetaNivel, 8)
        pagina.drawText(etiquetaNivel, { x: xNivel + (ANCHO_NIVEL - anchoEtiqueta) / 2, y: yInicio - ALTO_ENCABEZADO_INDICADOR - 10, size: 8, font: negrita, color: COLOR_TITULO })
      })
      x += ANCHO_INDICADOR
    })
    y -= ALTO_ENCABEZADO_TABLA
  }

  // Una fila por alumno: 4 casillas VACÍAS por indicador (nunca una
  // sola celda con una letra dentro) — el docente marca UNA con X,
  // círculo o palomita; una fila sin ninguna marca es "no evaluado".
  function dibujarFilaAlumno(alumno: AlumnoHoja) {
    asegurarEspacio(ALTO_FILA)
    const yInicio = y
    let x = MARGEN
    pagina.drawRectangle({ x, y: yInicio - ALTO_FILA, width: ANCHO_NUM, height: ALTO_FILA, borderColor: COLOR_BORDE, borderWidth: 0.75 })
    pagina.drawText(String(alumno.posicion), { x: x + 6, y: yInicio - 14, size: 8.5, font: regular, color: COLOR_TEXTO })
    x += ANCHO_NUM
    pagina.drawRectangle({ x, y: yInicio - ALTO_FILA, width: ANCHO_NOMBRE, height: ALTO_FILA, borderColor: COLOR_BORDE, borderWidth: 0.75 })
    pagina.drawText(truncarConEllipsis(alumno.nombre, regular, 8.5, ANCHO_NOMBRE - 10), { x: x + 5, y: yInicio - 14, size: 8.5, font: regular, color: COLOR_TEXTO })
    x += ANCHO_NOMBRE
    datos.indicadores.forEach(() => {
      NIVELES_EVALUACION.forEach((_, j) => {
        pagina.drawRectangle({ x: x + j * ANCHO_NIVEL, y: yInicio - ALTO_FILA, width: ANCHO_NIVEL, height: ALTO_FILA, borderColor: COLOR_BORDE, borderWidth: 0.75 })
      })
      x += ANCHO_INDICADOR
    })
    y -= ALTO_FILA
  }

  dibujarEncabezadoInstitucional()
  dibujarIdentificador()
  dibujarMetadatosProyecto()
  dibujarLeyenda()
  dibujarLeyendaIndicadores()
  dibujarEncabezadoTabla()
  for (const alumno of datos.alumnos) {
    // Si la página cambió a media tabla, repite el encabezado de
    // columnas antes de seguir — nunca deja una fila sin saber a qué
    // indicador corresponde cada casilla.
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
