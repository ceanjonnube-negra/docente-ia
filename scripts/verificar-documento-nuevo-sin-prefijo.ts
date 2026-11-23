// scripts/verificar-documento-nuevo-sin-prefijo.ts
//
// CASO 3 de FINALIZAR ARCHIVO: un documento NUEVO pedido con formato
// explícito (Word, PDF o PowerPoint) se entrega como archivo aunque el
// modelo titule con otro emoji o sin emoji (caso real en Preview:
// "📢 AVISO PARA FAMILIAS…" se entregó como texto, sin tarjeta). No cambia
// esDocumentoFormal ni el historial documental; una respuesta vacía, una
// pregunta, una negativa o un aviso del sistema nunca se toman por
// documento.
//
// Sin red, sin credenciales, sin IA. Se ejecuta con
// `npx tsx scripts/verificar-documento-nuevo-sin-prefijo.ts`.

import { readFileSync } from 'node:fs'
import {
  AVISO_ARCHIVO_GENERADO,
  contenidoParaArchivo,
  documentoParaHistorial,
  esDocumentoDelHistorial,
  esDocumentoFormal,
  esDocumentoNuevoConFormatoExplicito,
  esDocumentoNuevoEntregable,
  esDocumentoRedactado,
  FILTRO_DOCUMENTOS_HISTORIAL,
  finalizarArchivoExcedeLimite,
  LIMITE_CARACTERES_DOCUMENTO,
  MENSAJE_ARCHIVO_SIN_SESION,
  MENSAJE_DOCUMENTO_DEMASIADO_LARGO,
  PATRON_TITULO_DOCUMENTO_SQL,
  PREFIJOS_TITULO_DOCUMENTO,
  tipoArchivoSolicitado,
} from '../lib/asistente/documentos'

// persistencia.ts crea el cliente de Supabase al importarse: valores ficticios, sin red.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://supabase.invalid'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'clave-ficticia'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  console.log(`${condicion ? '✓' : '✗'} ${mensaje}`)
  if (!condicion) fallos++
}

const PEDIDO_AVISO = 'Redacta un aviso breve para las familias de 4.º B sobre la importancia de leer diariamente en casa. Entrégamelo en Word.'
const AVISO_ALTAVOZ = '📢 AVISO PARA FAMILIAS — LECTURA DIARIA EN CASA\n\nEstimadas familias:\nLes invitamos a leer con sus hijos al menos 20 minutos cada día.\n\nAtentamente,\nLa maestra de grupo'
const AVISO_SIN_EMOJI = 'AVISO PARA LAS FAMILIAS\n\nEstimadas familias:\nLeer en casa todos los días fortalece la comprensión lectora.'
const AVISO_TITULO_NORMAL = 'Aviso para las familias de 4.º B\n\nLes recordamos la importancia de la lectura diaria en casa.'
const CITATORIO = '📨 CITATORIO\n\nEstimados padres de familia:\n- Fecha: 12 de noviembre\n- Hora: 8:00'

// 1. Qué se reconoce como documento redactado en un documento nuevo confirmado.
verificar(esDocumentoNuevoConFormatoExplicito(PEDIDO_AVISO), '1a. El pedido real es un documento nuevo con formato explícito (Word)')
verificar(!esDocumentoFormal(AVISO_ALTAVOZ) && esDocumentoRedactado(AVISO_ALTAVOZ), '1b. Aviso que empieza con 📢 → documento (antes se entregaba como texto)')
verificar(esDocumentoRedactado(AVISO_SIN_EMOJI) && esDocumentoRedactado(AVISO_TITULO_NORMAL), '1c. Título sin emoji, en mayúsculas o en estilo normal → documento')
verificar(esDocumentoFormal(CITATORIO) && esDocumentoRedactado(CITATORIO), '1d. Documento con un emoji tradicional → documento, como siempre')

// 2. Lo que nunca es documento.
const noDocumentos: [string, string][] = [
  ['', 'vacío'],
  ['   \n  ', 'solo espacios'],
  ['No entendí bien qué documento necesitas. ¿Puedes darme más detalles?', 'aviso de error del servidor (una línea)'],
  ['Lo siento, no puedo generar ese documento.\nIntenta de nuevo más tarde.', 'negativa'],
  ['¿Para qué fecha es el aviso?\nAsí lo preparo con los datos correctos.', 'pregunta para aclarar'],
  ['Claro, aquí tienes el aviso:\n\nEstimadas familias…', 'frase de introducción antes del documento'],
  [`${AVISO_ARCHIVO_GENERADO}\nYa puedes abrirlo, compartirlo o descargarlo.`, 'aviso técnico de archivo'],
  [`${MENSAJE_ARCHIVO_SIN_SESION}\nVuelve a intentarlo.`, 'aviso de sesión inactiva'],
]
for (const [texto, caso] of noDocumentos) verificar(!esDocumentoRedactado(texto), `2. No es documento: ${caso}`)

// 3. Solo aplica a un documento nuevo con formato explícito confirmado.
for (const mensaje of ['¿Cuántos documentos tengo generados?', '¿Cuántos documentos de Word tengo?', 'Muéstrame mis documentos PDF']) {
  verificar(!esDocumentoNuevoConFormatoExplicito(mensaje), `3a. Consulta normal, sin solicitud de creación → regla de siempre: "${mensaje}"`)
}
for (const mensaje of ['Convierte el citatorio a PDF', 'Agrega una conclusión y guárdalo en PDF', 'Hazme un citatorio para mañana', 'Genera una imagen de un salón de clases']) {
  verificar(!esDocumentoNuevoConFormatoExplicito(mensaje), `3b. Conversión, edición, sin formato o multimedia → sin cambios: "${mensaje}"`)
}

// 4. La ruta: la entrega del CASO 3 ya no depende del emoji, solo en el caso confirmado.
const ruta = readFileSync('app/api/chat/route.ts', 'utf8')
verificar(ruta.includes("const documentoNuevoConfirmado = !esEdicionDocumento && esDocumentoNuevoConFormatoExplicito(mensaje || '')")
  && /const esDocumento = documentoNuevoConfirmado\s*\?\s*esDocumentoNuevoEntregable\(texto, respuestaCompleta\.stop_reason\)\s*:\s*esDocumentoFormal\(texto\)/.test(ruta)
  && ruta.includes('if (texto && esDocumento) {'), '4a. CASO 3: documento nuevo confirmado → esDocumentoNuevoEntregable (con stop_reason de la API); en lo demás, esDocumentoFormal')
const iGate = ruta.indexOf('if (texto && esDocumento) {')
const entrega = ruta.slice(iGate, ruta.indexOf("return respuestaTexto(`Documento generado correctamente.", iGate) + 120)
verificar(entrega.includes('ejecutarHerramientaDocumento(tipoHerramientaSolicitado, texto,') && entrega.includes('[[DOCUMENTO_ARCHIVO:') && entrega.includes('[[DOCUMENTO_CONTENIDO:'),
  '4b. Al pasar, se genera el archivo y se entregan su tarjeta ([[DOCUMENTO_ARCHIVO]]) y su contenido ([[DOCUMENTO_CONTENIDO]])')
verificar(ruta.includes("const esDocumentoConvertible = fuenteContenido === 'cliente' ? documentoTexto.trim() !== '' : esDocumentoFormal(documentoTexto)")
  && ruta.includes('if (documentoTexto && esDocumentoConvertible) {'), "4c. CASO 1/2: el documento activo del cliente ('cliente') se convierte sin depender del prefijo; lo del historial conserva esDocumentoFormal")

// 5. Historial: el aviso con 📢 queda registrado con origen 'archivo' y aparece.
const archivo = { tipo: 'word', nombre: 'AVISO_PARA_FAMILIAS.docx', url: 'https://ejemplo.invalid/a.docx' }
const registrado = documentoParaHistorial(AVISO_ARCHIVO_GENERADO, { archivos: [archivo], contenidoOriginal: AVISO_ALTAVOZ })
verificar(registrado?.origen === 'archivo' && registrado.contenido === AVISO_ALTAVOZ, "5a. El aviso con 📢 se registra con origen 'archivo' y su texto real")
verificar(esDocumentoDelHistorial({ origen: registrado!.origen, contenido: registrado!.contenido }), '5b. Aparece en Historial y en la consulta del Chat (origen válido)')

// 6. Sin cambios globales.
verificar(PREFIJOS_TITULO_DOCUMENTO.join('') === '📋📊📝📨📄📖', '6a. esDocumentoFormal conserva sus 6 prefijos (no se amplió la lista)')
verificar(FILTRO_DOCUMENTOS_HISTORIAL === `origen.in.(archivo,texto),and(origen.is.null,contenido.match."${PATRON_TITULO_DOCUMENTO_SQL}")`, '6b. El filtro del historial documental no cambió')

// 7. Señal de la API: solo una respuesta terminada se entrega como archivo.
verificar(esDocumentoNuevoEntregable(AVISO_ALTAVOZ, 'end_turn') && esDocumentoNuevoEntregable(AVISO_SIN_EMOJI, 'end_turn'), "7a. Aviso con 📢 o sin emoji, terminado ('end_turn') → se entrega como archivo")
verificar(!esDocumentoNuevoEntregable(AVISO_ALTAVOZ, 'max_tokens'), "7b. Documento cortado por max_tokens → no se entrega como archivo incompleto")
verificar(!esDocumentoNuevoEntregable(AVISO_ALTAVOZ, 'refusal') && !esDocumentoNuevoEntregable(AVISO_ALTAVOZ, null), '7c. Rechazo de la API o respuesta sin stop_reason → no es archivo')
verificar(!esDocumentoNuevoEntregable('Lo siento, no puedo generar ese documento.\nIntenta de nuevo más tarde.', 'end_turn')
  && !esDocumentoNuevoEntregable('¿Para qué fecha es el aviso?\nAsí lo preparo.', 'end_turn') && !esDocumentoNuevoEntregable('', 'end_turn'),
  '7d. Negativa, pregunta o vacío, aunque la API termine normal → no es archivo')

async function crearYConvertir() {
const { contenidoDocumentoDe } = await import('../lib/asistente/persistencia')
// 8. Crear y después convertir (el contenido persistido es el referente).
for (const [nombre, aviso] of [['con 📢', AVISO_ALTAVOZ], ['sin emoji', AVISO_SIN_EMOJI]] as const) {
  const archivoWord = { tipo: 'word', nombre: 'Aviso.docx', url: 'https://ejemplo.invalid/a.docx' }
  // Mensaje del asistente tal como queda tras el CASO 3 (texto = aviso técnico, contenido real aparte).
  const mensajeAsistente = { id: 'msg-1', rol: 'asistente' as const, texto: AVISO_ARCHIVO_GENERADO, creadoEn: 1, archivo: archivoWord, contenidoDocumento: aviso }
  verificar(contenidoDocumentoDe(mensajeAsistente as never) === aviso, `8a. Aviso ${nombre} entregado en Word → es documento (contenido + archivo), también al recargar`)
  for (const tipo of ['pdf', 'word', 'powerpoint'] as const) {
    const finalizarArchivo = { tipo, documentoTexto: aviso, textoOriginal: `Pásalo a ${tipo}` }
    const contenido = contenidoParaArchivo({ mensaje: `Pásalo a ${tipo}`, finalizarArchivo, historial: [{ role: 'assistant', content: AVISO_ARCHIVO_GENERADO }] })
    verificar(tipoArchivoSolicitado({ mensaje: `Pásalo a ${tipo}`, esEdicionDocumento: false, formatoEntrega: undefined, finalizarArchivo }) === tipo
      && contenido.fuente === 'cliente' && 'texto' in contenido && contenido.texto === aviso && contenido.texto.trim() !== '',
      `8b. Aviso ${nombre} → convertir a ${tipo}: llega como documento del cliente con su contenido persistido (CASO 1/2, sin redactar de nuevo)`)
  }
}

// 9. Consultas y conversiones existentes, sin cambios.
const citatorioHistorial = contenidoParaArchivo({ mensaje: 'Convierte el citatorio a PDF', finalizarArchivo: undefined, historial: [{ role: 'assistant', content: CITATORIO }] })
verificar(citatorioHistorial.fuente === 'historial' && esDocumentoFormal(CITATORIO), "9a. Conversión desde el historial ('historial') sigue usando el prefijo canónico")
const avisoSoloHistorial = contenidoParaArchivo({ mensaje: 'Pásalo a PDF', finalizarArchivo: undefined, historial: [{ role: 'assistant', content: 'Hola, ¿en qué te ayudo?' }] })
verificar(avisoSoloHistorial.fuente !== 'cliente' && avisoSoloHistorial.fuente !== 'historial', '9b. Sin documento activo, una respuesta conversacional del historial no se convierte en archivo')
verificar(!esDocumentoNuevoConFormatoExplicito('¿Cuántos documentos de Word tengo?') && !esDocumentoNuevoConFormatoExplicito('Convierte el citatorio a PDF'), '9c. Consultas y conversiones no usan la regla del documento nuevo')

// 10. Límite del documento activo que llega del navegador (60,000 caracteres).
const conLargo = (n: number) => { const base = AVISO_ALTAVOZ + '\n'; return base + 'x'.repeat(n - base.length) }
const fuenteCliente = (texto: string) => contenidoParaArchivo({ mensaje: 'Pásalo a PDF', finalizarArchivo: { tipo: 'pdf', documentoTexto: texto, textoOriginal: 'Pásalo a PDF' }, historial: [] }).fuente
verificar(LIMITE_CARACTERES_DOCUMENTO === 60_000, '10a. Se reutiliza el límite existente: 60,000 caracteres')
verificar(fuenteCliente(AVISO_ALTAVOZ) === 'cliente' && !finalizarArchivoExcedeLimite({ tipo: 'pdf', documentoTexto: AVISO_ALTAVOZ }), '10b. Contenido válido (aviso con 📢) → se convierte')
const exacto = conLargo(60_000)
verificar(exacto.length === 60_000 && fuenteCliente(exacto) === 'cliente' && !finalizarArchivoExcedeLimite({ tipo: 'pdf', documentoTexto: exacto }), '10c. Exactamente 60,000 caracteres → se acepta')
const excedido = conLargo(60_001)
verificar(excedido.length === 60_001 && finalizarArchivoExcedeLimite({ tipo: 'pdf', documentoTexto: excedido }) && fuenteCliente(excedido) !== 'cliente',
  '10d. 60,001 caracteres → se rechaza: no se acepta como documento activo')
verificar(tipoArchivoSolicitado({ mensaje: 'Hola', esEdicionDocumento: false, formatoEntrega: undefined, finalizarArchivo: { tipo: 'pdf', documentoTexto: excedido } }) === null,
  '10e. Un documento rechazado no impone su formato')
verificar(!finalizarArchivoExcedeLimite(undefined) && !finalizarArchivoExcedeLimite({}) && !finalizarArchivoExcedeLimite({ documentoTexto: 5 }), '10f. Sin finalizarArchivo (otros flujos) → nada que rechazar')
const iRechazo = ruta.indexOf('if (finalizarArchivoExcedeLimite(finalizarArchivo)) {')
const bloqueRechazo = ruta.slice(iRechazo, ruta.indexOf('\n  }\n', iRechazo) + 4)
verificar(iRechazo > 0 && iRechazo < ruta.indexOf('const tipoHerramientaSolicitado = tipoArchivoSolicitado(') && bloqueRechazo.includes('return respuestaTexto(MENSAJE_DOCUMENTO_DEMASIADO_LARGO)')
  && !/supabase|\.from\(|messages\.create|ejecutarHerramientaDocumento/.test(bloqueRechazo),
  '10g. La ruta rechaza antes de todo con un mensaje claro, sin Supabase ni IA')
verificar(MENSAJE_DOCUMENTO_DEMASIADO_LARGO.includes('no se creó ningún archivo'), '10h. El mensaje de rechazo dice que no se creó ningún archivo')
verificar(/if \(texto\.length > LIMITE_CARACTERES_DOCUMENTO\) \{\s*texto = texto\.slice\(0, LIMITE_CARACTERES_DOCUMENTO\)/.test(ruta) && !/const LIMITE_CARACTERES_DOCUMENTO/.test(ruta),
  '10i. Los adjuntos se siguen recortando con la misma constante (una sola definición)')

console.log(fallos === 0 ? '\nTODO OK' : `\n${fallos} verificación(es) fallaron`)
process.exit(fallos === 0 ? 0 : 1)
}

crearYConvertir()
