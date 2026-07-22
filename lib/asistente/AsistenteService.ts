// lib/asistente/AsistenteService.ts
//
// Instancia única para toda la aplicación (no ligada a ningún componente
// de pantalla). Vive mientras la pestaña esté abierta, conserva el
// historial completo de la conversación y el contexto activo (pantalla,
// alumno, documento) aunque el docente navegue entre módulos. La UI
// (AsistentePanel) solo lee este estado a través de useSyncExternalStore
// — nunca lo posee.

import { supabase } from '@/lib/supabaseClient'
import { MotorTextoClaude } from './motores/motorTextoClaude'
import { ConexionCanceladaError, MotorOpenAIRealtime } from './motores/motorOpenAIRealtime'
import { detectarFormatoExplicito, detectarHerramientaDocumento, esDocumentoFormal, type TipoHerramienta } from './documentos'
import { obtenerPerfilYSesion, type PerfilDocente } from './perfilDocente'
import { obtenerZonaHorariaDispositivo } from '@/lib/tiempo/TimeService'
import { esVerificacionCalendarioConImagen } from '@/lib/calendario/analisisCalendario'
import {
  borrarTodasLasConversaciones,
  cargarConversacionPorId,
  crearNuevaConversacion,
  eliminarConversacion as eliminarConversacionGuardada,
  establecerConversacionActiva,
  guardarConversacion,
  listarConversaciones,
  type ConversacionResumen,
  type DocumentoActivoGuardado,
} from './persistencia'
import type {
  AccionMensaje,
  AccionNavegacion,
  AdjuntoImagen,
  ArchivoGeneradoInfo,
  ContextoAplicacion,
  DiferenciaCalendario,
  EstadoMotor,
  EventoMotor,
  Herramienta,
  MensajeConversacion,
  MotorConversacional,
} from './tipos'
import { CONTEXTO_VACIO } from './tipos'

class ErrorLimiteDeTiempoAccion extends Error {}

// Mismo patrón de conLimiteDeTiempo que ya usan motorTextoClaude.ts (
// cliente) y app/api/chat/route.ts (servidor) — copia local a
// propósito, no una utilidad compartida (ver esos archivos: es una
// duplicación pequeña e intencional, no una entidad que otros módulos
// deban importar).
async function conLimiteDeTiempoAccion<T>(promesa: Promise<T>, ms: number, mensaje: string): Promise<T> {
  let temporizador!: ReturnType<typeof setTimeout>
  const limite = new Promise<never>((_, reject) => {
    temporizador = setTimeout(() => reject(new ErrorLimiteDeTiempoAccion(mensaje)), ms)
  })
  try {
    return await Promise.race([promesa, limite])
  } finally {
    clearTimeout(temporizador)
  }
}

// Al cargar el módulo SOLO se lee el índice liviano (id/título/fecha) de
// conversaciones guardadas — para que la barra lateral tenga qué
// mostrar. Nunca se selecciona ni se cargan mensajes de ninguna
// conversación automáticamente: la existencia de conversaciones
// persistidas no debe asignar activeConversationId por sí sola. El
// docente decide cuál abrir (ver abrirConversacion) o si empieza una
// nueva escribiendo (ver enviarMensaje) — el Chat IA siempre monta en su
// vista inicial, sin importar desde dónde se llegó (inicio de la app,
// botón Inicio, o cualquier módulo).
const INDICE_CONVERSACIONES_INICIAL = listarConversaciones()

export type EstadoAsistente = {
  mensajes: MensajeConversacion[]
  contexto: ContextoAplicacion
  estadoMotor: EstadoMotor
  panelAbierto: boolean
  generando: boolean
  transcripcionParcial: string
  modoVoz: boolean
  // Aviso breve y temporal para fallas de CONEXIÓN de voz (nunca se
  // guarda en el historial de mensajes — no es una respuesta del
  // asistente, es un estado transitorio de la interfaz). Se muestra junto
  // al botón del micrófono y desaparece solo. Ver mostrarAvisoVoz().
  avisoVoz: string | null
  // Registro paso a paso de la última conexión de voz — solo lo renderiza
  // AsistentePanel cuando la URL trae ?voiceDebug=1 (ver ese archivo).
  // Siempre se llena (barato), independientemente de si el panel de
  // debug está activo o no.
  debugVoz: PasoDebugVoz[]
  // Estado discreto del turno de voz (ver motorOpenAIRealtime.ts) —
  // null cuando no aplica (modo voz inactivo). Solo dos valores reales:
  // 'escuchando' (la sesión está captando audio) y 'hablando' (se está
  // reproduciendo la respuesta, ver reproducirRespuestaEnVoz). Toda la
  // detección de turnos/pausas queda encapsulada dentro del motor — ver
  // "Rediseñar el modo voz como conversación continua": la interfaz ya
  // no distingue "escuchando activamente" de "en una pausa natural
  // entre frases", ni muestra ningún estado intermedio de envío.
  estadoEscucha: 'escuchando' | 'hablando' | null
  // Aviso breve y temporal para fallas GENERANDO O EDITANDO UN DOCUMENTO
  // (nunca se guarda como mensaje del asistente — no es una respuesta,
  // es un estado transitorio de la interfaz, igual que avisoVoz). Se
  // muestra junto al área de escritura y desaparece solo. Tocarlo
  // reintenta la MISMA generación sin repetir el mensaje ni perder el
  // documento/contexto — ver reintentarGeneracion().
  avisoGeneracion: string | null
  // ID del mensaje cuyo archivo real (Word/PDF/PowerPoint/Excel) se está
  // generando y subiendo en este momento — null el resto del tiempo.
  // AsistentePanel lo usa para mostrar "Generando documento..." en la
  // tarjeta en vez del botón Word/PDF mientras dura (ver
  // enviarComoFinalizacion/ejecutarFinalizacion). A diferencia de
  // editandoDocumentoId (que cubre ediciones de contenido Y
  // finalizaciones), este SOLO se activa para finalizaciones.
  documentoFinalizandoId: string | null
  // Id de la conversación que se está viendo ahora mismo — null cuando
  // no hay ninguna seleccionada (vista inicial del Chat IA, ver
  // ARQUITECTURA: al montar nunca se abre una conversación sola). Lista
  // ligera (id/título/fecha) de todas las conversaciones guardadas — ver
  // lib/asistente/persistencia.ts. AsistentePanel las usa para pintar la
  // barra lateral y saber cuál está resaltada como activa.
  conversacionActivaId: string | null
  listaConversaciones: ConversacionResumen[]
  // Ver comentario junto a archivoReutilizadoId (campo privado) — señal
  // de una sola vez para que AsistentePanel baje el scroll y resalte la
  // tarjeta de un archivo que se reutilizó sin regenerar.
  archivoReutilizadoId: string | null
  // Secuencia visual mientras se aplica una corrección de calendario
  // confirmada (ver confirmarAccionCalendario) — null el resto del
  // tiempo. `mensajeId` es el mensaje con los botones que el docente
  // tocó, para que AsistentePanel sepa en qué burbuja mostrar la
  // animación en vez de un estado global ambiguo.
  accionCalendarioEnProgreso: { mensajeId: string; etapa: string } | null
  // Acción de navegación automática pendiente de ejecutar — null el
  // resto del tiempo. Solo AsistentePanel (única pieza con useRouter)
  // la consume: al verla distinta de null, hace router.push y llama a
  // limpiarNavegacionPendiente(). Ver "Integración de comandos
  // verbales con navegación y consulta interna".
  accionNavegacionPendiente: AccionNavegacion | null
  // Id del mensaje que sostiene el Documento Activo — null cuando no
  // hay ninguno. Solo el id (no el objeto completo): la tarjeta
  // universal (TarjetaDescarga) lo usa únicamente para saber si SU
  // mensaje es el activo (mostrar el distintivo "Documento activo" y
  // habilitar "Convertir a..."), nunca para leer el texto del
  // documento — ver "Ajustes sobre el sistema de generación y manejo
  // de documentos".
  documentoActivoId: string | null
  // Única fuente de verdad para nombre/escuela/grado/grupo en TODA la
  // interfaz — menú lateral (AsistentePanel), /dashboard/inicio, y
  // cualquier otra pantalla que necesite mostrarlo. null mientras carga
  // o si no hay sesión. Ningún componente debe volver a leer
  // perfiles_docentes por su cuenta con su propio useState — todos
  // consumen esto vía useAsistente() (ver "Corregir sincronización del
  // perfil docente en la interfaz").
  perfil: PerfilDocente | null
}

export type PasoDebugVoz = {
  hora: string
  ms: number
  paso: string
  resultado: 'ok' | 'error' | 'info'
  detalle?: string
}

type Listener = () => void

let contadorId = 0
const nuevoId = () => `msg-${Date.now()}-${contadorId++}`

class AsistenteServiceImpl {
  // null = sin conversación seleccionada (vista inicial) — nunca se
  // asigna sola a partir de lo que haya guardado en localStorage. Solo
  // abrirConversacion() (toque manual) o el primer mensaje escrito desde
  // la vista inicial (ver enviarMensaje) le dan un valor real.
  private conversacionActivaId: string | null = null
  private listaConversaciones: ConversacionResumen[] = INDICE_CONVERSACIONES_INICIAL
  private mensajes: MensajeConversacion[] = []
  private contexto: ContextoAplicacion = CONTEXTO_VACIO
  private estadoMotor: EstadoMotor = 'inactivo'
  private panelAbierto = false
  private generando = false
  private transcripcionParcial = ''
  private modoVoz = false
  private avisoVoz: string | null = null
  private avisoVozTimer: ReturnType<typeof setTimeout> | null = null
  private debugVoz: PasoDebugVoz[] = []
  private estadoEscucha: 'escuchando' | 'hablando' | null = null
  private avisoGeneracion: string | null = null
  private avisoGeneracionTimer: ReturnType<typeof setTimeout> | null = null
  private documentoFinalizandoId: string | null = null
  // Contenido real del documento que se está convirtiendo a archivo
  // (Word/PDF/...) — se preserva aparte porque, mientras dura la
  // finalización, el servidor va a transmitir "Documento generado
  // correctamente." + un marcador técnico en vez del documento (ver
  // FINALIZAR ARCHIVO en app/api/chat/route.ts). Sin esto, ese texto
  // genérico terminaba sobrescribiendo la vista previa real de la
  // burbuja (ver 'respuesta-parcial' más abajo) — el docente perdía de
  // vista el documento justo cuando debía poder verlo Y descargarlo a
  // la vez, y si pedía un segundo formato después ("también en PDF"),
  // el contenido real ya se había perdido.
  private textoDocumentoFinalizando: string | null = null
  // Cuántas veces se ha intentado la finalización de archivo ACTUAL sin
  // que el maestro haya tenido que tocar nada — ver el reintento
  // automático en el 'error' de manejarEventoMotor. Se reinicia al
  // empezar una finalización nueva y al terminar (éxito o agotado).
  private intentosFinalizacionActual = 0
  private readonly INTENTOS_MAXIMOS_FINALIZACION = 3
  // Últimos parámetros de una edición/generación de documento que falló
  // — permite reintentar exactamente lo mismo sin volver a escribir el
  // mensaje ni perder el documento activo (ver reintentarGeneracion()).
  private ultimoIntentoEdicion: {
    idDocumento: string
    textoParaModelo: string
    adjunto?: AdjuntoImagen
    // Presente solo cuando el reintento es de FINALIZAR ARCHIVO (ver
    // enviarComoFinalizacion) en vez de una edición de contenido normal.
    finalizarArchivo?: { tipo: TipoHerramienta; documentoTexto: string; textoOriginal: string }
  } | null = null

  private motor: MotorConversacional | null = null
  private motorTexto: MotorTextoClaude | null = null
  private motorVoz: MotorOpenAIRealtime | null = null
  // Motor de voz de la conexión que está en curso ahora mismo (entre
  // activarModoVoz() empezando y resolviendo) — a diferencia de
  // motorVoz, que solo se asigna si la conexión llega a completarse.
  // cancelarConexionVoz() lo necesita para poder cortar una conexión que
  // el docente canceló ANTES de que termine de conectar.
  private motorVozEnCurso: MotorOpenAIRealtime | null = null
  private herramientas: Herramienta[] = []
  private perfil: PerfilDocente | null = null
  private listeners = new Set<Listener>()
  private snapshot: EstadoAsistente = this.construirSnapshot()

  constructor() {
    // Carga inicial — cubre tanto un login recién hecho como una
    // recarga dura de la página con sesión ya activa (el listener de
    // abajo, en 'SIGNED_IN'/'INITIAL_SESSION', cubre los demás casos).
    this.recargarPerfil()
  }

  // Burbuja del asistente que sigue "abierta" para el turno actual — se
  // mantiene igual aunque una respuesta se genere en varios ciclos
  // internos (ej. una herramienta y luego la respuesta hablada), y solo
  // se cierra cuando el docente vuelve a hablar/escribir. Así una sola
  // intervención del asistente nunca se parte en varias burbujas.
  private turnoAbierto: string | null = null

  // Último documento formal (planeación, rúbrica, resumen, etc.) que el
  // asistente generó — permite que "agrégale...", "corrige...",
  // "hazlo más corto..." modifiquen ESE documento en vez de crear uno
  // nuevo (ver enviarMensaje/editarDocumento). Se carga junto con los
  // mensajes de una conversación, solo cuando el docente la abre — nunca
  // al montar el servicio.
  private documentoActivo: DocumentoActivoGuardado | null = null
  // Mientras no sea null, las respuestas del motor actualizan ESE mensaje
  // en vez de abrir uno nuevo — es como se implementa "editar el
  // documento existente" sin que el motor conversacional sepa nada de
  // documentos ni de ediciones.
  private editandoDocumentoId: string | null = null
  // Señal efímera para la UI: acaba de reutilizarse (sin regenerar) el
  // archivo de ESE mensaje — AsistentePanel baja el scroll hasta ahí y
  // aplica una animación breve de resaltado. Se apaga sola (mismo
  // patrón que avisoGeneracion/avisoVoz) para que el efecto de React
  // que dispara el scroll nunca tenga que llamar a setState — solo lee
  // este valor y actúa sobre el DOM. Nunca se persiste.
  private archivoReutilizadoId: string | null = null
  private archivoReutilizadoTimer: ReturnType<typeof setTimeout> | null = null

  // Secuencia visual (ver EstadoAsistente.accionCalendarioEnProgreso)
  // mientras se aplica una corrección de calendario ya confirmada —
  // puramente cosmética, igual que useEtapaGeneracion en
  // AsistentePanel.tsx: el trabajo real ocurre en una sola llamada a
  // /api/calendario/aplicar, este temporizador solo va avanzando el
  // texto que se muestra mientras esa llamada está en curso.
  private accionCalendarioEnProgreso: { mensajeId: string; etapa: string } | null = null
  private accionNavegacionPendiente: AccionNavegacion | null = null
  private accionCalendarioTimer: ReturnType<typeof setInterval> | null = null
  private readonly ETAPAS_ACCION_CALENDARIO = [
    'Analizando cambios...',
    'Corrigiendo eventos...',
    'Creando respaldo...',
    'Actualizando calendario...',
    'Sincronizando información...',
  ]

  // En modo voz, la transcripción del habla del docente y la respuesta
  // del modelo son dos procesos async INDEPENDIENTES de la Realtime API
  // — el segundo puede terminar primero. Sin esto, la burbuja del
  // asistente podía aparecer antes que la del docente. Mientras
  // turnoUsuarioPendiente sea true (desde 'inicio-turno-usuario' hasta
  // que 'mensaje-usuario' confirma el texto real), cualquier respuesta
  // del asistente se acumula aquí en vez de mostrarse, y se vuelca de
  // un jalón a la burbuja apenas aparece la burbuja del docente.
  private turnoUsuarioPendiente = false
  private textoAsistentePendiente = ''
  private finalPendiente = false

  // --- Suscripción externa (useSyncExternalStore) ---

  suscribir = (listener: Listener) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  obtenerSnapshot = (): EstadoAsistente => this.snapshot

  private construirSnapshot(): EstadoAsistente {
    return {
      mensajes: this.mensajes,
      contexto: this.contexto,
      estadoMotor: this.estadoMotor,
      panelAbierto: this.panelAbierto,
      generando: this.generando,
      transcripcionParcial: this.transcripcionParcial,
      modoVoz: this.modoVoz,
      avisoVoz: this.avisoVoz,
      debugVoz: this.debugVoz,
      estadoEscucha: this.estadoEscucha,
      avisoGeneracion: this.avisoGeneracion,
      documentoFinalizandoId: this.documentoFinalizandoId,
      conversacionActivaId: this.conversacionActivaId,
      listaConversaciones: this.listaConversaciones,
      archivoReutilizadoId: this.archivoReutilizadoId,
      accionCalendarioEnProgreso: this.accionCalendarioEnProgreso,
      accionNavegacionPendiente: this.accionNavegacionPendiente,
      documentoActivoId: this.documentoActivo?.id ?? null,
      perfil: this.perfil,
    }
  }

  // Único punto que escribe this.perfil — reutiliza obtenerPerfilYSesion
  // (misma función que ya usan los motores conversacionales para el
  // contexto de cada turno, ver lib/asistente/perfilDocente.ts) en vez
  // de una consulta propia a Supabase, para que nunca puedan divergir
  // dos lecturas del mismo registro. Se llama al iniciar el singleton,
  // en cada cambio de sesión, y cuando el propio Chat IA confirma haber
  // escrito un cambio (ver manejarEventoMotor, caso 'respuesta-final'
  // con evento.perfilActualizado).
  async recargarPerfil() {
    try {
      const { perfil } = await obtenerPerfilYSesion()
      this.perfil = perfil
      this.notificar()
    } catch (e) {
      console.error('No fue posible cargar el perfil del docente:', e)
    }
  }

  private iniciarProgresoAccionCalendario(mensajeId: string) {
    if (this.accionCalendarioTimer) clearInterval(this.accionCalendarioTimer)
    let indice = 0
    this.accionCalendarioEnProgreso = { mensajeId, etapa: this.ETAPAS_ACCION_CALENDARIO[0] }
    this.accionCalendarioTimer = setInterval(() => {
      indice = Math.min(indice + 1, this.ETAPAS_ACCION_CALENDARIO.length - 1)
      this.accionCalendarioEnProgreso = { mensajeId, etapa: this.ETAPAS_ACCION_CALENDARIO[indice] }
      this.notificar()
    }, 1100)
    this.notificar()
  }

  private detenerProgresoAccionCalendario() {
    if (this.accionCalendarioTimer) { clearInterval(this.accionCalendarioTimer); this.accionCalendarioTimer = null }
    this.accionCalendarioEnProgreso = null
  }

  private mostrarArchivoReutilizado(idMensaje: string) {
    if (this.archivoReutilizadoTimer) clearTimeout(this.archivoReutilizadoTimer)
    this.archivoReutilizadoId = idMensaje
    this.archivoReutilizadoTimer = setTimeout(() => {
      this.archivoReutilizadoId = null
      this.archivoReutilizadoTimer = null
      this.notificar()
    }, 1800)
  }

  // Agrega un paso al panel ?voiceDebug=1 — capado a los últimos 40 para
  // no crecer sin límite en una sesión con muchos intentos.
  private registrarPasoDebugVoz(paso: string, resultado: 'ok' | 'error' | 'info', detalle?: string, ms?: number) {
    const marca = ms ?? Date.now()
    const hora = new Date(marca).toLocaleTimeString('es-MX', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 })
    this.debugVoz = [...this.debugVoz, { hora, ms: marca, paso, resultado, detalle }].slice(-40)
  }

  // Aviso breve junto al botón del micrófono, no un mensaje del chat —
  // desaparece solo a los pocos segundos. Si ya había uno visible, se
  // reemplaza y el temporizador se reinicia.
  private mostrarAvisoVoz(texto: string) {
    if (this.avisoVozTimer) clearTimeout(this.avisoVozTimer)
    this.avisoVoz = texto
    this.avisoVozTimer = setTimeout(() => {
      this.avisoVoz = null
      this.avisoVozTimer = null
      this.notificar()
    }, 4000)
  }

  // Mismo patrón que mostrarAvisoVoz, para fallas generando/editando un
  // documento — nunca se guarda como mensaje del asistente.
  private mostrarAvisoGeneracion(texto: string) {
    if (this.avisoGeneracionTimer) clearTimeout(this.avisoGeneracionTimer)
    this.avisoGeneracion = texto
    this.avisoGeneracionTimer = setTimeout(() => {
      this.avisoGeneracion = null
      this.avisoGeneracionTimer = null
      this.notificar()
    }, 6000)
  }

  // Reintento automático de FINALIZAR ARCHIVO — hasta
  // INTENTOS_MAXIMOS_FINALIZACION veces, sin que el maestro tenga que
  // tocar nada ni volver a escribir "pásalo a Word": reintentarGeneracion()
  // ya conserva tipo/documentoTexto/textoOriginal exactos. Solo aplica a
  // fallas de FINALIZACIÓN de archivo (no a ediciones de contenido) y
  // nunca al límite permanente de imagen/audio/video (reintentar eso no
  // cambia nada, es exactamente el mismo resultado la próxima vez). El
  // maestro nunca ve los intentos intermedios — solo, si los tres
  // fallan, el mensaje final con el botón de reintentar manual.
  // Devuelve true si quedó un reintento automático en curso (el llamador
  // no debe mostrar ningún aviso todavía), false si ya se mostró el
  // aviso final y no hay más reintentos automáticos pendientes.
  private intentarReintentoAutomatico(estabaFinalizandoArchivo: boolean, mensajeError: string): boolean {
    const esLimitePermanente = /todavía no está disponible/i.test(mensajeError)
    if (estabaFinalizandoArchivo && !esLimitePermanente && this.intentosFinalizacionActual < this.INTENTOS_MAXIMOS_FINALIZACION - 1) {
      this.intentosFinalizacionActual += 1
      this.reintentarGeneracion()
      return true
    }
    this.intentosFinalizacionActual = 0
    this.mostrarAvisoGeneracion(
      estabaFinalizandoArchivo && !esLimitePermanente ? 'No fue posible generar el documento en este momento. Toca para reintentar.' : mensajeError
    )
    return false
  }

  private notificar() {
    this.snapshot = this.construirSnapshot()
    this.listeners.forEach(listener => listener())
    this.persistirConversacion()
  }

  // Guarda automáticamente en localStorage tras CUALQUIER cambio de
  // estado (notificar() es el único punto de paso de todos ellos) — el
  // docente nunca tiene que presionar nada. Con debounce corto: durante
  // el streaming de una respuesta, notificar() se llama muchas veces por
  // segundo; sin esto se reescribiría todo el historial en cada
  // fragmento de texto. 300ms sigue siendo "automático e inmediato" para
  // el docente, pero junta las ráfagas en una sola escritura real.
  private persistenciaTimer: ReturnType<typeof setTimeout> | null = null
  private persistirConversacion() {
    if (this.persistenciaTimer) clearTimeout(this.persistenciaTimer)
    this.persistenciaTimer = setTimeout(() => {
      this.persistenciaTimer = null
      this.guardarAhora()
    }, 300)
  }

  // Escritura real a localStorage — nunca se llama directo desde fuera,
  // siempre a través de persistirConversacion() (con debounce) o
  // guardarInmediatamente() (sin él). Actualiza también la lista ligera
  // de conversaciones para que la barra lateral refleje el título/fecha
  // más recientes sin tener que releer todo desde localStorage.
  private guardarAhora() {
    // Sin conversación activa (vista inicial, nada escrito todavía) o
    // sin mensajes: no hay nada que guardar — nunca se le pasa null a
    // guardarConversacion().
    if (!this.conversacionActivaId || this.mensajes.length === 0) return
    guardarConversacion(this.conversacionActivaId, this.mensajes, this.documentoActivo)
    this.listaConversaciones = listarConversaciones()
  }

  // Guardado inmediato, sin esperar el debounce — para el momento exacto
  // en que la pestaña se oculta (el docente cambia de app, minimiza, o el
  // sistema está a punto de suspenderla). Ver el listener de
  // visibilitychange más abajo, junto a la instancia exportada.
  guardarInmediatamente() {
    if (this.persistenciaTimer) {
      clearTimeout(this.persistenciaTimer)
      this.persistenciaTimer = null
    }
    this.guardarAhora()
  }

  // Descarta cualquier estado transitorio (turno abierto, edición o
  // generación de archivo en curso, avisos) antes de cambiar de
  // conversación o vaciar la actual — ninguno de esos estados tiene
  // sentido fuera de la conversación en la que empezaron.
  private limpiarEstadoTransitorio() {
    if (this.avisoGeneracionTimer) { clearTimeout(this.avisoGeneracionTimer); this.avisoGeneracionTimer = null }
    if (this.avisoVozTimer) { clearTimeout(this.avisoVozTimer); this.avisoVozTimer = null }
    if (this.archivoReutilizadoTimer) { clearTimeout(this.archivoReutilizadoTimer); this.archivoReutilizadoTimer = null }
    this.detenerProgresoAccionCalendario()
    this.archivoReutilizadoId = null
    this.accionNavegacionPendiente = null
    this.turnoAbierto = null
    this.editandoDocumentoId = null
    this.documentoFinalizandoId = null
    this.textoDocumentoFinalizando = null
    this.intentosFinalizacionActual = 0
    this.avisoGeneracion = null
    this.avisoVoz = null
    this.ultimoIntentoEdicion = null
    this.turnoUsuarioPendiente = false
    this.textoAsistentePendiente = ''
    this.finalPendiente = false
  }

  // Empieza una conversación nueva y vacía sin perder la actual — sigue
  // guardada y disponible en la barra lateral (ver listarConversaciones).
  // Completa el botón "+" que ya existía en el menú (antes solo cerraba
  // el menú sin hacer nada más).
  nuevaConversacion() {
    if (this.persistenciaTimer) { clearTimeout(this.persistenciaTimer); this.persistenciaTimer = null }
    this.guardarAhora() // no perder los últimos cambios de la conversación que se deja
    this.conversacionActivaId = crearNuevaConversacion()
    this.mensajes = []
    this.documentoActivo = null
    this.limpiarEstadoTransitorio()
    this.notificar()
  }

  // Cambia a una conversación ya guardada — la restaura completa
  // (mensajes, documento activo) y la deja como la activa.
  abrirConversacion(id: string) {
    if (id === this.conversacionActivaId) return
    if (this.persistenciaTimer) { clearTimeout(this.persistenciaTimer); this.persistenciaTimer = null }
    this.guardarAhora() // no perder los últimos cambios de la conversación que se deja
    const datos = cargarConversacionPorId(id)
    if (!datos) return
    this.conversacionActivaId = id
    establecerConversacionActiva(id)
    this.mensajes = datos.mensajes
    this.documentoActivo = datos.documentoActivo && datos.mensajes.some((m) => m.id === datos.documentoActivo!.id) ? datos.documentoActivo : null
    this.limpiarEstadoTransitorio()
    this.notificar()
  }

  // Borra una conversación guardada de forma permanente — si era la
  // activa, la pantalla vuelve a la vista inicial (null), nunca genera
  // sola una conversación nueva: la existencia/ausencia de datos
  // guardados no debe asignar activeConversationId por sí misma.
  eliminarConversacion(id: string) {
    eliminarConversacionGuardada(id)
    this.listaConversaciones = listarConversaciones()
    if (id === this.conversacionActivaId) {
      this.conversacionActivaId = null
      this.mensajes = []
      this.documentoActivo = null
      this.limpiarEstadoTransitorio()
    }
    this.notificar()
  }

  // Se dispara al cerrar sesión (ver el listener de onAuthStateChange
  // más abajo) — un dispositivo compartido entre dos docentes nunca debe
  // arrastrar la conversación de la sesión anterior a la siguiente.
  limpiarConversacionGuardada() {
    if (this.persistenciaTimer) {
      clearTimeout(this.persistenciaTimer)
      this.persistenciaTimer = null
    }
    this.mensajes = []
    this.documentoActivo = null
    this.limpiarEstadoTransitorio()
    borrarTodasLasConversaciones()
    this.conversacionActivaId = null
    this.listaConversaciones = []
    this.notificar()
  }

  // --- Panel (mostrar/ocultar la burbuja de conversación) ---

  abrirPanel() {
    this.panelAbierto = true
    this.notificar()
    this.asegurarMotor()
  }

  cerrarPanel() {
    this.panelAbierto = false
    this.notificar()
  }

  togglePanel() {
    if (this.panelAbierto) this.cerrarPanel()
    else this.abrirPanel()
  }

  // --- Contexto de la pantalla activa ---
  // Cada pantalla se registra al montar (ver useContextoAsistente). Como
  // solo una pantalla está activa a la vez con el App Router, el último
  // registro siempre gana — no hace falta fusionar ni limpiar entre
  // pantallas distintas.

  actualizarContexto(contexto: ContextoAplicacion) {
    this.contexto = contexto
    this.motor?.actualizarContexto(contexto)
    this.notificar()
  }

  // --- Herramientas ---
  // Cada módulo registra sus propias herramientas cuando está montado
  // (ver useHerramientasAsistente). Se identifican por nombre para poder
  // reemplazar/actualizar sin duplicar.

  registrarHerramientas(nuevas: Herramienta[]) {
    const porNombre = new Map(this.herramientas.map(h => [h.nombre, h]))
    nuevas.forEach(h => porNombre.set(h.nombre, h))
    this.herramientas = Array.from(porNombre.values())
  }

  private async asegurarMotorTexto(): Promise<MotorTextoClaude> {
    if (!this.motorTexto) {
      const motor = new MotorTextoClaude()
      motor.suscribir(evento => this.manejarEventoMotor(evento))
      this.motorTexto = motor
      await motor.iniciar(this.contexto, this.herramientas)
    }
    return this.motorTexto
  }

  private async asegurarMotor() {
    if (this.motor) return
    this.motor = await this.asegurarMotorTexto()
  }

  // Único punto que decide QUÉ motor genera el contenido real de una
  // respuesta. NUNCA this.motor a secas cuando modoVoz está activo:
  // this.motor apunta a MotorOpenAIRealtime en ese caso (solo capta y
  // transcribe audio ahora, ver motorOpenAIRealtime.ts), pero el
  // contenido siempre debe salir del mismo pipeline que un mensaje
  // escrito (MotorTextoClaude / /api/chat), sin excepción — ver
  // "Unificar el flujo de voz con el pipeline de texto". Esto cubre
  // TODOS los caminos que antes llamaban a this.motor?.enviarTexto
  // directamente (mensaje normal, varias fotos, edición de documento):
  // si el docente escribe o edita un documento mientras el modo voz
  // sigue conectado, también debe pasar por Claude, nunca por el
  // razonamiento propio de OpenAI Realtime.
  private async motorDeContenido(): Promise<MotorConversacional | null> {
    if (this.modoVoz) return await this.asegurarMotorTexto()
    return this.motor
  }

  // --- Modo conversación por voz ---
  // Sustituye QUÉ motor está detrás de this.motor sin que enviarMensaje,
  // interrumpir ni actualizarContexto sepan que cambió nada — siguen
  // llamando a this.motor como siempre. Si MotorOpenAIRealtime falla al
  // conectar (sin micrófono, sin red, proveedor caído), se recupera el
  // motor de texto automáticamente y el docente puede seguir escribiendo.

  // this.modoVoz solo se vuelve true DESPUÉS de que termina motor.iniciar()
  // (getUserMedia + handshake WebRTC completo — cientos de ms a varios
  // segundos). Si algo llama activarModoVoz() otra vez durante esa
  // ventana (doble tap, un evento duplicado, una reconexión), "if
  // (this.modoVoz) return" no lo detiene — ambas llamadas pasan y se
  // crean DOS instancias de MotorOpenAIRealtime, cada una conectada y
  // suscrita a manejarEventoMotor, cada una respondiendo por su cuenta a
  // lo mismo que dijo el docente. Ese es el origen real de "la misma
  // respuesta dos veces, una cortada" — dos motores generándola en
  // paralelo, no un evento duplicado dentro de un solo motor.
  // conectandoVoz se marca de forma SÍNCRONA, antes de cualquier await,
  // así que una segunda llamada mientras la primera sigue en vuelo se
  // descarta de inmediato, sin excepción.
  private conectandoVoz = false

  async activarModoVoz() {
    if (this.modoVoz || this.conectandoVoz) return
    this.conectandoVoz = true
    // Diagnóstico ?voiceDebug=1: un registro nuevo por cada intento, para
    // que el panel siempre muestre exactamente el último paso alcanzado
    // en LA conexión actual, no un mezcladero de intentos anteriores.
    this.debugVoz = []
    this.registrarPasoDebugVoz('voice:start_button_pressed', 'ok')
    this.estadoEscucha = 'escuchando'
    this.abrirPanel()
    try {
      // Red de seguridad: si por lo que sea ya había un motor de voz
      // vivo sin haberse cerrado, se cierra antes de abrir uno nuevo —
      // nunca deben quedar dos conexiones de Realtime activas a la vez.
      if (this.motorVoz) {
        await this.motorVoz.detener().catch(() => {})
        this.motorVoz = null
      }

      const motor = new MotorOpenAIRealtime()
      motor.suscribir(evento => this.manejarEventoMotor(evento))
      // Único puente real hacia el pipeline de texto (ver
      // "Unificar el flujo de voz con el pipeline de texto") — es
      // literalmente this.enviarMensaje, la misma función que llama el
      // botón Enviar. motorOpenAIRealtime.ts nunca vuelve a generar su
      // propia respuesta; solo capta/transcribe audio y entrega el
      // texto reconocido aquí.
      motor.establecerCanalDeTexto((texto) => this.enviarMensaje(texto))
      // Si el docente vuelve a hablar mientras la respuesta del turno
      // anterior todavía está en camino, esto la cancela — sin esto,
      // enviarMensaje() ignoraría en silencio el turno nuevo mientras
      // "generando" siga en true (ver interrumpirTexto en
      // motorOpenAIRealtime.ts).
      motor.establecerInterruptorTexto(() => this.motorTexto?.interrumpir())
      // Expuesto para que cancelarConexionVoz() pueda cortarlo incluso
      // ANTES de que este await resuelva (motorVoz solo se asigna si la
      // conexión llega a completarse).
      this.motorVozEnCurso = motor

      const historial = this.mensajes
        .slice(-10)
        .map(m => `${m.rol === 'usuario' ? 'Docente' : 'Asistente'}: ${m.texto}`)
        .join('\n')
      const contextoConHistorial: ContextoAplicacion = {
        ...this.contexto,
        datosAdicionales: {
          ...this.contexto.datosAdicionales,
          ...(historial ? { conversacionPrevia: historial } : {}),
        },
      }

      await motor.iniciar(contextoConHistorial, this.herramientas)
      this.motorVoz = motor
      this.motor = motor
      this.modoVoz = true
      this.notificar()
    } catch (err) {
      this.motorVoz = null
      this.motor = await this.asegurarMotorTexto()
      this.modoVoz = false
      this.estadoEscucha = null
      if (err instanceof ConexionCanceladaError) {
        // El propio docente canceló (tocó de nuevo mientras conectaba, o
        // cambió de pantalla) — vuelta silenciosa a idle, sin aviso ni
        // mensaje en el chat, no es una falla.
        this.estadoMotor = 'inactivo'
        this.notificar()
      } else {
        // El detalle técnico (WebRTC, DataChannel, SDP, timeouts) se
        // queda en la consola para diagnóstico — el docente nunca debe
        // ver esos términos, y esto NUNCA se guarda como mensaje del
        // chat (no es una respuesta del asistente). Ver
        // MotorOpenAIRealtime.iniciar(): ya intentó conectar dos veces
        // (con un token efímero nuevo cada vez) antes de llegar hasta
        // aquí, así que esto ya es un fallo real, no transitorio.
        console.error('[VOZ] No se pudo iniciar el modo de voz:', err)
        this.estadoMotor = 'inactivo'
        this.mostrarAvisoVoz('No se pudo conectar la voz. Toca para reintentar.')
        this.notificar()
      }
    } finally {
      this.motorVozEnCurso = null
      this.conectandoVoz = false
    }
  }

  // Segundo toque del botón MIENTRAS todavía está conectando (estadoMotor
  // === 'conectando'): cancela ese intento en curso en vez de esperar a
  // que falle o se quede colgado. No es un error, es una decisión del
  // docente — cancelarConexion() limpia absolutamente todo (WebRTC,
  // DataChannel, micrófono, fetches en vuelo) y la conexión en vuelo
  // termina resolviendo con ConexionCanceladaError (ver el catch de
  // activarModoVoz arriba), que la vuelve a idle en silencio.
  cancelarConexionVoz() {
    this.motorVozEnCurso?.cancelarConexion()
  }

  // Único significado posible de un toque mientras el modo voz ya está
  // conectado: terminar la sesión completa — ver "Rediseñar el modo voz
  // como conversación continua". Ya no existe un segundo significado
  // ("cerrar este turno") porque los turnos se cierran solos
  // (detección automática de fin de turno, ver motorOpenAIRealtime.ts).
  async desactivarModoVoz() {
    if (!this.modoVoz) return
    await this.motorVoz?.detener()
    this.motorVoz = null
    this.modoVoz = false
    this.turnoUsuarioPendiente = false
    this.textoAsistentePendiente = ''
    this.finalPendiente = false
    this.estadoEscucha = null
    this.motor = await this.asegurarMotorTexto()
    this.notificar()
  }

  private manejarEventoMotor(evento: EventoMotor) {
    switch (evento.tipo) {
      case 'estado':
        this.estadoMotor = evento.estado
        this.notificar()
        break
      case 'inicio-turno-usuario':
        // Apenas el VAD detecta que el docente empezó a hablar — mucho
        // antes de tener texto. Bloquea que una respuesta se muestre
        // antes de que exista la burbuja del docente.
        this.turnoUsuarioPendiente = true
        this.notificar()
        break
      case 'transcripcion-parcial':
        this.transcripcionParcial = evento.texto
        this.notificar()
        break
      case 'mensaje-usuario': {
        // Solo lo emiten motores de voz: en modo texto, enviarMensaje ya
        // agrega el mensaje del docente antes de llamar al motor. Este es
        // un turno nuevo del docente: lo que diga el asistente después
        // abre una burbuja nueva, no continúa la anterior.
        //
        // Igual que enviarMensaje(): si se llega aquí desde la vista
        // inicial (sin conversación seleccionada — ej. el docente activó
        // el modo voz directo desde el arranque), hablar por primera vez
        // ES la acción que crea la conversación nueva.
        if (!this.conversacionActivaId) {
          this.conversacionActivaId = crearNuevaConversacion()
        }
        this.transcripcionParcial = ''
        this.mensajes = [...this.mensajes, { id: nuevoId(), rol: 'usuario', texto: evento.texto, creadoEn: Date.now() }]
        this.turnoAbierto = null
        this.turnoUsuarioPendiente = false
        this.notificar()

        // Si la respuesta del asistente ya había llegado (o hasta
        // terminado) mientras esperábamos la transcripción, se vuelca
        // ahora de un jalón — la burbuja del docente ya quedó primero.
        if (this.textoAsistentePendiente) {
          this.turnoAbierto = nuevoId()
          this.mensajes = [...this.mensajes, { id: this.turnoAbierto, rol: 'asistente', texto: this.textoAsistentePendiente, creadoEn: Date.now() }]
          this.textoAsistentePendiente = ''
          if (this.finalPendiente) {
            this.generando = false
            this.finalPendiente = false
            if (esDocumentoFormal(this.mensajes[this.mensajes.length - 1].texto)) {
              this.actualizarDocumentoActivo(this.turnoAbierto, this.mensajes[this.mensajes.length - 1].texto)
            }
          }
          this.notificar()
        }
        break
      }
      case 'respuesta-parcial': {
        this.generando = true

        // Todavía no existe la burbuja del docente para este turno —
        // se guarda el texto sin mostrarlo (ver 'mensaje-usuario').
        if (this.turnoUsuarioPendiente) {
          this.textoAsistentePendiente = evento.texto
          this.notificar()
          break
        }

        // Editando un documento existente: el texto que llega reemplaza
        // ESE mensaje, nunca abre una burbuja nueva.
        if (this.editandoDocumentoId) {
          const idx = this.mensajes.findIndex(m => m.id === this.editandoDocumentoId)
          if (idx !== -1) {
            // FINALIZAR ARCHIVO (no una edición de contenido real): el
            // servidor transmite "Documento generado correctamente." +
            // el marcador técnico, nunca el documento — la burbuja debe
            // seguir mostrando el documento real (ver
            // textoDocumentoFinalizando) para que la vista previa nunca
            // desaparezca ni se reemplace por ese texto genérico.
            const texto = this.documentoFinalizandoId === this.editandoDocumentoId && this.textoDocumentoFinalizando
              ? this.textoDocumentoFinalizando
              : evento.texto
            const actualizado = { ...this.mensajes[idx], texto }
            this.mensajes = [...this.mensajes.slice(0, idx), actualizado, ...this.mensajes.slice(idx + 1)]
          }
          this.notificar()
          break
        }

        // Turno normal: todo lo que el asistente diga hasta que el
        // docente vuelva a hablar/escribir cae en la MISMA burbuja,
        // aunque internamente hayan sido varios ciclos de respuesta
        // (ej. una herramienta seguida de la respuesta hablada) — así una
        // sola intervención nunca se ve partida en varios mensajes.
        const ultimo = this.mensajes[this.mensajes.length - 1]
        if (ultimo && ultimo.rol === 'asistente' && ultimo.id === this.turnoAbierto) {
          ultimo.texto = evento.texto
          this.mensajes = [...this.mensajes.slice(0, -1), ultimo]
        } else {
          this.turnoAbierto = nuevoId()
          this.mensajes = [...this.mensajes, { id: this.turnoAbierto, rol: 'asistente', texto: evento.texto, creadoEn: Date.now() }]
        }
        this.notificar()
        break
      }
      case 'respuesta-final': {
        // El Chat IA acaba de confirmar un cambio real en
        // perfiles_docentes (ver actualizar_perfil_docente en
        // app/api/chat/route.ts) — se dispara sin esperar a los
        // chequeos de abajo (turnoUsuarioPendiente, etc.) porque es
        // independiente de cómo se termine mostrando esta respuesta.
        // recargarPerfil() notifica por su cuenta cuando termina.
        if (evento.perfilActualizado) this.recargarPerfil()

        // Igual que arriba: si aún no aparece la burbuja del docente,
        // solo se marca que ya está lista para volcarse en cuanto llegue.
        if (this.turnoUsuarioPendiente) {
          this.finalPendiente = true
          break
        }

        this.generando = false

        // Nunca dejar una burbuja vacía en pantalla — puede pasar si el
        // streaming "terminó bien" (sin error de red ni de HTTP) pero
        // sin texto real (ver Manejo de errores: respuesta vacía o
        // undefined). Se trata exactamente igual que un error real.
        const textoVacio = !evento.texto || !evento.texto.trim()

        if (this.editandoDocumentoId) {
          if (textoVacio) {
            const estabaFinalizandoArchivo = this.documentoFinalizandoId !== null
            this.editandoDocumentoId = null
            this.documentoFinalizandoId = null
            this.textoDocumentoFinalizando = null
            if (this.intentarReintentoAutomatico(estabaFinalizandoArchivo, 'No pude generar el archivo. Toca para reintentar.')) break
            this.notificar()
            break
          }
          // FINALIZAR ARCHIVO: el marcador [[DOCUMENTO_ARCHIVO:...]] ya
          // se procesó en el motor (ver motorTextoClaude) y llega aquí
          // como evento.archivo — se adjunta al mensaje para que la
          // tarjeta muestre el botón de descarga real.
          if (evento.archivo) {
            const idx = this.mensajes.findIndex(m => m.id === this.editandoDocumentoId)
            if (idx !== -1) {
              this.mensajes = [
                ...this.mensajes.slice(0, idx),
                { ...this.mensajes[idx], archivo: evento.archivo },
                ...this.mensajes.slice(idx + 1),
              ]
            }
          }
          // El documento sigue activo (con su texto real intacto, ver
          // arriba) tanto si se acaba de finalizar a archivo como si fue
          // una edición de contenido — así un segundo formato ("también
          // en PDF") o una nueva edición reutilizan el contenido real en
          // vez de partir de cero o de "Documento generado correctamente.".
          const doc = this.mensajes.find(m => m.id === this.editandoDocumentoId)
          if (doc) this.actualizarDocumentoActivo(doc.id, doc.texto, evento.archivo)
          this.editandoDocumentoId = null
          this.documentoFinalizandoId = null
          this.textoDocumentoFinalizando = null
          this.intentosFinalizacionActual = 0
          this.ultimoIntentoEdicion = null
          this.notificar()
          break
        }

        if (textoVacio && this.turnoAbierto) {
          // Quitar la burbuja vacía en vez de dejarla ahí sin nada.
          this.mensajes = this.mensajes.filter(m => m.id !== this.turnoAbierto)
          this.turnoAbierto = null
          this.manejarEventoMotor({ tipo: 'error', mensaje: 'No pude generar la respuesta. Intenta de nuevo.' })
          break
        }

        // NO se cierra turnoAbierto aquí a propósito — sigue abierto por
        // si llegan más ciclos de la misma intervención. Solo se cierra
        // cuando el docente vuelve a hablar (ver 'mensaje-usuario' y
        // enviarMensaje). Si lo que se acaba de terminar es un documento
        // formal, queda marcado como el documento activo para ediciones.
        if (this.turnoAbierto) {
          const idx = this.mensajes.findIndex(m => m.id === this.turnoAbierto)
          const msg = idx !== -1 ? this.mensajes[idx] : undefined
          if (msg && evento.archivo) {
            // CASO 3 (ver FINALIZAR ARCHIVO en app/api/chat/route.ts):
            // el maestro pidió el archivo real en el MISMO mensaje que
            // pidió el contenido ("hazme un examen y pásalo a Word"),
            // sin que existiera un documentoActivo previo — este turno
            // nunca pasó por enviarComoFinalizacion/editandoDocumentoId
            // (ver arriba), así que evento.archivo se tenía que adjuntar
            // aquí también o la tarjeta de descarga nunca aparecía y el
            // maestro solo veía el texto plano "Documento generado
            // correctamente."
            this.mensajes = [...this.mensajes.slice(0, idx), { ...msg, archivo: evento.archivo }, ...this.mensajes.slice(idx + 1)]
            // documentoActivo también se fija aquí (antes no pasaba) —
            // usando evento.contenidoOriginal (el texto real que Claude
            // redactó, ver route.ts CASO 3) en vez de msg.texto, que a
            // estas alturas ya es "Documento generado correctamente."
            // Sin esto, pedir después "ahora en PDF" no tenía ningún
            // documento activo del que partir y no había forma de
            // reutilizar el contenido sin volver a pedírselo a Claude.
            this.actualizarDocumentoActivo(msg.id, evento.contenidoOriginal ?? msg.texto, evento.archivo)
          } else if (msg && esDocumentoFormal(msg.texto)) {
            this.actualizarDocumentoActivo(msg.id, msg.texto)
          } else if (msg && evento.accionNavegacion) {
            // Navegación automática ("Abre a Sergio en la lista"): se
            // deja como señal pendiente para que AsistentePanel (única
            // pieza con acceso a useRouter) haga router.push y la
            // limpie — ver limpiarNavegacionPendiente(). Consulta
            // ("Muéstrame a Sergio en la lista"): se ofrece el botón
            // "Abrir en Lista" sobre el mismo mensaje, reutilizando
            // AccionMensaje/acciones igual que la confirmación de
            // calendario — ver confirmarNavegacion().
            if (evento.accionNavegacion.automatica) {
              this.accionNavegacionPendiente = evento.accionNavegacion
            } else {
              this.mensajes = [
                ...this.mensajes.slice(0, idx),
                { ...msg, datosAccionNavegacion: evento.accionNavegacion, acciones: [{ id: 'abrir_en_lista', etiqueta: 'Abrir en Lista', estilo: 'primario' }] },
                ...this.mensajes.slice(idx + 1),
              ]
            }
          }
        }
        // Modo voz: le pide a la MISMA sesión de Realtime que lea en voz
        // alta la respuesta real que acaba de llegar (ver
        // MotorOpenAIRealtime.reproducirRespuestaEnVoz — "Rediseñar el
        // modo voz como conversación continua"). Todo el ciclo de vida
        // de esa lectura (estado 'hablando', barge-in, vuelta a
        // 'escuchando' al terminar) lo maneja el propio motor a través
        // de response.done — este método no necesita saber nada más.
        if (this.modoVoz) this.motorVoz?.reproducirRespuestaEnVoz(evento.texto)
        this.notificar()
        break
      }
      case 'error': {
        this.generando = false
        this.estadoMotor = 'error'
        const estabaEditandoUnDocumento = this.editandoDocumentoId !== null
        const estabaFinalizandoArchivo = this.documentoFinalizandoId !== null
        this.editandoDocumentoId = null
        this.documentoFinalizandoId = null
        this.textoDocumentoFinalizando = null
        this.turnoAbierto = null
        this.turnoUsuarioPendiente = false
        this.textoAsistentePendiente = ''
        this.finalPendiente = false
        if (estabaEditandoUnDocumento) {
          // Falla generando/editando un documento — nunca se mete al
          // chat como si fuera una respuesta del asistente. El documento
          // activo y el resto de la conversación quedan intactos;
          // reintentarGeneracion() puede volver a intentar lo mismo sin
          // que el maestro tenga que volver a escribir el mensaje.
          // evento.mensaje ya trae el detalle específico del servidor
          // cuando existe (ej. "Error detectado en el módulo DOCX") — ver
          // motorTextoClaude.enviarTexto.
          if (this.intentarReintentoAutomatico(estabaFinalizandoArchivo, evento.mensaje)) break
        } else {
          this.mensajes = [...this.mensajes, { id: nuevoId(), rol: 'asistente', texto: evento.mensaje, creadoEn: Date.now() }]
        }
        // Un turno de voz que termina en error (red, timeout, HTTP de
        // /api/chat) nunca llega a 'respuesta-final' — sin esto, el
        // motor se quedaría esperando una respuesta que nunca va a
        // pedirle que lea, y estadoEscucha quedaría pegado.
        if (this.modoVoz) this.estadoEscucha = 'escuchando'
        this.notificar()
        break
      }
      case 'debug-paso':
        this.registrarPasoDebugVoz(evento.paso, evento.resultado, evento.detalle, evento.ms)
        this.notificar()
        break
      case 'estado-escucha':
        this.estadoEscucha = evento.estado
        this.notificar()
        break
      default:
        break
    }
  }

  // --- Enviar un mensaje (texto ya resuelto, venga de teclado o de voz
  // ya transcrita) ---

  async enviarMensaje(texto: string, adjunto?: AdjuntoImagen, adjuntos?: AdjuntoImagen[]) {
    const limpio = texto.trim()
    if (!limpio || this.generando) return

    // Vista inicial (sin conversación seleccionada): escribir el primer
    // mensaje ES la acción que crea la conversación nueva — ver
    // ARQUITECTURA: "al crear una conversación nueva: 1. crear un nuevo
    // conversationId". Nunca pasa nada implícito antes de esto.
    if (!this.conversacionActivaId) {
      this.conversacionActivaId = crearNuevaConversacion()
    }

    // Verificación de calendario con foto — antes de cualquier otra
    // regla (incluida "documento activo" abajo): una foto del
    // calendario oficial nunca debe interpretarse como edición del
    // documento que se esté redactando en ese momento. Detección
    // determinista (ver esVerificacionCalendarioConImagen), no una
    // decisión de IA — igual que detectarHerramientaDocumento más
    // abajo. No toca documentoActivo ni ninguna otra rama existente.
    // Solo aplica a una foto sola (adjunto) — comparar VARIAS fotos de
    // calendario cae en la rama de varias imágenes de abajo, como
    // análisis conversacional normal, no en el flujo de botones/
    // respaldo/escritura (ese sigue siendo específico de una sola
    // foto, ver RFC del calendario).
    if (esVerificacionCalendarioConImagen(limpio, adjunto) && adjunto) {
      await this.analizarCalendarioDesdeImagen(limpio, adjunto)
      return
    }

    // Varias fotos en un mismo mensaje ("compara estas dos listas",
    // "revisa estas cuatro evidencias"...) — igual que la verificación
    // de calendario arriba, nunca se interpreta como edición del
    // documento activo: es una solicitud de análisis nueva, sin
    // importar qué se esté redactando en ese momento. Ver "Implementar
    // soporte completo para múltiples fotografías".
    if (adjuntos && adjuntos.length > 1) {
      await this.enviarConMultiplesImagenes(limpio, adjuntos)
      return
    }

    // Con un documento activo: primero se revisa si el mensaje nombra un
    // formato de archivo real ("Word", "archivo Word", "DOCX", "a PDF",
    // "descárgalo"...) — eso es FINALIZAR ARCHIVO, se genera el archivo
    // real directo, sin pasar por el modelo grande (ver
    // enviarComoFinalizacion), y NUNCA se vuelve a narrar el contenido en
    // el chat. Si el mensaje NO pide un formato, se entiende como una
    // MODIFICACIÓN de ese mismo documento — sin importar cómo esté
    // redactada ("agrégale...", "que tenga...", "hazlo para tercer
    // grado...", "corrige ortografía..."): mientras exista un documento
    // activo, cualquier mensaje que no sea una petición de archivo
    // trabaja sobre él, nunca abre uno nuevo ni exige un verbo
    // específico al inicio.
    if (this.documentoActivo) {
      const tipoFinalizar = detectarHerramientaDocumento(limpio)
      if (tipoFinalizar) {
        // Resolución del archivo referenciado: si el maestro nombró un
        // formato real ("a PDF", "en power poin"), ese es el que pide.
        // Si solo dijo algo genérico ("descárgalo", "ábrelo", "el
        // archivo"), detectarHerramientaDocumento cae al default fijo
        // ('word') — pero lo correcto es el ÚLTIMO formato que ya se
        // generó para este documento, no siempre Word (ver "resolución
        // del archivo referenciado").
        const formatoExplicito = detectarFormatoExplicito(limpio)
        const tipoResuelto = formatoExplicito ?? (this.documentoActivo.ultimoFormatoGenerado as TipoHerramienta | undefined) ?? tipoFinalizar
        await this.ejecutarConversionFormato(tipoResuelto, limpio)
        return
      }
      await this.enviarComoEdicion(this.documentoActivo.id, limpio, this.construirPromptEdicion(this.documentoActivo.texto, limpio), adjunto)
      return
    }

    await this.asegurarMotor()
    this.sincronizarHistorialTexto()
    this.transcripcionParcial = ''
    this.mensajes = [...this.mensajes, { id: nuevoId(), rol: 'usuario', texto: limpio, creadoEn: Date.now(), imagen: adjunto }]
    this.turnoAbierto = null
    this.notificar()

    try {
      await (await this.motorDeContenido())?.enviarTexto(limpio, adjunto)
    } catch {
      this.manejarEventoMotor({ tipo: 'error', mensaje: 'No se pudo conectar con el asistente. Intenta de nuevo.' })
    }
  }

  // Mismo camino que el envío normal de arriba (asegurarMotor,
  // sincronizarHistorialTexto, empujar el mensaje, notificar, motor.
  // enviarTexto con manejo de error idéntico) — la única diferencia es
  // que el mensaje lleva `imagenes` (plural) en vez de `imagen`, y el
  // motor recibe el arreglo completo como quinto argumento para que
  // /api/chat construya varios bloques de imagen en una sola llamada a
  // Claude (ver motorTextoClaude.ts y app/api/chat/route.ts). Pasa por
  // el MISMO MotorConversacional que el chat de siempre — respuesta en
  // streaming, reintentos, límites de tiempo, todo igual — no es un
  // canal aparte.
  private async enviarConMultiplesImagenes(texto: string, adjuntos: AdjuntoImagen[]) {
    await this.asegurarMotor()
    this.sincronizarHistorialTexto()
    this.transcripcionParcial = ''
    this.mensajes = [...this.mensajes, { id: nuevoId(), rol: 'usuario', texto, creadoEn: Date.now(), imagenes: adjuntos }]
    this.turnoAbierto = null
    this.notificar()

    try {
      await (await this.motorDeContenido())?.enviarTexto(texto, undefined, undefined, false, adjuntos)
    } catch {
      this.manejarEventoMotor({ tipo: 'error', mensaje: 'No se pudo conectar con el asistente. Intenta de nuevo.' })
    }
  }

  // Compara la foto adjunta contra el calendario real y responde con un
  // resumen ejecutivo + botones — nunca pasa por MotorTextoClaude (no
  // hay streaming aquí, la respuesta necesita llegar completa para
  // construir los botones de una sola vez). Ver
  // app/api/calendario/analizar/route.ts. Sigue exactamente el mismo
  // criterio de "nunca colgarse en silencio" que motorTextoClaude.ts:
  // sesión y fetch con límite de tiempo real, y CUALQUIER falla termina
  // en un mensaje de error visible, nunca en generando=true para
  // siempre.
  private async analizarCalendarioDesdeImagen(texto: string, adjunto: AdjuntoImagen) {
    this.mensajes = [...this.mensajes, { id: nuevoId(), rol: 'usuario', texto, creadoEn: Date.now(), imagen: adjunto }]
    this.generando = true
    this.notificar()

    const controlador = new AbortController()
    const temporizadorFetch = setTimeout(() => controlador.abort(), 55_000)

    try {
      const { user, session } = await conLimiteDeTiempoAccion(
        obtenerPerfilYSesion(),
        12_000,
        'Tiempo de espera agotado obteniendo la sesión del docente'
      )

      const res = await fetch('/api/calendario/analizar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mensaje: texto,
          imagenBase64: adjunto.base64,
          imagenTipo: adjunto.tipo,
          userId: user?.id || null,
          accessToken: session?.access_token || null,
          zonaHoraria: obtenerZonaHorariaDispositivo(),
        }),
        signal: controlador.signal,
      })

      const cuerpo = await res.json().catch(() => null)
      if (!res.ok || !cuerpo || typeof cuerpo.error === 'string') {
        throw new Error(cuerpo?.error || 'No pude analizar la imagen del calendario. Intenta de nuevo.')
      }

      const acciones: AccionMensaje[] | undefined = Array.isArray(cuerpo.acciones) && cuerpo.acciones.length > 0 ? cuerpo.acciones : undefined
      const datosAccionCalendario: DiferenciaCalendario[] | undefined =
        Array.isArray(cuerpo.datosAccionCalendario) && cuerpo.datosAccionCalendario.length > 0 ? cuerpo.datosAccionCalendario : undefined

      this.mensajes = [
        ...this.mensajes,
        { id: nuevoId(), rol: 'asistente', texto: cuerpo.texto || '', creadoEn: Date.now(), acciones, datosAccionCalendario },
      ]
    } catch (err) {
      const mensajeError =
        err instanceof Error && err.name === 'AbortError'
          ? 'El análisis del calendario tardó demasiado. Intenta de nuevo.'
          : err instanceof Error
            ? err.message
            : 'No pude analizar la imagen del calendario. Intenta de nuevo.'
      this.mensajes = [...this.mensajes, { id: nuevoId(), rol: 'asistente', texto: mensajeError, creadoEn: Date.now() }]
    } finally {
      clearTimeout(temporizadorFetch)
      this.generando = false
      this.notificar()
      this.persistirConversacion()
    }
  }

  // El docente tocó un botón de acción sobre un mensaje (ver
  // AccionMensaje) — hoy solo existen los botones del análisis de
  // calendario, pero el método queda genérico por id de acción para no
  // tener que reabrir esta pieza si mañana hay otro flujo con botones.
  // accionElegida se marca ANTES de hacer cualquier trabajo, así los
  // botones desaparecen de inmediato y el mismo mensaje nunca puede
  // confirmarse dos veces (doble toque, doble pestaña, etc.).
  async confirmarAccionCalendario(mensajeId: string, accionId: string) {
    const mensaje = this.mensajes.find((m) => m.id === mensajeId)
    if (!mensaje || mensaje.accionElegida || this.generando) return

    this.mensajes = this.mensajes.map((m) => (m.id === mensajeId ? { ...m, accionElegida: accionId } : m))
    this.notificar()
    this.persistirConversacion()

    if (accionId === 'cancelar') {
      this.mensajes = [
        ...this.mensajes,
        { id: nuevoId(), rol: 'asistente', texto: 'De acuerdo, no realicé ningún cambio en el calendario.', creadoEn: Date.now() },
      ]
      this.notificar()
      this.persistirConversacion()
      return
    }

    if (accionId !== 'actualizar_calendario') return

    const diferencias = mensaje.datosAccionCalendario
    if (!diferencias || diferencias.length === 0) {
      this.mensajes = [
        ...this.mensajes,
        { id: nuevoId(), rol: 'asistente', texto: 'No encontré los cambios pendientes de ese análisis. Envía de nuevo la foto del calendario.', creadoEn: Date.now() },
      ]
      this.notificar()
      this.persistirConversacion()
      return
    }

    this.generando = true
    this.iniciarProgresoAccionCalendario(mensajeId)

    const controlador = new AbortController()
    const temporizadorFetch = setTimeout(() => controlador.abort(), 55_000)

    try {
      const { user, session } = await conLimiteDeTiempoAccion(
        obtenerPerfilYSesion(),
        12_000,
        'Tiempo de espera agotado obteniendo la sesión del docente'
      )

      const res = await fetch('/api/calendario/aplicar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diferencias, userId: user?.id || null, accessToken: session?.access_token || null }),
        signal: controlador.signal,
      })

      const cuerpo = await res.json().catch(() => null)
      if (!res.ok || !cuerpo || typeof cuerpo.error === 'string') {
        throw new Error(cuerpo?.error || 'No pude actualizar el calendario. Intenta de nuevo.')
      }

      const archivo: ArchivoGeneradoInfo | undefined = cuerpo.archivoRespaldo || undefined
      this.mensajes = [
        ...this.mensajes,
        { id: nuevoId(), rol: 'asistente', texto: cuerpo.texto || '✅ Calendario actualizado correctamente.', creadoEn: Date.now(), archivo },
      ]
    } catch (err) {
      const mensajeError =
        err instanceof Error && err.name === 'AbortError'
          ? 'La actualización del calendario tardó demasiado. Intenta de nuevo.'
          : err instanceof Error
            ? err.message
            : 'No pude actualizar el calendario. Intenta de nuevo.'
      this.mensajes = [...this.mensajes, { id: nuevoId(), rol: 'asistente', texto: `No pude actualizar el calendario: ${mensajeError}`, creadoEn: Date.now() }]
    } finally {
      clearTimeout(temporizadorFetch)
      this.detenerProgresoAccionCalendario()
      this.generando = false
      this.notificar()
      this.persistirConversacion()
    }
  }

  // El docente tocó "Abrir en Lista" sobre una consulta (ver
  // manejarEventoMotor, caso 'respuesta-final' con accionNavegacion no
  // automática) — mismo patrón que confirmarAccionCalendario: se marca
  // accionElegida de inmediato para que el botón no se pueda tocar dos
  // veces, y se deja la acción como pendiente para que AsistentePanel
  // (única pieza con useRouter) haga el router.push real.
  confirmarNavegacion(mensajeId: string) {
    const mensaje = this.mensajes.find((m) => m.id === mensajeId)
    if (!mensaje || mensaje.accionElegida || !mensaje.datosAccionNavegacion) return
    this.mensajes = this.mensajes.map((m) => (m.id === mensajeId ? { ...m, accionElegida: 'abrir_en_lista' } : m))
    this.accionNavegacionPendiente = mensaje.datosAccionNavegacion
    this.notificar()
    this.persistirConversacion()
  }

  // AsistentePanel llama esto justo después de hacer router.push, para
  // que la navegación nunca se repita si el snapshot se vuelve a leer
  // (ej. al volver a montar el efecto).
  limpiarNavegacionPendiente() {
    this.accionNavegacionPendiente = null
    this.notificar()
  }

  // Resolución del archivo referenciado (ver "no regenerar archivos
  // existentes") extraída como pieza única — la usan tanto el mensaje
  // de texto normal ("conviértelo a PDF") como convertirDocumentoActivo
  // (botón "Convertir a..." de la tarjeta universal), para que ambos
  // caminos compartan exactamente la misma lógica de caché/finalización
  // en vez de duplicarla.
  private async ejecutarConversionFormato(tipoResuelto: TipoHerramienta, textoVisible: string) {
    if (!this.documentoActivo) return
    const archivoExistente = this.documentoActivo.archivosGenerados?.[tipoResuelto]
    if (archivoExistente) {
      this.reutilizarArchivoExistente(textoVisible, archivoExistente)
      return
    }
    await this.enviarComoFinalizacion(this.documentoActivo.id, textoVisible, tipoResuelto, this.documentoActivo.texto)
  }

  // El docente tocó "Convertir a X" en la tarjeta universal del
  // documento (ver TarjetaDescarga en AsistentePanel.tsx) — misma
  // acción que escribir "conviértelo a X" en el chat, solo que el
  // formato ya viene resuelto desde el botón. Solo actúa si idDocumento
  // sigue siendo el Documento Activo: evita convertir el documento
  // equivocado si el docente generó otro distinto entre que vio la
  // tarjeta y tocó el botón (doble toque tardío, tarjeta vieja en
  // pantalla mientras se hace scroll hacia arriba, etc.).
  private static readonly ETIQUETA_FORMATO: Record<TipoHerramienta, string> = {
    word: 'Word', pdf: 'PDF', powerpoint: 'PowerPoint', excel: 'Excel', imagen: 'imagen', audio: 'audio', video: 'video',
  }
  async convertirDocumentoActivo(idDocumento: string, tipo: TipoHerramienta) {
    if (!this.documentoActivo || this.documentoActivo.id !== idDocumento || this.generando) return
    await this.ejecutarConversionFormato(tipo, `Conviértelo a ${AsistenteServiceImpl.ETIQUETA_FORMATO[tipo]}.`)
  }

  // Fuente única para "fijar" documentoActivo — un borrador nuevo, una
  // finalización a archivo, una edición de contenido por IA, o una
  // edición manual (ver los 4 lugares que la llaman) todas pasan por
  // aquí. Decide si la caché de archivos ya generados (archivosGenerados)
  // se conserva o se invalida: se conserva SOLO si es literalmente el
  // mismo documento (mismo id) con el mismo texto — cualquier cambio
  // real de contenido vuelve obsoletos los archivos ya generados para
  // la versión anterior (ver "conversión entre formatos" vs "nueva
  // versión modificada").
  private actualizarDocumentoActivo(id: string, texto: string, archivoNuevo?: ArchivoGeneradoInfo) {
    const mismoDocumentoSinCambios = this.documentoActivo?.id === id && this.documentoActivo?.texto === texto
    const archivosPrevios = mismoDocumentoSinCambios ? (this.documentoActivo?.archivosGenerados ?? {}) : {}
    const archivosGenerados = archivoNuevo ? { ...archivosPrevios, [archivoNuevo.tipo]: archivoNuevo } : archivosPrevios
    const ultimoFormatoGenerado = archivoNuevo?.tipo ?? (mismoDocumentoSinCambios ? this.documentoActivo?.ultimoFormatoGenerado : undefined)
    this.documentoActivo = { id, texto, archivosGenerados, ultimoFormatoGenerado }
  }

  // Edición manual directa (botón "Editar"): sobrescribe el texto sin
  // pasar por el modelo.
  actualizarMensaje(id: string, nuevoTexto: string) {
    this.mensajes = this.mensajes.map(m => (m.id === id ? { ...m, texto: nuevoTexto } : m))
    if (this.documentoActivo?.id === id) this.actualizarDocumentoActivo(id, nuevoTexto)
    this.notificar()
  }

  // Ampliado (ver "Motor de interpretación de intención y edición del
  // Documento Activo") con dos párrafos nuevos: completado profesional
  // ante instrucciones vagas, e interpretación de una foto adjunta
  // como el mismo documento en vez de un tema nuevo. El resto del
  // prompt (formato de salida, MODO DOCUMENTO) queda intacto a
  // propósito — sigue siendo el mismo camino de edición que ya
  // funciona, solo con más criterio para decidir QUÉ escribir.
  private construirPromptEdicion(documentoTexto: string, instruccion: string): string {
    return `El maestro pidió modificar/convertir el siguiente documento que ya se venía trabajando en esta conversación (aunque todavía no estuviera en el formato final de documento). Devuelve el documento COMPLETO ya actualizado, empezando DIRECTAMENTE con su título en mayúsculas y emoji (MODO DOCUMENTO) — nunca antes con una frase de confirmación, ni narrando de nuevo el contenido en prosa conversacional, ni explicando qué vas a hacer: la respuesta ES el documento, de principio a fin, sin nada más. Si la instrucción pide imágenes o ilustraciones, usa íconos y emoji relevantes para dar esa sensación visual dentro del texto — nunca respondas que no puedes generar imágenes.

Si la instrucción es vaga o pide completar/mejorar el documento en general ("complétalo", "llénalo", "hazlo formal", "termínalo", "arréglalo", "redáctalo", "pon lo que falta", "hazlo mejor", "corrígelo", "ponlo bonito", "perfecciónalo", "actualízalo", "modifícalo", o equivalentes): redacta tú mismo cualquier campo institucional que siga vacío o incompleto (observaciones, acuerdos, comentarios, seguimiento, conclusiones, recomendaciones, fundamento legal, etc.), con estilo profesional/institucional, coherente con el resto del documento (mismo alumno, incidente, fecha, materia y hechos ya presentes — nunca inventes datos que no estén ahí ni en la conversación). Nunca dejes marcadores genéricos como "Pendiente", "Opcional", "Escriba aquí" o similar, y nunca preguntes qué escribir — el maestro espera que completes esas partes con tu propio criterio profesional, no que se lo devuelvas sin terminar.

Si el mensaje trae una foto adjunta, en la gran mayoría de los casos esa foto ES este mismo documento (una captura de pantalla, una foto del papel ya impreso o firmado, una foto de lo que el maestro escribió a mano) — a menos que el maestro claramente esté pidiendo comparar o analizar algo distinto, interprétala como parte de este documento (para copiar datos que aparecen en ella, verificar que coincide, o completar/corregir con base en lo que se ve) y no como un tema nuevo e independiente.

DOCUMENTO/CONTENIDO ACTUAL:
${documentoTexto}

INSTRUCCIÓN DEL MAESTRO:
${instruccion}`
  }

  // El motor de texto necesita ver la conversación real (turnos previos)
  // para no "olvidar" de qué se está hablando entre un mensaje y el
  // siguiente — se sincroniza con el historial de ANTES de agregar el
  // mensaje que se está por enviar (ese va aparte, como el turno actual).
  // No tiene efecto en el motor de voz (la sesión de Realtime ya es
  // stateful del lado del servidor mientras dura la llamada).
  private sincronizarHistorialTexto() {
    this.motorTexto?.establecerHistorial(this.mensajes.slice(-20))
  }

  private async enviarComoEdicion(idDocumento: string, textoVisible: string, textoParaModelo: string, adjunto?: AdjuntoImagen) {
    await this.asegurarMotor()
    this.sincronizarHistorialTexto()
    this.transcripcionParcial = ''
    this.mensajes = [...this.mensajes, { id: nuevoId(), rol: 'usuario', texto: textoVisible, creadoEn: Date.now(), imagen: adjunto }]
    this.editandoDocumentoId = idDocumento
    // Se guarda para poder reintentar exactamente esto mismo si falla —
    // ver reintentarGeneracion(). Se limpia solo cuando la edición
    // termina bien (ver 'respuesta-final').
    this.ultimoIntentoEdicion = { idDocumento, textoParaModelo, adjunto }
    this.notificar()
    await this.ejecutarEdicion(textoParaModelo, adjunto)
  }

  // Aislado de enviarComoEdicion() para que reintentarGeneracion() pueda
  // reusarlo sin repetir la burbuja del docente (ya está en pantalla de
  // la vez anterior) ni perder this.ultimoIntentoEdicion.
  private async ejecutarEdicion(textoParaModelo: string, adjunto?: AdjuntoImagen) {
    try {
      // OJO: editandoDocumentoId NO se limpia aquí en el catch — lo hace
      // el propio manejador de 'error' (ver manejarEventoMotor), que
      // necesita verlo todavía puesto para saber que esto fue una falla
      // de documento y mostrar el aviso breve en vez de una burbuja.
      // esEdicionDocumento=true: textoParaModelo es un prompt interno
      // (construirPromptEdicion), no algo que el maestro escribió — jamás
      // debe interpretarse en /api/chat como una solicitud de archivo
      // (ver esEdicionDocumento en app/api/chat/route.ts).
      await (await this.motorDeContenido())?.enviarTexto(textoParaModelo, adjunto, undefined, true)
    } catch {
      this.manejarEventoMotor({ tipo: 'error', mensaje: 'No pude generar el archivo. Toca para reintentar.' })
    }
  }

  // "No regenerar archivos existentes": el maestro pidió un formato que
  // YA está listo para el documento activo — se reutiliza tal cual, sin
  // tocar la red, sin volver a invocar a Claude, sin volver a generar
  // el archivo ni subir nada a Storage. Sincrónico y siempre exitoso
  // (no hay nada que pueda fallar aquí — el archivo ya existe).
  private reutilizarArchivoExistente(textoVisible: string, archivo: ArchivoGeneradoInfo) {
    const idMensaje = nuevoId()
    this.mensajes = [
      ...this.mensajes,
      { id: nuevoId(), rol: 'usuario', texto: textoVisible, creadoEn: Date.now() },
      { id: idMensaje, rol: 'asistente', texto: 'Ya puedes abrirlo, compartirlo o descargarlo.', creadoEn: Date.now(), archivo },
    ]
    this.turnoAbierto = null
    // Señal de una sola vez (se apaga sola) para que AsistentePanel baje
    // el scroll y resalte la tarjeta — ver mostrarArchivoReutilizado().
    this.mostrarArchivoReutilizado(idMensaje)
    this.notificar()
  }

  // Genera el archivo real del documento activo (Word/PDF/PowerPoint/
  // Excel) — a diferencia de enviarComoEdicion, esto NUNCA pasa por el
  // modelo grande: el contenido ya se acordó en la conversación, así que
  // es una acción mecánica de servidor (ver FINALIZAR ARCHIVO en
  // app/api/chat/route.ts). Siempre se manda por el motor de TEXTO
  // (POST directo a /api/chat) sin importar si el docente está en modo
  // voz — Realtime no tiene una ruta equivalente todavía.
  private async enviarComoFinalizacion(idDocumento: string, textoVisible: string, tipo: TipoHerramienta, documentoTexto: string) {
    await this.asegurarMotor()
    this.sincronizarHistorialTexto()
    this.transcripcionParcial = ''
    this.mensajes = [...this.mensajes, { id: nuevoId(), rol: 'usuario', texto: textoVisible, creadoEn: Date.now() }]
    this.editandoDocumentoId = idDocumento
    this.documentoFinalizandoId = idDocumento
    this.textoDocumentoFinalizando = documentoTexto
    // Nueva finalización — cuenta desde cero para su propio ciclo de
    // hasta 3 intentos automáticos (ver intentarReintentoAutomatico()).
    this.intentosFinalizacionActual = 0
    // Se guarda para poder reintentar exactamente esto mismo si falla —
    // ver reintentarGeneracion().
    this.ultimoIntentoEdicion = { idDocumento, textoParaModelo: '', finalizarArchivo: { tipo, documentoTexto, textoOriginal: textoVisible } }
    this.notificar()
    await this.ejecutarFinalizacion(tipo, documentoTexto, textoVisible)
  }

  // Aislado igual que ejecutarEdicion(), para que reintentarGeneracion()
  // lo reuse. Va siempre por this.motorTexto (nunca this.motor) porque
  // la finalización de archivo es una llamada HTTP directa a /api/chat,
  // no una conversación de voz en tiempo real.
  private async ejecutarFinalizacion(tipo: TipoHerramienta, documentoTexto: string, textoOriginal: string) {
    try {
      const motorTexto = await this.asegurarMotorTexto()
      await motorTexto.enviarTexto(textoOriginal, undefined, { tipo, documentoTexto })
    } catch {
      this.manejarEventoMotor({ tipo: 'error', mensaje: 'No pude generar el archivo. Toca para reintentar.' })
    }
  }

  // Reintenta la última generación/edición de documento que falló, sin
  // que el maestro tenga que volver a escribir el mensaje — el documento
  // activo y el resto de la conversación se conservan tal cual.
  async reintentarGeneracion() {
    if (!this.ultimoIntentoEdicion) return
    const { idDocumento, textoParaModelo, adjunto, finalizarArchivo } = this.ultimoIntentoEdicion
    this.avisoGeneracion = null
    if (this.avisoGeneracionTimer) {
      clearTimeout(this.avisoGeneracionTimer)
      this.avisoGeneracionTimer = null
    }
    await this.asegurarMotor()
    this.editandoDocumentoId = idDocumento
    if (finalizarArchivo) {
      this.documentoFinalizandoId = idDocumento
      this.textoDocumentoFinalizando = finalizarArchivo.documentoTexto
    }
    this.notificar()
    if (finalizarArchivo) {
      await this.ejecutarFinalizacion(finalizarArchivo.tipo, finalizarArchivo.documentoTexto, finalizarArchivo.textoOriginal)
    } else {
      await this.ejecutarEdicion(textoParaModelo, adjunto)
    }
  }

  interrumpir() {
    this.motor?.interrumpir()
  }
}

// Instancia única de todo el proceso del navegador — se crea una sola vez
// al cargar el módulo, no dentro de ningún componente de React.
export const AsistenteService = new AsistenteServiceImpl()

if (typeof document !== 'undefined') {
  // El caso real reportado: el docente minimiza, cambia de app o el
  // sistema suspende la pestaña — todo eso dispara "hidden" ANTES de que
  // el proceso pueda morir, a diferencia de un simple cierre de pestaña
  // (donde ya no hay nada que hacer). El guardado normal ya tiene
  // debounce de 300ms; esto fuerza el guardado inmediato justo en ese
  // instante para no perder los últimos cambios si el sistema recarga la
  // página al volver.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) AsistenteService.guardarInmediatamente()
  })
}

// Un dispositivo compartido entre dos docentes (equipo de la escuela)
// nunca debe arrastrar la conversación de quien cerró sesión a quien
// entra después — el logout de esta app (ver app/dashboard/page.tsx) es
// una navegación de cliente (router.push), no una recarga completa, así
// que el singleton sigue vivo en memoria a menos que se limpie aquí.
supabase.auth.onAuthStateChange((evento) => {
  if (evento === 'SIGNED_OUT') AsistenteService.limpiarConversacionGuardada()
  // Cubre el login real y la restauración de sesión desde storage al
  // recargar la pestaña — ambos casos pueden dejar EstadoAsistente.perfil
  // en null (sesión aún no existía cuando el constructor la pidió).
  if (evento === 'SIGNED_IN' || evento === 'INITIAL_SESSION' || evento === 'TOKEN_REFRESHED') AsistenteService.recargarPerfil()
})
