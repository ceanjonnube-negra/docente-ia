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
  type ConteoAsistencia,
} from '../motorContexto'
import { formatearFecha } from '../tiempo/TimeService'

export type ResultadoHerramientaModulo<T> = { exito: true; datos: T } | { exito: false; error: string }

export type ContextoEjecucionHerramienta = {
  sb: SupabaseClient
  sesion: SesionContexto
  userId: string | null
  zonaHoraria: string | null | undefined
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

const REGISTRO: Record<string, DefinicionHerramientaModulo<unknown>> = {
  consultar_asistencia: herramientaConsultarAsistencia,
  consultar_asistencia_grupo: herramientaConsultarAsistenciaGrupo,
  consultar_incidencias_alumno: herramientaConsultarIncidencias,
  consultar_apoyo: herramientaConsultarApoyo,
  consultar_documentos: herramientaConsultarDocumentos,
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
