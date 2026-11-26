// lib/planeacion/archivoVersionApi.ts
//
// Hito 2, etapa 5b — Word/PDF de una versión pedidos desde la pestaña
// Planeación. Capa delgada sobre obtenerArchivoDeVersion (etapa 4): la
// misma reserva por versión + formato, la misma procedencia exacta y la
// misma recuperación del original. Sin IA. Nunca devuelve enlaces: el
// cliente abre o descarga el original con POST /api/archivos/descargar
// (archivoId), que vuelve a verificar que el archivo sea del docente.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { DependenciasArchivoVersion, ResultadoArchivoVersion } from './archivosVersion'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type RespuestaArchivoVersion =
  | { estado: 'archivo'; archivoId: string; nombre: string; generado: boolean; numero: number }
  | { estado: 'en_proceso' | 'inexistente' | 'sin_archivo' | 'error'; numero: number | null }
  | { estado: 'invalido' | 'sesion' | 'no_disponible' }

export function zonaHorariaValida(z: unknown): string | null {
  if (typeof z !== 'string' || z.length > 64) return null
  try {
    new Intl.DateTimeFormat('es-MX', { timeZone: z })
    return z
  } catch {
    return null
  }
}

const ESTADO_HTTP: Record<RespuestaArchivoVersion['estado'], number> = {
  archivo: 200, sin_archivo: 200, en_proceso: 202, inexistente: 410, error: 503, invalido: 400, sesion: 401, no_disponible: 404,
}
export const estadoHttp = (r: RespuestaArchivoVersion) => ESTADO_HTTP[r.estado]

export type DependenciasApiArchivoVersion = {
  autenticar: (token: string | null) => Promise<{ ok: true; docenteId: string; sb: SupabaseClient } | { ok: false }>
  obtener: (deps: DependenciasArchivoVersion, entrada: Parameters<typeof import('./archivosVersion').obtenerArchivoDeVersion>[1]) => Promise<ResultadoArchivoVersion>
  dependencias: () => DependenciasArchivoVersion
}

export async function atenderArchivoVersion(
  deps: DependenciasApiArchivoVersion,
  entrada: { token: string | null; versionId: string; cuerpo: unknown }
): Promise<RespuestaArchivoVersion> {
  const cuerpo = (entrada.cuerpo ?? {}) as { formato?: unknown; soloExistente?: unknown; zonaHoraria?: unknown }
  const formato = cuerpo.formato
  if (!UUID.test(entrada.versionId) || (formato !== 'word' && formato !== 'pdf')) return { estado: 'invalido' }
  const auth = await deps.autenticar(entrada.token)
  if (!auth.ok) return { estado: 'sesion' }
  const r = await deps.obtener(deps.dependencias(), {
    sb: auth.sb,
    docenteId: auth.docenteId,
    versionId: entrada.versionId,
    formato,
    zonaHoraria: zonaHorariaValida(cuerpo.zonaHoraria),
    soloExistente: cuerpo.soloExistente === true,
  })
  // Versión que la RLS del docente no deja leer: no disponible.
  if (r.tipo === 'error' && r.numero === null) return { estado: 'no_disponible' }
  if (r.tipo === 'archivo') return { estado: 'archivo', archivoId: r.archivo.archivoId, nombre: r.archivo.nombre, generado: r.generado, numero: r.numero }
  return { estado: r.tipo, numero: r.numero }
}
