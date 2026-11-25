// lib/seguimiento/capturaHojaVigente.ts
//
// Hito 2, etapa 3 — la captura y la corrección de una hoja de evaluación
// solo escriben sobre la hoja VIGENTE con la que empezó la operación.
// publicar_version_planeacion puede reemplazar la hoja de un proyecto sin
// capturas ni resultados; si eso ocurre en medio de una operación (o un
// cliente desactualizado sigue mostrando la anterior), la escritura
// condicional por hoja_id no afecta ninguna fila y la operación se rechaza:
// nunca se escribe sobre la hoja equivocada.

import type { SupabaseClient } from '@supabase/supabase-js'

export const MENSAJE_HOJA_CAMBIADA = 'La hoja de evaluación de este proyecto cambió porque se publicó una versión nueva de la planeación. Vuelve a abrir el proyecto y usa la hoja vigente.'

export function mensajeHojaReemplazadaImpresa(anterior: string, vigente: string): string {
  return `Esta hoja impresa (${anterior}) es de una versión anterior de la planeación y ya fue reemplazada. Imprime y usa la hoja vigente (${vigente}).`
}

export type ResultadoActualizacionCaptura = 'ok' | 'hoja_cambiada' | 'error'

// UPDATE de proyectos_seguimiento condicionado a que el proyecto siga
// usando la hoja esperada.
export async function actualizarCapturaSobreHoja(
  sb: SupabaseClient,
  proyectoId: string,
  hojaId: string,
  cambios: Record<string, unknown>
): Promise<ResultadoActualizacionCaptura> {
  const { data, error } = await sb.from('proyectos_seguimiento').update(cambios).eq('id', proyectoId).eq('hoja_id', hojaId).select('id')
  if (error) return 'error'
  return data && data.length > 0 ? 'ok' : 'hoja_cambiada'
}

// ¿El código leído en la foto es el de una hoja ya reemplazada de este
// mismo proyecto? (para explicarlo, nunca para aceptarla).
export async function esHojaReemplazadaDelProyecto(sb: SupabaseClient, proyectoId: string, codigo: string | null): Promise<boolean> {
  if (!codigo) return false
  const { data } = await sb
    .from('hojas_evaluacion')
    .select('id')
    .eq('proyecto_id', proyectoId)
    .eq('identificador_visible', codigo)
    .not('reemplazada_por', 'is', null)
    .maybeSingle()
  return !!data
}
