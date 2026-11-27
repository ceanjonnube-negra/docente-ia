// lib/documentGen/pdfPlaneacion.ts
//
// PDF de una planeación didáctica con la maqueta compartida
// (maquetaDocumento.ts), la paginación por bloques (paginacion.ts) y la
// identidad visual compartida (estiloDocumento.ts). Solo dibuja: el
// contenido es exactamente el canónico. Datos institucionales, versión y
// firma: únicamente los disponibles (nunca se inventan).

import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib'
import { construirMaqueta, versionDeMaqueta, type BloqueMaqueta } from './maquetaDocumento'
import { envolver, paginarCompacto, type Caja, type Fragmento, type Fuente, type Medidor, type Token } from './paginacion'
import { COLORES, ESPACIOS, NIVELES_COMPACTACION, TIPOGRAFIA, type ColorRGB, type NivelCompactacion } from './estiloDocumento'
import { sanearParaWinAnsi } from './textoPdf'
import type { EncabezadoDocumento } from './encabezadoDocumento'

const ANCHO = 612
const ALTO = 792
const MARGEN_X = 56
const MARGEN_SUP = 50
const MARGEN_INF = 58
const ANCHO_UTIL = ANCHO - MARGEN_X * 2
const SANGRIA_SESION = 14

const PANEL_RELLENO = 10
const PANEL_COLUMNAS = 20
const PANEL_FILAS = 6
type Panel = { filas: { etiqueta: string; valor: Token[][]; ancho: number }[][]; altos: number[]; alturaValor: number; alturaEtiqueta: number; alto: number }

type Meta = {
  tipo: BloqueMaqueta['tipo'] | 'firma'
  tamano: number
  sangria: number
  centrado?: boolean
  marcador?: 'punto' | 'cuadro' | { numero: string }
  barra?: boolean
  fondo?: boolean
  reglaInferior?: boolean
  panel?: Panel
  sesion?: string // número de la sesión a la que pertenece el bloque
  inicioSesion?: boolean
}

// Las flechas no existen en WinAnsi: se escriben con ASCII en lugar de
// perderse (p. ej. «causa → efecto»).
const paraPdf = (t: string) => sanearParaWinAnsi(t.replace(/[→⇒]/g, '->').replace(/[←⇐]/g, '<-').replace(/[↔⇔]/g, '<->'))
const color = (c: ColorRGB) => rgb(c[0], c[1], c[2])
const TONOS: Record<string, ColorRGB> = { acento: COLORES.acento, suave: COLORES.suave, tenue: COLORES.tenue, titulo: COLORES.titulo }

// Datos del encabezado que existen de verdad (prepararEncabezado usa
// "Escuela" y "Docente" cuando el perfil no los tiene: aquí se omiten).
function real(valor: string | null | undefined, marcador?: string): string | null {
  const v = (valor ?? '').trim()
  return v && v !== marcador ? v : null
}

export type ResultadoPdfPlaneacion = { bytes: Uint8Array; paginas: Fragmento<Meta>[][]; nivel: NivelCompactacion }

export async function generarPdfPlaneacion(texto: string, enc: EncabezadoDocumento, conFirma: boolean): Promise<ResultadoPdfPlaneacion> {
  const pdf = await PDFDocument.create()
  const fuentes: Record<Fuente, PDFFont> = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    negrita: await pdf.embedFont(StandardFonts.HelveticaBold),
    cursiva: await pdf.embedFont(StandardFonts.HelveticaOblique),
  }
  const medir: Medidor = (t, f, tam) => fuentes[f].widthOfTextAtSize(paraPdf(t), tam)
  const linea = (tam: number) => tam * TIPOGRAFIA.interlineado // encabezado y pie (fijos)

  const bloques = construirMaqueta(texto)
  const version = versionDeMaqueta(bloques)
  const escuela = real(enc.escuela, 'Escuela')
  const docente = real(enc.docente, 'Docente')
  const grado = real(enc.grado)
  const grupo = real(enc.grupo)

  // Panel de datos generales: etiqueta pequeña en versalitas sobre su
  // valor; dos datos breves comparten fila, uno largo ocupa el ancho.
  const componerPanel = (datos: { etiqueta: string; valor: string }[], interlineado: number): Panel => {
    const anchoInterior = ANCHO_UTIL - PANEL_RELLENO * 2
    const anchoMitad = (anchoInterior - PANEL_COLUMNAS) / 2
    const lv = TIPOGRAFIA.datoValor * interlineado
    const le = TIPOGRAFIA.datoEtiqueta * 1.5
    const celda = (d: { etiqueta: string; valor: string }, ancho: number) => ({ etiqueta: d.etiqueta.toUpperCase(), valor: envolver([{ texto: d.valor, fuente: 'regular' }], ancho, medir, TIPOGRAFIA.datoValor), ancho })
    const breve = (d: { etiqueta: string; valor: string }) => envolver([{ texto: d.valor, fuente: 'regular' }], anchoMitad, medir, TIPOGRAFIA.datoValor).length === 1
    const filas: Panel['filas'] = []
    for (let i = 0; i < datos.length; i++) {
      if (breve(datos[i]) && datos[i + 1] && breve(datos[i + 1])) { filas.push([celda(datos[i], anchoMitad), celda(datos[i + 1], anchoMitad)]); i++ }
      else filas.push([celda(datos[i], anchoInterior)])
    }
    const altos = filas.map((f) => le + Math.max(...f.map((c) => c.valor.length)) * lv)
    return { filas, altos, alturaValor: lv, alturaEtiqueta: le, alto: PANEL_RELLENO * 2 + altos.reduce((a, x) => a + x, 0) + PANEL_FILAS * (filas.length - 1) }
  }

  // --- Cajas (para un nivel de compactación) -------------------------
  const construirCajas = (nivel: NivelCompactacion): Caja<Meta>[] => {
  const linea = (tam: number) => tam * nivel.interlineado
  const e = (x: { antes: number; despues: number }) => ({ antes: x.antes * nivel.espacios, despues: x.despues * nivel.espacios })
  const cajas: Caja<Meta>[] = []
  // Grupo "indicadores": título de sección seguido de indicadores
  // numerados, con su nota y (si es lo último) la firma.
  let ultimoGrupo = 0
  let grupoActivo: number | undefined
  let sesionActual: string | undefined
  const agregar = (tokens: Token[], metaBase: Meta, opciones: { antes: number; despues: number; unir?: boolean; indivisible?: boolean; ancho?: number }) => {
    const meta: Meta = { ...metaBase, ...(sesionActual ? { sesion: sesionActual } : {}) }
    const ancho = opciones.ancho ?? ANCHO_UTIL - meta.sangria
    cajas.push({ lineas: envolver(tokens, ancho, medir, meta.tamano), interlineado: linea(meta.tamano), antes: opciones.antes, despues: opciones.despues, unirConSiguiente: !!opciones.unir, indivisible: !!opciones.indivisible, grupo: grupoActivo, meta })
  }
  bloques.forEach((b, i) => {
    // Datos generales consecutivos: un solo panel en dos columnas.
    if (b.tipo === 'dato' && bloques[i - 1]?.tipo !== 'dato') {
      const datos: { etiqueta: string; valor: string }[] = []
      for (let j = i; bloques[j]?.tipo === 'dato'; j++) {
        const d = bloques[j] as Extract<BloqueMaqueta, { tipo: 'dato' }>
        datos.push({ etiqueta: d.etiqueta, valor: d.valor })
      }
      const panel = componerPanel(datos, nivel.interlineado)
      cajas.push({ lineas: [[]], interlineado: panel.alto, antes: e(ESPACIOS.panel).antes, despues: e(ESPACIOS.panel).despues, unirConSiguiente: false, indivisible: true, meta: { tipo: 'dato', tamano: 0, sangria: 0, panel } })
    }
    if (b.tipo === 'sesion') sesionActual = b.numero
    else if (b.tipo === 'seccion') sesionActual = undefined
    if (b.tipo === 'seccion') grupoActivo = bloques[i + 1]?.tipo === 'numerado' ? ++ultimoGrupo : undefined
    else if (b.tipo !== 'numerado' && b.tipo !== 'nota') grupoActivo = undefined
    agregarBloque(b)
  })
  function agregarBloque(b: BloqueMaqueta) {
    switch (b.tipo) {
      case 'titulo':
        agregar([{ texto: b.texto, fuente: 'negrita', tono: 'titulo' }], { tipo: 'titulo', tamano: TIPOGRAFIA.titulo, sangria: 0, centrado: true }, { ...e(ESPACIOS.titulo), unir: true })
        break
      case 'dato':
        break // se agrupan en el panel de datos generales
      case 'seccion':
        agregar([{ texto: b.texto.toUpperCase(), fuente: 'negrita', tono: 'acento' }], { tipo: 'seccion', tamano: TIPOGRAFIA.seccion, sangria: 0, reglaInferior: true }, { ...e(ESPACIOS.seccion), unir: true })
        break
      case 'sesion':
        agregar([{ texto: `DÍA ${b.numero}`, fuente: 'negrita', tono: 'acento' }], { tipo: 'sesion', tamano: TIPOGRAFIA.sesionEtiqueta, sangria: 10, barra: true, inicioSesion: true }, { antes: e(ESPACIOS.sesion).antes, despues: 0, unir: true })
        if (b.titulo) agregar([{ texto: b.titulo, fuente: 'negrita', tono: 'titulo' }], { tipo: 'sesion', tamano: TIPOGRAFIA.sesionTitulo, sangria: 10, barra: true }, { antes: 0, despues: b.fecha ? 0 : e(ESPACIOS.sesion).despues, unir: true })
        if (b.fecha) agregar([{ texto: 'Fecha estimada:', fuente: 'negrita', tono: 'suave' }, { texto: b.fecha, fuente: 'regular', tono: 'suave' }], { tipo: 'sesion', tamano: TIPOGRAFIA.sesionDatos, sangria: 10, barra: true }, { antes: 0, despues: e(ESPACIOS.sesion).despues, unir: true })
        break
      case 'momento':
        agregar([{ texto: b.nombre, fuente: 'negrita', tono: 'titulo' }, ...(b.minutos !== null ? [{ texto: `· ${b.minutos} min`, fuente: 'regular' as const, tono: 'tenue' }] : [])], { tipo: 'momento', tamano: TIPOGRAFIA.momento, sangria: SANGRIA_SESION, marcador: 'cuadro' }, { ...e(ESPACIOS.momento), unir: true })
        break
      case 'parrafo': {
        const tokens: Token[] = b.etiqueta && b.valor ? [{ texto: `${b.etiqueta}:`, fuente: 'negrita' }, { texto: b.valor, fuente: 'regular' }] : [{ texto: b.texto, fuente: 'regular' }]
        agregar(tokens, { tipo: 'parrafo', tamano: TIPOGRAFIA.cuerpo, sangria: b.enSesion ? SANGRIA_SESION : 0 }, e(ESPACIOS.parrafo))
        break
      }
      case 'item':
        agregar([{ texto: b.texto, fuente: 'regular' }], { tipo: 'item', tamano: TIPOGRAFIA.cuerpo, sangria: (b.enSesion ? SANGRIA_SESION : 0) + 12, marcador: 'punto' }, { ...e(ESPACIOS.item), indivisible: true })
        break
      case 'numerado':
        agregar([{ texto: b.texto, fuente: 'regular' }], { tipo: 'numerado', tamano: TIPOGRAFIA.cuerpo, sangria: 18, marcador: { numero: b.numero } }, { ...e(ESPACIOS.numerado), indivisible: true })
        break
      case 'evaluacion':
        agregar([{ texto: 'Evaluación:', fuente: 'negrita', tono: 'acento' }, { texto: b.texto, fuente: 'regular' }], { tipo: 'evaluacion', tamano: TIPOGRAFIA.evaluacion, sangria: SANGRIA_SESION + 8, fondo: true }, { ...e(ESPACIOS.evaluacion), indivisible: true, ancho: ANCHO_UTIL - SANGRIA_SESION - 16 })
        break
      case 'nota':
        agregar([{ texto: b.texto, fuente: 'cursiva', tono: 'suave' }], { tipo: 'nota', tamano: TIPOGRAFIA.nota, sangria: 0 }, e(ESPACIOS.nota))
        break
    }
  }
  // Firma: solo con datos reales; siempre comparte página con el final.
  if (conFirma) {
    if (cajas.length) cajas[cajas.length - 1].unirConSiguiente = true
    const lineasFirma: Token[][] = [[{ texto: '______________________________', fuente: 'regular', tono: 'tenue' }]]
    if (docente) lineasFirma.push([{ texto: docente, fuente: 'negrita' }])
    lineasFirma.push([{ texto: 'Docente de grupo', fuente: 'regular', tono: 'suave' }])
    cajas.push({ lineas: lineasFirma, interlineado: linea(10), antes: e(ESPACIOS.firma).antes, despues: 0, unirConSiguiente: false, indivisible: true, grupo: cajas[cajas.length - 1]?.grupo, meta: { tipo: 'firma', tamano: 10, sangria: 0, centrado: true } })
  }
  return cajas
  }

  // --- Encabezados y pie -------------------------------------------
  const lineasEscuela = [
    [docente ? `Docente: ${docente}` : null].filter(Boolean).join(''),
    [grado ? `Grado: ${grado}` : null, grupo ? `Grupo: ${grupo}` : null, real(enc.cicloEscolar) ? `Ciclo escolar: ${enc.cicloEscolar}` : null].filter(Boolean).join('   ·   '),
    [real(enc.lugar), real(enc.fecha) ? `Fecha: ${enc.fecha}` : null].filter(Boolean).join('   ·   '),
  ].filter(Boolean)
  const altoEncabezadoCompleto = (escuela ? linea(TIPOGRAFIA.escuela) : 0) + lineasEscuela.length * linea(TIPOGRAFIA.datosEscuela) + 16
  const altoEncabezadoCompacto = linea(TIPOGRAFIA.encabezadoCompacto) + 14
  const altoContenido = ALTO - MARGEN_SUP - MARGEN_INF
  const { paginas, nivel } = paginarCompacto(NIVELES_COMPACTACION, construirCajas, (p) => altoContenido - (p === 0 ? altoEncabezadoCompleto : altoEncabezadoCompacto))

  // --- Dibujo -------------------------------------------------------
  const dibujarTokens = (pg: PDFPage, tokens: Token[], x: number, yBase: number, tam: number) => {
    let cx = x
    tokens.forEach((t, i) => {
      const txt = paraPdf(t.texto)
      if (i > 0) cx += medir(' ', t.fuente, tam)
      pg.drawText(txt, { x: cx, y: yBase, size: tam, font: fuentes[t.fuente], color: color(t.tono ? TONOS[t.tono] ?? COLORES.texto : COLORES.texto) })
      cx += medir(txt, t.fuente, tam)
    })
  }
  const anchoTokens = (tokens: Token[], tam: number) => tokens.reduce((w, t, i) => w + (i ? medir(' ', t.fuente, tam) : 0) + medir(t.texto, t.fuente, tam), 0)
  const centrado = (pg: PDFPage, texto: string, fuente: Fuente, tam: number, y: number, c: ColorRGB) => {
    const t = paraPdf(texto)
    pg.drawText(t, { x: (ANCHO - medir(t, fuente, tam)) / 2, y, size: tam, font: fuentes[fuente], color: color(c) })
  }

  const total = paginas.length
  paginas.forEach((fragmentos, p) => {
    const pg = pdf.addPage([ANCHO, ALTO])
    let tope = ALTO - MARGEN_SUP
    if (p === 0) {
      if (escuela) { centrado(pg, escuela, 'negrita', TIPOGRAFIA.escuela, tope - TIPOGRAFIA.escuela, COLORES.titulo); tope -= linea(TIPOGRAFIA.escuela) }
      for (const l of lineasEscuela) { centrado(pg, l, 'regular', TIPOGRAFIA.datosEscuela, tope - TIPOGRAFIA.datosEscuela, COLORES.suave); tope -= linea(TIPOGRAFIA.datosEscuela) }
      tope -= 6
      pg.drawLine({ start: { x: MARGEN_X, y: tope }, end: { x: ANCHO - MARGEN_X, y: tope }, thickness: 1.2, color: color(COLORES.acento) })
      tope -= 10
    } else {
      const izquierda = [escuela, [grado, grupo].filter(Boolean).join(' ')].filter(Boolean).join('  ·  ')
      if (izquierda) dibujarTokens(pg, [{ texto: izquierda, fuente: 'regular', tono: 'tenue' }], MARGEN_X, tope - TIPOGRAFIA.encabezadoCompacto, TIPOGRAFIA.encabezadoCompacto)
      // Sesión que viene de la página anterior: referencia discreta en el
      // encabezado (no ocupa espacio ni altera la paginación).
      const primero = fragmentos[0]?.caja.meta
      const derecha = primero?.sesion && !primero.inicioSesion ? `Día ${primero.sesion} · Continuación` : 'Planeación didáctica'
      dibujarTokens(pg, [{ texto: derecha, fuente: 'regular', tono: 'tenue' }], ANCHO - MARGEN_X - medir(derecha, 'regular', TIPOGRAFIA.encabezadoCompacto), tope - TIPOGRAFIA.encabezadoCompacto, TIPOGRAFIA.encabezadoCompacto)
      tope -= linea(TIPOGRAFIA.encabezadoCompacto) + 4
      pg.drawLine({ start: { x: MARGEN_X, y: tope }, end: { x: ANCHO - MARGEN_X, y: tope }, thickness: 0.5, color: color(COLORES.borde) })
      tope -= 10
    }

    for (const f of fragmentos) {
      const m = f.caja.meta
      const yArriba = tope - f.y
      const x = MARGEN_X + m.sangria
      if (m.fondo) {
        pg.drawRectangle({ x: x - 8, y: yArriba - f.alto - 3, width: ANCHO - MARGEN_X - (x - 8), height: f.alto + 6, color: color(COLORES.fondoEvaluacion) })
        pg.drawRectangle({ x: x - 8, y: yArriba - f.alto - 3, width: 2, height: f.alto + 6, color: color(COLORES.acento) })
      }
      if (m.panel) {
        const pn = m.panel
        pg.drawRectangle({ x: MARGEN_X, y: yArriba - pn.alto, width: ANCHO_UTIL, height: pn.alto, color: color(COLORES.fondoPanel), borderColor: color(COLORES.borde), borderWidth: 0.6 })
        pg.drawRectangle({ x: MARGEN_X, y: yArriba - pn.alto, width: 2.5, height: pn.alto, color: color(COLORES.acento) })
        let yf = yArriba - PANEL_RELLENO
        pn.filas.forEach((fila, k) => {
          let xc = MARGEN_X + PANEL_RELLENO
          for (const c of fila) {
            dibujarTokens(pg, [{ texto: c.etiqueta, fuente: 'negrita', tono: 'acento' }], xc, yf - TIPOGRAFIA.datoEtiqueta, TIPOGRAFIA.datoEtiqueta)
            c.valor.forEach((ln, j) => dibujarTokens(pg, ln.map((t) => ({ ...t, tono: 'titulo' })), xc, yf - pn.alturaEtiqueta - j * pn.alturaValor - TIPOGRAFIA.datoValor, TIPOGRAFIA.datoValor))
            xc += c.ancho + PANEL_COLUMNAS
          }
          yf -= pn.altos[k] + PANEL_FILAS
        })
        continue
      }
      if (m.barra) pg.drawRectangle({ x: MARGEN_X, y: yArriba - f.alto - (f.ultimo ? 2 : 0), width: 3, height: f.alto + (f.ultimo ? 2 : 0), color: color(COLORES.acento) })
      for (let i = f.desde; i < f.hasta; i++) {
        const tokens = f.caja.lineas[i]
        const yBase = yArriba - (i - f.desde) * f.caja.interlineado - m.tamano
        if (i === 0 && m.marcador === 'punto') pg.drawCircle({ x: x - 7, y: yBase + m.tamano * 0.32, size: 1.7, color: color(COLORES.acento) })
        if (i === 0 && m.marcador === 'cuadro') pg.drawRectangle({ x: MARGEN_X + 4, y: yBase + 1, width: 5, height: 5, color: color(COLORES.acento) })
        if (i === 0 && m.marcador && typeof m.marcador === 'object') dibujarTokens(pg, [{ texto: `${m.marcador.numero}.`, fuente: 'negrita', tono: 'acento' }], MARGEN_X + 2, yBase, m.tamano)
        const xi = m.centrado ? (ANCHO - anchoTokens(tokens, m.tamano)) / 2 : x
        dibujarTokens(pg, tokens, xi, yBase, m.tamano)
      }
      if (m.reglaInferior && f.ultimo) {
        const yR = yArriba - f.alto - 2
        pg.drawLine({ start: { x: MARGEN_X, y: yR }, end: { x: ANCHO - MARGEN_X, y: yR }, thickness: 0.6, color: color(COLORES.acentoClaro) })
      }
    }

    // Pie: versión real (si la hay) y numeración.
    const yPie = MARGEN_INF - 30
    pg.drawLine({ start: { x: MARGEN_X, y: yPie + 12 }, end: { x: ANCHO - MARGEN_X, y: yPie + 12 }, thickness: 0.5, color: color(COLORES.borde) })
    const izquierda = version ? `Planeación didáctica  ·  Versión ${version}` : 'Planeación didáctica'
    dibujarTokens(pg, [{ texto: izquierda, fuente: 'regular', tono: 'tenue' }], MARGEN_X, yPie, TIPOGRAFIA.pie)
    const numero = `Página ${p + 1} de ${total}`
    dibujarTokens(pg, [{ texto: numero, fuente: 'regular', tono: 'tenue' }], ANCHO - MARGEN_X - medir(numero, 'regular', TIPOGRAFIA.pie), yPie, TIPOGRAFIA.pie)
  })

  return { bytes: await pdf.save(), paginas, nivel }
}
