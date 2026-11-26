'use client'

// Tarjeta de una planeación en la biblioteca: título, campo formativo,
// fechas, sesiones, versión vigente y estado real de su evaluación.

import type { EstadoCapturaHoja } from '@/lib/seguimiento/estadoCapturaHoja'
import { COLOR_ESTADO_HOJA, ETIQUETA_ESTADO_HOJA } from '@/lib/seguimiento/etiquetasEstadoHoja'
import { rangoFechas, textoSesiones, type HojaResumen, type ResumenPlaneacion } from '@/lib/planeacion/vistaPlaneacion'
import { IconoCalendario, IconoCampo, IconoHoja, IconoSesiones, IconoSiguiente } from './Iconos'

// Hoja asociada con su estado real (sin estado: solo el código).
export function EstadoEvaluacion({ hoja, estado }: { hoja: HojaResumen; estado: EstadoCapturaHoja | undefined }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-gray-600">
      <IconoHoja className="w-3.5 h-3.5 flex-shrink-0 text-gray-500" />
      <span className="font-medium text-gray-700 whitespace-nowrap">{hoja.codigo}</span>
      {estado && <span className={`whitespace-nowrap ${COLOR_ESTADO_HOJA[estado]}`}>· {ETIQUETA_ESTADO_HOJA[estado]}</span>}
    </span>
  )
}

export function InsigniaVersion({ numero, vigente = true }: { numero: number; vigente?: boolean }) {
  return (
    <span className={`inline-flex flex-shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${vigente ? 'bg-green-50 text-green-800' : 'bg-gray-100 text-gray-700'}`}>
      {vigente && <span className="w-1.5 h-1.5 rounded-full bg-green-600" />}
      Versión {numero}
    </span>
  )
}

export default function TarjetaPlaneacion({ planeacion, estadoHoja, onAbrir }: { planeacion: ResumenPlaneacion; estadoHoja: EstadoCapturaHoja | undefined; onAbrir: () => void }) {
  const fechas = rangoFechas(planeacion.fechaInicio, planeacion.fechaFin)
  const sesiones = textoSesiones(planeacion.sesiones)
  return (
    <button
      type="button"
      onClick={onAbrir}
      className="w-full text-left bg-white rounded-2xl border border-gray-100 shadow-sm px-4 py-3.5 flex items-center gap-3 hover:border-green-200 hover:shadow transition focus:outline-none focus-visible:ring-2 focus-visible:ring-green-300"
    >
      <div className="flex-1 min-w-0">
        <p className="text-[15px] font-semibold text-gray-900 leading-snug line-clamp-2">{planeacion.nombre}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-600">
          {planeacion.campoFormativo && <span className="inline-flex items-center gap-1"><IconoCampo className="w-3.5 h-3.5 text-gray-500" />{planeacion.campoFormativo}</span>}
          {fechas && <span className="inline-flex items-center gap-1"><IconoCalendario className="w-3.5 h-3.5 text-gray-500" />{fechas}</span>}
          {sesiones && <span className="inline-flex items-center gap-1"><IconoSesiones className="w-3.5 h-3.5 text-gray-500" />{sesiones}</span>}
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <InsigniaVersion numero={planeacion.versionVigente} />
          {planeacion.hoja && <EstadoEvaluacion hoja={planeacion.hoja} estado={estadoHoja} />}
        </div>
      </div>
      <IconoSiguiente className="w-4 h-4 text-gray-400 flex-shrink-0" />
    </button>
  )
}
