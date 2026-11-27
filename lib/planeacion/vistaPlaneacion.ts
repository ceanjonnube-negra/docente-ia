// lib/planeacion/vistaPlaneacion.ts
//
// Hito 2, etapa 5a — pestaña Planeación: biblioteca de solo lectura de las
// planeaciones publicadas del grupo activo. Sin IA y sin escrituras.
//
// Fuentes canónicas (RLS del docente, aislamiento por grupo explícito):
// - planeaciones: nombre, fechas y versión vigente;
// - planeacion_versiones: campo formativo, sesiones, contenido,
//   indicadores, archivos y hoja de CADA versión (la estructura de la
//   versión, nunca la proyección planeacion_proyectos);
// - hojas_evaluacion: hoja asociada a la versión; su estado real lo da
//   /api/proyectos-seguimiento/[id]/estado-captura (el mismo que Evaluación).
//
// La lista carga solo lo necesario; el contenido completo y el historial
// de versiones se cargan al abrir el detalle.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { EstadoCapturaHoja } from '../seguimiento/estadoCapturaHoja'
import { admiteCapturaAutomatica } from '../seguimiento/capturaAutomatica'

// ------------------------------------------------------------------
// Presentación (pura)
// ------------------------------------------------------------------
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']
const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
const FECHA = /^(\d{4})-(\d{2})-(\d{2})/

// Fechas de calendario (AAAA-MM-DD): se leen tal cual, sin zona horaria.
function partes(fecha: string | null): { anio: number; mes: number; dia: number } | null {
  const m = fecha?.match(FECHA)
  return m ? { anio: Number(m[1]), mes: Number(m[2]) - 1, dia: Number(m[3]) } : null
}

// "24 – 30 nov", "24 nov – 7 dic", "28 dic 2026 – 9 ene 2027".
export function rangoFechas(inicio: string | null, fin: string | null): string | null {
  const a = partes(inicio)
  const b = partes(fin)
  if (!a) return null
  const corta = (p: { mes: number; dia: number }) => `${p.dia} ${MESES_CORTOS[p.mes]}`
  if (!b) return corta(a)
  if (a.anio !== b.anio) return `${corta(a)} ${a.anio} – ${corta(b)} ${b.anio}`
  if (a.mes === b.mes) return a.dia === b.dia ? corta(a) : `${a.dia} – ${corta(b)}`
  return `${corta(a)} – ${corta(b)}`
}

export function textoSesiones(n: number | null): string | null {
  if (!n || n < 1) return null
  return n === 1 ? '1 sesión' : `${n} sesiones`
}

type ProyectoEstructura = { campos_formativos?: string[]; duracion_dias?: number; actividades?: unknown[]; indicadores?: string[] }
export type EstructuraVersion = { proyecto?: ProyectoEstructura } | null

export function campoFormativoDe(estructura: EstructuraVersion): string | null {
  const campos = (estructura?.proyecto?.campos_formativos ?? []).filter((c) => typeof c === 'string' && c.trim())
  if (campos.length === 0) return null
  return campos.length === 1 ? campos[0] : `${campos[0]} +${campos.length - 1}`
}

export function sesionesDe(estructura: EstructuraVersion): number | null {
  const p = estructura?.proyecto
  if (typeof p?.duracion_dias === 'number' && p.duracion_dias > 0) return p.duracion_dias
  return Array.isArray(p?.actividades) && p.actividades.length > 0 ? p.actividades.length : null
}

// admiteCaptura: false en una hoja histórica sin registro de alumnos congelado
// (su estado es permanente: no se consulta estado-captura).
export type HojaResumen = { id: string; codigo: string; proyectoId: string; reemplazada: boolean; admiteCaptura: boolean }

export type ResumenPlaneacion = {
  id: string
  nombre: string
  fechaInicio: string | null
  fechaFin: string | null
  versionVigente: number
  campoFormativo: string | null
  sesiones: number | null
  hoja: HojaResumen | null
  creadoEn: string
}

export type GrupoMensual = { clave: string; etiqueta: string; planeaciones: ResumenPlaneacion[] }

// Biblioteca por mes de inicio, del más reciente al más antiguo (y dentro
// del mes, la más reciente primero). Sin fechas: al final. Nunca se
// deduce si una planeación ya se implementó: solo se ordena.
export function agruparPorMes(planeaciones: ResumenPlaneacion[]): GrupoMensual[] {
  const grupos = new Map<string, GrupoMensual>()
  for (const p of planeaciones) {
    const f = partes(p.fechaInicio)
    const clave = f ? `${f.anio}-${String(f.mes + 1).padStart(2, '0')}` : 'sin-fecha'
    const etiqueta = f ? `${MESES[f.mes][0].toUpperCase()}${MESES[f.mes].slice(1)} ${f.anio}` : 'Sin fechas'
    if (!grupos.has(clave)) grupos.set(clave, { clave, etiqueta, planeaciones: [] })
    grupos.get(clave)!.planeaciones.push(p)
  }
  const porFecha = (a: ResumenPlaneacion, b: ResumenPlaneacion) =>
    (b.fechaInicio ?? '').localeCompare(a.fechaInicio ?? '') || b.creadoEn.localeCompare(a.creadoEn) || a.nombre.localeCompare(b.nombre, 'es')
  return [...grupos.values()]
    .map((g) => ({ ...g, planeaciones: [...g.planeaciones].sort(porFecha) }))
    .sort((a, b) => (a.clave === 'sin-fecha' ? 1 : b.clave === 'sin-fecha' ? -1 : b.clave.localeCompare(a.clave)))
}

export const ORIGEN_VERSION: Record<string, string> = { aprobacion: 'Aprobación', modificacion: 'Modificación', derivada: 'Derivada' }

// ------------------------------------------------------------------
// Carga (cliente del docente, RLS)
// ------------------------------------------------------------------
type FilaPlaneacion = { id: string; nombre: string | null; fecha_inicio: string | null; fecha_fin: string | null; version: number; creado_en: string }
type FilaVersionResumen = { planeacion_id: string; numero: number; hoja_id: string | null; campos: string[] | null; dias: number | null; actividades: unknown[] | null }
type FilaHoja = { id: string; identificador_visible: string; proyecto_id: string; reemplazada_por: string | null; primer_alumno: unknown }

export class ErrorVistaPlaneacion extends Error {}

async function hojasPorId(sb: SupabaseClient, ids: string[]): Promise<Map<string, HojaResumen>> {
  if (ids.length === 0) return new Map()
  const { data, error } = await sb.from('hojas_evaluacion').select('id, identificador_visible, proyecto_id, reemplazada_por, primer_alumno:roster_congelado->0').in('id', ids)
  if (error) throw new ErrorVistaPlaneacion('No se pudieron leer las hojas de evaluación.')
  return new Map(((data ?? []) as FilaHoja[]).map((h) => [h.id, { id: h.id, codigo: h.identificador_visible, proyectoId: h.proyecto_id, reemplazada: h.reemplazada_por !== null, admiteCaptura: admiteCapturaAutomatica(h.primer_alumno) }]))
}

// Planeaciones publicadas del grupo, con los datos de su versión vigente.
export async function cargarResumenPlaneaciones(sb: SupabaseClient, grupoId: string): Promise<ResumenPlaneacion[]> {
  const { data, error } = await sb
    .from('planeaciones')
    .select('id, nombre, fecha_inicio, fecha_fin, version, creado_en')
    .eq('grupo_id', grupoId)
    .eq('estado', 'publicada')
  if (error) throw new ErrorVistaPlaneacion('No se pudieron leer las planeaciones del grupo.')
  const planeaciones = (data ?? []) as FilaPlaneacion[]
  if (planeaciones.length === 0) return []

  const { data: versiones, error: errorVersiones } = await sb
    .from('planeacion_versiones')
    .select('planeacion_id, numero, hoja_id, campos:estructura->proyecto->campos_formativos, dias:estructura->proyecto->duracion_dias, actividades:estructura->proyecto->actividades')
    .eq('grupo_id', grupoId)
    .in('planeacion_id', planeaciones.map((p) => p.id))
  if (errorVersiones) throw new ErrorVistaPlaneacion('No se pudieron leer las versiones de las planeaciones.')
  const vigentes = new Map<string, FilaVersionResumen>()
  const vigentePorPlaneacion = new Map(planeaciones.map((p) => [p.id, p.version]))
  for (const v of (versiones ?? []) as FilaVersionResumen[]) if (vigentePorPlaneacion.get(v.planeacion_id) === v.numero) vigentes.set(v.planeacion_id, v)

  const hojas = await hojasPorId(sb, [...new Set([...vigentes.values()].map((v) => v.hoja_id).filter((x): x is string => !!x))])
  return planeaciones.map((p) => {
    const v = vigentes.get(p.id)
    const estructura: EstructuraVersion = v ? { proyecto: { campos_formativos: v.campos ?? undefined, duracion_dias: v.dias ?? undefined, actividades: v.actividades ?? undefined } } : null
    return {
      id: p.id,
      nombre: p.nombre?.trim() || 'Planeación sin título',
      fechaInicio: p.fecha_inicio,
      fechaFin: p.fecha_fin,
      versionVigente: p.version,
      campoFormativo: campoFormativoDe(estructura),
      sesiones: sesionesDe(estructura),
      hoja: v?.hoja_id ? hojas.get(v.hoja_id) ?? null : null,
      creadoEn: p.creado_en,
    }
  })
}

export type VersionDetalle = {
  id: string
  numero: number
  origen: string
  contenido: string | null
  estructura: EstructuraVersion
  hoja: HojaResumen | null
  tieneWord: boolean
  tienePdf: boolean
  creadaEn: string
}

export type DetallePlaneacion = {
  id: string
  nombre: string
  fechaInicio: string | null
  fechaFin: string | null
  versionVigente: number
  versiones: VersionDetalle[] // de la más reciente a la más antigua
}

type FilaVersion = {
  id: string; numero: number; origen: string; contenido: string | null; estructura: EstructuraVersion; hoja_id: string | null
  documento_word_archivo_id: string | null; documento_pdf_archivo_id: string | null; creada_en: string
}

// Detalle de una planeación publicada del grupo activo (null si no es de
// ese grupo o del docente): todas sus versiones con su contenido.
export async function cargarDetallePlaneacion(sb: SupabaseClient, grupoId: string, planeacionId: string): Promise<DetallePlaneacion | null> {
  const { data: p, error } = await sb
    .from('planeaciones')
    .select('id, nombre, fecha_inicio, fecha_fin, version, creado_en')
    .eq('id', planeacionId)
    .eq('grupo_id', grupoId)
    .eq('estado', 'publicada')
    .maybeSingle()
  if (error) throw new ErrorVistaPlaneacion('No se pudo leer la planeación.')
  if (!p) return null
  const planeacion = p as FilaPlaneacion
  const { data, error: errorVersiones } = await sb
    .from('planeacion_versiones')
    .select('id, numero, origen, contenido, estructura, hoja_id, documento_word_archivo_id, documento_pdf_archivo_id, creada_en')
    .eq('planeacion_id', planeacionId)
    .eq('grupo_id', grupoId)
    .order('numero', { ascending: false })
  if (errorVersiones) throw new ErrorVistaPlaneacion('No se pudieron leer las versiones de la planeación.')
  const filas = (data ?? []) as FilaVersion[]
  const hojas = await hojasPorId(sb, [...new Set(filas.map((v) => v.hoja_id).filter((x): x is string => !!x))])
  return {
    id: planeacion.id,
    nombre: planeacion.nombre?.trim() || 'Planeación sin título',
    fechaInicio: planeacion.fecha_inicio,
    fechaFin: planeacion.fecha_fin,
    versionVigente: planeacion.version,
    versiones: filas.map((v) => ({
      id: v.id,
      numero: v.numero,
      origen: v.origen,
      contenido: v.contenido,
      estructura: v.estructura,
      hoja: v.hoja_id ? hojas.get(v.hoja_id) ?? null : null,
      tieneWord: v.documento_word_archivo_id !== null,
      tienePdf: v.documento_pdf_archivo_id !== null,
      creadaEn: v.creada_en,
    })),
  }
}

// Estado real de las hojas (la misma ruta que Evaluación), por proyecto.
export async function cargarEstadosEvaluacion(token: string, proyectoIds: string[], solicitar: typeof fetch = fetch): Promise<Record<string, EstadoCapturaHoja>> {
  const unicos = [...new Set(proyectoIds)]
  const pares = await Promise.all(unicos.map(async (id) => {
    try {
      const res = await solicitar(`/api/proyectos-seguimiento/${id}/estado-captura`, { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) return null
      const json = (await res.json()) as { estado?: EstadoCapturaHoja }
      return json.estado ? ([id, json.estado] as const) : null
    } catch {
      return null
    }
  }))
  return Object.fromEntries(pares.filter((x): x is readonly [string, EstadoCapturaHoja] => x !== null))
}
