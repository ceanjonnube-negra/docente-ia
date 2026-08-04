import { NextRequest, NextResponse } from 'next/server'
import { generarYGuardarHojaSeguimiento } from '@/lib/seguimiento/generarYGuardarHoja'
import { ASPECTOS_GENERALES, type IndicadorProyecto } from '@/lib/seguimiento/tipos'
import { autenticarRequestApi } from '@/lib/server/authApi'

export const runtime = 'nodejs'

const REGEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Genera la hoja de un proyecto ya existente — llamada por la pantalla
// de creación justo después de POST /api/proyectos-seguimiento, y
// también disponible como "Reintentar generar hoja" si ese primer
// intento falla (nunca crea un proyecto nuevo, solo vuelve a intentar
// la hoja sobre el mismo `id`). Los indicadores no se persisten en
// proyectos_seguimiento — solo viven en hojas_evaluacion.indicadores —
// así que el reintento debe volver a mandarlos; la pantalla los
// conserva en su estado mientras el docente no navegue fuera.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: proyectoId } = await params
  try {
    if (!REGEX_UUID.test(proyectoId)) {
      return NextResponse.json({ error: 'Identificador de proyecto inválido.' }, { status: 400 })
    }

    const { access_token, indicadores, zona_horaria } = (await req.json()) as {
      access_token: string
      indicadores: IndicadorProyecto[]
      zona_horaria: string | null
    }

    // El docente real se resuelve SIEMPRE desde el access_token vía
    // auth.getUser() — mismo patrón de lib/server/authApi.ts ya usado en
    // app/api/importar-alumnos/route.ts. Nunca se confía en un docente_id
    // que mande el cliente (ver C-002, IDOR corregido).
    const auth = await autenticarRequestApi(access_token)
    if (!auth.ok) {
      return NextResponse.json({ error: auth.mensaje }, { status: auth.status })
    }
    const docenteId = auth.user.id

    const aspectosValidos = new Set(ASPECTOS_GENERALES.map(a => a.valor))
    const indicadoresValidos = (indicadores || []).filter(
      i => i.indicador_especifico?.trim() && aspectosValidos.has(i.aspecto_general)
    )
    if (indicadoresValidos.length === 0) {
      return NextResponse.json({ error: 'Agrega al menos un indicador con su aspecto general.' }, { status: 400 })
    }

    const supabase = auth.supabase

    const { data: proyecto, error: errorProyecto } = await supabase
      .from('proyectos_seguimiento')
      .select('id, grupo_id, nombre, campos_formativos, periodo_evaluacion_id, fecha_inicio, fecha_fin, docente_id')
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

    let periodoNombre: string | null = null
    if (proyecto.periodo_evaluacion_id) {
      const { data: periodo } = await supabase
        .from('periodos_evaluacion')
        .select('nombre')
        .eq('id', proyecto.periodo_evaluacion_id)
        .maybeSingle()
      periodoNombre = periodo?.nombre ?? null
    }

    const { data: perfil } = await supabase.from('perfiles_docentes').select('*').eq('id', docenteId).single()

    const resultado = await generarYGuardarHojaSeguimiento(
      supabase,
      docenteId,
      {
        proyectoId: proyecto.id,
        grupoId: proyecto.grupo_id,
        nombreProyecto: proyecto.nombre,
        camposFormativos: proyecto.campos_formativos,
        trimestreNombre: periodoNombre,
        fechaInicio: proyecto.fecha_inicio,
        fechaFin: proyecto.fecha_fin,
        indicadores: indicadoresValidos,
      },
      perfil,
      zona_horaria
    )

    if (!resultado.ok) {
      return NextResponse.json({ error: resultado.error }, { status: 500 })
    }

    const { data: proyectoActualizado } = await supabase
      .from('proyectos_seguimiento')
      .select('id, nombre, campos_formativos, periodo_evaluacion_id, fecha_inicio, fecha_fin, estado, hoja_id')
      .eq('id', proyecto.id)
      .single()

    return NextResponse.json({
      proyecto: proyectoActualizado,
      hoja: { id: resultado.hojaId, identificador_visible: resultado.identificadorVisible, url: resultado.url },
    })
  } catch (err) {
    console.error(`Error en POST /api/proyectos-seguimiento/${proyectoId}/hoja:`, err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error inesperado.' }, { status: 500 })
  }
}
