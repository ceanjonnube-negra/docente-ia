'use client'
import type { ArchivoGeneradoInfo } from '@/lib/asistente/tipos'

// Overlay contextual para ver una imagen ya generada — ver "resultado
// persistente del Chat IA" (segundo tipo, imagen). Mismo criterio que
// VentanaListaFiltrada: sheet ENCIMA del chat, sin router.push/replace,
// sin tocar conversación/historial. A diferencia de esa, no hace
// ninguna consulta — `archivo` es la única fuente del recurso
// (MensajeConversacion.archivo, ya persistido), así que esta ventana
// es puramente de presentación, sin loading/error propios.

type Props = {
  archivo: ArchivoGeneradoInfo
  onClose: () => void
  onGuardarCompartir: () => void
  onDescargar: () => void
}

export default function VentanaImagen({ archivo, onClose, onGuardarCompartir, onDescargar }: Props) {
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[60] p-4" onClick={onClose}>
      <div
        onClick={e => e.stopPropagation()}
        className="bg-white rounded-3xl w-full max-w-lg max-h-[85vh] shadow-2xl flex flex-col overflow-hidden"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 flex-shrink-0">
          <p className="text-sm font-bold text-gray-900">Imagen generada</p>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            className="w-8 h-8 flex items-center justify-center rounded-full bg-gray-100 text-gray-500 text-lg flex-shrink-0"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-auto flex items-center justify-center bg-gray-50 p-2">
          <img src={archivo.url} alt="Imagen generada" className="max-w-full max-h-full object-contain rounded-xl" />
        </div>

        <div className="flex gap-2 px-4 py-3 border-t border-gray-100 flex-shrink-0 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={onGuardarCompartir}
            className="flex-1 flex items-center justify-center gap-1 bg-purple-600 text-white text-sm font-semibold px-4 py-2.5 rounded-full hover:bg-purple-700"
          >
            📤 Guardar o compartir
          </button>
          <button
            type="button"
            onClick={onDescargar}
            className="flex items-center justify-center gap-1 border border-gray-200 text-gray-600 text-sm font-semibold px-4 py-2.5 rounded-full hover:bg-gray-50"
          >
            ⬇️
          </button>
        </div>
      </div>
    </div>
  )
}
