// app/api/archivos/descargar/route.ts
//
// Proxy same-origin de descarga (CORRECCIÓN — "Descargar PDF abre vista
// previa en Safari/iPhone"): la URL firmada de Storage ya responde con
// Content-Disposition: attachment (verificado con un HEAD real), pero
// Safari, para una navegación directa a application/pdf, prioriza su
// visor nativo sobre ese encabezado — comportamiento propio de WebKit,
// no algo que un truco más de <a download> pueda resolver (el atributo
// download tampoco es confiable cross-origin en Safari). Esta ruta
// vuelve a servir el archivo desde el MISMO origin de la app, con
// Content-Type: application/octet-stream — un MIME que Safari no sabe
// previsualizar — así que la navegación resultante siempre se trata
// como "hay que guardar esto". Solo usada por PDF (ver
// descargarArchivoDirecto en AsistentePanel.tsx); Word/PowerPoint/Excel
// no la necesitan porque Safari no tiene visor nativo para esos
// formatos y ya descargan correctamente con la URL firmada directa.
//
// POST únicamente (no GET): la URL firmada lleva un token de firma
// temporal — no queremos que termine en el historial del navegador, en
// la URL visible, ni en logs de request de acceso.
//
// Nunca usa el service role: la URL que recibe ya viene firmada por
// Supabase (creada del lado del servidor de /api/chat con el mismo
// criterio de siempre) — es autosuficiente para leer el archivo.

import { NextRequest, NextResponse } from 'next/server'
import { BUCKET_DOCUMENTOS_GENERADOS } from '@/lib/documentGen/almacenamiento'

// Solo se acepta una URL https, del mismo proyecto de Supabase ya
// configurado (NEXT_PUBLIC_SUPABASE_URL, sin variable de entorno
// nueva), y con el path exacto de una URL firmada de Storage sobre el
// bucket real de documentos generados — cualquier otra cosa se
// rechaza antes de hacer ningún fetch, para no abrir un proxy SSRF.
function validarUrlAutorizada(candidata: string): URL | null {
  let url: URL
  try {
    url = new URL(candidata)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null

  const supabaseUrlConfigurada = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!supabaseUrlConfigurada) return null
  let hostSupabase: string
  try {
    hostSupabase = new URL(supabaseUrlConfigurada).hostname
  } catch {
    return null
  }
  if (url.hostname !== hostSupabase) return null

  const prefijoEsperado = `/storage/v1/object/sign/${BUCKET_DOCUMENTOS_GENERADOS}/`
  if (!url.pathname.startsWith(prefijoEsperado)) return null

  return url
}

// Quita CR/LF y caracteres de control (inyección de headers) y comillas
// dobles (romperían el valor entre comillas de Content-Disposition).
function sanitizarNombreArchivo(nombreCrudo: string): string {
  // eslint-disable-next-line no-control-regex
  const limpio = nombreCrudo.replace(/[\x00-\x1f\x7f]/g, '').replace(/"/g, "'").trim()
  return limpio || 'documento'
}

export async function POST(req: NextRequest) {
  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Solicitud inválida.' }, { status: 400 })
  }

  const urlCruda = form.get('url')
  const nombreCrudo = form.get('nombre')
  if (typeof urlCruda !== 'string' || !urlCruda || typeof nombreCrudo !== 'string' || !nombreCrudo) {
    return NextResponse.json({ error: 'Faltan datos para la descarga.' }, { status: 400 })
  }

  const urlValidada = validarUrlAutorizada(urlCruda)
  if (!urlValidada) {
    return NextResponse.json({ error: 'URL no autorizada.' }, { status: 400 })
  }

  let upstream: Response
  try {
    upstream = await fetch(urlValidada.toString())
  } catch {
    return NextResponse.json({ error: 'No se pudo obtener el archivo.' }, { status: 502 })
  }

  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ error: 'El archivo no está disponible para descargar.' }, { status: 502 })
  }

  const nombre = sanitizarNombreArchivo(nombreCrudo)
  const headers = new Headers()
  headers.set('Content-Type', 'application/octet-stream')
  headers.set('Content-Disposition', `attachment; filename="${nombre}"; filename*=UTF-8''${encodeURIComponent(nombre)}`)
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Cache-Control', 'private, no-store')
  const largoUpstream = upstream.headers.get('content-length')
  if (largoUpstream) headers.set('Content-Length', largoUpstream)

  return new NextResponse(upstream.body, { status: 200, headers })
}
