// lib/documentGen/generarPdfServidor.ts
//
// Genera un PDF real en el servidor con pdf-lib. Reemplaza el motor
// anterior (pdfkit): pdfkit carga sus métricas de fuente por defecto
// leyendo un archivo .afm del disco en tiempo de ejecución
// (node_modules/pdfkit/js/data/Helvetica.afm) con una ruta que el
// empaquetador de Vercel/Next no detecta como dependencia estática —
// el archivo nunca llegaba al bundle desplegado y la conversión fallaba
// con ENOENT en cada solicitud real, aunque funcionaba perfecto en
// local. pdf-lib no lee nada del disco: las métricas de las 14 fuentes
// estándar (incluida Helvetica) vienen embebidas como datos JS dentro
// del propio paquete, así que este problema de empaquetado no puede
// repetirse.
//
// Paginación manual: a diferencia de pdfkit, pdf-lib no ofrece un flujo
// de texto con salto de página automático — se lleva la posición Y a
// mano y se agrega una página nueva cuando el contenido no cabe.

import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib'
import { analizarContenido } from './parseContenido'
import { prepararEncabezado } from './encabezadoDocumento'

// Igual que en el motor anterior: los emoji del formato MODO DOCUMENTO
// (📋, 🎯, 📅...) no tienen glifo en las fuentes estándar — se quitan
// del texto visible antes de dibujar nada.
function quitarEmoji(texto: string): string {
  return texto.replace(/\p{Extended_Pictographic}/gu, '').replace(/\s{2,}/g, ' ').trim()
}

// Las fuentes estándar de pdf-lib codifican con WinAnsi (cp1252), que
// cubre todos los acentos y la ñ del español, pero no cualquier
// símbolo Unicode que el modelo pudiera colar (flechas, viñetas
// exóticas, etc.) — drawText lanzaría una excepción real ante un
// carácter no codificable. Se normalizan los signos tipográficos más
// comunes a su equivalente ASCII y se descarta cualquier otro carácter
// fuera de ASCII imprimible + Latin-1 (acentos/ñ/ü), en vez de arriesgar
// que una comilla rara tumbe la generación completa del documento.
function sanearParaWinAnsi(texto: string): string {
  return texto
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7E -ÿ]/g, '')
}

// "EQUIPO 1", "EQUIPO 2"... — nunca se dibuja con caracteres Unicode de
// caja (━), que las fuentes estándar de pdf-lib no pueden codificar; en
// vez de eso cada uno abre con una línea real dibujada (drawLine) y sus
// integrantes se cuentan aparte para el resumen final (ver más abajo) —
// nunca a partir de un total que la IA haya escrito por su cuenta.
const EQUIPO_REGEX = /^EQUIPO\s+(\d+)/i

const ANCHO_PAGINA = 612 // carta, en puntos (72pt = 1 in) — mismo tamaño que usaba pdfkit
const ALTO_PAGINA = 792
const MARGEN = 50
const ANCHO_CONTENIDO = ANCHO_PAGINA - MARGEN * 2

// Paleta discreta — nunca fondos de color ni acentos brillantes, solo
// texto en tonos gris/oscuro institucional, igual en Word y PDF.
const COLOR_TITULO = rgb(0.122, 0.161, 0.216) // #1F2937
const COLOR_TEXTO = rgb(0.216, 0.255, 0.318) // #374151
const COLOR_TEXTO_SUAVE = rgb(0.42, 0.447, 0.502) // #6B7280
const COLOR_BORDE = rgb(0.82, 0.835, 0.859) // #D1D5DB

type Fuentes = { regular: PDFFont; negrita: PDFFont }

// Envuelve una línea larga en varias que quepan dentro de anchoMax,
// midiendo con el ancho real de la fuente (no una heurística de
// caracteres por línea) — necesario para que la paginación por altura
// (asegurarEspacio) sea exacta.
function envolverTexto(texto: string, font: PDFFont, tamano: number, anchoMax: number): string[] {
  const palabras = texto.split(' ')
  const lineas: string[] = []
  let actual = ''
  for (const palabra of palabras) {
    const prueba = actual ? `${actual} ${palabra}` : palabra
    if (font.widthOfTextAtSize(prueba, tamano) > anchoMax && actual) {
      lineas.push(actual)
      actual = palabra
    } else {
      actual = prueba
    }
  }
  if (actual) lineas.push(actual)
  return lineas
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function generarPdfBuffer(texto: string, perfil: any, zonaHoraria: string | null): Promise<Buffer> {
  const enc = prepararEncabezado(perfil, zonaHoraria)
  const pdfDoc = await PDFDocument.create()
  const fuentes: Fuentes = {
    regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
    negrita: await pdfDoc.embedFont(StandardFonts.HelveticaBold),
  }

  let pagina: PDFPage = pdfDoc.addPage([ANCHO_PAGINA, ALTO_PAGINA])
  let y = ALTO_PAGINA - MARGEN

  function nuevaPagina() {
    pagina = pdfDoc.addPage([ANCHO_PAGINA, ALTO_PAGINA])
    y = ALTO_PAGINA - MARGEN
  }

  // Contenido paginado correctamente: antes de dibujar cualquier bloque
  // se comprueba que quepa en lo que resta de la página actual — si no,
  // se abre una página nueva ANTES de dibujar, nunca a mitad de línea.
  function asegurarEspacio(alturaNecesaria: number) {
    if (y - alturaNecesaria < MARGEN) nuevaPagina()
  }

  function dibujarLineaCentrada(texto: string, font: PDFFont, tamano: number, color = COLOR_TEXTO) {
    const limpio = sanearParaWinAnsi(texto)
    asegurarEspacio(tamano * 1.4)
    const ancho = font.widthOfTextAtSize(limpio, tamano)
    pagina.drawText(limpio, { x: (ANCHO_PAGINA - ancho) / 2, y: y - tamano, size: tamano, font, color })
    y -= tamano * 1.4
  }

  function dibujarParrafo(texto: string, font: PDFFont, tamano: number, color: ReturnType<typeof rgb>, x = MARGEN, anchoMax = ANCHO_CONTENIDO) {
    const limpio = sanearParaWinAnsi(texto)
    const interlineado = tamano * 1.4
    for (const linea of envolverTexto(limpio, font, tamano, anchoMax)) {
      asegurarEspacio(interlineado)
      pagina.drawText(linea, { x, y: y - tamano, size: tamano, font, color })
      y -= interlineado
    }
  }

  function dibujarBullet(texto: string, tamano = 11) {
    const limpio = sanearParaWinAnsi(texto)
    const interlineado = tamano * 1.4
    const xTexto = MARGEN + 14
    const lineas = envolverTexto(limpio, fuentes.regular, tamano, ANCHO_CONTENIDO - 14)
    lineas.forEach((linea, i) => {
      asegurarEspacio(interlineado)
      if (i === 0) {
        pagina.drawCircle({ x: MARGEN + 3, y: y - tamano + 3, size: 1.6, color: COLOR_TEXTO })
      }
      pagina.drawText(linea, { x: xTexto, y: y - tamano, size: tamano, font: fuentes.regular, color: COLOR_TEXTO })
      y -= interlineado
    })
  }

  // Línea divisoria real (nunca caracteres Unicode) — separa cada
  // "EQUIPO N" del anterior con aire visible arriba y abajo.
  function dibujarDivisoria() {
    asegurarEspacio(20)
    y -= 10
    pagina.drawLine({ start: { x: MARGEN, y }, end: { x: ANCHO_PAGINA - MARGEN, y }, thickness: 0.75, color: COLOR_BORDE })
    y -= 14
  }

  // Encabezado institucional — UNO solo, siempre igual, nunca lo
  // escribe la IA en el cuerpo (ver regla 9 de MODO DOCUMENTO en
  // app/api/chat/route.ts). Cada dato en su propia línea, centrado.
  dibujarLineaCentrada(enc.escuela, fuentes.negrita, 13, COLOR_TITULO)
  dibujarLineaCentrada(`Docente: ${enc.docente}`, fuentes.regular, 10, COLOR_TEXTO_SUAVE)
  dibujarLineaCentrada(`Grado: ${enc.grado}    Grupo: ${enc.grupo}`, fuentes.regular, 10, COLOR_TEXTO_SUAVE)
  dibujarLineaCentrada(`${enc.lugar ? enc.lugar + '   ·   ' : ''}Fecha: ${enc.fecha}`, fuentes.regular, 10, COLOR_TEXTO_SUAVE)
  dibujarLineaCentrada(`Ciclo Escolar: ${enc.cicloEscolar}`, fuentes.regular, 10, COLOR_TEXTO_SUAVE)
  y -= 16

  const lineas = analizarContenido(texto)
  let primerTitulo = true

  // Conteo real de integrantes por equipo — nunca reportado por la IA.
  const integrantesPorEquipo: { numero: string; total: number }[] = []
  let equipoActual: { numero: string; total: number } | null = null

  for (const l of lineas) {
    const contenido = quitarEmoji(l.texto)
    if (!contenido) continue

    const matchEquipo = (l.tipo === 'titulo' || l.tipo === 'seccion') ? contenido.match(EQUIPO_REGEX) : null

    if (matchEquipo) {
      equipoActual = { numero: matchEquipo[1], total: 0 }
      integrantesPorEquipo.push(equipoActual)
      dibujarDivisoria()
      dibujarParrafo(contenido, fuentes.negrita, 14, COLOR_TITULO)
      y -= 6
    } else if (l.tipo === 'titulo') {
      const tamano = primerTitulo ? 18 : 14
      if (primerTitulo) {
        dibujarLineaCentrada(contenido, fuentes.negrita, tamano, COLOR_TITULO)
      } else {
        asegurarEspacio(tamano * 1.6)
        dibujarParrafo(contenido, fuentes.negrita, tamano, COLOR_TITULO)
      }
      y -= 8
      primerTitulo = false
    } else if (l.tipo === 'seccion') {
      y -= 6
      dibujarParrafo(contenido, fuentes.negrita, 13, COLOR_TITULO)
      y -= 6
    } else if (l.tipo === 'bullet') {
      if (equipoActual) equipoActual.total += 1
      dibujarBullet(contenido)
    } else {
      dibujarParrafo(contenido, fuentes.regular, 11, COLOR_TEXTO)
      y -= 6
    }
  }

  // RESUMEN FINAL — solo cuando de verdad hay equipos detectados; se
  // calcula de los datos reales contados arriba, nunca de un texto que
  // la IA haya escrito por su cuenta.
  if (integrantesPorEquipo.length > 0) {
    dibujarDivisoria()
    dibujarParrafo('RESUMEN', fuentes.negrita, 14, COLOR_TITULO)
    y -= 6
    dibujarParrafo(`Total de equipos: ${integrantesPorEquipo.length}`, fuentes.regular, 11, COLOR_TEXTO)
    for (const eq of integrantesPorEquipo) {
      dibujarParrafo(`Equipo ${eq.numero}: ${eq.total} integrante(s)`, fuentes.regular, 11, COLOR_TEXTO)
    }
  }

  y -= 24
  dibujarLineaCentrada('______________________________', fuentes.regular, 10, COLOR_TEXTO_SUAVE)
  dibujarLineaCentrada(enc.docente, fuentes.negrita, 10, COLOR_TEXTO)
  dibujarLineaCentrada('Docente de grupo', fuentes.regular, 10, COLOR_TEXTO_SUAVE)

  const bytes = await pdfDoc.save()
  return Buffer.from(bytes)
}

export function nombreArchivoPdf(titulo: string): string {
  const slug = titulo
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'Documento'
  return `${slug}.pdf`
}
