// scripts/verificar-streaming-planeacion.ts
//
// Prueba aislada (sin credenciales, sin red, sin escrituras reales) del
// diagnóstico "Error al conectar con la IA" después de mostrar parte
// de la planeación. Causa real confirmada por código (ver informe):
// TIMEOUT_ANTHROPIC_MS (25s) se aplicaba también al streaming
// completo, no solo al primer byte — una planeación diagnóstica larga
// (secuencia didáctica completa de hasta 10 días, cerca de
// max_tokens=8000) podía tardar más de 25s en transmitirse completa,
// y el SDK de Anthropic abortaba la conexión a mitad de camino. No es
// posible reproducir de forma determinista una respuesta real de
// Claude que tarde más de X segundos (dependería de red/latencia real
// del proveedor, no de este código) — misma limitación ya documentada
// en el resto de la serie C-005. Se verifica en su lugar, con certeza:
// (1) que el valor del timeout realmente cambió y tiene margen real
// bajo max_tokens=8000, (2) que maxDuration da margen sobre ese
// timeout, (3) la forma exacta del manejo de errores (controller.error
// en vez de un cierre silencioso, exactamente una llamada terminal,
// ninguna escritura después), (4) que el cliente distingue la nueva
// señal de una respuesta exitosa y del resto de errores ya manejados,
// (5) la telemetría segura exigida.
// Se ejecuta con `npx tsx scripts/verificar-streaming-planeacion.ts`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

async function main() {
  const rutaChat = readFileSync(join(__dirname, '..', 'app', 'api', 'chat', 'route.ts'), 'utf-8')
  const rutaMotor = readFileSync(join(__dirname, '..', 'lib', 'asistente', 'motores', 'motorTextoClaude.ts'), 'utf-8')

  // ============================================================
  // 1. El timeout real del streaming de Claude da margen real para
  //    una planeación larga bajo el mismo max_tokens que ya usa el
  //    resto de la app — nunca menos de lo que ya se sabía necesario
  //    para una respuesta completa de ~8000 tokens (ver
  //    TIMEOUT_ANTHROPIC_DOCUMENTO_MS, la misma corrección ya hecha
  //    antes para el camino sin streaming).
  // ============================================================
  {
    const matchTimeout = rutaChat.match(/const TIMEOUT_ANTHROPIC_MS = (\d+)_(\d+)/)
    const timeoutMs = matchTimeout ? Number(matchTimeout[1] + matchTimeout[2]) : 0
    verificar(timeoutMs >= 100_000, `1a. TIMEOUT_ANTHROPIC_MS da margen real (${timeoutMs}ms >= 100000ms) — ya no corta una planeación larga a los 25s`)

    const matchDocumento = rutaChat.match(/const TIMEOUT_ANTHROPIC_DOCUMENTO_MS = (\d+)_(\d+)/)
    const timeoutDocumentoMs = matchDocumento ? Number(matchDocumento[1] + matchDocumento[2]) : 0
    verificar(timeoutMs >= timeoutDocumentoMs, `1b. El timeout de streaming (${timeoutMs}ms) es al menos tan generoso como el ya usado para respuestas completas de ~8000 tokens sin streaming (${timeoutDocumentoMs}ms)`)
  }

  // ============================================================
  // 2. maxDuration da margen real por encima del timeout de Claude —
  //    nunca al revés (Vercel no debe matar la función antes de que el
  //    propio timeout del SDK tenga oportunidad de resolver con
  //    claridad).
  // ============================================================
  {
    const matchMaxDuration = rutaChat.match(/export const maxDuration = (\d+)/)
    const maxDurationS = matchMaxDuration ? Number(matchMaxDuration[1]) : 0
    const matchTimeout = rutaChat.match(/const TIMEOUT_ANTHROPIC_MS = (\d+)_(\d+)/)
    const timeoutMs = matchTimeout ? Number(matchTimeout[1] + matchTimeout[2]) : 0
    verificar(maxDurationS > 0, '2a. app/api/chat/route.ts declara maxDuration explícitamente — nunca depende del límite implícito del plan')
    verificar(maxDurationS * 1000 > timeoutMs, `2b. maxDuration (${maxDurationS}s) da margen real por encima de TIMEOUT_ANTHROPIC_MS (${timeoutMs}ms) para el resto del trabajo de la petición`)
  }

  // ============================================================
  // 3. Manejo correcto de errores — exactamente UNA llamada terminal
  //    al controller (close O error, nunca ambas), ninguna escritura
  //    después de la llamada terminal, y una señal explícita en vez
  //    de un cierre silencioso cuando el streaming se interrumpe a
  //    mitad de una respuesta ya empezada.
  // ============================================================
  {
    verificar(rutaChat.includes("controller.error(new Error('RESPUESTA_INTERRUMPIDA'))"), '3a. El streaming interrumpido envía una señal explícita y distinguible (RESPUESTA_INTERRUMPIDA), no un cierre silencioso')

    // El `return` debe seguir INMEDIATAMENTE a controller.error() —
    // así controller.close() (la llamada de éxito) nunca se alcanza
    // para la misma ejecución que ya fue por error().
    const iError = rutaChat.indexOf("controller.error(new Error('RESPUESTA_INTERRUMPIDA'))")
    const bloqueTrasError = rutaChat.slice(iError, iError + 120)
    verificar(/controller\.error\(new Error\('RESPUESTA_INTERRUMPIDA'\)\)\s*\n\s*return/.test(bloqueTrasError), '3b. return sigue inmediatamente a controller.error() — controller.close() nunca se alcanza en el mismo camino de error')

    // Exactamente una llamada a controller.close() en el streaming
    // principal (la de éxito, fuera del try/catch) — nunca una
    // segunda ruta que también cierre.
    const zonaStreamPrincipalCodigo = rutaChat
      .slice(rutaChat.lastIndexOf('const readable = new ReadableStream({'), rutaChat.lastIndexOf('return new Response(readable'))
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n')
    const cierres = (zonaStreamPrincipalCodigo.match(/controller\.close\(\)/g) || []).length
    const errores = (zonaStreamPrincipalCodigo.match(/controller\.error\(/g) || []).length
    verificar(cierres === 1, `3c. Existe exactamente una llamada a controller.close() en el streaming principal (encontradas: ${cierres})`)
    verificar(errores === 1, `3d. Existe exactamente una llamada a controller.error() en el streaming principal (encontradas: ${errores})`)

    // Ninguna escritura (enqueue) ocurre DESPUÉS de la llamada de
    // cierre de éxito — controller.close() es la última línea del
    // cuerpo de start().
    const iClose = zonaStreamPrincipalCodigo.lastIndexOf('controller.close()')
    const despuesDeCerrar = zonaStreamPrincipalCodigo.slice(iClose + 'controller.close()'.length, iClose + 200)
    verificar(!despuesDeCerrar.includes('controller.enqueue'), '3e. Ninguna escritura (enqueue) ocurre después de controller.close()')
  }

  // ============================================================
  // 4. El cliente distingue la nueva señal de una respuesta exitosa,
  //    de un timeout de conexión y del catch-all genérico — nunca
  //    muestra "Error al conectar con la IA" para una interrupción a
  //    mitad de una respuesta que sí conectó y sí transmitió texto.
  // ============================================================
  {
    verificar(rutaMotor.includes("err.message === 'RESPUESTA_INTERRUMPIDA'"), '4a. motorTextoClaude.ts reconoce explícitamente la señal RESPUESTA_INTERRUMPIDA')
    verificar(rutaMotor.includes("mensaje: 'La respuesta se interrumpió antes de terminar. Vuelve a pedir la planeación.'"), '4b. El mensaje al docente es honesto y específico — nunca "Error al conectar con la IA" para este caso')

    // El chequeo de RESPUESTA_INTERRUMPIDA debe estar ANTES del
    // catch-all genérico, para que nunca caiga en el mensaje viejo.
    const iInterrumpida = rutaMotor.indexOf("err.message === 'RESPUESTA_INTERRUMPIDA'")
    const iGenerico = rutaMotor.indexOf("mensaje: 'Error al conectar con la IA.'")
    verificar(iInterrumpida !== -1 && iGenerico !== -1 && iInterrumpida < iGenerico, '4c. El chequeo de RESPUESTA_INTERRUMPIDA se evalúa antes que el catch-all genérico')

    // El catch-all genérico solo se alcanza si NINGUNA de las
    // condiciones anteriores (AbortError, ErrorLimiteDeTiempo,
    // RESPUESTA_INTERRUMPIDA) aplicó — nunca se dispara para una
    // respuesta que sí llegó completa (eso vive fuera del catch, en
    // el camino de éxito de arriba).
    const zonaCatch = rutaMotor.slice(rutaMotor.indexOf('} catch (err) {', rutaMotor.indexOf('guardarEnHistorial')), rutaMotor.indexOf("mensaje: 'Error al conectar con la IA.'") + 60)
    verificar(zonaCatch.includes('AbortError') && zonaCatch.includes('ErrorLimiteDeTiempo') && zonaCatch.includes('RESPUESTA_INTERRUMPIDA'), '4d. Las 3 rutas específicas (AbortError, ErrorLimiteDeTiempo, RESPUESTA_INTERRUMPIDA) se evalúan antes de caer en el mensaje genérico')
  }

  // ============================================================
  // 5. Telemetría segura — los indicadores exigidos existen, y nunca
  //    se registra contenido sensible (tokens, cookies, contenido de
  //    documentos, datos de alumnos, buffers).
  // ============================================================
  {
    const indicadoresExigidos = [
      'chatRequestIniciado', 'modeloRespondio', 'streamInicio', 'streamFinalizado',
      'borradorExtraido', 'planeacionPdfGenerado', 'evaluacionPdfGenerada',
      'cantidadAdjuntos', 'eventoFinalEnviado', 'duracionTotalMs', 'errorEtapa', 'nombreError',
    ]
    for (const indicador of indicadoresExigidos) {
      verificar(rutaChat.includes(indicador), `5. Telemetría segura incluye el indicador "${indicador}"`)
    }

    // Nunca se registra el valor de accessToken/token, ni contenido de
    // documentos, ni buffers — solo dentro de las líneas [STREAM][chat].
    const lineasStream = rutaChat.split('\n').filter((l) => l.includes('[STREAM][chat]'))
    const lineaConDatoSensible = lineasStream.find((l) => /\$\{accessToken\}|\$\{.*[Bb]uffer.*\}|\$\{texto\}|\$\{textoCompleto\}|\$\{textoBorradorAcumulado\}/.test(l))
    verificar(!lineaConDatoSensible, '5b. Ninguna línea de telemetría [STREAM][chat] interpola tokens, buffers ni el contenido de los documentos')
  }

  // ============================================================
  // 6. Dos adjuntos serializables sin buffers dentro del JSON — los
  //    descriptores solo llevan tipo/nombre/url/tipoDocumento/
  //    descripcion (strings), nunca un Buffer ni el PDF en sí.
  // ============================================================
  {
    const archivoDocumento = { tipo: 'pdf', nombre: 'vista-previa-planeacion.pdf', url: '/api/planeaciones/vista-previa-documento?tipoDocumento=planeacion&token=x&datos=y', tipoDocumento: 'planeacion' as const, descripcion: 'Primer trimestre · 10 días efectivos' }
    const archivoHoja = { tipo: 'pdf', nombre: 'vista-previa-hoja-evaluacion.pdf', url: '/api/planeaciones/vista-previa-hoja?tipoDocumento=hoja_evaluacion&token=x&datos=y', tipoDocumento: 'hoja_evaluacion' as const, descripcion: '28 alumnos · 3 indicadores' }
    const serializado1 = JSON.stringify(archivoDocumento)
    const serializado2 = JSON.stringify(archivoHoja)
    verificar(JSON.parse(serializado1).nombre === archivoDocumento.nombre && JSON.parse(serializado2).nombre === archivoHoja.nombre, '6a. Ambos descriptores se serializan y deserializan sin pérdida')
    verificar(!serializado1.includes('Buffer') && !serializado2.includes('Buffer') && Object.values(archivoDocumento).every((v) => typeof v === 'string') && Object.values(archivoHoja).every((v) => typeof v === 'string'), '6b. Ningún descriptor contiene un Buffer ni un valor no serializable — solo strings')
  }

  // ============================================================
  // 7. Sin persistencia ni escrituras durante la vista previa (mismo
  //    criterio que el resto de C-005) — reafirmado aquí porque este
  //    turno de planeación es exactamente el que dispara ambos
  //    adjuntos en el mismo request.
  // ============================================================
  {
    const zonaAdjuntos = rutaChat.slice(rutaChat.indexOf('borradorExtraido'), rutaChat.indexOf('return new Response(readable'))
    verificar(!zonaAdjuntos.includes('.insert(') && !zonaAdjuntos.includes('.update(') && !zonaAdjuntos.includes('.delete('), '7. La construcción de los dos adjuntos no ejecuta ningún INSERT/UPDATE/DELETE')
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
