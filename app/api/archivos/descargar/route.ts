// app/api/archivos/descargar/route.ts
//
// Descarga REAL de un PDF del Chat IA (botón "Descargar PDF"). Safari en
// iPhone ignora el atributo `download` en enlaces a otro origen y, al
// navegar a la URL firmada de Supabase, muestra el PDF en su visor aunque
// llegue como attachment. Esta ruta es del MISMO origen: recibe la URL
// firmada por POST (formulario nativo, no queda en la barra ni en el
// historial), la valida de forma estricta (lib/documentGen/descargaPdf.ts),
// pide el archivo desde el servidor sin seguir redirecciones y lo devuelve
// como application/octet-stream + attachment.
//
// Sin sesión propia: poseer la URL firmada vigente es la misma
// autorización que el botón ya tenía. Solo acepta peticiones del mismo
// sitio. No escribe nada ni toca el registro de archivos.

import { BUCKET_DESCARGA_PDF, TAMANO_MAXIMO_DESCARGA_PDF, contentDispositionAdjunto, validarUrlFirmadaPdf } from '@/lib/documentGen/descargaPdf'

export const runtime = 'nodejs'

// Respuestas de error en texto plano: es una navegación del navegador.
function error(estado: number, mensaje: string): Response {
  return new Response(`${mensaje}\n`, { status: estado, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
}

export async function POST(request: Request): Promise<Response> {
  // Solo el propio sitio (el formulario del Chat). Evita que otra página
  // use esta ruta como proxy de descargas.
  const origen = request.headers.get('origin')
  const sitio = request.headers.get('sec-fetch-site')
  if ((origen && origen !== new URL(request.url).origin) || (sitio && sitio !== 'same-origin')) {
    return error(403, 'Solicitud no permitida.')
  }

  let entrada: FormDataEntryValue | null = null
  try {
    entrada = (await request.formData()).get('u')
  } catch {
    return error(400, 'Solicitud de descarga inválida.')
  }
  const validacion = validarUrlFirmadaPdf(entrada, process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!validacion.ok) {
    console.error(`[DESCARGA_PDF] rechazada motivo=${validacion.motivo}`)
    return error(400, 'El enlace de descarga no es válido.')
  }

  let respuesta: Response
  try {
    respuesta = await fetch(validacion.url, { redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(20_000) })
  } catch {
    return error(502, 'No se pudo obtener el archivo. Intenta de nuevo.')
  }
  if (respuesta.status >= 300 && respuesta.status < 400) return error(502, 'No se pudo obtener el archivo. Intenta de nuevo.')
  if (respuesta.status === 400 || respuesta.status === 401 || respuesta.status === 403) return error(410, 'El enlace de descarga venció. Pide el documento de nuevo en el Chat.')
  if (respuesta.status === 404) return error(404, 'El archivo ya no está disponible.')
  if (!respuesta.ok) return error(502, 'No se pudo obtener el archivo. Intenta de nuevo.')
  if (!(respuesta.headers.get('content-type') ?? '').toLowerCase().startsWith('application/pdf')) {
    console.error(`[DESCARGA_PDF] tipo inesperado desde ${BUCKET_DESCARGA_PDF}`)
    return error(502, 'No se pudo obtener el archivo. Intenta de nuevo.')
  }
  const declarado = Number(respuesta.headers.get('content-length') ?? '0')
  if (declarado > TAMANO_MAXIMO_DESCARGA_PDF) return error(413, 'El archivo es demasiado grande para descargarlo desde aquí. Usa Compartir.')
  const contenido = new Uint8Array(await respuesta.arrayBuffer())
  if (contenido.byteLength > TAMANO_MAXIMO_DESCARGA_PDF) return error(413, 'El archivo es demasiado grande para descargarlo desde aquí. Usa Compartir.')

  return new Response(contenido, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': contentDispositionAdjunto(validacion.nombre),
      'Content-Length': String(contenido.byteLength),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
