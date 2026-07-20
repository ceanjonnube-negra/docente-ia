'use client'

import { useState, useEffect, useRef } from 'react'
import { createClient } from '@supabase/supabase-js'
import { formatearFecha, obtenerFechaHora, obtenerZonaHorariaDispositivo } from '@/lib/tiempo/TimeService'
import { useAsistente } from '@/lib/asistente/hooks'

// Perfeccionamiento visual/interactivo del Calendario — RFC-CALENDAR-001,
// etapa 1. Usa EXCLUSIVAMENTE la tabla calendario_eventos ya existente
// (id, user_id, titulo, fecha, tipo, color, descripcion, es_sep) — no se
// agregó ninguna columna ni tabla nueva. El Chat IA sigue en modo
// SOLO LECTURA sobre este mismo calendario (ver calendarioProximo() en
// lib/motorContexto.ts, ya existente, sin cambios) — crear/editar/
// eliminar eventos por chat, recordatorios, documentos adjuntos y
// repetición quedan para una etapa 2 que sí amplía la base de datos.
//
// La única escritura NUEVA que se agregó aquí es Editar/Eliminar de una
// actividad propia (es_sep=false) — reutiliza la misma tabla que ya
// recibía INSERT, ahora también UPDATE/DELETE; no es una tabla nueva.

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']
const DIAS = ['D', 'L', 'M', 'M', 'J', 'V', 'S']

type Evento = { id: string; titulo: string; fecha: string; tipo: string; color: string; descripcion: string; es_sep: boolean; user_id: string | null }
type FormActividad = { titulo: string; fecha: string; descripcion: string }
const FORM_VACIO: FormActividad = { titulo: '', fecha: '', descripcion: '' }

// Categoría legible + ícono a partir de datos que YA existen (es_sep +
// tipo) — nunca se inventa un campo nuevo, solo se interpreta el que
// ya hay. Coincide con la paleta que ya usaba el calendario.
function categoriaDe(e: Pick<Evento, 'tipo' | 'es_sep'>): { etiqueta: string; icono: string } {
  const t = (e.tipo || '').toLowerCase()
  if (!e.es_sep) return { etiqueta: 'Actividad propia', icono: '👤' }
  if (t.includes('inicio') || t.includes('fin')) return { etiqueta: 'Inicio/fin de ciclo', icono: '🎓' }
  if (t.includes('festiv')) return { etiqueta: 'Festivo', icono: '🎉' }
  if (t.includes('cte')) return { etiqueta: 'CTE', icono: '📚' }
  if (t.includes('vacacion')) return { etiqueta: 'Vacaciones', icono: '🏖️' }
  if (t.includes('consejo')) return { etiqueta: 'Consejo técnico', icono: '🗂️' }
  if (t.includes('suspension') || t.includes('suspensión')) return { etiqueta: 'Suspensión de labores', icono: '⛔' }
  return { etiqueta: e.tipo || 'Evento oficial', icono: '📌' }
}

export default function CalendarioPage() {
  const hoy = new Date()
  const [mes, setMes] = useState(hoy.getMonth())
  const [anio, setAnio] = useState(hoy.getFullYear())
  const [eventos, setEventos] = useState<Evento[]>([])
  const [cargando, setCargando] = useState(true)
  const [transicion, setTransicion] = useState(false)

  // Ventana amplia (ciclo escolar completo) solo para poblar filtros y
  // búsqueda con categorías/eventos reales, sin importar el mes que se
  // esté viendo — la grilla del mes sigue usando `eventos` (arriba),
  // sin cambios de comportamiento.
  const [eventosCiclo, setEventosCiclo] = useState<Evento[]>([])

  const [eventoSel, setEventoSel] = useState<Evento | null>(null)
  const [mostrarForm, setMostrarForm] = useState(false)
  const [actividadEditando, setActividadEditando] = useState<Evento | null>(null)
  const [nuevo, setNuevo] = useState<FormActividad>(FORM_VACIO)
  const [confirmandoEliminar, setConfirmandoEliminar] = useState(false)

  const [busquedaAbierta, setBusquedaAbierta] = useState(false)
  const [busqueda, setBusqueda] = useState('')
  const [filtrosAbiertos, setFiltrosAbiertos] = useState(false)
  const [categoriasInactivas, setCategoriasInactivas] = useState<Set<string>>(new Set())

  const touchInicioX = useRef<number | null>(null)

  // Calendario es un módulo independiente — nunca debe mostrarse con el
  // Chat IA abierto encima, sin importar cómo se llegó aquí (ver
  // ARQUITECTURA DE NAVEGACIÓN DEL CHAT IA). cerrarPanel() solo afecta
  // la visibilidad del panel, nunca la conversación guardada.
  const asistente = useAsistente()
  useEffect(() => {
    asistente.cerrarPanel()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const cargarEventos = async () => {
    setCargando(true)
    const ini = `${anio}-${String(mes + 1).padStart(2, '0')}-01`
    const fin = `${anio}-${String(mes + 1).padStart(2, '0')}-31`
    const { data } = await supabase.from('calendario_eventos').select('*').gte('fecha', ini).lte('fecha', fin)
    if (data) setEventos(data)
    setCargando(false)
  }

  // Mismo patrón de consulta que cargarEventos(), solo con un rango más
  // amplio (el ciclo escolar completo, mismo cálculo que ya usa
  // lib/tiempo/TimeService.ts en el resto de la app) — para que
  // búsqueda y filtros conozcan categorías/eventos que no están en el
  // mes que se está viendo ahora mismo.
  const cargarCiclo = async () => {
    const { anio: anioBase, mes: mesBase } = obtenerFechaHora(obtenerZonaHorariaDispositivo())
    const inicioCiclo = mesBase >= 8 ? anioBase : anioBase - 1
    const ini = `${inicioCiclo}-08-01`
    const fin = `${inicioCiclo + 1}-07-31`
    const { data } = await supabase.from('calendario_eventos').select('*').gte('fecha', ini).lte('fecha', fin)
    if (data) setEventosCiclo(data)
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect -- sincroniza con Supabase (sistema externo) al cambiar de mes, no con estado derivado de props.
  useEffect(() => { cargarEventos() }, [mes, anio])
  // eslint-disable-next-line react-hooks/set-state-in-effect -- sincroniza con Supabase (sistema externo) una sola vez al montar.
  useEffect(() => { cargarCiclo() }, [])

  const diasEnMes = new Date(anio, mes + 1, 0).getDate()
  const primerDia = new Date(anio, mes, 1).getDay()
  const evsDia = (d: number) => {
    const f = `${anio}-${String(mes + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    return eventos.filter(e => e.fecha.startsWith(f) && !categoriasInactivas.has(categoriaDe(e).etiqueta))
  }

  const cambiarMes = (delta: number) => {
    setTransicion(true)
    if (mes + delta < 0) { setMes(11); setAnio(a => a - 1) }
    else if (mes + delta > 11) { setMes(0); setAnio(a => a + 1) }
    else setMes(m => m + delta)
    setTimeout(() => setTransicion(false), 180)
  }
  const irAHoy = () => { setMes(hoy.getMonth()); setAnio(hoy.getFullYear()) }
  const viendoMesActual = mes === hoy.getMonth() && anio === hoy.getFullYear()

  const onTouchStart = (e: React.TouchEvent) => { touchInicioX.current = e.touches[0].clientX }
  const onTouchEnd = (e: React.TouchEvent) => {
    if (touchInicioX.current === null) return
    const delta = e.changedTouches[0].clientX - touchInicioX.current
    if (Math.abs(delta) > 55) cambiarMes(delta > 0 ? -1 : 1)
    touchInicioX.current = null
  }

  const agregar = async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user || !nuevo.titulo || !nuevo.fecha) return
    await supabase.from('calendario_eventos').insert({ user_id: user.id, titulo: nuevo.titulo, fecha: nuevo.fecha, tipo: 'actividad', color: '#8b5cf6', descripcion: nuevo.descripcion, es_sep: false })
    cerrarFormulario()
    cargarEventos()
    cargarCiclo()
  }

  // Único par de operaciones nuevas de escritura de esta etapa — misma
  // tabla, mismos campos, solo UPDATE/DELETE en vez de únicamente
  // INSERT. Nunca toca eventos oficiales (es_sep=true): el botón de
  // Editar/Eliminar solo aparece para actividades propias (ver tarjeta
  // de detalle).
  const actualizarActividad = async () => {
    if (!actividadEditando || !nuevo.titulo || !nuevo.fecha) return
    await supabase.from('calendario_eventos')
      .update({ titulo: nuevo.titulo, fecha: nuevo.fecha, descripcion: nuevo.descripcion })
      .eq('id', actividadEditando.id)
    cerrarFormulario()
    cargarEventos()
    cargarCiclo()
  }

  const eliminarActividad = async () => {
    if (!eventoSel) return
    await supabase.from('calendario_eventos').delete().eq('id', eventoSel.id)
    setEventoSel(null)
    setConfirmandoEliminar(false)
    cargarEventos()
    cargarCiclo()
  }

  const abrirEdicion = (e: Evento) => {
    setActividadEditando(e)
    setNuevo({ titulo: e.titulo, fecha: e.fecha.slice(0, 10), descripcion: e.descripcion || '' })
    setEventoSel(null)
    setMostrarForm(true)
  }
  const cerrarFormulario = () => {
    setMostrarForm(false)
    setActividadEditando(null)
    setNuevo(FORM_VACIO)
  }

  // Categorías reales, derivadas del ciclo completo (no solo del mes
  // visible) — nunca una lista fija adivinada, siempre lo que de
  // verdad hay en calendario_eventos.
  const categoriasDisponibles = Array.from(
    new Map(eventosCiclo.map(e => { const c = categoriaDe(e); return [c.etiqueta, { ...c, color: e.color }] })).values()
  )
  const toggleCategoria = (etiqueta: string) => {
    setCategoriasInactivas(prev => {
      const copia = new Set(prev)
      if (copia.has(etiqueta)) copia.delete(etiqueta); else copia.add(etiqueta)
      return copia
    })
  }

  const resultadosBusqueda = busqueda.trim().length > 0
    ? eventosCiclo
        .filter(e => `${e.titulo} ${e.descripcion} ${categoriaDe(e).etiqueta}`.toLowerCase().includes(busqueda.trim().toLowerCase()))
        .sort((a, b) => a.fecha.localeCompare(b.fecha))
        .slice(0, 20)
    : []

  const irAEvento = (e: Evento) => {
    const f = new Date(e.fecha)
    setMes(f.getMonth())
    setAnio(f.getFullYear())
    setEventoSel(e)
    setBusqueda('')
    setBusquedaAbierta(false)
  }

  const eventosDelMesFiltrados = eventos
    .filter(e => !categoriasInactivas.has(categoriaDe(e).etiqueta))
    .sort((a, b) => a.fecha.localeCompare(b.fecha))

  return (
    <div className="min-h-screen bg-gray-50 pb-28">
      <div className="max-w-4xl mx-auto p-4">
        {/* Encabezado */}
        <div className="flex items-center justify-between gap-3 mb-5">
          <div className="flex items-center gap-3">
            <a href="/dashboard" className="text-gray-400 text-xl hover:text-gray-600 transition-colors">←</a>
            <div>
              <h1 className="text-xl font-black text-gray-900">📅 Calendario Escolar</h1>
              <p className="text-xs text-gray-400">{obtenerFechaHora(obtenerZonaHorariaDispositivo()).cicloEscolar}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setBusquedaAbierta(v => !v); setFiltrosAbiertos(false) }}
              aria-label="Buscar"
              className={`w-10 h-10 rounded-full flex items-center justify-center text-lg transition-colors ${busquedaAbierta ? 'bg-purple-600 text-white' : 'bg-white text-gray-500 shadow-sm hover:bg-gray-100'}`}
            >🔍</button>
            <button
              onClick={() => { setFiltrosAbiertos(v => !v); setBusquedaAbierta(false) }}
              aria-label="Filtros"
              className={`w-10 h-10 rounded-full flex items-center justify-center text-lg transition-colors relative ${filtrosAbiertos ? 'bg-purple-600 text-white' : 'bg-white text-gray-500 shadow-sm hover:bg-gray-100'}`}
            >
              🎚️
              {categoriasInactivas.size > 0 && <span className="absolute -top-0.5 -right-0.5 w-3 h-3 bg-red-500 rounded-full border-2 border-gray-50" />}
            </button>
          </div>
        </div>

        {/* Pregúntale al Chat IA — integración visual, siempre de solo
            lectura (ver calendarioProximo en lib/motorContexto.ts). */}
        <button
          onClick={() => asistente.abrirPanel()}
          className="w-full mb-4 flex items-center gap-2.5 bg-white rounded-2xl shadow-sm px-4 py-3 text-left hover:shadow-md transition-shadow border border-gray-100"
        >
          <div className="w-8 h-8 bg-gradient-to-br from-purple-600 to-blue-500 rounded-xl flex items-center justify-center text-xs flex-shrink-0"><img src="/logo.png" alt="" className="w-full h-full object-contain rounded-xl" /></div>
          <p className="text-sm text-gray-500 flex-1">Pregúntale al Chat IA: <span className="text-gray-700 font-medium">&quot;¿Qué sigue esta semana?&quot;</span></p>
          <span className="text-gray-300">›</span>
        </button>

        {/* Búsqueda */}
        {busquedaAbierta && (
          <div className="bg-white rounded-2xl shadow-sm p-3 mb-4 border border-gray-100 animate-[fadeIn_.15s_ease-out]">
            <input
              autoFocus
              value={busqueda}
              onChange={e => setBusqueda(e.target.value)}
              placeholder="Buscar: CTE, vacaciones, consejo, suspensión..."
              className="w-full text-sm px-3 py-2 rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-purple-400"
            />
            {resultadosBusqueda.length > 0 && (
              <div className="mt-2 max-h-64 overflow-y-auto space-y-1">
                {resultadosBusqueda.map(e => {
                  const c = categoriaDe(e)
                  return (
                    <button key={e.id} onClick={() => irAEvento(e)} className="w-full flex items-center gap-2.5 p-2 rounded-xl hover:bg-gray-50 text-left">
                      <span className="text-base">{c.icono}</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-gray-800 truncate">{e.titulo}</p>
                        <p className="text-xs text-gray-400">{formatearFecha(e.fecha, obtenerZonaHorariaDispositivo(), { day: 'numeric', month: 'long' })}</p>
                      </div>
                      <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: e.color }} />
                    </button>
                  )
                })}
              </div>
            )}
            {busqueda.trim() && resultadosBusqueda.length === 0 && <p className="text-xs text-gray-400 mt-2 px-1">Sin resultados para &quot;{busqueda}&quot;.</p>}
          </div>
        )}

        {/* Filtros — la misma leyenda de colores ahora es interactiva */}
        {filtrosAbiertos && (
          <div className="bg-white rounded-2xl shadow-sm p-3.5 mb-4 border border-gray-100 animate-[fadeIn_.15s_ease-out]">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2.5">Mostrar en el calendario</p>
            <div className="flex flex-wrap gap-2">
              {categoriasDisponibles.map(c => {
                const activo = !categoriasInactivas.has(c.etiqueta)
                return (
                  <button
                    key={c.etiqueta}
                    onClick={() => toggleCategoria(c.etiqueta)}
                    className={`flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full border transition-all ${activo ? 'border-transparent text-white' : 'border-gray-200 text-gray-400 bg-gray-50'}`}
                    style={activo ? { backgroundColor: c.color } : undefined}
                  >
                    <span>{activo ? '✓' : ''}</span>{c.icono} {c.etiqueta}
                  </button>
                )
              })}
              {categoriasDisponibles.length === 0 && <p className="text-xs text-gray-400">Sin eventos registrados todavía.</p>}
            </div>
          </div>
        )}

        {/* Calendario — 20-25% más grande que antes (celdas min-h-14 en
            vez de 40px, tipografía y separación mayores) */}
        <div className="bg-white rounded-3xl shadow-md p-5 mb-4 border border-gray-100">
          <div className="flex items-center justify-between mb-5">
            <button onClick={() => cambiarMes(-1)} aria-label="Mes anterior" className="w-11 h-11 flex items-center justify-center text-2xl text-gray-500 bg-gray-50 rounded-2xl hover:bg-gray-100 active:scale-95 transition-all">‹</button>
            <div className="text-center">
              <h2 className="text-xl font-black text-gray-900">{MESES[mes]}</h2>
              <p className="text-xs text-gray-400 font-medium">{anio}</p>
            </div>
            <button onClick={() => cambiarMes(1)} aria-label="Mes siguiente" className="w-11 h-11 flex items-center justify-center text-2xl text-gray-500 bg-gray-50 rounded-2xl hover:bg-gray-100 active:scale-95 transition-all">›</button>
          </div>

          <div className="grid grid-cols-7 mb-1">
            {DIAS.map((d, i) => <div key={i} className="text-center text-[11px] font-bold text-gray-300 py-1">{d}</div>)}
          </div>

          <div
            onTouchStart={onTouchStart}
            onTouchEnd={onTouchEnd}
            className={`grid grid-cols-7 gap-1.5 transition-opacity duration-150 ${transicion ? 'opacity-0' : 'opacity-100'} ${cargando ? 'opacity-40' : ''}`}
          >
            {Array.from({ length: primerDia }).map((_, i) => <div key={`v-${i}`} />)}
            {Array.from({ length: diasEnMes }).map((_, i) => {
              const d = i + 1
              const evs = evsDia(d)
              const esHoy = d === hoy.getDate() && mes === hoy.getMonth() && anio === hoy.getFullYear()
              return (
                <button
                  key={d}
                  onClick={() => evs.length > 0 && setEventoSel(evs[0])}
                  className={`relative min-h-[52px] rounded-2xl flex flex-col items-center justify-start pt-1.5 transition-all active:scale-95 ${evs.length > 0 ? 'hover:bg-gray-50 cursor-pointer' : 'cursor-default'}`}
                >
                  {esHoy ? (
                    <span className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-600 to-blue-500 text-white text-sm font-bold flex items-center justify-center shadow-sm shadow-purple-200">{d}</span>
                  ) : (
                    <span className="text-sm text-gray-700 font-medium w-8 h-8 flex items-center justify-center">{d}</span>
                  )}
                  <div className="flex justify-center gap-0.5 mt-1 h-1.5">
                    {evs.slice(0, 3).map(e => <span key={e.id} className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: e.color }} />)}
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        {/* Eventos del mes, como tarjetas */}
        <div className="bg-white rounded-3xl shadow-md p-5 mb-4 border border-gray-100">
          <h3 className="font-bold text-gray-800 mb-3">Eventos de {MESES[mes]}</h3>
          {eventosDelMesFiltrados.length === 0 ? (
            <p className="text-gray-400 text-sm py-2">Sin eventos que mostrar {categoriasInactivas.size > 0 ? 'con los filtros activos' : 'este mes'}.</p>
          ) : (
            <div className="space-y-2">
              {eventosDelMesFiltrados.map(e => {
                const c = categoriaDe(e)
                return (
                  <button key={e.id} onClick={() => setEventoSel(e)} className="w-full flex items-center gap-3 p-2.5 rounded-2xl hover:bg-gray-50 transition-colors text-left active:scale-[0.99]">
                    <div className="w-10 h-10 rounded-2xl flex items-center justify-center text-base flex-shrink-0" style={{ backgroundColor: `${e.color}1A` }}>{c.icono}</div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-gray-800 truncate">{e.titulo}</p>
                      <div className="flex items-center gap-1.5 text-xs text-gray-400">
                        <span>{formatearFecha(e.fecha, obtenerZonaHorariaDispositivo(), { day: 'numeric', month: 'long' })}</span>
                        <span>·</span>
                        <span style={{ color: e.color }} className="font-medium">{c.etiqueta}</span>
                      </div>
                      {e.descripcion && <p className="text-xs text-gray-400 truncate mt-0.5">{e.descripcion}</p>}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <button onClick={() => setMostrarForm(true)} className="w-full py-3.5 bg-gradient-to-r from-purple-600 to-blue-500 text-white rounded-2xl font-bold shadow-md shadow-purple-200 hover:opacity-90 active:scale-[0.99] transition-all">
          + Agregar actividad propia
        </button>
      </div>

      {/* Botón flotante "Hoy" — solo cuando no se está viendo el mes actual */}
      {!viendoMesActual && (
        <button
          onClick={irAHoy}
          className="fixed bottom-24 right-5 z-40 bg-gray-900 text-white text-sm font-bold px-5 py-3 rounded-full shadow-lg hover:bg-gray-800 active:scale-95 transition-all flex items-center gap-1.5"
        >
          📍 Hoy
        </button>
      )}

      {/* Tarjeta de detalle del día */}
      {eventoSel && (
        <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4" onClick={() => { setEventoSel(null); setConfirmandoEliminar(false) }}>
          <div onClick={e => e.stopPropagation()} className="bg-white rounded-t-3xl sm:rounded-3xl p-6 w-full max-w-sm shadow-2xl animate-[slideUp_.2s_ease-out]">
            <div className="w-10 h-1 bg-gray-200 rounded-full mx-auto mb-4 sm:hidden" />
            {(() => {
              const c = categoriaDe(eventoSel)
              return (
                <>
                  <div className="flex items-start gap-3 mb-1">
                    <div className="w-11 h-11 rounded-2xl flex items-center justify-center text-xl flex-shrink-0" style={{ backgroundColor: `${eventoSel.color}1A` }}>{c.icono}</div>
                    <div className="min-w-0 flex-1 pt-1">
                      <h3 className="font-bold text-gray-900 leading-snug">{eventoSel.titulo}</h3>
                      <p className="text-xs font-semibold mt-0.5" style={{ color: eventoSel.color }}>{c.etiqueta}</p>
                    </div>
                  </div>
                  <p className="text-sm text-gray-500 mt-3 capitalize">{formatearFecha(eventoSel.fecha, obtenerZonaHorariaDispositivo(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>
                  {eventoSel.descripcion && (
                    <div className="mt-3 bg-gray-50 rounded-2xl p-3">
                      <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-1">Descripción</p>
                      <p className="text-sm text-gray-600 leading-relaxed">{eventoSel.descripcion}</p>
                    </div>
                  )}
                </>
              )
            })()}

            {!eventoSel.es_sep && (
              confirmandoEliminar ? (
                <div className="mt-5 bg-red-50 rounded-2xl p-3.5">
                  <p className="text-sm text-red-700 font-medium mb-3">¿Eliminar esta actividad? No se puede deshacer.</p>
                  <div className="flex gap-2">
                    <button onClick={() => setConfirmandoEliminar(false)} className="flex-1 py-2 bg-white rounded-xl text-sm font-semibold text-gray-600 border border-gray-200">Cancelar</button>
                    <button onClick={eliminarActividad} className="flex-1 py-2 bg-red-600 text-white rounded-xl text-sm font-semibold">Sí, eliminar</button>
                  </div>
                </div>
              ) : (
                <div className="flex gap-2 mt-5">
                  <button onClick={() => abrirEdicion(eventoSel)} className="flex-1 py-2.5 bg-gray-100 rounded-xl text-sm font-semibold text-gray-700 hover:bg-gray-200 transition-colors">✏️ Editar</button>
                  <button onClick={() => setConfirmandoEliminar(true)} className="flex-1 py-2.5 bg-red-50 rounded-xl text-sm font-semibold text-red-600 hover:bg-red-100 transition-colors">🗑️ Eliminar</button>
                </div>
              )
            )}

            <button onClick={() => { setEventoSel(null); setConfirmandoEliminar(false) }} className="mt-3 w-full py-2.5 text-gray-400 text-sm font-medium">Cerrar</button>
          </div>
        </div>
      )}

      {/* Agregar / Editar actividad propia — mismo formulario para ambos */}
      {mostrarForm && (
        <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4" onClick={cerrarFormulario}>
          <div onClick={e => e.stopPropagation()} className="bg-white rounded-t-3xl sm:rounded-3xl p-6 w-full max-w-sm shadow-2xl animate-[slideUp_.2s_ease-out]">
            <div className="w-10 h-1 bg-gray-200 rounded-full mx-auto mb-4 sm:hidden" />
            <h3 className="font-bold text-gray-900 mb-4">{actividadEditando ? 'Editar actividad' : 'Nueva actividad'}</h3>
            <input value={nuevo.titulo} onChange={e => setNuevo(p => ({ ...p, titulo: e.target.value }))} placeholder="Título" className="w-full border border-gray-200 rounded-2xl px-3.5 py-2.5 mb-3 text-sm focus:outline-none focus:ring-2 focus:ring-purple-400" />
            <input type="date" value={nuevo.fecha} onChange={e => setNuevo(p => ({ ...p, fecha: e.target.value }))} className="w-full border border-gray-200 rounded-2xl px-3.5 py-2.5 mb-3 text-sm focus:outline-none focus:ring-2 focus:ring-purple-400" />
            <textarea value={nuevo.descripcion} onChange={e => setNuevo(p => ({ ...p, descripcion: e.target.value }))} placeholder="Descripción (opcional)" className="w-full border border-gray-200 rounded-2xl px-3.5 py-2.5 mb-4 text-sm h-20 focus:outline-none focus:ring-2 focus:ring-purple-400" />
            <div className="flex gap-2">
              <button onClick={cerrarFormulario} className="flex-1 py-2.5 bg-gray-100 rounded-2xl text-sm font-semibold text-gray-600">Cancelar</button>
              <button onClick={actividadEditando ? actualizarActividad : agregar} className="flex-1 py-2.5 bg-purple-600 text-white rounded-2xl text-sm font-bold hover:bg-purple-700 transition-colors">{actividadEditando ? 'Guardar cambios' : 'Guardar'}</button>
            </div>
          </div>
        </div>
      )}

      <style jsx global>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes slideUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
    </div>
  )
}
