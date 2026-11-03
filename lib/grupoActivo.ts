// lib/grupoActivo.ts
//
// Resolución ÚNICA del grupo activo del docente para las pantallas de
// Lista y Evaluación — antes cada una lo calculaba por su cuenta (Lista
// ignoraba docente_contexto_activo y Evaluación no), así que con más de
// un grupo podían mostrar grupos distintos sin avisar.
//
// Regla (la misma que ya usaba Evaluación, MG-A):
// 1. docente_contexto_activo.grupo_id es una PREFERENCIA, nunca una
//    autorización: solo se usa si ese grupo es del docente
//    (grupos.docente_id), su ciclo está activo y, cuando el contexto
//    también guarda ciclo_escolar_id, coincide con el del grupo.
// 2. Si no es válido (ausente, ajeno, ciclo inactivo o distinto), el
//    grupo más reciente del docente en un ciclo activo; empate por id,
//    para que el resultado sea determinista.
// Sin grupo válido: null (fail-closed). Solo lectura, con el cliente
// del docente (RLS). Los docentes asociados únicamente por
// docente_grupos quedan fuera, igual que hasta ahora.
import type { SupabaseClient } from '@supabase/supabase-js'

export type GrupoActivo = {
  id: string
  nombre_grupo: string
  institucion_id: string
  docente_id: string
  ciclo_escolar_id: string
  creado_en: string
}

export type ResultadoGrupoActivo =
  | { ok: true; grupo: GrupoActivo; origen: 'contexto' | 'mas_reciente' }
  | { ok: false; motivo: 'sin_grupo' | 'error' }

const COLUMNAS = 'id, nombre_grupo, institucion_id, docente_id, ciclo_escolar_id, creado_en, ciclos_escolares!inner(activo)'

function limpiar(fila: Record<string, unknown>): GrupoActivo {
  return {
    id: fila.id as string,
    nombre_grupo: fila.nombre_grupo as string,
    institucion_id: fila.institucion_id as string,
    docente_id: fila.docente_id as string,
    ciclo_escolar_id: fila.ciclo_escolar_id as string,
    creado_en: fila.creado_en as string,
  }
}

export async function resolverGrupoActivo(sb: SupabaseClient, docenteId: string): Promise<ResultadoGrupoActivo> {
  const { data: contexto } = await sb
    .from('docente_contexto_activo')
    .select('grupo_id, ciclo_escolar_id')
    .eq('docente_id', docenteId)
    .maybeSingle()

  if (contexto?.grupo_id) {
    const { data: grupoValidado } = await sb
      .from('grupos')
      .select(COLUMNAS)
      .eq('id', contexto.grupo_id)
      .eq('docente_id', docenteId)
      .eq('ciclos_escolares.activo', true)
      .maybeSingle()
    if (grupoValidado && (!contexto.ciclo_escolar_id || contexto.ciclo_escolar_id === grupoValidado.ciclo_escolar_id)) {
      return { ok: true, grupo: limpiar(grupoValidado), origen: 'contexto' }
    }
  }

  const { data: grupos, error } = await sb
    .from('grupos')
    .select(COLUMNAS)
    .eq('docente_id', docenteId)
    .eq('ciclos_escolares.activo', true)
    .order('creado_en', { ascending: false })
    .order('id', { ascending: true })
    .limit(1)
  if (error) return { ok: false, motivo: 'error' }
  if (!grupos || grupos.length === 0) return { ok: false, motivo: 'sin_grupo' }
  return { ok: true, grupo: limpiar(grupos[0]), origen: 'mas_reciente' }
}
