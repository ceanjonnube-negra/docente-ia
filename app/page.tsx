'use client'

// app/page.tsx
//
// "/" es la raíz real del dominio y el entry point de toda la
// aplicación — el Chat IA se renderiza aquí directamente, sin pasar por
// /dashboard ni por ninguna redirección encadenada (ver RFC-0002: la
// pantalla verde de Inicio nunca se monta debajo de esta ruta ni se
// ejecuta durante el arranque). AsistentePanel vive en el layout raíz
// (ver app/layout.tsx), así que abrirPanel() aquí sí tiene un
// componente real que reacciona. Si ya existe una conversación, se
// restaura automáticamente (ver lib/asistente/persistencia.ts).
//
// La página de marketing para visitantes nuevos (antes aquí) se movió,
// sin cambios, a /bienvenida — sigue completa y alcanzable, solo dejó
// de ocupar la raíz del dominio.
import { useEffect } from 'react'
import { useAsistente } from '@/lib/asistente/hooks'

export default function Home() {
  const asistente = useAsistente()

  useEffect(() => {
    asistente.abrirPanel()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return null
}
