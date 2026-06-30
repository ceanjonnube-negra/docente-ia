'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@supabase/supabase-js'
import { useRouter } from 'next/navigation'

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']
const DIAS = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb']
type Evento = { id: string; titulo: string; fecha: string; tipo: string; color: string; descripcion: string; es_sep: boolean }

export default function CalendarioPage() {
  const router = useRouter()
  const hoy = new Date()
  const [mes, setMes] = useState(hoy.getMonth())
  const [anio, setAnio] = useState(hoy.getFullYear())
  const [eventos, setEventos] = useState<Evento[]>([])
  const [eventoSel, setEventoSel] = useState<Evento | null>(null)
  const [mostrarForm, setMostrarForm] = useState(false)
  const [nuevo, setNuevo] = useState({ titulo: '', fecha: '', descripcion: '' })

  useEffect(() => { cargarEventos() }, [mes, anio])

  const cargarEventos = async () => {
    const ini = `${anio}-${String(mes+1).padStart(2,'0')}-01`
    const fin = `${anio}-${String(mes+1).padStart(2,'0')}-31`
    const { data } = await supabase.from('calendario_eventos').select('*').gte('fecha', ini).lte('fecha', fin)
    if (data) setEventos(data)
  }

  const diasEnMes = new Date(anio, mes+1, 0).getDate()
  const primerDia = new Date(anio, mes, 1).getDay()
  const evsDia = (d: number) => { const f = `${anio}-${String(mes+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`; return eventos.filter(e => e.fecha.startsWith(f)) }

  const agregar = async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user || !nuevo.titulo || !nuevo.fecha) return
    await supabase.from('calendario_eventos').insert({ user_id: user.id, titulo: nuevo.titulo, fecha: nuevo.fecha, tipo: 'actividad', color: '#8b5cf6', descripcion: nuevo.descripcion, es_sep: false })
    setNuevo({ titulo: '', fecha: '', descripcion: '' })
    setMostrarForm(false)
    cargarEventos()
  }

  const ant = () => mes === 0 ? (setMes(11), setAnio(a => a-1)) : setMes(m => m-1)
  const sig = () => mes === 11 ? (setMes(0), setAnio(a => a+1)) : setMes(m => m+1)

  return (
    <div className="min-h-screen bg-gray-50 p-4">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center gap-3 mb-4">
          <button onClick={() => router.back()} className="text-gray-500 text-xl">←</button>
          <h1 className="text-2xl font-bold text-gray-800">📅 Calendario Escolar 2026-2027</h1>
        </div>
        <div className="flex flex-wrap gap-3 mb-4 text-sm">
          {[['#10b981','Inicio/Fin ciclo'],['#ef4444','Festivos'],['#f59e0b','CTE'],['#6366f1','Vacaciones'],['#8b5cf6','Mis actividades']].map(([c,l]) => (
            <div key={l} className="flex items-center gap-1"><div className="w-3 h-3 rounded-full" style={{backgroundColor:c}}/><span className="text-gray-600">{l}</span></div>
          ))}
        </div>
        <div className="bg-white rounded-2xl shadow p-4 mb-4">
          <div className="flex items-center justify-between mb-4">
            <button onClick={ant} className="p-2 hover:bg-gray-100 rounded-lg text-xl">‹</button>
            <h2 className="text-xl font-bold">{MESES[mes]} {anio}</h2>
            <button onClick={sig} className="p-2 hover:bg-gray-100 rounded-lg text-xl">›</button>
          </div>
          <div className="grid grid-cols-7 mb-2">{DIAS.map(d => <div key={d} className="text-center text-xs font-semibold text-gray-400 py-1">{d}</div>)}</div>
          <div className="grid grid-cols-7 gap-1">
            {Array.from({length:primerDia}).map((_,i) => <div key={i}/>)}
            {Array.from({length:diasEnMes}).map((_,i) => {
              const d = i+1; const evs = evsDia(d)
              const esHoy = d===hoy.getDate()&&mes===hoy.getMonth()&&anio===hoy.getFullYear()
              return <div key={d} onClick={() => evs.length>0&&setEventoSel(evs[0])} className={`p-1 rounded-lg text-center cursor-pointer hover:bg-gray-50 min-h-[40px] ${esHoy?'bg-blue-50 font-bold text-blue-600':'text-gray-700'}`}>
                <span className="text-sm">{d}</span>
                <div className="flex flex-wrap justify-center gap-0.5 mt-0.5">{evs.slice(0,3).map(e => <div key={e.id} className="w-1.5 h-1.5 rounded-full" style={{backgroundColor:e.color}}/>)}</div>
              </div>
            })}
          </div>
        </div>
        <div className="bg-white rounded-2xl shadow p-4 mb-4">
          <h3 className="font-semibold text-gray-700 mb-3">Eventos de {MESES[mes]}</h3>
          {eventos.length===0 ? <p className="text-gray-400 text-sm">Sin eventos este mes</p> :
            <div className="space-y-2">{eventos.sort((a,b)=>a.fecha.localeCompare(b.fecha)).map(e => (
              <div key={e.id} onClick={()=>setEventoSel(e)} className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-50 cursor-pointer">
                <div className="w-3 h-3 rounded-full" style={{backgroundColor:e.color}}/>
                <div><p className="text-sm font-medium">{e.titulo}</p><p className="text-xs text-gray-400">{new Date(e.fecha+'T12:00:00').toLocaleDateString('es-MX',{day:'numeric',month:'long'})}</p></div>
              </div>
            ))}</div>}
        </div>
        <button onClick={()=>setMostrarForm(true)} className="w-full py-3 bg-gradient-to-r from-purple-600 to-blue-500 text-white rounded-2xl font-semibold">+ Agregar actividad propia</button>
        {eventoSel && <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"><div className="bg-white rounded-2xl p-6 w-full max-w-sm">
          <div className="flex items-center gap-3 mb-3"><div className="w-4 h-4 rounded-full" style={{backgroundColor:eventoSel.color}}/><h3 className="font-bold">{eventoSel.titulo}</h3></div>
          <p className="text-sm text-gray-500">{new Date(eventoSel.fecha+'T12:00:00').toLocaleDateString('es-MX',{weekday:'long',day:'numeric',month:'long',year:'numeric'})}</p>
          {eventoSel.descripcion&&<p className="text-sm text-gray-600 mt-2">{eventoSel.descripcion}</p>}
          <button onClick={()=>setEventoSel(null)} className="mt-4 w-full py-2 bg-gray-100 rounded-xl text-gray-600">Cerrar</button>
        </div></div>}
        {mostrarForm && <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"><div className="bg-white rounded-2xl p-6 w-full max-w-sm">
          <h3 className="font-bold mb-4">Nueva actividad</h3>
          <input value={nuevo.titulo} onChange={e=>setNuevo(p=>({...p,titulo:e.target.value}))} placeholder="Título" className="w-full border rounded-xl px-3 py-2 mb-3 text-sm"/>
          <input type="date" value={nuevo.fecha} onChange={e=>setNuevo(p=>({...p,fecha:e.target.value}))} className="w-full border rounded-xl px-3 py-2 mb-3 text-sm"/>
          <textarea value={nuevo.descripcion} onChange={e=>setNuevo(p=>({...p,descripcion:e.target.value}))} placeholder="Descripción (opcional)" className="w-full border rounded-xl px-3 py-2 mb-4 text-sm h-20"/>
          <div className="flex gap-2">
            <button onClick={()=>setMostrarForm(false)} className="flex-1 py-2 bg-gray-100 rounded-xl text-sm">Cancelar</button>
            <button onClick={agregar} className="flex-1 py-2 bg-purple-600 text-white rounded-xl text-sm font-semibold">Guardar</button>
          </div>
        </div></div>}
      </div>
    </div>
  )
}
