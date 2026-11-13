import { NextRequest, NextResponse } from 'next/server'
import { gunzipSync } from 'node:zlib'
import { autenticarRequestApi, leerFormularioPost, respuestaErrorNavegacion } from '@/lib/server/authApi'
import { generarWordBuffer, nombreArchivoWordServidor } from '@/lib/documentGen/generarWordServidor'
import { extraerTitulo } from '@/lib/documentGen/parseContenido'
import { perfilConGrupoAcademico } from '@/lib/documentGen/encabezadoDocumento'
import { leerGrupoDelDocente } from '@/lib/grupoActivo'

export const runtime = 'nodejs'

const REGEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
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
// Solo POST: la credencial viaja en el CUERPO del formulario, nunca en la
// URL (historial, logs, enlaces compartidos). GET se rechaza siempre.
export function GET() {
  return respuestaErrorNavegacion('Abre la vista previa desde el Chat.', 405, { Allow: 'POST' })
}

export async function POST(req: NextRequest) {
  try {
    const parametros = await leerFormularioPost(req)
    if (!parametros) return respuestaErrorNavegacion('Solicitud de vista previa inválida.', 400)
    const token = parametros.get('token')
    const datosComprimidos = parametros.get('datos')
    // Validación explícita del tipo de documento — mismo criterio que
    // vista-previa-documento/route.ts: esta ruta SOLO genera la
    // planeación completa en Word, nunca decide qué generar solo por a
    // qué endpoint llegó la petición.
    const tipoDocumento = parametros.get('tipoDocumento')
    if (tipoDocumento !== 'planeacion') {
      return respuestaErrorNavegacion('Tipo de documento inválido para esta vista previa.', 400)
    }
    if (!token || !datosComprimidos) {
      return respuestaErrorNavegacion('Faltan parámetros para generar la vista previa.', 400)
    }

    const auth = await autenticarRequestApi(token)
    if (!auth.ok) {
      return respuestaErrorNavegacion(auth.mensaje, auth.status)
    }
    const docenteId = auth.user.id
    const supabase = auth.supabase

    let texto: string
    let zonaHoraria: string | null
    let grupoId: string | null
    try {
      const json = gunzipSync(Buffer.from(datosComprimidos, 'base64url')).toString('utf-8')
      const datos = JSON.parse(json) as { texto?: string; zonaHoraria?: string | null; grupoId?: string | null }
      if (!datos.texto?.trim()) throw new Error('texto vacío')
      if (datos.grupoId != null && !REGEX_UUID.test(datos.grupoId)) throw new Error('grupoId inválido')
      texto = datos.texto
      zonaHoraria = datos.zonaHoraria ?? null
      grupoId = datos.grupoId ?? null
    } catch {
      return respuestaErrorNavegacion('Datos de la vista previa inválidos.', 400)
    }

    // Mismo criterio que la vista previa PDF: grado y grupo del grupo de
    // la planeación (verificado contra el docente), nunca del perfil.
    // grupoId solo viaja en el enlace del servidor (el borrador aún no está
    // persistido): acredita la propiedad, no el vínculo con el texto. Sin
    // grupoId (enlaces anteriores): sin asociación académica verificable,
    // encabezado del perfil por compatibilidad.
    const grupo = grupoId ? await leerGrupoDelDocente(supabase, grupoId, docenteId) : null
    if (grupo === 'error') return respuestaErrorNavegacion('No se pudo verificar el grupo.', 500)
    if (grupo === 'ajeno') return respuestaErrorNavegacion('No tienes acceso a este grupo.', 403)
    const { data: perfilDocente } = await supabase.from('perfiles_docentes').select('*').eq('id', docenteId).single()
    const perfil = perfilConGrupoAcademico(perfilDocente, grupo)

    // Marca discreta de "todavía no aprobado" — mismo criterio que la
    // vista previa PDF, como una línea más del documento.
    const textoConMarca = `${texto}\n\n${IDENTIFICADOR_VISTA_PREVIA}`

    const bufferWord = await generarWordBuffer(textoConMarca, perfil, zonaHoraria)
    const nombreSugerido = nombreArchivoWordServidor(extraerTitulo(texto))

    return new NextResponse(new Uint8Array(bufferWord), {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        // filename* (UTF-8) además del filename clásico — AJUSTE
        // AISLADO "corregir únicamente el nombre del archivo Word":
        // nombreSugerido ya es un slug solo-ASCII (nombreArchivoWordServidor
        // quita acentos y sustituye cualquier carácter fuera de
        // [a-zA-Z0-9] por "_"), así que hoy ambos valores son
        // idénticos — se agrega igual como compatibilidad explícita
        // para clientes que prefieren la variante UTF-8 del estándar
        // (RFC 6266), sin cambiar el nombre real en ningún caso.
        'Content-Disposition': `attachment; filename="${nombreSugerido}"; filename*=UTF-8''${encodeURIComponent(nombreSugerido)}`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    console.error('Error en POST /api/planeaciones/vista-previa-documento-word:', err instanceof Error ? err.message : 'desconocido')
    return respuestaErrorNavegacion('No fue posible generar la vista previa.', 500)
  }
}
