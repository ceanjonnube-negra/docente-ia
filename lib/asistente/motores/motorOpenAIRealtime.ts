// lib/asistente/motores/motorOpenAIRealtime.ts
//
// Segundo MotorConversacional: conversación de voz CONTINUA en tiempo
// real sobre OpenAI Realtime/WebRTC — ver "Rediseñar el modo voz como
// conversación continua". Realtime es aquí exclusivamente oídos y
// boca, nunca cerebro:
//   - escucha continuamente mientras la sesión está activa;
//   - detecta el fin de turno con una heurística local (ver
//     lib/asistente/deteccionFinTurno.ts) y llama a finalizarTurno();
//   - finalizarTurno() manda el texto reconocido al MISMO pipeline que
//     un mensaje escrito (enviarComoMensaje = AsistenteService.
//     enviarMensaje — Clasificador de Nivel 0, Herramientas,
//     /api/chat, Claude);
//   - cuando la respuesta real llega, reproducirRespuestaEnVoz() le
//     pide a esta MISMA sesión que la lea en voz alta, palabra por
//     palabra (ver personaVoz.ts) — nunca que la componga;
//   - en cuanto termina de leer, vuelve sola a escuchar. El ciclo se
//     repite indefinidamente hasta que el docente cierra la sesión.
// Nunca genera contenido propio ni ejecuta Herramientas — no tiene
// tools registradas (ver app/api/realtime-token/route.ts), así que es
// arquitectónicamente imposible que lo haga, no solo por convención.
//
// Implementa exactamente la misma interfaz que MotorTextoClaude — nada
// fuera de este archivo sabe que existe WebRTC, SDP o un data channel.
// Si este motor falla al iniciar (sin micrófono, sin red, proveedor
// caído), AsistenteService recupera el control y sigue con
// MotorTextoClaude sin que ninguna pantalla se entere.
//
// El barge-in (el docente interrumpe mientras se lee una respuesta) se
// resuelve con el audio nativo de Realtime: interrupt_response=true
// hace que el servidor corte el audio en curso en cuanto detecta que
// el docente vuelve a hablar, y este motor cancela la respuesta de
// lectura explícitamente (response.cancel) apenas llega
// 'input_audio_buffer.speech_started' — mucho más inmediato y
// confiable que depender de un evento de un reproductor de audio del
// navegador.
//
// IMPORTANTE (iOS Safari): getUserMedia debe pedirse INMEDIATAMENTE al
// entrar a este método, antes de cualquier otro await (token, etc.).
// Safari en iPhone ata el permiso de micrófono a la "user activation" del
// tap que disparó la llamada; si se intercalan varias llamadas de red
// antes de pedir el micrófono, esa ventana puede expirar y getUserMedia
// falla (a veces sin diálogo de permiso siquiera), aunque el usuario
// nunca haya dicho que no. Por eso el orden aquí no es cosmético. Esa
// MISMA autorización (el <audio> remoto de esta sesión, conectado
// desde el toque inicial) es lo que permite reproducir la respuesta
// automáticamente más adelante sin volver a pedir permiso ni depender
// de un gesto nuevo por cada respuesta — a diferencia de
// speechSynthesis del navegador, que si exige gesto directo por
// llamada (la razón real por la que rondas anteriores necesitaron un
// botón de altavoz manual).
//
// Cada etapa emite un log con prefijo [VOZ][etapa] y, si falla, el error
// visible en el chat incluye la etapa + el mensaje real del navegador o
// de OpenAI — nunca un texto genérico que oculte la causa.

import { PERSONA_VOZ, MARCADOR_LECTURA_EXACTA } from '../personaVoz'
import { limpiarTextoParaVoz } from '../lecturaVoz'
import { analizarComplecionFrase, CONFIG_FIN_TURNO } from '../deteccionFinTurno'
import { supabase } from '@/lib/supabaseClient'
import { BUILD_ID } from '@/lib/buildInfo'
import type {
  AdjuntoImagen,
  ContextoAplicacion,
  DesuscribirFn,
  DiagnosticoArranqueVoz,
  EventoMotor,
  FinalizarArchivoInfo,
  Herramienta,
  MotorConversacional,
} from '../tipos'

const MODELO_DEFECTO = 'gpt-realtime'
const VOZ = 'marin'
// Respaldo final si la heurística de fin de turno (CASO A/B, ver
// deteccionFinTurno.ts) nunca da una señal clara — por ejemplo, el
// docente se queda callado a medio pensamiento. No es el mecanismo
// principal: solo evita que un turno quede escuchando para siempre.
const SILENCIO_MAXIMO_MS = 20000
// Sin esto, RTCPeerConnection solo reúne candidatos ICE "host" (la IP
// privada del docente en su red local) — en un entorno con IP pública
// directa (como este entorno de pruebas) eso basta y por eso las pruebas
// aquí siempre conectaron limpio, pero en CUALQUIER red real detrás de
// NAT (wifi doméstico, y sobre todo datos móviles/celular, que casi
// siempre usan NAT de operador) un candidato host nunca es alcanzable
// desde el servidor de OpenAI — el ICE nunca completa, el DataChannel
// nunca abre, y el timeout de 10s es la consecuencia visible, no la
// causa. Con un servidor STUN público, el navegador también reúne un
// candidato "server reflexive" (la IP/puerto público real detrás del
// NAT), que sí es alcanzable. Esta es la causa real del reporte en
// iPhone, no una casualidad de temporización.
const ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
]
// Techo de seguridad SOLO para el caso raro de que se pierda el evento
// de transcripción o de error (red, etc.) — el caso "no había audio
// nuevo" ya no pasa por aquí: el error 'buffer too small' lo resuelve
// de inmediato (ver manejarEventoServidor). Transcribir unos segundos de
// audio con Whisper normalmente toma bastante menos de esto.
const ESPERA_MAXIMA_COMMIT_MS = 1200

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EventoServidor = Record<string, any>

function describirError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  if (typeof err === 'string') return err
  try { return JSON.stringify(err) } catch { return String(err) }
}

// Cuenta los candidatos ICE por tipo (host / srflx / relay) dentro de un
// SDP — diagnóstico rápido en consola de si el lado local o remoto
// realmente reunió candidatos alcanzables desde fuera de su NAT, sin
// tener que imprimir el SDP completo.
function resumirCandidatos(sdp: string | undefined): string {
  if (!sdp) return 'sin SDP'
  const lineas = sdp.split('\r\n').filter(l => l.startsWith('a=candidate'))
  if (lineas.length === 0) return '0 candidatos'
  const porTipo: Record<string, number> = {}
  for (const linea of lineas) {
    const tipo = linea.match(/typ (\w+)/)?.[1] || 'desconocido'
    porTipo[tipo] = (porTipo[tipo] || 0) + 1
  }
  return `${lineas.length} total (${Object.entries(porTipo).map(([t, n]) => `${t}=${n}`).join(', ')})`
}

// Envuelve el error real con la etapa donde ocurrió — es lo que termina
// visible en el chat, así que el mensaje siempre trae la causa concreta.
class ErrorEtapaVoz extends Error {
  constructor(public etapa: string, causaOriginal: unknown) {
    super(`Voz [${etapa}]: ${describirError(causaOriginal)}`)
    this.name = 'ErrorEtapaVoz'
  }
}

// Señal de que el intento de conexión fue cancelado a propósito (el
// docente tocó el botón de nuevo mientras conectaba, o cambió de
// pantalla) — NUNCA es un error real, así que AsistenteService lo debe
// tratar distinto: silencio total, vuelta a idle, sin aviso ni mensaje.
export class ConexionCanceladaError extends Error {
  constructor() {
    super('Conexión de voz cancelada.')
    this.name = 'ConexionCanceladaError'
  }
}

export class MotorOpenAIRealtime implements MotorConversacional {
  readonly id = 'openai-realtime-voz'

  private listeners = new Set<(evento: EventoMotor) => void>()
  private contexto: ContextoAplicacion = { pantalla: 'inicio' }
  // Único puente hacia el pipeline de texto real — AsistenteService lo
  // asigna con establecerCanalDeTexto() al construir este motor (ver
  // activarModoVoz). Es literalmente this.enviarMensaje del panel de
  // texto: cuando un turno de voz termina de transcribirse, el texto
  // reconocido se manda AQUÍ, nunca se le pide una respuesta a OpenAI
  // Realtime (ver "Unificar el flujo de voz con el pipeline de texto" —
  // antes, este motor generaba su propia respuesta razonando
  // directamente sobre el audio, con sus propias instrucciones y sin
  // las Herramientas del Chat IA, por lo que consultas como "¿cuántos
  // alumnos vinieron hoy?" no tenían forma de responderse correctamente
  // por voz aunque sí funcionaran por texto).
  private enviarComoMensaje: ((texto: string) => Promise<void>) | null = null
  // Segundo puente, también asignado por establecerCanalDeTexto: si el
  // docente vuelve a hablar mientras la respuesta REAL del turno
  // anterior sigue en camino (motorTexto todavía esperando /api/chat),
  // esto la cancela — sin esto, ese segundo turno podía perderse en
  // silencio (enviarMensaje() ignora cualquier mensaje nuevo mientras
  // "generando" siga en true).
  private interrumpirTexto: (() => void) | null = null
  // true mientras dura una lectura en voz alta pedida por
  // reproducirRespuestaEnVoz() — distingue esa respuesta "de lectura"
  // de una respuesta conversacional real (que ya no existen en este
  // motor). Mientras es true, los eventos response.* NUNCA se emiten
  // hacia AsistenteService como 'respuesta-parcial'/'respuesta-final'
  // — solo producen audio, nunca un mensaje nuevo en el chat.
  private leyendoRespuestaClaude = false

  private pc: RTCPeerConnection | null = null
  private canal: RTCDataChannel | null = null
  private stream: MediaStream | null = null
  private audioEl: HTMLAudioElement | null = null
  // true solo después de que iniciar() completó con éxito una vez —
  // distingue un problema de la conexión inicial (nunca se muestra al
  // docente, se reintenta) de una desconexión real después de que la
  // llamada ya estaba funcionando (esa sí debe verse).
  private conexionEstablecida = false

  // Identifica el intento de conexión en curso. Se incrementa al empezar
  // iniciar() y también al cancelar/detener — cualquier callback o await
  // que resuelva tarde (de un intento ya superado) se descarta en cuanto
  // detecta que su ID ya no es el vigente, en vez de pisar el estado del
  // intento nuevo. Esto es lo que evita que el indicador se quede
  // girando: sin esto, un fetch o un timeout que tarda en resolverse
  // podía llegar después de que el docente ya canceló o reintentó, y
  // corromper el estado.
  private idIntentoActual = 0
  // Controlador de aborto del intento de conexión en curso — cancelarConexion()
  // lo usa para cortar de inmediato cualquier fetch en vuelo (token
  // efímero, POST del SDP) en vez de dejarlo colgado indefinidamente si
  // la red está en un estado donde ni siquiera falla explícitamente.
  private controladorAbort: AbortController | null = null

  private transcripcionRespuesta = ''
  private transcripcionUsuarioParcial = ''
  private respondiendoActivo = false
  // ID de la respuesta que estamos acumulando ahora mismo. Todo evento
  // con un response_id distinto es de una respuesta anterior ya
  // superada (cancelada por interrupción, o una que el servidor
  // reemplazó) — se descarta. Sin esto, fragmentos tardíos de una
  // respuesta vieja podían mezclarse con la nueva.
  private idRespuestaActual: string | null = null
  // Para el diagnóstico ?voiceDebug=1: marca si ya se registró el primer
  // delta de texto/audio de LA respuesta actual, para no loguear cada
  // fragmento — solo el primero (ver 'turno-primer-texto'/'turno-primer-audio').
  private primerDeltaDeEstaRespuesta = true
  private primerAudioDeEstaRespuesta = true

  // Con create_response:false (ver /api/realtime-token) el servidor NUNCA
  // dispara una respuesta por su cuenta — solo transcribe cada segmento
  // de habla que detecta el VAD. Esto junta esos segmentos entre pausas
  // en UN solo texto, para que "Hazme una fábula... con caballos... para
  // tercer grado" quede como un solo mensaje en vez de tres respuestas.
  private transcripcionUsuarioAcumulada = ''
  private resolverCommitFinal: (() => void) | null = null
  // Última vez que llegó un delta de transcripción parcial — no se loguea
  // cada uno (saturaría el panel de diagnóstico), solo se usa para medir
  // cuánto tardó la transcripción final desde el último fragmento parcial.
  private ultimoDeltaTranscripcionMs: number | null = null
  // Detección automática de fin de turno (ver
  // lib/asistente/deteccionFinTurno.ts y programarEvaluacionFinTurno) —
  // ventana adaptativa CASO A/B, reiniciada en cada segmento nuevo.
  private temporizadorFinTurno: ReturnType<typeof setTimeout> | null = null
  // Respaldo CASO D — techo largo de silencio total, independiente de
  // la ventana adaptativa de arriba (ver SILENCIO_MAXIMO_MS).
  private temporizadorSilencio: ReturnType<typeof setTimeout> | null = null

  // Verdadero solo cuando hay audio hablado que el servidor todavía NO
  // comiteó por su cuenta (entre 'speech_started' y el próximo
  // 'input_audio_transcription.completed/failed', que es la señal de que
  // YA hubo un commit — automático o manual — para ese fragmento).
  // finalizarTurno() solo manda 'input_audio_buffer.commit' cuando esto es
  // true: es la validación previa que evita el error "buffer too small"
  // en vez de solo reaccionar a él, y de paso evita la espera de red
  // completa en el caso normal (el VAD ya había comiteado momentos antes).
  private huboAudioSinConfirmar = false
  // Evita que la detección de fin de turno dispare finalizarTurno() dos
  // veces en paralelo (por ejemplo, si el techo de silencio y la
  // ventana adaptativa vencieran casi al mismo tiempo) — eso mandaría
  // dos turnos del mismo texto.
  private finalizandoTurno = false

  private registrar(etapa: string, detalle: unknown) {
    console.log(`[VOZ][${etapa}]`, detalle)
  }

  // Último paso (de cualquier resultado) registrado por debug() — "qué
  // fue lo último que pasó antes de la falla", sin tener que mantener a
  // mano una tabla de qué checkpoint corresponde a qué sub-etapa de
  // conectarWebRTC() (ver capturarErrorArranque).
  private ultimoCheckpoint: { paso: string; resultado: string; detalle?: string } | null = null

  // Un paso del diagnóstico ?voiceDebug=1 (ver AsistentePanel). Siempre
  // se emite — es barato (un evento más al mismo bus que ya existe) y
  // AsistenteService simplemente lo ignora si el panel de debug no está
  // activo. "detalle" nunca debe llevar el token/clave real, solo
  // estados, códigos HTTP o el mensaje de error real.
  private debug(paso: string, resultado: 'ok' | 'error' | 'info', detalle?: string) {
    this.registrar(`debug:${paso}`, detalle ?? resultado)
    this.ultimoCheckpoint = { paso, resultado, detalle }
    this.emitir({ tipo: 'debug-paso', paso, resultado, detalle, ms: Date.now() })
  }

  // Extrae "HTTP 500" / "cuerpo real" del texto de mensaje — todos los
  // Error de este archivo que vienen de una respuesta HTTP usan el
  // mismo formato `HTTP ${status}: ${cuerpo}` (ver intentarConexionConReintentos
  // y conectarWebRTC), así que no hace falta un tipo de error nuevo
  // para separar ambos campos.
  private extraerHttpDeMensaje(mensaje: string): { status: string | null; body: string | null } {
    const m = mensaje.replace(/\n/g, ' ').match(/^HTTP (\d+)[^:]*:?\s*(.*)$/)
    if (!m) return { status: null, body: null }
    return { status: m[1], body: m[2]?.slice(0, 300) || null }
  }

  // Panel técnico TEMPORAL visible en el propio iPhone sin ?voiceDebug=1
  // (ver "Capturar el error real de arranque de voz directamente desde
  // el iPhone") — se llama justo ANTES de cada throw new
  // ErrorEtapaVoz(...), mientras this.pc/this.canal todavía existen
  // (antes de que limpiarConexionParcial()/cancelarConexion() los
  // pongan en null), para que el estado real de WebRTC en el momento
  // exacto del fallo quede capturado.
  private capturarErrorArranque(etapa: string, err: unknown) {
    const e = err instanceof Error ? err : null
    const mensaje = e?.message || describirError(err)
    const { status, body } = this.extraerHttpDeMensaje(mensaje)
    const checkpointPrevio = this.ultimoCheckpoint
      ? `${this.ultimoCheckpoint.paso} (${this.ultimoCheckpoint.resultado}${this.ultimoCheckpoint.detalle ? `: ${this.ultimoCheckpoint.detalle.slice(0, 120)}` : ''})`
      : null

    const datos: DiagnosticoArranqueVoz = {
      buildId: BUILD_ID,
      etapa,
      ultimoCheckpoint: checkpointPrevio,
      errorName: e?.name || 'desconocido',
      errorMessage: mensaje,
      httpStatus: status,
      responseBody: body,
      connectionState: this.pc?.connectionState ?? 'sin-pc',
      iceConnectionState: this.pc?.iceConnectionState ?? 'sin-pc',
      dataChannelState: this.canal?.readyState ?? 'sin-canal',
    }
    this.emitir({ tipo: 'diagnostico-arranque-voz', datos })

    // Se conserva también en el bus de ?voiceDebug=1, ahora con el
    // mismo detalle completo — útil cuando SÍ hay Mac/consola a mano.
    this.debug('voice:start_error', 'error', [
      `etapa=${etapa}`,
      `name=${datos.errorName}`,
      `message=${datos.errorMessage}`,
      `httpStatus=${status ?? 'n/a'}`,
      `connectionState=${datos.connectionState}`,
      `iceConnectionState=${datos.iceConnectionState}`,
      `dataChannelState=${datos.dataChannelState}`,
    ].join(' · '))
    // El stack completo solo a consola — es largo y el panel visible
    // está pensado para leerse en la pantalla de un teléfono.
    if (e?.stack) this.registrar('voice:start_error-stack', e.stack)
  }

  // Lanza ConexionCanceladaError si, mientras se esperaba el último await,
  // este intento dejó de ser el vigente (cancelarConexion()/detener()
  // avanzaron idIntentoActual). Se llama después de CADA await de la
  // secuencia de conexión — es lo que evita que un fetch o un timeout que
  // resuelve tarde pise el estado de un intento nuevo o de una cancelación,
  // que es la causa real del indicador que se queda girando.
  private verificarIntentoVigente(idIntento: number) {
    if (idIntento !== this.idIntentoActual) throw new ConexionCanceladaError()
  }

  // AbortController con un techo de tiempo propio — cubre el caso real de
  // una red que ni conecta ni falla explícitamente (algunas redes
  // celulares restrictivas simplemente descartan paquetes en silencio),
  // donde un fetch sin límite se queda colgado para siempre y el
  // indicador nunca se apaga. cancelarConexion() también aborta este
  // mismo controlador para cortar de inmediato un fetch en vuelo.
  private crearControladorConTimeout(ms: number): AbortController {
    const controlador = new AbortController()
    const limite = setTimeout(() => controlador.abort(new Error(`Tiempo de espera agotado (${ms}ms)`)), ms)
    controlador.signal.addEventListener('abort', () => clearTimeout(limite), { once: true })
    this.controladorAbort = controlador
    return controlador
  }

  // Cancela el intento de conexión en curso (segundo toque del botón
  // mientras conectaba, o el panel se desmonta a mitad de la conexión):
  // invalida el intento vigente, corta cualquier fetch en vuelo, y limpia
  // absolutamente todo lo que se haya alcanzado a crear. No es un error —
  // AsistenteService lo trata como una vuelta silenciosa a idle.
  cancelarConexion() {
    this.idIntentoActual++
    this.controladorAbort?.abort()
    this.limpiarConexionParcial()
    this.stream?.getTracks().forEach(pista => pista.stop())
    this.stream = null
  }

  // Llamado por AsistenteService justo después de construir este motor,
  // antes de iniciar() — ver activarModoVoz(). No forma parte de
  // MotorConversacional (lib/asistente/tipos.ts): es específico de este
  // motor, igual que enviarAudio.
  establecerCanalDeTexto(fn: (texto: string) => Promise<void>) {
    this.enviarComoMensaje = fn
  }

  // Ver comentario junto a interrumpirTexto (campo privado).
  establecerInterruptorTexto(fn: () => void) {
    this.interrumpirTexto = fn
  }

  // herramientas: parte de la interfaz MotorConversacional compartida
  // con MotorTextoClaude — este motor ya no las usa para nada (ver
  // "Rediseñar el modo voz como conversación continua": Realtime nunca
  // ejecuta Herramientas, ni siquiera las conoce).
  async iniciar(contexto: ContextoAplicacion, _herramientas: Herramienta[]) {
    const idIntento = ++this.idIntentoActual
    this.contexto = contexto
    this.ultimoCheckpoint = null
    this.emitir({ tipo: 'estado', estado: 'conectando' })
    this.registrar('0-inicio', 'Activando modo voz')

    if (typeof window === 'undefined' || typeof RTCPeerConnection === 'undefined') {
      throw new ErrorEtapaVoz('3-webrtc-no-soportado', 'Este navegador no tiene RTCPeerConnection.')
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new ErrorEtapaVoz('1-permiso-microfono', 'navigator.mediaDevices.getUserMedia no existe en este navegador.')
    }

    // --- Etapas 1 y 2: permiso + captura de audio. SIEMPRE lo primero. ---
    this.debug('voice:permission_requested', 'info')
    try {
      // Constraints explícitas (no confiar en el default del navegador):
      // sin cancelación de eco, el micrófono capta la propia voz del
      // asistente saliendo por la bocina y el VAD la interpreta como el
      // docente interrumpiendo — cancela la respuesta a medias y dispara
      // una nueva, que es exactamente el patrón de "se corta y llega
      // otra respuesta" reportado.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      this.registrar('1-2-microfono', `Permiso concedido, ${this.stream.getAudioTracks().length} pista(s) de audio`)
      this.debug('voice:permission_granted', 'ok')
      const pista = this.stream.getAudioTracks()[0]
      this.debug('voice:media_stream_created', 'ok', `${this.stream.getAudioTracks().length} pista(s), readyState=${pista?.readyState}`)
    } catch (err) {
      // err aquí es típicamente un DOMException real de getUserMedia —
      // describirError ya extrae err.name (NotAllowedError, NotFoundError,
      // NotReadableError, AbortError, SecurityError...) y err.message tal
      // cual, nunca un texto genérico inventado.
      this.registrar('1-2-microfono-error', err)
      this.capturarErrorArranque('1-2-microfono', err)
      throw new ErrorEtapaVoz('1-2-microfono', err)
    }
    this.verificarIntentoVigente(idIntento)

    // --- Etapa 3 (autenticación docente) ---
    // Solo el access_token: este motor ya no necesita perfil ni sesión
    // de contexto (grupo/alumnos) — nunca redacta nada con esos datos,
    // eso lo hace Claude en /api/chat, que los vuelve a leer frescos en
    // cada turno (ver "Rediseñar el modo voz como conversación
    // continua"). Pedirlos aquí también era trabajo duplicado que
    // nunca se llegaba a usar.
    let accessToken: string
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error('Supabase no devolvió access_token para la sesión activa.')
      accessToken = session.access_token
      this.registrar('3-sesion-docente', `Sesión válida (${session.user?.email || 'sin email'})`)
    } catch (err) {
      this.registrar('3-sesion-docente-error', err)
      this.capturarErrorArranque('3-sesion-docente', err)
      throw new ErrorEtapaVoz('3-sesion-docente', err)
    }
    this.verificarIntentoVigente(idIntento)

    // --- Techo duro para TODA la secuencia de token + WebRTC + canal de
    // datos (con sus reintentos incluidos): si no se completó en ese
    // tiempo, se cancela todo y se vuelve a idle en vez de dejar el
    // indicador girando a la espera de un timeout interno más largo. El
    // caso de éxito real nunca se acerca a este techo (conexiones limpias
    // observadas en pruebas: 1.8-2.3s de punta a punta).
    //
    // CAUSA RAÍZ real de "No se pudo conectar la voz" en cuanto se
    // presiona el micrófono (ver "Auditar el arranque de la sesión de
    // voz"): este techo estaba en 12000ms, pero la SUMA de los propios
    // timeouts internos de una sola conexión ya alcanza hasta 29000ms
    // (token 8000 + espera de ICE gathering 3000 + POST del SDP 8000 +
    // apertura del canal de datos 10000) — el techo global mataba la
    // conexión ANTES de que sus propias etapas hubieran tenido chance de
    // completarse en cualquier red que no fuera excelente (datos
    // móviles, wifi de escuela), y de paso eliminaba en la práctica el
    // segundo intento de intentarConexionConReintentos(): un primer
    // intento lento ya consumía casi todo el presupuesto, sin dejar
    // tiempo real para el reintento con token nuevo. 20000ms deja margen
    // para un intento completo realista y todavía un segundo intento
    // parcial si el primero falla rápido, sin llegar a los 58000ms del
    // peor caso absoluto de dos intentos completos (que sí sería
    // demasiado tiempo esperando con el indicador de "conectando").
    const TECHO_CONEXION_MS = 20000
    const promesaConexion = this.intentarConexionConReintentos(idIntento, accessToken)
    let temporizadorTecho: ReturnType<typeof setTimeout> | null = null
    const resultado = await Promise.race([
      promesaConexion.then(() => 'listo' as const),
      new Promise<'techo'>(resolve => { temporizadorTecho = setTimeout(() => resolve('techo'), TECHO_CONEXION_MS) }),
    ])
    if (temporizadorTecho) clearTimeout(temporizadorTecho)

    if (resultado === 'techo') {
      this.debug('techo-conexion', 'error', `No se completó en ${TECHO_CONEXION_MS / 1000}s`)
      this.registrar('techo-conexion', `No se completó en ${TECHO_CONEXION_MS}ms — cancelando`)
      this.cancelarConexion()
      // promesaConexion sigue corriendo en segundo plano — al cancelar ya
      // subió idIntentoActual, así que en cuanto llegue a su próximo
      // verificarIntentoVigente() va a rechazar sola con
      // ConexionCanceladaError. Nadie más la espera desde aquí en
      // adelante; sin este catch, ese rechazo tardío aparecería como una
      // promesa no manejada en la consola.
      promesaConexion.catch(() => {})
      this.capturarErrorArranque('techo-12s', new Error(`No se completó en ${TECHO_CONEXION_MS / 1000}s`))
      throw new ErrorEtapaVoz('techo-12s', `La conexión de voz no se completó en ${TECHO_CONEXION_MS / 1000} segundos.`)
    }
  }

  // Secuencia real de conexión (token efímero + WebRTC + canal de datos),
  // con un reintento completo si la primera conexión no llega a abrir el
  // canal. Aislada en su propio método para poder correr contra el techo
  // de 12s de iniciar() con Promise.race sin duplicar esa lógica.
  private async intentarConexionConReintentos(idIntento: number, accessToken: string): Promise<void> {
    // Un client secret efímero se considera consumido en cuanto se manda
    // en la oferta SDP, aunque el canal nunca haya llegado a abrir — por
    // eso el reintento pide uno nuevo en vez de reusar el mismo
    // (reusarlo haría fallar el segundo intento con un 401/400).
    const MAX_INTENTOS_CONEXION = 2
    for (let intento = 1; intento <= MAX_INTENTOS_CONEXION; intento++) {
      this.verificarIntentoVigente(idIntento)
      let clientSecret: string
      let model: string
      try {
        this.debug('voice:token_request_started', 'info', `intento ${intento}`)
        const controlador = this.crearControladorConTimeout(8000)
        // instrucciones: PERSONA_VOZ tal cual, sin contexto dinámico —
        // este motor ya no razona ni compone nada (ver "Rediseñar el
        // modo voz como conversación continua"), así que las mismas
        // reglas de lectura literal sirven para toda la sesión.
        // Ningún parámetro "herramientas": /api/realtime-token ya no
        // acepta ninguno — garantía a nivel de arquitectura de que
        // Realtime nunca puede ejecutar una Herramienta.
        const tokenRes = await fetch('/api/realtime-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accessToken,
            instrucciones: PERSONA_VOZ,
            voz: VOZ,
          }),
          signal: controlador.signal,
        })
        this.registrar('5-token-efimero', `POST /api/realtime-token -> HTTP ${tokenRes.status} (intento ${intento})`)
        // Nunca se asume JSON válido — si el body no parsea (ej. una
        // página de error HTML de un 500/502 de la plataforma), data
        // queda {} y el mensaje de abajo usa 'sin detalle del servidor'
        // en vez de reventar aquí mismo.
        const data = await tokenRes.json().catch(() => ({}))
        this.debug('voice:token_response_status', tokenRes.ok ? 'ok' : 'error', `HTTP ${tokenRes.status} · body=${JSON.stringify(data).slice(0, 300)}`)
        if (!tokenRes.ok) throw new Error(`HTTP ${tokenRes.status}: ${data.error || 'sin detalle del servidor'}`)
        if (!data.value) throw new Error('La respuesta del servidor no incluyó un client secret.')
        clientSecret = data.value
        model = data.model || MODELO_DEFECTO
        this.debug('voice:ephemeral_token_received', 'ok', `HTTP ${tokenRes.status}, modelo=${model}`)
      } catch (err) {
        this.verificarIntentoVigente(idIntento)
        this.registrar('5-token-efimero-error', err)
        this.capturarErrorArranque('5-token-efimero', err)
        throw new ErrorEtapaVoz('5-token-efimero', err)
      }
      this.verificarIntentoVigente(idIntento)

      try {
        await this.conectarWebRTC(clientSecret, model)
        this.verificarIntentoVigente(idIntento)
        this.registrar('8-listo', 'Modo voz completamente conectado')
        this.debug('voice:session_ready', 'ok')
        this.conexionEstablecida = true
        this.emitir({ tipo: 'estado', estado: 'activo' })
        return
      } catch (err) {
        if (err instanceof ConexionCanceladaError) throw err
        this.verificarIntentoVigente(idIntento)
        // Captura el diagnóstico ANTES de limpiarConexionParcial(), que
        // pone this.pc en null — si se hiciera después, connectionState/
        // iceConnectionState/signalingState ya no se podrían leer.
        if (intento >= MAX_INTENTOS_CONEXION) this.capturarErrorArranque('6-7-conexion-webrtc', err)
        this.limpiarConexionParcial()
        if (intento >= MAX_INTENTOS_CONEXION) {
          this.registrar('6-7-error', err)
          throw new ErrorEtapaVoz('6-7-conexion-webrtc', err)
        }
        // Mientras quede un reintento disponible, esto NUNCA debe llegar
        // al docente como error — sigue viendo el estado "conectando".
        this.registrar('6-7-reintento', `Intento ${intento} falló, reintentando con un token nuevo: ${describirError(err)}`)
      }
    }
  }

  private limpiarConexionParcial() {
    this.canal?.close()
    this.pc?.close()
    this.audioEl?.remove()
    this.pc = null
    this.canal = null
    this.audioEl = null
  }

  // Una sola conexión WebRTC completa: PeerConnection, pista de audio
  // remota, canal de datos, oferta/respuesta SDP y espera a que el canal
  // abra. Aislado en su propio método para poder reintentarlo entero
  // (con una PeerConnection nueva) si el primer intento no llega a abrir
  // el canal.
  private async conectarWebRTC(clientSecret: string, model: string): Promise<void> {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    this.pc = pc
    this.debug('voice:peer_connection_created', 'ok')

    let rechazarCanalListo: ((err: Error) => void) | null = null
    // Diagnóstico completo del ciclo de vida de la conexión — solo va a
    // la consola (registrar = console.log), nunca al chat. Sirve para
    // reconstruir exactamente en qué estado se quedó una conexión que
    // falló, sin tener que mostrarle nada técnico al docente.
    pc.onsignalingstatechange = () => this.registrar('4-signaling', pc.signalingState)
    pc.onicegatheringstatechange = () => {
      this.registrar('4-ice-gathering', pc.iceGatheringState)
    }
    pc.oniceconnectionstatechange = () => {
      this.registrar('4-ice', pc.iceConnectionState)
      this.debug('voice:connection_state', pc.iceConnectionState === 'failed' ? 'error' : 'info', `ice=${pc.iceConnectionState}`)
    }
    pc.onconnectionstatechange = () => {
      this.registrar('4-conexion', pc.connectionState)
      this.debug('voice:connection_state', pc.connectionState === 'failed' ? 'error' : 'info', `connection=${pc.connectionState}`)
      // No esperar los 10s completos si la conexión ya falló de plano —
      // esto es lo que hace que el reintento sea rápido en vez de que el
      // docente se quede viendo "conectando" sin necesidad.
      if (pc.connectionState === 'failed') {
        rechazarCanalListo?.(new Error('La conexión WebRTC falló (connectionState=failed).'))
      }
    }

    const audioEl = document.createElement('audio')
    audioEl.autoplay = true
    audioEl.setAttribute('playsinline', 'true')
    audioEl.style.display = 'none'
    document.body.appendChild(audioEl)
    this.audioEl = audioEl
    pc.ontrack = (evento) => {
      const pista = evento.streams[0]?.getAudioTracks()[0]
      this.debug('5-audio-track-recibido', 'ok', `streamId=${evento.streams[0]?.id || 'sin-id'} trackState=${pista?.readyState || 'sin-track'}`)
      audioEl.srcObject = evento.streams[0]
      this.debug('6-play-invocado', 'info', 'llamando audioEl.play()')
      audioEl.play().then(
        () => this.debug('7-play-resultado', 'ok', 'play() resuelto correctamente'),
        err => this.debug('8-play-error', 'error', describirError(err))
      )
    }

    const pistasAudio = this.stream!.getAudioTracks()
    this.registrar('2-pista-local', pistasAudio.map(t => `readyState=${t.readyState} enabled=${t.enabled} muted=${t.muted}`))
    pistasAudio.forEach(pista => pc.addTrack(pista, this.stream!))
    this.debug('voice:local_track_added', pistasAudio.length > 0 ? 'ok' : 'error', `${pistasAudio.length} pista(s)`)

    const canal = pc.createDataChannel('oai-events')
    this.canal = canal
    this.debug('datachannel-creado', 'ok', `readyState=${canal.readyState}`)
    canal.onmessage = (evento) => {
      try {
        this.manejarEventoServidor(JSON.parse(evento.data))
      } catch {
        // evento no-JSON del data channel: se ignora
      }
    }
    canal.onerror = (evento) => {
      this.registrar('7-canal-error', evento)
      // Solo se muestra al docente si esto pasa DESPUÉS de haber quedado
      // conectados alguna vez — durante el intento inicial (con o sin
      // reintento en curso) nunca debe verse como error en el chat.
      if (this.conexionEstablecida) {
        // El detalle técnico ("[7-canal-datos]") ya quedó registrado
        // arriba (ver registrar) para el panel ?voiceDebug=1 — el
        // docente solo debe ver un mensaje simple, ver ARQUITECTURA
        // MAESTRA, principio de ERRORES.
        this.emitir({ tipo: 'error', mensaje: 'Se perdió la conexión de voz. Toca para reintentar.' })
      }
    }
    canal.onclose = () => this.registrar('7-canal-cerrado', 'Data channel cerrado')

    const canalListo = new Promise<void>((resolve, reject) => {
      rechazarCanalListo = reject
      const limite = setTimeout(() => {
        // Diagnóstico completo del estado en el momento exacto del
        // timeout — esto es lo que hay que mirar en consola para saber
        // si el problema fue ICE (nunca conectó) o el propio canal
        // (ICE sí conectó pero el DataChannel se quedó en 'connecting').
        const diagnostico = {
          dataChannelReadyState: canal.readyState,
          signalingState: pc.signalingState,
          iceConnectionState: pc.iceConnectionState,
          iceGatheringState: pc.iceGatheringState,
          connectionState: pc.connectionState,
        }
        this.registrar('7-canal-timeout-diagnostico', diagnostico)
        this.debug('voice:data_channel_open', 'error', `timeout 10s — ${JSON.stringify(diagnostico)}`)
        reject(new Error('Tiempo de espera agotado (10s) esperando que abriera el canal de datos.'))
      }, 10000)
      canal.addEventListener('open', () => {
        clearTimeout(limite)
        this.registrar('7-canal-abierto', `Data channel abierto (readyState=${canal.readyState})`)
        this.debug('voice:data_channel_open', 'ok', `readyState=${canal.readyState}`)
        resolve()
      }, { once: true })
    })

    const offer = await pc.createOffer()
    this.debug('voice:offer_created', 'ok')
    await pc.setLocalDescription(offer)
    this.debug('localdescription-configurada', 'ok', `signalingState=${pc.signalingState}`)

    // CLAVE del bug real: /v1/realtime/calls NO es trickle-ICE — se manda
    // UNA sola oferta y se recibe UNA sola respuesta, sin forma de
    // agregar candidatos después. offer.sdp es el snapshot de
    // createOffer(), tomado ANTES de que arranque la recolección de
    // candidatos (esa recolección solo empieza al llamar
    // setLocalDescription, y los candidatos se van agregando aparte a
    // pc.localDescription, nunca al objeto "offer" original). En redes
    // simples (localhost, el entorno de pruebas) sirve igual porque casi
    // no hace falta más que el candidato local. En una red real de
    // celular o wifi con NAT, mandar la oferta sin los candidatos
    // reflexivos/relay puede impedir que el canal de datos llegue a
    // abrir — es la causa real del timeout reportado, no una casualidad
    // de temporización. Por eso se espera aquí a que termine (o venza un
    // techo corto) el ICE gathering antes de mandar la oferta.
    await this.esperarIceGatheringCompleto(pc)
    const sdpParaEnviar = pc.localDescription?.sdp || offer.sdp
    this.registrar(
      '6-oferta-sdp',
      `Oferta local lista (${sdpParaEnviar?.length || 0} bytes), ICE gathering=${pc.iceGatheringState}, candidatos=${resumirCandidatos(sdpParaEnviar)}`
    )
    this.debug('voice:offer_sent', 'info', `candidatos=${resumirCandidatos(sdpParaEnviar)}`)

    const controladorSdp = this.crearControladorConTimeout(8000)
    let respuestaSdp: Response
    try {
      respuestaSdp = await fetch(`https://api.openai.com/v1/realtime/calls?model=${model}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${clientSecret}`,
          'Content-Type': 'application/sdp',
        },
        body: sdpParaEnviar,
        signal: controladorSdp.signal,
      })
    } catch (err) {
      this.debug('voice:answer_received', 'error', describirError(err))
      throw err
    }
    this.registrar('6-respuesta-sdp', `POST /v1/realtime/calls -> HTTP ${respuestaSdp.status}`)
    if (!respuestaSdp.ok) {
      const textoError = await respuestaSdp.text().catch(() => '')
      this.debug('voice:answer_received', 'error', `HTTP ${respuestaSdp.status} · body=${textoError.slice(0, 300) || 'sin cuerpo de respuesta'}`)
      throw new Error(`HTTP ${respuestaSdp.status} de OpenAI: ${textoError.slice(0, 300) || 'sin cuerpo de respuesta'}`)
    }
    this.debug('voice:answer_received', 'ok', `HTTP ${respuestaSdp.status}`)
    const answerSdp = await respuestaSdp.text()
    this.registrar('6-respuesta-sdp-contenido', `candidatos remotos=${resumirCandidatos(answerSdp)}`)
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })
    this.registrar('6-respuesta-remota', 'setRemoteDescription OK')
    this.debug('voice:remote_description_set', 'ok', `signalingState=${pc.signalingState}`)

    await canalListo
  }

  // Techo de espera para el ICE gathering antes de mandar la oferta (ver
  // conectarWebRTC). En la enorme mayoría de redes termina en unos
  // cientos de ms; si alguna red rara nunca llega a 'complete', no vale
  // la pena bloquear la conexión por eso — se sigue con los candidatos
  // que ya se hayan reunido para ese momento.
  private esperarIceGatheringCompleto(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === 'complete') return Promise.resolve()
    return new Promise<void>((resolve) => {
      const limite = setTimeout(() => {
        pc.removeEventListener('icegatheringstatechange', verificar)
        resolve()
      }, 3000)
      const verificar = () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(limite)
          pc.removeEventListener('icegatheringstatechange', verificar)
          resolve()
        }
      }
      pc.addEventListener('icegatheringstatechange', verificar)
    })
  }

  async detener() {
    this.registrar('detener', 'Cerrando modo voz')
    // Invalida cualquier intento de conexión que aún pudiera estar en
    // vuelo (ver verificarIntentoVigente) y corta cualquier fetch
    // pendiente — detener() puede llamarse mientras iniciar() todavía no
    // ha terminado (ver AsistenteService.activarModoVoz, red de
    // seguridad por si quedó un motor de voz vivo sin cerrar).
    this.idIntentoActual++
    this.controladorAbort?.abort()
    this.resolverCommitFinal = null
    this.huboAudioSinConfirmar = false
    this.finalizandoTurno = false
    this.cancelarTemporizadorFinTurno()
    if (this.temporizadorSilencio) { clearTimeout(this.temporizadorSilencio); this.temporizadorSilencio = null }
    this.leyendoRespuestaClaude = false
    this.conexionEstablecida = false
    this.canal?.close()
    this.pc?.getSenders().forEach(remitente => remitente.track?.stop())
    this.stream?.getTracks().forEach(pista => pista.stop())
    this.pc?.close()
    this.audioEl?.remove()
    this.pc = null
    this.canal = null
    this.stream = null
    this.audioEl = null
    this.transcripcionRespuesta = ''
    this.transcripcionUsuarioParcial = ''
    this.transcripcionUsuarioAcumulada = ''
    this.respondiendoActivo = false
    this.emitir({ tipo: 'estado', estado: 'inactivo' })
  }

  // Parte de la interfaz MotorConversacional — se conserva el contexto
  // local por si algo lo necesita más adelante, pero ya no se manda
  // ningún session.update: las instrucciones de este motor (PERSONA_VOZ,
  // leer texto tal cual) nunca dependen de qué pantalla esté viendo el
  // docente, así que no hay nada dinámico que refrescar (ver "Rediseñar
  // el modo voz como conversación continua").
  actualizarContexto(contexto: ContextoAplicacion) {
    this.contexto = contexto
  }

  // Texto completo reconocido HASTA AHORA en esta sesión de dictado:
  // todos los segmentos ya finalizados (transcripcionUsuarioAcumulada)
  // más lo que se está transcribiendo en este momento
  // (transcripcionUsuarioParcial). Se emite como 'transcripcion-parcial'
  // en cada cambio para que AsistentePanel muestre la vista previa
  // completa (ver "Corregir envío prematuro de mensajes durante el
  // dictado por voz") — nunca solo el último fragmento, que perdía de
  // vista todo lo dicho antes de la pausa más reciente.
  private textoReconocidoHastaAhora(): string {
    if (!this.transcripcionUsuarioParcial) return this.transcripcionUsuarioAcumulada
    return this.transcripcionUsuarioAcumulada
      ? `${this.transcripcionUsuarioAcumulada} ${this.transcripcionUsuarioParcial}`
      : this.transcripcionUsuarioParcial
  }

  // Corta de inmediato lo que se esté reproduciendo — respuesta de
  // lectura en curso (response.cancel nativo, ver reproducirRespuestaEnVoz)
  // y cualquier envío de texto todavía en vuelo. Se llama automáticamente
  // en cuanto el VAD detecta que el docente vuelve a hablar (ver
  // 'input_audio_buffer.speech_started') — el usuario SIEMPRE tiene
  // prioridad, nunca hay que esperar a que termine de hablar la IA.
  interrumpir() {
    if (this.respondiendoActivo) this.enviarEventoCliente({ type: 'response.cancel' })
    this.leyendoRespuestaClaude = false
  }

  private cancelarTemporizadorFinTurno() {
    if (this.temporizadorFinTurno) {
      clearTimeout(this.temporizadorFinTurno)
      this.temporizadorFinTurno = null
    }
  }

  private reiniciarTemporizadorSilencio() {
    if (this.temporizadorSilencio) clearTimeout(this.temporizadorSilencio)
    // Respaldo (CASO D) — si el docente dijo algo y luego se queda
    // callado este tiempo sin que la heurística adaptativa (CASO A/B)
    // haya dado una señal clara, el turno se cierra solo para no dejar
    // la conversación colgada escuchando para siempre.
    this.temporizadorSilencio = setTimeout(() => {
      if (this.transcripcionUsuarioAcumulada.trim() && !this.respondiendoActivo) {
        this.registrar('silencio-prolongado', 'Cerrando turno automáticamente como respaldo')
        this.finalizarTurno()
      }
    }, SILENCIO_MAXIMO_MS)
  }

  // Detección automática de fin de turno — ver
  // lib/asistente/deteccionFinTurno.ts. Se llama cada vez que un
  // fragmento de transcripción se confirma, con la transcripción
  // ACUMULADA completa hasta ese momento (no solo el fragmento nuevo)
  // — así una idea de varias partes con pausas para pensar ("Necesito
  // una planeación de quince días... para tercer grado... del campo
  // formativo Lenguajes") se evalúa completa cada vez, no fragmento
  // por fragmento. Es el ÚNICO disparador real de un turno: no existe
  // botón para forzar el cierre — la conversación se siente continua
  // porque nunca hace falta tocar nada entre un turno y el siguiente
  // (ver "Rediseñar el modo voz como conversación continua").
  private programarEvaluacionFinTurno() {
    this.cancelarTemporizadorFinTurno()

    const texto = this.transcripcionUsuarioAcumulada.trim()
    if (!texto) return

    const estado = analizarComplecionFrase(texto)
    this.debug('turno-analisis-complecion', 'info', estado)

    if (estado === 'espera_explicita') {
      // El docente literalmente pidió una pausa ("espera", "a ver...")
      // — no se programa cierre automático. Solo el techo de silencio
      // prolongado (CASO D) cierra el turno desde aquí si nunca vuelve.
      return
    }

    const espera = estado === 'completa'
      ? CONFIG_FIN_TURNO.silencioFraseCompletaMs
      : CONFIG_FIN_TURNO.silencioFraseIncompletaMs
    this.temporizadorFinTurno = setTimeout(() => {
      this.registrar('fin-turno-adaptativo', `estado=${estado}, espera=${espera}ms`)
      this.finalizarTurno()
    }, espera)
  }

  // Cierra el turno actual: confirma cualquier audio que el VAD todavía
  // no hubiera comiteado por su cuenta y manda el texto reconocido al
  // MISMO pipeline que un mensaje escrito — nunca le pide una respuesta
  // a OpenAI Realtime (ver enviarComoMensaje = AsistenteService.
  // enviarMensaje, inyectado por activarModoVoz): mismo Clasificador de
  // Nivel 0, mismas Herramientas, mismo historial, mismo prompt, misma
  // respuesta que el chat escrito. Se llama automáticamente desde
  // programarEvaluacionFinTurno()/reiniciarTemporizadorSilencio() — no
  // hace falta ningún toque del docente para cerrar un turno.
  async finalizarTurno() {
    // Ya hay un finalizarTurno() en vuelo — ignorar esta llamada extra
    // en vez de duplicar el turno (puede pasar si el techo de silencio
    // y la ventana adaptativa vencieran casi al mismo tiempo).
    if (this.finalizandoTurno) return
    this.finalizandoTurno = true
    this.cancelarTemporizadorFinTurno()
    if (this.temporizadorSilencio) { clearTimeout(this.temporizadorSilencio); this.temporizadorSilencio = null }
    try {
      this.debug('turno-fin-detectado', 'ok')

      // Solo comitear (y esperar su transcripción) si de verdad hay
      // audio nuevo sin confirmar. El caso normal es que el VAD ya haya
      // comiteado el fragmento momentos antes de esto — ahí no hay nada
      // que mandar ni que esperar.
      let promesaTranscripcion: Promise<void> = Promise.resolve()
      if (this.huboAudioSinConfirmar) {
        this.enviarEventoCliente({ type: 'input_audio_buffer.commit' })
        this.debug('turno-fin-captura', 'ok', 'commit enviado, esperando transcripción')
        promesaTranscripcion = new Promise<void>((resolve) => {
          this.resolverCommitFinal = resolve
          setTimeout(resolve, ESPERA_MAXIMA_COMMIT_MS)
        })
      } else {
        this.debug('turno-fin-captura', 'ok', 'sin audio nuevo que comitear')
      }

      await promesaTranscripcion
      this.resolverCommitFinal = null

      const textoFinal = this.transcripcionUsuarioAcumulada.trim()
      this.transcripcionUsuarioAcumulada = ''
      if (!textoFinal) {
        // Caso raro: el VAD marcó actividad pero no hubo texto
        // transcribible (ruido, falsa alarma) — no hay nada que enviar.
        this.debug('turno-transcripcion-final', 'error', 'vacío — nada que enviar')
        return
      }
      this.debug('turno-transcripcion-final', 'ok', textoFinal.slice(0, 60))

      if (!this.enviarComoMensaje) {
        console.error('[VOZ] No hay canal de texto configurado (establecerCanalDeTexto) — no se pudo enviar el turno reconocido.')
        this.emitir({ tipo: 'error', mensaje: 'No se pudo procesar lo que dijiste. Intenta de nuevo.' })
        return
      }
      // Único punto real de entrega: mismo enviarMensaje() que usa el
      // botón Enviar — agrega la burbuja del docente, pasa por el
      // Clasificador de Nivel 0, las Herramientas y /api/chat, y deja
      // la respuesta real en el historial exactamente igual que un
      // mensaje escrito. Cuando la respuesta llegue, AsistenteService
      // (case 'respuesta-final') llama a reproducirRespuestaEnVoz() —
      // este método no necesita saber nada de eso.
      await this.enviarComoMensaje(textoFinal)
      this.debug('turno-mensaje-enviado-a-texto', 'ok')
    } finally {
      this.finalizandoTurno = false
    }
  }

  // Le pide a ESTA MISMA sesión de Realtime (ya conectada y autorizada
  // desde el toque inicial) que lea en voz alta el texto EXACTO que
  // redactó Claude — ver personaVoz.ts: la sesión está instruida para
  // solo leer literal, nunca razonar ni responder por su cuenta.
  // Reutiliza el canal de audio WebRTC ya autorizado por el gesto de
  // usuario que abrió la sesión, así que nunca choca con la política de
  // autoplay de Safari/iOS — a diferencia de speechSynthesis del
  // navegador, que exige un gesto nuevo por cada llamada (ver
  // "Rediseñar el modo voz como conversación continua").
  reproducirRespuestaEnVoz(texto: string) {
    const textoLimpio = limpiarTextoParaVoz(texto)
    if (!textoLimpio) return
    // Nunca se solapan dos lecturas — corta cualquiera en curso primero
    // (no debería haber ninguna normalmente, ya que enviarComoMensaje
    // se espera antes de llegar aquí, pero es defensivo).
    if (this.respondiendoActivo) this.enviarEventoCliente({ type: 'response.cancel' })
    this.leyendoRespuestaClaude = true
    this.emitir({ tipo: 'estado-escucha', estado: 'hablando' })
    this.debug('lectura-solicitada', 'info', `${textoLimpio.length} caracteres`)
    this.enviarEventoCliente({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `${MARCADOR_LECTURA_EXACTA}\n${textoLimpio}` }],
      },
    })
    // output_modalities — NO "modalities" (ese nombre es de la API beta
    // vieja / de RealtimeSession, no de RealtimeResponseCreateParams en
    // esta versión GA del SDK, la misma que ya usa la forma anidada
    // audio.output/audio.input en /api/realtime-token). Enviar
    // "modalities" aquí hace que el servidor rechace response.create
    // con un evento 'error' — la causa raíz real de "Ocurrió un
    // problema con la voz": el reconocimiento y el Chat IA nunca
    // pasaban por este método, solo la reproducción.
    this.enviarEventoCliente({ type: 'response.create', response: { output_modalities: ['audio'] } })
  }

  suscribir(callback: (evento: EventoMotor) => void): DesuscribirFn {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }

  private emitir(evento: EventoMotor) {
    this.listeners.forEach(l => l(evento))
  }

  private enviarEventoCliente(evento: Record<string, unknown>) {
    if (this.canal?.readyState === 'open') this.canal.send(JSON.stringify(evento))
  }

  // Parte de la interfaz MotorConversacional (todo motor debe
  // implementarlo), pero nunca debería ejecutarse en la práctica:
  // AsistenteService.motorDeContenido() manda SIEMPRE por motorTexto
  // (nunca por este motor) mientras modoVoz esté activo, para que
  // escribir con el teclado durante una llamada de voz también pase
  // por Claude/Herramientas. Deliberadamente no hace nada: esta sesión
  // solo sabe leer texto ya marcado con [LEER_EXACTO] (ver
  // reproducirRespuestaEnVoz/personaVoz.ts) — mandarle texto libre sin
  // esa marca no tiene un resultado bien definido y podría hacer que
  // "razone" algo por su cuenta, justo lo que esta arquitectura
  // prohíbe (ver "Rediseñar el modo voz como conversación continua").
  async enviarTexto(_texto: string, _adjunto?: AdjuntoImagen, _finalizarArchivo?: FinalizarArchivoInfo, _esEdicionDocumento?: boolean, _adjuntos?: AdjuntoImagen[]) {
    console.error('[VOZ] enviarTexto() llamado sobre MotorOpenAIRealtime — no debería pasar nunca (ver motorDeContenido en AsistenteService.ts).')
  }

  // Un evento con response_id trae la respuesta a la que pertenece. Si ya
  // estamos siguiendo una respuesta distinta, es un fragmento tardío de
  // una respuesta anterior (cancelada por interrupción, o superada) —
  // se descarta en vez de mezclarse con la respuesta actual.
  private esEventoDeRespuestaSuperada(responseId: unknown): boolean {
    return typeof responseId === 'string' && this.idRespuestaActual !== null && responseId !== this.idRespuestaActual
  }

  private manejarEventoServidor(evento: EventoServidor) {
    switch (evento.type) {
      case 'input_audio_buffer.speech_started':
        // Barge-in real: el docente SIEMPRE tiene prioridad. Si había
        // una lectura en curso (respondiendoActivo), se corta de
        // inmediato con el cancel nativo de Realtime — no hace falta
        // esperar a que termine ni depender de un evento del
        // reproductor de audio del navegador (ver "Rediseñar el modo
        // voz como conversación continua").
        if (this.respondiendoActivo) this.enviarEventoCliente({ type: 'response.cancel' })
        this.leyendoRespuestaClaude = false
        // Si el turno anterior todavía sigue esperando la respuesta
        // real (motorTexto/api/chat en vuelo), cancelarlo — así el
        // turno nuevo nunca se pierde en silencio (ver
        // interrumpirTexto).
        this.interrumpirTexto?.()
        // El docente volvió a hablar antes de que se cerrara el turno
        // — cancela cualquier cierre automático que estuviera contando
        // (CASO A/B en pausa) y vuelve a "escuchando". Se reevalúa
        // desde cero en cuanto este nuevo fragmento termine de
        // transcribirse.
        this.cancelarTemporizadorFinTurno()
        this.huboAudioSinConfirmar = true
        this.debug('turno-ultimo-fragmento-audio', 'info')
        this.emitir({ tipo: 'estado-escucha', estado: 'escuchando' })
        break

      case 'response.created':
        this.idRespuestaActual = evento.response?.id || null
        this.respondiendoActivo = true
        this.transcripcionRespuesta = ''
        this.primerDeltaDeEstaRespuesta = true
        this.primerAudioDeEstaRespuesta = true
        this.registrar('respuesta-iniciada', this.idRespuestaActual)
        this.debug('turno-primer-evento-respuesta', 'ok')
        break

      case 'conversation.item.input_audio_transcription.delta':
        this.transcripcionUsuarioParcial += evento.delta || ''
        this.ultimoDeltaTranscripcionMs = Date.now()
        this.emitir({ tipo: 'transcripcion-parcial', texto: this.textoReconocidoHastaAhora() })
        break

      case 'conversation.item.input_audio_transcription.completed': {
        // Con create_response:false, cada pausa natural genera SU PROPIO
        // evento de transcripción — se van juntando aquí en un solo
        // texto acumulado (transcripcionUsuarioAcumulada), sin importar
        // cuántas pausas haya. Cada segmento nuevo reevalúa si el turno
        // ya terminó (ver programarEvaluacionFinTurno) — nunca se
        // cierra directamente desde aquí.
        this.transcripcionUsuarioParcial = ''
        // Este evento solo llega DESPUÉS de un commit ya resuelto (auto o
        // manual) — el fragmento que acaba de transcribirse ya quedó
        // confirmado del lado del servidor, así que ya no hay nada
        // pendiente de comitear para él.
        this.huboAudioSinConfirmar = false
        const texto = evento.transcript ? String(evento.transcript).trim() : ''
        const msDesdeUltimoParcial = this.ultimoDeltaTranscripcionMs ? Date.now() - this.ultimoDeltaTranscripcionMs : null
        this.debug(
          'turno-transcripcion-segmento',
          texto ? 'ok' : 'info',
          `"${texto.slice(0, 60)}"${msDesdeUltimoParcial !== null ? ` · ${msDesdeUltimoParcial}ms desde el último parcial` : ''}`
        )
        if (texto) {
          this.transcripcionUsuarioAcumulada = this.transcripcionUsuarioAcumulada
            ? `${this.transcripcionUsuarioAcumulada} ${texto}`
            : texto
          // Vista previa: refleja el segmento recién confirmado de
          // inmediato, sin esperar al próximo delta (que puede tardar
          // si el docente hace una pausa larga antes de seguir).
          this.emitir({ tipo: 'transcripcion-parcial', texto: this.textoReconocidoHastaAhora() })
          this.reiniciarTemporizadorSilencio()
          this.programarEvaluacionFinTurno()
        }
        if (this.resolverCommitFinal) {
          const resolver = this.resolverCommitFinal
          this.resolverCommitFinal = null
          resolver()
        }
        break
      }

      case 'conversation.item.input_audio_transcription.failed':
        this.transcripcionUsuarioParcial = ''
        this.huboAudioSinConfirmar = false
        if (this.resolverCommitFinal) {
          const resolver = this.resolverCommitFinal
          this.resolverCommitFinal = null
          resolver()
        }
        break

      // response.output_audio_transcript.* es la transcripción de LO QUE
      // ESTÁ LEYENDO Realtime — solo se usa para el diagnóstico (¿leyó
      // lo que se le pidió, palabra por palabra?), NUNCA se reenvía
      // como 'respuesta-parcial'/'respuesta-final': ese texto ya lo
      // tiene AsistenteService desde Claude, y volver a emitirlo aquí
      // duplicaría o corrompería el mensaje real en el chat (ver
      // "Rediseñar el modo voz como conversación continua" —
      // leyendoRespuestaClaude es la señal de que esta respuesta es de
      // lectura, no conversacional).
      case 'response.output_audio_transcript.delta':
        if (this.esEventoDeRespuestaSuperada(evento.response_id)) break
        if (!this.idRespuestaActual && evento.response_id) this.idRespuestaActual = evento.response_id
        if (this.primerDeltaDeEstaRespuesta) {
          this.primerDeltaDeEstaRespuesta = false
          this.debug('turno-primer-texto', 'ok')
        }
        this.transcripcionRespuesta += evento.delta || ''
        break

      // Audio crudo (no la transcripción de texto) — la señal real de que
      // ya hay bytes de audio de ESTA respuesta viajando por WebRTC. El
      // elemento <audio> reproduce un stream continuo que normalmente no
      // se pausa entre turnos, así que su evento 'playing' del navegador
      // no es confiable turno a turno; este evento del servidor sí lo es.
      case 'response.output_audio.delta':
        if (this.esEventoDeRespuestaSuperada(evento.response_id)) break
        if (this.primerAudioDeEstaRespuesta) {
          this.primerAudioDeEstaRespuesta = false
          this.debug('turno-primer-audio', 'ok')
        }
        break

      case 'response.output_audio_transcript.done':
        // OJO: este evento se dispara también si la respuesta fue
        // interrumpida o cancelada (lo documenta la propia API) — aquí
        // solo se guarda el texto. Decidir si es una respuesta válida le
        // toca únicamente a response.done, que trae el status real.
        if (this.esEventoDeRespuestaSuperada(evento.response_id)) break
        if (evento.transcript) this.transcripcionRespuesta = evento.transcript
        break

      case 'response.done': {
        const idDeEstaRespuesta = evento.response?.id
        if (this.esEventoDeRespuestaSuperada(idDeEstaRespuesta)) break
        this.respondiendoActivo = false
        const status = evento.response?.status
        if (status && status !== 'completed') {
          // cancelled / failed / incomplete (interrupción real — el
          // docente volvió a hablar — o falsa alarma del VAD): se deja
          // constancia, pero nunca es un error para el docente.
          this.registrar('respuesta-no-completada', `status=${status}`)
        }
        this.debug('turno-respuesta-finalizada', status === 'completed' || !status ? 'ok' : 'info', status)
        // Diagnóstico temporal: compara lo que se le pidió leer contra
        // lo que Realtime realmente dijo (ver reproducirRespuestaEnVoz)
        // — si algún día difieren, esto lo hace visible de inmediato en
        // vez de tener que adivinar por qué "sonó distinto".
        if (this.leyendoRespuestaClaude) {
          this.debug('lectura-transcripcion-real', 'info', this.transcripcionRespuesta.slice(0, 200))
        }
        // NUNCA se emite 'respuesta-final' aquí — ver el comentario
        // junto a response.output_audio_transcript.delta. Esta
        // respuesta era de lectura (o, si function-calling alguna vez
        // reviviera por error, tampoco tiene destino válido: este motor
        // no tiene Herramientas registradas).
        this.leyendoRespuestaClaude = false
        this.transcripcionRespuesta = ''
        this.idRespuestaActual = null
        this.emitir({ tipo: 'estado-escucha', estado: 'escuchando' })
        break
      }

      case 'error': {
        this.registrar('8-error-servidor', evento)
        const detalle = String(evento.error?.message || evento.error?.code || describirError(evento))
        // Antes este detalle solo llegaba a console.log (registrar) —
        // invisible en un iPhone real sin Mac conectado por cable. debug()
        // sí llega al panel ?voiceDebug=1 en el propio dispositivo.
        this.debug('8-error-servidor-detalle', 'error', `type=${evento.error?.type || 'sin-tipo'} code=${evento.error?.code || 'sin-code'} · ${detalle}`)

        // "buffer too small" / "Expected at least Xms of audio": con la
        // validación de huboAudioSinConfirmar en finalizarTurno() esto ya
        // no debería pasar en el caso normal (ya no se manda commit sin
        // audio nuevo) — se deja como red de seguridad para el caso raro
        // de una condición de carrera entre eventos. Nunca es un error
        // real para el docente y nunca debe verse en el chat.
        if (/buffer too small|expected at least/i.test(detalle)) {
          this.registrar('commit-sin-audio-nuevo', detalle)
          if (this.resolverCommitFinal) {
            const resolver = this.resolverCommitFinal
            this.resolverCommitFinal = null
            resolver()
          }
          break
        }

        // El detalle técnico real ya quedó registrado arriba (8-error-
        // servidor-detalle, visible en ?voiceDebug=1) — el docente solo
        // debe ver un mensaje simple, ver ARQUITECTURA MAESTRA, principio
        // de ERRORES.
        this.emitir({ tipo: 'error', mensaje: 'Ocurrió un problema con la voz. Toca para reintentar.' })
        break
      }

      default:
        break
    }
  }
}
