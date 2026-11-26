// lib/documentGen/registroArchivos.ts
//
// Registro de archivos generados (etapa 3B-2A, tabla archivos_generados).
// Solo servidor: escribe con la llave de servicio, sea cual sea el
// cliente con el que se suba el archivo (el Chat sube con service role,
// la aprobación de planeaciones con el cliente del docente). El cliente
// del navegador no tiene ningún permiso sobre estas tablas.
//
// Ciclo: registrarArchivo ('subiendo', ANTES de subir) → subida y
// verificación → confirmarArchivo ('activo'). Un archivo solo se entrega
// confirmado; si algo falla después de registrar, marcarArchivoFallido
// ('fallido' = nunca entregado). Nada aquí borra archivos ni registros.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { BUCKET_DOCUMENTOS_GENERADOS, crearUrlFirmada, descargarBuffer } from './almacenamiento'
import { TAMANO_MAXIMO_DESCARGA_PDF } from './descargaPdf'

export type ClaseArchivo = 'conservar' | 'efimero'
// Señal estructurada que un llamador puede pasar a ejecutarHerramientaDocumento.
export type RegistroArchivoSolicitado = { clase: ClaseArchivo; conversacionId?: string | null }
// Identidad de la ejecución que produce el Word/PDF de una versión de
// planeación (reserva de planeacion_version_archivos). Se escribe en el
// registro inicial y la base la valida al ligar el archivo a la versión.
export type OrigenVersion = { versionId: string; formato: 'word' | 'pdf'; ejecucionId: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Clasificación: 'conservar' siempre, salvo que un llamador pase una
// señal ESTRUCTURADA y verificable de que el archivo es temporal y
// exclusivo de una conversación ({ clase: 'efimero', conversacionId }).
// Nunca se deduce del texto del documento. Hoy ningún flujo la envía, así
// que todos los archivos se registran como 'conservar'. Si llega, la base
// además exige que la conversación sea del mismo docente (FK compuesta);
// si no lo es, se registra como 'conservar'.
export function clasificarArchivo(registro?: RegistroArchivoSolicitado): { clase: ClaseArchivo; conversacionId: string | null } {
  if (registro?.clase === 'efimero' && registro.conversacionId && UUID.test(registro.conversacionId)) {
    return { clase: 'efimero', conversacionId: registro.conversacionId.toLowerCase() }
  }
  return { clase: 'conservar', conversacionId: null }
}

let clienteRegistro: SupabaseClient | null = null

// Cliente del servidor (service role) del registro de archivos: el mismo
// que reserva y liga los Word/PDF de una versión (archivosVersion.ts).
export function clienteServidorArchivos(): SupabaseClient {
  return cliente()
}

function cliente(): SupabaseClient {
  if (!clienteRegistro) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const llave = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !llave) throw new Error('Falta la configuración del servidor para registrar archivos.')
    clienteRegistro = createClient(url, llave, { auth: { persistSession: false, autoRefreshToken: false } })
  }
  return clienteRegistro
}

// Solo para pruebas: sustituye el cliente del registro.
export function configurarClienteRegistroArchivos(sustituto: SupabaseClient | null) {
  clienteRegistro = sustituto
}

type ErrorBD = { code?: string; message?: string } | null

function mensajeDe(error: unknown): string {
  return error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : String(error)
}

// Reintentos cortos para fallos transitorios de la base (nunca regeneran
// el archivo ni llaman a la IA).
async function conReintentos<T>(fn: () => Promise<T>, intentos = 3, esperaMs = 200): Promise<T> {
  let ultimo: unknown
  for (let i = 0; i < intentos; i++) {
    try {
      return await fn()
    } catch (e) {
      ultimo = e
      if (i < intentos - 1) await new Promise((r) => setTimeout(r, esperaMs * (i + 1)))
    }
  }
  throw ultimo
}

export async function registrarArchivo(datos: {
  docenteId: string
  ruta: string
  nombre: string
  tipoMime: string
  tamanoBytes: number
  clase: ClaseArchivo
  conversacionId: string | null
  origenVersion?: OrigenVersion
}): Promise<{ id: string; clase: ClaseArchivo }> {
  const origen = datos.origenVersion
  if (origen && (!UUID.test(origen.versionId) || !UUID.test(origen.ejecucionId) || (origen.formato !== 'word' && origen.formato !== 'pdf'))) {
    throw new Error('Origen de versión inválido')
  }
  // Id generado aquí: si una respuesta se pierde y se reintenta, el
  // mismo id choca (23505) y se reconoce el registro ya hecho.
  const id = crypto.randomUUID()
  let { clase, conversacionId } = datos
  return conReintentos(async () => {
    const fila = {
      id,
      docente_id: datos.docenteId,
      bucket: BUCKET_DOCUMENTOS_GENERADOS,
      ruta: datos.ruta,
      nombre: datos.nombre,
      tipo_mime: datos.tipoMime,
      tamano_bytes: datos.tamanoBytes,
      clase,
      conversacion_id: conversacionId,
      // Solo los archivos de una versión llevan origen; los demás, sin cambio.
      ...(origen ? { version_id: origen.versionId, version_formato: origen.formato, version_ejecucion_id: origen.ejecucionId } : {}),
    }
    const { error } = (await cliente().from('archivos_generados').insert(fila)) as { error: ErrorBD }
    if (!error) return { id, clase }
    if (error.code === '23505') {
      const { data } = await cliente().from('archivos_generados').select('id, clase').eq('id', id).maybeSingle()
      if (data) return { id, clase: data.clase as ClaseArchivo }
    }
    if (error.code === '23503' && clase === 'efimero') {
      // La conversación no es de este docente (o no existe): se conserva.
      console.error('[REGISTRO_ARCHIVOS] conversación no válida — se registra como conservar')
      clase = 'conservar'
      conversacionId = null
    }
    throw error
  })
}

export async function confirmarArchivo(id: string): Promise<void> {
  await conReintentos(async () => {
    const { data, error } = (await cliente()
      .from('archivos_generados')
      .update({ estado: 'activo', activado_en: new Date().toISOString() })
      .eq('id', id)
      .eq('estado', 'subiendo')
      .select('id')) as { data: { id: string }[] | null; error: ErrorBD }
    if (error) throw error
    if (data && data.length > 0) return
    // 0 filas: quizá una confirmación anterior sí llegó (respuesta perdida).
    const { data: actual, error: errorLectura } = (await cliente().from('archivos_generados').select('estado').eq('id', id).maybeSingle()) as { data: { estado: string } | null; error: ErrorBD }
    if (errorLectura) throw errorLectura
    if (actual?.estado === 'activo') return
    throw new Error(`El registro del archivo no se pudo confirmar (estado=${actual?.estado ?? 'inexistente'}).`)
  })
}

// Mejor esfuerzo: nunca lanza (el error original es el que importa).
export async function marcarArchivoFallido(id: string, causa: unknown): Promise<void> {
  try {
    await conReintentos(async () => {
      const { error } = (await cliente()
        .from('archivos_generados')
        .update({ estado: 'fallido', ultimo_error: mensajeDe(causa).slice(0, 500) })
        .eq('id', id)
        .eq('estado', 'subiendo')) as { error: ErrorBD }
      if (error) throw error
    }, 2)
  } catch (e) {
    console.error('[REGISTRO_ARCHIVOS] no se pudo marcar como fallido (queda en subiendo):', mensajeDe(e))
  }
}

// Archivo YA confirmado que nunca llegó a entregarse (p. ej. lo generó una
// aprobación de planeación que perdió su concesión antes de consolidarlo):
// 'fallido' = nunca entregado (activado_en vuelve a null: la tabla exige
// estado 'activo' ⇔ activado_en). Queda auditado y recuperarArchivoPropio
// no lo entrega jamás. Mejor esfuerzo: nunca lanza.
export async function marcarArchivoNoEntregado(id: string, causa: string): Promise<void> {
  try {
    await conReintentos(async () => {
      const { error } = (await cliente()
        .from('archivos_generados')
        .update({ estado: 'fallido', activado_en: null, ultimo_error: causa.slice(0, 500) })
        .eq('id', id)
        .eq('estado', 'activo')) as { error: ErrorBD }
      if (error) throw error
    }, 2)
  } catch (e) {
    console.error('[REGISTRO_ARCHIVOS] no se pudo marcar como no entregado:', mensajeDe(e))
  }
}

// --- Recuperar un archivo propio (tarjetas del Chat con el enlace vencido) ---
// Solo LECTURA: no genera archivos, no escribe registros ni llama a la IA.
// La fuente de verdad es archivos_generados: el archivo se entrega solo si
// su registro existe, es del docente autenticado, está 'activo', vive en el
// bucket de documentos generados y bajo la carpeta del propio docente.
// Referencias aceptadas:
// - { archivoId }: tarjetas nuevas (etapa 3B-2A).
// - { bucket, ruta }: tarjetas antiguas, sacadas de su URL firmada
//   persistida; igual exigen un registro propio. Un archivo sin registro no
//   puede verificarse y NO se recupera.
// Las respuestas no distinguen "no existe" de "es de otro docente".
export type ReferenciaArchivo = { archivoId: string } | { bucket: string; ruta: string }
export type ArchivoRecuperado =
  | { ok: true; nombre: string; tipoMime: string; contenido: Buffer }
  | { ok: false; estado: 404 | 410 | 413 | 502; mensaje: string; motivo: string }

const NO_ENCONTRADO = 'No encontré ese archivo entre tus documentos. Pídelo de nuevo en el Chat.'

export async function recuperarArchivoPropio(docenteId: string, referencia: ReferenciaArchivo): Promise<ArchivoRecuperado> {
  const noEncontrado = (motivo: string): ArchivoRecuperado => ({ ok: false, estado: 404, mensaje: NO_ENCONTRADO, motivo })
  if (!UUID.test(docenteId)) return noEncontrado('docente')
  let consulta = cliente().from('archivos_generados')
    .select('docente_id, bucket, ruta, nombre, tipo_mime, estado, tamano_bytes')
    .eq('docente_id', docenteId)
  if ('archivoId' in referencia) {
    if (!UUID.test(referencia.archivoId)) return noEncontrado('archivo_id')
    consulta = consulta.eq('id', referencia.archivoId)
  } else {
    if (referencia.bucket !== BUCKET_DOCUMENTOS_GENERADOS) return noEncontrado('bucket')
    consulta = consulta.eq('bucket', referencia.bucket).eq('ruta', referencia.ruta)
  }
  const { data, error } = (await consulta.maybeSingle()) as {
    data: { docente_id: string; bucket: string; ruta: string; nombre: string; tipo_mime: string; estado: string; tamano_bytes: number } | null
    error: ErrorBD
  }
  if (error) return { ok: false, estado: 502, mensaje: 'No se pudo consultar el archivo. Intenta de nuevo.', motivo: 'consulta' }
  // Comprobaciones explícitas además del filtro de la consulta.
  if (!data || data.docente_id !== docenteId) return noEncontrado('sin_registro_propio')
  if (data.bucket !== BUCKET_DOCUMENTOS_GENERADOS || !data.ruta.startsWith(`${docenteId}/`) || data.ruta.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    return noEncontrado('ubicacion')
  }
  if (data.estado !== 'activo') return noEncontrado('estado')
  if (data.tamano_bytes > TAMANO_MAXIMO_DESCARGA_PDF) {
    return { ok: false, estado: 413, mensaje: 'El archivo es demasiado grande para abrirlo desde aquí. Pídelo de nuevo en el Chat.', motivo: 'tamano' }
  }
  let contenido: Buffer
  try {
    contenido = await descargarBuffer(cliente(), data.ruta, data.bucket)
  } catch {
    return { ok: false, estado: 410, mensaje: 'El archivo ya no está disponible. Pídelo de nuevo en el Chat.', motivo: 'sin_objeto' }
  }
  if (contenido.byteLength > TAMANO_MAXIMO_DESCARGA_PDF) {
    return { ok: false, estado: 413, mensaje: 'El archivo es demasiado grande para abrirlo desde aquí. Pídelo de nuevo en el Chat.', motivo: 'tamano' }
  }
  return { ok: true, nombre: data.nombre, tipoMime: data.tipo_mime, contenido }
}

// --- Enlaces firmados de un archivo ORIGINAL propio (consulta de
// planeaciones guardadas, Hito 2): mismas comprobaciones que
// recuperarArchivoPropio — registro del docente, 'activo', en el bucket y
// la carpeta del docente — sin descargarlo ni regenerarlo. null si no se
// puede entregar.
// Enlaces NUEVOS (firmados en el momento: un enlace vencido nunca se
// entrega) del original de un archivo propio, distinguiendo:
// - 'inexistente': sin registro propio activo o sin el objeto en Storage
//   (el archivo realmente ya no está; nunca se sustituye en silencio);
// - 'error': falla pasajera al consultar o firmar (se puede reintentar).
export type EnlacesArchivo =
  | { estado: 'ok'; nombre: string; url: string; urlVer: string }
  | { estado: 'inexistente' }
  | { estado: 'error' }
export async function estadoEnlacesArchivo(docenteId: string, archivoId: string): Promise<EnlacesArchivo> {
  if (!UUID.test(docenteId) || !UUID.test(archivoId)) return { estado: 'inexistente' }
  let fila: { docente_id: string; bucket: string; ruta: string; nombre: string; estado: string } | null
  try {
    const { data, error } = (await cliente()
      .from('archivos_generados')
      .select('docente_id, bucket, ruta, nombre, estado')
      .eq('id', archivoId)
      .eq('docente_id', docenteId)
      .maybeSingle()) as { data: typeof fila; error: ErrorBD }
    if (error) return { estado: 'error' }
    fila = data
  } catch {
    return { estado: 'error' }
  }
  if (!fila || fila.docente_id !== docenteId || fila.estado !== 'activo' || fila.bucket !== BUCKET_DOCUMENTOS_GENERADOS) return { estado: 'inexistente' }
  if (!fila.ruta.startsWith(`${docenteId}/`) || fila.ruta.split('/').some((s) => s === '' || s === '.' || s === '..')) return { estado: 'inexistente' }
  try {
    const url = await crearUrlFirmada(cliente(), fila.ruta, fila.nombre, fila.bucket)
    const urlVer = await crearUrlFirmada(cliente(), fila.ruta, undefined, fila.bucket)
    return { estado: 'ok', nombre: fila.nombre, url, urlVer }
  } catch (e) {
    // Storage responde "not found" cuando el objeto ya no existe.
    if (/not[ _]?found|does not exist|no existe/i.test(mensajeDe(e))) return { estado: 'inexistente' }
    console.error('[REGISTRO_ARCHIVOS] no se pudieron firmar los enlaces del original:', mensajeDe(e))
    return { estado: 'error' }
  }
}

export async function enlacesArchivoPropio(docenteId: string, archivoId: string): Promise<{ nombre: string; url: string; urlVer: string } | null> {
  const r = await estadoEnlacesArchivo(docenteId, archivoId)
  return r.estado === 'ok' ? { nombre: r.nombre, url: r.url, urlVer: r.urlVer } : null
}
