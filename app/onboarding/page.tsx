'use client'
import { useState } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

const pasos = [
  { campo: 'nombre', label: '¿Cómo te llamas?', sub: 'Empecemos con tu nombre.', placeholder: 'Escribe tu nombre completo', icono: '👤' },
  { campo: 'escuela', label: '¿En qué escuela trabajas?', sub: 'Nombre de tu institución.', placeholder: 'Nombre de tu escuela', icono: '🏫' },
  { campo: 'grado', label: '¿Qué grado atiendes?', sub: 'Selecciona tu grado escolar.', placeholder: '', icono: '🎒', tipo: 'select', opciones: ['1°','2°','3°','4°','5°','6°'] },
  { campo: 'grupo', label: '¿Cuál es tu grupo?', sub: 'Selecciona tu grupo.', placeholder: '', icono: '👥', tipo: 'select', opciones: ['A','B','C','D','E'] },
  { campo: 'estado', label: '¿En qué estado trabajas?', sub: 'Tu estado de la república.', placeholder: 'Ej. Jalisco', icono: '📍' },
  { campo: 'municipio', label: '¿En qué municipio?', sub: 'Tu municipio o ciudad.', placeholder: 'Ej. Guadalajara', icono: '🏙️' },
]

export default function Onboarding() {
  const [paso, setPaso] = useState(0)
  const [datos, setDatos] = useState<Record<string, string>>({})
  const [guardando, setGuardando] = useState(false)

  const actual = pasos[paso]
  const progreso = ((paso + 1) / pasos.length) * 100

  const siguiente = async () => {
    if (paso < pasos.length - 1) {
      setPaso(paso + 1)
    } else {
      setGuardando(true)
      const { data: { user } } = await supabase.auth.getUser()
      await supabase.from('perfiles_docentes').upsert({ id: user?.id, ...datos })
      window.location.href = '/dashboard'
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-purple-50 flex flex-col p-6 max-w-md mx-auto">
      <div className="flex items-center justify-between mb-6 pt-4">
        <button onClick={() => paso > 0 && setPaso(paso - 1)} className="w-10 h-10 bg-white rounded-full flex items-center justify-center shadow-sm text-gray-500">
          ‹
        </button>
        <span className="text-purple-600 font-semibold text-sm">¿Necesitas ayuda?</span>
      </div>

      <div className="flex items-center gap-4 mb-6">
        <div className="w-20 h-20 bg-gradient-to-br from-purple-100 to-purple-200 rounded-3xl flex items-center justify-center text-4xl flex-shrink-0">
          🤖
        </div>
        <div>
          <h1 className="text-2xl font-black text-gray-900">Crea tu cuenta</h1>
          <p className="text-gray-500 text-sm">Completa tus datos para personalizar<br/>tu experiencia al máximo.</p>
        </div>
      </div>

      <div className="bg-white rounded-2xl p-4 mb-6 shadow-sm">
        <div className="flex justify-between items-center mb-2">
          <span className="text-gray-700 font-semibold text-sm">Personalizando tu experiencia...</span>
          <span className="text-purple-600 font-bold text-sm">Paso {paso + 1} de {pasos.length}</span>
        </div>
        <div className="w-full bg-gray-100 rounded-full h-2">
          <div className="bg-gradient-to-r from-purple-600 to-blue-500 h-2 rounded-full transition-all duration-500" style={{ width: `${progreso}%` }} />
        </div>
      </div>

      <div className="bg-white rounded-3xl p-6 shadow-sm mb-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-purple-100 rounded-full flex items-center justify-center text-xl">
            {actual.icono}
          </div>
          <div>
            <h2 className="font-bold text-gray-900">{actual.label}</h2>
            <p className="text-gray-400 text-sm">{actual.sub}</p>
          </div>
        </div>

        {actual.tipo === 'select' ? (
          <select
            value={datos[actual.campo] || ''}
            onChange={e => setDatos({ ...datos, [actual.campo]: e.target.value })}
            className="w-full border-2 border-purple-200 rounded-2xl px-4 py-4 text-base focus:outline-none focus:border-purple-500 bg-purple-50"
          >
            <option value="">Selecciona...</option>
            {actual.opciones?.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        ) : (
          <input
            type="text"
            placeholder={actual.placeholder}
            value={datos[actual.campo] || ''}
            onChange={e => setDatos({ ...datos, [actual.campo]: e.target.value })}
            onKeyDown={e => e.key === 'Enter' && datos[actual.campo] && siguiente()}
            className="w-full border-2 border-purple-200 rounded-2xl px-4 py-4 text-base focus:outline-none focus:border-purple-500 bg-purple-50"
            autoFocus
          />
        )}

        <div className="mt-4 bg-purple-50 rounded-2xl p-3 flex items-center gap-3">
          <span className="text-purple-600 text-lg">🔒</span>
          <div>
            <p className="text-purple-700 font-semibold text-xs">Tu información está segura</p>
            <p className="text-purple-500 text-xs">No compartimos tus datos. Solo los usamos para mejorar tu experiencia.</p>
          </div>
        </div>
      </div>

      <button
        onClick={siguiente}
        disabled={!datos[actual.campo] || guardando}
        className="w-full bg-gradient-to-r from-purple-600 to-blue-500 text-white rounded-2xl py-4 text-base font-bold shadow-lg hover:opacity-90 transition disabled:opacity-40 flex items-center justify-center gap-2"
      >
        {paso < pasos.length - 1 ? `Continuar →` : guardando ? 'Guardando...' : 'Entrar a Docente IA ✨'}
      </button>

      <div className="flex justify-center gap-2 mt-6">
        {pasos.map((_, i) => (
          <div key={i} className={`w-2 h-2 rounded-full transition-all ${i === paso ? 'bg-purple-600 w-4' : 'bg-gray-300'}`} />
        ))}
      </div>

      <div className="flex justify-around mt-8 text-center">
        {[
          { icon: '🔒', titulo: '100% seguro', desc: 'Tus datos siempre protegidos' },
          { icon: '☁️', titulo: 'Sincronizado', desc: 'Accede desde todos tus dispositivos' },
          { icon: '⚡', titulo: 'Rápido y fácil', desc: 'Solo toma unos minutos' },
        ].map(b => (
          <div key={b.titulo} className="flex flex-col items-center gap-1">
            <span className="text-2xl">{b.icon}</span>
            <p className="text-xs font-bold text-gray-700">{b.titulo}</p>
            <p className="text-xs text-gray-400">{b.desc}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
