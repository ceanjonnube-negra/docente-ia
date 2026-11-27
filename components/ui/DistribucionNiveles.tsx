// components/ui/DistribucionNiveles.tsx
//
// Barra segmentada con la distribución de niveles confirmados y su
// leyenda con conteos (ficha del alumno y concentrado del grupo). Solo
// conteos directos; mismos tonos que la matriz de Evaluación.

import { ETIQUETA_NIVEL_CANONICO, ORDEN_NIVELES_CANONICOS, type NivelTextoCanonico } from '@/lib/seguimiento/conversionCalificacion'

// Segmentos de la barra de distribución (mismos tonos que la matriz de
// Evaluación, en versión sólida).
export const BARRA_NIVEL: Record<NivelTextoCanonico, string> = {
  destacado: 'bg-green-600',
  logrado: 'bg-teal-500',
  en_proceso: 'bg-amber-400',
  requiere_apoyo: 'bg-red-500',
  no_evaluado: 'bg-gray-300',
}

export default function DistribucionNiveles({ distribucion, compacta = false }: { distribucion: Record<NivelTextoCanonico, number>; compacta?: boolean }) {
  const total = ORDEN_NIVELES_CANONICOS.reduce((s, n) => s + distribucion[n], 0)
  const presentes = ORDEN_NIVELES_CANONICOS.filter((n) => distribucion[n] > 0)
  return (
    <div className={compacta ? '' : 'mt-2.5'}>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-gray-100" aria-hidden="true">
        {presentes.map((n) => <span key={n} className={BARRA_NIVEL[n]} style={{ width: `${(distribucion[n] / total) * 100}%` }} />)}
      </div>
      {!compacta && <p className="mt-1.5 flex flex-wrap gap-x-2.5 gap-y-0.5 text-[11px] text-gray-600">
        {presentes.map((n) => (
          <span key={n} className="inline-flex items-center gap-1">
            <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${BARRA_NIVEL[n]}`} />
            {distribucion[n]} {ETIQUETA_NIVEL_CANONICO[n]}
          </span>
        ))}
      </p>}
    </div>
  )
}
