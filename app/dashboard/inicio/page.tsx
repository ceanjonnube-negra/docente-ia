'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'


const toTitle = (s: string) => s ? s.toLowerCase().replace(/\w/g, c => c.toUpperCase()) : ''

export default function Dashboard() {
  const router = useRouter()
  const [perfil, setPerfil] = useState<any>(null)

  // NOTA: Inicio NO cierra el panel del Chat IA al montar. /dashboard/chat
  // abre el panel y luego hace router.replace('/dashboard/inicio') como
  // navegación suave — Inicio monta debajo de ese mismo cambio de ruta, así
  // que un cierre automático aquí cancelaba la apertura un instante después
  // de que ocurriera (el chat se abría y se cerraba solo). Ver
  // ARQUITECTURA DE NAVEGACIÓN DEL CHAT IA: el panel solo se cierra cuando
  // el propio docente lo decide.

  useEffect(() => {
    const cargar = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      const { data } = await supabase.from('perfiles_docentes').select('*').eq('id', user.id).single()
      if (data) setPerfil(data)
    }
    cargar()
  }, [])

  const salir = async () => { await supabase.auth.signOut(); router.push('/') }

  return (
    <div className="min-h-screen flex flex-col items-center px-4 py-6" style={{backgroundColor: '#8BC34A'}}>
      {/* Header */}
      <div className="w-full max-w-sm flex justify-end mb-4">
        <button onClick={salir} className="w-10 h-10 bg-white/80 rounded-full flex items-center justify-center shadow text-lg">⚙️</button>
      </div>

      {/* Tarjeta maestro */}
      <div className="w-full max-w-sm bg-white/90 rounded-3xl p-4 mb-6 shadow-lg">
        <div className="flex items-center gap-3">
          <div className="w-14 h-14 rounded-full bg-green-100 border-4 border-green-400 flex items-center justify-center text-2xl flex-shrink-0">👨‍🏫</div>
          <div className="flex-1">
            <p className="text-xs text-green-600 font-semibold">Maestro</p>
            <p className="font-bold text-gray-800 text-sm leading-tight">{(perfil?.nombre || 'Cargando...').split(' ').map((w:string)=>w.charAt(0).toUpperCase()+w.slice(1).toLowerCase()).join(' ')}</p>
            <p className="text-xs text-gray-400">Maestro de Grupo</p>
          </div>
          <div className="w-px h-10 bg-gray-200"/>
          <div className="flex-1">
            <div className="flex items-center gap-1">
              <span className="text-base">🏫</span>
              <div>
                <p className="text-xs text-green-600 font-semibold">Escuela</p>
                <p className="font-bold text-gray-800 text-xs leading-tight">{(perfil?.escuela || '...').split(' ').map((w:string)=>w.charAt(0).toUpperCase()+w.slice(1).toLowerCase()).join(' ')}</p>
              </div>
            </div>
            <p className="text-xs text-gray-400 mt-1">🎓 {perfil?.grado ? `${perfil.grado}° ${perfil.grupo || ''}` : '...'}</p>
            <p className="text-xs text-gray-400">📍 {(perfil?.municipio||'').split(' ').map((w:string)=>w.charAt(0).toUpperCase()+w.slice(1).toLowerCase()).join(' ')}{perfil?.estado ? `, ${(perfil.estado).split(' ').map((w:string)=>w.charAt(0).toUpperCase()+w.slice(1).toLowerCase()).join(' ')}` : ''}</p>
          </div>
        </div>
      </div>

      {/* Rueda */}
      <div className="relative mb-6" style={{width:'300px', height:'300px'}}>
        <svg width="300" height="300" viewBox="0 0 300 300" className="absolute inset-0">
          <path d="M150,150 L253,47 A145,145 0 0,1 253,253 Z" fill="#F44336"/>
          <path d="M150,150 L253,253 A145,145 0 0,1 47,253 Z" fill="#2196F3"/>
          <path d="M150,150 L47,253 A145,145 0 0,1 47,47 Z" fill="#4CAF50"/>
          <path d="M150,150 L47,47 A145,145 0 0,1 253,47 Z" fill="#FFC107"/>
          <line x1="47" y1="47" x2="253" y2="253" stroke="white" strokeWidth="5"/>
          <line x1="253" y1="47" x2="47" y2="253" stroke="white" strokeWidth="5"/>
          <circle cx="150" cy="150" r="145" fill="none" stroke="white" strokeWidth="5"/>
          <circle cx="150" cy="150" r="68" fill="white" stroke="#e5e7eb" strokeWidth="2"/>
        </svg>

        {/* Planeación - arriba */}
        <a href="/dashboard/chat?tipo=planeacion" className="absolute flex flex-col items-center gap-0.5 cursor-pointer" style={{top:'18px',left:'50%',transform:'translateX(-50%)'}}>
          <div className="w-11 h-11 bg-white rounded-full flex items-center justify-center shadow-md text-xl">📋</div>
          <span className="text-white font-bold text-xs drop-shadow-md">Planeación</span>
        </a>

        {/* Calendario - derecha */}
        <a href="/dashboard/calendario" className="absolute flex flex-col items-center gap-0.5 cursor-pointer" style={{top:'50%',right:'18px',transform:'translateY(-50%) translateX(0)'}}>
          <div className="w-11 h-11 bg-white rounded-full flex items-center justify-center shadow-md text-xl">📅</div>
          <span className="text-white font-bold text-xs drop-shadow-md">Calendario</span>
        </a>

        {/* Alumnos - abajo (Asistencia y Seguimiento viven dentro de Lista, no como pantallas aparte) */}
        <a href="/dashboard/lista" className="absolute flex flex-col items-center gap-0.5 cursor-pointer" style={{bottom:'18px',left:'50%',transform:'translateX(-50%)'}}>
          <div className="w-11 h-11 bg-white rounded-full flex items-center justify-center shadow-md text-xl">📝</div>
          <span className="text-white font-bold text-xs drop-shadow-md">Lista</span>
        </a>

        {/* Asistencia - izquierda (vive dentro de Lista, no como pantalla aparte) */}
        <a href="/dashboard/lista" className="absolute flex flex-col items-center gap-0.5 cursor-pointer" style={{top:'50%',left:'18px',transform:'translateY(-50%) translateX(0)'}}>
          <div className="w-11 h-11 bg-white rounded-full flex items-center justify-center shadow-md text-xl">✅</div>
          <span className="text-white font-bold text-xs drop-shadow-md">Lista</span>
        </a>

        {/* Centro Chat IA */}
        <a href="/dashboard/chat" className="absolute flex items-center justify-center cursor-pointer" style={{inset:0}}>
          <div className="w-32 h-32 rounded-full shadow-xl overflow-hidden border-2 border-gray-100">
            <img src="/logo.png" alt="Docente IA" className="w-full h-full object-cover"/>
          </div>
        </a>
      </div>

      {/* Lista */}
      <a href="/dashboard/lista" className="w-full max-w-sm bg-white/90 rounded-2xl px-5 py-4 flex items-center justify-between shadow mb-3">
        <div className="flex items-center gap-3">
          <span className="text-2xl">📝</span>
          <span className="font-bold text-gray-700">Lista</span>
        </div>
        <span className="text-gray-400 text-xl">›</span>
      </a>

      {/* Historial */}
      <a href="/dashboard/historial" className="w-full max-w-sm bg-white/90 rounded-2xl px-5 py-4 flex items-center justify-between shadow">
        <div className="flex items-center gap-3">
          <span className="text-2xl">🕐</span>
          <span className="font-bold text-gray-700">Historial</span>
        </div>
        <span className="text-gray-400 text-xl">›</span>
      </a>
    </div>
  )
}
