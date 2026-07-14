'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'

type Alumno = {
  id: string
  nombre: string
  numero_lista: number | null
  curp: string | null
  sexo: string | null
  fecha_nacimiento: string | null
}

type Resumen = {
  presenteHoy: boolean | null
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
  const router = useRouter()
  const [nombreGrupo, setNombreGrupo] = useState('')
  const [alumnos, setAlumnos] = useState<Alumno[]>([])
  const [resumenes, setResumenes] = useState<Record<string, Resumen>>({})
  const [cargando, setCargando] = useState(true)
  const [mensaje, setMensaje] = useState('')
  const [busqueda, setBusqueda] = useState('')
  const [filtro, setFiltro] = useState<'todos' | 'ninas' | 'ninos' | 'presentes' | 'ausentes'>('todos')

  useEffect(() => {
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
        .select('id, nombre_grupo, ciclo_escolar_id, ciclos_escolares!inner(activo)')
        .eq('docente_id', user.id)
        .eq('ciclos_escolares.activo', true)
        .order('creado_en', { ascending: false })
        .limit(1)

      if (errorGrupo || !grupos || grupos.length === 0) {
        setMensaje('No se encontró un grupo activo.')
        setCargando(false)
        return
      }

      const grupo = grupos[0]
      setNombreGrupo(grupo.nombre_grupo)

      const { data: alumnosDelGrupo, error: errorAlumnos } = await supabase
        .from('alumnos')
        .select('id, nombre, numero_lista, curp, sexo, fecha_nacimiento')
        .eq('grupo_id', grupo.id)
        .order('numero_lista', { ascending: true, nullsFirst: false })

      if (errorAlumnos || !alumnosDelGrupo) {
        setMensaje('No se pudo cargar la lista de alumnos.')
        setCargando(false)
        return
      }

      setAlumnos(alumnosDelGrupo)

      const idsAlumnos = alumnosDelGrupo.map(a => a.id)
      const hoy = new Date().toISOString().slice(0, 10)

      const [{ data: asistenciasTodas }, { data: incidenciasTodas }] = await Promise.all([
        supabase.from('asistencias').select('alumno_id, fecha, presente').in('alumno_id', idsAlumnos),
        supabase.from('incidencias').select('alumno_id').in('alumno_id', idsAlumnos),
      ])

      const nuevosResumenes: Record<string, Resumen> = {}
      alumnosDelGrupo.forEach(a => {
        const registros = (asistenciasTodas || []).filter(r => r.alumno_id === a.id)
        const registroHoy = registros.find(r => r.fecha === hoy)
        nuevosResumenes[a.id] = {
          presenteHoy: registroHoy ? registroHoy.presente : null,
          totalAsistencias: registros.filter(r => r.presente).length,
          totalFaltas: registros.filter(r => !r.presente).length,
          incidencias: (incidenciasTodas || []).filter(i => i.alumno_id === a.id).length,
        }
      })
      setResumenes(nuevosResumenes)

      setCargando(false)
    }

    cargarTodo()
  }, [])

  const totalNinas = alumnos.filter(a => a.sexo === 'M').length
  const totalNinos = alumnos.filter(a => a.sexo === 'H').length

  const alumnosFiltrados = alumnos.filter(a => {
    if (busqueda && !a.nombre.toLowerCase().includes(busqueda.toLowerCase())) return false
    if (filtro === 'ninas' && a.sexo !== 'M') return false
    if (filtro === 'ninos' && a.sexo !== 'H') return false
    if (filtro === 'presentes' && resumenes[a.id]?.presenteHoy !== true) return false
    if (filtro === 'ausentes' && resumenes[a.id]?.presenteHoy !== false) return false
    return true
  })

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
          <a href="/dashboard/chat" className="w-8 h-8 bg-gray-100 rounded-full flex items-center justify-center text-gray-500 hover:bg-gray-200">‹</a>
          <div>
            <p className="font-bold text-gray-900 text-base">{nombreGrupo || 'Lista'}</p>
            <p className="text-xs text-gray-400">{new Date().toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
          </div>
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
          return (
            <button
              key={a.id}
              onClick={() => router.push(`/dashboard/lista/${a.id}`)}
              className={`w-full text-left px-4 py-3 rounded-xl border ${esNina ? 'bg-rose-50/60 border-rose-100' : 'bg-sky-50/60 border-sky-100'}`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-semibold text-gray-900">
                  {a.numero_lista ? `${a.numero_lista}. ` : ''}{a.nombre}
                </span>
                <span className="text-lg">
                  {r?.presenteHoy === true ? '✅' : r?.presenteHoy === false ? '❌' : '—'}
                </span>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-500">
                <span>{a.sexo === 'M' ? 'Niña' : a.sexo === 'H' ? 'Niño' : '—'}</span>
                <span>{calcularEdad(a.fecha_nacimiento)}</span>
                <span>Asist: {r?.totalAsistencias ?? 0}</span>
                <span>Faltas: {r?.totalFaltas ?? 0}</span>
                <span>Incidencias: {r?.incidencias ?? 0}</span>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
