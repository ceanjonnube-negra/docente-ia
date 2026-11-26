// POST /api/planeaciones/versiones/[id]/archivo — Word/PDF de una versión
// desde la pestaña Planeación (Hito 2, etapa 5b). Cuerpo: { formato:
// 'word'|'pdf', soloExistente?: boolean, zonaHoraria?: string }. Sesión por
// "Authorization: Bearer". Lógica: lib/planeacion/archivoVersionApi.ts.
import { NextResponse } from 'next/server'
import { autenticarRequestApi, extraerBearerToken } from '@/lib/server/authApi'
import { dependenciasArchivoVersion, obtenerArchivoDeVersion } from '@/lib/planeacion/archivosVersion'
import { clienteServidorArchivos } from '@/lib/documentGen/registroArchivos'
import { atenderArchivoVersion, estadoHttp } from '@/lib/planeacion/archivoVersionApi'

export const runtime = 'nodejs'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const cuerpo = await req.json().catch(() => null)
  const respuesta = await atenderArchivoVersion(
    {
      autenticar: async (token) => {
        const auth = await autenticarRequestApi(token)
        return auth.ok ? { ok: true, docenteId: auth.user.id, sb: auth.supabase } : { ok: false }
      },
      obtener: obtenerArchivoDeVersion,
      dependencias: () => dependenciasArchivoVersion(clienteServidorArchivos()),
    },
    { token: extraerBearerToken(req), versionId: id, cuerpo }
  )
  console.log(`[PLANEACION_ARCHIVO] pestaña: ${respuesta.estado}${'numero' in respuesta && respuesta.numero ? ` (versión ${respuesta.numero})` : ''}${respuesta.estado === 'archivo' ? (respuesta.generado ? ' generado' : ' original') : ''} — sin IA`)
  return NextResponse.json(respuesta, { status: estadoHttp(respuesta), headers: { 'Cache-Control': 'no-store' } })
}
