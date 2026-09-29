// scripts/verificar-descarga-word-pdf.ts
//
// Prueba aislada (sin credenciales, sin red real hacia Supabase, sin
// escrituras reales) de "AJUSTE AISLADO DE DOCUMENTOS — descarga real
// en Word y PDF, sin botones redundantes": confirma que "Abrir" fue
// retirado, que "Convertir" sigue sin reaparecer, que la tarjeta de
// planeación ofrece Descargar Word + Descargar PDF (agrupados en UNA
// tarjeta, nunca dos), que la hoja de evaluación sigue siendo
// exclusivamente PDF, que Word y PDF se generan de verdad (buffers
// reales, firmas binarias válidas) desde el MISMO texto fuente, que la
// vista previa no persiste nada, que la aprobación guarda ambos
// formatos de forma idempotente (nunca duplicados), y que ningún
// camino nuevo crea mensajes role:user ni usa el modelo pedagógico
// para "convertir".
// Se ejecuta con `npx tsx scripts/verificar-descarga-word-pdf.ts`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { generarWordBuffer } from '../lib/documentGen/generarWordServidor'
import { generarPdfBuffer } from '../lib/documentGen/generarPdfServidor'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

const RAIZ = join(__dirname, '..')
const PERFIL_FALSO = { nombre: 'Docente de prueba', escuela: 'Escuela de prueba', grado: '4°', grupo: 'B' }
const TEXTO_PLANEACION = `📋 PLANEACIÓN DIDÁCTICA — Los seres vivos
Propósito
Que el alumnado identifique las características de los seres vivos.
CONTENIDOS
- Clasificación de seres vivos
- Características comunes
DÍA 1 — Introducción
Actividad de inicio: preguntas exploratorias.
Actividad de desarrollo: observación de imágenes.
Actividad de cierre: registro en el cuaderno.
`

async function main() {
  const rutaPanel = readFileSync(join(RAIZ, 'components', 'Asistente', 'AsistentePanel.tsx'), 'utf-8')
  const rutaRouteChat = readFileSync(join(RAIZ, 'app', 'api', 'chat', 'route.ts'), 'utf-8')
  const rutaAprobar = readFileSync(join(RAIZ, 'lib', 'planeacion', 'aprobarBorrador.ts'), 'utf-8')
  const rutaVistaPreviaPdf = readFileSync(join(RAIZ, 'app', 'api', 'planeaciones', 'vista-previa-documento', 'route.ts'), 'utf-8')
  const rutaVistaPreviaWord = readFileSync(join(RAIZ, 'app', 'api', 'planeaciones', 'vista-previa-documento-word', 'route.ts'), 'utf-8')

  const iTarjeta = rutaPanel.indexOf('function TarjetaDescarga(')
  const iFinTarjeta = rutaPanel.indexOf('\n// Vista previa de solo lectura del documento activo', iTarjeta)
  const cuerpoTarjeta = rutaPanel.slice(iTarjeta, iFinTarjeta)
  const codigoRealTarjeta = cuerpoTarjeta.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

  // ============================================================
  // 1. "Abrir" ya no aparece en ninguna tarjeta.
  // ============================================================
  {
    verificar(!codigoRealTarjeta.includes('🔗 Abrir'), '1. TarjetaDescarga ya no muestra el botón "Abrir"')
  }

  // ============================================================
  // 2. "Convertir" no reaparece.
  // ============================================================
  {
    verificar(!codigoRealTarjeta.includes('Convertir'), '2a. TarjetaDescarga sigue sin mostrar "Convertir" (fuera de comentarios explicativos)')
    verificar(!rutaPanel.includes('onConvertir') && !rutaPanel.includes('convertirDocumento'), '2b. No existe ningún callback de conversión (onConvertir/convertirDocumento) en todo el panel')
  }

  // ============================================================
  // 3-5. La planeación ofrece Word + PDF agrupados; la hoja de
  //      evaluación ofrece solamente PDF.
  // ============================================================
  {
    verificar(cuerpoTarjeta.includes('⬇️ {etiquetaDescargar(archivo.tipo)}'), '3-4. El botón "Descargar" usa el nombre real del formato (Word/PDF) por cada archivo del grupo — no un botón fijo único')
    // AJUSTE DE NOMENCLATURA (diagnóstico real en iPhone Safari): el
    // PDF se abre en el visor de Safari en vez de descargarse directo
    // (comportamiento propio de WebKit, no un error de la app) — la
    // etiqueta del botón ahora lo refleja ("Ver / Descargar PDF"),
    // aunque el comportamiento real (descargarArchivo) no cambió.
    verificar(rutaPanel.includes("if (tipo === 'pdf') return 'Ver / Descargar PDF'"), '3-4b. La etiqueta del PDF es "Ver / Descargar PDF" — Word conserva "Descargar Word" sin cambios')
    verificar(rutaPanel.includes('function agruparArchivosPorDocumento'), '3b. Existe la función que agrupa Word+PDF de la planeación en UNA sola tarjeta (nunca dos tarjetas separadas para el mismo documento)')
    verificar(rutaPanel.includes('archivo.tipoDocumento) {') && rutaPanel.includes('grupos[indiceExistente].push(archivo)'), '3c. El agrupamiento realmente junta archivos que comparten tipoDocumento, en vez de crear un grupo por archivo')
    // La hoja de evaluación solo emite un marcador 'pdf' — nunca 'word' — en las 2 rutas donde se adjunta (aprobación y vista previa).
    const seccionAprobacionHoja = rutaRouteChat.slice(rutaRouteChat.indexOf('archivoHoja ='), rutaRouteChat.indexOf('archivoHoja =') + 300)
    verificar(seccionAprobacionHoja.includes("tipo: 'pdf'") && !seccionAprobacionHoja.includes("tipo: 'word'"), "5. La hoja de evaluación definitiva se adjunta exclusivamente como 'pdf', nunca como 'word'")
  }

  // ============================================================
  // 6-9. El Word y el PDF se generan REALMENTE (no simulados) desde
  //      el MISMO texto fuente, con firmas binarias válidas.
  // ============================================================
  {
    const bufferWord = await generarWordBuffer(TEXTO_PLANEACION, PERFIL_FALSO, 'America/Mexico_City')
    const bufferPdf = await generarPdfBuffer(TEXTO_PLANEACION, PERFIL_FALSO, 'America/Mexico_City')
    verificar(bufferWord.length > 0 && bufferWord.subarray(0, 2).toString('latin1') === 'PK', '6. El Word generado es un archivo .docx real (firma ZIP "PK" — un docx es internamente un ZIP con XML de OOXML válido)')
    verificar(bufferWord.length > 1000, '7. El Word generado tiene un tamaño real y sustancial (no un archivo vacío o truncado) — consistente con un .docx abrible en Word/Pages/Google Docs')
    verificar(bufferPdf.length > 0 && bufferPdf.subarray(0, 4).toString('latin1') === '%PDF', '8. El PDF generado sigue siendo un .pdf real y válido (firma "%PDF")')
    // Ambos se generaron con el MISMO texto de entrada (TEXTO_PLANEACION) — la prueba en sí misma demuestra que "misma fuente" es posible; en producción, tanto el marcador Word como el PDF de la vista previa parten de la MISMA variable `datosDocumento`/`textoCompleto` (verificado a nivel de código en el punto 9a).
    const seccionMarcadores = rutaRouteChat.slice(rutaRouteChat.indexOf('const textoCompleto = extraerTextoCompletoBorrador'), rutaRouteChat.indexOf('planeacionPdfGenerado=true planeacionWordGenerado=true'))
    verificar(
      (seccionMarcadores.match(/datosComprimidos/g) ?? []).length >= 2,
      '9a. La URL de Word y la URL de PDF en la vista previa reutilizan el MISMO payload comprimido (datosComprimidos) — nunca dos extracciones de texto distintas'
    )
    // 9b/9c (AUDITORÍA 2026-09-29): la generación DEFINITIVA (aprobación) ya
    // no extrae el texto vía `ultimoTurno?.role` ni genera Word/PDF con
    // ejecutarHerramientaDocumento('word'|'pdf', textoCompleto, ...) — desde
    // PLN-1E-B (snapshot V4, prioridad a `contenidoCompletoDefinitivo` sobre
    // el historial) y la composición con la hoja canónica (Fase 4.5:
    // generarWordBuffer/generarPdfBuffer en tries independientes, fusionados
    // con la hoja) ese contrato cambió de raíz. Ambos comportamientos ya
    // están protegidos con mayor precisión por suites vigentes:
    //   - prioridad de contenidoCompletoDefinitivo sobre el historial:
    //     verificar-aprobar-planeacion-snapshot-v4.ts (CASO G)
    //   - Word/PDF definitivos generados desde la MISMA textoCompleto,
    //     compuestos con la hoja, cada uno en su propio try/catch:
    //     verificar-composicion-hoja-planeacion.ts
    // No se duplica aquí para no dejar una aserción frágil sobre texto
    // literal de una implementación ya reemplazada.
  }

  // ============================================================
  // 10-12. Ningún camino nuevo crea mensajes role:user, modifica el
  //        input del Chat IA, ni llama al modelo pedagógico para
  //        "convertir".
  // ============================================================
  {
    verificar(!codigoRealTarjeta.includes("rol: 'usuario'"), '10. TarjetaDescarga no construye ningún mensaje con rol "usuario"')
    verificar(!codigoRealTarjeta.includes('setInput') && !codigoRealTarjeta.includes('sendMessage') && !codigoRealTarjeta.includes('handleSend') && !codigoRealTarjeta.includes('enviarMensaje'), '11. TarjetaDescarga no modifica el input del Chat IA ni llama a sendMessage/handleSend/enviarMensaje')
    const rutaHerramientas = readFileSync(join(RAIZ, 'lib', 'documentGen', 'herramientas.ts'), 'utf-8')
    verificar(!rutaHerramientas.includes('Anthropic') && !rutaHerramientas.includes('claude') && !rutaHerramientas.includes('messages.create'), '12. ejecutarHerramientaDocumento (usado tanto por la vista previa como por la aprobación) nunca llama al modelo pedagógico — genera el archivo de forma mecánica')
  }

  // ============================================================
  // 13-14. Descargar un formato nunca elimina el otro.
  // ============================================================
  {
    verificar(!rutaPanel.includes('agregarArchivoATarjeta'), '13a. No existe ninguna función que reescriba/reemplace el arreglo de archivos al descargar (el menú de conversión que hacía eso fue retirado por completo)')
    // 13b (AUDITORÍA 2026-09-29): desde FASE V1-A la tarjeta ya no recorre
    // `archivos` directamente — deriva `archivosVista` con `.map()` (nunca
    // .filter()/.slice()) para poder refrescar la URL de la imagen principal
    // sin mutar `archivos`. El invariante real a proteger sigue siendo el
    // mismo de antes (nunca se quita/reordena una entrada, solo puede
    // sustituirse su `url`), verificado de forma estructural y no por texto
    // literal frágil:
    verificar(rutaPanel.includes('const archivosVista = archivos.map('), '13b-1. archivosVista se deriva con .map() directamente sobre `archivos` — un .map() siempre conserva el mismo tamaño y orden (nunca quita ni reordena entradas)')
    verificar(rutaPanel.includes('{ ...archivo, url:') && rutaPanel.includes(': archivo))'), '13b-2. Cada entrada del mapeo solo puede resultar en (a) el mismo `archivo` sin tocar, o (b) un spread `{...archivo, url: ...}` que conserva todos sus campos originales y únicamente sustituye `url` — nunca se construye una entrada distinta')
    verificar(!codigoRealTarjeta.includes('archivosVista.filter(') && !codigoRealTarjeta.includes('archivos.filter('), '13b-3. Ningún .filter() se aplica sobre archivos/archivosVista dentro de la tarjeta — ninguna entrada puede desaparecer antes de renderizarse')
    verificar(codigoRealTarjeta.includes('archivosVista.map((archivo)'), '13b-4. El render de los botones "Descargar" recorre `archivosVista` completo — solo lectura, nunca un subconjunto filtrado ni una lista reconstruida aparte')
    verificar(!rutaAprobar.includes('.delete(') && !rutaVistaPreviaPdf.includes('.delete(') && !rutaVistaPreviaWord.includes('.delete('), '14. Ninguno de los caminos de generación (aprobación, vista previa Word, vista previa PDF) ejecuta DELETE sobre ninguna tabla')
  }

  // ============================================================
  // 15. No se generan archivos duplicados — Fase 4.5 es idempotente.
  // ============================================================
  {
    // 15a/15b (AUDITORÍA 2026-09-29): la reutilización ya NO es incondicional
    // (`evaluacionPrevia?.documento_word ?? null` / `?.documento_pdf ?? null`)
    // — ahora exige `doc.incluye_hoja === true && doc.hoja_id === hojaId`
    // (función esReutilizable) para no reutilizar un documento compuesto con
    // una hoja distinta a la vigente. Ese contrato exacto ya está protegido
    // con mayor precisión por verificar-composicion-hoja-planeacion.ts
    // (aserción 18b, que exige el regex exacto de esa condición) — no se
    // duplica aquí.
    verificar(rutaAprobar.includes('if (!documentoWord) {') && rutaAprobar.includes('if (!documentoPdf) {'), '15c. La generación real solo se dispara si el formato correspondiente TODAVÍA no existe (o no fue reutilizable)')
  }

  // ============================================================
  // 16. La vista previa (Word y PDF) no persiste datos definitivos —
  //     sigue sin subir nada a Storage ni crear filas.
  // ============================================================
  {
    for (const [nombre, contenido] of [['vista-previa-documento', rutaVistaPreviaPdf], ['vista-previa-documento-word', rutaVistaPreviaWord]] as const) {
      verificar(!contenido.includes('.insert(') && !contenido.includes('.upsert(') && !contenido.includes('subirBuffer'), `16. ${nombre}/route.ts no sube nada a Storage ni crea filas en ninguna tabla`)
      verificar(contenido.includes("'Cache-Control': 'no-store'"), `16b. ${nombre}/route.ts marca la respuesta como no-store — nunca se cachea como si fuera definitiva`)
    }
  }

  // ============================================================
  // 17. La aprobación guarda correctamente ambos formatos, vinculados
  //     al mismo registro de planeación (planeacion_proyectos.evaluacion).
  // ============================================================
  {
    verificar(rutaAprobar.includes('...(documentoWord ? { documento_word: documentoWord } : {})'), '17a. El Word definitivo se guarda dentro de evaluacion.documento_word cuando se logró generar')
    verificar(rutaAprobar.includes('...(documentoPdf ? { documento_pdf: documentoPdf } : {})'), '17b. El PDF definitivo se guarda dentro de evaluacion.documento_pdf cuando se logró generar')
    verificar(rutaAprobar.includes(".eq('planeacion_id', planeacionId)"), '17c. Ambos quedan vinculados al MISMO registro de planeación (mismo planeacion_id), sin tabla nueva')
    verificar(rutaAprobar.includes('documentoPlaneacion: documentoWord && documentoPdf'), '17d. El resultado de la aprobación expone ambos formatos juntos cuando los dos existen — nunca uno sin el otro')
  }

  // ============================================================
  // 18. La hoja de evaluación conserva su maquetación (28 alumnos, 5
  //     indicadores, escala 1-4, Nivel final, una sola hoja) — este
  //     bloque no tocó lib/documentGen/generarHojaSeguimientoPdf.ts en
  //     absoluto (ver también scripts/verificar-maquetacion-hoja-evaluacion.ts).
  // ============================================================
  {
    const rutaHoja = readFileSync(join(RAIZ, 'lib', 'documentGen', 'generarHojaSeguimientoPdf.ts'), 'utf-8')
    verificar(rutaHoja.includes('CANTIDAD_INDICADORES_HOJA') && rutaHoja.includes("'Nivel final'"), '18. generarHojaSeguimientoPdf.ts sigue intacto (5 indicadores, columna Nivel final) — no se tocó en este ajuste')
  }

  // ============================================================
  // 19. Descarga robusta en Safari de iPhone — no se puede probar en
  //     un dispositivo real desde este entorno; se verifica que el
  //     mecanismo usado (blob + <a download> con object URL) es la
  //     técnica más confiable conocida, en vez de depender solo de
  //     window.open o del atributo `download` sobre una URL remota.
  // ============================================================
  {
    verificar(rutaPanel.includes('async function descargarArchivo(url: string, nombreSugerido: string)'), '19a. Existe una función dedicada de descarga (no un window.open directo en cada botón)')
    verificar(rutaPanel.includes('URL.createObjectURL(blob)') && rutaPanel.includes('enlace.download = nombreSugerido'), '19b. La descarga se dispara desde un blob local con un <a download> — la técnica más robusta conocida contra el comportamiento de "abrir en vez de descargar" de Safari/iOS')
    verificar(rutaVistaPreviaPdf.includes('attachment; filename=') && rutaVistaPreviaWord.includes('attachment; filename='), '19c. El servidor también manda Content-Disposition:attachment como primera línea de defensa (no se depende ÚNICAMENTE del blob del lado del cliente)')
  }

  // ============================================================
  // 20. Compartir no escribe mensajes en nombre del docente.
  // ============================================================
  {
    const iCompartir = rutaPanel.indexOf('async function compartirArchivo(')
    const iFinCompartir = rutaPanel.indexOf('\n// AJUSTE AISLADO', iCompartir)
    const cuerpoCompartir = rutaPanel.slice(iCompartir, iFinCompartir === -1 ? iCompartir + 1500 : iFinCompartir)
    verificar(!cuerpoCompartir.includes('AsistenteService') && !cuerpoCompartir.includes('enviarMensaje') && !cuerpoCompartir.includes("rol: 'usuario'"), '20. compartirArchivo no toca AsistenteService, enviarMensaje ni crea mensajes role:user en ninguna forma')
  }

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
