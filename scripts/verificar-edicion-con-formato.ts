// scripts/verificar-edicion-con-formato.ts
//
// Editar un documento y entregarlo en un formato en el mismo turno
// ("agrega una conclusión y guárdalo en PDF"): el cliente manda la
// edición con el texto real y el formato (formatoEntrega); el servidor
// valida el formato contra una lista explícita, nunca convierte la
// versión anterior y lo resuelve en el CASO 3 (una sola llamada al
// modelo). Sin contenido recuperable, lo dice en vez de inventarlo.
//
// Sin red, sin credenciales, sin IA. Se ejecuta con
// `npx tsx scripts/verificar-edicion-con-formato.ts`.

import { readFileSync } from 'node:fs'
import {
  construirPromptEdicion, contenidoParaArchivo, esEdicionConFormato, esFormatoEntrega, instruccionDeEdicion,
  MARCADOR_INSTRUCCION_EDICION, referenciaCompatibleConDocumento, referenciaDocumento, refiereDocumentoExistente, tipoArchivoSolicitado,
} from '../lib/asistente/documentos'
import { seccionesDePresentacion, tieneCantidadExplicita } from '../lib/asistente/instruccionesPresentacion'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  console.log(`${condicion ? '✓' : '✗'} ${mensaje}`)
  if (!condicion) fallos++
}

const EJEMPLOS = [
  'Agrega una conclusión y guárdalo en PDF',
  'Corrige la ortografía del documento y pásalo a Word',
  'Amplía el contenido anterior y conviértelo en PowerPoint',
  'Resume este documento y entrégamelo en PDF',
]
const E2E_NUEVO = "Genera un documento PDF con el título 'Prueba de grupo académico PDF'. Incluye el nombre de la escuela, el docente, el grado y el grupo que correspondan a mi grupo activo. Agrega la oración: 'Documento de validación E2E PDF'."
const DOC = '📨 OFICIO DE PRUEBA\nTexto del oficio. Son 7 diapositivas de 12 páginas.'
const HISTORIAL = [{ role: 'user' as const, content: 'Hazme un oficio' }, { role: 'assistant' as const, content: DOC }]
const SIN_DOC = [{ role: 'user' as const, content: 'Hola' }, { role: 'assistant' as const, content: 'Documento generado correctamente.' }]
const prompt = (instruccion: string) => `El maestro pidió modificar...\n\nDOCUMENTO/CONTENIDO ACTUAL:\n${DOC}\n\n${MARCADOR_INSTRUCCION_EDICION}\n${instruccion}`

// 1. Clasificación: edición con formato frente a conversión y documento nuevo.
for (const e of EJEMPLOS) verificar(esEdicionConFormato(e), `1a. "${e}" → edición con formato`)
for (const c of ['Pásalo a PDF', 'Hazme un PDF', 'Conviértelo en Word', E2E_NUEVO]) verificar(!esEdicionConFormato(c), `1b. "${c.slice(0, 50)}" → no es edición (conversión o documento nuevo)`)
verificar(!esEdicionConFormato('Agrega una conclusión'), '1c. Edición sin formato → no pide archivo (sigue la edición normal en streaming)')

// 2. formatoEntrega: lista explícita en el servidor.
verificar(['word', 'pdf', 'powerpoint', 'excel'].every(esFormatoEntrega), '2a. Formatos admitidos: word, pdf, powerpoint, excel')
verificar(![undefined, null, '', 'imagen', 'audio', 'video', 'docx', 'WORD', 123, { tipo: 'pdf' }].some(esFormatoEntrega), '2b. Cualquier otro valor (imagen, mayúsculas, objetos, vacío) se rechaza')

// 3. tipoArchivoSolicitado: una edición solo pide archivo con formatoEntrega válido.
const base = { mensaje: '', finalizarArchivo: null }
verificar(tipoArchivoSolicitado({ ...base, mensaje: prompt('Agrega una conclusión y guárdalo en PDF'), esEdicionDocumento: true, formatoEntrega: 'pdf' }) === 'pdf', '3a. Edición + formatoEntrega "pdf" → archivo PDF')
verificar(tipoArchivoSolicitado({ ...base, mensaje: prompt('Agrega una conclusión y guárdalo en PDF'), esEdicionDocumento: true, formatoEntrega: 'imagen' }) === null, '3b. Edición + formato no admitido → sin archivo (edición normal)')
verificar(tipoArchivoSolicitado({ ...base, mensaje: prompt('hazlo en formato imagen, en Word'), esEdicionDocumento: true, formatoEntrega: undefined }) === null, '3c. Edición sin formatoEntrega → sin archivo, aunque el prompt mencione formatos (nunca se detecta dentro del prompt)')
verificar(tipoArchivoSolicitado({ ...base, mensaje: 'Pásalo a PDF', esEdicionDocumento: false, formatoEntrega: 'word' }) === 'pdf', '3d. Fuera de una edición, formatoEntrega se ignora (conversión simple igual que antes)')
verificar(tipoArchivoSolicitado({ mensaje: 'Pásalo a PDF', esEdicionDocumento: false, formatoEntrega: null, finalizarArchivo: { tipo: 'pdf', documentoTexto: DOC } }) === 'pdf', '3e. Conversión del documento activo (finalizarArchivo) sin cambios')

// 4. contenidoParaArchivo (sin documento activo en el cliente).
verificar(JSON.stringify(contenidoParaArchivo({ mensaje: 'Agrega una conclusión y guárdalo en PDF', finalizarArchivo: null, historial: HISTORIAL })) === JSON.stringify({ fuente: 'edicion-historial', texto: DOC }), '4a. Edición con formato y documento en el historial → se recupera explícitamente ESE texto para editarlo (nunca se convierte la versión anterior)')
verificar(contenidoParaArchivo({ mensaje: 'Agrega una conclusión y guárdalo en PDF', finalizarArchivo: null, historial: SIN_DOC }).fuente === 'sin-documento', '4b. Edición de un documento que ya no está disponible → respuesta clara, sin convertir ni inventar')
verificar(contenidoParaArchivo({ mensaje: 'Resume este documento y entrégamelo en PDF', finalizarArchivo: null, historial: [] }).fuente === 'sin-documento', '4c. "Resume este documento…" sin ningún documento → respuesta clara')
verificar(contenidoParaArchivo({ mensaje: 'Haz un PowerPoint de la lectura y agrega imágenes', finalizarArchivo: null, historial: [] }).fuente === 'ninguna', '4d. Verbo de edición sin referirse a un documento existente → se redacta como pedido nuevo (comportamiento previo)')
verificar(JSON.stringify(contenidoParaArchivo({ mensaje: 'Pásalo a PDF', finalizarArchivo: null, historial: HISTORIAL })) === JSON.stringify({ fuente: 'historial', texto: DOC }), '4e. Conversión simple sin documento activo → sigue convirtiendo el del historial')
verificar(contenidoParaArchivo({ mensaje: E2E_NUEVO, finalizarArchivo: null, historial: HISTORIAL }).fuente === 'ninguna', '4f. Documento nuevo → CASO 3 (sin cambios)')
verificar(['guárdalo', 'entrégamelo', 'pásalo', 'conviértelo', 'este documento', 'el anterior'].every((r) => refiereDocumentoExistente(`Agrega una conclusión y ${r} en PDF`)) && !refiereDocumentoExistente('Haz un PowerPoint de la lectura y agrega imágenes'), '4g. Referencia a un documento existente: pronombres y "este documento"/"el anterior"')

// 4h-4l. Selección del documento original sin documento activo.
const DOC_VIEJO = '📨 OFICIO VIEJO\nTexto del oficio viejo.'
const DOC_RECIENTE = '📄 RESUMEN — LEY RECIENTE\nTexto del resumen reciente.'
const VARIOS = [
  { role: 'user' as const, content: 'Hazme un oficio' }, { role: 'assistant' as const, content: DOC_VIEJO },
  { role: 'user' as const, content: 'Ahora un resumen' }, { role: 'assistant' as const, content: DOC_RECIENTE },
  { role: 'user' as const, content: 'Gracias' }, { role: 'assistant' as const, content: 'Con gusto.' },
]
const PEDIDOS: [string, string][] = [
  ['Corrige la ortografía y pásalo a PDF', 'pdf'],
  ['Agrega una conclusión y guárdalo en Word', 'word'],
  ['Resume el documento anterior y entrégamelo en PDF', 'pdf'],
]
for (const [pedido, formato] of PEDIDOS) {
  const conDoc = contenidoParaArchivo({ mensaje: pedido, finalizarArchivo: null, historial: VARIOS })
  const sinDoc = contenidoParaArchivo({ mensaje: pedido, finalizarArchivo: null, historial: SIN_DOC })
  verificar(tipoArchivoSolicitado({ mensaje: pedido, esEdicionDocumento: false, formatoEntrega: null, finalizarArchivo: null }) === formato && conDoc.fuente === 'edicion-historial' && 'texto' in conDoc && conDoc.texto === DOC_RECIENTE && sinDoc.fuente === 'sin-documento', `4h. "${pedido}": edita explícitamente el documento más reciente (nunca el viejo, nunca uno nuevo); sin documento → falta el original`)
}
const nuevoPpt = 'Haz un PowerPoint sobre la lectura y agrega actividades'
verificar(!esEdicionConFormato(nuevoPpt) && contenidoParaArchivo({ mensaje: nuevoPpt, finalizarArchivo: null, historial: VARIOS }).fuente === 'ninguna', '4i. "Haz un PowerPoint sobre la lectura y agrega actividades": documento nuevo (CASO 3), sin tocar los documentos del historial')
verificar(contenidoParaArchivo({ mensaje: 'Agrega una conclusión y guárdalo en PDF', finalizarArchivo: null, historial: VARIOS, adjuntoPresente: true }).fuente === 'ninguna', '4j. Con un adjunto en el mismo turno, el referente es el adjunto (no un documento del historial)')
const promptHistorial = construirPromptEdicion(DOC_RECIENTE, 'Corrige la ortografía y pásalo a PDF')
verificar(promptHistorial.includes(DOC_RECIENTE) && !promptHistorial.includes(DOC_VIEJO) && instruccionDeEdicion(promptHistorial) === 'Corrige la ortografía y pásalo a PDF', '4k. El prompt de edición lleva solo el texto recuperado y la instrucción del docente')

// 4m-4s. ¿Qué documento editar? Solo el reciente cuando la referencia es
// inequívoca; nunca sustituir otro documento nombrado; si no hay certeza,
// aclaración sin archivo.
const fuente = (mensaje: string, historial = VARIOS) => contenidoParaArchivo({ mensaje, finalizarArchivo: null, historial })
for (const m of ['Agrégale una conclusión y guárdalo en PDF', 'Corrige el documento anterior y pásalo a PDF']) {
  const r = fuente(m)
  verificar(referenciaDocumento(m) === 'reciente' && r.fuente === 'edicion-historial' && 'texto' in r && r.texto === DOC_RECIENTE, `4m. Referencia inequívoca al reciente ("${m}") → se edita el documento más reciente`)
}
for (const m of ['Corrige el oficio de la semana pasada y pásalo a PDF', 'Corrige el primer examen y pásalo a Word', 'Agrega una conclusión al otro documento y guárdalo en PDF']) {
  verificar(referenciaDocumento(m) === 'otro' && fuente(m).fuente === 'aclarar', `4n. Referencia explícita a otro documento ("${m}") → aclaración, nunca el más reciente`)
}
const OFICIO_RECIENTE = [...VARIOS.slice(0, 4), { role: 'user' as const, content: 'Otro oficio' }, { role: 'assistant' as const, content: '📨 OFICIO NUEVO\nTexto del oficio nuevo.' }]
verificar(fuente('Corrige el oficio y pásalo a PDF').fuente === 'aclarar' && fuente('Corrige el oficio y pásalo a PDF', OFICIO_RECIENTE).fuente === 'edicion-historial', '4o. Nombra "el oficio": si el más reciente es un resumen → aclaración; si es un oficio → se edita ese')
verificar(referenciaDocumento('Corrige la ortografía en PDF') === 'ninguna' && fuente('Corrige la ortografía en PDF').fuente === 'aclarar' && fuente('Corrige la ortografía en PDF', SIN_DOC).fuente === 'sin-documento', '4p. Referencia ambigua (no dice qué documento) → aclaración con documentos; sin documentos → falta el original')
const ULTIMO_SOLO_ARCHIVO = [...VARIOS, { role: 'user' as const, content: 'Hazme un examen en Word' }, { role: 'assistant' as const, content: 'Documento generado correctamente.' }]
verificar(fuente('Agrégale una conclusión y guárdalo en PDF', ULTIMO_SOLO_ARCHIVO).fuente === 'sin-documento', '4q. El más reciente se generó directo como archivo (sin texto en el historial) → no se toma uno anterior: falta el original')
const ACTIVO = '📄 RESUMEN — LEY ACTIVA\nTexto del documento activo.'
verificar(referenciaCompatibleConDocumento('Agrégale una conclusión y guárdalo en PDF', ACTIVO) && referenciaCompatibleConDocumento('Corrige la ortografía en PDF', ACTIVO) && referenciaCompatibleConDocumento('Corrige el resumen y pásalo a Word', ACTIVO), '4r. Documento activo disponible y compatible (sin referencia, "agrégale", "el resumen") → se edita el activo')
verificar(!referenciaCompatibleConDocumento('Corrige el oficio de la semana pasada y pásalo a PDF', ACTIVO) && !referenciaCompatibleConDocumento('Corrige el oficio y pásalo a PDF', ACTIVO), '4s. Documento activo que NO es el nombrado ("el oficio de la semana pasada", "el oficio") → no se edita el activo')
verificar(fuente('Pásalo otra vez a PDF').fuente === 'historial' && fuente('Haz un PowerPoint de la lectura y agrega imágenes').fuente === 'ninguna' && fuente(E2E_NUEVO).fuente === 'ninguna', '4t. Sin cambios: conversión simple, pedido nuevo con verbo de edición y documento nuevo')

// 5. PowerPoint: la cantidad sale de la instrucción del docente, nunca del documento.
verificar(instruccionDeEdicion(prompt('Amplía el contenido y conviértelo en PowerPoint')) === 'Amplía el contenido y conviértelo en PowerPoint', '5a. Se separa la instrucción del docente del texto del documento')
verificar(!tieneCantidadExplicita(instruccionDeEdicion(prompt('Amplía el contenido y conviértelo en PowerPoint'))!) && tieneCantidadExplicita(DOC), '5b. "7 diapositivas" dentro del documento no cuenta: la instrucción no trae cantidad → estructura del documento')
const conCantidad = instruccionDeEdicion(prompt('Amplía el contenido y conviértelo en PowerPoint de 5 diapositivas'))!
verificar(tieneCantidadExplicita(conCantidad) && seccionesDePresentacion(conCantidad) === 4, '5c. Cantidad explícita en la instrucción ("5 diapositivas") → 4 secciones + portada')
verificar(instruccionDeEdicion('texto sin marcador') === null, '5d. Sin marcador de instrucción → sin plantilla (nada se calcula sobre el documento)')

// 6. Cliente (estructura): edición con formato, reintento y motor.
const servicio = readFileSync('lib/asistente/AsistenteService.ts', 'utf8')
verificar(/if \(esEdicionConFormato\(limpio\)[^\n]*\{\s*\n\s*await this\.enviarComoEdicion\(this\.documentoActivo\.id, limpio, construirPromptEdicion\(this\.documentoActivo\.texto, limpio\), adjunto, formatoExplicito \? tipoResuelto : undefined\)\s*\n\s*return/.test(servicio), '6a. Con documento activo: edición con formato → edición con el texto real y el formato resuelto')
verificar(/\$\{MARCADOR_INSTRUCCION_EDICION\}\n\$\{instruccion\}`/.test(readFileSync('lib/asistente/documentos.ts', 'utf8')) && /import \{[^}]*construirPromptEdicion[^}]*\} from '\.\/documentos'/.test(servicio), '6b. construirPromptEdicion (compartido en documentos.ts) usa el marcador que lee el servidor')
verificar(/this\.ultimoIntentoEdicion = \{ idDocumento, textoParaModelo, adjunto, formatoEntrega \}/.test(servicio) && /const \{ idDocumento, textoParaModelo, adjunto, finalizarArchivo, formatoEntrega \} = this\.ultimoIntentoEdicion/.test(servicio) && /await this\.ejecutarEdicion\(textoParaModelo, adjunto, formatoEntrega\)\s*\n\s*\}\s*\n\s*\}/.test(servicio), '6c. Reintento: repite la misma edición CON el mismo formato')
verificar(/enviarTexto\(textoParaModelo, adjunto, undefined, true, undefined, undefined, undefined, undefined, formatoEntrega\)/.test(servicio), '6d. La edición envía formatoEntrega al motor de texto')
const motor = readFileSync('lib/asistente/motores/motorTextoClaude.ts', 'utf8')
verificar(/formatoEntrega: esEdicionDocumento && formatoEntrega \? formatoEntrega : null/.test(motor) && /finalizarArchivo \|\| formatoEntrega \|\| esVariasImagenes \? TIMEOUT_FETCH_DOCUMENTO_MS/.test(motor), '6e. Motor: formatoEntrega solo viaja con una edición, con el tiempo de espera de documentos')
verificar(/if \(msg && evento\.archivo\) \{[\s\S]{0,1600}this\.actualizarDocumentoActivo\(msg\.id, evento\.contenidoOriginal \?\? msg\.texto, evento\.archivo\)/.test(servicio), '6f. Éxito: el documento activo pasa al texto editado confirmado (marcador de contenido), en el mensaje nuevo')

const bloqueError = servicio.slice(servicio.indexOf("      case 'error': {"), servicio.indexOf('      case ', servicio.indexOf("      case 'error': {") + 10))
verificar(bloqueError.length > 100 && !bloqueError.includes('documentoActivo') && bloqueError.includes('this.editandoDocumentoId = null'), '6g. Falla (error de red, del modelo o del archivo): el documento activo anterior se conserva intacto')

// 7. Servidor (estructura).
verificar(/&& !esPedidoDocumentoNuevo\(limpio\) && !\(esEdicionConFormato\(limpio\) && !referenciaCompatibleConDocumento\(limpio, this\.documentoActivo\.texto\)\)\) \{/.test(servicio), '7h. Cliente: editar y entregar un documento que no es el activo no edita el activo (va al servidor, que pide aclaración)')
verificar((servicio.match(/construirPromptEdicion\(this\.documentoActivo\.texto, limpio\)/g) ?? []).length === 2 && !/private construirPromptEdicion/.test(servicio), '7e. Con documento activo: la edición (con o sin formato) usa SU texto completo con el mismo prompt compartido')
const ruta = readFileSync('app/api/chat/route.ts', 'utf8')
verificar(/const tipoHerramientaSolicitado = tipoArchivoSolicitado\(\{ mensaje: mensaje \|\| '', esEdicionDocumento: Boolean\(esEdicionDocumento\), formatoEntrega, finalizarArchivo \}\)/.test(ruta), '7a. El servidor decide el archivo con tipoArchivoSolicitado (formato validado)')
verificar(/if \(supabaseUser && userId && tipoHerramientaSolicitado && !esEdicionDocumento\) \{/.test(ruta), '7b. Una edición nunca pasa por la conversión del texto anterior')
verificar(/if \(contenido\.fuente === 'sin-documento' \|\| contenido\.fuente === 'aclarar'\) \{[\s\S]{0,300}return respuestaTexto\(contenido\.fuente === 'aclarar' \? MENSAJE_EDICION_AMBIGUA : MENSAJE_EDICION_SIN_DOCUMENTO\)/.test(ruta), '7c. Sin contenido recuperable o sin certeza del documento: respuesta clara, sin archivo ni llamada al modelo')
verificar(/if \(contenido\.fuente === 'edicion-historial'\) \{[\s\S]{0,400}mensajeConDocumento = construirPromptEdicion\(contenido\.texto, mensaje \|\| ''\)/.test(ruta) && /const documentoTexto = contenido\.fuente === 'cliente' \|\| contenido\.fuente === 'historial' \? contenido\.texto : ''/.test(ruta), '7f. Sin documento activo: el texto recuperado va explícito en el prompt del CASO 3 (no se convierte tal cual)')
verificar(/const adjuntoPresente = Boolean\(imagenBase64\) \|\| \(Array\.isArray\(imagenesBase64\) && imagenesBase64\.length > 0\) \|\| mensajeConDocumento !== mensaje/.test(ruta), '7g. El servidor reconoce un adjunto del mismo turno como referente')
verificar(/const instruccionDocente = esEdicionDocumento \? instruccionDeEdicion\(mensaje \|\| ''\) : \(mensaje \|\| ''\)/.test(ruta), '7d. CASO 3: la cantidad de diapositivas se calcula solo sobre la instrucción del docente')

console.log('')
if (fallos > 0) {
  console.error(`${fallos} prueba(s) fallaron.`)
  process.exit(1)
}
console.log('Todas las pruebas pasaron.')
