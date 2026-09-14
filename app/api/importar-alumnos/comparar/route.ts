// app/api/importar-alumnos/comparar/route.ts
//
// Rama de COMPARACIÓN/ACTUALIZACIÓN — fase 1, estrictamente READ-ONLY:
// documento (imágenes) → V1-A (extracción) → roster real del grupo →
// V1-B (matching/diff) → resultado. Ninguna escritura en este endpoint:
// no hay INSERT/UPDATE/DELETE, no se llama ninguna RPC de escritura.
//
// Reutiliza sin modificar: analizarImagenesListaOficial (V1-A),
// compararListaOficial (V1-B) y obtenerRosterConPosicion — misma fuente
// de roster que ya usa Lista, ninguna segunda definición.
//
// Ownership: el grupo_id que manda el cliente nunca es autoritativo por
// sí solo — se revalida aquí mismo contra auth.uid(), mismo patrón que
// ya usa /api/importar-alumnos (líneas 103-114 de ese archivo).
//
// Formatos: solo imágenes en esta fase (jpg/jpeg/png/gif/webp), porque
// V1-A hoy solo sabe leer imágenes — un archivo no compatible (pdf/doc/
// xlsx) se rechaza aquí con un mensaje claro; el flujo actual de ALTA
// (/api/importar-alumnos) sigue soportando esos formatos sin cambios.
//
// Privacidad: los logs de este endpoint son solo conteos/flags/estado,
// nunca nombres, CURPs, imágenes ni IDs reales de alumnos.

import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { autenticarRequestApi, extraerBearerToken } from '@/lib/server/authApi'
import {
  analizarImagenesListaOficial,
  type ImagenListaOficial,
  type MediaTypeImagenListaOficial,
} from '@/lib/listaOficial/analisisListaOficial'
import { compararListaOficial, type AlumnoRosterListaOficial } from '@/lib/listaOficial/matchingListaOficial'
import { clasificarPropuestasReparacionCurp } from '@/lib/listaOficial/propuestasReparacionCurp'
import { obtenerRosterConPosicion } from '@/lib/rosterGrupo'

export const runtime = 'nodejs'

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
})

const MEDIA_TYPE_POR_EXTENSION: Record<string, MediaTypeImagenListaOficial> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
}

export async function POST(req: NextRequest) {
  try {
    const accessToken = extraerBearerToken(req)
    const auth = await autenticarRequestApi(accessToken)
    if (!auth.ok) {
      return NextResponse.json({ error: auth.mensaje }, { status: auth.status })
    }

    const formData = await req.formData()

    const grupoId = formData.get('grupo_id') as string | null
    if (!grupoId) {
      return NextResponse.json({ error: 'Falta el grupo.' }, { status: 400 })
    }

    // Server-side, nunca confiar solo en lo que manda el cliente.
    const { data: grupoValido } = await auth.supabase
      .from('grupos')
      .select('id')
      .eq('id', grupoId)
      .eq('docente_id', auth.user.id)
      .maybeSingle()

    if (!grupoValido) {
      return NextResponse.json({ error: 'No tienes acceso a este grupo.' }, { status: 403 })
    }

    const archivos = formData.getAll('archivos').filter((a): a is File => a instanceof File)
    if (archivos.length === 0) {
      return NextResponse.json({ error: 'No se recibió ninguna imagen.' }, { status: 400 })
    }

    const imagenes: ImagenListaOficial[] = []
    for (const archivo of archivos) {
      const extension = archivo.name.split('.').pop()?.toLowerCase() || ''
      const mediaType = MEDIA_TYPE_POR_EXTENSION[extension]
      if (!mediaType) {
        return NextResponse.json(
          { error: 'La comparación con la lista actual solo admite imágenes por ahora.' },
          { status: 422 }
        )
      }
      const buffer = Buffer.from(await archivo.arrayBuffer())
      imagenes.push({ base64: buffer.toString('base64'), mediaType })
    }

    const [extraccion, roster] = await Promise.all([
      analizarImagenesListaOficial(anthropic, imagenes),
      obtenerRosterConPosicion(auth.supabase, grupoId),
    ])

    if (roster.error) {
      return NextResponse.json({ error: 'No se pudo obtener la lista actual del grupo.' }, { status: 500 })
    }

    const rosterParaComparar: AlumnoRosterListaOficial[] = roster.data.map((a) => ({
      id: a.id,
      nombre: a.nombre,
      curp: a.curp,
    }))

    const comparacion = compararListaOficial(extraccion.registros, rosterParaComparar)

    // Capa posterior, fuera de V1-B — mismo resultado y mismo roster ya
    // en memoria, sin ninguna consulta adicional a Supabase. Solo lectura,
    // solo diagnóstico: nunca escribe, nunca se persiste.
    const propuestasReparacionCurp = clasificarPropuestasReparacionCurp(comparacion, rosterParaComparar)

    console.log('[importar-alumnos/comparar] comparación read-only completada', {
      totalRegistrosDocumento: extraccion.registros.length,
      totalRoster: rosterParaComparar.length,
      totalAusentes: comparacion.ausentesEnDocumento.length,
      totalCurpDiferente: propuestasReparacionCurp.totalCurpDiferente,
      totalCandidatosReparacionCurp: propuestasReparacionCurp.candidatos.length,
    })

    return NextResponse.json({ comparacion, propuestasReparacionCurp })
  } catch (error: unknown) {
    console.error('Error en importar-alumnos/comparar:', error instanceof Error ? error.message : 'error desconocido')
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Ocurrió un error al comparar la lista.' },
      { status: 500 }
    )
  }
}
