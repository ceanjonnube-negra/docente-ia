import { NextRequest, NextResponse } from 'next/server'
import { autenticarRequestApi, extraerBearerToken } from '@/lib/server/authApi'
import type { EstadoPlaneacion } from '@/lib/planeacion/tipos'

export const runtime = 'nodejs'

const REGEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ESTADOS_VALIDOS: EstadoPlaneacion[] = ['borrador', 'publicada', 'archivada']

// Detalle de una planeación. `proyectos` va vacío en Fase 1 a
// propósito — ningún endpoint todavía escribe en planeacion_proyectos
// (ver migrations/planeacion_fase1.sql) — se deja en la respuesta
// desde ahora para no romper contrato cuando una fase futura empiece
// a poblarla.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: planeacionId } = await params
  try {
    if (!REGEX_UUID.test(planeacionId)) {
      return NextResponse.json({ error: 'Identificador de planeación inválido.' }, { status: 400 })
    }

    const accessToken = extraerBearerToken(req)
    const auth = await autenticarRequestApi(accessToken)
    if (!auth.ok) {
      return NextResponse.json({ error: auth.mensaje }, { status: auth.status })
    }
    const docenteId = auth.user.id
    const supabase = auth.supabase

    const { data: planeacion, error: errorPlaneacion } = await supabase
      .from('planeaciones')
      .select('id, docente_id, nombre, proposito, fecha_inicio, fecha_fin, periodo_evaluacion_id, estado, version, creado_en, actualizado_en')
      .eq('id', planeacionId)
      .maybeSingle()
    if (errorPlaneacion) {
      return NextResponse.json({ error: 'No se pudo verificar la planeación.' }, { status: 500 })
    }
    if (!planeacion) {
      return NextResponse.json({ error: 'Planeación no encontrada.' }, { status: 404 })
    }
    if (planeacion.docente_id !== docenteId) {
      return NextResponse.json({ error: 'No tienes acceso a esta planeación.' }, { status: 403 })
    }

    return NextResponse.json({ planeacion, proyectos: [] })
  } catch (err) {
    console.error(`Error en GET /api/planeaciones/${planeacionId}:`, err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error inesperado.' }, { status: 500 })
  }
}

type BodyPatch = {
  access_token: string
  nombre?: string
  proposito?: string | null
  fecha_inicio?: string | null
  fecha_fin?: string | null
  periodo_evaluacion_id?: string | null
  estado?: EstadoPlaneacion
}

// Actualiza campos de la planeación, o cambia su estado (ej. archivar
// — baja lógica, nunca DELETE físico, mismo criterio ya usado en
// "Eliminar lista completa"). `version` solo se incrementa cuando
// cambia contenido real, no cuando solo cambia el estado.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: planeacionId } = await params
  try {
    if (!REGEX_UUID.test(planeacionId)) {
      return NextResponse.json({ error: 'Identificador de planeación inválido.' }, { status: 400 })
    }

    const body = (await req.json()) as BodyPatch
    const { access_token, nombre, proposito, fecha_inicio, fecha_fin, periodo_evaluacion_id, estado } = body

    const auth = await autenticarRequestApi(access_token)
    if (!auth.ok) {
      return NextResponse.json({ error: auth.mensaje }, { status: auth.status })
    }
    const docenteId = auth.user.id

    if (estado !== undefined && !ESTADOS_VALIDOS.includes(estado)) {
      return NextResponse.json({ error: 'Estado inválido.' }, { status: 400 })
    }
    if (periodo_evaluacion_id && !REGEX_UUID.test(periodo_evaluacion_id)) {
      return NextResponse.json({ error: 'Identificador de periodo inválido.' }, { status: 400 })
    }

    const supabase = auth.supabase

    const { data: planeacionActual, error: errorActual } = await supabase
      .from('planeaciones')
      .select('id, docente_id, version')
      .eq('id', planeacionId)
      .maybeSingle()
    if (errorActual) {
      return NextResponse.json({ error: 'No se pudo verificar la planeación.' }, { status: 500 })
    }
    if (!planeacionActual) {
      return NextResponse.json({ error: 'Planeación no encontrada.' }, { status: 404 })
    }
    if (planeacionActual.docente_id !== docenteId) {
      return NextResponse.json({ error: 'No tienes acceso a esta planeación.' }, { status: 403 })
    }

    const cambiosContenido: Record<string, unknown> = {}
    if (nombre !== undefined) cambiosContenido.nombre = nombre.trim()
    if (proposito !== undefined) cambiosContenido.proposito = proposito
    if (fecha_inicio !== undefined) cambiosContenido.fecha_inicio = fecha_inicio
    if (fecha_fin !== undefined) cambiosContenido.fecha_fin = fecha_fin
    if (periodo_evaluacion_id !== undefined) cambiosContenido.periodo_evaluacion_id = periodo_evaluacion_id

    const huboCambioDeContenido = Object.keys(cambiosContenido).length > 0
    const actualizacion: Record<string, unknown> = {
      ...cambiosContenido,
      actualizado_en: new Date().toISOString(),
    }
    if (estado !== undefined) actualizacion.estado = estado
    if (huboCambioDeContenido) actualizacion.version = planeacionActual.version + 1

    const { data: planeacion, error: errorUpdate } = await supabase
      .from('planeaciones')
      .update(actualizacion)
      .eq('id', planeacionId)
      .select('id, nombre, proposito, fecha_inicio, fecha_fin, periodo_evaluacion_id, estado, version, creado_en, actualizado_en')
      .single()

    if (errorUpdate || !planeacion) {
      return NextResponse.json({ error: errorUpdate?.message || 'No se pudo actualizar la planeación.' }, { status: 500 })
    }

    return NextResponse.json({ planeacion })
  } catch (err) {
    console.error(`Error en PATCH /api/planeaciones/${planeacionId}:`, err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error inesperado.' }, { status: 500 })
  }
}
