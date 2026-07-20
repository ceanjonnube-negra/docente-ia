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
import { formatearFecha } from '../tiempo/TimeService'

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
    .replace(/[^\x20-\x7E -ÿ]/g, '')
}

const ANCHO_PAGINA = 612 // carta, en puntos (72pt = 1 in) — mismo tamaño que usaba pdfkit
const ALTO_PAGINA = 792
const MARGEN = 50
const ANCHO_CONTENIDO = ANCHO_PAGINA - MARGEN * 2

const VERDE = rgb(0.086, 0.396, 0.204) // #166534
const GRIS_TEXTO = rgb(0.216, 0.255, 0.318) // #374151
const GRIS_CLARO = rgb(0.4, 0.4, 0.4) // #666666

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

  function dibujarLineaCentrada(texto: string, font: PDFFont, tamano: number, color = GRIS_TEXTO) {
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
        pagina.drawCircle({ x: MARGEN + 3, y: y - tamano + 3, size: 1.6, color: GRIS_TEXTO })
      }
      pagina.drawText(linea, { x: xTexto, y: y - tamano, size: tamano, font: fuentes.regular, color: GRIS_TEXTO })
      y -= interlineado
    })
  }

  // Encabezado — mismos datos reales que el Word.
  dibujarLineaCentrada(perfil?.escuela || 'Escuela', fuentes.regular, 10, GRIS_TEXTO)
  dibujarParrafo(
    `Docente: ${perfil?.nombre || ''}   Grado: ${perfil?.grado || ''} grado   Grupo: ${perfil?.grupo || ''}   Fecha: ${formatearFecha(new Date(), zonaHoraria, { day: 'numeric', month: 'numeric', year: 'numeric' })}`,
    fuentes.regular,
    10,
    GRIS_TEXTO
  )
  y -= 10

  const lineas = analizarContenido(texto)
  let primerTitulo = true
  for (const l of lineas) {
    const contenido = quitarEmoji(l.texto)
    if (!contenido) continue
    if (l.tipo === 'titulo') {
      const tamano = primerTitulo ? 18 : 14
      if (primerTitulo) {
        dibujarLineaCentrada(contenido, fuentes.negrita, tamano, VERDE)
      } else {
        asegurarEspacio(tamano * 1.6)
        dibujarParrafo(contenido, fuentes.negrita, tamano, VERDE)
      }
      y -= 6
      primerTitulo = false
    } else if (l.tipo === 'seccion') {
      y -= 4
      dibujarParrafo(contenido, fuentes.negrita, 13, VERDE)
      y -= 4
    } else if (l.tipo === 'bullet') {
      dibujarBullet(contenido)
    } else {
      dibujarParrafo(contenido, fuentes.regular, 11, GRIS_TEXTO)
      y -= 4
    }
  }

  y -= 20
  dibujarLineaCentrada('______________________________', fuentes.regular, 10, GRIS_CLARO)
  dibujarLineaCentrada(perfil?.nombre || 'Docente', fuentes.regular, 10, GRIS_CLARO)
  dibujarLineaCentrada('Firma del Docente', fuentes.regular, 10, GRIS_CLARO)

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
