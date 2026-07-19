'use client'

// app/dashboard/page.tsx
//
// "/dashboard" ya no fuerza la apertura del Chat IA — ver ARQUITECTURA
// DE NAVEGACIÓN DEL CHAT IA: la navegación siempre le pertenece al
// docente, el chat nunca debe abrirse por decisión propia de la
// aplicación (ni al volver de otro módulo, ni al reabrir la app). Esta
// ruta solo existe como red de seguridad para cualquier enlace viejo que
// todavía apunte aquí — redirige directo a Inicio (/dashboard/inicio),
// la pantalla neutral. Abrir el Chat IA sigue siendo posible en
// cualquier momento tocando su ícono explícitamente (ver
// /dashboard/chat, o el burbuja flotante del panel).
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function Dashboard() {
  const router = useRouter()

  useEffect(() => {
    router.replace('/dashboard/inicio')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return null
}
