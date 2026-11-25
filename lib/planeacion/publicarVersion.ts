// lib/planeacion/publicarVersion.ts
//
// Hito 2, etapa 3 — publicación de una versión N+1 de una planeación con
// protección de su evaluación (publicar_version_planeacion, migración
// 20261127000000). La usa la aprobación de ajustes del Chat
// (aprobarAjuste.ts, etapa 3b).
//
// - La decisión sobre la hoja (conservar, reemplazar o proteger) ocurre
//   en la MISMA transacción de la publicación.
// - Si la hoja se reemplazó, su PDF se genera después con el generador
//   idempotente de siempre: completa la hoja vigente sin PDF y nunca crea
//   otra. Si falla, la hoja queda pendiente (el proyecto sigue en
//   'planeado') y cualquier intento posterior la completa.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ResumenBorrador } from './extraerBorrador'
import { construirIndicadoresSeguimiento } from './aprobarBorrador'
import { generarCodigoHoja } from '../identificadorHoja'
import { generarYGuardarHojaSeguimiento } from '../seguimiento/generarYGuardarHoja'
import type { IndicadorCongelado } from '../seguimiento/tipos'

export type EstadoHojaPublicacion = 'conservada' | 'reemplazada' | 'evaluacion_protegida' | 'sin_hoja' | 'ya_publicada'
export type ResultadoPublicacion = {
  estado: string
  numero?: number
  versionId?: string
  hoja?: { estado: EstadoHojaPublicacion; id: string | null; anteriorId?: string | null }
  // Solo con hoja reemplazada: si su PDF quedó listo o pendiente de completar.
  pdfHoja?: 'listo' | 'pendiente'
}

export const MAX_INTENTOS_CODIGO_HOJA = 5

// Indicadores congelados de la hoja para la versión: los mismos que usa la
// primera aprobación (construirIndicadoresSeguimiento), numerados.
export function indicadoresHojaDeVersion(resumen: Pick<ResumenBorrador, 'indicadores'>): IndicadorCongelado[] {
  return construirIndicadoresSeguimiento(resumen as ResumenBorrador).map((i, n) => ({ ...i, numero_indicador: n + 1 }))
}

// Completa el PDF de la hoja VIGENTE del proyecto (si le falta) con el
// generador de siempre. true si quedó lista.
export type CompletarHoja = (proyectoSeguimientoId: string) => Promise<boolean>

export async function publicarVersionPlaneacion(
  sb: SupabaseClient,
  entrada: {
    planeacionId: string
    versionBase: number
    borradorClave: string
    contenido: string
    estructura: Record<string, unknown>
    trazabilidad: unknown
    resumen: Pick<ResumenBorrador, 'indicadores'>
    documentoWord?: string | null
    documentoPdf?: string | null
  },
  completarHoja: CompletarHoja
): Promise<ResultadoPublicacion> {
  let resultado: ResultadoPublicacion = { estado: 'error' }
  for (let intento = 0; intento < MAX_INTENTOS_CODIGO_HOJA; intento++) {
    const { data, error } = await sb.rpc('publicar_version_planeacion', {
      p_planeacion_id: entrada.planeacionId,
      p_version_base: entrada.versionBase,
      p_borrador_clave: entrada.borradorClave,
      p_contenido: entrada.contenido,
      p_estructura: entrada.estructura,
      p_trazabilidad: entrada.trazabilidad,
      p_documento_word: entrada.documentoWord ?? null,
      p_documento_pdf: entrada.documentoPdf ?? null,
      p_indicadores_hoja: indicadoresHojaDeVersion(entrada.resumen),
      // Código nuevo por si la hoja se reemplaza (único; si ya existe, otro).
      p_identificador_hoja: generarCodigoHoja(),
    })
    if (error) return { estado: 'error' }
    const r = data as { estado?: string; numero?: number; version_id?: string; hoja?: { estado: EstadoHojaPublicacion; id: string | null; anterior_id?: string | null } } | null
    resultado = { estado: r?.estado ?? 'error', numero: r?.numero, versionId: r?.version_id, hoja: r?.hoja ? { estado: r.hoja.estado, id: r.hoja.id, anteriorId: r.hoja.anterior_id ?? null } : undefined }
    if (resultado.estado !== 'identificador_ocupado') break
  }
  if (resultado.estado === 'publicada' && resultado.hoja?.estado === 'reemplazada' && resultado.hoja.id) {
    const { data: hoja } = await sb.from('hojas_evaluacion').select('proyecto_id').eq('id', resultado.hoja.id).maybeSingle()
    let lista = false
    try {
      lista = hoja ? await completarHoja((hoja as { proyecto_id: string }).proyecto_id) : false
    } catch (e) {
      console.error('[PLANEACION_VERSION] no se pudo completar el PDF de la hoja nueva (queda pendiente):', e)
    }
    resultado.pdfHoja = lista ? 'listo' : 'pendiente'
  }
  return resultado
}

// Generador real para completarHoja: datos del proyecto de seguimiento y
// de su hoja vigente (los indicadores ya están congelados en ella).
export function completarHojaConGenerador(sb: SupabaseClient, docenteId: string, perfil: unknown, zonaHoraria: string | null): CompletarHoja {
  return async (proyectoSeguimientoId) => {
    const { data: ps } = await sb
      .from('proyectos_seguimiento')
      .select('id, grupo_id, nombre, campos_formativos, fecha_inicio, fecha_fin, periodo_evaluacion_id, hoja_id')
      .eq('id', proyectoSeguimientoId)
      .eq('docente_id', docenteId)
      .maybeSingle()
    const proyecto = ps as { grupo_id: string; nombre: string; campos_formativos: string[] | null; fecha_inicio: string | null; fecha_fin: string | null; periodo_evaluacion_id: string | null; hoja_id: string | null } | null
    if (!proyecto?.hoja_id) return false
    const { data: hoja } = await sb.from('hojas_evaluacion').select('indicadores').eq('id', proyecto.hoja_id).is('reemplazada_por', null).maybeSingle()
    const indicadores = ((hoja as { indicadores?: IndicadorCongelado[] } | null)?.indicadores ?? []).map(({ indicador_especifico, aspecto_general }) => ({ indicador_especifico, aspecto_general }))
    const { data: periodo } = proyecto.periodo_evaluacion_id
      ? await sb.from('periodos_evaluacion').select('nombre').eq('id', proyecto.periodo_evaluacion_id).maybeSingle()
      : { data: null }
    const r = await generarYGuardarHojaSeguimiento(
      sb,
      docenteId,
      {
        proyectoId: proyectoSeguimientoId,
        grupoId: proyecto.grupo_id,
        nombreProyecto: proyecto.nombre,
        camposFormativos: proyecto.campos_formativos ?? [],
        trimestreNombre: (periodo as { nombre?: string } | null)?.nombre ?? null,
        fechaInicio: proyecto.fecha_inicio,
        fechaFin: proyecto.fecha_fin,
        indicadores,
      },
      perfil,
      zonaHoraria
    )
    return r.ok
  }
}

// Aviso discreto para el docente según lo que pasó con la evaluación.
export function avisoEvaluacionDeVersion(r: ResultadoPublicacion, codigoHojaNueva?: string | null): string | null {
  if (r.hoja?.estado === 'evaluacion_protegida') return 'La evaluación de este proyecto ya tiene capturas o resultados: se conserva con sus criterios originales y la hoja no cambia.'
  if (r.hoja?.estado === 'reemplazada') {
    const codigo = codigoHojaNueva ? ` (${codigoHojaNueva})` : ''
    return r.pdfHoja === 'listo'
      ? `Como cambiaron los indicadores, la hoja de evaluación se actualizó${codigo}. Usa la nueva; la anterior queda solo para consulta.`
      : `Como cambiaron los indicadores, la hoja de evaluación se actualizó${codigo}; su PDF se terminará de generar al abrirla.`
  }
  return null
}
