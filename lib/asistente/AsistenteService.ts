// lib/asistente/AsistenteService.ts
//
// Instancia única para toda la aplicación (no ligada a ningún componente
// de pantalla). Vive mientras la pestaña esté abierta, conserva el
// historial completo de la conversación y el contexto activo (pantalla,
// alumno, documento) aunque el docente navegue entre módulos. La UI
// (AsistentePanel) solo lee este estado a través de useSyncExternalStore
// — nunca lo posee.

import { supabase } from '@/lib/supabaseClient'
import { MENSAJE_CONVERSACION_ELIMINADA } from '@/lib/vinculoConversacion'
import { MotorTextoClaude } from './motores/motorTextoClaude'
import { ConexionCanceladaError, MotorOpenAIRealtime } from './motores/motorOpenAIRealtime'
import { AVISO_ARCHIVO_LISTO, detectarFormatoExplicito, detectarHerramientaDocumento, detectarSolicitudVersion, destinoNombrado, esConsultaDocumentoActual, esDocumentoFormal, pideOperacionDocumento, respuestaAclaracionDocumento, respuestaAclaracionVersion, tituloNombraTipo, type SolicitudVersion, MENSAJE_ARCHIVO_SIN_SESION, esPedidoDocumentoNuevo, construirPromptEdicion, esEdicionConFormato, referenciaCompatibleConDocumento, identificadorDeDocumento, documentoTieneIdentificador, nombraOtroDocumento, refiereColeccionDeDocumentos, type FormatoEntrega, type TipoHerramienta } from './documentos'
import { obtenerPerfilYSesion, type PerfilDocente } from './perfilDocente'
import { fechaISOHoy, obtenerZonaHorariaDispositivo } from '@/lib/tiempo/TimeService'
import { esVerificacionCalendarioConImagen } from '@/lib/calendario/analisisCalendario'
import { detectarAprobarPlaneacion } from '@/lib/planeacion/detectarAprobarPlaneacion'
import { esBorradorPlaneacion } from '@/lib/planeacion/extraerBorrador'
import type { MarcaTurno } from './textoFinalChat'
import { consultaPlaneacionEnServidor } from '@/lib/planeacion/detectarConsultaPlaneacion'
import {
  asegurarConversacionRemota,
  cargarConversacionPorId,
  combinarConversaciones,
  combinarMensajes,
  conversacionesLocalesEliminadas,
  conversacionesRemotasSinCopiaLocal,
  crearNuevaConversacion,
  contenidoDocumentoDe,
  descargarConversacionRemota,
  documentoRaizDe,
  documentosDeConversacion,
  elegirDocumentoActivo,
  leerIndiceDocumental,
  leerMensajesRemotosPorId,
  resolverDocumentoVigente,
  TOPE_MENSAJES,
  documentoVigente,
  eliminarConversacionGlobal,
  establecerConversacionActiva,
  guardarConversacion,
  guardarMensajesRemotos,
  idRemotoDe,
  registrarMensajeDelServidor,
  sinRespuestasPendientesResueltas,
  turnosPorRecuperar,
  listarConversaciones,
  propietarioLocal,
  establecerPropietarioLocal,
  resolverPropietariosLocales,
  migrarHistorialLocal,
  registrarAlRetirarConversacion,
  reintentarMensajesRemotosPendientes,
  retirarConversacionLocal,
  sincronizarConversacionRemota,
  type ConversacionResumen,
  type DocumentoActivoGuardado,
} from './persistencia'
import type {
  AccionMensaje,
  AccionNavegacion,
  AdjuntoImagen,
  ArchivoGeneradoInfo,
  ContextoAplicacion,
  DiagnosticoArranqueVoz,
  DiferenciaCalendario,
  EstadoMotor,
  EventoMotor,
  Herramienta,
  MensajeConversacion,
  MotorConversacional,
  TurnoSolicitud,
} from './tipos'
import { MENSAJE_PROPUESTA_VENCIDA } from './tipos'
import { CONTEXTO_VACIO } from './tipos'

// Espera máxima para confirmar la copia remota antes de aprobar una planeación.
const LIMITE_PERSISTENCIA_ANTES_DE_APROBAR_MS = 5000
// Turnos duraderos (lib/chat/turnosChat.ts): consultas de recuperación
// espaciadas (y se detienen al terminar el turno o tras el límite: el
// turno del servidor ya habrá vencido como interrumpido).
// (Exportadas para que las pruebas puedan acortarlas.)
export const ESPERAS_RECUPERACION_MS = [2_000, 3_000, 5_000, 8_000, 13_000, 15_000]
export const LIMITES_RECUPERACION = { totalMs: 5 * 60_000, respaldoConAvisosMs: 15_000 }
const LIMITE_CONSULTA_TURNO_MS = 10_000
// Texto compacto junto al botón «Reintentar» bajo el mensaje del docente.
export const TEXTO_REINTENTO_TURNO = { fallido: 'No se completó la respuesta', no_enviado: 'No se envió', ocupada: 'Esperaba la respuesta anterior' } as const
type TurnoConsultado = { estado: 'queued' | 'generating' | 'completed' | 'failed'; mensaje_asistente_id: string | null; codigo_error: string | null }

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

// Al cargar el módulo no se lee ninguna conversación: todavía no se sabe
// qué docente tiene la sesión. Tampoco se selecciona ninguna
// automáticamente: el docente decide cuál abrir (ver abrirConversacion) o
// si empieza una nueva escribiendo (ver enviarMensaje) — el Chat IA
// siempre monta en su vista inicial.
// Aislamiento por docente: la lista empieza vacía y solo se llena cuando
// se confirma la sesión (ver cambiarDeDocente).
const INDICE_CONVERSACIONES_INICIAL: ConversacionResumen[] = []

export type EstadoAsistente = {
  mensajes: MensajeConversacion[]
  contexto: ContextoAplicacion
  estadoMotor: EstadoMotor
  panelAbierto: boolean
  generando: boolean
  // Turno duradero cuya respuesta se está recuperando del servidor (se
  // perdió el stream, se recargó o se volvió del segundo plano): la
  // interfaz muestra el mismo indicador que al generar.
  recuperandoRespuesta: boolean
  transcripcionParcial: string
  modoVoz: boolean
  // Aviso breve y temporal para fallas de CONEXIÓN de voz (nunca se
  // guarda en el historial de mensajes — no es una respuesta del
  // asistente, es un estado transitorio de la interfaz). Se muestra junto
  // al botón del micrófono y desaparece solo. Ver mostrarAvisoVoz().
  avisoVoz: string | null
  // Panel técnico TEMPORAL (ver "Capturar el error real de arranque de
  // voz directamente desde el iPhone") — a diferencia de debugVoz, este
  // SIEMPRE se muestra en AsistentePanel cuando arrancar la voz falla,
  // sin necesitar ?voiceDebug=1. null en cuanto se intenta de nuevo o
  // la conexión tiene éxito. Quitar junto con AsistentePanel cuando ya
  // no haga falta diagnosticar en el propio dispositivo.
  diagnosticoArranqueVoz: DiagnosticoArranqueVoz | null
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
  // Mensaje cuya propuesta de lista oficial se está aplicando ahora mismo
  // (ver confirmarPropuestaLista) — null el resto del tiempo.
  propuestaListaEnCurso: string | null
  // Acción de navegación automática pendiente de ejecutar — null el
  // resto del tiempo. Solo AsistentePanel (única pieza con useRouter)
  // la consume: al verla distinta de null, hace router.push y llama a
  // limpiarNavegacionPendiente(). Ver "Integración de comandos
  // verbales con navegación y consulta interna".
  accionNavegacionPendiente: AccionNavegacion | null
  // Id del mensaje que sostiene el Documento Activo — null cuando no
  // hay ninguno. Solo el id (no el objeto completo): la tarjeta
  // universal (TarjetaDescarga) lo usa únicamente para saber si SU
  // mensaje es el activo (mostrar el distintivo "Documento activo"),
  // nunca para leer el texto del documento — ver "Ajustes sobre el
  // sistema de generación y manejo de documentos".
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

// Eliminar conversaciones en las Previews de Vercel solo está disponible
// en la rama cuya base E2E ya tiene la eliminación global (etapa 3B-1,
// migración 20261112000000). Las Previews de otras ramas la mantienen
// desactivada: allí borrar solo la copia local haría que la conversación
// reapareciera desde Supabase. En Production y en local no cambia nada.
const RAMA_CON_ELIMINACION_GLOBAL = 'fix/chat-documento-nuevo-contextual'
export const ELIMINAR_CONVERSACION_DISPONIBLE =
  process.env.NEXT_PUBLIC_VERCEL_ENV !== 'preview' || process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_REF === RAMA_CON_ELIMINACION_GLOBAL

// El sufijo aleatorio evita que dos dispositivos que continúan la misma
// conversación generen el mismo id (mismo milisegundo y contador).
let contadorId = 0
const sufijoAleatorio = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(36).padStart(2, '0')).join('')
const nuevoId = () => `msg-${Date.now()}-${contadorId++}-${sufijoAleatorio()}`
// Fecha de creación de cada mensaje nuevo (P2c): nunca repite ni retrocede
// en este dispositivo, así una pregunta y su respuesta creadas en el mismo
// milisegundo conservan su orden en cualquier otro dispositivo.
let ultimaMarca = 0
const marcaTiempo = () => (ultimaMarca = Math.max(Date.now(), ultimaMarca + 1))

// Propuestas de lista oficial (ver confirmarPropuestaLista): códigos de
// /api/lista-oficial/aplicar que no invalidan la propuesta.
const CODIGOS_PROPUESTA_REINTENTABLES = new Set(['SESION_INVALIDA', 'NO_DISPONIBLE', 'ERROR_TEMPORAL'])

// Antes de enviar a la IA (fase 3A), la conversación se sincroniza si
// su última sincronización exitosa tiene más de VIGENCIA_SINCRONIZACION_MS
// (en la práctica, en casi cada turno: 3 lecturas ligeras), esperando
// como máximo ESPERA_SINCRONIZACION_ENVIO_MS.
const VIGENCIA_SINCRONIZACION_MS = 15_000
// Al volver a la app (fase 3B): una ausencia más corta que esto (cambio
// breve de pestaña o de app) no consulta.
const AUSENCIA_MINIMA_MS = 5_000
const ESPERA_SINCRONIZACION_ENVIO_MS = 2_500
// Único error que emite MotorOpenAIRealtime (conexión de voz): no es la
// respuesta de una solicitud.
const MENSAJE_VOZ_PERDIDA = 'Se perdió la conexión de voz. Toca para reintentar.'
// Resultado de elegir una versión (P2c): el id elegido, o un aviso (con los
// candidatos de una aclaración, si la respuesta puede completarla).
type SeleccionVersion = { id: string; distinto: boolean } | { aviso: string; aclaracion?: NonNullable<MensajeConversacion['aclaracionVersion']> }

// Respuesta a una solicitud que nombra un documento o versión anterior
// (P2a): todavía no se identifica ese referente de forma segura; nada
// cambia, nada se genera y no se llama a la IA.
const RESPUESTA_SOLICITUD_VERSION = {
  restaurar: 'Necesito identificar con seguridad qué documento o versión anterior quieres recuperar. No cambié el documento actual ni generé ningún archivo.',
  consultar: 'Necesito identificar con seguridad qué documento o versión anterior quieres ver. Sigue más arriba en esta conversación; no cambié el documento actual.',
  convertir: 'Necesito identificar con seguridad qué documento o versión anterior quieres convertir. No generé ningún archivo ni cambié el documento actual.',
  editar: 'Necesito identificar con seguridad qué documento o versión anterior quieres modificar. No modifiqué ningún documento.',
  ambigua: 'Necesito identificar qué documento o versión anterior quieres y qué deseas hacer con él. No cambié el documento actual ni generé ningún archivo.',
} as const
// Restauración de versiones (P2c-1).
const MENSAJE_VERSION_ANTERIOR_RESTAURADA = 'Volví a la versión anterior del documento. Los siguientes cambios y archivos partirán de ella.'
const MENSAJE_PRIMERA_VERSION_RESTAURADA = 'Volví a la primera versión del documento. Los siguientes cambios y archivos partirán de ella.'
const MENSAJE_DOCUMENTO_ANTERIOR_RESTAURADO = 'Volví al documento anterior. Los siguientes cambios y archivos partirán de él.'
const MENSAJE_VERSION_ANTERIOR_CONSULTADA = 'Esta es la versión anterior del documento; la resalté más arriba. No cambié el documento actual.'
const MENSAJE_PRIMERA_VERSION_CONSULTADA = 'Esta es la primera versión del documento; la resalté más arriba. No cambié el documento actual.'
const MENSAJE_DOCUMENTO_ANTERIOR_CONSULTADO = 'Este es el documento anterior; lo resalté más arriba. No cambié el documento actual.'
const ACLARAR_TIPO_NOMBRADO = 'El documento actual no corresponde al que mencionas, así que no sé a qué documento te refieres. No cambié nada.'
const ACLARAR_VERSION_O_DOCUMENTO = '¿Te refieres a una versión anterior de este mismo documento o a otro documento de la conversación? Dime "la versión anterior", "la primera versión" o "el otro documento". No cambié nada.'
const ACLARAR_CUAL_DOCUMENTO = 'Hay varios documentos anteriores en esta conversación y no puedo saber a cuál te refieres. No cambié nada.'
const ACLARAR_RAMA = 'Esta versión se restauró: ¿quieres la versión anterior en su historial o la que usabas antes de restaurarla? No cambié nada.'
const PRECISAR_VERSION_O_DOCUMENTO = '¿La versión anterior de este documento o el otro documento?'
const PRECISAR_RAMA = '¿La versión anterior en su historial o la que usabas antes de restaurarla?'
const MENSAJE_DOCUMENTO_ACTUAL_CONSULTADO = 'Este es el documento actual; lo resalté más arriba.'
const MENSAJE_SIN_OTRO_DOCUMENTO = 'No encontré otro documento en esta conversación, así que no cambié nada.'
const MENSAJE_SIN_VERSION_ANTERIOR = 'No hay una versión anterior registrada de este documento, así que no cambié nada.'
const MENSAJE_VERSION_NO_DISPONIBLE = 'Esa versión no está disponible en esta conversación en este dispositivo, así que no cambié el documento actual.'
const MENSAJE_VERSION_NO_RECUPERADA = 'La versión que se restauró de este documento no está disponible en este dispositivo, así que todavía no puedo usarla. No modifiqué nada.'
const MENSAJE_DOCUMENTO_SIN_VERIFICAR = 'No se pudo comprobar si este documento cambió en otro dispositivo. Revisa tu conexión e intenta de nuevo.'
// Documento al que se refiere el docente (P3a).
const MENSAJE_DOCUMENTO_ELEGIDO_NO_RECUPERADO = 'El documento que se eligió no está disponible en este dispositivo, así que todavía no puedo usarlo. No modifiqué nada.'
const MENSAJE_DOCUMENTO_NOMBRADO_CONSULTADO = 'Este es el documento que mencionas; lo resalté más arriba. No cambié el documento actual.'
const MENSAJE_DOCUMENTO_NOMBRADO_NO_DISPONIBLE = 'Ese documento no está disponible en esta conversación en este dispositivo, así que no cambié nada.'
const MENSAJE_ORDINAL_INCOMPLETO = 'Esta conversación es larga y en este dispositivo no tengo todos sus documentos, así que no puedo saber cuál es por su orden. Dime su título. No cambié nada.'
// Tiempo máximo para leer el índice documental (P3b); si se excede, sigue
// la protección de P3a.
const LIMITE_INDICE_DOCUMENTAL_MS = 6000
const MENSAJE_ORDINAL_INEXISTENTE = 'No encuentro ese documento en esta conversación, así que no cambié nada.'
const PRECISAR_DOCUMENTO = '¿Cuál de ellos? Responde con el número de la lista o con «el más reciente». No cambié nada.'
const NOMBRE_TIPO: Record<string, [string, string]> = {
  oficio: ['un', 'oficio'], examen: ['un', 'examen'], citatorio: ['un', 'citatorio'], planeacion: ['una', 'planeación'], rubrica: ['una', 'rúbrica'], resumen: ['un', 'resumen'], carta: ['una', 'carta'],
  circular: ['una', 'circular'], ficha: ['una', 'ficha'], reporte: ['un', 'reporte'], informe: ['un', 'informe'], presentacion: ['una', 'presentación'], aviso: ['un', 'aviso'],
}
function sinDocumentoDelTipo(tipo: string, incompleta: boolean): string {
  const [articulo, nombre] = NOMBRE_TIPO[tipo] ?? ['un', tipo]
  return `No encuentro ${articulo} ${nombre} en esta conversación, así que no cambié nada.${incompleta ? ' Si está más atrás en la conversación, todavía no puedo ubicarlo desde aquí.' : ''}`
}
// Título legible de un documento (su primera línea, sin emoji ni formato).
function tituloVisible(titulo: string): string {
  const limpio = titulo.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[*_#]+/g, '').trim()
  return limpio.length > 70 ? `${limpio.slice(0, 67)}…` : limpio || 'Documento sin título'
}
// Con títulos repetidos, la lista agrega la fecha de cada documento.
function aclararCualDocumento(candidatos: { titulo: string; creadoEn: number }[], incompleta: boolean): string {
  const titulos = candidatos.map((c) => c.titulo)
  if (titulos.length === 1) return `Encontré este documento entre los mensajes recientes: «${tituloVisible(titulos[0])}». Esta conversación es larga y puede haber otro más atrás. ¿Uso este? Responde «sí» o dime su título. No cambié nada.`
  const repetidos = new Set(titulos.filter((t, i) => titulos.indexOf(t) !== i))
  const fecha = (ms: number) => { const d = new Date(ms); const dos = (n: number) => String(n).padStart(2, '0'); return `${dos(d.getDate())}/${dos(d.getMonth() + 1)} ${dos(d.getHours())}:${dos(d.getMinutes())}` }
  const lista = candidatos.map((c, i) => `${i + 1}. «${tituloVisible(c.titulo)}»${repetidos.has(c.titulo) ? ` (${fecha(c.creadoEn)})` : ''}`).join('\n')
  return `Hay ${titulos.length} documentos que coinciden con lo que pides:\n${lista}\n¿Con cuál trabajo? Responde con el número o con «el más reciente».${incompleta ? ' Esta conversación es larga y puede haber otros más atrás.' : ''} No cambié nada.`
}

// Cierre de sesión seguro (etapa 3).
const LIMITE_ENVIO_AL_SALIR_MS = 4000
const MENSAJE_SALIDA_FALLIDA = 'No se pudo cerrar la sesión. Revisa tu conexión e intenta de nuevo.'
export type ResultadoCierreSesion = { ok: true } | { ok: false; mensaje: string }

// 'al_dia': Supabase respondió (con o sin novedades); 'fallo': no se
// pudo consultar; 'sin_sesion': no hay docente con quien consultar.
type EstadoSincronizacion = 'al_dia' | 'fallo' | 'eliminada' | 'sin_sesion'
export type ResultadoEnvio = 'enviado' | 'no_enviado' | 'otra_conversacion'

// Documento vigente tras incorporar mensajes de otro dispositivo: el
// último documento de la conversación (documentoVigente, también uno
// entregado directo como archivo), solo si llegó con esos mensajes (si el último es local —pendiente o en curso— el
// documento activo no cambia).
function documentoFormalSincronizado(mensajes: MensajeConversacion[], nuevos: MensajeConversacion[]): DocumentoActivoGuardado | null {
  if (nuevos.length === 0) return null
  // Lo determina el evento (una versión o una restauración), no el id de
  // la versión: una restauración vuelve vigente una versión antigua.
  const vigente = resolverDocumentoVigente(mensajes)
  return vigente && nuevos.some((m) => m.id === vigente.origenId) ? vigente.documento : null
}

// Documento activo tras incorporar mensajes: el que determinan los nuevos
// o, si el activo esperaba una versión restaurada que no estaba (P2c-2) y
// llegó con ellos, esa versión ya resuelta.
function documentoTrasIncorporar(mensajes: MensajeConversacion[], nuevos: MensajeConversacion[], activo: DocumentoActivoGuardado | null): DocumentoActivoGuardado | null {
  const determinado = documentoFormalSincronizado(mensajes, nuevos)
  if (determinado || !activo?.noRecuperado || nuevos.length === 0) return determinado
  const vigente = documentoVigente(mensajes)
  return vigente && !vigente.noRecuperado && vigente.id === activo.id ? vigente : null
}

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
  private diagnosticoArranqueVoz: DiagnosticoArranqueVoz | null = null
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
    // Edición que además pide el archivo en un formato: se reintenta igual.
    formatoEntrega?: FormatoEntrega
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
  // Documento elegido para la operación en curso (P3a): el próximo mensaje
  // del docente lo registra (documentoDestinoId) y, tras una aclaración,
  // muestra la respuesta del docente ("El segundo") en lugar de la
  // solicitud original. Si la operación no llega a escribir ese mensaje,
  // el documento activo vuelve al anterior.
  private destinoPendiente: { id?: string; burbuja?: string } | null = null
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
  private propuestaListaEnCurso: string | null = null
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
      recuperandoRespuesta: this.recuperandoRespuestaActiva(),
      transcripcionParcial: this.transcripcionParcial,
      modoVoz: this.modoVoz,
      avisoVoz: this.avisoVoz,
      diagnosticoArranqueVoz: this.diagnosticoArranqueVoz,
      debugVoz: this.debugVoz,
      estadoEscucha: this.estadoEscucha,
      avisoGeneracion: this.avisoGeneracion,
      documentoFinalizandoId: this.documentoFinalizandoId,
      conversacionActivaId: this.conversacionActivaId,
      listaConversaciones: this.listaConversaciones,
      archivoReutilizadoId: this.archivoReutilizadoId,
      accionCalendarioEnProgreso: this.accionCalendarioEnProgreso,
      propuestaListaEnCurso: this.propuestaListaEnCurso,
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
  // informativo: el aviso solo informa (p. ej. no se pudo abrir una
  // conversación remota); tocarlo lo cierra y NUNCA reintenta nada.
  private avisoInformativo = false
  private mostrarAvisoGeneracion(texto: string, informativo = false) {
    if (this.avisoGeneracionTimer) clearTimeout(this.avisoGeneracionTimer)
    this.avisoGeneracion = texto
    this.avisoInformativo = informativo
    this.avisoGeneracionTimer = setTimeout(() => {
      this.avisoGeneracion = null
      this.avisoInformativo = false
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
    if (this.sincronizacionDiferida && !this.generando) this.incorporarSincronizacion()
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
    // Mensajes de otro dispositivo que esperan a que termine la respuesta
    // en curso: ya están en la copia local y ningún guardado los quita
    // (en pantalla se incorporan después, ver incorporarSincronizacion),
    // con el documento activo que tendrán al incorporarse.
    const diferidos = this.sincronizacionDiferida?.id === this.conversacionActivaId ? this.sincronizacionDiferida.nuevos : []
    const mensajes = combinarMensajes(this.mensajes, diferidos)
    const documentoNuevo = documentoTrasIncorporar(mensajes, diferidos, this.documentoActivo)
    guardarConversacion(this.conversacionActivaId, mensajes, documentoNuevo ? elegirDocumentoActivo(this.documentoActivo, documentoNuevo) : this.documentoActivo)
    this.recalcularLista()
    this.programarCopiaRemota(this.conversacionActivaId, this.mensajes)
  }

  // Copia remota de los mensajes (persistencia remota, etapa 1): en
  // segundo plano y con su propio debounce, para no escribir en cada
  // fragmento de una respuesta. Nunca bloquea ni cambia el chat; un
  // fallo queda en la cola de persistencia.ts y se reintenta.
  private copiaRemotaTimer: ReturnType<typeof setTimeout> | null = null
  private copiasRemotasPendientes = new Map<string, MensajeConversacion[]>()
  private programarCopiaRemota(localId: string, mensajes: MensajeConversacion[]) {
    this.copiasRemotasPendientes.set(localId, mensajes)
    if (this.copiaRemotaTimer) clearTimeout(this.copiaRemotaTimer)
    this.copiaRemotaTimer = setTimeout(() => void this.enviarCopiaRemota(), 2000)
  }

  private async confirmarPersistenciaConversacion(): Promise<void> {
    if (!this.conversacionActivaId) return
    this.copiasRemotasPendientes.set(this.conversacionActivaId, this.mensajes)
    try {
      await Promise.race([this.enviarCopiaRemota(), new Promise((r) => setTimeout(r, LIMITE_PERSISTENCIA_ANTES_DE_APROBAR_MS))])
    } catch {
      // Sin confirmación, el servidor responde que aún se está guardando.
    }
  }

  private async enviarCopiaRemota() {
    if (this.copiaRemotaTimer) { clearTimeout(this.copiaRemotaTimer); this.copiaRemotaTimer = null }
    // Respuesta en curso: no se envía nada a medias. Lo pendiente se
    // queda en el mapa y la notificación que cierra el turno (respuesta
    // final o error) vuelve a programar la copia, sin sondeos. No se
    // usa turnoAbierto: sigue abierto después de la respuesta final.
    if (this.generando) return
    const lote = [...this.copiasRemotasPendientes]
    this.copiasRemotasPendientes.clear()
    if (lote.length === 0) return
    const { data: { session } } = await supabase.auth.getSession()
    const docenteId = session?.user?.id
    if (!docenteId) return
    // Solo conversaciones que siguen guardadas en este dispositivo: tras
    // cerrar sesión ya no existen y nunca se copian a otro docente.
    const vigentes = new Set(listarConversaciones().map((c) => c.id))
    for (const [localId, mensajes] of lote) {
      if (vigentes.has(localId)) await guardarMensajesRemotos(localId, docenteId, mensajes)
    }
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
    void this.enviarCopiaRemota()
  }

  // Envía lo que haya quedado en la cola de mensajes remotos (al
  // restaurar la sesión o al recuperar la conexión). Fuera del callback
  // de onAuthStateChange: llamar a Supabase dentro de él puede bloquear.
  reintentarCopiaRemota(docenteId: string) {
    setTimeout(() => void reintentarMensajesRemotosPendientes(docenteId), 0)
  }

  // Migración del historial local anterior (etapa 2), en segundo plano
  // y unos segundos después de entrar, para no competir con la carga.
  // Una vez por página y docente; solo se repite si hubo un fallo.
  private migracionesLanzadas = new Set<string>()
  iniciarMigracionHistorial(docenteId: string) {
    if (this.migracionesLanzadas.has(docenteId)) return
    this.migracionesLanzadas.add(docenteId)
    setTimeout(() => {
      void migrarHistorialLocal(docenteId)
        .then((r) => { if (r.fallidas > 0) this.migracionesLanzadas.delete(docenteId) })
        .catch(() => this.migracionesLanzadas.delete(docenteId))
    }, 5000)
  }

  // Descarta cualquier estado transitorio (turno abierto, edición o
  // generación de archivo en curso, avisos) antes de cambiar de
  // conversación o vaciar la actual — ninguno de esos estados tiene
  // sentido fuera de la conversación en la que empezaron.
  private limpiarEstadoTransitorio() {
    // Vista nueva: cualquier respuesta pendiente de la anterior ya no es de aquí.
    this.vista++
    this.cancelarRecuperacionesAjenas()
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
    this.avisoInformativo = false
    this.avisoVoz = null
    this.ultimoIntentoEdicion = null
    this.turnoUsuarioPendiente = false
    this.textoAsistentePendiente = ''
    this.finalPendiente = false
    this.sincronizacionDiferida = null
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
  // (mensajes, documento activo) y la deja como la activa. Después trae
  // en segundo plano los mensajes escritos en otro dispositivo (salvo
  // si se acaba de descargar).
  abrirConversacion(id: string, sincronizar = true) {
    if (id === this.conversacionActivaId) return
    if (this.persistenciaTimer) { clearTimeout(this.persistenciaTimer); this.persistenciaTimer = null }
    this.guardarAhora() // no perder los últimos cambios de la conversación que se deja
    const datos = cargarConversacionPorId(id)
    if (!datos) {
      if (this.remotasSinCopia.some((c) => c.id === id)) void this.abrirConversacionRemota(id)
      return
    }
    this.conversacionActivaId = id
    establecerConversacionActiva(id)
    this.mensajes = datos.mensajes
    // El documento vigente de los mensajes (también uno entregado directo
    // como archivo). El guardado se conserva (con su caché de archivos) si
    // es ese mismo; uno anterior nunca lo sustituye.
    this.documentoActivo = elegirDocumentoActivo(datos.documentoActivo, documentoVigente(datos.mensajes))
    this.limpiarEstadoTransitorio()
    this.notificar()
    if (sincronizar) void this.sincronizarConversacion(id)
  }

  // --- Mensajes de otros dispositivos en una conversación con copia local ---
  // sincronizarConversacionRemota (persistencia.ts) combina con la copia
  // del navegador; aquí solo se aplican los mensajes nuevos a la
  // conversación en pantalla. Se descartan si el docente ya cambió de
  // conversación (quedan en la copia local para la próxima apertura) y
  // esperan, sin volver a consultar, si hay una respuesta en curso: se
  // aplican en la notificación que cierra el turno. Un fallo solo se
  // registra: la copia local sigue siendo válida.
  private sincronizacionDiferida: { id: string; nuevos: MensajeConversacion[] } | null = null
  // Una sola sincronización a la vez por conversación (la apertura y el
  // envío comparten la misma) y la hora de la última exitosa: un fallo
  // nunca cuenta como actualizada.
  private sincronizacionesEnCurso = new Map<string, Promise<EstadoSincronizacion>>()
  // sincronizadaEn guarda cuándo EMPEZÓ la última sincronización exitosa
  // (lo que consultó es lo que había en Supabase a partir de entonces);
  // iniciadaEn, cuándo empezó la que está en curso.
  private sincronizadaEn = new Map<string, number>()
  private iniciadaEn = new Map<string, number>()
  private preparandoEnvio = false

  private sincronizarConversacion(id: string): Promise<EstadoSincronizacion> {
    const enCurso = this.sincronizacionesEnCurso.get(id)
    if (enCurso) return enCurso
    const inicio = Date.now()
    const promesa = this.ejecutarSincronizacion(id, inicio).finally(() => {
      this.sincronizacionesEnCurso.delete(id)
      this.iniciadaEn.delete(id)
    })
    this.sincronizacionesEnCurso.set(id, promesa)
    this.iniciadaEn.set(id, inicio)
    return promesa
  }

  private async ejecutarSincronizacion(id: string, inicio: number): Promise<EstadoSincronizacion> {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const docenteId = session?.user?.id
      if (!docenteId) return 'sin_sesion'
      if (id !== this.conversacionActivaId) return 'fallo'
      const resultado = await sincronizarConversacionRemota(docenteId, id)
      // 'eliminada': la retirada ya avisó a alRetirarConversacion.
      if (resultado.estado === 'eliminada') return 'eliminada'
      this.sincronizadaEn.set(id, inicio)
      if (resultado.estado === 'actualizada' && id === this.conversacionActivaId) {
        const previos = this.sincronizacionDiferida?.id === id ? this.sincronizacionDiferida.nuevos : []
        this.sincronizacionDiferida = { id, nuevos: [...previos, ...resultado.nuevos] }
        this.notificar()
      }
      // Al abrir, recargar, volver del segundo plano o recuperar la
      // conexión: los turnos pendientes de esta conversación.
      if (id === this.conversacionActivaId) this.recuperarTurnosPendientes()
      return 'al_dia'
    } catch (e) {
      console.error('[SINCRONIZAR_CONVERSACION] sincronizada=false', e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e))
      return 'fallo'
    }
  }

  // Al volver a la app (fase 3B): sincroniza en silencio la conversación
  // activa con el mismo mecanismo que la apertura y el envío (comparten la
  // sincronización en curso y la hora de la última exitosa). Tras una
  // ausencia de AUSENCIA_MINIMA_MS o más, consulta salvo que ya haya una
  // sincronización EMPEZADA después de ocultarse (exitosa o en curso);
  // una empezada antes no cubre lo escrito durante la ausencia. La
  // sesión, el cambio de conversación, la respuesta en curso y la
  // conversación eliminada los resuelve ejecutarSincronizacion.
  private ocultaDesde: number | null = null

  alOcultarse() {
    this.ocultaDesde = Date.now()
    this.guardarInmediatamente()
  }

  alVolverAPrimerPlano() {
    const id = this.conversacionActivaId
    // ocultaDesde se conserva hasta la siguiente ocultación: si llegan
    // visibilitychange y pageshow juntos, los dos ven la misma ausencia.
    // Sin ocultación registrada (nunca se ocultó en esta página) no hay
    // ausencia que cubrir: basta cualquier sincronización exitosa.
    const ausencia = this.ocultaDesde === null ? Infinity : Date.now() - this.ocultaDesde
    if (!id || ausencia < AUSENCIA_MINIMA_MS) return
    const ocultaDesde = this.ocultaDesde ?? 0
    const enCurso = this.sincronizacionesEnCurso.get(id)
    if (enCurso) {
      // Empezada antes de ocultarse: al terminar se vuelve a evaluar (y,
      // si sigue siendo necesario, se consulta una vez más).
      if ((this.iniciadaEn.get(id) ?? 0) < ocultaDesde) void enCurso.then(() => this.alVolverAPrimerPlano())
      return
    }
    if ((this.sincronizadaEn.get(id) ?? -1) >= ocultaDesde) return
    void this.sincronizarConversacion(id)
  }

  // Antes de enviar a la IA: espera la sincronización en curso o hace una
  // si la última exitosa ya es vieja (o siempre, para operar sobre el
  // documento activo). Sin respuesta generándose, los
  // mensajes nuevos (y el documento activo) se aplican en ese mismo
  // momento. 'tiempo': se agotó la espera (la consulta sigue y se aplica
  // al llegar, como en la apertura).
  private async asegurarContextoActualizado(id: string, siempre: boolean): Promise<EstadoSincronizacion | 'tiempo'> {
    const enCurso = this.sincronizacionesEnCurso.get(id)
    if (!enCurso && !siempre && Date.now() - (this.sincronizadaEn.get(id) ?? 0) < VIGENCIA_SINCRONIZACION_MS) return 'al_dia'
    try {
      return await conLimiteDeTiempoAccion(enCurso ?? this.sincronizarConversacion(id), ESPERA_SINCRONIZACION_ENVIO_MS, 'Tiempo de espera agotado sincronizando la conversación')
    } catch {
      return 'tiempo'
    }
  }

  // Solo agrega los ids que no están en pantalla (lo creado mientras
  // tanto se conserva tal cual). El documento activo pasa al documento
  // formal nuevo solo si es el último de la conversación (ver
  // documentoFormalSincronizado).
  private incorporarSincronizacion() {
    const { id, nuevos } = this.sincronizacionDiferida!
    this.sincronizacionDiferida = null
    if (id !== this.conversacionActivaId) return
    const combinados = sinRespuestasPendientesResueltas(combinarMensajes(this.mensajes, nuevos))
    if (combinados === this.mensajes) return
    this.mensajes = combinados
    const documentoNuevo = documentoTrasIncorporar(combinados, nuevos, this.documentoActivo)
    if (documentoNuevo?.noRecuperado) {
      // Restauración de otro dispositivo cuya versión no está aquí: se
      // conserva el activo si ya es esa versión; si no, queda explícita.
      this.documentoActivo = elegirDocumentoActivo(this.documentoActivo, documentoNuevo)
    } else if (documentoNuevo) {
      this.actualizarDocumentoActivo(documentoNuevo.id, documentoNuevo.texto)
      if (!this.documentoActivo!.ultimoFormatoGenerado && documentoNuevo.ultimoFormatoGenerado) this.documentoActivo = { ...this.documentoActivo!, ultimoFormatoGenerado: documentoNuevo.ultimoFormatoGenerado }
    }
  }

  // --- Conversaciones de otros dispositivos (persistencia remota, etapa 3A) ---
  // Solo del docente de la sesión: `remotasDe` evita mostrar las de otro
  // docente si cambia la sesión en el mismo dispositivo.
  private remotasSinCopia: ConversacionResumen[] = []
  private remotasDe: string | null = null
  private ultimaConsultaRemota = 0
  private abriendoRemota: string | null = null

  private recalcularLista() {
    this.listaConversaciones = combinarConversaciones(listarConversaciones(), this.remotasSinCopia)
  }

  olvidarConversacionesRemotas() {
    this.remotasSinCopia = []
    this.remotasDe = null
    this.ultimaConsultaRemota = 0
  }

  async refrescarConversacionesRemotas(docenteId: string, forzar = false) {
    if (this.remotasDe !== docenteId) this.olvidarConversacionesRemotas()
    if (!forzar && Date.now() - this.ultimaConsultaRemota < 60_000) return
    this.ultimaConsultaRemota = Date.now()
    try {
      const [remotas, eliminadas] = await Promise.all([conversacionesRemotasSinCopiaLocal(docenteId), conversacionesLocalesEliminadas(docenteId)])
      const { data: { session } } = await supabase.auth.getSession()
      if (session?.user?.id !== docenteId) return
      for (const { localId, remotoId } of eliminadas) await retirarConversacionLocal(docenteId, localId, remotoId)
      this.remotasSinCopia = remotas
      this.remotasDe = docenteId
      this.recalcularLista()
      this.notificar()
    } catch (e) {
      this.ultimaConsultaRemota = 0
      console.error('[CONVERSACIONES_REMOTAS] lista=false', e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e))
    }
  }

  private async abrirConversacionRemota(id: string) {
    if (this.abriendoRemota === id) return
    this.abriendoRemota = id
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const docenteId = session?.user?.id
      if (!docenteId || docenteId !== this.remotasDe) return
      const descargada = await descargarConversacionRemota(docenteId, id)
      this.remotasSinCopia = this.remotasSinCopia.filter((c) => c.id !== id)
      if (descargada) this.abrirConversacion(id, false)
      else {
        this.recalcularLista()
        this.notificar()
      }
    } catch (e) {
      console.error('[CONVERSACIONES_REMOTAS] abrir=false', e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e))
      this.mostrarAvisoGeneracion('No se pudo abrir la conversación. Revisa tu conexión e intenta de nuevo.', true)
      this.notificar()
    } finally {
      this.abriendoRemota = null
    }
  }

  // Borra una conversación guardada de forma permanente — si era la
  // activa, la pantalla vuelve a la vista inicial (null), nunca genera
  // sola una conversación nueva: la existencia/ausencia de datos
  // guardados no debe asignar activeConversationId por sí misma.
  // Elimina la conversación en TODOS los dispositivos del docente (etapa
  // 3B-1), previa confirmación nativa. La copia local solo se retira
  // cuando Supabase confirma; si falla, no se toca nada y se avisa.
  eliminarConversacion(id: string) {
    if (!ELIMINAR_CONVERSACION_DISPONIBLE) return
    if (typeof window !== 'undefined' && typeof window.confirm === 'function'
      && !window.confirm('¿Eliminar esta conversación? Se eliminará en todos tus dispositivos y no se puede deshacer.')) return
    void this.eliminarConversacionEnTodos(id)
  }

  private async eliminarConversacionEnTodos(id: string) {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const docenteId = session?.user?.id
      if (!docenteId) {
        this.mostrarAvisoGeneracion('Inicia sesión para eliminar la conversación.', true)
        this.notificar()
        return
      }
      const soloRemota = !cargarConversacionPorId(id) && this.remotasSinCopia.some((c) => c.id === id)
      await eliminarConversacionGlobal(docenteId, id, soloRemota ? id : undefined)
      // eliminarConversacionGlobal ya retiró la copia local (y avisó a
      // alRetirarConversacion); para una solo remota, se quita de la lista.
      this.alRetirarConversacion(id)
    } catch (e) {
      console.error('[ELIMINAR_CONVERSACION] eliminada=false', e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e))
      this.mostrarAvisoGeneracion('No se pudo eliminar la conversación. Revisa tu conexión e intenta de nuevo.', true)
      this.notificar()
    }
  }

  // Una conversación dejó de existir en este dispositivo (eliminada aquí
  // o en otro): sale de la lista y, si estaba abierta, a la vista inicial.
  alRetirarConversacion(localId: string) {
    this.remotasSinCopia = this.remotasSinCopia.filter((c) => c.id !== localId)
    if (localId === this.conversacionActivaId) {
      if (this.persistenciaTimer) { clearTimeout(this.persistenciaTimer); this.persistenciaTimer = null }
      this.conversacionActivaId = null
      this.mensajes = []
      this.documentoActivo = null
      this.limpiarEstadoTransitorio()
    }
    this.recalcularLista()
    this.notificar()
  }

  // Cambio de identidad (sesión confirmada, cierre o cambio de cuenta; ver
  // el listener de onAuthStateChange más abajo). Lo pendiente de la cuenta
  // anterior se guarda en SU copia local y en SU cola antes de cerrar el
  // acceso; después solo se ve lo del docente nuevo (o nada, sin sesión).
  // Las copias locales, las colas y los marcadores nunca se borran aquí.
  cambiarDeDocente(nuevo: string | null) {
    const anterior = propietarioLocal()
    if (anterior === nuevo) return
    if (anterior) {
      if (this.persistenciaTimer) {
        clearTimeout(this.persistenciaTimer)
        this.persistenciaTimer = null
        this.guardarAhora()
      }
      if (this.copiaRemotaTimer) { clearTimeout(this.copiaRemotaTimer); this.copiaRemotaTimer = null }
      const lote = [...this.copiasRemotasPendientes]
      this.copiasRemotasPendientes.clear()
      for (const [localId, mensajes] of lote) void guardarMensajesRemotos(localId, anterior, mensajes)
    }
    establecerPropietarioLocal(nuevo)
    // Sin sesión (salida aquí o en otro dispositivo) no queda el panel del
    // chat encima de la pantalla de bienvenida.
    if (!nuevo) this.panelAbierto = false
    this.limpiarConversacionGuardada()
    this.olvidarConversacionesRemotas()
    if (nuevo) {
      this.listaConversaciones = listarConversaciones()
      this.notificar()
      // Copias anteriores al aislamiento: solo las que tienen evidencia de
      // ser de este docente vuelven a la lista (etapa 2).
      void resolverPropietariosLocales(nuevo).then((r) => {
        if (r.asignadas.length === 0 || propietarioLocal() !== nuevo) return
        this.recalcularLista()
        this.notificar()
      })
    }
  }

  // Cierre de sesión seguro (etapa 3): lo pendiente en memoria pasa a la
  // copia local y a la cola del docente actual sin esperar los debounces, y
  // se intenta enviar con el mecanismo de siempre durante un tiempo
  // limitado (lo que no alcance queda en su cola para su próxima sesión).
  // Solo si signOut confirma se cierra la puerta y se vacía la memoria; si
  // falla, la sesión sigue igual y se avisa. Una segunda pulsación espera
  // el mismo cierre. Nada local se borra.
  private cierreSesionEnCurso: Promise<ResultadoCierreSesion> | null = null
  cerrarSesion(): Promise<ResultadoCierreSesion> {
    if (!this.cierreSesionEnCurso) this.cierreSesionEnCurso = this.ejecutarCierreSesion().finally(() => { this.cierreSesionEnCurso = null })
    return this.cierreSesionEnCurso
  }

  private async ejecutarCierreSesion(): Promise<ResultadoCierreSesion> {
    const docente = propietarioLocal()
    if (docente) {
      if (this.persistenciaTimer) {
        clearTimeout(this.persistenciaTimer)
        this.persistenciaTimer = null
      }
      this.guardarAhora()
      if (this.copiaRemotaTimer) { clearTimeout(this.copiaRemotaTimer); this.copiaRemotaTimer = null }
      const lote = [...this.copiasRemotasPendientes]
      this.copiasRemotasPendientes.clear()
      try {
        await conLimiteDeTiempoAccion((async () => {
          for (const [localId, mensajes] of lote) await guardarMensajesRemotos(localId, docente, mensajes)
          await reintentarMensajesRemotosPendientes(docente)
        })(), LIMITE_ENVIO_AL_SALIR_MS, 'Tiempo de espera agotado enviando lo pendiente antes de salir')
      } catch {
        // Lo no enviado sigue en la cola del docente (se envía en su próxima sesión).
      }
    }
    let error: unknown = null
    try {
      error = (await supabase.auth.signOut()).error
    } catch (e) {
      error = e
    }
    if (error) return { ok: false, mensaje: MENSAJE_SALIDA_FALLIDA }
    // Sin esperar el evento SIGNED_OUT: acceso cerrado y memoria vacía.
    this.cambiarDeDocente(null)
    return { ok: true }
  }

  // Vacía el estado conversacional en memoria (no toca lo guardado): las
  // operaciones en curso de la cuenta anterior ya no encuentran su
  // conversación ni su vista, así que no escriben ni muestran nada.
  limpiarConversacionGuardada() {
    if (this.persistenciaTimer) {
      clearTimeout(this.persistenciaTimer)
      this.persistenciaTimer = null
    }
    this.mensajes = []
    this.documentoActivo = null
    this.limpiarEstadoTransitorio()
    this.sincronizacionDiferida = null
    this.sincronizadaEn.clear()
    this.conversacionActivaId = null
    this.listaConversaciones = []
    this.notificar()
  }

  // --- Panel (mostrar/ocultar la burbuja de conversación) ---

  // «Continuar en el Chat IA» desde la pestaña Planeación (Hito 2, 5c): la
  // planeación y versión elegidas pasan al único Chat con el mismo
  // mecanismo de una consulta guardada (referencia de la conversación y
  // vista determinista de la versión como documento activo). Sin mensaje
  // del docente y sin IA. Se reutiliza la conversación actual solo si el
  // servidor confirma que ya es exactamente esa planeación, versión y
  // grupo sin ajustes pendientes; si no, se abre una conversación nueva
  // (nunca se toca otra conversación ni un borrador pendiente).
  async continuarPlaneacion(versionId: string): Promise<'listo' | 'ocupado' | 'otro_grupo' | 'no_disponible' | 'sesion' | 'error'> {
    if (this.generando || this.reservaEnvio) return 'ocupado'
    const { data: { session } } = await supabase.auth.getSession()
    const docenteId = session?.user?.id
    if (!session || !docenteId) return 'sesion'
    const pedir = async (conversacionId: string, modo: 'evaluar' | 'abrir'): Promise<{ estado: string; mensajeId?: string }> => {
      try {
        const res = await fetch(`/api/planeaciones/versiones/${encodeURIComponent(versionId)}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ conversacionId, modo, zonaHoraria: obtenerZonaHorariaDispositivo() }),
        })
        return (await res.json()) as { estado: string; mensajeId?: string }
      } catch {
        return { estado: 'error' }
      }
    }
    const final = (estado: string) => (['otro_grupo', 'no_disponible', 'sesion'].includes(estado) ? estado : 'error') as 'otro_grupo' | 'no_disponible' | 'sesion' | 'error'

    if (this.mensajes.length > 0 && this.conversacionActivaId) {
      const actual = await asegurarConversacionRemota(this.conversacionActivaId, docenteId)
      const evaluacion = actual ? await pedir(actual, 'evaluar') : { estado: 'requiere_nueva' }
      if (evaluacion.estado === 'reutilizar') { this.abrirPanel(); return 'listo' }
      if (evaluacion.estado !== 'requiere_nueva') return final(evaluacion.estado)
    }
    if (this.generando || this.reservaEnvio) return 'ocupado'
    // Conversación vacía actual o, si tenía mensajes, una nueva.
    if (this.mensajes.length > 0 || !this.conversacionActivaId) this.nuevaConversacion()
    const local = this.conversacionActivaId
    if (!local) return 'error'
    const remota = await asegurarConversacionRemota(local, docenteId)
    if (!remota) return 'error'
    const apertura = await pedir(remota, 'abrir')
    if (apertura.estado !== 'listo' || !apertura.mensajeId) return final(apertura.estado)
    await this.traerMensajeCanonico(local, apertura.mensajeId)
    this.abrirPanel()
    return 'listo'
  }

  abrirPanel() {
    this.panelAbierto = true
    this.notificar()
    this.asegurarMotor()
    void supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user?.id) void this.refrescarConversacionesRemotas(session.user.id)
    })
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
    this.diagnosticoArranqueVoz = null
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
      motor.establecerCanalDeTexto(async (texto, turnId, voiceDebug) => { await this.enviarMensaje(texto, undefined, undefined, 'voz', turnId, voiceDebug) })
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
    this.registrarPasoDebugVoz('voice:stop_button_pressed', 'ok')
    // CAUSA RAÍZ real de "el botón de colgar no hace nada visible" (ver
    // "Confirmar arquitectura híbrida y corregir botón de colgar y
    // reproducción"): antes, si motor.detener() o asegurarMotorTexto()
    // lanzaban una excepción, la función se detenía en seco AHÍ MISMO —
    // this.modoVoz nunca llegaba a false y this.notificar() (el único
    // puente hacia React) nunca se ejecutaba, así que ni el estado
    // interno ni la UI cambiaban, aunque el toque sí se hubiera
    // registrado. try/finally garantiza que el estado SIEMPRE vuelve a
    // IDLE y SIEMPRE se notifica a React, pase lo que pase adentro.
    try {
      await this.motorVoz?.detener()
    } catch (err) {
      console.error('[VOZ] motor.detener() falló al colgar — se limpia el estado de todas formas:', err)
    } finally {
      this.motorVoz = null
      this.modoVoz = false
      this.turnoUsuarioPendiente = false
      this.textoAsistentePendiente = ''
      this.finalPendiente = false
      this.estadoEscucha = null
      this.registrarPasoDebugVoz('voice:state_idle', 'ok')
      this.notificar()
    }
    // asegurarMotorTexto() se deja fuera del try/finally a propósito: si
    // falla, el docente ya volvió a ver el micrófono normal y la
    // conversación de voz ya terminó (lo urgente); el chat escrito
    // simplemente reintentará crear su motor en el próximo mensaje (ver
    // asegurarMotor/motorDeContenido), sin bloquear el cierre de voz.
    try {
      this.motor = await this.asegurarMotorTexto()
    } catch (err) {
      console.error('[VOZ] asegurarMotorTexto() falló tras colgar — se reintentará en el próximo mensaje:', err)
    }
  }

  // --- Respuestas ligadas a la conversación que las pidió ---
  // Cada solicitud al motor guarda la vista (conversación y turno) en que
  // se hizo; limpiarEstadoTransitorio abre una vista nueva al cambiar de
  // conversación, empezar una nueva, retirarla o cerrar sesión. Una
  // respuesta de otra vista nunca se muestra ni toca el documento activo:
  // si es la última de esa solicitud (respuesta final o error), solo
  // libera el estado de generación. El motor de texto, además, solo emite
  // los eventos de su solicitud vigente (ver MotorTextoClaude.enviarTexto).
  private vista = 0
  private vistaSolicitud: number | null = null

  private marcarSolicitud() {
    this.vistaSolicitud = this.vista
    this.reservaEnvio = false
  }

  private esRespuestaDeOtraVista(evento: EventoMotor): boolean {
    // Un turno que termina en otra vista se recupera al volver a abrir su
    // conversación (ver recuperarTurnosPendientes).
    const deSolicitud = evento.tipo === 'respuesta-parcial' || evento.tipo === 'respuesta-final' || evento.tipo === 'turno'
      || (evento.tipo === 'error' && evento.mensaje !== MENSAJE_VOZ_PERDIDA)
    if (!deSolicitud || this.vistaSolicitud === null || this.vistaSolicitud === this.vista) return false
    if (evento.tipo !== 'respuesta-parcial') {
      this.vistaSolicitud = null
      this.generando = false
      this.notificar()
    }
    return true
  }

  private manejarEventoMotor(evento: EventoMotor) {
    if (this.esRespuestaDeOtraVista(evento)) return
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
        this.mensajes = [...this.mensajes, { id: nuevoId(), rol: 'usuario', texto: evento.texto, creadoEn: marcaTiempo() }]
        this.turnoAbierto = null
        this.turnoUsuarioPendiente = false
        this.notificar()

        // Si la respuesta del asistente ya había llegado (o hasta
        // terminado) mientras esperábamos la transcripción, se vuelca
        // ahora de un jalón — la burbuja del docente ya quedó primero.
        if (this.textoAsistentePendiente) {
          this.turnoAbierto = nuevoId()
          this.mensajes = [...this.mensajes, { id: this.turnoAbierto, rol: 'asistente', texto: this.textoAsistentePendiente, creadoEn: marcaTiempo() }]
          this.textoAsistentePendiente = ''
          if (this.finalPendiente) {
            this.generando = false
            this.finalPendiente = false
            if (esDocumentoFormal(this.mensajes[this.mensajes.length - 1].texto)) {
              this.actualizarDocumentoActivo(this.turnoAbierto, this.mensajes[this.mensajes.length - 1].texto)
            }
            // Edición de contenido cuya respuesta final esperaba a la
            // burbuja del docente (voz): mismo cierre que la finalización
            // normal (estado de edición limpio y, si la respuesta es un
            // documento, vinculada como versión nueva — P2b).
            const origen = this.tomarOrigenDeEdicion()
            if (origen) this.vincularVersion(this.turnoAbierto, origen)
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

        // FINALIZAR ARCHIVO: el servidor solo transmite "Documento
        // generado correctamente." + marcadores técnicos. El mensaje del
        // documento no se toca y el archivo llega en una respuesta nueva
        // (ver 'respuesta-final'). Una edición de contenido NO entra aquí
        // (append-only, ver enviarComoEdicion): su respuesta — documento
        // nuevo, aclaración o error en texto — cae al turno normal de
        // abajo en una burbuja propia, sin pisar el documento fuente.
        if (this.editandoDocumentoId && this.documentoFinalizandoId === this.editandoDocumentoId) {
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
          this.mensajes = [...this.mensajes, { id: this.turnoAbierto, rol: 'asistente', texto: evento.texto, creadoEn: marcaTiempo() }]
        }
        this.notificar()
        break
      }
      case 'respuesta-final': {
        // Documento del que esta respuesta es una versión nueva (edición
        // de contenido), para vincularla al terminar (P2b).
        let origenVersion: string | null = null
        // El Chat IA acaba de confirmar un cambio real en
        // perfiles_docentes (ver actualizar_perfil_docente en
        // app/api/chat/route.ts) — se dispara sin esperar a los
        // chequeos de abajo (turnoUsuarioPendiente, etc.) porque es
        // independiente de cómo se termine mostrando esta respuesta.
        // recargarPerfil() notifica por su cuenta cuando termina.
        if (evento.perfilActualizado) this.recargarPerfil()
        // Turno duradero: adoptar el mensaje canónico del servidor o, sin
        // confirmación de guardado, dejar la respuesta pendiente y
        // consultarla (nunca darla por guardada).
        if (evento.turno) this.confirmarTurno(evento.turno)

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
            // Edición de contenido (append-only): no dejar en pantalla la
            // burbuja nueva vacía que abrió 'respuesta-parcial'.
            if (!estabaFinalizandoArchivo && this.turnoAbierto) {
              const turnoVacio = this.turnoAbierto
              this.mensajes = this.mensajes.filter(m => m.id !== turnoVacio)
              this.turnoAbierto = null
            }
            this.editandoDocumentoId = null
            this.documentoFinalizandoId = null
            this.textoDocumentoFinalizando = null
            if (this.intentarReintentoAutomatico(estabaFinalizandoArchivo, 'No pude generar el archivo. Toca para reintentar.')) break
            this.notificar()
            break
          }
          if (this.documentoFinalizandoId === this.editandoDocumentoId) {
            // Aviso controlado del servidor (archivo sin sesión, ver
            // MENSAJE_ARCHIVO_SIN_SESION): se muestra como respuesta del
            // asistente y el documento activo queda intacto. Cualquier
            // otra respuesta sin archivo sigue el camino de siempre.
            if (!evento.archivo && evento.texto.trim() === MENSAJE_ARCHIVO_SIN_SESION) {
              this.mensajes = [...this.mensajes, { id: nuevoId(), rol: 'asistente', texto: MENSAJE_ARCHIVO_SIN_SESION, creadoEn: marcaTiempo() }]
              this.editandoDocumentoId = null
              this.documentoFinalizandoId = null
              this.textoDocumentoFinalizando = null
              this.intentosFinalizacionActual = 0
              this.ultimoIntentoEdicion = null
              this.notificar()
              break
            }
            // FINALIZAR ARCHIVO: el marcador [[DOCUMENTO_ARCHIVO:...]] ya
            // se procesó en el motor (ver motorTextoClaude) y llega aquí
            // como evento.archivo. Se entrega en una respuesta NUEVA del
            // asistente, igual que al reutilizar un archivo ya generado
            // (reutilizarArchivoExistente): el mensaje del documento no se
            // modifica, la entrega se ve aunque sea el mismo formato y se
            // sincroniza a otros dispositivos como cualquier mensaje.
            if (evento.archivo) {
              const idMensaje = nuevoId()
              this.mensajes = [...this.mensajes, { id: idMensaje, rol: 'asistente', texto: AVISO_ARCHIVO_LISTO, creadoEn: marcaTiempo(), archivo: evento.archivo, ...(evento.archivos ? { archivos: evento.archivos } : {}), ...(this.editandoDocumentoId ? { documentoOrigenId: this.editandoDocumentoId } : {}) }]
              this.turnoAbierto = null
              this.mostrarArchivoReutilizado(idMensaje)
            }
            // El documento sigue activo con el texto que se convirtió
            // (también el de un documento CASO 3, cuyo mensaje solo dice
            // "Documento generado correctamente.") — así un segundo
            // formato ("también en PDF") o una nueva edición reutilizan el
            // contenido real; la caché de archivos solo se conserva si es
            // esa misma versión (actualizarDocumentoActivo).
            const doc = this.mensajes.find(m => m.id === this.editandoDocumentoId)
            const textoConvertido = this.textoDocumentoFinalizando ?? (doc ? contenidoDocumentoDe(doc) : null)
            if (doc && textoConvertido) this.actualizarDocumentoActivo(doc.id, textoConvertido, evento.archivo)
            this.editandoDocumentoId = null
            this.documentoFinalizandoId = null
            this.textoDocumentoFinalizando = null
            this.intentosFinalizacionActual = 0
            this.ultimoIntentoEdicion = null
            this.notificar()
            break
          }
          // EDICIÓN DE CONTENIDO con texto real (append-only, mismo
          // diseño que test/images-v1): el documento fuente nunca se toca
          // aquí. Se limpia el estado de edición y se deja caer, SIN
          // break, al turno normal de abajo, que ya sabe completar la
          // respuesta nueva (documento editado, aclaración o error en
          // texto), adjuntar archivo y mover documentoActivo solo si la
          // respuesta es un documento formal.
          origenVersion = this.tomarOrigenDeEdicion()
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
            this.mensajes = [...this.mensajes.slice(0, idx), { ...msg, archivo: evento.archivo, archivos: evento.archivos, ...(evento.contenidoOriginal ? { contenidoDocumento: evento.contenidoOriginal } : {}) }, ...this.mensajes.slice(idx + 1)]
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
          } else if (msg && evento.propuestaLista) {
            // Propuesta de lista oficial registrada por el servidor: la
            // tarjeta de confirmación vive pegada al mismo mensaje (ver
            // confirmarPropuestaLista y TarjetaPropuestaLista).
            this.mensajes = [
              ...this.mensajes.slice(0, idx),
              { ...msg, datosPropuestaLista: { estado: 'pendiente', expiraEn: evento.propuestaLista.expiraEn, token: evento.propuestaLista.token, operaciones: evento.propuestaLista.operaciones } },
              ...this.mensajes.slice(idx + 1),
            ]
          }
        }
        // Versión nueva (P2b): si la edición produjo un documento, queda
        // vinculada a la versión de la que salió y a la identidad estable
        // del documento. Solo se completa el mensaje de ESTE turno; los
        // históricos no se tocan.
        // Respuesta adoptada del servidor, ya con sus tarjetas: queda como
        // sincronizada antes del vínculo de versión (metadato del cliente).
        this.registrarAdopcion()
        if (origenVersion && this.turnoAbierto) this.vincularVersion(this.turnoAbierto, origenVersion)
        // Modo voz: le pide a la MISMA sesión de Realtime que lea en voz
        // alta la respuesta real que acaba de llegar (ver
        // MotorOpenAIRealtime.reproducirRespuestaEnVoz — "Rediseñar el
        // modo voz como conversación continua"). Todo el ciclo de vida
        // de esa lectura (estado 'hablando', barge-in, vuelta a
        // 'escuchando' al terminar) lo maneja el propio motor a través
        // de response.done — este método no necesita saber nada más.
        if (this.modoVoz) {
          this.registrarPasoDebugVoz('chat:response_received', 'ok', `${evento.texto.length} caracteres`)
          this.motorVoz?.reproducirRespuestaEnVoz(evento.texto)
        }
        this.notificar()
        break
      }
      case 'error': {
        // CAUSA RAÍZ real de "la sesión aparentemente permanece abierta"
        // (ver "Confirmar arquitectura híbrida y corregir botón de
        // colgar y reproducción"): este 'error' genérico también recibe
        // los errores de CONEXIÓN de MotorOpenAIRealtime (canal.onerror/
        // onclose, DataChannel cerrado en reproducirRespuestaEnVoz) —
        // antes se trataban igual que un error conversacional de Claude:
        // se metían al chat como si fueran un mensaje del asistente, Y
        // modoVoz se quedaba en true (solo estadoEscucha volvía a
        // 'escuchando'), así que la interfaz seguía mostrando la sesión
        // activa aunque la conexión real ya hubiera muerto. Se distingue
        // por el texto exacto — solo MotorOpenAIRealtime emite este
        // mensaje — y aquí se termina la sesión de verdad, sin ensuciar
        // el historial con un "mensaje" que Claude nunca dijo.
        if (this.modoVoz && evento.mensaje === MENSAJE_VOZ_PERDIDA) {
          this.motorVoz?.detener().catch(() => {})
          this.motorVoz = null
          this.modoVoz = false
          this.estadoEscucha = null
          this.generando = false
          this.estadoMotor = 'inactivo'
          this.mostrarAvisoVoz(evento.mensaje)
          this.asegurarMotorTexto()
            .then(motor => { this.motor = motor; this.notificar() })
            .catch(err => console.error('[VOZ] asegurarMotorTexto() falló tras conexión perdida:', err))
          this.notificar()
          break
        }
        this.generando = false
        this.estadoMotor = 'error'
        const estabaEditandoUnDocumento = this.editandoDocumentoId !== null
        const estabaFinalizandoArchivo = this.documentoFinalizandoId !== null
        const turnoParcial = this.turnoAbierto
        this.editandoDocumentoId = null
        this.documentoFinalizandoId = null
        this.textoDocumentoFinalizando = null
        this.turnoAbierto = null
        this.turnoUsuarioPendiente = false
        this.textoAsistentePendiente = ''
        this.finalPendiente = false
        // Una edición de contenido que falló a medio streaming deja una
        // burbuja nueva a medias (append-only) — se quita para que el
        // reintento no la duplique.
        if (estabaEditandoUnDocumento && !estabaFinalizandoArchivo && turnoParcial) {
          this.mensajes = this.mensajes.filter(m => m.id !== turnoParcial)
        }
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
          this.mensajes = [...this.mensajes, { id: nuevoId(), rol: 'asistente', texto: evento.mensaje, creadoEn: marcaTiempo() }]
        }
        // Un turno de voz que termina en error (red, timeout, HTTP de
        // /api/chat) nunca llega a 'respuesta-final' — sin esto, el
        // motor se quedaría esperando una respuesta que nunca va a
        // pedirle que lea, y estadoEscucha quedaría pegado.
        if (this.modoVoz) this.estadoEscucha = 'escuchando'
        this.notificar()
        break
      }
      case 'turno':
        this.atenderEstadoDeTurno(evento.estado, evento.requestId)
        break
      case 'debug-paso':
        this.registrarPasoDebugVoz(evento.paso, evento.resultado, evento.detalle, evento.ms)
        this.notificar()
        break
      case 'diagnostico-arranque-voz':
        this.diagnosticoArranqueVoz = evento.datos
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

  // 'no_enviado': la solicitud no salió y el borrador sigue siendo de la
  // vista actual (el panel lo devuelve al campo). 'otra_conversacion': el
  // docente cambió de conversación durante la espera; el borrador era de
  // la anterior y no se traslada.
  // Reserva síncrona del envío: un doble toque no envía dos veces el mismo
  // mensaje mientras se prepara (sincronización, guardado del turno…). Se
  // libera al salir la solicitud (marcarSolicitud), cuando el indicador de
  // generación ya bloquea el envío, o si no se envía nada.
  private reservaEnvio = false

  async enviarMensaje(texto: string, adjunto?: AdjuntoImagen, adjuntos?: AdjuntoImagen[], canal?: 'texto' | 'voz', turnId?: string, voiceDebug?: boolean): Promise<ResultadoEnvio> {
    if (this.reservaEnvio) return 'no_enviado'
    this.reservaEnvio = true
    try {
      return await this.enviarMensajeReservado(texto, adjunto, adjuntos, canal, turnId, voiceDebug)
    } finally {
      this.reservaEnvio = false
    }
  }

  private async enviarMensajeReservado(texto: string, adjunto?: AdjuntoImagen, adjuntos?: AdjuntoImagen[], canal?: 'texto' | 'voz', turnId?: string, voiceDebug?: boolean): Promise<ResultadoEnvio> {
    const limpio = texto.trim()
    if (!limpio || this.generando || this.preparandoEnvio) return 'no_enviado'

    // Vista inicial (sin conversación seleccionada): escribir el primer
    // mensaje ES la acción que crea la conversación nueva — ver
    // ARQUITECTURA: "al crear una conversación nueva: 1. crear un nuevo
    // conversationId". Nunca pasa nada implícito antes de esto.
    if (!this.conversacionActivaId) {
      this.conversacionActivaId = crearNuevaConversacion()
    }

    // Aprobación de un borrador de planeación: el servidor identifica el
    // borrador por el id PERSISTIDO de su mensaje, así que antes de enviar
    // la orden se confirma la copia remota de la conversación (mismo
    // mecanismo de siempre, sin esperar su debounce; con límite).
    if (detectarAprobarPlaneacion(limpio, { hayBorradorPlaneacion: this.mensajes.some((m) => m.rol === 'asistente' && esBorradorPlaneacion(m.texto)) })) {
      await this.confirmarPersistenciaConversacion()
    }

    // Contexto al día antes de decidir el camino y armar el historial:
    // todos los envíos de abajo (texto, fotos, edición, conversión,
    // finalización) usan this.mensajes y this.documentoActivo ya
    // sincronizados. Si el docente cambió de conversación durante la
    // espera, este mensaje no se envía a otra. Editar o convertir el
    // documento activo siempre se comprueba, aunque la última
    // sincronización sea reciente.
    const conversacion = this.conversacionActivaId
    this.preparandoEnvio = true
    let contexto: EstadoSincronizacion | 'tiempo'
    try {
      contexto = await this.asegurarContextoActualizado(conversacion, this.trabajaSobreDocumentoActivo(limpio) || esConsultaDocumentoActual(limpio) || !!destinoNombrado(limpio) || !!this.documentoActivo?.noRecuperado)
    } finally {
      this.preparandoEnvio = false
    }
    if (contexto === 'eliminada') {
      this.mostrarAvisoGeneracion(MENSAJE_CONVERSACION_ELIMINADA, true)
      this.notificar()
      return 'no_enviado'
    }
    if (conversacion !== this.conversacionActivaId) return 'otra_conversacion'
    if (this.generando) return 'no_enviado'
    const contextoSinVerificar = contexto === 'fallo' || contexto === 'tiempo'

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
    // Nombrar un documento o versión anterior ("regresa al documento
    // anterior", "convierte el documento anterior a Word", "corrige la
    // versión anterior") nunca opera sobre el documento vigente. Antes que
    // cualquier otro camino: todavía no se puede identificar ese referente
    // de forma segura (P2a), así que se responde sin llamar a la IA, sin
    // generar archivos y sin tocar el documento activo.
    const solicitudVersion = detectarSolicitudVersion(limpio)
    // Consulta de una planeación GUARDADA: la resuelve el servidor con su
    // versión vigente (ver esConsultaPlaneacionGuardada); ningún camino
    // local de documentos o versiones la atiende.
    const consultaGuardada = this.esConsultaPlaneacionGuardada(limpio)
    // Respuesta a una aclaración sobre versiones que sigue vigente (P2c):
    // completa la acción original sin repetir la solicitud.
    const aclarada = await this.responderAclaracion(limpio, adjunto)
    if (aclarada !== null) return aclarada ? 'enviado' : 'otra_conversacion'
    // Respuesta a una aclaración sobre cuál documento (P3a).
    const documentoAclarado = await this.responderAclaracionDocumento(limpio, adjunto, contextoSinVerificar)
    if (documentoAclarado !== null) return documentoAclarado

    // Consultar o restaurar una versión (P2c): con un documento activo
    // disponible, por vínculos explícitos (seleccionarVersion). Convertir o
    // editar una versión anterior, lo ambiguo y lo que no tiene documento
    // activo siguen con la respuesta segura de P2a.
    if (!consultaGuardada && (solicitudVersion?.accion === 'restaurar' || solicitudVersion?.accion === 'consultar') && this.documentoActivo && !this.documentoActivo.noRecuperado) {
      return (await this.atenderSolicitudVersion(limpio, solicitudVersion, adjunto)) ? 'enviado' : 'otra_conversacion'
    }
    if (solicitudVersion && !consultaGuardada) {
      this.transcripcionParcial = ''
      this.mensajes = [
        ...this.mensajes,
        { id: nuevoId(), rol: 'usuario', texto: limpio, creadoEn: marcaTiempo(), imagen: adjunto },
        { id: nuevoId(), rol: 'asistente', texto: RESPUESTA_SOLICITUD_VERSION[solicitudVersion.accion], creadoEn: marcaTiempo() },
      ]
      this.turnoAbierto = null
      this.notificar()
      return 'enviado'
    }

    // Restauración vigente cuya versión no está en este dispositivo: nada
    // que dependa del documento (editar, convertir, aprobar) opera sobre
    // otro en su lugar.
    if (this.documentoActivo?.noRecuperado && (this.trabajaSobreDocumentoActivo(limpio) || detectarAprobarPlaneacion(limpio, { hayBorradorPlaneacion: true }))) {
      const origen = this.mensajes.find((m) => m.id === resolverDocumentoVigente(this.mensajes)?.origenId)
      this.mostrarAvisoGeneracion(origen?.documentoDestinoId ? MENSAJE_DOCUMENTO_ELEGIDO_NO_RECUPERADO : MENSAJE_VERSION_NO_RECUPERADA, true)
      this.notificar()
      return 'no_enviado'
    }

    // Documento nombrado (P3a): "Cambia la fecha del citatorio" con el
    // examen activo trabaja sobre el citatorio, nunca sobre el examen.
    // Sin un tipo nombrado como destino, o si es el activo, todo sigue
    // igual.
    if (!consultaGuardada && !(adjuntos && adjuntos.length > 1) && !esVerificacionCalendarioConImagen(limpio, adjunto)) {
      const referido = await this.atenderDocumentoNombrado(limpio, adjunto, contextoSinVerificar)
      if (referido !== null) return referido
    }

    // Ver el documento actual ("Muéstrame el documento actual"): se muestra
    // la versión vigente (también una restaurada), igual que una consulta
    // de versiones, sin generar archivos ni llamar a la IA.
    if (!consultaGuardada && this.documentoActivo && !this.documentoActivo.noRecuperado && !adjunto && esConsultaDocumentoActual(limpio, this.documentoActivo.texto)) {
      return (await this.mostrarDocumentoActual(limpio)) ? 'enviado' : 'otra_conversacion'
    }

    if (esVerificacionCalendarioConImagen(limpio, adjunto) && adjunto) {
      await this.analizarCalendarioDesdeImagen(limpio, adjunto)
      return 'enviado'
    }

    // Varias fotos en un mismo mensaje ("compara estas dos listas",
    // "revisa estas cuatro evidencias"...) — igual que la verificación
    // de calendario arriba, nunca se interpreta como edición del
    // documento activo: es una solicitud de análisis nueva, sin
    // importar qué se esté redactando en ese momento. Ver "Implementar
    // soporte completo para múltiples fotografías".
    if (adjuntos && adjuntos.length > 1) {
      await this.enviarConMultiplesImagenes(limpio, adjuntos)
      return 'enviado'
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
    // Excepción: una orden inequívoca de aprobar/guardar la planeación
    // ("Apruébala y guárdala") no es una edición — se manda como mensaje
    // normal para que el flujo de aprobación de /api/chat la atienda
    // (ver detectarAprobarPlaneacion).
    // Otra excepción: pedir un documento NUEVO, con o sin formato ("genera
    // un citatorio en PDF", "prepara otro citatorio", "hazme un examen de
    // fracciones"), no es conversión ni edición del documento activo — va
    // como mensaje normal y /api/chat lo redacta (ver
    // esPedidoDocumentoNuevo; una referencia explícita al documento
    // existente, como "de este examen", lo mantiene como edición).
    // Y otra: editar Y entregar un documento que NO es el activo ("corrige
    // el oficio de la semana pasada y pásalo a PDF") — va como mensaje
    // normal y /api/chat pide aclaración (ver referenciaCompatibleConDocumento).
    if (this.documentoActivo && this.trabajaSobreDocumentoActivo(limpio)) {
      // Editar o convertir el documento activo sin haber podido comprobar
      // si otro dispositivo generó uno más reciente: no se ejecuta sobre
      // un documento posiblemente desactualizado.
      if (contextoSinVerificar) {
        this.mostrarAvisoGeneracion(MENSAJE_DOCUMENTO_SIN_VERIFICAR, true)
        this.notificar()
        return 'no_enviado'
      }
      await this.operarDocumentoActivo(limpio, adjunto)
      return 'enviado'
    }

    await this.asegurarMotor()
    this.sincronizarHistorialTexto()
    this.transcripcionParcial = ''
    const mensajeDocente: MensajeConversacion = { id: nuevoId(), rol: 'usuario', texto: limpio, creadoEn: marcaTiempo(), imagen: adjunto }
    // Turno duradero (texto escrito, sin imágenes): identidad persistente
    // guardada ANTES de enviar.
    const turno = canal !== 'voz' && !adjunto ? this.identidadDeTurno(mensajeDocente) : undefined
    this.mensajes = [...this.mensajes, mensajeDocente]
    this.turnoAbierto = null
    this.notificar()

    try {
      if (turno) await this.persistirIdentidadDelTurno(mensajeDocente)
      this.marcarSolicitud()
      await (await this.motorDeContenido())?.enviarTexto(limpio, adjunto, undefined, undefined, undefined, canal, turnId, voiceDebug, undefined, turno)
    } catch {
      this.manejarEventoMotor({ tipo: 'error', mensaje: 'No se pudo conectar con el asistente. Intenta de nuevo.' })
    }
    return 'enviado'
  }

  // Edita o convierte el documento activo según lo que pidió el docente (lo
  // que escribió o, tras una aclaración, su solicitud original).
  private async operarDocumentoActivo(limpio: string, adjunto?: AdjuntoImagen) {
    if (!this.documentoActivo) return
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
      // Editar Y entregar en un formato ("agrega una conclusión y
      // guárdalo en PDF"): primero la edición con el texto real del
      // documento y, en la misma llamada, el archivo del resultado
      // (CASO 3 en /api/chat) — nunca la conversión del texto anterior.
      // Solo con un formato NOMBRADO ("en PDF", "a Word"): una palabra
      // genérica ("haz un resumen de este documento") no pide archivo,
      // así que es una edición normal, sin formato.
      if (esEdicionConFormato(limpio) && tipoResuelto !== 'imagen' && tipoResuelto !== 'audio' && tipoResuelto !== 'video') {
        await this.enviarComoEdicion(this.documentoActivo.id, limpio, construirPromptEdicion(this.documentoActivo.texto, limpio), adjunto, formatoExplicito ? tipoResuelto : undefined)
        return
      }
      await this.ejecutarConversionFormato(tipoResuelto, limpio)
      return
    }
    await this.enviarComoEdicion(this.documentoActivo.id, limpio, construirPromptEdicion(this.documentoActivo.texto, limpio), adjunto)
  }

  // Mensaje del docente que inicia una edición o conversión: si se eligió
  // otro documento para ella (P3a), lo registra.
  private mensajeDocente(texto: string, imagen?: AdjuntoImagen): MensajeConversacion {
    const pendiente = this.destinoPendiente
    this.destinoPendiente = null
    return { id: nuevoId(), rol: 'usuario', texto: pendiente?.burbuja ?? texto, creadoEn: marcaTiempo(), ...(imagen ? { imagen } : {}), ...(pendiente?.id ? { documentoDestinoId: pendiente.id } : {}) }
  }

  // --- Documento al que se refiere el docente (P3a) ---
  // Con un documento activo y un tipo nombrado como destino ("del
  // citatorio", "al examen"; no como tema ni como documento nuevo):
  // - el activo lo nombra (y no hay ordinal): null, todo sigue igual;
  // - un solo documento de ese tipo en la conversación: se usa ese;
  // - varios, o el único candidato con la conversación posiblemente
  //   incompleta en el dispositivo: aclaración, sin ejecutar nada;
  // - ninguno: aviso, aunque el activo sea el único documento (nombrar otro
  //   tipo nunca opera sobre el activo);
  // - un ordinal ("el segundo citatorio") solo se resuelve con la
  //   conversación completa.
  // Devuelve null si el mensaje sigue el camino normal.
  private async atenderDocumentoNombrado(limpio: string, adjunto: AdjuntoImagen | undefined, sinVerificar: boolean): Promise<ResultadoEnvio | null> {
    const activo = this.documentoActivo
    if (!activo || activo.noRecuperado || esPedidoDocumentoNuevo(limpio) || detectarAprobarPlaneacion(limpio, { hayBorradorPlaneacion: esBorradorPlaneacion(activo.texto) })) return null
    const destino = destinoNombrado(limpio)
    if (!destino) return null
    let documentos = documentosDeConversacion(this.mensajes)
    let incompleta = this.mensajes.length >= TOPE_MENSAJES
    // Con la conversación posiblemente incompleta en el dispositivo y otro
    // documento nombrado (o un ordinal), se conocen TODOS sus documentos
    // por el índice de Supabase (P3b). Si falla, sigue la protección de
    // P3a (confirmar o avisar); nunca se elige otro documento en silencio.
    let traidos: MensajeConversacion[] = []
    if (incompleta && (destino.ordinal || destino.tipos.length > 1 || !tituloNombraTipo(activo.texto, destino.tipos[0]))) {
      const conversacion = this.conversacionActivaId
      const completos = await this.documentosCompletos()
      if (conversacion !== this.conversacionActivaId) return 'otra_conversacion'
      if (completos) {
        documentos = completos.documentos
        traidos = completos.traidos
        incompleta = false
      }
    }
    const delTipo = documentos.filter((d) => destino.tipos.some((t) => tituloNombraTipo(d.titulo ?? '', t)))
    const delActivo = documentos.find((d) => d.id === activo.id)
    // Identificado por su nombre ("la planeación de las leyendas"): solo los
    // documentos de la conversación que corresponden a ese nombre. Si
    // ninguno, no es de esta conversación: el servidor lo busca.
    const identificador = identificadorDeDocumento(limpio)
    const identificados = identificador.length > 0 ? delTipo.filter((d) => this.documentoConIdentificador(d, identificador)) : delTipo
    let candidatos: typeof documentos
    if (destino.ordinal) {
      if (destino.tipos.length > 1) candidatos = delTipo
      else if (incompleta) return this.responderSinCambios(limpio, adjunto, MENSAJE_ORDINAL_INCOMPLETO)
      else {
        const elegido = delTipo[destino.ordinal === -1 ? delTipo.length - 1 : destino.ordinal - 1]
        if (!elegido) return this.responderSinCambios(limpio, adjunto, MENSAJE_ORDINAL_INEXISTENTE)
        candidatos = [elegido]
      }
    } else if (destino.tipos.length === 1 && tituloNombraTipo(activo.texto, destino.tipos[0]) && !nombraOtroDocumento(limpio, activo.texto)) {
      candidatos = delActivo ? [delActivo] : []
      if (!destino.seleccion) return null
    } else if (identificador.length > 0 && identificados.length === 0) {
      return null
    } else if (delTipo.length === 0) {
      return this.responderSinCambios(limpio, adjunto, sinDocumentoDelTipo(destino.tipos[0], incompleta))
    } else candidatos = identificados
    if (candidatos.length === 0) return null
    // Con la conversación posiblemente incompleta, el único candidato
    // visible se confirma (P3b lo buscará en Supabase); salvo el activo.
    if (candidatos.length > 1 || (incompleta && !destino.ordinal && candidatos[0].id !== activo.id)) {
      return this.aclararDocumento(limpio, adjunto, candidatos, incompleta)
    }
    if (candidatos[0].id === activo.id && !destino.seleccion) return null
    return this.ejecutarConDestino(limpio, limpio, candidatos[0].id, adjunto, sinVerificar, traidos)
  }

  // Todos los documentos de la conversación (P3b): el índice documental de
  // Supabase combinado con los mensajes en memoria (regla canónica del
  // vigente por documento) y el título de los que no están en memoria, leído
  // por id. null si algo falla, tarda demasiado o llega incompleto.
  private async documentosCompletos(): Promise<{ documentos: ReturnType<typeof documentosDeConversacion>; traidos: MensajeConversacion[] } | null> {
    const localId = this.conversacionActivaId
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const docenteId = session?.user?.id
      if (!docenteId || !localId) return null
      return await conLimiteDeTiempoAccion((async () => {
        const indice = await leerIndiceDocumental(docenteId, localId)
        const documentos = documentosDeConversacion(this.mensajes, indice)
        const faltan = [...new Set(documentos.filter((d) => d.titulo === undefined).map((d) => d.idTitulo))]
        const traidos = faltan.length ? await leerMensajesRemotosPorId(docenteId, await idRemotoDe(docenteId, localId), faltan) : []
        const titulos = new Map(traidos.map((m) => [m.id, contenidoDocumentoDe(m)?.trim().split('\n')[0]]))
        if (faltan.some((id) => titulos.get(id) === undefined)) return null
        return { documentos: documentos.map((d) => (d.titulo === undefined ? { ...d, titulo: titulos.get(d.idTitulo) } : d)), traidos }
      })(), LIMITE_INDICE_DOCUMENTAL_MS, 'índice documental')
    } catch (e) {
      console.error('[INDICE_DOCUMENTAL] leido=false', e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e))
      return null
    }
  }

  // Respuesta a la aclaración sobre cuál documento que es el ÚLTIMO mensaje
  // (P3a): con el documento vigente igual que cuando se preguntó, completa
  // la solicitud original sobre el elegido. Una solicitud nueva y completa
  // sigue el camino normal; una respuesta breve que no elige a ninguno
  // repite la pregunta (nunca opera sobre el documento activo en su lugar).
  private async responderAclaracionDocumento(limpio: string, adjunto: AdjuntoImagen | undefined, sinVerificar: boolean): Promise<ResultadoEnvio | null> {
    const ultimo = this.mensajes[this.mensajes.length - 1]
    const aclaracion = ultimo?.rol === 'asistente' ? ultimo.aclaracionDocumento : undefined
    if (!aclaracion || resolverDocumentoVigente(this.mensajes)?.origenId !== aclaracion.origenId) return null
    // Una solicitud nueva y completa ("Corrige el primer citatorio") no es
    // la respuesta, aunque traiga un ordinal.
    if (pideOperacionDocumento(limpio)) return null
    const documentos = documentosDeConversacion(this.mensajes)
    const titulo = (id: string, i: number) => aclaracion.titulos?.[i] ?? documentos.find((d) => d.id === id)?.titulo ?? ''
    const eleccion = respuestaAclaracionDocumento(limpio, aclaracion.candidatos.map(titulo))
    if (typeof eleccion === 'number') return this.ejecutarConDestino(aclaracion.instruccion, limpio, aclaracion.candidatos[eleccion], adjunto, sinVerificar)
    if (eleccion === null && limpio.split(/\s+/).length > 6) return null
    return this.responderSinCambios(limpio, adjunto, PRECISAR_DOCUMENTO, aclaracion)
  }

  // Opera sobre el documento elegido (su versión vigente, también una
  // restaurada). Antes de cambiar nada se comprueba que sea un documento
  // disponible (si no está en memoria se trae por su id). Ver no cambia el
  // documento activo; elegirlo o editarlo/convertirlo sí, y el mensaje del
  // docente lo registra (documentoDestinoId) para el resto de dispositivos.
  private async ejecutarConDestino(instruccion: string, textoVisible: string, destinoId: string, adjunto: AdjuntoImagen | undefined, sinVerificar: boolean, traidos: MensajeConversacion[] = []): Promise<ResultadoEnvio> {
    const conversacion = this.conversacionActivaId
    // Ya leída con el índice (P3b): no se vuelve a pedir.
    const traido = traidos.find((m) => m.id === destinoId)
    if (traido && !this.mensajes.some((m) => m.id === destinoId)) this.mensajes = combinarMensajes(this.mensajes, [traido])
    if (!this.mensajes.some((m) => m.id === destinoId)) {
      await this.traerVersionRemota(destinoId)
      if (conversacion !== this.conversacionActivaId) return 'otra_conversacion'
    }
    const destino = this.mensajes.find((m) => m.id === destinoId)
    const texto = destino ? contenidoDocumentoDe(destino) : null
    if (!destino || !texto) return this.responderSinCambios(textoVisible, adjunto, MENSAJE_DOCUMENTO_NOMBRADO_NO_DISPONIBLE)
    if (esConsultaDocumentoActual(instruccion, texto)) {
      this.aplicarSeleccionVersion(textoVisible, 'consultar', 'anterior', { id: destino.id, distinto: true }, adjunto, destino.id === this.documentoActivo?.id ? MENSAJE_DOCUMENTO_ACTUAL_CONSULTADO : MENSAJE_DOCUMENTO_NOMBRADO_CONSULTADO)
      return 'enviado'
    }
    if (sinVerificar) {
      this.mostrarAvisoGeneracion(MENSAJE_DOCUMENTO_SIN_VERIFICAR, true)
      this.notificar()
      return 'no_enviado'
    }
    const formato = destino.archivo?.tipo
    if (destinoNombrado(instruccion)?.seleccion) {
      const yaActivo = destino.id === this.documentoActivo?.id
      this.transcripcionParcial = ''
      this.mensajes = [
        ...this.mensajes,
        { id: nuevoId(), rol: 'usuario', texto: textoVisible, creadoEn: marcaTiempo(), imagen: adjunto, ...(yaActivo ? {} : { documentoDestinoId: destino.id }) },
        { id: nuevoId(), rol: 'asistente', texto: yaActivo ? `Ya estamos trabajando con «${tituloVisible(texto.trim().split('\n')[0] ?? '')}».` : `Listo: ahora trabajo con «${tituloVisible(texto.trim().split('\n')[0] ?? '')}». Los siguientes cambios y archivos partirán de él.`, creadoEn: marcaTiempo() },
      ]
      if (!yaActivo) this.documentoActivo = { id: destino.id, texto, archivosGenerados: {}, ...(formato ? { ultimoFormatoGenerado: formato } : {}) }
      this.mostrarArchivoReutilizado(destino.id)
      this.turnoAbierto = null
      this.notificar()
      return 'enviado'
    }
    // Editar o convertir: el documento activo pasa al elegido para esta
    // operación; si no llega a escribirse el mensaje del docente, vuelve.
    const previo = this.documentoActivo
    const cambia = destino.id !== previo?.id
    if (cambia) this.documentoActivo = { id: destino.id, texto, archivosGenerados: {}, ...(formato ? { ultimoFormatoGenerado: formato } : {}) }
    this.destinoPendiente = { ...(cambia ? { id: destino.id } : {}), ...(textoVisible !== instruccion ? { burbuja: textoVisible } : {}) }
    try {
      await this.operarDocumentoActivo(instruccion, adjunto)
    } finally {
      if (this.destinoPendiente) {
        this.destinoPendiente = null
        if (cambia) this.documentoActivo = previo
        this.notificar()
      }
    }
    return 'enviado'
  }

  // Aviso o aclaración sin cambiar nada: la burbuja del docente y la
  // respuesta, sin IA.
  private responderSinCambios(limpio: string, adjunto: AdjuntoImagen | undefined, texto: string, aclaracionDocumento?: MensajeConversacion['aclaracionDocumento']): ResultadoEnvio {
    this.transcripcionParcial = ''
    this.mensajes = [...this.mensajes, { id: nuevoId(), rol: 'usuario', texto: limpio, creadoEn: marcaTiempo(), imagen: adjunto }, { id: nuevoId(), rol: 'asistente', texto, creadoEn: marcaTiempo(), ...(aclaracionDocumento ? { aclaracionDocumento } : {}) }]
    this.turnoAbierto = null
    this.notificar()
    return 'enviado'
  }

  private aclararDocumento(limpio: string, adjunto: AdjuntoImagen | undefined, candidatos: { id: string; titulo?: string; creadoEn: number }[], incompleta: boolean): ResultadoEnvio {
    const origenId = resolverDocumentoVigente(this.mensajes)?.origenId ?? this.documentoActivo?.id ?? ''
    const conTitulo = candidatos.map((c) => ({ titulo: c.titulo ?? '', creadoEn: c.creadoEn }))
    return this.responderSinCambios(limpio, adjunto, aclararCualDocumento(conTitulo, incompleta), { origenId, instruccion: limpio, candidatos: candidatos.map((c) => c.id), titulos: conTitulo.map((c) => c.titulo) })
  }

  // Cierre de una edición de contenido (no de una conversión): devuelve el
  // documento de origen y limpia el estado de edición. Lo usan la
  // finalización normal y la de voz (finalPendiente).
  private tomarOrigenDeEdicion(): string | null {
    const origen = this.editandoDocumentoId
    if (!origen || this.documentoFinalizandoId === origen) return null
    this.editandoDocumentoId = null
    this.ultimoIntentoEdicion = null
    return origen
  }

  // Vincula la respuesta de una edición como versión nueva del documento
  // de origen, solo si es un documento y todavía no está vinculada (una
  // finalización repetida no la reescribe).
  private vincularVersion(idVersion: string, idOrigen: string) {
    const idx = this.mensajes.findIndex((m) => m.id === idVersion)
    const origen = this.mensajes.find((m) => m.id === idOrigen)
    const version = idx !== -1 ? this.mensajes[idx] : undefined
    if (!version || !origen || version.id === origen.id || version.versionDe || !contenidoDocumentoDe(version)) return
    this.mensajes = [...this.mensajes.slice(0, idx), { ...version, versionDe: origen.id, documentoRaizId: documentoRaizDe(origen) }, ...this.mensajes.slice(idx + 1)]
  }

  // --- Versiones de un documento: consultar y restaurar (P2c) ---
  // Selección determinista, solo con vínculos explícitos (P2b) a partir del
  // documento activo:
  // - "anterior": su versión padre (versionDe); "primera": su raíz.
  // - Un tipo nombrado ("del citatorio") solo valida contra el título del
  //   documento activo; si no coincide, se pide aclaración (nunca se elige
  //   otro documento por su título).
  // - "Documento anterior": la versión anterior si en la conversación no hay
  //   otros documentos; el otro documento si el activo no tiene versión
  //   previa, no viene de una restauración y hay exactamente uno distinto;
  //   si no (o si la conversación local puede estar incompleta), aclaración.
  // - Ramas: si el activo viene de una restauración y antes se usaba una
  //   versión de OTRA rama (que no desciende de él), "anterior" es ambiguo:
  //   aclaración. Retroceder paso a paso (V3 → V2 → V1) no lo es.
  // La versión que no está en memoria se trae por su id (P2c-2). Devuelve
  // null si el docente cambió de conversación durante esa lectura.
  private async seleccionarVersion(solicitud: SolicitudVersion): Promise<SeleccionVersion | null> {
    const activo = this.documentoActivo
    const actual = this.mensajes.find((m) => m.id === activo?.id)
    if (!activo || !actual) return { aviso: MENSAJE_VERSION_NO_DISPONIBLE }
    if (solicitud.tipo && !tituloNombraTipo(activo.texto, solicitud.tipo)) return { aviso: ACLARAR_TIPO_NOMBRADO }
    const raiz = documentoRaizDe(actual)
    const vigente = resolverDocumentoVigente(this.mensajes)
    const origenId = vigente?.origenId ?? actual.id
    const versionId = solicitud.objetivo === 'primera' ? raiz : actual.versionDe
    if (solicitud.referencia === 'documento') {
      const otras = new Set(this.mensajes.filter((m) => contenidoDocumentoDe(m)).map((m) => documentoRaizDe(m)).filter((r) => r !== raiz))
      const restaurado = !!vigente && vigente.origenId !== vigente.documento.id
      // Con la conversación posiblemente incompleta en el dispositivo (la
      // copia guarda los últimos TOPE_MENSAJES), puede haber otros
      // documentos que no se ven: no se puede descartar que sea otro.
      const incompleta = this.mensajes.length >= TOPE_MENSAJES
      const otroDocumento = otras.size === 1 && !incompleta ? [...this.mensajes].reverse().find((m) => contenidoDocumentoDe(m) && documentoRaizDe(m) === [...otras][0])?.id : undefined
      if ((otras.size > 0 || incompleta) && (actual.versionDe || solicitud.objetivo === 'primera' || restaurado || incompleta)) {
        return { aviso: ACLARAR_VERSION_O_DOCUMENTO, aclaracion: { accion: 'restaurar', objetivo: solicitud.objetivo, origenId, ...(versionId && versionId !== actual.id ? { version: versionId } : {}), ...(otroDocumento ? { otroDocumento } : { varios: true }) } }
      }
      if (otras.size > 1) return { aviso: ACLARAR_CUAL_DOCUMENTO }
      if (otroDocumento) return this.confirmarDestino(otroDocumento, true, raiz)
    }
    if (!versionId || versionId === actual.id) return { aviso: MENSAJE_SIN_VERSION_ANTERIOR }
    if (solicitud.objetivo === 'anterior') {
      // Solo tras una restauración: elegir otro documento (P3a) no crea
      // ramas en el historial de este.
      const idx = vigente && vigente.origenId !== vigente.documento.id && this.mensajes.some((m) => m.id === vigente.origenId && m.restauraVersion) ? this.mensajes.findIndex((m) => m.id === vigente.origenId) : -1
      const antesDeRestaurar = idx > 0 ? resolverDocumentoVigente(this.mensajes.slice(0, idx))?.documento.id : undefined
      if (antesDeRestaurar && antesDeRestaurar !== versionId && antesDeRestaurar !== actual.id && !this.desciendeDe(antesDeRestaurar, actual.id)) {
        return { aviso: ACLARAR_RAMA, aclaracion: { accion: 'restaurar', objetivo: 'anterior', origenId, version: versionId, previa: antesDeRestaurar } }
      }
    }
    return this.confirmarDestino(versionId, false, raiz)
  }

  // La versión elegida: si no está en memoria se trae por su id (P2c-2) y
  // se valida que sea un documento de la misma raíz (o de otra, si se pidió
  // otro documento). null si el docente cambió de conversación mientras.
  private async confirmarDestino(destinoId: string, distinto: boolean, raiz: string): Promise<SeleccionVersion | null> {
    const conversacion = this.conversacionActivaId
    if (!this.mensajes.some((m) => m.id === destinoId)) {
      await this.traerVersionRemota(destinoId)
      if (conversacion !== this.conversacionActivaId) return null
    }
    const destino = this.mensajes.find((m) => m.id === destinoId)
    const valido = !!destino && !!contenidoDocumentoDe(destino) && (distinto ? documentoRaizDe(destino) !== raiz : documentoRaizDe(destino) === raiz)
    return valido ? { id: destino!.id, distinto } : { aviso: MENSAJE_VERSION_NO_DISPONIBLE }
  }

  // Respuesta a la aclaración que es el ÚLTIMO mensaje de esta
  // conversación ("A la versión anterior", "Al otro documento"): completa
  // la acción original con los ids que la aclaración guardó, solo si el
  // documento vigente sigue siendo el mismo de entonces. null si no aplica
  // (no hay aclaración vigente, la respuesta no es inequívoca o el contexto
  // cambió): el mensaje sigue el camino normal y la aclaración queda atrás.
  private async responderAclaracion(limpio: string, adjunto?: AdjuntoImagen): Promise<boolean | null> {
    const ultimo = this.mensajes[this.mensajes.length - 1]
    const aclaracion = ultimo?.rol === 'asistente' ? ultimo.aclaracionVersion : undefined
    const respuesta = aclaracion ? respuestaAclaracionVersion(limpio) : null
    const activo = this.mensajes.find((m) => m.id === this.documentoActivo?.id)
    if (!aclaracion || !respuesta || !activo || this.documentoActivo?.noRecuperado) return null
    // Una solicitud nueva y completa no es la respuesta: si nombra un tipo
    // ("del citatorio") o pide convertir o editar, sigue el camino normal
    // con sus validaciones. Si trae su propio verbo (muéstrame, regresa),
    // manda ese verbo sobre el de la aclaración.
    const solicitud = detectarSolicitudVersion(limpio)
    if (solicitud && (solicitud.tipo || solicitud.accion === 'convertir' || solicitud.accion === 'editar')) return null
    const accion = solicitud?.accion === 'consultar' || solicitud?.accion === 'restaurar' ? solicitud.accion : aclaracion.accion
    if (resolverDocumentoVigente(this.mensajes)?.origenId !== aclaracion.origenId) return null
    // Sigue sin elegir una sola opción: solo se repite la precisión que
    // falta, con el mismo contexto.
    if (respuesta === 'imprecisa') {
      this.aplicarSeleccionVersion(limpio, accion, aclaracion.objetivo, { aviso: aclaracion.previa ? PRECISAR_RAMA : PRECISAR_VERSION_O_DOCUMENTO, aclaracion: { ...aclaracion, accion } }, adjunto)
      return true
    }
    const raiz = documentoRaizDe(activo)
    const objetivo = respuesta.primera ? 'primera' : aclaracion.objetivo
    let seleccion: SeleccionVersion | null
    if (respuesta.eleccion === 'otro') {
      seleccion = aclaracion.otroDocumento ? await this.confirmarDestino(aclaracion.otroDocumento, true, raiz) : { aviso: aclaracion.varios ? ACLARAR_CUAL_DOCUMENTO : MENSAJE_SIN_OTRO_DOCUMENTO }
    } else if (respuesta.eleccion === 'previa') {
      if (!aclaracion.previa) return null
      seleccion = await this.confirmarDestino(aclaracion.previa, false, raiz)
    } else {
      const versionId = respuesta.primera ? raiz : aclaracion.version
      seleccion = versionId && versionId !== activo.id ? await this.confirmarDestino(versionId, false, raiz) : { aviso: MENSAJE_SIN_VERSION_ANTERIOR }
    }
    if (!seleccion) return false
    this.aplicarSeleccionVersion(limpio, accion, objetivo, seleccion, adjunto)
    return true
  }

  // ¿La versión `id` desciende de `ancestro` siguiendo versionDe (solo con
  // los mensajes de esta conversación)?
  private desciendeDe(id: string, ancestro: string): boolean {
    let actual = this.mensajes.find((m) => m.id === id)
    for (let paso = 0; actual?.versionDe && paso < 200; paso++) {
      if (actual.versionDe === ancestro) return true
      const padre: string = actual.versionDe
      actual = this.mensajes.find((m) => m.id === padre)
    }
    return false
  }

  // Consultar no cambia nada: se responde y se lleva la vista a esa versión
  // (el mismo resaltado que un archivo reutilizado; si estaba fuera de la
  // ventana local, se trajo por su id y se muestra en su lugar).
  // Restaurar agrega el marcador (P2c-1): solo referencias, nunca el
  // contenido; el documento activo pasa a esa versión exacta, con la caché
  // de archivos vacía (era de otra versión). Sin IA. Devuelve false si el
  // docente cambió de conversación durante una lectura remota (no se
  // escribe nada en ninguna).
  private async atenderSolicitudVersion(limpio: string, solicitud: SolicitudVersion, adjunto?: AdjuntoImagen): Promise<boolean> {
    const seleccion = await this.seleccionarVersion(solicitud)
    if (!seleccion) return false
    // La acción original viaja en la aclaración (consultar o restaurar).
    if ('aclaracion' in seleccion && seleccion.aclaracion) seleccion.aclaracion.accion = solicitud.accion === 'consultar' ? 'consultar' : 'restaurar'
    this.aplicarSeleccionVersion(limpio, solicitud.accion === 'consultar' ? 'consultar' : 'restaurar', solicitud.objetivo, seleccion, adjunto)
    return true
  }

  // Muestra la versión vigente del documento activo (si no está en memoria,
  // se trae por su id). false si el docente cambió de conversación mientras.
  private async mostrarDocumentoActual(limpio: string): Promise<boolean> {
    const conversacion = this.conversacionActivaId
    const activo = this.documentoActivo!
    if (!this.mensajes.some((m) => m.id === activo.id)) {
      await this.traerVersionRemota(activo.id)
      if (conversacion !== this.conversacionActivaId) return false
    }
    const mensaje = this.mensajes.find((m) => m.id === activo.id)
    const seleccion = mensaje ? await this.confirmarDestino(activo.id, false, documentoRaizDe(mensaje)) : { aviso: MENSAJE_VERSION_NO_DISPONIBLE }
    if (!seleccion) return false
    this.aplicarSeleccionVersion(limpio, 'consultar', 'anterior', seleccion, undefined, MENSAJE_DOCUMENTO_ACTUAL_CONSULTADO)
    return true
  }

  private aplicarSeleccionVersion(limpio: string, accion: 'consultar' | 'restaurar', objetivo: 'anterior' | 'primera', seleccion: SeleccionVersion, adjunto?: AdjuntoImagen, textoConsulta?: string) {
    const restaurar = accion === 'restaurar'
    const destino = 'id' in seleccion ? this.mensajes.find((m) => m.id === seleccion.id) : undefined
    const texto = destino ? contenidoDocumentoDe(destino) : null
    // La pregunta recibe su id y su fecha antes que la respuesta (P2c).
    const pregunta: MensajeConversacion = { id: nuevoId(), rol: 'usuario', texto: limpio, creadoEn: marcaTiempo(), imagen: adjunto }
    let respuesta: MensajeConversacion
    if (!destino || !texto || !('id' in seleccion)) {
      const aviso = 'aviso' in seleccion ? seleccion.aviso : MENSAJE_VERSION_NO_DISPONIBLE
      const aclaracion = 'aclaracion' in seleccion ? seleccion.aclaracion : undefined
      respuesta = { id: nuevoId(), rol: 'asistente', texto: aviso, creadoEn: marcaTiempo(), ...(aclaracion ? { aclaracionVersion: aclaracion } : {}) }
    } else if (restaurar) {
      const confirmacion = seleccion.distinto ? MENSAJE_DOCUMENTO_ANTERIOR_RESTAURADO : objetivo === 'primera' ? MENSAJE_PRIMERA_VERSION_RESTAURADA : MENSAJE_VERSION_ANTERIOR_RESTAURADA
      respuesta = { id: nuevoId(), rol: 'asistente', texto: confirmacion, creadoEn: marcaTiempo(), restauraVersion: destino.id, documentoRaizId: documentoRaizDe(destino) }
    } else {
      const consulta = textoConsulta ?? (seleccion.distinto ? MENSAJE_DOCUMENTO_ANTERIOR_CONSULTADO : objetivo === 'primera' ? MENSAJE_PRIMERA_VERSION_CONSULTADA : MENSAJE_VERSION_ANTERIOR_CONSULTADA)
      respuesta = { id: nuevoId(), rol: 'asistente', texto: consulta, creadoEn: marcaTiempo() }
    }
    this.transcripcionParcial = ''
    this.mensajes = [...this.mensajes, pregunta, respuesta]
    if (destino && texto && restaurar) this.actualizarDocumentoActivo(destino.id, texto)
    if (destino && texto && !restaurar) this.mostrarArchivoReutilizado(destino.id)
    this.turnoAbierto = null
    this.notificar()
  }

  // Trae un mensaje de ESTA conversación por su id y lo intercala en su
  // lugar (no lo modifica ni crea nada). Si falla, no se agrega nada.
  private async traerVersionRemota(id: string) {
    const conversacion = this.conversacionActivaId
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const docenteId = session?.user?.id
      if (!docenteId || !conversacion) return
      const traidos = await leerMensajesRemotosPorId(docenteId, await idRemotoDe(docenteId, conversacion), [id])
      if (conversacion === this.conversacionActivaId) this.mensajes = combinarMensajes(this.mensajes, traidos)
    } catch (e) {
      console.error('[VERSION_RESTAURADA] recuperada=false', e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e))
    }
  }

  // El mensaje trabaja sobre el documento activo (edición o conversión),
  // con las mismas excepciones de siempre: aprobar la planeación, pedir
  // un documento nuevo o editar y entregar otro documento.
  private documentoConIdentificador(d: { id: string; titulo?: string }, identificador: string[]): boolean {
    const mensaje = this.mensajes.find((m) => m.id === d.id)
    return documentoTieneIdentificador((mensaje ? contenidoDocumentoDe(mensaje) : null) ?? d.titulo ?? '', identificador)
  }

  // Consulta de una planeación GUARDADA ("Muéstrame la planeación de
  // cuentos propios", "¿qué planeaciones trabajé en noviembre?"): va como
  // mensaje normal y el servidor la resuelve con la versión VIGENTE, sin
  // IA ni el documento local (ver consultaPlaneacionEnServidor).
  private esConsultaPlaneacionGuardada(limpio: string): boolean {
    const activo = this.documentoActivo
    const i = activo ? this.mensajes.findIndex((m) => m.id === activo.id) : -1
    const posteriores = i === -1 ? [] : this.mensajes.slice(i + 1).filter((m) => m.rol === 'asistente').map((m) => m.texto)
    return consultaPlaneacionEnServidor(limpio, fechaISOHoy(obtenerZonaHorariaDispositivo()), activo?.texto ?? null, posteriores)
  }

  private trabajaSobreDocumentoActivo(limpio: string): boolean {
    if (this.esConsultaPlaneacionGuardada(limpio)) return false
    const documento = this.documentoActivo
    // Un documento identificado por su nombre que no es el activo ("la
    // planeación de las leyendas" con otra abierta), o una pregunta sobre
    // la colección ("¿qué planeaciones trabajé en noviembre?"), no es
    // trabajo sobre él: va como mensaje normal (el servidor la resuelve).
    return !!documento && !detectarAprobarPlaneacion(limpio, { hayBorradorPlaneacion: esBorradorPlaneacion(documento.texto) }) && !esPedidoDocumentoNuevo(limpio) && !nombraOtroDocumento(limpio, documento.texto) && !refiereColeccionDeDocumentos(limpio) && !(esEdicionConFormato(limpio) && !referenciaCompatibleConDocumento(limpio, documento.texto))
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
    this.mensajes = [...this.mensajes, { id: nuevoId(), rol: 'usuario', texto, creadoEn: marcaTiempo(), imagenes: adjuntos }]
    this.turnoAbierto = null
    this.notificar()

    try {
      this.marcarSolicitud()
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
    this.mensajes = [...this.mensajes, { id: nuevoId(), rol: 'usuario', texto, creadoEn: marcaTiempo(), imagen: adjunto }]
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
        { id: nuevoId(), rol: 'asistente', texto: cuerpo.texto || '', creadoEn: marcaTiempo(), acciones, datosAccionCalendario },
      ]
    } catch (err) {
      const mensajeError =
        err instanceof Error && err.name === 'AbortError'
          ? 'El análisis del calendario tardó demasiado. Intenta de nuevo.'
          : err instanceof Error
            ? err.message
            : 'No pude analizar la imagen del calendario. Intenta de nuevo.'
      this.mensajes = [...this.mensajes, { id: nuevoId(), rol: 'asistente', texto: mensajeError, creadoEn: marcaTiempo() }]
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
        { id: nuevoId(), rol: 'asistente', texto: 'De acuerdo, no realicé ningún cambio en el calendario.', creadoEn: marcaTiempo() },
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
        { id: nuevoId(), rol: 'asistente', texto: 'No encontré los cambios pendientes de ese análisis. Envía de nuevo la foto del calendario.', creadoEn: marcaTiempo() },
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
        { id: nuevoId(), rol: 'asistente', texto: cuerpo.texto || '✅ Calendario actualizado correctamente.', creadoEn: marcaTiempo(), archivo },
      ]
    } catch (err) {
      const mensajeError =
        err instanceof Error && err.name === 'AbortError'
          ? 'La actualización del calendario tardó demasiado. Intenta de nuevo.'
          : err instanceof Error
            ? err.message
            : 'No pude actualizar el calendario. Intenta de nuevo.'
      this.mensajes = [...this.mensajes, { id: nuevoId(), rol: 'asistente', texto: `No pude actualizar el calendario: ${mensajeError}`, creadoEn: marcaTiempo() }]
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

  // El docente marcó operaciones de una propuesta de lista oficial y tocó
  // "Aplicar seleccionados" (ver TarjetaPropuestaLista). Mismo patrón que
  // confirmarAccionCalendario: nunca decide nada, solo envía al servidor
  // el token opaco y el identificador de cada operación elegida.
  // /api/lista-oficial/aplicar descifra, revalida todo y la RPC garantiza
  // el uso único. Al terminar (aplicada o rechazada sin remedio) el token
  // y la vista se descartan del mensaje: solo quedan el estado y el aviso.
  async confirmarPropuestaLista(mensajeId: string, operacionIds: string[]) {
    const mensaje = this.mensajes.find((m) => m.id === mensajeId)
    const datos = mensaje?.datosPropuestaLista
    if (!mensaje || !datos || datos.estado !== 'pendiente' || !datos.token || !datos.operaciones || this.propuestaListaEnCurso || operacionIds.length === 0) return

    const cerrar = (estado: 'aplicada' | 'cerrada', aviso: string) => {
      this.mensajes = this.mensajes.map((m) => (m.id === mensajeId ? { ...m, datosPropuestaLista: { estado, expiraEn: datos.expiraEn, aviso } } : m))
    }
    const agregarMensaje = (texto: string) => {
      this.mensajes = [...this.mensajes, { id: nuevoId(), rol: 'asistente', texto, creadoEn: marcaTiempo() }]
    }
    if (Date.now() >= Date.parse(datos.expiraEn)) {
      cerrar('cerrada', MENSAJE_PROPUESTA_VENCIDA)
      agregarMensaje(MENSAJE_PROPUESTA_VENCIDA)
      this.notificar()
      this.persistirConversacion()
      return
    }

    // Solo operaciones aplicables de la vista; el servidor arma las
    // confirmaciones desde lo firmado.
    const elegidas = new Set(operacionIds)
    const seleccion = datos.operaciones.filter((op) => op.aplicable && elegidas.has(op.operacionId)).map((op) => op.operacionId)
    if (seleccion.length === 0) return

    this.propuestaListaEnCurso = mensajeId
    this.notificar()
    const controlador = new AbortController()
    const temporizadorFetch = setTimeout(() => controlador.abort(), 55_000)
    try {
      const { session } = await conLimiteDeTiempoAccion(obtenerPerfilYSesion(), 12_000, 'Tiempo de espera agotado obteniendo la sesión del docente')
      const res = await fetch('/api/lista-oficial/aplicar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: datos.token, operacionIds: seleccion, accessToken: session?.access_token || null }),
        signal: controlador.signal,
      })
      const cuerpo = await res.json().catch(() => null) as { exito?: boolean; codigo?: string; error?: string; mensaje?: string } | null
      if (cuerpo?.exito) {
        const texto = cuerpo.mensaje || 'Listo: apliqué los cambios a tu lista.'
        cerrar('aplicada', texto)
        agregarMensaje(texto)
      } else {
        const texto = cuerpo?.error || 'No pude aplicar los cambios. No se modificó nada; intenta de nuevo en unos segundos.'
        // Los errores temporales dejan la propuesta disponible para
        // reintentar; cualquier otro rechazo la cierra.
        if (!cuerpo?.codigo || CODIGOS_PROPUESTA_REINTENTABLES.has(cuerpo.codigo)) {
          agregarMensaje(texto)
        } else {
          cerrar('cerrada', texto)
          agregarMensaje(texto)
        }
      }
    } catch (err) {
      agregarMensaje(err instanceof Error && err.name === 'AbortError'
        ? 'Aplicar los cambios tardó demasiado. No se modificó nada; intenta de nuevo.'
        : 'No pude aplicar los cambios. No se modificó nada; intenta de nuevo en unos segundos.')
    } finally {
      clearTimeout(temporizadorFetch)
      this.propuestaListaEnCurso = null
      this.notificar()
      this.persistirConversacion()
    }
  }

  // AsistentePanel llama esto justo después de hacer router.push, para
  // que la navegación nunca se repita si el snapshot se vuelve a leer
  // (ej. al volver a montar el efecto).
  limpiarNavegacionPendiente() {
    this.accionNavegacionPendiente = null
    this.notificar()
  }

  // Camino EXCLUSIVO del mensaje de texto normal ("conviértelo a PDF"
  // escrito por el docente) — SÍ crea una burbuja real porque el
  // docente sí escribió algo (ver reutilizarArchivoExistente/
  // enviarComoFinalizacion más abajo). Ver "CONTENCIÓN DEFINITIVA —
  // retirar temporalmente Convertir de todas las tarjetas de
  // documentos": el botón "Convertir" de la tarjeta universal fue
  // retirado por completo (ya no existe ningún callback de conversión
  // disparado por botón); este es ahora el ÚNICO camino de conversión
  // de formato que queda en la aplicación.
  private async ejecutarConversionFormato(tipoResuelto: TipoHerramienta, textoVisible: string) {
    if (!this.documentoActivo) return
    const archivoExistente = this.documentoActivo.archivosGenerados?.[tipoResuelto]
    if (archivoExistente) {
      this.reutilizarArchivoExistente(textoVisible, archivoExistente)
      return
    }
    await this.enviarComoFinalizacion(this.documentoActivo.id, textoVisible, tipoResuelto, this.documentoActivo.texto)
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


  // El motor de texto necesita ver la conversación real (turnos previos)
  // para no "olvidar" de qué se está hablando entre un mensaje y el
  // siguiente — se sincroniza con el historial de ANTES de agregar el
  // mensaje que se está por enviar (ese va aparte, como el turno actual).
  // No tiene efecto en el motor de voz (la sesión de Realtime ya es
  // stateful del lado del servidor mientras dura la llamada).
  // Una restauración (P2c) va al modelo con el contenido de la versión
  // restaurada (solo en lo enviado; lo guardado no cambia): así el último
  // documento del historial —el que usa el servidor, p. ej. al aprobar una
  // planeación— es la versión vigente y no la que se dejó atrás.
  private sincronizarHistorialTexto() {
    const historial = this.mensajes.slice(-20).map((m) => {
      if (!m.restauraVersion) return m
      const version = this.mensajes.find((x) => x.id === m.restauraVersion)
      const texto = version ? contenidoDocumentoDe(version) : null
      return texto ? { ...m, texto } : m
    })
    this.motorTexto?.establecerHistorial(historial)
    this.motorTexto?.establecerConversacion(this.conversacionActivaId)
  }

  private async enviarComoEdicion(idDocumento: string, textoVisible: string, textoParaModelo: string, adjunto?: AdjuntoImagen, formatoEntrega?: FormatoEntrega) {
    await this.asegurarMotor()
    this.sincronizarHistorialTexto()
    this.transcripcionParcial = ''
    const mensajeDocente = this.mensajeDocente(textoVisible, adjunto)
    const turno = !adjunto && !formatoEntrega ? this.identidadDeTurno(mensajeDocente, true) : undefined
    this.mensajes = [...this.mensajes, mensajeDocente]
    // Append-only: la respuesta de una edición de contenido es un turno
    // NUEVO, nunca continuación de un turnoAbierto residual de antes.
    // editandoDocumentoId sigue siendo solo el documento FUENTE.
    this.turnoAbierto = null
    this.editandoDocumentoId = idDocumento
    // Se guarda para poder reintentar exactamente esto mismo si falla —
    // ver reintentarGeneracion(). Se limpia solo cuando la edición
    // termina bien (ver 'respuesta-final').
    this.ultimoIntentoEdicion = { idDocumento, textoParaModelo, adjunto, formatoEntrega }
    this.notificar()
    if (turno) await this.persistirIdentidadDelTurno(mensajeDocente)
    await this.ejecutarEdicion(textoParaModelo, adjunto, formatoEntrega, turno)
  }

  // Aislado de enviarComoEdicion() para que reintentarGeneracion() pueda
  // reusarlo sin repetir la burbuja del docente (ya está en pantalla de
  // la vez anterior) ni perder this.ultimoIntentoEdicion.
  private async ejecutarEdicion(textoParaModelo: string, adjunto?: AdjuntoImagen, formatoEntrega?: FormatoEntrega, turno?: TurnoSolicitud) {
    try {
      // OJO: editandoDocumentoId NO se limpia aquí en el catch — lo hace
      // el propio manejador de 'error' (ver manejarEventoMotor), que
      // necesita verlo todavía puesto para saber que esto fue una falla
      // de documento y mostrar el aviso breve en vez de una burbuja.
      // esEdicionDocumento=true: textoParaModelo es un prompt interno
      // (construirPromptEdicion en documentos.ts), no algo que el maestro escribió — jamás
      // debe interpretarse en /api/chat como una solicitud de archivo
      // (ver esEdicionDocumento en app/api/chat/route.ts).
      this.marcarSolicitud()
      await (await this.motorDeContenido())?.enviarTexto(textoParaModelo, adjunto, undefined, true, undefined, undefined, undefined, undefined, formatoEntrega, turno)
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
    // La pregunta recibe su id y su fecha antes que la entrega (P2c).
    const pregunta = this.mensajeDocente(textoVisible)
    const idMensaje = nuevoId()
    this.mensajes = [
      ...this.mensajes,
      pregunta,
      { id: idMensaje, rol: 'asistente', texto: AVISO_ARCHIVO_LISTO, creadoEn: marcaTiempo(), archivo, ...(this.documentoActivo ? { documentoOrigenId: this.documentoActivo.id } : {}) },
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
    this.mensajes = [...this.mensajes, this.mensajeDocente(textoVisible)]
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
      this.marcarSolicitud()
      await motorTexto.enviarTexto(textoOriginal, undefined, { tipo, documentoTexto })
    } catch {
      this.manejarEventoMotor({ tipo: 'error', mensaje: 'No pude generar el archivo. Toca para reintentar.' })
    }
  }

  // Reintenta la última generación/edición de documento que falló, sin
  // que el maestro tenga que volver a escribir el mensaje — el documento
  // activo y el resto de la conversación se conservan tal cual.
  async reintentarGeneracion() {
    if (this.avisoInformativo) {
      if (this.avisoGeneracionTimer) { clearTimeout(this.avisoGeneracionTimer); this.avisoGeneracionTimer = null }
      this.avisoGeneracion = null
      this.avisoInformativo = false
      this.notificar()
      return
    }
    if (!this.ultimoIntentoEdicion) return
    const { idDocumento, textoParaModelo, adjunto, finalizarArchivo, formatoEntrega } = this.ultimoIntentoEdicion
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
      await this.ejecutarEdicion(textoParaModelo, adjunto, formatoEntrega)
    }
  }

  // ===================================================================
  // Turnos duraderos (lib/chat/turnosChat.ts). Cada mensaje escrito tiene
  // una identidad persistente (MensajeConversacion.turno) guardada antes de
  // enviarse. La respuesta solo se da por guardada con la confirmación del
  // servidor ([[TURNO:…]], emitida después de guardar): entonces adopta el
  // id canónico del mensaje que creó el servidor y el cliente no escribe
  // otra copia. Sin confirmación (corte, inactividad, recarga, segundo
  // plano, otro dispositivo) se CONSULTA el turno —nunca se genera otra
  // vez—; un turno fallido solo se repite con un reintento explícito.
  // ===================================================================
  // consultando: hay una consulta en vuelo; ningún otro disparador lanza
  // otra (todos pasan por programarRecuperacion).
  private recuperaciones = new Map<string, { conversacion: string; intento: number; desde: number; timer: ReturnType<typeof setTimeout> | null; consultando: boolean }>()
  // Avisos en tiempo real (Supabase Realtime) de los turnos de la
  // conversación activa: un solo canal, abierto solo mientras hay una
  // recuperación en curso. Con el canal suscrito, las consultas espaciadas
  // quedan como respaldo lento; si falla, siguen como siempre.
  private canalTurnos: { conversacion: string; canal: ReturnType<typeof supabase.channel> | null; suscrito: boolean } | null = null
  // Respuesta adoptada en este turno: se registra como ya sincronizada
  // cuando el mensaje tiene sus tarjetas (antes de los metadatos que solo
  // conoce el cliente, como el vínculo de versión).
  private adopcionPendiente: { conversacionRemota: string; id: string } | null = null

  private recuperandoRespuestaActiva(): boolean {
    const activa = this.conversacionActivaId
    return !!activa && [...this.recuperaciones.values()].some((r) => r.conversacion === activa)
  }

  // Identidad del turno de un mensaje del docente (el id del mensaje es el
  // requestId de su primer intento).
  private identidadDeTurno(mensaje: MensajeConversacion, edicion = false): TurnoSolicitud {
    mensaje.turno = { requestId: mensaje.id, intento: 1, ...(edicion ? { edicion: true as const } : {}) }
    return { requestId: mensaje.id, mensajeUsuarioLocalId: mensaje.id }
  }

  // Guarda el mensaje del docente (con su turno) antes de enviarlo, con
  // límite de tiempo. Mientras tanto se muestra el indicador de generación;
  // el doble envío lo bloquea la reserva del envío (reservaEnvio). Al
  // terminar, el indicador vuelve a su estado: nunca queda pegado si el
  // motor no llega a emitir nada (p. ej. una interrupción).
  private async persistirIdentidadDelTurno(mensaje: MensajeConversacion): Promise<void> {
    const generabaAntes = this.generando
    this.generando = true
    this.notificar()
    // Primero en el dispositivo (sin esperar el guardado diferido), luego en
    // Supabase: la copia local nunca queda detrás de la remota.
    this.guardarInmediatamente()
    const conversacion = this.conversacionActivaId
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const docenteId = session?.user?.id
      if (!docenteId || !conversacion) return
      await Promise.race([guardarMensajesRemotos(conversacion, docenteId, [mensaje]), new Promise((r) => setTimeout(r, LIMITE_PERSISTENCIA_ANTES_DE_APROBAR_MS))])
    } catch {
      // Queda en la cola de persistencia; el turno sigue con su identidad.
    } finally {
      this.generando = generabaAntes
    }
  }

  private confirmarTurno(turno: MarcaTurno | { estado: 'sin_confirmar'; requestId: string }) {
    const indice = this.turnoAbierto ? this.mensajes.findIndex((m) => m.id === this.turnoAbierto) : -1
    const respuesta = indice === -1 ? undefined : this.mensajes[indice]
    if (turno.estado === 'completado') {
      // Completado sin mensaje del servidor (respuesta con archivos u otros
      // marcadores que solo el cliente procesa): el cliente guarda su copia,
      // la única que existe.
      if (!turno.mensajeAsistenteId || !respuesta) return
      const separador = turno.mensajeAsistenteId.indexOf(':')
      const conversacionRemota = turno.mensajeAsistenteId.slice(0, separador)
      const idCanonico = turno.mensajeAsistenteId.slice(separador + 1)
      // El mismo turno reproducido (reenvío o recuperación): su mensaje ya
      // está; la burbuja nueva se descarta (nunca dos copias).
      if (this.mensajes.some((m) => m.id === idCanonico && m !== respuesta)) {
        this.mensajes = this.mensajes.filter((m) => m !== respuesta)
        this.turnoAbierto = idCanonico
        return
      }
      const docente = this.mensajes.find((m) => m.rol === 'usuario' && m.turno?.requestId === turno.requestId)
      const adoptada: MensajeConversacion = {
        ...respuesta,
        id: idCanonico,
        // Hora del servidor del mensaje canónico: se conserva al agregar metadatos.
        ...(turno.creadoEn && !Number.isNaN(Date.parse(turno.creadoEn)) ? { creadoEn: Date.parse(turno.creadoEn) } : {}),
        turnoServidor: { requestId: turno.requestId, estado: 'guardado' },
        requestId: turno.requestId,
        ...(turno.turnoId ? { turnoId: turno.turnoId } : {}),
        ...(docente ? { mensajeUsuarioId: `${conversacionRemota}:${docente.id}` } : {}),
      }
      this.mensajes = [...this.mensajes.slice(0, indice), adoptada, ...this.mensajes.slice(indice + 1)]
      this.turnoAbierto = idCanonico
      this.adopcionPendiente = { conversacionRemota, id: idCanonico }
      if (docente?.turno?.reintento) this.marcarReintento(docente.id, undefined)
      return
    }
    // Sin confirmación de guardado (o el servidor no pudo guardarla): la
    // respuesta se ve, pero queda pendiente y se consulta el turno.
    if (respuesta) this.mensajes = [...this.mensajes.slice(0, indice), { ...respuesta, turnoServidor: { requestId: turno.requestId, estado: 'pendiente' } }, ...this.mensajes.slice(indice + 1)]
    this.programarRecuperacion(turno.requestId)
  }

  // La respuesta adoptada, ya con sus tarjetas, queda registrada como
  // sincronizada: el cliente no reescribe la fila que creó el servidor.
  private registrarAdopcion() {
    const pendiente = this.adopcionPendiente
    this.adopcionPendiente = null
    const mensaje = pendiente ? this.mensajes.find((m) => m.id === pendiente.id) : undefined
    if (!pendiente || !mensaje) return
    void supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user?.id) registrarMensajeDelServidor(session.user.id, pendiente.conversacionRemota, mensaje)
    })
  }

  private marcarReintento(mensajeId: string, reintento: 'fallido' | 'no_enviado' | 'ocupada' | undefined) {
    this.mensajes = this.mensajes.map((m) => {
      if (m.id !== mensajeId || !m.turno) return m
      const turno = { ...m.turno }
      delete turno.reintento
      return { ...m, turno: reintento ? { ...turno, reintento } : turno }
    })
  }

  // Estado del turno que no trajo respuesta por el stream.
  private atenderEstadoDeTurno(estado: Extract<EventoMotor, { tipo: 'turno' }>['estado'], requestId: string) {
    this.generando = false
    const parcial = this.turnoAbierto ? this.mensajes.find((m) => m.id === this.turnoAbierto) : undefined
    if (parcial?.rol === 'asistente') this.mensajes = this.mensajes.map((m) => (m === parcial ? { ...m, turnoServidor: { requestId, estado: 'pendiente' as const } } : m))
    this.turnoAbierto = null
    this.editandoDocumentoId = null
    this.documentoFinalizandoId = null
    this.textoDocumentoFinalizando = null
    if (estado === 'pendiente' || estado === 'en_proceso' || estado === 'mensaje_en_curso') this.programarRecuperacion(requestId)
    else if (estado === 'ocupada') {
      // Este mensaje no se ejecutó: queda para enviarlo con un toque; la
      // respuesta anterior se sigue recuperando.
      this.ofrecerReintento(requestId, 'ocupada')
      this.recuperarTurnosPendientes(requestId)
    } else this.ofrecerReintento(requestId, estado === 'invalido' || estado === 'conflicto' ? 'no_enviado' : 'fallido')
    this.notificar()
  }

  // Turnos pendientes de la conversación activa (abrir, recargar, volver
  // del segundo plano, recuperar la conexión). No mientras se genera.
  private recuperarTurnosPendientes(excepto?: string) {
    const conversacion = this.conversacionActivaId
    if (!conversacion || this.generando) return
    const diferidos = this.sincronizacionDiferida?.id === conversacion ? this.sincronizacionDiferida.nuevos : []
    for (const requestId of turnosPorRecuperar(combinarMensajes(this.mensajes, diferidos))) {
      if (requestId !== excepto) this.programarRecuperacion(requestId)
    }
  }

  private programarRecuperacion(requestId: string, demoraMs = 0) {
    const conversacion = this.conversacionActivaId
    if (!conversacion) return
    let actual = this.recuperaciones.get(requestId)
    // Programada desde otra conversación: se reemplaza por la de esta.
    if (actual && actual.conversacion !== conversacion) {
      if (actual.timer) clearTimeout(actual.timer)
      this.recuperaciones.delete(requestId)
      actual = undefined
    }
    // Punto único de todos los disparadores (corte del stream, volver a la
    // app, abrir la conversación, conexión recuperada, aviso en tiempo
    // real): con una consulta en vuelo no se lanza otra; una inmediata
    // adelanta la que estaba en espera, nunca la duplica.
    if (actual?.consultando) return
    if (actual?.timer) {
      if (demoraMs > 0) return
      clearTimeout(actual.timer)
      actual.timer = null
    }
    const estado = actual ?? { conversacion, intento: 0, desde: Date.now(), timer: null, consultando: false }
    estado.timer = setTimeout(() => void this.consultarTurnoPendiente(requestId), demoraMs)
    this.recuperaciones.set(requestId, estado)
    void this.actualizarCanalTurnos()
    this.notificar()
  }

  private terminarRecuperacion(requestId: string) {
    const r = this.recuperaciones.get(requestId)
    if (r?.timer) clearTimeout(r.timer)
    this.recuperaciones.delete(requestId)
    void this.actualizarCanalTurnos()
    this.notificar()
  }

  // Cambio de conversación: sus recuperaciones y su canal se cierran (al
  // volver a abrirla, la sincronización las retoma).
  private cancelarRecuperacionesAjenas() {
    for (const [requestId, r] of this.recuperaciones) {
      if (r.conversacion === this.conversacionActivaId) continue
      if (r.timer) clearTimeout(r.timer)
      this.recuperaciones.delete(requestId)
    }
    void this.actualizarCanalTurnos()
  }

  // Abre el canal de la conversación activa si tiene recuperaciones; si no,
  // lo cierra. Aislamiento: Realtime aplica la RLS de turnos_chat (solo los
  // turnos del docente) y además se filtra por conversación y docente.
  private async actualizarCanalTurnos() {
    const conversacion = this.conversacionActivaId
    const necesario = !!conversacion && [...this.recuperaciones.values()].some((r) => r.conversacion === conversacion)
    if (this.canalTurnos && (!necesario || this.canalTurnos.conversacion !== conversacion)) {
      const { canal } = this.canalTurnos
      this.canalTurnos = null
      if (canal) void supabase.removeChannel(canal)
    }
    if (!necesario || this.canalTurnos) return
    const entrada: NonNullable<AsistenteServiceImpl['canalTurnos']> = { conversacion: conversacion!, canal: null, suscrito: false }
    this.canalTurnos = entrada
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const docenteId = session?.user?.id
      if (!docenteId || this.canalTurnos !== entrada) return
      const remoto = await idRemotoDe(docenteId, entrada.conversacion)
      if (this.canalTurnos !== entrada) return
      entrada.canal = supabase
        .channel(`turnos:${remoto}`)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'turnos_chat', filter: `conversacion_id=eq.${remoto}` }, (cambio: { new?: Record<string, unknown> }) => {
          const fila = cambio.new
          if (this.canalTurnos !== entrada || !fila || fila.docente_id !== docenteId) return
          if ((fila.estado === 'completed' || fila.estado === 'failed') && typeof fila.request_id === 'string' && this.recuperaciones.has(fila.request_id)) {
            this.programarRecuperacion(fila.request_id, 0)
          }
        })
        .subscribe((estadoCanal: string) => { entrada.suscrito = estadoCanal === 'SUBSCRIBED' })
    } catch {
      // Sin canal: las consultas espaciadas siguen como siempre.
    }
  }

  private async consultarTurnoPendiente(requestId: string) {
    const r = this.recuperaciones.get(requestId)
    if (!r || r.consultando) return
    r.timer = null
    if (r.conversacion !== this.conversacionActivaId) return this.terminarRecuperacion(requestId)
    r.consultando = true
    let turno: Awaited<ReturnType<AsistenteServiceImpl['consultarTurno']>>
    try {
      turno = await this.consultarTurno(requestId)
    } finally {
      r.consultando = false
    }
    if (this.recuperaciones.get(requestId) !== r) return
    if (r.conversacion !== this.conversacionActivaId) return this.terminarRecuperacion(requestId)
    if (turno === 'no_encontrado') {
      // El servidor nunca recibió este envío: se ofrece enviarlo.
      this.terminarRecuperacion(requestId)
      this.ofrecerReintento(requestId, 'no_enviado')
      return
    }
    if (!turno || turno.estado === 'queued' || turno.estado === 'generating') {
      r.intento += 1
      if (Date.now() - r.desde > LIMITES_RECUPERACION.totalMs) return this.terminarRecuperacion(requestId)
      // Con avisos en tiempo real, la consulta es solo un respaldo lento.
      const espera = this.canalTurnos?.conversacion === r.conversacion && this.canalTurnos.suscrito
        ? LIMITES_RECUPERACION.respaldoConAvisosMs
        : ESPERAS_RECUPERACION_MS[Math.min(r.intento - 1, ESPERAS_RECUPERACION_MS.length - 1)]
      this.programarRecuperacion(requestId, espera)
      return
    }
    if (turno.estado === 'failed') {
      this.terminarRecuperacion(requestId)
      this.ofrecerReintento(requestId, 'fallido')
      return
    }
    const docente = this.mensajes.find((m) => m.rol === 'usuario' && m.turno?.requestId === requestId)
    if (docente?.turno?.reintento) this.marcarReintento(docente.id, undefined)
    // Terminado: su mensaje canónico (sin IA); reemplaza la respuesta
    // pendiente de este turno al incorporarse.
    if (turno.mensaje_asistente_id) await this.traerMensajeCanonico(r.conversacion, turno.mensaje_asistente_id)
    this.terminarRecuperacion(requestId)
  }

  private async consultarTurno(requestId: string): Promise<TurnoConsultado | 'no_encontrado' | null> {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return null
      const res = await fetch('/api/chat/turno', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken: session.access_token, requestId }),
        signal: AbortSignal.timeout(LIMITE_CONSULTA_TURNO_MS),
      })
      if (res.status === 404) return 'no_encontrado'
      if (!res.ok) return null
      return ((await res.json()) as { turno?: TurnoConsultado }).turno ?? null
    } catch {
      return null
    }
  }

  private async traerMensajeCanonico(conversacion: string, mensajeAsistenteId: string) {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const docenteId = session?.user?.id
      if (!docenteId) return
      const separador = mensajeAsistenteId.indexOf(':')
      const traidos = await leerMensajesRemotosPorId(docenteId, mensajeAsistenteId.slice(0, separador), [mensajeAsistenteId.slice(separador + 1)])
      if (conversacion !== this.conversacionActivaId || traidos.length === 0) return
      const previos = this.sincronizacionDiferida?.id === conversacion ? this.sincronizacionDiferida.nuevos : []
      this.sincronizacionDiferida = { id: conversacion, nuevos: [...previos, ...traidos] }
      this.notificar()
    } catch (e) {
      console.error('[TURNO] no se pudo traer la respuesta guardada:', e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e))
    }
  }

  // El turno no terminó: el mensaje del docente muestra «Reintentar» (sin
  // avisos que desaparecen; se conserva al recargar).
  private ofrecerReintento(requestId: string, motivo: 'fallido' | 'no_enviado' | 'ocupada') {
    const docente = this.mensajes.find((m) => m.rol === 'usuario' && m.turno?.requestId === requestId)
    if (!docente || docente.turno?.reintento === motivo) return
    this.marcarReintento(docente.id, motivo)
    this.notificar()
  }

  // Reintento EXPLÍCITO (el docente tocó «Reintentar» en su mensaje): un
  // intento nuevo del mismo mensaje, ligado al turno fallido (reintento_de)
  // si ese turno existe. Nunca automático.
  async reintentarTurno(mensajeId: string) {
    if (this.generando || this.reservaEnvio) return
    const indice = this.mensajes.findIndex((m) => m.id === mensajeId)
    const docente = this.mensajes[indice]
    if (!docente?.turno?.reintento) return
    this.reservaEnvio = true
    const anterior = docente.turno.requestId
    const ligado = docente.turno.reintento === 'fallido'
    const intento = docente.turno.intento + 1
    const sinMarca = { ...docente.turno }
    delete sinMarca.reintento
    const actualizado: MensajeConversacion = { ...docente, turno: { ...sinMarca, requestId: `${docente.id}:r${intento}`, intento } }
    this.mensajes = [...this.mensajes.slice(0, indice), actualizado, ...this.mensajes.slice(indice + 1)].filter((m) => m.turnoServidor?.requestId !== anterior)
    this.turnoAbierto = null
    const turno: TurnoSolicitud = { requestId: actualizado.turno!.requestId, mensajeUsuarioLocalId: docente.id, ...(ligado ? { reintentoDe: anterior } : {}) }
    try {
      await this.asegurarMotor()
      // El modelo ve la conversación de ANTES de ese mensaje (igual que al enviarlo).
      this.motorTexto?.establecerHistorial(this.mensajes.slice(Math.max(0, indice - 20), indice))
      this.motorTexto?.establecerConversacion(this.conversacionActivaId)
      await this.persistirIdentidadDelTurno(actualizado)
      if (docente.turno.edicion && this.documentoActivo) {
        const ultimo = this.ultimoIntentoEdicion
        const textoParaModelo = ultimo?.idDocumento === this.documentoActivo.id ? ultimo.textoParaModelo : construirPromptEdicion(this.documentoActivo.texto, docente.texto)
        this.editandoDocumentoId = this.documentoActivo.id
        this.ultimoIntentoEdicion = { idDocumento: this.documentoActivo.id, textoParaModelo }
        await this.ejecutarEdicion(textoParaModelo, undefined, undefined, turno)
        return
      }
      this.marcarSolicitud()
      await (await this.motorDeContenido())?.enviarTexto(docente.texto, undefined, undefined, undefined, undefined, 'texto', undefined, undefined, undefined, turno)
    } catch {
      this.manejarEventoMotor({ tipo: 'error', mensaje: 'No se pudo conectar con el asistente. Intenta de nuevo.' })
    } finally {
      this.reservaEnvio = false
    }
  }

  // Al recuperar la conexión: solo los turnos pendientes de la conversación
  // activa (una consulta ligera por turno; sin sincronización completa).
  alRecuperarConexion() {
    this.recuperarTurnosPendientes()
  }

  interrumpir() {
    this.motor?.interrumpir()
  }
}

// Instancia única de todo el proceso del navegador — se crea una sola vez
// al cargar el módulo, no dentro de ningún componente de React.
export const AsistenteService = new AsistenteServiceImpl()
registrarAlRetirarConversacion((localId) => AsistenteService.alRetirarConversacion(localId))

if (typeof document !== 'undefined') {
  // El caso real reportado: el docente minimiza, cambia de app o el
  // sistema suspende la pestaña — todo eso dispara "hidden" ANTES de que
  // el proceso pueda morir, a diferencia de un simple cierre de pestaña
  // (donde ya no hay nada que hacer). El guardado normal ya tiene
  // debounce de 300ms; esto fuerza el guardado inmediato justo en ese
  // instante para no perder los últimos cambios si el sistema recarga la
  // página al volver.
  // Al volver (fase 3B): la conversación activa trae en silencio lo
  // escrito en otro dispositivo. pageshow con persisted: Safari/iOS
  // restaura la página desde bfcache (puede no repetir visibilitychange);
  // si llegan los dos, el segundo no consulta.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) AsistenteService.alOcultarse()
    else AsistenteService.alVolverAPrimerPlano()
  })
  window.addEventListener('pageshow', (evento) => {
    if (evento.persisted) AsistenteService.alVolverAPrimerPlano()
  })
  window.addEventListener('online', () => {
    void supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user?.id) AsistenteService.reintentarCopiaRemota(session.user.id)
    })
    AsistenteService.alRecuperarConexion()
  })
}

// Un dispositivo compartido entre dos docentes (equipo de la escuela)
// nunca debe arrastrar la conversación de quien cerró sesión a quien
// entra después — el logout de esta app (ver app/dashboard/page.tsx) es
// una navegación de cliente (router.push), no una recarga completa, así
// que el singleton sigue vivo en memoria a menos que se limpie aquí.
supabase.auth.onAuthStateChange((evento, session) => {
  // Identidad de las copias locales: se abre solo con una sesión
  // confirmada y se cierra al salir o al cambiar de cuenta. Sin sesión al
  // cargar la página (también si se perdió un SIGNED_OUT) la puerta ya
  // está cerrada desde el inicio.
  const docente = session?.user?.id ?? null
  if (evento === 'SIGNED_OUT' || (docente && docente !== propietarioLocal())) AsistenteService.cambiarDeDocente(docente)
  // Cubre el login real y la restauración de sesión desde storage al
  // recargar la pestaña — ambos casos pueden dejar EstadoAsistente.perfil
  // en null (sesión aún no existía cuando el constructor la pidió).
  if (evento === 'SIGNED_IN' || evento === 'INITIAL_SESSION' || evento === 'TOKEN_REFRESHED') AsistenteService.recargarPerfil()
  if ((evento === 'SIGNED_IN' || evento === 'INITIAL_SESSION') && session?.user?.id) {
    AsistenteService.reintentarCopiaRemota(session.user.id)
    AsistenteService.iniciarMigracionHistorial(session.user.id)
    const docenteId = session.user.id
    setTimeout(() => void AsistenteService.refrescarConversacionesRemotas(docenteId, true), 0)
  }
})
