'use client'
import { useState } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

export default function Registro() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleRegistro = async () => {
    if (!email || !password) return
    if (password.length < 6) { setError('La contraseña debe tener al menos 6 caracteres'); return }
    setLoading(true)
    setError('')
    const { error } = await supabase.auth.signUp({ email, password })
    if (error) {
      setError('Error al crear cuenta. Intenta con otro correo.')
    } else {
      window.location.href = '/onboarding'
    }
    setLoading(false)
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-purple-50 flex flex-col items-center justify-center p-6 max-w-md mx-auto">
      <div className="w-16 h-16 bg-gradient-to-br from-purple-600 to-blue-500 rounded-3xl flex items-center justify-center text-3xl mb-4 shadow-lg">
        <img src="/logo.png" alt="Docente IA" className="w-full h-full object-contain" />
      </div>
      <h1 className="text-2xl font-black text-gray-900 mb-1">Crea tu cuenta</h1>
      <p className="text-gray-400 text-sm mb-8">Únete a Docente IA gratis</p>

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
          placeholder="Contraseña (mínimo 6 caracteres)"
          value={password}
          onChange={e => setPassword(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleRegistro()}
          className="w-full bg-white border border-gray-200 rounded-2xl px-4 py-4 text-base focus:outline-none focus:ring-2 focus:ring-purple-500 shadow-sm"
        />
        {error && <p className="text-red-500 text-sm text-center">{error}</p>}
        <button
          onClick={handleRegistro}
          disabled={loading || !email || !password}
          className="w-full bg-gradient-to-r from-purple-600 to-blue-500 text-white rounded-2xl py-4 text-base font-bold shadow-lg hover:opacity-90 transition disabled:opacity-40"
        >
          {loading ? 'Creando cuenta...' : '✨ Crear cuenta gratis'}
        </button>
        <button
          onClick={() => window.location.href = '/login'}
          className="w-full text-purple-600 font-semibold py-2 text-sm"
        >
          Ya tengo cuenta → Iniciar sesión
        </button>
        <button
          onClick={() => window.location.href = '/bienvenida'}
          className="w-full text-gray-400 text-sm"
        >
          ← Volver
        </button>
      </div>

      <p className="text-center text-xs text-gray-400 mt-6">🔒 Tus datos están seguros y encriptados</p>
    </div>
  )
}
