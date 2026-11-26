'use client'

import type { EstadoCapturaHoja } from '@/lib/seguimiento/estadoCapturaHoja'
import { agruparPorMes, type ResumenPlaneacion } from '@/lib/planeacion/vistaPlaneacion'
import TarjetaPlaneacion from './TarjetaPlaneacion'

export function Esqueleto() {
  return (
    <div className="px-4 py-5 space-y-3" aria-busy="true" aria-label="Cargando planeaciones">
      {[0, 1, 2].map((i) => (
        <div key={i} className="bg-white rounded-2xl border border-gray-100 p-4 space-y-2.5 animate-pulse">
          <div className="h-4 w-3/4 bg-gray-100 rounded" />
          <div className="h-3 w-1/2 bg-gray-100 rounded" />
          <div className="h-3 w-1/3 bg-gray-100 rounded" />
        </div>
      ))}
    </div>
  )
}

// Biblioteca por mes (presentación pura, reutilizable).
export default function ListaPlaneaciones({ planeaciones, estados, onAbrir }: { planeaciones: ResumenPlaneacion[]; estados: Record<string, EstadoCapturaHoja>; onAbrir: (id: string) => void }) {
  return (
    <div className="px-4 py-4 space-y-6">
      <p className="px-1 text-xs text-gray-500">{planeaciones.length === 1 ? '1 planeación' : `${planeaciones.length} planeaciones`}</p>
      {agruparPorMes(planeaciones).map((mes) => (
        <section key={mes.clave} className="space-y-2.5">
          <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-gray-500">{mes.etiqueta}</h2>
          {mes.planeaciones.map((p) => (
            <TarjetaPlaneacion key={p.id} planeacion={p} estadoHoja={p.hoja ? estados[p.hoja.proyectoId] : undefined} onAbrir={() => onAbrir(p.id)} />
          ))}
        </section>
      ))}
    </div>
  )
}
