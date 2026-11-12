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
import { esDocumentoFormal } from './documentos'
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
    // Propuesta de lista oficial: el token y la vista solo se
    // guardan mientras se puede aplicar.
    if (ligero.datosPropuestaLista) ligero = { ...ligero, datosPropuestaLista: propuestaListaParaGuardar(ligero.datosPropuestaLista) }
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
      .select('id, titulo, documento_activo, actualizado_en')
      .in('id', candidatas.map((c) => c.remotoId))
    if (error) throw error
    const filasPropias = new Map((propias ?? []).map((f: { id: string; titulo: string; documento_activo: unknown; actualizado_en: string }) => [f.id, f]))

    for (const c of candidatas) {
      const remota = filasPropias.get(c.remotoId)
      if (!remota) {
        resultado.sinPertenencia++
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
    const { error } = await supabase.from('conversaciones_chat').update({ documento_activo: c.documentoActivo }).eq('id', c.remotoId).is('documento_activo', null)
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
    const resumen = leerIndice().find((c) => c.id === localId)
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

// Conversaciones remotas con mensajes y sin copia en este dispositivo.
export async function conversacionesRemotasSinCopiaLocal(docenteId: string): Promise<ConversacionResumen[]> {
  const { data, error } = await supabase
    .from('conversaciones_chat')
    .select('id, titulo, actualizado_en, mensajes_chat(count)')
    .eq('docente_id', docenteId)
    .order('actualizado_en', { ascending: false })
    .limit(TOPE_CONVERSACIONES)
  if (error) throw error
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

// Descarga una conversación remota al navegador. Devuelve false si no
// existe, no es del docente o no tiene mensajes. Nunca pisa una copia
// local existente (y solo la acepta si su relación es de este docente).
export async function descargarConversacionRemota(docenteId: string, remotoId: string): Promise<boolean> {
  if (cargarConversacionPorId(remotoId)) return leerVinculosRemotos()[remotoId]?.docenteId === docenteId
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
  const prefijo = `${remotoId}:`
  const mensajes = ((filas ?? []) as { id: string; rol: MensajeConversacion['rol']; texto: string; contenido: Record<string, unknown> | null; creado_en: string }[])
    .filter((f) => f.id.startsWith(prefijo))
    .reverse()
    .map((f) => ({ ...(f.contenido ?? {}), id: f.id.slice(prefijo.length), rol: f.rol, texto: f.texto, creadoEn: Date.parse(f.creado_en) }) as MensajeConversacion)
  if (mensajes.length === 0) return false

  // Relación primero: desde aquí el motor y la etapa 1 usan este id.
  guardarVinculoRemoto(remotoId, docenteId, remotoId)
  // Documento activo: el guardado en la fila si sigue en los mensajes; si
  // no hay, el último documento formal del asistente (mismo criterio con
  // el que el chat lo fija al terminar un documento).
  const documentoRemoto = conversacion.documento_activo as DocumentoActivoGuardado | null
  const ultimoDocumento = [...mensajes].reverse().find((m) => m.rol === 'asistente' && esDocumentoFormal(m.texto))
  const documentoActivo = documentoRemoto && mensajes.some((m) => m.id === documentoRemoto.id)
    ? documentoRemoto
    : ultimoDocumento ? { id: ultimoDocumento.id, texto: ultimoDocumento.texto } : null
  const titulo = conversacion.titulo && conversacion.titulo !== TITULO_INICIAL ? conversacion.titulo : undefined
  guardarConversacion(remotoId, mensajes, documentoActivo, titulo)

  // Ya están en Supabase: se registran como enviados (sin reenvío) y de
  // solo inserción; la etapa 2 no los vuelve a procesar.
  const guardados = cargarConversacionPorId(remotoId)?.mensajes ?? []
  const estado = leerEstadoSincronizacion(docenteId)
  estado.soloInsercion = estado.soloInsercion ?? {}
  for (const m of guardados) {
    const fila = mensajeAFilaRemota(remotoId, docenteId, m)
    estado.huellas[fila.id] = huellaDe(fila)
    estado.soloInsercion[fila.id] = true
  }
  escribirEstadoSincronizacion(docenteId, estado)
  marcarConversacionMigracion(docenteId, remotoId, 'migrada')
  recordarTituloRemoto(docenteId, remotoId, conversacion.titulo)
  return true
}
