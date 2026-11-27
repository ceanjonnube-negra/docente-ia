'use client'
// components/Evaluacion/ConcentradoGrupo.tsx
//
// Concentrado académico del grupo activo (Hito 3c) dentro de Evaluación:
// historial acumulado de proyectos CONFIRMADOS (GET historial-grupo, mismo
// modelo que la ficha) visto por alumno o por proyecto, con filtros por
// periodo y campo formativo. Listas compactas en lugar de una matriz
// ancha (30–40 alumnos, muchos proyectos). Solo conteos directos: sin
// calificaciones, promedios, etiquetas de alumno ni conclusiones.

import { useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import DistribucionNiveles from '@/components/ui/DistribucionNiveles'
import { IconoCampo, IconoSiguiente } from '@/components/Planeacion/Iconos'
import { COLOR_NIVEL_CANONICO, ETIQUETA_NIVEL_CANONICO } from '@/lib/seguimiento/conversionCalificacion'
import { construirConcentradoGrupo, type AlumnoEnConcentrado, type FiltroHistorial, type HistorialGrupo, type InscripcionDelGrupo, type ProyectoEnConcentrado } from '@/lib/seguimiento/historialGrupo'

type Datos = { historial: HistorialGrupo; inscripciones: InscripcionDelGrupo[] }
type Vista = 'alumnos' | 'proyectos'

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`
const fecha = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' }) : null)

function Chips({ requiereApoyo, sinEvaluar, sinRegistro }: { requiereApoyo: number; sinEvaluar: number; sinRegistro: number }) {
  return (
    <span className="flex flex-wrap gap-1">
      {requiereApoyo > 0 && <span className="rounded-full bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-700">{requiereApoyo} Requiere apoyo</span>}
      {sinEvaluar > 0 && <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">{sinEvaluar} Sin evaluar</span>}
      {sinRegistro > 0 && <span className="rounded-full border border-dashed border-gray-300 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">{sinRegistro} Sin registro</span>}
    </span>
  )
}

function FilaAlumno({ a, onVerProyecto }: { a: AlumnoEnConcentrado; onVerProyecto: (id: string) => void }) {
  return (
    <details className="group rounded-xl border border-gray-100 bg-white px-3 py-2.5 shadow-sm">
      <summary className="flex cursor-pointer list-none items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-gray-900">
            {a.inscripcion.nombre}
            {a.inscripcion.estatus && a.inscripcion.estatus !== 'activo' && <span className="ml-1.5 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">Baja</span>}
          </p>
          <div className="mt-1"><Chips requiereApoyo={a.requiereApoyo} sinEvaluar={a.sinEvaluar} sinRegistro={a.sinRegistro} /></div>
        </div>
        <div className="w-20 flex-shrink-0 sm:w-28"><DistribucionNiveles distribucion={a.distribucion} compacta /></div>
        <IconoSiguiente className="h-3.5 w-3.5 flex-shrink-0 text-gray-400 transition-transform group-open:rotate-90" />
      </summary>
      <div className="mt-2.5 space-y-2 border-t border-gray-50 pt-2.5">
        {a.proyectos.map((c) => (
          <div key={c.proyecto.proyectoId} className="text-xs">
            <div className="flex items-center justify-between gap-2">
              <p className="min-w-0 truncate font-medium text-gray-700">{c.proyecto.nombre ?? 'Proyecto'}</p>
              <button type="button" onClick={() => onVerProyecto(c.proyecto.proyectoId)} className="flex-shrink-0 text-[11px] font-semibold text-green-700 hover:text-green-800">Ver evaluación</button>
            </div>
            {c.estado === 'sin_registro' ? (
              <p className="mt-0.5 text-[11px] text-gray-500">Sin registro en este proyecto.</p>
            ) : (
              <ul className="mt-1 flex flex-wrap gap-1">
                {c.resultado.indicadores.map((i) => (
                  <li key={i.indicadorNumero} title={i.indicadorEspecifico} className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${COLOR_NIVEL_CANONICO[i.nivel]}`}>
                    {i.indicadorNumero}. {ETIQUETA_NIVEL_CANONICO[i.nivel]}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
        <a href={`/dashboard/lista/${a.inscripcion.alumnoId}?tab=evaluaciones`} className="inline-flex items-center gap-0.5 text-xs font-semibold text-green-700 hover:text-green-800">
          Abrir ficha del alumno<IconoSiguiente className="h-3.5 w-3.5" />
        </a>
      </div>
    </details>
  )
}

function TarjetaProyecto({ p, onVerProyecto }: { p: ProyectoEnConcentrado; onVerProyecto: (id: string) => void }) {
  const campos = p.proyecto.campoFormativo ?? (p.proyecto.camposFormativos.join(' · ') || null)
  return (
    <div className="rounded-xl border border-gray-100 bg-white px-3.5 py-3 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-sm font-semibold text-gray-900">{p.proyecto.nombre ?? 'Proyecto'}</p>
        {p.proyecto.confirmadoEn && <span className="flex-shrink-0 text-[11px] text-gray-400">{fecha(p.proyecto.confirmadoEn)}</span>}
      </div>
      <p className="mt-0.5 flex items-center gap-1 text-[11px] text-gray-500">
        <IconoCampo className="h-3.5 w-3.5 flex-shrink-0 text-green-700" />
        <span className="truncate">{[p.proyecto.periodo?.nombre ?? 'Sin periodo asignado', campos].filter(Boolean).join(' · ')}</span>
      </p>
      <DistribucionNiveles distribucion={p.distribucion} />
      <div className="mt-2 flex items-center justify-between gap-2">
        <p className="text-[11px] text-gray-500">
          {plural(p.alumnosConResultados, 'alumno con resultados', 'alumnos con resultados')}
          {p.sinRegistro > 0 && ` · ${p.sinRegistro} sin registro`}
          {p.indicadoresRequierenApoyo > 0 && <span className="text-red-700"> · {plural(p.indicadoresRequierenApoyo, 'indicador en Requiere apoyo', 'indicadores en Requiere apoyo')}</span>}
        </p>
        <button type="button" onClick={() => onVerProyecto(p.proyecto.proyectoId)} className="flex-shrink-0 text-xs font-semibold text-green-700 hover:text-green-800">Ver evaluación</button>
      </div>
    </div>
  )
}

export default function ConcentradoGrupo({ grupoId, onVerProyecto }: { grupoId: string; onVerProyecto: (proyectoId: string) => void }) {
  const [datos, setDatos] = useState<Datos | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let vigente = true
    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { if (vigente) setError('Tu sesión expiró. Vuelve a iniciar sesión.'); return }
      const res = await fetch(`/api/proyectos-seguimiento/historial-grupo?grupo_id=${grupoId}`, { headers: { Authorization: `Bearer ${session.access_token}` } })
      const json = await res.json().catch(() => ({}))
      if (!vigente) return
      if (!res.ok) setError(json.error || 'No se pudo cargar el concentrado del grupo.')
      else setDatos({ historial: json.historial, inscripciones: json.inscripciones ?? [] })
    })()
    return () => { vigente = false }
  }, [grupoId])

  if (error) return <p role="alert" className="rounded-xl border border-red-100 bg-red-50 px-3.5 py-3 text-sm text-red-700">{error}</p>
  if (!datos) return <p className="text-sm text-gray-500">Cargando concentrado…</p>
  return <PanelConcentrado datos={datos} onVerProyecto={onVerProyecto} />
}

// Presentación (sin red): filtros, resumen, Requiere apoyo y vistas.
export function PanelConcentrado({ datos, onVerProyecto }: { datos: Datos; onVerProyecto: (proyectoId: string) => void }) {
  const [filtro, setFiltro] = useState<FiltroHistorial>({})
  const [vista, setVista] = useState<Vista>('alumnos')
  const c = useMemo(() => construirConcentradoGrupo(datos.historial, datos.inscripciones, filtro), [datos, filtro])
  if (datos.historial.proyectos.length === 0) {
    return <p className="rounded-2xl border border-gray-100 bg-white px-4 py-8 text-center text-sm text-gray-500 shadow-sm">Aún no hay proyectos con resultados confirmados en este grupo.</p>
  }
  const valorPeriodo = filtro.periodoId ?? ''
  const conApoyo = c.alumnos.filter((a) => a.apoyo.length > 0)
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <select aria-label="Periodo" value={valorPeriodo} onChange={(e) => setFiltro((f) => ({ ...f, periodoId: e.target.value || undefined }))} className="min-w-0 rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700">
          <option value="">Todos los periodos</option>
          {c.opciones.periodos.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
          {c.opciones.haySinPeriodo && <option value="sin_periodo">Sin periodo asignado</option>}
        </select>
        <select aria-label="Campo formativo" value={filtro.campoFormativo ?? ''} onChange={(e) => setFiltro((f) => ({ ...f, campoFormativo: e.target.value || undefined }))} className="min-w-0 rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700">
          <option value="">Todos los campos</option>
          {c.opciones.campos.map((campo) => <option key={campo} value={campo}>{campo}</option>)}
        </select>
      </div>

      <div className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm">
        <p className="text-xs text-gray-500">{plural(c.proyectos.length, 'proyecto confirmado', 'proyectos confirmados')} · {plural(c.alumnos.length, 'alumno', 'alumnos')}</p>
        <DistribucionNiveles distribucion={c.distribucion} />
        {filtro.campoFormativo && <p className="mt-2 text-[11px] text-gray-400">Incluye los proyectos que trabajan este campo; los indicadores no se atribuyen a un campo en particular.</p>}
      </div>

      {c.indicadoresRequierenApoyo > 0 && (
        <details className="rounded-2xl border border-red-100 bg-white p-4 shadow-sm">
          <summary className="cursor-pointer list-none text-sm font-semibold text-gray-900">
            {plural(c.indicadoresRequierenApoyo, 'indicador confirmado', 'indicadores confirmados')} en <span className="text-red-700">Requiere apoyo</span>
            <span className="ml-1 text-xs font-normal text-gray-500">({plural(c.alumnosConIndicadoresEnApoyo, 'alumno', 'alumnos')})</span>
          </summary>
          <ul className="mt-3 space-y-2">
            {conApoyo.map((a) => (
              <li key={a.inscripcion.inscripcionId} className="text-xs">
                <a href={`/dashboard/lista/${a.inscripcion.alumnoId}?tab=evaluaciones`} className="font-medium text-gray-900 hover:text-green-800">{a.inscripcion.nombre}</a>
                <ul className="mt-0.5 space-y-0.5 text-gray-600">
                  {a.apoyo.map((x) => (
                    <li key={`${x.proyectoId}-${x.indicadorNumero}`}>
                      {c.proyectos.find((p) => p.proyecto.proyectoId === x.proyectoId)?.proyecto.nombre ?? 'Proyecto'} · {x.indicadorNumero}. {x.indicadorEspecifico}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div role="tablist" className="grid grid-cols-2 rounded-full bg-gray-100 p-0.5 text-xs font-semibold">
        {(['alumnos', 'proyectos'] as Vista[]).map((v) => (
          <button key={v} type="button" role="tab" aria-selected={vista === v} onClick={() => setVista(v)} className={`rounded-full py-1.5 ${vista === v ? 'bg-white text-green-800 shadow-sm' : 'text-gray-500'}`}>
            {v === 'alumnos' ? 'Por alumno' : 'Por proyecto'}
          </button>
        ))}
      </div>

      {c.proyectos.length === 0 ? (
        <p className="text-sm text-gray-500">No hay proyectos confirmados con este filtro.</p>
      ) : vista === 'alumnos' ? (
        <div className="space-y-2">{c.alumnos.map((a) => <FilaAlumno key={a.inscripcion.inscripcionId} a={a} onVerProyecto={onVerProyecto} />)}</div>
      ) : (
        <div className="grid gap-2.5 sm:grid-cols-2">{c.proyectos.map((p) => <TarjetaProyecto key={p.proyecto.proyectoId} p={p} onVerProyecto={onVerProyecto} />)}</div>
      )}

      <p className="text-[11px] leading-relaxed text-gray-400">
        Niveles confirmados de las hojas de evaluación. «Sin evaluar»: indicador sin marca en la hoja. «Sin registro»: el alumno no tiene resultados en ese proyecto.
      </p>
      {c.entradasExcluidas > 0 && <p className="text-[11px] text-amber-700">{c.entradasExcluidas} registro(s) con datos inconsistentes no se incluyen.</p>}
    </div>
  )
}
