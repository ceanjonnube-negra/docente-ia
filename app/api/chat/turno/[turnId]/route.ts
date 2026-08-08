// app/api/chat/turno/[turnId]/route.ts
//
// ARQUITECTURA DURABLE — Vercel Workflow + turnos_chat (FASE 7): el
// cliente consulta este endpoint al reconectar (visibilitychange/
// pageshow/focus, ver AsistenteService.ts) en vez de asumir que la
// conexión que hizo el POST original sigue viva. Nunca devuelve
// turnos de otro docente (RLS "solo titular" real, mismo access_token
// del docente — nunca service_role) ni ningún dato interno del
// modelo/proveedor.

import { NextRequest, NextResponse } from 'next/server'
import { autenticarRequestApi, extraerBearerToken } from '@/lib/server/authApi'
import { obtenerTurnoPorId } from '@/lib/turnosChat'

export const runtime = 'nodejs'

export async function GET(req: NextRequest, { params }: { params: Promise<{ turnId: string }> }) {
  try {
    const { turnId } = await params
    const REGEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (!REGEX_UUID.test(turnId)) {
      return NextResponse.json({ error: 'Identificador de turno inválido.' }, { status: 400 })
    }

    const accessToken = extraerBearerToken(req)
    const auth = await autenticarRequestApi(accessToken)
    if (!auth.ok) {
      return NextResponse.json({ error: auth.mensaje }, { status: auth.status })
    }

    // select('*') + RLS ("solo titular", docente_id = auth.uid()) es
    // lo que de verdad impide devolver el turno de otro docente — un
    // turno ajeno simplemente no aparece en el resultado (fila
    // filtrada por Postgres, no por una comprobación en este código).
    const turno = await obtenerTurnoPorId(auth.supabase, turnId)
    if (!turno || turno.docenteId !== auth.user.id) {
      return NextResponse.json({ error: 'Turno no encontrado.' }, { status: 404 })
    }

    return NextResponse.json({
      id: turno.id,
      estado: turno.estado,
      textoParcial: turno.textoParcial,
      textoFinal: turno.textoFinal,
      archivos: turno.archivos,
      error: turno.error,
      actualizadoEn: turno.actualizadoEn,
    })
  } catch (err) {
    console.error('Error en GET /api/chat/turno/[turnId]:', err)
    return NextResponse.json({ error: 'No fue posible consultar el turno.' }, { status: 500 })
  }
}
