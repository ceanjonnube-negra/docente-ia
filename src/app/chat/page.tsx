'use client'

import { useState, useRef, useEffect } from 'react'
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'
import { generarWord } from '@/utils/generarWord'

interface Mensaje {
  rol: 'user' | 'assistant'
  contenido: string
}

export default function ChatPage() {
  const [mensajes, setMensajes] = useState<Mensaje[]>([])
  const [input, setInput] = useState('')
  const [cargando, setCargando] = useState(false)
  const [perfil, setPerfil] = useState<any>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const supabase = createClientComponentClient()

  useEffect(() => {
    const cargarPerfil = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        const { data } = await supabase
          .from('perfiles_docentes')
          .select('*')
          .eq('user_id', user.id)
          .single()
        if (data) setPerfil(data)
      }
    }
    cargarPerfil()
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [mensajes])

  const enviar = async () => {
    if (!input.trim()) return
    const nuevoMensaje: Mensaje = { rol: 'user', contenido: input }
    const nuevos = [...mensajes, nuevoMensaje]
    setMensajes(nuevos)
    setInput('')
    setCargando(true)

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mensaje: input, perfil })
      })
      const data = await res.json()
      setMensajes([...nuevos, { rol: 'assistant', contenido: data.respuesta }])
    } catch {
      setMensajes([...nuevos, { rol: 'assistant', contenido: 'Error al conectar con la IA.' }])
    } finally {
      setCargando(false)
    }
  }

  const descargarWord = async () => {
    const ultimo = [...mensajes].reverse().find(m => m.rol === 'assistant')
    if (ultimo) await generarWord(ultimo.contenido, perfil)
  }

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <div className="bg-white border-b px-4 py-3 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-purple-700">Chat IA Docente</h1>
        <button
          onClick={descargarWord}
          className="text-sm bg-purple-600 text-white px-3 py-1 rounded-lg"
        >
          ⬇ Word
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {mensajes.map((m, i) => (
          <div key={i} className={`flex ${m.rol === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[80%] px-4 py-2 rounded-2xl text-sm whitespace-pre-wrap ${
              m.rol === 'user'
                ? 'bg-purple-600 text-white'
                : 'bg-white border text-gray-800'
            }`}>
              {m.contenido}
            </div>
          </div>
        ))}
        {cargando && (
          <div className="flex justify-start">
            <div className="bg-white border px-4 py-2 rounded-2xl text-sm text-gray-400">Escribiendo...</div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="bg-white border-t px-4 py-3 flex gap-2">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && enviar()}
          placeholder="Escribe tu solicitud..."
          className="flex-1 border rounded-xl px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-400"
        />
        <button
          onClick={enviar}
          className="bg-purple-600 text-white px-4 py-2 rounded-xl text-sm"
        >
          Enviar
        </button>
      </div>
    </div>
  )
}
