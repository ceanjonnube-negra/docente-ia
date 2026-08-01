import { NextRequest, NextResponse } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { CAMPOS_FORMATIVOS } from '@/lib/seguimiento/tipos'
import { autenticarRequestApi } from '@/lib/server/authApi'

export const runtime = 'nodejs'

const REGEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function getClient(accessToken: string): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${accessToken}` } } }
  )
}

export async function GET(req: NextRequest) {
  const accessToken = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!accessToken) return NextResponse.json({ error: 'No autenticado' }, { status: 401 })

  const grupoId = req.nextUrl.searchParams.get('grupo_id')
  if (!grupoId) return NextResponse.json({ error: 'Falta grupo_id' }, { status: 400 })

  const supabase = getClient(accessToken)
  const { data, error } = await supabase
    .from('proyectos_seguimiento')
    .select('id, nombre, campos_formativos, periodo_evaluacion_id, fecha_inicio, fecha_fin, estado, hoja_id, creado_en')
    .eq('grupo_id', grupoId)
    .order('creado_en', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ proyectos: data })
}

type BodyPost = {
  access_token: string
  grupo_id: string
  nombre: string
  campos_formativos: string[]
  periodo_evaluacion_id?: string | null
  fecha_inicio?: string | null
  fecha_fin?: string | null
}

// Crea SOLO el proyecto (estado='planeado') — la generación de la hoja
// es un paso aparte (POST /api/proyectos-seguimiento/[id]/hoja),
// llamado justo después por la pantalla de creación. Separarlos permite
// reintentar solo la hoja si ese paso falla, sin crear un proyecto
// duplicado — ver el comentario en la ruta de la hoja.
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as BodyPost
    const {
      access_token, grupo_id, nombre, campos_formativos,
      periodo_evaluacion_id, fecha_inicio, fecha_fin,
    } = body

    // El docente real se resuelve SIEMPRE desde el access_token vía
    // auth.getUser() — mismo patrón de lib/server/authApi.ts ya usado en
    // app/api/importar-alumnos/route.ts. Nunca se confía en un docente_id
    // que mande el cliente (ver C-002, IDOR corregido).
    const auth = await autenticarRequestApi(access_token)
    if (!auth.ok) {
      return NextResponse.json({ error: auth.mensaje }, { status: auth.status })
    }
    const docenteId = auth.user.id

    if (!grupo_id || !nombre?.trim()) {
      return NextResponse.json({ error: 'Faltan el grupo o el nombre del proyecto.' }, { status: 400 })
    }
    if (!REGEX_UUID.test(grupo_id)) {
      return NextResponse.json({ error: 'Identificador de grupo inválido.' }, { status: 400 })
    }
    const camposValidos = (campos_formativos || []).filter(c => (CAMPOS_FORMATIVOS as readonly string[]).includes(c))
    if (camposValidos.length === 0) {
      return NextResponse.json({ error: 'Selecciona al menos un campo formativo válido.' }, { status: 400 })
    }

    const supabase = auth.supabase

    // El grupo se vuelve a resolver server-side (nunca se confía en un
    // ciclo_escolar_id que mande el cliente), y su pertenencia se verifica
    // explícitamente contra el docente real de la sesión — ya no se
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

    const { data: proyecto, error: errorProyecto } = await supabase
      .from('proyectos_seguimiento')
      .insert({
        grupo_id,
        docente_id: docenteId,
        ciclo_escolar_id: grupo.ciclo_escolar_id,
        periodo_evaluacion_id: periodo_evaluacion_id || null,
        nombre: nombre.trim(),
        campos_formativos: camposValidos,
        fecha_inicio: fecha_inicio || null,
        fecha_fin: fecha_fin || null,
      })
      .select('id, nombre, campos_formativos, periodo_evaluacion_id, fecha_inicio, fecha_fin, estado')
      .single()

    if (errorProyecto || !proyecto) {
      return NextResponse.json({ error: errorProyecto?.message || 'No se pudo crear el proyecto.' }, { status: 500 })
    }

    return NextResponse.json({ proyecto })
  } catch (err) {
    console.error('Error en POST /api/proyectos-seguimiento:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error inesperado.' }, { status: 500 })
  }
}
