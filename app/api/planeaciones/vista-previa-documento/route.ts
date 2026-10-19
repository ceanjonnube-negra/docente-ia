import { NextRequest, NextResponse } from 'next/server'
import { gunzipSync } from 'node:zlib'
import { autenticarRequestApi, leerFormularioPost, respuestaErrorNavegacion } from '@/lib/server/authApi'
import { errorSeguro } from '@/lib/logSeguro'
import { generarPdfBuffer, nombreArchivoPdf } from '@/lib/documentGen/generarPdfServidor'
import { extraerTitulo } from '@/lib/documentGen/parseContenido'

export const runtime = 'nodejs'

const IDENTIFICADOR_VISTA_PREVIA = 'VISTA PREVIA — PENDIENTE DE APROBACIÓN'

// Vista previa DESCARGABLE del documento de planeación completo de un
// borrador TODAVÍA NO APROBADO (corrección funcional — "falta mostrar
// y descargar la planeación"), hermana de vista-previa-hoja/route.ts:
// mismo criterio, a propósito NO sube nada a Storage, NO crea ninguna
// fila en base de datos — genera el PDF en memoria a partir del propio
// texto completo que Claude ya redactó (nunca un resumen reducido) y
// lo devuelve directo en la respuesta HTTP. Reutiliza el mismo
// generador ya usado para Word/PDF/PPT/Excel de documentos formales
// (generarPdfBuffer, lib/documentGen/generarPdfServidor.ts) — nunca un
// generador nuevo ni una segunda interpretación del contenido.
//
// POST (nunca GET con credenciales): "Ver"/"Descargar" de TarjetaDescarga
// (components/Asistente/AsistentePanel.tsx) envían un <form> POST con
// tipoDocumento/datos/modo y el token de la sesión VIGENTE como campos
// del cuerpo — la credencial nunca forma parte de la URL (historial,
// logs de acceso, enlaces compartidos). El texto completo del borrador
// (a diferencia de los datos compactos de la hoja) puede ser largo — se
// comprime con gzip y se codifica en base64url, sin depender de ninguna
// persistencia ni de un segundo viaje al servidor para "guardar" el
// borrador. GET se rechaza siempre (ver abajo).
async function generarVistaPrevia(parametros: URLSearchParams): Promise<Response> {
  try {
    const token = parametros.get('token')
    const datosComprimidos = parametros.get('datos')
    // Validación explícita del tipo de documento (corrección "el
    // adjunto de planeación abre la hoja de evaluación") — esta ruta
    // SOLO genera la planeación completa; nunca decide qué generar
    // solo por a qué endpoint llegó la petición ni por el nombre del
    // archivo. Un tipoDocumento ausente o distinto de "planeacion" es
    // un error controlado, nunca un valor por defecto silencioso.
    const tipoDocumento = parametros.get('tipoDocumento')
    if (tipoDocumento !== 'planeacion') {
      return respuestaErrorNavegacion('Tipo de documento inválido para esta vista previa.', 400)
    }
    if (!token || !datosComprimidos) {
      return respuestaErrorNavegacion('Faltan parámetros para generar la vista previa.', 400)
    }
    // modo (CORRECCIÓN AISLADA — "separar 'Ver PDF' de 'Descargar
    // PDF'"): 'ver' sirve el MISMO pdf en línea (para abrir en una
    // pestaña nueva sin forzar descarga); 'descargar' (default,
    // comportamiento previo) fuerza la descarga con
    // application/octet-stream — Safari en iPhone trata ese
    // Content-Type como binario genérico en vez de intentar mostrarlo
    // en su visor integrado. Nunca cambia el buffer generado, solo las
    // cabeceras de la respuesta.
    const modo = parametros.get('modo') === 'ver' ? 'ver' : 'descargar'

    const auth = await autenticarRequestApi(token)
    if (!auth.ok) {
      return respuestaErrorNavegacion('Tu sesión expiró. Vuelve al Chat IA, inicia sesión de nuevo y toca Ver o Descargar.', auth.status)
    }
    const docenteId = auth.user.id
    const supabase = auth.supabase

    let texto: string
    let zonaHoraria: string | null
    try {
      const json = gunzipSync(Buffer.from(datosComprimidos, 'base64url')).toString('utf-8')
      const datos = JSON.parse(json) as { texto?: string; zonaHoraria?: string | null }
      if (!datos.texto?.trim()) throw new Error('texto vacío')
      texto = datos.texto
      zonaHoraria = datos.zonaHoraria ?? null
    } catch {
      return respuestaErrorNavegacion('Datos de la vista previa inválidos.', 400)
    }

    const { data: perfil } = await supabase.from('perfiles_docentes').select('*').eq('id', docenteId).single()

    // Marca discreta de "todavía no aprobado" — mismo criterio que
    // IDENTIFICADOR_VISTA_PREVIA en la hoja de evaluación, como una
    // línea más del documento (analizarContenido la trata como un
    // párrafo corto, sin alterar el resto del formato).
    const textoConMarca = `${texto}\n\n${IDENTIFICADOR_VISTA_PREVIA}`

    const bufferPdf = await generarPdfBuffer(textoConMarca, perfil, zonaHoraria)
    // Nombre real del proyecto (no un nombre técnico genérico) — mismo
    // criterio que la hermana Word, ver vista-previa-documento-word/route.ts.
    const nombreSugerido = nombreArchivoPdf(extraerTitulo(texto))

    return new NextResponse(new Uint8Array(bufferPdf), {
      status: 200,
      headers: modo === 'ver'
        ? {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `inline; filename="${nombreSugerido}"`,
            'Cache-Control': 'no-store',
          }
        : {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${nombreSugerido}"`,
            'Cache-Control': 'private, no-store, max-age=0',
            'X-Content-Type-Options': 'nosniff',
          },
    })
  } catch (err) {
    console.error(`Error en POST /api/planeaciones/vista-previa-documento: ${errorSeguro(err)}`)
    return respuestaErrorNavegacion('No fue posible generar la vista previa.', 500)
  }
}

// POST — único método que genera la vista previa (ver comentario arriba).
export async function POST(req: NextRequest) {
  const parametros = await leerFormularioPost(req)
  if (!parametros) return respuestaErrorNavegacion('Solicitud inválida para generar la vista previa.', 400)
  return generarVistaPrevia(parametros)
}

// GET — rechazado SIEMPRE, con o sin token: ninguna credencial se acepta
// en la URL. Una referencia histórica que todavía lleve ?token= se abre
// desde la tarjeta del Chat IA, que descarta ese token y usa la sesión
// vigente.
export async function GET() {
  return respuestaErrorNavegacion('Esta vista previa se abre desde el Chat IA: vuelve a la conversación y toca Ver o Descargar.', 405, { Allow: 'POST' })
}
