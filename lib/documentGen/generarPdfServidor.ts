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

// Ver "Documentos ilustrados + guías completas e ilustradas", Fase 2A
// — mapa descripción→imagen ya generada por herramientas.ts ANTES de
// llamar aquí (generarImagen() es async y usa red; este archivo solo
// dibuja). Opcional: un documento sin líneas [[IMAGEN:...]] nunca
// pasa por este camino, se comporta exactamente igual que siempre.
export type ImagenParaDocumento = { buffer: Buffer; ancho: number; alto: number }

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

// Ver "Pulido visual — pie de página duplicado en exámenes/hojas de
// actividades" (mismo criterio que construirDocumentoWord.ts).
function esExamenOActividad(texto: string): boolean {
  return texto.trim().startsWith('📝')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function generarPdfBuffer(texto: string, perfil: any, zonaHoraria: string | null, imagenesPorDescripcion?: Map<string, ImagenParaDocumento>): Promise<Buffer> {
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

  // Ilustración embebida (ver "Documentos ilustrados...", Fase 2A) —
  // escalada para caber en el ancho de contenido sin distorsionar
  // proporciones; si la descripción no tiene imagen en el mapa (falló
  // su generación o no se pidió embeber), se omite en silencio y el
  // resto del documento sigue exactamente igual — nunca rompe la
  // generación completa por una sola ilustración faltante.
  async function dibujarImagen(descripcion: string) {
    const imagen = imagenesPorDescripcion?.get(descripcion)
    if (!imagen) return
    const png = await pdfDoc.embedPng(imagen.buffer)
    const anchoMax = ANCHO_CONTENIDO * 0.85
    const altoMax = 260
    const escala = Math.min(anchoMax / png.width, altoMax / png.height, 1)
    const anchoDibujo = png.width * escala
    const altoDibujo = png.height * escala
    asegurarEspacio(altoDibujo + 16)
    y -= 8
    pagina.drawImage(png, { x: (ANCHO_PAGINA - anchoDibujo) / 2, y: y - altoDibujo, width: anchoDibujo, height: altoDibujo })
    y -= altoDibujo + 12
  }

  // Altura estimada de una imagen SIN dibujarla (mismo cálculo de
  // escala que dibujarImagen) — usada solo para decidir si el bloque
  // completo "encabezado + imagen" cabe junto en la página actual, ver
  // más abajo. Si la descripción no tiene imagen en el mapa, 0 (no
  // afecta la estimación — la imagen se omitirá igual que siempre).
  function alturaImagenEstimada(descripcion: string): number {
    const imagen = imagenesPorDescripcion?.get(descripcion)
    if (!imagen) return 0
    const anchoMax = ANCHO_CONTENIDO * 0.85
    const altoMax = 260
    const escala = Math.min(anchoMax / imagen.ancho, altoMax / imagen.alto, 1)
    return imagen.alto * escala + 16 + 12
  }

  // Altura estimada de un párrafo corto (mismo ajuste de línea real
  // que dibujarParrafo) — usada junto con la de arriba.
  function alturaParrafoEstimada(texto: string, font: PDFFont, tamano: number): number {
    const lineasEnvueltas = envolverTexto(sanearParaWinAnsi(texto), font, tamano, ANCHO_CONTENIDO)
    return lineasEnvueltas.length * (tamano * 1.4)
  }

  // Tabla real (ver "Pulido visual — tabla real en PDF"): relaciona
  // columnas, verdadero/falso, puntaje. Primera fila como encabezado
  // (sombreado + negrita), igual criterio visual que
  // construirDocumentoWord.ts. Columnas totalmente vacías en TODAS las
  // filas (espaciador típico entre "Columna A"/"Columna B") se
  // colapsan para que se vean como columnas reales, no con una tira
  // vacía. Paginación por fila: si una fila no cabe, se abre página
  // nueva ANTES de dibujarla (mismo criterio que el resto del archivo).
  function dibujarTabla(filas: string[][]) {
    const numColumnasOriginal = Math.max(...filas.map(f => f.length))
    const columnasUtiles: number[] = []
    for (let i = 0; i < numColumnasOriginal; i++) {
      const todasVacias = filas.every(f => !(f[i] ?? '').trim())
      if (!todasVacias) columnasUtiles.push(i)
    }
    const indices = columnasUtiles.length > 0 ? columnasUtiles : Array.from({ length: numColumnasOriginal }, (_, i) => i)
    const numColumnas = indices.length
    const anchoColumna = ANCHO_CONTENIDO / numColumnas
    const PADDING_CELDA = 6
    const TAMANO_TEXTO = 10
    const INTERLINEADO_CELDA = TAMANO_TEXTO * 1.3

    asegurarEspacio(20)
    y -= 6

    filas.forEach((fila, indiceFila) => {
      const esEncabezado = indiceFila === 0
      const font = esEncabezado ? fuentes.negrita : fuentes.regular
      const celdasTexto = indices.map(i => sanearParaWinAnsi(fila[i] ?? ''))
      const lineasPorCelda = celdasTexto.map(t => envolverTexto(t, font, TAMANO_TEXTO, anchoColumna - PADDING_CELDA * 2))
      const maxLineas = Math.max(1, ...lineasPorCelda.map(l => l.length))
      const alturaFila = maxLineas * INTERLINEADO_CELDA + PADDING_CELDA * 2

      asegurarEspacio(alturaFila)
      const yInicioFila = y

      pagina.drawRectangle({
        x: MARGEN,
        y: yInicioFila - alturaFila,
        width: ANCHO_CONTENIDO,
        height: alturaFila,
        color: esEncabezado ? rgb(0.953, 0.957, 0.965) : undefined,
        borderColor: COLOR_BORDE,
        borderWidth: 0.75,
      })
      for (let c = 1; c < numColumnas; c++) {
        const xLinea = MARGEN + anchoColumna * c
        pagina.drawLine({ start: { x: xLinea, y: yInicioFila }, end: { x: xLinea, y: yInicioFila - alturaFila }, thickness: 0.75, color: COLOR_BORDE })
      }
      lineasPorCelda.forEach((lineasCelda, c) => {
        const xCelda = MARGEN + anchoColumna * c + PADDING_CELDA
        lineasCelda.forEach((linea, li) => {
          pagina.drawText(linea, {
            x: xCelda,
            y: yInicioFila - PADDING_CELDA - (li + 1) * INTERLINEADO_CELDA + TAMANO_TEXTO * 0.25,
            size: TAMANO_TEXTO,
            font,
            color: esEncabezado ? COLOR_TITULO : COLOR_TEXTO,
          })
        })
      })

      y = yInicioFila - alturaFila
    })

    y -= 10
  }

  for (let indiceLinea = 0; indiceLinea < lineas.length; indiceLinea++) {
    const l = lineas[indiceLinea]
    if (l.tipo === 'imagen') {
      await dibujarImagen(l.descripcion)
      continue
    }
    if (l.tipo === 'tabla') {
      dibujarTabla(l.filas.map((fila) => fila.map((celda) => quitarEmoji(celda))))
      continue
    }
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
      // Ver "Pulido — mantener juntos título + instrucciones +
      // ilustración de una actividad": antes cada elemento reservaba
      // su propio espacio por separado, así que un encabezado que
      // cabía al final de la página se quedaba ahí mientras su imagen
      // brincaba a la siguiente. Ahora, si esta sección va seguida de
      // cerca (la línea inmediata, o una instrucción corta y luego la
      // imagen) por una ilustración, se reserva el espacio del BLOQUE
      // COMPLETO antes de dibujar nada — si no cabe junto, el bloque
      // entero pasa a la página nueva (nunca un salto forzado ni una
      // página en blanco: es el mismo asegurarEspacio de siempre, solo
      // con una altura mayor calculada por adelantado).
      let alturaBloque = 13 * 1.4 + 12
      const siguiente = lineas[indiceLinea + 1]
      const subsiguiente = lineas[indiceLinea + 2]
      if (siguiente?.tipo === 'imagen') {
        alturaBloque += alturaImagenEstimada(siguiente.descripcion)
      } else if (siguiente?.tipo === 'parrafo' && subsiguiente?.tipo === 'imagen') {
        alturaBloque += alturaParrafoEstimada(quitarEmoji(siguiente.texto), fuentes.regular, 11) + 6
        alturaBloque += alturaImagenEstimada(subsiguiente.descripcion)
      }
      asegurarEspacio(alturaBloque)
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

  if (!esExamenOActividad(texto)) {
    y -= 24
    dibujarLineaCentrada('______________________________', fuentes.regular, 10, COLOR_TEXTO_SUAVE)
    dibujarLineaCentrada(enc.docente, fuentes.negrita, 10, COLOR_TEXTO)
    dibujarLineaCentrada('Docente de grupo', fuentes.regular, 10, COLOR_TEXTO_SUAVE)
  }

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
