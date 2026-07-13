'use client'
import { useState, useRef } from 'react'
import { supabase } from '@/lib/supabaseClient'


type Alumno = { id: string; nombre: string }

export default function AsistenciaPage() {
  const [alumnos, setAlumnos] = useState<Alumno[]>([])
  const [presentes, setPresentes] = useState<Record<string, boolean>>({})
  const [cargando, setCargando] = useState(false)
  const [guardando, setGuardando] = useState(false)
  const [mensaje, setMensaje] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const tomarFoto = () => {
    inputRef.current?.click()
  }

  const procesarFoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setCargando(true)
    setMensaje('')

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      setMensaje('No se pudo identificar al maestro.')
      setCargando(false)
      return
    }

    const formData = new FormData()
    formData.append('file', file)
    formData.append('docente_id', user.id)

    const { data: { session } } = await supabase.auth.getSession()
    if (session?.access_token) {
      formData.append('access_token', session.access_token)
    }

    try {
      const res = await fetch('/api/asistencia-foto', { method: 'POST', body: formData })
      const data = await res.json()

      if (!res.ok) {
        setMensaje(data.error || 'No se pudo leer la lista.')
      } else {
        setAlumnos(data.alumnos)
        const nuevosPresentes: Record<string, boolean> = {}
        data.alumnos.forEach((a: Alumno) => { nuevosPresentes[a.id] = true })
        setPresentes(nuevosPresentes)
        setMensaje(`✅ ${data.nuevos_detectados} nombre(s) detectados. Lista actualizada.`)
      }
    } catch (err) {
      setMensaje('Error al procesar la foto.')
    }

    setCargando(false)
    if (inputRef.current) inputRef.current.value = ''
  }

  const toggle = (id: string) => {
    setPresentes(prev => ({ ...prev, [id]: !prev[id] }))
  }

  const guardarAsistencia = async () => {
    setGuardando(true)
    const registros = alumnos.map(a => ({ alumno_id: a.id, presente: presentes[a.id] ?? true }))

    try {
      const res = await fetch('/api/asistencia-guardar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ registros }),
      })
      const data = await res.json()
      if (res.ok) {
        setMensaje(`✅ Asistencia guardada (${data.guardados} alumnos).`)
      } else {
        setMensaje(data.error || 'No se pudo guardar.')
      }
    } catch {
      setMensaje('Error al guardar.')
    }
    setGuardando(false)
  }

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <header className="flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-100 shadow-sm">
        <a href="/dashboard/chat" className="w-8 h-8 bg-gray-100 rounded-full flex items-center justify-center text-gray-500 hover:bg-gray-200">‹</a>
        <div className="w-8 h-8 bg-gradient-to-br from-rose-400 to-rose-600 rounded-xl flex items-center justify-center text-xs">✅</div>
        <div>
          <p className="font-bold text-gray-900 text-sm">Asistencia</p>
          <p className="text-xs text-gray-400">{new Date().toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
        </div>
      </header>

      <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={procesarFoto} />

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {alumnos.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-6">
            <h2 className="text-lg font-bold text-gray-900 mb-2">Toma foto de tu lista</h2>
            <p className="text-sm text-gray-500 max-w-xs mb-6">La IA leerá los nombres y armará tu lista digital automáticamente, ordenada alfabéticamente.</p>
            <button onClick={tomarFoto} disabled={cargando} className="w-10 h-10 bg-gradient-to-r from-purple-600 to-blue-500 text-white rounded-full flex items-center justify-center hover:opacity-90 transition disabled:opacity-40">
              📷
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-semibold text-gray-700">{alumnos.length} alumnos</p>
              <button onClick={tomarFoto} disabled={cargando} className="w-8 h-8 bg-gray-100 rounded-full flex items-center justify-center text-sm hover:bg-gray-200 transition disabled:opacity-40">
                📷
              </button>
            </div>
            <div className="space-y-2">
              {alumnos.map(a => (
                <button
                  key={a.id}
                  onClick={() => toggle(a.id)}
                  className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border text-left ${presentes[a.id] ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}
                >
                  <span className="text-sm font-medium text-gray-800">{a.nombre}</span>
                  <span className="text-lg">{presentes[a.id] ? '✅' : '❌'}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {mensaje && <p className="text-xs text-center text-gray-500 mt-4">{mensaje}</p>}
      </div>

      {alumnos.length > 0 && (
        <div className="p-4 border-t border-gray-100 bg-white">
          <button onClick={guardarAsistencia} disabled={guardando} className="w-full bg-gradient-to-r from-purple-600 to-blue-500 text-white py-3 rounded-full font-semibold text-sm disabled:opacity-50">
            {guardando ? 'Guardando...' : 'Guardar asistencia de hoy'}
          </button>
        </div>
      )}
    </div>
  )
}
