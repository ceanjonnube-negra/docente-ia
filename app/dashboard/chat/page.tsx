'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAsistente } from '@/lib/asistente/hooks'

// El Asistente IA ahora es un servicio global (ver app/dashboard/layout.tsx
// → AsistentePanel), no una pantalla propia. Esta ruta se conserva porque
// varios enlaces existentes apuntan aquí (ej. el ícono central de Inicio)
// — su único trabajo es abrir el panel y dejar /dashboard debajo, el
// punto de entrada real de la app (ver ese archivo: /dashboard también
// abre el panel directo, así que esto solo evita una pantalla en blanco
// para los enlaces que todavía apuntan a /dashboard/chat).
export default function ChatPage() {
  const asistente = useAsistente()
  const router = useRouter()

  useEffect(() => {
    asistente.abrirPanel()
    router.replace('/dashboard')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return null
}
