// app/workflows/generarTurnoChat.ts
//
// ARQUITECTURA DURABLE — Vercel Workflow + Supabase turnos_chat: el
// ejecutor que de verdad completa la generación del Chat IA
// INDEPENDIENTEMENTE de si Safari/iPhone sigue conectado. `after()`/
// `waitUntil()` se descartaron a propósito (quedan limitados al
// maxDuration de la misma invocación y no sobreviven un reciclado o
// redeploy de la función) — un Workflow de Vercel es una ejecución
// separada (cada paso "use step" es su propia invocación, orquestada
// por Vercel Queues + persistencia administrada), sin límite de
// duración total, que se reanuda exactamente donde quedó ante
// crashes o redeploys.
//
// REUTILIZA el 100% de la lógica de generación existente en
// app/api/chat/route.ts (Clasificador de Nivel 0, Herramientas, MODO
// DOCUMENTO, generación de documentos) — este Workflow NUNCA la
// duplica: el paso de generación hace una llamada HTTP interna al
// MISMO endpoint /api/chat (con `esTurnoInterno: true`, ver ese
// archivo), server-a-servidor, inmune a que el navegador del docente
// desaparezca — y consume su streaming existente hasta el final,
// exactamente como ya lo hacía el propio navegador.
//
// Alcance V1 (ver informe de la implementación): cubre el mensaje de
// texto simple (sin imagen adjunta, sin edición de documento activo,
// fuera del canal de voz) — el caso exacto reportado. No reintenta
// generar contenido si el turno ya quedó `completed` (ver el chequeo
// de estado en cada paso) — un reintento de un `step` nunca duplica
// el resultado final.

import { autenticarRequestApi } from '@/lib/server/authApi'
import {
  obtenerTurnoPorId,
  marcarGenerando,
  marcarCompletado,
  marcarFallido,
} from '@/lib/turnosChat'
import {
  procesarMarcadorDeArchivo,
  procesarMarcadorDeContenido,
  procesarMarcadorDeNavegacion,
} from '@/lib/asistente/marcadoresRespuesta'
import type { ArchivoGeneradoInfo } from '@/lib/asistente/tipos'

export type PayloadChatDurable = {
  mensaje: string
  historial: unknown
  contexto: unknown
  institucionId: string | null
  zonaHoraria: string | null
  finalizarArchivo: unknown
  esEdicionDocumento: boolean
  channel: string | undefined
}

// PASO 3 (FASE 5) — marcar generating. También cubre PASO 1/2 (cargar
// turno + validar idempotencia/estado): si el turno YA está
// `completed` (un reintento del propio paso, o el Workflow completo
// se reanuda tras un crash DESPUÉS de haber terminado), se detiene
// aquí sin volver a llamar a la IA — nunca regenera.
async function pasoValidarYMarcarGenerando(turnoId: string, accessToken: string): Promise<{ yaCompletado: boolean }> {
  'use step';
  const auth = await autenticarRequestApi(accessToken)
  if (!auth.ok) throw new Error(`Sesión inválida para el turno ${turnoId}: ${auth.mensaje}`)
  const turno = await obtenerTurnoPorId(auth.supabase, turnoId)
  if (!turno) throw new Error(`Turno ${turnoId} no encontrado`)
  if (turno.estado === 'completed') return { yaCompletado: true }
  await marcarGenerando(auth.supabase, turnoId)
  return { yaCompletado: false }
}

// PASO 4-6 (FASE 5) — generar respuesta con IA + clasificar/procesar
// resultado (marcadores) + documentos asociados (los documentos ya se
// generan DENTRO de la misma llamada a /api/chat, reutilizando
// ejecutarHerramientaDocumento — nunca un segundo generador aparte).
async function pasoGenerarYPersistir(
  turnoId: string,
  payload: PayloadChatDurable,
  accessToken: string,
  baseUrl: string
): Promise<void> {
  'use step';
  const auth = await autenticarRequestApi(accessToken)
  if (!auth.ok) throw new Error(`Sesión inválida para el turno ${turnoId}: ${auth.mensaje}`)

  // Defensa adicional contra un reintento tardío del propio paso —
  // mismo criterio que pasoValidarYMarcarGenerando: si ya terminó,
  // no se repite la llamada a la IA.
  const turnoActual = await obtenerTurnoPorId(auth.supabase, turnoId)
  if (turnoActual?.estado === 'completed') return

  let respuestaTexto: string
  try {
    const res = await fetch(new URL('/api/chat', baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        accessToken,
        esTurnoInterno: true,
      }),
    })
    if (!res.ok) {
      const detalle = await res.text().catch(() => '')
      throw new Error(`/api/chat interno respondió ${res.status}: ${detalle.slice(0, 300)}`)
    }
    const reader = res.body?.getReader()
    const decoder = new TextDecoder()
    let acumulado = ''
    if (reader) {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        acumulado += decoder.decode(value, { stream: true })
      }
    }
    respuestaTexto = acumulado
  } catch (err) {
    const mensajeError = err instanceof Error ? err.message : 'Error desconocido generando la respuesta.'
    await marcarFallido(auth.supabase, turnoId, mensajeError)
    throw err
  }

  // Mismo procesamiento de marcadores que ya usa motorTextoClaude.ts
  // (funciones puras compartidas, ver lib/asistente/marcadoresRespuesta.ts)
  // — nunca una segunda interpretación del texto crudo.
  const { texto: sinArchivo, archivos } = procesarMarcadorDeArchivo(respuestaTexto)
  const { texto: sinContenido } = procesarMarcadorDeContenido(sinArchivo)
  const { texto: textoLimpio } = procesarMarcadorDeNavegacion(sinContenido)

  const archivosFinales: ArchivoGeneradoInfo[] = archivos ?? []
  await marcarCompletado(auth.supabase, turnoId, textoLimpio, archivosFinales)
}

export async function generarTurnoChat(
  turnoId: string,
  payload: PayloadChatDurable,
  accessToken: string,
  baseUrl: string
): Promise<void> {
  'use workflow';
  const { yaCompletado } = await pasoValidarYMarcarGenerando(turnoId, accessToken)
  if (yaCompletado) return
  await pasoGenerarYPersistir(turnoId, payload, accessToken, baseUrl)
}
