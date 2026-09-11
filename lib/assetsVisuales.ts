// lib/assetsVisuales.ts
//
// Persistencia server-only de assets_visuales (ver diseño técnico
// aprobado: "Implementar en Docente IA la capacidad de generar
// imágenes y documentos ilustrados", Fase 0+1 — tabla nueva 100%
// aditiva, migración 20260808210000_crear_assets_visuales.sql).
//
// Usa siempre el cliente AUTENTICADO del docente (nunca service_role)
// — RLS ya exige docente_id = auth.uid(), mismo criterio que
// lib/turnosChat.ts. El único uso de service_role en este flujo sigue
// siendo Storage (ver lib/documentGen/almacenamiento.ts /
// herramientas.ts), que nunca tuvo políticas RLS propias.
//
// Versionado ("regenerar" nunca borra, ver reglas del diseño
// aprobado): al pasar versionAnteriorId, la fila nueva hereda
// version = anterior.version + 1 y la anterior se marca vigente=false
// — nunca se hace DELETE.

import type { SupabaseClient } from '@supabase/supabase-js'

export type TipoAssetVisual = 'imagen' | 'documento_ilustrado'

export type AssetVisualNuevo = {
  docenteId: string
  conversacionId: string | null
  tipo: TipoAssetVisual
  formatoArchivo: string
  promptOriginal: string
  storagePath: string
  tamanoBytes: number
  grado: string | null
  grupo: string | null
  versionAnteriorId?: string | null
}

export type AssetVisualGuardado = {
  id: string
  version: number
  promptOriginal: string
  storagePath: string
  // V3-A (ver "referente visual histórico") — agregados de forma
  // aditiva: ningún consumidor existente que solo lea
  // id/version/promptOriginal/storagePath se ve afectado. Necesarios
  // para que app/api/chat/route.ts pueda validar ownership fuerte
  // (conversacionId === conversación actual, exige no-null) y construir
  // el media_type real del bloque image sin una consulta aparte.
  conversacionId: string | null
  formatoArchivo: string
}

// Ver "corrección — edición real de imágenes con el asset visual
// anterior como entrada": antes de editar, el pipeline necesita el
// storagePath REAL del asset anterior para descargar el archivo (ver
// lib/documentGen/almacenamiento.ts descargarBuffer) — no basta con
// promptOriginal como se hacía antes. null si el id no existe o no le
// pertenece al docente autenticado (RLS ya lo garantiza vía sb).
export async function obtenerAssetVisualPorId(sb: SupabaseClient, id: string): Promise<AssetVisualGuardado | null> {
  const { data, error } = await sb
    .from('assets_visuales')
    .select('id, version, prompt_original, storage_path, conversacion_id, formato_archivo')
    .eq('id', id)
    .maybeSingle()
  if (error || !data) return null
  return {
    id: data.id,
    version: data.version,
    promptOriginal: data.prompt_original,
    storagePath: data.storage_path,
    conversacionId: data.conversacion_id,
    formatoArchivo: data.formato_archivo,
  }
}

export async function guardarAssetVisual(sb: SupabaseClient, datos: AssetVisualNuevo): Promise<AssetVisualGuardado> {
  let version = 1
  if (datos.versionAnteriorId) {
    const { data: anterior } = await sb
      .from('assets_visuales')
      .select('version')
      .eq('id', datos.versionAnteriorId)
      .maybeSingle()
    version = (anterior?.version ?? 0) + 1
  }

  const { data, error } = await sb
    .from('assets_visuales')
    .insert({
      docente_id: datos.docenteId,
      conversacion_id: datos.conversacionId,
      tipo: datos.tipo,
      formato_archivo: datos.formatoArchivo,
      prompt_original: datos.promptOriginal,
      storage_path: datos.storagePath,
      tamano_bytes: datos.tamanoBytes,
      grado: datos.grado,
      grupo: datos.grupo,
      version,
      version_anterior_id: datos.versionAnteriorId ?? null,
    })
    .select('id, version, prompt_original, storage_path')
    .single()
  if (error || !data) throw new Error(`Error guardando el asset visual: ${error?.message || 'sin fila devuelta'}`)

  // Nunca borra la versión anterior — solo deja de marcarla vigente.
  // Mejor esfuerzo: si esto falla, el asset nuevo ya quedó guardado
  // (lo importante); simplemente ambas quedarían vigentes=true, un
  // detalle de listado, no una pérdida de información.
  if (datos.versionAnteriorId) {
    await sb.from('assets_visuales').update({ vigente: false }).eq('id', datos.versionAnteriorId).then(
      () => {},
      () => {}
    )
  }

  // conversacionId/formatoArchivo ya conocidos del propio `datos` de
  // entrada (V3-A, ver AssetVisualGuardado) — nunca hace falta
  // volver a seleccionarlos.
  return {
    id: data.id,
    version: data.version,
    promptOriginal: data.prompt_original,
    storagePath: data.storage_path,
    conversacionId: datos.conversacionId,
    formatoArchivo: datos.formatoArchivo,
  }
}
