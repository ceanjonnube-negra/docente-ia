'use client'
import { useState } from 'react'
import { supabase } from '@/lib/supabaseClient'

export default function Login() {
  // 'login' es la pantalla normal; 'recuperar' reutiliza el mismo layout
  // y el mismo campo de correo, sin ser una ruta aparte — así el enlace
  // "¿Olvidaste tu contraseña?" no obliga a navegar a otra pantalla para
  // algo tan simple como pedir un correo.
  const [modo, setModo] = useState<'login' | 'recuperar'>('login')

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mostrarPassword, setMostrarPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [enviandoRecuperacion, setEnviandoRecuperacion] = useState(false)
  const [mensajeRecuperacion, setMensajeRecuperacion] = useState('')

  const handleLogin = async () => {
    setLoading(true)
    setError('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      setError('Correo o contraseña incorrectos.')
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

  // El origen se lee en el momento del clic (window.location.origin) —
  // nunca un dominio fijo — para que el enlace del correo apunte siempre
  // a donde realmente se está usando la app: Mac, iPhone en la red local
  // o producción. Requiere que esas 3 formas de origen estén permitidas
  // en Supabase → Authentication → URL Configuration → Redirect URLs.
  const handleRecuperar = async () => {
    if (!email.trim()) {
      setMensajeRecuperacion('Escribe tu correo para poder enviarte el enlace.')
      return
    }
    setEnviandoRecuperacion(true)
    setMensajeRecuperacion('')
    // Nunca se distingue en el mensaje si el correo existe o no en el
    // sistema — evita revelar qué cuentas están registradas.
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/actualizar-contrasena`,
    })
    setMensajeRecuperacion('Si ese correo tiene una cuenta, te enviamos un enlace para crear una contraseña nueva. Revisa tu bandeja de entrada.')
    setEnviandoRecuperacion(false)
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-purple-50 flex flex-col items-center justify-center p-6 max-w-md mx-auto">
      <div className="w-16 h-16 bg-gradient-to-br from-purple-600 to-blue-500 rounded-3xl flex items-center justify-center text-3xl mb-4 shadow-lg">
        <img src="/logo.png" alt="Docente IA" className="w-full h-full object-contain" />
      </div>

      {modo === 'login' ? (
        <>
          <h1 className="text-2xl font-black text-gray-900 mb-1">Bienvenido de vuelta</h1>
          <p className="text-gray-400 text-sm mb-8">Inicia sesión en Docente IA</p>

          <div className="w-full space-y-4">
            <input
              type="email"
              placeholder="Correo electrónico"
              autoComplete="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full bg-white border border-gray-200 rounded-2xl px-4 py-4 text-base focus:outline-none focus:ring-2 focus:ring-purple-500 shadow-sm"
            />
            <div className="relative">
              <input
                type={mostrarPassword ? 'text' : 'password'}
                placeholder="Contraseña"
                autoComplete="current-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleLogin()}
                className="w-full bg-white border border-gray-200 rounded-2xl px-4 py-4 pr-12 text-base focus:outline-none focus:ring-2 focus:ring-purple-500 shadow-sm"
              />
              <button
                type="button"
                onClick={() => setMostrarPassword(v => !v)}
                aria-label={mostrarPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                className="absolute right-4 top-1/2 -translate-y-1/2 text-lg"
              >
                {mostrarPassword ? '🙈' : '👁️'}
              </button>
            </div>

            <div className="text-right">
              <button
                type="button"
                onClick={() => { setModo('recuperar'); setError(''); setMensajeRecuperacion('') }}
                className="text-xs font-semibold text-purple-600"
              >
                ¿Olvidaste tu contraseña?
              </button>
            </div>

            {error && <p className="text-red-500 text-sm text-center">{error}</p>}
            <button
              onClick={handleLogin}
              disabled={loading}
              className="w-full bg-gradient-to-r from-purple-600 to-blue-500 text-white rounded-2xl py-4 text-base font-bold shadow-lg hover:opacity-90 transition disabled:opacity-60"
            >
              {loading ? 'Entrando...' : 'Iniciar sesión'}
            </button>
            <button
              onClick={() => window.location.href = '/bienvenida'}
              className="w-full text-purple-600 font-semibold py-2 text-sm"
            >
              ← Volver
            </button>
          </div>
        </>
      ) : (
        <>
          <h1 className="text-2xl font-black text-gray-900 mb-1">Recuperar contraseña</h1>
          <p className="text-gray-400 text-sm mb-8 text-center">Escribe tu correo y te enviaremos un enlace para crear una contraseña nueva.</p>

          <div className="w-full space-y-4">
            <input
              type="email"
              placeholder="Correo electrónico"
              autoComplete="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleRecuperar()}
              className="w-full bg-white border border-gray-200 rounded-2xl px-4 py-4 text-base focus:outline-none focus:ring-2 focus:ring-purple-500 shadow-sm"
            />

            {mensajeRecuperacion && (
              <p className="text-sm text-center text-gray-600">{mensajeRecuperacion}</p>
            )}

            <button
              onClick={handleRecuperar}
              disabled={enviandoRecuperacion}
              className="w-full bg-gradient-to-r from-purple-600 to-blue-500 text-white rounded-2xl py-4 text-base font-bold shadow-lg hover:opacity-90 transition disabled:opacity-60"
            >
              {enviandoRecuperacion ? 'Enviando...' : 'Enviar enlace de recuperación'}
            </button>
            <button
              type="button"
              onClick={() => { setModo('login'); setMensajeRecuperacion('') }}
              className="w-full text-purple-600 font-semibold py-2 text-sm"
            >
              ← Volver a iniciar sesión
            </button>
          </div>
        </>
      )}
    </div>
  )
}
