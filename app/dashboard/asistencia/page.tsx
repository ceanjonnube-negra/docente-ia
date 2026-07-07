export default function AsistenciaPage() {{
  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <header className="flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-100 shadow-sm">
        <a href="/dashboard" className="w-8 h-8 bg-gray-100 rounded-full flex items-center justify-center text-gray-500 hover:bg-gray-200">‹</a>
        <div className="w-8 h-8 bg-gradient-to-br from-rose-400 to-rose-600 rounded-xl flex items-center justify-center text-xs">✅</div>
        <div>
          <p className="font-bold text-gray-900 text-sm">Asistencia</p>
          <p className="text-xs text-gray-400">Próximamente</p>
        </div>
      </header>

      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
        <div className="w-16 h-16 bg-rose-50 rounded-2xl flex items-center justify-center text-3xl mb-4">✅</div>
        <h2 className="text-lg font-bold text-gray-900 mb-2">Asistencia</h2>
        <p className="text-sm text-gray-500 max-w-xs">Aquí podrás pasar lista y llevar el control de asistencia de tus grupos de forma automática.</p>
      </div>
    </div>
  )
}}
