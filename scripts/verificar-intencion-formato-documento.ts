// scripts/verificar-intencion-formato-documento.ts
//
// Un mensaje que nombra un formato (PDF, Word, PowerPoint...) no siempre
// pide convertir el documento existente: también puede pedir un
// documento NUEVO o una edición. Verifica el clasificador determinista
// (lib/asistente/documentos.ts) y que el cliente (documento activo) y el
// servidor (documento del historial) no conviertan un pedido nuevo.
//
// Sin red, sin credenciales, sin IA. Se ejecuta con
// `npx tsx scripts/verificar-intencion-formato-documento.ts`.

import { readFileSync } from 'node:fs'
import { clasificarIntencionConFormato, contenidoParaArchivo, detectarHerramientaDocumento, esDocumentoNuevoConFormato, esPedidoDocumentoNuevo, tipoArchivoSolicitado, type IntencionConFormato } from '../lib/asistente/documentos'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  console.log(`${condicion ? '✓' : '✗'} ${mensaje}`)
  if (!condicion) fallos++
}

// 1. Clasificador: [mensaje, formato esperado, intención esperada].
// 'editar' (con formato) va a la edición + archivo: ver 3c y
// verificar-edicion-con-formato.
const CASOS: [string, string, IntencionConFormato][] = [
  ['Pásalo a PDF', 'pdf', 'convertir'],
  ['Hazme un PDF', 'pdf', 'convertir'],
  ['Conviértelo en Word', 'word', 'convertir'],
  ['Descárgalo', 'word', 'convertir'],
  ['Quiero el pdf', 'pdf', 'convertir'],
  ['Hazla oficial', 'word', 'convertir'],
  ['Genera el PDF', 'pdf', 'convertir'],
  ['Ahora en PowerPoint', 'powerpoint', 'convertir'],
  ['Descárgalo otra vez en PDF', 'pdf', 'convertir'],
  ['Genera un documento PDF nuevo con el título Prueba de grupo académico PDF', 'pdf', 'nuevo'],
  ["Genera un documento PDF con el título 'Prueba de grupo académico PDF'. Incluye el nombre de la escuela, el docente, el grado y el grupo que correspondan a mi grupo activo. Agrega la oración: 'Documento de validación E2E PDF'.", 'pdf', 'nuevo'],
  ['Crea una presentación en PowerPoint sobre el ciclo del agua', 'powerpoint', 'nuevo'],
  ['Hazme otro oficio en Word', 'word', 'nuevo'],
  ['Agrega una conclusión y guárdalo en PDF', 'pdf', 'editar'],
  ['Corrige la ortografía y pásalo a Word', 'word', 'editar'],
  // Palabras sueltas nunca bastan para "nuevo".
  ['Ponlo sobre fondo blanco y pásalo a PDF', 'pdf', 'convertir'],
  ['Agrega información sobre las leyendas y guárdalo en PDF', 'pdf', 'editar'],
  ['Pásalo otra vez a PDF', 'pdf', 'convertir'],
  ['Agrega una sección nueva y pásalo a PDF', 'pdf', 'editar'],
  ['Hazme otra vez el PDF', 'pdf', 'convertir'],
  ['Necesito un documento nuevo en Word', 'word', 'nuevo'],
]
for (const [mensaje, formato, intencion] of CASOS) {
  const tipo = detectarHerramientaDocumento(mensaje)
  const obtenida = clasificarIntencionConFormato(mensaje)
  verificar(tipo === formato && obtenida === intencion, `1. "${mensaje.slice(0, 70)}" → ${formato} / ${intencion} (obtenido ${tipo} / ${obtenida})`)
}

// 2. Solo un pedido nuevo CON formato cambia de camino; sin formato o con
// otra intención, todo sigue igual que antes.
const FRASE_E2E = "Genera un documento PDF con el título 'Prueba de grupo académico PDF'. Incluye el nombre de la escuela, el docente, el grado y el grupo que correspondan a mi grupo activo. Agrega la oración: 'Documento de validación E2E PDF'."
verificar(esDocumentoNuevoConFormato(FRASE_E2E) && esDocumentoNuevoConFormato('Genera un documento PDF nuevo con el título Prueba de grupo académico PDF'), '2a. Frase exacta de la prueba E2E (y su variante con "nuevo") → documento nuevo, aun con documentoActivo')
verificar(!esDocumentoNuevoConFormato('Pásalo a PDF') && !esDocumentoNuevoConFormato('Hazme un PDF'), '2b. Conversiones explícitas y ambiguas → siguen convirtiendo')
verificar(!esDocumentoNuevoConFormato('Agrega una conclusión y guárdalo en PDF') && !esDocumentoNuevoConFormato('Corrige la ortografía y pásalo a Word'), '2c. Edición con formato → no es documento nuevo (sigue el camino de siempre)')
verificar(!esDocumentoNuevoConFormato('Agrega una sección nueva sobre la evaluación'), '2d. Sin formato → sigue siendo edición del documento activo')

// 3. Cliente: con documentoActivo, un pedido nuevo con formato sale del
// bloque de conversión/edición y va como mensaje normal.
const servicio = readFileSync('lib/asistente/AsistenteService.ts', 'utf8')
verificar(/if \(this\.documentoActivo && !detectarAprobarPlaneacion\([^)]*\{[^}]*\}\) && !esPedidoDocumentoNuevo\(limpio\)( && !\(esEdicionConFormato\(limpio\) && !referenciaCompatibleConDocumento\(limpio, this\.documentoActivo\.texto\)\))?\) \{\s*\n\s*const tipoFinalizar = detectarHerramientaDocumento\(limpio\)/.test(servicio), '3a. Cliente con documentoActivo: un pedido nuevo con formato no entra a ejecutarConversionFormato ni a enviarComoEdicion')
verificar(/if \(esEdicionConFormato\(limpio\) && tipoResuelto !== 'imagen'[^\n]*\{\s*\n\s*await this\.enviarComoEdicion\(this\.documentoActivo\.id, limpio, construirPromptEdicion\(this\.documentoActivo\.texto, limpio\), adjunto, formatoExplicito \? tipoResuelto : undefined\)\s*\n\s*return\s*\n\s*\}\s*\n\s*await this\.ejecutarConversionFormato\(tipoResuelto, limpio\)/.test(servicio), "3c. Cliente: una edición con formato va a la edición con el texto real (y el formato), nunca a la conversión del texto anterior (ver verificar-edicion-con-formato)")
verificar(/await this\.ejecutarConversionFormato\(tipoResuelto, limpio\)/.test(servicio) && /detectarFormatoExplicito\(limpio\)/.test(servicio), '3b. Cliente: "Pásalo a PDF" conserva la conversión del documento activo y la resolución del último formato')

// 4. Servidor: con solo un documento en el historial, un pedido nuevo no
// lo recupera; finalizarArchivo del cliente conserva la prioridad.
const ruta = readFileSync('app/api/chat/route.ts', 'utf8')
const DOC_HISTORIAL = [{ role: 'user' as const, content: 'Hazme un oficio' }, { role: 'assistant' as const, content: '📨 OFICIO ANTERIOR\nTexto del oficio anterior.' }]
verificar(contenidoParaArchivo({ mensaje: 'Genera un documento PDF nuevo con el título Prueba de grupo académico PDF', finalizarArchivo: null, historial: DOC_HISTORIAL }).fuente === 'ninguna' && /const contenido = contenidoParaArchivo\(\{ mensaje: mensaje \|\| '', finalizarArchivo, historial: historialMensajes, adjuntoPresente \}\)/.test(ruta), '4a. Servidor con documento histórico: un pedido nuevo no recupera el último documento del historial')
verificar(JSON.stringify(contenidoParaArchivo({ mensaje: 'Genera un documento PDF nuevo con el título X', finalizarArchivo: { tipo: 'pdf', documentoTexto: '📨 TEXTO DEL CLIENTE' }, historial: DOC_HISTORIAL })) === JSON.stringify({ fuente: 'cliente', texto: '📨 TEXTO DEL CLIENTE' }) && JSON.stringify(contenidoParaArchivo({ mensaje: 'Pásalo a PDF', finalizarArchivo: null, historial: DOC_HISTORIAL })) === JSON.stringify({ fuente: 'historial', texto: '📨 OFICIO ANTERIOR\nTexto del oficio anterior.' }), '4b. Servidor: el contenido enviado por el cliente conserva la prioridad, y "Pásalo a PDF" sigue convirtiendo el del historial')
verificar(/fuenteContenido=claude-directo \(sin documento previo que recuperar\)/.test(ruta), '4c. Servidor: sin contenido recuperado, el pedido sigue al CASO 3 (redacción + archivo)')

// 5. Crear, convertir o editar — con y sin formato (esPedidoDocumentoNuevo,
// regla compartida por el cliente y la clasificación con formato).
const NUEVOS = [
  'Genera un citatorio en PDF', 'Hazme un citatorio nuevo en PDF', 'Prepara otro citatorio', 'Hazme un examen de fracciones',
  'Crea una circular para padres', 'Diseña un instrumento para evaluar la exposición', 'Hazme un nuevo citatorio',
  'Genera un citatorio en PDF y entrégamelo para este viernes', 'Genera una planeación de fracciones para tercer grado',
]
for (const m of NUEVOS) verificar(esPedidoDocumentoNuevo(m), `5a. Creación nueva: "${m}"`)
const NO_NUEVOS = [
  'Hazme un PDF', 'Genera el PDF', 'Pasa este citatorio a PDF', 'Genera un documento en PDF',
  'Haz otra versión de este examen', 'Haz un resumen de este documento', 'Hazlo más formal', 'Agrégale una conclusión y guárdalo en PDF',
  'Hazme una versión más corta', 'Hazme otro igual', 'Hazme otra vez el PDF', 'Crea un examen a partir de esto', 'Prepara otro citatorio con el contenido anterior',
]
for (const m of NO_NUEVOS) verificar(!esPedidoDocumentoNuevo(m), `5b. No es creación nueva (conversión, edición o referencia al existente): "${m}"`)
const CON_FORMATO: [string, IntencionConFormato][] = [
  ['Genera un citatorio en PDF', 'nuevo'], ['Hazme un citatorio nuevo en PDF', 'nuevo'],
  ['Pasa este citatorio a PDF', 'convertir'], ['Hazme un PDF', 'convertir'], ['Genera el PDF', 'convertir'], ['Genera un documento en PDF', 'convertir'],
  ['Agrégale una conclusión y guárdalo en PDF', 'editar'], ['Haz un resumen de este documento y entrégamelo en PDF', 'editar'], ['Hazme una versión más corta en PDF', 'editar'],
]
for (const [m, esperado] of CON_FORMATO) verificar(clasificarIntencionConFormato(m) === esperado, `5c. Con formato: "${m}" → ${esperado} (obtenido ${clasificarIntencionConFormato(m)})`)
const HISTORIAL_DOC = [{ role: 'user' as const, content: 'Hazme un oficio' }, { role: 'assistant' as const, content: '📨 OFICIO ANTERIOR\nTexto del oficio anterior.' }]
verificar(contenidoParaArchivo({ mensaje: 'Genera un citatorio en PDF', finalizarArchivo: null, historial: HISTORIAL_DOC }).fuente === 'ninguna' && contenidoParaArchivo({ mensaje: 'Pásalo a PDF', finalizarArchivo: null, historial: HISTORIAL_DOC }).fuente === 'historial', '5d. Servidor sin documento activo: "Genera un citatorio en PDF" no convierte el documento anterior; "Pásalo a PDF" sí (sin cambios)')
verificar(/!detectarAprobarPlaneacion\(limpio, \{[^}]*\}\) && !esPedidoDocumentoNuevo\(limpio\)/.test(servicio) && !servicio.includes('esDocumentoNuevoConFormato'), '5e. Cliente: la aprobación de planeación conserva su prioridad y un pedido nuevo (con o sin formato) no edita ni convierte el documento activo')
verificar(/adjunto, formatoExplicito \? tipoResuelto : undefined\)/.test(servicio), '5f. Cliente: una edición solo entrega archivo si el formato se NOMBRÓ ("haz un resumen de este documento" queda como edición sin archivo)')

// 6. Transformaciones referidas al documento existente: edición (con o sin
// archivo según el formato NOMBRADO); "documento"/"texto" no implican Word.
const archivoServidor = (m: string) => tipoArchivoSolicitado({ mensaje: m, esEdicionDocumento: false, formatoEntrega: null, finalizarArchivo: null })
verificar(!esPedidoDocumentoNuevo('Hazme una síntesis de este documento') && clasificarIntencionConFormato('Hazme una síntesis de este documento') === 'editar' && archivoServidor('Hazme una síntesis de este documento') === null, '6a. «Hazme una síntesis de este documento» → edición sin archivo (sin Word implícito)')
verificar(clasificarIntencionConFormato('Hazme una paráfrasis de este texto en PDF') === 'editar' && archivoServidor('Hazme una paráfrasis de este texto en PDF') === 'pdf', '6b. «Hazme una paráfrasis de este texto en PDF» → edición con PDF')
verificar(!esPedidoDocumentoNuevo('Hazme una versión adaptada de este examen') && detectarHerramientaDocumento('Hazme una versión adaptada de este examen') === null, '6c. «Hazme una versión adaptada de este examen» → edición del activo')
verificar(clasificarIntencionConFormato('Pasa este documento a PDF') === 'convertir' && clasificarIntencionConFormato('Hazme un PDF') === 'convertir' && archivoServidor('Hazme un PDF') === 'pdf', '6d. «Pasa este documento a PDF» y «Hazme un PDF» → conversión')
verificar(clasificarIntencionConFormato('Genera un citatorio en PDF') === 'nuevo' && esPedidoDocumentoNuevo('Prepara otro citatorio') && esPedidoDocumentoNuevo('Genera una planeación de fracciones para cinco sesiones') && archivoServidor('Genera una planeación de fracciones para cinco sesiones') === null, '6e. Citatorio nuevo, otro citatorio y planeación → creación nueva (la planeación, sin archivo, sigue a Nivel 0)')
verificar(archivoServidor('Descárgalo') === 'word' && archivoServidor('Genera el documento') === 'word', '6f. Entregas genéricas ("Descárgalo", "Genera el documento") conservan su archivo por defecto')
verificar(/adjunto, formatoExplicito \? tipoResuelto : undefined\)/.test(servicio), '6g. Cliente con documento activo: la transformación sin formato nombrado se edita sin archivo')

console.log('')
if (fallos > 0) {
  console.error(`${fallos} prueba(s) fallaron.`)
  process.exit(1)
}
console.log('Todas las pruebas pasaron.')
