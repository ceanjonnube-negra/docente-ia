// lib/documentGen/wordPlaneacion.ts
//
// Word de una planeación didáctica con la MISMA maqueta semántica
// (maquetaDocumento.ts) y el mismo estilo (estiloDocumento.ts) que el PDF.
// Word pagina por sí mismo: aquí solo se declaran las reglas nativas
// (keepNext, keepLines, widowControl, filas que no se parten), así el
// documento sigue siendo completamente editable. Contenido canónico
// íntegro; datos institucionales, versión y firma solo si existen.

import {
  AlignmentType, BorderStyle, Document, Footer, Header, PageNumber, Paragraph, ShadingType,
  Table, TableCell, TableRow, TabStopType, TextRun, WidthType, LevelFormat,
} from 'docx'
import { construirMaqueta, versionDeMaqueta, type BloqueMaqueta } from './maquetaDocumento'
import { ESPACIOS, HEX, NIVELES_COMPACTACION, TIPOGRAFIA } from './estiloDocumento'
import type { EncabezadoDocumento } from './encabezadoDocumento'

const FUENTE = 'Arial'
const tam = (pt: number) => Math.round(pt * 2) // medios puntos
const tw = (pt: number) => Math.round(pt * 20) // twips
// Word pagina por sí mismo (no puede elegir nivel como el PDF): usa el
// nivel compacto intermedio del estilo compartido. El interlineado se
// convierte a la línea sencilla de Arial (≈1.15 × tamaño).
const NIVEL = NIVELES_COMPACTACION[2]
const INTERLINEADO = Math.round((NIVEL.interlineado / 1.15) * 240)
const esc = (e: { antes: number; despues: number }) => ({ antes: e.antes * NIVEL.espacios, despues: e.despues * NIVEL.espacios })
const MARGEN_X = tw(50)
const ANCHO_UTIL = 12240 - MARGEN_X * 2
const SANGRIA_SESION = tw(12)
const VINETAS = 'vinetas-planeacion'

type Run = { texto: string; negrita?: boolean; cursiva?: boolean; color?: string; tamano: number; versalitas?: boolean }
const run = (r: Run) => new TextRun({ text: r.texto, bold: r.negrita, italics: r.cursiva, color: r.color ?? HEX.texto, size: tam(r.tamano), font: FUENTE, smallCaps: r.versalitas })

function real(valor: string | null | undefined, marcador?: string): string | null {
  const v = (valor ?? '').trim()
  return v && v !== marcador ? v : null
}

const bordeAcento = { style: BorderStyle.SINGLE, size: 18, color: HEX.acento, space: 8 }
const sinBorde = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }

export function construirWordPlaneacion(texto: string, enc: EncabezadoDocumento, conFirma: boolean): Document {
  const bloques = construirMaqueta(texto)
  const version = versionDeMaqueta(bloques)
  const escuela = real(enc.escuela, 'Escuela')
  const docente = real(enc.docente, 'Docente')
  const grado = real(enc.grado)
  const grupo = real(enc.grupo)

  const cuerpo: (Paragraph | Table)[] = []
  const espacio = (e: { antes: number; despues: number }) => ({ before: tw(esc(e).antes), after: tw(esc(e).despues), line: INTERLINEADO })

  // Indicadores: el título viaja con el primero y los dos últimos con la
  // firma; los de en medio pueden repartirse entre páginas (ninguno se
  // parte), así no quedan grandes huecos.
  let enIndicadores = false
  const ultimoNumerado = bloques.map((b) => b.tipo).lastIndexOf('numerado')
  // El último bloque de contenido va unido a la firma.
  let unirConFirma = false

  const parrafo = (runs: Run[], o: { espacio: { antes: number; despues: number }; sangria?: number; colgante?: number; unir?: boolean; sinPartir?: boolean; centrado?: boolean; borde?: 'sesion' | 'seccion' | 'evaluacion'; vineta?: boolean }) =>
    new Paragraph({
      children: runs.map(run),
      spacing: espacio(o.espacio),
      alignment: o.centrado ? AlignmentType.CENTER : AlignmentType.LEFT,
      indent: o.sangria || o.colgante ? { left: (o.sangria ?? 0) + (o.colgante ?? 0), hanging: o.colgante } : undefined,
      keepNext: o.unir || unirConFirma,
      keepLines: o.sinPartir,
      widowControl: true,
      numbering: o.vineta ? { reference: VINETAS, level: 0 } : undefined,
      border:
        o.borde === 'sesion' ? { left: bordeAcento }
        : o.borde === 'seccion' ? { bottom: { style: BorderStyle.SINGLE, size: 6, color: HEX.acentoClaro, space: 3 } }
        : o.borde === 'evaluacion' ? { left: { ...bordeAcento, size: 12, space: 6 } }
        : undefined,
      shading: o.borde === 'evaluacion' ? { type: ShadingType.CLEAR, color: 'auto', fill: HEX.fondoEvaluacion } : undefined,
    })

  // Panel de datos generales: tabla editable, dos datos breves por fila.
  const panel = (datos: { etiqueta: string; valor: string }[]) => {
    const breve = (d: { valor: string }) => d.valor.length <= 42
    const filas: { etiqueta: string; valor: string }[][] = []
    for (let i = 0; i < datos.length; i++) {
      if (breve(datos[i]) && datos[i + 1] && breve(datos[i + 1])) { filas.push([datos[i], datos[i + 1]]); i++ }
      else filas.push([datos[i]])
    }
    const celda = (d: { etiqueta: string; valor: string } | null, span: number, ultimaFila: boolean) => new TableCell({
      columnSpan: span,
      width: { size: span === 2 ? ANCHO_UTIL : ANCHO_UTIL / 2, type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, color: 'auto', fill: HEX.fondoPanel },
      margins: { top: tw(2), bottom: tw(2), left: tw(8), right: tw(8) },
      borders: { top: sinBorde, bottom: sinBorde, left: sinBorde, right: sinBorde },
      children: d ? [
        new Paragraph({ children: [run({ texto: d.etiqueta.toUpperCase(), negrita: true, color: HEX.acento, tamano: TIPOGRAFIA.datoEtiqueta })], spacing: { after: 0 }, keepNext: true }),
        new Paragraph({ children: [run({ texto: d.valor, color: HEX.titulo, tamano: TIPOGRAFIA.datoValor })], spacing: { after: 0 }, keepNext: !ultimaFila }),
      ] : [new Paragraph({ children: [] })],
    })
    return new Table({
      width: { size: ANCHO_UTIL, type: WidthType.DXA },
      columnWidths: [ANCHO_UTIL / 2, ANCHO_UTIL / 2],
      borders: {
        top: { style: BorderStyle.SINGLE, size: 4, color: HEX.borde }, bottom: { style: BorderStyle.SINGLE, size: 4, color: HEX.borde },
        left: { style: BorderStyle.SINGLE, size: 18, color: HEX.acento }, right: { style: BorderStyle.SINGLE, size: 4, color: HEX.borde },
        insideHorizontal: sinBorde, insideVertical: sinBorde,
      },
      rows: filas.map((f, k) => new TableRow({
        cantSplit: true,
        children: f.length === 2 ? [celda(f[0], 1, k === filas.length - 1), celda(f[1], 1, k === filas.length - 1)] : [celda(f[0], 2, k === filas.length - 1)],
      })),
    })
  }

  // Indicador que debe ir con el siguiente: el primero (con el título ya
  // unido) y los que preceden a la firma (penúltimo y último, más la nota).
  const numeradoUnido = (i: number) => {
    const primero = bloques[i - 1]?.tipo === 'seccion'
    const cercaDelFinal = conFirma && i >= ultimoNumerado - 1 && bloques.slice(i + 1).every((x) => x.tipo === 'numerado' || x.tipo === 'nota')
    return primero || cercaDelFinal
  }

  bloques.forEach((b, i) => {
    if (b.tipo === 'seccion') enIndicadores = bloques[i + 1]?.tipo === 'numerado'
    else if (b.tipo !== 'numerado' && b.tipo !== 'nota') enIndicadores = false
    unirConFirma = conFirma && i === bloques.length - 1
    agregar(b, i)
  })

  function agregar(b: BloqueMaqueta, i: number) {
    switch (b.tipo) {
      case 'titulo':
        cuerpo.push(parrafo([{ texto: b.texto, negrita: true, color: HEX.titulo, tamano: TIPOGRAFIA.titulo }], { espacio: ESPACIOS.titulo, centrado: true, unir: true }))
        break
      case 'dato':
        if (bloques[i - 1]?.tipo !== 'dato') {
          const datos: { etiqueta: string; valor: string }[] = []
          for (let j = i; bloques[j]?.tipo === 'dato'; j++) {
            const d = bloques[j] as Extract<BloqueMaqueta, { tipo: 'dato' }>
            datos.push({ etiqueta: d.etiqueta, valor: d.valor })
          }
          cuerpo.push(panel(datos))
          cuerpo.push(new Paragraph({ children: [], spacing: { before: 0, after: 0, line: 100 } }))
        }
        break
      case 'seccion':
        cuerpo.push(parrafo([{ texto: b.texto.toUpperCase(), negrita: true, color: HEX.acento, tamano: TIPOGRAFIA.seccion }], { espacio: ESPACIOS.seccion, unir: true, borde: 'seccion' }))
        break
      case 'sesion':
        cuerpo.push(parrafo([{ texto: `DÍA ${b.numero}`, negrita: true, color: HEX.acento, tamano: TIPOGRAFIA.sesionEtiqueta }], { espacio: { antes: ESPACIOS.sesion.antes, despues: 0 }, unir: true, borde: 'sesion' }))
        if (b.titulo) cuerpo.push(parrafo([{ texto: b.titulo, negrita: true, color: HEX.titulo, tamano: TIPOGRAFIA.sesionTitulo }], { espacio: { antes: 0, despues: b.fecha ? 0 : ESPACIOS.sesion.despues }, unir: true, borde: 'sesion' }))
        if (b.fecha) cuerpo.push(parrafo([{ texto: 'Fecha estimada: ', negrita: true, color: HEX.suave, tamano: TIPOGRAFIA.sesionDatos }, { texto: b.fecha, color: HEX.suave, tamano: TIPOGRAFIA.sesionDatos }], { espacio: { antes: 0, despues: ESPACIOS.sesion.despues }, unir: true, borde: 'sesion' }))
        break
      case 'momento':
        cuerpo.push(parrafo([
          { texto: '■  ', color: HEX.acento, tamano: TIPOGRAFIA.momento - 2 },
          { texto: b.nombre, negrita: true, color: HEX.titulo, tamano: TIPOGRAFIA.momento },
          ...(b.minutos !== null ? [{ texto: `  ·  ${b.minutos} min`, color: HEX.tenue, tamano: TIPOGRAFIA.momento }] : []),
        ], { espacio: ESPACIOS.momento, unir: true }))
        break
      case 'parrafo': {
        const runs: Run[] = b.etiqueta && b.valor
          ? [{ texto: `${b.etiqueta}: `, negrita: true, tamano: TIPOGRAFIA.cuerpo }, { texto: b.valor, tamano: TIPOGRAFIA.cuerpo }]
          : [{ texto: b.texto, tamano: TIPOGRAFIA.cuerpo }]
        cuerpo.push(parrafo(runs, { espacio: ESPACIOS.parrafo, sangria: b.enSesion ? SANGRIA_SESION : 0 }))
        break
      }
      case 'item':
        // El penúltimo elemento de una lista va con el último: nunca queda
        // uno solo al inicio de una página.
        cuerpo.push(parrafo([{ texto: b.texto, tamano: TIPOGRAFIA.cuerpo }], { espacio: ESPACIOS.item, sangria: b.enSesion ? SANGRIA_SESION : 0, vineta: true, sinPartir: true, unir: bloques[i + 1]?.tipo === 'item' && bloques[i + 2]?.tipo !== 'item' }))
        break
      case 'numerado':
        // Número literal del texto canónico (no se renumera), con sangría francesa.
        cuerpo.push(new Paragraph({
          children: [run({ texto: `${b.numero}.`, negrita: true, color: HEX.acento, tamano: TIPOGRAFIA.cuerpo }), new TextRun({ text: '\t', font: FUENTE }), run({ texto: b.texto, tamano: TIPOGRAFIA.cuerpo })],
          spacing: espacio(ESPACIOS.numerado),
          indent: { left: tw(16), hanging: tw(16) },
          tabStops: [{ type: TabStopType.LEFT, position: tw(16) }],
          keepNext: (enIndicadores && numeradoUnido(i)) || unirConFirma,
          keepLines: true,
          widowControl: true,
        }))
        break
      case 'evaluacion':
        cuerpo.push(parrafo([{ texto: 'Evaluación: ', negrita: true, color: HEX.acento, tamano: TIPOGRAFIA.evaluacion }, { texto: b.texto, tamano: TIPOGRAFIA.evaluacion }], { espacio: ESPACIOS.evaluacion, sangria: SANGRIA_SESION, sinPartir: true, borde: 'evaluacion' }))
        break
      case 'nota':
        cuerpo.push(parrafo([{ texto: b.texto, cursiva: true, color: HEX.suave, tamano: TIPOGRAFIA.nota }], { espacio: ESPACIOS.nota }))
        break
    }
  }

  // Firma: solo datos reales; unida al último bloque de contenido.
  if (conFirma) {
    const firma = [
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: tw(esc(ESPACIOS.firma).antes), after: 0 }, keepNext: true, keepLines: true, children: [run({ texto: '______________________________', color: HEX.tenue, tamano: 10 })] }),
      ...(docente ? [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: tw(2), after: 0 }, keepNext: true, children: [run({ texto: docente, negrita: true, tamano: 10 })] })] : []),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 0 }, children: [run({ texto: 'Docente de grupo', color: HEX.suave, tamano: 10 })] }),
    ]
    cuerpo.push(...firma)
  }

  // Encabezados: completo en la primera página, compacto en las demás.
  const lineasEscuela = [
    docente ? `Docente: ${docente}` : '',
    [grado ? `Grado: ${grado}` : null, grupo ? `Grupo: ${grupo}` : null, real(enc.cicloEscolar) ? `Ciclo escolar: ${enc.cicloEscolar}` : null].filter(Boolean).join('   ·   '),
    [real(enc.lugar), real(enc.fecha) ? `Fecha: ${enc.fecha}` : null].filter(Boolean).join('   ·   '),
  ].filter(Boolean)
  const encabezadoCompleto = new Header({
    children: [
      ...(escuela ? [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 0 }, children: [run({ texto: escuela, negrita: true, color: HEX.titulo, tamano: TIPOGRAFIA.escuela })] })] : []),
      ...lineasEscuela.map((l, k) => new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 0 },
        border: k === lineasEscuela.length - 1 ? { bottom: { style: BorderStyle.SINGLE, size: 10, color: HEX.acento, space: 6 } } : undefined,
        children: [run({ texto: l, color: HEX.suave, tamano: TIPOGRAFIA.datosEscuela })],
      })),
    ],
  })
  const izquierda = [escuela, [grado, grupo].filter(Boolean).join(' ')].filter(Boolean).join('  ·  ')
  const encabezadoCompacto = new Header({
    children: [new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: ANCHO_UTIL }],
      border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: HEX.borde, space: 4 } },
      children: [run({ texto: izquierda, color: HEX.tenue, tamano: TIPOGRAFIA.encabezadoCompacto }), new TextRun({ text: '\t' }), run({ texto: 'Planeación didáctica', color: HEX.tenue, tamano: TIPOGRAFIA.encabezadoCompacto })],
    })],
  })
  // Pie: versión real (si la hay) y numeración automática de Word.
  const pie = () => new Footer({
    children: [new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: ANCHO_UTIL }],
      border: { top: { style: BorderStyle.SINGLE, size: 4, color: HEX.borde, space: 4 } },
      children: [
        run({ texto: version ? `Planeación didáctica  ·  Versión ${version}` : 'Planeación didáctica', color: HEX.tenue, tamano: TIPOGRAFIA.pie }),
        new TextRun({ text: '\t' }),
        new TextRun({ children: ['Página ', PageNumber.CURRENT, ' de ', PageNumber.TOTAL_PAGES], color: HEX.tenue, size: tam(TIPOGRAFIA.pie), font: FUENTE }),
      ],
    })],
  })

  return new Document({
    styles: { default: { document: { run: { font: FUENTE, size: tam(TIPOGRAFIA.cuerpo), color: HEX.texto } } } },
    numbering: {
      config: [{
        reference: VINETAS,
        levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { run: { color: HEX.acento }, paragraph: { indent: { left: tw(14), hanging: tw(10) } } } }],
      }],
    },
    sections: [{
      properties: {
        titlePage: true,
        page: { size: { width: 12240, height: 15840 }, margin: { top: tw(50), bottom: tw(50), left: MARGEN_X, right: MARGEN_X, header: tw(22), footer: tw(22) } },
      },
      headers: { first: encabezadoCompleto, default: encabezadoCompacto },
      footers: { first: pie(), default: pie() },
      children: cuerpo,
    }],
  })
}
