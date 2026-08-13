// lib/asistente/herramientasModulo.ts
//
// Separación estricta entre conversación libre y consultas de módulos
// internos (ver "Corrección de arquitectura — separación estricta
// entre conversación libre y consultas de módulos internos"). Para
// CUALQUIER intención que el Clasificador de Nivel 0 reconozca como
// una consulta a un módulo (Asistencias, Incidencias, Apoyo,
// Documentos, y cualquier futura), la respuesta SIEMPRE sale de una
// Herramienta ejecutada con éxito, formateada de forma determinista —
// nunca del modelo grande componiendo texto libre. Si la herramienta
// falla o los datos indispensables no están, se responde con un error
// controlado o una aclaración, pero JAMÁS se deja que el LLM complete
// la respuesta con una inferencia.
//
// Qué NO vive aquí a propósito: ficha_descriptiva, planeacion_nueva y
// consultar_calendario. Esos tres son generación/razonamiento real
// sobre datos reales inyectados (un documento redactado, una
// respuesta sobre un rango de fechas en lenguaje natural) — la
// composición del texto ES el producto, no un bug a eliminar. La
// garantía que sí aplica ahí (y ya aplica) es "nunca redactar sin
// datos reales de por medio", no "cero composición" — ver el bloque
// Nivel 4 en app/api/chat/route.ts. Tratar de forzarlos a un molde de
// "cero LLM" produciría una ficha llena de espacios en blanco en vez
// de un perfil redactado, que es exactamente lo que se pidió construir.
//
// Tampoco viven aquí las escrituras (marcar_asistencia_individual,
// registrar_asistencia) ni la navegación (consultar_alumno_lista,
// navegar_alumno_lista, navegar_lista_filtrada) — ya son 100%
// deterministas desde antes (nunca pasan por el modelo grande), solo
// que con una forma de resultado distinta (confirmación de escritura,
// marcador de navegación) a la de "formatearRespuesta(datos): string"
// que usa este registro.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ClasificacionNivel0 } from '../clasificadorNivel0'
import type { SesionContexto } from '../sesionContexto'
import type { CampoAlumnoCorregible, DiferenciaAlumno } from './tipos'
import {
  aplicarCorreccionAlumno,
  asistenciaGrupoResumen,
  calcularPorcentajeAsistencia,
  consultarAsistenciaAlumno,
  contextoAlumno,
  documentosDelDocente,
  incidenciasAlumno,
  necesidadesApoyoGrupo,
  periodosEvaluacionDelCiclo,
  validarValorCampoAlumno,
  type ConteoAsistencia,
  type PeriodoEvaluacion,
} from '../motorContexto'
import { formatearFecha } from '../tiempo/TimeService'
import { listarPlaneaciones, obtenerPlaneacionPorId } from '../planeacion/persistencia'
import type { EstadoPlaneacion, Planeacion } from '../planeacion/tipos'

export type ResultadoHerramientaModulo<T> = { exito: true; datos: T } | { exito: false; error: string }

export type ContextoEjecucionHerramienta = {
  sb: SupabaseClient
  sesion: SesionContexto
  userId: string | null
  zonaHoraria: string | null | undefined
  // Solo para ajustar la brevedad de la respuesta en el canal de voz
  // (ver planeacion_consultar, C-005 Paso 3A) — 'voice' cuando el
  // turno vino de conversación hablada (channel==="voice" en
  // app/api/chat/route.ts), 'text'/undefined en cualquier otro caso.
  // Las herramientas existentes no lo usan — campo opcional, aditivo.
  canal?: 'voice' | 'text'
  // Solo para corregir_dato_alumno — id real de la conversación
  // (ver contexto.conversacionId en app/api/chat/route.ts), para que
  // la trazabilidad en correcciones_alumno pueda enlazarla cuando
  // exista. Opcional/aditivo, ninguna otra Herramienta lo usa.
  conversacionId?: string | null
}

type DisponibilidadHerramienta = { listo: true } | { listo: false; mensaje: string }

export type DefinicionHerramientaModulo<TDatos> = {
  intent: string
  // Se corre ANTES de ejecutar: ¿hay lo indispensable (alumno
  // resuelto, grupo activo con ciclo escolar, etc.)? Si no, regresa el
  // mensaje de aclaración determinista — nunca se ejecuta a medias ni
  // se cae al modelo grande a "improvisar" por falta de un dato.
  puedeEjecutar: (clasificacion: ClasificacionNivel0, ctx: ContextoEjecucionHerramienta) => DisponibilidadHerramienta
  ejecutar: (clasificacion: ClasificacionNivel0, ctx: ContextoEjecucionHerramienta) => Promise<ResultadoHerramientaModulo<TDatos>>
  formatearRespuesta: (datos: TDatos, clasificacion: ClasificacionNivel0, ctx: ContextoEjecucionHerramienta) => string
}

function definir<T>(def: DefinicionHerramientaModulo<T>): DefinicionHerramientaModulo<unknown> {
  return def as DefinicionHerramientaModulo<unknown>
}

// --- Asistencia de un alumno (ciclo completo) ---
const herramientaConsultarAsistencia = definir({
  intent: 'consultar_asistencia',
  puedeEjecutar: (clasificacion, ctx) => {
    if (!clasificacion.entidades_resueltas.alumno_id) return { listo: false, mensaje: '¿De qué alumno quieres consultar la asistencia?' }
    if (!ctx.sesion.ciclo_escolar_id) return { listo: false, mensaje: 'No tengo un grupo activo con ciclo escolar configurado para consultar la asistencia.' }
    return { listo: true }
  },
  ejecutar: async (clasificacion, ctx) => {
    try {
      const datos = await consultarAsistenciaAlumno(ctx.sb, clasificacion.entidades_resueltas.alumno_id!, ctx.sesion.ciclo_escolar_id!)
      return { exito: true, datos }
    } catch (e) {
      console.error('[HERRAMIENTA] consultar_asistencia — fallo consultando:', e)
      return { exito: false, error: 'No fue posible consultar la asistencia registrada' }
    }
  },
  formatearRespuesta: (datos: { faltas: number; retardos: number; justificadas: number; dias_registrados: number }, clasificacion) => {
    const nombre = clasificacion.entidades_resueltas.alumno_nombre_detectado || 'ese alumno'
    return `${nombre} lleva ${datos.faltas} falta(s), ${datos.retardos} retardo(s) y ${datos.justificadas} justificada(s) de ${datos.dias_registrados} días registrados este ciclo escolar.`
  },
})

// --- Asistencia del grupo completo, hoy ---
const herramientaConsultarAsistenciaGrupo = definir({
  intent: 'consultar_asistencia_grupo',
  puedeEjecutar: (_clasificacion, ctx) => {
    if (!ctx.sesion.grupo_activo_id) return { listo: false, mensaje: 'No tengo un grupo activo configurado para consultar la asistencia de hoy.' }
    return { listo: true }
  },
  ejecutar: async (_clasificacion, ctx) => {
    try {
      const resumen = await asistenciaGrupoResumen(ctx.sb, ctx.sesion.grupo_activo_id!, ctx.sesion.fecha_actual)
      return { exito: true, datos: resumen }
    } catch (e) {
      console.error('[HERRAMIENTA] consultar_asistencia_grupo — fallo consultando:', e)
      return { exito: false, error: 'No fue posible consultar la asistencia del grupo' }
    }
  },
  formatearRespuesta: (
    datos: { fecha: string; presentes: string[]; faltas: string[]; retardos: string[]; sinRegistrarHoy: string[] },
    clasificacion,
    ctx
  ) => {
    // Total = los 4 estados oficiales (ver clasificarEstadoAsistencia
    // en lib/motorContexto.ts) — "sin registrar" cuenta para el total
    // de alumnos, nunca para el % de asistencia. calcularPorcentajeAsistencia
    // (lib/motorContexto.ts) es la ÚNICA función de todo el proyecto
    // que calcula este %: un retardo SÍ cuenta como asistencia, nunca
    // solo los presentes (ver "Corregir el cálculo de asistencia
    // utilizado por el Chat IA").
    const conteo: ConteoAsistencia = {
      presentes: datos.presentes.length,
      faltas: datos.faltas.length,
      retardos: datos.retardos.length,
      sinRegistrar: datos.sinRegistrarHoy.length,
      total: datos.presentes.length + datos.faltas.length + datos.retardos.length + datos.sinRegistrarHoy.length,
    }
    const total = conteo.total

    // Ver "Corregir respuestas excesivas del modo voz": la respuesta
    // debe ajustarse a lo que realmente se preguntó — nunca el reporte
    // completo por default. nivel_detalle_asistencia_grupo/
    // categoria_asistencia_grupo vienen del Clasificador de Nivel 0
    // (regla 5.1). null/desconocido cae en "completo" (comportamiento
    // de siempre) para nunca perder información ante un caso no
    // cubierto por las reglas.
    const nivel = clasificacion.nivel_detalle_asistencia_grupo ?? 'completo'
    const categoria = clasificacion.categoria_asistencia_grupo

    if (nivel === 'cantidad') {
      switch (categoria) {
        case 'faltas':
          return datos.faltas.length === 0 ? 'Nadie faltó hoy.' : datos.faltas.length === 1 ? 'Faltó 1 alumno.' : `Faltaron ${datos.faltas.length} alumnos.`
        case 'presentes':
          return `Hay ${datos.presentes.length} presentes hoy.`
        case 'retardos':
          return datos.retardos.length === 0 ? 'No hubo retardos hoy.' : datos.retardos.length === 1 ? 'Hubo 1 retardo.' : `Hubo ${datos.retardos.length} retardos.`
        case 'total':
          return `El grupo tiene ${total} alumnos en total.`
      }
    }

    if (nivel === 'nombres') {
      switch (categoria) {
        case 'faltas':
          return datos.faltas.length === 0 ? 'Nadie faltó hoy.' : datos.faltas.join(', ')
        case 'presentes':
          return datos.presentes.length === 0 ? 'Nadie ha sido registrado como presente hoy.' : datos.presentes.join(', ')
        case 'retardos':
          return datos.retardos.length === 0 ? 'No hubo retardos hoy.' : datos.retardos.join(', ')
      }
    }

    if (nivel === 'resumen') {
      const porcentajeAsistencia = calcularPorcentajeAsistencia(conteo).toFixed(1)
      return `Total: ${total}. Presentes: ${datos.presentes.length}, ausentes: ${datos.faltas.length}, retardos: ${datos.retardos.length}. Asistencia: ${porcentajeAsistencia}%.`
    }

    // "completo" (o cualquier combinación nivel/categoria no cubierta
    // arriba, ej. nivel="nombres" categoria="total") — el reporte de
    // siempre, sin cambios.
    const fechaLegible = formatearFecha(datos.fecha, ctx.zonaHoraria, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    const porcentajeAsistencia = calcularPorcentajeAsistencia(conteo).toFixed(1)
    const lineas = [
      `Hoy, ${fechaLegible}.`,
      '',
      `Total de alumnos: ${total}`,
      '',
      `✅ Presentes: ${datos.presentes.length}`,
      `❌ Ausentes: ${datos.faltas.length}`,
      `🟡 Retardos: ${datos.retardos.length}`,
    ]
    if (datos.sinRegistrarHoy.length > 0) lineas.push(`⚪ Sin registrar: ${datos.sinRegistrarHoy.length}`)
    lineas.push('', `Asistencia: ${porcentajeAsistencia}%`)
    if (datos.faltas.length > 0) {
      lineas.push('', 'Alumnos ausentes:')
      datos.faltas.forEach((n) => lineas.push(`• ${n}`))
    }
    if (datos.retardos.length > 0) {
      lineas.push('', 'Alumnos con retardo:')
      datos.retardos.forEach((n) => lineas.push(`• ${n}`))
    }
    return lineas.join('\n')
  },
})

// --- Incidencias de un alumno ---
const herramientaConsultarIncidencias = definir({
  intent: 'consultar_incidencias_alumno',
  puedeEjecutar: (clasificacion) => {
    if (!clasificacion.entidades_resueltas.alumno_id) return { listo: false, mensaje: '¿De qué alumno quieres consultar las incidencias?' }
    return { listo: true }
  },
  ejecutar: async (clasificacion, ctx) => {
    try {
      const datos = await incidenciasAlumno(ctx.sb, clasificacion.entidades_resueltas.alumno_id!)
      return { exito: true, datos }
    } catch (e) {
      console.error('[HERRAMIENTA] consultar_incidencias_alumno — fallo consultando:', e)
      return { exito: false, error: 'No fue posible consultar las incidencias registradas' }
    }
  },
  formatearRespuesta: (datos: { total: number; incidencias: { fecha: string; tipo: string; descripcion: string }[] }, clasificacion) => {
    const nombre = clasificacion.entidades_resueltas.alumno_nombre_detectado || 'ese alumno'
    if (datos.total === 0) return `${nombre} no tiene incidencias registradas.`
    return `${nombre} tiene ${datos.total} incidencia(s) registrada(s)${datos.incidencias[0] ? `; la más reciente es del ${datos.incidencias[0].fecha} (${datos.incidencias[0].tipo}).` : '.'}`
  },
})

// --- Necesidades de apoyo del grupo ---
const herramientaConsultarApoyo = definir({
  intent: 'consultar_apoyo',
  puedeEjecutar: (_clasificacion, ctx) => {
    if (!ctx.sesion.grupo_activo_id) return { listo: false, mensaje: 'No tengo un grupo activo configurado para consultar necesidades de apoyo.' }
    return { listo: true }
  },
  ejecutar: async (_clasificacion, ctx) => {
    try {
      const datos = await necesidadesApoyoGrupo(ctx.sb, ctx.sesion.grupo_activo_id!)
      return { exito: true, datos }
    } catch (e) {
      console.error('[HERRAMIENTA] consultar_apoyo — fallo consultando:', e)
      return { exito: false, error: 'No fue posible consultar las necesidades de apoyo registradas' }
    }
  },
  formatearRespuesta: (datos: { nombre: string; tipo: string | null; descripcion: string | null }[]) => {
    if (datos.length === 0) return 'No hay alumnos con necesidad de apoyo registrada todavía.'
    const lineas = [`Alumnos con necesidad de apoyo registrada (${datos.length}):`]
    datos.forEach((a) => lineas.push(`• ${a.nombre}${a.tipo ? ` — ${a.tipo}` : ''}`))
    return lineas.join('\n')
  },
})

// --- Documentos ya generados por el docente ---
const herramientaConsultarDocumentos = definir({
  intent: 'consultar_documentos',
  puedeEjecutar: (_clasificacion, ctx) => {
    if (!ctx.userId) return { listo: false, mensaje: 'No pude identificar tu sesión para consultar tus documentos.' }
    return { listo: true }
  },
  ejecutar: async (_clasificacion, ctx) => {
    try {
      const datos = await documentosDelDocente(ctx.sb, ctx.userId!)
      return { exito: true, datos }
    } catch (e) {
      console.error('[HERRAMIENTA] consultar_documentos — fallo consultando:', e)
      return { exito: false, error: 'No fue posible consultar tus documentos generados' }
    }
  },
  formatearRespuesta: (datos: { total: number; recientes: { titulo: string; tipo: string; fecha: string }[] }, _clasificacion, ctx) => {
    if (datos.total === 0) return 'No has generado ningún documento todavía.'
    const lineas = [`Tienes ${datos.total} documento(s) generado(s). Los más recientes:`]
    datos.recientes.slice(0, 8).forEach((d) => {
      const fecha = formatearFecha(d.fecha, ctx.zonaHoraria, { day: 'numeric', month: 'short', year: 'numeric' })
      lineas.push(`• ${d.titulo} (${d.tipo}) — ${fecha}`)
    })
    return lineas.join('\n')
  },
})

// --- Planeaciones ya guardadas (C-005, Paso 3A — solo lectura) ---
//
// Reutiliza exclusivamente lib/planeacion/persistencia.ts
// (listarPlaneaciones/obtenerPlaneacionPorId), que ya resuelven el
// docente real desde el cliente autenticado y ya filtran por
// docente_id — cero lógica de seguridad nueva aquí. Nunca INSERT,
// UPDATE ni DELETE.

// Quita diacríticos (acentos) tras normalizar a NFD, usando puntos de
// código explícitos (U+0300-U+036F) para no depender de caracteres
// combinantes literales en el código fuente.
const RANGO_DIACRITICOS = new RegExp('[̀-ͯ]', 'g')

function normalizarTexto(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(RANGO_DIACRITICOS, '').trim()
}

const ORDINALES_PERIODO: Record<string, number> = {
  primer: 1, primero: 1, '1': 1, '1er': 1, '1ro': 1, '1°': 1,
  segundo: 2, '2': 2, '2do': 2, '2°': 2,
  tercer: 3, tercero: 3, '3': 3, '3er': 3, '3ro': 3, '3°': 3,
  cuarto: 4, '4': 4, '4to': 4, '4°': 4,
}

function resolverPeriodoPorTexto(periodos: PeriodoEvaluacion[], texto: string): PeriodoEvaluacion | null {
  const normalizado = normalizarTexto(texto)
  for (const [palabra, numero] of Object.entries(ORDINALES_PERIODO)) {
    if (normalizado.includes(palabra)) {
      const encontrado = periodos.find((p) => p.numero_periodo === numero)
      if (encontrado) return encontrado
    }
  }
  return periodos.find((p) => normalizado.includes(normalizarTexto(p.nombre))) || null
}

function filtrarPlaneacionesPorNombre(planeaciones: Planeacion[], texto: string): Planeacion[] {
  const normalizado = normalizarTexto(texto)
  if (!normalizado) return []
  return planeaciones.filter((p) => {
    const nombreNormalizado = normalizarTexto(p.nombre)
    return nombreNormalizado.includes(normalizado) || normalizado.includes(nombreNormalizado)
  })
}

const ETIQUETA_ESTADO_PLANEACION: Record<EstadoPlaneacion, string> = {
  borrador: 'en borrador',
  publicada: 'publicada',
  archivada: 'archivada',
}

function formatearRangoFechas(p: Planeacion, zonaHoraria: string | null | undefined): string {
  if (!p.fecha_inicio && !p.fecha_fin) return 'sin fechas asignadas'
  const opciones: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }
  const inicio = p.fecha_inicio ? formatearFecha(p.fecha_inicio, zonaHoraria, opciones) : '(sin inicio)'
  const fin = p.fecha_fin ? formatearFecha(p.fecha_fin, zonaHoraria, opciones) : '(sin fin)'
  return `${inicio} – ${fin}`
}

function etiquetaPeriodo(p: Planeacion, periodos: PeriodoEvaluacion[]): string {
  const periodo = periodos.find((per) => per.id === p.periodo_evaluacion_id)
  return periodo?.nombre || 'sin periodo asignado'
}

function formatearPlaneacionDetalle(p: Planeacion, periodos: PeriodoEvaluacion[], zonaHoraria: string | null | undefined, voz: boolean): string {
  const periodo = etiquetaPeriodo(p, periodos)
  const fechas = formatearRangoFechas(p, zonaHoraria)
  const estado = ETIQUETA_ESTADO_PLANEACION[p.estado]
  if (voz) return `${p.nombre}, ${periodo}, del ${fechas}, ${estado}.`
  return [`**${p.nombre}**`, `Periodo: ${periodo}`, `Fechas: ${fechas}`, `Estado: ${estado}`].join('\n')
}

function formatearPlaneacionesLista(planeaciones: Planeacion[], periodos: PeriodoEvaluacion[], zonaHoraria: string | null | undefined, voz: boolean): string {
  if (voz) {
    const nombres = planeaciones.slice(0, 3).map((p) => p.nombre)
    const extra = planeaciones.length > 3 ? ' y otras más' : ''
    return `Tienes ${planeaciones.length} planeaciones: ${nombres.join(', ')}${extra}.`
  }
  const lineas = [`Tienes ${planeaciones.length} planeación(es):`]
  planeaciones.forEach((p) => {
    lineas.push(`• ${p.nombre} — ${etiquetaPeriodo(p, periodos)}, ${formatearRangoFechas(p, zonaHoraria)}, ${ETIQUETA_ESTADO_PLANEACION[p.estado]}`)
  })
  return lineas.join('\n')
}

type ResultadoConsultaPlaneaciones =
  // Sin ninguna planeación guardada en el grupo (sin filtro de por medio).
  | { tipo: 'vacio' }
  // Con filtro (periodo/estado/nombre) aplicado, pero cero coincidencias
  // — el grupo SÍ tiene planeaciones, solo que ninguna cumple el
  // filtro; mensaje distinto para no decir "no tienes ninguna" cuando
  // en realidad sí existen, solo no coinciden con la búsqueda.
  | { tipo: 'sin_coincidencias' }
  | { tipo: 'detalle'; planeacion: Planeacion; periodos: PeriodoEvaluacion[] }
  | { tipo: 'lista'; planeaciones: Planeacion[]; periodos: PeriodoEvaluacion[] }
  | { tipo: 'ambiguo'; planeaciones: Planeacion[] }

const MENSAJE_SIN_PLANEACIONES = 'Todavía no tienes planeaciones guardadas para este grupo.'
const MENSAJE_SIN_COINCIDENCIAS = 'No encontré planeaciones que coincidan con esa búsqueda.'

const herramientaConsultarPlaneaciones = definir({
  intent: 'planeacion_consultar',
  puedeEjecutar: (_clasificacion, ctx) => {
    if (!ctx.sesion.grupo_activo_id) return { listo: false, mensaje: 'No tengo un grupo activo configurado para consultar tus planeaciones.' }
    return { listo: true }
  },
  ejecutar: async (clasificacion, ctx): Promise<ResultadoHerramientaModulo<ResultadoConsultaPlaneaciones>> => {
    try {
      const grupoId = ctx.sesion.grupo_activo_id!
      const tipo = clasificacion.tipo_consulta_planeacion ?? 'listado_general'

      if (tipo === 'por_periodo' && clasificacion.periodo_planeacion_consulta && ctx.sesion.ciclo_escolar_id) {
        const periodos = await periodosEvaluacionDelCiclo(ctx.sb, ctx.sesion.ciclo_escolar_id)
        const periodo = resolverPeriodoPorTexto(periodos, clasificacion.periodo_planeacion_consulta)
        if (!periodo) return { exito: true, datos: { tipo: 'sin_coincidencias' } }
        const r = await listarPlaneaciones({ supabase: ctx.sb }, { grupo_id: grupoId, periodo_evaluacion_id: periodo.id })
        if (!r.ok) return { exito: false, error: r.error.mensaje }
        if (r.datos.length === 0) return { exito: true, datos: { tipo: 'sin_coincidencias' } }
        if (r.datos.length === 1) return { exito: true, datos: { tipo: 'detalle', planeacion: r.datos[0], periodos } }
        return { exito: true, datos: { tipo: 'lista', planeaciones: r.datos, periodos } }
      }

      if (tipo === 'por_estado' && clasificacion.estado_planeacion_consulta) {
        const r = await listarPlaneaciones({ supabase: ctx.sb }, { grupo_id: grupoId, estado: clasificacion.estado_planeacion_consulta })
        if (!r.ok) return { exito: false, error: r.error.mensaje }
        if (r.datos.length === 0) return { exito: true, datos: { tipo: 'sin_coincidencias' } }
        const periodos = ctx.sesion.ciclo_escolar_id ? await periodosEvaluacionDelCiclo(ctx.sb, ctx.sesion.ciclo_escolar_id) : []
        if (r.datos.length === 1) return { exito: true, datos: { tipo: 'detalle', planeacion: r.datos[0], periodos } }
        return { exito: true, datos: { tipo: 'lista', planeaciones: r.datos, periodos } }
      }

      if (tipo === 'por_nombre' && clasificacion.nombre_planeacion_consulta) {
        const r = await listarPlaneaciones({ supabase: ctx.sb }, { grupo_id: grupoId })
        if (!r.ok) return { exito: false, error: r.error.mensaje }
        const coincidencias = filtrarPlaneacionesPorNombre(r.datos, clasificacion.nombre_planeacion_consulta)
        if (coincidencias.length === 0) return { exito: true, datos: { tipo: 'sin_coincidencias' } }
        if (coincidencias.length > 1) return { exito: true, datos: { tipo: 'ambiguo', planeaciones: coincidencias } }
        const detalle = await obtenerPlaneacionPorId({ supabase: ctx.sb }, coincidencias[0].id)
        if (!detalle.ok) return { exito: false, error: detalle.error.mensaje }
        const periodos = ctx.sesion.ciclo_escolar_id ? await periodosEvaluacionDelCiclo(ctx.sb, ctx.sesion.ciclo_escolar_id) : []
        return { exito: true, datos: { tipo: 'detalle', planeacion: detalle.datos.planeacion, periodos } }
      }

      if (tipo === 'actual') {
        const r = await listarPlaneaciones({ supabase: ctx.sb }, { grupo_id: grupoId })
        if (!r.ok) return { exito: false, error: r.error.mensaje }
        if (r.datos.length === 0) return { exito: true, datos: { tipo: 'vacio' } }
        const hoy = ctx.sesion.fecha_actual
        const vigente = r.datos.find((p) => p.estado !== 'archivada' && p.fecha_inicio && p.fecha_fin && p.fecha_inicio <= hoy && hoy <= p.fecha_fin)
        if (!vigente) return { exito: true, datos: { tipo: 'sin_coincidencias' } }
        const periodos = ctx.sesion.ciclo_escolar_id ? await periodosEvaluacionDelCiclo(ctx.sb, ctx.sesion.ciclo_escolar_id) : []
        return { exito: true, datos: { tipo: 'detalle', planeacion: vigente, periodos } }
      }

      if (tipo === 'ultima') {
        const r = await listarPlaneaciones({ supabase: ctx.sb }, { grupo_id: grupoId })
        if (!r.ok) return { exito: false, error: r.error.mensaje }
        if (r.datos.length === 0) return { exito: true, datos: { tipo: 'vacio' } }
        const periodos = ctx.sesion.ciclo_escolar_id ? await periodosEvaluacionDelCiclo(ctx.sb, ctx.sesion.ciclo_escolar_id) : []
        return { exito: true, datos: { tipo: 'detalle', planeacion: r.datos[0], periodos } }
      }

      // listado_general (default)
      const r = await listarPlaneaciones({ supabase: ctx.sb }, { grupo_id: grupoId })
      if (!r.ok) return { exito: false, error: r.error.mensaje }
      if (r.datos.length === 0) return { exito: true, datos: { tipo: 'vacio' } }
      const periodos = ctx.sesion.ciclo_escolar_id ? await periodosEvaluacionDelCiclo(ctx.sb, ctx.sesion.ciclo_escolar_id) : []
      if (r.datos.length === 1) return { exito: true, datos: { tipo: 'detalle', planeacion: r.datos[0], periodos } }
      return { exito: true, datos: { tipo: 'lista', planeaciones: r.datos, periodos } }
    } catch (e) {
      console.error('[HERRAMIENTA] planeacion_consultar — fallo consultando:', e)
      return { exito: false, error: 'No fue posible consultar tus planeaciones' }
    }
  },
  formatearRespuesta: (datos: ResultadoConsultaPlaneaciones, _clasificacion, ctx) => {
    const voz = ctx.canal === 'voice'
    if (datos.tipo === 'vacio') return MENSAJE_SIN_PLANEACIONES
    if (datos.tipo === 'sin_coincidencias') return MENSAJE_SIN_COINCIDENCIAS
    if (datos.tipo === 'ambiguo') {
      const nombres = datos.planeaciones.map((p) => p.nombre).join(', ')
      return `Tengo más de una planeación que coincide: ${nombres}. ¿Cuál te interesa?`
    }
    if (datos.tipo === 'detalle') return formatearPlaneacionDetalle(datos.planeacion, datos.periodos, ctx.zonaHoraria, voz)
    return formatearPlaneacionesLista(datos.planeaciones, datos.periodos, ctx.zonaHoraria, voz)
  },
})

// --- Dato individual confirmado de un alumno (CURP, sexo, fecha de
// nacimiento) — ver "Consulta directa y segura de datos individuales
// de alumnos". Reutiliza SIN MODIFICAR contextoAlumno() (y su RPC
// contexto_alumno, ya con verificación de propiedad del docente) —
// misma fuente que ya usa ficha_descriptiva, nunca una segunda
// consulta paralela a Supabase ni un segundo mecanismo de resolución
// de alumno. Consulta EXCLUSIVAMENTE al alumno ya resuelto por el
// Clasificador de Nivel 0 (nunca al grupo completo) y extrae SOLO el
// campo pedido antes de formatear la respuesta — ningún otro dato
// personal, ni de este alumno ni de ningún otro, llega jamás al
// modelo grande: esta Herramienta nunca pasa por Claude (ver
// ejecutarHerramientaDeModulo, más abajo), así que tampoco hay una
// llamada adicional a la IA solo para redactar la respuesta.
type DatosPersonalesAlumno = { curp?: string | null; sexo?: string | null; fecha_nacimiento?: string | null }
type CampoAlumnoConsultable = 'curp' | 'sexo' | 'fecha_nacimiento'

const herramientaConsultarDatoAlumno = definir({
  intent: 'consultar_dato_alumno',
  puedeEjecutar: (clasificacion, ctx) => {
    if (!clasificacion.entidades_resueltas.alumno_id) return { listo: false, mensaje: '¿De qué alumno se trata?' }
    if (!clasificacion.campo_alumno_solicitado) return { listo: false, mensaje: '¿Qué dato necesitas — CURP, sexo o fecha de nacimiento?' }
    if (!ctx.sesion.ciclo_escolar_id) return { listo: false, mensaje: 'No tengo un ciclo escolar activo configurado para consultar ese dato.' }
    return { listo: true }
  },
  ejecutar: async (clasificacion, ctx) => {
    try {
      const datos = await contextoAlumno(ctx.sb, clasificacion.entidades_resueltas.alumno_id!, ctx.sesion.ciclo_escolar_id!)
      const datosPersonales = (datos?.datos_personales ?? {}) as DatosPersonalesAlumno
      return { exito: true, datos: datosPersonales }
    } catch (e) {
      console.error('[HERRAMIENTA] consultar_dato_alumno — fallo consultando:', e)
      return { exito: false, error: 'No fue posible consultar ese dato' }
    }
  },
  formatearRespuesta: (datos: DatosPersonalesAlumno, clasificacion, ctx) => {
    const nombre = clasificacion.entidades_resueltas.alumno_nombre_detectado || 'ese alumno'
    const campo = clasificacion.campo_alumno_solicitado as CampoAlumnoConsultable
    const valorCrudo = datos[campo]

    // VERACIDAD DE DATOS, versión determinista (sin pasar por el
    // modelo): si el campo viene null/vacío en la base, se dice con
    // honestidad que no está registrado — NUNCA se infiere ni se
    // completa.
    if (valorCrudo === null || valorCrudo === undefined || valorCrudo === '') {
      if (campo === 'curp') return `${nombre} no tiene CURP registrada en el sistema.`
      if (campo === 'sexo') return `${nombre} no tiene sexo registrado en el sistema.`
      return `${nombre} no tiene fecha de nacimiento registrada en el sistema.`
    }

    if (campo === 'curp') return `La CURP registrada de ${nombre} es ${valorCrudo}.`
    if (campo === 'sexo') {
      // Mismo criterio ya usado en app/dashboard/lista/[alumnoId]/page.tsx
      // (pestaña Datos) — el código real ('M'/'H') nunca se muestra
      // crudo, siempre como "Niña"/"Niño".
      const etiquetaSexo = valorCrudo === 'M' ? 'Niña' : valorCrudo === 'H' ? 'Niño' : valorCrudo
      return `El sexo registrado de ${nombre} es ${etiquetaSexo}.`
    }
    const fechaLegible = formatearFecha(valorCrudo, ctx.zonaHoraria, { day: 'numeric', month: 'long', year: 'numeric' })
    return `La fecha de nacimiento registrada de ${nombre} es ${fechaLegible}.`
  },
})

// --- Corrección individual de un dato de alumno (PASO 2 — ver
// "corrección individual segura de UN campo de UN alumno") ---
//
// Cubre las 3 sub-acciones que ya resuelve el Clasificador de Nivel 0
// (regla 22/22.1): 'proponer' (primera vez, nunca escribe — solo
// compara y presenta), 'confirmar' (ya se mostró la propuesta y el
// docente la aprobó — aquí SÍ se escribe, vía aplicarCorreccionAlumno,
// que ya hace verificación real antes/después y la trazabilidad) y
// 'cancelar' (no se toca nada). Reutiliza sin duplicar:
// contextoAlumno/contexto_alumno (mismo RPC ya usado por
// consultar_dato_alumno/ficha_descriptiva) y
// validarValorCampoAlumno/aplicarCorreccionAlumno (lib/motorContexto.ts).
const ETIQUETA_CAMPO_ALUMNO_CORREGIR: Record<CampoAlumnoCorregible, string> = {
  curp: 'CURP',
  sexo: 'sexo',
  fecha_nacimiento: 'fecha de nacimiento',
}

type ResultadoCorregirDatoAlumno =
  | { tipo: 'invalido'; motivo: string }
  | { tipo: 'sin_cambios'; nombre: string; campo: CampoAlumnoCorregible; valor: string }
  | { tipo: 'propuesta'; diferencia: DiferenciaAlumno }
  | { tipo: 'aplicado'; nombre: string; campo: CampoAlumnoCorregible; valorNuevo: string }
  | { tipo: 'error_aplicar'; error: string }
  | { tipo: 'cancelado'; nombre: string }

const herramientaCorregirDatoAlumno = definir({
  intent: 'corregir_dato_alumno',
  puedeEjecutar: (clasificacion, ctx) => {
    if (!clasificacion.entidades_resueltas.alumno_id) return { listo: false, mensaje: '¿De qué alumno se trata?' }
    if (clasificacion.accion_correccion_alumno === 'cancelar') return { listo: true }
    if (!clasificacion.campo_alumno_corregir) return { listo: false, mensaje: '¿Qué dato necesitas corregir — CURP, sexo o fecha de nacimiento?' }
    if (!clasificacion.valor_alumno_propuesto) return { listo: false, mensaje: '¿Cuál es el valor correcto?' }
    if (!ctx.sesion.ciclo_escolar_id) return { listo: false, mensaje: 'No tengo un ciclo escolar activo configurado para hacer esta corrección.' }
    if (clasificacion.accion_correccion_alumno === 'confirmar' && !ctx.userId) {
      return { listo: false, mensaje: 'No pude identificar tu sesión para hacer esta corrección.' }
    }
    return { listo: true }
  },
  ejecutar: async (clasificacion, ctx): Promise<ResultadoHerramientaModulo<ResultadoCorregirDatoAlumno>> => {
    const alumnoId = clasificacion.entidades_resueltas.alumno_id!
    const nombre = clasificacion.entidades_resueltas.alumno_nombre_detectado || 'ese alumno'
    const accion = clasificacion.accion_correccion_alumno

    if (accion === 'cancelar') {
      return { exito: true, datos: { tipo: 'cancelado', nombre } }
    }

    const campo = clasificacion.campo_alumno_corregir!
    // Validación de FORMATO — nunca reconstruye ni completa el valor,
    // solo lo rechaza si es evidentemente inválido (ver
    // lib/motorContexto.ts, misma función usada aquí y en la
    // confirmación, para que ambos caminos apliquen exactamente la
    // misma regla).
    const validacion = validarValorCampoAlumno(campo, clasificacion.valor_alumno_propuesto!)
    if (!validacion.valido) {
      return { exito: true, datos: { tipo: 'invalido', motivo: validacion.motivo } }
    }

    if (accion === 'confirmar') {
      // Escritura real — verificación antes/después y trazabilidad ya
      // resueltas dentro de aplicarCorreccionAlumno; esta Herramienta
      // nunca hace su propio UPDATE.
      const resultado = await aplicarCorreccionAlumno(ctx.sb, ctx.userId!, alumnoId, campo, validacion.valorNormalizado, {
        tipo: 'texto',
        conversacionId: ctx.conversacionId ?? null,
        mensajeId: null,
      })
      if (!resultado.exito) return { exito: true, datos: { tipo: 'error_aplicar', error: resultado.error } }
      if (resultado.sinCambios) return { exito: true, datos: { tipo: 'sin_cambios', nombre, campo, valor: resultado.valorNuevo } }
      return { exito: true, datos: { tipo: 'aplicado', nombre, campo, valorNuevo: resultado.valorNuevo } }
    }

    // accion === 'proponer' — solo comparar y presentar, NUNCA escribir.
    let contextoReal: unknown
    try {
      contextoReal = await contextoAlumno(ctx.sb, alumnoId, ctx.sesion.ciclo_escolar_id!)
    } catch (e) {
      console.error('[HERRAMIENTA] corregir_dato_alumno — fallo consultando el valor actual:', e)
      return { exito: false, error: 'No fue posible consultar el dato actual del alumno' }
    }
    const datosPersonales = ((contextoReal as { datos_personales?: DatosPersonalesAlumno })?.datos_personales ?? {}) as DatosPersonalesAlumno
    const valorActualCrudo = datosPersonales[campo]
    const valorActual = typeof valorActualCrudo === 'string' && valorActualCrudo.trim() ? valorActualCrudo : null

    if (valorActual === validacion.valorNormalizado) {
      return { exito: true, datos: { tipo: 'sin_cambios', nombre, campo, valor: validacion.valorNormalizado } }
    }

    const diferencia: DiferenciaAlumno = {
      alumnoId,
      alumnoNombre: nombre,
      campo,
      valorActual,
      valorNuevo: validacion.valorNormalizado,
      fuente: 'texto',
    }
    return { exito: true, datos: { tipo: 'propuesta', diferencia } }
  },
  formatearRespuesta: (datos: ResultadoCorregirDatoAlumno) => {
    if (datos.tipo === 'invalido') {
      return `Ese valor no tiene el formato correcto: ${datos.motivo}. Revísalo y vuelve a intentarlo — no voy a guardar nada hasta que sea válido.`
    }
    if (datos.tipo === 'cancelado') {
      return `De acuerdo, no hice ningún cambio en los datos de ${datos.nombre}.`
    }
    if (datos.tipo === 'sin_cambios') {
      return `Ese valor ya coincide con el registrado — ${datos.nombre} ya tiene ${ETIQUETA_CAMPO_ALUMNO_CORREGIR[datos.campo]} = ${datos.valor}. No hice ningún cambio.`
    }
    if (datos.tipo === 'error_aplicar') {
      return `No fue posible aplicar la corrección: ${datos.error}. Intenta de nuevo.`
    }
    if (datos.tipo === 'aplicado') {
      return `Listo. Corregí ${ETIQUETA_CAMPO_ALUMNO_CORREGIR[datos.campo]} de ${datos.nombre}: ahora es ${datos.valorNuevo}.`
    }
    // tipo === 'propuesta' — NUNCA se escribió nada todavía; el
    // marcador técnico va pegado al final (invisible para el docente,
    // ver motorTextoClaude.ts) para que la burbuja muestre los botones
    // Corregir/Cancelar — mismo patrón ya usado por
    // [[NAVEGACION:...]]/datosAccionCalendario.
    const d = datos.diferencia
    const marcador = `[[CORRECCION_ALUMNO:${Buffer.from(JSON.stringify(d), 'utf-8').toString('base64')}]]`
    const actualTexto = d.valorActual ?? '(no registrado)'
    return `Alumno: ${d.alumnoNombre}\nCampo: ${ETIQUETA_CAMPO_ALUMNO_CORREGIR[d.campo]}\nActual: ${actualTexto}\nNuevo: ${d.valorNuevo}\nFuente: texto del docente\n\n¿Confirmas la corrección?\n${marcador}`
  },
})

const REGISTRO: Record<string, DefinicionHerramientaModulo<unknown>> = {
  consultar_asistencia: herramientaConsultarAsistencia,
  consultar_asistencia_grupo: herramientaConsultarAsistenciaGrupo,
  consultar_incidencias_alumno: herramientaConsultarIncidencias,
  consultar_dato_alumno: herramientaConsultarDatoAlumno,
  corregir_dato_alumno: herramientaCorregirDatoAlumno,
  consultar_apoyo: herramientaConsultarApoyo,
  consultar_documentos: herramientaConsultarDocumentos,
  planeacion_consultar: herramientaConsultarPlaneaciones,
}

// Único punto de entrada: si la intención clasificada tiene una
// Herramienta registrada, la ejecuta y regresa el texto final ya
// formateado (éxito, aclaración, o error) — nunca null en ese caso.
// Si la intención NO pertenece a ningún módulo interno (conversación
// general, generación de documentos, calendario, navegación, una
// escritura), regresa null para que el llamador siga con su propio
// flujo — esta función nunca decide POR el resto de la app qué
// intenciones existen, solo garantiza que las que SÍ están aquí jamás
// se resuelven con texto libre del modelo.
export async function ejecutarHerramientaDeModulo(
  clasificacion: ClasificacionNivel0,
  ctx: ContextoEjecucionHerramienta
): Promise<string | null> {
  const definicion = REGISTRO[clasificacion.intencion_principal]
  if (!definicion) return null

  const disponibilidad = definicion.puedeEjecutar(clasificacion, ctx)
  if (!disponibilidad.listo) {
    console.log(`[HERRAMIENTA] ${definicion.intent} — no se pudo ejecutar: ${disponibilidad.mensaje}`)
    return disponibilidad.mensaje
  }

  const resultado = await definicion.ejecutar(clasificacion, ctx)
  if (!resultado.exito) {
    console.error(`[HERRAMIENTA] ${definicion.intent} — error real: ${resultado.error}`)
    return `${resultado.error}. Intenta nuevamente.`
  }

  console.log(`[HERRAMIENTA] ${definicion.intent} OK — respuesta construida desde datos reales, sin pasar por el modelo`)
  return definicion.formatearRespuesta(resultado.datos, clasificacion, ctx)
}
