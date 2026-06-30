'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
 process.env.NEXT_PUBLIC_SUPABASE_URL!,
 process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

export default function Dashboard() {
 const [perfil, setPerfil] = useState<any>(null)
 const [hora, setHora] = useState('')

 useEffect(() => {
   const h = new Date().getHours()
   if (h < 12) setHora('Buenos días')
   else if (h < 19) setHora('Buenas tardes')
   else setHora('Buenas noches')

   const cargar = async () => {
     const { data: { user } } = await supabase.auth.getUser()
     if (!user) return
     const { data } = await supabase
       .from('perfiles_docentes')
       .select('*')
       .eq('user_id', user.id)
       .single()
     if (data) setPerfil(data)
   }
   cargar()
 }, [])

 const nombre = perfil?.nombre?.split(' ')[0]?.toUpperCase() || 'MAESTRO'
 const escuela = perfil?.escuela || ''
 const grado = perfil?.grado || ''
 const grupo = perfil?.grupo || ''

 return (
   <div className="min-h-screen bg-gray-50">
     {/* Header */}
     <div style={{background: 'linear-gradient(135deg, #6C3FE8, #3B82F6)'}} className="px-5 pt-14 pb-6">
       <p className="text-white/70 text-sm mb-1">{hora}</p>
       <h1 className="text-white text-3xl font-black tracking-tight">{nombre} 👋</h1>
       <p className="text-white/70 text-sm mt-1">{escuela} · {grado}°{grupo}</p>

       <a href="/dashboard/chat" className="flex items-center gap-3 mt-5 bg-white/15 rounded-2xl px-4 py-3">
         <span className="text-2xl">🤖</span>
         <div>
           <p className="text-white font-semibold text-sm">¿Qué necesitas hoy, maestro?</p>
           <p className="text-white/60 text-xs">Toca para abrir el asistente IA</p>
         </div>
       </a>
     </div>

     <div className="px-4 py-6 space-y-5">
       {/* Accesos rápidos */}
       <div>
         <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">Accesos rápidos</p>
         <div className="grid grid-cols-3 gap-3">
           <a href="/dashboard/chat?tipo=planeacion" className="bg-purple-50 rounded-2xl p-4 text-center">
             <div className="text-3xl mb-2">📋</div>
             <p className="text-xs font-bold text-gray-800">Planeación</p>
             <p className="text-xs text-gray-400 mt-0.5">Semanal / diaria</p>
           </a>
           <a href="/dashboard/asistencia" className="bg-green-50 rounded-2xl p-4 text-center">
             <div className="text-3xl mb-2">✅</div>
             <p className="text-xs font-bold text-gray-800">Asistencia</p>
             <p className="text-xs text-gray-400 mt-0.5">Lista del día</p>
           </a>
           <a href="/dashboard/alumnos" className="bg-yellow-50 rounded-2xl p-4 text-center">
             <div className="text-3xl mb-2">👨‍🎓</div>
             <p className="text-xs font-bold text-gray-800">Alumnos</p>
             <p className="text-xs text-gray-400 mt-0.5">Seguimiento</p>
           </a>
         </div>
       </div>

       {/* Chat IA */}
       <a href="/dashboard/chat" style={{background: 'linear-gradient(135deg, #6C3FE8, #3B82F6)'}} className="block rounded-2xl p-5 text-center shadow-lg">
         <p className="text-white font-black text-lg">✨ Abrir Chat IA</p>
         <p className="text-white/70 text-xs mt-1">Planeaciones · Rúbricas · Citatorios · Más</p>
       </a>

       {/* Historial */}
       <a href="/dashboard/historial" className="flex items-center gap-4 bg-white border-2 border-purple-100 rounded-2xl px-4 py-4">
         <span className="text-3xl">📁</span>
         <div className="flex-1">
           <p className="text-sm font-bold text-purple-700">Historial de Documentos</p>
           <p className="text-xs text-gray-400 mt-0.5">Todo organizado por fecha y alumno</p>
         </div>
         <span className="text-purple-400 text-xl">›</span>
       </a>

       {/* Salir */}
       <button
         onClick={async () => { await supabase.auth.signOut(); window.location.href = '/' }}
         className="w-full text-center text-sm text-gray-400 py-2"
       >
         Salir
       </button>
     </div>
   </div>
 )
}
