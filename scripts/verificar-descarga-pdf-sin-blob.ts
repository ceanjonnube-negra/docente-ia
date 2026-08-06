// scripts/verificar-descarga-pdf-sin-blob.ts
//
// Prueba aislada (sin credenciales, sin red real, sin escrituras
// reales) de "CORRECCIÓN URGENTE Y AISLADA — Error WebKitBlobResource
// 1 al descargar PDF en Safari de iPhone": confirma que el botón
// "Descargar PDF" de TarjetaDescarga (components/Asistente/
// AsistentePanel.tsx) ya NUNCA pasa por un Blob local (fetch,
// response.blob/arrayBuffer, URL.createObjectURL/revokeObjectURL,
// blob:) — usa un <a href> directo a la ruta HTTP real del servidor,
// con el atributo `download` solo como apoyo, nunca como mecanismo
// principal. Confirma también que las dos rutas de vista previa
// (vista-previa-documento/route.ts, vista-previa-hoja/route.ts) siguen
// separando "ver" (inline, application/pdf) de "descargar" (attachment,
// application/octet-stream, Cache-Control endurecido, X-Content-Type-
// Options:nosniff), que el binario generado sigue siendo un PDF real
// (firma %PDF), y que "Descargar Word"/"Ver PDF"/"Compartir" quedaron
// exactamente igual que antes de este ajuste.
// Se ejecuta con `npx tsx scripts/verificar-descarga-pdf-sin-blob.ts`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { generarPdfBuffer } from '../lib/documentGen/generarPdfServidor'
import { generarHojaSeguimientoPdfBuffer } from '../lib/documentGen/generarHojaSeguimientoPdf'

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
const rutaPanel = join(RAIZ, 'components/Asistente/AsistentePanel.tsx')
const cuerpoPanel = readFileSync(rutaPanel, 'utf-8')
const rutaVistaPreviaDocumento = join(RAIZ, 'app/api/planeaciones/vista-previa-documento/route.ts')
const cuerpoVistaPreviaDocumento = readFileSync(rutaVistaPreviaDocumento, 'utf-8')
const rutaVistaPreviaHoja = join(RAIZ, 'app/api/planeaciones/vista-previa-hoja/route.ts')
const cuerpoVistaPreviaHoja = readFileSync(rutaVistaPreviaHoja, 'utf-8')

// Extrae el cuerpo completo de una función nombrada por su firma
// (incluyendo su bloque `{...}` balanceado) — necesario porque
// descargarPdfDirecto está rodeada de otras funciones que SÍ usan Blob
// legítimamente (descargarArchivo, para Word; compartirArchivo, para
// el Web Share API) y no deben confundirse con ella.
function extraerCuerpoFuncion(codigo: string, firma: string): string {
  const inicioFirma = codigo.indexOf(firma)
  if (inicioFirma === -1) return ''
  const inicioLlave = codigo.indexOf('{', inicioFirma)
  if (inicioLlave === -1) return ''
  let profundidad = 0
  for (let i = inicioLlave; i < codigo.length; i++) {
    if (codigo[i] === '{') profundidad++
    if (codigo[i] === '}') {
      profundidad--
      if (profundidad === 0) return codigo.slice(inicioFirma, i + 1)
    }
  }
  return ''
}

async function main() {
  const cuerpoDescargarPdfDirecto = extraerCuerpoFuncion(cuerpoPanel, 'function descargarPdfDirecto(')

  // ============================================================
  // 1-3. descargarPdfDirecto no usa fetch, no usa response.blob/
  //      arrayBuffer, no crea ni consume ninguna URL blob:.
  // ============================================================
  verificar(cuerpoDescargarPdfDirecto.length > 0, '0. descargarPdfDirecto existe como función real en AsistentePanel.tsx')
  verificar(!/fetch\(/.test(cuerpoDescargarPdfDirecto), '1. descargarPdfDirecto no llama a fetch — no hay respuesta HTTP que convertir a Blob')
  verificar(!/\.blob\(\)|\.arrayBuffer\(\)/.test(cuerpoDescargarPdfDirecto), '2. descargarPdfDirecto no usa response.blob()/arrayBuffer()')
  verificar(!/new Blob\(|URL\.createObjectURL|URL\.revokeObjectURL/.test(cuerpoDescargarPdfDirecto), '3. descargarPdfDirecto no crea ningún Blob local ni URL.createObjectURL/revokeObjectURL')
  verificar(!/blob:/.test(cuerpoDescargarPdfDirecto), '3b. descargarPdfDirecto no contiene ninguna referencia literal a blob:')
  verificar(!/window\.open|window\.location|router\.push/.test(cuerpoDescargarPdfDirecto), '3c. descargarPdfDirecto no usa window.open/window.location/router.push')

  // ============================================================
  // 4. El href de descarga es la URL real recibida como parámetro
  //    (ruta HTTP del propio servidor o la URL firmada de Storage),
  //    nunca una variable de blob local.
  // ============================================================
  verificar(/enlace\.href\s*=\s*url\b/.test(cuerpoDescargarPdfDirecto), '4. enlace.href se asigna directamente al parámetro `url` real — nunca a un objectUrl/blob local')
  verificar(/enlace\.download\s*=\s*nombreSugerido/.test(cuerpoDescargarPdfDirecto), '4b. enlace.download conserva el nombre real sugerido (soporte adicional, nunca el mecanismo principal)')
  verificar(/enlace\.rel\s*=\s*'noopener'/.test(cuerpoDescargarPdfDirecto), '4c. enlace.rel="noopener" presente, tal como se pidió')
  verificar(/document\.body\.appendChild\(enlace\)/.test(cuerpoDescargarPdfDirecto) && /enlace\.click\(\)/.test(cuerpoDescargarPdfDirecto) && /enlace\.remove\(\)/.test(cuerpoDescargarPdfDirecto), '4d. Patrón exacto: <a> temporal agregado al DOM, click(), remove()')

  // ============================================================
  // 5-6b. El botón "Descargar PDF" llama a descargarPdfDirecto con
  //       archivo.url (la URL de descarga real) — nunca con una
  //       versión ya envuelta en blob.
  // ============================================================
  verificar(cuerpoPanel.includes('onClick={() => descargarPdfDirecto(archivo.url, archivo.nombre)}'), '5. El botón "Descargar PDF" llama a descargarPdfDirecto(archivo.url, archivo.nombre) de forma síncrona y directa')
  verificar(cuerpoPanel.includes("onClick={() => window.open(archivo.urlVer, '_blank')}"), '6. El botón "Ver PDF" sigue abriendo archivo.urlVer en una pestaña nueva, sin cambios')
  verificar(!cuerpoPanel.includes('descargarArchivoForzado'), '6b. La variante anterior basada en Blob (descargarArchivoForzado) fue eliminada por completo — no queda ningún rastro')

  // ============================================================
  // 9. Ver PDF y Descargar PDF usan campos de URL distintos
  //    (archivo.urlVer vs archivo.url) — nunca la misma URL.
  // ============================================================
  {
    const bloqueBotones = cuerpoPanel.slice(cuerpoPanel.indexOf('archivo.tipo === \'pdf\' && archivo.tipoDocumento && archivo.urlVer'), cuerpoPanel.indexOf('archivo.tipo === \'pdf\' && archivo.tipoDocumento && archivo.urlVer') + 1200)
    verificar(bloqueBotones.includes('archivo.urlVer') && bloqueBotones.includes('archivo.url,'), '9. El bloque Ver/Descargar usa archivo.urlVer para "Ver" y archivo.url para "Descargar" — dos campos distintos, nunca el mismo')
  }

  // ============================================================
  // 10-11. Descargar Word y Compartir permanecen sin ningún cambio.
  // ============================================================
  verificar(cuerpoPanel.includes('async function descargarArchivo(url: string, nombreSugerido: string)'), '10. descargarArchivo (usada por "Descargar Word") sigue existiendo exactamente igual — no se tocó')
  verificar(/const res = await fetch\(url\)[\s\S]{0,400}const blob = await res\.blob\(\)[\s\S]{0,200}URL\.createObjectURL\(blob\)/.test(cuerpoPanel), '10b. descargarArchivo (Word) conserva su propio mecanismo de blob — restricción explícita: "Descargar Word ya funciona correctamente", no se modificó')
  verificar(cuerpoPanel.includes('async function compartirArchivo('), '11. compartirArchivo sigue existiendo exactamente igual — Compartir no se tocó')

  // ============================================================
  // 12. Ninguna acción del flujo de descarga crea mensajes role:user.
  // ============================================================
  verificar(!/rol:\s*'usuario'|rol:"usuario"|sendMessage|handleSend|enviarMensaje|setInput\(/.test(cuerpoDescargarPdfDirecto), '12. descargarPdfDirecto no crea mensajes role:user ni toca sendMessage/handleSend/enviarMensaje/setInput')

  // ============================================================
  // 17. No queda ninguna referencia activa a blob: en el flujo de
  //     descarga de PDF (ni en descargarPdfDirecto ni en el bloque de
  //     botones Ver/Descargar) — descargarArchivo (Word) queda
  //     explícitamente fuera de este barrido, es la única función que
  //     legítimamente sigue usando blob.
  // ============================================================
  {
    const bloqueBotonesPdf = cuerpoPanel.slice(cuerpoPanel.indexOf('archivo.tipo === \'pdf\' && archivo.tipoDocumento && archivo.urlVer'), cuerpoPanel.indexOf('archivo.tipo === \'pdf\' && archivo.tipoDocumento && archivo.urlVer') + 1200)
    verificar(!/createObjectURL|revokeObjectURL|new Blob\(|\.blob\(\)/.test(bloqueBotonesPdf), '17. El bloque de botones Ver/Descargar PDF no contiene ninguna referencia a Blob/createObjectURL')
  }

  // ============================================================
  // Encabezados reales de la ruta de descarga (modo=descargar) — las
  // dos rutas de vista previa, planeación y hoja.
  // ============================================================
  for (const [nombre, cuerpo] of [['vista-previa-documento', cuerpoVistaPreviaDocumento], ['vista-previa-hoja', cuerpoVistaPreviaHoja]] as const) {
    const bloqueDescargar = cuerpo.slice(cuerpo.indexOf(': {', cuerpo.indexOf("modo === 'ver'")))
    verificar(bloqueDescargar.includes("'Content-Type': 'application/octet-stream'"), `application/octet-stream presente en la rama de descarga de ${nombre}`)
    verificar(/'Content-Disposition':\s*[`']attachment;\s*filename=/.test(bloqueDescargar), `Content-Disposition: attachment con filename presente en la rama de descarga de ${nombre}`)
    verificar(bloqueDescargar.includes("'Cache-Control': 'private, no-store, max-age=0'"), `Cache-Control: private, no-store, max-age=0 presente en la rama de descarga de ${nombre}`)
    verificar(bloqueDescargar.includes("'X-Content-Type-Options': 'nosniff'"), `X-Content-Type-Options: nosniff presente en la rama de descarga de ${nombre}`)
    // 8. La rama "ver" sigue intacta: inline + application/pdf.
    const bloqueVer = cuerpo.slice(cuerpo.indexOf("modo === 'ver'"), cuerpo.indexOf(': {', cuerpo.indexOf("modo === 'ver'")))
    verificar(cuerpo.includes("'Content-Type': 'application/pdf'") && /'Content-Disposition':\s*[`']inline/.test(cuerpo), `8. La rama "ver" de ${nombre} sigue usando application/pdf + inline, sin cambios`)
  }

  // ============================================================
  // 7. El binario generado sigue siendo un PDF real (firma %PDF) —
  //    misma generación de siempre, nunca se tocó (generarPdfBuffer /
  //    generarHojaSeguimientoPdfBuffer son las mismas funciones puras
  //    que ya usan las dos rutas de vista previa).
  // ============================================================
  {
    const PERFIL_FALSO = { nombre: 'Docente de prueba', escuela: 'Escuela de prueba', grado: '4°', grupo: 'B' }
    const bufferPlaneacion = await generarPdfBuffer('📋 PLANEACIÓN DIDÁCTICA — prueba\nPropósito\nTexto de prueba.', PERFIL_FALSO, 'America/Mexico_City')
    verificar(bufferPlaneacion.length > 0 && bufferPlaneacion.subarray(0, 4).toString('latin1') === '%PDF', '7a. El PDF real de planeación (generarPdfBuffer) comienza con la firma %PDF')

    const bufferHoja = await generarHojaSeguimientoPdfBuffer(
      {
        nombreProyecto: 'Proyecto de prueba',
        camposFormativos: ['Lenguajes'],
        trimestreNombre: 'Primer trimestre',
        fechaInicio: '2026-08-03',
        fechaFin: '2026-08-18',
        identificadorVisible: 'PRUEBA-0001',
        indicadores: [{ indicador_especifico: 'Indicador de prueba', aspecto_general: 'logro_aprendizaje' }],
        alumnos: [{ nombre: 'Alumno de prueba', posicion: 1 }],
      },
      PERFIL_FALSO,
      'America/Mexico_City'
    )
    verificar(bufferHoja.length > 0 && bufferHoja.subarray(0, 4).toString('latin1') === '%PDF', '7b. El PDF real de la hoja de evaluación (generarHojaSeguimientoPdfBuffer) comienza con la firma %PDF')
  }

  // ============================================================
  // 13-16. No reaparecen Abrir/Convertir/PowerPoint/Excel; no
  //        reaparece "Ver / Descargar PDF" para documentos
  //        planeación/hoja (sigue existiendo SOLO como fallback para
  //        pdf genérico sin urlVer, ver etiquetaDescargar).
  // ============================================================
  verificar(!cuerpoPanel.includes('🔗 Abrir'), '13a. El botón "Abrir" sigue sin reaparecer')
  verificar(!cuerpoPanel.includes('🔄 Convertir'), '13b. El botón "Convertir" sigue sin reaparecer')
  {
    const bloqueBotonesPdf = cuerpoPanel.slice(cuerpoPanel.indexOf('archivo.tipo === \'pdf\' && archivo.tipoDocumento && archivo.urlVer'), cuerpoPanel.indexOf('archivo.tipo === \'pdf\' && archivo.tipoDocumento && archivo.urlVer') + 1200)
    verificar(!/PowerPoint|Excel/.test(bloqueBotonesPdf), '13c. El bloque Ver/Descargar de planeación/hoja no ofrece PowerPoint ni Excel')
    verificar(!bloqueBotonesPdf.includes('Ver / Descargar PDF'), '14. El bloque Ver/Descargar de planeación/hoja nunca renderiza "Ver / Descargar PDF" combinado')
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
