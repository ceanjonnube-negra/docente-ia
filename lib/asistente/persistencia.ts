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

import { supabase } from '@/lib/supabaseClient'
import { esDocumentoFormal, PATRON_TITULO_DOCUMENTO_SQL } from './documentos'
import { archivoSinTokenVistaPrevia, sinTokenVistaPrevia } from './textoFinalChat'
import { extraerTitulo } from '../documentGen/parseContenido'
import { propuestaListaParaGuardar, type ArchivoGeneradoInfo, type MensajeConversacion } from './tipos'

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
export const TOPE_MENSAJES = 80

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
  // La restauración vigente apunta a una versión que no está (o no es
  // válida) en este dispositivo: nunca se opera sobre otro documento.
  noRecuperado?: true
}
// docenteId: propietario de la copia local (aislamiento por docente). Las
// copias anteriores no lo tienen: quedan aisladas (nadie las ve ni las
// sincroniza) hasta resolver a quién pertenecen.
export type ConversacionResumen = { id: string; titulo: string; actualizadaEn: number; docenteId?: string }

type ConversacionGuardada = {
  version: number
  titulo: string
  mensajes: MensajeConversacion[]
  documentoActivo: DocumentoActivoGuardado | null
  actualizadaEn: number
  docenteId?: string
}

// ---------------------------------------------------------------------
// Puerta de acceso por docente. Solo el docente con sesión confirmada (lo
// establece AsistenteService al conocer la sesión) puede listar, cargar,
// guardar, abrir, migrar o sincronizar copias locales, y solo las suyas.
// Mientras no hay sesión confirmada no se ve nada. Nada se borra al
// cambiar de cuenta: las copias de otros quedan intactas y ocultas.
let propietarioActual: string | null = null
export function establecerPropietarioLocal(docenteId: string | null) {
  propietarioActual = docenteId
}
export function propietarioLocal(): string | null {
  return propietarioActual
}
// Propietario guardado en la copia (sin filtrar): undefined si no lo tiene
// o no existe.
function propietarioDeCopia(id: string): string | undefined {
  try {
    return (JSON.parse(leer(PREFIJO_CONVERSACION + id) ?? '{}') as Partial<ConversacionGuardada>).docenteId
  } catch {
    return undefined
  }
}
function esDelPropietario(docenteId: string | undefined): boolean {
  return !!propietarioActual && docenteId === propietarioActual
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

function leerIndicePropio(): ConversacionResumen[] {
  return leerIndice().filter((c) => esDelPropietario(c.docenteId))
}

// El tope se aplica solo a las conversaciones del docente actual: las de
// otros (o sin propietario) nunca se recortan ni se borran desde aquí.
function escribirIndice(indice: ConversacionResumen[]) {
  const propias = indice.filter((c) => esDelPropietario(c.docenteId))
  const recortado = [...propias].sort((a, b) => b.actualizadaEn - a.actualizadaEn).slice(0, TOPE_CONVERSACIONES)
  escribir(CLAVE_INDICE, JSON.stringify([...recortado, ...indice.filter((c) => !esDelPropietario(c.docenteId))]))
  // Cualquier conversación que salió del tope por vieja se borra también
  // — sin esto, el índice se recorta pero el blob queda huérfano en
  // localStorage para siempre.
  const idsVigentes = new Set(recortado.map((c) => c.id))
  for (const c of propias) {
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
    // Sin propietario conocido: queda aislada como cualquier copia anterior.
    escribirCopia(id, datosViejos.mensajes, datosViejos.documentoActivo ?? null, titulo, undefined)
  } catch (e) {
    console.error('Error migrando la conversación del formato anterior:', e)
  } finally {
    borrar(CLAVE_FORMATO_VIEJO)
  }
}

export function listarConversaciones(): ConversacionResumen[] {
  migrarFormatoViejoSiHaceFalta()
  return leerIndicePropio().sort((a, b) => b.actualizadaEn - a.actualizadaEn)
}

export function obtenerConversacionActivaId(): string | null {
  migrarFormatoViejoSiHaceFalta()
  const id = leer(CLAVE_ACTIVA)
  return id && esDelPropietario(propietarioDeCopia(id)) ? id : null
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
    if (!esDelPropietario(datos.docenteId)) return null
    return { titulo: datos.titulo, mensajes: ordenarEmpates(datos.mensajes), documentoActivo: datos.documentoActivo ?? null }
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
// Vistas previas de planeación/hoja: su URL es solo una REFERENCIA (ruta
// + tipoDocumento + datos + modo). Un `token=` (credencial de sesión de
// mensajes anteriores a esta corrección) nunca se guarda — ni en el
// navegador ni en mensajes_chat —; la tarjeta las abre con la sesión
// VIGENTE. Las URL firmadas de Supabase (otro origen) no se tocan.
// Misma fuente que el servidor (lib/asistente/textoFinalChat.ts).
export { sinTokenVistaPrevia }

export function documentoActivoSinTokenVistaPrevia(documentoActivo: DocumentoActivoGuardado | null): DocumentoActivoGuardado | null {
  if (!documentoActivo?.archivosGenerados) return documentoActivo
  const archivosGenerados = Object.fromEntries(Object.entries(documentoActivo.archivosGenerados).map(([tipo, archivo]) => [tipo, archivoSinTokenVistaPrevia(archivo)]))
  return { ...documentoActivo, archivosGenerados }
}

function aligerarParaGuardar(mensajes: MensajeConversacion[]): MensajeConversacion[] {
  return mensajes.map((m) => {
    let ligero = m
    if (ligero.archivo) ligero = { ...ligero, archivo: archivoSinTokenVistaPrevia(ligero.archivo) }
    if (ligero.archivos) ligero = { ...ligero, archivos: ligero.archivos.map(archivoSinTokenVistaPrevia) }
    if (ligero.imagen) ligero = { ...ligero, imagen: { base64: '', tipo: ligero.imagen.tipo, nombreArchivo: ligero.imagen.nombreArchivo } }
    if (ligero.imagenes) ligero = { ...ligero, imagenes: ligero.imagenes.map((img) => ({ base64: '', tipo: img.tipo })) }
    // Propuesta de lista oficial: el token y la vista solo se
    // guardan mientras se puede aplicar.
    if (ligero.datosPropuestaLista) ligero = { ...ligero, datosPropuestaLista: propuestaListaParaGuardar(ligero.datosPropuestaLista) }
    return ligero
  })
}

export function guardarConversacion(id: string, mensajes: MensajeConversacion[], documentoActivo: DocumentoActivoGuardado | null, tituloForzado?: string) {
  // Sin sesión confirmada no se guarda; una copia de otro docente o sin
  // propietario con el mismo id nunca se pisa.
  if (!propietarioActual) return
  if (leer(PREFIJO_CONVERSACION + id) !== null && !esDelPropietario(propietarioDeCopia(id))) return
  escribirCopia(id, mensajes, documentoActivo, tituloForzado, propietarioActual)
}

function escribirCopia(id: string, mensajes: MensajeConversacion[], documentoActivo: DocumentoActivoGuardado | null, tituloForzado: string | undefined, docenteId: string | undefined) {
  if (mensajes.length === 0) return // conversación vacía: nada que guardar todavía
  const mensajesRecortados = conVersionRestauradaFijada(mensajes, mensajes.slice(-TOPE_MENSAJES))
  const titulo = tituloForzado ?? derivarTitulo(mensajesRecortados)
  const actualizadaEn = marcaDeTiempo()

  const datos: ConversacionGuardada = {
    version: VERSION,
    titulo,
    mensajes: aligerarParaGuardar(mensajesRecortados),
    documentoActivo: documentoActivoSinTokenVistaPrevia(documentoActivo),
    actualizadaEn,
    ...(docenteId ? { docenteId } : {}),
  }
  escribir(PREFIJO_CONVERSACION + id, JSON.stringify(datos))

  const indice = leerIndice().filter((c) => c.id !== id)
  indice.push({ id, titulo, actualizadaEn, ...(docenteId ? { docenteId } : {}) })
  escribirIndice(indice)
}

export function crearNuevaConversacion(): string {
  const id = nuevoId()
  establecerConversacionActiva(id)
  return id
}

export function eliminarConversacion(id: string) {
  if (!esDelPropietario(propietarioDeCopia(id))) return
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

// ---------------------------------------------------------------------
// Identidad remota de la conversación (LISTA-P5, etapa 1): la misma fila
// canónica de conversaciones_chat que usa la persistencia remota de
// test/images-v1 (crearConversacionRemota: INSERT {id, docente_id} con
// RLS; grupo_contexto_version toma su default 1). Los mensajes siguen
// guardándose SOLO en localStorage, como arriba: aquí no se sincroniza
// ningún mensaje ni se crea otro almacén.
//
// El id remoto se deriva de forma determinista del docente y del id
// local, así que no hace falta guardar ninguna correspondencia: la misma
// conversación local —nueva o anterior a esta etapa— siempre apunta a la
// misma fila, sin duplicados aunque haya dos pestañas o se recargue. El
// docente solo lo usa para calcular el id; quién es el dueño lo decide
// RLS con la sesión real.
//
// Después se pide a fijar_grupo_conversacion (auth.uid(), security
// definer) que fije el grupo una sola vez; la base nunca lo cambia
// después. Si no pudo fijarse (sin grupo o ambiguo), /api/chat lo
// reintenta cuando lo necesite.

async function idConversacionRemota(docenteId: string, localId: string): Promise<string> {
  const datos = new TextEncoder().encode(`docente-ia:conversacion-remota:${docenteId}:${localId}`)
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', datos)).slice(0, 16)
  b[6] = (b[6] & 0x0f) | 0x80 // versión 8 (UUID definido por la aplicación)
  b[8] = (b[8] & 0x3f) | 0x80 // variante RFC 4122
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

// Id remoto de una conversación local: el de su relación guardada (una
// conversación descargada de otro dispositivo, etapa 3A) o, si no la
// tiene, el determinista de siempre. La relación solo vale para el
// docente que la creó.
const CLAVE_VINCULOS_REMOTOS = 'docente-ia:vinculos-remotos'
type VinculoRemoto = { docenteId: string; remotoId: string }

function leerVinculosRemotos(): Record<string, VinculoRemoto> {
  try {
    const datos = JSON.parse(leer(CLAVE_VINCULOS_REMOTOS) ?? '{}')
    return datos && typeof datos === 'object' ? datos : {}
  } catch {
    return {}
  }
}

export function idRemotoDe(docenteId: string, localId: string): Promise<string> {
  const vinculo = leerVinculosRemotos()[localId]
  return vinculo && vinculo.docenteId === docenteId ? Promise.resolve(vinculo.remotoId) : idConversacionRemota(docenteId, localId)
}

function guardarVinculoRemoto(localId: string, docenteId: string, remotoId: string) {
  const vinculos = leerVinculosRemotos()
  vinculos[localId] = { docenteId, remotoId }
  escribir(CLAVE_VINCULOS_REMOTOS, JSON.stringify(vinculos))
}

// Una sola promesa por conversación y sesión de página: evita repetir el
// INSERT en cada mensaje. Si falla se olvida, para reintentar después.
const conversacionesRemotas = new Map<string, Promise<string | null>>()

// Devuelve el id de la fila remota de la conversación local, creándola
// si hace falta, o null si no se pudo (el chat sigue igual sin él).
export function asegurarConversacionRemota(localId: string, docenteId: string): Promise<string | null> {
  const clave = `${docenteId}:${localId}`
  const existente = conversacionesRemotas.get(clave)
  if (existente) return existente

  const promesa = (async () => {
    const id = await idRemotoDe(docenteId, localId)
    const { error } = await supabase.from('conversaciones_chat').insert({ id, docente_id: docenteId })
    if (error) {
      // 23505: ya existe. Solo se usa si RLS la devuelve (es del docente).
      if (error.code !== '23505') throw error
      const { data, error: errorLectura } = await supabase.from('conversaciones_chat').select('id').eq('id', id).maybeSingle()
      if (errorLectura) throw errorLectura
      if (!data) throw new Error('La conversación remota no pertenece a la sesión actual.')
    }
    const { error: errorGrupo } = await supabase.rpc('fijar_grupo_conversacion', { p_conversacion_id: id })
    if (errorGrupo) console.error('[CONVERSACION_REMOTA] grupo_fijado=false')
    return id
  })().catch((e) => {
    conversacionesRemotas.delete(clave)
    console.error('[CONVERSACION_REMOTA] creada=false', e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e))
    return null
  })
  conversacionesRemotas.set(clave, promesa)
  return promesa
}

// ---------------------------------------------------------------------
// Copia remota de los mensajes (persistencia remota, etapa 1): cada
// mensaje nuevo se guarda también en mensajes_chat, en segundo plano.
// localStorage sigue siendo lo único que se lee: aquí no se restaura
// nada desde Supabase ni se reemplaza nada local.
//
// - Id remoto del mensaje: `<id remoto de la conversación>:<id local>`.
//   El id local (msg-<ms>-<contador>) puede repetirse entre recargas o
//   dispositivos; con la conversación delante, dos mensajes de
//   conversaciones distintas nunca comparten fila, así que el upsert
//   solo puede reescribir la MISMA fila del MISMO mensaje (su versión
//   más reciente: respuesta final, archivo agregado, edición).
// - Huella por mensaje: solo se envía lo nuevo o lo que cambió, y solo
//   se marca como sincronizado con la confirmación de Supabase.
// - Cola en localStorage (por docente) con reintentos: un fallo de red
//   no pierde el mensaje y reenviarlo no lo duplica.
// - Solo mensajes creados desde que esta etapa empezó a correr en el
//   dispositivo (`desde`): el historial anterior no se migra aquí.
// - RLS decide el dueño; además nunca se envía nada si la sesión
//   actual no es del docente de la cola.

const PREFIJO_SINCRONIZACION = 'docente-ia:mensajes-remotos:'
const TOPE_PENDIENTES = 400
const TOPE_HUELLAS = 3000
const TOPE_SOLO_INSERCION = 5000
const ESPERAS_REINTENTO_MS = [5_000, 15_000, 60_000, 300_000]

export type FilaMensajeRemoto = {
  id: string
  conversacion_id: string
  docente_id: string
  rol: MensajeConversacion['rol']
  texto: string
  contenido: Record<string, unknown>
  creado_en: string
}
type MensajePendiente = { localId: string; fila: FilaMensajeRemoto; huella: string }
// soloInsercion: mensajes descargados de Supabase (etapa 3A). Ya existen
// remotos y los escribió otro dispositivo: un cambio local nunca los
// sobrescribe (hasta tener versiones atómicas, etapa 4).
type EstadoSincronizacion = { desde: number; pendientes: MensajePendiente[]; huellas: Record<string, string>; soloInsercion?: Record<string, true> }

export function idMensajeRemoto(conversacionRemotaId: string, mensajeId: string): string {
  return `${conversacionRemotaId}:${mensajeId}`
}

// Igual que en localStorage (aligerarParaGuardar: sin base64), y el
// token de una propuesta de lista nunca sale del dispositivo.
export function mensajeAFilaRemota(conversacionRemotaId: string, docenteId: string, mensaje: MensajeConversacion): FilaMensajeRemoto {
  const [ligero] = aligerarParaGuardar([mensaje])
  const { id, rol, texto, creadoEn, ...contenido } = ligero
  if (contenido.datosPropuestaLista) contenido.datosPropuestaLista = { ...contenido.datosPropuestaLista, token: undefined }
  return {
    id: idMensajeRemoto(conversacionRemotaId, id),
    conversacion_id: conversacionRemotaId,
    docente_id: docenteId,
    rol,
    texto,
    contenido: JSON.parse(JSON.stringify(contenido)) as Record<string, unknown>,
    creado_en: new Date(creadoEn).toISOString(),
  }
}

// FNV-1a de 32 bits: solo detecta cambios, no es seguridad.
function huellaDe(fila: FilaMensajeRemoto): string {
  const texto = JSON.stringify(fila)
  let h = 0x811c9dc5
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `${(h >>> 0).toString(36)}-${texto.length.toString(36)}`
}

function leerEstadoSincronizacion(docenteId: string): EstadoSincronizacion {
  const clave = PREFIJO_SINCRONIZACION + docenteId
  try {
    const crudo = leer(clave)
    const datos = crudo ? (JSON.parse(crudo) as EstadoSincronizacion) : null
    if (datos && typeof datos.desde === 'number' && Array.isArray(datos.pendientes) && datos.huellas && typeof datos.huellas === 'object') return datos
  } catch {
    // estado ilegible: se reinicia (solo puede reenviar, nunca borrar)
  }
  const nuevo: EstadoSincronizacion = { desde: Date.now(), pendientes: [], huellas: {} }
  escribir(clave, JSON.stringify(nuevo))
  return nuevo
}

function escribirEstadoSincronizacion(docenteId: string, estado: EstadoSincronizacion) {
  const huellas = Object.entries(estado.huellas)
  if (huellas.length > TOPE_HUELLAS) estado.huellas = Object.fromEntries(huellas.slice(-TOPE_HUELLAS))
  const soloInsercion = Object.keys(estado.soloInsercion ?? {})
  if (soloInsercion.length > TOPE_SOLO_INSERCION) estado.soloInsercion = Object.fromEntries(soloInsercion.slice(-TOPE_SOLO_INSERCION).map((id) => [id, true]))
  if (estado.pendientes.length > TOPE_PENDIENTES) {
    console.error(`[MENSAJES_REMOTOS] cola_llena descartados=${estado.pendientes.length - TOPE_PENDIENTES}`)
    estado.pendientes = estado.pendientes.slice(-TOPE_PENDIENTES)
  }
  escribir(PREFIJO_SINCRONIZACION + docenteId, JSON.stringify(estado))
}

// Encola los mensajes nuevos o cambiados de una conversación local y
// los envía. Nunca lanza: si algo falla, quedan en la cola.
export async function guardarMensajesRemotos(localId: string, docenteId: string, mensajes: MensajeConversacion[]): Promise<void> {
  const conversacionRemotaId = await idRemotoDe(docenteId, localId)
  const estado = leerEstadoSincronizacion(docenteId)
  const nuevos: MensajePendiente[] = []
  for (const mensaje of mensajes) {
    if (mensaje.creadoEn < estado.desde) continue
    // Respuesta de un turno duradero que el servidor todavía no confirmó:
    // su único escritor es el servidor (nunca una segunda fila).
    if (mensaje.turnoServidor?.estado === 'pendiente') continue
    const fila = mensajeAFilaRemota(conversacionRemotaId, docenteId, mensaje)
    const huella = huellaDe(fila)
    if (estado.huellas[fila.id] === huella) continue
    if (estado.soloInsercion?.[fila.id]) continue
    nuevos.push({ localId, fila, huella })
  }
  if (nuevos.length > 0) {
    const ids = new Set(nuevos.map((p) => p.fila.id))
    estado.pendientes = [...estado.pendientes.filter((p) => !ids.has(p.fila.id)), ...nuevos]
    escribirEstadoSincronizacion(docenteId, estado)
  }
  await reintentarMensajesRemotosPendientes(docenteId)
}

// Turnos duraderos: el servidor ya creó la fila de esta respuesta (id
// canónico). Se registra como sincronizada con el contenido que el cliente
// adopta, para no volver a escribirla; solo un cambio posterior que
// únicamente conoce el cliente (p. ej. el vínculo de versión de un
// documento) actualiza esa MISMA fila.
export function registrarMensajeDelServidor(docenteId: string, conversacionRemotaId: string, mensaje: MensajeConversacion): void {
  const estado = leerEstadoSincronizacion(docenteId)
  const fila = mensajeAFilaRemota(conversacionRemotaId, docenteId, mensaje)
  estado.huellas[fila.id] = huellaDe(fila)
  estado.pendientes = estado.pendientes.filter((p) => p.fila.id !== fila.id)
  escribirEstadoSincronizacion(docenteId, estado)
}

// Turnos que hay que consultar en el servidor (lógica pura): respuestas
// pendientes de confirmar y, si el último mensaje es del docente con un
// turno, ese turno (incluso si se perdió el estado local: el turno viaja
// en el mensaje guardado). Un turno ya resuelto por un mensaje canónico
// del servidor no se consulta.
export function turnosPorRecuperar(mensajes: MensajeConversacion[]): string[] {
  const resueltos = new Set(mensajes.filter((m) => m.rol === 'asistente' && (m.requestId || m.turnoServidor?.estado === 'guardado')).map((m) => m.requestId ?? m.turnoServidor!.requestId))
  const ids = mensajes.filter((m) => m.rol === 'asistente' && m.turnoServidor?.estado === 'pendiente').map((m) => m.turnoServidor!.requestId)
  const ultimo = mensajes[mensajes.length - 1]
  if (ultimo?.rol === 'usuario' && ultimo.turno) ids.push(ultimo.turno.requestId)
  return [...new Set(ids)].filter((id) => !resueltos.has(id))
}

// Una respuesta pendiente cuyo mensaje canónico del servidor ya está en la
// conversación (mismo requestId) se reemplaza por él: nunca dos respuestas
// del mismo turno.
export function sinRespuestasPendientesResueltas(mensajes: MensajeConversacion[]): MensajeConversacion[] {
  const canonicos = new Set(mensajes.filter((m) => m.rol === 'asistente' && m.requestId).map((m) => m.requestId))
  if (canonicos.size === 0) return mensajes
  const filtrados = mensajes.filter((m) => !(m.turnoServidor?.estado === 'pendiente' && canonicos.has(m.turnoServidor.requestId)))
  return filtrados.length === mensajes.length ? mensajes : filtrados
}

const envioEnCurso = new Map<string, Promise<void>>()
const reintentos = new Map<string, { timer: ReturnType<typeof setTimeout> | null; intento: number }>()

// Envía la cola del docente. Un solo envío a la vez por docente; si
// llegan más mensajes mientras tanto, se envían en la siguiente vuelta.
export function reintentarMensajesRemotosPendientes(docenteId: string): Promise<void> {
  const enCurso = envioEnCurso.get(docenteId)
  const siguiente = (enCurso ?? Promise.resolve()).then(() => enviarPendientes(docenteId))
  const envio = siguiente.finally(() => {
    if (envioEnCurso.get(docenteId) === envio) envioEnCurso.delete(docenteId)
  })
  envioEnCurso.set(docenteId, envio)
  return envio
}

async function enviarPendientes(docenteId: string): Promise<void> {
  const pendientes = leerEstadoSincronizacion(docenteId).pendientes
  if (pendientes.length === 0) return
  let fallo = false
  try {
    const { data: { session } } = await supabase.auth.getSession()
    // Sin sesión o con la de otro docente: la cola espera a su dueño.
    if (session?.user?.id !== docenteId) return

    const porConversacion = new Map<string, MensajePendiente[]>()
    for (const p of pendientes) porConversacion.set(p.fila.conversacion_id, [...(porConversacion.get(p.fila.conversacion_id) ?? []), p])

    for (const [conversacionRemotaId, grupo] of porConversacion) {
      const filas = grupo.map((p) => p.fila)
      // Defensa: cada fila es de ESTA conversación y de este docente.
      if (filas.some((f) => f.docente_id !== docenteId || !f.id.startsWith(`${conversacionRemotaId}:`))) {
        console.error('[MENSAJES_REMOTOS] fila_inconsistente descartada')
        confirmar(docenteId, grupo, new Set(), true)
        continue
      }
      const id = await asegurarConversacionRemota(grupo[0].localId, docenteId)
      if (id !== conversacionRemotaId) {
        fallo = true
        continue
      }
      const { data, error } = await supabase.from('mensajes_chat').upsert(filas, { onConflict: 'id' }).select('id')
      if (error) {
        // RLS rechaza escribir en una conversación eliminada (etapa 3B-1):
        // si es eso, su cola se descarta y se retira la copia local.
        if (error.code === '42501' && (await conversacionEliminadaRemota(conversacionRemotaId))) {
          confirmar(docenteId, grupo, new Set(), true)
          await retirarConversacionLocal(docenteId, grupo[0].localId)
          continue
        }
        console.error('[MENSAJES_REMOTOS] guardado=false', error.code ?? error.message)
        fallo = true
        continue
      }
      const confirmados = new Set((data ?? []).map((f: { id: string }) => f.id))
      if (confirmados.size < filas.length) fallo = true
      confirmar(docenteId, grupo, confirmados, false)
      if (confirmados.size > 0) await actualizarContextoRemoto(docenteId, grupo[0].localId, conversacionRemotaId)
    }
  } catch (e) {
    console.error('[MENSAJES_REMOTOS] guardado=false', e instanceof Error ? e.message : String(e))
    fallo = true
  }
  programarReintento(docenteId, fallo)
}

// Marca como sincronizado solo lo confirmado, y solo si en la cola
// sigue la MISMA versión que se envió (una más nueva queda pendiente).
function confirmar(docenteId: string, enviados: MensajePendiente[], confirmados: Set<string>, descartar: boolean) {
  const estado = leerEstadoSincronizacion(docenteId)
  const resueltos = new Map(enviados.filter((p) => descartar || confirmados.has(p.fila.id)).map((p) => [p.fila.id, p.huella]))
  if (resueltos.size === 0) return
  estado.pendientes = estado.pendientes.filter((p) => resueltos.get(p.fila.id) !== p.huella)
  if (!descartar) {
    for (const [id, huella] of resueltos) {
      delete estado.huellas[id]
      estado.huellas[id] = huella
    }
  }
  escribirEstadoSincronizacion(docenteId, estado)
}

function programarReintento(docenteId: string, fallo: boolean) {
  const actual = reintentos.get(docenteId) ?? { timer: null, intento: 0 }
  if (actual.timer) clearTimeout(actual.timer)
  if (!fallo) {
    reintentos.delete(docenteId)
    return
  }
  const espera = ESPERAS_REINTENTO_MS[Math.min(actual.intento, ESPERAS_REINTENTO_MS.length - 1)]
  const timer = setTimeout(() => {
    const r = reintentos.get(docenteId)
    if (r) r.timer = null
    void reintentarMensajesRemotosPendientes(docenteId)
  }, espera)
  reintentos.set(docenteId, { timer, intento: actual.intento + 1 })
}

// ---------------------------------------------------------------------
// Migración del historial local anterior (persistencia remota, etapa 2):
// copia a Supabase los mensajes que la etapa 1 no envía (los creados
// antes de su `desde`), una conversación a la vez. No borra ni cambia
// nada local y no toca los mensajes que maneja la etapa 1.
//
// - Pertenencia: solo se migra una conversación cuya fila remota (id
//   determinista docente + conversación local) YA existe y RLS la
//   devuelve al docente actual. Sin esa prueba queda pendiente, intacta
//   y sin atribuirse a nadie (no se crea la fila ni se fija el grupo).
// - Mensajes: insert que ignora los existentes (nunca sobrescribe), en
//   lotes pequeños. La conversación solo se marca migrada tras releer
//   las filas y comprobar que coinciden con las locales.
// - Contexto: título, documento activo y fecha se escriben con UPDATE
//   condicionados a que la fila siga con su valor inicial (o una fecha
//   anterior), así que nunca pisan un valor escrito por otro.
// - Reanudable: lo pendiente se vuelve a intentar en la siguiente
//   sesión; repetir cualquier paso es seguro.

const PREFIJO_MIGRACION = 'docente-ia:migracion-historial:'
const LOTE_MIGRACION = 20
const TITULO_INICIAL = 'Nueva conversación'

// 'migrada': mensajes y contexto confirmados. 'conflicto': algo remoto
// difiere de lo local; nada se pisó y la conversación sigue sin migrar
// (pendiente de resolver; no se reintenta sola para no repetir envíos).
// Sin marca: pendiente y se reintenta en la siguiente sesión.
type EstadoConversacionMigrada = 'migrada' | 'conflicto'
export type ResultadoMigracion = { migradas: number; sinPertenencia: number; conflictos: number; fallidas: number }

function leerEstadoMigracion(docenteId: string): Record<string, EstadoConversacionMigrada> {
  try {
    const datos = JSON.parse(leer(PREFIJO_MIGRACION + docenteId) ?? '{}')
    return datos && typeof datos === 'object' ? datos : {}
  } catch {
    return {}
  }
}

function marcarConversacionMigracion(docenteId: string, localId: string, estado: EstadoConversacionMigrada) {
  const actual = leerEstadoMigracion(docenteId)
  actual[localId] = estado
  escribir(PREFIJO_MIGRACION + docenteId, JSON.stringify(actual))
}

// JSON con claves ordenadas: jsonb no conserva el orden de las claves.
function canonico(valor: unknown): string {
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(',')}]`
  if (valor && typeof valor === 'object') return `{${Object.keys(valor).sort().map((k) => `${JSON.stringify(k)}:${canonico((valor as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(valor ?? null)
}

function filaCoincide(local: FilaMensajeRemoto, remota: Partial<FilaMensajeRemoto> | undefined): boolean {
  return !!remota
    && remota.conversacion_id === local.conversacion_id
    && remota.docente_id === local.docente_id
    && remota.rol === local.rol
    && remota.texto === local.texto
    && Date.parse(remota.creado_en ?? '') === Date.parse(local.creado_en)
    && canonico(remota.contenido ?? {}) === canonico(local.contenido)
}

let migracionEnCurso: Promise<ResultadoMigracion> | null = null

export function migrarHistorialLocal(docenteId: string): Promise<ResultadoMigracion> {
  if (!migracionEnCurso) migracionEnCurso = ejecutarMigracion(docenteId).finally(() => { migracionEnCurso = null })
  return migracionEnCurso
}

async function ejecutarMigracion(docenteId: string): Promise<ResultadoMigracion> {
  const resultado: ResultadoMigracion = { migradas: 0, sinPertenencia: 0, conflictos: 0, fallidas: 0 }
  if (propietarioActual !== docenteId) return resultado
  const { desde } = leerEstadoSincronizacion(docenteId)
  const estados = leerEstadoMigracion(docenteId)

  // Candidatas (sin red): conversaciones locales no resueltas que tienen
  // mensajes anteriores a la etapa 1.
  const candidatas: { localId: string; remotoId: string; titulo: string; actualizadaEn: number; documentoActivo: DocumentoActivoGuardado | null; mensajes: MensajeConversacion[] }[] = []
  for (const { id: localId } of listarConversaciones()) {
    if (estados[localId]) continue
    const datos = cargarConversacionPorId(localId)
    const anteriores = datos?.mensajes.filter((m) => m.creadoEn < desde) ?? []
    if (!datos || anteriores.length === 0) continue
    const crudo = JSON.parse(leer(PREFIJO_CONVERSACION + localId) ?? '{}') as Partial<ConversacionGuardada>
    candidatas.push({ localId, remotoId: await idRemotoDe(docenteId, localId), titulo: datos.titulo, actualizadaEn: Number(crudo.actualizadaEn) || 0, documentoActivo: datos.documentoActivo, mensajes: anteriores })
  }
  if (candidatas.length === 0) return resultado

  try {
    const { data: { session } } = await supabase.auth.getSession()
    if (session?.user?.id !== docenteId) return resultado

    // Una sola consulta para la pertenencia de todas las candidatas.
    const { data: propias, error } = await supabase
      .from('conversaciones_chat')
      .select('id, titulo, documento_activo, actualizado_en, eliminada_en')
      .in('id', candidatas.map((c) => c.remotoId))
    if (error) throw error
    const filasPropias = new Map((propias ?? []).map((f: { id: string; titulo: string; documento_activo: unknown; actualizado_en: string; eliminada_en: string | null }) => [f.id, f]))

    for (const c of candidatas) {
      // La sesión cambió durante la migración: no se sigue con otra cuenta.
      if (propietarioActual !== docenteId) break
      const remota = filasPropias.get(c.remotoId)
      if (!remota) {
        resultado.sinPertenencia++
        continue
      }
      if (remota.eliminada_en) {
        await retirarConversacionLocal(docenteId, c.localId)
        continue
      }
      try {
        const estado = await migrarConversacion(docenteId, c, remota)
        marcarConversacionMigracion(docenteId, c.localId, estado)
        if (estado === 'migrada') resultado.migradas++
        else resultado.conflictos++
      } catch (e) {
        resultado.fallidas++
        console.error('[MIGRACION_HISTORIAL] conversacion=false', e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e))
      }
    }
  } catch (e) {
    resultado.fallidas++
    console.error('[MIGRACION_HISTORIAL] fallo', e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e))
  }
  if (resultado.migradas || resultado.conflictos || resultado.fallidas) console.info('[MIGRACION_HISTORIAL]', JSON.stringify(resultado))
  return resultado
}

async function migrarConversacion(
  docenteId: string,
  c: { remotoId: string; titulo: string; actualizadaEn: number; documentoActivo: DocumentoActivoGuardado | null; mensajes: MensajeConversacion[] },
  remota: { titulo: string; documento_activo: unknown; actualizado_en: string },
): Promise<EstadoConversacionMigrada> {
  const filas = c.mensajes.map((m) => mensajeAFilaRemota(c.remotoId, docenteId, m))
  for (let i = 0; i < filas.length; i += LOTE_MIGRACION) {
    const lote = filas.slice(i, i + LOTE_MIGRACION)
    const { error } = await supabase.from('mensajes_chat').upsert(lote, { onConflict: 'id', ignoreDuplicates: true })
    if (error) throw error
  }

  // Integridad: cada mensaje debe existir en Supabase y coincidir con el
  // local. Si una fila previa difiere, no se toca: queda en conflicto.
  const remotas = new Map<string, Partial<FilaMensajeRemoto>>()
  for (let i = 0; i < filas.length; i += LOTE_MIGRACION) {
    const { data, error } = await supabase
      .from('mensajes_chat')
      .select('id, conversacion_id, docente_id, rol, texto, contenido, creado_en')
      .in('id', filas.slice(i, i + LOTE_MIGRACION).map((f) => f.id))
    if (error) throw error
    for (const f of (data ?? []) as Partial<FilaMensajeRemoto>[]) if (f.id) remotas.set(f.id, f)
  }
  if (filas.some((f) => !remotas.has(f.id))) throw new Error('Faltan mensajes tras la inserción.')
  if (filas.some((f) => !filaCoincide(f, remotas.get(f.id)))) return 'conflicto'

  // Contexto: cada UPDATE solo aplica si la fila sigue con su valor
  // inicial; si otro lo cambió antes, el filtro no coincide y no se pisa.
  if (remota.titulo === TITULO_INICIAL && c.titulo && c.titulo !== TITULO_INICIAL) {
    const { error } = await supabase.from('conversaciones_chat').update({ titulo: c.titulo }).eq('id', c.remotoId).eq('titulo', TITULO_INICIAL)
    if (error) throw error
  }
  if (remota.documento_activo == null && c.documentoActivo) {
    const { error } = await supabase.from('conversaciones_chat').update({ documento_activo: documentoActivoSinTokenVistaPrevia(c.documentoActivo) }).eq('id', c.remotoId).is('documento_activo', null)
    if (error) throw error
  }
  const actualizada = c.actualizadaEn > 1e15 ? Math.floor(c.actualizadaEn / 1000) : c.actualizadaEn
  if (actualizada > 0 && Date.parse(remota.actualizado_en) < actualizada) {
    const iso = new Date(actualizada).toISOString()
    const { error } = await supabase.from('conversaciones_chat').update({ actualizado_en: iso }).eq('id', c.remotoId).lt('actualizado_en', iso)
    if (error) throw error
  }

  // Contexto confirmado: se relee la fila. Si el título o el documento
  // activo remotos difieren de los locales (los escribió otro antes),
  // no se pisan y la conversación queda en conflicto, no migrada.
  const tituloLocal = c.titulo && c.titulo !== TITULO_INICIAL ? c.titulo : null
  if (tituloLocal || c.documentoActivo) {
    const { data: final, error } = await supabase.from('conversaciones_chat').select('titulo, documento_activo').eq('id', c.remotoId).maybeSingle()
    if (error) throw error
    if (!final) throw new Error('La conversación remota no se pudo releer.')
    if (tituloLocal && final.titulo !== tituloLocal) return 'conflicto'
    if (c.documentoActivo && canonico(final.documento_activo) !== canonico(c.documentoActivo)) return 'conflicto'
  }
  return 'migrada'
}

// ---------------------------------------------------------------------
// Recuperación entre dispositivos (persistencia remota, etapa 3A).
//
// - Lista: una consulta con las conversaciones del docente y su número
//   de mensajes; las vacías no se muestran (no se borran). Las que ya
//   tienen copia local se quedan con la local.
// - Abrir una remota: se descargan sus últimos mensajes, se guarda la
//   relación local → remoto ANTES de activarla (así el motor y la etapa
//   1 siguen usando el mismo id remoto y su grupo original) y se copia
//   al navegador sin pisar ninguna conversación local existente. Sus
//   mensajes quedan registrados como ya enviados y de solo inserción.
// - Título y fecha: el título se escribe solo si el remoto sigue siendo
//   el último que este dispositivo conoció (si otro lo cambió, se adopta
//   sin pisarlo); la fecha solo avanza.

const PREFIJO_TITULOS_REMOTOS = 'docente-ia:titulos-remotos:'

function leerTitulosRemotos(docenteId: string): Record<string, string> {
  try {
    const datos = JSON.parse(leer(PREFIJO_TITULOS_REMOTOS + docenteId) ?? '{}')
    return datos && typeof datos === 'object' ? datos : {}
  } catch {
    return {}
  }
}

function recordarTituloRemoto(docenteId: string, remotoId: string, titulo: string) {
  const titulos = leerTitulosRemotos(docenteId)
  titulos[remotoId] = titulo
  escribir(PREFIJO_TITULOS_REMOTOS + docenteId, JSON.stringify(titulos))
}

async function actualizarContextoRemoto(docenteId: string, localId: string, remotoId: string): Promise<void> {
  try {
    const resumen = leerIndicePropio().find((c) => c.id === localId)
    if (!resumen) return
    const conocido = leerTitulosRemotos(docenteId)[remotoId] ?? TITULO_INICIAL
    if (resumen.titulo && resumen.titulo !== conocido) {
      const { data, error } = await supabase.from('conversaciones_chat').update({ titulo: resumen.titulo }).eq('id', remotoId).eq('titulo', conocido).select('id')
      if (error) throw error
      if (data && data.length > 0) {
        recordarTituloRemoto(docenteId, remotoId, resumen.titulo)
      } else {
        const { data: actual, error: errorLectura } = await supabase.from('conversaciones_chat').select('titulo').eq('id', remotoId).maybeSingle()
        if (errorLectura) throw errorLectura
        if (actual?.titulo) recordarTituloRemoto(docenteId, remotoId, actual.titulo)
      }
    }
    const ms = resumen.actualizadaEn > 1e15 ? Math.floor(resumen.actualizadaEn / 1000) : resumen.actualizadaEn
    if (ms > 0) {
      const iso = new Date(ms).toISOString()
      const { error } = await supabase.from('conversaciones_chat').update({ actualizado_en: iso }).eq('id', remotoId).lt('actualizado_en', iso)
      if (error) throw error
    }
  } catch (e) {
    console.error('[CONTEXTO_REMOTO] actualizado=false', e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e))
  }
}

// ---------------------------------------------------------------------
// Propietario de las copias anteriores al aislamiento (etapa 2). Una copia
// sin docenteId solo se asigna al docente con sesión si hay evidencia
// explícita de que es suya y de ningún otro:
// - local: su vínculo remoto, sus marcadores de migración, sus títulos
//   remotos o mensajes de la copia en su estado de sincronización (huellas,
//   solo inserción o la cola pendiente);
// - remota: sin evidencia local, la conversación remota que le
//   correspondería existe y RLS la devuelve a ese docente.
// Nunca por ser la única cuenta conocida en el navegador. Evidencia de dos
// docentes, de otro docente, una conversación remota eliminada o una
// asignación que duplicaría otra copia propia: la copia queda intacta y
// aislada. Asignar solo agrega docenteId: los mensajes, la cola y los
// marcadores no cambian.
export type MotivoAislada = 'sin_evidencia' | 'contradictoria' | 'de_otro_docente' | 'eliminada' | 'duplicada'
export type ResultadoPropietarios = { asignadas: string[]; aisladas: { id: string; motivo: MotivoAislada }[] }

function clavesLocales(): string[] {
  try {
    const almacen = window.localStorage as Storage
    if (typeof almacen.length !== 'number' || typeof almacen.key !== 'function') return []
    return Array.from({ length: almacen.length }, (_, i) => almacen.key(i)).filter((k): k is string => !!k)
  } catch {
    return []
  }
}

// Docentes con algún rastro en este navegador (solo para detectar
// evidencias contradictorias, nunca para asignar).
function docentesConRastro(): string[] {
  const ids = new Set<string>()
  for (const k of clavesLocales()) {
    for (const prefijo of [PREFIJO_SINCRONIZACION, PREFIJO_MIGRACION, PREFIJO_TITULOS_REMOTOS]) if (k.startsWith(prefijo)) ids.add(k.slice(prefijo.length))
  }
  for (const v of Object.values(leerVinculosRemotos())) ids.add(v.docenteId)
  return [...ids]
}

// Lectura sin efectos (leerEstadoSincronizacion crea un estado si falta).
function estadoSincronizacionExistente(docenteId: string): EstadoSincronizacion | null {
  try {
    const datos = JSON.parse(leer(PREFIJO_SINCRONIZACION + docenteId) ?? 'null') as EstadoSincronizacion | null
    return datos && Array.isArray(datos.pendientes) && datos.huellas && typeof datos.huellas === 'object' ? datos : null
  } catch {
    return null
  }
}

async function evidenciaLocalDe(docenteId: string, localId: string, idsMensajes: string[]): Promise<boolean> {
  if (leerVinculosRemotos()[localId]?.docenteId === docenteId) return true
  if (leerEstadoMigracion(docenteId)[localId]) return true
  const remotoId = await idRemotoDe(docenteId, localId)
  if (leerTitulosRemotos(docenteId)[remotoId] !== undefined) return true
  const estado = estadoSincronizacionExistente(docenteId)
  if (!estado) return false
  if (estado.pendientes.some((pendiente) => pendiente.localId === localId && pendiente.fila.conversacion_id === remotoId)) return true
  return idsMensajes.some((id) => estado.huellas[`${remotoId}:${id}`] !== undefined || !!estado.soloInsercion?.[`${remotoId}:${id}`])
}

function leerCopiaCruda(id: string): ConversacionGuardada | null {
  try {
    const datos = JSON.parse(leer(PREFIJO_CONVERSACION + id) ?? 'null') as ConversacionGuardada | null
    return datos && Array.isArray(datos.mensajes) ? datos : null
  } catch {
    return null
  }
}

// Solo agrega el propietario a la copia y a su entrada del índice (sin
// recortar el índice ni tocar mensajes).
function asignarPropietario(id: string, docenteId: string) {
  const copia = leerCopiaCruda(id)
  if (!copia || copia.docenteId) return
  escribir(PREFIJO_CONVERSACION + id, JSON.stringify({ ...copia, docenteId }))
  escribir(CLAVE_INDICE, JSON.stringify(leerIndice().map((c) => (c.id === id ? { ...c, docenteId } : c))))
}

const resolucionesEnCurso = new Map<string, Promise<ResultadoPropietarios>>()
export function resolverPropietariosLocales(docenteId: string): Promise<ResultadoPropietarios> {
  const enCurso = resolucionesEnCurso.get(docenteId)
  if (enCurso) return enCurso
  const promesa = ejecutarResolucionPropietarios(docenteId).finally(() => resolucionesEnCurso.delete(docenteId))
  resolucionesEnCurso.set(docenteId, promesa)
  return promesa
}

async function ejecutarResolucionPropietarios(docenteId: string): Promise<ResultadoPropietarios> {
  const resultado: ResultadoPropietarios = { asignadas: [], aisladas: [] }
  if (propietarioActual !== docenteId) return resultado
  const sinPropietario = leerIndice().filter((c) => !c.docenteId)
  if (sinPropietario.length === 0) return resultado
  const docentes = [...new Set([docenteId, ...docentesConRastro()])]
  const confirmadas: { id: string; remotoId: string }[] = []
  const porVerificar: { id: string; remotos: string[] }[] = []
  for (const { id } of sinPropietario) {
    const copia = leerCopiaCruda(id)
    if (!copia || copia.docenteId) continue
    const idsMensajes = copia.mensajes.map((m) => m.id)
    const conEvidencia: string[] = []
    for (const d of docentes) if (await evidenciaLocalDe(d, id, idsMensajes)) conEvidencia.push(d)
    if (conEvidencia.length > 1) resultado.aisladas.push({ id, motivo: 'contradictoria' })
    else if (conEvidencia.length === 1 && conEvidencia[0] !== docenteId) resultado.aisladas.push({ id, motivo: 'de_otro_docente' })
    else if (conEvidencia.length === 1) confirmadas.push({ id, remotoId: await idRemotoDe(docenteId, id) })
    // Una copia descargada de Supabase usa como id el de la conversación remota.
    else porVerificar.push({ id, remotos: [...new Set([await idRemotoDe(docenteId, id), id])] })
  }
  if (porVerificar.length > 0 && propietarioActual === docenteId) {
    try {
      const { data, error } = await supabase
        .from('conversaciones_chat')
        .select('id, eliminada_en')
        .eq('docente_id', docenteId)
        .in('id', porVerificar.flatMap((v) => v.remotos))
      if (error) throw error
      const filas = new Map(((data ?? []) as { id: string; eliminada_en: string | null }[]).map((f) => [f.id, f]))
      for (const v of porVerificar) {
        const fila = v.remotos.map((r) => filas.get(r)).find(Boolean)
        if (!fila) resultado.aisladas.push({ id: v.id, motivo: 'sin_evidencia' })
        else if (fila.eliminada_en) resultado.aisladas.push({ id: v.id, motivo: 'eliminada' })
        else confirmadas.push({ id: v.id, remotoId: fila.id })
      }
    } catch (e) {
      console.error('[PROPIETARIO_LOCAL] verificacion=false', e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e))
      for (const v of porVerificar) resultado.aisladas.push({ id: v.id, motivo: 'sin_evidencia' })
    }
  }
  // Sin duplicados: cada conversación remota tiene a lo más una copia propia.
  const propias = leerIndicePropio()
  const ocupados = new Set([...propias.map((c) => c.id), ...(await Promise.all(propias.map((c) => idRemotoDe(docenteId, c.id))))])
  // La sesión cambió durante la verificación: no se asigna nada.
  if (propietarioActual !== docenteId) return { asignadas: [], aisladas: resultado.aisladas }
  for (const c of confirmadas) {
    if (ocupados.has(c.remotoId)) {
      resultado.aisladas.push({ id: c.id, motivo: 'duplicada' })
      continue
    }
    ocupados.add(c.remotoId)
    // Copia descargada cuyo vínculo se perdió: se restituye para que la
    // sincronización use la conversación remota verificada.
    if (c.remotoId === c.id && (await idRemotoDe(docenteId, c.id)) !== c.id) guardarVinculoRemoto(c.id, docenteId, c.id)
    if (propietarioActual !== docenteId) return { asignadas: resultado.asignadas, aisladas: resultado.aisladas }
    asignarPropietario(c.id, docenteId)
    resultado.asignadas.push(c.id)
  }
  if (resultado.asignadas.length || resultado.aisladas.length) console.info('[PROPIETARIO_LOCAL]', JSON.stringify({ asignadas: resultado.asignadas.length, aisladas: resultado.aisladas.length }))
  return resultado
}

// Conversaciones remotas con mensajes y sin copia en este dispositivo.
export async function conversacionesRemotasSinCopiaLocal(docenteId: string): Promise<ConversacionResumen[]> {
  const { data, error } = await supabase
    .from('conversaciones_chat')
    .select('id, titulo, actualizado_en, mensajes_chat(count)')
    .eq('docente_id', docenteId)
    .is('eliminada_en', null)
    .order('actualizado_en', { ascending: false })
    .limit(TOPE_CONVERSACIONES)
  if (error) throw error
  // También cuentan como ocupadas las copias de otros o sin propietario:
  // descargarla de nuevo duplicaría o pisaría una copia aislada.
  const locales = leerIndice()
  const conCopia = new Set([...locales.map((c) => c.id), ...(await Promise.all(locales.map((c) => idRemotoDe(docenteId, c.id))))])
  return ((data ?? []) as { id: string; titulo: string; actualizado_en: string; mensajes_chat?: { count: number }[] }[])
    .filter((f) => (f.mensajes_chat?.[0]?.count ?? 0) > 0 && !conCopia.has(f.id))
    .map((f) => ({ id: f.id, titulo: f.titulo, actualizadaEn: Date.parse(f.actualizado_en) * 1000 }))
}

// Lista de la barra lateral: las locales primero en prioridad; las
// remotas solo si no hay una local con el mismo id.
export function combinarConversaciones(locales: ConversacionResumen[], remotasSinCopia: ConversacionResumen[]): ConversacionResumen[] {
  const ids = new Set(locales.map((c) => c.id))
  return [...locales, ...remotasSinCopia.filter((r) => !ids.has(r.id))].sort((a, b) => b.actualizadaEn - a.actualizadaEn)
}

type FilaMensajeLeida = { id: string; rol: MensajeConversacion['rol']; texto: string; contenido: Record<string, unknown> | null; creado_en: string }

// Filas de mensajes_chat → mensajes locales, solo las de esa conversación
// (id `<remoto>:<id local>`), en el orden recibido.
function filasAMensajes(remotoId: string, filas: FilaMensajeLeida[]): MensajeConversacion[] {
  const prefijo = `${remotoId}:`
  return filas
    .filter((f) => f.id.startsWith(prefijo))
    .map((f) => ({ ...(f.contenido ?? {}), id: f.id.slice(prefijo.length), rol: f.rol, texto: f.texto, creadoEn: Date.parse(f.creado_en) }) as MensajeConversacion)
}

// Contenido documental real de un mensaje del asistente:
// - el texto visible si es un documento formal (los de siempre; también
//   refleja una edición manual);
// - si no, el dato estructurado de un documento entregado directo como
//   archivo (CASO 3 del chat): muestra "Documento generado
//   correctamente." y guarda su texto real en contenidoDocumento junto al
//   archivo.
// Ningún otro mensaje es documento.
export function contenidoDocumentoDe(m: MensajeConversacion): string | null {
  if (m.rol !== 'asistente') return null
  if (esDocumentoFormal(m.texto)) return m.texto
  return m.contenidoDocumento?.trim() && (m.archivo || m.archivos?.length) ? m.contenidoDocumento : null
}

// Identidad estable del documento al que pertenece un mensaje (P2b): la del
// documento original de sus versiones; sin vínculo, el propio mensaje.
export function documentoRaizDe(m: Pick<MensajeConversacion, 'id' | 'documentoRaizId'>): string {
  return m.documentoRaizId ?? m.id
}

// Documento vigente de una conversación: lo determina el último evento
// documental — un mensaje con documento (cada edición agrega su versión al
// final) o una restauración (restauraVersion, P2c), que vuelve vigente la
// versión referida sin copiarla. origenId es el mensaje que lo determinó
// (la versión o el marcador): con él se sabe si llegó algo nuevo al
// sincronizar. Una restauración cuya versión no está en los mensajes, no
// es un documento o no es del mismo documento (otra raíz) queda como
// noRecuperado: nunca se elige otra versión en su lugar. Con su formato ya
// generado, si lo tiene; la caché de archivos no se reconstruye (es por
// versión exacta y vive solo en el documento activo del dispositivo).
export function resolverDocumentoVigente(mensajes: MensajeConversacion[]): { documento: DocumentoActivoGuardado; origenId: string } | null {
  const vigente = vigenteDeEventos(mensajes.flatMap((m) => eventoDocumentalDe(m) ?? []))
  if (!vigente) return null
  const version = vigente.noRecuperado ? undefined : mensajes.find((m) => m.id === vigente.id)
  const texto = version ? contenidoDocumentoDe(version) : null
  if (!version || !texto) return { documento: { id: vigente.id, texto: '', noRecuperado: true }, origenId: vigente.origenId }
  const formato = version.archivo?.tipo
  return { documento: { id: version.id, texto, ...(formato ? { ultimoFormatoGenerado: formato } : {}) }, origenId: vigente.origenId }
}

// Eventos documentales (P3b): lo único que decide qué versión es la vigente
// — una versión (un mensaje con documento), una restauración (P2c, con la
// raíz del documento) o una selección del docente (P3a). Se obtienen de
// los mensajes en memoria (eventoDocumentalDe) o, sin el texto, del índice
// remoto (leerIndiceDocumental): la misma regla para ambos.
export type EventoDocumental = { id: string; creadoEn: number; rol: MensajeConversacion['rol']; tipo: 'version' | 'restauracion' | 'seleccion'; raiz?: string; objetivo?: string }
export function eventoDocumentalDe(m: MensajeConversacion): EventoDocumental | null {
  if (m.rol === 'usuario' && m.documentoDestinoId) return { id: m.id, creadoEn: m.creadoEn, rol: m.rol, tipo: 'seleccion', objetivo: m.documentoDestinoId }
  if (m.rol === 'asistente' && m.restauraVersion) return { id: m.id, creadoEn: m.creadoEn, rol: m.rol, tipo: 'restauracion', objetivo: m.restauraVersion, ...(m.documentoRaizId ? { raiz: m.documentoRaizId } : {}) }
  return contenidoDocumentoDe(m) ? { id: m.id, creadoEn: m.creadoEn, rol: m.rol, tipo: 'version', raiz: documentoRaizDe(m) } : null
}

// Regla canónica del documento vigente: lo determina el ÚLTIMO evento. Una
// restauración o una selección solo referencian una versión; si esa versión
// no está entre los eventos (o, en una restauración, es de otra raíz), queda
// noRecuperado: nunca se elige otra en su lugar.
export function vigenteDeEventos(eventos: EventoDocumental[]): { id: string; origenId: string; noRecuperado?: true } | null {
  const e = eventos[eventos.length - 1]
  if (!e) return null
  if (e.tipo === 'version') return { id: e.id, origenId: e.id }
  const version = eventos.find((x) => x.tipo === 'version' && x.id === e.objetivo)
  const valida = !!version && (e.tipo === 'seleccion' || version.raiz === e.raiz)
  return valida ? { id: version.id, origenId: e.id } : { id: e.objetivo ?? '', origenId: e.id, noRecuperado: true }
}

// Documentos de la conversación (P3a), en el orden en que aparecieron (su
// primera versión): por cada identidad (raíz), su versión vigente —la
// última de ese documento o la que se restauró o eligió para él, con la
// regla canónica— y el título de su versión más reciente. Con los eventos
// del índice remoto (P3b) incluye los documentos fuera de la ventana local;
// el título de los que no están en memoria queda pendiente (idTitulo es la
// versión que hay que leer para conocerlo). Una versión vigente que no está
// en los eventos queda noRecuperado.
export type DocumentoDeConversacion = { raiz: string; id: string; titulo?: string; idTitulo: string; creadoEn: number; noRecuperado?: true }
export function documentosDeConversacion(mensajes: MensajeConversacion[], remotos: EventoDocumental[] = []): DocumentoDeConversacion[] {
  const locales = mensajes.flatMap((m) => eventoDocumentalDe(m) ?? [])
  const ids = new Set(mensajes.map((m) => m.id))
  const eventos = remotos.length ? combinarMensajes(locales, remotos.filter((e) => !ids.has(e.id))) : locales
  const raizDe = new Map(eventos.filter((e) => e.tipo === 'version').map((e) => [e.id, e.raiz ?? e.id]))
  const porRaiz = new Map<string, EventoDocumental[]>()
  for (const e of eventos) {
    const raiz = e.tipo === 'version' ? raizDe.get(e.id) : e.tipo === 'restauracion' ? e.raiz : raizDe.get(e.objetivo ?? '')
    if (!raiz || (!porRaiz.has(raiz) && e.tipo !== 'version')) continue
    porRaiz.set(raiz, [...(porRaiz.get(raiz) ?? []), e])
  }
  return [...porRaiz.entries()].flatMap(([raiz, propios]) => {
    const vigente = vigenteDeEventos(propios)
    if (!vigente) return []
    const versiones = propios.filter((e) => e.tipo === 'version')
    const ultima = versiones[versiones.length - 1]
    const mensaje = mensajes.find((m) => m.id === ultima.id)
    const texto = mensaje ? contenidoDocumentoDe(mensaje) : null
    return [{ raiz, id: vigente.id, idTitulo: ultima.id, creadoEn: versiones[0].creadoEn, ...(texto ? { titulo: texto.trim().split('\n')[0] ?? '' } : {}), ...(vigente.noRecuperado ? { noRecuperado: true as const } : {}) }]
  })
}

export function documentoVigente(mensajes: MensajeConversacion[]): DocumentoActivoGuardado | null {
  return resolverDocumentoVigente(mensajes)?.documento ?? null
}

// Documento activo al abrir o combinar: el guardado (con su caché y su
// texto) si es esa misma versión y está disponible; si no, el vigente.
export function elegirDocumentoActivo(guardado: DocumentoActivoGuardado | null, vigente: DocumentoActivoGuardado | null): DocumentoActivoGuardado | null {
  return guardado && vigente && guardado.id === vigente.id && !guardado.noRecuperado ? guardado : vigente
}

// La versión que la restauración vigente referencia se conserva en la
// copia local aunque quede fuera de los últimos TOPE_MENSAJES (así se
// resuelve al reabrir sin red).
function conVersionRestauradaFijada(mensajes: MensajeConversacion[], recortados: MensajeConversacion[]): MensajeConversacion[] {
  const vigente = resolverDocumentoVigente(mensajes)
  if (!vigente || vigente.origenId === vigente.documento.id || vigente.documento.noRecuperado) return recortados
  if (recortados.some((m) => m.id === vigente.documento.id)) return recortados
  const version = mensajes.find((m) => m.id === vigente.documento.id)
  return version ? [version, ...recortados] : recortados
}

// Mensajes que ya están en Supabase (descargados): se registran como
// enviados (sin reenvío) y de solo inserción. Recibe la copia YA guardada
// (aligerada), la misma que después ve la etapa 1.
function registrarComoEnviados(docenteId: string, remotoId: string, guardados: MensajeConversacion[]) {
  const estado = leerEstadoSincronizacion(docenteId)
  estado.soloInsercion = estado.soloInsercion ?? {}
  for (const m of guardados) {
    const fila = mensajeAFilaRemota(remotoId, docenteId, m)
    estado.huellas[fila.id] = huellaDe(fila)
    estado.soloInsercion[fila.id] = true
  }
  escribirEstadoSincronizacion(docenteId, estado)
}

// Descarga una conversación remota al navegador. Devuelve false si no
// existe, no es del docente o no tiene mensajes. Nunca pisa una copia
// local existente (y solo la acepta si su relación es de este docente).
export async function descargarConversacionRemota(docenteId: string, remotoId: string): Promise<boolean> {
  if (propietarioActual !== docenteId) return false
  if (cargarConversacionPorId(remotoId)) return leerVinculosRemotos()[remotoId]?.docenteId === docenteId
  // Hay una copia aislada (de otro docente o sin propietario) con ese id.
  if (leer(PREFIJO_CONVERSACION + remotoId) !== null) return false
  const { data: conversacion, error } = await supabase
    .from('conversaciones_chat')
    .select('id, titulo, documento_activo')
    .eq('id', remotoId)
    .eq('docente_id', docenteId)
    .maybeSingle()
  if (error) throw error
  if (!conversacion) return false
  const { data: filas, error: errorMensajes } = await supabase
    .from('mensajes_chat')
    .select('id, rol, texto, contenido, creado_en')
    .eq('conversacion_id', remotoId)
    .order('creado_en', { ascending: false })
    .limit(TOPE_MENSAJES)
  if (errorMensajes) throw errorMensajes
  // Desempate ANTES de recortar: si la fila más antigua leída comparte
  // fecha con otras que quedaron fuera del límite, también se leen, y los
  // últimos TOPE_MENSAJES se eligen con el orden canónico (P2c).
  let leidas = (filas ?? []) as FilaMensajeLeida[]
  if (leidas.length === TOPE_MENSAJES) {
    const { data: empatadas, error: errorEmpates } = await supabase
      .from('mensajes_chat')
      .select('id, rol, texto, contenido, creado_en')
      .eq('conversacion_id', remotoId)
      .eq('creado_en', leidas[leidas.length - 1].creado_en)
    if (errorEmpates) throw errorEmpates
    const ids = new Set(leidas.map((f) => f.id))
    leidas = [...leidas, ...((empatadas ?? []) as FilaMensajeLeida[]).filter((f) => !ids.has(f.id))]
  }
  let mensajes = filasAMensajes(remotoId, leidas).sort(compararOrden).slice(-TOPE_MENSAJES)
  if (mensajes.length === 0) return false
  // La versión que una restauración vigente referencia puede ser más vieja
  // que los últimos mensajes: se trae por su id (P2c-2). Si falla, la copia
  // queda con la restauración noRecuperado (se reintenta al sincronizar).
  const pendiente = resolverDocumentoVigente(mensajes)
  if (pendiente?.documento.noRecuperado) {
    try {
      mensajes = combinarMensajes(mensajes, await leerMensajesRemotosPorId(docenteId, remotoId, [pendiente.documento.id]))
    } catch (e) {
      console.error('[VERSION_RESTAURADA] recuperada=false', e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e))
    }
  }

  // La sesión cambió durante la descarga: no se escribe nada.
  if (propietarioActual !== docenteId) return false
  // Relación primero: desde aquí el motor y la etapa 1 usan este id.
  guardarVinculoRemoto(remotoId, docenteId, remotoId)
  // Documento activo: el documento vigente de los mensajes (también uno
  // entregado directo como archivo). El guardado en la fila solo se usa si
  // es ese mismo; uno anterior nunca lo sustituye.
  const documentoRemoto = conversacion.documento_activo as DocumentoActivoGuardado | null
  const documentoActivo = elegirDocumentoActivo(documentoRemoto, documentoVigente(mensajes))
  const titulo = conversacion.titulo && conversacion.titulo !== TITULO_INICIAL ? conversacion.titulo : undefined
  guardarConversacion(remotoId, mensajes, documentoActivo, titulo)

  // Ya están en Supabase: se registran como enviados (sin reenvío) y de
  // solo inserción; la etapa 2 no los vuelve a procesar.
  registrarComoEnviados(docenteId, remotoId, cargarConversacionPorId(remotoId)?.mensajes ?? [])
  marcarConversacionMigracion(docenteId, remotoId, 'migrada')
  recordarTituloRemoto(docenteId, remotoId, conversacion.titulo)
  return true
}

// ---------------------------------------------------------------------
// Sincronización de una conversación que YA tiene copia local (mensajes
// escritos en otro dispositivo). Fase 1: solo la función; todavía no se
// llama desde el chat.
//
// - Eliminada en Supabase: se retira la copia local (mecanismo 3B-1).
// - Detección: se leen TODOS los ids y fechas de la conversación (sin
//   textos), por páginas ordenadas por id, así que no depende del largo.
//   Solo se descargan completos los que faltan y caben en la copia local
//   (sus últimos TOPE_MENSAJES, el mismo recorte que guardarConversacion).
// - Combinación por id: lo local nunca se quita, reemplaza ni reordena
//   (ediciones y mensajes pendientes de subida incluidos); lo remoto
//   nuevo se intercala por fecha.
// - Sin carreras: la copia local se vuelve a leer justo antes de
//   escribir, sin ninguna espera entre esa lectura y la escritura; lo
//   creado mientras corría la consulta se conserva.
// - Lo traído queda como ya enviado y de solo inserción (la etapa 1 no
//   lo reenvía). Ninguna escritura remota.
//
// Quien muestre la conversación en memoria debe guardar antes lo que
// tenga sin guardar y aplicar `nuevos` con combinarMensajes.

// Filas pedidas por página. El servidor puede devolver menos (límite de
// filas de PostgREST): la lectura solo termina con una página vacía.
const PAGINA_IDS = 1000

export type ResultadoSincronizacion =
  | { estado: 'sin_cambios' | 'sin_remota' | 'sin_copia_local' | 'eliminada' }
  | { estado: 'actualizada'; nuevos: MensajeConversacion[] }

// Orden canónico de los mensajes (P2c): por fecha de creación y, con la
// misma fecha:
// 1. la pregunta del docente antes que la respuesta (los pares creados en
//    el mismo milisegundo; antes de P2c la respuesta recibía el id menor);
// 2. entre mensajes del mismo rol, la secuencia de su id
//    (msg-<ms>-<contador>-…) comparada como números (9 antes que 10);
// 3. el id como texto (ids de otro formato).
// Mensajes con fechas distintas nunca se reordenan por rol ni por id.
type ClaveOrden = Pick<MensajeConversacion, 'id' | 'creadoEn'> & { rol?: MensajeConversacion['rol'] }
const SECUENCIA_ID = /^msg-(\d+)-(\d+)-/
function ordenAntes(a: ClaveOrden, b: ClaveOrden): boolean {
  if (a.creadoEn !== b.creadoEn) return a.creadoEn < b.creadoEn
  if (a.rol && b.rol && (a.rol === 'usuario') !== (b.rol === 'usuario')) return a.rol === 'usuario'
  const sa = SECUENCIA_ID.exec(a.id)
  const sb = SECUENCIA_ID.exec(b.id)
  if (sa && sb && (sa[1] !== sb[1] || sa[2] !== sb[2])) return sa[1] !== sb[1] ? Number(sa[1]) < Number(sb[1]) : Number(sa[2]) < Number(sb[2])
  return a.id < b.id
}
export function compararOrden(a: ClaveOrden, b: ClaveOrden): number {
  return ordenAntes(a, b) ? -1 : ordenAntes(b, a) ? 1 : 0
}

// Copias locales anteriores a P2c: solo los mensajes con la MISMA fecha se
// ponen en orden canónico (p. ej. una respuesta guardada antes que su
// pregunta); el orden entre fechas distintas se conserva tal cual.
function ordenarEmpates<T extends ClaveOrden>(mensajes: T[]): T[] {
  let cambio = false
  const salida: T[] = []
  for (let i = 0; i < mensajes.length; ) {
    let j = i + 1
    while (j < mensajes.length && mensajes[j].creadoEn === mensajes[i].creadoEn) j++
    const grupo = mensajes.slice(i, j)
    if (grupo.length > 1) {
      const ordenado = [...grupo].sort(compararOrden)
      if (ordenado.some((m, k) => m !== grupo[k])) cambio = true
      salida.push(...ordenado)
    } else salida.push(grupo[0])
    i = j
  }
  return cambio ? salida : mensajes
}

// Intercala por fecha (y id) los remotos cuyo id no existe localmente.
// Los locales conservan su contenido y su orden relativo.
export function combinarMensajes<T extends ClaveOrden>(locales: T[], remotos: T[]): T[] {
  const ids = new Set(locales.map((m) => m.id))
  const nuevos = [...new Map(remotos.filter((m) => !ids.has(m.id)).map((m) => [m.id, m])).values()]
    .sort(compararOrden)
  if (nuevos.length === 0) return locales
  const combinados: T[] = []
  let i = 0
  for (const local of locales) {
    while (i < nuevos.length && ordenAntes(nuevos[i], local)) combinados.push(nuevos[i++])
    combinados.push(local)
  }
  return [...combinados, ...nuevos.slice(i)]
}

// Una sola sincronización a la vez por conversación.
const sincronizacionesEnCurso = new Map<string, Promise<ResultadoSincronizacion>>()

// Lanza si Supabase falla; en ese caso no se escribió nada.
export function sincronizarConversacionRemota(docenteId: string, localId: string): Promise<ResultadoSincronizacion> {
  const clave = `${docenteId}:${localId}`
  const enCurso = sincronizacionesEnCurso.get(clave)
  if (enCurso) return enCurso
  const promesa = ejecutarSincronizacion(docenteId, localId).finally(() => sincronizacionesEnCurso.delete(clave))
  sincronizacionesEnCurso.set(clave, promesa)
  return promesa
}

// Después de los mensajes nuevos, la versión que una restauración vigente
// referencia y no está en la copia local (P2c-2): se trae por su id antes
// de permitir operaciones con el documento.
async function ejecutarSincronizacion(docenteId: string, localId: string): Promise<ResultadoSincronizacion> {
  const resultado = await sincronizarMensajesNuevos(docenteId, localId)
  if (resultado.estado !== 'actualizada' && resultado.estado !== 'sin_cambios') return resultado
  const version = await recuperarVersionRestaurada(docenteId, localId)
  if (!version) return resultado
  return { estado: 'actualizada', nuevos: [...(resultado.estado === 'actualizada' ? resultado.nuevos : []), version] }
}

async function sincronizarMensajesNuevos(docenteId: string, localId: string): Promise<ResultadoSincronizacion> {
  if (propietarioActual !== docenteId || !cargarConversacionPorId(localId)) return { estado: 'sin_copia_local' }
  const remotoId = await idRemotoDe(docenteId, localId)
  const { data: conversacion, error } = await supabase
    .from('conversaciones_chat')
    .select('id, eliminada_en')
    .eq('id', remotoId)
    .eq('docente_id', docenteId)
    .maybeSingle()
  if (error) throw error
  if (!conversacion) return { estado: 'sin_remota' }
  if (conversacion.eliminada_en) {
    await retirarConversacionLocal(docenteId, localId, remotoId)
    return { estado: 'eliminada' }
  }

  // Todos los ids y fechas remotos (paginación por id: estable aunque
  // lleguen mensajes nuevos durante la lectura, y correcta aunque el
  // servidor devuelva menos filas de las pedidas).
  const prefijo = `${remotoId}:`
  const remotos: ClaveOrden[] = []
  for (let ultimo = ''; ;) {
    const { data, error: errorIds } = await supabase
      .from('mensajes_chat')
      .select('id, creado_en')
      .eq('conversacion_id', remotoId)
      .gt('id', ultimo)
      .order('id', { ascending: true })
      .limit(PAGINA_IDS)
    if (errorIds) throw errorIds
    const pagina = (data ?? []) as { id: string; creado_en: string }[]
    for (const f of pagina) if (f.id.startsWith(prefijo)) remotos.push({ id: f.id.slice(prefijo.length), creadoEn: Date.parse(f.creado_en) })
    if (pagina.length === 0) break
    ultimo = pagina[pagina.length - 1].id
  }

  // Faltantes que quedarían dentro de la copia local tras combinar.
  const local = cargarConversacionPorId(localId)
  if (!local) return { estado: 'sin_copia_local' }
  const idsLocales = new Set(local.mensajes.map((m) => m.id))
  const ventana = combinarMensajes<ClaveOrden>(local.mensajes, remotos).slice(-TOPE_MENSAJES)
  // Empates en el límite (P2c): aquí no se conoce el rol, así que también
  // se traen los mensajes con la misma fecha que el más antiguo de la
  // ventana; al combinarlos completos, el orden canónico decide cuáles
  // quedan en la copia (guardarConversacion recorta igual que siempre).
  const limite = ventana[0]?.creadoEn
  const faltantes = [...new Set([...ventana, ...remotos.filter((m) => m.creadoEn === limite)].map((m) => m.id))]
    .filter((id) => !idsLocales.has(id))
    .map((id) => idMensajeRemoto(remotoId, id))
  if (faltantes.length === 0) return { estado: 'sin_cambios' }

  const traidos = filasAMensajes(remotoId, await leerFilasPorId(remotoId, faltantes))

  // Desde aquí no hay esperas: se combina con la copia local VIGENTE.
  const actual = cargarConversacionPorId(localId)
  if (!actual) return { estado: 'sin_copia_local' }
  const idsActuales = new Set(actual.mensajes.map((m) => m.id))
  const agregados = new Set(traidos.filter((m) => !idsActuales.has(m.id)).map((m) => m.id))
  if (agregados.size === 0) return { estado: 'sin_cambios' }
  const combinados = combinarMensajes(actual.mensajes, traidos)
  // Documento activo: pasa al documento vigente solo si lo determinó uno
  // de los traídos (una versión o una restauración; criterio de la 3A).
  const vigente = resolverDocumentoVigente(combinados)
  const documentoActivo = vigente && agregados.has(vigente.origenId) ? elegirDocumentoActivo(actual.documentoActivo, vigente.documento) : actual.documentoActivo
  guardarConversacion(localId, combinados, documentoActivo, actual.titulo)
  const nuevos = (cargarConversacionPorId(localId)?.mensajes ?? []).filter((m) => agregados.has(m.id))
  registrarComoEnviados(docenteId, remotoId, nuevos)
  return { estado: 'actualizada', nuevos }
}

// ---------------------------------------------------------------------
// Versiones fuera de la ventana local (P2c-2): lectura por ids exactos,
// siempre de ESTA conversación (conversacion_id) y con la sesión del
// docente (RLS); nunca se carga el historial completo.

// Filas de mensajes_chat por id remoto, en lotes (la misma lectura con la
// que la sincronización trae los mensajes que faltan).
async function leerFilasPorId(remotoId: string, idsRemotos: string[]): Promise<FilaMensajeLeida[]> {
  const filas: FilaMensajeLeida[] = []
  for (let i = 0; i < idsRemotos.length; i += LOTE_MIGRACION) {
    const { data, error } = await supabase
      .from('mensajes_chat')
      .select('id, rol, texto, contenido, creado_en')
      .eq('conversacion_id', remotoId)
      .in('id', idsRemotos.slice(i, i + LOTE_MIGRACION))
    if (error) throw error
    filas.push(...((data ?? []) as FilaMensajeLeida[]))
  }
  return filas
}

// Mensajes de una conversación por su id local. Una sola lectura en curso
// por conversación e ids (las peticiones simultáneas comparten la misma).
// Índice documental de una conversación (P3b): TODOS sus eventos
// documentales en Supabase —sin el texto, solo id, fecha y vínculos—, para
// conocer los documentos que quedaron fuera de la ventana local. Mismas
// restricciones que la sincronización: sesión del docente (RLS) y
// conversacion_id; paginado por id hasta agotar (sin tope de resultados).
// El filtro reproduce en el servidor lo que eventoDocumentalDe reconoce en
// el cliente (título de documento formal, documento entregado como
// archivo, restauración o selección). Lanza si Supabase falla.
const FILTRO_EVENTOS_DOCUMENTALES = [
  `and(rol.eq.asistente,texto.match."${PATRON_TITULO_DOCUMENTO_SQL}")`,
  'and(rol.eq.asistente,contenido->>contenidoDocumento.not.is.null,or(contenido->archivo.not.is.null,contenido->archivos.not.is.null))',
  'and(rol.eq.asistente,contenido->>restauraVersion.not.is.null)',
  'and(rol.eq.usuario,contenido->>documentoDestinoId.not.is.null)',
].join(',')
type FilaIndiceDocumental = { id: string; rol: string; creado_en: string; raiz: string | null; restaura: string | null; destino: string | null }
export async function leerIndiceDocumental(docenteId: string, localId: string): Promise<EventoDocumental[]> {
  const remotoId = await idRemotoDe(docenteId, localId)
  const prefijo = `${remotoId}:`
  const eventos: EventoDocumental[] = []
  for (let ultimo = ''; ;) {
    const { data, error } = await supabase
      .from('mensajes_chat')
      .select('id, rol, creado_en, raiz:contenido->>documentoRaizId, restaura:contenido->>restauraVersion, destino:contenido->>documentoDestinoId')
      .eq('conversacion_id', remotoId)
      .or(FILTRO_EVENTOS_DOCUMENTALES)
      .gt('id', ultimo)
      .order('id', { ascending: true })
      .limit(PAGINA_IDS)
    if (error) throw error
    const pagina = (data ?? []) as unknown as FilaIndiceDocumental[]
    for (const f of pagina) {
      if (!f.id.startsWith(prefijo)) continue
      const id = f.id.slice(prefijo.length)
      const creadoEn = Date.parse(f.creado_en)
      if (f.rol === 'usuario') eventos.push({ id, creadoEn, rol: 'usuario', tipo: 'seleccion', objetivo: f.destino ?? '' })
      else if (f.restaura) eventos.push({ id, creadoEn, rol: 'asistente', tipo: 'restauracion', objetivo: f.restaura, ...(f.raiz ? { raiz: f.raiz } : {}) })
      else eventos.push({ id, creadoEn, rol: 'asistente', tipo: 'version', raiz: f.raiz ?? id })
    }
    if (pagina.length === 0) break
    ultimo = pagina[pagina.length - 1].id
  }
  return eventos.sort(compararOrden)
}

// Vienen de Supabase: quedan registrados como ya enviados (la etapa 1 no
// los reescribe). Lanza si Supabase falla.
const lecturasPorIdEnCurso = new Map<string, Promise<MensajeConversacion[]>>()
export function leerMensajesRemotosPorId(docenteId: string, remotoId: string, ids: string[]): Promise<MensajeConversacion[]> {
  const unicos = [...new Set(ids)].sort()
  const clave = `${docenteId}:${remotoId}:${unicos.join(',')}`
  const enCurso = lecturasPorIdEnCurso.get(clave)
  if (enCurso) return enCurso
  const promesa = (async () => {
    const mensajes = filasAMensajes(remotoId, await leerFilasPorId(remotoId, unicos.map((id) => idMensajeRemoto(remotoId, id))))
    if (mensajes.length > 0) registrarComoEnviados(docenteId, remotoId, mensajes)
    return mensajes
  })().finally(() => lecturasPorIdEnCurso.delete(clave))
  lecturasPorIdEnCurso.set(clave, promesa)
  return promesa
}

// Si la restauración vigente de la copia local apunta a una versión que no
// está, la trae por su id y, solo si resuelve esa misma restauración (es un
// documento de la misma raíz), la combina y la guarda (queda fijada en la
// copia). Nunca usa otra versión; si algo falla, queda noRecuperado.
async function recuperarVersionRestaurada(docenteId: string, localId: string): Promise<MensajeConversacion | null> {
  if (propietarioActual !== docenteId) return null
  const local = cargarConversacionPorId(localId)
  const pendiente = local ? resolverDocumentoVigente(local.mensajes) : null
  if (!pendiente?.documento.noRecuperado) return null
  let traidos: MensajeConversacion[]
  try {
    traidos = await leerMensajesRemotosPorId(docenteId, await idRemotoDe(docenteId, localId), [pendiente.documento.id])
  } catch (e) {
    console.error('[VERSION_RESTAURADA] recuperada=false', e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e))
    return null
  }
  // Desde aquí no hay esperas: se combina con la copia local VIGENTE.
  const actual = cargarConversacionPorId(localId)
  if (!actual || traidos.length === 0) return null
  const combinados = combinarMensajes(actual.mensajes, traidos)
  const resuelto = resolverDocumentoVigente(combinados)
  if (!resuelto || resuelto.documento.noRecuperado || resuelto.documento.id !== pendiente.documento.id || resuelto.origenId !== pendiente.origenId) return null
  guardarConversacion(localId, combinados, elegirDocumentoActivo(actual.documentoActivo, resuelto.documento), actual.titulo)
  return cargarConversacionPorId(localId)?.mensajes.find((m) => m.id === resuelto.documento.id) ?? null
}

// ---------------------------------------------------------------------
// Eliminación global (etapa 3B-1). La conversación se elimina en
// Supabase con eliminar_conversacion (borra sus mensajes y deja la fila
// como marca: ningún dispositivo puede recrearla). Solo después de esa
// confirmación se retira la copia local; en los demás dispositivos se
// retira al detectar la marca (lista, etapa 1 o etapa 2). Archivos de
// Storage: fuera de esta subfase.

// Quien muestra la lista se entera de que una conversación se retiró
// del dispositivo (para salir de ella si estaba abierta).
let alRetirarConversacion: ((localId: string) => void) | null = null
export function registrarAlRetirarConversacion(funcion: (localId: string) => void) {
  alRetirarConversacion = funcion
}

async function conversacionEliminadaRemota(remotoId: string): Promise<boolean> {
  const { data, error } = await supabase.from('conversaciones_chat').select('eliminada_en').eq('id', remotoId).maybeSingle()
  return !error && !!data?.eliminada_en
}

// Quita del dispositivo todo lo de una conversación: copia local,
// relación local → remoto, mensajes pendientes, huellas y marcas. Nada
// remoto.
export async function retirarConversacionLocal(docenteId: string, localId: string, remotoConocido?: string): Promise<void> {
  if (propietarioActual !== docenteId) return
  const remotoId = remotoConocido ?? (await idRemotoDe(docenteId, localId))
  if (propietarioActual !== docenteId) return
  eliminarConversacion(localId)
  const vinculos = leerVinculosRemotos()
  if (vinculos[localId]) {
    delete vinculos[localId]
    escribir(CLAVE_VINCULOS_REMOTOS, JSON.stringify(vinculos))
  }
  const estado = leerEstadoSincronizacion(docenteId)
  const prefijo = `${remotoId}:`
  estado.pendientes = estado.pendientes.filter((p) => p.fila.conversacion_id !== remotoId)
  estado.huellas = Object.fromEntries(Object.entries(estado.huellas).filter(([id]) => !id.startsWith(prefijo)))
  if (estado.soloInsercion) estado.soloInsercion = Object.fromEntries(Object.entries(estado.soloInsercion).filter(([id]) => !id.startsWith(prefijo)))
  escribirEstadoSincronizacion(docenteId, estado)
  const migracion = leerEstadoMigracion(docenteId)
  if (migracion[localId]) {
    delete migracion[localId]
    escribir(PREFIJO_MIGRACION + docenteId, JSON.stringify(migracion))
  }
  const titulos = leerTitulosRemotos(docenteId)
  if (titulos[remotoId]) {
    delete titulos[remotoId]
    escribir(PREFIJO_TITULOS_REMOTOS + docenteId, JSON.stringify(titulos))
  }
  conversacionesRemotas.delete(`${docenteId}:${localId}`)
  alRetirarConversacion?.(localId)
}

// Elimina en todos los dispositivos. remotoConocido: para una
// conversación que solo existe en Supabase (su id local ES el remoto).
// Lanza si Supabase no confirma: entonces no se retira nada local.
export async function eliminarConversacionGlobal(docenteId: string, localId: string, remotoConocido?: string): Promise<'eliminada' | 'ya_eliminada' | 'no_encontrada'> {
  const remotoId = remotoConocido ?? (await idRemotoDe(docenteId, localId))
  const { data, error } = await supabase.rpc('eliminar_conversacion', { p_conversacion_id: remotoId })
  if (error) throw error
  const estado = (data as { estado?: string } | null)?.estado
  if (estado !== 'eliminada' && estado !== 'ya_eliminada' && estado !== 'no_encontrada') throw new Error('Respuesta inesperada al eliminar la conversación.')
  // no_encontrada: nunca llegó a Supabase (solo local) o no es de este
  // docente; en ambos casos se retira solo la copia de este dispositivo.
  await retirarConversacionLocal(docenteId, localId, remotoId)
  return estado
}

// Conversaciones con copia en este dispositivo que fueron eliminadas en
// otro: una consulta acotada a sus ids remotos.
export async function conversacionesLocalesEliminadas(docenteId: string): Promise<{ localId: string; remotoId: string }[]> {
  if (propietarioActual !== docenteId) return []
  const locales = leerIndicePropio()
  if (locales.length === 0) return []
  const pares = await Promise.all(locales.map(async (c) => ({ localId: c.id, remotoId: await idRemotoDe(docenteId, c.id) })))
  const { data, error } = await supabase
    .from('conversaciones_chat')
    .select('id')
    .eq('docente_id', docenteId)
    .in('id', pares.map((p) => p.remotoId))
    .not('eliminada_en', 'is', null)
  if (error) throw error
  const eliminadas = new Set((data ?? []).map((f: { id: string }) => f.id))
  return pares.filter((p) => eliminadas.has(p.remotoId))
}
