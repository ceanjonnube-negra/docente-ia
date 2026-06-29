'use client'
import { useState, useEffect, useRef } from 'react'
import { createClient } from '@supabase/supabase-js'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

const acciones = ['📄 Planeación', '📚 Actividad', '📊 Evaluación', '📋 Rúbrica', '📢 Comunicado', '🎓 Diploma']

export default function Chat() {
  const [perfil, setPerfil] = useState<any>(null)
  const [mensajes, setMensajes] = useState<{rol: string, texto: string}[]>([])
  const [input, setInput] = useState('')
  const [cargando, setCargando] = useState(false)
  const [estado, setEstado] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const cargar = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        const { data } = await supabase.from('perfiles_docentes').select('*').eq('id', user.id).single()
        setPerfil(data)
        const nombre = data?.nombre?.split(' ')[0] || 'Maestro'
        setMensajes([{ rol: 'ia', texto: `¡Hola ${nombre}! Soy tu asistente Docente IA. ¿Qué necesitas hoy?` }])
      }
    }
    cargar()
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [mensajes, cargando])

  const estados = ['Analizando...', 'Consultando documentos SEP...', 'Adaptando al grado...', 'Generando contenido...', 'Casi listo...']

  const enviar = async (texto?: string) => {
    const msg = texto || input
    if (!msg.trim() || cargando) return
    const nuevosMensajes = [...mensajes, { rol: 'usuario', texto: msg }]
    setMensajes(nuevosMensajes)
    setInput('')
    setCargando(true)

    let i = 0
    setEstado(estados[0])
    const intervalo = setInterval(() => {
      i = (i + 1) % estados.length
      setEstado(estados[i])
    }, 1500)

    const contexto = perfil ? `El maestro se llama ${perfil.nombre}, trabaja en ${perfil.escuela}, atiende ${perfil.grado}° grado grupo ${perfil.grupo}, en ${perfil.municipio}, ${perfil.estado}.` : ''

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mensaje: msg, contexto })
    })
    const data = await res.json()
    clearInterval(intervalo)
    setCargando(false)
    setEstado('')
    setMensajes([...nuevosMensajes, { rol: 'ia', texto: data.respuesta }])
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col max-w-md mx-auto">
      <header className="bg-white border-b border-gray-100 px-4 py-3 flex items-center gap-3 sticky top-0 z-10">
        <a href="/dashboard" className="w-8 h-8 bg-gray-100 rounded-full flex items-center justify-center text-gray-500 hover:bg-gray-200">‹</a>
        <div className="w-8 h-8 bg-gradient-to-br from-purple-600 to-blue-500 rounded-xl flex items-center justify-center text-sm">🤖</div>
        <div>
          <p className="font-bold text-gray-900 text-sm">Asistente Docente IA</p>
          <p className="text-xs text-green-500">● En línea</p>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {mensajes.map((m, i) => (
          <div key={i} className={`flex ${m.rol === 'usuario' ? 'justify-end' : 'justify-start'}`}>
            {m.rol === 'ia' && (
              <div className="w-7 h-7 bg-gradient-to-br from-purple-600 to-blue-500 rounded-full flex items-center justify-center text-xs mr-2 flex-shrink-0 mt-1">🤖</div>
            )}
            <div className={`rounded-2xl px-4 py-3 max-w-sm text-sm leading-relaxed ${m.rol === 'usuario' ? 'bg-gradient-to-r from-purple-600 to-blue-500 text-white rounded-br-sm' : 'bg-white text-gray-800 shadow-sm rounded-bl-sm'}`}>
              {m.rol === 'ia' ? (
                <div className="prose prose-sm max-w-none prose-headings:text-purple-800 prose-headings:font-bold prose-strong:text-gray-900 prose-table:text-xs prose-td:border prose-td:border-gray-200 prose-td:px-2 prose-td:py-1 prose-th:border prose-th:border-gray-200 prose-th:px-2 prose-th:py-1 prose-th:bg-purple-50">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.texto}</ReactMarkdown>
                </div>
              ) : m.texto}
            </div>
          </div>
        ))}
        {cargando && (
          <div className="flex justify-start items-center gap-2">
            <div className="w-7 h-7 bg-gradient-to-br from-purple-600 to-blue-500 rounded-full flex items-center justify-center text-xs">🤖</div>
            <div className="bg-white rounded-2xl rounded-bl-sm px-4 py-3 shadow-sm">
              <p className="text-xs text-purple-600 font-medium animate-pulse">{estado}</p>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="px-4 py-2 bg-white border-t border-gray-100">
        <div className="flex gap-2 overflow-x-auto pb-2">
          {acciones.map(a => (
            <button key={a} onClick={() => enviar(a.replace(/^[^\s]+\s/, ''))} className="flex-shrink-0 bg-purple-50 text-purple-700 text-xs font-semibold px-3 py-2 rounded-full hover:bg-purple-100 transition">
              {a}
            </button>
          ))}
        </div>
        <div className="flex gap-2 mt-2">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && enviar()}
            placeholder="Escribe lo que necesitas..."
            className="flex-1 bg-gray-100 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-purple-400"
          />
          <button onClick={() => enviar()} disabled={cargando} className="w-10 h-10 bg-gradient-to-r from-purple-600 to-blue-500 text-white rounded-full flex items-center justify-center hover:opacity-90 transition disabled:opacity-40">
            ↑
          </button>
        </div>
      </div>
    </div>
  )
}
