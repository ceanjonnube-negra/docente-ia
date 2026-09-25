// scripts/verificar-estado-captura-hoja.ts
//
// EVAL-1G — pruebas deterministas (sin credenciales, sin red, sin
// datos reales) de lib/seguimiento/estadoCapturaHoja.ts: el enum
// discreto que CapturaHoja.tsx usa para decidir qué mostrar, SIN
// reconstruir nada a partir de códigos HTTP. Cubre los 6 estados
// reales del ciclo de vida.
//
// Se ejecuta con `npx tsx scripts/verificar-estado-captura-hoja.ts`.

import { readFileSync } from 'node:fs'
import { determinarEstadoCapturaHoja } from '../lib/seguimiento/estadoCapturaHoja'
import { CANTIDAD_INDICADORES_HOJA, type AlumnoRosterCongelado, type IndicadorCongelado } from '../lib/seguimiento/tipos'
import type { ResultadoExtraccionHojaEvaluacion, CeldaHojaEvaluacion } from '../lib/seguimiento/analisisHojaEvaluacion'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

const ROSTER: AlumnoRosterCongelado[] = [
  { alumno_id: 'a1', inscripcion_id: 'i1', nombre: 'Alumno Uno', posicion: 1 },
  { alumno_id: 'a2', inscripcion_id: 'i2', nombre: 'Alumno Dos', posicion: 2 },
]
const INDICADORES: IndicadorCongelado[] = Array.from({ length: CANTIDAD_INDICADORES_HOJA }, (_, i) => ({
  numero_indicador: i + 1,
  indicador_especifico: `Indicador ${i + 1}`,
  aspecto_general: 'logro_aprendizaje',
}))

function celdaNivel(numeroIndicador: number, nivel: 1 | 2 | 3 | 4): CeldaHojaEvaluacion {
  return { numeroIndicador, lectura: { estado: 'nivel', nivel }, confianza: 'alta', dudoso: false }
}
function celdaDudosa(numeroIndicador: number): CeldaHojaEvaluacion {
  return { numeroIndicador, lectura: { estado: 'lectura_dudosa' }, confianza: 'baja', dudoso: true }
}
function filaLimpia(posicion: number) {
  return { posicion, celdas: Array.from({ length: CANTIDAD_INDICADORES_HOJA }, (_, i) => celdaNivel(i + 1, 4)) }
}

function base(overrides: Partial<Parameters<typeof determinarEstadoCapturaHoja>[0]> = {}) {
  return {
    estadoProyecto: 'requiere_revision',
    paginasEsperadas: 1,
    paginasCargadas: 0,
    extraidoBruto: null as ResultadoExtraccionHojaEvaluacion | null,
    rosterCongelado: ROSTER,
    indicadoresCongelados: INDICADORES,
    ...overrides,
  }
}

function main() {
  // CASO A — sin ninguna fotografía todavía.
  {
    const r = determinarEstadoCapturaHoja(base({ estadoProyecto: 'hoja_generada', paginasCargadas: 0 }))
    verificar(r.estado === 'sin_fotografia', 'CASO A. 0 fotos, sin extraidoBruto => sin_fotografia')
    verificar(r.paginasEsperadas === 1 && r.paginasCargadas === 0, 'CASO A. paginasEsperadas/paginasCargadas se propagan tal cual')
    verificar(r.totalBloqueantes === undefined, 'CASO A. totalBloqueantes no aplica todavía (undefined, no 0 inventado)')
  }

  // CASO B — captura parcial (hoja de 2 páginas, solo 1 cargada).
  {
    const r = determinarEstadoCapturaHoja(base({ estadoProyecto: 'fotografia_cargada', paginasEsperadas: 2, paginasCargadas: 1 }))
    verificar(r.estado === 'captura_incompleta', 'CASO B. paginasCargadas < paginasEsperadas, sin extraidoBruto => captura_incompleta')
  }

  // CASO C — todas las páginas cargadas, pero el análisis todavía no corrió (reanudación).
  {
    const r = determinarEstadoCapturaHoja(base({ estadoProyecto: 'fotografia_cargada', paginasEsperadas: 2, paginasCargadas: 2 }))
    verificar(r.estado === 'lista_para_analizar', 'CASO C. paginasCargadas === paginasEsperadas, sin extraidoBruto => lista_para_analizar')
  }
  // CASO C2 — defensivo: paginasCargadas > paginasEsperadas (no debería poder pasar, foto-hoja ya lo impide) también cuenta como listo, nunca como incompleto.
  {
    const r = determinarEstadoCapturaHoja(base({ estadoProyecto: 'fotografia_cargada', paginasEsperadas: 2, paginasCargadas: 3 }))
    verificar(r.estado === 'lista_para_analizar', 'CASO C2. paginasCargadas > paginasEsperadas (defensivo) también resuelve a lista_para_analizar, nunca a captura_incompleta')
  }

  // CASO D — analizado, con celdas bloqueantes => revision_pendiente.
  {
    const extraido: ResultadoExtraccionHojaEvaluacion = {
      filas: [{ posicion: 1, celdas: [celdaDudosa(1), ...Array.from({ length: 4 }, (_, i) => celdaNivel(i + 2, 4))] }, filaLimpia(2)],
    }
    const r = determinarEstadoCapturaHoja(base({ paginasCargadas: 1, extraidoBruto: extraido }))
    verificar(r.estado === 'revision_pendiente', 'CASO D. extraidoBruto con 1 celda bloqueante => revision_pendiente')
    verificar(r.totalBloqueantes === 1, 'CASO D. totalBloqueantes refleja el conteo real de construirMatrizRevision (reutilizado, no reinventado)')
  }

  // CASO E — analizado, 0 bloqueantes, cobertura completa => lista_para_confirmar.
  {
    const extraido: ResultadoExtraccionHojaEvaluacion = { filas: [filaLimpia(1), filaLimpia(2)] }
    const r = determinarEstadoCapturaHoja(base({ paginasCargadas: 1, extraidoBruto: extraido }))
    verificar(r.estado === 'lista_para_confirmar', 'CASO E. extraidoBruto limpio y con cobertura completa => lista_para_confirmar')
    verificar(r.totalBloqueantes === 0, 'CASO E. totalBloqueantes=0')
  }

  // CASO E2 — analizado pero cobertura incompleta (faltó un alumno en la transcripción) => sigue sin poder confirmarse.
  {
    const extraido: ResultadoExtraccionHojaEvaluacion = { filas: [filaLimpia(1)] } // falta la posición 2
    const r = determinarEstadoCapturaHoja(base({ paginasCargadas: 1, extraidoBruto: extraido }))
    verificar(r.estado === 'revision_pendiente', 'CASO E2. cobertura incompleta (falta un alumno) => revision_pendiente, nunca lista_para_confirmar aunque 0 celdas sean bloqueantes')
  }

  // CASO F — proyecto ya confirmado: estado='confirmado' gana SIEMPRE, sin importar los demás datos.
  {
    for (const estadoDb of ['confirmado', 'corregido', 'sustituido', 'cerrado']) {
      const r = determinarEstadoCapturaHoja(base({ estadoProyecto: estadoDb, paginasCargadas: 0, extraidoBruto: null }))
      verificar(r.estado === 'confirmado', `CASO F. proyecto.estado='${estadoDb}' siempre resuelve a 'confirmado', sin importar fotos/análisis`)
    }
  }
  {
    // Incluso con extraidoBruto lleno de bloqueantes, una vez confirmado sigue siendo 'confirmado' — nunca vuelve a 'revision_pendiente'.
    const extraido: ResultadoExtraccionHojaEvaluacion = { filas: [{ posicion: 1, celdas: [celdaDudosa(1), ...Array.from({ length: 4 }, (_, i) => celdaNivel(i + 2, 4))] }, filaLimpia(2)] }
    const r = determinarEstadoCapturaHoja(base({ estadoProyecto: 'confirmado', paginasCargadas: 1, extraidoBruto: extraido }))
    verificar(r.estado === 'confirmado', 'CASO F2. proyecto.estado=confirmado gana incluso con celdas bloqueantes presentes en extraidoBruto')
  }

  // CASO G — 100% puro: 0 Supabase/Anthropic/red.
  {
    const modulo = readFileSync(new URL('../lib/seguimiento/estadoCapturaHoja.ts', import.meta.url), 'utf-8')
    verificar(!modulo.includes('supabase') && !modulo.includes('Anthropic') && !modulo.includes('fetch('), 'CASO G. estadoCapturaHoja.ts no importa Supabase, Anthropic ni hace ninguna llamada de red')
    verificar(modulo.includes('construirMatrizRevision'), 'CASO G. reutiliza construirMatrizRevision — nunca reimplementa esCeldaBloqueante/bloqueantes aparte')
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
