// scripts/verificar-calculo-fechas-planeacion.ts
//
// Prueba aislada (sin credenciales, sin Supabase, sin React) de
// lib/planeacion/calculoFechasHabiles.ts — Paso 1 de la integración
// Chat IA → Planeación (C-005). Se ejecuta con
// `npx tsx scripts/verificar-calculo-fechas-planeacion.ts`.

import { calcularFechasPlaneacion, type DiaNoLaborable } from '../lib/planeacion/calculoFechasHabiles'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

const REF = '2026-08-03' // lunes, sin relación con la fecha real del sistema — 100% determinista

// --- 1. Dos semanas normales sin días inhábiles ---
{
  const r = calcularFechasPlaneacion({ duracionSemanas: 2, diasNoLaborables: [], fechaReferencia: REF })
  verificar(r.totalDiasEfectivos === 10, '1. Dos semanas = 10 días efectivos')
  verificar(r.fechaInicioResuelta === '2026-08-03', '1. Inicio = fecha de referencia (ya es día hábil)')
  verificar(r.fechaFinResuelta === '2026-08-14', '1. Fin correcto tras 2 fines de semana')
  verificar(!r.conflicto, '1. Sin conflicto')
}

// --- 2. Periodo que cruza un fin de semana (fechas exactas) ---
{
  const r = calcularFechasPlaneacion({ fechaInicio: '2026-08-07', fechaFin: '2026-08-10', diasNoLaborables: [], fechaReferencia: REF })
  // viernes 7, sábado 8, domingo 9, lunes 10 -> 2 efectivos, 2 excluidos por fin de semana
  verificar(r.totalDiasEfectivos === 2, '2. Cruce de fin de semana: 2 días efectivos')
  verificar(r.fechasExcluidas.filter(f => f.motivo === 'fin_de_semana').length === 2, '2. 2 días excluidos por fin de semana')
}

// --- 3. Inicio en sábado (fecha inicial explícita) ---
{
  const r = calcularFechasPlaneacion({ fechaInicio: '2026-08-08', duracionDiasEfectivos: 5, diasNoLaborables: [], fechaReferencia: REF })
  verificar(r.fechaInicioResuelta === '2026-08-10', '3. Inicio en sábado se mueve al lunes siguiente')
  verificar(r.advertencias.length > 0, '3. Se registra una advertencia, no falla silenciosamente')
}

// --- 4. Un día inhábil dentro del periodo ---
{
  const noLaborables: DiaNoLaborable[] = [{ fecha: '2026-08-05', motivo: 'dia_inhabil', descripcion: 'Día inhábil de prueba' }]
  const r = calcularFechasPlaneacion({ fechaInicio: '2026-08-03', duracionDiasEfectivos: 5, diasNoLaborables: noLaborables, fechaReferencia: REF })
  verificar(r.totalDiasEfectivos === 5, '4. Se completan los 5 días efectivos pese al día inhábil')
  verificar(r.fechasExcluidas.some(f => f.fecha === '2026-08-05' && f.motivo === 'dia_inhabil'), '4. El día inhábil queda registrado con su motivo')
  verificar(r.fechaFinResuelta !== '2026-08-07', '4. La fecha final se extendió para compensar el día inhábil')
}

// --- 5. Una semana completa de vacaciones dentro del periodo ---
{
  const vacaciones: DiaNoLaborable[] = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14']
    .map(fecha => ({ fecha, motivo: 'vacaciones' as const }))
  const r = calcularFechasPlaneacion({ fechaInicio: '2026-08-03', duracionDiasEfectivos: 10, diasNoLaborables: vacaciones, fechaReferencia: REF })
  verificar(r.totalDiasEfectivos === 10, '5. Se completan los 10 días efectivos saltando la semana de vacaciones')
  verificar(r.fechasExcluidas.filter(f => f.motivo === 'vacaciones').length === 5, '5. Los 5 días de vacaciones quedan excluidos')
}

// --- 6. Dos suspensiones separadas ---
{
  const suspensiones: DiaNoLaborable[] = [
    { fecha: '2026-08-04', motivo: 'suspension', descripcion: 'Suspensión 1' },
    { fecha: '2026-08-11', motivo: 'suspension', descripcion: 'Suspensión 2' },
  ]
  const r = calcularFechasPlaneacion({ fechaInicio: '2026-08-03', duracionDiasEfectivos: 8, diasNoLaborables: suspensiones, fechaReferencia: REF })
  verificar(r.totalDiasEfectivos === 8, '6. Se completan los 8 días pese a las 2 suspensiones')
  verificar(r.fechasExcluidas.filter(f => f.motivo === 'suspension').length === 2, '6. Las 2 suspensiones quedan registradas por separado')
}

// --- 7. Fechas exactas indicadas por el docente ---
{
  const r = calcularFechasPlaneacion({ fechaInicio: '2026-08-03', fechaFin: '2026-08-07', diasNoLaborables: [], fechaReferencia: REF })
  verificar(r.fechaInicioResuelta === '2026-08-03' && r.fechaFinResuelta === '2026-08-07', '7. Se respetan ambas fechas exactas')
  verificar(r.totalDiasEfectivos === 5, '7. 5 días efectivos dentro de una semana completa lun-vie')
}

// --- 8. Duración sin fecha inicial ---
{
  const r = calcularFechasPlaneacion({ duracionDiasEfectivos: 3, diasNoLaborables: [], fechaReferencia: REF })
  verificar(r.fechaInicioResuelta === REF, '8. Sin fecha inicial, usa la fecha de referencia (ya es día hábil)')
  verificar(r.totalDiasEfectivos === 3, '8. Calcula 3 días efectivos correctamente')
}

// --- 9. Rango sin ningún día efectivo ---
{
  const r = calcularFechasPlaneacion({ fechaInicio: '2026-08-08', fechaFin: '2026-08-09', diasNoLaborables: [], fechaReferencia: REF }) // sábado-domingo
  verificar(r.totalDiasEfectivos === 0, '9. Rango de puro fin de semana: 0 días efectivos')
  verificar(r.conflicto, '9. Se marca como conflicto')
}

// --- 10. Fecha final anterior a la inicial ---
{
  const r = calcularFechasPlaneacion({ fechaInicio: '2026-08-14', fechaFin: '2026-08-03', diasNoLaborables: [], fechaReferencia: REF })
  verificar(r.conflicto, '10. Fecha final antes que la inicial: conflicto')
  verificar(r.totalDiasEfectivos === 0 && r.diasEfectivos.length === 0, '10. Sin días efectivos calculados')
}

// --- 11. Duración cero o negativa ---
{
  const cero = calcularFechasPlaneacion({ duracionDiasEfectivos: 0, diasNoLaborables: [], fechaReferencia: REF })
  const negativa = calcularFechasPlaneacion({ duracionDiasEfectivos: -3, diasNoLaborables: [], fechaReferencia: REF })
  verificar(cero.conflicto, '11. Duración cero: conflicto, no calcula')
  verificar(negativa.conflicto, '11. Duración negativa: conflicto, no calcula')
}

// --- 12. Cambio de mes ---
{
  const r = calcularFechasPlaneacion({ fechaInicio: '2026-08-28', duracionDiasEfectivos: 5, diasNoLaborables: [], fechaReferencia: REF })
  // viernes 28 ago, luego 29-30 fin de semana, 31 ago (lunes), 1-3 sep
  verificar(r.fechaFinResuelta === '2026-09-03', '12. El cálculo cruza correctamente de agosto a septiembre')
}

// --- 13. Cambio de año ---
{
  const r = calcularFechasPlaneacion({ fechaInicio: '2026-12-28', duracionDiasEfectivos: 5, diasNoLaborables: [], fechaReferencia: REF })
  // lunes 28, martes 29, miércoles 30, jueves 31 dic, viernes 1 ene 2027
  verificar(r.fechaFinResuelta === '2027-01-01', '13. El cálculo cruza correctamente de 2026 a 2027')
}

// --- 14. Cruce del cierre de un trimestre (evento_sin_clases arbitrario) ---
{
  const cierre: DiaNoLaborable[] = [{ fecha: '2026-08-06', motivo: 'evento_sin_clases', descripcion: 'Cierre de trimestre' }]
  const r = calcularFechasPlaneacion({ fechaInicio: '2026-08-03', duracionDiasEfectivos: 5, diasNoLaborables: cierre, fechaReferencia: REF })
  verificar(r.totalDiasEfectivos === 5, '14. Se completan los 5 días pese al cierre de trimestre')
  verificar(r.fechasExcluidas.some(f => f.motivo === 'evento_sin_clases' && f.descripcion === 'Cierre de trimestre'), '14. El cierre de trimestre queda registrado con su descripción')
}

console.log('')
if (fallos > 0) {
  console.error(`${fallos} prueba(s) fallaron.`)
  process.exit(1)
} else {
  console.log('Todas las pruebas pasaron.')
}
