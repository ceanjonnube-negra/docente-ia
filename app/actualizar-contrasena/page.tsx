'use client'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'

// app/actualizar-contrasena/page.tsx
//
// Destino del enlace de recuperación de contraseña (ver
// resetPasswordForEmail en app/login/page.tsx, redirectTo =
// `${window.location.origin}/actualizar-contrasena`). Nunca se llega
// aquí por navegación normal — solo desde ese correo.
//
// La sesión de recuperación la procesa supabase-js de forma ASÍNCRONA
// al leer el token de la URL (detectSessionInUrl) — el mismo tipo de
// carrera que ya se corrigió en Lista/Seguimiento (ver C-004). Por eso
// esta pantalla nunca hace un solo chequeo de sesión al montar: escucha
// el evento PASSWORD_RECOVERY de onAuthStateChange, y además revisa
// getSession() una vez por si el evento ya se disparó antes de que el
// listener alcanzara a suscribirse.
type Fase = 'verificando' | 'listo' | 'invalido' | 'exito'

const LONGITUD_MINIMA = 6
const TIEMPO_ESPERA_MS = 6000

export default function ActualizarContrasena() {
  const [fase, setFase] = useState<Fase>('verificando')

  const [password, setPassword] = useState('')
  const [confirmarPassword, setConfirmarPassword] = useState('')
  const [mostrarPassword, setMostrarPassword] = useState(false)
  const [mostrarConfirmar, setMostrarConfirmar] = useState(false)

  const [enviando, setEnviando] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let resuelto = false

    const marcarListo = () => {
      if (resuelto) return
      resuelto = true
      setFase('listo')
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange((evento) => {
      if (evento === 'PASSWORD_RECOVERY') marcarListo()
    })

    // Respaldo: si el evento ya se disparó antes de que este listener
    // alcanzara a suscribirse, la sesión de recuperación ya existe.
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) marcarListo()
    })

    const timeout = setTimeout(() => {
      if (!resuelto) {
        resuelto = true
        setFase('invalido')
      }
    }, TIEMPO_ESPERA_MS)

    return () => {
      subscription.unsubscribe()
      clearTimeout(timeout)
    }
  }, [])

  const handleActualizar = async () => {
    setError('')

    if (password.length < LONGITUD_MINIMA) {
      setError(`La contraseña debe tener al menos ${LONGITUD_MINIMA} caracteres.`)
      return
    }
    if (password !== confirmarPassword) {
      setError('Las contraseñas no coinciden.')
      return
    }

    setEnviando(true)
    const { error: errorUpdate } = await supabase.auth.updateUser({ password })
    setEnviando(false)

    if (errorUpdate) {
      setError(errorUpdate.message)
      return
    }

    setFase('exito')
    setTimeout(() => { window.location.href = '/login' }, 2500)
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-purple-50 flex flex-col items-center justify-center p-6 max-w-md mx-auto">
      <div className="w-16 h-16 bg-gradient-to-br from-purple-600 to-blue-500 rounded-3xl flex items-center justify-center text-3xl mb-4 shadow-lg">
        <img src="/logo.png" alt="Docente IA" className="w-full h-full object-contain" />
      </div>

      {fase === 'verificando' && (
        <>
          <h1 className="text-2xl font-black text-gray-900 mb-1">Verificando enlace</h1>
          <p className="text-gray-400 text-sm text-center">Un momento, estamos confirmando tu enlace de recuperación...</p>
        </>
      )}

      {fase === 'invalido' && (
        <>
          <h1 className="text-2xl font-black text-gray-900 mb-1">Enlace no válido</h1>
          <p className="text-gray-500 text-sm text-center mb-8">Este enlace ya expiró o no es válido. Solicita uno nuevo desde la pantalla de inicio de sesión.</p>
          <button
            onClick={() => window.location.href = '/login'}
            className="w-full bg-gradient-to-r from-purple-600 to-blue-500 text-white rounded-2xl py-4 text-base font-bold shadow-lg hover:opacity-90 transition"
          >
            Ir a iniciar sesión
          </button>
        </>
      )}

      {fase === 'exito' && (
        <>
          <h1 className="text-2xl font-black text-gray-900 mb-1">Contraseña actualizada</h1>
          <p className="text-gray-500 text-sm text-center">Ya puedes iniciar sesión con tu nueva contraseña. Te llevamos a la pantalla de inicio de sesión...</p>
        </>
      )}

      {fase === 'listo' && (
        <>
          <h1 className="text-2xl font-black text-gray-900 mb-1">Nueva contraseña</h1>
          <p className="text-gray-400 text-sm mb-8 text-center">Escribe y confirma tu nueva contraseña.</p>

          <div className="w-full space-y-4">
            <div className="relative">
              <input
                type={mostrarPassword ? 'text' : 'password'}
                placeholder="Nueva contraseña"
                autoComplete="new-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
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

            <div className="relative">
              <input
                type={mostrarConfirmar ? 'text' : 'password'}
                placeholder="Confirmar contraseña"
                autoComplete="new-password"
                value={confirmarPassword}
                onChange={e => setConfirmarPassword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleActualizar()}
                className="w-full bg-white border border-gray-200 rounded-2xl px-4 py-4 pr-12 text-base focus:outline-none focus:ring-2 focus:ring-purple-500 shadow-sm"
              />
              <button
                type="button"
                onClick={() => setMostrarConfirmar(v => !v)}
                aria-label={mostrarConfirmar ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                className="absolute right-4 top-1/2 -translate-y-1/2 text-lg"
              >
                {mostrarConfirmar ? '🙈' : '👁️'}
              </button>
            </div>

            {error && <p className="text-red-500 text-sm text-center">{error}</p>}

            <button
              onClick={handleActualizar}
              disabled={enviando}
              className="w-full bg-gradient-to-r from-purple-600 to-blue-500 text-white rounded-2xl py-4 text-base font-bold shadow-lg hover:opacity-90 transition disabled:opacity-60"
            >
              {enviando ? 'Guardando...' : 'Guardar nueva contraseña'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
