import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { autenticarRequestApi } from '@/lib/server/authApi'
import { descargarBuffer, BUCKET_HOJAS_SEGUIMIENTO } from '@/lib/documentGen/almacenamiento'
import { analizarImagenHojaEvaluacion, type MediaTypeImagenHoja } from '@/lib/seguimiento/analisisHojaEvaluacion'

export const runtime = 'nodejs'

// EVAL-1D — extracción visual ESTRUCTURADA de la fotografía ya
// cargada en EVAL-1C. Esta fase SOLO transcribe — deliberadamente NO
// hace matching con alumnos/inscripciones reales, NO escribe
// seguimiento_resultados, NO confirma nada, NO convierte la escala
// 1-4 al enum textual canónico. La transcripción bruta se guarda
// únicamente en proyectos_seguimiento.captura_pendiente.extraidoBruto
// (columna ya preparada en EVAL-1B para exactamente este propósito) —
// nunca en una tabla de historial académico real.

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const REGEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const MIME_POR_EXTENSION: Record<string, MediaTypeImagenHoja> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

const ESTADOS_POST_CONFIRMACION = new Set(['confirmado', 'corregido', 'sustituido', 'cerrado'])

type CapturaPendiente = { fotoStoragePath?: string; fotoSubidaEn?: string } | null

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: proyectoId } = await params
  try {
    if (!REGEX_UUID.test(proyectoId)) {
      return NextResponse.json({ error: 'Identificador de proyecto inválido.' }, { status: 400 })
    }

    const { access_token: accessToken } = (await req.json()) as { access_token: string }

    // El docente real se resuelve SIEMPRE desde el access_token vía
    // auth.getUser() — mismo patrón que el resto de
    // app/api/proyectos-seguimiento/*. Nunca se confía en un
    // docente_id que mande el cliente.
    const auth = await autenticarRequestApi(accessToken)
    if (!auth.ok) {
      return NextResponse.json({ error: auth.mensaje }, { status: auth.status })
    }
    const docenteId = auth.user.id
    const supabase = auth.supabase

    const { data: proyecto, error: errorProyecto } = await supabase
      .from('proyectos_seguimiento')
      .select('id, docente_id, hoja_id, estado, captura_pendiente')
      .eq('id', proyectoId)
      .maybeSingle()
    if (errorProyecto) {
      return NextResponse.json({ error: 'No se pudo verificar el proyecto.' }, { status: 500 })
    }
    if (!proyecto) {
      return NextResponse.json({ error: 'Proyecto no encontrado.' }, { status: 404 })
    }
    if (proyecto.docente_id !== docenteId) {
      return NextResponse.json({ error: 'No tienes acceso a este proyecto.' }, { status: 403 })
    }
    if (ESTADOS_POST_CONFIRMACION.has(proyecto.estado)) {
      return NextResponse.json({ error: 'Esta hoja ya fue confirmada; no se puede volver a analizar.' }, { status: 409 })
    }

    const capturaPendiente = (proyecto.captura_pendiente as CapturaPendiente) ?? null
    if (!capturaPendiente?.fotoStoragePath) {
      return NextResponse.json({ error: 'Este proyecto todavía no tiene ninguna fotografía cargada.' }, { status: 409 })
    }
    if (!proyecto.hoja_id) {
      return NextResponse.json({ error: 'Este proyecto todavía no tiene una hoja de evaluación generada.' }, { status: 409 })
    }

    // EVAL-1B — fail-closed: sin roster_congelado no existe una
    // identidad determinista de alumno×posición para esta hoja — la
    // MISMA regla ya aplicada en la carga (EVAL-1C) se repite aquí,
    // nunca se confía en que el estado del proyecto por sí solo
    // implique que la hoja tiene roster congelado.
    const { data: hoja, error: errorHoja } = await supabase
      .from('hojas_evaluacion')
      .select('id, roster_congelado')
      .eq('id', proyecto.hoja_id)
      .maybeSingle()
    if (errorHoja) {
      return NextResponse.json({ error: 'No se pudo verificar la hoja de evaluación.' }, { status: 500 })
    }
    if (!hoja) {
      return NextResponse.json({ error: 'Hoja de evaluación no encontrada.' }, { status: 404 })
    }
    const rosterCongelado = hoja.roster_congelado as Array<{ posicion: number }> | null
    if (!rosterCongelado || rosterCongelado.length === 0) {
      // Nunca se sustituye por el roster vivo — una hoja sin roster
      // congelado (ej. SG-VXKR, histórica, anterior a EVAL-1B) queda
      // fuera del flujo automático, sin excepción.
      return NextResponse.json({ error: 'Esta hoja fue generada antes de que existiera el registro de alumnos congelado y no admite análisis automático.' }, { status: 409 })
    }

    // Media type derivado de la extensión real del archivo ya subido
    // — nunca se acepta una URL ni un tipo que mande el cliente en
    // este request. HEIC (aceptado por EVAL-1C para la carga) no es
    // un formato que la API de visión de Anthropic soporte
    // directamente — se rechaza aquí con un mensaje honesto en vez de
    // intentar un análisis que fallaría de todos modos.
    const extension = capturaPendiente.fotoStoragePath.split('.').pop()?.toLowerCase() || ''
    const mediaType = MIME_POR_EXTENSION[extension]
    if (!mediaType) {
      return NextResponse.json({ error: 'Esta fotografía está en un formato (probablemente HEIC) que todavía no se puede analizar automáticamente. Vuelve a subirla como JPG, PNG o WEBP.' }, { status: 409 })
    }

    // Descarga real desde Storage — únicamente la ruta ya autorizada y
    // vinculada a este proyecto (captura_pendiente.fotoStoragePath),
    // nunca una URL arbitraria que mande el cliente.
    let buffer: Buffer
    try {
      buffer = await descargarBuffer(supabase, capturaPendiente.fotoStoragePath, BUCKET_HOJAS_SEGUIMIENTO)
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'No se pudo leer la fotografía.' }, { status: 500 })
    }

    let resultado
    try {
      resultado = await analizarImagenHojaEvaluacion(
        anthropic,
        { base64: buffer.toString('base64'), mediaType },
        rosterCongelado.length
      )
    } catch (e) {
      // Fail-closed: ningún error de extracción toca captura_pendiente
      // ni el estado del proyecto — la fotografía y el estado previo
      // quedan intactos para un reintento.
      return NextResponse.json({ error: e instanceof Error ? e.message : 'No se pudo analizar la fotografía.' }, { status: 422 })
    }

    const { error: errorUpdate } = await supabase
      .from('proyectos_seguimiento')
      .update({
        captura_pendiente: {
          ...capturaPendiente,
          extraidoBruto: resultado,
          extraidoEn: new Date().toISOString(),
        },
        estado: 'requiere_revision',
        actualizado_en: new Date().toISOString(),
      })
      .eq('id', proyectoId)
    if (errorUpdate) {
      return NextResponse.json({ error: 'El análisis se completó pero no se pudo registrar. Intenta de nuevo.' }, { status: 500 })
    }

    return NextResponse.json({ ok: true, estado: 'requiere_revision', filas: resultado.filas.length })
  } catch (err) {
    console.error(`Error en POST /api/proyectos-seguimiento/${proyectoId}/analizar-hoja:`, err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error inesperado.' }, { status: 500 })
  }
}
