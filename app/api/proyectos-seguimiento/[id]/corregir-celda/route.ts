import { NextRequest, NextResponse } from 'next/server'
import { autenticarRequestApi } from '@/lib/server/authApi'
import { esCeldaBloqueante, contarCeldasBloqueantes } from '@/lib/seguimiento/confirmarResultadosHoja'
import type { ResultadoExtraccionHojaEvaluacion, CeldaHojaEvaluacion } from '@/lib/seguimiento/analisisHojaEvaluacion'
import { CANTIDAD_INDICADORES_HOJA } from '@/lib/seguimiento/tipos'

export const runtime = 'nodejs'

// EVAL-1F — corrección manual de UNA celda de captura_pendiente.extraidoBruto,
// escrita por el propio docente en la pantalla de revisión. Nunca toca
// seguimiento_resultados (esa tabla académica canónica solo se escribe
// en confirmar-hoja/route.ts) — esto solo actualiza el scratch/staging
// area ya diseñado en EVAL-1B, exactamente igual que analizar-hoja/route.ts
// lo hace con la transcripción de la IA. 0 llamadas IA: una corrección
// manual es, por definición, lo opuesto a una lectura automática.
//
// Al marcar corregidoManualmente=true, esta celda deja de poder
// bloquear la confirmación (ver esCeldaBloqueante en
// confirmarResultadosHoja.ts) — es la única forma en que una hoja con
// lecturas ambiguas puede llegar a confirmarse.

const REGEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const ESTADOS_POST_CONFIRMACION = new Set(['confirmado', 'corregido', 'sustituido', 'cerrado'])

type CapturaPendiente = Record<string, unknown> | null

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: proyectoId } = await params
  try {
    if (!REGEX_UUID.test(proyectoId)) {
      return NextResponse.json({ error: 'Identificador de proyecto inválido.' }, { status: 400 })
    }

    const { access_token: accessToken, posicion, numeroIndicador, nivel } = (await req.json()) as {
      access_token: string
      posicion: number
      numeroIndicador: number
      nivel: number | null
    }

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

    if (!Number.isInteger(posicion) || posicion < 1) {
      return NextResponse.json({ error: 'Posición inválida.' }, { status: 400 })
    }
    if (!Number.isInteger(numeroIndicador) || numeroIndicador < 1 || numeroIndicador > CANTIDAD_INDICADORES_HOJA) {
      return NextResponse.json({ error: 'Número de indicador inválido.' }, { status: 400 })
    }
    if (nivel !== null && (!Number.isInteger(nivel) || nivel < 1 || nivel > 4)) {
      return NextResponse.json({ error: 'El nivel debe ser 1, 2, 3, 4, o null (no evaluado).' }, { status: 400 })
    }

    const { data: proyecto, error: errorProyecto } = await supabase
      .from('proyectos_seguimiento')
      .select('id, docente_id, estado, captura_pendiente')
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
    // Misma ventana que confirmar-hoja: una vez confirmado (o en
    // cualquier estado posterior), los resultados reales ya viven en
    // seguimiento_resultados — corregir captura_pendiente después de
    // eso no tendría ningún efecto real y daría una falsa sensación de
    // haber corregido algo.
    if (proyecto.estado !== 'requiere_revision') {
      if (ESTADOS_POST_CONFIRMACION.has(proyecto.estado)) {
        return NextResponse.json({ error: 'Esta hoja ya fue confirmada; no se puede corregir desde aquí.' }, { status: 409 })
      }
      return NextResponse.json({ error: 'Esta hoja todavía no tiene un análisis pendiente de revisión.' }, { status: 409 })
    }

    const capturaPendiente = (proyecto.captura_pendiente as CapturaPendiente) ?? null
    const extraidoBruto = capturaPendiente?.extraidoBruto as ResultadoExtraccionHojaEvaluacion | undefined
    if (!extraidoBruto || !Array.isArray(extraidoBruto.filas)) {
      return NextResponse.json({ error: 'Esta hoja todavía no tiene ningún análisis para corregir.' }, { status: 409 })
    }

    const indiceFila = extraidoBruto.filas.findIndex((f) => f.posicion === posicion)
    if (indiceFila === -1) {
      return NextResponse.json({ error: 'Esa posición no existe en la transcripción de esta hoja.' }, { status: 404 })
    }
    const indiceCelda = extraidoBruto.filas[indiceFila].celdas.findIndex((c) => c.numeroIndicador === numeroIndicador)
    if (indiceCelda === -1) {
      return NextResponse.json({ error: 'Ese indicador no existe en la transcripción de esa fila.' }, { status: 404 })
    }

    // Reemplaza ÚNICAMENTE la celda corregida — el resto de la
    // transcripción (todas las demás filas/celdas, incluidas otras ya
    // corregidas antes) se conserva intacto. nivel!==null se convierte
    // en fila('nivel'), nivel===null en 'no_evaluado' — nunca se
    // aproxima ni se infiere, es exactamente lo que el docente eligió.
    const celdaCorregida: CeldaHojaEvaluacion = {
      numeroIndicador,
      lectura: nivel === null ? { estado: 'no_evaluado' } : { estado: 'nivel', nivel: nivel as 1 | 2 | 3 | 4 },
      // El docente es ahora la fuente directa de este dato — no una
      // lectura de la IA — así que su confianza siempre es 'alta'.
      confianza: 'alta',
      dudoso: false,
      corregidoManualmente: true,
    }
    const filasActualizadas = extraidoBruto.filas.map((fila, i) => {
      if (i !== indiceFila) return fila
      return {
        ...fila,
        celdas: fila.celdas.map((celda, j) => (j === indiceCelda ? celdaCorregida : celda)),
      }
    })
    const extraidoBrutoActualizado: ResultadoExtraccionHojaEvaluacion = { ...extraidoBruto, filas: filasActualizadas }

    const { error: errorUpdate } = await supabase
      .from('proyectos_seguimiento')
      .update({
        captura_pendiente: { ...capturaPendiente, extraidoBruto: extraidoBrutoActualizado },
        actualizado_en: new Date().toISOString(),
      })
      .eq('id', proyectoId)
    if (errorUpdate) {
      return NextResponse.json({ error: 'No se pudo guardar la corrección. Intenta de nuevo.' }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      celda: {
        posicion,
        numeroIndicador,
        lectura: celdaCorregida.lectura,
        confianza: celdaCorregida.confianza,
        bloqueante: esCeldaBloqueante(celdaCorregida),
        corregidoManualmente: true,
      },
      totalBloqueantes: contarCeldasBloqueantes(extraidoBrutoActualizado),
    })
  } catch (err) {
    console.error(`Error en POST /api/proyectos-seguimiento/${proyectoId}/corregir-celda:`, err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error inesperado.' }, { status: 500 })
  }
}
