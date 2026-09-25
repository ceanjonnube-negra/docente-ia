// scripts/verificar-confirmar-resultados-hoja.ts
//
// EVAL-1E — pruebas deterministas (sin credenciales, sin red, sin
// datos reales) de lib/seguimiento/confirmarResultadosHoja.ts: las 2
// reglas fail-closed cerradas en la conversación EVAL-1E (cobertura
// completa del roster, 0 celdas bloqueantes) y el mapeo correcto a las
// columnas reales de seguimiento_resultados.
//
// Se ejecuta con `npx tsx scripts/verificar-confirmar-resultados-hoja.ts`.

import { readFileSync } from 'node:fs'
import { prepararResultadosConfirmacion, contarCeldasBloqueantes } from '../lib/seguimiento/confirmarResultadosHoja'
import { CANTIDAD_INDICADORES_HOJA, type AlumnoRosterCongelado, type IndicadorCongelado } from '../lib/seguimiento/tipos'
import type { ResultadoExtraccionHojaEvaluacion, CeldaHojaEvaluacion, ConfianzaLecturaHoja } from '../lib/seguimiento/analisisHojaEvaluacion'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

const PROYECTO_ID = 'p1111111-1111-1111-1111-111111111111'

const ROSTER: AlumnoRosterCongelado[] = [
  { alumno_id: 'a1111111-0000-0000-0000-000000000001', inscripcion_id: 'i1111111-0000-0000-0000-000000000001', nombre: 'Alumno Uno', posicion: 1 },
  { alumno_id: 'a1111111-0000-0000-0000-000000000002', inscripcion_id: 'i1111111-0000-0000-0000-000000000002', nombre: 'Alumno Dos', posicion: 2 },
]

const INDICADORES: IndicadorCongelado[] = Array.from({ length: CANTIDAD_INDICADORES_HOJA }, (_, i) => ({
  numero_indicador: i + 1,
  indicador_especifico: `Indicador específico número ${i + 1}`,
  aspecto_general: 'logro_aprendizaje',
}))

function celdaNivel(numeroIndicador: number, nivel: 1 | 2 | 3 | 4, confianza: ConfianzaLecturaHoja = 'alta'): CeldaHojaEvaluacion {
  return { numeroIndicador, lectura: { estado: 'nivel', nivel }, confianza, dudoso: confianza !== 'alta' }
}
function celdaNoEvaluado(numeroIndicador: number, confianza: ConfianzaLecturaHoja = 'alta'): CeldaHojaEvaluacion {
  return { numeroIndicador, lectura: { estado: 'no_evaluado' }, confianza, dudoso: true }
}
function celdaDudosa(numeroIndicador: number, confianza: ConfianzaLecturaHoja = 'baja'): CeldaHojaEvaluacion {
  return { numeroIndicador, lectura: { estado: 'lectura_dudosa' }, confianza, dudoso: true }
}
function filaTodoNivel4(posicion: number): { posicion: number; celdas: CeldaHojaEvaluacion[] } {
  return { posicion, celdas: Array.from({ length: CANTIDAD_INDICADORES_HOJA }, (_, i) => celdaNivel(i + 1, 4)) }
}

function main() {
  // CASO A — hoja completamente limpia: todas las celdas nivel=4, confianza alta.
  {
    const extraido: ResultadoExtraccionHojaEvaluacion = { filas: [filaTodoNivel4(1), filaTodoNivel4(2)] }
    const filas = prepararResultadosConfirmacion(PROYECTO_ID, extraido, ROSTER, INDICADORES)
    verificar(filas.length === ROSTER.length * CANTIDAD_INDICADORES_HOJA, 'CASO A. produce exactamente roster.length * CANTIDAD_INDICADORES_HOJA filas (2*5=10)')
    verificar(filas.every((f) => f.nivel === 'destacado'), 'CASO A. nivel=4 se convierte a "destacado" (nivelATextoCanonico) en todas las filas')
    verificar(filas.every((f) => f.confianza === 1), 'CASO A. confianza="alta" se mapea a 1')
    verificar(filas.every((f) => f.proyecto_id === PROYECTO_ID), 'CASO A. proyecto_id se propaga a cada fila')
    verificar(filas.every((f) => f.corregido_manualmente === false && f.fuente_correccion === null && f.observacion === null), 'CASO A. corregido_manualmente=false, fuente_correccion=null, observacion=null en todas las filas (0 corrección en esta microfase)')
  }

  // CASO B — alumno_id/inscripcion_id/indicador_especifico/aspecto_general se toman del roster/indicadores congelados, nunca inventados.
  {
    const extraido: ResultadoExtraccionHojaEvaluacion = { filas: [filaTodoNivel4(1), filaTodoNivel4(2)] }
    const filas = prepararResultadosConfirmacion(PROYECTO_ID, extraido, ROSTER, INDICADORES)
    const filaAlumno1Indicador3 = filas.find((f) => f.alumno_id === ROSTER[0].alumno_id && f.indicador_numero === 3)
    verificar(filaAlumno1Indicador3?.inscripcion_id === ROSTER[0].inscripcion_id, 'CASO B. inscripcion_id corresponde exactamente al alumno de esa posición')
    verificar(filaAlumno1Indicador3?.indicador_especifico === INDICADORES[2].indicador_especifico, 'CASO B. indicador_especifico se toma del indicador congelado con ese numero_indicador (no del índice del array)')
    verificar(filaAlumno1Indicador3?.aspecto_general === 'logro_aprendizaje', 'CASO B. aspecto_general se toma del indicador congelado')
  }

  // CASO C — decisión #1: menos filas que alumnos en el roster => rechazo total.
  {
    const extraido: ResultadoExtraccionHojaEvaluacion = { filas: [filaTodoNivel4(1)] } // falta la posición 2
    let lanzo = false
    let mensaje = ''
    try {
      prepararResultadosConfirmacion(PROYECTO_ID, extraido, ROSTER, INDICADORES)
    } catch (e) {
      lanzo = true
      mensaje = e instanceof Error ? e.message : ''
    }
    verificar(lanzo, 'CASO C. transcripción con menos filas que el roster se rechaza (decisión #1, fail-closed)')
    verificar(mensaje.includes('2') && mensaje.includes('1'), 'CASO C. el mensaje de rechazo es honesto: menciona el total real (2) y lo cubierto (1)')
  }

  // CASO D — decisión #2: una celda lectura_dudosa bloquea TODA la confirmación.
  {
    const filaConDudosa = { posicion: 1, celdas: [celdaDudosa(1), ...Array.from({ length: 4 }, (_, i) => celdaNivel(i + 2, 4))] }
    const extraido: ResultadoExtraccionHojaEvaluacion = { filas: [filaConDudosa, filaTodoNivel4(2)] }
    let lanzo = false
    try {
      prepararResultadosConfirmacion(PROYECTO_ID, extraido, ROSTER, INDICADORES)
    } catch {
      lanzo = true
    }
    verificar(lanzo, 'CASO D. UNA sola celda lectura_dudosa en cualquier fila rechaza TODA la confirmación (nunca parcial)')
  }

  // CASO E — decisión #2: nivel con confianza no-alta (media/baja) bloquea, igual que lectura_dudosa.
  {
    const filaConfianzaMedia = { posicion: 1, celdas: [celdaNivel(1, 3, 'media'), ...Array.from({ length: 4 }, (_, i) => celdaNivel(i + 2, 4))] }
    const extraido: ResultadoExtraccionHojaEvaluacion = { filas: [filaConfianzaMedia, filaTodoNivel4(2)] }
    let lanzo = false
    try {
      prepararResultadosConfirmacion(PROYECTO_ID, extraido, ROSTER, INDICADORES)
    } catch {
      lanzo = true
    }
    verificar(lanzo, 'CASO E. un nivel con confianza "media" bloquea igual que una lectura_dudosa')
  }

  // CASO F — decisión #2 (el punto central acordado): una celda no_evaluado con confianza BAJA NUNCA bloquea.
  {
    const filaConBlancoInseguro = { posicion: 1, celdas: [celdaNoEvaluado(1, 'baja'), ...Array.from({ length: 4 }, (_, i) => celdaNivel(i + 2, 4))] }
    const extraido: ResultadoExtraccionHojaEvaluacion = { filas: [filaConBlancoInseguro, filaTodoNivel4(2)] }
    const filas = prepararResultadosConfirmacion(PROYECTO_ID, extraido, ROSTER, INDICADORES)
    verificar(filas.length === ROSTER.length * CANTIDAD_INDICADORES_HOJA, 'CASO F. una celda no_evaluado con confianza "baja" NUNCA bloquea la confirmación — se acepta igual (decisión #2 tal como se acordó)')
    const filaGenerada = filas.find((f) => f.alumno_id === ROSTER[0].alumno_id && f.indicador_numero === 1)
    verificar(filaGenerada?.nivel === 'no_evaluado', 'CASO F. la celda no_evaluado se persiste con nivel="no_evaluado" (valor real, no ausencia)')
    verificar(filaGenerada?.confianza === 0, 'CASO F. la confianza numérica de esa celda no_evaluado sí refleja "baja" (0) — se conserva la información sin que bloquee')
  }

  // CASO G — contarCeldasBloqueantes cuenta con precisión, no solo detecta "sí/no".
  {
    const filaDosBloqueantes = { posicion: 1, celdas: [celdaDudosa(1), celdaNivel(2, 2, 'baja'), celdaNivel(3, 4), celdaNivel(4, 4), celdaNivel(5, 4)] }
    const extraido: ResultadoExtraccionHojaEvaluacion = { filas: [filaDosBloqueantes, filaTodoNivel4(2)] }
    verificar(contarCeldasBloqueantes(extraido) === 2, 'CASO G. contarCeldasBloqueantes cuenta exactamente 2 celdas bloqueantes (1 lectura_dudosa + 1 nivel con confianza baja), ignorando las demás celdas limpias')
  }

  // CASO H — indicadores congelados incompletos: defensivo, nunca asume la forma en silencio.
  {
    const extraido: ResultadoExtraccionHojaEvaluacion = { filas: [filaTodoNivel4(1), filaTodoNivel4(2)] }
    const indicadoresIncompletos = INDICADORES.slice(0, 4) // falta el número 5
    let lanzo = false
    try {
      prepararResultadosConfirmacion(PROYECTO_ID, extraido, ROSTER, indicadoresIncompletos)
    } catch {
      lanzo = true
    }
    verificar(lanzo, 'CASO H. indicadores congelados incompletos (falta el número 5) rechaza la confirmación — defensivo, aunque no debería poder pasar en la práctica')
  }

  // CASO I — 0 dependencias de red/Supabase/IA: este módulo es 100% puro.
  {
    const modulo = readFileSync(new URL('../lib/seguimiento/confirmarResultadosHoja.ts', import.meta.url), 'utf-8')
    verificar(!modulo.includes('supabase') && !modulo.includes('Anthropic') && !modulo.includes('fetch('), 'CASO I. confirmarResultadosHoja.ts no importa Supabase, Anthropic ni hace ninguna llamada de red — lógica 100% pura')
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
