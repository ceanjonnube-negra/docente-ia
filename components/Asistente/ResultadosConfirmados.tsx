'use client'

// components/Asistente/ResultadosConfirmados.tsx
//
// EVAL-1J — panel de SOLO LECTURA de los resultados ya confirmados de
// una hoja (ver GET .../resultados-confirmados). Deliberadamente
// separado de CapturaHoja.tsx: esa pieza es exclusivamente de
// captura/confirmación; esta es exclusivamente de consulta posterior,
// misma separación de responsabilidades que
// lib/seguimiento/resultadosConfirmados.ts tiene frente a
// confirmarResultadosHoja.ts. El fetch ocurre SOLO cuando este
// componente se monta (es decir, solo cuando el padre lo renderiza
// tras tocar "Ver resultados") — nunca al cargar la lista de
// Evaluación. Si el docente cierra y vuelve a abrir el mismo panel
// mientras la tarjeta sigue montada en memoria, el padre decide si
// este componente se desmonta o no; aquí no se agrega ninguna caché
// nueva — un montaje nuevo simplemente vuelve a pedir el dato real.

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'

type Celda = { numeroIndicador: number; indicadorEspecifico: string; nivel: string | null }
type Alumno = { alumnoId: string; inscripcionId: string; nombre: string; posicion: number; celdas: Celda[] }
type Matriz = { alumnos: Alumno[] }

// Mismas 5 etiquetas cortas de siempre para columnas — el texto
// completo del indicador se ofrece como title (tooltip nativo) para
// no ensanchar la tabla en pantallas angostas.
const ETIQUETA_NIVEL: Record<string, string> = {
  destacado: 'Destacado',
  logrado: 'Logrado',
  en_proceso: 'En proceso',
  requiere_apoyo: 'Requiere apoyo',
  no_evaluado: 'No evaluado',
}

export default function ResultadosConfirmados({ proyectoId }: { proyectoId: string }) {
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [matriz, setMatriz] = useState<Matriz | null>(null)

  useEffect(() => {
    let activo = true
    ;(async () => {
      setCargando(true)
      setError(null)
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        if (activo) {
          setError('Tu sesión expiró. Vuelve a iniciar sesión.')
          setCargando(false)
        }
        return
      }
      try {
        const res = await fetch(`/api/proyectos-seguimiento/${proyectoId}/resultados-confirmados`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
        const json = await res.json()
        if (!activo) return
        if (!res.ok) {
          setError(json.error || 'No se pudieron cargar los resultados.')
          setCargando(false)
          return
        }
        setMatriz(json.matriz as Matriz)
        setCargando(false)
      } catch {
        if (activo) {
          setError('No se pudieron cargar los resultados.')
          setCargando(false)
        }
      }
    })()
    return () => {
      activo = false
    }
  }, [proyectoId])

  if (cargando) {
    return <p className="px-4 py-3 text-xs text-gray-400">Cargando resultados…</p>
  }
  if (error) {
    return <p className="px-4 py-3 text-xs text-red-600">{error}</p>
  }
  if (!matriz || matriz.alumnos.length === 0) {
    return <p className="px-4 py-3 text-xs text-gray-400">No hay resultados para mostrar.</p>
  }

  const indicadores = matriz.alumnos[0].celdas

  return (
    <div className="px-2 pb-3">
      {/* Scroll horizontal SOLO dentro de este panel — nunca ensancha
          el resto de la pantalla. Primera columna (alumno) con fondo
          propio y sticky para seguir identificable al desplazarse. */}
      <div className="overflow-x-auto rounded-xl border border-gray-100">
        <table className="min-w-full text-[11px]">
          <thead>
            <tr className="bg-gray-50">
              <th className="sticky left-0 bg-gray-50 px-2 py-2 text-left font-semibold text-gray-600 whitespace-nowrap">Alumno</th>
              {indicadores.map((c) => (
                <th key={c.numeroIndicador} className="px-2 py-2 text-center font-semibold text-gray-600 whitespace-nowrap" title={c.indicadorEspecifico}>
                  Ind. {c.numeroIndicador}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matriz.alumnos.map((alumno) => (
              <tr key={alumno.inscripcionId} className="border-t border-gray-50">
                <td className="sticky left-0 bg-white px-2 py-2 font-medium text-gray-800 whitespace-nowrap">{alumno.nombre}</td>
                {alumno.celdas.map((celda) => (
                  <td key={celda.numeroIndicador} className="px-2 py-2 text-center text-gray-600 whitespace-nowrap">
                    {celda.nivel ? ETIQUETA_NIVEL[celda.nivel] ?? '—' : '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
