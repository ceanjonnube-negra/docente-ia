// scripts/verificar-analisis-hoja-evaluacion.ts
//
// EVAL-1D — pruebas deterministas (sin credenciales de Anthropic, sin
// red, sin datos reales) de lib/seguimiento/analisisHojaEvaluacion.ts.
// Mismo criterio ya usado en analisisListaOficial.ts: la validación
// server-side (validarResultadoExtraccionHoja) se prueba directo, sin
// necesitar el cliente Anthropic real — solo la llamada real
// (analizarImagenHojaEvaluacion) necesita un cliente, y para esa se
// usa un doble mínimo que cuenta invocaciones de .messages.create().
//
// Se ejecuta con `npx tsx scripts/verificar-analisis-hoja-evaluacion.ts`.

import { readFileSync } from 'node:fs'
import {
  validarResultadoExtraccionHoja,
  analizarImagenHojaEvaluacion,
} from '../lib/seguimiento/analisisHojaEvaluacion'
import type Anthropic from '@anthropic-ai/sdk'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

function celda(numeroIndicador: number, digitosDetectados: number[], confianza: 'alta' | 'media' | 'baja' = 'alta') {
  return { numeroIndicador, digitosDetectados, confianza }
}

function filaCompleta(posicion: number, valores: (number | number[])[], confianza: 'alta' | 'media' | 'baja' = 'alta') {
  return {
    posicion,
    celdas: valores.map((v, i) => celda(i + 1, Array.isArray(v) ? v : v === -1 ? [] : [v], confianza)),
  }
}

async function main() {
  // CASO A — matriz válida completa: todas las celdas con un solo dígito limpio.
  {
    const bruto = {
      hojaLegible: true,
      filas: [
        filaCompleta(1, [4, 3, 2, 1, 4]),
        filaCompleta(2, [1, 1, 1, 1, 1]),
        filaCompleta(3, [4, 4, 4, 4, 4]),
      ],
    }
    const r = validarResultadoExtraccionHoja(bruto, 28)
    verificar(r.filas.length === 3, 'CASO A. matriz válida completa: se aceptan las 3 filas')
    verificar(r.filas.every((f) => f.celdas.length === 5), 'CASO A. cada fila tiene exactamente 5 celdas')
    verificar(r.filas[0].celdas[0].lectura.estado === 'nivel' && (r.filas[0].celdas[0].lectura as { nivel: number }).nivel === 4, 'CASO A. un dígito limpio produce lectura.estado="nivel" con el valor correcto')
    verificar(r.filas[0].celdas[0].dudoso === false, 'CASO A. confianza alta + lectura limpia => dudoso=false')
  }

  // CASO B — algunas celdas vacías (digitosDetectados=[]) => no_evaluado, marcado dudoso para revisión.
  {
    const bruto = { hojaLegible: true, filas: [filaCompleta(1, [4, -1, 2, -1, 1])] }
    const r = validarResultadoExtraccionHoja(bruto, 28)
    const celdaVacia = r.filas[0].celdas[1]
    verificar(celdaVacia.lectura.estado === 'no_evaluado', 'CASO B. celda sin dígitos => lectura.estado="no_evaluado"')
    verificar(celdaVacia.dudoso === true, 'CASO B. no_evaluado se marca dudoso=true (requiere revisión, no se asume automáticamente)')
    verificar(r.filas[0].celdas[0].lectura.estado === 'nivel', 'CASO B. las celdas SÍ marcadas en la misma fila se leen normalmente')
  }

  // CASO C — lectura dudosa: dos dígitos en la misma celda, y confianza baja en una celda por lo demás limpia.
  {
    const bruto = {
      hojaLegible: true,
      filas: [{
        posicion: 1,
        celdas: [
          celda(1, [2, 3]), // dos dígitos => dudosa
          celda(2, [4], 'baja'), // un solo dígito pero confianza baja
          celda(3, [1]),
          celda(4, [1]),
          celda(5, [1]),
        ],
      }],
    }
    const r = validarResultadoExtraccionHoja(bruto, 28)
    verificar(r.filas[0].celdas[0].lectura.estado === 'lectura_dudosa', 'CASO C. dos dígitos en la misma celda => lectura_dudosa')
    verificar(r.filas[0].celdas[0].dudoso === true, 'CASO C. lectura_dudosa siempre se marca dudoso=true')
    verificar(r.filas[0].celdas[1].lectura.estado === 'nivel' && r.filas[0].celdas[1].dudoso === true, 'CASO C. un dígito limpio con confianza baja SIGUE marcándose dudoso=true (nunca se confía ciegamente solo porque hubo un único trazo)')
  }

  // CASO D — valor fuera de 1-4: nunca se acepta como nivel válido, la celda se vuelve dudosa (no rompe la fila completa).
  {
    const bruto = { hojaLegible: true, filas: [filaCompleta(1, [7, 1, 1, 1, 1])] }
    const r = validarResultadoExtraccionHoja(bruto, 28)
    verificar(r.filas[0].celdas[0].lectura.estado === 'lectura_dudosa', 'CASO D. un dígito fuera de 1-4 (7) nunca se acepta como nivel — la celda se marca lectura_dudosa')
    verificar(r.filas[0].celdas[0].dudoso === true, 'CASO D. dudoso=true para el valor fuera de rango')
  }

  // CASO E — indicador duplicado dentro de la misma fila: rechaza TODA la extracción (fail-closed, nunca se completa/ignora en silencio).
  {
    const bruto = {
      hojaLegible: true,
      filas: [{
        posicion: 1,
        celdas: [celda(1, [1]), celda(2, [1]), celda(3, [1]), celda(3, [2]), celda(5, [1])], // numeroIndicador=3 repetido, falta el 4
      }],
    }
    let lanzo = false
    try { validarResultadoExtraccionHoja(bruto, 28) } catch { lanzo = true }
    verificar(lanzo, 'CASO E. un indicador duplicado (numeroIndicador repetido) dentro de una fila rechaza toda la extracción')
  }

  // CASO F — posición duplicada/repetida entre filas: rechaza toda la extracción.
  {
    const bruto = { hojaLegible: true, filas: [filaCompleta(1, [1, 1, 1, 1, 1]), filaCompleta(1, [2, 2, 2, 2, 2])] }
    let lanzo = false
    try { validarResultadoExtraccionHoja(bruto, 28) } catch { lanzo = true }
    verificar(lanzo, 'CASO F. una posición repetida entre dos filas rechaza toda la extracción')
  }

  // CASO F2 — posición inventada (fuera del roster congelado real): rechazada.
  {
    const bruto = { hojaLegible: true, filas: [filaCompleta(99, [1, 1, 1, 1, 1])] }
    let lanzo = false
    try { validarResultadoExtraccionHoja(bruto, 28) } catch { lanzo = true }
    verificar(lanzo, 'CASO F2. una posición fuera del rango real del roster congelado (99 > 28) se rechaza — nunca se inventa una posición')
  }

  // CASO G — JSON malformado: rechazado en varias formas.
  {
    let lanzo1 = false
    try { validarResultadoExtraccionHoja('esto no es un objeto', 28) } catch { lanzo1 = true }
    verificar(lanzo1, 'CASO G. una respuesta que no es un objeto se rechaza')

    let lanzo2 = false
    try { validarResultadoExtraccionHoja({ hojaLegible: true }, 28) } catch { lanzo2 = true }
    verificar(lanzo2, 'CASO G. falta el campo "filas" (no es arreglo) => se rechaza')

    let lanzo3 = false
    try { validarResultadoExtraccionHoja({ hojaLegible: true, filas: [{ posicion: 'uno', celdas: [] }] }, 28) } catch { lanzo3 = true }
    verificar(lanzo3, 'CASO G. una posición que no es número se rechaza')
  }

  // CASO H — fotografía ilegible: fail-closed explícito, nunca fabrica una matriz.
  {
    let lanzo = false
    let mensaje = ''
    try { validarResultadoExtraccionHoja({ hojaLegible: false, filas: [] }, 28) } catch (e) { lanzo = true; mensaje = e instanceof Error ? e.message : '' }
    verificar(lanzo, 'CASO H. hojaLegible=false rechaza toda la extracción')
    verificar(mensaje.includes('legible'), 'CASO H. el mensaje de rechazo es honesto sobre la causa (legibilidad), no un error genérico')

    let lanzo2 = false
    try { validarResultadoExtraccionHoja({ hojaLegible: true, filas: [] }, 28) } catch { lanzo2 = true }
    verificar(lanzo2, 'CASO H2. hojaLegible=true pero 0 filas también se rechaza (nunca se acepta una matriz vacía como resultado válido)')
  }

  // CASO I — máximo 1 llamada IA por análisis.
  {
    let llamadas = 0
    const respuestaValida = {
      hojaLegible: true,
      filas: [filaCompleta(1, [1, 1, 1, 1, 1])],
    }
    const anthropicFalso = {
      messages: {
        create: async () => {
          llamadas++
          return { content: [{ type: 'text', text: JSON.stringify(respuestaValida) }] }
        },
      },
    } as unknown as Anthropic

    const r = await analizarImagenHojaEvaluacion(anthropicFalso, { base64: 'ZmFrZQ==', mediaType: 'image/jpeg' }, 28)
    verificar(llamadas === 1, 'CASO I. exactamente 1 llamada a anthropic.messages.create por análisis')
    verificar(r.filas.length === 1, 'CASO I. el resultado real de esa única llamada se valida y se regresa correctamente')
  }

  // CASO J — 0 escrituras en seguimiento_resultados (estructural, en los 2 archivos nuevos).
  {
    const libContenido = readFileSync(new URL('../lib/seguimiento/analisisHojaEvaluacion.ts', import.meta.url), 'utf-8')
    const rutaContenido = readFileSync(new URL('../app/api/proyectos-seguimiento/[id]/analizar-hoja/route.ts', import.meta.url), 'utf-8')
    verificar(!libContenido.includes(".from('seguimiento_resultados')"), 'CASO J. analisisHojaEvaluacion.ts nunca escribe en seguimiento_resultados')
    verificar(!rutaContenido.includes(".from('seguimiento_resultados')"), 'CASO J. analizar-hoja/route.ts nunca escribe en seguimiento_resultados')
    verificar(!rutaContenido.includes('SERVICE_ROLE') && !rutaContenido.includes('createClient('), 'CASO J. analizar-hoja/route.ts no usa SERVICE_ROLE ni crea su propio cliente')
    verificar(rutaContenido.includes("captura_pendiente:") && rutaContenido.includes('extraidoBruto'), 'CASO J. lo único que se persiste es captura_pendiente.extraidoBruto (columna ya preparada en EVAL-1B)')
    verificar(!/anthropic\.messages\.create/.test(libContenido.split('async function analizarImagenHojaEvaluacion')[0]), 'CASO J. ninguna llamada a Anthropic ocurre antes de la validación/construcción del prompt (una sola función concentra la única llamada real)')
    verificar((libContenido.match(/anthropic\.messages\.create/g) || []).length === 1, 'CASO J. el archivo entero contiene exactamente 1 referencia a anthropic.messages.create')
  }

  // Precondición estructural: un roster_congelado ausente jamás debe caer en un fallback silencioso al roster vivo.
  {
    const rutaContenido = readFileSync(new URL('../app/api/proyectos-seguimiento/[id]/analizar-hoja/route.ts', import.meta.url), 'utf-8')
    verificar(!rutaContenido.includes('obtenerRosterConPosicion'), 'N. analizar-hoja/route.ts nunca llama obtenerRosterConPosicion (roster vivo) — solo usa roster_congelado, nunca un sustituto')
    verificar(/!rosterCongelado \|\| rosterCongelado\.length === 0/.test(rutaContenido), 'N. fail-closed explícito si roster_congelado está ausente o vacío')
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
