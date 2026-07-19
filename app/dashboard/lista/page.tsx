'use client'
import { Suspense, useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { obtenerRosterConPosicion, type AlumnoConPosicion } from '@/lib/rosterGrupo'
import ImportacionInteligente from '@/components/ImportacionInteligente'
import type { GrupoParaImportar } from '@/lib/importacionInteligente'
import { useAsistente, useContextoAsistente, useHerramientasAsistente } from '@/lib/asistente/hooks'
import { herramientaMarcarAsistencia } from '@/lib/asistente/herramientas/asistencia'
import { fechaISOHoy, formatearFecha, obtenerZonaHorariaDispositivo } from '@/lib/tiempo/TimeService'

type Alumno = AlumnoConPosicion
type EstadoAsistencia = 'presente' | 'falta' | 'retardo'

const ESTADOS_ASISTENCIA: { valor: EstadoAsistencia; icono: string; etiqueta: string }[] = [
  { valor: 'presente', icono: '🟢', etiqueta: 'Presente' },
  { valor: 'falta', icono: '🔴', etiqueta: 'Falta' },
  { valor: 'retardo', icono: '🟠', etiqueta: 'Retardo' },
]

type Resumen = {
  estadoHoy: EstadoAsistencia | null
  totalAsistencias: number
  totalFaltas: number
  incidencias: number
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

export default function ListaPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-screen bg-gray-50">
        <p className="text-sm text-gray-400">Cargando lista...</p>
      </div>
    }>
      <ListaPageContent />
    </Suspense>
  )
}

function ListaPageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [mostrarExitoImportacion, setMostrarExitoImportacion] = useState(() => searchParams.get('importado') === '1')
  const [mostrarExitoBaja, setMostrarExitoBaja] = useState(() => searchParams.get('eliminado') === '1')
  const [nombreGrupo, setNombreGrupo] = useState('')
  const [grupo, setGrupo] = useState<GrupoParaImportar | null>(null)
  const [alumnos, setAlumnos] = useState<Alumno[]>([])
  const [resumenes, setResumenes] = useState<Record<string, Resumen>>({})
  const [cargando, setCargando] = useState(true)
  const [mensaje, setMensaje] = useState('')
  const [busqueda, setBusqueda] = useState('')
  const [filtro, setFiltro] = useState<'todos' | 'ninas' | 'ninos' | 'presentes' | 'ausentes'>('todos')

  const [estados, setEstados] = useState<Record<string, EstadoAsistencia>>({})
  const [guardandoAsistencia, setGuardandoAsistencia] = useState(false)

  const cargarTodo = async () => {
    setCargando(true)

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      setMensaje('No se pudo identificar al maestro.')
      setCargando(false)
      return
    }

    const { data: grupos, error: errorGrupo } = await supabase
      .from('grupos')
      .select('id, nombre_grupo, institucion_id, docente_id, ciclo_escolar_id, ciclos_escolares!inner(activo)')
      .eq('docente_id', user.id)
      .eq('ciclos_escolares.activo', true)
      .order('creado_en', { ascending: false })
      .limit(1)

    if (errorGrupo || !grupos || grupos.length === 0) {
      setMensaje('No se encontró un grupo activo.')
      setCargando(false)
      return
    }

    const grupoActivo = grupos[0]
    setNombreGrupo(grupoActivo.nombre_grupo)
    setGrupo({
      id: grupoActivo.id,
      institucion_id: grupoActivo.institucion_id,
      docente_id: grupoActivo.docente_id,
      ciclo_escolar_id: grupoActivo.ciclo_escolar_id,
    })

    const { data: alumnosDelGrupo, error: errorAlumnos } = await obtenerRosterConPosicion(supabase, grupoActivo.id)

    if (errorAlumnos) {
      setMensaje('No se pudo cargar la lista de alumnos.')
      setCargando(false)
      return
    }

    setAlumnos(alumnosDelGrupo)

    const idsAlumnos = alumnosDelGrupo.map(a => a.id)
    // Zona horaria real del dispositivo — toISOString() siempre da la
    // fecha en UTC sin importar dónde corra, así que cerca de medianoche
    // podía buscar el registro de asistencia del día equivocado.
    const hoy = fechaISOHoy(obtenerZonaHorariaDispositivo())

    const [{ data: asistenciasTodas }, { data: incidenciasTodas }, { data: inscripcionesActivas }] = await Promise.all([
      supabase.from('asistencias').select('alumno_id, fecha, presente').in('alumno_id', idsAlumnos),
      supabase.from('incidencias').select('alumno_id').in('alumno_id', idsAlumnos),
      supabase.from('inscripciones').select('id, alumno_id').eq('grupo_id', grupoActivo.id).eq('estatus', 'activo'),
    ])

    const inscripcionPorAlumno = new Map(
      (inscripcionesActivas || []).map((i: { id: string; alumno_id: string }) => [i.alumno_id, i.id])
    )
    const inscripcionIds = Array.from(inscripcionPorAlumno.values())

    const { data: registrosHoy } = inscripcionIds.length > 0
      ? await supabase
          .from('asistencia_registro')
          .select('inscripcion_id, estatus')
          .eq('fecha', hoy)
          .in('inscripcion_id', inscripcionIds)
      : { data: [] as { inscripcion_id: string; estatus: string }[] }

    const estatusPorInscripcion = new Map(
      (registrosHoy || []).map((r: { inscripcion_id: string; estatus: string }) => [r.inscripcion_id, r.estatus as EstadoAsistencia])
    )

    const nuevosResumenes: Record<string, Resumen> = {}
    alumnosDelGrupo.forEach(a => {
      const registros = (asistenciasTodas || []).filter(r => r.alumno_id === a.id)
      const inscripcionId = inscripcionPorAlumno.get(a.id)
      nuevosResumenes[a.id] = {
        estadoHoy: (inscripcionId && estatusPorInscripcion.get(inscripcionId)) || null,
        totalAsistencias: registros.filter(r => r.presente).length,
        totalFaltas: registros.filter(r => !r.presente).length,
        incidencias: (incidenciasTodas || []).filter(i => i.alumno_id === a.id).length,
      }
    })
    setResumenes(nuevosResumenes)

    const nuevosEstados: Record<string, EstadoAsistencia> = {}
    alumnosDelGrupo.forEach(a => {
      nuevosEstados[a.id] = nuevosResumenes[a.id]?.estadoHoy ?? 'presente'
    })
    setEstados(nuevosEstados)

    setCargando(false)
  }

  useEffect(() => {
    cargarTodo()
  }, [])

  useEffect(() => {
    if (!mostrarExitoImportacion) return
    router.replace('/dashboard/lista')
    const timer = setTimeout(() => setMostrarExitoImportacion(false), 4000)
    return () => clearTimeout(timer)
  }, [mostrarExitoImportacion, router])

  useEffect(() => {
    if (!mostrarExitoBaja) return
    router.replace('/dashboard/lista')
    const timer = setTimeout(() => setMostrarExitoBaja(false), 4000)
    return () => clearTimeout(timer)
  }, [mostrarExitoBaja, router])

  const importacionCompletada = async () => {
    await cargarTodo()
    setMostrarExitoImportacion(true)
  }

  const marcarEstadoHoy = (id: string, estado: EstadoAsistencia) => {
    setEstados(prev => ({ ...prev, [id]: estado }))
  }

  const guardarAsistenciaHoy = async () => {
    const registros = alumnos.map(a => ({ alumno_id: a.id, estado: estados[a.id] ?? 'presente' }))

    setGuardandoAsistencia(true)
    setMensaje('')

    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) {
      setMensaje('No se pudo identificar la sesión. Vuelve a iniciar sesión.')
      setGuardandoAsistencia(false)
      return
    }

    try {
      const res = await fetch('/api/asistencia-guardar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ registros, access_token: session.access_token, zonaHoraria: obtenerZonaHorariaDispositivo() }),
      })
      const data = await res.json()
      if (res.ok) {
        setMensaje(`✅ Asistencia guardada (${data.guardados} alumnos).`)
        await cargarTodo()
      } else {
        setMensaje(data.error || 'No se pudo guardar la asistencia.')
      }
    } catch {
      setMensaje('Error al guardar la asistencia.')
    }
    setGuardandoAsistencia(false)
  }

  const totalNinas = alumnos.filter(a => a.sexo === 'M').length
  const totalNinos = alumnos.filter(a => a.sexo === 'H').length

  const totalPresentes = alumnos.filter(a => (estados[a.id] ?? 'presente') === 'presente').length
  const totalFaltas = alumnos.filter(a => (estados[a.id] ?? 'presente') === 'falta').length
  const totalRetardos = alumnos.filter(a => (estados[a.id] ?? 'presente') === 'retardo').length

  const alumnosFiltrados = alumnos.filter(a => {
    if (busqueda && !a.nombre.toLowerCase().includes(busqueda.toLowerCase())) return false
    if (filtro === 'ninas' && a.sexo !== 'M') return false
    if (filtro === 'ninos' && a.sexo !== 'H') return false
    if (filtro === 'presentes' && (estados[a.id] ?? 'presente') !== 'presente') return false
    if (filtro === 'ausentes' && (estados[a.id] ?? 'presente') !== 'falta') return false
    return true
  })

  // El asistente siempre sabe que el docente está viendo Lista y de qué
  // grupo, sin tener que preguntarlo.
  useContextoAsistente({
    pantalla: 'lista',
    grupoId: grupo?.id,
    datosAdicionales: { nombreGrupo, totalAlumnos: alumnos.length },
  })
  useHerramientasAsistente([herramientaMarcarAsistencia])

  // Lista es un módulo independiente — nunca debe mostrarse con el Chat
  // IA abierto encima, sin importar cómo se llegó aquí (ver ARQUITECTURA
  // DE NAVEGACIÓN DEL CHAT IA). cerrarPanel() solo afecta la visibilidad
  // del panel, nunca la conversación guardada.
  const asistente = useAsistente()
  useEffect(() => {
    asistente.cerrarPanel()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (cargando) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50">
        <p className="text-sm text-gray-400">Cargando lista...</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <header className="px-4 py-4 bg-white border-b border-gray-100 shadow-sm">
        <div className="flex items-center gap-3 mb-3">
          <a href="/dashboard" className="w-8 h-8 bg-gray-100 rounded-full flex items-center justify-center text-gray-500 hover:bg-gray-200">‹</a>
          <div className="flex-1">
            <p className="font-bold text-gray-900 text-base">{nombreGrupo || 'Lista'}</p>
            <p className="text-xs text-gray-400">{formatearFecha(new Date(), obtenerZonaHorariaDispositivo(), { weekday: 'long', day: 'numeric', month: 'long' })}</p>
          </div>
          <ImportacionInteligente grupo={grupo} onImportacionCompleta={importacionCompletada} />
        </div>
        <div className="flex gap-2 text-xs">
          <div className="flex-1 bg-gray-50 border border-gray-200 rounded-lg py-2 text-center">
            <p className="font-bold text-gray-900">{alumnos.length}</p>
            <p className="text-gray-400">Alumnos</p>
          </div>
          <div className="flex-1 bg-rose-50 border border-rose-100 rounded-lg py-2 text-center">
            <p className="font-bold text-rose-700">{totalNinas}</p>
            <p className="text-rose-400">Niñas</p>
          </div>
          <div className="flex-1 bg-sky-50 border border-sky-100 rounded-lg py-2 text-center">
            <p className="font-bold text-sky-700">{totalNinos}</p>
            <p className="text-sky-400">Niños</p>
          </div>
        </div>
      </header>

      {alumnos.length > 0 && (
        <div className="grid grid-cols-3 gap-2 px-4 py-3 bg-white border-b border-gray-100">
          <div className="rounded-xl bg-green-50 border border-green-200 py-2 text-center">
            <p className="text-lg font-bold text-green-700">{totalPresentes}</p>
            <p className="text-[11px] font-medium text-green-600">🟢 Presentes</p>
          </div>
          <div className="rounded-xl bg-red-50 border border-red-200 py-2 text-center">
            <p className="text-lg font-bold text-red-700">{totalFaltas}</p>
            <p className="text-[11px] font-medium text-red-600">🔴 Faltas</p>
          </div>
          <div className="rounded-xl bg-orange-50 border border-orange-200 py-2 text-center">
            <p className="text-lg font-bold text-orange-700">{totalRetardos}</p>
            <p className="text-[11px] font-medium text-orange-600">🟠 Retardos</p>
          </div>
        </div>
      )}

      {mostrarExitoImportacion && (
        <div className="px-4 py-2.5 bg-emerald-50 border-b border-emerald-100 text-center text-xs font-semibold text-emerald-700">
          ✅ Importación completada correctamente
        </div>
      )}

      {mostrarExitoBaja && (
        <div className="px-4 py-2.5 bg-emerald-50 border-b border-emerald-100 text-center text-xs font-semibold text-emerald-700">
          ✅ Alumno eliminado correctamente
        </div>
      )}

      <div className="px-4 py-3 bg-white border-b border-gray-100">
        <input
          type="text"
          placeholder="Buscar alumno..."
          value={busqueda}
          onChange={e => setBusqueda(e.target.value)}
          className="w-full px-3 py-2 text-sm bg-gray-50 border border-gray-200 rounded-lg mb-2"
        />
        <div className="flex gap-2 overflow-x-auto text-xs">
          {(['todos', 'ninas', 'ninos', 'presentes', 'ausentes'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFiltro(f)}
              className={`px-3 py-1.5 rounded-full whitespace-nowrap border ${filtro === f ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-500 border-gray-200'}`}
            >
              {f === 'todos' ? 'Todos' : f === 'ninas' ? 'Niñas' : f === 'ninos' ? 'Niños' : f === 'presentes' ? 'Presentes' : 'Ausentes'}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {mensaje && <p className="text-xs text-center text-gray-500">{mensaje}</p>}

        {alumnosFiltrados.map(a => {
          const r = resumenes[a.id]
          const esNina = a.sexo === 'M'
          const estadoLocal = estados[a.id] ?? 'presente'
          return (
            <div
              key={a.id}
              onClick={() => router.push(`/dashboard/lista/${a.id}`)}
              className={`w-full text-left px-4 py-3 rounded-xl border cursor-pointer ${esNina ? 'bg-rose-50/60 border-rose-100' : 'bg-sky-50/60 border-sky-100'}`}
            >
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-sm font-semibold text-gray-900 min-w-0 truncate">
                  {a.posicion}. {a.nombre}
                </span>
                <div className="flex items-center gap-1 flex-shrink-0" onClick={e => e.stopPropagation()}>
                  {ESTADOS_ASISTENCIA.map(op => (
                    <button
                      key={op.valor}
                      type="button"
                      onClick={() => marcarEstadoHoy(a.id, op.valor)}
                      aria-label={op.etiqueta}
                      aria-pressed={estadoLocal === op.valor}
                      className={`w-7 h-7 rounded-full flex items-center justify-center text-xs border transition ${estadoLocal === op.valor ? 'bg-white border-gray-300 shadow-sm scale-105' : 'bg-transparent border-transparent opacity-40'}`}
                    >
                      {op.icono}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-500">
                <span>{a.sexo === 'M' ? 'Niña' : a.sexo === 'H' ? 'Niño' : '—'}</span>
                <span>{calcularEdad(a.fecha_nacimiento)}</span>
                <span>Asist: {r?.totalAsistencias ?? 0}</span>
                <span>Faltas: {r?.totalFaltas ?? 0}</span>
                <span>Incidencias: {r?.incidencias ?? 0}</span>
              </div>
            </div>
          )
        })}
      </div>

      {alumnos.length > 0 && (
        <div className="p-4 border-t border-gray-100 bg-white">
          <button
            onClick={guardarAsistenciaHoy}
            disabled={guardandoAsistencia}
            className="w-full bg-gradient-to-r from-purple-600 to-blue-500 text-white py-3 rounded-full font-semibold text-sm disabled:opacity-50"
          >
            {guardandoAsistencia ? 'Guardando...' : 'Guardar asistencia de hoy'}
          </button>
        </div>
      )}
    </div>
  )
}
