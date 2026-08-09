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

  return { id: data.id, version: data.version, promptOriginal: data.prompt_original, storagePath: data.storage_path }
}
