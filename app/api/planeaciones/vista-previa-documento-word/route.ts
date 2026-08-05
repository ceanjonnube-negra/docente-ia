import { NextRequest, NextResponse } from 'next/server'
import { gunzipSync } from 'node:zlib'
import { autenticarRequestApi } from '@/lib/server/authApi'
import { generarWordBuffer, nombreArchivoWordServidor } from '@/lib/documentGen/generarWordServidor'
import { extraerTitulo } from '@/lib/documentGen/parseContenido'

export const runtime = 'nodejs'

const IDENTIFICADOR_VISTA_PREVIA = 'VISTA PREVIA — PENDIENTE DE APROBACIÓN'

// Hermana Word de vista-previa-documento/route.ts (PDF) — mismo
// criterio exacto: NO sube nada a Storage, NO crea ninguna fila en
// base de datos, genera el .docx en memoria a partir del mismo texto
// completo del borrador (nunca un resumen reducido) y lo devuelve
// directo en la respuesta HTTP. Reutiliza generarWordBuffer (el mismo
// generador ya usado para el Word real de "FINALIZAR ARCHIVO",
// lib/documentGen/generarWordServidor.ts) — nunca un generador nuevo
// ni una segunda interpretación del contenido. Existe como archivo
// separado a propósito, en vez de agregar un parámetro `formato` a
// vista-previa-documento/route.ts, para no tocar esa ruta.
//
// GET (no POST), mismo motivo que su hermana PDF: la descarga real se
// dispara con una petición GET directa (ver descargarArchivo en
// AsistentePanel.tsx), nunca con window.open a secas — Content-Type y
// Content-Disposition van siempre correctos para que el navegador (o
// el picker de Safari en iPhone) ofrezca guardar un .docx real, nunca
// abrirlo como si fuera texto plano.
export async function GET(req: NextRequest) {
  try {
    const token = req.nextUrl.searchParams.get('token')
    const datosComprimidos = req.nextUrl.searchParams.get('datos')
    // Validación explícita del tipo de documento — mismo criterio que
    // vista-previa-documento/route.ts: esta ruta SOLO genera la
    // planeación completa en Word, nunca decide qué generar solo por a
    // qué endpoint llegó la petición.
    const tipoDocumento = req.nextUrl.searchParams.get('tipoDocumento')
    if (tipoDocumento !== 'planeacion') {
      return NextResponse.json({ error: 'Tipo de documento inválido para esta vista previa.' }, { status: 400 })
    }
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

    // Marca discreta de "todavía no aprobado" — mismo criterio que la
    // vista previa PDF, como una línea más del documento.
    const textoConMarca = `${texto}\n\n${IDENTIFICADOR_VISTA_PREVIA}`

    const bufferWord = await generarWordBuffer(textoConMarca, perfil, zonaHoraria)
    const nombreSugerido = nombreArchivoWordServidor(extraerTitulo(texto))

    return new NextResponse(new Uint8Array(bufferWord), {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${nombreSugerido}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    console.error('Error en GET /api/planeaciones/vista-previa-documento-word:', err)
    return NextResponse.json({ error: 'No fue posible generar la vista previa.' }, { status: 500 })
  }
}
