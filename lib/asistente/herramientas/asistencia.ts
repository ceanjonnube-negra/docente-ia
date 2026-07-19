// lib/asistente/herramientas/asistencia.ts
//
// Primera Herramienta real conectada al framework — prueba de que
// cualquier motor conversacional (hoy MotorTextoClaude, mañana un motor
// de voz en tiempo real) puede ejecutar una acción real sobre la
// aplicación a través de la misma interfaz. Reutiliza /api/asistencia-guardar
// (ya validado y con upsert por fecha) en vez de escribir lógica nueva.

import { supabase } from '@/lib/supabaseClient'
import { obtenerZonaHorariaDispositivo } from '@/lib/tiempo/TimeService'
import type { ContextoAplicacion, Herramienta, ResultadoHerramienta } from '../tipos'

const ESTADOS_VALIDOS = new Set(['presente', 'falta', 'retardo'])

async function resolverAlumnoId(
  argumentos: Record<string, unknown>,
  contexto: ContextoAplicacion
): Promise<{ id: string; nombre: string } | null> {
  if (contexto.alumnoId) {
    return { id: contexto.alumnoId, nombre: contexto.alumnoNombre || 'el alumno' }
  }

  const nombreBuscado = typeof argumentos.alumno_nombre === 'string' ? argumentos.alumno_nombre.trim().toLowerCase() : ''
  if (!nombreBuscado || !contexto.grupoId) return null

  const { data } = await supabase
    .from('inscripciones')
    .select('alumno_id, alumnos(nombre)')
    .eq('grupo_id', contexto.grupoId)
    .eq('estatus', 'activo')

  type FilaInscripcion = { alumno_id: string; alumnos: { nombre: string | null } | { nombre: string | null }[] | null }
  const coincidencia = ((data as FilaInscripcion[] | null) || [])
    .map(i => {
      const rel = Array.isArray(i.alumnos) ? i.alumnos[0] : i.alumnos
      return { id: i.alumno_id, nombre: rel?.nombre || '' }
    })
    .find(a => a.nombre.toLowerCase().includes(nombreBuscado))

  return coincidencia || null
}

export const herramientaMarcarAsistencia: Herramienta = {
  nombre: 'marcar_asistencia',
  descripcion:
    'Marca el estado de asistencia (presente, falta o retardo) de un alumno para el día de hoy. ' +
    'Si no se indica alumno_nombre, usa el alumno que el docente tiene abierto en pantalla en este momento.',
  parametros: {
    type: 'object',
    properties: {
      alumno_nombre: { type: 'string', description: 'Nombre del alumno. Opcional si ya hay uno seleccionado en pantalla.' },
      estado: { type: 'string', enum: ['presente', 'falta', 'retardo'], description: 'Nuevo estado de asistencia.' },
    },
    required: ['estado'],
  },
  async ejecutar(argumentos, contexto): Promise<ResultadoHerramienta> {
    const estado = typeof argumentos.estado === 'string' ? argumentos.estado : ''
    if (!ESTADOS_VALIDOS.has(estado)) {
      return { exito: false, mensaje: 'No reconocí ese estado de asistencia.' }
    }

    const alumno = await resolverAlumnoId(argumentos, contexto)
    if (!alumno) {
      return { exito: false, mensaje: 'No pude identificar de qué alumno se trata.' }
    }

    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) {
      return { exito: false, mensaje: 'No se pudo identificar la sesión del docente.' }
    }

    const res = await fetch('/api/asistencia-guardar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        registros: [{ alumno_id: alumno.id, estado }],
        access_token: session.access_token,
        zonaHoraria: obtenerZonaHorariaDispositivo(),
      }),
    })

    if (!res.ok) {
      return { exito: false, mensaje: `No se pudo guardar la asistencia de ${alumno.nombre}.` }
    }

    const etiqueta = estado === 'presente' ? 'presente' : estado === 'falta' ? 'con falta' : 'con retardo'
    return { exito: true, mensaje: `Listo. ${alumno.nombre} quedó marcado ${etiqueta}.`, datos: { alumnoId: alumno.id, estado } }
  },
}
