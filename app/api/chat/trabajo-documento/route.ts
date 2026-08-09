// app/api/chat/trabajo-documento/route.ts
//
// Ver "corrección: timeout en documentos ilustrados largos" — generar
// una guía ilustrada + Word + PDF puede tardar (Claude redactando +
// hasta 4 ilustraciones reales, ~15-20s cada una) más de lo que
// Safari/iPhone espera en una sola respuesta bloqueante
// (TIMEOUT_FETCH_DOCUMENTO_MS=130s en el cliente). Este endpoint
// responde EN MILISEGUNDOS con un trabajoId — la generación real
// sigue corriendo en segundo plano vía after() (sobrevive a que el
// navegador se desconecte, ver Next.js after()), y el cliente consulta
// el resultado por polling (ver GET /api/chat/trabajo-documento/[trabajoId]
// y lib/asistente/trabajoDocumentoCliente.ts).
//
// Deliberadamente NO usa turnos_chat/Vercel Workflow (arquitectura de
// test/chat-durable-v1, rama que no se mezcla con esta) — after() es
// suficiente aquí: el trabajo tiene un techo de tiempo real
// (maxDuration de esta misma función, 180s) en vez de la durabilidad
// sin límite que sí necesita el chat completo. No introduce ninguna
// dependencia nueva.
//
// REUTILIZA el 100% de la lógica de generación existente en
// app/api/chat/route.ts (CASO 3: Claude + MODO DOCUMENTO/MODO
// DOCUMENTO ILUSTRADO + ejecutarHerramientaDocumento) — este endpoint
// NUNCA la duplica: hace una llamada HTTP interna al MISMO endpoint
// /api/chat (con el mismo body que ya mandaba el cliente), server-a-
// servidor, inmune a que el navegador del docente desaparezca, y
// consume su respuesta hasta el final.

import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { autenticarRequestApi } from '@/lib/server/authApi'
import { crearOTrabajoRecuperarPorRequestId, marcarGenerando, marcarCompletado, marcarFallido } from '@/lib/trabajosDocumento'

export const maxDuration = 180

// Misma extracción que procesarMarcadorDeArchivo/procesarMarcadorDeContenido
// (privados en motorTextoClaude.ts, solo cliente) — se repite aquí,
// server-only, porque no hay un módulo compartido de marcadores en
// esta rama (esa extracción vive en test/chat-durable-v1, rama que no
// se mezcla con esta). Pura, sin dependencias. contenidoOriginal es el
// texto REAL del documento (ver [[DOCUMENTO_CONTENIDO:...]] en CASO 3)
// — sin él, el cliente no podría fijar documentoActivo.texto para
// ediciones futuras.
function extraerArchivosDeRespuesta(respuesta: string): { texto: string; archivos: unknown[]; contenidoOriginal?: string } {
  const regexArchivo = /\[\[DOCUMENTO_ARCHIVO:([^\]]+)\]\]/g
  const archivos: unknown[] = []
  let texto = respuesta
  let match: RegExpExecArray | null
  while ((match = regexArchivo.exec(respuesta)) !== null) {
    try {
      archivos.push(JSON.parse(Buffer.from(match[1], 'base64').toString('utf-8')))
    } catch {
      // marcador corrupto — se quita del texto igual, sin adjuntar nada por él
    }
    texto = texto.replace(match[0], '')
  }
  let contenidoOriginal: string | undefined
  const matchContenido = texto.match(/\[\[DOCUMENTO_CONTENIDO:([^\]]+)\]\]/)
  if (matchContenido) {
    try {
      contenidoOriginal = Buffer.from(matchContenido[1], 'base64').toString('utf-8')
    } catch {
      // marcador corrupto — se ignora, documentoActivo simplemente no se fija
    }
    texto = texto.replace(matchContenido[0], '')
  }
  return { texto: texto.trim(), archivos, contenidoOriginal }
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { mensaje, historial, contexto, institucionId, userId: userIdCliente, accessToken, zonaHoraria, requestId } = body

  if (typeof requestId !== 'string' || !requestId) {
    return NextResponse.json({ error: 'Falta requestId.' }, { status: 400 })
  }

  const auth = await autenticarRequestApi(accessToken)
  if (!auth.ok) return NextResponse.json({ error: auth.mensaje }, { status: auth.status })

  const conversacionId = typeof contexto?.conversacionId === 'string' ? contexto.conversacionId : null

  let trabajo: Awaited<ReturnType<typeof crearOTrabajoRecuperarPorRequestId>>['trabajo']
  try {
    const resultado = await crearOTrabajoRecuperarPorRequestId(auth.supabase, auth.user.id, conversacionId, requestId)
    trabajo = resultado.trabajo
    // Idempotencia real (doble tap, reconexión que reenvía el mismo
    // POST): si el trabajo ya existía, NUNCA se vuelve a arrancar la
    // generación — se devuelve el trabajoId existente tal cual.
    if (resultado.yaExistia) return NextResponse.json({ trabajoId: trabajo.id, estado: trabajo.estado })
  } catch (e) {
    console.error('[TRABAJO_DOCUMENTO] Fallo creando el trabajo:', e)
    return NextResponse.json({ error: 'No fue posible iniciar la generación en este momento. Intenta de nuevo.' }, { status: 502 })
  }

  const baseUrl = req.nextUrl.origin
  const trabajoId = trabajo.id

  // El trabajo real corre DESPUÉS de que esta respuesta ya se mandó —
  // sigue vivo aunque el docente cierre Safari o pierda la conexión
  // (ver Next.js after()). auth.supabase/accessToken quedan en el
  // closure, nunca se escriben en la base de datos.
  after(async () => {
    try {
      await marcarGenerando(auth.supabase, trabajoId)
      const res = await fetch(new URL('/api/chat', baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mensaje,
          historial,
          contexto,
          institucionId,
          userId: userIdCliente,
          accessToken,
          zonaHoraria,
        }),
      })
      if (!res.ok) {
        const detalle = await res.text().catch(() => '')
        throw new Error(`/api/chat interno respondió ${res.status}: ${detalle.slice(0, 300)}`)
      }
      const cuerpoCompleto = await res.text()
      const { texto, archivos, contenidoOriginal } = extraerArchivosDeRespuesta(cuerpoCompleto)
      await marcarCompletado(auth.supabase, trabajoId, { archivos, mensaje: texto, contenidoOriginal })
    } catch (err) {
      const mensajeError = err instanceof Error ? err.message : 'Error desconocido generando el documento.'
      console.error(`[TRABAJO_DOCUMENTO] Falló el trabajo ${trabajoId}:`, err)
      await marcarFallido(auth.supabase, trabajoId, mensajeError)
    }
  })

  return NextResponse.json({ trabajoId, estado: trabajo.estado })
}
