// lib/documentGen/generarPptxServidor.ts
//
// Genera una presentación PowerPoint real (.pptx) en el servidor —
// convierte el mismo texto estructurado de MODO DOCUMENTO en una
// diapositiva de título más una diapositiva por cada sección principal
// (ver agruparEnDiapositivas en parseContenido.ts), sin que el maestro
// tenga que pedir "una diapositiva por día" explícitamente.

import PptxGenJS from 'pptxgenjs'
import { analizarContenido, agruparEnDiapositivas, extraerTitulo } from './parseContenido'
import { formatearFecha } from '../tiempo/TimeService'
import { prepararEncabezado } from './encabezadoDocumento'

function quitarEmoji(texto: string): string {
  return texto.replace(/\p{Extended_Pictographic}/gu, '').replace(/\s{2,}/g, ' ').trim()
}

// Medidas en pulgadas del diseño 16:9 (10 × 5.625). Toda caja de texto
// queda dentro de la diapositiva y ninguna se encima con otra: el texto
// que no cabe nunca se recorta — el título reduce su letra y las viñetas
// siguen en una diapositiva de continuación.
const ANCHO_TEXTO = 9
const LETRA_VINETAS = 16
const INTERLINEADO = 1.25

// Estimación conservadora de cuántas líneas ocupa un texto en una caja
// (ancho medio de carácter ≈ 0.55 de la letra).
function lineasDe(texto: string, letra: number, ancho: number): number {
  const porLinea = Math.max(1, Math.floor((ancho * 72) / (letra * 0.55)))
  return Math.max(1, Math.ceil(texto.length / porLinea))
}

// La letra más grande (de maxima a minima) con la que el texto cabe en la caja.
function letraQueCabe(texto: string, alto: number, maxima: number, minima: number): number {
  for (let letra = maxima; letra > minima; letra -= 2) {
    if (lineasDe(texto, letra, ANCHO_TEXTO) * letra * INTERLINEADO <= alto * 72) return letra
  }
  return minima
}

// Reparte las viñetas en páginas que caben en `alto`; una viñeta que por
// sí sola no cabe se parte por palabras (nunca se pierde texto).
function paginarVinetas(vinetas: string[], alto: number): string[][] {
  const capacidad = Math.max(1, Math.floor((alto * 72) / (LETRA_VINETAS * INTERLINEADO)))
  const porLinea = Math.max(1, Math.floor(((ANCHO_TEXTO - 0.4) * 72) / (LETRA_VINETAS * 0.55)))
  const piezas = vinetas.flatMap((v) => {
    if (lineasDe(v, LETRA_VINETAS, ANCHO_TEXTO - 0.4) <= capacidad) return [v]
    const partes: string[] = []
    let actual = ''
    for (const palabra of v.split(/\s+/)) {
      const siguiente = actual ? `${actual} ${palabra}` : palabra
      if (siguiente.length > capacidad * porLinea && actual) { partes.push(actual); actual = palabra } else actual = siguiente
    }
    if (actual) partes.push(actual)
    return partes
  })
  const paginas: string[][] = []
  let pagina: string[] = []
  let usadas = 0
  for (const p of piezas) {
    const lineas = lineasDe(p, LETRA_VINETAS, ANCHO_TEXTO - 0.4)
    if (pagina.length > 0 && usadas + lineas > capacidad) { paginas.push(pagina); pagina = []; usadas = 0 }
    pagina.push(p)
    usadas += lineas
  }
  if (pagina.length > 0) paginas.push(pagina)
  return paginas
}

function agregarVinetas(slide: PptxGenJS.Slide, vinetas: string[], y: number, alto: number) {
  slide.addText(
    vinetas.map((texto) => ({ text: texto, options: { bullet: true, breakLine: true } })),
    { x: 0.5, y, w: ANCHO_TEXTO, h: alto, fontSize: LETRA_VINETAS, color: '374151', valign: 'top' }
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function generarPptxBuffer(texto: string, perfil: any, zonaHoraria: string | null): Promise<Buffer> {
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_16x9'
  const lineas = analizarContenido(texto)
  const diapositivas = agruparEnDiapositivas(lineas)
  const titulo = quitarEmoji(extraerTitulo(texto))
  // Grado y grupo como en Word y PDF (el grado ya trae "°"). Escuela y
  // docente solo con datos reales del perfil: sin textos genéricos.
  const enc = prepararEncabezado(perfil, zonaHoraria)
  const datosInstitucionales = `${perfil?.escuela || ''}\nDocente: ${perfil?.nombre || ''} · Grado ${enc.grado} Grupo ${enc.grupo}\n${formatearFecha(new Date(), zonaHoraria, { day: 'numeric', month: 'long', year: 'numeric' })}`
  const contenidoDelTitulo = (diapositivas[0]?.contenido ?? []).map(quitarEmoji).filter(Boolean)

  // Presentación de UNA sola diapositiva (solo el título y su contenido,
  // sin secciones): título, contenido útil y datos institucionales juntos,
  // si caben; si no, sigue el formato normal (portada + contenido).
  const TITULO_UNICA = { y: 0.3, h: 0.9 }
  const VINETAS_UNICA = { y: 1.3, h: 3.2 }
  if (diapositivas.length === 1 && contenidoDelTitulo.length > 0 && paginarVinetas(contenidoDelTitulo, VINETAS_UNICA.h).length === 1) {
    const unica = pptx.addSlide()
    unica.addText(titulo, { x: 0.5, ...TITULO_UNICA, w: ANCHO_TEXTO, fontSize: letraQueCabe(titulo, TITULO_UNICA.h, 28, 16), bold: true, color: '166534', valign: 'top' })
    agregarVinetas(unica, contenidoDelTitulo, VINETAS_UNICA.y, VINETAS_UNICA.h)
    unica.addText(datosInstitucionales, { x: 0.5, y: 4.65, w: ANCHO_TEXTO, h: 0.8, fontSize: 11, color: '6B7280', align: 'center', valign: 'bottom' })
    const arrayBuffer = await pptx.write({ outputType: 'nodebuffer' })
    return arrayBuffer as Buffer
  }

  // Diapositiva de portada.
  const portada = pptx.addSlide()
  portada.background = { color: '166534' }
  portada.addText(titulo, { x: 0.5, y: 1.2, w: ANCHO_TEXTO, h: 2.4, fontSize: letraQueCabe(titulo, 2.4, 32, 18), bold: true, color: 'FFFFFF', align: 'center', valign: 'middle' })
  portada.addText(datosInstitucionales, { x: 0.5, y: 3.9, w: ANCHO_TEXTO, h: 1.3, fontSize: 14, color: 'DCFCE7', align: 'center' })

  // Una diapositiva por sección (DÍA 1, DÍA 2... o CRITERIO 1, CRITERIO 2...).
  // El título principal (primer grupo) ya es la portada: solo tiene
  // diapositiva propia si trae contenido antes de la primera sección.
  // Si el contenido de una sección no cabe, sigue en otra diapositiva
  // con el mismo título y "(continuación)".
  const TITULO = { y: 0.3, h: 1.0 }
  const VINETAS = { y: 1.4, h: 3.9 }
  for (const d of diapositivas.filter((d, i) => i > 0 || d.contenido.some((t) => quitarEmoji(t)))) {
    const tituloSeccion = quitarEmoji(d.titulo)
    const contenidoLimpio = d.contenido.map(quitarEmoji).filter(Boolean)
    const paginas = contenidoLimpio.length > 0 ? paginarVinetas(contenidoLimpio, VINETAS.h) : [[]]
    paginas.forEach((pagina, i) => {
      const slide = pptx.addSlide()
      const rotulo = i === 0 ? tituloSeccion : `${tituloSeccion} (continuación)`
      slide.addText(rotulo, { x: 0.5, ...TITULO, w: ANCHO_TEXTO, fontSize: letraQueCabe(rotulo, TITULO.h, 24, 14), bold: true, color: '166534', valign: 'top' })
      if (pagina.length > 0) agregarVinetas(slide, pagina, VINETAS.y, VINETAS.h)
    })
  }

  const arrayBuffer = await pptx.write({ outputType: 'nodebuffer' })
  return arrayBuffer as Buffer
}

export function nombreArchivoPptx(titulo: string): string {
  const slug = titulo
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'Presentacion'
  return `${slug}.pptx`
}
