import { NextRequest, NextResponse } from 'next/server'
import { autenticarRequestApi, extraerBearerToken } from '@/lib/server/authApi'
import { construirMatrizResultadosConfirmados, type FilaResultadoConfirmadoLectura } from '@/lib/seguimiento/resultadosConfirmados'
import type { AlumnoRosterCongelado, IndicadorCongelado } from '@/lib/seguimiento/tipos'

export const runtime = 'nodejs'

// EVAL-1J — primer consumidor real de seguimiento_resultados a nivel
// de UNA hoja ya confirmada (ver auditoría READ-ONLY "primer hueco
// real: consumo grupal de seguimiento_resultados"). Mismo patrón de
// autenticación/verificación de propiedad que revisar-hoja/route.ts y
// estado-captura/route.ts — la única diferencia real es QUÉ tabla se
// lee para las celdas: aquí SIEMPRE seguimiento_resultados (la tabla
// académica canónica), NUNCA captura_pendiente (ese es el staging que
// ya usa revisar-hoja, una fuente distinta a propósito). Solo LEE — 0
// escrituras, 0 llamadas IA.
//
// Fail-closed: responde 409 si el proyecto todavía no está confirmado
// — nunca intenta mostrar un panel con resultados parciales o
// inexistentes. 3 queries, mismo patrón ya probado en esta misma
// familia de endpoints (proyecto -> hoja -> [aquí] seguimiento_resultados
// en vez de captura_pendiente); no se intentó un embed de una sola
// consulta porque ningún otro endpoint de esta familia (revisar-hoja,
// estado-captura, confirmar-hoja, analizar-hoja, foto-hoja, hoja-url)
// embebe proyectos_seguimiento + hojas_evaluacion en una sola llamada
// — 0 precedente real en todo el repositorio — y no hay forma de
// confirmar que el embed sea seguro con el esquema/RLS reales sin una
// consulta remota, fuera de alcance en esta fase.

const REGEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// 'confirmado' es hoy el único estado post-confirmación que Fase 2
// realmente usa (ver lib/seguimiento/tipos.ts, EstadoProyectoFase2) —
// mismo conjunto documentado en corregir-celda/route.ts como "estados
// posteriores a la confirmación", reutilizado aquí tal cual para no
// duplicar ese criterio con una lista distinta.
const ESTADOS_CON_RESULTADOS_CONFIRMADOS = new Set(['confirmado', 'corregido', 'sustituido', 'cerrado'])

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

    // Query 1 — proyecto real, ownership y estado. Mismo select que
    // ya usan revisar-hoja/estado-captura; se agrega `estado` para el
    // guard fail-closed de abajo.
    const { data: proyecto, error: errorProyecto } = await supabase
      .from('proyectos_seguimiento')
      .select('id, docente_id, hoja_id, estado')
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
    if (!ESTADOS_CON_RESULTADOS_CONFIRMADOS.has(proyecto.estado)) {
      return NextResponse.json({ error: 'Esta hoja todavía no tiene resultados confirmados.' }, { status: 409 })
    }

    // Query 2 — roster e indicadores congelados de la hoja (misma
    // fuente de identidad que revisar-hoja/estado-captura: 0 N+1, los
    // nombres ya vienen resueltos aquí).
    const { data: hoja, error: errorHoja } = await supabase
      .from('hojas_evaluacion')
      .select('id, roster_congelado, indicadores')
      .eq('id', proyecto.hoja_id)
      .maybeSingle()
    if (errorHoja) {
      return NextResponse.json({ error: 'No se pudo verificar la hoja de evaluación.' }, { status: 500 })
    }
    if (!hoja) {
      return NextResponse.json({ error: 'Hoja de evaluación no encontrada.' }, { status: 404 })
    }
    const rosterCongelado = hoja.roster_congelado as AlumnoRosterCongelado[] | null
    if (!rosterCongelado || rosterCongelado.length === 0) {
      return NextResponse.json({ error: 'Esta hoja no tiene registro de alumnos congelado y no admite esta consulta.' }, { status: 409 })
    }
    const indicadoresCongelados = hoja.indicadores as IndicadorCongelado[]

    // Query 3 — la ÚNICA lectura real nueva de esta fase: la tabla
    // académica canónica, filtrada EXCLUSIVAMENTE por este proyecto —
    // nunca otro proyecto, grupo o ciclo (proyecto_id ya los resuelve
    // de forma unívoca, mismo criterio de aislamiento que el resto de
    // esta familia de endpoints). NUNCA captura_pendiente.
    const { data: filasConfirmadas, error: errorResultados } = await supabase
      .from('seguimiento_resultados')
      .select('inscripcion_id, indicador_numero, nivel')
      .eq('proyecto_id', proyectoId)
    if (errorResultados) {
      return NextResponse.json({ error: 'No se pudieron recuperar los resultados confirmados.' }, { status: 500 })
    }

    const matriz = construirMatrizResultadosConfirmados((filasConfirmadas ?? []) as FilaResultadoConfirmadoLectura[], rosterCongelado, indicadoresCongelados)

    return NextResponse.json({ matriz })
  } catch (err) {
    console.error(`Error en GET /api/proyectos-seguimiento/${proyectoId}/resultados-confirmados:`, err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error inesperado.' }, { status: 500 })
  }
}
