'use client'

// app/dashboard/page.tsx
//
// "/dashboard" es el punto de entrada real de toda la aplicación
// autenticada — el Chat IA es la pantalla principal (ver REDISEÑO DE
// ARQUITECTURA: eliminar la pantalla verde como pantalla principal).
// Abre el panel global directo, sin ninguna pantalla intermedia (ver
// components/Asistente/AsistentePanel.tsx, montado en el layout). Si ya
// existe una conversación, el panel la restaura automáticamente (ver
// lib/asistente/persistencia.ts) — el docente entra directo a donde se
// quedó, listo para escribir o hablar. Inicio (la portada verde)
// conserva todas sus funciones tal cual, ahora en /dashboard/inicio,
// accesible desde el menú lateral del chat — solo dejó de ser la
// pantalla con la que arranca la app.
import { useEffect } from 'react'
import { useAsistente } from '@/lib/asistente/hooks'

export const dynamic = 'force-dynamic'

export default function Dashboard() {
  const asistente = useAsistente()

  useEffect(() => {
    asistente.abrirPanel()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return null
}
