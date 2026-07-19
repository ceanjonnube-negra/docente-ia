'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAsistente } from '@/lib/asistente/hooks'

// El Asistente IA ahora es un servicio global (ver app/dashboard/layout.tsx
// → AsistentePanel), no una pantalla propia. Esta ruta se conserva porque
// varios enlaces existentes apuntan aquí (ej. el ícono central de Inicio)
// — su único trabajo es abrir el panel cuando el docente lo pide
// explícitamente así, y dejar /dashboard/inicio debajo como pantalla
// neutral (ver ARQUITECTURA DE NAVEGACIÓN DEL CHAT IA: abrir el chat
// siempre es una decisión del docente, nunca automática de la app).
export default function ChatPage() {
  const asistente = useAsistente()
  const router = useRouter()

  useEffect(() => {
    asistente.abrirPanel()
    router.replace('/dashboard/inicio')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return null
}
