import { NextRequest, NextResponse } from 'next/server'
import { autenticarRequestApi } from '@/lib/server/authApi'
import { prepararResultadosConfirmacion } from '@/lib/seguimiento/confirmarResultadosHoja'
import type { ResultadoExtraccionHojaEvaluacion } from '@/lib/seguimiento/analisisHojaEvaluacion'
import type { AlumnoRosterCongelado, IndicadorCongelado } from '@/lib/seguimiento/tipos'

export const runtime = 'nodejs'

// EVAL-1E — confirmación real de los resultados ya transcritos en
// EVAL-1D/EVAL-1D.2 (captura_pendiente.extraidoBruto). Esta es la
// ÚNICA fase de todo el flujo que escribe en seguimiento_resultados
// (la tabla académica canónica) y que marca el proyecto como
// 'confirmado' — hasta aquí, todo lo demás (fotografía, análisis
// visual) vivía solo en captura_pendiente, un scratch/staging area
// explícitamente no canónico (ver informe EVAL-1B).
//
// Alcance cerrado de esta microfase (decisión explícita, ver
// conversación EVAL-1E): SOLO backend, sin ninguna pantalla de
// corrección todavía. Dos reglas fail-closed, aplicadas por la lógica
// pura de lib/seguimiento/confirmarResultadosHoja.ts, bloquean la
// confirmación COMPLETA (nunca parcial):
//   1. Si la transcripción no cubrió TODOS los alumnos del roster
//      congelado (menos filas que alumnos).
//   2. Si CUALQUIER celda quedó con lectura ambigua ('lectura_dudosa')
//      o con un nivel de confianza no-alta — una celda 'no_evaluado'
//      NUNCA bloquea, es un valor real del sistema, no una lectura
//      fallida.
// Mientras cualquiera de esas dos condiciones exista, la hoja
// simplemente no puede confirmarse — no hay todavía ninguna vía de
// corrección manual (fase futura).
//
// 0 llamadas IA en este endpoint — toda la lógica es determinista,
// sobre datos que EVAL-1D ya extrajo y validó una vez.

const REGEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type CapturaPendiente = { extraidoBruto?: unknown } | null

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
    // Único estado del que se puede confirmar — cubre en un solo gate
    // tanto "todavía no se analizó ninguna fotografía" como "ya está
    // confirmado" (o cualquier estado posterior) y "el análisis quedó
    // en un estado intermedio inesperado". Nunca se re-confirma un
    // proyecto ya confirmado.
    if (proyecto.estado !== 'requiere_revision') {
      return NextResponse.json(
        { error: 'Esta hoja no está lista para confirmarse (debe tener un análisis pendiente de revisión).' },
        { status: 409 }
      )
    }
    if (!proyecto.hoja_id) {
      return NextResponse.json({ error: 'Este proyecto todavía no tiene una hoja de evaluación generada.' }, { status: 409 })
    }

    const capturaPendiente = (proyecto.captura_pendiente as CapturaPendiente) ?? null
    // extraidoBruto es exclusivamente escrito por analizar-hoja/route.ts
    // con la forma exacta de ResultadoExtraccionHojaEvaluacion (ya
    // validada una vez ahí) — mismo criterio "de confianza por
    // construcción" ya aplicado a roster_congelado/indicadores en el
    // resto de este flujo (ver analizar-hoja/route.ts, foto-hoja/route.ts).
    const extraidoBruto = capturaPendiente?.extraidoBruto as ResultadoExtraccionHojaEvaluacion | undefined
    if (!extraidoBruto || !Array.isArray(extraidoBruto.filas) || extraidoBruto.filas.length === 0) {
      return NextResponse.json({ error: 'Esta hoja todavía no tiene ningún análisis para confirmar.' }, { status: 409 })
    }

    // EVAL-1B — fail-closed: sin roster_congelado no existe una
    // identidad determinista de alumno×posición — misma regla ya
    // aplicada en foto-hoja/route.ts y analizar-hoja/route.ts.
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
      return NextResponse.json({ error: 'Esta hoja fue generada antes de que existiera el registro de alumnos congelado y no admite confirmación automática.' }, { status: 409 })
    }
    const indicadoresCongelados = hoja.indicadores as IndicadorCongelado[]

    let filas
    try {
      filas = prepararResultadosConfirmacion(proyectoId, extraidoBruto, rosterCongelado, indicadoresCongelados)
    } catch (e) {
      // Fail-closed: cualquier violación de las 2 reglas cerradas
      // (cobertura incompleta, celda bloqueante) rechaza TODA la
      // confirmación — nunca se escribe un subconjunto.
      return NextResponse.json({ error: e instanceof Error ? e.message : 'No se pudo preparar la confirmación de esta hoja.' }, { status: 409 })
    }

    // upsert (no insert plano): si un intento previo ya escribió estas
    // filas pero la siguiente actualización de estado falló (ver
    // abajo), un reintento del mismo POST nunca choca con
    // seguimiento_resultados_proyecto_inscripcion_indicador_key — vuelve
    // a escribir exactamente los mismos valores, de forma segura.
    const { error: errorInsert } = await supabase
      .from('seguimiento_resultados')
      .upsert(filas, { onConflict: 'proyecto_id,inscripcion_id,indicador_numero' })
    if (errorInsert) {
      return NextResponse.json({ error: 'No se pudieron guardar los resultados. Intenta de nuevo.' }, { status: 500 })
    }

    const { error: errorUpdate } = await supabase
      .from('proyectos_seguimiento')
      .update({
        estado: 'confirmado',
        confirmado_en: new Date().toISOString(),
        confirmado_por: docenteId,
        origen_resultados: 'fotografia',
        actualizado_en: new Date().toISOString(),
      })
      .eq('id', proyectoId)
    if (errorUpdate) {
      // Los resultados YA se guardaron (upsert de arriba) — un
      // reintento de este mismo POST es seguro (el upsert no
      // duplicará nada) y volverá a intentar únicamente este UPDATE.
      return NextResponse.json({ error: 'Los resultados se guardaron pero no se pudo marcar la hoja como confirmada. Intenta de nuevo.' }, { status: 500 })
    }

    return NextResponse.json({ ok: true, estado: 'confirmado', resultados: filas.length })
  } catch (err) {
    console.error(`Error en POST /api/proyectos-seguimiento/${proyectoId}/confirmar-hoja:`, err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error inesperado.' }, { status: 500 })
  }
}
