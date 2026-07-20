// lib/asistente/motores/motorOpenAIRealtime.ts
//
// Segundo MotorConversacional: conversación de voz en tiempo real, con
// interrupción real (barge-in), usando OpenAI Realtime API sobre WebRTC.
// Implementa exactamente la misma interfaz que MotorTextoClaude — nada
// fuera de este archivo sabe que existe WebRTC, SDP o un data channel.
// Si este motor falla al iniciar (sin micrófono, sin red, proveedor
// caído), AsistenteService recupera el control y sigue con
// MotorTextoClaude sin que ninguna pantalla se entere.
//
// El barge-in (el docente interrumpe mientras el asistente habla) no se
// maneja "a mano": turn_detection en modo server_vad con
// interrupt_response=true hace que el propio servidor de OpenAI cancele
// la respuesta en curso en cuanto detecta que el usuario vuelve a hablar.
//
// IMPORTANTE (iOS Safari): getUserMedia debe pedirse INMEDIATAMENTE al
// entrar a este método, antes de cualquier otro await (perfil, token).
// Safari en iPhone ata el permiso de micrófono a la "user activation" del
// tap que disparó la llamada; si se intercalan varias llamadas de red
// antes de pedir el micrófono, esa ventana puede expirar y getUserMedia
// falla (a veces sin diálogo de permiso siquiera), aunque el usuario
// nunca haya dicho que no. Por eso el orden aquí no es cosmético.
//
// Cada etapa emite un log con prefijo [VOZ][etapa] y, si falla, el error
// visible en el chat incluye la etapa + el mensaje real del navegador o
// de OpenAI — nunca un texto genérico que oculte la causa.

import { construirInstrucciones, obtenerPerfilYSesion } from '../perfilDocente'
import { PERSONA_VOZ } from '../personaVoz'
import { MARCO_CURRICULAR_VIGENTE } from '../marcoCurricular'
import { analizarComplecionFrase, CONFIG_FIN_TURNO } from '../deteccionFinTurno'
import { obtenerFechaHora, obtenerZonaHorariaDispositivo } from '@/lib/tiempo/TimeService'
import { supabase } from '@/lib/supabaseClient'
import { obtenerSesionContexto, type SesionContexto } from '@/lib/sesionContexto'
import type {
  AdjuntoImagen,
  ContextoAplicacion,
  DesuscribirFn,
  EventoMotor,
  Herramienta,
  MotorConversacional,
} from '../tipos'

const MODELO_DEFECTO = 'gpt-realtime'
const VOZ = 'marin'
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
// Respaldo final (CASO D, ver deteccionFinTurno.ts) — NO el mecanismo
// principal. Los mecanismos principales son, en orden: el botón manual
// (ver alternarTurno) y la detección adaptativa de fin de turno (ver
// programarEvaluacionFinTurno). Este techo largo solo actúa si ninguno
// de los dos cerró el turno — para no dejar la conversación colgada
// indefinidamente en el caso raro de que la transcripción nunca dé una
// señal clara ni el docente vuelva a tocar el botón.
const SILENCIO_MAXIMO_MS = 20000
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
  private herramientas: Herramienta[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private perfil: any = null
  // Grupo activo + lista de alumnos reales — se obtiene una vez al
  // conectar (ver iniciar()) y se reutiliza en cada
  // construirInstruccionesCompletas() para que el modo voz también sepa
  // "sí tengo acceso a tu lista" en vez de responder como chatbot
  // genérico (mismo dato que ya se le da al modo texto en /api/chat).
  private sesion: SesionContexto | null = null

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
  private temporizadorSilencio: ReturnType<typeof setTimeout> | null = null
  // Ventana adaptativa de cierre de turno (CASO A/B/C, ver
  // deteccionFinTurno.ts) — independiente del techo largo de arriba.
  private temporizadorFinTurno: ReturnType<typeof setTimeout> | null = null
  // Última vez que llegó un delta de transcripción parcial — no se loguea
  // cada uno (saturaría el panel de diagnóstico), solo se usa para medir
  // cuánto tardó la transcripción final desde el último fragmento parcial.
  private ultimoDeltaTranscripcionMs: number | null = null

  // Verdadero solo cuando hay audio hablado que el servidor todavía NO
  // comiteó por su cuenta (entre 'speech_started' y el próximo
  // 'input_audio_transcription.completed/failed', que es la señal de que
  // YA hubo un commit — automático o manual — para ese fragmento).
  // finalizarTurno() solo manda 'input_audio_buffer.commit' cuando esto es
  // true: es la validación previa que evita el error "buffer too small"
  // en vez de solo reaccionar a él, y de paso evita la espera de red
  // completa en el caso normal (el VAD ya había comiteado momentos antes).
  private huboAudioSinConfirmar = false
  // Evita que un segundo toque del botón mientras finalizarTurno() sigue
  // en vuelo (esperando su commit o su transcripción) dispare una segunda
  // llamada en paralelo — eso mandaría dos response.create para el mismo
  // turno y se verían dos respuestas.
  private finalizandoTurno = false

  private registrar(etapa: string, detalle: unknown) {
    console.log(`[VOZ][${etapa}]`, detalle)
  }

  // Un paso del diagnóstico ?voiceDebug=1 (ver AsistentePanel). Siempre
  // se emite — es barato (un evento más al mismo bus que ya existe) y
  // AsistenteService simplemente lo ignora si el panel de debug no está
  // activo. "detalle" nunca debe llevar el token/clave real, solo
  // estados, códigos HTTP o el mensaje de error real.
  private debug(paso: string, resultado: 'ok' | 'error' | 'info', detalle?: string) {
    this.registrar(`debug:${paso}`, detalle ?? resultado)
    this.emitir({ tipo: 'debug-paso', paso, resultado, detalle, ms: Date.now() })
  }

  // Fecha/hora se recalculan CADA VEZ que se llama esto (no una sola vez
  // al conectar) — ver dónde se usa: al conectar, en cada cambio de
  // pantalla (actualizarContexto) y de nuevo en cada finalizarTurno(),
  // así la hora que el modelo tiene nunca queda vieja en una llamada de
  // voz larga. Siempre la zona horaria REAL del dispositivo (nunca una
  // fija) — ver lib/tiempo/TimeService.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private construirInstruccionesCompletas(perfil: any, contexto: ContextoAplicacion): string {
    const info = obtenerFechaHora(obtenerZonaHorariaDispositivo())
    const fechaHoraTexto = `FECHA Y HORA ACTUALES (zona horaria real del dispositivo del maestro: ${info.zonaHoraria}, nunca UTC ni otra zona): hoy es ${info.diaSemana} ${info.fechaLegible}, son las ${info.horaLegible}. Ciclo escolar actual: ${info.cicloEscolar}. Si el maestro pregunta la hora o la fecha, responde exactamente con estos datos.`

    // Mismo dato real que /api/chat le da al modo texto — sin esto, el
    // modo voz no tenía forma de saber si ya había una lista de alumnos
    // y terminaba respondiendo como chatbot genérico ("no tengo acceso
    // directo a tu lista") en vez de confirmar el dato real.
    const resumenGrupoTexto = this.sesion
      ? this.sesion.grupo_activo_id
        ? `Grupo activo: sí hay un grupo configurado. Alumnos inscritos activos: ${this.sesion.alumnos_del_grupo_activo.length}.${
            this.sesion.alumnos_del_grupo_activo.length > 0
              ? ` Lista de alumnos: ${this.sesion.alumnos_del_grupo_activo.map((a) => a.nombre_completo).join(', ')}.`
              : ''
          }`
        : 'Grupo activo: el maestro todavía no tiene un grupo configurado como activo.'
      : ''
    const concienciaDatos = 'Eres el cerebro central de Docente IA — tienes acceso directo a los datos reales de arriba sin que el maestro te los dé. Nunca respondas con frases genéricas de chatbot como "no tengo acceso directo...", "puedes decirme los nombres...", "podemos organizar una lista desde cero..." — son falsas aquí. Si el maestro pregunta si ya tienes acceso a su lista o su grupo, confírmalo con el dato real de arriba.'

    return `${PERSONA_VOZ}\n\n${MARCO_CURRICULAR_VIGENTE}\n\n${fechaHoraTexto}\n\n${resumenGrupoTexto}\n\n${concienciaDatos}\n\n${construirInstrucciones(perfil, contexto)}`
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

  async iniciar(contexto: ContextoAplicacion, herramientas: Herramienta[]) {
    const idIntento = ++this.idIntentoActual
    this.contexto = contexto
    this.herramientas = herramientas
    this.emitir({ tipo: 'estado', estado: 'conectando' })
    this.registrar('0-inicio', 'Activando modo voz')

    if (typeof window === 'undefined' || typeof RTCPeerConnection === 'undefined') {
      throw new ErrorEtapaVoz('3-webrtc-no-soportado', 'Este navegador no tiene RTCPeerConnection.')
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new ErrorEtapaVoz('1-permiso-microfono', 'navigator.mediaDevices.getUserMedia no existe en este navegador.')
    }

    // --- Etapas 1 y 2: permiso + captura de audio. SIEMPRE lo primero. ---
    this.debug('permiso-microfono-solicitado', 'info')
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
      this.debug('permiso-microfono-concedido', 'ok')
      const pista = this.stream.getAudioTracks()[0]
      this.debug('mediastream-obtenido', 'ok', `${this.stream.getAudioTracks().length} pista(s)`)
      this.debug('track-audio-activo', pista?.readyState === 'live' ? 'ok' : 'error', `readyState=${pista?.readyState}`)
    } catch (err) {
      this.registrar('1-2-microfono-error', err)
      this.debug('permiso-microfono-concedido', 'error', describirError(err))
      throw new ErrorEtapaVoz('1-2-microfono', err)
    }
    this.verificarIntentoVigente(idIntento)

    // --- Etapa 3 (autenticación docente) ---
    let accessToken: string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let perfil: any
    try {
      const resultado = await obtenerPerfilYSesion()
      perfil = resultado.perfil
      this.perfil = perfil
      if (!resultado.session?.access_token) throw new Error('Supabase no devolvió access_token para la sesión activa.')
      accessToken = resultado.session.access_token
      this.registrar('3-sesion-docente', `Sesión válida (${resultado.user?.email || 'sin email'})`)
      if (resultado.user?.id) {
        this.sesion = await obtenerSesionContexto(supabase, resultado.user.id, obtenerZonaHorariaDispositivo()).catch(() => null)
      }
    } catch (err) {
      this.registrar('3-sesion-docente-error', err)
      throw new ErrorEtapaVoz('3-sesion-docente', err)
    }
    this.verificarIntentoVigente(idIntento)

    // --- Techo duro de 12s para TODA la secuencia de token + WebRTC +
    // canal de datos (con sus reintentos incluidos): si no se completó en
    // ese tiempo, se cancela todo y se vuelve a idle en vez de dejar el
    // indicador girando a la espera de un timeout interno más largo. El
    // caso de éxito real nunca se acerca a este techo (conexiones limpias
    // observadas en pruebas: 1.8-2.3s de punta a punta).
    const TECHO_CONEXION_MS = 12000
    const promesaConexion = this.intentarConexionConReintentos(idIntento, accessToken, perfil, contexto, herramientas)
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
      throw new ErrorEtapaVoz('techo-12s', `La conexión de voz no se completó en ${TECHO_CONEXION_MS / 1000} segundos.`)
    }
  }

  // Secuencia real de conexión (token efímero + WebRTC + canal de datos),
  // con un reintento completo si la primera conexión no llega a abrir el
  // canal. Aislada en su propio método para poder correr contra el techo
  // de 12s de iniciar() con Promise.race sin duplicar esa lógica.
  private async intentarConexionConReintentos(
    idIntento: number,
    accessToken: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    perfil: any,
    contexto: ContextoAplicacion,
    herramientas: Herramienta[]
  ): Promise<void> {
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
        this.debug('token-efimero-solicitado', 'info', `intento ${intento}`)
        const controlador = this.crearControladorConTimeout(8000)
        const tokenRes = await fetch('/api/realtime-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accessToken,
            instrucciones: this.construirInstruccionesCompletas(perfil, contexto),
            herramientas: herramientas.map(h => ({ nombre: h.nombre, descripcion: h.descripcion, parametros: h.parametros })),
            voz: VOZ,
          }),
          signal: controlador.signal,
        })
        this.registrar('5-token-efimero', `POST /api/realtime-token -> HTTP ${tokenRes.status} (intento ${intento})`)
        const data = await tokenRes.json().catch(() => ({}))
        if (!tokenRes.ok) throw new Error(`HTTP ${tokenRes.status}: ${data.error || 'sin detalle del servidor'}`)
        if (!data.value) throw new Error('La respuesta del servidor no incluyó un client secret.')
        clientSecret = data.value
        model = data.model || MODELO_DEFECTO
        this.debug('token-efimero-recibido', 'ok', `HTTP ${tokenRes.status}`)
      } catch (err) {
        this.verificarIntentoVigente(idIntento)
        this.registrar('5-token-efimero-error', err)
        this.debug('token-efimero-recibido', 'error', describirError(err))
        throw new ErrorEtapaVoz('5-token-efimero', err)
      }
      this.verificarIntentoVigente(idIntento)

      try {
        await this.conectarWebRTC(clientSecret, model)
        this.verificarIntentoVigente(idIntento)
        this.registrar('8-listo', 'Modo voz completamente conectado')
        this.debug('sesion-configurada', 'ok')
        this.conexionEstablecida = true
        this.emitir({ tipo: 'estado', estado: 'activo' })
        this.debug('estado-listening', 'ok')
        return
      } catch (err) {
        if (err instanceof ConexionCanceladaError) throw err
        this.verificarIntentoVigente(idIntento)
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
    this.debug('peerconnection-creada', 'ok')

    let rechazarCanalListo: ((err: Error) => void) | null = null
    // Diagnóstico completo del ciclo de vida de la conexión — solo va a
    // la consola (registrar = console.log), nunca al chat. Sirve para
    // reconstruir exactamente en qué estado se quedó una conexión que
    // falló, sin tener que mostrarle nada técnico al docente.
    pc.onsignalingstatechange = () => this.registrar('4-signaling', pc.signalingState)
    pc.onicegatheringstatechange = () => {
      this.registrar('4-ice-gathering', pc.iceGatheringState)
      this.debug('ice-gathering-state', 'info', pc.iceGatheringState)
    }
    pc.oniceconnectionstatechange = () => {
      this.registrar('4-ice', pc.iceConnectionState)
      this.debug('ice-connection-state', pc.iceConnectionState === 'failed' ? 'error' : 'info', pc.iceConnectionState)
    }
    pc.onconnectionstatechange = () => {
      this.registrar('4-conexion', pc.connectionState)
      this.debug('peerconnection-state', pc.connectionState === 'failed' ? 'error' : 'info', pc.connectionState)
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
      this.registrar('4-pista-remota', 'Audio del modelo recibido')
      audioEl.srcObject = evento.streams[0]
      audioEl.play().catch(err => this.registrar('4-pista-remota-play-error', describirError(err)))
    }

    const pistasAudio = this.stream!.getAudioTracks()
    this.registrar('2-pista-local', pistasAudio.map(t => `readyState=${t.readyState} enabled=${t.enabled} muted=${t.muted}`))
    pistasAudio.forEach(pista => pc.addTrack(pista, this.stream!))
    this.debug('track-agregado', pistasAudio.length > 0 ? 'ok' : 'error', `${pistasAudio.length} pista(s)`)

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
        this.debug('datachannel-open', 'error', `timeout 10s — ${JSON.stringify(diagnostico)}`)
        reject(new Error('Tiempo de espera agotado (10s) esperando que abriera el canal de datos.'))
      }, 10000)
      canal.addEventListener('open', () => {
        clearTimeout(limite)
        this.registrar('7-canal-abierto', `Data channel abierto (readyState=${canal.readyState})`)
        this.debug('datachannel-open', 'ok', `readyState=${canal.readyState}`)
        resolve()
      }, { once: true })
    })

    const offer = await pc.createOffer()
    this.debug('offer-creada', 'ok')
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
    this.debug('sdp-enviado-openai', 'info', `candidatos=${resumirCandidatos(sdpParaEnviar)}`)

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
      this.debug('respuesta-sdp-recibida', 'error', describirError(err))
      throw err
    }
    this.registrar('6-respuesta-sdp', `POST /v1/realtime/calls -> HTTP ${respuestaSdp.status}`)
    if (!respuestaSdp.ok) {
      const textoError = await respuestaSdp.text().catch(() => '')
      this.debug('respuesta-sdp-recibida', 'error', `HTTP ${respuestaSdp.status}`)
      throw new Error(`HTTP ${respuestaSdp.status} de OpenAI: ${textoError.slice(0, 300) || 'sin cuerpo de respuesta'}`)
    }
    this.debug('respuesta-sdp-recibida', 'ok', `HTTP ${respuestaSdp.status}`)
    const answerSdp = await respuestaSdp.text()
    this.registrar('6-respuesta-sdp-contenido', `candidatos remotos=${resumirCandidatos(answerSdp)}`)
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })
    this.registrar('6-respuesta-remota', 'setRemoteDescription OK')
    this.debug('remotedescription-configurada', 'ok', `signalingState=${pc.signalingState}`)

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
    if (this.temporizadorSilencio) clearTimeout(this.temporizadorSilencio)
    this.temporizadorSilencio = null
    this.cancelarTemporizadorFinTurno()
    this.resolverCommitFinal = null
    this.huboAudioSinConfirmar = false
    this.finalizandoTurno = false
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

  actualizarContexto(contexto: ContextoAplicacion) {
    this.contexto = contexto
    // session.update REEMPLAZA "instructions" por completo — si aquí solo
    // fuera el contexto (sin PERSONA_VOZ), el primer cambio de pantalla
    // borraría las reglas de comportamiento para el resto de la llamada.
    this.enviarEventoCliente({
      type: 'session.update',
      session: { type: 'realtime', instructions: this.construirInstruccionesCompletas(this.perfil, contexto) },
    })
  }

  interrumpir() {
    if (this.respondiendoActivo) this.enviarEventoCliente({ type: 'response.cancel' })
  }

  private reiniciarTemporizadorSilencio() {
    if (this.temporizadorSilencio) clearTimeout(this.temporizadorSilencio)
    // Respaldo, no el método principal (ver alternarTurno): si el
    // docente dijo algo y luego se queda callado este tiempo sin volver
    // a tocar el botón, el turno se cierra solo para no dejar la
    // conversación colgada.
    this.temporizadorSilencio = setTimeout(() => {
      if (this.transcripcionUsuarioAcumulada.trim() && !this.respondiendoActivo) {
        this.registrar('silencio-prolongado', 'Cerrando turno automáticamente como respaldo')
        this.finalizarTurno('automatico')
      }
    }, SILENCIO_MAXIMO_MS)
  }

  private cancelarTemporizadorFinTurno() {
    if (this.temporizadorFinTurno) {
      clearTimeout(this.temporizadorFinTurno)
      this.temporizadorFinTurno = null
    }
  }

  // Detección adaptativa de fin de turno (CASO A/B/C, ver
  // deteccionFinTurno.ts): se llama cada vez que un fragmento de
  // transcripción se confirma, con la transcripción ACUMULADA completa
  // hasta ese momento (no solo el fragmento nuevo) — así una instrucción
  // de varias partes con pausas ("Hazme cinco problemas de resta...
  // para tercer grado... con dificultad progresiva") se evalúa completa
  // cada vez, no fragmento por fragmento.
  private programarEvaluacionFinTurno() {
    this.cancelarTemporizadorFinTurno()

    // Una respuesta en curso significa que esto es una interrupción
    // (barge-in), no un turno nuevo pendiente de cerrar — el barge-in ya
    // se maneja del lado del servidor (interrupt_response:true). Cuando
    // esa respuesta cancelada termine de asentarse, el próximo fragmento
    // de transcripción vuelve a llamar a este método normalmente.
    if (this.respondiendoActivo) return

    const texto = this.transcripcionUsuarioAcumulada.trim()
    if (!texto) return

    const estado = analizarComplecionFrase(texto)
    this.debug('turno-analisis-complecion', 'info', estado)

    if (estado === 'espera_explicita') {
      // No se programa cierre automático — el docente literalmente pidió
      // una pausa. Solo el botón manual o el techo de silencio
      // prolongado (CASO D) cierran el turno desde aquí.
      this.emitir({ tipo: 'estado-escucha', estado: 'escuchando' })
      return
    }

    const espera = estado === 'completa'
      ? CONFIG_FIN_TURNO.silencioFraseCompletaMs
      : CONFIG_FIN_TURNO.silencioFraseIncompletaMs
    this.emitir({ tipo: 'estado-escucha', estado: 'confirmando' })
    this.temporizadorFinTurno = setTimeout(() => {
      this.registrar('fin-turno-adaptativo', `estado=${estado}, espera=${espera}ms`)
      this.finalizarTurno('automatico')
    }, espera)
  }

  // Cierra el turno actual: confirma cualquier audio que el VAD todavía
  // no hubiera comiteado por su cuenta y pide la respuesta de inmediato
  // — sin esperar a que Whisper termine de transcribir ese fragmento
  // para nosotros. El modelo ya recibió el audio crudo por RTP en tiempo
  // real; nuestra transcripción es solo para el texto de la burbuja del
  // docente, un proceso paralelo e independiente. La transcripción final
  // se sigue esperando (mismo techo de siempre) para poder mostrar ESE
  // texto, pero ya no bloquea el response.create — eso es lo que elimina
  // de la latencia percibida el viaje redondo completo de Whisper antes
  // de siquiera empezar a generar la respuesta.
  //
  // El orden visual del chat sigue garantizado sin tocar nada de eso:
  // turnoUsuarioPendiente (ver AsistenteService, activo desde
  // 'inicio-turno-usuario') sigue reteniendo cualquier fragmento de
  // respuesta que llegue antes de que exista el texto final del
  // docente — se muestra recién después de 'mensaje-usuario', nunca
  // antes, exactamente como ya funcionaba.
  async finalizarTurno(origen: 'manual' | 'automatico' = 'manual') {
    // Ya hay un finalizarTurno() en vuelo (segundo toque disparado antes
    // de que el primero terminara de esperar su commit/transcripción) —
    // ignorar esta llamada extra en vez de duplicar el turno.
    if (this.finalizandoTurno) return
    this.finalizandoTurno = true
    try {
      if (this.temporizadorSilencio) {
        clearTimeout(this.temporizadorSilencio)
        this.temporizadorSilencio = null
      }
      this.cancelarTemporizadorFinTurno()
      this.debug('turno-fin-turno-decidido', 'ok', origen)
      if (origen === 'manual') this.debug('turno-2do-toque', 'ok')

      // Solo comitear (y esperar su transcripción) si de verdad hay
      // audio nuevo sin confirmar. El caso normal es que el VAD ya haya
      // comiteado el fragmento momentos antes de este toque — ahí no hay
      // nada que mandar ni que esperar.
      let promesaTranscripcion: Promise<void> = Promise.resolve()
      if (this.huboAudioSinConfirmar) {
        this.enviarEventoCliente({ type: 'input_audio_buffer.commit' })
        this.debug('turno-fin-captura', 'ok', 'commit enviado, esperando transcripción en paralelo')
        promesaTranscripcion = new Promise<void>((resolve) => {
          this.resolverCommitFinal = resolve
          setTimeout(resolve, ESPERA_MAXIMA_COMMIT_MS)
        })
      } else {
        this.debug('turno-fin-captura', 'ok', 'sin audio nuevo que comitear')
      }

      // Refresca la hora justo antes de responder — un session.update no
      // agrega ninguna vuelta de red (mismo canal ya abierto, sin
      // esperar respuesta antes de mandar response.create a continuación)
      // pero evita que la hora quede vieja en una llamada de voz larga.
      this.enviarEventoCliente({
        type: 'session.update',
        session: { type: 'realtime', instructions: this.construirInstruccionesCompletas(this.perfil, this.contexto) },
      })

      // Pedir la respuesta YA — no esperar la transcripción para esto.
      this.enviarEventoCliente({ type: 'response.create' })
      this.debug('turno-response-create-enviado', 'ok')
      this.emitir({ tipo: 'estado-escucha', estado: 'pensando' })

      await promesaTranscripcion
      this.resolverCommitFinal = null

      const textoFinal = this.transcripcionUsuarioAcumulada.trim()
      this.transcripcionUsuarioAcumulada = ''
      if (!textoFinal) {
        // Caso raro: el VAD marcó actividad pero no hubo texto
        // transcribible (ruido, falsa alarma) — ya mandamos
        // response.create, así que hay que cancelar esa respuesta en
        // vez de dejar que conteste sin burbuja del docente que la
        // preceda.
        this.debug('turno-transcripcion-final', 'error', 'vacío — cancelando respuesta')
        this.enviarEventoCliente({ type: 'response.cancel' })
        return
      }
      this.debug('turno-transcripcion-final', 'ok', textoFinal.slice(0, 60))
      this.emitir({ tipo: 'mensaje-usuario', texto: textoFinal })
      this.debug('turno-mensaje-renderizado', 'ok')
    } finally {
      this.finalizandoTurno = false
    }
  }

  // Único punto que AsistenteService llama cada vez que el docente toca
  // el botón mientras el modo voz ya está conectado. El significado del
  // toque depende del estado real de la conversación, nunca hace falta
  // un botón distinto:
  // - la IA está hablando -> interrumpir y volver a escuchar.
  // - el docente ya dijo algo -> cerrar el turno y pedir la respuesta.
  // - no hay nada que enviar -> no hay nada que hacer aquí; AsistenteService
  //   interpreta 'vacio' como "el docente quiere salir del modo voz".
  async alternarTurno(): Promise<'interrumpido' | 'finalizado' | 'vacio'> {
    // Un finalizarTurno() anterior sigue en vuelo — este toque ya no
    // tiene nada nuevo que hacer (ver finalizandoTurno).
    if (this.finalizandoTurno) return 'finalizado'
    if (this.respondiendoActivo) {
      this.interrumpir()
      return 'interrumpido'
    }
    if (this.transcripcionUsuarioAcumulada.trim()) {
      // El botón manual siempre gana: cierra de inmediato sin esperar
      // ningún análisis automático (ver programarEvaluacionFinTurno).
      await this.finalizarTurno('manual')
      return 'finalizado'
    }
    return 'vacio'
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

  // Permite seguir escribiendo (o mandar una foto ya resuelta como texto)
  // aunque el modo de voz esté activo — no rompe la entrada por teclado.
  async enviarTexto(texto: string, _adjunto?: AdjuntoImagen) {
    this.enviarEventoCliente({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: texto }] },
    })
    this.enviarEventoCliente({ type: 'response.create' })
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
        // Señal más temprana posible de que el docente empezó a hablar —
        // llega antes que la transcripción y antes que la respuesta del
        // modelo. AsistenteService la usa para nunca mostrar la
        // respuesta del asistente antes de la burbuja del docente.
        this.emitir({ tipo: 'inicio-turno-usuario' })
        this.huboAudioSinConfirmar = true
        this.reiniciarTemporizadorSilencio()
        this.debug('turno-ultimo-fragmento-audio', 'info')
        // El docente volvió a hablar antes de que se cerrara el turno —
        // cancela cualquier cierre automático que estuviera contando
        // (CASO A/B en pausa) y vuelve a "escuchando". Se reevalúa desde
        // cero en cuanto este nuevo fragmento termine de transcribirse.
        this.cancelarTemporizadorFinTurno()
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
        this.emitir({ tipo: 'transcripcion-parcial', texto: this.transcripcionUsuarioParcial })
        break

      case 'conversation.item.input_audio_transcription.completed': {
        // Con create_response:false, cada pausa natural genera SU PROPIO
        // evento de transcripción — se van juntando aquí en vez de
        // mostrarse cada una como un mensaje aparte. La detección
        // adaptativa (ver programarEvaluacionFinTurno) decide, con el
        // texto acumulado completo, si ya es momento de cerrar el turno;
        // el botón manual siempre puede cerrarlo antes.
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

      case 'response.output_audio_transcript.delta':
        if (this.esEventoDeRespuestaSuperada(evento.response_id)) break
        if (!this.idRespuestaActual && evento.response_id) this.idRespuestaActual = evento.response_id
        if (this.primerDeltaDeEstaRespuesta) {
          this.primerDeltaDeEstaRespuesta = false
          this.debug('turno-primer-texto', 'ok')
          this.emitir({ tipo: 'estado-escucha', estado: 'escuchando' })
        }
        this.transcripcionRespuesta += evento.delta || ''
        this.emitir({ tipo: 'respuesta-parcial', texto: this.transcripcionRespuesta })
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
          // cancelled / failed / incomplete (interrupción real o falsa
          // alarma del VAD) — se deja constancia, pero el texto que ya
          // se alcanzó a mostrar se conserva tal cual quedó, igual que
          // una frase interrumpida en una conversación real.
          this.registrar('respuesta-no-completada', `status=${status}`)
        }
        this.debug('turno-respuesta-finalizada', status === 'completed' || !status ? 'ok' : 'info', status)
        if (this.transcripcionRespuesta) {
          this.emitir({ tipo: 'respuesta-final', texto: this.transcripcionRespuesta })
        }
        this.transcripcionRespuesta = ''
        this.idRespuestaActual = null
        break
      }

      case 'response.function_call_arguments.done':
        this.ejecutarHerramienta(evento)
        break

      case 'error': {
        this.registrar('8-error-servidor', evento)
        const detalle = String(evento.error?.message || evento.error?.code || describirError(evento))

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

        // El detalle técnico real ya quedó registrado arriba (ver
        // registrar, línea de este mismo bloque) para el panel
        // ?voiceDebug=1 — el docente solo debe ver un mensaje simple,
        // ver ARQUITECTURA MAESTRA, principio de ERRORES.
        this.emitir({ tipo: 'error', mensaje: 'Ocurrió un problema con la voz. Toca para reintentar.' })
        break
      }

      default:
        break
    }
  }

  private async ejecutarHerramienta(evento: EventoServidor) {
    const herramienta = this.herramientas.find(h => h.nombre === evento.name)
    const argumentos = this.parsearArgumentos(evento.arguments)
    this.emitir({ tipo: 'llamada-herramienta', nombre: evento.name, argumentos })

    let salida: string
    try {
      if (!herramienta) throw new Error('Herramienta no disponible')
      const resultado = await herramienta.ejecutar(argumentos, this.contexto)
      salida = resultado.mensaje
    } catch {
      salida = 'No se pudo ejecutar la acción solicitada.'
    }

    this.enviarEventoCliente({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: evento.call_id, output: salida },
    })
    this.enviarEventoCliente({ type: 'response.create' })
  }

  private parsearArgumentos(json: string): Record<string, unknown> {
    try {
      return JSON.parse(json || '{}')
    } catch {
      return {}
    }
  }
}
