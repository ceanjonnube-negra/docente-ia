'use client'

// app/dashboard/evaluacion/page.tsx
//
// EVAL-1I — primera pantalla operativa de Evaluación. Memoria
// organizada de las hojas de evaluación ya generadas (por Planeación,
// vía el Chat IA) para el grupo activo — NUNCA otro sistema paralelo:
// lista por consulta directa a proyectos_seguimiento + hojas_evaluacion
// (ya son la fuente de verdad real), sin ninguna escritura nueva para
// "publicar" o "activar" una hoja aquí. Si el proyecto ya tiene una
// hoja generada, aparece — punto.
//
// Reutiliza EVAL-1B→1G íntegramente: el estado de cada hoja viene de
// GET estado-captura (mismo enum discreto ya usado por CapturaHoja),
// y la captura/análisis/revisión/confirmación las hace CapturaHoja.tsx
// tal cual (misma instancia, mismo componente, 0 lógica duplicada) —
// esta pantalla solo decide QUÉ proyecto mostrar, nunca CÓMO capturar.

import { useCallback, useEffect, useState } from 'react'
import { useAsistente } from '@/lib/asistente/hooks'
import { supabase } from '@/lib/supabaseClient'
import CapturaHoja from '@/components/Asistente/CapturaHoja'

type EstadoCapturaHoja =
  | 'sin_fotografia'
  | 'captura_incompleta'
  | 'lista_para_analizar'
  | 'revision_pendiente'
  | 'lista_para_confirmar'
  | 'confirmado'

type HojaEmbebida = { identificador_visible: string; storage_path: string | null; generado_en: string } | null

type Proyecto = {
  id: string
  nombre: string
  fecha_inicio: string | null
  fecha_fin: string | null
  estado: string
  hoja_id: string | null
  creado_en: string
  hojas_evaluacion: HojaEmbebida
}

const ETIQUETA_ESTADO: Record<EstadoCapturaHoja, string> = {
  sin_fotografia: 'Pendiente de captura',
  captura_incompleta: 'Captura parcial',
  lista_para_analizar: 'Analizando…',
  revision_pendiente: 'Revisión pendiente',
  lista_para_confirmar: 'Lista para confirmar',
  confirmado: 'Confirmada',
}

const ETIQUETA_BOTON: Record<EstadoCapturaHoja, string> = {
  sin_fotografia: 'Capturar resultados',
  captura_incompleta: 'Continuar captura',
  lista_para_analizar: 'Continuar',
  revision_pendiente: 'Revisar resultados',
  lista_para_confirmar: 'Confirmar resultados',
  confirmado: 'Ver detalle',
}

const COLOR_BADGE: Record<EstadoCapturaHoja, string> = {
  sin_fotografia: 'bg-gray-100 text-gray-600',
  captura_incompleta: 'bg-amber-100 text-amber-700',
  lista_para_analizar: 'bg-blue-100 text-blue-700',
  revision_pendiente: 'bg-amber-100 text-amber-700',
  lista_para_confirmar: 'bg-blue-100 text-blue-700',
  confirmado: 'bg-green-100 text-green-700',
}

export default function EvaluacionPage() {
  const asistente = useAsistente()
  useEffect(() => {
    asistente.cerrarPanel()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nombreGrupo, setNombreGrupo] = useState('')
  const [proyectos, setProyectos] = useState<Proyecto[]>([])
  const [estados, setEstados] = useState<Record<string, EstadoCapturaHoja>>({})
  const [seleccionado, setSeleccionado] = useState<string | null>(null)
  const [urlHoja, setUrlHoja] = useState<Record<string, string>>({})
  const [cargandoUrl, setCargandoUrl] = useState<string | null>(null)

  const cargarEstadosDe = useCallback(async (accessToken: string, lista: Proyecto[]) => {
    const resultados = await Promise.all(
      lista.map(async (p) => {
        const res = await fetch(`/api/proyectos-seguimiento/${p.id}/estado-captura`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        })
        if (!res.ok) return [p.id, null] as const
        const json = await res.json()
        return [p.id, json.estado as EstadoCapturaHoja] as const
      })
    )
    setEstados((prev) => {
      const siguiente = { ...prev }
      for (const [id, estado] of resultados) {
        if (estado) siguiente[id] = estado
      }
      return siguiente
    })
  }, [])

  const cargar = useCallback(async () => {
    setCargando(true)
    setError(null)

    const { data: { session } } = await supabase.auth.getSession()
    const { data: { user } } = await supabase.auth.getUser()
    if (!session || !user) {
      setError('Tu sesión expiró. Vuelve a iniciar sesión.')
      setCargando(false)
      return
    }

    // MG-A — mismo mecanismo canónico ya usado en Lista
    // (app/dashboard/lista/page.tsx): intenta primero el contexto que
    // el docente ya seleccionó (docente_contexto_activo.grupo_id) —
    // una PREFERENCIA, nunca una autorización: se revalida contra
    // `grupos` filtrando por ESE id Y por docente_id/ciclo activo. Si
    // no produce un grupo válido, se usa exactamente la misma
    // heurística de siempre (el grupo más reciente del docente en el
    // ciclo activo) — nunca por nombre, nunca aproximado. Sin grupo
    // válido, fail-closed: no se muestra ningún proyecto.
    type GrupoActivo = { id: string; nombre_grupo: string }
    let grupoActivo: GrupoActivo | undefined

    const { data: contextoPersistido } = await supabase
      .from('docente_contexto_activo')
      .select('grupo_id')
      .eq('docente_id', user.id)
      .maybeSingle()

    if (contextoPersistido?.grupo_id) {
      const { data: grupoValidado } = await supabase
        .from('grupos')
        .select('id, nombre_grupo, ciclos_escolares!inner(activo)')
        .eq('id', contextoPersistido.grupo_id)
        .eq('docente_id', user.id)
        .eq('ciclos_escolares.activo', true)
        .maybeSingle()
      if (grupoValidado) grupoActivo = grupoValidado as unknown as GrupoActivo
    }

    if (!grupoActivo) {
      const { data: grupos } = await supabase
        .from('grupos')
        .select('id, nombre_grupo, ciclos_escolares!inner(activo)')
        .eq('docente_id', user.id)
        .eq('ciclos_escolares.activo', true)
        .order('creado_en', { ascending: false })
        .limit(1)
      if (!grupos || grupos.length === 0) {
        setError('No se encontró un grupo activo.')
        setCargando(false)
        return
      }
      grupoActivo = grupos[0] as unknown as GrupoActivo
    }
    setNombreGrupo(grupoActivo.nombre_grupo)

    const res = await fetch(`/api/proyectos-seguimiento?grupo_id=${grupoActivo.id}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
    const json = await res.json()
    if (!res.ok) {
      setError(json.error || 'No se pudieron cargar los proyectos de este grupo.')
      setCargando(false)
      return
    }

    // Solo proyectos con hoja de evaluación final ya generada —
    // Evaluación es memoria de hojas, no un listado general de
    // proyectos/planeaciones (eso ya vive en Planeación/el historial
    // del Chat).
    const conHoja: Proyecto[] = (json.proyectos ?? []).filter((p: Proyecto) => p.hoja_id)
    setProyectos(conHoja)
    setCargando(false)

    if (conHoja.length > 0) {
      cargarEstadosDe(session.access_token, conHoja)
    }
  }, [cargarEstadosDe])

  useEffect(() => {
    cargar()
  }, [cargar])

  const verHoja = async (proyectoId: string) => {
    if (cargandoUrl) return
    setCargandoUrl(proyectoId)
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) {
      setError('Tu sesión expiró. Vuelve a iniciar sesión.')
      setCargandoUrl(null)
      return
    }
    const res = await fetch(`/api/proyectos-seguimiento/${proyectoId}/hoja-url`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
    const json = await res.json()
    setCargandoUrl(null)
    if (!res.ok) {
      setError(json.error || 'No se pudo abrir la hoja.')
      return
    }
    setUrlHoja((prev) => ({ ...prev, [proyectoId]: json.urlVer }))
    window.open(json.urlVer, '_blank')
  }

  const alternarSeleccion = async (proyectoId: string) => {
    if (seleccionado === proyectoId) {
      setSeleccionado(null)
      // Al cerrar, refresca el estado real de ese proyecto — puede
      // haber cambiado dentro de CapturaHoja (foto subida, análisis
      // corrido, confirmación) mientras estaba expandido.
      const { data: { session } } = await supabase.auth.getSession()
      if (session) cargarEstadosDe(session.access_token, proyectos.filter((p) => p.id === proyectoId))
      return
    }
    setSeleccionado(proyectoId)
  }

  if (cargando) {
    return (
      <div className="flex flex-col h-screen bg-gray-50">
        <Encabezado />
        <p className="p-4 text-sm text-gray-500">Cargando evaluación…</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-screen bg-gray-50 overflow-y-auto">
      <Encabezado subtitulo={nombreGrupo} />

      <div className="flex-1 px-4 py-4 space-y-3 max-w-2xl mx-auto w-full">
        {error && <p className="text-sm text-red-600">{error}</p>}

        {!error && proyectos.length === 0 && (
          <div className="text-center py-12">
            <div className="w-14 h-14 bg-teal-50 rounded-2xl flex items-center justify-center text-2xl mx-auto mb-3">✅</div>
            <p className="text-sm text-gray-500 max-w-xs mx-auto">
              Todavía no hay ninguna hoja de evaluación generada para este grupo. En cuanto apruebes un proyecto en el Chat, su hoja aparecerá aquí.
            </p>
          </div>
        )}

        {proyectos.map((proyecto) => {
          const estado = estados[proyecto.id]
          const expandido = seleccionado === proyecto.id
          return (
            <div key={proyecto.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
              <div className="p-4 flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl bg-teal-50 flex items-center justify-center text-lg flex-shrink-0">📄</div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-gray-900 truncate">{proyecto.nombre}</p>
                  <p className="text-xs text-gray-400">
                    {proyecto.hojas_evaluacion?.identificador_visible ?? ''}
                    {proyecto.fecha_inicio ? ` · ${proyecto.fecha_inicio}` : ''}
                  </p>
                  {estado && (
                    <span className={`inline-block mt-1.5 text-[11px] font-semibold px-2 py-0.5 rounded-full ${COLOR_BADGE[estado]}`}>
                      {ETIQUETA_ESTADO[estado]}
                    </span>
                  )}
                </div>
              </div>

              <div className="px-4 pb-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => verHoja(proyecto.id)}
                  disabled={cargandoUrl === proyecto.id}
                  className="flex-1 border border-gray-200 text-gray-700 text-xs font-semibold px-3 py-2 rounded-full hover:bg-gray-50 disabled:opacity-50"
                >
                  {cargandoUrl === proyecto.id ? 'Abriendo…' : '👁️ Ver hoja'}
                </button>
                <button
                  type="button"
                  onClick={() => alternarSeleccion(proyecto.id)}
                  className="flex-1 bg-teal-600 text-white text-xs font-semibold px-3 py-2 rounded-full hover:bg-teal-700"
                >
                  {expandido ? 'Cerrar' : estado ? ETIQUETA_BOTON[estado] : 'Abrir'}
                </button>
              </div>

              {expandido && (
                <div className="border-t border-gray-50">
                  <CapturaHoja proyectoId={proyecto.id} />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Encabezado({ subtitulo }: { subtitulo?: string }) {
  return (
    <header className="flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-100 shadow-sm flex-shrink-0">
      <a href="/dashboard" className="w-8 h-8 bg-gray-100 rounded-full flex items-center justify-center text-gray-500 hover:bg-gray-200">‹</a>
      <div className="w-8 h-8 bg-gradient-to-br from-teal-400 to-teal-600 rounded-xl flex items-center justify-center text-xs">✅</div>
      <div>
        <p className="font-bold text-gray-900 text-sm">Evaluación</p>
        <p className="text-xs text-gray-400">{subtitulo || 'Hojas de evaluación del grupo'}</p>
      </div>
    </header>
  )
}
