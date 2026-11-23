// lib/documentGen/descargaPdf.ts
//
// Validación de la URL firmada que recibe POST /api/archivos/descargar
// (descarga real de PDF en Safari iOS: same-origin, donde sí se respeta
// la descarga). La ruta solo puede pedir al servidor PDFs de los buckets
// privados del Chat (documentos generados y hojas de evaluación) del MISMO
// proyecto de Supabase del entorno, con una URL firmada vigente: poseer
// esa URL es la misma autorización que ya tiene hoy el botón. Sin red:
// funciones puras.

export const BUCKET_DESCARGA_PDF = 'documentos-generados-ia'
// Lista cerrada: cualquier otro bucket se rechaza.
export const BUCKETS_DESCARGA_PDF = [BUCKET_DESCARGA_PDF, 'hojas-seguimiento'] as const
export const TAMANO_MAXIMO_DESCARGA_PDF = 4 * 1024 * 1024 // límite de respuesta de una Function de Vercel (4.5 MB), con margen

export type UrlDescargaValida = { ok: true; url: string; nombre: string }
export type UrlDescargaInvalida = { ok: false; motivo: string }

// Nombre seguro para Content-Disposition: sin rutas, comillas, barras
// invertidas ni caracteres de control; termina en .pdf.
export function nombreSeguroPdf(crudo: string): string {
  const base = crudo.split(/[\\/]/).pop() ?? ''
  const limpio = base
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f"\\;]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120)
  const sinExtension = limpio.replace(/\.pdf$/i, '')
  return `${sinExtension || 'documento'}.pdf`
}

// Nombre seguro para un archivo del registro (Word, PDF, PowerPoint,
// Excel): mismas reglas que nombreSeguroPdf, conservando su extensión.
export function nombreSeguroArchivo(crudo: string): string {
  const base = (crudo.split(/[\\/]/).pop() ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f"\\;]/g, '').replace(/^\.+/, '').trim().slice(0, 120)
  return /^.+\.[a-z0-9]{2,5}$/i.test(base) ? base : `${base || 'documento'}`
}

// Content-Disposition con respaldo ASCII y nombre UTF-8 (RFC 6266/5987).
export function contentDispositionAdjunto(nombre: string): string {
  const ascii = nombre.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(nombre)}`
}

// Bucket y ruta de una URL firmada del proyecto de Supabase del entorno, con
// las mismas comprobaciones estrictas de origen y ruta. No exige que la URL
// siga vigente: sirve también para identificar el archivo de una tarjeta
// antigua (sin archivoId), cuya propiedad se verifica después en el registro.
export type RutaUrlFirmada = { ok: true; url: URL; bucket: (typeof BUCKETS_DESCARGA_PDF)[number]; ruta: string; segmentos: string[] }
export function rutaDeUrlFirmada(entrada: unknown, urlSupabase: string | undefined): RutaUrlFirmada | UrlDescargaInvalida {
  if (typeof entrada !== 'string' || entrada.length === 0 || entrada.length > 4096) return { ok: false, motivo: 'url_ausente_o_larga' }
  if (!urlSupabase) return { ok: false, motivo: 'entorno_sin_supabase' }
  // Antes de que el parser normalice la ruta: ningún segmento "." o ".."
  // (tampoco codificado), ni barras invertidas.
  if (/(^|\/)(\.|%2e){1,2}(\/|$)|\\|%5c/i.test(entrada.split(/[?#]/)[0])) return { ok: false, motivo: 'ruta' }
  let base: URL
  let url: URL
  try {
    base = new URL(urlSupabase)
    url = new URL(entrada)
  } catch {
    return { ok: false, motivo: 'url_mal_formada' }
  }
  if (url.protocol !== 'https:' || base.protocol !== 'https:') return { ok: false, motivo: 'protocolo' }
  // Origen EXACTO del proyecto del entorno (mismo host, sin puerto ni
  // credenciales): descarta hosts parecidos y cualquier otro servidor.
  if (url.username || url.password || url.port || url.hostname !== base.hostname || url.origin !== base.origin) return { ok: false, motivo: 'origen' }
  if (url.hash) return { ok: false, motivo: 'fragmento' }
  const bucket = BUCKETS_DESCARGA_PDF.find((b) => url.pathname.startsWith(`/storage/v1/object/sign/${b}/`))
  if (!bucket) return { ok: false, motivo: 'ruta' }
  const prefijo = `/storage/v1/object/sign/${bucket}/`
  let rutaDecodificada: string
  try {
    rutaDecodificada = decodeURIComponent(url.pathname.slice(prefijo.length))
  } catch {
    return { ok: false, motivo: 'ruta_mal_codificada' }
  }
  const segmentos = rutaDecodificada.split('/')
  if (segmentos.length < 2 || segmentos.some((s) => s === '' || s === '.' || s === '..') || /[\\\u0000-\u001f]/.test(rutaDecodificada)) return { ok: false, motivo: 'ruta' }
  return { ok: true, url, bucket, ruta: rutaDecodificada, segmentos }
}

export function validarUrlFirmadaPdf(entrada: unknown, urlSupabase: string | undefined): UrlDescargaValida | UrlDescargaInvalida {
  const r = rutaDeUrlFirmada(entrada, urlSupabase)
  if (!r.ok) return r
  if (!/\.pdf$/i.test(r.ruta)) return { ok: false, motivo: 'no_pdf' }
  if (!r.url.searchParams.get('token')) return { ok: false, motivo: 'sin_token' }
  const nombre = nombreSeguroPdf(r.url.searchParams.get('download') || r.segmentos[r.segmentos.length - 1].replace(/^\d+-/, ''))
  return { ok: true, url: r.url.toString(), nombre }
}
