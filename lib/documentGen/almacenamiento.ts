// lib/documentGen/almacenamiento.ts
//
// Sube un archivo generado por el servidor (Word/PDF/PowerPoint/Excel) a
// un bucket de Supabase Storage DEDICADO a documentos generados por el
// Chat IA — separado de "documentos-institucionales" (que es para lo que
// el docente SUBE, no lo que la IA genera) para no mezclar ambos usos.
//
// El bucket se crea de forma perezosa e idempotente la primera vez que
// se necesita — no hay forma de correr una migración SQL desde este
// proyecto, así que en vez de asumir que el bucket ya existe, el propio
// código lo asegura antes de subir.
//
// Privado, nunca público: estos documentos pueden traer datos reales de
// alumnos y de la escuela — la descarga siempre es por URL firmada con
// vencimiento, nunca por URL pública permanente.

import type { SupabaseClient } from '@supabase/supabase-js'

const BUCKET = 'documentos-generados-ia'
const VENCIMIENTO_URL_SEGUNDOS = 60 * 60 * 24 * 7 // 7 días — tiempo de sobra para que el maestro lo descargue y lo reintente si hace falta

let bucketAsegurado = false

async function asegurarBucket(sb: SupabaseClient) {
  if (bucketAsegurado) return
  const { data: existente } = await sb.storage.getBucket(BUCKET)
  if (!existente) {
    const { error } = await sb.storage.createBucket(BUCKET, { public: false })
    // Si otro request lo creó al mismo tiempo, createBucket puede
    // devolver un error de "ya existe" — no es una falla real.
    if (error && !/already exists|ya existe/i.test(error.message)) throw error
  }
  bucketAsegurado = true
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
// sin confundirla con la etapa de obtener la URL firmada.
export async function subirBuffer(sb: SupabaseClient, ruta: string, buffer: Buffer, contentType: string): Promise<void> {
  await asegurarBucket(sb)
  const { error } = await sb.storage.from(BUCKET).upload(ruta, buffer, { contentType, upsert: false })
  if (error) throw new Error(`Error subiendo archivo a Storage: ${error.message}`)
}

// Etapa "URL firmada" aislada — nunca pública ni permanente (ver arriba).
// `nombreDescarga` fuerza Content-Disposition: attachment con ese nombre
// de archivo — sin esto, Safari/Chrome en el celular a veces solo abren
// una pestaña en blanco con un .docx en vez de descargarlo o abrirlo con
// Word/Office, porque el navegador intenta renderizarlo inline.
export async function crearUrlFirmada(sb: SupabaseClient, ruta: string, nombreDescarga?: string): Promise<string> {
  const { data, error } = await sb.storage
    .from(BUCKET)
    .createSignedUrl(ruta, VENCIMIENTO_URL_SEGUNDOS, nombreDescarga ? { download: nombreDescarga } : undefined)
  if (error || !data?.signedUrl) throw new Error(`Error generando URL de descarga: ${error?.message || 'sin URL'}`)
  return data.signedUrl
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
  contentType: string
): Promise<ArchivoGenerado> {
  const ruta = rutaArchivo(userId, nombreArchivo)
  await subirBuffer(sb, ruta, buffer, contentType)
  const url = await crearUrlFirmada(sb, ruta, nombreArchivo)
  return { tipo, nombre: nombreArchivo, url, tamanoBytes: buffer.length }
}
