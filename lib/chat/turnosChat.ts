// lib/chat/turnosChat.ts
//
// Turnos duraderos del Chat IA (etapa del servidor). Cada envío de texto
// que /api/chat atiende es un turno de public.turnos_chat (migración
// 20261129000000):
//
// - Identidad: (docente, request_id) + conversación del mismo docente, su
//   grupo y el mensaje del docente que lo originó. La adquisición es
//   atómica (adquirir_turno_chat): el mismo envío nunca se ejecuta dos
//   veces y una conversación tiene un solo turno activo.
// - Durabilidad: la generación NO depende de que el dispositivo consuma el
//   stream. Un puente lee el stream original desde el servidor y reenvía
//   cada fragmento al cliente mientras siga conectado; after() mantiene viva
//   la función hasta que la respuesta completa queda guardada (dentro de la
//   duración máxima de la ruta). Si el cliente se desconecta, solo se deja
//   de reenviar.
// - Persistencia antes del cierre: el stream del cliente se cierra solo
//   después de completar_turno_chat (turno + mensaje del asistente con
//   protocolo >= 1 + metadatos del ajuste, en una transacción). Un resultado
//   que no se pudo guardar marca el turno como fallido.
// - Sin turnos eternos: el plazo (vence_en) supera la duración máxima de la
//   función; si la función muere, el turno vence y se cierra como
//   interrumpido al consultarlo. Completar o fallar exigen la misma
//   ejecución y rechazan una finalización tardía.
// - Recuperar ≠ reejecutar: un turno terminado se reproduce sin IA; uno
//   fallido o interrumpido solo se vuelve a ejecutar con un reintento
//   explícito del cliente (reintento_de). Nunca hay reintentos automáticos;
//   los efectos académicos conservan su propia idempotencia (p. ej. la
//   publicación de versiones por borrador_clave).
// - Compatibilidad: el cliente actual (sin requestId ni protocoloTurno)
//   recibe exactamente el mismo stream; el servidor no crea su mensaje (lo
//   guarda el cliente con su propio id). Si la infraestructura de turnos no
//   está disponible, /api/chat responde como siempre.
//
// Alcance de esta etapa: el flujo de texto. Imágenes, archivos por
// finalizar, entregas con formato y voz siguen sin turno.

import { createHash, randomUUID } from 'node:crypto'
import { after } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { marcadorTurno as marca, textoVisibleDeRespuesta } from '../asistente/textoFinalChat'
import { ejecutarEnTurno, type ContextoTurno } from './contextoTurno'

// Duración máxima de /api/chat (180 s) + margen: si el plazo pasó, la
// función que lo ejecutaba ya no existe.
export const PLAZO_TURNO_SEGUNDOS = 210
export const MENSAJE_CONVERSACION_OCUPADA = 'Todavía estoy terminando la respuesta anterior de esta conversación. Espera unos segundos y vuelve a enviarlo.'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REQUEST_ID = /^[A-Za-z0-9:_-]{8,200}$/

export type TurnoPublico = {
  id: string
  request_id: string
  conversacion_id: string
  grupo_id: string | null
  estado: 'queued' | 'generating' | 'completed' | 'failed'
  codigo_error: 'interrumpido' | 'error_generacion' | 'error_persistencia' | null
  texto_crudo: string | null
  texto_parcial: string | null
  mensaje_usuario_id: string | null
  mensaje_asistente_id: string | null
  reintento_de: string | null
  reintentable: boolean
  creado_en: string
  completado_en: string | null
}
type ResultadoAdquisicion = { resultado: string; turno?: TurnoPublico; ejecucion_id?: string }

export type CuerpoChat = {
  mensaje?: unknown
  accessToken?: unknown
  conversacionId?: unknown
  esEdicionDocumento?: unknown
  formatoEntrega?: unknown
  finalizarArchivo?: unknown
  imagenBase64?: unknown
  imagenesBase64?: unknown
  channel?: unknown
  requestId?: unknown
  mensajeUsuarioId?: unknown
  protocoloTurno?: unknown
  reintentoDe?: unknown
}

export type DependenciasTurno = {
  clienteDocente: (accessToken: string) => SupabaseClient
  clienteServidor: () => SupabaseClient | null
  // Mantiene viva la función hasta que la tarea termine (after()).
  despues: (tarea: () => Promise<unknown>) => void
}

let servidor: SupabaseClient | null = null
export const dependenciasReales: DependenciasTurno = {
  clienteDocente: (accessToken) => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  }),
  // service_role: la única que puede completar o fallar un turno.
  clienteServidor: () => {
    const llave = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!llave || !process.env.NEXT_PUBLIC_SUPABASE_URL) return null
    servidor ??= createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, llave, { auth: { persistSession: false, autoRefreshToken: false } })
    return servidor
  },
  despues: (tarea) => after(tarea),
}

// Envío de texto que se atiende como turno (alcance de esta etapa).
export function esTurnoDeTexto(cuerpo: CuerpoChat | null): cuerpo is CuerpoChat & { mensaje: string; accessToken: string; conversacionId: string } {
  return !!cuerpo
    && typeof cuerpo.mensaje === 'string' && cuerpo.mensaje.trim().length > 0
    && typeof cuerpo.accessToken === 'string' && cuerpo.accessToken.length > 0
    && typeof cuerpo.conversacionId === 'string' && UUID.test(cuerpo.conversacionId)
    && !cuerpo.imagenBase64 && !cuerpo.imagenesBase64 && !cuerpo.finalizarArchivo && !cuerpo.formatoEntrega
    && cuerpo.channel !== 'voice'
}

// Huella del CONTENIDO del envío: el mismo request_id con otro contenido es
// un conflicto, nunca el mismo turno.
export function huellaSolicitud(cuerpo: CuerpoChat & { mensaje: string; conversacionId: string }): string {
  return createHash('sha256').update(JSON.stringify([cuerpo.conversacionId, cuerpo.mensaje, cuerpo.esEdicionDocumento === true, typeof cuerpo.mensajeUsuarioId === 'string' ? cuerpo.mensajeUsuarioId : null]), 'utf8').digest('hex')
}

// Texto visible y marcador de cierre: compartidos con el cliente
// (lib/asistente/textoFinalChat.ts), que adopta exactamente el mismo texto.
export { textoVisibleDeRespuesta }
// Marcador de cierre para clientes con protocolo de turnos (nunca para el
// cliente actual): identidad del turno y del mensaje del asistente.
export function marcadorTurno(datos: { estado: 'completado' | 'fallido'; requestId: string; turnoId?: string; mensajeAsistenteId?: string | null; codigoError?: string | null }): string {
  return marca(datos)
}

function textoPlano(texto: string, status = 200): Response {
  return new Response(texto, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}
function json(datos: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(datos), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } })
}

// Puente servidor → cliente: el servidor consume TODO el stream original
// (la generación nunca espera al dispositivo); cada fragmento se reenvía
// mientras el cliente siga conectado (si cancela, solo se deja de reenviar).
// El texto de una respuesta del chat es pequeño, así que el búfer del lado
// del cliente no necesita contrapresión. Se cierra solo después de
// alTerminar (la persistencia).
export function puenteDuradero(
  fuente: ReadableStream<Uint8Array>,
  alTerminar: (crudo: string) => Promise<string | null>,
  alFallar: (crudo: string, error: unknown) => Promise<void>,
  despues: DependenciasTurno['despues']
): ReadableStream<Uint8Array> {
  let control!: ReadableStreamDefaultController<Uint8Array>
  let clienteConectado = true
  const salida = new ReadableStream<Uint8Array>({
    start(c) { control = c },
    cancel() { clienteConectado = false },
  })
  const enviar = (accion: () => void) => {
    if (!clienteConectado) return
    try { accion() } catch { clienteConectado = false }
  }
  const bomba = (async () => {
    const lector = fuente.getReader()
    const decodificador = new TextDecoder()
    let crudo = ''
    try {
      for (;;) {
        const { done, value } = await lector.read()
        if (done) break
        crudo += decodificador.decode(value, { stream: true })
        enviar(() => control.enqueue(value))
      }
      crudo += decodificador.decode()
    } catch (error) {
      await alFallar(crudo, error).catch((e) => console.error('[TURNO] no se pudo registrar la falla:', e))
      enviar(() => control.error(error))
      return
    }
    let cola: string | null = null
    try {
      cola = await alTerminar(crudo)
    } catch (e) {
      console.error('[TURNO] error al guardar el resultado:', e)
    }
    if (cola) enviar(() => control.enqueue(new TextEncoder().encode(cola!)))
    enviar(() => control.close())
  })()
  despues(() => bomba)
  return salida
}

// Punto de entrada: envuelve el manejador de /api/chat sin cambiar su
// interior.
export async function conTurnoDuradero(req: Request, procesar: (req: Request) => Promise<Response>, deps: DependenciasTurno = dependenciasReales): Promise<Response> {
  const cuerpo = (await req.clone().json().catch(() => null)) as CuerpoChat | null
  if (!esTurnoDeTexto(cuerpo)) return procesar(req)
  const servidorTurnos = deps.clienteServidor()
  if (!servidorTurnos) return procesar(req)

  const delCliente = typeof cuerpo.requestId === 'string' && REQUEST_ID.test(cuerpo.requestId)
  const requestId = delCliente ? (cuerpo.requestId as string) : `srv-${randomUUID()}`
  // Protocolo 1 solo con identidad del cliente (requestId y su mensaje).
  const protocolo = delCliente && cuerpo.protocoloTurno === 1 && typeof cuerpo.mensajeUsuarioId === 'string' ? 1 : 0
  const { data, error } = await deps.clienteDocente(cuerpo.accessToken).rpc('adquirir_turno_chat', {
    p_request_id: requestId,
    p_conversacion_id: cuerpo.conversacionId,
    p_mensaje_usuario_id: protocolo === 1 ? cuerpo.mensajeUsuarioId : null,
    p_huella: huellaSolicitud(cuerpo),
    p_protocolo: protocolo,
    p_reintento_de: protocolo === 1 && typeof cuerpo.reintentoDe === 'string' && REQUEST_ID.test(cuerpo.reintentoDe) ? cuerpo.reintentoDe : null,
    p_plazo_segundos: PLAZO_TURNO_SEGUNDOS,
  })
  const adquisicion = data as ResultadoAdquisicion | null
  if (error || !adquisicion?.resultado) {
    // Sin infraestructura de turnos (p. ej. migración pendiente): como siempre.
    console.error('[TURNO] adquisición no disponible; se atiende sin turno:', error?.message ?? 'sin respuesta')
    return procesar(req)
  }
  const turno = adquisicion.turno
  console.log(`[TURNO] ${adquisicion.resultado} request=${requestId.slice(0, 12)} protocolo=${protocolo}`)

  switch (adquisicion.resultado) {
    case 'adquirido':
      break
    case 'completado':
      // Recuperar: la respuesta guardada, sin volver a ejecutar ni llamar a la IA.
      return textoPlano(`${turno!.texto_crudo ?? ''}${protocolo === 1 ? marcadorTurno({ estado: 'completado', requestId, turnoId: turno!.id, mensajeAsistenteId: turno!.mensaje_asistente_id }) : ''}`)
    case 'ocupada':
      return protocolo === 1 ? json({ estadoTurno: 'ocupada', requestId, error: MENSAJE_CONVERSACION_OCUPADA }, 409) : textoPlano(MENSAJE_CONVERSACION_OCUPADA)
    case 'en_proceso':
    case 'mensaje_en_curso':
    case 'fallido':
    case 'conflicto':
    case 'reintento_requerido':
    case 'reintento_invalido':
      return json({ estadoTurno: adquisicion.resultado, requestId, turno: turno ?? null }, 409)
    default:
      // conversacion_invalida, grupo_invalido, mensaje_invalido, parametros_invalidos:
      // el cliente actual sigue como siempre (la ruta valida lo suyo); con
      // protocolo, es un envío inválido.
      return protocolo === 1 ? json({ estadoTurno: adquisicion.resultado, requestId }, 400) : procesar(req)
  }

  const turnoId = turno!.id
  const ejecucionId = adquisicion.ejecucion_id!
  const fallar = async (codigo: 'error_generacion' | 'error_persistencia', parcial: string, detalle: string) => {
    const r = await servidorTurnos.rpc('fallar_turno_chat', { p_turno_id: turnoId, p_ejecucion_id: ejecucionId, p_codigo: codigo, p_texto_parcial: parcial, p_error: detalle.slice(0, 500) })
    if (r.error) console.error('[TURNO] no se pudo marcar fallido:', r.error.message)
  }
  const contexto: ContextoTurno = { conversacionId: cuerpo.conversacionId, ajuste: null }
  let respuesta: Response
  try {
    respuesta = await ejecutarEnTurno(contexto, () => procesar(req))
  } catch (e) {
    await fallar('error_generacion', '', e instanceof Error ? e.message : String(e))
    throw e
  }
  if (!respuesta.ok || !respuesta.body) {
    const texto = await respuesta.text().catch(() => '')
    await fallar('error_generacion', texto, `http ${respuesta.status}`)
    return new Response(texto, { status: respuesta.status, headers: respuesta.headers })
  }

  const alTerminar = async (crudo: string): Promise<string | null> => {
    const visible = textoVisibleDeRespuesta(crudo)
    // Un borrador de ajuste sin mensaje no se podría aprobar: no es un resultado utilizable.
    if (protocolo === 1 && contexto.ajuste && visible === null) {
      await fallar('error_persistencia', crudo, 'borrador de ajuste sin texto final')
      return marcadorTurno({ estado: 'fallido', requestId, turnoId, codigoError: 'error_persistencia' })
    }
    const r = await servidorTurnos.rpc('completar_turno_chat', {
      p_turno_id: turnoId,
      p_ejecucion_id: ejecucionId,
      p_texto_crudo: crudo,
      p_texto_final: visible,
      p_materializar: protocolo === 1 && visible !== null,
      p_ajuste: contexto.ajuste,
    })
    const completado = r.data as ResultadoAdquisicion | null
    if (r.error || completado?.resultado !== 'completado') {
      // Error de persistencia: nada quedó a medias (la función es atómica).
      if (r.error) await fallar('error_persistencia', crudo, r.error.message)
      console.error(`[TURNO] no se completó: ${r.error?.message ?? completado?.resultado}`)
      return protocolo === 1 ? marcadorTurno({ estado: 'fallido', requestId, turnoId, codigoError: completado?.turno?.codigo_error ?? 'error_persistencia' }) : null
    }
    return protocolo === 1 ? marcadorTurno({ estado: 'completado', requestId, turnoId, mensajeAsistenteId: completado.turno?.mensaje_asistente_id ?? null }) : null
  }
  const alFallar = (crudo: string, e: unknown) => fallar('error_generacion', crudo, e instanceof Error ? e.message : String(e))
  return new Response(puenteDuradero(respuesta.body, alTerminar, alFallar, deps.despues), { status: respuesta.status, headers: respuesta.headers })
}
