// scripts/verificar-nombre-word-planeacion.ts
//
// Prueba aislada (sin credenciales, sin red real, sin escrituras
// reales) de "AJUSTE AISLADO — corregir únicamente el nombre del
// archivo Word de la planeación": confirma que el marcador de vista
// previa (app/api/chat/route.ts) ya NO manda el nombre hardcodeado
// "vista-previa-planeacion.docx" — en su lugar calcula el nombre con
// la MISMA función (nombreArchivoWordServidor) y el MISMO criterio
// (extraerTitulo) que ya usa vista-previa-documento-word/route.ts para
// su propio Content-Disposition, así que ambos SIEMPRE coinciden
// (fuente única, nunca pueden desalinearse). Confirma también que el
// .docx generado sigue siendo un ZIP/Office real (firma "PK",
// [Content_Types].xml, word/document.xml), que el Content-Disposition
// de la ruta real entrega "PLANEACION_DIDACTICA.docx" (con su
// variante filename* UTF-8), y que el PDF, Ver PDF, Descargar PDF y
// Compartir no se tocaron.
// Se ejecuta con `npx tsx scripts/verificar-nombre-word-planeacion.ts`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { generarWordBuffer, nombreArchivoWordServidor } from '../lib/documentGen/generarWordServidor'
import { generarPdfBuffer, nombreArchivoPdf } from '../lib/documentGen/generarPdfServidor'
import { extraerTitulo } from '../lib/documentGen/parseContenido'

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
const rutaChat = join(RAIZ, 'app/api/chat/route.ts')
const cuerpoChat = readFileSync(rutaChat, 'utf-8')
const rutaVistaPreviaWord = join(RAIZ, 'app/api/planeaciones/vista-previa-documento-word/route.ts')
const cuerpoVistaPreviaWord = readFileSync(rutaVistaPreviaWord, 'utf-8')
const rutaPanel = join(RAIZ, 'components/Asistente/AsistentePanel.tsx')
const cuerpoPanel = readFileSync(rutaPanel, 'utf-8')

const PERFIL_FALSO = { nombre: 'Docente de prueba', escuela: 'Escuela de prueba', grado: '4°', grupo: 'B' }
const TEXTO_PLANEACION = `📋 PLANEACIÓN DIDÁCTICA
Grado: 4° | Grupo: B | Fase: 4
Campo Formativo: Lenguajes
Proyecto Didáctico: Los seres vivos
Duración: 5 días

🎯 PROPÓSITO GENERAL
Que el alumnado identifique las características de los seres vivos.`

async function main() {
  // ============================================================
  // 1. El nombre hardcodeado anterior fue eliminado por completo del
  //    marcador de vista previa — nunca puede reaparecer por
  //    accidente.
  // ============================================================
  verificar(!cuerpoChat.includes("nombre: 'vista-previa-planeacion.docx'"), '1. El nombre hardcodeado "vista-previa-planeacion.docx" fue eliminado del marcador de vista previa en chat/route.ts')

  // ============================================================
  // 2. Fuente única real: el marcador ahora calcula el nombre con
  //    nombreArchivoWordServidor(extraerTitulo(textoCompleto)) — la
  //    MISMA función y el MISMO criterio que ya usa
  //    vista-previa-documento-word/route.ts (línea 70 real,
  //    verificada abajo) para su propio Content-Disposition.
  // ============================================================
  verificar(cuerpoChat.includes('nombre: nombreArchivoWordServidor(extraerTitulo(textoCompleto))'), '2. El marcador de vista previa calcula el nombre real con nombreArchivoWordServidor(extraerTitulo(textoCompleto))')
  verificar(cuerpoVistaPreviaWord.includes('nombreArchivoWordServidor(extraerTitulo(texto))'), '2b. vista-previa-documento-word/route.ts sigue calculando su Content-Disposition con la MISMA función — ambos nunca pueden desalinearse')
  verificar(cuerpoChat.includes("import { nombreArchivoWordServidor } from '@/lib/documentGen/generarWordServidor'"), '2c. chat/route.ts importa nombreArchivoWordServidor del módulo real de generación (no reinventa el slug)')
  verificar(cuerpoChat.includes("import { extraerTitulo } from '@/lib/documentGen/parseContenido'"), '2d. chat/route.ts importa extraerTitulo del módulo real de parseo (no reinventa la extracción del título)')

  // ============================================================
  // 5. La ruta real produce exactamente "PLANEACION_DIDACTICA.docx"
  //    para el título fijo de la planeación — verificado con
  //    ejecución REAL de extraerTitulo + nombreArchivoWordServidor,
  //    no una suposición.
  // ============================================================
  {
    const titulo = extraerTitulo(TEXTO_PLANEACION)
    const nombreCalculado = nombreArchivoWordServidor(titulo)
    verificar(nombreCalculado === 'PLANEACION_DIDACTICA.docx', `5. nombreArchivoWordServidor(extraerTitulo(...)) produce exactamente "PLANEACION_DIDACTICA.docx" para el título fijo de la planeación (obtenido: "${nombreCalculado}")`)
  }

  // ============================================================
  // Content-Disposition real de la ruta de descarga Word — filename
  // clásico + variante UTF-8 (filename*), Content-Type sin cambios.
  // ============================================================
  verificar(cuerpoVistaPreviaWord.includes("'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'"), '4. El Content-Type del Word sigue siendo el correcto, sin cambios')
  verificar(/'Content-Disposition':\s*`attachment; filename="\$\{nombreSugerido\}"; filename\*=UTF-8''\$\{encodeURIComponent\(nombreSugerido\)\}`/.test(cuerpoVistaPreviaWord), '5b. Content-Disposition incluye filename clásico + filename*=UTF-8\'\' con el mismo nombreSugerido real')

  // ============================================================
  // 6. El nombre mostrado/descargado nunca contiene "vista-previa" ni
  //    identificadores técnicos — verificado con el nombre REAL
  //    calculado arriba.
  // ============================================================
  {
    const nombreCalculado = nombreArchivoWordServidor(extraerTitulo(TEXTO_PLANEACION))
    verificar(!nombreCalculado.includes('vista-previa') && !nombreCalculado.includes('vista_previa'), '6. El nombre real calculado no contiene "vista-previa" ni "vista_previa"')
  }

  // ============================================================
  // 1-3 (docx real). El buffer generado sigue siendo un .docx real:
  //     firma ZIP "PK" y las dos entradas obligatorias de un Office
  //     Open XML válido — verificado cargando el ZIP de verdad con
  //     JSZip, nunca solo un grep de bytes.
  // ============================================================
  {
    const bufferWord = await generarWordBuffer(TEXTO_PLANEACION, PERFIL_FALSO, 'America/Mexico_City')
    verificar(bufferWord.length > 0 && bufferWord.subarray(0, 2).toString('latin1') === 'PK', '1a. El Word generado sigue siendo un archivo ZIP real (firma "PK")')
    const zip = await JSZip.loadAsync(bufferWord)
    verificar(zip.file('[Content_Types].xml') !== null, '1b. El .docx contiene [Content_Types].xml (Office Open XML real)')
    verificar(zip.file('word/document.xml') !== null, '1c. El .docx contiene word/document.xml (el contenido real del documento)')
  }

  // ============================================================
  // 9. El PDF sigue llamándose PLANEACION_DIDACTICA.pdf — ni la
  //    función ni el marcador de PDF se tocaron en este ajuste.
  // ============================================================
  {
    const nombrePdf = nombreArchivoPdf(extraerTitulo(TEXTO_PLANEACION))
    verificar(nombrePdf === 'PLANEACION_DIDACTICA.pdf', `9. El PDF sigue calculando exactamente "PLANEACION_DIDACTICA.pdf" (obtenido: "${nombrePdf}")`)
    verificar(cuerpoChat.includes("nombre: 'vista-previa-planeacion.pdf'"), "9b. El marcador de PDF conserva su propio nombre interno sin ningún cambio (restricción: no modificar la descarga PDF)")
    const bufferPdf = await generarPdfBuffer(TEXTO_PLANEACION, PERFIL_FALSO, 'America/Mexico_City')
    verificar(bufferPdf.length > 0 && bufferPdf.subarray(0, 4).toString('latin1') === '%PDF', '9c. El PDF real sigue generándose correctamente (firma %PDF), sin cambios')
  }

  // ============================================================
  // 10-11. Descargar Word (mecanismo), Ver PDF, Descargar PDF y
  //        Compartir permanecen intactos; ningún botón crea mensajes
  //        role:user.
  // ============================================================
  verificar(cuerpoPanel.includes('async function descargarArchivo(url: string, nombreSugerido: string)'), '10a. descargarArchivo (mecanismo real de "Descargar Word") sigue existiendo sin cambios')
  verificar(cuerpoPanel.includes("onClick={() => window.open(archivo.urlVer, '_blank')}"), '10b. "Ver PDF" sigue abriendo archivo.urlVer sin cambios')
  verificar(cuerpoPanel.includes('function descargarPdfDirecto(') && cuerpoPanel.includes('onClick={() => descargarPdfDirecto(archivo.url, archivo.nombre)}'), '10c. "Descargar PDF" sigue usando descargarPdfDirecto sin cambios')
  verificar(cuerpoPanel.includes('async function compartirArchivo('), '10d. Compartir (compartirArchivo) sigue existiendo sin cambios')
  {
    const bloqueTarjeta = cuerpoPanel
      .slice(cuerpoPanel.indexOf('function TarjetaDescarga'), cuerpoPanel.indexOf('function VistaPreviaDocumento'))
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n')
    verificar(!/rol:\s*'usuario'|rol:"usuario"|sendMessage|handleSend|enviarMensaje|setInput\(/.test(bloqueTarjeta), '11. Ningún onClick dentro de TarjetaDescarga crea mensajes role:user ni toca sendMessage/handleSend/enviarMensaje/setInput')
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
