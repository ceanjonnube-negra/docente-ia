'use client'
import { useState } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleLogin = async () => {
    setLoading(true)
    setError('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      setError('Correo o contraseña incorrectos')
    } else {
      const { data: perfil } = await supabase.from('perfiles_docentes').select('id').single()
      if (perfil) {
        window.location.href = '/dashboard'
      } else {
        window.location.href = '/onboarding'
      }
    }
    setLoading(false)
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-purple-50 flex flex-col items-center justify-center p-6 max-w-md mx-auto">
      <div className="w-16 h-16 bg-gradient-to-br from-purple-600 to-blue-500 rounded-3xl flex items-center justify-center text-3xl mb-4 shadow-lg">
        <img src="/logo.png" alt="Docente IA" className="w-full h-full object-contain" />
      </div>
      <h1 className="text-2xl font-black text-gray-900 mb-1">Bienvenido de vuelta</h1>
      <p className="text-gray-400 text-sm mb-8">Inicia sesión en Docente IA</p>

      <div className="w-full space-y-4">
        <input
          type="email"
          placeholder="Correo electrónico"
          value={email}
          onChange={e => setEmail(e.target.value)}
          className="w-full bg-white border border-gray-200 rounded-2xl px-4 py-4 text-base focus:outline-none focus:ring-2 focus:ring-purple-500 shadow-sm"
        />
        <input
          type="password"
          placeholder="Contraseña"
          value={password}
          onChange={e => setPassword(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleLogin()}
          className="w-full bg-white border border-gray-200 rounded-2xl px-4 py-4 text-base focus:outline-none focus:ring-2 focus:ring-purple-500 shadow-sm"
        />
        {error && <p className="text-red-500 text-sm text-center">{error}</p>}
        <button
          onClick={handleLogin}
          disabled={loading}
          className="w-full bg-gradient-to-r from-purple-600 to-blue-500 text-white rounded-2xl py-4 text-base font-bold shadow-lg hover:opacity-90 transition"
        >
          {loading ? 'Entrando...' : 'Iniciar sesión'}
        </button>
        <button
          onClick={() => window.location.href = '/'}
          className="w-full text-purple-600 font-semibold py-2 text-sm"
        >
          ← Volver
        </button>
      </div>
    </div>
  )
}
