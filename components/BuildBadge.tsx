import { BUILD_ID } from '@/lib/buildInfo'

// Identificador de versión, esquina inferior izquierda (la derecha la
// ocupa la burbuja del Asistente IA — ver AsistentePanel). Solo texto
// pequeño y gris, nunca interfiere con nada; sirve para confirmar de un
// vistazo que el navegador está sirviendo el build recién publicado y no
// una copia vieja desde caché.
export default function BuildBadge() {
  return (
    <div className="fixed bottom-1 left-1 z-30 text-[9px] text-gray-400 bg-white/70 px-1.5 py-0.5 rounded pointer-events-none select-none">
      Build: {BUILD_ID}
    </div>
  )
}
