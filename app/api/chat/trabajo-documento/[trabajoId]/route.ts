// app/api/chat/trabajo-documento/[trabajoId]/route.ts
//
// Ver "corrección: timeout en documentos ilustrados largos" — consulta
// el estado real de un trabajo (ver POST /api/chat/trabajo-documento).
// Autenticado, con RLS (docente_id = auth.uid()) — nunca devuelve el
// trabajo de otro docente, nunca usa service_role.

import { NextRequest, NextResponse } from 'next/server'
import { autenticarRequestApi, extraerBearerToken } from '@/lib/server/authApi'
import { obtenerTrabajoPorId } from '@/lib/trabajosDocumento'

export async function GET(req: NextRequest, { params }: { params: Promise<{ trabajoId: string }> }) {
  const { trabajoId } = await params
  const accessToken = extraerBearerToken(req)
  const auth = await autenticarRequestApi(accessToken)
  if (!auth.ok) return NextResponse.json({ error: auth.mensaje }, { status: auth.status })

  const trabajo = await obtenerTrabajoPorId(auth.supabase, trabajoId)
  if (!trabajo) return NextResponse.json({ error: 'No se encontró el trabajo solicitado.' }, { status: 404 })
  if (trabajo.docenteId !== auth.user.id) return NextResponse.json({ error: 'No se encontró el trabajo solicitado.' }, { status: 404 })

  return NextResponse.json({
    id: trabajo.id,
    estado: trabajo.estado,
    resultado: trabajo.resultado,
    error: trabajo.error,
    actualizadoEn: trabajo.actualizadoEn,
  })
}
