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

// HOTFIX (segundo menú nativo en Fotos/Archivos): ni "multiple" ni
// mezclar categorías de accept son gratis en iOS/Android — un
// <input type="file"> SIN capture y SIN esas dos cosas es la única
// combinación que abre el recurso de forma directa, sin que el propio
// sistema operativo muestre su panel de "¿Fototeca, Tomar foto o
// Elegir archivo?" encima de este menú:
//   - "Fotos" ya no permite selección múltiple (una imagen por
//     mensaje, igual que "Tomar foto" siempre hizo) — con "multiple"
//     puesto, iOS mostraba su propio selector antes de dejar elegir.
//   - "Archivos" ya no incluye extensiones de imagen en su accept —
//     mezclar imagen+documento en la misma opción es lo que hacía que
//     el sistema ofreciera Fototeca/Cámara además del explorador de
//     archivos. Para una imagen se usa "Fotos".
// El chat solo adjunta un archivo por mensaje en cualquier caso (ver
// manejarSeleccionAdjunto en AsistentePanel.tsx).
export const OPCIONES_ADJUNTO_CHAT: OpcionAdjunto[] = [
  { id: 'camara', icono: '📷', titulo: 'Tomar foto', descripcion: 'Fotografía una lista o documento', accept: 'image/*', capture: 'environment' },
  { id: 'fotos', icono: '🖼️', titulo: 'Fotos', descripcion: 'Selecciona una imagen', accept: 'image/*' },
  { id: 'archivos', icono: '📄', titulo: 'Archivos', descripcion: 'PDF, Word, Excel o PowerPoint', accept: '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx' },
]
