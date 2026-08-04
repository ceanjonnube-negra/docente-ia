// lib/documentGen/almacenamiento.ts
//
// Sube un archivo generado por el servidor (Word/PDF/PowerPoint/Excel) a
// un bucket de Supabase Storage DEDICADO a documentos generados por el
// Chat IA — separado de "documentos-institucionales" (que es para lo que
// el docente SUBE, no lo que la IA genera) para no mezclar ambos usos.
// Por el mismo criterio, las hojas de Seguimiento (formularios
// capturables, no documentos exportables) viven en su propio bucket —
// ver BUCKET_HOJAS_SEGUIMIENTO.
//
// Los buckets se crean de forma perezosa e idempotente la primera vez
// que se necesitan — no hay forma de correr una migración SQL desde este
// proyecto, así que en vez de asumir que el bucket ya existe, el propio
// código lo asegura antes de subir.
//
// Privado, nunca público: estos documentos pueden traer datos reales de
// alumnos y de la escuela — la descarga siempre es por URL firmada con
// vencimiento, nunca por URL pública permanente.

import type { SupabaseClient } from '@supabase/supabase-js'

export const BUCKET_DOCUMENTOS_GENERADOS = 'documentos-generados-ia'
export const BUCKET_HOJAS_SEGUIMIENTO = 'hojas-seguimiento'

const VENCIMIENTO_URL_SEGUNDOS = 60 * 60 * 24 * 7 // 7 días — tiempo de sobra para que el maestro lo descargue y lo reintente si hace falta

const bucketsAsegurados = new Set<string>()

async function asegurarBucket(sb: SupabaseClient, bucket: string) {
  if (bucketsAsegurados.has(bucket)) return
  const { data: existente } = await sb.storage.getBucket(bucket)
  if (!existente) {
    const { error } = await sb.storage.createBucket(bucket, { public: false })
    // Si otro request lo creó al mismo tiempo, createBucket puede
    // devolver un error de "ya existe" — no es una falla real.
    if (error && !/already exists|ya existe/i.test(error.message)) throw error
  }
  bucketsAsegurados.add(bucket)
}

export type TipoArchivoGenerado = 'word' | 'pdf' | 'powerpoint' | 'excel'

export type ArchivoGenerado = {
  tipo: TipoArchivoGenerado
  nombre: string
  url: string
  // Tamaño real del archivo en bytes — opcional porque subirArchivoGenerado
  // (usado por el flujo de reintento/subida directa) no siempre lo tiene
  // a mano; ejecutarHerramientaDocumento en herramientas.ts sí lo calcula
  // gratis (ya mide buffer.length para verificar la firma binaria) y lo
  // incluye siempre. La tarjeta universal del Chat IA lo muestra si viene.
  tamanoBytes?: number
}

export function rutaArchivo(userId: string, nombreArchivo: string): string {
  return `${userId}/${Date.now()}-${nombreArchivo}`
}

// Etapa "subida" aislada — quien llama (ver herramientas.ts) mide su
// propio tiempo y le atribuye un código de error específico si falla,
// sin confundirla con la etapa de obtener la URL firmada. `bucket` es
// opcional (default BUCKET_DOCUMENTOS_GENERADOS) para no romper a los
// llamadores existentes, que nunca necesitaron otro bucket hasta ahora.
export async function subirBuffer(sb: SupabaseClient, ruta: string, buffer: Buffer, contentType: string, bucket: string = BUCKET_DOCUMENTOS_GENERADOS): Promise<void> {
  await asegurarBucket(sb, bucket)
  const { error } = await sb.storage.from(bucket).upload(ruta, buffer, { contentType, upsert: false })
  if (error) throw new Error(`Error subiendo archivo a Storage: ${error.message}`)
}

// Etapa "URL firmada" aislada — nunca pública ni permanente (ver arriba).
// `nombreDescarga` fuerza Content-Disposition: attachment con ese nombre
// de archivo — sin esto, Safari/Chrome en el celular a veces solo abren
// una pestaña en blanco con un .docx en vez de descargarlo o abrirlo con
// Word/Office, porque el navegador intenta renderizarlo inline.
export async function crearUrlFirmada(sb: SupabaseClient, ruta: string, nombreDescarga?: string, bucket: string = BUCKET_DOCUMENTOS_GENERADOS): Promise<string> {
  const { data, error } = await sb.storage
    .from(bucket)
    .createSignedUrl(ruta, VENCIMIENTO_URL_SEGUNDOS, nombreDescarga ? { download: nombreDescarga } : undefined)
  if (error || !data?.signedUrl) throw new Error(`Error generando URL de descarga: ${error?.message || 'sin URL'}`)
  return data.signedUrl
}

// Elimina un archivo de Storage. A diferencia de subirBuffer, NUNCA
// lanza: quien llama decide si un archivo ya ausente es aceptable (ver
// DELETE /api/proyectos-seguimiento/[id]) o debe tratarse como falla —
// Storage no distingue de forma consistente "no existía" de "no se
// pudo verificar", así que se regresa el mensaje crudo del error (o
// null si no hubo ninguno) en vez de una decisión ya tomada aquí.
export async function eliminarArchivo(sb: SupabaseClient, ruta: string, bucket: string = BUCKET_DOCUMENTOS_GENERADOS): Promise<string | null> {
  const { error } = await sb.storage.from(bucket).remove([ruta])
  return error ? error.message : null
}

// Sube el buffer ya generado y regresa una URL firmada de descarga. Nunca
// lanza silenciosamente — cualquier falla aquí se propaga para que quien
// llama pueda reportar "no fue posible generar el documento" con
// honestidad, en vez de fingir éxito. Wrapper simple sobre subirBuffer +
// crearUrlFirmada para quien no necesita medir cada etapa por separado.
export async function subirArchivoGenerado(
  sb: SupabaseClient,
  userId: string,
  tipo: TipoArchivoGenerado,
  nombreArchivo: string,
  buffer: Buffer,
  contentType: string,
  bucket: string = BUCKET_DOCUMENTOS_GENERADOS
): Promise<ArchivoGenerado> {
  const ruta = rutaArchivo(userId, nombreArchivo)
  await subirBuffer(sb, ruta, buffer, contentType, bucket)
  const url = await crearUrlFirmada(sb, ruta, nombreArchivo, bucket)
  return { tipo, nombre: nombreArchivo, url, tamanoBytes: buffer.length }
}
