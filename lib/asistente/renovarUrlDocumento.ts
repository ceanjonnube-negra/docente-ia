// lib/asistente/renovarUrlDocumento.ts
//
// Cliente de POST /api/archivos/renovar-url — compartido por la tarjeta
// de descarga del Chat IA (TarjetaDescarga, AsistentePanel.tsx) y por la
// reutilización de archivos ya generados en la conversión de formatos
// (AsistenteService.ejecutarConversionFormato). Nunca regenera ni copia
// un archivo y nunca llama a un modelo: solo pide una URL firmada nueva
// del MISMO objeto de Storage, identificado por referencias del
// historial (conversación + mensaje + índice, o conversación + formato
// de documento_activo) — jamás manda una URL al servidor.
//
// Las URLs renovadas viven SOLO en memoria (nunca se reescriben en
// mensajes_chat ni en documento_activo), igual que las de imágenes.

import { supabase } from '../supabaseClient'

const BUCKETS_RENOVABLES = ['documentos-generados-ia', 'hojas-seguimiento']
// Se renueva un poco ANTES del vencimiento real, para que el clic de
// Ver/Descargar nunca use una URL que vence en ese mismo instante.
export const MARGEN_RENOVACION_MS = 5 * 60 * 1000
// Tras una falla (archivo eliminado, sin acceso, red) no se vuelve a
// pedir la misma referencia durante este tiempo — nunca reintentos en bucle.
const ESPERA_TRAS_FALLA_MS = 5 * 60 * 1000
const REGEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REGEX_ID_MENSAJE = /^[A-Za-z0-9_-]{1,100}$/

export type ReferenciaDocumentoGuardado =
  | { origen: 'mensaje'; conversacionId: string; mensajeId: string; indice: number }
  | { origen: 'documento_activo'; conversacionId: string; tipo: string }

export type UrlDocumentoRenovada = { url: string; urlVer?: string; expiraEn: number }

// Vencimiento REAL (ms) de una URL firmada de Storage de un documento:
// el `exp` del token de la propia firma. null si no es una URL firmada de
// un bucket de documentos (imágenes, vistas previas, URLs externas…), que
// siguen sus propios mecanismos de siempre.
export function vencimientoUrlDocumento(url: string | undefined): number | null {
  if (!url) return null
  let destino: URL
  try {
    destino = new URL(url)
  } catch {
    return null
  }
  const bucket = destino.pathname.match(/^\/storage\/v1\/object\/sign\/([^/]+)\//)?.[1]
  const token = destino.searchParams.get('token')
  if (!bucket || !BUCKETS_RENOVABLES.includes(bucket) || !token) return null
  try {
    const carga = token.split('.')[1] ?? ''
    const base64 = carga.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(carga.length / 4) * 4, '=')
    const exp = (JSON.parse(atob(base64)) as { exp?: unknown }).exp
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null
  } catch {
    return null
  }
}

export function urlDocumentoPorVencer(url: string | undefined, ahora = Date.now()): boolean {
  const vence = vencimientoUrlDocumento(url)
  return vence !== null && vence - ahora < MARGEN_RENOVACION_MS
}

export function urlDocumentoVencida(url: string | undefined, ahora = Date.now()): boolean {
  const vence = vencimientoUrlDocumento(url)
  return vence !== null && vence <= ahora
}

// Solo referencias YA persistidas: una conversación local (conv-…) o un
// id con otra forma nunca se consulta — no existe en la base de datos.
export function referenciaPersistible(referencia: ReferenciaDocumentoGuardado): boolean {
  if (!REGEX_UUID.test(referencia.conversacionId)) return false
  if (referencia.origen === 'mensaje') return REGEX_ID_MENSAJE.test(referencia.mensajeId) && Number.isInteger(referencia.indice) && referencia.indice >= 0
  return typeof referencia.tipo === 'string' && referencia.tipo.length > 0
}

type EntradaCache = { promesa: Promise<UrlDocumentoRenovada | null>; resultado?: UrlDocumentoRenovada | null; resueltaEn?: number }
const cache = new Map<string, EntradaCache>()

// Una sola petición por referencia: llamadas concurrentes (varias
// tarjetas, renders repetidos) comparten la misma promesa; un resultado
// vigente se reutiliza hasta que esté por vencer; una falla no se
// reintenta durante ESPERA_TRAS_FALLA_MS.
export function renovarUrlDocumento(referencia: ReferenciaDocumentoGuardado): Promise<UrlDocumentoRenovada | null> {
  if (!referenciaPersistible(referencia)) return Promise.resolve(null)
  const clave = JSON.stringify(referencia)
  const existente = cache.get(clave)
  const ahora = Date.now()
  if (existente) {
    if (existente.resueltaEn === undefined) return existente.promesa
    if (existente.resultado && existente.resultado.expiraEn - ahora > MARGEN_RENOVACION_MS) return existente.promesa
    if (!existente.resultado && ahora - existente.resueltaEn < ESPERA_TRAS_FALLA_MS) return existente.promesa
  }
  const entrada: EntradaCache = { promesa: Promise.resolve(null) }
  entrada.promesa = pedirRenovacion(referencia).then((resultado) => {
    entrada.resultado = resultado
    entrada.resueltaEn = Date.now()
    return resultado
  })
  cache.set(clave, entrada)
  return entrada.promesa
}

async function pedirRenovacion(referencia: ReferenciaDocumentoGuardado): Promise<UrlDocumentoRenovada | null> {
  try {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) return null
    const res = await fetch('/api/archivos/renovar-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(referencia),
    })
    if (!res.ok) return null
    const cuerpo = (await res.json()) as { url?: unknown; urlVer?: unknown; expiraEn?: unknown }
    const expiraEn = typeof cuerpo.expiraEn === 'string' ? Date.parse(cuerpo.expiraEn) : NaN
    // Solo se acepta una URL firmada de un bucket de documentos — nunca
    // cualquier cosa que venga en la respuesta.
    if (typeof cuerpo.url !== 'string' || vencimientoUrlDocumento(cuerpo.url) === null || !Number.isFinite(expiraEn)) return null
    const urlVer = typeof cuerpo.urlVer === 'string' && vencimientoUrlDocumento(cuerpo.urlVer) !== null ? cuerpo.urlVer : undefined
    return { url: cuerpo.url, ...(urlVer ? { urlVer } : {}), expiraEn }
  } catch {
    return null
  }
}
