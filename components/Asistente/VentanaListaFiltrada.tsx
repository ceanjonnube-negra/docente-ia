'use client'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { obtenerRosterConPosicion, type AlumnoConPosicion } from '@/lib/rosterGrupo'
import { filtrarAlumnosPorCriterio, cargarEstadosAsistenciaHoy, type FiltroLista } from '@/lib/listaFiltrada'
import { fechaISOHoy, obtenerZonaHorariaDispositivo } from '@/lib/tiempo/TimeService'
import type { EstadoAsistenciaOficial } from '@/lib/motorContexto'

// Sheet contextual sobre el Chat IA — ver "ventana contextual de
// Lista filtrada desde el Chat IA". NO es otra Lista: es una vista
// temporal y de solo lectura de los mismos datos, reutilizando
// obtenerRosterConPosicion + filtrarAlumnosPorCriterio +
// cargarEstadosAsistenciaHoy (misma fuente de verdad que Lista
// completa, ver lib/listaFiltrada.ts). Nunca navega, nunca toca
// router.push/replace, nunca modifica el estado del Chat — al
// cerrarse, el chat de abajo queda exactamente como estaba.

const TITULO_POR_FILTRO: Record<FiltroLista, string> = {
  todos: 'Alumnos',
  ninas: 'Niñas',
  ninos: 'Niños',
  presentes: 'Presentes',
  ausentes: 'Ausentes',
}

// Solo presentes/ausentes necesitan consulta de asistencia — todos/
// ninas/ninos se resuelven únicamente con el roster (ver "Latencia"
// en la auditoría previa).
function requiereEstadosAsistencia(filtro: FiltroLista): boolean {
  return filtro === 'presentes' || filtro === 'ausentes'
}

type Props = {
  grupoId: string
  filtro: FiltroLista
  onClose: () => void
}

export default function VentanaListaFiltrada({ grupoId, filtro, onClose }: Props) {
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [alumnosFiltrados, setAlumnosFiltrados] = useState<AlumnoConPosicion[]>([])
  const [estados, setEstados] = useState<Record<string, EstadoAsistenciaOficial>>({})

  useEffect(() => {
    let cancelado = false

    async function cargar() {
      setCargando(true)
      setError(null)
      try {
        const { data: roster, error: errorRoster } = await obtenerRosterConPosicion(supabase, grupoId)
        if (errorRoster) throw errorRoster
        if (cancelado) return

        let estadosHoy: Record<string, EstadoAsistenciaOficial> = {}
        if (requiereEstadosAsistencia(filtro)) {
          const hoy = fechaISOHoy(obtenerZonaHorariaDispositivo())
          estadosHoy = await cargarEstadosAsistenciaHoy(supabase, grupoId, roster.map(a => a.id), hoy)
          if (cancelado) return
        }

        setEstados(estadosHoy)
        setAlumnosFiltrados(filtrarAlumnosPorCriterio(roster, estadosHoy, filtro))
      } catch {
        // Nunca inventar alumnos si la consulta falla — ver "no
        // inventar alumnos si una consulta falla".
        if (!cancelado) setError('No se pudo cargar la lista en este momento.')
      } finally {
        if (!cancelado) setCargando(false)
      }
    }

    cargar()
    return () => { cancelado = true }
  }, [grupoId, filtro])

  const ETIQUETA_ESTADO: Record<EstadoAsistenciaOficial, string> = {
    presente: 'Presente',
    falta: 'Ausente',
    retardo: 'Retardo',
    sin_registrar: 'Sin registrar',
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-[60] p-0 sm:p-4" onClick={onClose}>
      <div
        onClick={e => e.stopPropagation()}
        className="bg-white rounded-t-3xl sm:rounded-3xl w-full max-w-sm shadow-2xl animate-[slideUp_0.32s_cubic-bezier(0.32,0.72,0,1)] max-h-[80vh] flex flex-col"
      >
        <div className="w-10 h-1 bg-gray-200 rounded-full mx-auto mt-3 mb-1 sm:hidden flex-shrink-0" />

        <div className="flex items-center justify-between px-5 pt-3 pb-3 border-b border-gray-100 flex-shrink-0">
          <div>
            <h3 className="font-bold text-gray-900 text-base">{TITULO_POR_FILTRO[filtro]}</h3>
            {!cargando && !error && (
              <p className="text-xs text-gray-400 mt-0.5">{TITULO_POR_FILTRO[filtro]} · {alumnosFiltrados.length}</p>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            className="w-8 h-8 flex items-center justify-center rounded-full bg-gray-100 text-gray-500 text-lg flex-shrink-0"
          >
            ✕
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {cargando && (
            <p className="text-sm text-gray-400 text-center py-8">Cargando…</p>
          )}

          {!cargando && error && (
            <div className="text-center py-8">
              <p className="text-sm text-gray-500 mb-4">{error}</p>
              <button onClick={onClose} className="px-4 py-2 rounded-full bg-gray-900 text-white text-sm font-semibold">
                Cerrar
              </button>
            </div>
          )}

          {!cargando && !error && alumnosFiltrados.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-8">No hay alumnos para mostrar.</p>
          )}

          {!cargando && !error && alumnosFiltrados.length > 0 && (
            <div className="space-y-1.5">
              {alumnosFiltrados.map(a => (
                <div key={a.id} className="flex items-center gap-3 px-2.5 py-2 rounded-2xl">
                  <span className="w-6 text-xs text-gray-400 flex-shrink-0 text-right">{a.posicion}</span>
                  <span className="text-sm text-gray-800 flex-1 truncate">{a.nombre}</span>
                  {requiereEstadosAsistencia(filtro) && (
                    <span className="text-xs text-gray-400 flex-shrink-0">
                      {ETIQUETA_ESTADO[estados[a.id] ?? 'sin_registrar']}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
