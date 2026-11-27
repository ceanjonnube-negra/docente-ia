import { NextRequest, NextResponse } from 'next/server'
import { autenticarRequestApi, extraerBearerToken } from '@/lib/server/authApi'
import { historialAcademicoGrupo } from '@/lib/seguimiento/historialAcademico'

export const runtime = 'nodejs'

// EVAL-1K — primer consumidor real de resultadosProyectoGrupo()
// (lib/motorContexto.ts), expuesto como read-model acumulativo del
// grupo (ver lib/seguimiento/historialGrupo.ts). Solo LEE — 0
// escrituras, 0 llamadas IA, 0 tabla nueva.
//
// Mismo patrón de autenticación/ownership ya usado en
// GET /api/proyectos-seguimiento (app/api/proyectos-seguimiento/route.ts)
// — grupo_id es el ÚNICO identificador que acepta del cliente;
// ciclo_escolar_id NUNCA se acepta del cliente, se deriva server-side
// desde la misma fila de `grupos` ya usada para verificar ownership
// (mismo criterio que el POST de esa misma ruta: "el grupo se vuelve
// a resolver server-side, nunca se confía en un ciclo_escolar_id que
// mande el cliente").
//
// 2 queries en el camino normal: (1) grupo real + ownership + su
// ciclo_escolar_id; (2) la única query de resultadosProyectoGrupo().
// Ninguna query por proyecto, por alumno ni por indicador — el
// agrupamiento/conteo ocurre enteramente en memoria dentro de
// construirHistorialGrupo().

const REGEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(req: NextRequest) {
  try {
    const accessToken = extraerBearerToken(req)
    const auth = await autenticarRequestApi(accessToken)
    if (!auth.ok) {
      return NextResponse.json({ error: auth.mensaje }, { status: auth.status })
    }
    const docenteId = auth.user.id
    const supabase = auth.supabase

    const grupoId = req.nextUrl.searchParams.get('grupo_id')
    if (!grupoId) {
      return NextResponse.json({ error: 'Falta grupo_id' }, { status: 400 })
    }
    if (!REGEX_UUID.test(grupoId)) {
      return NextResponse.json({ error: 'Identificador de grupo inválido.' }, { status: 400 })
    }

    // Query 1 — grupo real, ownership, y su ciclo_escolar_id real
    // (nunca aceptado del cliente). Mismo select/verificación que ya
    // usa el POST de app/api/proyectos-seguimiento/route.ts.
    const { data: grupo, error: errorGrupo } = await supabase
      .from('grupos')
      .select('id, docente_id, ciclo_escolar_id')
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
    if (!grupo.ciclo_escolar_id) {
      return NextResponse.json({ error: 'Este grupo no tiene un ciclo escolar asociado.' }, { status: 409 })
    }

    // Query 2 — la única lectura de resultadosProyectoGrupo(), sin
    // modificarla. Un error real de Supabase se propaga como 500 (esa
    // función relanza, nunca convierte un error en []).
    // Hito 3: resultados confirmados + periodos del ciclo (2 consultas),
    // con el modelo de lectura compartido (periodo resuelto, campos
    // formativos, conteos por alumno).
    let historial
    try {
      historial = await historialAcademicoGrupo(supabase, grupo.id, grupo.ciclo_escolar_id)
    } catch (err) {
      console.error('Error en historialAcademicoGrupo() dentro de GET historial-grupo:', err)
      return NextResponse.json({ error: 'No se pudieron recuperar los resultados del grupo.' }, { status: 500 })
    }

    return NextResponse.json({ historial })
  } catch (err) {
    console.error('Error en GET /api/proyectos-seguimiento/historial-grupo:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error inesperado.' }, { status: 500 })
  }
}
