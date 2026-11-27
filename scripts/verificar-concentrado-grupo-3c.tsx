// Hito 3, etapa 3c — concentrado académico del grupo en Evaluación.
// Sin red, sin IA: conteos por alumno y por proyecto sobre el modelo
// compartido, «Sin evaluar» vs «Sin registro», bajas, filtros, Requiere
// apoyo sin etiquetas, escala (40 alumnos × 15 proyectos) y presentación.
//   npx tsx scripts/verificar-concentrado-grupo-3c.tsx

import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ResultadoProyectoGrupo } from '../lib/motorContexto'
import { construirConcentradoGrupo, construirHistorialGrupo, type InscripcionDelGrupo } from '../lib/seguimiento/historialGrupo'

process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://127.0.0.1:9'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'sin-clave-pruebas'

let fallos = 0
let total = 0
function verificar(ok: boolean, nombre: string) {
  total++
  if (!ok) fallos++
  console.log(`${ok ? '✓' : '✗'} ${nombre}`)
}
const leer = (r: string) => readFileSync(r, 'utf-8')

const C = 'ciclo-1'
const PER = [
  { id: 'p1', nombre: 'Primer trimestre', numero_periodo: 1, fecha_inicio: '2026-09-01', fecha_fin: '2026-11-30', ciclo_escolar_id: C },
  { id: 'p2', nombre: 'Segundo trimestre', numero_periodo: 2, fecha_inicio: '2026-12-01', fecha_fin: '2027-03-15', ciclo_escolar_id: C },
]
type Proy = { id: string; ini: string; fin: string; conf: string; campos: string[] }
const fila = (p: Proy, ins: string, alu: string, n: number, nivel: string): ResultadoProyectoGrupo => ({
  proyecto_id: p.id, alumno_id: alu, inscripcion_id: ins, indicador_numero: n, indicador_especifico: `Indicador ${n} de ${p.id}`, aspecto_general: 'logro_aprendizaje',
  nivel: nivel as ResultadoProyectoGrupo['nivel'], confianza: 1, corregido_manualmente: false, observacion: null,
  proyectos_seguimiento: { nombre: `Proyecto ${p.id}`, docente_id: 'd1', grupo_id: 'g1', ciclo_escolar_id: C, periodo_evaluacion_id: null, campos_formativos: p.campos, fecha_inicio: p.ini, fecha_fin: p.fin, origen_resultados: 'fotografia', confirmado_en: p.conf },
})
const A: Proy = { id: 'A', ini: '2026-10-05', fin: '2026-10-09', conf: '2026-10-10T10:00:00Z', campos: ['Lenguajes'] }
const B: Proy = { id: 'B', ini: '2026-12-03', fin: '2026-12-08', conf: '2026-12-09T10:00:00Z', campos: ['Lenguajes', 'Saberes y Pensamiento Científico'] }
const X: Proy = { id: 'X', ini: '2026-11-28', fin: '2026-12-04', conf: '2026-12-05T10:00:00Z', campos: ['De lo Humano y lo Comunitario'] }
const INS: InscripcionDelGrupo[] = [
  { inscripcionId: 'i-ana', alumnoId: 'ana', nombre: 'Ana', estatus: 'activo' },
  { inscripcionId: 'i-beto', alumnoId: 'beto', nombre: 'Beto', estatus: 'activo' },
  { inscripcionId: 'i-ceci', alumnoId: 'ceci', nombre: 'Ceci', estatus: 'baja' }, // baja con resultados en A
  { inscripcionId: 'i-dani', alumnoId: 'dani', nombre: 'Dani', estatus: 'baja' }, // baja sin resultados
]
const filas = [
  fila(A, 'i-ana', 'ana', 1, 'logrado'), fila(A, 'i-ana', 'ana', 2, 'requiere_apoyo'), fila(A, 'i-ana', 'ana', 3, 'no_evaluado'),
  fila(A, 'i-ceci', 'ceci', 1, 'destacado'),
  fila(B, 'i-ana', 'ana', 1, 'en_proceso'), fila(B, 'i-beto', 'beto', 1, 'requiere_apoyo'),
  fila(X, 'i-beto', 'beto', 1, 'logrado'),
]
const h = construirHistorialGrupo(filas, PER)
const c = construirConcentradoGrupo(h, INS)
const alumno = (n: string) => c.alumnos.find((a) => a.inscripcion.nombre === n)!
const proyecto = (id: string) => c.proyectos.find((p) => p.proyecto.proyectoId === id)!

// 1. Por alumno.
verificar(c.alumnos.map((a) => a.inscripcion.nombre).join() === 'Ana,Beto,Ceci', '1a. Activos y bajas con resultados, por nombre; una baja sin resultados no aparece')
verificar(alumno('Ana').requiereApoyo === 1 && alumno('Ana').sinEvaluar === 1 && alumno('Ana').sinRegistro === 1 && alumno('Ana').distribucion.logrado === 1, '1b. Ana: Requiere apoyo, Sin evaluar y Sin registro (proyecto X) contados por separado')
verificar(alumno('Ceci').sinRegistro === 0 && alumno('Ceci').proyectos.map((p) => p.proyecto.proyectoId).join() === 'A', '1c. Baja: solo sus proyectos con resultados (nunca «Sin registro»)')
verificar(alumno('Beto').apoyo.map((x) => `${x.proyectoId}:${x.indicadorNumero}`).join() === 'B:1', '1d. Requiere apoyo: indicadores confirmados con su proyecto')

// 2. Por proyecto y grupo.
verificar(proyecto('A').alumnosConResultados === 2 && proyecto('A').sinRegistro === 1 && proyecto('A').indicadoresRequierenApoyo === 1, '2a. Proyecto A: 2 con resultados (incluye baja), 1 activo sin registro, 1 indicador en Requiere apoyo')
verificar(c.distribucion.requiere_apoyo === 2 && c.distribucion.no_evaluado === 1 && c.indicadoresRequierenApoyo === 2 && c.alumnosConIndicadoresEnApoyo === 2, '2b. Distribución grupal y conteo de Requiere apoyo (conteo directo)')
verificar(proyecto('B').proyecto.campoFormativo === null && proyecto('X').proyecto.periodo === null, '2c. Sin atribución por campo con varios campos; proyecto que cruza periodos sin periodo')

// 3. Filtros (misma regla que 3a) y opciones.
const f1 = construirConcentradoGrupo(h, INS, { periodoId: 'p1' })
verificar(f1.proyectos.map((p) => p.proyecto.proyectoId).join() === 'A' && f1.alumnos.find((a) => a.inscripcion.nombre === 'Beto')!.sinRegistro === 1, '3a. Filtro por periodo (y «Sin registro» dentro del filtro)')
verificar(construirConcentradoGrupo(h, INS, { periodoId: 'sin_periodo' }).proyectos.map((p) => p.proyecto.proyectoId).join() === 'X', '3b. Filtro «Sin periodo asignado»')
const f3 = construirConcentradoGrupo(h, INS, { campoFormativo: 'Saberes y Pensamiento Científico' })
verificar(f3.proyectos.map((p) => p.proyecto.proyectoId).join() === 'B' && f3.alumnos.map((a) => a.inscripcion.nombre).join() === 'Ana,Beto', '3c. Filtro por campo: proyectos que lo trabajan (una baja sin resultados en ellos no aparece)')
verificar(f1.opciones.periodos.map((p) => p.id).join() === 'p1,p2' && f1.opciones.haySinPeriodo && f1.opciones.campos.length === 3, '3d. Opciones de filtro de todos los proyectos, no solo los filtrados')
verificar(/cumpleFiltro\(p, filtro\)/.test(leer('lib/seguimiento/historialGrupo.ts').split('construirConcentradoGrupo')[1] ?? '') && /if \(!cumpleFiltro\(p, filtro\)\) proyectosPorId\.delete/.test(leer('lib/seguimiento/historialGrupo.ts')), '3e. Una sola regla de filtro para historial y concentrado')

// 4. Escala y determinismo.
const proyectos: Proy[] = Array.from({ length: 15 }, (_, k) => ({ id: `P${k}`, ini: `2026-${String(9 + (k % 3)).padStart(2, '0')}-0${1 + (k % 8)}`, fin: `2026-${String(9 + (k % 3)).padStart(2, '0')}-0${2 + (k % 8)}`, conf: `2026-11-${String(10 + k).padStart(2, '0')}T10:00:00Z`, campos: ['Lenguajes'] }))
const grande = Array.from({ length: 40 }, (_, k) => ({ inscripcionId: `i${k}`, alumnoId: `a${k}`, nombre: `Alumno ${String(k).padStart(2, '0')}`, estatus: 'activo' }))
const niveles = ['destacado', 'logrado', 'en_proceso', 'requiere_apoyo', 'no_evaluado']
const filasGrandes = proyectos.flatMap((p, j) => grande.filter((_, k) => (k + j) % 9 !== 0).flatMap((a, k) => [1, 2, 3, 4, 5].map((n) => fila(p, a.inscripcionId, a.alumnoId, n, niveles[(k + n + j) % 5]))))
const t0 = performance.now()
const cg = construirConcentradoGrupo(construirHistorialGrupo(filasGrandes, PER), grande)
const ms = performance.now() - t0
const totalCeldas = cg.alumnos.reduce((s, a) => s + a.proyectos.length, 0)
verificar(cg.alumnos.length === 40 && cg.proyectos.length === 15 && totalCeldas === 600 && Object.values(cg.distribucion).reduce((s, n) => s + n, 0) === filasGrandes.length, `3f. 40 alumnos × 15 proyectos: todas las celdas y los ${filasGrandes.length} indicadores contados (${ms.toFixed(0)} ms)`)
verificar(JSON.stringify(construirConcentradoGrupo(construirHistorialGrupo(filas.slice().reverse(), PER), INS.slice().reverse())) === JSON.stringify(c), '4a. Determinista: mismo resultado con entradas en otro orden')

// 5. Presentación (sin red).
;(async () => {
const { PanelConcentrado } = await import('../components/Evaluacion/ConcentradoGrupo')
const html = renderToStaticMarkup(<PanelConcentrado datos={{ historial: h, inscripciones: INS }} onVerProyecto={() => {}} />)
verificar(html.includes('3 proyectos confirmados') && html.includes('3 alumnos') && html.includes('Todos los periodos') && html.includes('Sin periodo asignado') && html.includes('Todos los campos'), '5a. Resumen y filtros de periodo y campo formativo')
verificar(html.includes('2 indicadores confirmados') && html.includes('Requiere apoyo') && html.includes('Indicador 2 de A') && !/en riesgo|rezago|bajo rendimiento|reprob/i.test(html), '5b. Requiere apoyo como indicadores confirmados, sin etiquetar al alumno')
verificar(html.includes('1 Sin evaluar') && html.includes('1 Sin registro') && html.includes('Sin registro en este proyecto.') && html.includes('Baja'), '5c. Diferencia Sin evaluar y Sin registro; bajas identificadas')
verificar(html.includes('/dashboard/lista/ana?tab=evaluaciones') && html.includes('Ver evaluación') && html.includes('Por alumno') && html.includes('Por proyecto'), '5d. Navegación a la ficha y a la evaluación original; vistas por alumno y por proyecto')
verificar(!/promedio|calificaci[oó]n|<table/i.test(html), '5e. Sin promedios ni calificaciones; sin matriz ancha')

// 6. Fuentes.
const ruta = leer('app/api/proyectos-seguimiento/historial-grupo/route.ts')
verificar(/historialAcademicoGrupo\(/.test(ruta) && /inscripcionesDelGrupo\(/.test(ruta) && /Promise\.all/.test(ruta), '6a. Endpoint existente: historial + inscripciones en paralelo (sin N+1)')
const pagina = leer('app/dashboard/evaluacion/page.tsx')
verificar(/<ConcentradoGrupo grupoId=\{grupoId\} onVerProyecto=\{verProyecto\} \/>/.test(pagina) && /setResultadosAbiertos\(proyectoId\)/.test(pagina) && /vista === 'hojas' && proyectos\.map/.test(pagina), '6b. Evaluación: pestaña Concentrado; «Ver evaluación» abre los resultados originales del proyecto')
const codigo = ['components/Evaluacion/ConcentradoGrupo.tsx', 'lib/seguimiento/historialGrupo.ts', 'lib/seguimiento/historialAcademico.ts'].map(leer).join('\n')
verificar(!/anthropic|openai|generateText|streamText|\/api\/chat/.test(codigo) && !/\.(insert|update|upsert)\(|\.rpc\(/.test(codigo), '6c. Sin IA y sin escrituras (los resultados confirmados no se modifican)')

console.log(`\n${total - fallos}/${total} verificaciones correctas`)
process.exit(fallos ? 1 : 0)
})()
