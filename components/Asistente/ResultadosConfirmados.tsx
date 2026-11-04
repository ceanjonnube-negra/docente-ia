'use client'

// components/Asistente/ResultadosConfirmados.tsx
//
// "Ver resultados" de un proyecto ya confirmado (pantalla de
// Evaluación). Solo LEE: consume GET resultados-confirmados (EVAL-1J),
// que ya arma la matriz desde seguimiento_resultados con el roster e
// indicadores congelados de la hoja — aquí no se recalcula, completa ni
// corrige nada. Una celda sin dato real se muestra como "—", nunca como
// un nivel aproximado. Sin controles de edición ni de confirmación.

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { ASPECTOS_GENERALES, NIVELES_EVALUACION, type NivelEvaluacion } from '@/lib/seguimiento/tipos'
import type { NivelTextoCanonico } from '@/lib/seguimiento/conversionCalificacion'
import type { MatrizResultadosConfirmados } from '@/lib/seguimiento/resultadosConfirmados'

// Inversa de nivelATextoCanonico (conversionCalificacion.ts): misma
// escala 1-4 que la hoja impresa; 'no_evaluado' es la casilla sin marca.
const NUMERO_NIVEL: Record<NivelTextoCanonico, NivelEvaluacion | null> = {
  destacado: 4,
  logrado: 3,
  en_proceso: 2,
  requiere_apoyo: 1,
  no_evaluado: null,
}

const COLOR_NIVEL: Record<NivelTextoCanonico, string> = {
  destacado: 'bg-green-100 text-green-800',
  logrado: 'bg-teal-100 text-teal-800',
  en_proceso: 'bg-amber-100 text-amber-800',
  requiere_apoyo: 'bg-red-100 text-red-800',
  no_evaluado: 'bg-gray-100 text-gray-500',
}

function textoNivel(nivel: NivelTextoCanonico | null): string {
  if (nivel === null) return '—'
  const numero = NUMERO_NIVEL[nivel]
  return numero === null ? 'NE' : String(numero)
}

function etiquetaAspecto(valor: string): string {
  return ASPECTOS_GENERALES.find((a) => a.valor === valor)?.etiqueta ?? valor
}

export function TablaResultadosConfirmados({ matriz }: { matriz: MatrizResultadosConfirmados }) {
  if (matriz.alumnos.length === 0) {
    return <p className="text-sm text-gray-500">Esta hoja no tiene alumnos registrados.</p>
  }
  const indicadores = matriz.alumnos[0].celdas
  const sinDatos = matriz.alumnos.every((a) => a.celdas.every((c) => c.nivel === null))

  return (
    <div className="space-y-3">
      {sinDatos && (
        <p className="text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm">
          No se encontraron resultados registrados para este proyecto.
        </p>
      )}

      <ol className="space-y-1">
        {indicadores.map((c) => (
          <li key={c.numeroIndicador} className="text-xs text-gray-600">
            <span className="font-semibold text-gray-800">I{c.numeroIndicador}.</span> {c.indicadorEspecifico}
            <span className="text-gray-400"> · {etiquetaAspecto(c.aspectoGeneral)}</span>
          </li>
        ))}
      </ol>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-gray-500">
              <th className="text-left font-medium py-1 pr-2">Alumno</th>
              {indicadores.map((c) => (
                <th key={c.numeroIndicador} className="font-medium py-1 px-1 text-center">I{c.numeroIndicador}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matriz.alumnos.map((alumno) => (
              <tr key={alumno.inscripcionId} className="border-t border-gray-50">
                <td className="py-1.5 pr-2 text-gray-800">
                  <span className="text-gray-400">{alumno.posicion}.</span> {alumno.nombre}
                </td>
                {alumno.celdas.map((celda) => (
                  <td key={celda.numeroIndicador} className="py-1.5 px-1 text-center">
                    <span
                      className={
                        'inline-flex items-center justify-center w-7 h-7 rounded text-xs font-medium ' +
                        (celda.nivel ? COLOR_NIVEL[celda.nivel] : 'bg-white text-gray-400 border border-gray-200')
                      }
                    >
                      {textoNivel(celda.nivel)}
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-gray-500">
        {NIVELES_EVALUACION.map((n) => `${n.valor} = ${n.etiqueta}`).join(' · ')} · NE = No evaluado · — = Sin dato registrado
      </p>
    </div>
  )
}

type Fase = { tipo: 'cargando' } | { tipo: 'error'; mensaje: string } | { tipo: 'listo'; matriz: MatrizResultadosConfirmados }

async function leerResultados(proyectoId: string): Promise<Fase> {
  try {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return { tipo: 'error', mensaje: 'Tu sesión expiró. Vuelve a iniciar sesión.' }
    const res = await fetch(`/api/proyectos-seguimiento/${proyectoId}/resultados-confirmados`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
    const json = await res.json()
    if (!res.ok || !json.matriz) return { tipo: 'error', mensaje: json.error || 'No se pudieron cargar los resultados.' }
    return { tipo: 'listo', matriz: json.matriz as MatrizResultadosConfirmados }
  } catch {
    return { tipo: 'error', mensaje: 'No se pudieron cargar los resultados. Revisa tu conexión e inténtalo de nuevo.' }
  }
}

export default function ResultadosConfirmados({ proyectoId }: { proyectoId: string }) {
  const [fase, setFase] = useState<Fase>({ tipo: 'cargando' })
  const [intento, setIntento] = useState(0)

  useEffect(() => {
    let vigente = true
    leerResultados(proyectoId).then((siguiente) => {
      if (vigente) setFase(siguiente)
    })
    return () => {
      vigente = false
    }
  }, [proyectoId, intento])

  const reintentar = () => {
    setFase({ tipo: 'cargando' })
    setIntento((n) => n + 1)
  }

  return (
    <div className="p-4">
      {fase.tipo === 'cargando' && <p className="text-sm text-gray-500">Cargando resultados…</p>}
      {fase.tipo === 'error' && (
        <div className="space-y-2">
          <p className="text-sm text-red-600">{fase.mensaje}</p>
          <button
            type="button"
            onClick={reintentar}
            className="border border-gray-200 text-gray-700 text-xs font-semibold px-3 py-2 rounded-full hover:bg-gray-50"
          >
            Reintentar
          </button>
        </div>
      )}
      {fase.tipo === 'listo' && <TablaResultadosConfirmados matriz={fase.matriz} />}
    </div>
  )
}
