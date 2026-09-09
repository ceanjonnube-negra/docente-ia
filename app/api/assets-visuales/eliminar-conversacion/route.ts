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
// CORRECCIÓN — "assets históricos con conversacion_id null": se
// confirmó con datos reales que assets_visuales.conversacion_id llega
// null en el 100% de las imágenes generadas/editadas hoy (el flujo de
// texto estándar nunca lo propaga a guardarAssetVisual — bug de
// escritura, corrección aparte, fuera de alcance aquí). Filtrar solo
// por conversacion_id dejaría esos assets huérfanos en cada borrado.
// Por eso los assets a borrar se resuelven de DOS fuentes:
//   FUENTE A — vínculo directo: assets_visuales.conversacion_id = id.
//   FUENTE B — fallback histórico: los assetId estructurados que ya
//     viajan en mensajes_chat.contenido.archivo/archivos (archivos
//     generados/editados por la IA) O contenido.imagen/imagenes
//     (fotos subidas por el docente, ver V2) de ESA conversación
//     (mensajes_chat.conversacion_id sí es una columna real, not null,
//     siempre correcta — nunca tuvo este problema).
// Deliberadamente NO se usa version_anterior_id como fuente de
// ownership: demuestra línea de versionado, no pertenencia a ESTA
// conversación. Un asset creado por una conversación B contaminada por
// materialVisualActivo de una conversación A previa (bug histórico,
// ver auditoría) comparte cadena de versiones con A sin pertenecerle —
// recorrer esa cadena al borrar B podría eliminar un asset todavía
// usado por A. Un asset huérfano (conversacion_id null y sin mensaje
// persistido) no se infiere aquí; queda para un mecanismo de limpieza
// de huérfanos aparte, una vez corregida la causa de conversacion_id
// null.
// La unión de las dos fuentes, sin duplicados, es la lista real de
// assets a limpiar. Nunca se acepta un assetId del body del cliente —
// los únicos assetId que se usan salen de mensajes YA persistidos y
// filtrados por conversacion_id con el cliente autenticado (RLS), y
// cada uno se re-resuelve contra assets_visuales con ese MISMO cliente
// antes de tocar Storage — un assetId ajeno en un mensaje corrupto
// simplemente no resuelve ninguna fila (RLS lo filtra), nunca se usa
// service_role para esa resolución.
//
// El cliente solo manda conversacionId — nunca storage_path ni
// docente_id. Ownership se resuelve con el cliente AUTENTICADO del
// docente (RLS de conversaciones_chat/assets_visuales/mensajes_chat);
// service_role se crea DESPUÉS de esa resolución, solo para lo que RLS
// no cubre hoy (Storage sin policies propias, y assets_visuales sin
// policy de delete — ver diagnóstico previo).
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

// FUENTE B (fallback histórico) — extrae, de forma defensiva, los
// assetId estructurados de UN mensaje ya persistido, tanto de
// archivo/archivos (generado/editado por la IA) como de imagen/imagenes
// (subido por el docente, ver V2). Nunca confía en storage_path/url del
// propio mensaje (pueden venir de una signed URL vieja) — solo el
// assetId, que después se re-resuelve contra assets_visuales con el
// cliente autenticado. Ignora null/undefined/strings vacíos/valores que
// no sean string.
function extraerAssetIdsDeMensaje(contenido: unknown): string[] {
  if (!contenido || typeof contenido !== 'object') return []
  const c = contenido as Record<string, unknown>
  const ids: string[] = []

  const archivo = c.archivo as Record<string, unknown> | undefined
  if (archivo && typeof archivo.assetId === 'string' && archivo.assetId) ids.push(archivo.assetId)

  const archivos = c.archivos
  if (Array.isArray(archivos)) {
    for (const item of archivos) {
      const assetId = (item as Record<string, unknown> | null)?.assetId
      if (typeof assetId === 'string' && assetId) ids.push(assetId)
    }
  }

  // EXTENSIÓN V2 (adjuntos de imagen subidos por el docente) — mismo
  // criterio exacto que archivo/archivos de arriba, nunca una fuente
  // nueva: contenido.imagen/imagenes es donde V2 persiste el assetId
  // real de una foto adjunta (ver app/api/chat/route.ts, bloque
  // "PERSISTENCIA DURABLE DE ADJUNTOS VISUALES"). Se une al MISMO
  // arreglo que ya se deduplica en el caller (idsDeMensajes, un Set) —
  // nunca una Fuente C aparte.
  const imagen = c.imagen as Record<string, unknown> | undefined
  if (imagen && typeof imagen.assetId === 'string' && imagen.assetId) ids.push(imagen.assetId)

  const imagenes = c.imagenes
  if (Array.isArray(imagenes)) {
    for (const item of imagenes) {
      const assetId = (item as Record<string, unknown> | null)?.assetId
      if (typeof assetId === 'string' && assetId) ids.push(assetId)
    }
  }

  return ids
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

    // FUENTE A — vínculo directo. Misma lógica: RLS ya limita esto a
    // assets del propio docente, sin necesidad de comparar docente_id
    // a mano.
    const { data: assetsDirectos, error: errorAssetsDirectos } = await supabase
      .from('assets_visuales')
      .select('id, storage_path')
      .eq('conversacion_id', conversacionId)
    if (errorAssetsDirectos) {
      return NextResponse.json({ error: 'No se pudieron leer los archivos asociados.' }, { status: 500 })
    }

    // FUENTE B — fallback histórico. mensajes_chat.conversacion_id SÍ
    // es una columna real, not null, siempre correcta (a diferencia de
    // assets_visuales.conversacion_id) — mismo cliente autenticado,
    // misma RLS, solo lectura de lo mínimo necesario.
    const { data: mensajes, error: errorMensajes } = await supabase
      .from('mensajes_chat')
      .select('id, contenido')
      .eq('conversacion_id', conversacionId)
    if (errorMensajes) {
      return NextResponse.json({ error: 'No se pudieron leer los mensajes de la conversación.' }, { status: 500 })
    }

    const idsDirectos = new Set((assetsDirectos ?? []).map((a) => a.id))
    const idsDeMensajes = new Set<string>()
    for (const mensaje of mensajes ?? []) {
      for (const id of extraerAssetIdsDeMensaje(mensaje.contenido)) idsDeMensajes.add(id)
    }
    // Solo hace falta resolver los ids de mensajes que la FUENTE A no
    // trajo ya — evita una segunda lectura redundante de la misma fila.
    const idsSoloDeMensajes = [...idsDeMensajes].filter((id) => !idsDirectos.has(id))

    let assetsDesdeMensajes: { id: string; storage_path: string }[] = []
    if (idsSoloDeMensajes.length > 0) {
      // Re-resolución con el cliente AUTENTICADO (RLS) — un assetId
      // ajeno (mensaje corrupto o de otra cuenta) simplemente no
      // devuelve fila; nunca se usa service_role para esto.
      // conversacionId ya fue validado arriba contra conversaciones_chat.id
      // (columna uuid) — si no fuera un uuid válido, esa consulta ya habría
      // fallado antes de llegar aquí, así que es seguro interpolarlo en el
      // filtro .or() de PostgREST sin riesgo de inyección de sintaxis.
      // Ownership real de Fuente B: un assetId ajeno (de otra conversación
      // del mismo docente) NO debe resolver fila aquí solo por pasar RLS de
      // docente_id — se exige además que la fila sea de ESTA conversación o
      // que sea un asset histórico sin conversacion_id (null).
      const { data: resueltos, error: errorResueltos } = await supabase
        .from('assets_visuales')
        .select('id, storage_path, conversacion_id')
        .in('id', idsSoloDeMensajes)
        .or(`conversacion_id.eq.${conversacionId},conversacion_id.is.null`)
      if (errorResueltos) {
        return NextResponse.json({ error: 'No se pudieron resolver los archivos históricos de la conversación.' }, { status: 500 })
      }
      assetsDesdeMensajes = resueltos ?? []

      // Una referencia histórica sin fila (ya se limpió antes, o el
      // asset nunca terminó de guardarse) no es un error — se registra
      // y se sigue con lo que sí pudo resolverse.
      const idsResueltos = new Set(assetsDesdeMensajes.map((a) => a.id))
      const idsSinFila = idsSoloDeMensajes.filter((id) => !idsResueltos.has(id))
      if (idsSinFila.length > 0) {
        console.log('[ASSETS_VISUALES] Referencias históricas sin fila en assets_visuales (se ignoran, no bloquean el borrado)', conversacionId, idsSinFila)
      }
    }

    // Unión de FUENTE A + FUENTE B, sin duplicados — ownership ya
    // demostrado explícitamente para cada asset de esta lista.
    const asignados = new Map<string, { id: string; storage_path: string }>()
    for (const a of [...(assetsDirectos ?? []), ...assetsDesdeMensajes]) asignados.set(a.id, a)
    const assets = [...asignados.values()]

    if (assets.length > 0) {
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
