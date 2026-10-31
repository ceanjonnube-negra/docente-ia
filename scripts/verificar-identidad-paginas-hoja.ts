// scripts/verificar-identidad-paginas-hoja.ts
//
// Prueba aislada (sin credenciales, sin red, sin IA real) de la
// identidad por página de la hoja de evaluación:
//   - el PDF imprime SG-XXXX y "Página n de m" en todas las páginas, y
//     las posiciones "#" de cada página coinciden con
//     calcularRangosPaginasHoja / calcularCantidadPaginasHoja;
//   - la extracción visual devuelve código y página por imagen, en la
//     misma única llamada;
//   - validarIdentidadPaginasHoja rechaza páginas mezcladas, repetidas,
//     faltantes, en otro orden o ilegibles, y las hojas antiguas
//     multipágina; acepta páginas correctas y hojas antiguas de una
//     página con identidad verificable.
// Se ejecuta con `npx tsx scripts/verificar-identidad-paginas-hoja.ts`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import type Anthropic from '@anthropic-ai/sdk'
import { PDFArray, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib'
import { calcularCantidadPaginasHoja, calcularRangosPaginasHoja, generarHojaSeguimientoPdfBuffer } from '../lib/documentGen/generarHojaSeguimientoPdf'
import { analizarImagenesHojaEvaluacion } from '../lib/seguimiento/analisisHojaEvaluacion'
import { validarIdentidadPaginasHoja, type PaginaObservadaHoja } from '../lib/seguimiento/identidadPaginasHoja'
import type { IndicadorProyecto } from '../lib/seguimiento/tipos'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

// ---------- Textos de cada página del PDF real ----------

async function textosPorPagina(buffer: Buffer): Promise<string[][]> {
  const doc = await PDFDocument.load(buffer)
  return doc.getPages().map((p) => {
    const c = p.node.Contents()
    const flujos = c instanceof PDFArray ? c.asArray().map((r) => doc.context.lookup(r)) : [c]
    const contenido = flujos
      .map((f) => {
        const raw = f as PDFRawStream
        return Buffer.from(raw.dict.get(PDFName.of('Filter')) ? inflateSync(raw.contents) : raw.contents).toString('latin1')
      })
      .join('\n')
    return [...contenido.matchAll(/<([0-9A-F]*)> Tj/g)].map((m) => Buffer.from(m[1], 'hex').toString('latin1'))
  })
}

const INDICADORES: IndicadorProyecto[] = [1, 2, 3, 4, 5].map((i) => ({ indicador_especifico: `Indicador ${i}`, aspecto_general: 'autonomia' as const }))
const PERFIL = { escuela: 'Escuela de prueba', grado: '4°', grupo: 'B', ciclo_escolar: '2026-2027' }
const CODIGO = 'SG-PWCU'
const OTRO_CODIGO = 'SG-VXKR'

function datosHoja(n: number, identificadorVisible: string) {
  return { nombreProyecto: 'Proyecto', camposFormativos: ['Lenguajes'], trimestreNombre: null, fechaInicio: null, fechaFin: null, identificadorVisible, indicadores: INDICADORES, alumnos: Array.from({ length: n }, (_, i) => ({ nombre: `Alumno ${i + 1}`, posicion: i + 1 })) }
}

// ---------- Escenarios de lectura ----------

function pagina(imagen: number, identificadorVisible: string | null, paginaImpresa: number | null, totalPaginasImpreso: number | null): PaginaObservadaHoja {
  return { imagen, identificadorVisible, paginaImpresa, totalPaginasImpreso }
}

// Filas tal como las leería el modelo: cada posición en la imagen de su página.
function filasCorrectas(n: number) {
  return calcularRangosPaginasHoja(n).flatMap((r) => Array.from({ length: r.hasta - r.desde + 1 }, (_, i) => ({ posicion: r.desde + i, imagen: r.pagina })))
}

function validar(n: number, paginas: unknown, filas: { posicion: number; imagen?: number }[] = filasCorrectas(n), cantidadImagenes = calcularCantidadPaginasHoja(n)) {
  return validarIdentidadPaginasHoja({ identificadorEsperado: CODIGO, cantidadAlumnos: n, cantidadImagenes, paginasObservadas: paginas, filas })
}

async function main() {
  // ============================================================
  // 1. PDF real: código y "Página n de m" en todas las páginas, y las
  //    posiciones de cada página = calcularRangosPaginasHoja
  // ============================================================
  {
    let todoBien = true
    for (const n of [1, 15, 28, 29, 33, 40, 50, 68, 69, 100, 150]) {
      const paginas = await textosPorPagina(await generarHojaSeguimientoPdfBuffer(datosHoja(n, CODIGO), PERFIL, null))
      const m = paginas.length
      const rangos = calcularRangosPaginasHoja(n)
      if (m !== calcularCantidadPaginasHoja(n) || rangos.length !== m) { todoBien = false; console.error(`  n=${n}: páginas ${m}, calculadas ${calcularCantidadPaginasHoja(n)}, rangos ${rangos.length}`) }
      paginas.forEach((textos, i) => {
        if (textos.filter((t) => t === CODIGO).length !== 1 || textos.filter((t) => t === `Página ${i + 1} de ${m}`).length !== 1) { todoBien = false; console.error(`  n=${n} p${i + 1}: sin código o sin paginación`) }
        const numeros = textos.filter((t) => /^\d+$/.test(t)).map(Number)
        const r = rangos[i]
        const esperado = r ? Array.from({ length: r.hasta - r.desde + 1 }, (_, j) => r.desde + j) : []
        if (JSON.stringify(numeros) !== JSON.stringify(esperado)) { todoBien = false; console.error(`  n=${n} p${i + 1}: posiciones ${numeros[0]}..${numeros[numeros.length - 1]} ≠ rango ${r?.desde}..${r?.hasta}`) }
      })
    }
    verificar(todoBien, '1. En 11 tamaños (1 a 150 alumnos) cada página del PDF real lleva SG-XXXX y "Página n de m", y sus posiciones "#" coinciden con calcularRangosPaginasHoja')

    const vista = await textosPorPagina(await generarHojaSeguimientoPdfBuffer(datosHoja(60, 'VISTA PREVIA — PENDIENTE DE APROBACIÓN'), PERFIL, null))
    verificar(vista.length === 2 && vista[1].some((t) => t === 'Página 2 de 2') && !vista[1].some((t) => t.startsWith('VISTA PREVIA')), '1b. Vista previa multipágina: "Página n de m" en todas, el rótulo largo solo en la página 1 (no invade la tabla)')
  }

  // ============================================================
  // 1c. Una sola fuente de paginación: para 1..300 alumnos los rangos
  //     cubren 1..n sin huecos ni solapes y su número de páginas es el
  //     de calcularCantidadPaginasHoja
  // ============================================================
  {
    let consistentes = true
    for (let n = 1; n <= 300; n++) {
      const rangos = calcularRangosPaginasHoja(n)
      const contiguos = rangos.every((r, i) => r.pagina === i + 1 && r.desde <= r.hasta && r.desde === (i === 0 ? 1 : rangos[i - 1].hasta + 1))
      if (!contiguos || rangos[rangos.length - 1].hasta !== n || rangos.length !== calcularCantidadPaginasHoja(n)) { consistentes = false; console.error(`  n=${n}: rangos inconsistentes`) }
    }
    verificar(consistentes, '1c. Para 1..300 alumnos, calcularRangosPaginasHoja cubre 1..n sin huecos y coincide con calcularCantidadPaginasHoja')
  }

  // ============================================================
  // 2. Extracción visual: código y página por imagen, una sola llamada
  // ============================================================
  {
    const respuesta = {
      hojaLegible: true,
      identificadorVisible: CODIGO,
      paginas: [pagina(1, CODIGO, 1, 2), pagina(2, CODIGO, 2, 2)],
      filas: [1, 40].map((posicion, i) => ({ imagen: i + 1, posicion, celdas: [1, 2, 3, 4, 5].map((numeroIndicador) => ({ numeroIndicador, digitosDetectados: [3], confianza: 'alta' })) })),
    }
    let llamadas = 0
    let prompt = ''
    const anthropic = { messages: { create: async (p: { messages: { content: { type: string; text?: string }[] }[] }) => { llamadas++; prompt = p.messages[0].content.find((b) => b.type === 'text')?.text ?? ''; return { content: [{ type: 'text', text: JSON.stringify(respuesta) }] } } } } as unknown as Anthropic
    const r = await analizarImagenesHojaEvaluacion(anthropic, [{ base64: 'AA', mediaType: 'image/jpeg' }, { base64: 'BB', mediaType: 'image/jpeg' }], 40)
    verificar(llamadas === 1, '2a. Dos imágenes: exactamente 1 llamada de visión')
    verificar(JSON.stringify(r.paginasObservadas) === JSON.stringify(respuesta.paginas), '2b. Devuelve el código y la página observados en CADA imagen')
    verificar(r.extraccion.filas.map((f) => f.imagen).join(',') === '1,2', '2c. Cada fila conserva la imagen en la que se leyó')
    verificar(!prompt.includes(CODIGO) && prompt.includes('"paginas"') && prompt.includes('NO lo asumas'), '2d. El prompt pide código y página por imagen, no presupone el orden y nunca recibe el código esperado')
  }

  // ============================================================
  // 3. Validación por página (40 alumnos = 2 páginas)
  // ============================================================
  const N = 40
  const M = calcularCantidadPaginasHoja(N)
  verificar(M === 2, `3. Escenario base: ${N} alumnos ocupan 2 páginas`)
  const correctas = [pagina(1, CODIGO, 1, 2), pagina(2, CODIGO, 2, 2)]

  verificar(validar(N, correctas).ok, '3a. Páginas correctas: se acepta')
  verificar(validar(N, [pagina(1, ' sg-pwcu ', 1, 2), pagina(2, CODIGO, 2, 2)]).ok, '3b. Mismo código con espacios/minúsculas: se acepta (solo trim + mayúsculas)')

  const mezcladas = validar(N, [pagina(1, CODIGO, 1, 2), pagina(2, OTRO_CODIGO, 2, 2)])
  verificar(!mezcladas.ok && mezcladas.razon === 'identidad_no_valida', '3c. Páginas mezcladas (página 2 de otra hoja): se rechaza')
  verificar(!validar(N, [pagina(1, OTRO_CODIGO, 1, 2), pagina(2, CODIGO, 2, 2)]).ok, '3d. Páginas mezcladas (página 1 de otra hoja): se rechaza')

  verificar(!validar(N, [pagina(1, CODIGO, 1, 2), pagina(2, CODIGO, 1, 2)]).ok, '3e. Página repetida (ambas fotos son la página 1): se rechaza')
  verificar(!validar(N, [pagina(1, CODIGO, 1, 2), pagina(1, CODIGO, 1, 2)]).ok, '3f. Imagen repetida en la respuesta: se rechaza')

  verificar(!validar(N, [pagina(1, CODIGO, 1, 2)], filasCorrectas(N), 1).ok, '3g. Página faltante (1 foto de una hoja de 2): se rechaza')
  verificar(!validar(N, [pagina(1, CODIGO, 1, 2)]).ok, '3h. Página faltante en la respuesta del modelo (2 fotos, 1 página reportada): se rechaza')
  verificar(!validar(N, [pagina(1, CODIGO, 1, 3), pagina(2, CODIGO, 2, 3)]).ok, '3i. "Página n de m" con otro total (hoja de 3 páginas): se rechaza')

  const invertidas = [pagina(1, CODIGO, 2, 2), pagina(2, CODIGO, 1, 2)]
  const filasInvertidas = filasCorrectas(N).map((f) => ({ ...f, imagen: f.imagen === 1 ? 2 : 1 }))
  verificar(!validar(N, invertidas, filasInvertidas).ok, '3j. Orden invertido (la foto 1 es la página 2): se rechaza')

  const ilegible = validar(N, [pagina(1, CODIGO, 1, 2), pagina(2, null, 2, 2)])
  verificar(!ilegible.ok && ilegible.razon === 'identidad_no_valida', '3k. Código ilegible en la página 2 (con paginación visible): se rechaza')
  verificar(!validar(N, [pagina(1, null, 1, 2), pagina(2, CODIGO, 2, 2)]).ok, '3l. Código ilegible en la página 1: se rechaza')
  verificar(!validar(N, [pagina(1, 'SG-PWC', 1, 2), pagina(2, CODIGO, 2, 2)]).ok, '3m. Código con formato inválido: se rechaza')
  verificar(!validar(N, [pagina(1, CODIGO, null, null), pagina(2, CODIGO, 2, 2)]).ok, '3n. Número de página ilegible en una página: se rechaza')

  const filaEnOtraPagina = filasCorrectas(N).map((f) => (f.posicion === 40 ? { ...f, imagen: 1 } : f))
  verificar(!validar(N, correctas, filaEnOtraPagina).ok, '3o. Una fila de la página 2 atribuida a la foto 1: se rechaza')
  verificar(!validar(N, correctas, filasCorrectas(N).map(({ posicion }) => ({ posicion }))).ok, '3p. Filas sin imagen en una hoja multipágina: se rechaza')
  verificar(!validar(N, undefined).ok && !validar(N, 'x').ok, '3q. Respuesta sin "paginas" o con forma inválida: se rechaza')

  // ============================================================
  // 4. Hojas antiguas (sin "Página n de m" ni código en páginas 2+)
  // ============================================================
  {
    const unaPagina = calcularCantidadPaginasHoja(28)
    verificar(unaPagina === 1, '4. Escenario: 28 alumnos ocupan 1 página')
    const filas28 = Array.from({ length: 28 }, (_, i) => ({ posicion: i + 1 }))
    verificar(validar(28, [pagina(1, CODIGO, null, null)], filas28).ok, '4a. Hoja antigua de una página con código verificable: se acepta')
    verificar(!validar(28, [pagina(1, null, null, null)], filas28).ok, '4b. Hoja antigua de una página con código ilegible: se rechaza')
    verificar(!validar(28, [pagina(1, OTRO_CODIGO, null, null)], filas28).ok, '4c. Hoja antigua de una página de otro proyecto: se rechaza')
    verificar(!validar(28, [pagina(1, CODIGO, 2, 2)], filas28).ok, '4d. Una sola foto que muestra "Página 2 de 2": se rechaza')

    const antigua = validar(N, [pagina(1, CODIGO, null, null), pagina(2, null, null, null)])
    verificar(!antigua.ok && antigua.razon === 'hoja_sin_identidad_por_pagina', '4e. Hoja antigua multipágina: no se acepta y se pide una hoja nueva identificable')
    const antiguaOtra = validar(N, [pagina(1, OTRO_CODIGO, null, null), pagina(2, null, null, null)])
    verificar(!antiguaOtra.ok && antiguaOtra.razon === 'identidad_no_valida', '4f. Hoja antigua multipágina de otro proyecto: se rechaza por identidad')
  }

  // ============================================================
  // 5. Tres páginas: orden y mezcla en la página intermedia
  // ============================================================
  {
    const n = Array.from({ length: 150 }, (_, i) => i + 1).find((x) => calcularCantidadPaginasHoja(x) === 3)!
    const ok3 = [pagina(1, CODIGO, 1, 3), pagina(2, CODIGO, 2, 3), pagina(3, CODIGO, 3, 3)]
    verificar(validar(n, ok3).ok, `5a. Hoja de 3 páginas (${n} alumnos) correcta: se acepta`)
    verificar(!validar(n, [ok3[0], pagina(2, CODIGO, 3, 3), pagina(3, CODIGO, 2, 3)]).ok, '5b. Páginas 2 y 3 intercambiadas: se rechaza')
    verificar(!validar(n, [ok3[0], pagina(2, OTRO_CODIGO, 2, 3), ok3[2]]).ok, '5c. Página intermedia de otra hoja: se rechaza')
  }

  // ============================================================
  // 6. Ruta: la validación por página ocurre antes de guardar la
  //    extracción, y un rechazo nunca escribe extraidoBruto
  // ============================================================
  {
    const ruta = readFileSync(join(__dirname, '..', 'app', 'api', 'proyectos-seguimiento', '[id]', 'analizar-hoja', 'route.ts'), 'utf-8')
    const iGlobal = ruta.indexOf('if (!identidadHojaValida(')
    const iPaginas = ruta.indexOf('validarIdentidadPaginasHoja({')
    const iGuardado = ruta.indexOf('extraidoBruto: resultado.extraccion')
    verificar(iGlobal > 0 && iPaginas > iGlobal && iGuardado > iPaginas, '6a. analizar-hoja valida identidad global, luego por página, y solo después guarda la extracción')
    const bloqueRechazo = ruta.slice(iPaginas, ruta.indexOf('const { error: errorUpdate }', iPaginas))
    verificar(!bloqueRechazo.replace(/\/\/.*$/gm, '').includes('extraidoBruto') && bloqueRechazo.includes("validacionIdentidad: { estado: 'rechazada', razon: identidadPaginas.razon"), '6b. El rechazo por página guarda solo validacionIdentidad con su motivo, nunca extraidoBruto')
    verificar(!bloqueRechazo.includes('anthropic') && (ruta.match(/analizarImagenesHojaEvaluacion\(/g) || []).length === 1, '6c. Sin llamadas de IA adicionales: una sola llamada de visión en la ruta')
  }

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
