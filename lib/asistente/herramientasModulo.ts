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
import {
  asistenciaGrupoResumen,
  calcularPorcentajeAsistencia,
  consultarAsistenciaAlumno,
  documentosDelDocente,
  incidenciasAlumno,
  necesidadesApoyoGrupo,
  periodosEvaluacionDelCiclo,
  type ConteoAsistencia,
  type PeriodoEvaluacion,
} from '../motorContexto'
import { formatearFecha } from '../tiempo/TimeService'
import { listarPlaneaciones } from '../planeacion/persistencia'
import {
  MAXIMO_OPCIONES,
  coincidenciasPorNombre,
  elegirVersion,
  firmarOriginalPropio,
  guardarReferenciaPlaneacion,
  leerReferenciaPlaneacion,
  mensajeModificacionNoDisponible,
  rangoDeFechasEnTexto,
  rangoLegible,
  textoOpciones,
  textoPlaneacion,
  trabajadasEnRango,
  versionesDePlaneacion,
  type RangoFechas,
  type VersionSolicitada,
} from '../planeacion/consultaPlaneaciones'
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
  // Conversación propia validada (RLS) — referencia contextual de la
  // consulta de planeaciones (conversaciones_chat.planeacion_activa).
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

// --- Planeaciones ya guardadas (C-005 Paso 3A; Hito 2, etapa 2) ---
//
// Solo lectura de las planeaciones: listarPlaneaciones (docente y grupo
// activo, solo confirmadas) y planeacion_versiones (RLS) vía
// lib/planeacion/consultaPlaneaciones.ts. La única escritura es la
// referencia contextual de la conversación (planeacion_activa).

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

// Hito 2, etapa 2 — la respuesta sale de planeacion_versiones (texto
// canónico y archivos originales de la versión), nunca de la proyección.
// Varias coincidencias → lista numerada y pregunta breve (las opciones
// quedan en la referencia de la conversación para responder "la 2").
type ResultadoConsultaPlaneaciones =
  // Sin ninguna planeación guardada en el grupo (sin filtro de por medio).
  | { tipo: 'vacio' }
  // Con filtro aplicado, pero cero coincidencias — el grupo SÍ tiene
  // planeaciones, solo que ninguna cumple el filtro.
  | { tipo: 'sin_coincidencias'; mensaje?: string }
  | { tipo: 'texto'; texto: string }

const ETIQUETA_ESTADO_PLANEACION: Record<EstadoPlaneacion, string> = {
  borrador: 'en borrador',
  publicada: 'publicadas',
  archivada: 'archivadas',
}

const MENSAJE_SIN_PLANEACIONES = 'Todavía no tienes planeaciones guardadas para este grupo.'
const MENSAJE_SIN_COINCIDENCIAS = 'No encontré planeaciones que coincidan con esa búsqueda.'
const MENSAJE_SIN_CONTEXTO = '¿De qué planeación? Dime su nombre o el periodo en que la trabajaste.'

function describirVersion(v: VersionSolicitada): string {
  if (v === 'anterior') return 'una versión anterior'
  if (v === 'original') return 'la versión original'
  if (v === 'vigente') return 'la versión vigente'
  return `la versión ${v}`
}

async function mostrarPlaneacion(p: Planeacion, pedida: VersionSolicitada | null, mostrada: number | null, ctx: ContextoEjecucionHerramienta): Promise<ResultadoConsultaPlaneaciones> {
  const versiones = await versionesDePlaneacion(ctx.sb, p.id)
  const version = elegirVersion(versiones, p.version, pedida, mostrada)
  if (!version) {
    if (versiones.length === 0) return { tipo: 'texto', texto: `«${p.nombre}» (${rangoLegible(p)}) no tiene una versión guardada que pueda mostrarte.` }
    const tiene = versiones.length === 1 ? 'solo tiene la versión 1' : `tiene las versiones 1 a ${versiones.length}`
    return { tipo: 'texto', texto: `«${p.nombre}» ${tiene}; no encontré ${describirVersion(pedida ?? 'vigente')}.` }
  }
  const texto = await textoPlaneacion(p, version, versiones.length, firmarOriginalPropio(ctx.userId), ctx.canal === 'voice', ctx.zonaHoraria)
  await guardarReferenciaPlaneacion(ctx.sb, ctx.conversacionId ?? null, { planeacionId: p.id, numero: version.numero, opciones: [] })
  return { tipo: 'texto', texto }
}

async function elegirEntre(encabezado: string, planeaciones: Planeacion[], pedida: VersionSolicitada | null, ctx: ContextoEjecucionHerramienta): Promise<ResultadoConsultaPlaneaciones> {
  if (planeaciones.length === 1) return mostrarPlaneacion(planeaciones[0], pedida, null, ctx)
  await guardarReferenciaPlaneacion(ctx.sb, ctx.conversacionId ?? null, { planeacionId: null, numero: null, opciones: planeaciones.slice(0, MAXIMO_OPCIONES).map((p) => p.id) })
  return { tipo: 'texto', texto: textoOpciones(encabezado, planeaciones, ctx.canal === 'voice', undefined, ctx.zonaHoraria) }
}

function porFechas(planeaciones: Planeacion[], rango: RangoFechas, ctx: ContextoEjecucionHerramienta): Promise<ResultadoConsultaPlaneaciones> | ResultadoConsultaPlaneaciones {
  const enRango = trabajadasEnRango(planeaciones, rango)
  if (enRango.length === 0) return { tipo: 'sin_coincidencias', mensaje: `No encontré planeaciones trabajadas ${rango.etiqueta}.` }
  return elegirEntre(`Trabajaste ${enRango.length} planeaciones ${rango.etiqueta}:`, enRango, null, ctx)
}

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
      const pedida = clasificacion.version_planeacion_consulta ?? null
      const ok = (datos: ResultadoConsultaPlaneaciones) => ({ exito: true as const, datos })

      // Solo planeaciones confirmadas del docente y del grupo activo.
      const r = await listarPlaneaciones({ supabase: ctx.sb }, { grupo_id: grupoId })
      if (!r.ok) return { exito: false, error: r.error.mensaje }
      // Orden estable: inicio más reciente y, a igual inicio, creación más
      // reciente — la numeración mostrada y las opciones guardadas coinciden.
      const todas = [...r.datos].sort((x, y) => (y.fecha_inicio ?? '').localeCompare(x.fecha_inicio ?? '') || (y.creado_en ?? '').localeCompare(x.creado_en ?? ''))
      const delGrupo = (id: string | null) => todas.find((p) => p.id === id) ?? null

      // Seguimiento de la conversación: elegir de la lista o pedir otra versión.
      if (tipo === 'seleccion' || tipo === 'version') {
        const ref = await leerReferenciaPlaneacion(ctx.sb, ctx.conversacionId ?? null)
        if (tipo === 'seleccion') {
          const i = clasificacion.seleccion_planeacion_consulta ?? 0
          const opciones = ref?.opciones ?? []
          const id = i === -1 ? opciones[opciones.length - 1] : opciones[i - 1]
          const elegida = delGrupo(id ?? null)
          if (!elegida) return ok({ tipo: 'texto', texto: opciones.length > 0 ? `Elige un número del 1 al ${opciones.length}.` : MENSAJE_SIN_CONTEXTO })
          if (ref?.intencion === 'modificar') {
            // Etapa 3 aún no habilitada: se identifica la planeación, sin modificarla.
            await guardarReferenciaPlaneacion(ctx.sb, ctx.conversacionId ?? null, { planeacionId: elegida.id, numero: elegida.version, opciones: [] })
            return ok({ tipo: 'texto', texto: mensajeModificacionNoDisponible(elegida.nombre) })
          }
          return ok(await mostrarPlaneacion(elegida, null, null, ctx))
        }
        const actual = delGrupo(ref?.planeacionId ?? null)
        if (!actual) return ok({ tipo: 'texto', texto: MENSAJE_SIN_CONTEXTO })
        return ok(await mostrarPlaneacion(actual, pedida, ref?.numero ?? null, ctx))
      }

      if (todas.length === 0) return ok({ tipo: 'vacio' })

      if (tipo === 'por_fechas' && clasificacion.rango_planeacion_consulta) return ok(await porFechas(todas, clasificacion.rango_planeacion_consulta, ctx))

      if (tipo === 'por_periodo' && clasificacion.periodo_planeacion_consulta) {
        // Trimestre/periodo de evaluación; si no lo es, un periodo de fechas ("en noviembre").
        const periodos = ctx.sesion.ciclo_escolar_id ? await periodosEvaluacionDelCiclo(ctx.sb, ctx.sesion.ciclo_escolar_id) : []
        const periodo = resolverPeriodoPorTexto(periodos, clasificacion.periodo_planeacion_consulta)
        if (periodo) {
          const enPeriodo = todas.filter((p) => p.periodo_evaluacion_id === periodo.id)
          if (enPeriodo.length === 0) return ok({ tipo: 'sin_coincidencias' })
          return ok(await elegirEntre(`Tienes ${enPeriodo.length} planeaciones en ${periodo.nombre}:`, enPeriodo, null, ctx))
        }
        const rango = rangoDeFechasEnTexto(clasificacion.periodo_planeacion_consulta, ctx.sesion.fecha_actual)
        if (rango) return ok(await porFechas(todas, rango, ctx))
        return ok({ tipo: 'sin_coincidencias' })
      }

      if (tipo === 'por_estado' && clasificacion.estado_planeacion_consulta) {
        const enEstado = todas.filter((p) => p.estado === clasificacion.estado_planeacion_consulta)
        if (enEstado.length === 0) return ok({ tipo: 'sin_coincidencias' })
        return ok(await elegirEntre(`Tienes ${enEstado.length} planeaciones ${ETIQUETA_ESTADO_PLANEACION[clasificacion.estado_planeacion_consulta]}:`, enEstado, null, ctx))
      }

      if (tipo === 'por_nombre' && clasificacion.nombre_planeacion_consulta) {
        const coincidencias = coincidenciasPorNombre(todas, clasificacion.nombre_planeacion_consulta)
        if (coincidencias.length === 0) return ok({ tipo: 'sin_coincidencias' })
        return ok(await elegirEntre(`Encontré ${coincidencias.length} planeaciones que coinciden:`, coincidencias, pedida, ctx))
      }

      if (tipo === 'actual') {
        const hoy = ctx.sesion.fecha_actual
        const vigente = todas.filter((p) => p.estado !== 'archivada' && p.fecha_inicio && p.fecha_fin && p.fecha_inicio <= hoy && hoy <= p.fecha_fin)
        if (vigente.length === 0) return ok({ tipo: 'sin_coincidencias', mensaje: 'No tienes una planeación en curso para hoy.' })
        return ok(await elegirEntre(`Tienes ${vigente.length} planeaciones en curso:`, vigente, null, ctx))
      }

      if (tipo === 'ultima') return ok(await mostrarPlaneacion(todas[0], null, null, ctx))

      // listado_general (por omisión)
      return ok(await elegirEntre(`Tienes ${todas.length} planeaciones guardadas en este grupo:`, todas, null, ctx))
    } catch (e) {
      console.error('[HERRAMIENTA] planeacion_consultar — fallo consultando:', e)
      return { exito: false, error: 'No fue posible consultar tus planeaciones' }
    }
  },
  formatearRespuesta: (datos: ResultadoConsultaPlaneaciones) => {
    if (datos.tipo === 'vacio') return MENSAJE_SIN_PLANEACIONES
    if (datos.tipo === 'sin_coincidencias') return datos.mensaje ?? MENSAJE_SIN_COINCIDENCIAS
    return datos.texto
  },
})

const REGISTRO: Record<string, DefinicionHerramientaModulo<unknown>> = {
  consultar_asistencia: herramientaConsultarAsistencia,
  consultar_asistencia_grupo: herramientaConsultarAsistenciaGrupo,
  consultar_incidencias_alumno: herramientaConsultarIncidencias,
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
