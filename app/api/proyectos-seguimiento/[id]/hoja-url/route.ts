import { NextRequest, NextResponse } from 'next/server'
import { autenticarRequestApi, extraerBearerToken } from '@/lib/server/authApi'
import { crearUrlFirmada, BUCKET_HOJAS_SEGUIMIENTO } from '@/lib/documentGen/almacenamiento'
import { nombreArchivoHoja } from '@/lib/documentGen/generarHojaSeguimientoPdf'

export const runtime = 'nodejs'

// EVAL-1I — "Ver hoja" desde la pantalla de Evaluación. NUNCA se
// persiste una URL firmada como fuente de verdad (las URLs firmadas
// vencen) — esta ruta regenera una fresca, a demanda, únicamente
// cuando el docente de verdad pide ver una hoja puntual. Deliberadamente
// separada del GET de listado (que solo devuelve storage_path, nunca
// una URL) para no generar N URLs firmadas (N llamadas reales a la API
// de Storage) por cada hoja que aparece en la lista, la mayoría de las
// cuales el docente nunca abre. Mismo patrón GET (Authorization:
// Bearer) ya usado en revisar-hoja/estado-captura — un GET no lleva
// body. 0 escrituras, 0 llamadas IA.

const REGEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: proyectoId } = await params
  try {
    if (!REGEX_UUID.test(proyectoId)) {
      return NextResponse.json({ error: 'Identificador de proyecto inválido.' }, { status: 400 })
    }

    const accessToken = extraerBearerToken(req)
    const auth = await autenticarRequestApi(accessToken)
    if (!auth.ok) {
      return NextResponse.json({ error: auth.mensaje }, { status: auth.status })
    }
    const docenteId = auth.user.id
    const supabase = auth.supabase

    const { data: proyecto, error: errorProyecto } = await supabase
      .from('proyectos_seguimiento')
      .select('id, docente_id, hoja_id')
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
    if (!proyecto.hoja_id) {
      return NextResponse.json({ error: 'Este proyecto todavía no tiene una hoja de evaluación generada.' }, { status: 409 })
    }

    const { data: hoja, error: errorHoja } = await supabase
      .from('hojas_evaluacion')
      .select('identificador_visible, storage_path')
      .eq('id', proyecto.hoja_id)
      .maybeSingle()
    if (errorHoja) {
      return NextResponse.json({ error: 'No se pudo verificar la hoja de evaluación.' }, { status: 500 })
    }
    if (!hoja || !hoja.storage_path) {
      return NextResponse.json({ error: 'Esta hoja todavía no tiene un archivo generado.' }, { status: 409 })
    }

    // Mismo par url/urlVer ya usado en generarYGuardarHoja.ts —
    // `url` fuerza descarga, `urlVer` es para abrir en línea.
    const url = await crearUrlFirmada(supabase, hoja.storage_path, nombreArchivoHoja(hoja.identificador_visible), BUCKET_HOJAS_SEGUIMIENTO)
    const urlVer = await crearUrlFirmada(supabase, hoja.storage_path, undefined, BUCKET_HOJAS_SEGUIMIENTO)

    return NextResponse.json({ ok: true, url, urlVer })
  } catch (err) {
    console.error(`Error en GET /api/proyectos-seguimiento/${proyectoId}/hoja-url:`, err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error inesperado.' }, { status: 500 })
  }
}
