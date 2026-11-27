// lib/seguimiento/historialGrupo.ts
//
// EVAL-1K — read-model acumulativo del historial grupal, construido
// EXCLUSIVAMENTE a partir de lo que resultadosProyectoGrupo()
// (lib/motorContexto.ts) ya devuelve en 1 sola query. Pura,
// determinista, 0 IA, 0 I/O, 0 conocimiento de autenticación/React/
// APIs — mismo criterio de capas que
// lib/seguimiento/resultadosConfirmados.ts (EVAL-1J) y
// construirMatrizRevision() (confirmarResultadosHoja.ts): nunca se
// mezcla la responsabilidad de LEER (motorContexto.ts) con la de
// REORGANIZAR en memoria (este archivo).
//
// Deliberadamente NO calcula: promedio, porcentaje convertido a
// calificación, nivel final, nivel predominante, semáforo,
// recomendación, progreso o tendencia inferida — ninguna conclusión
// pedagógica automática. Solo reestructura y cuenta datos ya
// existentes (ver RESUMEN más abajo).
//
// nivel/aspecto_general LLEGAN a resultadosProyectoGrupo() mediante
// `(data || []) as unknown as ResultadoProyectoGrupo[]`
// (lib/motorContexto.ts) — un doble cast de TypeScript, nunca una
// validación en runtime: el cliente de Supabase no verifica contra
// ningún CHECK, solo entrega el JSON crudo de la fila. Esta capa es
// la PRIMERA frontera real donde el dato externo se valida de verdad
// antes de usarse — mismo principio fail-closed ya aplicado en EVAL-1J
// (lib/seguimiento/resultadosConfirmados.ts): un valor fuera del
// dominio canónico real nunca se convierte, aproxima, ni deja crear
// una categoría dinámica nueva — la fila completa se excluye de forma
// explícita y visible (ver entradasInvalidasExcluidas), nunca de
// "primero/último gana" ni en silencio.

import type { ResultadoProyectoGrupo } from '../motorContexto'
import type { AspectoGeneral } from './tipos'
import { ASPECTOS_GENERALES } from './tipos'
import type { NivelTextoCanonico } from './conversionCalificacion'
import { resolverPeriodoDeProyecto, type PeriodoReferencia, type PeriodoResuelto } from './periodoProyecto'
import type { ProyectoDeResultado } from '../motorContexto'

// Único lugar de este archivo donde se escriben los 5 valores
// literales — tanto la plantilla de conteo (distribucionNivelesVacia)
// como el validador de dominio (esNivelValido) se derivan de aquí,
// nunca se repiten sueltos. Mismo dominio canónico documentado en
// conversionCalificacion.ts (NivelTextoCanonico, CHECK real de
// seguimiento_resultados.nivel) — no existe hoy un array exportado
// equivalente en ese archivo (solo el tipo TypeScript, que un cast no
// garantiza en runtime), así que se declara aquí explícitamente en
// vez de reimportar el Set privado y no exportado de
// resultadosConfirmados.ts (eso habría exigido tocar un archivo de
// EVAL-1J, fuera del alcance de esta fase).
const NIVELES_TEXTO_CANONICO: NivelTextoCanonico[] = ['destacado', 'logrado', 'en_proceso', 'requiere_apoyo', 'no_evaluado']
const NIVELES_TEXTO_CANONICO_VALIDOS = new Set<string>(NIVELES_TEXTO_CANONICO)

// Reutiliza el array YA EXPORTADO de lib/seguimiento/tipos.ts — nunca
// se duplica la lista de valores de AspectoGeneral, solo se deriva un
// Set de búsqueda O(1) a partir de la fuente real ya existente.
const ASPECTOS_GENERALES_VALIDOS = new Set<string>(ASPECTOS_GENERALES.map((a) => a.valor))

function esNivelValido(valor: unknown): valor is NivelTextoCanonico {
  return typeof valor === 'string' && NIVELES_TEXTO_CANONICO_VALIDOS.has(valor)
}

function esAspectoGeneralValido(valor: unknown): valor is AspectoGeneral {
  return typeof valor === 'string' && ASPECTOS_GENERALES_VALIDOS.has(valor)
}

// Las 5 claves se inicializan en 0 explícitamente (nunca solo las que
// aparecieron en los datos) — un nivel con 0 ocurrencias reales debe
// verse como 0, nunca estar ausente del resumen.
function distribucionNivelesVacia(): Record<NivelTextoCanonico, number> {
  return Object.fromEntries(NIVELES_TEXTO_CANONICO.map((n) => [n, 0])) as Record<NivelTextoCanonico, number>
}

export type IndicadorConfirmadoGrupo = {
  indicadorNumero: number
  indicadorEspecifico: string
  aspectoGeneral: AspectoGeneral
  nivel: NivelTextoCanonico
}

// Metadata de un proyecto: SOLO lo que el embed de resultadosProyecto*()
// ya trae (Hito 3: nombre, grupo, ciclo, campos formativos y fechas
// reales) más el periodo resuelto de forma determinista
// (periodoProyecto.ts). Nunca se inventa un dato que no venga del embed.
export type ProyectoHistorialGrupo = {
  proyectoId: string
  confirmadoEn: string | null
  periodoEvaluacionId: string | null
  nombre: string | null
  grupoId: string | null
  cicloEscolarId: string | null
  camposFormativos: string[]
  // Solo si el proyecto tiene UN campo formativo: los indicadores no
  // guardan su campo, así que con varios no se atribuye a ninguno.
  campoFormativo: string | null
  fechaInicio: string | null
  fechaFin: string | null
  periodo: PeriodoResuelto | null
}

// Conteo directo por alumno y proyecto. «Sin evaluar» (no_evaluado: la
// hoja no tiene marca) es AUSENCIA de evaluación, nunca un nivel bajo;
// «Requiere apoyo» es un nivel confirmado. Nunca se mezclan.
export type ConteoAlumnoProyecto = {
  evaluados: number
  sinEvaluar: number
  requiereApoyo: number
}

// Solo identidad del proyecto: el resto de su metadata vive una sola vez
// en HistorialGrupo.proyectos (no se duplica por alumno).
export type ProyectoDeAlumno = {
  proyectoId: string
  confirmadoEn: string | null
  periodoEvaluacionId: string | null
  conteo: ConteoAlumnoProyecto
  // Ordenados por indicadorNumero ascendente (sección 8) — nunca se
  // repite proyectoId/alumnoId/inscripcionId aquí dentro: ya los fija
  // el nodo padre (alumno) y el nodo abuelo (este mismo proyecto), ver
  // "no duplicar innecesariamente todas las filas en varias
  // representaciones".
  indicadores: IndicadorConfirmadoGrupo[]
}

export type AlumnoHistorialGrupo = {
  alumnoId: string
  inscripcionId: string
  // Ordenados por confirmadoEn desc, proyectoId asc como desempate
  // (sección 8) — mismo criterio que la lista de proyectos del nivel
  // superior.
  proyectos: ProyectoDeAlumno[]
}

// Agregados DETERMINISTAS permitidos (sección 7) — exclusivamente
// conteo directo de datos existentes, nunca promedio/porcentaje/nivel
// final/semáforo/recomendación.
export type ResumenHistorialGrupo = {
  proyectosConfirmados: number
  alumnosConResultados: number
  totalIndicadoresConfirmados: number
  distribucionNiveles: Record<NivelTextoCanonico, number>
  distribucionNivelesPorAspecto: Record<AspectoGeneral, Record<NivelTextoCanonico, number>>
}

export type PeriodoPresente = { id: string; nombre: string; numero: number }

export type HistorialGrupo = {
  proyectos: ProyectoHistorialGrupo[]
  // Periodos con al menos un proyecto (por número), y cuántos proyectos
  // quedaron «Sin periodo asignado».
  periodos: PeriodoPresente[]
  proyectosSinPeriodo: number
  alumnos: AlumnoHistorialGrupo[]
  resumen: ResumenHistorialGrupo
  // Nunca "primero gana" ni "último gana" (sección 9): cuenta cuántas
  // FILAS se excluyeron de la reconstrucción/resumen por compartir una
  // identidad lógica (proyecto_id + inscripcion_id + indicador_numero)
  // con otra fila — el UNIQUE real de la tabla debería impedirlo, pero
  // esta función nunca asume esa garantía sin verificarla. 0 en el
  // caso normal; cualquier valor > 0 es una señal visible de
  // inconsistencia real en los datos, nunca oculta en silencio.
  entradasAmbiguasExcluidas: number
  // Cuenta cuántas FILAS se excluyeron porque `nivel` y/o
  // `aspecto_general` no pertenecen al dominio canónico real (ver
  // esNivelValido/esAspectoGeneralValido) — nunca por duplicado de
  // identidad (eso es entradasAmbiguasExcluidas, campo separado a
  // propósito: son dos motivos de exclusión distintos, cada contador
  // debe reflejar exactamente lo que cuenta). 0 en el caso normal.
  entradasInvalidasExcluidas: number
}

function claveIdentidad(fila: ResultadoProyectoGrupo): string {
  return `${fila.proyecto_id}:${fila.inscripcion_id}:${fila.indicador_numero}`
}

// Pura, determinista, 0 IA, 0 I/O. Recibe exactamente lo que
// resultadosProyectoGrupo() ya devuelve — nunca consulta Supabase ni
// conoce cómo se obtuvieron esas filas.
// Metadata de un proyecto (una sola regla para proyectos con o sin
// resultados del alumno): datos reales del registro + periodo resuelto
// con los periodos de SU ciclo.
export function metadataDeProyecto(
  proyectoId: string,
  ps: ProyectoDeResultado | null,
  periodos: (PeriodoReferencia & { ciclo_escolar_id?: string })[]
): ProyectoHistorialGrupo {
  const cicloEscolarId = ps?.ciclo_escolar_id ?? null
  const camposFormativos = (ps?.campos_formativos ?? []).slice()
  const meta = { periodoEvaluacionId: ps?.periodo_evaluacion_id ?? null, fechaInicio: ps?.fecha_inicio ?? null, fechaFin: ps?.fecha_fin ?? null }
  return {
    proyectoId,
    confirmadoEn: ps?.confirmado_en ?? null,
    ...meta,
    nombre: ps?.nombre ?? null,
    grupoId: ps?.grupo_id ?? null,
    cicloEscolarId,
    camposFormativos,
    campoFormativo: camposFormativos.length === 1 ? camposFormativos[0] : null,
    periodo: resolverPeriodoDeProyecto(meta, periodos.filter((p) => !p.ciclo_escolar_id || p.ciclo_escolar_id === cicloEscolarId)),
  }
}

// Filtro opcional (concentrado, Chat): por periodo resuelto ('sin_periodo'
// = proyectos sin periodo asignado) y/o por campo formativo del proyecto.
// Se aplica ANTES de construir, así estructura y resumen son coherentes.
export type FiltroHistorial = { periodoId?: string | 'sin_periodo'; campoFormativo?: string }

// Regla única del filtro (historial, concentrado, Chat).
export function cumpleFiltro(p: ProyectoHistorialGrupo, filtro: FiltroHistorial): boolean {
  const porPeriodo = filtro.periodoId === undefined || (filtro.periodoId === 'sin_periodo' ? p.periodo === null : p.periodo?.id === filtro.periodoId)
  const porCampo = filtro.campoFormativo === undefined || p.camposFormativos.includes(filtro.campoFormativo)
  return porPeriodo && porCampo
}

// Conteo directo de niveles de una lista de indicadores (las 5 claves).
export function distribucionDe(indicadores: { nivel: NivelTextoCanonico }[]): Record<NivelTextoCanonico, number> {
  const d = distribucionNivelesVacia()
  for (const i of indicadores) d[i.nivel]++
  return d
}

// periodos: los del ciclo (o de varios ciclos, con ciclo_escolar_id) para
// resolver el periodo de cada proyecto. Sin ellos, solo se usa nada: todo
// proyecto queda «Sin periodo asignado» salvo que el periodo registrado
// esté en la lista.
export function construirHistorialGrupo(
  filas: ResultadoProyectoGrupo[],
  periodos: (PeriodoReferencia & { ciclo_escolar_id?: string })[] = [],
  filtro: FiltroHistorial = {}
): HistorialGrupo {
  // Paso 1a — detectar duplicados de identidad ANTES de construir
  // nada: una clave vista más de una vez se marca ambigua (las N
  // filas que la comparten, no solo la 2ª en adelante) — nunca
  // "primero gana"/"último gana".
  const vistas = new Set<string>()
  const ambiguas = new Set<string>()
  for (const fila of filas) {
    const clave = claveIdentidad(fila)
    if (vistas.has(clave)) ambiguas.add(clave)
    vistas.add(clave)
  }

  // Paso 1b — un solo recorrido que excluye, de forma EXPLÍCITA y
  // contada (nunca en silencio), dos motivos distintos de exclusión:
  // identidad ambigua (arriba) y dominio inválido de nivel/aspecto_general
  // (la frontera runtime real frente a lo que Supabase devuelve — ver
  // comentario superior del archivo). Una fila con cualquiera de los
  // dos problemas queda fuera de TODA la reconstrucción (estructura Y
  // resumen) — nunca se convierte, aproxima, ni crea una categoría
  // dinámica nueva.
  let entradasAmbiguasExcluidas = 0
  let entradasInvalidasExcluidas = 0
  const filasValidas: ResultadoProyectoGrupo[] = []
  for (const fila of filas) {
    if (ambiguas.has(claveIdentidad(fila))) {
      entradasAmbiguasExcluidas++
      continue
    }
    if (!esNivelValido(fila.nivel) || !esAspectoGeneralValido(fila.aspecto_general)) {
      entradasInvalidasExcluidas++
      continue
    }
    filasValidas.push(fila)
  }

  // Paso 2 — proyectos presentes (deduplicados por proyecto_id;
  // confirmadoEn/periodoEvaluacionId vienen del embed ya incluido en
  // cada fila, nunca de una consulta adicional).
  const proyectosPorId = new Map<string, ProyectoHistorialGrupo>()
  for (const fila of filasValidas) {
    if (!proyectosPorId.has(fila.proyecto_id)) proyectosPorId.set(fila.proyecto_id, metadataDeProyecto(fila.proyecto_id, fila.proyectos_seguimiento, periodos))
  }
  // Filtro (periodo / campo formativo) sobre proyectos completos.
  for (const [id, p] of proyectosPorId) if (!cumpleFiltro(p, filtro)) proyectosPorId.delete(id)
  const filasIncluidas = filasValidas.filter((f) => proyectosPorId.has(f.proyecto_id))
  const compararProyectos = (a: { proyectoId: string; confirmadoEn: string | null }, b: { proyectoId: string; confirmadoEn: string | null }): number => {
    const confirmadoA = a.confirmadoEn ?? ''
    const confirmadoB = b.confirmadoEn ?? ''
    if (confirmadoA !== confirmadoB) return confirmadoB.localeCompare(confirmadoA)
    return a.proyectoId.localeCompare(b.proyectoId)
  }
  const proyectos = Array.from(proyectosPorId.values()).sort(compararProyectos)

  // Paso 3 — alumnos presentes, cada uno con sus proyectos anidados e
  // indicadores dentro de cada proyecto. inscripcion_id es la clave de
  // agrupación (identidad canónica real de un resultado, ver UNIQUE de
  // seguimiento_resultados) — alumno_id se conserva como dato, nunca
  // como clave, porque un alumno puede tener más de una inscripción.
  type ProyectoDeAlumnoMutable = ProyectoDeAlumno
  const alumnosPorInscripcion = new Map<string, { alumnoId: string; inscripcionId: string; proyectos: Map<string, ProyectoDeAlumnoMutable> }>()

  for (const fila of filasIncluidas) {
    let alumno = alumnosPorInscripcion.get(fila.inscripcion_id)
    if (!alumno) {
      alumno = { alumnoId: fila.alumno_id, inscripcionId: fila.inscripcion_id, proyectos: new Map() }
      alumnosPorInscripcion.set(fila.inscripcion_id, alumno)
    }
    let proyectoDeAlumno = alumno.proyectos.get(fila.proyecto_id)
    if (!proyectoDeAlumno) {
      proyectoDeAlumno = {
        proyectoId: fila.proyecto_id,
        confirmadoEn: fila.proyectos_seguimiento?.confirmado_en ?? null,
        periodoEvaluacionId: fila.proyectos_seguimiento?.periodo_evaluacion_id ?? null,
        conteo: { evaluados: 0, sinEvaluar: 0, requiereApoyo: 0 },
        indicadores: [],
      }
      alumno.proyectos.set(fila.proyecto_id, proyectoDeAlumno)
    }
    if (fila.nivel === 'no_evaluado') proyectoDeAlumno.conteo.sinEvaluar++
    else proyectoDeAlumno.conteo.evaluados++
    if (fila.nivel === 'requiere_apoyo') proyectoDeAlumno.conteo.requiereApoyo++
    proyectoDeAlumno.indicadores.push({
      indicadorNumero: fila.indicador_numero,
      indicadorEspecifico: fila.indicador_especifico,
      aspectoGeneral: fila.aspecto_general,
      nivel: fila.nivel,
    })
  }

  const alumnos: AlumnoHistorialGrupo[] = Array.from(alumnosPorInscripcion.values())
    .map((alumno) => ({
      alumnoId: alumno.alumnoId,
      inscripcionId: alumno.inscripcionId,
      proyectos: Array.from(alumno.proyectos.values())
        .map((p) => ({ ...p, indicadores: p.indicadores.slice().sort((a, b) => a.indicadorNumero - b.indicadorNumero) }))
        .sort(compararProyectos),
    }))
    .sort((a, b) => a.inscripcionId.localeCompare(b.inscripcionId))

  // Paso 4 — resumen agregado: solo conteo directo, inicializando las
  // 5 claves de nivel/aspecto en 0 para que una categoría sin
  // ocurrencias se vea como 0, nunca como ausente.
  const distribucionNiveles = distribucionNivelesVacia()
  const distribucionNivelesPorAspecto = Object.fromEntries(
    ASPECTOS_GENERALES.map((a) => [a.valor, distribucionNivelesVacia()])
  ) as Record<AspectoGeneral, Record<NivelTextoCanonico, number>>

  for (const fila of filasIncluidas) {
    distribucionNiveles[fila.nivel]++
    distribucionNivelesPorAspecto[fila.aspecto_general][fila.nivel]++
  }

  const resumen: ResumenHistorialGrupo = {
    proyectosConfirmados: proyectos.length,
    alumnosConResultados: alumnos.length,
    totalIndicadoresConfirmados: filasIncluidas.length,
    distribucionNiveles,
    distribucionNivelesPorAspecto,
  }

  const periodosPresentes = new Map<string, PeriodoPresente>()
  for (const p of proyectos) if (p.periodo) periodosPresentes.set(p.periodo.id, { id: p.periodo.id, nombre: p.periodo.nombre, numero: p.periodo.numero })
  return {
    proyectos,
    periodos: [...periodosPresentes.values()].sort((a, b) => a.numero - b.numero || a.id.localeCompare(b.id)),
    proyectosSinPeriodo: proyectos.filter((p) => !p.periodo).length,
    alumnos,
    resumen,
    entradasAmbiguasExcluidas,
    entradasInvalidasExcluidas,
  }
}

// Celda alumno × proyecto: distingue «sin registro» (la inscripción no
// tiene resultados en ese proyecto) de un proyecto con resultados (y,
// dentro, «sin evaluar» de un nivel confirmado).
export type CeldaHistorial = { estado: 'sin_registro' } | { estado: 'con_resultados'; proyecto: ProyectoDeAlumno }
export function celdaHistorial(historial: HistorialGrupo, inscripcionId: string, proyectoId: string): CeldaHistorial {
  const p = historial.alumnos.find((a) => a.inscripcionId === inscripcionId)?.proyectos.find((x) => x.proyectoId === proyectoId)
  return p ? { estado: 'con_resultados', proyecto: p } : { estado: 'sin_registro' }
}

// Necesidades de apoyo: EXCLUSIVAMENTE indicadores confirmados en
// «Requiere apoyo», con su proyecto — un hecho verificable, nunca una
// etiqueta del alumno ni una conclusión inferida.
export type IndicadorConApoyo = { proyectoId: string; indicadorNumero: number; indicadorEspecifico: string }
export function indicadoresQueRequierenApoyo(alumno: AlumnoHistorialGrupo): IndicadorConApoyo[] {
  return alumno.proyectos.flatMap((p) => p.indicadores.filter((i) => i.nivel === 'requiere_apoyo').map((i) => ({ proyectoId: p.proyectoId, indicadorNumero: i.indicadorNumero, indicadorEspecifico: i.indicadorEspecifico })))
}

// ------------------------------------------------------------------
// Historial individual (Hito 3b): organiza el MISMO historial por ciclo →
// inscripción → periodo → proyecto. Pura y determinista. Un proyecto
// confirmado del grupo de una inscripción sin resultados de ese alumno es
// «sin registro» (distinto de «sin evaluar», que es un indicador sin marca
// dentro de un proyecto con resultados).
// ------------------------------------------------------------------
export type InscripcionHistorial = {
  inscripcionId: string
  grupoId: string
  cicloEscolarId: string
  estatus: string | null
  fechaInscripcion: string | null
  grupoNombre: string | null
  cicloNombre: string | null
}

export type ProyectoEnHistorialAlumno =
  | { estado: 'con_resultados'; proyecto: ProyectoHistorialGrupo; resultado: ProyectoDeAlumno; distribucion: Record<NivelTextoCanonico, number> }
  | { estado: 'sin_registro'; proyecto: ProyectoHistorialGrupo }

export type PeriodoEnHistorialAlumno = { periodo: PeriodoPresente | null; proyectos: ProyectoEnHistorialAlumno[] }
export type InscripcionEnHistorialAlumno = { inscripcion: InscripcionHistorial; periodos: PeriodoEnHistorialAlumno[] }
export type CicloEnHistorialAlumno = { cicloEscolarId: string; cicloNombre: string | null; inscripciones: InscripcionEnHistorialAlumno[] }

export type HistorialAlumno = {
  ciclos: CicloEnHistorialAlumno[]
  // Proyectos con resultados confirmados del alumno (todas sus inscripciones).
  proyectosConResultados: { proyecto: ProyectoHistorialGrupo; resultado: ProyectoDeAlumno }[]
  ultimaConfirmacion: string | null
  entradasExcluidas: number
}

const ordenFecha = (a: string | null, b: string | null) => (b ?? '').localeCompare(a ?? '')

export function organizarHistorialAlumno(
  historial: HistorialGrupo,
  inscripciones: InscripcionHistorial[],
  proyectosDeSusGrupos: ProyectoHistorialGrupo[]
): HistorialAlumno {
  const metaPorId = new Map(historial.proyectos.map((p) => [p.proyectoId, p]))
  const porInscripcion = new Map<string, InscripcionHistorial>(inscripciones.map((i) => [i.inscripcionId, i]))
  // Resultados de una inscripción que no llegó en la lista (no debería
  // ocurrir): se conserva con los datos reales del proyecto, nunca se pierde.
  for (const a of historial.alumnos) {
    if (porInscripcion.has(a.inscripcionId)) continue
    const m = metaPorId.get(a.proyectos[0]?.proyectoId ?? '')
    if (m?.grupoId && m.cicloEscolarId) porInscripcion.set(a.inscripcionId, { inscripcionId: a.inscripcionId, grupoId: m.grupoId, cicloEscolarId: m.cicloEscolarId, estatus: null, fechaInscripcion: null, grupoNombre: null, cicloNombre: null })
  }

  const conResultados: HistorialAlumno['proyectosConResultados'] = []
  const proyectosPorInscripcion = new Map<string, ProyectoEnHistorialAlumno[]>()
  const agregar = (ins: string, p: ProyectoEnHistorialAlumno) => proyectosPorInscripcion.set(ins, [...(proyectosPorInscripcion.get(ins) ?? []), p])
  for (const a of historial.alumnos) {
    for (const r of a.proyectos) {
      const proyecto = metaPorId.get(r.proyectoId)
      if (!proyecto) continue
      const distribucion = distribucionDe(r.indicadores)
      agregar(a.inscripcionId, { estado: 'con_resultados', proyecto, resultado: r, distribucion })
      conResultados.push({ proyecto, resultado: r })
    }
  }
  // «Sin registro»: proyectos confirmados del grupo y ciclo de la inscripción sin resultados del alumno.
  for (const ins of porInscripcion.values()) {
    const propios = new Set((proyectosPorInscripcion.get(ins.inscripcionId) ?? []).map((p) => p.proyecto.proyectoId))
    for (const p of proyectosDeSusGrupos) {
      if (p.grupoId === ins.grupoId && p.cicloEscolarId === ins.cicloEscolarId && !propios.has(p.proyectoId)) agregar(ins.inscripcionId, { estado: 'sin_registro', proyecto: p })
    }
  }

  const ciclos = new Map<string, CicloEnHistorialAlumno>()
  const inscripcionesOrdenadas = [...porInscripcion.values()].sort((a, b) =>
    (a.estatus === 'activo' ? 0 : 1) - (b.estatus === 'activo' ? 0 : 1) || ordenFecha(a.fechaInscripcion, b.fechaInscripcion) || a.inscripcionId.localeCompare(b.inscripcionId))
  for (const ins of inscripcionesOrdenadas) {
    const proyectos = proyectosPorInscripcion.get(ins.inscripcionId) ?? []
    const porPeriodo = new Map<string, PeriodoEnHistorialAlumno>()
    for (const p of proyectos) {
      const clave = p.proyecto.periodo?.id ?? ''
      if (!porPeriodo.has(clave)) porPeriodo.set(clave, { periodo: p.proyecto.periodo ? { id: p.proyecto.periodo.id, nombre: p.proyecto.periodo.nombre, numero: p.proyecto.periodo.numero } : null, proyectos: [] })
      porPeriodo.get(clave)!.proyectos.push(p)
    }
    const periodos = [...porPeriodo.values()]
      .map((g) => ({ ...g, proyectos: g.proyectos.sort((a, b) => ordenFecha(a.proyecto.confirmadoEn, b.proyecto.confirmadoEn) || a.proyecto.proyectoId.localeCompare(b.proyecto.proyectoId)) }))
      // Periodos por número; «Sin periodo asignado» al final.
      .sort((a, b) => (a.periodo ? a.periodo.numero : Infinity) - (b.periodo ? b.periodo.numero : Infinity) || (a.periodo?.id ?? '').localeCompare(b.periodo?.id ?? ''))
    if (!ciclos.has(ins.cicloEscolarId)) ciclos.set(ins.cicloEscolarId, { cicloEscolarId: ins.cicloEscolarId, cicloNombre: ins.cicloNombre, inscripciones: [] })
    ciclos.get(ins.cicloEscolarId)!.inscripciones.push({ inscripcion: ins, periodos })
  }

  conResultados.sort((a, b) => ordenFecha(a.proyecto.confirmadoEn, b.proyecto.confirmadoEn) || a.proyecto.proyectoId.localeCompare(b.proyecto.proyectoId))
  return {
    ciclos: [...ciclos.values()],
    proyectosConResultados: conResultados,
    ultimaConfirmacion: conResultados[0]?.proyecto.confirmadoEn ?? null,
    entradasExcluidas: historial.entradasAmbiguasExcluidas + historial.entradasInvalidasExcluidas,
  }
}

// ------------------------------------------------------------------
// Concentrado grupal (Hito 3c): el MISMO historial del grupo, filtrado con
// cumpleFiltro, visto por proyecto y por alumno. Pura y determinista; solo
// conteos directos (nunca promedios, calificaciones ni conclusiones).
// «Sin registro» solo para inscripciones ACTIVAS sin resultados en un
// proyecto; una baja aparece únicamente si tiene resultados.
// ------------------------------------------------------------------
export type InscripcionDelGrupo = { inscripcionId: string; alumnoId: string; nombre: string; estatus: string | null }

export type ProyectoEnConcentrado = {
  proyecto: ProyectoHistorialGrupo
  distribucion: Record<NivelTextoCanonico, number>
  alumnosConResultados: number
  sinRegistro: number
  indicadoresRequierenApoyo: number
}
export type CeldaConcentrado =
  | { estado: 'con_resultados'; proyecto: ProyectoHistorialGrupo; resultado: ProyectoDeAlumno; distribucion: Record<NivelTextoCanonico, number> }
  | { estado: 'sin_registro'; proyecto: ProyectoHistorialGrupo }
export type AlumnoEnConcentrado = {
  inscripcion: InscripcionDelGrupo
  distribucion: Record<NivelTextoCanonico, number>
  requiereApoyo: number
  sinEvaluar: number
  sinRegistro: number
  proyectos: CeldaConcentrado[]
  apoyo: IndicadorConApoyo[]
}
export type ConcentradoGrupo = {
  // Opciones de filtro: de TODOS los proyectos (no solo los filtrados).
  opciones: { periodos: PeriodoPresente[]; haySinPeriodo: boolean; campos: string[] }
  proyectos: ProyectoEnConcentrado[]
  alumnos: AlumnoEnConcentrado[]
  distribucion: Record<NivelTextoCanonico, number>
  indicadoresRequierenApoyo: number
  alumnosConIndicadoresEnApoyo: number
  entradasExcluidas: number
}

export function construirConcentradoGrupo(historial: HistorialGrupo, inscripciones: InscripcionDelGrupo[], filtro: FiltroHistorial = {}): ConcentradoGrupo {
  const proyectos = historial.proyectos.filter((p) => cumpleFiltro(p, filtro))
  const resultadosPorInscripcion = new Map(historial.alumnos.map((a) => [a.inscripcionId, a]))
  const porInscripcion = new Map(inscripciones.map((i) => [i.inscripcionId, i]))
  for (const a of historial.alumnos) {
    if (!porInscripcion.has(a.inscripcionId)) porInscripcion.set(a.inscripcionId, { inscripcionId: a.inscripcionId, alumnoId: a.alumnoId, nombre: 'Alumno sin nombre registrado', estatus: null })
  }
  // Activas + cualquiera con resultados en los proyectos filtrados.
  const visibles = [...porInscripcion.values()].filter((i) => i.estatus === 'activo' || resultadosPorInscripcion.get(i.inscripcionId)?.proyectos.some((r) => proyectos.some((p) => p.proyectoId === r.proyectoId)))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es') || a.inscripcionId.localeCompare(b.inscripcionId))

  const alumnos: AlumnoEnConcentrado[] = visibles.map((ins) => {
    const propio = resultadosPorInscripcion.get(ins.inscripcionId)
    const celdas: CeldaConcentrado[] = []
    for (const p of proyectos) {
      const r = propio?.proyectos.find((x) => x.proyectoId === p.proyectoId)
      if (r) celdas.push({ estado: 'con_resultados', proyecto: p, resultado: r, distribucion: distribucionDe(r.indicadores) })
      else if (ins.estatus === 'activo') celdas.push({ estado: 'sin_registro', proyecto: p })
    }
    const indicadores = celdas.flatMap((c) => (c.estado === 'con_resultados' ? c.resultado.indicadores : []))
    const ids = new Set(proyectos.map((p) => p.proyectoId))
    return {
      inscripcion: ins,
      distribucion: distribucionDe(indicadores),
      requiereApoyo: indicadores.filter((i) => i.nivel === 'requiere_apoyo').length,
      sinEvaluar: indicadores.filter((i) => i.nivel === 'no_evaluado').length,
      sinRegistro: celdas.filter((c) => c.estado === 'sin_registro').length,
      proyectos: celdas,
      apoyo: propio ? indicadoresQueRequierenApoyo(propio).filter((x) => ids.has(x.proyectoId)) : [],
    }
  })

  const enProyectos: ProyectoEnConcentrado[] = proyectos.map((p) => {
    const celdas = alumnos.map((a) => a.proyectos.find((c) => c.proyecto.proyectoId === p.proyectoId)).filter((c): c is CeldaConcentrado => !!c)
    const indicadores = celdas.flatMap((c) => (c.estado === 'con_resultados' ? c.resultado.indicadores : []))
    return {
      proyecto: p,
      distribucion: distribucionDe(indicadores),
      alumnosConResultados: celdas.filter((c) => c.estado === 'con_resultados').length,
      sinRegistro: celdas.filter((c) => c.estado === 'sin_registro').length,
      indicadoresRequierenApoyo: indicadores.filter((i) => i.nivel === 'requiere_apoyo').length,
    }
  })

  const todos = alumnos.flatMap((a) => a.proyectos.flatMap((c) => (c.estado === 'con_resultados' ? c.resultado.indicadores : [])))
  const campos = [...new Set(historial.proyectos.flatMap((p) => p.camposFormativos))].sort((a, b) => a.localeCompare(b, 'es'))
  return {
    opciones: { periodos: historial.periodos, haySinPeriodo: historial.proyectosSinPeriodo > 0, campos },
    proyectos: enProyectos,
    alumnos,
    distribucion: distribucionDe(todos),
    indicadoresRequierenApoyo: todos.filter((i) => i.nivel === 'requiere_apoyo').length,
    alumnosConIndicadoresEnApoyo: alumnos.filter((a) => a.requiereApoyo > 0).length,
    entradasExcluidas: historial.entradasAmbiguasExcluidas + historial.entradasInvalidasExcluidas,
  }
}
