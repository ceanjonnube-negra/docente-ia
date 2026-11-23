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

import { BUCKET_DESCARGA_PDF, TAMANO_MAXIMO_DESCARGA_PDF, contentDispositionAdjunto, nombreSeguroArchivo, rutaDeUrlFirmada, validarUrlFirmadaPdf } from '@/lib/documentGen/descargaPdf'
import { recuperarArchivoPropio, type ReferenciaArchivo } from '@/lib/documentGen/registroArchivos'
import { autenticarRequestApi } from '@/lib/server/authApi'

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

  let datos: FormData
  try {
    datos = await request.formData()
  } catch {
    return error(400, 'Solicitud de descarga inválida.')
  }
  // Con sesión: recuperar el archivo original aunque su URL firmada ya
  // haya vencido (ver recuperarAutenticado abajo).
  if (datos.has('token')) return recuperarAutenticado(datos)
  const entrada = datos.get('u')
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

// Modo autenticado (tarjetas del Chat con el enlace vencido): el docente se
// identifica con su sesión vigente y el archivo se lee de Storage solo si su
// registro en archivos_generados es suyo, está activo y en su carpeta del
// bucket de documentos generados (recuperarArchivoPropio). Solo lectura: no
// genera archivos, no escribe registros ni llama a la IA.
// - archivoId: tarjetas nuevas. Sin él, la URL persistida de una tarjeta
//   antigua solo sirve para ubicar el archivo; su propiedad se verifica
//   igual en el registro, y sin registro no se entrega.
// - modo 'ver' muestra en línea solo un PDF; cualquier otro archivo (Word…)
//   se entrega como descarga, porque el navegador no lo muestra en línea.
async function recuperarAutenticado(datos: FormData): Promise<Response> {
  const token = datos.get('token')
  const auth = await autenticarRequestApi(typeof token === 'string' ? token : null)
  if (!auth.ok) return error(auth.status, 'Tu sesión venció. Vuelve a iniciar sesión para abrir el archivo.')

  const archivoId = datos.get('archivoId')
  let referencia: ReferenciaArchivo
  if (typeof archivoId === 'string' && archivoId) {
    referencia = { archivoId }
  } else {
    const ubicacion = rutaDeUrlFirmada(datos.get('u'), process.env.NEXT_PUBLIC_SUPABASE_URL)
    if (!ubicacion.ok) {
      console.error(`[RECUPERAR_ARCHIVO] referencia rechazada motivo=${ubicacion.motivo}`)
      return error(404, 'No encontré ese archivo entre tus documentos. Pídelo de nuevo en el Chat.')
    }
    referencia = { bucket: ubicacion.bucket, ruta: ubicacion.ruta }
  }

  const archivo = await recuperarArchivoPropio(auth.user.id, referencia)
  if (!archivo.ok) {
    console.error(`[RECUPERAR_ARCHIVO] no entregado motivo=${archivo.motivo}`)
    return error(archivo.estado, archivo.mensaje)
  }

  const nombre = nombreSeguroArchivo(archivo.nombre)
  const enLinea = datos.get('modo') === 'ver' && archivo.tipoMime === 'application/pdf'
  return new Response(new Uint8Array(archivo.contenido), {
    status: 200,
    headers: {
      'Content-Type': enLinea ? 'application/pdf' : 'application/octet-stream',
      'Content-Disposition': enLinea ? contentDispositionAdjunto(nombre).replace(/^attachment/, 'inline') : contentDispositionAdjunto(nombre),
      'Content-Length': String(archivo.contenido.byteLength),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
