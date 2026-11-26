'use client'

// Planeación (Hito 2, etapa 5a): biblioteca de solo lectura del trabajo
// pedagógico del grupo activo. El único Chat IA crea y modifica; aquí se
// organiza, conserva y consulta. Datos canónicos con la RLS del docente
// (lib/planeacion/vistaPlaneacion.ts) y aislamiento explícito por grupo.

import { Suspense, useCallback, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { useAsistente } from '@/lib/asistente/hooks'
import { resolverGrupoActivo, rotuloGrupo } from '@/lib/grupoActivo'
import type { EstadoCapturaHoja } from '@/lib/seguimiento/estadoCapturaHoja'
import { evaluacionConCriteriosDistintos } from '@/lib/planeacion/documentoVersion'
import {
  cargarDetallePlaneacion,
  cargarEstadosEvaluacion,
  cargarResumenPlaneaciones,
  ErrorVistaPlaneacion,
  type DetallePlaneacion as Detalle,
  type ResumenPlaneacion,
} from '@/lib/planeacion/vistaPlaneacion'
import ListaPlaneaciones, { Esqueleto } from '@/components/Planeacion/ListaPlaneaciones'
import DetallePlaneacion from '@/components/Planeacion/DetallePlaneacion'
import { IconoAtras, IconoBiblioteca } from '@/components/Planeacion/Iconos'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default function PlaneacionPage() {
  return (
    <Suspense fallback={<Esqueleto />}>
      <PlaneacionContenido />
    </Suspense>
  )
}

type Grupo = { id: string; rotulo: string }
type Sesion = { token: string; grupo: Grupo }

function Aviso({ titulo, texto, accion }: { titulo: string; texto: string; accion?: { etiqueta: string; onClick: () => void } }) {
  return (
    <div className="flex flex-col items-center text-center px-8 py-16">
      <div className="w-14 h-14 rounded-2xl bg-green-50 text-green-700 flex items-center justify-center mb-4">
        <IconoBiblioteca className="w-7 h-7" />
      </div>
      <p className="text-base font-semibold text-gray-900">{titulo}</p>
      <p className="mt-1.5 text-sm text-gray-500 max-w-xs">{texto}</p>
      {accion && (
        <button type="button" onClick={accion.onClick} className="mt-5 rounded-full bg-green-600 px-5 py-2 text-sm font-semibold text-white hover:bg-green-700">
          {accion.etiqueta}
        </button>
      )}
    </div>
  )
}

// Aviso de «Continuar en el Chat IA» (null: el Chat quedó abierto).
function avisoContinuar(r: 'listo' | 'ocupado' | 'otro_grupo' | 'no_disponible' | 'sesion' | 'error'): string | null {
  switch (r) {
    case 'listo': return null
    case 'ocupado': return 'El Chat IA está terminando una respuesta. Inténtalo en un momento.'
    case 'otro_grupo': return 'Esta planeación es de otro grupo. Cambia al grupo correspondiente para continuarla en el Chat IA.'
    case 'no_disponible': return 'Esta planeación ya no está disponible.'
    case 'sesion': return 'Tu sesión venció. Vuelve a iniciar sesión.'
    default: return 'No se pudo abrir el Chat IA. Inténtalo de nuevo.'
  }
}

function mensajeDe(e: unknown): string {
  return e instanceof ErrorVistaPlaneacion ? e.message : 'No se pudo cargar la información. Revisa tu conexión e inténtalo de nuevo.'
}

function PlaneacionContenido() {
  // Planeación es un módulo independiente — nunca se muestra con el Chat
  // IA abierto encima. cerrarPanel() solo afecta la visibilidad del panel.
  const asistente = useAsistente()
  useEffect(() => {
    asistente.cerrarPanel()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const router = useRouter()
  const parametro = useSearchParams().get('id')
  const planeacionId = parametro && UUID.test(parametro) ? parametro : null

  const [sesion, setSesion] = useState<Sesion | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sinGrupo, setSinGrupo] = useState(false)
  const [intento, setIntento] = useState(0)

  // Sesión y grupo activo (el mismo que Lista y Evaluación). Sin grupo
  // válido no se muestra nada (fail-closed).
  useEffect(() => {
    let vigente = true
    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      const { data: { user } } = await supabase.auth.getUser()
      if (!vigente) return
      if (!session || !user) { setError('Tu sesión expiró. Vuelve a iniciar sesión.'); return }
      const resolucion = await resolverGrupoActivo(supabase, user.id)
      if (!vigente) return
      if (!resolucion.ok) { setSinGrupo(true); return }
      const r = rotuloGrupo(resolucion.grupo)
      const rotulo = r.grado ? `${r.grado.replace(/°+$/, '')}° ${r.letra ?? ''}`.trim() : resolucion.grupo.nombre_grupo
      setSesion({ token: session.access_token, grupo: { id: resolucion.grupo.id, rotulo } })
    })().catch(() => { if (vigente) setError('No se pudo identificar tu grupo activo. Inténtalo de nuevo.') })
    return () => { vigente = false }
  }, [intento])

  const reintentar = useCallback(() => { setError(null); setSinGrupo(false); setSesion(null); setIntento((n) => n + 1) }, [])

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="sticky top-0 z-10 flex items-center gap-3 px-4 py-3 bg-white/95 backdrop-blur border-b border-gray-100">
        <button
          type="button"
          onClick={() => (planeacionId ? router.push('/dashboard/planeacion') : router.push('/dashboard'))}
          aria-label={planeacionId ? 'Volver a Planeación' : 'Volver al inicio'}
          className="w-8 h-8 rounded-full bg-gray-100 text-gray-600 flex items-center justify-center hover:bg-gray-200"
        >
          <IconoAtras className="w-4 h-4" />
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-900">Planeación</p>
          <p className="text-xs text-gray-500 truncate">{sesion ? `Grupo ${sesion.grupo.rotulo}` : ' '}</p>
        </div>
      </header>

      <main className="max-w-2xl mx-auto pb-[calc(7rem+env(safe-area-inset-bottom))]">
        {error ? (
          <Aviso titulo="No se pudo cargar" texto={error} accion={{ etiqueta: 'Reintentar', onClick: reintentar }} />
        ) : sinGrupo ? (
          <Aviso titulo="Sin grupo activo" texto="Selecciona o crea un grupo para ver sus planeaciones." accion={{ etiqueta: 'Ir a Grupos', onClick: () => router.push('/dashboard/grupos') }} />
        ) : !sesion ? (
          <Esqueleto />
        ) : planeacionId ? (
          <VistaDetalle key={planeacionId} sesion={sesion} planeacionId={planeacionId} onVolver={() => router.push('/dashboard/planeacion')} />
        ) : (
          <VistaLista sesion={sesion} onAbrir={(id) => router.push(`/dashboard/planeacion?id=${id}`)} onAbrirChat={() => asistente.abrirPanel()} />
        )}
      </main>
    </div>
  )
}

function VistaLista({ sesion, onAbrir, onAbrirChat }: { sesion: Sesion; onAbrir: (id: string) => void; onAbrirChat: () => void }) {
  const [planeaciones, setPlaneaciones] = useState<ResumenPlaneacion[] | null>(null)
  const [estados, setEstados] = useState<Record<string, EstadoCapturaHoja>>({})
  const [error, setError] = useState<string | null>(null)
  const [intento, setIntento] = useState(0)

  useEffect(() => {
    let vigente = true
    cargarResumenPlaneaciones(supabase, sesion.grupo.id)
      .then((lista) => {
        if (!vigente) return
        setPlaneaciones(lista)
        const proyectos = lista.map((p) => p.hoja?.proyectoId).filter((x): x is string => !!x)
        if (proyectos.length) void cargarEstadosEvaluacion(sesion.token, proyectos).then((e) => { if (vigente) setEstados(e) })
      })
      .catch((e) => { if (vigente) setError(mensajeDe(e)) })
    return () => { vigente = false }
  }, [sesion, intento])

  if (error) return <Aviso titulo="No se pudo cargar" texto={error} accion={{ etiqueta: 'Reintentar', onClick: () => { setError(null); setPlaneaciones(null); setIntento((n) => n + 1) } }} />
  if (!planeaciones) return <Esqueleto />
  if (planeaciones.length === 0) {
    return <Aviso titulo="Aún no hay planeaciones" texto={`Las planeaciones que apruebes en el Chat IA para el grupo ${sesion.grupo.rotulo} se guardarán aquí.`} accion={{ etiqueta: 'Abrir Chat IA', onClick: onAbrirChat }} />
  }
  return <ListaPlaneaciones planeaciones={planeaciones} estados={estados} onAbrir={onAbrir} />
}

function VistaDetalle({ sesion, planeacionId, onVolver }: { sesion: Sesion; planeacionId: string; onVolver: () => void }) {
  const asistente = useAsistente()
  const [detalle, setDetalle] = useState<Detalle | null | undefined>(undefined)
  const [numero, setNumero] = useState<number | null>(null)
  const [estados, setEstados] = useState<Record<string, EstadoCapturaHoja>>({})
  const [distintas, setDistintas] = useState<Record<string, string | null>>({})
  const [error, setError] = useState<string | null>(null)
  const [intento, setIntento] = useState(0)

  useEffect(() => {
    let vigente = true
    cargarDetallePlaneacion(supabase, sesion.grupo.id, planeacionId)
      .then((d) => {
        if (!vigente) return
        setDetalle(d)
        if (!d) return
        setNumero(d.versionVigente)
        const proyectos = d.versiones.map((v) => v.hoja?.proyectoId).filter((x): x is string => !!x)
        if (proyectos.length) void cargarEstadosEvaluacion(sesion.token, proyectos).then((e) => { if (vigente) setEstados(e) })
      })
      .catch((e) => { if (vigente) setError(mensajeDe(e)) })
    return () => { vigente = false }
  }, [sesion, planeacionId, intento])

  const version = detalle?.versiones.find((v) => v.numero === numero) ?? detalle?.versiones[0] ?? null

  // Aviso de evaluación protegida con criterios distintos (la misma regla
  // que la nota de los Word/PDF), una vez por versión consultada.
  useEffect(() => {
    if (!version?.hoja || version.id in distintas) return
    let vigente = true
    evaluacionConCriteriosDistintos(supabase, { hoja_id: version.hoja.id, estructura: version.estructura })
      .then((r) => { if (vigente) setDistintas((prev) => ({ ...prev, [version.id]: r?.codigo ?? null })) })
      .catch(() => { if (vigente) setDistintas((prev) => ({ ...prev, [version.id]: null })) })
    return () => { vigente = false }
  }, [version, distintas])

  if (error) return <Aviso titulo="No se pudo cargar" texto={error} accion={{ etiqueta: 'Reintentar', onClick: () => { setError(null); setDetalle(undefined); setIntento((n) => n + 1) } }} />
  if (detalle === undefined) return <Esqueleto />
  if (detalle === null || !version) {
    return <Aviso titulo="Planeación no disponible" texto={`Esta planeación no está entre las del grupo ${sesion.grupo.rotulo}.`} accion={{ etiqueta: 'Ver planeaciones', onClick: onVolver }} />
  }
  return (
    <div className="px-4 py-5">
      <DetallePlaneacion
        detalle={detalle}
        version={version}
        onSeleccionarVersion={(n) => { setNumero(n); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
        estadosHoja={estados}
        evaluacionDistinta={distintas[version.id] ?? null}
        onContinuarEnChat={async (versionId) => avisoContinuar(await asistente.continuarPlaneacion(versionId))}
        onArchivoGenerado={(versionId, formato) => setDetalle((d) => d && {
          ...d,
          versiones: d.versiones.map((v) => (v.id === versionId ? { ...v, ...(formato === 'word' ? { tieneWord: true } : { tienePdf: true }) } : v)),
        })}
      />
    </div>
  )
}
