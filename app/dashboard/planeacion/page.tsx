'use client'
import { useEffect } from 'react'
import { useAsistente } from '@/lib/asistente/hooks'

export default function PlaneacionPage() {
  // Planeación es un módulo independiente — nunca debe mostrarse con el
  // Chat IA abierto encima, sin importar cómo se llegó aquí (ver
  // ARQUITECTURA DE NAVEGACIÓN DEL CHAT IA). cerrarPanel() solo afecta
  // la visibilidad del panel, nunca la conversación guardada.
  const asistente = useAsistente()
  useEffect(() => {
    asistente.cerrarPanel()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <header className="flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-100 shadow-sm">
        <a href="/dashboard/inicio" className="w-8 h-8 bg-gray-100 rounded-full flex items-center justify-center text-gray-500 hover:bg-gray-200">‹</a>
        <div className="w-8 h-8 bg-gradient-to-br from-amber-400 to-amber-600 rounded-xl flex items-center justify-center text-xs">📋</div>
        <div>
          <p className="font-bold text-gray-900 text-sm">Planeación</p>
          <p className="text-xs text-gray-400">Próximamente</p>
        </div>
      </header>

      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
        <div className="w-16 h-16 bg-amber-50 rounded-2xl flex items-center justify-center text-3xl mb-4">📋</div>
        <h2 className="text-lg font-bold text-gray-900 mb-2">Planeación</h2>
        <p className="text-sm text-gray-500 max-w-xs">Aquí podrás generar y organizar tus planeaciones didácticas semanales, alineadas a la Nueva Escuela Mexicana.</p>
      </div>
    </div>
  )
}
