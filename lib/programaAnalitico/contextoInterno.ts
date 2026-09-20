// lib/programaAnalitico/contextoInterno.ts
//
// PA-3B — contexto interno REAL disponible para el grupo, mínimo y
// confiable: solo datos que existen en tablas reales del proyecto.
// Nunca inventa nada — si una tabla está vacía, se refleja como lista
// vacía, nunca como una afirmación ("sin necesidades de apoyo" sería
// una interpretación; "0 filas" es el hecho). Deliberadamente NO
// incluye diagnóstico, estilo de aprendizaje, nivel socioeconómico,
// características comunitarias, intereses, recursos, CCT ni turno —
// ninguna tabla real del proyecto los registra hoy (ver auditoría
// PA-3B §5).

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ContextoCurricularGrupo } from '../curriculo/resolverContextoCurricularGrupo'

export type EventoCalendarioRelevante = { titulo: string; fecha: string; tipo: string }
export type PeriodoDisponible = { id: string; nombre: string; numeroPeriodo: number }
export type NecesidadApoyoResumen = { tipo: string; descripcion: string }

export type ContextoInternoGrupo = {
  nivelEducativo: string
  gradoGrupo: string
  cicloEscolarId: string
  institucionNombre: string | null
  totalAlumnosActivos: number
  calendarioRelevante: EventoCalendarioRelevante[]
  periodosDisponibles: PeriodoDisponible[]
  necesidadesApoyo: NecesidadApoyoResumen[]
}

export async function recopilarContextoInternoGrupo(
  sb: SupabaseClient,
  grupoId: string,
  contexto: ContextoCurricularGrupo
): Promise<ContextoInternoGrupo> {
  const { data: grupo } = await sb.from('grupos').select('institucion_id').eq('id', grupoId).maybeSingle()

  let institucionNombre: string | null = null
  if (grupo?.institucion_id) {
    const { data: institucion } = await sb.from('instituciones').select('nombre').eq('id', grupo.institucion_id).maybeSingle()
    institucionNombre = (institucion?.nombre as string | undefined) ?? null
  }

  const { count: totalAlumnosActivos } = await sb
    .from('inscripciones')
    .select('id', { count: 'exact', head: true })
    .eq('grupo_id', grupoId)
    .eq('estatus', 'activo')

  // calendario_eventos es global por docente (sin ciclo_escolar_id/
  // grupo_id en el esquema) — se trae tal cual existe, sin inventar un
  // filtro de ciclo que la tabla no soporta.
  const { data: eventos } = await sb
    .from('calendario_eventos')
    .select('titulo, fecha, tipo')
    .order('fecha', { ascending: true })

  // Periodos SOLO compatibles con el ciclo real del grupo — "mismo
  // docente" ya lo garantiza RLS. Si el ciclo actual no tiene periodos
  // registrados (caso real detectado para 4°B: los 3 periodos
  // existentes pertenecen al ciclo anterior), esta lista queda vacía a
  // propósito — nunca se inventa un trimestre.
  const { data: periodos } = await sb
    .from('periodos_evaluacion')
    .select('id, nombre, numero_periodo')
    .eq('ciclo_escolar_id', contexto.cicloEscolarId)
    .order('numero_periodo', { ascending: true })

  const { data: necesidades } = await sb
    .from('necesidades_apoyo')
    .select('tipo, descripcion')
    .eq('grupo_id', grupoId)
    .eq('activa', true)

  return {
    nivelEducativo: contexto.nivelEducativo,
    gradoGrupo: contexto.gradoGrupo,
    cicloEscolarId: contexto.cicloEscolarId,
    institucionNombre,
    totalAlumnosActivos: totalAlumnosActivos ?? 0,
    calendarioRelevante: (eventos ?? []).map((e) => ({ titulo: e.titulo as string, fecha: e.fecha as string, tipo: e.tipo as string })),
    periodosDisponibles: (periodos ?? []).map((p) => ({ id: p.id as string, nombre: p.nombre as string, numeroPeriodo: p.numero_periodo as number })),
    necesidadesApoyo: (necesidades ?? []).map((n) => ({ tipo: n.tipo as string, descripcion: n.descripcion as string })),
  }
}
