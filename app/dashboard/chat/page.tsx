'use client'

import { useState, useRef, useEffect } from 'react'
import { createClient } from '@supabase/supabase-js'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { generarWord } from '@/utils/generarWord'

interface Mensaje {
  rol: 'usuario' | 'ia'
  texto: string
}

const detectarTipo = (texto: string): string => {
  if (texto.includes('RÚBRICA')) return 'rubrica'
  if (texto.includes('CITATORIO')) return 'citatorio'
  if (texto.includes('PLANEACIÓN')) return 'planeacion'
  return 'documento'
}

const detectarTitulo = (texto: string): string => {
  const lineas = texto.split('\n').filter(l => l.trim())
  for (const linea of lineas) {
    const limpia = linea.replace(/[📋📊📨🎯📚🧰📅✍️]/g, '').trim()
    if (limpia.length > 5) return limpia.substring(0, 80)
  }
  return 'Documento generado'
}

const detectarCampoFormativo = (texto: string): string | null => {
  const match = texto.match(/Campo Formativo:\s*([^\n]+)/i)
  if (match) return match[1].trim()
  return null
}

export default function ChatPage() {
  const [mensajes, setMensajes] = useState<Mensaje[]>([])
  const [input, setInput] = useState('')
  const [cargando, setCargando] = useState(false)
  const [estado, setEstado] = useState('')
  const [perfil, setPerfil] = useState<any>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const [grabando, setGrabando] = useState(false)
  const [menuAbierto, setMenuAbierto] = useState(false)
  const [historial, setHistorial] = useState<any[]>([])
  const [cargandoHistorial, setCargandoHistorial] = useState(false)

  const cargarHistorial = async () => {
    setCargandoHistorial(true)
    const { data } = await supabase.from('documentos_generados').select('*').order('created_at', { ascending: false }).limit(30)
    if (data) setHistorial(data)
    setCargandoHistorial(false)
  }
  const recognitionRef = useRef<any>(null)
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)

  const toggleMicrofono = () => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SpeechRecognition) {
      alert("Tu navegador no soporta comando de voz")
      return
    }
    if (grabando) {
      recognitionRef.current?.stop()
      setGrabando(false)
      return
    }
    const recognition = new SpeechRecognition()
    recognition.lang = "es-MX"
    recognition.continuous = false
    recognition.interimResults = false
    recognition.onresult = (event: any) => {
      const texto = event.results[0][0].transcript
      setInput(prev => prev ? prev + " " + texto : texto)
    }
    recognition.onend = () => setGrabando(false)
    recognition.onerror = () => setGrabando(false)
    recognitionRef.current = recognition
    recognition.start()
    setGrabando(true)
  }

  useEffect(() => {
    const cargarPerfil = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const { data } = await supabase
        .from('perfiles_docentes')
        .select('*')
        .eq('id', user.id)
        .single()
      if (data) setPerfil(data)
    }
    cargarPerfil()
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [mensajes])

  const guardarEnHistorial = async (texto: string) => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    await supabase.from('documentos_generados').insert({
      user_id: user.id,
      tipo: detectarTipo(texto),
      titulo: detectarTitulo(texto),
      contenido: texto,
      campo_formativo: detectarCampoFormativo(texto) || perfil?.campo_formativo || null,
      grado: perfil?.grado || null,
      grupo: perfil?.grupo || null,
    })
  }

  const enviar = async () => {
    if (!input.trim() || cargando) return
    const nuevoMensaje: Mensaje = { rol: 'usuario', texto: input }
    const nuevos = [...mensajes, nuevoMensaje]
    setMensajes(nuevos)
    setInput('')
    setCargando(true)
    setEstado('Generando...')

    const contexto = perfil ? `
Nombre: ${perfil.nombre}
Escuela: ${perfil.escuela}
Grado: ${perfil.grado}
Grupo: ${perfil.grupo}
Municipio: ${perfil.municipio}
Estado: ${perfil.estado}` : ''

    try {
  const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mensaje: input, contexto: contexto })
    })

    const reader = res.body?.getReader()
    const decoder = new TextDecoder()
    let respuesta = ''

    setMensajes(prev => [...prev, { rol: 'ia', texto: '' }])

    if (reader) {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        respuesta += decoder.decode(value, { stream: true })
        setMensajes(prev => {
          const copia = [...prev]
          copia[copia.length - 1] = { rol: 'ia', texto: respuesta }
          return copia
        })
      }
    }

    await guardarEnHistorial(respuesta)
      setEstado('')
    } catch {
      setMensajes([...nuevos, { rol: 'ia', texto: 'Error al conectar con la IA.' }])
      setEstado('')
    } finally {
      setCargando(false)
    }
  }

  const copiar = (texto: string, i: number) => {
    navigator.clipboard.writeText(texto)
  }

  const descargarWord = async (texto: string) => {
    await generarWord(texto, perfil)
  }

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <header className="flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-100 shadow-sm">
        <button onClick={() => { setMenuAbierto(true); cargarHistorial() }} className="w-8 h-8 bg-gray-100 rounded-full flex items-center justify-center text-gray-500 hover:bg-gray-200">☰</button>
        <a href="/dashboard" className="w-8 h-8 bg-gray-100 rounded-full flex items-center justify-center text-gray-500 hover:bg-gray-200">←</a>
        <div className="w-8 h-8 bg-gradient-to-br from-purple-600 to-blue-500 rounded-xl flex items-center justify-center text-xs mr-2 flex-shrink-0 mt-1"><img src="/logo.png" alt="Docente IA" className="w-full h-full object-contain" /></div>
        <div>
          <p className="font-bold text-gray-900 text-sm">Asistente Docente IA</p>
          <p className="text-xs text-green-500">● En linea</p>
        </div>
      </header>

      <div
        onMouseEnter={() => setMenuAbierto(true)}
        onTouchStart={() => setMenuAbierto(true)}
        className="fixed left-0 top-0 h-full w-4 z-40"
      ></div>

      <div className={`fixed inset-0 z-50 flex transition-opacity duration-300 ${menuAbierto ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}>
          <div className={`w-72 bg-white h-full shadow-xl flex flex-col transition-transform duration-300 ease-out ${menuAbierto ? 'translate-x-0' : '-translate-x-full'}`}>
            <div className="p-4 border-b border-gray-100">
              <button onClick={() => { setMensajes([]); setMenuAbierto(false) }}
                className="w-full bg-green-600 text-white py-2.5 rounded-xl text-sm font-medium">
                + Nuevo chat
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-3 py-2">
              <p className="text-xs text-gray-400 font-medium px-2 py-2">Historial</p>
              {cargandoHistorial ? (
                <p className="text-xs text-gray-400 text-center mt-4">Cargando...</p>
              ) : historial.length === 0 ? (
                <p className="text-xs text-gray-400 text-center mt-4">Sin documentos aun</p>
              ) : (
                historial.map((doc) => (
                  <button key={doc.id}
                    onClick={() => { setMensajes([{ rol: 'ia', texto: doc.contenido }]); setMenuAbierto(false) }}
                    className="w-full text-left px-3 py-2.5 rounded-xl hover:bg-gray-50 text-sm text-gray-700 truncate block">
                    {doc.titulo}
                  </button>
                ))
              )}
            </div>
          </div>
          <div onClick={() => setMenuAbierto(false)} className="flex-1 bg-black/40"></div>
        </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {mensajes.map((m, i) => (
          <div key={i} className={`flex flex-col ${m.rol === 'usuario' ? 'items-end' : 'items-start'} w-full`}>
            {m.rol === 'ia' && (
              <div className="w-7 h-7 bg-gradient-to-br from-purple-600 to-blue-500 rounded-xl flex items-center justify-center text-xs mr-2 flex-shrink-0 mt-1"><img src="/logo.png" alt="Docente IA" className="w-full h-full object-contain" /></div>
            )}
            <div className={`rounded-2xl px-4 py-3 max-w-sm text-sm leading-relaxed ${m.rol === 'usuario' ? 'bg-gradient-to-r from-purple-600 to-blue-500 text-white rounded-br-sm' : 'bg-white text-gray-800 shadow-sm rounded-bl-sm'}`}>
              {m.rol === 'ia' ? (
                <div className="prose prose-sm max-w-none prose-headings:text-purple-800 prose-headings:font-bold prose-strong:text-gray-900">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.texto.replace(/\n/g, "  \n")}</ReactMarkdown>
                </div>
              ) : m.texto}
            </div>
            {m.rol === 'ia' && i > 0 && (
              <div className="flex gap-2 mt-2 ml-1">
                <button onClick={() => copiar(m.texto, i)} className="flex items-center gap-1 bg-white border border-gray-200 text-gray-600 text-xs px-3 py-1.5 rounded-full hover:bg-gray-50 shadow-sm">
                  📋 Copiar
                </button>
                <button onClick={() => descargarWord(m.texto)} className="flex items-center gap-1 bg-blue-600 text-white text-xs px-3 py-1.5 rounded-full hover:bg-blue-700 shadow-sm">
                  📄 Word
                </button>
              </div>
            )}
          </div>
        ))}
        {cargando && (
          <div className="flex justify-start">
            <div className="bg-white shadow-sm rounded-2xl rounded-bl-sm px-4 py-3">
              <p className="text-xs text-purple-600 font-medium animate-pulse">{estado}</p>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="px-4 py-3 bg-white border-t border-gray-100">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && enviar()}
            placeholder="¿Qué necesitas hoy, maestro?"
            className="flex-1 bg-gray-100 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-purple-400"
          />
          <button onClick={toggleMicrofono} className={`w-10 h-10 rounded-full flex items-center justify-center transition ${grabando ? "bg-red-500 text-white animate-pulse" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
          🎤
        </button>
        <button onClick={() => enviar()} disabled={cargando} className="w-10 h-10 bg-gradient-to-r from-purple-600 to-blue-500 text-white rounded-full flex items-center justify-center hover:opacity-90 transition disabled:opacity-40">
            ↑
          </button>
        </div>
      </div>
    </div>
  )
}
