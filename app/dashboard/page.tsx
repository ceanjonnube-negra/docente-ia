'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

const modulos = [
  { icon: '📄', titulo: 'Planeaciones', desc: 'NEM por campo formativo', color: 'bg-purple-100', href: '#' },
  { icon: '🎨', titulo: 'Material', desc: 'Actividades e imprimibles', color: 'bg-blue-100', href: '#' },
  { icon: '📊', titulo: 'Evaluaciones', desc: 'Rúbricas y exámenes', color: 'bg-green-100', href: '#' },
  { icon: '👨‍🎓', titulo: 'Alumnos', desc: 'Lista y seguimiento', color: 'bg-yellow-100', href: '#' },
  { icon: '🏫', titulo: 'Mi Escuela', desc: 'Documentos institucionales', color: 'bg-orange-100', href: '#' },
  { icon: '📢', titulo: 'Comunicados', desc: 'Avisos para padres', color: 'bg-pink-100', href: '#' },
  { icon: '📋', titulo: 'Documentos', desc: 'Oficios, actas, constancias', color: 'bg-indigo-100', href: '#' },
  { icon: '📅', titulo: 'Asistencia', desc: 'Control diario', color: 'bg-teal-100', href: '#' },
]

export default function Dashboard() {
  const [perfil, setPerfil] = useState<any>(null)
  const [hora, setHora] = useState('')

  useEffect(() => {
    const h = new Date().getHours()
    if (h < 12) setHora('Buenos días')
    else if (h < 19) setHora('Buenas tardes')
    else setHora('Buenas noches')

    const cargar = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        const { data } = await supabase.from('perfiles_docentes').select('*').eq('id', user.id).single()
        setPerfil(data)
      }
    }
    cargar()
  }, [])

  const nombre = perfil?.nombre?.split(' ')[0] || 'Maestro'

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-purple-50">
      <header className="bg-white border-b border-gray-100 px-6 py-4 flex justify-between items-center sticky top-0 z-10">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-gradient-to-br from-purple-600 to-blue-500 rounded-xl flex items-center justify-center text-sm">🤖</div>
          <span className="font-black text-gray-900">Docente <span className="text-purple-600">IA</span></span>
        </div>
        <button onClick={async () => { await supabase.auth.signOut(); window.location.href = '/' }} className="text-sm text-gray-400 hover:text-gray-600">
          Salir
        </button>
      </header>

      <div className="max-w-md mx-auto px-4 py-6">
        <div className="bg-gradient-to-r from-purple-600 to-blue-500 rounded-3xl p-6 mb-6 text-white shadow-lg">
          <p className="text-purple-200 text-sm">{hora}</p>
          <h1 className="text-2xl font-black mt-1">{nombre} 👋</h1>
          {perfil && (
            <p className="text-purple-200 text-sm mt-1">{perfil.escuela} · {perfil.grado}{perfil.grupo}</p>
          )}
          <div className="mt-4 flex items-center gap-2 bg-white/20 rounded-2xl p-3">
            <span className="text-2xl">🤖</span>
            <div>
              <p className="font-semibold text-sm">¿Qué necesitas resolver hoy?</p>
              <p className="text-purple-200 text-xs">Toca para abrir el asistente IA</p>
            </div>
          </div>
        </div>

        <a href="/dashboard/chat" className="block w-full bg-gradient-to-r from-purple-600 to-blue-500 text-white rounded-2xl py-4 text-center font-bold shadow-lg hover:opacity-90 transition mb-6 text-base">
          ✨ Abrir Chat IA
        </a>

        <h2 className="font-black text-gray-900 text-lg mb-3">Módulos</h2>
        <div className="grid grid-cols-2 gap-3">
          {modulos.map((m) => (
            <a key={m.titulo} href={m.href} className={`${m.color} rounded-2xl p-4 block hover:shadow-md transition`}>
              <div className="text-3xl mb-2">{m.icon}</div>
              <h3 className="font-bold text-gray-900 text-sm">{m.titulo}</h3>
              <p className="text-gray-500 text-xs mt-1">{m.desc}</p>
            </a>
          ))}
        </div>
      </div>
    </div>
  )
}
