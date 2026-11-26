// POST /api/planeaciones/versiones/[id]/chat — «Continuar en el Chat IA»
// desde la pestaña Planeación (Hito 2, etapa 5c). Cuerpo: { conversacionId,
// modo: 'evaluar'|'abrir', zonaHoraria? }. Sesión por "Authorization:
// Bearer" (RLS del docente). Sin IA. Lógica: lib/planeacion/continuarEnChat.ts.
import { NextResponse } from 'next/server'
import { autenticarRequestApi, extraerBearerToken } from '@/lib/server/authApi'
import { firmarOriginalPropio } from '@/lib/planeacion/consultaPlaneaciones'
import { atenderContinuarEnChat, estadoHttpContinuar } from '@/lib/planeacion/continuarEnChat'

export const runtime = 'nodejs'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const cuerpo = await req.json().catch(() => null)
  const respuesta = await atenderContinuarEnChat(
    {
      autenticar: async (token) => {
        const auth = await autenticarRequestApi(token)
        return auth.ok ? { ok: true, docenteId: auth.user.id, sb: auth.supabase } : { ok: false }
      },
      firmar: firmarOriginalPropio,
    },
    { token: extraerBearerToken(req), versionId: id, cuerpo }
  )
  console.log(`[PLANEACION_CHAT] continuar: ${respuesta.estado} — sin IA`)
  return NextResponse.json(respuesta, { status: estadoHttpContinuar(respuesta), headers: { 'Cache-Control': 'no-store' } })
}
