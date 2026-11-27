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
verificar(!admiteCapturaAutomatica(null) && !admiteCapturaAutomatica(undefined) && admiteCapturaAutomatica({ inscripcion_id: 'x' }), '2a. Mismo criterio que estado-captura: sin registro de alumnos (o vacío) no admite captura')
const historica = conCapturaAutomatica({ id: 'p1', hojas_evaluacion: { identificador_visible: 'SG-VXKR', storage_path: 'x', generado_en: '2026-09-23', primer_alumno: null } })
const compatible = conCapturaAutomatica({ id: 'p2', hojas_evaluacion: { identificador_visible: 'SG-W4W2', storage_path: 'y', generado_en: '2026-11-25', primer_alumno: { inscripcion_id: 'i' } } })
const sinHoja = conCapturaAutomatica({ id: 'p3', hojas_evaluacion: null })
verificar(JSON.stringify(historica.hojas_evaluacion) === JSON.stringify({ identificador_visible: 'SG-VXKR', storage_path: 'x', generado_en: '2026-09-23', admite_captura: false })
  && compatible.hojas_evaluacion?.admite_captura === true && sinHoja.hojas_evaluacion === null,
  '2b. El listado de proyectos indica admite_captura (sin exponer la lista de alumnos; documentos históricos intactos)')
const listado = leer('app/api/proyectos-seguimiento/route.ts')
verificar(listado.includes('primer_alumno:roster_congelado->0') && listado.includes('.map(conCapturaAutomatica)'), '2c. Se lee solo el primer alumno, en la misma consulta del listado')
const estadoCaptura = leer('app/api/proyectos-seguimiento/[id]/estado-captura/route.ts')
verificar(/no admite captura automática\.', codigo: CODIGO_SIN_CAPTURA_AUTOMATICA \}, \{ status: 409 \}/.test(estadoCaptura) && CODIGO_SIN_CAPTURA_AUTOMATICA === 'sin_captura_automatica',
  '2d. estado-captura conserva su 409 y agrega un código estable (los errores no se ocultan)')
const evaluacion = leer('app/dashboard/evaluacion/page.tsx')
verificar(/lista\.filter\(\(p\) => p\.hojas_evaluacion\?\.admite_captura !== false\)\.map/.test(evaluacion), '2e. Evaluación no consulta las hojas que no admiten captura')
verificar(/sinCaptura: json\.codigo === CODIGO_SIN_CAPTURA_AUTOMATICA/.test(evaluacion) && /if \(r\.error && !r\.sinCaptura\)/.test(evaluacion), '2f. Si aun así el servidor lo indica (datos viejos), lo reconoce como estado permanente, no como error')
verificar(evaluacion.includes('{!estado && sinCaptura && <span className="font-medium text-amber-600">No disponible para captura automática</span>}')
  && evaluacion.includes('{!estado && !sinCaptura && errorEstado && <span className="font-medium text-red-600">No se pudo consultar el estado</span>}'),
  '2g. La hoja histórica se muestra como siempre; un error real ya no se disfraza de «no disponible»')
const planeacion = leer('app/dashboard/planeacion/page.tsx')
verificar((planeacion.match(/\.hoja\?\.admiteCaptura \? [a-z]\.hoja\.proyectoId : null/g) ?? []).length === 2 && leer('lib/planeacion/vistaPlaneacion.ts').includes('admiteCaptura: admiteCapturaAutomatica(h.primer_alumno)'),
  '2h. Planeación (lista y detalle) tampoco las consulta')

console.log(`\n${total - fallos}/${total} pruebas pasaron.`)
if (fallos) process.exit(1)
