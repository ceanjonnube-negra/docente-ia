// Hito 3, etapa 3b — historial académico individual en la ficha del alumno.
// Sin red, sin IA: organización por ciclo/inscripción/periodo/proyecto,
// «Requiere apoyo» vs «Sin evaluar» vs «Sin registro», consultas (sin N+1,
// propiedad por grupo del docente) y presentación.
//   npx tsx scripts/verificar-historial-alumno-3b.tsx

import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ResultadoProyectoGrupo } from '../lib/motorContexto'
import { construirHistorialGrupo, metadataDeProyecto, organizarHistorialAlumno, type InscripcionHistorial } from '../lib/seguimiento/historialGrupo'
import { historialAlumnoCompleto } from '../lib/seguimiento/historialAcademico'
import { ETIQUETA_NIVEL_CANONICO } from '../lib/seguimiento/conversionCalificacion'
import HistorialAcademicoAlumno from '../components/Lista/HistorialAcademicoAlumno'

let fallos = 0
let total = 0
function verificar(ok: boolean, nombre: string) {
  total++
  if (!ok) fallos++
  console.log(`${ok ? '✓' : '✗'} ${nombre}`)
}

const C1 = 'ciclo-2026', C0 = 'ciclo-2025'
const PER = [
  { id: 'p1', nombre: 'Primer trimestre', numero_periodo: 1, fecha_inicio: '2026-09-01', fecha_fin: '2026-11-30', ciclo_escolar_id: C1 },
  { id: 'p2', nombre: 'Segundo trimestre', numero_periodo: 2, fecha_inicio: '2026-12-01', fecha_fin: '2027-03-15', ciclo_escolar_id: C1 },
]
type Proy = { id: string; grupo: string; ciclo: string; ini: string; fin: string; conf: string; campos?: string[] }
const ps = (p: Proy) => ({ nombre: `Proyecto ${p.id}`, docente_id: 'd1', grupo_id: p.grupo, ciclo_escolar_id: p.ciclo, periodo_evaluacion_id: null, campos_formativos: p.campos ?? ['Lenguajes'], fecha_inicio: p.ini, fecha_fin: p.fin, origen_resultados: 'fotografia', confirmado_en: p.conf })
const fila = (p: Proy, ins: string, n: number, nivel: string): ResultadoProyectoGrupo => ({
  proyecto_id: p.id, alumno_id: 'alu1', inscripcion_id: ins, indicador_numero: n, indicador_especifico: `Indicador ${n}`, aspecto_general: 'logro_aprendizaje',
  nivel: nivel as ResultadoProyectoGrupo['nivel'], confianza: 1, corregido_manualmente: false, observacion: null, proyectos_seguimiento: ps(p),
})
const A: Proy = { id: 'A', grupo: 'g3', ciclo: C1, ini: '2026-10-05', fin: '2026-10-09', conf: '2026-10-10T10:00:00Z' }
const B: Proy = { id: 'B', grupo: 'g3', ciclo: C1, ini: '2026-12-03', fin: '2026-12-08', conf: '2026-12-09T10:00:00Z', campos: ['Lenguajes', 'De lo Humano y lo Comunitario'] }
const X: Proy = { id: 'X', grupo: 'g3', ciclo: C1, ini: '2026-11-28', fin: '2026-12-04', conf: '2026-12-05T10:00:00Z' } // sin registro y cruza periodos
const V: Proy = { id: 'V', grupo: 'g2', ciclo: C0, ini: '2025-10-01', fin: '2025-10-05', conf: '2025-10-06T10:00:00Z' } // ciclo anterior
const filas = [
  fila(A, 'ins-act', 1, 'logrado'), fila(A, 'ins-act', 2, 'requiere_apoyo'), fila(A, 'ins-act', 3, 'no_evaluado'),
  fila(B, 'ins-act', 1, 'destacado'),
  fila(V, 'ins-ant', 1, 'en_proceso'),
]
const INS: InscripcionHistorial[] = [
  { inscripcionId: 'ins-ant', grupoId: 'g2', cicloEscolarId: C0, estatus: 'baja', fechaInscripcion: '2025-08-20', grupoNombre: '2° A', cicloNombre: '2025-2026' },
  { inscripcionId: 'ins-act', grupoId: 'g3', cicloEscolarId: C1, estatus: 'activo', fechaInscripcion: '2026-08-20', grupoNombre: '3° A', cicloNombre: '2026-2027' },
]
const deGrupos = [A, B, X, V].map((p) => metadataDeProyecto(p.id, ps(p), PER))
const h = organizarHistorialAlumno(construirHistorialGrupo(filas, PER), INS, deGrupos)

// 1. Organización.
verificar(h.ciclos.map((c) => c.cicloEscolarId).join() === `${C1},${C0}` && h.ciclos[0].inscripciones[0].inscripcion.estatus === 'activo', '1a. Por ciclo e inscripción: la activa primero, la anterior (baja) después')
const act = h.ciclos[0].inscripciones[0]
verificar(act.periodos.map((g) => g.periodo?.nombre ?? 'Sin periodo asignado').join() === 'Primer trimestre,Segundo trimestre,Sin periodo asignado', '1b. Periodos por número; «Sin periodo asignado» al final')
verificar(h.ciclos[1].inscripciones[0].periodos.flatMap((g) => g.proyectos.map((p) => p.proyecto.proyectoId)).join() === 'V', '1c. Cada inscripción solo con los proyectos de su grupo y ciclo')
const todos = act.periodos.flatMap((g) => g.proyectos)
const pA = todos.find((p) => p.proyecto.proyectoId === 'A')!, pX = todos.find((p) => p.proyecto.proyectoId === 'X')!
verificar(pX.estado === 'sin_registro' && pA.estado === 'con_resultados', '1d. Proyecto confirmado del grupo sin resultados del alumno: «Sin registro»')
verificar(pA.estado === 'con_resultados' && pA.distribucion.requiere_apoyo === 1 && pA.distribucion.no_evaluado === 1 && pA.distribucion.logrado === 1, '1e. Distribución con los niveles reales (Requiere apoyo y Sin evaluar separados)')
verificar(h.proyectosConResultados.map((x) => x.proyecto.proyectoId).join() === 'B,A,V' && h.ultimaConfirmacion === B.conf, '1f. Proyectos con resultados (más reciente primero) y última confirmación')
verificar(JSON.stringify(organizarHistorialAlumno(construirHistorialGrupo(filas.slice().reverse(), PER), INS.slice().reverse(), deGrupos.slice().reverse())) === JSON.stringify(h), '1g. Determinista: mismo resultado con entradas en otro orden')

// 2. Etiquetas reales de la hoja.
verificar(ETIQUETA_NIVEL_CANONICO.destacado === 'Dominio destacado' && ETIQUETA_NIVEL_CANONICO.logrado === 'Logro esperado' && ETIQUETA_NIVEL_CANONICO.requiere_apoyo === 'Requiere apoyo' && ETIQUETA_NIVEL_CANONICO.no_evaluado === 'Sin evaluar', '2a. Etiquetas de nivel = las de la hoja impresa; «Sin evaluar» no es un nivel')

// 3. Presentación.
const html = renderToStaticMarkup(<HistorialAcademicoAlumno historial={h} error={false} />)
verificar(html.includes('Proyecto A') && html.includes('Primer trimestre') && html.includes('Sin periodo asignado') && html.includes('2025-2026') && html.includes('Baja'), '3a. Muestra ciclo, inscripción (baja), periodo y proyecto')
verificar(html.includes('1 indicador en Requiere apoyo') && html.includes('1 Sin evaluar') && html.includes('Sin registro: este alumno no tiene resultados en este proyecto.'), '3b. Diferencia Requiere apoyo, Sin evaluar y Sin registro')
verificar(html.includes('Lenguajes · De lo Humano y lo Comunitario') && html.includes('Ver indicadores (3)') && html.includes('Logro esperado'), '3c. Campos del proyecto sin atribución por indicador; indicadores con su nivel')
verificar(!/promedio|calificaci[oó]n|aprobad|reprobad|bajo rendimiento/i.test(html), '3d. Sin calificaciones, promedios ni conclusiones')
verificar(renderToStaticMarkup(<HistorialAcademicoAlumno historial={null} error />).includes('No se pudieron cargar') && renderToStaticMarkup(<HistorialAcademicoAlumno historial={organizarHistorialAlumno(construirHistorialGrupo([], PER), [], [])} error={false} />).includes('Aún no hay resultados confirmados'), '3e. Error visible y estado vacío claros')

;(async () => {
  // 4. Consultas: 4 en 2 rondas, propiedad por grupo del docente, error visible.
  const llamadas: { tabla: string; metodo: string; args: unknown[] }[] = []
  const datos: Record<string, unknown[]> = {
    inscripciones: INS.map((i) => ({ id: i.inscripcionId, grupo_id: i.grupoId, ciclo_escolar_id: i.cicloEscolarId, estatus: i.estatus, fecha_inscripcion: i.fechaInscripcion, grupos: { grado: i.grupoNombre![0], grupo: 'A', nombre_grupo: null }, ciclos_escolares: { nombre: i.cicloNombre } })),
    seguimiento_resultados: filas,
    periodos_evaluacion: PER,
    proyectos_seguimiento: [A, B, X, V].map((p) => ({ id: p.id, ...ps(p) })),
  }
  let falla: string | null = null
  const sb = {
    from: (tabla: string) => {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'not', 'order', 'in']) b[m] = (...args: unknown[]) => { llamadas.push({ tabla, metodo: m, args }); return b }
      b.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(falla === tabla ? { data: null, error: { message: 'falla' } } : { data: datos[tabla], error: null }).then(ok, ko)
      return b
    },
  } as unknown as SupabaseClient
  const r = await historialAlumnoCompleto(sb, 'alu1', 'd1')
  verificar([...new Set(llamadas.map((l) => l.tabla))].sort().join() === 'inscripciones,periodos_evaluacion,proyectos_seguimiento,seguimiento_resultados' && llamadas.filter((l) => l.metodo === 'select').length === 4, '4a. Exactamente 4 consultas (sin N+1)')
  verificar(llamadas.some((l) => l.tabla === 'inscripciones' && l.metodo === 'eq' && l.args[0] === 'grupos.docente_id' && l.args[1] === 'd1') && /grupos!inner/.test(String(llamadas.find((l) => l.tabla === 'inscripciones' && l.metodo === 'select')?.args[0])), '4b. Inscripciones: propiedad por el grupo del docente (inscripciones.docente_id puede venir vacío)')
  verificar(llamadas.some((l) => l.tabla === 'proyectos_seguimiento' && l.metodo === 'eq' && l.args[0] === 'docente_id' && l.args[1] === 'd1') && llamadas.some((l) => l.tabla === 'seguimiento_resultados' && l.metodo === 'eq' && l.args[0] === 'proyectos_seguimiento.docente_id'), '4c. Proyectos y resultados separados por docente')
  verificar(r.proyectosConResultados.length === 3 && r.ciclos[0].inscripciones[0].inscripcion.grupoNombre === '3° A', '4d. Resultado completo con nombres reales de grupo y ciclo')
  falla = 'proyectos_seguimiento'
  let lanzo = false
  try { await historialAlumnoCompleto(sb, 'alu1', 'd1') } catch { lanzo = true }
  verificar(lanzo, '4e. Un error de consulta se reporta (nunca se muestra como «sin resultados»)')

  // 5. Ficha: sin tabla antigua, misma fuente para Evaluaciones e Historial.
  const ficha = readFileSync('app/dashboard/lista/[alumnoId]/page.tsx', 'utf-8')
  verificar(!/from\('evaluaciones'\)/.test(ficha) && /historialAlumnoCompleto\(supabase, alumnoId/.test(ficha), '5a. La ficha ya no lee la tabla antigua «evaluaciones»; usa el historial canónico')
  verificar(/historialAcademico\?\.proyectosConResultados \?\? \[\]\)\.map\(\(\{ proyecto, resultado \}\)/.test(ficha) && /origen: 'Asistencia'/.test(ficha) && /origen: 'Incidencia'/.test(ficha) && /origen: 'Evidencia'/.test(ficha) && /origen: 'Nota'/.test(ficha), '5b. Historial: una entrada por proyecto confirmado, conservando las demás entradas')
  const lectura = ['lib/seguimiento/historialAcademico.ts', 'lib/seguimiento/historialGrupo.ts', 'components/Lista/HistorialAcademicoAlumno.tsx'].map((f) => readFileSync(f, 'utf-8')).join('\n')
  verificar(!/anthropic|openai|generateText|streamText|\/api\/chat/.test(lectura) && !/\.(insert|update|upsert)\(|\.rpc\(/.test(lectura), '5c. Sin IA y sin escrituras (los resultados confirmados no se modifican)')

  console.log(`\n${total - fallos}/${total} verificaciones correctas`)
  process.exit(fallos ? 1 : 0)
})()
