'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { generarWord } from '@/utils/generarWord'
import { formatearFecha, obtenerZonaHorariaDispositivo } from '@/lib/tiempo/TimeService'
import { useAsistente } from '@/lib/asistente/hooks'


const iconos: Record<string, string> = {
  planeacion: '📋',
  rubrica: '📊',
  citatorio: '📨',
  documento: '📄'
}

export default function HistorialPage() {
  // Historial es un módulo independiente — nunca debe mostrarse con el
  // Chat IA abierto encima, sin importar cómo se llegó aquí (ver
  // ARQUITECTURA DE NAVEGACIÓN DEL CHAT IA). cerrarPanel() solo afecta
  // la visibilidad del panel, nunca la conversación guardada.
  const asistente = useAsistente()
  useEffect(() => {
    asistente.cerrarPanel()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [documentos, setDocumentos] = useState<any[]>([])
  const [cargando, setCargando] = useState(true)
  const [filtro, setFiltro] = useState('todos')
  const [seleccionado, setSeleccionado] = useState<any>(null)

  const eliminarDocumento = async (id: string) => {
    if (!confirm('¿Eliminar este documento? Esta acción no se puede deshacer.')) return
    await supabase.from('documentos_generados').delete().eq('id', id)
    setDocumentos((prev: any[]) => prev.filter((d: any) => d.id !== id))
    setSeleccionado(null)
  }

  useEffect(() => {
    const cargar = async () => {
      const { data } = await supabase
        .from('documentos_generados')
        .select('*')
        .order('created_at', { ascending: false })
      if (data) setDocumentos(data)
      setCargando(false)
    }
    cargar()
  }, [])

  const filtrados = filtro === 'todos'
    ? documentos
    : documentos.filter(d => d.tipo === filtro)

  const formatFecha = (fecha: string) => formatearFecha(fecha, obtenerZonaHorariaDispositivo(), { day: '2-digit', month: 'short', year: 'numeric' })

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <header className="flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-100 shadow-sm">
        <a href="/dashboard" className="w-8 h-8 bg-gray-100 rounded-full flex items-center justify-center text-gray-500">←</a>
        <div>
          <p className="font-bold text-gray-900 text-sm">Historial de Documentos</p>
          <p className="text-xs text-gray-400">{documentos.length} documentos generados</p>
        </div>
      </header>

      <div className="flex gap-2 px-4 py-3 overflow-x-auto">
        {['todos', 'planeacion', 'rubrica', 'citatorio'].map(f => (
          <button key={f} onClick={() => setFiltro(f)}
            className={`px-3 py-1.5 rounded-full text-xs whitespace-nowrap font-medium transition ${filtro === f ? 'bg-purple-600 text-white' : 'bg-white text-gray-600 border border-gray-200'}`}>
            {f === 'todos' ? '📁 Todos' : f === 'planeacion' ? '📋 Planeaciones' : f === 'rubrica' ? '📊 Rubricas' : '📨 Citatorios'}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-2">
        {cargando ? (
          <p className="text-center text-gray-400 text-sm mt-8">Cargando...</p>
        ) : filtrados.length === 0 ? (
          <p className="text-center text-gray-400 text-sm mt-8">No hay documentos aun</p>
        ) : (
          filtrados.map(doc => (
            <div key={doc.id} onClick={() => setSeleccionado(doc)}
              className="bg-white rounded-2xl px-4 py-3 shadow-sm border border-gray-100 cursor-pointer active:scale-95 transition">
              <div className="flex items-start gap-3">
                <span className="text-2xl">{iconos[doc.tipo] || '📄'}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-800 truncate">{doc.titulo}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{formatFecha(doc.created_at)}</p>
                  <div className="flex gap-2 mt-1">
                    {doc.grado && <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full">{doc.grado}</span>}
                    {doc.tipo && <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full capitalize">{doc.tipo}</span>}
                  </div>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {seleccionado && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end">
          <div className="bg-white w-full rounded-t-3xl p-5 max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between mb-3">
              <p className="font-bold text-gray-900 text-sm">{seleccionado.titulo}</p>
              <button onClick={() => setSeleccionado(null)} className="text-gray-400 text-lg">X</button>
            </div>
            <p className="text-xs text-gray-400 mb-3">{formatFecha(seleccionado.created_at)}</p>
            <div className="flex-1 overflow-y-auto text-sm text-gray-700 whitespace-pre-wrap bg-gray-50 rounded-xl p-3 mb-4">
              {seleccionado.contenido}
            </div>
            <button onClick={() => generarWord(seleccionado.contenido, null)}
              className="w-full bg-purple-600 text-white py-3 rounded-2xl text-sm font-medium">
              Descargar Word
            </button>
          <button onClick={() => eliminarDocumento(seleccionado.id)}
            className="w-full bg-red-50 text-red-600 py-3 rounded-2xl text-sm font-medium mt-2">
            Eliminar documento
          </button>
          </div>
        </div>
      )}
    </div>
  )
}
