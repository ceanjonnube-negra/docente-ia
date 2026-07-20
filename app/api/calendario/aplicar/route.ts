// app/api/calendario/aplicar/route.ts
//
// Aplica las diferencias que el docente ya vio y confirmó con el botón
// "🟢 Actualizar calendario" — primero genera el respaldo (siempre,
// incluso si luego no hay nada que corregir), después escribe los
// cambios reales sobre calendario_eventos. Separado de
// app/api/calendario/analizar/route.ts: analizar nunca escribe nada;
// aplicar nunca decide qué corregir, solo ejecuta lo ya decidido.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { aplicarCorreccionesCalendario } from '@/lib/motorContexto'
import { generarRespaldoCalendario } from '@/lib/calendario/respaldoCalendario'
import { construirResumenExito } from '@/lib/calendario/analisisCalendario'
import type { DiferenciaCalendario, TipoAccionCalendario } from '@/lib/asistente/tipos'

export const runtime = 'nodejs'

const ACCIONES_VALIDAS: TipoAccionCalendario[] = ['agregar', 'corregir', 'eliminar']

// Revalidación de forma (no de existencia del id — eso ya lo garantiza
// aplicarCorreccionesCalendario al exigir .eq('user_id', userId) y
// contar solo filas realmente afectadas): nunca se confía a ciegas en
// un payload que viaja de vuelta desde el cliente, aunque haya salido
// del propio servidor momentos antes.
function tieneFormaValida(d: unknown): d is DiferenciaCalendario {
  if (typeof d !== 'object' || d === null) return false
  const obj = d as Record<string, unknown>
  if (typeof obj.accion !== 'string' || !ACCIONES_VALIDAS.includes(obj.accion as TipoAccionCalendario)) return false
  const ev = obj.evento
  if (typeof ev !== 'object' || ev === null) return false
  const e = ev as Record<string, unknown>
  return typeof e.titulo === 'string' && typeof e.fecha === 'string' && typeof e.tipo === 'string'
}

export async function POST(req: NextRequest) {
  try {
    const { diferencias, userId, accessToken } = await req.json()

    if (!userId || !accessToken) {
      return NextResponse.json({ error: 'Sesión no válida. Vuelve a iniciar sesión e intenta de nuevo.' }, { status: 401 })
    }
    if (!Array.isArray(diferencias) || diferencias.length === 0) {
      return NextResponse.json({ error: 'No hay cambios pendientes que aplicar.' }, { status: 400 })
    }

    const diferenciasValidas = diferencias.filter(tieneFormaValida)
    if (diferenciasValidas.length === 0) {
      return NextResponse.json({ error: 'Los cambios pendientes ya no son válidos. Vuelve a analizar la imagen.' }, { status: 400 })
    }

    const supabaseUser = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    })

    // Respaldo SIEMPRE antes de cualquier escritura — si esto falla, no
    // se aplica ningún cambio (mejor no corregir nada a corregir sin
    // poder garantizar que hay un respaldo real).
    const archivoRespaldo = await generarRespaldoCalendario(supabaseUser, userId)

    const resultado = await aplicarCorreccionesCalendario(supabaseUser, userId, diferenciasValidas)

    if (!resultado.exito) {
      const textoParcial =
        resultado.aplicadas.length > 0
          ? `${construirResumenExito(resultado)}\n\n⚠️ Un cambio no se pudo aplicar: ${resultado.error}`
          : `No pude actualizar el calendario: ${resultado.error}`
      return NextResponse.json({ exito: false, texto: textoParcial, archivoRespaldo }, { status: 200 })
    }

    return NextResponse.json({ exito: true, texto: construirResumenExito(resultado), archivoRespaldo })
  } catch (error) {
    console.error('[calendario/aplicar] Error:', error)
    const mensajeError = error instanceof Error ? error.message : 'No pude actualizar el calendario. Intenta de nuevo.'
    return NextResponse.json({ error: mensajeError }, { status: 502 })
  }
}
