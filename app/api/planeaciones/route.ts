import { NextRequest, NextResponse } from 'next/server'
import { autenticarRequestApi, extraerBearerToken } from '@/lib/server/authApi'

export const runtime = 'nodejs'

const REGEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// GET solo acepta grupo_id — un docente nunca puede listar planeaciones
// sin especificar un grupo, y ese grupo se verifica explícitamente
// contra el docente real de la sesión antes de consultar
// planeaciones (mismo patrón ya usado en proyectos-seguimiento/route.ts).
export async function GET(req: NextRequest) {
  try {
    const accessToken = extraerBearerToken(req)
    const auth = await autenticarRequestApi(accessToken)
    if (!auth.ok) {
      return NextResponse.json({ error: auth.mensaje }, { status: auth.status })
    }
    const docenteId = auth.user.id

    const grupoId = req.nextUrl.searchParams.get('grupo_id')
    if (!grupoId) {
      return NextResponse.json({ error: 'Falta grupo_id' }, { status: 400 })
    }
    if (!REGEX_UUID.test(grupoId)) {
      return NextResponse.json({ error: 'Identificador de grupo inválido.' }, { status: 400 })
    }

    const periodoEvaluacionId = req.nextUrl.searchParams.get('periodo_evaluacion_id')
    if (periodoEvaluacionId && !REGEX_UUID.test(periodoEvaluacionId)) {
      return NextResponse.json({ error: 'Identificador de periodo inválido.' }, { status: 400 })
    }

    const supabase = auth.supabase

    const { data: grupo, error: errorGrupo } = await supabase
      .from('grupos')
      .select('id, docente_id')
      .eq('id', grupoId)
      .maybeSingle()
    if (errorGrupo) {
      return NextResponse.json({ error: 'No se pudo verificar el grupo.' }, { status: 500 })
    }
    if (!grupo) {
      return NextResponse.json({ error: 'Grupo no encontrado.' }, { status: 404 })
    }
    if (grupo.docente_id !== docenteId) {
      return NextResponse.json({ error: 'No tienes acceso a este grupo.' }, { status: 403 })
    }

    let consulta = supabase
      .from('planeaciones')
      .select('id, nombre, proposito, fecha_inicio, fecha_fin, periodo_evaluacion_id, estado, version, creado_en')
      .eq('grupo_id', grupoId)
      .order('creado_en', { ascending: false })
    if (periodoEvaluacionId) {
      consulta = consulta.eq('periodo_evaluacion_id', periodoEvaluacionId)
    }

    const { data, error } = await consulta
    if (error) return NextResponse.json({ error: 'No se pudieron leer las planeaciones.' }, { status: 500 })
    return NextResponse.json({ planeaciones: data })
  } catch (err) {
    console.error('Error en GET /api/planeaciones:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error inesperado.' }, { status: 500 })
  }
}

type BodyPost = {
  access_token: string
  grupo_id: string
  nombre: string
  proposito?: string | null
  fecha_inicio?: string | null
  fecha_fin?: string | null
  periodo_evaluacion_id?: string | null
}

// Crea SOLO la planeación (el contenedor) con estado='borrador'. No
// crea ningún planeacion_proyectos — esa tabla existe desde esta
// migración pero ningún endpoint de Fase 1 escribe en ella todavía
// (ver migrations/planeacion_fase1.sql).
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as BodyPost
    const { access_token, grupo_id, nombre, proposito, fecha_inicio, fecha_fin, periodo_evaluacion_id } = body

    // El docente real se resuelve SIEMPRE desde el access_token vía
    // auth.getUser() — nunca se confía en un docente_id que mande el
    // cliente (mismo patrón que app/api/proyectos-seguimiento/route.ts).
    const auth = await autenticarRequestApi(access_token)
    if (!auth.ok) {
      return NextResponse.json({ error: auth.mensaje }, { status: auth.status })
    }
    const docenteId = auth.user.id

    if (!grupo_id || !nombre?.trim()) {
      return NextResponse.json({ error: 'Faltan el grupo o el nombre de la planeación.' }, { status: 400 })
    }
    if (!REGEX_UUID.test(grupo_id)) {
      return NextResponse.json({ error: 'Identificador de grupo inválido.' }, { status: 400 })
    }
    if (periodo_evaluacion_id && !REGEX_UUID.test(periodo_evaluacion_id)) {
      return NextResponse.json({ error: 'Identificador de periodo inválido.' }, { status: 400 })
    }

    const supabase = auth.supabase

    // El grupo se resuelve server-side y su pertenencia se verifica
    // explícitamente contra el docente real de la sesión — no se
    // delega esa verificación únicamente al RLS.
    const { data: grupo, error: errorGrupo } = await supabase
      .from('grupos')
      .select('id, docente_id, ciclo_escolar_id')
      .eq('id', grupo_id)
      .maybeSingle()
    if (errorGrupo) {
      return NextResponse.json({ error: 'No se pudo verificar el grupo.' }, { status: 500 })
    }
    if (!grupo) {
      return NextResponse.json({ error: 'Grupo no encontrado.' }, { status: 404 })
    }
    if (grupo.docente_id !== docenteId) {
      return NextResponse.json({ error: 'No tienes acceso a este grupo.' }, { status: 403 })
    }

    const { data: planeacion, error: errorPlaneacion } = await supabase
      .from('planeaciones')
      .insert({
        docente_id: docenteId,
        grupo_id,
        ciclo_escolar_id: grupo.ciclo_escolar_id,
        periodo_evaluacion_id: periodo_evaluacion_id || null,
        nombre: nombre.trim(),
        proposito: proposito || null,
        fecha_inicio: fecha_inicio || null,
        fecha_fin: fecha_fin || null,
      })
      .select('id, nombre, proposito, fecha_inicio, fecha_fin, periodo_evaluacion_id, estado, version, creado_en')
      .single()

    if (errorPlaneacion || !planeacion) {
      return NextResponse.json({ error: errorPlaneacion?.message || 'No se pudo crear la planeación.' }, { status: 500 })
    }

    return NextResponse.json({ planeacion })
  } catch (err) {
    console.error('Error en POST /api/planeaciones:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error inesperado.' }, { status: 500 })
  }
}
