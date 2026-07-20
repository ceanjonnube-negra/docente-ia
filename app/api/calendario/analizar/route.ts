// app/api/calendario/analizar/route.ts
//
// Compara una foto del calendario oficial contra calendario_eventos
// real y regresa un resumen + botones de confirmación — nunca aplica
// ningún cambio (eso lo hace app/api/calendario/aplicar/route.ts, solo
// después de que el docente toca "Actualizar calendario"). Separado de
// app/api/chat/route.ts a propósito: no toca ese archivo ni su pipeline
// existente (streaming, voz, generación de documentos) — ver RFC
// "Mejora del flujo inteligente de actualización del Calendario
// Escolar".

import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import { calendarioCicloCompleto } from '@/lib/motorContexto'
import { analizarImagenCalendario, construirResumenAnalisis } from '@/lib/calendario/analisisCalendario'
import { obtenerFechaHora } from '@/lib/tiempo/TimeService'
import type { AccionMensaje } from '@/lib/asistente/tipos'

export const runtime = 'nodejs'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

class ErrorLimiteDeTiempo extends Error {}
const TIMEOUT_ANALISIS_MS = 45_000

async function conLimiteDeTiempo<T>(promesa: Promise<T>, ms: number, mensaje: string): Promise<T> {
  let temporizador!: ReturnType<typeof setTimeout>
  const limite = new Promise<never>((_, reject) => {
    temporizador = setTimeout(() => reject(new ErrorLimiteDeTiempo(mensaje)), ms)
  })
  try {
    return await Promise.race([promesa, limite])
  } finally {
    clearTimeout(temporizador)
  }
}

export async function POST(req: NextRequest) {
  try {
    const { mensaje, imagenBase64, imagenTipo, userId, accessToken, zonaHoraria } = await req.json()

    if (!userId || !accessToken) {
      return NextResponse.json({ error: 'Sesión no válida. Vuelve a iniciar sesión e intenta de nuevo.' }, { status: 401 })
    }
    if (!imagenBase64 || typeof imagenTipo !== 'string' || !imagenTipo.startsWith('image/')) {
      return NextResponse.json({ error: 'Adjunta una foto del calendario oficial para poder compararlo.' }, { status: 400 })
    }

    const supabaseUser = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    })

    // Mismo cálculo de ciclo escolar (agosto→julio) que ya usa
    // app/dashboard/calendario/page.tsx (cargarCiclo) — para comparar
    // contra la foto hace falta ver el ciclo completo, no solo lo
    // próximo.
    const { anio, mes } = obtenerFechaHora(zonaHoraria)
    const inicioCiclo = mes >= 8 ? anio : anio - 1
    const ini = `${inicioCiclo}-08-01`
    const fin = `${inicioCiclo + 1}-07-31`

    const eventosReales = await calendarioCicloCompleto(supabaseUser, userId, ini, fin)

    const { diferencias } = await conLimiteDeTiempo(
      analizarImagenCalendario(anthropic, imagenBase64, imagenTipo, mensaje || '', eventosReales),
      TIMEOUT_ANALISIS_MS,
      'El análisis del calendario tardó demasiado. Intenta de nuevo.'
    )

    const texto = construirResumenAnalisis(diferencias)

    const acciones: AccionMensaje[] =
      diferencias.length > 0
        ? [
            { id: 'actualizar_calendario', etiqueta: '🟢 Actualizar calendario', estilo: 'primario' },
            { id: 'cancelar', etiqueta: '⚪ Cancelar', estilo: 'secundario' },
          ]
        : []

    return NextResponse.json({ texto, acciones, datosAccionCalendario: diferencias })
  } catch (error) {
    console.error('[calendario/analizar] Error:', error)
    const mensajeError =
      error instanceof ErrorLimiteDeTiempo
        ? error.message
        : error instanceof Error
          ? error.message
          : 'No pude analizar la imagen del calendario. Intenta de nuevo.'
    return NextResponse.json({ error: mensajeError }, { status: 502 })
  }
}
