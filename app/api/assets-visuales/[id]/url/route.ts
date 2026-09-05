// app/api/assets-visuales/[id]/url/route.ts
//
// FASE V1-A ("contexto visual persistente del Chat IA" — ver diseño
// aprobado: "la signed URL NO es fuente de verdad, assetId → storage_path
// sí lo es"). Devuelve una signed URL FRESCA para un asset ya existente,
// sin depender de la URL de 7 días guardada en el mensaje.
//
// El cliente solo manda assetId — nunca storage_path, docente_id ni
// bucket. Ownership se resuelve exclusivamente con el cliente
// AUTENTICADO del docente (obtenerAssetVisualPorId ya filtra por RLS,
// igual que lib/assetsVisuales.ts exige en el resto del proyecto) —
// service_role se crea DESPUÉS de esa resolución, solo para la
// operación de Storage que no tiene policies propias (mismo criterio
// que ya usa lib/documentGen/herramientas.ts).

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { autenticarRequestApi, extraerBearerToken } from '@/lib/server/authApi'
import { obtenerAssetVisualPorId } from '@/lib/assetsVisuales'
import { crearUrlFirmada, BUCKET_IMAGENES_GENERADAS } from '@/lib/documentGen/almacenamiento'

export const runtime = 'nodejs'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: assetId } = await params
  try {
    if (!assetId) {
      return NextResponse.json({ error: 'Falta el identificador del asset.' }, { status: 400 })
    }

    const accessToken = extraerBearerToken(req)
    const auth = await autenticarRequestApi(accessToken)
    if (!auth.ok) {
      return NextResponse.json({ error: auth.mensaje }, { status: auth.status })
    }

    // RLS (docente_id = auth.uid()) ya garantiza que esto sea null si el
    // asset no existe o no pertenece al docente autenticado — no hace
    // falta ninguna comparación manual de dueño.
    const asset = await obtenerAssetVisualPorId(auth.supabase, assetId)
    if (!asset) {
      return NextResponse.json({ error: 'Imagen no encontrada.' }, { status: 404 })
    }

    // Ownership ya demostrado con el cliente autenticado — solo ahora
    // se crea el cliente service_role, únicamente para Storage (bucket
    // sin policies propias, ver lib/assetsVisuales.ts).
    const supabaseStorage = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
    const url = await crearUrlFirmada(supabaseStorage, asset.storagePath, undefined, BUCKET_IMAGENES_GENERADAS)

    return NextResponse.json({ url })
  } catch (e) {
    console.error('[ASSETS_VISUALES] Fallo generando la URL fresca:', e)
    return NextResponse.json({ error: 'No se pudo obtener la imagen.' }, { status: 500 })
  }
}
