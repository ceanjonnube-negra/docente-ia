import { NextRequest, NextResponse } from 'next/server'
import { autenticarRequestApi, extraerBearerToken } from '@/lib/server/authApi'
import { calcularCantidadPaginasHoja } from '@/lib/documentGen/generarHojaSeguimientoPdf'
import { extraerFotosCapturaPendiente } from '@/lib/seguimiento/analisisHojaEvaluacion'
import { determinarEstadoCapturaHoja } from '@/lib/seguimiento/estadoCapturaHoja'
import type { ResultadoExtraccionHojaEvaluacion } from '@/lib/seguimiento/analisisHojaEvaluacion'
import type { AlumnoRosterCongelado, IndicadorCongelado } from '@/lib/seguimiento/tipos'

export const runtime = 'nodejs'

// EVAL-1G — lectura de estado para CapturaHoja.tsx (tarjeta "Hoja de
// evaluación final" en el Chat). Distinto propósito que revisar-hoja
// (EVAL-1F): esa ruta exige que ya exista una transcripción (409 si
// no) porque su trabajo es dar la matriz completa para corregir. Esta
// ruta NUNCA exige nada — siempre responde 200 con un estado discreto
// (determinarEstadoCapturaHoja, lógica pura) que cubre TODO el ciclo
// de vida, incluso antes de que exista ninguna fotografía — para que
// el cliente jamás tenga que inferir un estado a partir de un código
// HTTP. Mismas 2 SELECT ya usadas en el resto de esta familia de
// rutas — 0 escrituras, 0 llamadas IA.

const REGEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type CapturaPendiente = { extraidoBruto?: unknown } | null

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
    if (!proyecto.hoja_id) {
      return NextResponse.json({ error: 'Este proyecto todavía no tiene una hoja de evaluación generada.' }, { status: 409 })
    }

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
      return NextResponse.json({ error: 'Esta hoja fue generada antes de que existiera el registro de alumnos congelado y no admite captura automática.' }, { status: 409 })
    }
    const indicadoresCongelados = hoja.indicadores as IndicadorCongelado[]

    const capturaPendiente = (proyecto.captura_pendiente as CapturaPendiente) ?? null
    const fotos = extraerFotosCapturaPendiente(capturaPendiente)
    const extraidoBruto = (capturaPendiente?.extraidoBruto as ResultadoExtraccionHojaEvaluacion | undefined) ?? null
    const paginasEsperadas = calcularCantidadPaginasHoja(rosterCongelado.length)

    const resultado = determinarEstadoCapturaHoja({
      estadoProyecto: proyecto.estado,
      paginasEsperadas,
      paginasCargadas: fotos.length,
      extraidoBruto,
      rosterCongelado,
      indicadoresCongelados,
    })

    return NextResponse.json(resultado)
  } catch (err) {
    console.error(`Error en GET /api/proyectos-seguimiento/${proyectoId}/estado-captura:`, err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error inesperado.' }, { status: 500 })
  }
}
