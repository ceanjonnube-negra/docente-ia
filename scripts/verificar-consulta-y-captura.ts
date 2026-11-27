// Mejoras previas al Hito 3:
// 1. Una pregunta sobre la planeación guardada abierta es una CONSULTA de su
//    texto canónico, no un ajuste (decidirEdicionGuardada + ruta del Chat).
// 2. Una hoja histórica sin registro de alumnos congelado no se vuelve a
//    consultar en estado-captura (Evaluación y Planeación).
// Sin red, sin IA.
//   npx tsx scripts/verificar-consulta-y-captura.ts

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decidirEdicionGuardada, esPreguntaSobrePlaneacion } from '../lib/planeacion/consultaPlaneaciones'
import { soloPideFormato } from '../lib/planeacion/modificarPlaneacion'
import { clasificacionPreguntaPlaneacion } from '../lib/clasificadorNivel0'
import { detectarConsultaPlaneacion } from '../lib/planeacion/detectarConsultaPlaneacion'
import { esConsultaDocumentoActual } from '../lib/asistente/documentos'
import { CODIGO_SIN_CAPTURA_AUTOMATICA, admiteCapturaAutomatica, conCapturaAutomatica } from '../lib/seguimiento/capturaAutomatica'

let fallos = 0
let total = 0
function verificar(ok: boolean, nombre: string) {
  total++
  if (!ok) fallos++
  console.log(`${ok ? '✓' : '✗'} ${nombre}`)
}
const leer = (r: string) => readFileSync(join(__dirname, '..', r), 'utf-8')
const decidir = (t: string) => decidirEdicionGuardada(t, { hoy: '2026-11-26', soloArchivo: soloPideFormato(t) })
const revisar = (casos: [string, string][]) => casos.filter(([t, e]) => decidir(t) !== e).map(([t, e]) => `${t} → ${decidir(t)} (esperado ${e})`)

console.log('== 1. Consulta frente a modificación')
{
  const malos = revisar([
    ['¿Cuál es el producto final de esta planeación?', 'consulta'], ['¿Cuántas sesiones tiene?', 'consulta'], ['Dime cuál es el propósito', 'consulta'],
    ['¿Qué materiales necesito para el día 3?', 'consulta'], ['¿Cuánto dura?', 'consulta'], ['¿De qué trata?', 'consulta'],
    ['¿Puedes explicarme el cierre del día 2?', 'consulta'], ['¿Qué indicadores evalúa?', 'consulta'], ['Explícame la evaluación', 'consulta'],
  ])
  verificar(malos.length === 0, `1a. Preguntas y pedidos de información sobre la planeación abierta → consulta${malos.length ? ` — ${malos.join('; ')}` : ''}`)
}
{
  const malos = revisar([
    ['¿Puedes cambiar el cierre del día 2?', 'ajuste'], ['¿Le agregas un juego al inicio?', 'ajuste'], ['¿Y si la sesión 3 es al aire libre?', 'ajuste'], ['¿Podrías hacerla más dinámica?', 'ajuste'],
    ['Haz más dinámica la sesión 2', 'ajuste'], ['Modifica únicamente la actividad de inicio de la sesión 2 para hacerla más creativa y participativa.', 'ajuste'],
  ])
  verificar(malos.length === 0, `1b. Órdenes de cambio, también en forma de pregunta, cortesía, sugerencia o segunda persona → ajuste${malos.length ? ` — ${malos.join('; ')}` : ''}`)
}
{
  const malos = revisar([
    ['Que dure 3 días', 'ajuste'], ['Más dinámicas para trabajar en equipos', 'ajuste'], ['Con menos materiales', 'ajuste'], ['La sesión 4 debe incluir una salida al patio', 'ajuste'],
    ['¿Qué planeaciones guardé en noviembre?', 'consulta'], ['Pásala a Word', 'archivo'], ['Haz una planeación nueva de fracciones', 'nuevo'], ['Crea un citatorio para mañana', 'nuevo'],
    ['¿Cuántos alumnos faltaron hoy?', 'otro_tema'], ['Pasa lista', 'otro_tema'], ['No, gracias', 'negativa'],
  ])
  verificar(malos.length === 0, `1c. Sin regresiones: cambios sin verbo, consultas de planeaciones, archivo, documento nuevo, otro tema y negativas${malos.length ? ` — ${malos.join('; ')}` : ''}`)
}
verificar(esPreguntaSobrePlaneacion('¿Cuál es el producto final?') && !esPreguntaSobrePlaneacion('Que dure 3 días') && !esPreguntaSobrePlaneacion('¿Puedes quitar la sesión 5?'),
  '1d. La forma (pregunta o pedido de información) y la ausencia de intención de cambio deciden, no una palabra aislada')
const c = clasificacionPreguntaPlaneacion()
verificar(c.intencion_principal === 'conversacion_general' && c.requiere_ia && c.nivel_confianza === 1 && c.accion_planeacion_generar === null, '1e. Clasificación determinista de la pregunta (sin clasificador de IA; la única llamada es la respuesta)')
const ruta = leer('app/api/chat/route.ts')
verificar(/decision === 'consulta' && !formatoOriginal\) \{\n\s+consultaDesdeEdicion = instruccion\n\s+preguntaSobreVersion = \{ pregunta: instruccion, numero: consultada\.numero, contenido: consultada\.contenido \}/.test(ruta),
  '1f. La pregunta se ata a la versión consultada por el servidor (su texto canónico, no el del cliente)')
const iPregunta = ruta.indexOf('const preguntaContenido = !consultaPlaneacion && !ajusteDelTurno && !ordenAprobarPlaneacion ? preguntaSobreVersion : null')
const iClasif = ruta.indexOf('const clasificacion = ajusteDelTurno', iPregunta)
verificar(iPregunta > 0 && iClasif > iPregunta && /: preguntaContenido\n\s+\? clasificacionPreguntaPlaneacion\(\)\n\s+: await clasificarNivel0\(/.test(ruta),
  '1g. Ajuste, aprobación y consultas de planeaciones conservan su prioridad; la pregunta evita el clasificador')
const bloque = ruta.slice(iPregunta, iClasif)
verificar(/mensajeConDocumento = preguntaContenido\.contenido\?\.trim\(\)/.test(bloque) && /no la reescribas ni la modifiques/.test(bloque) && !/construirPromptEdicion/.test(bloque),
  '1h. El modelo recibe la pregunta y el texto canónico de la versión, nunca el prompt de edición')
const preguntas = ['¿Cuál es el producto final de esta planeación?', '¿Cuántas sesiones tiene?', 'Dime cuál es el propósito', '¿De qué trata?', '¿Puedes explicarme el cierre del día 2?', 'Explícame la evaluación']
verificar(preguntas.every((t) => detectarConsultaPlaneacion(t, '2026-11-26') === null && !esConsultaDocumentoActual(t) && decidir(t) === 'consulta'),
  '1i. Las preguntas de contenido no se confunden con consultas de planeaciones ni con «muéstramela»: llegan a la respuesta sobre el texto canónico')

console.log('== 2. Hojas históricas sin captura automática')
// Estructura REAL de roster_congelado en E2E (jsonb → arreglo de objetos con
// alumno_id, inscripcion_id, nombre y posicion; valores anonimizados).
const alumno = (n: number) => ({ alumno_id: `a${n}`, inscripcion_id: `i${n}`, nombre: `Alumno ${n}`, posicion: n })
verificar(!admiteCapturaAutomatica(null) && !admiteCapturaAutomatica(undefined) && !admiteCapturaAutomatica([]) && admiteCapturaAutomatica([alumno(1), alumno(2)]),
  '2a. Mismo criterio que estado-captura: sin registro de alumnos (o vacío) no admite captura; con alumnos, sí')
// Respuesta de GET /api/proyectos-seguimiento tal como la entrega Supabase
// (hoja embebida a uno: objeto; jsonb: arreglo), serializada como en la red.
const respuestaSupabase = JSON.parse(JSON.stringify([
  { id: 'p-fbgc', estado: 'hoja_generada', hoja_id: 'h1', hojas_evaluacion: { identificador_visible: 'SG-FBGC', storage_path: 'd/SG-FBGC.pdf', generado_en: '2026-11-23T10:00:00+00:00', roster_congelado: [alumno(1), alumno(2)] } },
  { id: 'p-gjcd', estado: 'hoja_generada', hoja_id: 'h2', hojas_evaluacion: { identificador_visible: 'SG-GJCD', storage_path: 'd/SG-GJCD.pdf', generado_en: '2026-11-24T10:00:00+00:00', roster_congelado: [alumno(1), alumno(2)] } },
  { id: 'p-t6mu', estado: 'hoja_generada', hoja_id: 'h3', hojas_evaluacion: { identificador_visible: 'SG-T6MU', storage_path: 'd/SG-T6MU.pdf', generado_en: '2026-11-24T11:00:00+00:00', roster_congelado: [alumno(1), alumno(2)] } },
  { id: 'p-3uaa', estado: 'confirmado', hoja_id: 'h4', hojas_evaluacion: { identificador_visible: 'SG-3UAA', storage_path: 'd/SG-3UAA.pdf', generado_en: '2026-11-24T12:00:00+00:00', roster_congelado: [alumno(1), alumno(2)] } },
  { id: 'p-prbt', estado: 'hoja_generada', hoja_id: 'h5', hojas_evaluacion: { identificador_visible: 'SG-PRBT', storage_path: null, generado_en: '2026-11-26T18:08:00+00:00', roster_congelado: null } },
  { id: 'p-sin-hoja', estado: 'planeado', hoja_id: null, hojas_evaluacion: null },
])) as { id: string; hojas_evaluacion: unknown }[]
const listados = respuestaSupabase.map(conCapturaAutomatica)
const admite = Object.fromEntries(listados.filter((p) => p.hojas_evaluacion).map((p) => [p.hojas_evaluacion!.identificador_visible, p.hojas_evaluacion!.admite_captura]))
verificar(JSON.stringify(admite) === JSON.stringify({ 'SG-FBGC': true, 'SG-GJCD': true, 'SG-T6MU': true, 'SG-3UAA': true, 'SG-PRBT': false }),
  '2b. Con la estructura real de Supabase: las 4 hojas con alumnos admiten captura y solo SG-PRBT no (regresión de las 18:11)')
verificar(listados.every((p) => !p.hojas_evaluacion || !('roster_congelado' in p.hojas_evaluacion)) && listados.find((p) => p.id === 'p-sin-hoja')!.hojas_evaluacion === null,
  '2b2. El registro de alumnos nunca llega al cliente; un proyecto sin hoja queda igual')
const consultadas = listados.filter((p) => p.hojas_evaluacion && (p.hojas_evaluacion as { admite_captura?: boolean }).admite_captura !== false).map((p) => p.id)
verificar(consultadas.join() === 'p-fbgc,p-gjcd,p-t6mu,p-3uaa', '2b3. Evaluación consulta el estado real de las 4 compatibles (SG-3UAA conserva «Resultados registrados») y no el de SG-PRBT')
const listado = leer('app/api/proyectos-seguimiento/route.ts')
verificar(listado.includes('hojas_evaluacion!hoja_id(identificador_visible, storage_path, generado_en, roster_congelado)') && listado.includes('.map(conCapturaAutomatica)') && !/->\s*0/.test(listado),
  '2c. Sin rutas JSON por índice: se lee la columna real y se resume en el servidor')
const estadoCaptura = leer('app/api/proyectos-seguimiento/[id]/estado-captura/route.ts')
verificar(/no admite captura automática\.', codigo: CODIGO_SIN_CAPTURA_AUTOMATICA \}, \{ status: 409 \}/.test(estadoCaptura) && /if \(!rosterCongelado \|\| !admiteCapturaAutomatica\(rosterCongelado\)\)/.test(estadoCaptura) && CODIGO_SIN_CAPTURA_AUTOMATICA === 'sin_captura_automatica',
  '2d. estado-captura usa la MISMA regla, conserva su 409 y agrega un código estable (los errores no se ocultan)')
const evaluacion = leer('app/dashboard/evaluacion/page.tsx')
verificar(/lista\.filter\(\(p\) => p\.hojas_evaluacion\?\.admite_captura !== false\)\.map/.test(evaluacion), '2e. Evaluación no consulta las hojas que no admiten captura')
verificar(/sinCaptura: json\.codigo === CODIGO_SIN_CAPTURA_AUTOMATICA/.test(evaluacion) && /if \(r\.error && !r\.sinCaptura\)/.test(evaluacion), '2f. Si aun así el servidor lo indica (datos viejos), lo reconoce como estado permanente, no como error')
verificar(evaluacion.includes('{!estado && sinCaptura && <span className="font-medium text-amber-600">No disponible para captura automática</span>}')
  && evaluacion.includes('{!estado && !sinCaptura && errorEstado && <span className="font-medium text-red-600">No se pudo consultar el estado</span>}'),
  '2g. La hoja histórica se muestra como siempre; un error real ya no se disfraza de «no disponible»')
const planeacion = leer('app/dashboard/planeacion/page.tsx')
verificar((planeacion.match(/\.hoja\?\.admiteCaptura \? [a-z]\.hoja\.proyectoId : null/g) ?? []).length === 2 && leer('lib/planeacion/vistaPlaneacion.ts').includes('admiteCaptura: admiteCapturaAutomatica(h.roster_congelado)') && !/->\s*0/.test(leer('lib/planeacion/vistaPlaneacion.ts')),
  '2h. Planeación (lista y detalle) tampoco las consulta')

console.log(`\n${total - fallos}/${total} pruebas pasaron.`)
if (fallos) process.exit(1)
