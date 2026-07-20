// lib/asistente/persistencia.ts
//
// Persiste TODAS las conversaciones del Chat IA en localStorage — no solo
// una. Sin esto, el historial solo vivía en memoria del singleton
// AsistenteService y desaparecía cada vez que el sistema recargaba la
// pestaña al minimizar, cambiar de app o volver. localStorage.getItem es
// síncrono, así que la conversación activa ya está restaurada antes del
// primer render, no después.
//
// Cada conversación es un objeto independiente (mensajes + documento
// activo + título) guardado bajo su propia clave — así abrir/guardar una
// conversación nunca obliga a leer o escribir las demás. Un índice ligero
// (solo id/título/fecha) es lo único que se lee para pintar la barra
// lateral, sin cargar mensajes de conversaciones que ni siquiera están
// abiertas.
//
// Deliberadamente NO se separa por usuario: esta app asume un docente por
// dispositivo (igual que el resto del Chat IA). Para el caso real de un
// dispositivo compartido entre dos docentes, ver AsistenteService: todo
// esto se limpia por completo al cerrar sesión.

import { esDocumentoFormal } from './documentos'
import { extraerTitulo } from '../documentGen/parseContenido'
import type { ArchivoGeneradoInfo, MensajeConversacion } from './tipos'

const VERSION = 2
const CLAVE_INDICE = 'docente-ia:conversaciones'
const CLAVE_ACTIVA = 'docente-ia:conversacion-activa'
const PREFIJO_CONVERSACION = 'docente-ia:conversacion:'
// Clave del formato viejo (una sola conversación, sin índice) — se migra
// una vez a la conversación #1 del sistema nuevo y se borra, nunca se
// pierde la conversación que el docente ya tenía en curso.
const CLAVE_FORMATO_VIEJO = 'docente-ia:conversacion'

// Sin esto la barra lateral crecería sin límite en un uso real de meses
// — 30 conversaciones es de sobra ("nunca se pierde una conversación
// hasta que el usuario la elimine" se refiere a una eliminación
// explícita, no a que la lista sea infinita; las más viejas nunca
// tocadas se recortan igual que ya se recortaban los mensajes).
const TOPE_CONVERSACIONES = 30
const TOPE_MENSAJES = 80

export type DocumentoActivoGuardado = {
  id: string
  texto: string
  // Caché de archivos YA generados para este documento exacto (mismo
  // id, mismo texto) — evita regenerar el mismo formato dos veces (ver
  // "no regenerar archivos existentes" en AsistenteService.ts). Se
  // invalida (vuelve a quedar vacía) en cuanto el texto cambia por una
  // edición real. Opcionales para no romper conversaciones guardadas
  // antes de que existieran estos campos — código viejo simplemente
  // los lee como undefined y arranca con la caché vacía.
  archivosGenerados?: Record<string, ArchivoGeneradoInfo>
  ultimoFormatoGenerado?: string
}
export type ConversacionResumen = { id: string; titulo: string; actualizadaEn: number }

type ConversacionGuardada = {
  version: number
  titulo: string
  mensajes: MensajeConversacion[]
  documentoActivo: DocumentoActivoGuardado | null
  actualizadaEn: number
}

function leer(clave: string): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(clave)
  } catch {
    return null
  }
}

function escribir(clave: string, valor: string) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(clave, valor)
  } catch (e) {
    // Cuota llena u otro fallo de almacenamiento — nunca debe romper la
    // conversación en curso, solo se deja de persistir en silencio.
    console.error(`Error guardando "${clave}":`, e)
  }
}

function borrar(clave: string) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(clave)
  } catch {
    // no-op
  }
}

function nuevoId(): string {
  return `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// Date.now() por sí solo puede empatar entre dos guardados muy seguidos
// (crear una conversación y guardarle el primer mensaje casi al mismo
// tiempo, por ejemplo) — un empate deja el orden de la barra lateral
// dependiendo de un detalle interno de implementación (estabilidad del
// sort) en vez de reflejar cuál se tocó de verdad más reciente. Este
// contador garantiza que cada marca de tiempo sea estrictamente mayor
// que la anterior dentro del mismo proceso.
let contadorMarcaTiempo = 0
function marcaDeTiempo(): number {
  contadorMarcaTiempo = (contadorMarcaTiempo + 1) % 1000
  return Date.now() * 1000 + contadorMarcaTiempo
}

// Título "inteligente" sin llamar a ningún modelo: si ya hay un documento
// formal en la conversación (planeación, examen, rúbrica...), usa SU
// título real (extraerTitulo, la misma función que ya arma los nombres
// de archivo reales) — es más descriptivo que la primera frase. Si
// todavía no hay documento, usa el primer mensaje del docente truncado —
// mucho más útil que "Conversación 1" y disponible desde el primer
// mensaje, sin esperar nada.
export function derivarTitulo(mensajes: MensajeConversacion[]): string {
  const ultimoDocumento = [...mensajes].reverse().find((m) => m.rol === 'asistente' && esDocumentoFormal(m.texto))
  if (ultimoDocumento) return extraerTitulo(ultimoDocumento.texto).slice(0, 60)

  const primerMensajeUsuario = mensajes.find((m) => m.rol === 'usuario' && m.texto.trim())
  if (primerMensajeUsuario) {
    const limpio = primerMensajeUsuario.texto.trim().replace(/\s+/g, ' ')
    return limpio.length > 48 ? `${limpio.slice(0, 48)}…` : limpio
  }
  return 'Nueva conversación'
}

function leerIndice(): ConversacionResumen[] {
  const crudo = leer(CLAVE_INDICE)
  if (!crudo) return []
  try {
    const datos = JSON.parse(crudo)
    return Array.isArray(datos) ? datos : []
  } catch {
    return []
  }
}

function escribirIndice(indice: ConversacionResumen[]) {
  const recortado = [...indice].sort((a, b) => b.actualizadaEn - a.actualizadaEn).slice(0, TOPE_CONVERSACIONES)
  escribir(CLAVE_INDICE, JSON.stringify(recortado))
  // Cualquier conversación que salió del tope por vieja se borra también
  // — sin esto, el índice se recorta pero el blob queda huérfano en
  // localStorage para siempre.
  const idsVigentes = new Set(recortado.map((c) => c.id))
  for (const c of indice) {
    if (!idsVigentes.has(c.id)) borrar(PREFIJO_CONVERSACION + c.id)
  }
}

// Convierte el formato viejo (una sola conversación bajo una clave fija,
// del guardado automático anterior a este) en la conversación #1 del
// sistema nuevo — se ejecuta una sola vez, la primera vez que se lee el
// índice y no existe todavía.
function migrarFormatoViejoSiHaceFalta() {
  if (leer(CLAVE_INDICE) !== null) return // ya está en el formato nuevo
  const crudoViejo = leer(CLAVE_FORMATO_VIEJO)
  if (!crudoViejo) return
  try {
    const datosViejos = JSON.parse(crudoViejo) as { mensajes?: MensajeConversacion[]; documentoActivo?: DocumentoActivoGuardado | null }
    if (!Array.isArray(datosViejos.mensajes) || datosViejos.mensajes.length === 0) return
    const id = nuevoId()
    const titulo = derivarTitulo(datosViejos.mensajes)
    guardarConversacion(id, datosViejos.mensajes, datosViejos.documentoActivo ?? null, titulo)
    establecerConversacionActiva(id)
  } catch (e) {
    console.error('Error migrando la conversación del formato anterior:', e)
  } finally {
    borrar(CLAVE_FORMATO_VIEJO)
  }
}

export function listarConversaciones(): ConversacionResumen[] {
  migrarFormatoViejoSiHaceFalta()
  return leerIndice().sort((a, b) => b.actualizadaEn - a.actualizadaEn)
}

export function obtenerConversacionActivaId(): string | null {
  migrarFormatoViejoSiHaceFalta()
  return leer(CLAVE_ACTIVA)
}

export function establecerConversacionActiva(id: string) {
  escribir(CLAVE_ACTIVA, id)
}

export function cargarConversacionPorId(id: string): { titulo: string; mensajes: MensajeConversacion[]; documentoActivo: DocumentoActivoGuardado | null } | null {
  const crudo = leer(PREFIJO_CONVERSACION + id)
  if (!crudo) return null
  try {
    const datos = JSON.parse(crudo) as ConversacionGuardada
    if (datos.version !== VERSION || !Array.isArray(datos.mensajes)) return null
    return { titulo: datos.titulo, mensajes: datos.mensajes, documentoActivo: datos.documentoActivo ?? null }
  } catch (e) {
    console.error(`Error restaurando la conversación ${id}:`, e)
    return null
  }
}

// Aligera los adjuntos (fotos y documentos) antes de guardar — un solo
// adjunto en base64 puede pesar varios cientos de KB a unos MB, y con la
// cuota típica de localStorage (5-10MB por origen) guardar el base64
// completo de cada uno arriesga llenarla y romper el guardado de TODAS
// las conversaciones, no solo la de ese adjunto. Se guarda solo un
// marcador ligero (tipo + nombre real del archivo, ver RFC-CHAT-
// ADJUNTOS-003); el adjunto real sigue completo mientras dura la sesión
// (en memoria), solo no sobrevive a un reinicio en frío. `imagenes`
// (plural, ver "Implementar soporte completo para múltiples
// fotografías") se aligera igual, una por una — un mensaje de varias
// fotos puede pesar varios MB de base64, mucho más que una sola.
function aligerarParaGuardar(mensajes: MensajeConversacion[]): MensajeConversacion[] {
  return mensajes.map((m) => {
    let ligero = m
    if (ligero.imagen) ligero = { ...ligero, imagen: { base64: '', tipo: ligero.imagen.tipo, nombreArchivo: ligero.imagen.nombreArchivo } }
    if (ligero.imagenes) ligero = { ...ligero, imagenes: ligero.imagenes.map((img) => ({ base64: '', tipo: img.tipo })) }
    return ligero
  })
}

export function guardarConversacion(id: string, mensajes: MensajeConversacion[], documentoActivo: DocumentoActivoGuardado | null, tituloForzado?: string) {
  if (mensajes.length === 0) return // conversación vacía: nada que guardar todavía
  const mensajesRecortados = mensajes.slice(-TOPE_MENSAJES)
  const titulo = tituloForzado ?? derivarTitulo(mensajesRecortados)
  const actualizadaEn = marcaDeTiempo()

  const datos: ConversacionGuardada = {
    version: VERSION,
    titulo,
    mensajes: aligerarParaGuardar(mensajesRecortados),
    documentoActivo,
    actualizadaEn,
  }
  escribir(PREFIJO_CONVERSACION + id, JSON.stringify(datos))

  const indice = leerIndice().filter((c) => c.id !== id)
  indice.push({ id, titulo, actualizadaEn })
  escribirIndice(indice)
}

export function crearNuevaConversacion(): string {
  const id = nuevoId()
  establecerConversacionActiva(id)
  return id
}

export function eliminarConversacion(id: string) {
  borrar(PREFIJO_CONVERSACION + id)
  escribirIndice(leerIndice().filter((c) => c.id !== id))
  if (leer(CLAVE_ACTIVA) === id) borrar(CLAVE_ACTIVA)
}

export function borrarTodasLasConversaciones() {
  for (const c of leerIndice()) borrar(PREFIJO_CONVERSACION + c.id)
  borrar(CLAVE_INDICE)
  borrar(CLAVE_ACTIVA)
  borrar(CLAVE_FORMATO_VIEJO)
}
