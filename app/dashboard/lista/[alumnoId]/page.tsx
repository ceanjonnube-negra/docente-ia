'use client'
import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'

type Alumno = {
  id: string
  nombre: string
  numero_lista: number | null
  curp: string | null
  sexo: string | null
  fecha_nacimiento: string | null
}

type Asistencia = { fecha: string; presente: boolean }
type Incidencia = { id: string; fecha: string; tipo: string; descripcion: string }

export default function FichaAlumnoPage() {
  const { alumnoId } = useParams<{ alumnoId: string }>()
  const router = useRouter()

  const [alumno, setAlumno] = useState<Alumno | null>(null)
  const [asistencias, setAsistencias] = useState<Asistencia[]>([])
  const [incidencias, setIncidencias] = useState<Incidencia[]>([])
  const [pestana, setPestana] = useState<'datos' | 'asistencia' | 'incidencias'>('datos')
  const [cargando, setCargando] = useState(true)
  const [guardando, setGuardando] = useState(false)
  const [mensaje, setMensaje] = useState('')

  const [curp, setCurp] = useState('')
  const [sexo, setSexo] = useState('')
  const [fechaNacimiento, setFechaNacimiento] = useState('')
  const [numeroLista, setNumeroLista] = useState('')

  useEffect(() => {
    const cargar = async () => {
      setCargando(true)

      const { data: a, error: errorAlumno } = await supabase
        .from('alumnos')
        .select('id, nombre, numero_lista, curp, sexo, fecha_nacimiento')
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
      setNumeroLista(a.numero_lista?.toString() || '')

      const { data: asis } = await supabase
        .from('asistencias')
        .select('fecha, presente')
        .eq('alumno_id', alumnoId)
        .order('fecha', { ascending: false })

      setAsistencias(asis || [])

      const { data: inc } = await supabase
        .from('incidencias')
        .select('id, fecha, tipo, descripcion')
        .eq('alumno_id', alumnoId)
        .order('fecha', { ascending: false })

      setIncidencias(inc || [])
      setCargando(false)
    }

    if (alumnoId) cargar()
  }, [alumnoId])

  const guardarDatos = async () => {
    setGuardando(true)
    setMensaje('')

    const { error } = await supabase
      .from('alumnos')
      .update({
        curp: curp || null,
        sexo: sexo || null,
        fecha_nacimiento: fechaNacimiento || null,
        numero_lista: numeroLista ? parseInt(numeroLista) : null,
      })
      .eq('id', alumnoId)

    if (error) {
      setMensaje(`No se pudo guardar: ${error.message}`)
    } else {
      setMensaje('✅ Datos guardados.')
      setAlumno(prev => prev ? { ...prev, curp, sexo, fecha_nacimiento: fechaNacimiento, numero_lista: numeroLista ? parseInt(numeroLista) : null } : prev)
    }
    setGuardando(false)
  }

  if (cargando) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50">
        <p className="text-sm text-gray-400">Cargando...</p>
      </div>
    )
  }

  if (!alumno) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50">
        <p className="text-sm text-gray-500">{mensaje || 'Alumno no encontrado.'}</p>
      </div>
    )
  }

  const totalAsistencias = asistencias.filter(a => a.presente).length
  const totalFaltas = asistencias.filter(a => !a.presente).length

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <header className="flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-100 shadow-sm">
        <button onClick={() => router.back()} className="w-8 h-8 bg-gray-100 rounded-full flex items-center justify-center text-gray-500 hover:bg-gray-200">‹</button>
        <div>
          <p className="font-bold text-gray-900 text-sm">{alumno.nombre}</p>
          <p className="text-xs text-gray-400">
            {alumno.numero_lista ? `# ${alumno.numero_lista}` : 'Sin número de lista'}
          </p>
        </div>
      </header>

      <div className="flex gap-2 px-4 py-3 bg-white border-b border-gray-100 overflow-x-auto text-xs">
        {(['datos', 'asistencia', 'incidencias'] as const).map(p => (
          <button
            key={p}
            onClick={() => setPestana(p)}
            className={`px-3 py-1.5 rounded-full whitespace-nowrap border ${pestana === p ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-500 border-gray-200'}`}
          >
            {p === 'datos' ? 'Datos personales' : p === 'asistencia' ? 'Asistencia' : 'Incidencias'}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {pestana === 'datos' && (
          <div className="space-y-4">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Número de lista</label>
              <input
                type="number"
                value={numeroLista}
                onChange={e => setNumeroLista(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">CURP</label>
              <input
                type="text"
                value={curp}
                onChange={e => setCurp(e.target.value.toUpperCase())}
                maxLength={18}
                className="w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg uppercase"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Sexo</label>
              <div className="flex gap-2">
                <button
                  onClick={() => setSexo('F')}
                  className={`flex-1 py-2 rounded-lg text-sm border ${sexo === 'F' ? 'bg-rose-100 border-rose-300 text-rose-700' : 'bg-white border-gray-200 text-gray-500'}`}
                >
                  Niña
                </button>
                <button
                  onClick={() => setSexo('M')}
                  className={`flex-1 py-2 rounded-lg text-sm border ${sexo === 'M' ? 'bg-sky-100 border-sky-300 text-sky-700' : 'bg-white border-gray-200 text-gray-500'}`}
                >
                  Niño
                </button>
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Fecha de nacimiento</label>
              <input
                type="date"
                value={fechaNacimiento}
                onChange={e => setFechaNacimiento(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg"
              />
            </div>

            <button
              onClick={guardarDatos}
              disabled={guardando}
              className="w-full bg-gradient-to-r from-purple-600 to-blue-500 text-white py-3 rounded-full font-semibold text-sm disabled:opacity-50"
            >
              {guardando ? 'Guardando...' : 'Guardar datos'}
            </button>

            {mensaje && <p className="text-xs text-center text-gray-500">{mensaje}</p>}
          </div>
        )}

        {pestana === 'asistencia' && (
          <div className="space-y-3">
            <div className="flex gap-2 text-xs">
              <div className="flex-1 bg-green-50 border border-green-100 rounded-lg py-2 text-center">
                <p className="font-bold text-green-700">{totalAsistencias}</p>
                <p className="text-green-500">Asistencias</p>
              </div>
              <div className="flex-1 bg-red-50 border border-red-100 rounded-lg py-2 text-center">
                <p className="font-bold text-red-700">{totalFaltas}</p>
                <p className="text-red-500">Faltas</p>
              </div>
            </div>
            <div className="space-y-2">
              {asistencias.length === 0 && <p className="text-xs text-center text-gray-400 mt-4">Sin registros de asistencia.</p>}
              {asistencias.map((a, i) => (
                <div key={i} className="flex items-center justify-between px-4 py-2 bg-white border border-gray-100 rounded-lg text-sm">
                  <span className="text-gray-700">{a.fecha}</span>
                  <span>{a.presente ? '✅ Presente' : '❌ Falta'}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {pestana === 'incidencias' && (
          <div className="space-y-2">
            {incidencias.length === 0 && <p className="text-xs text-center text-gray-400 mt-4">Sin incidencias registradas.</p>}
            {incidencias.map(i => (
              <div key={i.id} className="px-4 py-3 bg-white border border-gray-100 rounded-lg">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-semibold text-gray-900">{i.tipo}</span>
                  <span className="text-xs text-gray-400">{i.fecha}</span>
                </div>
                <p className="text-xs text-gray-600">{i.descripcion}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
