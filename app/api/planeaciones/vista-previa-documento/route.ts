import { NextRequest, NextResponse } from 'next/server'
import { gunzipSync } from 'node:zlib'
import { autenticarRequestApi } from '@/lib/server/authApi'
import { generarPdfBuffer, nombreArchivoPdf } from '@/lib/documentGen/generarPdfServidor'

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
// GET (no POST) por la misma razón que vista-previa-hoja: el botón
// "Descargar"/"Abrir" del Chat IA hace window.open(url), una
// navegación directa sin cabeceras — la autenticación viaja en la URL
// como query param `token`. El texto completo del borrador (a
// diferencia de los datos compactos de la hoja) puede ser largo — se
// comprime con gzip antes de codificar en base64url para mantener la
// URL dentro de límites seguros, sin depender de ninguna persistencia
// ni de un segundo viaje al servidor para "guardar" el borrador.
export async function GET(req: NextRequest) {
  try {
    const token = req.nextUrl.searchParams.get('token')
    const datosComprimidos = req.nextUrl.searchParams.get('datos')
    if (!token || !datosComprimidos) {
      return NextResponse.json({ error: 'Faltan parámetros para generar la vista previa.' }, { status: 400 })
    }

    const auth = await autenticarRequestApi(token)
    if (!auth.ok) {
      return NextResponse.json({ error: auth.mensaje }, { status: auth.status })
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
      return NextResponse.json({ error: 'Datos de la vista previa inválidos.' }, { status: 400 })
    }

    const { data: perfil } = await supabase.from('perfiles_docentes').select('*').eq('id', docenteId).single()

    // Marca discreta de "todavía no aprobado" — mismo criterio que
    // IDENTIFICADOR_VISTA_PREVIA en la hoja de evaluación, como una
    // línea más del documento (analizarContenido la trata como un
    // párrafo corto, sin alterar el resto del formato).
    const textoConMarca = `${texto}\n\n${IDENTIFICADOR_VISTA_PREVIA}`

    const bufferPdf = await generarPdfBuffer(textoConMarca, perfil, zonaHoraria)

    return new NextResponse(new Uint8Array(bufferPdf), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${nombreArchivoPdf('vista-previa-planeacion')}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    console.error('Error en GET /api/planeaciones/vista-previa-documento:', err)
    return NextResponse.json({ error: 'No fue posible generar la vista previa.' }, { status: 500 })
  }
}
