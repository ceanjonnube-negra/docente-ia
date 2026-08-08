// scripts/verificar-consolidacion-turno-voz.ts
//
// Prueba aislada (sin credenciales, sin red real, sin WebRTC) de
// "CORRECCIÓN AISLADA — evitar envío prematuro y fragmentación del
// dictado de voz en Chat IA": confirma, con ejecución REAL de la
// heurística pura (analizarComplecionFrase, lib/asistente/
// deteccionFinTurno.ts), que la instrucción reportada — "Ahora quiero
// que me diseñes una portada de bienvenida con [pausa natural de 1-2s]
// unos dibujos bonitos para el examen." — no se cierra a la mitad
// (el fragmento cortado por la pausa termina en un conector colgante,
// "con", así que la heurística la marca "incompleta" y espera el
// margen completo antes de cerrar), y verifica ESTRUCTURALMENTE la
// corrección real del bug de fondo: finalizarTurno() (lib/asistente/
// motores/motorOpenAIRealtime.ts) ya NO descarta en silencio un turno
// nuevo cuando el turno ANTERIOR todavía sigue esperando su respuesta
// completa — antes eso perdía para siempre el texto ya reconocido del
// segundo fragmento ("quedó dentro del campo de entrada, nunca se
// envió"); ahora reintenta solo, sin producir ningún envío duplicado.
//
// LÍMITE HONESTO DE ESTA PRUEBA: MotorOpenAIRealtime importa
// lib/supabaseClient.ts de forma transitiva (crea un cliente real de
// Supabase al cargar el módulo) — instanciar la clase completa en un
// script aislado exigiría variables de entorno falsas, rompiendo la
// misma convención que ya siguen las otras 19 suites de esta serie
// (nunca construir un cliente real de Supabase en una prueba). Por
// eso esta prueba combina ejecución real de la heurística pura (la
// parte que decide CUÁNDO cerrar un turno) con verificación
// estructural del mecanismo de reintento (la parte que evita perder
// texto cuando SÍ hace falta esperar) — la validación de extremo a
// extremo con WebRTC real sigue pendiente de un dispositivo real,
// igual que el resto del módulo de voz en este proyecto.
// Se ejecuta con `npx tsx scripts/verificar-consolidacion-turno-voz.ts`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { analizarComplecionFrase, CONFIG_FIN_TURNO } from '../lib/asistente/deteccionFinTurno'

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
const rutaMotor = join(RAIZ, 'lib/asistente/motores/motorOpenAIRealtime.ts')
const cuerpoMotor = readFileSync(rutaMotor, 'utf-8')

async function main() {
  // ============================================================
  // 1-2. Escenario EXACTO reportado: la pausa real (1-2s) cae en un
  //      fragmento que termina en un conector colgante ("con") — la
  //      heurística debe marcarlo "incompleta" y esperar el margen
  //      completo (3500ms, sin cambios), muy por encima de una pausa
  //      de 1-2s real.
  // ============================================================
  {
    const fragmento1 = 'Ahora quiero que me diseñes una portada de bienvenida con'
    const estado1 = analizarComplecionFrase(fragmento1)
    verificar(estado1 === 'incompleta', `1. El primer fragmento ("...con") se clasifica "incompleta" — nunca se cierra con una pausa de 1-2s (obtenido: "${estado1}")`)

    const consolidado = 'Ahora quiero que me diseñes una portada de bienvenida con unos dibujos bonitos para el examen.'
    const estadoFinal = analizarComplecionFrase(consolidado)
    verificar(estadoFinal === 'completa', `2. El texto consolidado completo (ambos fragmentos unidos) se clasifica "completa" — sí debe cerrarse tras el margen de tolerancia (obtenido: "${estadoFinal}")`)
  }

  // ============================================================
  // 3. Pausas naturales — varios puntos de corte plausibles de la
  //    MISMA instrucción, ninguno debe cerrarse antes de tiempo.
  // ============================================================
  {
    const cortes = [
      'Ahora quiero que me diseñes una portada de bienvenida',
      'Ahora quiero que me diseñes una portada de bienvenida con unos dibujos',
      'Ahora quiero que me diseñes una portada de bienvenida con unos dibujos bonitos',
      'Ahora quiero que me diseñes una portada de bienvenida con unos dibujos bonitos para',
    ]
    for (const corte of cortes) {
      const estado = analizarComplecionFrase(corte)
      verificar(estado !== 'completa', `3. Corte intermedio "...${corte.split(' ').slice(-2).join(' ')}" nunca se clasifica "completa" (obtenido: "${estado}")`)
    }
  }

  // ============================================================
  // 4. Frases largas — una instrucción de varias cláusulas con pausas
  //    internas reales (comas) nunca se cierra a la mitad.
  // ============================================================
  {
    const fragmentoLargo = 'Necesito que me hagas una planeación de quince días efectivos para el campo formativo de Lenguajes, con actividades de lectura'
    const estado = analizarComplecionFrase(fragmentoLargo)
    verificar(estado === 'incompleta', `4. Una frase larga con coma intermedia se clasifica "incompleta" (obtenido: "${estado}")`)
  }

  // ============================================================
  // 5. Correcciones al hablar — el docente pide explícitamente una
  //    pausa para pensar ("espera", "a ver") a media frase: nunca debe
  //    cerrarse automáticamente (solo el techo de silencio prolongado,
  //    sin cambios, lo haría).
  // ============================================================
  {
    const conEspera = 'Hazme dos ejemplos de fracciones, espera'
    verificar(analizarComplecionFrase(conEspera) === 'espera_explicita', '5a. "...espera" se clasifica espera_explicita (corrección al hablar)')
    const conAVer = 'Ponle falta a Sofía, no, a ver'
    verificar(analizarComplecionFrase(conAVer) === 'espera_explicita', '5b. "...a ver" se clasifica espera_explicita (corrección al hablar)')
  }

  // ============================================================
  // 6. Regresión — un cierre corto y legítimo ("Gracias.") sigue
  //    cerrando normalmente tras el ajuste de tolerancia (no se
  //    volvió tan permisivo que ya no cierre nunca).
  // ============================================================
  verificar(analizarComplecionFrase('Gracias.') === 'completa', '6. Un cierre corto y real ("Gracias.") sigue clasificándose "completa"')
  verificar(analizarComplecionFrase('') === 'incompleta', '6b. Texto vacío se clasifica "incompleta" (sin cambios)')

  // ============================================================
  // 7. Ajuste de tolerancia — silencioFraseCompletaMs subió (pequeña
  //    ventana adicional, pedida explícitamente); silencioFraseIncompletaMs
  //    y el techo de silencio prolongado quedaron intactos.
  // ============================================================
  verificar(CONFIG_FIN_TURNO.silencioFraseCompletaMs === 2500, `7a. silencioFraseCompletaMs subió a 2500ms (obtenido: ${CONFIG_FIN_TURNO.silencioFraseCompletaMs})`)
  verificar(CONFIG_FIN_TURNO.silencioFraseIncompletaMs === 3500, `7b. silencioFraseIncompletaMs permanece en 3500ms, sin cambios (obtenido: ${CONFIG_FIN_TURNO.silencioFraseIncompletaMs})`)

  // ============================================================
  // 8. CORRECCIÓN ESTRUCTURAL REAL DEL BUG — finalizarTurno() ya no
  //    descarta en silencio ("return" a secas) un turno nuevo mientras
  //    el anterior sigue esperando su respuesta completa: ahora
  //    reintenta con REINTENTO_FIN_TURNO_MS, sin perder el texto ya
  //    acumulado.
  // ============================================================
  {
    const bloqueGuard = cuerpoMotor.slice(cuerpoMotor.indexOf('async finalizarTurno()'), cuerpoMotor.indexOf('this.finalizandoTurno = true'))
    verificar(!/if \(this\.finalizandoTurno\) return\s*$/m.test(bloqueGuard), '8a. El guard de finalizandoTurno ya NO es un "return" a secas que descarta el turno nuevo')
    verificar(bloqueGuard.includes('this.reintentoFinTurno = setTimeout(') && bloqueGuard.includes('this.finalizarTurno()'), '8b. El guard reintenta llamando a finalizarTurno() de nuevo tras REINTENTO_FIN_TURNO_MS')
    verificar(cuerpoMotor.includes('const REINTENTO_FIN_TURNO_MS = 400'), '8c. REINTENTO_FIN_TURNO_MS está definido como una constante real (400ms), no un número mágico suelto')
  }

  // ============================================================
  // 9. El reintento nunca produce un envío duplicado — si ya no queda
  //    texto acumulado cuando el reintento corre (el turno anterior
  //    YA lo mandó), finalizarTurno() no hace nada (protección
  //    preexistente, sin cambios, ver textoFinal vacío).
  // ============================================================
  verificar(cuerpoMotor.includes("if (!textoFinal) {"), '9. finalizarTurno() sigue sin mandar nada si textoFinal quedó vacío — el reintento nunca duplica un envío ya resuelto')

  // ============================================================
  // 10. Eventos tardíos después de colgar — detener() limpia el
  //     temporizador de reintento (ya no puede disparar tras cerrar la
  //     sesión).
  // ============================================================
  {
    const bloqueDetener = cuerpoMotor.slice(cuerpoMotor.indexOf('async detener()'), cuerpoMotor.indexOf('async detener()') + 1000)
    verificar(bloqueDetener.includes('this.reintentoFinTurno') && bloqueDetener.includes('clearTimeout(this.reintentoFinTurno)'), '10. detener() limpia el temporizador de reintento — ningún evento tardío puede disparar un envío tras colgar')
  }

  // ============================================================
  // 11. Único punto de entrega real — sigue existiendo exactamente
  //     UNA llamada a enviarComoMensaje en todo el archivo (ningún
  //     camino nuevo que pudiera producir un segundo envío paralelo).
  // ============================================================
  {
    const llamadas = cuerpoMotor.match(/this\.enviarComoMensaje\(/g) ?? []
    verificar(llamadas.length === 1, `11. Sigue existiendo exactamente UN punto real de entrega (this.enviarComoMensaje) — encontrados: ${llamadas.length}`)
  }

  // ============================================================
  // 12. Interim nunca se envía a la IA — el caso 'delta' (transcripción
  //     parcial) solo actualiza el texto en pantalla, nunca llama a
  //     finalizarTurno ni a enviarComoMensaje.
  // ============================================================
  {
    const inicioDelta = cuerpoMotor.indexOf("case 'conversation.item.input_audio_transcription.delta':")
    const bloqueDelta = cuerpoMotor.slice(inicioDelta, cuerpoMotor.indexOf('case ', inicioDelta + 10))
    verificar(!bloqueDelta.includes('finalizarTurno') && !bloqueDelta.includes('enviarComoMensaje'), '12. El evento de transcripción parcial (interim) nunca llama a finalizarTurno ni a enviarComoMensaje — solo actualiza la vista previa')
  }

  // ============================================================
  // 13. La acumulación de fragmentos finales (varios segmentos de la
  //     misma intervención) sigue concatenándose en orden, sin
  //     cambios — es lo que permite consolidar "con" + "unos dibujos
  //     bonitos..." en un solo texto antes de evaluar el cierre.
  // ============================================================
  verificar(
    cuerpoMotor.includes('this.transcripcionUsuarioAcumulada = this.transcripcionUsuarioAcumulada\n            ? `${this.transcripcionUsuarioAcumulada} ${texto}`\n            : texto'),
    '13. Los fragmentos finales siguen concatenándose en orden en un solo texto acumulado antes de evaluar el cierre'
  )

  // ============================================================
  // 14. El techo de silencio prolongado (respaldo CASO D, distinto de
  //     la ventana adaptativa) permanece en 20000ms, sin cambios —
  //     "silencio definitivo" sigue siendo un mecanismo aparte.
  // ============================================================
  verificar(cuerpoMotor.includes('const SILENCIO_MAXIMO_MS = 20000'), '14. SILENCIO_MAXIMO_MS (silencio definitivo, respaldo) permanece en 20000ms, sin cambios')

  // ============================================================
  // 15. finalizandoTurno como re-entrancia sigue existiendo (doble
  //     evento onend / techo de silencio y ventana adaptativa
  //     venciendo casi al mismo tiempo) — no se eliminó, solo se le
  //     agregó el reintento para el caso de un turno NUEVO.
  // ============================================================
  verificar(cuerpoMotor.includes('private finalizandoTurno = false'), '15. El guard de re-entrancia finalizandoTurno sigue existiendo, sin eliminarse')

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
