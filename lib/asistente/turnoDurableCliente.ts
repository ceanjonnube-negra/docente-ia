// lib/asistente/turnoDurableCliente.ts
//
// ARQUITECTURA DURABLE — Vercel Workflow + turnos_chat: lado CLIENTE.
// AsistenteService usa estas funciones para (a) iniciar un turno
// durable (POST /api/chat con requestId — nunca espera a que termine
// la generación completa) y (b) consultar su estado al reconectar
// (GET /api/chat/turno/[turnoId]). También guarda/lee el puntero al
// turno activo en localStorage — así "el docente cierra Safari por
// completo y lo vuelve a abrir minutos después" también se recupera,
// no solo una suspensión breve en la misma pestaña.
//
// Alcance V1 (ver informe de la implementación): solo cubre el
// mensaje de texto simple. El motor de voz y los mensajes con imagen
// adjunta siguen exactamente el camino síncrono existente, sin pasar
// por aquí.

import { obtenerPerfilYSesion, construirInstrucciones } from './perfilDocente'
import { obtenerZonaHorariaDispositivo } from '@/lib/tiempo/TimeService'
import type { ArchivoGeneradoInfo, ContextoAplicacion } from './tipos'

const CLAVE_TURNO_ACTIVO = 'docente-ia:turno-activo'

export type TurnoActivoGuardado = {
  turnoId: string
  requestId: string
  conversacionId: string | null
}

export type EstadoTurnoConsultado = {
  id: string
  estado: 'queued' | 'generating' | 'completed' | 'failed'
  textoParcial: string
  textoFinal: string | null
  archivos: ArchivoGeneradoInfo[]
  error: string | null
  actualizadoEn: string
}

export function guardarTurnoActivo(valor: TurnoActivoGuardado) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(CLAVE_TURNO_ACTIVO, JSON.stringify(valor))
  } catch {
    // cuota llena u otro fallo de almacenamiento — nunca debe romper el envío
  }
}

export function leerTurnoActivo(): TurnoActivoGuardado | null {
  if (typeof window === 'undefined') return null
  try {
    const crudo = window.localStorage.getItem(CLAVE_TURNO_ACTIVO)
    if (!crudo) return null
    return JSON.parse(crudo) as TurnoActivoGuardado
  } catch {
    return null
  }
}

export function limpiarTurnoActivo() {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(CLAVE_TURNO_ACTIVO)
  } catch {
    // no crítico
  }
}

// Genera un request_id real (idempotencia — FASE 3) — crypto.randomUUID()
// ya está disponible en todos los navegadores que soportan WebRTC
// (requisito del modo voz), así que no hace falta un polyfill nuevo.
export function generarRequestId(): string {
  return crypto.randomUUID()
}

type TurnoHistorialSimple = { rol: 'usuario' | 'asistente' | 'herramienta'; texto: string }

// Inicia un turno durable — crea/recupera el turnId (idempotente por
// requestId) y arranca el Workflow en el servidor; NUNCA espera a que
// la generación termine. Lanza si la sesión no es válida o si el
// servidor rechaza la creación del turno (fallo real, no una
// desconexión — eso ni siquiera puede pasar en un POST que responde
// en milisegundos).
export async function iniciarTurnoDurable(
  mensaje: string,
  contexto: ContextoAplicacion,
  historialMensajes: TurnoHistorialSimple[],
  requestId: string,
  institucionId: string | null
): Promise<{ turnoId: string; estado: string }> {
  const { user, session, perfil } = await obtenerPerfilYSesion()
  if (!user || !session?.access_token) throw new Error('Sesión no encontrada.')

  const contextoTexto = construirInstrucciones(perfil, contexto)
  const historial = historialMensajes
    .filter((m) => m.rol === 'usuario' || m.rol === 'asistente')
    .map((m) => ({ role: m.rol === 'usuario' ? ('user' as const) : ('assistant' as const), content: m.texto }))

  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mensaje,
      historial,
      contexto: contextoTexto,
      institucionId: institucionId || perfil?.institucion_id || null,
      userId: user.id,
      accessToken: session.access_token,
      zonaHoraria: obtenerZonaHorariaDispositivo(),
      requestId,
    }),
  })
  if (!res.ok) {
    const detalle = await res.text().catch(() => '')
    let mensajeError = 'No fue posible iniciar la generación en este momento. Intenta de nuevo.'
    try {
      const cuerpo = JSON.parse(detalle)
      if (typeof cuerpo?.error === 'string' && cuerpo.error.trim()) mensajeError = cuerpo.error
    } catch {
      // cuerpo no era JSON — se usa el mensaje genérico
    }
    throw new Error(mensajeError)
  }
  const data = await res.json()
  if (!data?.turnoId) throw new Error('El servidor no devolvió un identificador de turno.')
  return { turnoId: data.turnoId, estado: data.estado }
}

// FASE 7 — consulta el estado real del turno. Nunca lanza por un
// turno que ya no existe/no pertenece al docente: lo trata como
// "failed" honesto en vez de un error técnico crudo.
export async function consultarTurno(turnoId: string, accessToken: string): Promise<EstadoTurnoConsultado> {
  const res = await fetch(`/api/chat/turno/${turnoId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    return {
      id: turnoId,
      estado: 'failed',
      textoParcial: '',
      textoFinal: null,
      archivos: [],
      error: res.status === 404 ? 'No se encontró el turno solicitado.' : 'No fue posible consultar el estado del turno.',
      actualizadoEn: new Date().toISOString(),
    }
  }
  return res.json()
}
