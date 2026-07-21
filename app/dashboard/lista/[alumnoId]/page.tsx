'use client'
import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { obtenerRosterConPosicion } from '@/lib/rosterGrupo'
import { eliminarAlumnoDefinitivamente } from '@/lib/motorContexto'
import { useContextoAsistente, useHerramientasAsistente } from '@/lib/asistente/hooks'
import { herramientaMarcarAsistencia } from '@/lib/asistente/herramientas/asistencia'
import { formatearFecha, obtenerZonaHorariaDispositivo } from '@/lib/tiempo/TimeService'

type Alumno = {
  id: string
  nombre: string
  curp: string | null
  sexo: string | null
  fecha_nacimiento: string | null
}

type Grupo = { grado: string | null; grupo: string | null; nombre_grupo: string | null; docente_id: string | null }

type Asistencia = { fecha: string; presente: boolean }
type Incidencia = { id: string; fecha: string; tipo: string; descripcion: string; seguimiento: unknown }
type Evaluacion = { id: string; campo_formativo: string | null; periodo: string | null; calificacion: string | null; rubrica: unknown; creado_en: string }
type Evidencia = { id: string; tipo: string | null; descripcion: string | null; archivo_url: string | null; creado_en: string }
type NecesidadApoyo = { id: string; tipo: string | null; descripcion: string | null; activa: boolean; creado_en: string }
type FichaDescriptiva = { id: string; periodo: string | null; contenido: unknown; creado_en: string }
type NotaAlumno = { id: string; tipo: string | null; contenido: string | null; fuente_modulo: string | null; estado: string; fecha: string }
type PeriodoEvaluacion = { id: string; nombre: string; numero_periodo: number }

type BorradorFicha = {
  fortalezas: string
  areas_oportunidad: string
  apoyos_requeridos: string
  observaciones_generales: string
  recomendaciones: string
}

const CAMPOS_BORRADOR: { campo: keyof BorradorFicha; etiqueta: string }[] = [
  { campo: 'fortalezas', etiqueta: 'Fortalezas' },
  { campo: 'areas_oportunidad', etiqueta: 'Áreas de oportunidad' },
  { campo: 'apoyos_requeridos', etiqueta: 'Apoyos requeridos' },
  { campo: 'observaciones_generales', etiqueta: 'Observaciones generales' },
  { campo: 'recomendaciones', etiqueta: 'Recomendaciones' },
]

type Pestana = 'resumen' | 'datos' | 'asistencia' | 'incidencias' | 'evaluaciones' | 'evidencias' | 'fichas' | 'historial'

type HistorialItem = { key: string; origen: string; fecha: string; titulo: string; descripcion: string }

function formatFecha(fecha: string | null | undefined): string {
  if (!fecha) return '—'
  return formatearFecha(fecha, obtenerZonaHorariaDispositivo(), { day: '2-digit', month: 'short', year: 'numeric' })
}

function calcularEdad(fechaNacimiento: string | null): string {
  if (!fechaNacimiento) return '—'
  const hoy = new Date()
  const nacimiento = new Date(fechaNacimiento)
  let edad = hoy.getFullYear() - nacimiento.getFullYear()
  const m = hoy.getMonth() - nacimiento.getMonth()
  if (m < 0 || (m === 0 && hoy.getDate() < nacimiento.getDate())) edad--
  return `${edad} años`
}

function getIniciales(nombre: string): string {
  const partes = nombre.trim().split(/\s+/).filter(Boolean)
  if (partes.length === 0) return '?'
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase()
  return (partes[0][0] + partes[1][0]).toUpperCase()
}

const ICONOS_PESTANA: Record<Pestana, string> = {
  resumen: '📊',
  datos: '📝',
  asistencia: '✅',
  incidencias: '⚠️',
  evaluaciones: '🏆',
  evidencias: '📎',
  fichas: '📝',
  historial: '🕓',
}

const ICONOS_ORIGEN: Record<string, string> = {
  Asistencia: '✅',
  Incidencia: '⚠️',
  Evaluación: '🏆',
  Evidencia: '📎',
  Nota: '🗒️',
}

const CHIP_ORIGEN: Record<string, string> = {
  Asistencia: 'bg-green-50 text-green-600',
  Incidencia: 'bg-amber-50 text-amber-600',
  Evaluación: 'bg-violet-50 text-violet-600',
  Evidencia: 'bg-blue-50 text-blue-600',
  Nota: 'bg-indigo-50 text-indigo-600',
}

function EstadoVacio({ icono, mensaje }: { icono: string; mensaje: string }) {
  return (
    <div className="sm:col-span-2 flex flex-col items-center justify-center gap-2 py-10 px-4 text-center">
      <span aria-hidden="true" className="text-2xl opacity-40">{icono}</span>
      <p className="text-sm text-gray-400">{mensaje}</p>
    </div>
  )
}

function BannerError({ mensaje }: { mensaje: string }) {
  return (
    <p className="sm:col-span-2 text-xs text-center text-amber-700 bg-amber-50 border border-amber-100 rounded-xl py-2 px-3">
      ⚠️ {mensaje}
    </p>
  )
}

// Convierte un valor jsonb en líneas de texto seguras para mostrar en pantalla,
// sin imprimir nunca la estructura JSON cruda (solo "clave: valor" planos).
function resumenSeguroJson(valor: unknown): string[] {
  if (valor === null || valor === undefined) return []
  if (typeof valor === 'string') return valor.trim() ? [valor] : []
  if (typeof valor === 'number' || typeof valor === 'boolean') return [String(valor)]
  if (Array.isArray(valor)) {
    return valor.map(item => {
      if (item === null || item === undefined) return '—'
      if (typeof item === 'object') return 'Elemento con detalle adicional'
      return String(item)
    })
  }
  if (typeof valor === 'object') {
    return Object.entries(valor as Record<string, unknown>).map(([clave, val]) => {
      if (val === null || val === undefined || val === '') return `${clave}: —`
      if (typeof val === 'object') return `${clave}: (detalle adicional)`
      return `${clave}: ${val}`
    })
  }
  return []
}

function ResumenJson({ valor, vacio }: { valor: unknown; vacio: string }) {
  const lineas = resumenSeguroJson(valor)
  if (lineas.length === 0) return <p className="text-xs text-gray-400">{vacio}</p>
  return (
    <ul className="text-xs text-gray-600 space-y-0.5">
      {lineas.map((l, i) => <li key={i}>{l}</li>)}
    </ul>
  )
}

export default function FichaAlumnoPage() {
  const { alumnoId } = useParams<{ alumnoId: string }>()
  const router = useRouter()

  const [alumno, setAlumno] = useState<Alumno | null>(null)
  const [grupo, setGrupo] = useState<Grupo | null>(null)
  const [posicion, setPosicion] = useState<number | null>(null)
  const [asistencias, setAsistencias] = useState<Asistencia[]>([])
  const [incidencias, setIncidencias] = useState<Incidencia[]>([])
  const [evaluaciones, setEvaluaciones] = useState<Evaluacion[]>([])
  const [evidencias, setEvidencias] = useState<Evidencia[]>([])
  const [necesidadesApoyo, setNecesidadesApoyo] = useState<NecesidadApoyo[]>([])
  const [fichasDescriptivas, setFichasDescriptivas] = useState<FichaDescriptiva[]>([])
  const [notasAlumno, setNotasAlumno] = useState<NotaAlumno[]>([])
  const [periodosEvaluacion, setPeriodosEvaluacion] = useState<PeriodoEvaluacion[]>([])
  const [cicloEscolarId, setCicloEscolarId] = useState<string | null>(null)
  const [observacionesInscripcion, setObservacionesInscripcion] = useState<string | null>(null)
  const [grupoId, setGrupoId] = useState<string | null>(null)

  const [errorAsistencia, setErrorAsistencia] = useState(false)
  const [errorIncidencias, setErrorIncidencias] = useState(false)
  const [errorEvaluaciones, setErrorEvaluaciones] = useState(false)
  const [errorEvidencias, setErrorEvidencias] = useState(false)
  const [errorNecesidades, setErrorNecesidades] = useState(false)
  const [errorFichas, setErrorFichas] = useState(false)
  const [errorNotas, setErrorNotas] = useState(false)

  const [estadoGeneral, setEstadoGeneral] = useState<{ texto: string; clase: string }>({
    texto: 'Sin datos suficientes',
    clase: 'bg-gray-100 text-gray-500',
  })

  // Pestaña inicial desde ?tab=... (ver "Integración de comandos
  // verbales con navegación y consulta interna" — AsistentePanel
  // navega aquí con router.push incluyendo este parámetro). Leído
  // directo de window.location.search en vez de useSearchParams() para
  // no exigirle un límite de Suspense a toda esta pantalla por un
  // parámetro opcional — mismo patrón que voiceDebug en
  // AsistentePanel.tsx.
  const [pestana, setPestana] = useState<Pestana>(() => {
    if (typeof window === 'undefined') return 'resumen'
    const tab = new URLSearchParams(window.location.search).get('tab')
    const validas: Pestana[] = ['resumen', 'datos', 'asistencia', 'incidencias', 'evaluaciones', 'evidencias', 'fichas', 'historial']
    return validas.includes(tab as Pestana) ? (tab as Pestana) : 'resumen'
  })
  const [cargando, setCargando] = useState(true)
  const [guardando, setGuardando] = useState(false)
  const [mensaje, setMensaje] = useState('')

  const [curp, setCurp] = useState('')
  const [sexo, setSexo] = useState('')
  const [fechaNacimiento, setFechaNacimiento] = useState('')

  const [mostrarConfirmacionBaja, setMostrarConfirmacionBaja] = useState(false)
  const [eliminando, setEliminando] = useState(false)
  const [errorBaja, setErrorBaja] = useState('')

  const [generandoBorrador, setGenerandoBorrador] = useState(false)
  const [borrador, setBorrador] = useState<BorradorFicha | null>(null)
  const [errorBorrador, setErrorBorrador] = useState('')
  const [guardandoFicha, setGuardandoFicha] = useState(false)

  useEffect(() => {
    const cargar = async () => {
      setCargando(true)

      const { data: a, error: errorAlumno } = await supabase
        .from('alumnos')
        .select('id, nombre, curp, sexo, fecha_nacimiento')
        .eq('id', alumnoId)
        .single()

      if (errorAlumno || !a) {
        setMensaje('No se pudo cargar al alumno.')
        setCargando(false)
        return
      }

      setAlumno(a)
      setCurp(a.curp || '')
      setSexo(a.sexo || '')
      setFechaNacimiento(a.fecha_nacimiento || '')

      // El grupo y el número de lista se resuelven vía la inscripción activa
      // del alumno (fuente única de verdad, igual que en /dashboard/lista),
      // no desde un campo almacenado en alumnos.
      const { data: inscripcionActiva } = await supabase
        .from('inscripciones')
        .select('grupo_id, ciclo_escolar_id, observaciones')
        .eq('alumno_id', alumnoId)
        .eq('estatus', 'activo')
        .maybeSingle()

      const grupoIdActivo = inscripcionActiva?.grupo_id ?? null
      const cicloEscolarIdActivo = inscripcionActiva?.ciclo_escolar_id ?? null
      setCicloEscolarId(cicloEscolarIdActivo)
      setObservacionesInscripcion(inscripcionActiva?.observaciones ?? null)
      setGrupoId(grupoIdActivo)

      const [grupoRes, rosterRes, asistenciasRes, incidenciasRes, evaluacionesRes, evidenciasRes, necesidadesRes, fichasRes, notasRes, periodosRes] = await Promise.allSettled([
        grupoIdActivo
          ? supabase.from('grupos').select('grado, grupo, nombre_grupo, docente_id').eq('id', grupoIdActivo).single()
          : Promise.resolve({ data: null, error: null }),
        grupoIdActivo
          ? obtenerRosterConPosicion(supabase, grupoIdActivo)
          : Promise.resolve({ data: [], error: null }),
        supabase.from('asistencias').select('fecha, presente').eq('alumno_id', alumnoId).order('fecha', { ascending: false }),
        supabase.from('incidencias').select('id, fecha, tipo, descripcion, seguimiento').eq('alumno_id', alumnoId).order('fecha', { ascending: false }),
        supabase.from('evaluaciones').select('id, campo_formativo, periodo, calificacion, rubrica, creado_en').eq('alumno_id', alumnoId).order('creado_en', { ascending: false }),
        supabase.from('evidencias').select('id, tipo, descripcion, archivo_url, creado_en').eq('alumno_id', alumnoId).order('creado_en', { ascending: false }),
        supabase.from('necesidades_apoyo').select('id, tipo, descripcion, activa, creado_en').eq('alumno_id', alumnoId).order('creado_en', { ascending: false }),
        supabase.from('fichas_descriptivas').select('id, periodo, contenido, creado_en').eq('alumno_id', alumnoId).order('creado_en', { ascending: false }),
        supabase.from('perfil_alumno_notas').select('id, tipo, contenido, fuente_modulo, estado, fecha').eq('alumno_id', alumnoId).neq('estado', 'pendiente_confirmar').order('fecha', { ascending: false }),
        cicloEscolarIdActivo
          ? supabase.from('periodos_evaluacion').select('id, nombre, numero_periodo').eq('ciclo_escolar_id', cicloEscolarIdActivo).order('numero_periodo')
          : Promise.resolve({ data: [], error: null }),
      ])

      if (periodosRes.status === 'fulfilled' && !periodosRes.value.error) {
        setPeriodosEvaluacion(periodosRes.value.data || [])
      } else {
        setPeriodosEvaluacion([])
      }

      setGrupo(grupoRes.status === 'fulfilled' && !grupoRes.value.error ? (grupoRes.value.data as Grupo | null) : null)

      if (rosterRes.status === 'fulfilled' && !rosterRes.value.error) {
        const propio = rosterRes.value.data.find(r => r.id === alumnoId)
        setPosicion(propio ? propio.posicion : null)
      } else {
        setPosicion(null)
      }

      let asistenciasData: Asistencia[] = []
      if (asistenciasRes.status === 'fulfilled' && !asistenciasRes.value.error) {
        asistenciasData = asistenciasRes.value.data || []
        setAsistencias(asistenciasData)
        setErrorAsistencia(false)
      } else {
        setAsistencias([])
        setErrorAsistencia(true)
      }

      let incidenciasData: Incidencia[] = []
      if (incidenciasRes.status === 'fulfilled' && !incidenciasRes.value.error) {
        incidenciasData = incidenciasRes.value.data || []
        setIncidencias(incidenciasData)
        setErrorIncidencias(false)
      } else {
        setIncidencias([])
        setErrorIncidencias(true)
      }

      const totalFaltasCarga = asistenciasData.length - asistenciasData.filter(a => a.presente).length
      if (asistenciasData.length === 0) {
        setEstadoGeneral({ texto: 'Sin datos suficientes', clase: 'bg-gray-100 text-gray-500' })
      } else {
        const tasaFaltas = totalFaltasCarga / asistenciasData.length
        const hace30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
        const incidenciaReciente = incidenciasData.some(i => new Date(`${i.fecha}T12:00:00`) >= hace30)
        setEstadoGeneral(
          tasaFaltas > 0.2 || incidenciaReciente
            ? { texto: 'Requiere atención', clase: 'bg-amber-100 text-amber-700' }
            : { texto: 'Al corriente', clase: 'bg-green-100 text-green-700' }
        )
      }

      if (evaluacionesRes.status === 'fulfilled' && !evaluacionesRes.value.error) {
        setEvaluaciones(evaluacionesRes.value.data || [])
        setErrorEvaluaciones(false)
      } else {
        setEvaluaciones([])
        setErrorEvaluaciones(true)
      }

      if (evidenciasRes.status === 'fulfilled' && !evidenciasRes.value.error) {
        setEvidencias(evidenciasRes.value.data || [])
        setErrorEvidencias(false)
      } else {
        setEvidencias([])
        setErrorEvidencias(true)
      }

      if (necesidadesRes.status === 'fulfilled' && !necesidadesRes.value.error) {
        setNecesidadesApoyo(necesidadesRes.value.data || [])
        setErrorNecesidades(false)
      } else {
        setNecesidadesApoyo([])
        setErrorNecesidades(true)
      }

      if (fichasRes.status === 'fulfilled' && !fichasRes.value.error) {
        setFichasDescriptivas(fichasRes.value.data || [])
        setErrorFichas(false)
      } else {
        setFichasDescriptivas([])
        setErrorFichas(true)
      }

      if (notasRes.status === 'fulfilled' && !notasRes.value.error) {
        setNotasAlumno(notasRes.value.data || [])
        setErrorNotas(false)
      } else {
        setNotasAlumno([])
        setErrorNotas(true)
      }

      setCargando(false)
    }

    if (alumnoId) cargar()
  }, [alumnoId])

  const guardarDatos = async () => {
    setGuardando(true)
    setMensaje('')

    try {
      const { error } = await supabase
        .from('alumnos')
        .update({
          curp: curp || null,
          sexo: sexo || null,
          fecha_nacimiento: fechaNacimiento || null,
        })
        .eq('id', alumnoId)

      if (error) {
        setMensaje(`No se pudo guardar: ${error.message}`)
      } else {
        setMensaje('✅ Datos guardados.')
        setAlumno(prev => prev ? { ...prev, curp, sexo, fecha_nacimiento: fechaNacimiento } : prev)
      }
    } catch {
      setMensaje('No se pudo guardar: error de conexión.')
    }
    setGuardando(false)
  }

  const confirmarBaja = async () => {
    setEliminando(true)
    setErrorBaja('')
    try {
      await eliminarAlumnoDefinitivamente(supabase, alumnoId)
      router.push('/dashboard/lista?eliminado=1')
    } catch (err) {
      setErrorBaja(err instanceof Error ? err.message : 'No se pudo eliminar al alumno.')
      setEliminando(false)
    }
  }

  const generarBorrador = async () => {
    if (!cicloEscolarId) {
      setErrorBorrador('No se pudo determinar el ciclo escolar del alumno.')
      return
    }
    setGenerandoBorrador(true)
    setErrorBorrador('')
    setBorrador(null)

    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        setErrorBorrador('No se pudo identificar la sesión. Vuelve a iniciar sesión.')
        setGenerandoBorrador(false)
        return
      }

      const res = await fetch('/api/generar-ficha-descriptiva', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alumno_id: alumnoId,
          ciclo_escolar_id: cicloEscolarId,
          access_token: session.access_token,
        }),
      })
      const data = await res.json()

      if (!res.ok) {
        setErrorBorrador(data.error || 'No se pudo generar el borrador.')
      } else {
        setBorrador(data.borrador)
      }
    } catch {
      setErrorBorrador('Error al generar el borrador.')
    }
    setGenerandoBorrador(false)
  }

  const actualizarBorrador = (campo: keyof BorradorFicha, valor: string) => {
    setBorrador(prev => (prev ? { ...prev, [campo]: valor } : prev))
  }

  const guardarFicha = async () => {
    if (!borrador) return
    if (!grupoId || !grupo?.docente_id) {
      setErrorBorrador('No se pudo determinar el grupo del alumno.')
      return
    }
    setGuardandoFicha(true)
    setErrorBorrador('')

    const periodoActual = periodosEvaluacion[periodosEvaluacion.length - 1]?.nombre ?? null

    const { data, error } = await supabase
      .from('fichas_descriptivas')
      .insert({
        alumno_id: alumnoId,
        grupo_id: grupoId,
        docente_id: grupo.docente_id,
        periodo: periodoActual,
        contenido: borrador,
      })
      .select('id, periodo, contenido, creado_en')
      .single()

    if (error || !data) {
      setErrorBorrador('No se pudo guardar la ficha. Intenta de nuevo.')
    } else {
      setFichasDescriptivas(prev => [data, ...prev])
      setBorrador(null)
    }
    setGuardandoFicha(false)
  }

  // El asistente siempre sabe qué alumno está viendo el docente, sin
  // tener que preguntarlo — funciona aunque todavía esté cargando.
  useContextoAsistente({
    pantalla: 'ficha_alumno',
    alumnoId: alumno?.id,
    alumnoNombre: alumno?.nombre,
    datosAdicionales: { pestanaActiva: pestana },
  })
  useHerramientasAsistente([herramientaMarcarAsistencia])

  if (cargando) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 h-screen bg-gray-50">
        <div className="w-8 h-8 rounded-full border-2 border-purple-200 border-t-purple-600 animate-spin" />
        <p className="text-sm text-gray-400">Cargando...</p>
      </div>
    )
  }

  if (!alumno) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50 px-4">
        <p className="text-sm text-gray-500 text-center">{mensaje || 'Alumno no encontrado.'}</p>
      </div>
    )
  }

  const totalAsistencias = asistencias.filter(a => a.presente).length
  const totalFaltas = asistencias.length - totalAsistencias
  const porcentajeAsistencia = asistencias.length > 0 ? Math.round((totalAsistencias / asistencias.length) * 100) : null

  const fechasActividad = [
    asistencias[0]?.fecha,
    incidencias[0]?.fecha,
    evaluaciones[0]?.creado_en,
    evidencias[0]?.creado_en,
  ].filter(Boolean) as string[]
  const ultimaActividad = fechasActividad.length > 0 ? fechasActividad.reduce((max, f) => (f > max ? f : max)) : null

  const gradoGrupoTexto = grupo
    ? (grupo.grado ? `${grupo.grado}° ${grupo.grupo || ''}`.trim() : grupo.nombre_grupo)
    : null

  // Estado del expediente: se calcula con datos reales (no con la IA), para
  // que sea determinista y quede claro exactamente qué falta. Esta
  // inteligencia vive únicamente dentro de la pestaña Ficha descriptiva.
  const faltantesExpediente: string[] = []
  periodosEvaluacion.forEach(p => {
    const tieneEvaluacion = evaluaciones.some(
      ev => ev.periodo && ev.periodo.trim().toLowerCase() === p.nombre.trim().toLowerCase()
    )
    if (!tieneEvaluacion) faltantesExpediente.push(`Falta evaluación del ${p.nombre}.`)
  })
  if (evidencias.length === 0) faltantesExpediente.push('No existen evidencias.')
  if (!observacionesInscripcion || !observacionesInscripcion.trim()) faltantesExpediente.push('No hay observaciones registradas.')
  const expedienteCompleto = faltantesExpediente.length === 0

  const pestanas: { id: Pestana; label: string }[] = [
    { id: 'resumen', label: 'Resumen' },
    { id: 'datos', label: 'Datos' },
    { id: 'asistencia', label: 'Asistencia' },
    { id: 'incidencias', label: 'Incidencias' },
    { id: 'evaluaciones', label: 'Evaluaciones' },
    { id: 'evidencias', label: 'Evidencias' },
    { id: 'fichas', label: 'Ficha descriptiva' },
    { id: 'historial', label: 'Historial' },
  ]

  const historialItems: HistorialItem[] = [
    ...asistencias.map(a => ({
      key: `asistencia-${a.fecha}`,
      origen: 'Asistencia',
      fecha: a.fecha,
      titulo: a.presente ? 'Presente' : 'Falta',
      descripcion: '',
    })),
    ...incidencias.map(i => ({
      key: `incidencia-${i.id}`,
      origen: 'Incidencia',
      fecha: i.fecha,
      titulo: i.tipo || 'Incidencia',
      descripcion: i.descripcion || '',
    })),
    ...evaluaciones.map(ev => ({
      key: `evaluacion-${ev.id}`,
      origen: 'Evaluación',
      fecha: ev.creado_en,
      titulo: ev.campo_formativo || 'Evaluación',
      descripcion: [ev.periodo ? `Periodo: ${ev.periodo}` : null, ev.calificacion ? `Calificación: ${ev.calificacion}` : null].filter(Boolean).join(' · '),
    })),
    ...evidencias.map(ev => ({
      key: `evidencia-${ev.id}`,
      origen: 'Evidencia',
      fecha: ev.creado_en,
      titulo: ev.tipo || 'Evidencia',
      descripcion: ev.descripcion || '',
    })),
    ...notasAlumno.map(n => ({
      key: `nota-${n.id}`,
      origen: 'Nota',
      fecha: n.fecha,
      titulo: n.tipo || n.fuente_modulo || 'Nota',
      descripcion: n.contenido || '',
    })),
  ].sort((x, y) => (x.fecha < y.fecha ? 1 : x.fecha > y.fecha ? -1 : 0))

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <header className="relative bg-gradient-to-br from-purple-700 to-blue-600 px-4 pt-3 pb-4 sm:px-6 sm:pt-4 sm:pb-5">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center justify-between gap-3 mb-3">
            <a
              href="/dashboard/lista"
              aria-label="Volver a la lista"
              className="w-10 h-10 bg-white/15 backdrop-blur rounded-full flex items-center justify-center text-white text-lg hover:bg-white/25 active:bg-white/30 flex-shrink-0 transition-colors focus:outline-none focus:ring-2 focus:ring-white/70"
            >
              ‹
            </a>
            <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full whitespace-nowrap shadow-sm ${estadoGeneral.clase}`}>
              <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full ${estadoGeneral.texto === 'Al corriente' ? 'bg-green-600' : estadoGeneral.texto === 'Requiere atención' ? 'bg-amber-600' : 'bg-gray-400'}`} />
              {estadoGeneral.texto}
            </span>
          </div>

          <div className="flex items-center gap-3.5">
            <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-full bg-white/15 backdrop-blur border-2 border-white/30 flex items-center justify-center text-white text-lg sm:text-xl font-bold flex-shrink-0 shadow-lg">
              {getIniciales(alumno.nombre)}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-bold text-white text-lg sm:text-xl leading-tight truncate">{alumno.nombre}</p>
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                <span className="text-xs font-medium text-white bg-white/15 backdrop-blur px-2 py-0.5 rounded-full">
                  {posicion !== null ? `# ${posicion}` : 'Sin número'}
                </span>
                {gradoGrupoTexto && (
                  <span className="text-xs font-medium text-white bg-white/15 backdrop-blur px-2 py-0.5 rounded-full">{gradoGrupoTexto}</span>
                )}
                <span className="text-xs font-medium text-white bg-white/15 backdrop-blur px-2 py-0.5 rounded-full">
                  {alumno.sexo === 'M' ? 'Niña' : alumno.sexo === 'H' ? 'Niño' : 'Sexo sin registrar'}
                </span>
                <span className="text-xs font-medium text-white bg-white/15 backdrop-blur px-2 py-0.5 rounded-full">
                  {calcularEdad(alumno.fecha_nacimiento)}
                </span>
              </div>
            </div>
          </div>
        </div>
      </header>

      <div className="sticky top-0 z-10 bg-white/95 backdrop-blur border-b border-gray-100 shadow-sm">
        <div className="relative max-w-5xl mx-auto">
          <div className="flex gap-1.5 px-4 py-2.5 sm:px-6 overflow-x-auto text-sm [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]" style={{ WebkitOverflowScrolling: 'touch' }}>
            {pestanas.map(p => (
              <button
                key={p.id}
                onClick={() => setPestana(p.id)}
                className={`flex items-center gap-1.5 px-3.5 py-2 rounded-full whitespace-nowrap font-medium flex-shrink-0 transition-all focus:outline-none focus:ring-2 focus:ring-purple-400 ${pestana === p.id ? 'bg-gradient-to-r from-purple-600 to-blue-500 text-white shadow-sm' : 'bg-gray-50 text-gray-500 hover:bg-gray-100 active:bg-gray-200'}`}
              >
                <span aria-hidden="true" className="text-sm leading-none opacity-80">{ICONOS_PESTANA[p.id]}</span>
                {p.label}
              </button>
            ))}
          </div>
          <div aria-hidden="true" className="pointer-events-none absolute top-0 right-0 h-full w-10 bg-gradient-to-l from-white/95 to-transparent" />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-6 lg:px-8">
        <div className="max-w-3xl mx-auto">
        {pestana === 'resumen' && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <button onClick={() => setPestana('asistencia')} className="text-left bg-white border border-gray-100 rounded-2xl p-4 shadow-sm hover:shadow-md active:scale-[0.98] transition-all focus:outline-none focus:ring-2 focus:ring-purple-400">
                <div className="flex items-center gap-2 mb-2">
                  <span aria-hidden="true" className="w-7 h-7 rounded-lg bg-green-50 text-green-600 flex items-center justify-center text-sm flex-shrink-0">✅</span>
                  <p className="text-xs font-medium text-gray-500">Asistencia</p>
                </div>
                <p className="text-xl font-bold text-gray-900">{porcentajeAsistencia !== null ? `${porcentajeAsistencia}%` : 'Sin registros'}</p>
                {porcentajeAsistencia !== null && <p className="text-xs text-gray-400 mt-0.5">{totalAsistencias} de {asistencias.length} días</p>}
              </button>
              <button onClick={() => setPestana('asistencia')} className="text-left bg-white border border-gray-100 rounded-2xl p-4 shadow-sm hover:shadow-md active:scale-[0.98] transition-all focus:outline-none focus:ring-2 focus:ring-purple-400">
                <div className="flex items-center gap-2 mb-2">
                  <span aria-hidden="true" className="w-7 h-7 rounded-lg bg-red-50 text-red-600 flex items-center justify-center text-sm flex-shrink-0">❌</span>
                  <p className="text-xs font-medium text-gray-500">Faltas</p>
                </div>
                <p className="text-xl font-bold text-gray-900">{asistencias.length > 0 ? totalFaltas : 'Sin registros'}</p>
              </button>
              <button onClick={() => setPestana('incidencias')} className="text-left bg-white border border-gray-100 rounded-2xl p-4 shadow-sm hover:shadow-md active:scale-[0.98] transition-all focus:outline-none focus:ring-2 focus:ring-purple-400">
                <div className="flex items-center gap-2 mb-2">
                  <span aria-hidden="true" className="w-7 h-7 rounded-lg bg-amber-50 text-amber-600 flex items-center justify-center text-sm flex-shrink-0">⚠️</span>
                  <p className="text-xs font-medium text-gray-500">Incidencias</p>
                </div>
                <p className="text-xl font-bold text-gray-900">{incidencias.length > 0 ? incidencias.length : 'Sin registros'}</p>
              </button>
              <button onClick={() => setPestana('evaluaciones')} className="text-left bg-white border border-gray-100 rounded-2xl p-4 shadow-sm hover:shadow-md active:scale-[0.98] transition-all focus:outline-none focus:ring-2 focus:ring-purple-400">
                <div className="flex items-center gap-2 mb-2">
                  <span aria-hidden="true" className="w-7 h-7 rounded-lg bg-violet-50 text-violet-600 flex items-center justify-center text-sm flex-shrink-0">🏆</span>
                  <p className="text-xs font-medium text-gray-500">Evaluaciones</p>
                </div>
                <p className="text-xl font-bold text-gray-900">{evaluaciones.length > 0 ? evaluaciones.length : 'Sin registros'}</p>
              </button>
              <button onClick={() => setPestana('evidencias')} className="col-span-2 text-left bg-white border border-gray-100 rounded-2xl p-4 shadow-sm hover:shadow-md active:scale-[0.98] transition-all focus:outline-none focus:ring-2 focus:ring-purple-400">
                <div className="flex items-center gap-2 mb-2">
                  <span aria-hidden="true" className="w-7 h-7 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center text-sm flex-shrink-0">📎</span>
                  <p className="text-xs font-medium text-gray-500">Evidencias</p>
                </div>
                <p className="text-xl font-bold text-gray-900">{evidencias.length > 0 ? evidencias.length : 'Sin registros'}</p>
              </button>
            </div>

            <div className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm flex items-center gap-3">
              <span aria-hidden="true" className="w-9 h-9 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center text-base flex-shrink-0">🕓</span>
              <div className="min-w-0">
                <p className="text-xs font-medium text-gray-500">Última actividad registrada</p>
                <p className="text-sm font-semibold text-gray-900">{ultimaActividad ? formatFecha(ultimaActividad) : 'Sin registros'}</p>
              </div>
            </div>

            {(errorAsistencia || errorIncidencias || errorEvaluaciones || errorEvidencias || errorNecesidades) && (
              <BannerError mensaje="Algunos datos no se pudieron cargar por completo." />
            )}
          </div>
        )}

        {pestana === 'datos' && (
          <div className="bg-white border border-gray-100 rounded-2xl shadow-sm p-4 sm:p-6">
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-semibold text-gray-500 mb-1.5 block">CURP</label>
                <input
                  type="text"
                  value={curp}
                  onChange={e => setCurp(e.target.value.toUpperCase())}
                  maxLength={18}
                  className="w-full px-3.5 py-2.5 text-sm bg-gray-50 border border-gray-200 rounded-xl uppercase focus:outline-none focus:ring-2 focus:ring-purple-400 focus:border-transparent transition-shadow"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-500 mb-1.5 block">Sexo</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setSexo('M')}
                    className={`flex-1 py-2.5 rounded-xl text-sm font-medium border transition-colors focus:outline-none focus:ring-2 focus:ring-purple-400 ${sexo === 'M' ? 'bg-rose-100 border-rose-300 text-rose-700' : 'bg-gray-50 border-gray-200 text-gray-500'}`}
                  >
                    Niña
                  </button>
                  <button
                    onClick={() => setSexo('H')}
                    className={`flex-1 py-2.5 rounded-xl text-sm font-medium border transition-colors focus:outline-none focus:ring-2 focus:ring-purple-400 ${sexo === 'H' ? 'bg-sky-100 border-sky-300 text-sky-700' : 'bg-gray-50 border-gray-200 text-gray-500'}`}
                  >
                    Niño
                  </button>
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-500 mb-1.5 block">Fecha de nacimiento</label>
                <input
                  type="date"
                  value={fechaNacimiento}
                  onChange={e => setFechaNacimiento(e.target.value)}
                  className="w-full px-3.5 py-2.5 text-sm bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-400 focus:border-transparent transition-shadow"
                />
              </div>
            </div>

            <button
              onClick={guardarDatos}
              disabled={guardando}
              className="w-full bg-gradient-to-r from-purple-600 to-blue-500 text-white py-3 rounded-full font-semibold text-sm shadow-sm hover:shadow-md active:scale-[0.98] transition-all disabled:opacity-50 mt-5 focus:outline-none focus:ring-2 focus:ring-purple-400 focus:ring-offset-2"
            >
              {guardando ? 'Guardando...' : 'Guardar datos'}
            </button>

            {mensaje && <p className="text-xs text-center text-gray-500 mt-3">{mensaje}</p>}

            <div className="mt-6 pt-5 border-t border-gray-100">
              <button
                onClick={() => setMostrarConfirmacionBaja(true)}
                className="w-full sm:w-auto px-5 py-2.5 rounded-full bg-red-50 border border-red-200 text-sm font-semibold text-red-600 hover:bg-red-100 active:scale-[0.98] transition-all focus:outline-none focus:ring-2 focus:ring-red-300"
              >
                Dar de baja
              </button>
            </div>
          </div>
        )}

        {pestana === 'asistencia' && (
          <div className="space-y-3">
            <div className="flex gap-3 text-xs">
              <div className="flex-1 bg-green-50 border border-green-100 rounded-2xl py-3 text-center shadow-sm">
                <p className="font-bold text-green-700 text-lg">{totalAsistencias}</p>
                <p className="text-green-600 font-medium">Asistencias</p>
              </div>
              <div className="flex-1 bg-red-50 border border-red-100 rounded-2xl py-3 text-center shadow-sm">
                <p className="font-bold text-red-700 text-lg">{totalFaltas}</p>
                <p className="text-red-600 font-medium">Faltas</p>
              </div>
            </div>
            <div className="grid sm:grid-cols-2 gap-2.5">
              {errorAsistencia && <BannerError mensaje="No se pudieron cargar los registros de asistencia." />}
              {!errorAsistencia && asistencias.length === 0 && <EstadoVacio icono="✅" mensaje="Sin registros de asistencia." />}
              {asistencias.map((a, i) => (
                <div key={i} className="flex items-center justify-between px-4 py-3 bg-white border border-gray-100 rounded-2xl shadow-sm text-sm">
                  <span className="text-gray-700 font-medium">{formatFecha(a.fecha)}</span>
                  <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${a.presente ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                    {a.presente ? '✅ Presente' : '❌ Falta'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {pestana === 'incidencias' && (
          <div className="grid sm:grid-cols-2 gap-2.5">
            {errorIncidencias && <BannerError mensaje="No se pudieron cargar las incidencias." />}
            {!errorIncidencias && incidencias.length === 0 && <EstadoVacio icono="⚠️" mensaje="Sin incidencias registradas." />}
            {incidencias.map(i => (
              <div key={i.id} className="px-4 py-3.5 bg-white border border-gray-100 rounded-2xl shadow-sm">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
                    <span aria-hidden="true" className="w-6 h-6 rounded-md bg-amber-50 text-amber-600 flex items-center justify-center text-xs flex-shrink-0">⚠️</span>
                    {i.tipo}
                  </span>
                  <span className="text-xs text-gray-400">{formatFecha(i.fecha)}</span>
                </div>
                <p className="text-xs text-gray-600">{i.descripcion}</p>
                {i.seguimiento != null && (
                  <div className="mt-2 pt-2 border-t border-gray-100">
                    <p className="text-xs font-semibold text-gray-500 mb-1">Seguimiento</p>
                    <ResumenJson valor={i.seguimiento} vacio="Sin detalle de seguimiento." />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {pestana === 'evaluaciones' && (
          <div className="grid sm:grid-cols-2 gap-2.5">
            {errorEvaluaciones && <BannerError mensaje="No se pudieron cargar las evaluaciones." />}
            {!errorEvaluaciones && evaluaciones.length === 0 && <EstadoVacio icono="🏆" mensaje="Sin evaluaciones registradas." />}
            {evaluaciones.map(ev => (
              <div key={ev.id} className="px-4 py-3.5 bg-white border border-gray-100 rounded-2xl shadow-sm">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
                    <span aria-hidden="true" className="w-6 h-6 rounded-md bg-violet-50 text-violet-600 flex items-center justify-center text-xs flex-shrink-0">🏆</span>
                    {ev.campo_formativo || 'Campo formativo sin registrar'}
                  </span>
                  <span className="text-xs text-gray-400">{formatFecha(ev.creado_en)}</span>
                </div>
                <div className="flex flex-wrap gap-1.5 mb-1">
                  <span className="text-xs text-gray-500 bg-gray-50 px-2 py-0.5 rounded-full">Periodo: {ev.periodo || '—'}</span>
                  <span className="text-xs text-gray-500 bg-gray-50 px-2 py-0.5 rounded-full">Calificación: {ev.calificacion || '—'}</span>
                </div>
                {ev.rubrica != null && (
                  <div className="mt-2 pt-2 border-t border-gray-100">
                    <p className="text-xs font-semibold text-gray-500 mb-1">Rúbrica</p>
                    <ResumenJson valor={ev.rubrica} vacio="Sin detalle de rúbrica." />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {pestana === 'evidencias' && (
          <div className="grid sm:grid-cols-2 gap-2.5">
            {errorEvidencias && <BannerError mensaje="No se pudieron cargar las evidencias." />}
            {!errorEvidencias && evidencias.length === 0 && <EstadoVacio icono="📎" mensaje="Sin evidencias registradas." />}
            {evidencias.map(ev => (
              <div key={ev.id} className="px-4 py-3.5 bg-white border border-gray-100 rounded-2xl shadow-sm">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
                    <span aria-hidden="true" className="w-6 h-6 rounded-md bg-blue-50 text-blue-600 flex items-center justify-center text-xs flex-shrink-0">📎</span>
                    {ev.tipo || 'Evidencia sin tipo registrado'}
                  </span>
                  <span className="text-xs text-gray-400">{formatFecha(ev.creado_en)}</span>
                </div>
                {ev.descripcion && <p className="text-xs text-gray-600 mb-1">{ev.descripcion}</p>}
                {ev.archivo_url && (
                  <a
                    href={ev.archivo_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-semibold text-purple-600 mt-1 focus:outline-none focus:ring-2 focus:ring-purple-400 rounded"
                  >
                    📎 Abrir archivo
                  </a>
                )}
              </div>
            ))}
          </div>
        )}

        {pestana === 'fichas' && (
          <div className="space-y-5">
            <div className={`rounded-2xl border p-4 shadow-sm ${expedienteCompleto ? 'bg-green-50 border-green-100' : 'bg-amber-50 border-amber-100'}`}>
              <p className={`text-sm font-bold ${expedienteCompleto ? 'text-green-700' : 'text-amber-700'}`}>
                {expedienteCompleto ? '🟢 Todo listo para generar la ficha descriptiva.' : '🟡 Faltan elementos para generar la ficha descriptiva.'}
              </p>
              {!expedienteCompleto && (
                <ul className="mt-1.5 space-y-0.5">
                  {faltantesExpediente.map((f, i) => (
                    <li key={i} className="text-xs text-amber-700">• {f}</li>
                  ))}
                </ul>
              )}
            </div>

            {!borrador && expedienteCompleto && (
              <button
                type="button"
                onClick={generarBorrador}
                disabled={generandoBorrador}
                className="w-full px-5 py-3.5 rounded-full bg-gradient-to-r from-purple-600 to-blue-500 text-white text-base font-semibold shadow-sm hover:shadow-md active:scale-[0.98] transition-all disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-purple-400 focus:ring-offset-2"
              >
                {generandoBorrador ? 'Generando borrador...' : '✨ Generar borrador con IA'}
              </button>
            )}

            {errorBorrador && (
              <p className="text-xs text-center text-red-600 bg-red-50 border border-red-100 rounded-xl py-2 px-3">{errorBorrador}</p>
            )}

            {borrador && (
              <div className="bg-white border border-gray-100 rounded-2xl shadow-sm p-4 sm:p-6 space-y-4">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Borrador generado por IA — puedes editarlo antes de guardar</p>
                {CAMPOS_BORRADOR.map(({ campo, etiqueta }) => (
                  <div key={campo}>
                    <label className="text-xs font-semibold text-gray-500 mb-1.5 block">{etiqueta}</label>
                    <textarea
                      value={borrador[campo]}
                      onChange={e => actualizarBorrador(campo, e.target.value)}
                      rows={3}
                      className="w-full px-3.5 py-2.5 text-sm bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-400 focus:border-transparent transition-shadow resize-y"
                    />
                  </div>
                ))}
                <div className="flex flex-col sm:flex-row gap-2.5">
                  <button
                    type="button"
                    onClick={guardarFicha}
                    disabled={guardandoFicha}
                    className="flex-1 bg-gradient-to-r from-purple-600 to-blue-500 text-white py-3 rounded-full font-semibold text-sm shadow-sm hover:shadow-md active:scale-[0.98] transition-all disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-purple-400 focus:ring-offset-2"
                  >
                    {guardandoFicha ? 'Guardando...' : 'Guardar ficha'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setBorrador(null); setErrorBorrador('') }}
                    disabled={guardandoFicha}
                    className="rounded-full border border-gray-300 px-5 py-3 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-40"
                  >
                    Descartar
                  </button>
                </div>
              </div>
            )}

            <div className="grid sm:grid-cols-2 gap-2.5">
              {errorFichas && <BannerError mensaje="No se pudieron cargar las fichas descriptivas." />}
              {!errorFichas && fichasDescriptivas.length === 0 && <EstadoVacio icono="📝" mensaje="Sin fichas descriptivas registradas." />}
              {fichasDescriptivas.map(f => (
                <div key={f.id} className="px-4 py-3.5 bg-white border border-gray-100 rounded-2xl shadow-sm">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
                      <span aria-hidden="true" className="w-6 h-6 rounded-md bg-slate-100 text-slate-600 flex items-center justify-center text-xs flex-shrink-0">📝</span>
                      {f.periodo || 'Ficha descriptiva'}
                    </span>
                    <span className="text-xs text-gray-400">{formatFecha(f.creado_en)}</span>
                  </div>
                  <ResumenJson valor={f.contenido} vacio="Sin contenido registrado." />
                </div>
              ))}
            </div>

            <div>
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2.5">Necesidades de apoyo</p>
              <div className="grid sm:grid-cols-2 gap-2.5">
                {errorNecesidades && <BannerError mensaje="No se pudieron cargar las necesidades de apoyo." />}
                {!errorNecesidades && necesidadesApoyo.length === 0 && <EstadoVacio icono="🤝" mensaje="Sin necesidades de apoyo registradas." />}
                {necesidadesApoyo.map(n => (
                  <div key={n.id} className="px-4 py-3.5 bg-white border border-gray-100 rounded-2xl shadow-sm">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
                        <span aria-hidden="true" className="w-6 h-6 rounded-md bg-orange-50 text-orange-600 flex items-center justify-center text-xs flex-shrink-0">🤝</span>
                        {n.tipo || 'Necesidad de apoyo sin tipo registrado'}
                      </span>
                      <span className={`text-xs font-semibold px-2.5 py-1 rounded-full whitespace-nowrap ${n.activa ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'}`}>
                        {n.activa ? 'Activa' : 'Inactiva'}
                      </span>
                    </div>
                    {n.descripcion && <p className="text-xs text-gray-600 mb-1">{n.descripcion}</p>}
                    <p className="text-xs text-gray-400">{formatFecha(n.creado_en)}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {pestana === 'historial' && (
          <div className="grid sm:grid-cols-2 gap-2.5">
            {(errorAsistencia || errorIncidencias || errorEvaluaciones || errorEvidencias || errorNotas) && (
              <BannerError mensaje="Algunos registros no se pudieron incluir en el historial." />
            )}
            {historialItems.length === 0 && <EstadoVacio icono="🕓" mensaje="Sin registros en el historial." />}
            {historialItems.map(item => (
              <div key={item.key} className="px-4 py-3.5 bg-white border border-gray-100 rounded-2xl shadow-sm">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
                    <span aria-hidden="true" className={`w-6 h-6 rounded-md flex items-center justify-center text-xs flex-shrink-0 ${CHIP_ORIGEN[item.origen] || 'bg-gray-100 text-gray-500'}`}>{ICONOS_ORIGEN[item.origen] || '•'}</span>
                    {item.titulo}
                  </span>
                  <span className="text-xs text-gray-400">{formatFecha(item.fecha)}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  {item.descripcion && <p className="text-xs text-gray-600">{item.descripcion}</p>}
                  <span className="text-xs text-gray-400 whitespace-nowrap ml-auto bg-gray-50 px-2 py-0.5 rounded-full">{item.origen}</span>
                </div>
              </div>
            ))}
          </div>
        )}
        </div>
      </div>

      {mostrarConfirmacionBaja && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-black/40 backdrop-blur-sm">
          <div className="w-full max-w-sm bg-white rounded-3xl shadow-2xl p-6">
            <p className="text-base font-bold text-gray-900 text-center mb-2">
              ¿Deseas eliminar definitivamente este alumno del sistema?
            </p>
            <p className="text-sm text-gray-500 text-center mb-5">
              Esta acción eliminará permanentemente al alumno y toda su información asociada. No podrá recuperarse.
            </p>

            {errorBaja && (
              <p className="text-xs text-center text-red-600 bg-red-50 border border-red-100 rounded-xl py-2 px-3 mb-4">
                {errorBaja}
              </p>
            )}

            <div className="flex flex-col gap-2">
              <button
                onClick={confirmarBaja}
                disabled={eliminando}
                className="w-full bg-red-600 text-white py-3 rounded-full font-semibold text-sm hover:bg-red-700 active:scale-[0.98] transition-all disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-red-400 focus:ring-offset-2"
              >
                {eliminando ? 'Eliminando...' : 'Eliminar definitivamente'}
              </button>
              <button
                onClick={() => { setMostrarConfirmacionBaja(false); setErrorBaja('') }}
                disabled={eliminando}
                className="w-full bg-gray-100 text-gray-700 py-3 rounded-full font-semibold text-sm hover:bg-gray-200 active:scale-[0.98] transition-all disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-gray-300 focus:ring-offset-2"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
