import { NextRequest, NextResponse } from 'next/server'
import { autenticarRequestApi } from '@/lib/server/authApi'

export const runtime = 'nodejs'

// Consulta de un turno duradero del Chat IA (lib/chat/turnosChat.ts): por
// su requestId o el más reciente de una conversación propia. Solo lectura
// para el docente autenticado (consultar_turno_chat, RLS + auth.uid()); un
// turno cuya ejecución murió se cierra como interrumpido al consultarlo.
// Nunca vuelve a ejecutar nada ni llama a la IA.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REQUEST_ID = /^[A-Za-z0-9:_-]{8,200}$/

export async function POST(req: NextRequest) {
  const cuerpo = (await req.json().catch(() => null)) as { accessToken?: unknown; requestId?: unknown; conversacionId?: unknown } | null
  const requestId = typeof cuerpo?.requestId === 'string' && REQUEST_ID.test(cuerpo.requestId) ? cuerpo.requestId : null
  const conversacionId = typeof cuerpo?.conversacionId === 'string' && UUID.test(cuerpo.conversacionId) ? cuerpo.conversacionId : null
  if (!requestId && !conversacionId) return NextResponse.json({ error: 'Falta el turno a consultar.' }, { status: 400 })
  const auth = await autenticarRequestApi(typeof cuerpo?.accessToken === 'string' ? cuerpo.accessToken : null)
  if (!auth.ok) return NextResponse.json({ error: auth.mensaje }, { status: auth.status })
  const { data, error } = await auth.supabase.rpc('consultar_turno_chat', { p_request_id: requestId, p_conversacion_id: requestId ? null : conversacionId })
  if (error) {
    console.error('[TURNO] consulta no disponible:', error.message)
    return NextResponse.json({ error: 'No pude consultar la respuesta en este momento. Intenta de nuevo en unos segundos.' }, { status: 503 })
  }
  const resultado = data as { resultado: string; turno?: unknown }
  return NextResponse.json(resultado.resultado === 'encontrado' ? { turno: resultado.turno } : { turno: null }, { status: resultado.resultado === 'encontrado' ? 200 : 404 })
}
