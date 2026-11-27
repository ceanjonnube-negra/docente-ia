// Hito 3, etapa 3a — modelo de lectura compartido del historial académico.
// Sin red, sin IA: periodo resuelto sin modificar datos, campos formativos
// sin atribución arbitraria, ausencia de evaluación vs. nivel bajo,
// separación por inscripción/ciclo/docente, filtros y número de consultas.
//   npx tsx scripts/verificar-historial-academico-3a.ts

import { readFileSync } from 'node:fs'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ResultadoProyectoGrupo } from '../lib/motorContexto'
import { resolverPeriodoDeProyecto, type PeriodoReferencia } from '../lib/seguimiento/periodoProyecto'
import { celdaHistorial, construirHistorialGrupo, indicadoresQueRequierenApoyo } from '../lib/seguimiento/historialGrupo'
import { historialAcademicoAlumno } from '../lib/seguimiento/historialAcademico'

let fallos = 0
let total = 0
function verificar(ok: boolean, nombre: string) {
  total++
  if (!ok) fallos++
  console.log(`${ok ? '✓' : '✗'} ${nombre}`)
}
const leer = (r: string) => readFileSync(r, 'utf-8')

const C1 = 'ciclo-2026', C2 = 'ciclo-2027'
const PER: (PeriodoReferencia & { ciclo_escolar_id: string })[] = [
  { id: 'p1', nombre: 'Primer trimestre', numero_periodo: 1, fecha_inicio: '2026-09-01', fecha_fin: '2026-11-30', ciclo_escolar_id: C1 },
  { id: 'p2', nombre: 'Segundo trimestre', numero_periodo: 2, fecha_inicio: '2026-12-01', fecha_fin: '2027-03-15', ciclo_escolar_id: C1 },
  { id: 'p3', nombre: 'Tercer trimestre', numero_periodo: 3, fecha_inicio: null, fecha_fin: null, ciclo_escolar_id: C1 },
  { id: 'q1', nombre: 'Primer trimestre', numero_periodo: 1, fecha_inicio: '2027-09-01', fecha_fin: '2027-11-30', ciclo_escolar_id: C2 },
]
const deC1 = PER.filter((p) => p.ciclo_escolar_id === C1)
const r = (p: { periodoEvaluacionId?: string | null; fechaInicio?: string | null; fechaFin?: string | null }, lista: PeriodoReferencia[] = deC1) =>
  resolverPeriodoDeProyecto({ periodoEvaluacionId: p.periodoEvaluacionId ?? null, fechaInicio: p.fechaInicio ?? null, fechaFin: p.fechaFin ?? null }, lista)

// 1. Periodo: registrado válido > fechas inequívocas > ninguno.
verificar(r({ periodoEvaluacionId: 'p2', fechaInicio: '2026-10-01' })?.id === 'p2' && r({ periodoEvaluacionId: 'p2' })?.origen === 'registrado', '1a. Prioriza el periodo registrado cuando es válido')
verificar(r({ periodoEvaluacionId: 'q1', fechaInicio: '2026-10-01', fechaFin: '2026-10-09' })?.id === 'p1' && r({ periodoEvaluacionId: 'q1', fechaInicio: '2026-10-01' })?.origen === 'fechas', '1b. Registrado de otro ciclo (inválido): se resuelve por fechas')
verificar(r({ fechaInicio: '2026-11-24', fechaFin: '2026-11-30' })?.id === 'p1', '1c. Fechas dentro de un único periodo: ese periodo')
verificar(r({ fechaInicio: '2026-11-28', fechaFin: '2026-12-04' }) === null, '1d. Proyecto que cruza dos periodos: sin periodo (ambiguo)')
const traslape = [...deC1, { id: 'px', nombre: 'Traslapado', numero_periodo: 9, fecha_inicio: '2026-10-01', fecha_fin: '2026-10-31' }]
verificar(r({ fechaInicio: '2026-10-05', fechaFin: '2026-10-09' }, traslape) === null, '1e. Periodos traslapados: sin periodo (ambiguo)')
verificar(r({}) === null && r({ fechaInicio: '2027-05-01' }) === null, '1f. Sin fechas o fuera de todo periodo: sin periodo')
verificar(r({ fechaFin: '2026-12-10' })?.id === 'p2', '1g. Solo fecha de fin: se usa si es inequívoca')

// Filas con la forma real de resultadosProyecto*().
type Proy = { id: string; ciclo?: string; grupo?: string; campos?: string[]; ini?: string | null; fin?: string | null; periodo?: string | null; conf: string }
const fila = (pr: Proy, ins: string, alu: string, n: number, nivel: string): ResultadoProyectoGrupo => ({
  proyecto_id: pr.id, alumno_id: alu, inscripcion_id: ins, indicador_numero: n, indicador_especifico: `Indicador ${n}`,
  aspecto_general: 'logro_aprendizaje', nivel: nivel as ResultadoProyectoGrupo['nivel'], confianza: 1, corregido_manualmente: false, observacion: null,
  proyectos_seguimiento: { nombre: `Proyecto ${pr.id}`, docente_id: 'd1', grupo_id: pr.grupo ?? 'g1', ciclo_escolar_id: pr.ciclo ?? C1, periodo_evaluacion_id: pr.periodo ?? null, campos_formativos: pr.campos ?? ['Lenguajes'], fecha_inicio: pr.ini ?? null, fecha_fin: pr.fin ?? null, origen_resultados: 'fotografia', confirmado_en: pr.conf },
})
const PA: Proy = { id: 'A', campos: ['Lenguajes'], ini: '2026-10-05', fin: '2026-10-09', conf: '2026-10-10T10:00:00Z' }
const PB: Proy = { id: 'B', campos: ['Ética, Naturaleza y Sociedades', 'Saberes y Pensamiento Científico'], ini: '2026-11-28', fin: '2026-12-04', conf: '2026-12-05T10:00:00Z' }
const PC: Proy = { id: 'C', ciclo: C2, grupo: 'g2', ini: '2027-09-10', fin: '2027-09-20', conf: '2027-09-21T10:00:00Z' }
const filas = [
  fila(PA, 'insA', 'alu1', 1, 'logrado'), fila(PA, 'insA', 'alu1', 2, 'requiere_apoyo'), fila(PA, 'insA', 'alu1', 3, 'no_evaluado'),
  fila(PA, 'insB', 'alu2', 1, 'destacado'), fila(PA, 'insB', 'alu2', 2, 'no_evaluado'),
  fila(PB, 'insA', 'alu1', 1, 'en_proceso'),
  fila(PC, 'insC', 'alu1', 1, 'requiere_apoyo'),
]
const h = construirHistorialGrupo(filas, PER)
const proy = (id: string) => h.proyectos.find((p) => p.proyectoId === id)!

// 2. Metadata real y periodo por proyecto (sin modificar registros).
verificar(proy('A').periodo?.id === 'p1' && proy('B').periodo === null && proy('C').periodo?.id === 'q1', '2a. Periodo resuelto por proyecto con los periodos de SU ciclo (A→p1, B cruza→ninguno, C→ciclo 2027)')
verificar(h.periodos.map((p) => p.id).join() === 'p1,q1' && h.proyectosSinPeriodo === 1, '2b. Periodos presentes y conteo de «Sin periodo asignado»')
verificar(proy('A').nombre === 'Proyecto A' && proy('A').fechaInicio === '2026-10-05' && proy('C').cicloEscolarId === C2 && proy('C').grupoId === 'g2', '2c. Nombre, fechas, grupo y ciclo reales del proyecto')
verificar(proy('A').campoFormativo === 'Lenguajes' && proy('B').campoFormativo === null && proy('B').camposFormativos.length === 2, '2d. Campo formativo: atribuido solo con un campo; con varios, ninguno')

// 3. Ausencia de evaluación ≠ nivel bajo; apoyo solo con indicadores confirmados.
const a1 = h.alumnos.find((a) => a.inscripcionId === 'insA')!
const cA = a1.proyectos.find((p) => p.proyectoId === 'A')!.conteo
verificar(cA.evaluados === 2 && cA.sinEvaluar === 1 && cA.requiereApoyo === 1, '3a. Conteo: «sin evaluar» separado de «requiere apoyo»')
verificar(h.alumnos.find((a) => a.inscripcionId === 'insB')!.proyectos[0].conteo.requiereApoyo === 0, '3b. «Sin evaluar» nunca cuenta como «requiere apoyo»')
verificar(JSON.stringify(indicadoresQueRequierenApoyo(a1)) === JSON.stringify([{ proyectoId: 'A', indicadorNumero: 2, indicadorEspecifico: 'Indicador 2' }]), '3c. Necesidades de apoyo: solo indicadores confirmados en «Requiere apoyo», con su proyecto')
verificar(celdaHistorial(h, 'insB', 'B').estado === 'sin_registro' && celdaHistorial(h, 'insA', 'B').estado === 'con_resultados', '3d. Celda alumno×proyecto: «sin registro» distinto de resultados')

// 4. Separación por inscripción y ciclo.
verificar(h.alumnos.filter((a) => a.alumnoId === 'alu1').map((a) => a.inscripcionId).sort().join() === 'insA,insC', '4a. Mismo alumno, dos inscripciones (ciclos distintos): dos nodos separados')
verificar(h.alumnos.find((a) => a.inscripcionId === 'insC')!.proyectos.map((p) => p.proyectoId).join() === 'C', '4b. Cada inscripción solo con los proyectos de su ciclo')

// 5. Filtros coherentes (estructura y resumen).
const f1 = construirHistorialGrupo(filas, PER, { periodoId: 'p1' })
verificar(f1.proyectos.map((p) => p.proyectoId).join() === 'A' && f1.resumen.totalIndicadoresConfirmados === 5, '5a. Filtro por periodo')
verificar(construirHistorialGrupo(filas, PER, { periodoId: 'sin_periodo' }).proyectos.map((p) => p.proyectoId).join() === 'B', '5b. Filtro «Sin periodo asignado»')
const f3 = construirHistorialGrupo(filas, PER, { campoFormativo: 'Saberes y Pensamiento Científico' })
verificar(f3.proyectos.map((p) => p.proyectoId).join() === 'B' && f3.resumen.alumnosConResultados === 1, '5c. Filtro por campo formativo (proyectos que lo incluyen)')

// 6. Determinista y sin periodos: nada inventado.
verificar(JSON.stringify(construirHistorialGrupo(filas.slice().reverse(), PER)) === JSON.stringify(h), '6a. Determinista: mismo resultado con filas en otro orden')
verificar(construirHistorialGrupo(filas).proyectos.every((p) => p.periodo === null), '6b. Sin periodos del ciclo: ningún periodo inventado')

;(async () => {
  // 7. Historial individual: 2 consultas, separado por docente, periodos con .in.
  const llamadas: { tabla: string; metodo: string; args: unknown[] }[] = []
  const sb = {
    from: (tabla: string) => {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'not', 'order', 'in']) b[m] = (...args: unknown[]) => { llamadas.push({ tabla, metodo: m, args }); return b }
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: tabla === 'seguimiento_resultados' ? filas.filter((f) => f.alumno_id === 'alu1') : PER, error: null }).then(ok)
      return b
    },
  } as unknown as SupabaseClient
  const ind = await historialAcademicoAlumno(sb, 'alu1', 'd1')
  const tablas = [...new Set(llamadas.map((l) => l.tabla))]
  verificar(tablas.join() === 'seguimiento_resultados,periodos_evaluacion', '7a. Individual: exactamente 2 consultas (resultados y periodos), sin N+1')
  verificar(llamadas.some((l) => l.metodo === 'eq' && l.args[0] === 'proyectos_seguimiento.docente_id' && l.args[1] === 'd1'), '7b. Individual: separado por docente')
  verificar(llamadas.some((l) => l.tabla === 'periodos_evaluacion' && l.metodo === 'in' && JSON.stringify(l.args[1]) === JSON.stringify([C1, C2])), '7c. Periodos de todos sus ciclos en una sola consulta')
  verificar(ind.alumnos.length === 2 && ind.proyectos.length === 3, '7d. Individual: sus inscripciones y proyectos con el mismo modelo')

  // 8. Fuentes: sin IA, sin escrituras en la lectura, proyectos nuevos con la regla compartida.
  const lectura = ['lib/seguimiento/periodoProyecto.ts', 'lib/seguimiento/historialGrupo.ts', 'lib/seguimiento/historialAcademico.ts'].map(leer).join('\n')
  verificar(!/anthropic|openai|clasificarNivel0|generateText|streamText/.test(lectura) && !/\.from\([^)]*\)[\s\S]{0,200}?\.(insert|update|upsert|delete)\(|\.rpc\(/.test(lectura), '8a. Modelo de lectura sin IA ni escrituras')
  const crear = leer('app/api/proyectos-seguimiento/route.ts')
  verificar(/resolverPeriodoDeProyecto\(/.test(crear) && /periodo_evaluacion_id: periodoId/.test(crear), '8b. Proyectos nuevos: periodo asignado con la regla compartida cuando es inequívoco')
  verificar(/resolverPeriodoPorFechaInicio/.test(leer('lib/seguimiento/periodoProyecto.ts')), '8c. Reutiliza la regla de periodo de la aprobación de planeaciones')

  console.log(`\n${total - fallos}/${total} verificaciones correctas`)
  process.exit(fallos ? 1 : 0)
})()
