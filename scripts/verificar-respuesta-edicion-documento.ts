// scripts/verificar-respuesta-edicion-documento.ts
//
// Respuestas del asistente mientras hay un documento activo (ver
// enviarComoEdicion y 'respuesta-final' en AsistenteService). Defecto
// corregido: una edición de contenido reemplazaba EN SITIO el mensaje
// del documento con lo que respondiera el modelo, así que una respuesta
// solo de texto ("No encontré un borrador…", una aclaración, un error
// explicado) pisaba el documento, nunca aparecía como mensaje propio y
// además quedaba registrada como documentoActivo.
//
// Diseño (el mismo append-only de test/images-v1):
// - Edición de contenido: la respuesta es un turno NUEVO; el documento
//   fuente nunca se toca; documentoActivo solo se mueve si la respuesta
//   es un documento formal o trae archivo.
// - Finalizar archivo (Word/PDF): sin cambios — el archivo se adjunta al
//   mismo mensaje del documento y no se abre burbuja nueva.
//
// Prueba funcional sobre el servicio real (sin red, sin credenciales, sin
// llamar al modelo): se sustituyen únicamente los envíos al motor y la
// persistencia local, y se inyectan los eventos que emite el motor.
//
// Se ejecuta con `npx tsx scripts/verificar-respuesta-edicion-documento.ts`.

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

const DOC_ID = 'doc-fuente'
const TEXTO_DOC = '📋 PLANEACIÓN DIDÁCTICA\n\nProyecto: Los insectos\n…'
const TEXTO_DOC_EDITADO = '📋 PLANEACIÓN DIDÁCTICA\n\nProyecto: Los insectos (versión ajustada)\n…'
const ARCHIVO_WORD = { tipo: 'word', url: 'https://ejemplo.invalid/doc.docx', nombre: 'doc.docx' }

async function main() {
  // supabaseClient se crea al importar; con valores ficticios nunca se
  // usa la red en estas pruebas.
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://127.0.0.1:1'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'clave-ficticia'
  const { AsistenteService } = await import('../lib/asistente/AsistenteService')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = AsistenteService as any

  const avisos: string[] = []
  svc.persistirConversacion = () => {}
  svc.asegurarMotor = async () => {}
  svc.sincronizarHistorialTexto = () => {}
  svc.ejecutarEdicion = async () => {}
  svc.ejecutarFinalizacion = async () => {}
  svc.mostrarAvisoGeneracion = (texto: string) => { avisos.push(texto) }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const evento = (e: any) => svc.manejarEventoMotor(e)

  function reiniciar() {
    avisos.length = 0
    svc.mensajes = [
      { id: 'u1', rol: 'usuario', texto: 'Hazme la planeación', creadoEn: 1 },
      { id: DOC_ID, rol: 'asistente', texto: TEXTO_DOC, creadoEn: 2 },
    ]
    svc.documentoActivo = null
    svc.actualizarDocumentoActivo(DOC_ID, TEXTO_DOC)
    // turnoAbierto residual del turno anterior (el del documento).
    svc.turnoAbierto = DOC_ID
    svc.editandoDocumentoId = null
    svc.documentoFinalizandoId = null
    svc.textoDocumentoFinalizando = null
    svc.ultimoIntentoEdicion = null
    svc.turnoUsuarioPendiente = false
    svc.generando = false
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc = () => svc.mensajes.find((m: any) => m.id === DOC_ID)
  const ultimo = () => svc.mensajes[svc.mensajes.length - 1]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const asistentes = () => svc.mensajes.filter((m: any) => m.rol === 'asistente')

  // 1. Edición de contenido con respuesta SOLO de texto.
  reiniciar()
  await svc.enviarComoEdicion(DOC_ID, 'Apruébala y guárdala', 'prompt de edición')
  verificar(svc.turnoAbierto === null, '1a. enviarComoEdicion cierra el turnoAbierto residual')
  const textoRespuesta = 'No encontré un borrador de planeación en esta conversación.'
  evento({ tipo: 'respuesta-parcial', texto: textoRespuesta })
  verificar(doc()?.texto === TEXTO_DOC, '1b. El texto parcial no pisa el documento fuente')
  evento({ tipo: 'respuesta-final', texto: textoRespuesta })
  verificar(ultimo().rol === 'asistente' && ultimo().texto === textoRespuesta && ultimo().id !== DOC_ID, '1c. La respuesta de texto aparece como mensaje normal del asistente')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  verificar(svc.mensajes.filter((m: any) => m.texto === textoRespuesta).length === 1, '1d. Sin respuestas duplicadas')
  verificar(asistentes().length === 2, '1e. Exactamente una burbuja nueva del asistente')
  verificar(doc()?.texto === TEXTO_DOC, '1f. El documento fuente queda intacto')
  verificar(svc.documentoActivo?.id === DOC_ID && svc.documentoActivo?.texto === TEXTO_DOC, '1g. documentoActivo sigue siendo el documento real, no la respuesta de texto')
  verificar(svc.editandoDocumentoId === null && svc.ultimoIntentoEdicion === null, '1h. Estado de edición limpio')
  verificar(svc.generando === false, '1i. generando=false al terminar')
  verificar(avisos.length === 0, '1j. Sin aviso de error')

  // 2. Edición de contenido que devuelve un documento formal.
  reiniciar()
  await svc.enviarComoEdicion(DOC_ID, 'Ajusta el proyecto', 'prompt de edición')
  evento({ tipo: 'respuesta-parcial', texto: TEXTO_DOC_EDITADO })
  evento({ tipo: 'respuesta-final', texto: TEXTO_DOC_EDITADO })
  verificar(ultimo().texto === TEXTO_DOC_EDITADO && ultimo().id !== DOC_ID, '2a. El documento editado aparece como mensaje nuevo')
  verificar(doc()?.texto === TEXTO_DOC, '2b. La versión anterior queda intacta')
  verificar(svc.documentoActivo?.id === ultimo().id && svc.documentoActivo?.texto === TEXTO_DOC_EDITADO, '2c. documentoActivo pasa a la versión editada')
  verificar(svc.editandoDocumentoId === null && svc.ultimoIntentoEdicion === null, '2d. Estado de edición limpio')

  // 3. Edición de contenido que devuelve archivo adjunto.
  reiniciar()
  await svc.enviarComoEdicion(DOC_ID, 'Ajusta y pásalo a Word', 'prompt de edición')
  evento({ tipo: 'respuesta-parcial', texto: 'Documento generado correctamente.' })
  evento({ tipo: 'respuesta-final', texto: 'Documento generado correctamente.', archivo: ARCHIVO_WORD, archivos: [ARCHIVO_WORD], contenidoOriginal: TEXTO_DOC_EDITADO })
  verificar(ultimo().id !== DOC_ID && ultimo().archivo?.url === ARCHIVO_WORD.url, '3a. El archivo queda en el mensaje nuevo')
  verificar(doc()?.texto === TEXTO_DOC && !doc()?.archivo, '3b. El documento fuente no se modifica')
  verificar(svc.documentoActivo?.id === ultimo().id && svc.documentoActivo?.texto === TEXTO_DOC_EDITADO && svc.documentoActivo?.archivosGenerados?.word?.url === ARCHIVO_WORD.url, '3c. documentoActivo usa el contenido real y registra el archivo')
  verificar(svc.editandoDocumentoId === null, '3d. Estado de edición limpio')

  // 4. Finalizar archivo (Word) — comportamiento sin cambios.
  reiniciar()
  await svc.enviarComoFinalizacion(DOC_ID, 'Pásalo a Word', 'word', TEXTO_DOC)
  const cantidadAntes = svc.mensajes.length
  evento({ tipo: 'respuesta-parcial', texto: 'Documento generado correctamente.' })
  verificar(doc()?.texto === TEXTO_DOC, '4a. El texto técnico no reemplaza el documento')
  verificar(svc.mensajes.length === cantidadAntes, '4b. No se abre burbuja nueva durante la finalización')
  evento({ tipo: 'respuesta-final', texto: 'Documento generado correctamente.', archivo: ARCHIVO_WORD, archivos: [ARCHIVO_WORD] })
  verificar(doc()?.archivo?.url === ARCHIVO_WORD.url && doc()?.texto === TEXTO_DOC, '4c. El archivo se adjunta al mismo mensaje del documento')
  verificar(svc.mensajes.length === cantidadAntes, '4d. Sin burbujas nuevas al terminar')
  verificar(svc.documentoActivo?.id === DOC_ID && svc.documentoActivo?.archivosGenerados?.word?.url === ARCHIVO_WORD.url, '4e. documentoActivo conserva el documento y registra el archivo')
  verificar(svc.editandoDocumentoId === null && svc.documentoFinalizandoId === null && svc.textoDocumentoFinalizando === null && svc.ultimoIntentoEdicion === null, '4f. Estado de finalización limpio')

  // 5. Error a mitad de una edición de contenido.
  reiniciar()
  await svc.enviarComoEdicion(DOC_ID, 'Ajusta el proyecto', 'prompt de edición')
  evento({ tipo: 'respuesta-parcial', texto: '📋 PLANEACIÓN DIDÁCTICA\n\nProyec' })
  evento({ tipo: 'error', mensaje: 'Se perdió la conexión.' })
  verificar(asistentes().length === 1 && doc()?.texto === TEXTO_DOC, '5a. Se quita la burbuja a medias y el documento queda intacto')
  verificar(avisos.includes('Se perdió la conexión.'), '5b. El error se muestra al docente')
  verificar(svc.ultimoIntentoEdicion?.idDocumento === DOC_ID, '5c. Se conserva el intento para reintentar')
  verificar(svc.editandoDocumentoId === null && svc.turnoAbierto === null, '5d. Estado de edición limpio')

  // 6. Respuesta vacía en una edición de contenido.
  reiniciar()
  await svc.enviarComoEdicion(DOC_ID, 'Ajusta el proyecto', 'prompt de edición')
  evento({ tipo: 'respuesta-parcial', texto: '' })
  evento({ tipo: 'respuesta-final', texto: '' })
  verificar(asistentes().length === 1 && doc()?.texto === TEXTO_DOC, '6a. No queda burbuja vacía y el documento queda intacto')
  verificar(avisos.length === 1, '6b. Se avisa al docente')
  verificar(svc.editandoDocumentoId === null && svc.turnoAbierto === null, '6c. Estado de edición limpio')

  // 7. Turno normal sin documento activo — sin cambios.
  reiniciar()
  svc.documentoActivo = null
  svc.turnoAbierto = null
  evento({ tipo: 'respuesta-parcial', texto: 'Hola' })
  evento({ tipo: 'respuesta-final', texto: 'Hola' })
  verificar(ultimo().texto === 'Hola' && asistentes().length === 2, '7a. Turno normal intacto')

  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
    process.exit(0)
  }
}

main()
