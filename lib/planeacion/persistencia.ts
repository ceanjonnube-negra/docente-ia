// lib/planeacion/persistencia.ts
//
// Capa de persistencia aislada para Planeación (C-005, Paso 2) — 5
// funciones puras, reutilizables tanto por los endpoints HTTP ya
// existentes (app/api/planeaciones/*) como, en una fase posterior no
// autorizada todavía, por el flujo del Chat IA. Ninguna función crea
// su propio cliente de Supabase ni usa service_role: reciben un
// cliente YA autenticado con la sesión real del docente (el mismo que
// devuelve autenticarRequestApi() en lib/server/authApi.ts), así que
// RLS se aplica automáticamente. Además, cada función resuelve
// docenteId por su cuenta con auth.getUser() — nunca confía a ciegas
// en un docente_id que le pasen como dato (mismo criterio ya aplicado
// en todo el proyecto desde la corrección de IDOR de Seguimiento).
//
// Sin lógica de React, sin nada del Chat IA, sin dependencia de
// app/api/chat/route.ts ni de lib/clasificadorNivel0.ts.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { EstadoPlaneacion, Planeacion, PlaneacionProyecto } from './tipos'

export type CodigoErrorPlaneacion =
  | 'CAMPOS_FALTANTES'
  | 'GRUPO_NO_ENCONTRADO'
  | 'GRUPO_AJENO'
  | 'PLANEACION_NO_ENCONTRADA'
  | 'PLANEACION_AJENA'
  | 'SESION_INVALIDA'
  | 'ERROR_SUPABASE'

export type ErrorPlaneacion = { codigo: CodigoErrorPlaneacion; mensaje: string }

export type ResultadoPlaneacion<T> =
  | { ok: true; datos: T }
  | { ok: false; error: ErrorPlaneacion }

export type ContextoPlaneacion = { supabase: SupabaseClient }

function fallo<T>(codigo: CodigoErrorPlaneacion, mensaje: string): ResultadoPlaneacion<T> {
  return { ok: false, error: { codigo, mensaje } }
}

function exito<T>(datos: T): ResultadoPlaneacion<T> {
  return { ok: true, datos }
}

// Único punto que resuelve el docente real — nunca se confía en un
// docente_id recibido como dato de entrada sin cotejarlo contra esto.
async function resolverDocenteId(supabase: SupabaseClient): Promise<ResultadoPlaneacion<string>> {
  const { data, error } = await supabase.auth.getUser()
  if (error || !data?.user) {
    return fallo('SESION_INVALIDA', 'No se pudo identificar al docente autenticado.')
  }
  return exito(data.user.id)
}

const COLUMNAS_PLANEACION = 'id, docente_id, grupo_id, ciclo_escolar_id, periodo_evaluacion_id, nombre, proposito, fecha_inicio, fecha_fin, estado, version, creado_en, actualizado_en'
const COLUMNAS_PROYECTO = 'id, planeacion_id, nombre, campos_formativos, contenidos, pda, ejes_articuladores, metodologia, duracion_dias, actividades, recursos, evaluacion, orden, creado_en, actualizado_en'

export type DatosProyectoPlaneacion = Omit<PlaneacionProyecto, 'id' | 'planeacion_id' | 'creado_en' | 'actualizado_en'>

export type DatosCrearPlaneacion = {
  docente_id: string // se valida contra la sesión real, ver resolverDocenteId
  grupo_id: string
  periodo_evaluacion_id?: string | null
  nombre: string
  proposito?: string | null
  fecha_inicio?: string | null
  fecha_fin?: string | null
  estado?: EstadoPlaneacion
  version?: number
  proyectos?: DatosProyectoPlaneacion[] // contenido estructurado, opcional
}

// Crea la planeación y, si vienen, sus proyectos vinculados. Valida
// campos obligatorios y que el grupo pertenezca al docente ANTES de
// insertar — nunca delega esa verificación únicamente a RLS.
export async function crearPlaneacion(ctx: ContextoPlaneacion, datos: DatosCrearPlaneacion): Promise<ResultadoPlaneacion<Planeacion>> {
  const resDocente = await resolverDocenteId(ctx.supabase)
  if (!resDocente.ok) return resDocente
  const docenteId = resDocente.datos

  if (datos.docente_id && datos.docente_id !== docenteId) {
    return fallo('SESION_INVALIDA', 'El docente_id indicado no coincide con la sesión real.')
  }
  if (!datos.grupo_id || !datos.nombre?.trim()) {
    return fallo('CAMPOS_FALTANTES', 'Faltan el grupo o el nombre de la planeación.')
  }

  const { data: grupo, error: errorGrupo } = await ctx.supabase
    .from('grupos')
    .select('id, docente_id, ciclo_escolar_id')
    .eq('id', datos.grupo_id)
    .maybeSingle()
  if (errorGrupo) return fallo('ERROR_SUPABASE', 'No se pudo verificar el grupo.')
  if (!grupo) return fallo('GRUPO_NO_ENCONTRADO', 'Grupo no encontrado.')
  if (grupo.docente_id !== docenteId) return fallo('GRUPO_AJENO', 'No tienes acceso a este grupo.')

  const { data: planeacion, error: errorInsert } = await ctx.supabase
    .from('planeaciones')
    .insert({
      docente_id: docenteId,
      grupo_id: datos.grupo_id,
      ciclo_escolar_id: grupo.ciclo_escolar_id,
      periodo_evaluacion_id: datos.periodo_evaluacion_id ?? null,
      nombre: datos.nombre.trim(),
      proposito: datos.proposito ?? null,
      fecha_inicio: datos.fecha_inicio ?? null,
      fecha_fin: datos.fecha_fin ?? null,
      estado: datos.estado ?? 'borrador',
      version: datos.version ?? 1,
    })
    .select(COLUMNAS_PLANEACION)
    .single()
  if (errorInsert || !planeacion) {
    return fallo('ERROR_SUPABASE', errorInsert?.message || 'No se pudo crear la planeación.')
  }

  if (datos.proyectos && datos.proyectos.length > 0) {
    const filas = datos.proyectos.map(p => ({ ...p, planeacion_id: (planeacion as Planeacion).id }))
    const { error: errorProyectos } = await ctx.supabase.from('planeacion_proyectos').insert(filas)
    if (errorProyectos) {
      return fallo('ERROR_SUPABASE', `La planeación se creó, pero no se pudieron guardar sus proyectos: ${errorProyectos.message}`)
    }
  }

  return exito(planeacion as Planeacion)
}

export type FiltrosListarPlaneaciones = {
  grupo_id: string
  periodo_evaluacion_id?: string | null
  estado?: EstadoPlaneacion
}

// Filtra explícitamente por docente Y por grupo — defensa adicional
// sobre RLS, nunca depende solo de la política para no mezclar datos
// entre docentes.
export async function listarPlaneaciones(ctx: ContextoPlaneacion, filtros: FiltrosListarPlaneaciones): Promise<ResultadoPlaneacion<Planeacion[]>> {
  const resDocente = await resolverDocenteId(ctx.supabase)
  if (!resDocente.ok) return resDocente
  const docenteId = resDocente.datos

  if (!filtros.grupo_id) return fallo('CAMPOS_FALTANTES', 'Falta el grupo para listar planeaciones.')

  let consulta = ctx.supabase
    .from('planeaciones')
    .select(COLUMNAS_PLANEACION)
    .eq('docente_id', docenteId)
    .eq('grupo_id', filtros.grupo_id)
    // version=0 es el centinela de "creación en dos fases todavía sin
    // confirmar" (ver aprobarBorrador.ts, C-005 Paso 3C) — nunca debe
    // aparecer en una consulta normal, ni siquiera parcialmente creada.
    .gt('version', 0)
    .order('fecha_inicio', { ascending: false })

  if (filtros.periodo_evaluacion_id) consulta = consulta.eq('periodo_evaluacion_id', filtros.periodo_evaluacion_id)
  if (filtros.estado) consulta = consulta.eq('estado', filtros.estado)

  const { data, error } = await consulta
  if (error) return fallo('ERROR_SUPABASE', 'No se pudieron leer las planeaciones.')
  return exito((data || []) as Planeacion[])
}

export async function obtenerPlaneacionPorId(ctx: ContextoPlaneacion, id: string): Promise<ResultadoPlaneacion<{ planeacion: Planeacion; proyectos: PlaneacionProyecto[] }>> {
  const resDocente = await resolverDocenteId(ctx.supabase)
  if (!resDocente.ok) return resDocente
  const docenteId = resDocente.datos

  const { data: planeacion, error: errorPlaneacion } = await ctx.supabase
    .from('planeaciones')
    .select(COLUMNAS_PLANEACION)
    .eq('id', id)
    .gt('version', 0) // oculta una fila todavía sin confirmar, igual que listarPlaneaciones
    .maybeSingle()
  if (errorPlaneacion) return fallo('ERROR_SUPABASE', 'No se pudo verificar la planeación.')
  if (!planeacion) return fallo('PLANEACION_NO_ENCONTRADA', 'Planeación no encontrada.')
  if ((planeacion as Planeacion).docente_id !== docenteId) return fallo('PLANEACION_AJENA', 'No tienes acceso a esta planeación.')

  const { data: proyectos, error: errorProyectos } = await ctx.supabase
    .from('planeacion_proyectos')
    .select(COLUMNAS_PROYECTO)
    .eq('planeacion_id', id)
    .order('orden', { ascending: true })
  if (errorProyectos) return fallo('ERROR_SUPABASE', 'No se pudieron leer los proyectos de la planeación.')

  return exito({ planeacion: planeacion as Planeacion, proyectos: (proyectos || []) as PlaneacionProyecto[] })
}

// docente_id y grupo_id NO forman parte de este tipo a propósito — es
// imposible pasarlos por error en una edición ordinaria.
export type DatosActualizarPlaneacion = Partial<Pick<Planeacion, 'nombre' | 'proposito' | 'fecha_inicio' | 'fecha_fin' | 'periodo_evaluacion_id' | 'estado'>>

export async function actualizarPlaneacion(ctx: ContextoPlaneacion, id: string, cambios: DatosActualizarPlaneacion): Promise<ResultadoPlaneacion<Planeacion>> {
  const resDocente = await resolverDocenteId(ctx.supabase)
  if (!resDocente.ok) return resDocente
  const docenteId = resDocente.datos

  const { data: actual, error: errorActual } = await ctx.supabase
    .from('planeaciones')
    .select('id, docente_id, version')
    .eq('id', id)
    .maybeSingle()
  if (errorActual) return fallo('ERROR_SUPABASE', 'No se pudo verificar la planeación.')
  if (!actual) return fallo('PLANEACION_NO_ENCONTRADA', 'Planeación no encontrada.')
  if ((actual as { docente_id: string }).docente_id !== docenteId) return fallo('PLANEACION_AJENA', 'No tienes acceso a esta planeación.')

  // Cambios parciales reales — nunca se sobrescribe un campo que no
  // vino en `cambios` (undefined se omite, nunca se convierte en null).
  const cambiosContenido: Record<string, unknown> = {}
  if (cambios.nombre !== undefined) cambiosContenido.nombre = cambios.nombre
  if (cambios.proposito !== undefined) cambiosContenido.proposito = cambios.proposito
  if (cambios.fecha_inicio !== undefined) cambiosContenido.fecha_inicio = cambios.fecha_inicio
  if (cambios.fecha_fin !== undefined) cambiosContenido.fecha_fin = cambios.fecha_fin
  if (cambios.periodo_evaluacion_id !== undefined) cambiosContenido.periodo_evaluacion_id = cambios.periodo_evaluacion_id

  const huboCambioDeContenido = Object.keys(cambiosContenido).length > 0
  const actualizacion: Record<string, unknown> = { ...cambiosContenido, actualizado_en: new Date().toISOString() }
  if (cambios.estado !== undefined) actualizacion.estado = cambios.estado
  if (huboCambioDeContenido) actualizacion.version = (actual as { version: number }).version + 1

  const { data: planeacion, error: errorUpdate } = await ctx.supabase
    .from('planeaciones')
    .update(actualizacion)
    .eq('id', id)
    .select(COLUMNAS_PLANEACION)
    .single()
  if (errorUpdate || !planeacion) return fallo('ERROR_SUPABASE', errorUpdate?.message || 'No se pudo actualizar la planeación.')

  return exito(planeacion as Planeacion)
}

// Promueve una planeación creada con version=0 (centinela de "creación
// en dos fases, todavía sin confirmar" — ver aprobarBorrador.ts, C-005
// Paso 3C) a su estado final visible, incrementando version a 1 de
// forma explícita. Distinta de actualizarPlaneacion A PROPÓSITO: esa
// función nunca incrementa version en un cambio puro de estado (así
// debe seguir siendo — archivar una planeación ya completa no es un
// cambio de contenido). Aquí SIEMPRE se pasa de 0 a 1, porque ese
// cambio es exactamente la señal que listarPlaneaciones y
// obtenerPlaneacionPorId usan (filtro version>0) para dejar de
// ocultarla. Nunca usar esta función para nada que no sea esa
// promoción — para editar una planeación ya confirmada, usar
// actualizarPlaneacion.
export async function confirmarPlaneacion(ctx: ContextoPlaneacion, id: string, estado: EstadoPlaneacion): Promise<ResultadoPlaneacion<Planeacion>> {
  const resDocente = await resolverDocenteId(ctx.supabase)
  if (!resDocente.ok) return resDocente
  const docenteId = resDocente.datos

  const { data: actual, error: errorActual } = await ctx.supabase
    .from('planeaciones')
    .select('id, docente_id, version')
    .eq('id', id)
    .maybeSingle()
  if (errorActual) return fallo('ERROR_SUPABASE', 'No se pudo verificar la planeación.')
  if (!actual) return fallo('PLANEACION_NO_ENCONTRADA', 'Planeación no encontrada.')
  if ((actual as { docente_id: string }).docente_id !== docenteId) return fallo('PLANEACION_AJENA', 'No tienes acceso a esta planeación.')

  const { data: planeacion, error: errorUpdate } = await ctx.supabase
    .from('planeaciones')
    .update({ estado, version: 1, actualizado_en: new Date().toISOString() })
    .eq('id', id)
    .select(COLUMNAS_PLANEACION)
    .single()
  if (errorUpdate || !planeacion) return fallo('ERROR_SUPABASE', errorUpdate?.message || 'No se pudo confirmar la planeación.')

  return exito(planeacion as Planeacion)
}

// Cambia únicamente el estado — nunca DELETE, conserva contenido,
// fechas y relaciones. No incrementa version (no es un cambio de
// contenido, mismo criterio que ya usa PATCH del endpoint HTTP).
export async function archivarPlaneacion(ctx: ContextoPlaneacion, id: string): Promise<ResultadoPlaneacion<Planeacion>> {
  const resDocente = await resolverDocenteId(ctx.supabase)
  if (!resDocente.ok) return resDocente
  const docenteId = resDocente.datos

  const { data: actual, error: errorActual } = await ctx.supabase
    .from('planeaciones')
    .select('id, docente_id')
    .eq('id', id)
    .maybeSingle()
  if (errorActual) return fallo('ERROR_SUPABASE', 'No se pudo verificar la planeación.')
  if (!actual) return fallo('PLANEACION_NO_ENCONTRADA', 'Planeación no encontrada.')
  if ((actual as { docente_id: string }).docente_id !== docenteId) return fallo('PLANEACION_AJENA', 'No tienes acceso a esta planeación.')

  const { data: planeacion, error: errorUpdate } = await ctx.supabase
    .from('planeaciones')
    .update({ estado: 'archivada', actualizado_en: new Date().toISOString() })
    .eq('id', id)
    .select(COLUMNAS_PLANEACION)
    .single()
  if (errorUpdate || !planeacion) return fallo('ERROR_SUPABASE', errorUpdate?.message || 'No se pudo archivar la planeación.')

  return exito(planeacion as Planeacion)
}
