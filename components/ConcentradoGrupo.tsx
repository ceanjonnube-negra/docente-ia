'use client'

// components/ConcentradoGrupo.tsx
//
// EVAL-1L — concentrado grupal acumulativo, bajo demanda, dentro de
// Evaluación. Único consumidor de datos: GET
// /api/proyectos-seguimiento/historial-grupo (EVAL-1K), ya cerrado y
// validado E2E — este componente NUNCA consulta Supabase directamente
// (0 queries desde UI), NUNCA llama IA, NUNCA escribe nada. Mismo
// patrón de carga perezosa que ResultadosConfirmados.tsx (EVAL-1J):
// el padre (app/dashboard/evaluacion/page.tsx) solo MONTA este
// componente cuando el docente abre el control "Concentrado del
// grupo" — el fetch ocurre una sola vez al montar, nunca antes.
//
// Semántica correcta (corrección explícita sobre la auditoría
// previa): "General" = TODOS los resultados confirmados recibidos
// (historial.resumen completo) — NUNCA periodoEvaluacionId===null.
// "Sin periodo asignado" es una propiedad de CADA proyecto individual
// (periodoEvaluacionId===null), no una vista alterna a "General". En
// esta primera fase no existe ningún selector de periodo real: la
// pantalla de Evaluación no tiene hoy ningún nombre/orden de periodo
// cargado en memoria (verificado, 0 referencias), así que agregar un
// selector por nombre real exigiría una consulta nueva fuera de
// alcance — se deja preparado (cada proyecto ya conserva
// periodoEvaluacionId) para una fase futura, nunca inventado aquí.
//
// Trazabilidad: la lista de "Proyectos evaluados" es informativa en
// esta fase — no abre el panel Alumno×Indicador de EVAL-1J. Hacerlo
// requeriría levantar el estado verResultadosDe/setVerResultadosDe de
// page.tsx hasta este componente (prop callback) y, además, decidir
// cómo desplazar la vista hasta la tarjeta real del proyecto (que
// puede no estar visible en pantalla) — un cambio de UX no trivial
// que se deja explícitamente para una fase posterior, ver reporte.

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { ASPECTOS_GENERALES, type AspectoGeneral } from '@/lib/seguimiento/tipos'
import { formatearFecha, obtenerZonaHorariaDispositivo } from '@/lib/tiempo/TimeService'

type NivelTextoCanonico = 'destacado' | 'logrado' | 'en_proceso' | 'requiere_apoyo' | 'no_evaluado'

// Mismo orden/etiquetas en español que ya pediste mostrar — no existe
// hoy, en el repositorio, un helper exportado que mapee
// NivelTextoCanonico -> etiqueta visible (el único mapa de etiquetas
// existente, NIVELES_EVALUACION en lib/seguimiento/tipos.ts, es para
// la escala numérica 1-4, una clave distinta) — así que se declara
// aquí, una sola vez, sin inventar ningún valor nuevo.
const NIVELES_ORDEN: { valor: NivelTextoCanonico; etiqueta: string }[] = [
  { valor: 'destacado', etiqueta: 'Destacado' },
  { valor: 'logrado', etiqueta: 'Logrado' },
  { valor: 'en_proceso', etiqueta: 'En proceso' },
  { valor: 'requiere_apoyo', etiqueta: 'Requiere apoyo' },
  { valor: 'no_evaluado', etiqueta: 'No evaluado' },
]

type ProyectoHistorialGrupo = { proyectoId: string; confirmadoEn: string | null; periodoEvaluacionId: string | null }
type ResumenHistorialGrupo = {
  proyectosConfirmados: number
  alumnosConResultados: number
  totalIndicadoresConfirmados: number
  distribucionNiveles: Record<NivelTextoCanonico, number>
  distribucionNivelesPorAspecto: Record<AspectoGeneral, Record<NivelTextoCanonico, number>>
}
type HistorialGrupo = {
  proyectos: ProyectoHistorialGrupo[]
  resumen: ResumenHistorialGrupo
  entradasAmbiguasExcluidas: number
  entradasInvalidasExcluidas: number
}

function BarraNivel({ etiqueta, cantidad, total }: { etiqueta: string; cantidad: number; total: number }) {
  // Guarda explícita de división por cero (sección 5) — con total=0
  // simplemente no hay barra que proporcionar, solo el conteo (0).
  const porcentaje = total > 0 ? Math.round((cantidad / total) * 100) : 0
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-600 w-28 flex-shrink-0">{etiqueta}</span>
      <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className="h-full bg-teal-500 rounded-full" style={{ width: `${porcentaje}%` }} />
      </div>
      <span className="text-xs font-semibold text-gray-700 w-8 text-right flex-shrink-0">{cantidad}</span>
    </div>
  )
}

export default function ConcentradoGrupo({
  grupoId,
  // Mapa proyectoId -> nombre YA resuelto por el padre (page.tsx), que
  // ya tiene esa lista cargada para sus propias tarjetas — 0 consultas
  // adicionales, nunca una por proyecto (ver sección 7).
  titulosPorProyecto,
}: {
  grupoId: string
  titulosPorProyecto: Record<string, string>
}) {
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [historial, setHistorial] = useState<HistorialGrupo | null>(null)
  const [aspectosExpandidos, setAspectosExpandidos] = useState<Set<AspectoGeneral>>(new Set())

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
        const res = await fetch(`/api/proyectos-seguimiento/historial-grupo?grupo_id=${grupoId}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
        const json = await res.json()
        if (!activo) return
        if (!res.ok) {
          setError(json.error || 'No se pudo cargar el concentrado del grupo.')
          setCargando(false)
          return
        }
        setHistorial(json.historial as HistorialGrupo)
        setCargando(false)
      } catch {
        if (activo) {
          setError('No se pudo cargar el concentrado del grupo.')
          setCargando(false)
        }
      }
    })()
    return () => {
      activo = false
    }
  }, [grupoId])

  const alternarAspecto = (valor: AspectoGeneral) => {
    setAspectosExpandidos((actual) => {
      const siguiente = new Set(actual)
      if (siguiente.has(valor)) siguiente.delete(valor)
      else siguiente.add(valor)
      return siguiente
    })
  }

  if (cargando) {
    return <p className="px-4 py-3 text-xs text-gray-400">Cargando concentrado…</p>
  }
  if (error) {
    // Error confinado a este panel — nunca rompe el resto de
    // Evaluación (sección 10): el padre sigue mostrando sus tarjetas
    // de proyectos intactas, solo este bloque queda en error.
    return <p className="px-4 py-3 text-xs text-red-600">{error}</p>
  }
  if (!historial || historial.resumen.proyectosConfirmados === 0) {
    return <p className="px-4 py-3 text-xs text-gray-400">Todavía no hay resultados confirmados en este grupo.</p>
  }

  const { resumen } = historial
  const hayInconsistencia = historial.entradasAmbiguasExcluidas > 0 || historial.entradasInvalidasExcluidas > 0

  return (
    <div className="px-4 pb-4 space-y-4">
      {/* Resumen (sección 4) — solo conteos directos, sin ningún
          cálculo pedagógico. */}
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="bg-gray-50 rounded-xl py-2">
          <p className="text-lg font-bold text-gray-900">{resumen.proyectosConfirmados}</p>
          <p className="text-[10px] text-gray-500">Proyectos evaluados</p>
        </div>
        <div className="bg-gray-50 rounded-xl py-2">
          <p className="text-lg font-bold text-gray-900">{resumen.alumnosConResultados}</p>
          <p className="text-[10px] text-gray-500">Alumnos con resultados</p>
        </div>
        <div className="bg-gray-50 rounded-xl py-2">
          <p className="text-lg font-bold text-gray-900">{resumen.totalIndicadoresConfirmados}</p>
          <p className="text-[10px] text-gray-500">Indicadores registrados</p>
        </div>
      </div>

      {/* Distribución por nivel (sección 5) — las 5 categorías
          canónicas, siempre las 5, conteo + barra proporcional simple
          (sin librería de gráficas). */}
      <div className="space-y-1.5">
        <p className="text-xs font-semibold text-gray-700">Distribución por nivel</p>
        {NIVELES_ORDEN.map((n) => (
          <BarraNivel key={n.valor} etiqueta={n.etiqueta} cantidad={resumen.distribucionNiveles[n.valor]} total={resumen.totalIndicadoresConfirmados} />
        ))}
      </div>

      {/* Aspectos generales (sección 6) — cada aspecto como fila
          plegable, nunca una matriz 5x5 permanente. Etiquetas
          reutilizadas de ASPECTOS_GENERALES (lib/seguimiento/tipos.ts),
          nunca redeclaradas. */}
      <div className="space-y-1.5">
        <p className="text-xs font-semibold text-gray-700">Aspectos generales</p>
        {ASPECTOS_GENERALES.map((aspecto) => {
          const distribucionAspecto = resumen.distribucionNivelesPorAspecto[aspecto.valor]
          const totalAspecto = NIVELES_ORDEN.reduce((acc, n) => acc + distribucionAspecto[n.valor], 0)
          const expandido = aspectosExpandidos.has(aspecto.valor)
          return (
            <div key={aspecto.valor} className="border border-gray-100 rounded-xl overflow-hidden">
              <button
                type="button"
                onClick={() => alternarAspecto(aspecto.valor)}
                className="w-full flex items-center justify-between px-3 py-2 text-left"
              >
                <span className="text-xs font-medium text-gray-700">{aspecto.etiqueta}</span>
                <span className="text-xs text-gray-400">{totalAspecto} · {expandido ? 'Ocultar' : 'Ver'}</span>
              </button>
              {expandido && (
                <div className="px-3 pb-2 space-y-1.5 border-t border-gray-50 pt-2">
                  {NIVELES_ORDEN.map((n) => (
                    <BarraNivel key={n.valor} etiqueta={n.etiqueta} cantidad={distribucionAspecto[n.valor]} total={totalAspecto} />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Proyectos evaluados (sección 7) — informativo en esta fase,
          sin abrir todavía el panel de EVAL-1J (ver comentario
          superior del archivo). Título resuelto EN MEMORIA desde el
          mapa que ya trae page.tsx — nunca una consulta nueva. */}
      <div className="space-y-1.5">
        <p className="text-xs font-semibold text-gray-700">Proyectos evaluados</p>
        <ul className="space-y-1">
          {historial.proyectos.map((p) => {
            const fecha = p.confirmadoEn ? formatearFecha(p.confirmadoEn, obtenerZonaHorariaDispositivo()) : null
            return (
              <li key={p.proyectoId} className="text-xs text-gray-600 flex items-center justify-between gap-2">
                <span className="truncate">{titulosPorProyecto[p.proyectoId] ?? 'Proyecto'}</span>
                <span className="text-gray-400 flex-shrink-0">
                  {fecha}
                  {p.periodoEvaluacionId === null ? ' · Sin periodo asignado' : ''}
                </span>
              </li>
            )
          })}
        </ul>
      </div>

      {/* Señal discreta de inconsistencia (sección 10) — nunca
          interpretación pedagógica, nunca detalle técnico. */}
      {hayInconsistencia && (
        <p className="text-[11px] text-amber-600">⚠️ Algunos registros no pudieron incluirse por una inconsistencia de datos.</p>
      )}
    </div>
  )
}
