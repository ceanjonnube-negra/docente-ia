// lib/seguimiento/contratoHistorial.ts
//
// Hito 3e — contrato ESTABLE del historial académico para el Hito 4
// (fichas descriptivas y reportes). Es una vista versionada, tipada y
// serializable (JSON puro, determinista) del MISMO modelo de lectura
// (historialGrupo.ts): no consulta nada propio, no guarda nada, no usa IA.
// Los consumidores dependen de este contrato y no de la forma interna del
// modelo, que puede seguir evolucionando.
//
// Reglas que el contrato hace explícitas:
//   - solo resultados CONFIRMADOS (seguimiento_resultados);
//   - alcance estricto: un alumno = su inscripción en UN grupo y ciclo;
//   - «Requiere apoyo» (nivel confirmado), «Sin evaluar» (indicador sin
//     marca: ausencia de evaluación) y «Sin registro» (sin resultados en
//     un proyecto) nunca se mezclan;
//   - sin calificaciones, promedios ni conclusiones: niveles y conteos;
//   - campo formativo atribuido solo si el proyecto tiene uno;
//   - lo que falta se declara en «avisos», nunca se rellena.

import type { SupabaseClient } from '@supabase/supabase-js'
import { ASPECTOS_GENERALES, type AspectoGeneral } from './tipos'
import { ETIQUETA_NIVEL_CANONICO, type NivelTextoCanonico } from './conversionCalificacion'
import { datosConcentradoGrupo, historialAlumnoCompleto } from './historialAcademico'
import {
  construirConcentradoGrupo,
  distribucionDe,
  type ConcentradoGrupo,
  type FiltroHistorial,
  type HistorialAlumno,
  type IndicadorConfirmadoGrupo,
  type ProyectoDeAlumno,
  type ProyectoHistorialGrupo,
} from './historialGrupo'

export const VERSION_CONTRATO_HISTORIAL = 1 as const

export type DistribucionNiveles = Record<NivelTextoCanonico, number>

export type IndicadorContrato = {
  numero: number
  texto: string
  aspecto: { valor: AspectoGeneral; etiqueta: string }
  nivel: NivelTextoCanonico
  etiquetaNivel: string
  // false = «Sin evaluar» (casilla sin marca), nunca un nivel bajo.
  evaluado: boolean
}

export type PeriodoContrato = { id: string; nombre: string; numero: number }

export type ProyectoContrato = {
  proyectoId: string
  nombre: string | null
  camposFormativos: string[]
  // Solo con un campo; con varios, null (los indicadores no guardan su campo).
  campoFormativoAtribuido: string | null
  fechaInicio: string | null
  fechaFin: string | null
  confirmadoEn: string | null
  // null = «Sin periodo asignado». origen: registrado o deducido de las fechas.
  periodo: (PeriodoContrato & { origen: 'registrado' | 'fechas' }) | null
}

export type ConteoContrato = { indicadores: number; evaluados: number; sinEvaluar: number; requiereApoyo: number }

export type ResultadoProyectoContrato =
  | { estado: 'con_resultados'; proyecto: ProyectoContrato; distribucion: DistribucionNiveles; conteo: ConteoContrato; indicadores: IndicadorContrato[] }
  | { estado: 'sin_registro'; proyecto: ProyectoContrato }

export type IndicadorEnApoyoContrato = { proyectoId: string; numero: number; texto: string }

export type AvisoContrato =
  | { codigo: 'sin_resultados_confirmados' }
  | { codigo: 'proyectos_sin_periodo'; cantidad: number }
  | { codigo: 'proyectos_sin_registro'; cantidad: number }
  | { codigo: 'entradas_excluidas'; cantidad: number }

export type HistorialAcademicoAlumnoV1 = {
  version: typeof VERSION_CONTRATO_HISTORIAL
  alcance: { alumnoId: string; inscripcionId: string; estatus: string | null; grupoId: string; grupoNombre: string | null; cicloEscolarId: string; cicloNombre: string | null }
  // Por número de periodo; «Sin periodo asignado» (periodo null) al final.
  periodos: { periodo: PeriodoContrato | null; proyectos: ResultadoProyectoContrato[] }[]
  resumen: { proyectosConResultados: number; proyectosSinRegistro: number; distribucion: DistribucionNiveles; conteo: ConteoContrato; indicadoresEnApoyo: IndicadorEnApoyoContrato[] }
  avisos: AvisoContrato[]
}

export type AlumnoEnGrupoContrato = {
  alumnoId: string
  inscripcionId: string
  nombre: string
  estatus: string | null
  distribucion: DistribucionNiveles
  conteo: ConteoContrato & { sinRegistro: number }
  proyectos: ResultadoProyectoContrato[]
  indicadoresEnApoyo: IndicadorEnApoyoContrato[]
}

export type HistorialAcademicoGrupoV1 = {
  version: typeof VERSION_CONTRATO_HISTORIAL
  alcance: { grupoId: string; grupoNombre: string | null; cicloEscolarId: string; filtro: FiltroHistorial }
  proyectos: { proyecto: ProyectoContrato; distribucion: DistribucionNiveles; alumnosConResultados: number; sinRegistro: number; indicadoresRequierenApoyo: number }[]
  alumnos: AlumnoEnGrupoContrato[]
  resumen: { proyectos: number; alumnos: number; distribucion: DistribucionNiveles; indicadoresRequierenApoyo: number; alumnosConIndicadoresEnApoyo: number }
  avisos: AvisoContrato[]
}

// ------------------------------------------------------------------
// Construcción (pura)
// ------------------------------------------------------------------
const ETIQUETA_ASPECTO = new Map(ASPECTOS_GENERALES.map((a) => [a.valor, a.etiqueta]))

function proyectoContrato(p: ProyectoHistorialGrupo): ProyectoContrato {
  return {
    proyectoId: p.proyectoId,
    nombre: p.nombre,
    camposFormativos: p.camposFormativos.slice(),
    campoFormativoAtribuido: p.campoFormativo,
    fechaInicio: p.fechaInicio,
    fechaFin: p.fechaFin,
    confirmadoEn: p.confirmadoEn,
    periodo: p.periodo ? { id: p.periodo.id, nombre: p.periodo.nombre, numero: p.periodo.numero, origen: p.periodo.origen } : null,
  }
}

function indicadorContrato(i: IndicadorConfirmadoGrupo): IndicadorContrato {
  return {
    numero: i.indicadorNumero,
    texto: i.indicadorEspecifico,
    aspecto: { valor: i.aspectoGeneral, etiqueta: ETIQUETA_ASPECTO.get(i.aspectoGeneral) ?? i.aspectoGeneral },
    nivel: i.nivel,
    etiquetaNivel: ETIQUETA_NIVEL_CANONICO[i.nivel],
    evaluado: i.nivel !== 'no_evaluado',
  }
}

function conteoDe(indicadores: { nivel: NivelTextoCanonico }[]): ConteoContrato {
  const evaluados = indicadores.filter((i) => i.nivel !== 'no_evaluado').length
  return { indicadores: indicadores.length, evaluados, sinEvaluar: indicadores.length - evaluados, requiereApoyo: indicadores.filter((i) => i.nivel === 'requiere_apoyo').length }
}

function resultadoContrato(p: ProyectoHistorialGrupo, r: ProyectoDeAlumno | null): ResultadoProyectoContrato {
  if (!r) return { estado: 'sin_registro', proyecto: proyectoContrato(p) }
  return { estado: 'con_resultados', proyecto: proyectoContrato(p), distribucion: distribucionDe(r.indicadores), conteo: conteoDe(r.indicadores), indicadores: r.indicadores.map(indicadorContrato) }
}

const enApoyo = (rs: ResultadoProyectoContrato[]): IndicadorEnApoyoContrato[] =>
  rs.flatMap((r) => (r.estado === 'con_resultados' ? r.indicadores.filter((i) => i.nivel === 'requiere_apoyo').map((i) => ({ proyectoId: r.proyecto.proyectoId, numero: i.numero, texto: i.texto })) : []))

function avisos(proyectos: ProyectoContrato[], conResultados: number, sinRegistro: number, excluidas: number): AvisoContrato[] {
  const a: AvisoContrato[] = []
  if (conResultados === 0) a.push({ codigo: 'sin_resultados_confirmados' })
  const sinPeriodo = proyectos.filter((p) => !p.periodo).length
  if (sinPeriodo) a.push({ codigo: 'proyectos_sin_periodo', cantidad: sinPeriodo })
  if (sinRegistro) a.push({ codigo: 'proyectos_sin_registro', cantidad: sinRegistro })
  if (excluidas) a.push({ codigo: 'entradas_excluidas', cantidad: excluidas })
  return a
}

// Alumno: SOLO su inscripción en el grupo y ciclo indicados; null si no la tiene.
export function contratoAlumno(h: HistorialAlumno, alumnoId: string, grupoId: string, cicloEscolarId: string): HistorialAcademicoAlumnoV1 | null {
  const ins = h.ciclos.flatMap((c) => c.inscripciones).find((i) => i.inscripcion.grupoId === grupoId && i.inscripcion.cicloEscolarId === cicloEscolarId)
  if (!ins) return null
  const periodos = ins.periodos.map((g) => ({
    periodo: g.periodo ? { id: g.periodo.id, nombre: g.periodo.nombre, numero: g.periodo.numero } : null,
    proyectos: g.proyectos.map((x) => resultadoContrato(x.proyecto, x.estado === 'con_resultados' ? x.resultado : null)),
  }))
  const todos = periodos.flatMap((g) => g.proyectos)
  const con = todos.filter((r) => r.estado === 'con_resultados')
  const indicadores = con.flatMap((r) => (r.estado === 'con_resultados' ? r.indicadores : []))
  const sinRegistro = todos.length - con.length
  return {
    version: VERSION_CONTRATO_HISTORIAL,
    alcance: { alumnoId, inscripcionId: ins.inscripcion.inscripcionId, estatus: ins.inscripcion.estatus, grupoId, grupoNombre: ins.inscripcion.grupoNombre, cicloEscolarId, cicloNombre: ins.inscripcion.cicloNombre },
    periodos,
    resumen: { proyectosConResultados: con.length, proyectosSinRegistro: sinRegistro, distribucion: distribucionDe(indicadores), conteo: conteoDe(indicadores), indicadoresEnApoyo: enApoyo(todos) },
    avisos: avisos(todos.map((r) => r.proyecto), con.length, sinRegistro, h.entradasExcluidas),
  }
}

// Grupo: el concentrado (ya filtrado) del grupo y ciclo indicados.
export function contratoGrupo(c: ConcentradoGrupo, alcance: { grupoId: string; grupoNombre: string | null; cicloEscolarId: string; filtro: FiltroHistorial }): HistorialAcademicoGrupoV1 {
  const alumnos: AlumnoEnGrupoContrato[] = c.alumnos.map((a) => {
    const proyectos = a.proyectos.map((x) => resultadoContrato(x.proyecto, x.estado === 'con_resultados' ? x.resultado : null))
    const indicadores = proyectos.flatMap((r) => (r.estado === 'con_resultados' ? r.indicadores : []))
    return {
      alumnoId: a.inscripcion.alumnoId,
      inscripcionId: a.inscripcion.inscripcionId,
      nombre: a.inscripcion.nombre,
      estatus: a.inscripcion.estatus,
      distribucion: distribucionDe(indicadores),
      conteo: { ...conteoDe(indicadores), sinRegistro: a.sinRegistro },
      proyectos,
      indicadoresEnApoyo: enApoyo(proyectos),
    }
  })
  const proyectos = c.proyectos.map((p) => ({ proyecto: proyectoContrato(p.proyecto), distribucion: p.distribucion, alumnosConResultados: p.alumnosConResultados, sinRegistro: p.sinRegistro, indicadoresRequierenApoyo: p.indicadoresRequierenApoyo }))
  return {
    version: VERSION_CONTRATO_HISTORIAL,
    alcance: { ...alcance, filtro: { ...alcance.filtro } },
    proyectos,
    alumnos,
    resumen: { proyectos: proyectos.length, alumnos: alumnos.length, distribucion: c.distribucion, indicadoresRequierenApoyo: c.indicadoresRequierenApoyo, alumnosConIndicadoresEnApoyo: c.alumnosConIndicadoresEnApoyo },
    avisos: avisos(proyectos.map((p) => p.proyecto), proyectos.length, proyectos.reduce((s, p) => s + p.sinRegistro, 0), c.entradasExcluidas),
  }
}

// ------------------------------------------------------------------
// Obtención (reutiliza las mismas lecturas; sin consultas propias)
// ------------------------------------------------------------------
export async function obtenerHistorialAcademicoAlumno(sb: SupabaseClient, alumnoId: string, docenteId: string, grupoId: string, cicloEscolarId: string): Promise<HistorialAcademicoAlumnoV1 | null> {
  return contratoAlumno(await historialAlumnoCompleto(sb, alumnoId, docenteId), alumnoId, grupoId, cicloEscolarId)
}

export async function obtenerHistorialAcademicoGrupo(sb: SupabaseClient, alcance: { grupoId: string; grupoNombre: string | null; cicloEscolarId: string }, filtro: FiltroHistorial = {}): Promise<HistorialAcademicoGrupoV1> {
  const d = await datosConcentradoGrupo(sb, alcance.grupoId, alcance.cicloEscolarId)
  return contratoGrupo(construirConcentradoGrupo(d.historial, d.inscripciones, filtro), { ...alcance, filtro })
}
