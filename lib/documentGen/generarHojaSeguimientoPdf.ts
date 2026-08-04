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
// de evaluación con 5 indicadores y escala 1-4"): cada hoja evalúa
// EXACTAMENTE 5 indicadores esenciales (ver CANTIDAD_INDICADORES_HOJA
// en lib/seguimiento/tipos.ts) y cada uno ocupa UNA sola columna: el
// docente escribe a mano un único dígito (4, 3, 2 o 1) dentro de una
// celda vacía — nunca marca una de varias casillas por posición. Una
// celda vacía sigue significando "no evaluado". La tabla agrega
// además una columna "Nivel final" (más ancha, también un solo
// dígito 1-4 o vacía) que el docente puede llenar o dejar en blanco
// para que la app sugiera un nivel más adelante — nunca se le llama
// "Calificación" en esta hoja ni se muestra aquí la conversión a
// escala 5-10 (ver lib/seguimiento/conversionCalificacion.ts).
//
// MAQUETACIÓN FINAL ("AJUSTE AISLADO C-005 — maquetación final de la
// hoja de evaluación compacta"): la altura de fila y el ancho de las
// celdas de indicador YA NO son constantes adivinadas — se calculan
// en tiempo real a partir del espacio que de verdad queda después de
// dibujar todo el encabezado (institucional, proyecto, leyenda y los
// 5 indicadores), para que las 28 filas usen el máximo alto posible
// sin dejar espacio en blanco entre la última fila y el margen
// inferior, y sin arriesgarse a no caber. ALTO_FILA_MINIMO/MAXIMO
// acotan ese cálculo: nunca por debajo de lo que ya se probó legible,
// ni tan alto que un grupo con pocos alumnos deje celdas
// desproporcionadas.

import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib'
import { prepararEncabezado } from './encabezadoDocumento'
import { NIVELES_EVALUACION, CANTIDAD_INDICADORES_HOJA, type IndicadorProyecto } from '../seguimiento/tipos'

const ANCHO_PAGINA = 792 // carta apaisada (11in), en puntos
const ALTO_PAGINA = 612 // carta apaisada (8.5in)
const MARGEN = 24 // margen seguro de impresión en los 4 lados (~0.33in, por encima del mínimo típico de 0.25in)
const ANCHO_CONTENIDO = ANCHO_PAGINA - MARGEN * 2

const COLOR_TITULO = rgb(0.122, 0.161, 0.216) // #1F2937
const COLOR_TEXTO = rgb(0.216, 0.255, 0.318) // #374151
const COLOR_TEXTO_SUAVE = rgb(0.42, 0.447, 0.502) // #6B7280
const COLOR_BORDE = rgb(0.5, 0.52, 0.55) // visible al imprimir y fotografiar, sin volverse pesado

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

// Cota inferior: nunca una fila más baja que la primera versión del
// modelo compacto (15pt) — sigue siendo legible pero es el piso.
// Cota superior: evita filas exageradamente altas cuando el grupo
// tiene pocos alumnos y sobra alto de página.
export const ALTO_FILA_MINIMO = 15
export const ALTO_FILA_MAXIMO = 26

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
  const ANCHO_NOMBRE = 240 // suficiente para nombre(s) y dos apellidos completos
  const ALTO_ENCABEZADO_TABLA = 20 // una sola fila: # | Alumno | I1..I5 | Nivel final — nunca repite la escala aquí
  const RESERVA_INFERIOR_TABLA = 4 // colchón extra bajo la última fila, además del margen — el borde de la tabla nunca queda pegado al límite de impresión

  let pagina: PDFPage = pdfDoc.addPage([ANCHO_PAGINA, ALTO_PAGINA])
  let y = ALTO_PAGINA - MARGEN - 3 // pequeño respiro respecto al borde superior, nunca pegado al margen exacto

  function nuevaPagina() {
    pagina = pdfDoc.addPage([ANCHO_PAGINA, ALTO_PAGINA])
    y = ALTO_PAGINA - MARGEN - 3
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
      const limpio = truncarConEllipsis(l.texto, l.font, l.tamano, ANCHO_CONTENIDO)
      pagina.drawText(limpio, { x: MARGEN, y: y - l.tamano, size: l.tamano, font: l.font, color: l.color })
      y -= l.tamano * 1.3
    }
  }

  function dibujarIdentificador() {
    const texto = datos.identificadorVisible
    const tamano = 13
    const ancho = negrita.widthOfTextAtSize(texto, tamano)
    pagina.drawRectangle({
      x: ANCHO_PAGINA - MARGEN - ancho - 14,
      y: ALTO_PAGINA - MARGEN - 19,
      width: ancho + 14,
      height: 21,
      borderColor: COLOR_TITULO,
      borderWidth: 1,
    })
    pagina.drawText(texto, {
      x: ANCHO_PAGINA - MARGEN - ancho - 7,
      y: ALTO_PAGINA - MARGEN - 14,
      size: tamano,
      font: negrita,
      color: COLOR_TITULO,
    })
  }

  function dibujarMetadatosProyecto() {
    y -= 2
    pagina.drawText(truncarConEllipsis(datos.nombreProyecto, negrita, 11, ANCHO_CONTENIDO), { x: MARGEN, y: y - 11, size: 11, font: negrita, color: COLOR_TITULO })
    y -= 14
    const metaPartes = [
      datos.camposFormativos.join(' / '),
      datos.trimestreNombre ? `Trimestre: ${datos.trimestreNombre}` : null,
      datos.fechaInicio && datos.fechaFin ? `${datos.fechaInicio} — ${datos.fechaFin}` : null,
    ].filter(Boolean)
    pagina.drawText(truncarConEllipsis(metaPartes.join('    ·    '), regular, 8, ANCHO_CONTENIDO), { x: MARGEN, y: y - 8, size: 8, font: regular, color: COLOR_TEXTO })
    y -= 10.5
  }

  // Leyenda ÚNICA y compacta — nunca se repite dentro de la tabla
  // (justamente porque cada indicador ya es una sola columna, no hace
  // falta reexplicar la escala en cada celda). Incluye "Vacío No
  // evaluado" para dejar ese significado explícito sin necesidad de
  // otra leyenda aparte.
  function dibujarLeyenda() {
    const etiqueta = NIVELES_EVALUACION.map(n => `${n.valor} ${n.etiqueta}`).join(' · ') + ' · Vacío No evaluado'
    pagina.drawText(truncarConEllipsis(etiqueta, regular, 8, ANCHO_CONTENIDO), { x: MARGEN, y: y - 8, size: 8, font: regular, color: COLOR_TEXTO_SUAVE })
    y -= 10.5
  }

  // Los 5 indicadores numerados, en 3 columnas (nunca más de 2 filas
  // para hasta 6 indicadores) — el texto completo vive aquí; la tabla
  // de abajo solo repite "I1".."I5" como referencia a esta lista. Sin
  // título aparte ("Indicadores"): la numeración y la leyenda de
  // arriba ya dejan claro qué es esta lista, y ahorra una línea
  // completa de alto que se reinvierte en las filas de alumnos.
  function dibujarListaIndicadores() {
    const COLUMNAS = 3
    const gap = 10
    const anchoColumna = (ANCHO_CONTENIDO - gap * (COLUMNAS - 1)) / COLUMNAS
    const yListaInicio = y
    const filasPorColumna = new Array(COLUMNAS).fill(0)
    indicadoresUsados.forEach((ind, i) => {
      const columna = i % COLUMNAS
      const fila = filasPorColumna[columna]++
      const x = MARGEN + columna * (anchoColumna + gap)
      const texto = `${i + 1}. ${ind.indicador_especifico}`
      pagina.drawText(truncarConEllipsis(texto, regular, 8, anchoColumna), {
        x,
        y: yListaInicio - fila * 10.5 - 8,
        size: 8,
        font: regular,
        color: COLOR_TEXTO,
      })
    })
    const filas = Math.max(...filasPorColumna, 1)
    y = yListaInicio - filas * 10.5 - 6
  }

  dibujarEncabezadoInstitucional()
  dibujarIdentificador()
  dibujarMetadatosProyecto()
  dibujarLeyenda()
  dibujarListaIndicadores()

  // A partir de aquí se reparte TODO el alto que sobró entre las
  // filas de alumnos — nunca un número fijo adivinado. Así la tabla
  // aprovecha el máximo alto disponible sin dejar espacio en blanco
  // entre la última fila y el margen inferior, y las celdas I1-I5 se
  // dibujan visualmente cuadradas (mismo ancho que ese alto).
  const alturaDisponibleFilas = y - ALTO_ENCABEZADO_TABLA - MARGEN - RESERVA_INFERIOR_TABLA
  const cantidadFilas = Math.max(datos.alumnos.length, 1)
  const ALTO_FILA = Math.min(ALTO_FILA_MAXIMO, Math.max(ALTO_FILA_MINIMO, alturaDisponibleFilas / cantidadFilas))
  const ANCHO_IND = ALTO_FILA // celda cuadrada para un solo dígito 1-4 escrito a mano

  const TEXTO_NIVEL_FINAL = 'Nivel final'
  const TAMANO_NIVEL_FINAL = 8
  const anchoTextoNivelFinal = negrita.widthOfTextAtSize(TEXTO_NIVEL_FINAL, TAMANO_NIVEL_FINAL)
  // "Nivel final" siempre completo y sin recortar: el ancho de la
  // columna se calcula a partir del texto real, nunca al revés — y
  // además queda ligeramente más ancha que una celda de indicador.
  const ANCHO_FINAL = Math.max(anchoTextoNivelFinal + 14, ANCHO_IND * 1.6)

  const anchoTabla = ANCHO_NUM + ANCHO_NOMBRE + indicadoresUsados.length * ANCHO_IND + ANCHO_FINAL
  const X_TABLA = MARGEN + Math.max(0, (ANCHO_CONTENIDO - anchoTabla) / 2)

  function dibujarEncabezadoTabla() {
    asegurarEspacio(ALTO_ENCABEZADO_TABLA + ALTO_FILA)
    const yInicio = y
    let x = X_TABLA
    pagina.drawRectangle({ x, y: yInicio - ALTO_ENCABEZADO_TABLA, width: ANCHO_NUM, height: ALTO_ENCABEZADO_TABLA, borderColor: COLOR_BORDE, borderWidth: 1 })
    pagina.drawText('#', { x: x + 6, y: yInicio - 14, size: 8.5, font: negrita, color: COLOR_TITULO })
    x += ANCHO_NUM
    pagina.drawRectangle({ x, y: yInicio - ALTO_ENCABEZADO_TABLA, width: ANCHO_NOMBRE, height: ALTO_ENCABEZADO_TABLA, borderColor: COLOR_BORDE, borderWidth: 1 })
    pagina.drawText('Alumno', { x: x + 5, y: yInicio - 14, size: 8.5, font: negrita, color: COLOR_TITULO })
    x += ANCHO_NOMBRE
    indicadoresUsados.forEach((_, i) => {
      pagina.drawRectangle({ x, y: yInicio - ALTO_ENCABEZADO_TABLA, width: ANCHO_IND, height: ALTO_ENCABEZADO_TABLA, borderColor: COLOR_BORDE, borderWidth: 1 })
      const etiqueta = `I${i + 1}`
      const anchoEtiqueta = negrita.widthOfTextAtSize(etiqueta, 8.5)
      pagina.drawText(etiqueta, { x: x + (ANCHO_IND - anchoEtiqueta) / 2, y: yInicio - 14, size: 8.5, font: negrita, color: COLOR_TITULO })
      x += ANCHO_IND
    })
    pagina.drawRectangle({ x, y: yInicio - ALTO_ENCABEZADO_TABLA, width: ANCHO_FINAL, height: ALTO_ENCABEZADO_TABLA, borderColor: COLOR_BORDE, borderWidth: 1 })
    pagina.drawText(TEXTO_NIVEL_FINAL, { x: x + Math.max(2, (ANCHO_FINAL - anchoTextoNivelFinal) / 2), y: yInicio - 14, size: TAMANO_NIVEL_FINAL, font: negrita, color: COLOR_TITULO })
    y -= ALTO_ENCABEZADO_TABLA
  }

  // Una fila por alumno: una celda cuadrada VACÍA por indicador (para
  // un solo dígito escrito a mano, nunca varias casillas de posición)
  // más una celda "Nivel final" al final, también vacía.
  function dibujarFilaAlumno(alumno: AlumnoHoja) {
    asegurarEspacio(ALTO_FILA)
    const yInicio = y
    let x = X_TABLA
    const yTexto = yInicio - ALTO_FILA / 2 - 3
    pagina.drawRectangle({ x, y: yInicio - ALTO_FILA, width: ANCHO_NUM, height: ALTO_FILA, borderColor: COLOR_BORDE, borderWidth: 0.75 })
    pagina.drawText(String(alumno.posicion), { x: x + 5, y: yTexto, size: 7.5, font: regular, color: COLOR_TEXTO })
    x += ANCHO_NUM
    pagina.drawRectangle({ x, y: yInicio - ALTO_FILA, width: ANCHO_NOMBRE, height: ALTO_FILA, borderColor: COLOR_BORDE, borderWidth: 0.75 })
    pagina.drawText(truncarConEllipsis(alumno.nombre, regular, 8, ANCHO_NOMBRE - 8), { x: x + 4, y: yTexto, size: 8, font: regular, color: COLOR_TEXTO })
    x += ANCHO_NOMBRE
    indicadoresUsados.forEach(() => {
      pagina.drawRectangle({ x, y: yInicio - ALTO_FILA, width: ANCHO_IND, height: ALTO_FILA, borderColor: COLOR_BORDE, borderWidth: 0.75 })
      x += ANCHO_IND
    })
    pagina.drawRectangle({ x, y: yInicio - ALTO_FILA, width: ANCHO_FINAL, height: ALTO_FILA, borderColor: COLOR_BORDE, borderWidth: 0.75 })
    y -= ALTO_FILA
  }

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
