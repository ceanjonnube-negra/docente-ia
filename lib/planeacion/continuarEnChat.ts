// lib/planeacion/continuarEnChat.ts
//
// Hito 2, etapa 5c — «Continuar en el Chat IA» desde la pestaña Planeación.
// El único Chat IA recibe la planeación con el MISMO mecanismo contextual
// que una consulta guardada: la referencia de la conversación
// (conversaciones_chat.planeacion_activa) y la vista determinista de esa
// versión (textoPlaneacion) como documento activo. Nada lo escribe el
// docente y no se llama a ninguna IA.
//
// - evaluar: ¿la conversación actual ya es exactamente esta planeación,
//   versión y grupo, sin ajustes pendientes? Entonces se reutiliza.
// - abrir: solo sobre una conversación del docente, del grupo de la
//   planeación y sin mensajes (nunca contamina otra conversación ni
//   sobrescribe un borrador). Guarda la referencia y materializa la vista.
//
// Una versión histórica conserva su identidad (para consultarla); los
// ajustes siguen las reglas de siempre (parten de la vigente).

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Planeacion } from './tipos'
import { leerVinculoConversacion } from '../vinculoConversacion'
import { guardarReferenciaPlaneacion, leerReferenciaPlaneacion, textoPlaneacion, versionesDePlaneacion, type FirmarArchivo, type ReferenciaPlaneacion } from './consultaPlaneaciones'
import { mensajeDeRespuesta } from '../asistente/textoFinalChat'
import { MARCADOR_DOCUMENTO_RECUPERADO } from '../asistente/documentos'
import { zonaHorariaValida } from './archivoVersionApi'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type RespuestaContinuarEnChat =
  | { estado: 'listo'; mensajeId: string }
  | { estado: 'reutilizar' | 'requiere_nueva' | 'otro_grupo' | 'no_disponible' | 'invalido' | 'sesion' | 'error' }

const ESTADO_HTTP: Record<RespuestaContinuarEnChat['estado'], number> = {
  listo: 200, reutilizar: 200, requiere_nueva: 200, otro_grupo: 409, no_disponible: 404, invalido: 400, sesion: 401, error: 503,
}
export const estadoHttpContinuar = (r: RespuestaContinuarEnChat) => ESTADO_HTTP[r.estado]

// Identificador del mensaje de contexto: uno por conversación y versión
// (pedirlo dos veces nunca duplica el mensaje).
export const idMensajeContexto = (versionId: string) => `contexto-${versionId}`

// Ajuste aún sin publicar en la conversación (borrador de una versión
// posterior a la vigente de su planeación).
type EntradaAjuste = { planeacionId?: string; versionBase?: number }
export function referenciaReutilizable(ref: ReferenciaPlaneacion | null, planeacion: { id: string; version: number }, numero: number): boolean {
  if (!ref || ref.planeacionId !== planeacion.id || ref.numero !== numero) return false
  if (ref.intencion || ref.instruccionPendiente || ref.formatoPendiente) return false
  const ajustes = (Array.isArray(ref.ajustes) ? ref.ajustes : []) as EntradaAjuste[]
  return ajustes.every((a) => a.planeacionId === planeacion.id && typeof a.versionBase === 'number' && a.versionBase < planeacion.version)
}

export type DependenciasContinuarEnChat = {
  autenticar: (token: string | null) => Promise<{ ok: true; docenteId: string; sb: SupabaseClient } | { ok: false }>
  firmar: (docenteId: string) => FirmarArchivo
}

export async function atenderContinuarEnChat(
  deps: DependenciasContinuarEnChat,
  entrada: { token: string | null; versionId: string; cuerpo: unknown }
): Promise<RespuestaContinuarEnChat> {
  const cuerpo = (entrada.cuerpo ?? {}) as { conversacionId?: unknown; modo?: unknown; zonaHoraria?: unknown }
  const conversacionId = typeof cuerpo.conversacionId === 'string' ? cuerpo.conversacionId : ''
  if (!UUID.test(entrada.versionId) || !UUID.test(conversacionId) || (cuerpo.modo !== 'evaluar' && cuerpo.modo !== 'abrir')) return { estado: 'invalido' }
  const auth = await deps.autenticar(entrada.token)
  if (!auth.ok) return { estado: 'sesion' }
  const { sb, docenteId } = auth
  try {
    // Versión y planeación publicada del docente (RLS), del mismo grupo.
    const { data: v } = await sb.from('planeacion_versiones').select('id, planeacion_id, grupo_id, numero').eq('id', entrada.versionId).maybeSingle()
    const version = v as { id: string; planeacion_id: string; grupo_id: string; numero: number } | null
    if (!version) return { estado: 'no_disponible' }
    const { data: p } = await sb.from('planeaciones').select('*').eq('id', version.planeacion_id).eq('grupo_id', version.grupo_id).eq('estado', 'publicada').maybeSingle()
    const planeacion = p as Planeacion | null
    if (!planeacion) return { estado: 'no_disponible' }

    // Conversación del docente, vigente y fijada al grupo de la planeación.
    const vinculo = await leerVinculoConversacion(sb, conversacionId)
    if (vinculo.estado === 'error') return { estado: 'error' }
    if (vinculo.estado === 'con_grupo' && vinculo.grupoId !== version.grupo_id) return { estado: 'otro_grupo' }
    if (vinculo.estado !== 'con_grupo') return cuerpo.modo === 'evaluar' ? { estado: 'requiere_nueva' } : { estado: 'no_disponible' }

    if (cuerpo.modo === 'evaluar') {
      return referenciaReutilizable(await leerReferenciaPlaneacion(sb, conversacionId), planeacion, version.numero) ? { estado: 'reutilizar' } : { estado: 'requiere_nueva' }
    }

    // abrir: solo una conversación sin mensajes.
    const { count, error: errorConteo } = await sb.from('mensajes_chat').select('id', { count: 'exact', head: true }).eq('conversacion_id', conversacionId)
    if (errorConteo) return { estado: 'error' }
    const mensajeId = idMensajeContexto(version.id)
    const idRemoto = `${conversacionId}:${mensajeId}`
    if ((count ?? 0) > 0) {
      // Repetición del mismo toque: el contexto ya está, no se duplica.
      const { data: ya } = await sb.from('mensajes_chat').select('id').eq('id', idRemoto).maybeSingle()
      return ya && count === 1 ? { estado: 'listo', mensajeId: idRemoto } : { estado: 'requiere_nueva' }
    }

    const versiones = await versionesDePlaneacion(sb, planeacion.id)
    const completa = versiones.find((x) => x.id === version.id)
    if (!completa) return { estado: 'no_disponible' }
    const texto = await textoPlaneacion(planeacion, completa, versiones.length, deps.firmar(docenteId), false, zonaHorariaValida(cuerpo.zonaHoraria))
    const mensaje = mensajeDeRespuesta(`${texto}\n${MARCADOR_DOCUMENTO_RECUPERADO}`)
    if (!mensaje) return { estado: 'error' }
    const { texto: visible, ...contenido } = mensaje
    await guardarReferenciaPlaneacion(sb, conversacionId, { planeacionId: planeacion.id, numero: version.numero, opciones: [] })
    const { error } = await sb.from('mensajes_chat').insert({ id: idRemoto, conversacion_id: conversacionId, docente_id: docenteId, rol: 'asistente', texto: visible, contenido })
    if (error && error.code !== '23505') return { estado: 'error' }
    return { estado: 'listo', mensajeId: idRemoto }
  } catch {
    return { estado: 'error' }
  }
}
