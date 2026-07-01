'use client'
import { useRouter } from 'next/navigation'

export default function Bienvenida() {
  const router = useRouter()

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-purple-50 flex flex-col items-center justify-between p-6 max-w-md mx-auto">
      <div className="w-full flex flex-col items-center pt-8">
        <div className="w-20 h-20 bg-gradient-to-br from-purple-600 to-blue-500 rounded-3xl flex items-center justify-center text-4xl mb-4 shadow-lg">
          <img src="/logo.png" alt="Docente IA" className="w-full h-full object-contain" />
        </div>
        <h1 className="text-4xl font-black text-gray-900 mb-1">
          Docente <span className="text-purple-600">IA</span>
        </h1>
        <p className="text-gray-500 text-center text-base mt-2 leading-relaxed">
          Tu asistente inteligente para planificar,<br />
          crear y <span className="text-purple-600 font-semibold">transformar</span> tu enseñanza.
        </p>
      </div>

      <div className="w-full space-y-3 my-6">
        {[
          { icon: '⚡', color: 'bg-purple-600', titulo: 'Ahorra tiempo', desc: 'Automatiza tareas y reduce horas de trabajo.' },
          { icon: '🧠', color: 'bg-green-500', titulo: 'Inteligencia real', desc: 'IA entrenada con programas oficiales y recursos docentes.' },
          { icon: '✅', color: 'bg-orange-400', titulo: 'Todo en un solo lugar', desc: 'Planeaciones, evaluaciones, reportes y mucho más.' },
        ].map(b => (
          <div key={b.titulo} className="flex items-center gap-4 bg-white rounded-2xl p-4 shadow-sm">
            <div className={`${b.color} w-12 h-12 rounded-2xl flex items-center justify-center text-xl flex-shrink-0 text-white`}>
              {b.icon}
            </div>
            <div className="flex-1">
              <p className="font-bold text-gray-900 text-sm">{b.titulo}</p>
              <p className="text-gray-500 text-xs">{b.desc}</p>
            </div>
            <span className="text-gray-300 text-xl">›</span>
          </div>
        ))}
      </div>

      <div className="w-full space-y-3 pb-4">
        <button
          onClick={() => router.push('/registro')}
          className="w-full bg-gradient-to-r from-purple-600 to-blue-500 text-white rounded-2xl py-4 text-lg font-bold shadow-lg hover:opacity-90 transition flex items-center justify-center gap-2"
        >
          ✨ Comenzar ahora →
        </button>
        <button
          onClick={() => router.push('/login')}
          className="w-full text-purple-600 font-semibold py-2 text-base"
        >
          Ya tengo cuenta
        </button>
        <p className="text-center text-xs text-gray-400">🔒 Seguro, confiable y diseñado para docentes como tú.</p>
      </div>
    </div>
  )
}
