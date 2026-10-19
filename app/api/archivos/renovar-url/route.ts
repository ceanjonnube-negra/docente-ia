// app/api/archivos/renovar-url/route.ts
//
// Renovación de URLs firmadas de documentos YA generados (Word/PDF/
// PowerPoint/Excel del Chat IA, documentos definitivos de planeación y
// hojas de evaluación) cuando la URL guardada en el historial venció.
// Nunca regenera ni copia el archivo, nunca llama a un modelo de IA: solo
// vuelve a firmar el MISMO objeto de Storage.
//
// La referencia SIEMPRE sale de la base de datos, nunca del cliente: el
// cliente solo manda identificadores (conversación + mensaje + índice, o
// conversación + formato de la caché documento_activo). Tres capas
// independientes de autorización, todas con el cliente AUTENTICADO del
// docente (nunca service_role):
// 1. RLS de mensajes_chat / conversaciones_chat (docente_id = auth.uid()).
// 2. La ruta guardada debe empezar por el id del docente de la sesión.
// 3. RLS de Storage al verificar (info) y al firmar (foldername[1] = auth.uid()).
// El token de la URL vencida NUNCA se usa como prueba de nada: solo se
// toma la ruta del objeto.
//
// Respuesta: { url, urlVer?, expiraEn } con vigencia de 1 hora, siempre
// Cache-Control: no-store. Los logs nunca registran URLs, firmas, rutas
// ni nombres de archivo.

import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { autenticarRequestApi, extraerBearerToken } from '@/lib/server/authApi'
import { crearUrlFirmada, BUCKET_DOCUMENTOS_GENERADOS, BUCKET_HOJAS_SEGUIMIENTO } from '@/lib/documentGen/almacenamiento'
import { errorSeguro } from '@/lib/logSeguro'

export const runtime = 'nodejs'

const VIGENCIA_RENOVADA_SEGUNDOS = 60 * 60
const BUCKETS_RENOVABLES = new Set([BUCKET_DOCUMENTOS_GENERADOS, BUCKET_HOJAS_SEGUIMIENTO])
const PREFIJO_FIRMA = '/storage/v1/object/sign/'
const REGEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// mensajes_chat.id es el id del propio cliente (msg-<ms>-<n>), texto.
const REGEX_ID_MENSAJE = /^[A-Za-z0-9_-]{1,100}$/
const TIPOS_DOCUMENTO = new Set(['word', 'pdf', 'powerpoint', 'excel'])
const MAX_ARCHIVOS_POR_MENSAJE = 20

const SIN_CACHE = { 'Cache-Control': 'no-store' }
const responder = (cuerpo: Record<string, unknown>, status = 200) => NextResponse.json(cuerpo, { status, headers: SIN_CACHE })
const NO_DISPONIBLE = () => responder({ error: 'Este documento ya no está disponible.' }, 404)

type ArchivoGuardado = { tipo?: unknown; nombre?: unknown; url?: unknown }

// Ruta permanente del objeto a partir de la URL firmada GUARDADA (nunca
// de una URL del cliente): mismo origen que el proyecto de Supabase,
// prefijo exacto de URL firmada, bucket permitido, y cada segmento
// decodificado UNA sola vez — cualquier codificación doble/ambigua,
// segmento vacío, '.', '..', barra, contrabarra o carácter de control se
// rechaza.
function referenciaStorage(url: unknown): { bucket: string; segmentos: string[] } | null {
  if (typeof url !== 'string' || url.length > 4096) return null
  const configurada = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!configurada) return null
  let destino: URL
  let origenEsperado: string
  try {
    destino = new URL(url)
    origenEsperado = new URL(configurada).origin
  } catch {
    return null
  }
  if (destino.origin !== origenEsperado || !destino.pathname.startsWith(PREFIJO_FIRMA)) return null
  const [bucket, ...crudos] = destino.pathname.slice(PREFIJO_FIRMA.length).split('/')
  if (!BUCKETS_RENOVABLES.has(bucket) || crudos.length < 2) return null
  const segmentos: string[] = []
  for (const crudo of crudos) {
    let segmento: string
    try {
      segmento = decodeURIComponent(crudo)
    } catch {
      return null
    }
    if (!segmento || segmento === '.' || segmento === '..' || /[/\\%\x00-\x1f\x7f]/.test(segmento) || segmento.length > 255) return null
    segmentos.push(segmento)
  }
  return { bucket, segmentos }
}

async function leerArchivoDeMensaje(sb: SupabaseClient, conversacionId: string, mensajeId: string, indice: number): Promise<ArchivoGuardado | null> {
  const { data, error } = await sb
    .from('mensajes_chat')
    .select('contenido')
    .eq('id', mensajeId)
    .eq('conversacion_id', conversacionId)
    .maybeSingle()
  if (error) throw error
  const contenido = (data?.contenido ?? null) as { archivo?: ArchivoGuardado; archivos?: ArchivoGuardado[] } | null
  if (!contenido) return null
  // Mismo criterio que el render del Chat IA: `archivos` si existe, si no `archivo`.
  const lista = Array.isArray(contenido.archivos) && contenido.archivos.length > 0 ? contenido.archivos : contenido.archivo ? [contenido.archivo] : []
  return lista.length <= MAX_ARCHIVOS_POR_MENSAJE ? lista[indice] ?? null : null
}

async function leerArchivoDeDocumentoActivo(sb: SupabaseClient, conversacionId: string, tipo: string): Promise<ArchivoGuardado | null> {
  const { data, error } = await sb
    .from('conversaciones_chat')
    .select('documento_activo')
    .eq('id', conversacionId)
    .maybeSingle()
  if (error) throw error
  const documentoActivo = (data?.documento_activo ?? null) as { archivosGenerados?: Record<string, ArchivoGuardado> } | null
  const archivo = documentoActivo?.archivosGenerados?.[tipo]
  return archivo && typeof archivo === 'object' ? archivo : null
}

export async function POST(req: NextRequest) {
  let origen = 'desconocido'
  try {
    const auth = await autenticarRequestApi(extraerBearerToken(req))
    if (!auth.ok) return responder({ error: auth.mensaje }, auth.status)

    let cuerpo: Record<string, unknown>
    try {
      cuerpo = (await req.json()) as Record<string, unknown>
    } catch {
      return responder({ error: 'Solicitud inválida.' }, 400)
    }
    if (!cuerpo || typeof cuerpo !== 'object') return responder({ error: 'Solicitud inválida.' }, 400)
    const { conversacionId } = cuerpo
    if (typeof conversacionId !== 'string' || !REGEX_UUID.test(conversacionId)) return responder({ error: 'Solicitud inválida.' }, 400)

    let archivo: ArchivoGuardado | null
    if (cuerpo.origen === 'mensaje') {
      origen = 'mensaje'
      const { mensajeId, indice } = cuerpo
      if (typeof mensajeId !== 'string' || !REGEX_ID_MENSAJE.test(mensajeId) || typeof indice !== 'number' || !Number.isInteger(indice) || indice < 0 || indice >= MAX_ARCHIVOS_POR_MENSAJE) {
        return responder({ error: 'Solicitud inválida.' }, 400)
      }
      archivo = await leerArchivoDeMensaje(auth.supabase, conversacionId, mensajeId, indice)
    } else if (cuerpo.origen === 'documento_activo') {
      origen = 'documento_activo'
      const { tipo } = cuerpo
      if (typeof tipo !== 'string' || !TIPOS_DOCUMENTO.has(tipo)) return responder({ error: 'Solicitud inválida.' }, 400)
      archivo = await leerArchivoDeDocumentoActivo(auth.supabase, conversacionId, tipo)
    } else {
      return responder({ error: 'Solicitud inválida.' }, 400)
    }

    // Mensaje/conversación inexistente, ajeno (RLS) o sin ese archivo: la
    // misma respuesta, sin distinguir — nunca revela qué existe de otro docente.
    if (!archivo || typeof archivo.tipo !== 'string' || !TIPOS_DOCUMENTO.has(archivo.tipo)) return NO_DISPONIBLE()
    const referencia = referenciaStorage(archivo.url)
    if (!referencia || referencia.segmentos[0] !== auth.user.id) return NO_DISPONIBLE()
    const ruta = referencia.segmentos.join('/')

    // Acceso al objeto verificado ANTES de firmar, con la RLS de Storage
    // del propio docente: si el archivo se eliminó o no es suyo, no se
    // emite ninguna URL.
    const { data: informacion, error: errorInformacion } = await auth.supabase.storage.from(referencia.bucket).info(ruta)
    if (errorInformacion || !informacion) {
      console.log(`[RENOVAR_URL] origen=${origen} resultado=no_disponible`)
      return NO_DISPONIBLE()
    }

    const nombreDescarga = typeof archivo.nombre === 'string' && archivo.nombre.trim() && archivo.nombre.length <= 200 ? archivo.nombre : referencia.segmentos[referencia.segmentos.length - 1]
    const url = await crearUrlFirmada(auth.supabase, ruta, nombreDescarga, referencia.bucket, VIGENCIA_RENOVADA_SEGUNDOS)
    const urlVer = archivo.tipo === 'pdf' ? await crearUrlFirmada(auth.supabase, ruta, undefined, referencia.bucket, VIGENCIA_RENOVADA_SEGUNDOS) : undefined
    const expiraEn = new Date(Date.now() + VIGENCIA_RENOVADA_SEGUNDOS * 1000).toISOString()
    console.log(`[RENOVAR_URL] origen=${origen} resultado=renovada tipo=${archivo.tipo}`)
    return responder({ url, ...(urlVer ? { urlVer } : {}), expiraEn })
  } catch (e) {
    console.error(`[RENOVAR_URL] origen=${origen} fallo: ${errorSeguro(e)}`)
    return responder({ error: 'No fue posible recuperar el documento en este momento.' }, 500)
  }
}
