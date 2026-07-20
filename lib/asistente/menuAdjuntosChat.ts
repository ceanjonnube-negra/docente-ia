// lib/asistente/menuAdjuntosChat.ts
//
// Las 3 opciones del menú de adjuntos del Chat IA — RFC-CHAT-ADJUNTOS-003.
// Vive en su propio archivo, sin ningún otro import, a propósito: así
// scripts/verificar-menu-adjuntos.ts puede comprobar el contrato (3
// opciones, este orden exacto, sin "Complementos"/"Inteligencia"/
// "Compartir") sin arrastrar Supabase, React ni el resto de la app.
// components/Asistente/AsistentePanel.tsx importa esta misma constante
// — un solo lugar donde existe la lista real.

import type { OpcionAdjunto } from '@/components/ui/MenuAdjuntos'

// "Fotos" y "Archivos" permiten marcar varias en el selector porque así
// se espera de una galería/explorador de archivos, pero el chat solo
// adjunta una por mensaje (igual que "Cámara" siempre hizo) — se usa
// la primera que el maestro marcó (ver manejarSeleccionAdjunto en
// AsistentePanel.tsx).
export const OPCIONES_ADJUNTO_CHAT: OpcionAdjunto[] = [
  { id: 'camara', icono: '📷', titulo: 'Cámara', accept: 'image/*', capture: 'environment' },
  { id: 'fotos', icono: '🖼️', titulo: 'Fotos', accept: 'image/*', multiple: true },
  { id: 'archivos', icono: '📄', titulo: 'Archivos', accept: '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,image/*', multiple: true },
]
