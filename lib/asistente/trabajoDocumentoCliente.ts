// lib/asistente/trabajoDocumentoCliente.ts
//
// Ver "corrección: timeout en documentos ilustrados largos" — lado
// CLIENTE del trabajo asíncrono de generación de documentos.
// AsistenteService usa estas funciones para (a) iniciar un trabajo
// (POST /api/chat/trabajo-documento — nunca espera a que la generación
// termine) y (b) consultar su estado al reconectar (GET .../[trabajoId]).
// También guarda/lee el puntero al trabajo activo en localStorage —
// así "el docente cierra Safari por completo y lo vuelve a abrir
// minutos después" también se recupera, no solo una suspensión breve
// en la misma pestaña.
//
// Alcance: solo se usa para documentos ilustrados/multi-formato (ver
// AsistenteService.deberiaUsarTrabajoAsincrono) — un mensaje normal
// sigue exactamente el camino síncrono de siempre, sin pasar por aquí.

import { obtenerPerfilYSesion, construirInstrucciones } from './perfilDocente'
import { obtenerZonaHorariaDispositivo } from '@/lib/tiempo/TimeService'
import type { ArchivoGeneradoInfo, ContextoAplicacion } from './tipos'

const CLAVE_TRABAJO_ACTIVO = 'docente-ia:trabajo-documento-activo'

export type TrabajoDocumentoActivoGuardado = {
  trabajoId: string
  requestId: string
  conversacionId: string | null
}

export type EstadoTrabajoConsultado = {
  id: string
  estado: 'queued' | 'generando' | 'completado' | 'fallido'
  resultado: { archivos: ArchivoGeneradoInfo[]; mensaje: string; contenidoOriginal?: string } | null
  error: string | null
  actualizadoEn: string
}

export function guardarTrabajoActivo(valor: TrabajoDocumentoActivoGuardado) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(CLAVE_TRABAJO_ACTIVO, JSON.stringify(valor))
  } catch {
    // cuota llena u otro fallo de almacenamiento — nunca debe romper el envío
  }
}

export function leerTrabajoActivo(): TrabajoDocumentoActivoGuardado | null {
  if (typeof window === 'undefined') return null
  try {
    const crudo = window.localStorage.getItem(CLAVE_TRABAJO_ACTIVO)
    if (!crudo) return null
    return JSON.parse(crudo) as TrabajoDocumentoActivoGuardado
  } catch {
    return null
  }
}

export function limpiarTrabajoActivo() {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(CLAVE_TRABAJO_ACTIVO)
  } catch {
    // no crítico
  }
}

export function generarRequestId(): string {
  return crypto.randomUUID()
}

type TrabajoHistorialSimple = { rol: 'usuario' | 'asistente' | 'herramienta'; texto: string }

// Inicia el trabajo — crea/recupera el trabajoId (idempotente por
// requestId) y arranca la generación real en el servidor; NUNCA espera
// a que termine. Lanza si la sesión no es válida o si el servidor
// rechaza la creación del trabajo (fallo real, no una desconexión —
// eso ni siquiera puede pasar en un POST que responde en milisegundos).
export async function iniciarTrabajoDocumento(
  mensaje: string,
  contexto: ContextoAplicacion,
  historialMensajes: TrabajoHistorialSimple[],
  requestId: string,
  institucionId: string | null,
  // Edición/regeneración de imagen existente (ver "recuperación robusta
  // de generación de imágenes — ediciones") — mismo contrato inline
  // {assetIdAnterior} que ya usa motorTextoClaude.ts/AsistenteService.ts
  // para el camino síncrono, nunca un tipo nuevo. Ausente para
  // documentos e imágenes NUEVAS — mismo comportamiento de siempre.
  regenerarImagen?: { assetIdAnterior: string }
): Promise<{ trabajoId: string; estado: string }> {
  const { user, session, perfil } = await obtenerPerfilYSesion()
  if (!user || !session?.access_token) throw new Error('Sesión no encontrada.')

  const contextoTexto = construirInstrucciones(perfil, contexto)
  const historial = historialMensajes
    .filter((m) => m.rol === 'usuario' || m.rol === 'asistente')
    .map((m) => ({ role: m.rol === 'usuario' ? ('user' as const) : ('assistant' as const), content: m.texto }))

  const res = await fetch('/api/chat/trabajo-documento', {
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
      regenerarImagen: regenerarImagen || undefined,
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
  if (!data?.trabajoId) throw new Error('El servidor no devolvió un identificador de trabajo.')
  return { trabajoId: data.trabajoId, estado: data.estado }
}

// Consulta el estado real del trabajo. Nunca lanza por un trabajo que
// ya no existe/no pertenece al docente: lo trata como "fallido"
// honesto en vez de un error técnico crudo.
export async function consultarTrabajo(trabajoId: string, accessToken: string): Promise<EstadoTrabajoConsultado> {
  const res = await fetch(`/api/chat/trabajo-documento/${trabajoId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    return {
      id: trabajoId,
      estado: 'fallido',
      resultado: null,
      error: res.status === 404 ? 'No se encontró el trabajo solicitado.' : 'No fue posible consultar el estado del trabajo.',
      actualizadoEn: new Date().toISOString(),
    }
  }
  return res.json()
}
