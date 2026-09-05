// app/api/assets-visuales/eliminar-conversacion/route.ts
//
// FASE V1-B ("contexto visual persistente del Chat IA" — ciclo de vida
// sano de assets). Borra, en orden estricto, todo lo que pertenece a
// una conversación: objetos Storage → filas assets_visuales →
// conversación (mensajes_chat sigue cayendo por el ON DELETE CASCADE
// ya existente). Invariante obligatoria: NUNCA borrar una fila
// assets_visuales sin confirmar antes que su objeto Storage ya fue
// eliminado o ya no existía — así nunca queda "fila borrada, archivo
// imposible de localizar después".
//
// El cliente solo manda conversacionId — nunca storage_path ni
// docente_id. Ownership se resuelve con el cliente AUTENTICADO del
// docente (RLS de conversaciones_chat/assets_visuales); service_role
// se crea DESPUÉS de esa resolución, solo para lo que RLS no cubre hoy
// (Storage sin policies propias, y assets_visuales sin policy de
// delete — ver diagnóstico previo).
//
// Reintentable por diseño: sb.storage.remove() sobre una ruta que ya
// no existe no produce error (ver eliminarObjetoVerificado) — así que
// repetir esta llamada tras un fallo parcial simplemente confirma como
// "ok" lo que ya se borró en el intento anterior y solo reintenta lo
// que de verdad sigue pendiente.

import { NextRequest, NextResponse } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { autenticarRequestApi, extraerBearerToken } from '@/lib/server/authApi'
import { BUCKET_IMAGENES_GENERADAS } from '@/lib/documentGen/almacenamiento'

export const runtime = 'nodejs'

// Deliberadamente LOCAL a este endpoint — no se toca
// lib/documentGen/almacenamiento.ts ni su eliminarArchivo() existente
// (best-effort, nunca lanza, sin resultado verificable) porque tiene
// otros consumidores (lib/documentGen/herramientas.ts) que dependen de
// ese comportamiento tal cual. Aquí necesitamos saber, con certeza,
// si cada objeto quedó eliminado o ya no existía, antes de tocar
// ninguna fila.
async function eliminarObjetoVerificado(sb: SupabaseClient, storagePath: string): Promise<{ ok: boolean; motivo?: string }> {
  const { error } = await sb.storage.from(BUCKET_IMAGENES_GENERADAS).remove([storagePath])
  if (error) return { ok: false, motivo: error.message }
  return { ok: true }
}

export async function POST(req: NextRequest) {
  try {
    const { conversacionId } = await req.json()
    if (typeof conversacionId !== 'string' || !conversacionId) {
      return NextResponse.json({ error: 'Falta el identificador de la conversación.' }, { status: 400 })
    }

    const accessToken = extraerBearerToken(req)
    const auth = await autenticarRequestApi(accessToken)
    if (!auth.ok) {
      return NextResponse.json({ error: auth.mensaje }, { status: auth.status })
    }
    const supabase = auth.supabase

    // RLS (docente_id = auth.uid()) ya garantiza fail-closed: si la
    // conversación no existe o no es de este docente, esto es null.
    const { data: conversacion, error: errorConversacion } = await supabase
      .from('conversaciones_chat')
      .select('id')
      .eq('id', conversacionId)
      .maybeSingle()
    if (errorConversacion) {
      return NextResponse.json({ error: 'No se pudo verificar la conversación.' }, { status: 500 })
    }
    if (!conversacion) {
      return NextResponse.json({ error: 'Conversación no encontrada.' }, { status: 404 })
    }

    // Misma lógica: RLS ya limita esto a assets del propio docente,
    // sin necesidad de comparar docente_id a mano.
    const { data: assets, error: errorAssets } = await supabase
      .from('assets_visuales')
      .select('id, storage_path')
      .eq('conversacion_id', conversacionId)
    if (errorAssets) {
      return NextResponse.json({ error: 'No se pudieron leer los archivos asociados.' }, { status: 500 })
    }

    if (assets && assets.length > 0) {
      // Ownership ya demostrado con el cliente autenticado — solo
      // ahora se crea el cliente service_role, únicamente para lo que
      // RLS no cubre (Storage, y el DELETE de assets_visuales).
      const supabaseAdmin = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
      )

      const resultados = await Promise.all(
        assets.map((asset) => eliminarObjetoVerificado(supabaseAdmin, asset.storage_path))
      )
      const fallidos = resultados
        .map((resultado, i) => ({ resultado, asset: assets[i] }))
        .filter(({ resultado }) => !resultado.ok)
      if (fallidos.length > 0) {
        console.error(
          '[ASSETS_VISUALES] Limpieza de Storage incompleta al borrar conversación',
          conversacionId,
          fallidos.map(({ asset, resultado }) => ({ id: asset.id, storagePath: asset.storage_path, motivo: resultado.motivo }))
        )
        return NextResponse.json({ error: 'No se pudieron eliminar todos los archivos. Intenta de nuevo.' }, { status: 500 })
      }

      const { error: errorBorrarAssets } = await supabaseAdmin
        .from('assets_visuales')
        .delete()
        .in('id', assets.map((asset) => asset.id))
      if (errorBorrarAssets) {
        console.error('[ASSETS_VISUALES] Fallo borrando filas assets_visuales', conversacionId, errorBorrarAssets)
        return NextResponse.json({ error: 'No se pudieron eliminar los archivos asociados. Intenta de nuevo.' }, { status: 500 })
      }
    }

    // Ya no hace falta service_role: la policy conversaciones_chat_delete_propio
    // ya permite este DELETE con el cliente autenticado del propio docente.
    // mensajes_chat cae por el ON DELETE CASCADE ya existente.
    const { error: errorBorrarConversacion } = await supabase
      .from('conversaciones_chat')
      .delete()
      .eq('id', conversacionId)
    if (errorBorrarConversacion) {
      console.error('[ASSETS_VISUALES] Fallo borrando la conversación', conversacionId, errorBorrarConversacion)
      return NextResponse.json({ error: 'No se pudo eliminar la conversación. Intenta de nuevo.' }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[ASSETS_VISUALES] Fallo eliminando la conversación:', e)
    return NextResponse.json({ error: 'No se pudo eliminar la conversación.' }, { status: 500 })
  }
}
