// lib/vinculoConversacion.ts
//
// Lectura ESTRICTAMENTE de solo lectura del grupo fijado de una
// conversación remota (conversaciones_chat.grupo_id, que fija una sola vez
// fijar_grupo_conversacion). Nunca fija ni modifica nada: el fijado sigue
// ocurriendo donde ya ocurría (navegador al crear la conversación y el
// flujo de Lista Oficial). Con el cliente del docente: RLS decide si la
// conversación es suya.
import type { SupabaseClient } from '@supabase/supabase-js'

export type VinculoConversacion =
  // La petición no trae un conversacionId válido (chat sin conversación remota).
  | { estado: 'sin_conversacion' }
  // Conversación del docente con grupo fijado.
  | { estado: 'con_grupo'; id: string; grupoId: string }
  // Conversación del docente sin grupo fijado (p. ej. tenía varios grupos sin contexto válido).
  | { estado: 'sin_grupo'; id: string }
  // Conversación del docente anterior a los snapshots de grupo (grupo_contexto_version ≠ 1).
  | { estado: 'antigua'; id: string }
  // Conversación del docente eliminada (marca eliminada_en, etapa 3B-1): nunca se continúa.
  | { estado: 'eliminada'; id: string }
  // La conversación no existe o RLS no la devuelve (no es del docente).
  | { estado: 'no_autorizada' }
  // Falla al leer el vínculo.
  | { estado: 'error' }

export async function leerVinculoConversacion(sb: SupabaseClient, conversacionId: string | null): Promise<VinculoConversacion> {
  if (!conversacionId) return { estado: 'sin_conversacion' }
  try {
    const { data, error } = await sb
      .from('conversaciones_chat')
      .select('id, grupo_contexto_version, grupo_id, eliminada_en')
      .eq('id', conversacionId)
      .maybeSingle()
    if (error) return { estado: 'error' }
    if (!data) return { estado: 'no_autorizada' }
    const id = data.id as string
    if (data.eliminada_en) return { estado: 'eliminada', id }
    if (data.grupo_contexto_version !== 1) return { estado: 'antigua', id }
    return data.grupo_id ? { estado: 'con_grupo', id, grupoId: data.grupo_id as string } : { estado: 'sin_grupo', id }
  } catch {
    return { estado: 'error' }
  }
}

// Respuesta de /api/chat cuando la conversación fue eliminada (en este u
// otro dispositivo): se responde antes de cualquier llamada al modelo.
export const MENSAJE_CONVERSACION_ELIMINADA = 'Esta conversación fue eliminada. Inicia una conversación nueva para continuar.'
