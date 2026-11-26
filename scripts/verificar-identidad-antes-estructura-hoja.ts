// scripts/verificar-identidad-antes-estructura-hoja.ts
//
// Regresión (sin credenciales, sin red, sin IA real) del caso real en
// E2E: se subió la foto de otra hoja (SG-TWFY, 3 alumnos) al proyecto
// de SG-3UAA (2 alumnos). La fila 3 rompía la validación estructural
// ANTES de comparar el código, y el docente veía «La transcripción de
// la hoja tiene una estructura inválida…» en vez de «Esta fotografía no
// corresponde…». Ahora la identidad se valida primero, con la MISMA
// respuesta del modelo, y la estructura después.
//
// Se ejecuta con `npx tsx scripts/verificar-identidad-antes-estructura-hoja.ts`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type Anthropic from '@anthropic-ai/sdk'
import { analizarImagenesHojaEvaluacion, ErrorEstructuraHoja, ErrorHojaIlegible } from '../lib/seguimiento/analisisHojaEvaluacion'
import { validarIdentidadPaginasHoja } from '../lib/seguimiento/identidadPaginasHoja'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

const ESPERADO = 'SG-3UAA'
const OTRA = 'SG-TWFY'
const ALUMNOS = 2
const MENSAJE_ESTRUCTURA = 'La transcripción de la hoja tiene una estructura inválida. Intenta de nuevo con una foto más clara.'

function fila(posicion: number, niveles: number[]) {
  return { imagen: 1, posicion, celdas: niveles.map((n, i) => ({ numeroIndicador: i + 1, digitosDetectados: [n], confianza: 'alta' })) }
}

function respuestaModelo(codigo: string | null, filas: unknown[], extra: Record<string, unknown> = {}) {
  return { hojaLegible: true, identificadorVisible: codigo, paginas: [{ imagen: 1, identificadorVisible: codigo, paginaImpresa: 1, totalPaginasImpreso: 1 }], filas, ...extra }
}

// La foto real de SG-TWFY: 3 filas con 5 niveles cada una.
const FILAS_TWFY = [fila(1, [4, 3, 4, 3, 4]), fila(2, [2, 3, 2, 3, 3]), fila(3, [3, 2, 3, 2, 3])]
const FILAS_3UAA = [fila(1, [4, 3, 4, 3, 4]), fila(2, [2, 3, 2, 3, 3])]

function modeloFalso(respuesta: unknown) {
  const estado = { llamadas: 0 }
  const anthropic = { messages: { create: async () => { estado.llamadas++; return { content: [{ type: 'text', text: typeof respuesta === 'string' ? respuesta : JSON.stringify(respuesta) }] } } } } as unknown as Anthropic
  return { anthropic, estado }
}

const IMAGEN = [{ base64: 'AA', mediaType: 'image/jpeg' as const }]

async function analizar(respuesta: unknown) {
  const { anthropic, estado } = modeloFalso(respuesta)
  try {
    return { resultado: await analizarImagenesHojaEvaluacion(anthropic, IMAGEN, ALUMNOS), error: null as unknown, llamadas: estado.llamadas }
  } catch (e) {
    return { resultado: null, error: e, llamadas: estado.llamadas }
  }
}

// Mismo gate por página que usa la ruta, con las filas disponibles (sin
// filas validadas, solo código y "Página n de m").
function identidadPaginas(paginasObservadas: unknown, filas: { posicion: number; imagen?: number }[]) {
  return validarIdentidadPaginasHoja({ identificadorEsperado: ESPERADO, cantidadAlumnos: ALUMNOS, cantidadImagenes: 1, paginasObservadas, filas })
}

async function main() {
  // ============================================================
  // 1. SG-TWFY (3 alumnos) en el proyecto de SG-3UAA (2 alumnos)
  // ============================================================
  {
    const r = await analizar(respuestaModelo(OTRA, FILAS_TWFY))
    verificar(r.llamadas === 1, '1a. Una sola llamada de visión')
    verificar(r.error instanceof ErrorEstructuraHoja, '1b. La fila 3 sigue rechazándose por estructura (validación existente conservada)')
    const e = r.error as ErrorEstructuraHoja
    verificar(e.message === MENSAJE_ESTRUCTURA, '1c. Mismo mensaje de estructura que antes, para la hoja correcta')
    verificar(e.identificadorVisibleObservado === OTRA, '1d. El error conserva el código observado en la MISMA respuesta (SG-TWFY)')
    const paginas = identidadPaginas(e.paginasObservadas, [])
    verificar(!paginas.ok && paginas.razon === 'identidad_no_valida', '1e. El gate de identidad la rechaza como «no corresponde», antes de informar la estructura')
  }

  // ============================================================
  // 2. Hoja correcta (SG-3UAA, 2 alumnos): sigue funcionando
  // ============================================================
  {
    const r = await analizar(respuestaModelo(ESPERADO, FILAS_3UAA))
    verificar(r.llamadas === 1 && r.error === null && r.resultado !== null, '2a. La hoja correcta se analiza sin error con una sola llamada')
    verificar(r.resultado?.identificadorVisibleObservado === ESPERADO, '2b. Código observado SG-3UAA')
    verificar(r.resultado?.extraccion.filas.map((f) => f.posicion).join(',') === '1,2', '2c. Dos filas, posiciones 1 y 2')
    verificar(r.resultado?.extraccion.filas.every((f) => f.celdas.length === 5 && f.celdas.every((c) => c.lectura.estado === 'nivel' && !c.dudoso)) === true, '2d. Cinco niveles limpios por alumno')
    verificar(identidadPaginas(r.resultado?.paginasObservadas, r.resultado!.extraccion.filas).ok, '2e. Pasa el gate por página con sus filas')
  }

  // ============================================================
  // 3. Hoja correcta con estructura inválida: el error de estructura
  //    se conserva
  // ============================================================
  {
    const sinCelda = { ...FILAS_3UAA[1], celdas: FILAS_3UAA[1].celdas.slice(0, 4) }
    for (const [nombre, filas] of [
      ['fila 3 inexistente', [...FILAS_3UAA, fila(3, [1, 1, 1, 1, 1])]],
      ['celda faltante', [FILAS_3UAA[0], sinCelda]],
    ] as const) {
      const r = await analizar(respuestaModelo(ESPERADO, [...filas]))
      const e = r.error as ErrorEstructuraHoja
      verificar(r.error instanceof ErrorEstructuraHoja && e.message === MENSAJE_ESTRUCTURA && e.identificadorVisibleObservado === ESPERADO, `3. SG-3UAA con ${nombre}: error de estructura con el código correcto`)
      verificar(identidadPaginas(e.paginasObservadas, []).ok, `3. SG-3UAA con ${nombre}: la identidad pasa, así que se informa la estructura`)
    }
    const duplicada = await analizar(respuestaModelo(ESPERADO, [FILAS_3UAA[0], FILAS_3UAA[0]]))
    verificar(duplicada.error instanceof ErrorEstructuraHoja && (duplicada.error as Error).message.includes('misma posición'), '3c. Posición duplicada: conserva su propio mensaje')
    const vacia = await analizar(respuestaModelo(ESPERADO, []))
    verificar(vacia.error instanceof ErrorEstructuraHoja && (vacia.error as Error).message.includes('ninguna fila'), '3d. Sin filas: conserva su propio mensaje')
  }

  // ============================================================
  // 4. Ninguna hoja incorrecta pasa la identidad
  // ============================================================
  {
    const dosFilasOtra = await analizar(respuestaModelo(OTRA, FILAS_3UAA))
    verificar(dosFilasOtra.error === null && !identidadPaginas(dosFilasOtra.resultado!.paginasObservadas, dosFilasOtra.resultado!.extraccion.filas).ok, '4a. SG-TWFY con estructura válida: rechazada por identidad (comportamiento existente)')
    const sinCodigo = await analizar(respuestaModelo(null, FILAS_TWFY))
    verificar(sinCodigo.error instanceof ErrorEstructuraHoja && (sinCodigo.error as ErrorEstructuraHoja).identificadorVisibleObservado === null && !identidadPaginas((sinCodigo.error as ErrorEstructuraHoja).paginasObservadas, []).ok, '4b. Código ilegible y estructura inválida: rechazada por identidad')
    const sinPaginas = await analizar({ hojaLegible: true, identificadorVisible: OTRA, filas: FILAS_TWFY })
    verificar(sinPaginas.error instanceof ErrorEstructuraHoja && !identidadPaginas((sinPaginas.error as ErrorEstructuraHoja).paginasObservadas, []).ok, '4c. Respuesta sin "paginas": rechazada por identidad')

    const ilegible = await analizar({ hojaLegible: false, filas: [] })
    verificar(ilegible.error instanceof ErrorHojaIlegible && !(ilegible.error instanceof ErrorEstructuraHoja), '4d. Hoja ilegible: conserva su propio rechazo')
    const noJson = await analizar('no es json')
    verificar(noJson.error instanceof Error && !(noJson.error instanceof ErrorEstructuraHoja), '4e. Respuesta que no es JSON: conserva su error genérico')
  }

  // ============================================================
  // 5. Ruta: identidad antes de estructura; solo una extracción con
  //    identidad válida se guarda y puede llegar a confirmarse
  // ============================================================
  {
    const raiz = join(__dirname, '..', 'app', 'api', 'proyectos-seguimiento', '[id]')
    const ruta = readFileSync(join(raiz, 'analizar-hoja', 'route.ts'), 'utf-8')
    const sinComentarios = ruta.replace(/\/\/.*$/gm, '')
    const iGate = sinComentarios.indexOf('const rechazoPorIdentidad = async (')
    const iFinGate = sinComentarios.indexOf('return null\n    }', iGate)
    const iLlamada = sinComentarios.indexOf('analizarImagenesHojaEvaluacion(')
    const iRamaEstructura = sinComentarios.indexOf('if (e instanceof ErrorEstructuraHoja) {')
    const iGateEnError = sinComentarios.indexOf('await rechazoPorIdentidad(e, [])', iRamaEstructura)
    const i422 = sinComentarios.indexOf('{ status: 422 }', iRamaEstructura)
    const iGateExito = sinComentarios.indexOf('await rechazoPorIdentidad(resultado, resultado.extraccion.filas)')
    const iGuardado = sinComentarios.indexOf('extraidoBruto: resultado.extraccion')
    verificar(iGate > 0 && iGate < iLlamada, '5a. El gate de identidad está definido una sola vez, antes de la llamada de visión')
    verificar(iRamaEstructura > iLlamada && iGateEnError > iRamaEstructura && i422 > iGateEnError, '5b. Ante un error de estructura, la ruta valida identidad antes de responder 422')
    verificar(iGateExito > i422 && iGuardado > iGateExito, '5c. En el caso exitoso, la identidad se valida antes de guardar la extracción')
    const gate = sinComentarios.slice(iGate, iFinGate)
    verificar(!gate.includes('extraidoBruto') && !gate.includes("estado: 'requiere_revision'") && gate.includes("validacionIdentidad: { estado: 'rechazada'"), '5d. Un rechazo de identidad solo guarda validacionIdentidad: nunca extraidoBruto ni requiere_revision')
    const posiciones = (patron: RegExp) => [...sinComentarios.matchAll(patron)].map((m) => m.index ?? -1)
    const escrituras = [...posiciones(/extraidoBruto:/g), ...posiciones(/estado: 'requiere_revision'/g)]
    verificar(posiciones(/extraidoBruto:/g).length === 1 && escrituras.every((i) => i > iGateExito), '5e. extraidoBruto y requiere_revision solo aparecen después del gate de identidad')
    verificar((sinComentarios.match(/analizarImagenesHojaEvaluacion\(/g) || []).length === 1 && !sinComentarios.includes('messages.create'), '5f. Sin llamadas de IA adicionales en la ruta')
    verificar(!sinComentarios.includes(".from('seguimiento_resultados')"), '5g. analizar-hoja nunca escribe seguimiento_resultados')

    const confirmar = readFileSync(join(raiz, 'confirmar-hoja', 'route.ts'), 'utf-8')
    verificar(confirmar.includes("proyecto.estado !== 'requiere_revision'") && confirmar.includes('if (!extraidoBruto ||'), '5h. confirmar-hoja exige requiere_revision y extraidoBruto: una hoja rechazada por identidad no puede registrar resultados')
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
