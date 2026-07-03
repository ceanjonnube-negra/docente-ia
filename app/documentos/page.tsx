'use client'

import { useState, useRef } from 'react'

export default function DocumentosPage() {
  const [archivo, setArchivo] = useState<File | null>(null)
  const [categoria, setCategoria] = useState('Normatividad')
  const [descripcion, setDescripcion] = useState('')
  const [subiendo, setSubiendo] = useState(false)
  const [resultado, setResultado] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const categorias = [
    'SEP', 'Planes y Programas', 'Libros de Texto', 'Evaluacion',
    'Planeacion', 'Consejos Tecnicos', 'Normatividad', 'Acuerdos',
    'Reglamentos', 'Protocolos', 'Formatos Oficiales', 'Calendario Escolar',
    'Educacion Especial', 'Inclusion', 'Inteligencia Artificial',
    'Capacitacion Docente', 'Material Complementario', 'Personalizadas'
  ]

  const handleSubir = async () => {
    if (!archivo) return
    setSubiendo(true)
    setResultado(null)
    setError(null)

    const formData = new FormData()
    formData.append('file', archivo)
    formData.append('categoria', categoria)
    formData.append('descripcion', descripcion)

    try {
      const res = await fetch('/api/upload-documento', {
        method: 'POST',
        body: formData,
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error || 'Ocurrio un error al subir el documento')
      } else {
        setResultado(`Documento subido correctamente. Se generaron ${data.chunks_creados} fragmentos de conocimiento.`)
        setArchivo(null)
        setDescripcion('')
        if (inputRef.current) inputRef.current.value = ''
      }
    } catch (e) {
      setError('No se pudo conectar con el servidor')
    } finally {
      setSubiendo(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center px-4 py-6" style={{ backgroundColor: '#8BC34A' }}>
      <div className="w-full max-w-sm mb-4">
        <h1 className="text-white text-xl font-bold">Documentos Institucionales</h1>
        <p className="text-white/80 text-sm mt-1">
          Administra el conocimiento oficial utilizado por la Inteligencia Artificial.
        </p>
      </div>

      <div className="w-full max-w-sm bg-white/90 rounded-3xl p-4 mb-6 shadow-lg">
        <p className="text-sm font-semibold text-gray-800 mb-3">Subir documento</p>

        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.doc,.docx,.txt"
          onChange={(e) => setArchivo(e.target.files?.[0] || null)}
          className="w-full text-sm text-gray-600 mb-3 file:mr-3 file:py-2 file:px-4 file:rounded-full file:border-0 file:bg-green-600 file:text-white file:text-sm"
        />

        <label className="text-xs text-gray-500 font-semibold">Categoria</label>
        <select
          value={categoria}
          onChange={(e) => setCategoria(e.target.value)}
          className="w-full mt-1 mb-3 p-2 rounded-xl border border-gray-200 text-sm text-gray-700"
        >
          {categorias.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>

        <label className="text-xs text-gray-500 font-semibold">Descripcion (opcional)</label>
        <textarea
          value={descripcion}
          onChange={(e) => setDescripcion(e.target.value)}
          placeholder="Ej. Reglamento escolar 2026"
          className="w-full mt-1 mb-4 p-2 rounded-xl border border-gray-200 text-sm text-gray-700 resize-none"
          rows={2}
        />

        <button
          onClick={handleSubir}
          disabled={!archivo || subiendo}
          className="w-full bg-green-600 disabled:bg-gray-300 text-white font-semibold py-3 rounded-full text-sm"
        >
          {subiendo ? 'Subiendo y procesando...' : 'Subir documento'}
        </button>

        {resultado && (
          <p className="text-green-700 text-sm mt-3 text-center">{resultado}</p>
        )}
        {error && (
          <p className="text-red-600 text-sm mt-3 text-center">{error}</p>
        )}
      </div>
    </div>
  )
}
