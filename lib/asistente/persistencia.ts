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
//
// ARCHIVO EN TRANSICIÓN (PASO 2 del plan de historial persistente en
// Supabase): todo lo de ARRIBA de esta nota es LEGACY — localStorage,
// tal cual ya funcionaba, SIN NINGÚN CAMBIO — y sigue siendo lo único
// que usa AsistenteService.ts hasta el PASO 3. La sección nueva, al
// final del archivo ("PASO 2 — Persistencia remota (Supabase)"), habla
// directo con las tablas conversaciones_chat/mensajes_chat y es la
// que se irá conectando en el paso siguiente — Supabase es su única
// fuente de verdad, nunca localStorage.

import { esDocumentoFormal } from './documentos'
import { extraerTitulo } from '../documentGen/parseContenido'
import { supabase } from '../supabaseClient'
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
// Imagen suelta activa (ver "Implementar en Docente IA la capacidad de
// generar imágenes...", Fase 0+1) — paralelo a DocumentoActivoGuardado,
// nunca lo reemplaza: una conversación puede tener un documento de
// texto activo Y una imagen activa a la vez (por ejemplo, si el
// docente generó una imagen ANTES de empezar un documento). id es la
// fila real en assets_visuales (permite "regenerar" con versionado,
// ver lib/assetsVisuales.ts). Opcional en ConversacionGuardada por la
// misma razón que archivosGenerados/ultimoFormatoGenerado: código de
// conversaciones guardadas antes de que existiera este campo debe
// seguir restaurando sin él.
export type MaterialVisualActivoGuardado = {
  id: string
  promptOriginal: string
  url: string
  nombre: string
}
export type ConversacionResumen = { id: string; titulo: string; actualizadaEn: number }

type ConversacionGuardada = {
  version: number
  titulo: string
  mensajes: MensajeConversacion[]
  documentoActivo: DocumentoActivoGuardado | null
  materialVisualActivo?: MaterialVisualActivoGuardado | null
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
    guardarConversacion(id, datosViejos.mensajes, datosViejos.documentoActivo ?? null, null, titulo)
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

export function cargarConversacionPorId(id: string): { titulo: string; mensajes: MensajeConversacion[]; documentoActivo: DocumentoActivoGuardado | null; materialVisualActivo: MaterialVisualActivoGuardado | null } | null {
  const crudo = leer(PREFIJO_CONVERSACION + id)
  if (!crudo) return null
  try {
    const datos = JSON.parse(crudo) as ConversacionGuardada
    if (datos.version !== VERSION || !Array.isArray(datos.mensajes)) return null
    return { titulo: datos.titulo, mensajes: datos.mensajes, documentoActivo: datos.documentoActivo ?? null, materialVisualActivo: datos.materialVisualActivo ?? null }
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

export function guardarConversacion(id: string, mensajes: MensajeConversacion[], documentoActivo: DocumentoActivoGuardado | null, materialVisualActivo: MaterialVisualActivoGuardado | null, tituloForzado?: string) {
  if (mensajes.length === 0) return // conversación vacía: nada que guardar todavía
  const mensajesRecortados = mensajes.slice(-TOPE_MENSAJES)
  const titulo = tituloForzado ?? derivarTitulo(mensajesRecortados)
  const actualizadaEn = marcaDeTiempo()

  const datos: ConversacionGuardada = {
    version: VERSION,
    titulo,
    mensajes: aligerarParaGuardar(mensajesRecortados),
    documentoActivo,
    materialVisualActivo,
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
// PASO 2 — Persistencia remota (Supabase): conversaciones_chat +
// mensajes_chat (ver migración 20260811184000_crear_conversaciones_chat.sql).
//
// Ver "Nueva prueba real en iPhone — historial no persiste": localStorage
// vive por origen, y cada Preview de Vercel usa un subdominio nuevo, así
// que el historial quedaba inaccesible en cuanto cambiaba el deployment
// (o el dispositivo). Todo lo de ARRIBA en este archivo (localStorage)
// queda como LEGACY a partir de aquí — sigue en uso tal cual, sin
// ningún cambio de comportamiento, únicamente porque AsistenteService.ts
// todavía llama a esas funciones (se adapta en el PASO 3 del plan
// autorizado, no en este). Ninguna función de esta sección toca
// localStorage; Supabase es su única fuente de verdad.
//
// docente_id NUNCA se recibe como parámetro desde quien llama — se
// resuelve siempre aquí adentro contra la sesión real
// (supabase.auth.getUser()), igual que ya exige RLS del lado servidor.
// Aceptarlo como argumento sería confiar en un dato que el propio
// docente podría manipular antes de que RLS lo rechace.

async function docenteIdActual(): Promise<string | null> {
  const { data: { user } } = await supabase.auth.getUser()
  return user?.id ?? null
}

// Separa los campos "núcleo" (columnas reales de mensajes_chat) del
// resto de MensajeConversacion (archivo, archivos, imagen, imagenes,
// acciones, accionElegida, datosAccionCalendario, datosAccionNavegacion)
// — ese resto viaja completo en la columna `contenido` jsonb (mismo
// criterio que trabajos_documento.resultado: evita una migración de
// columna cada vez que se agregue un campo nuevo al tipo).
// aligerarParaGuardar ya existe arriba y sigue aplicando aquí por la
// misma razón de siempre: nunca guardar el base64 completo de un adjunto.
function mensajeAFilaRemota(conversacionId: string, docenteId: string, mensaje: MensajeConversacion) {
  const [ligero] = aligerarParaGuardar([mensaje])
  const { id, rol, texto, creadoEn, ...contenido } = ligero
  return {
    id,
    conversacion_id: conversacionId,
    docente_id: docenteId,
    rol,
    texto,
    contenido,
    creado_en: new Date(creadoEn).toISOString(),
  }
}

function filaAMensajeRemoto(fila: {
  id: string
  rol: MensajeConversacion['rol']
  texto: string
  creado_en: string
  contenido: Record<string, unknown> | null
}): MensajeConversacion {
  return {
    id: fila.id,
    rol: fila.rol,
    texto: fila.texto,
    creadoEn: new Date(fila.creado_en).getTime(),
    ...(fila.contenido ?? {}),
  } as MensajeConversacion
}

// Crea la conversación en Supabase (fila real desde el primer
// instante) y regresa su id. Lanza si no hay sesión real — a
// diferencia de las funciones legacy de arriba (que nunca truenan por
// diseño, para no romper localStorage), aquí un fallo real de
// autenticación SÍ debe propagarse: escribir con un docente_id
// inventado no es una opción.
export async function crearConversacionRemota(): Promise<string> {
  const docenteId = await docenteIdActual()
  if (!docenteId) throw new Error('Sesión no encontrada.')
  const id = crypto.randomUUID()
  const { error } = await supabase.from('conversaciones_chat').insert({ id, docente_id: docenteId })
  if (error) throw error
  return id
}

// Recupera una conversación completa (título + documento/imagen
// activos + TODOS sus mensajes, en orden real de creación) desde
// Supabase. null si no existe o no pertenece al docente actual — RLS
// ya lo filtra solo, esto nunca distingue "no existe" de "no es tuya"
// (mismo criterio de no exponer información de otro docente que ya
// sigue cargarConversacionPorId).
export async function obtenerConversacionRemota(id: string): Promise<{
  titulo: string
  mensajes: MensajeConversacion[]
  documentoActivo: DocumentoActivoGuardado | null
  materialVisualActivo: MaterialVisualActivoGuardado | null
} | null> {
  const { data: conversacion, error: errorConversacion } = await supabase
    .from('conversaciones_chat')
    .select('titulo, documento_activo, material_visual_activo')
    .eq('id', id)
    .maybeSingle()
  if (errorConversacion) throw errorConversacion
  if (!conversacion) return null

  const { data: filasMensajes, error: errorMensajes } = await supabase
    .from('mensajes_chat')
    .select('id, rol, texto, contenido, creado_en')
    .eq('conversacion_id', id)
    .order('creado_en', { ascending: false })
    .limit(TOPE_MENSAJES)
  if (errorMensajes) throw errorMensajes

  const mensajes = (filasMensajes ?? []).map(filaAMensajeRemoto).reverse()
  return {
    titulo: conversacion.titulo,
    mensajes,
    documentoActivo: (conversacion.documento_activo as DocumentoActivoGuardado | null) ?? null,
    materialVisualActivo: (conversacion.material_visual_activo as MaterialVisualActivoGuardado | null) ?? null,
  }
}

// Guarda UN mensaje. upsert por id (no solo insert) a propósito:
// permite que el mismo mensaje del asistente se actualice varias veces
// mientras termina de redactarse/transmitirse sin crear filas
// duplicadas — la política RLS de UPDATE ya existe para esto (ver
// migración). Nunca reescribe los demás mensajes de la conversación, a
// diferencia de guardarConversacion (legacy), que reescribía el
// arreglo completo cada vez.
export async function guardarMensajeRemoto(conversacionId: string, mensaje: MensajeConversacion): Promise<void> {
  const docenteId = await docenteIdActual()
  if (!docenteId) throw new Error('Sesión no encontrada.')
  const fila = mensajeAFilaRemota(conversacionId, docenteId, mensaje)
  const { error } = await supabase.from('mensajes_chat').upsert(fila, { onConflict: 'id' })
  if (error) throw error
}

// Título / documento activo / imagen activa de la conversación.
// actualizado_en se toca SIEMPRE, explícito — este proyecto no usa
// triggers en ningún lado (ver la migración), mismo criterio que ya
// usa lib/trabajosDocumento.ts para su propio actualizado_en.
export async function actualizarConversacionRemota(
  id: string,
  cambios: { titulo?: string; documentoActivo?: DocumentoActivoGuardado | null; materialVisualActivo?: MaterialVisualActivoGuardado | null }
): Promise<void> {
  const docenteId = await docenteIdActual()
  if (!docenteId) throw new Error('Sesión no encontrada.')
  const filaCambios: Record<string, unknown> = { actualizado_en: new Date().toISOString() }
  if (cambios.titulo !== undefined) filaCambios.titulo = cambios.titulo
  if (cambios.documentoActivo !== undefined) filaCambios.documento_activo = cambios.documentoActivo
  if (cambios.materialVisualActivo !== undefined) filaCambios.material_visual_activo = cambios.materialVisualActivo
  const { error } = await supabase.from('conversaciones_chat').update(filaCambios).eq('id', id)
  if (error) throw error
}

// Índice ligero para la barra lateral, más reciente primero. RLS ya
// limita a las del docente actual; el .eq de abajo es solo claridad
// adicional, mismo estilo que ya usa el resto del proyecto (ver
// obtenerPerfilYSesion en perfilDocente.ts).
export async function listarConversacionesRemoto(): Promise<ConversacionResumen[]> {
  const docenteId = await docenteIdActual()
  if (!docenteId) return []
  const { data, error } = await supabase
    .from('conversaciones_chat')
    .select('id, titulo, actualizado_en')
    .eq('docente_id', docenteId)
    .order('actualizado_en', { ascending: false })
    .limit(TOPE_CONVERSACIONES)
  if (error) throw error
  return (data ?? []).map((fila) => ({ id: fila.id, titulo: fila.titulo, actualizadaEn: new Date(fila.actualizado_en).getTime() }))
}

// FASE V1-B — ya NO borra conversaciones_chat directamente: los
// assets_visuales de la conversación (imágenes generadas/editadas) no
// tienen cascada real hacia Storage ni policy de DELETE propia (ver
// diagnóstico "contexto visual persistente" — ciclo de vida sano de
// assets), así que el borrado real vive en un endpoint server-side que
// limpia Storage + assets_visuales + conversación EN ESE ORDEN, con
// service_role solo donde hace falta. mensajes_chat se sigue vaciando
// solo por el ON DELETE CASCADE ya existente, dentro de ese endpoint.
// Nunca esconde el error: si la respuesta no es 200 (y no es el 404
// idempotente de abajo), se lanza — el caller
// (AsistenteService.eliminarConversacion) depende de esto para no
// limpiar el estado local sin que el borrado remoto haya funcionado.
//
// EXCEPCIÓN — 404 se trata como éxito idempotente: el endpoint (RLS de
// conversaciones_chat) responde 404 tanto si la conversación nunca
// existió en Supabase como si es de otro docente — nunca distingue
// ambos casos, por diseño, para no filtrar esa información (mismo
// criterio que obtenerConversacionRemota). Una conversación que solo
// vive en localStorage SIGUE siendo un caso real y vigente hoy:
// crearConversacionRemota() se llama fire-and-forget (ver
// persistirMensajeRemoto/persistirMensajeAsegurandoConversacion en
// AsistenteService.ts) y su fallo solo se loguea, nunca bloquea el
// chat — así que puede no existir fila remota nunca. Si esta llamada
// da 404, no hay nada remoto PROPIO que borrar (RLS ya garantiza que
// nunca es de otro docente) — es seguro dejar seguir la limpieza local.
// 401/500 (auth inválida, fallo real de Storage/DB/red) NO entran aquí
// y siguen lanzando.
export async function eliminarConversacionRemota(id: string): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch('/api/assets-visuales/eliminar-conversacion', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session?.access_token ?? ''}`,
    },
    body: JSON.stringify({ conversacionId: id }),
  })
  if (res.status === 404) return
  if (!res.ok) {
    const cuerpo = await res.json().catch(() => null)
    throw new Error(cuerpo?.error || 'No se pudo eliminar la conversación.')
  }
}

