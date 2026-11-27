'use client'

// Word o PDF de UNA versión de planeación: disponibilidad, Ver/Descargar
// el original exacto de esa versión y, si falta, generarlo una sola vez con
// la infraestructura canónica (sin IA). Nunca regenera un archivo existente.

import { useState } from 'react'
import {
  generarArchivoDeVersion,
  modosRecuperacion,
  recuperarArchivoDeVersion,
  type FormatoVersionArchivo,
  type ModoRecuperacion,
  type ResultadoArchivoVersionCliente,
} from '@/lib/asistente/recuperacionArchivo'
import { IconoDocumento } from './Iconos'

const NOMBRE: Record<FormatoVersionArchivo, string> = { word: 'Word', pdf: 'PDF' }

export function avisoDocumento(r: ResultadoArchivoVersionCliente, formato: FormatoVersionArchivo): string | null {
  switch (r.estado) {
    case 'archivo': return null
    case 'sesion': return 'Tu sesión venció. Vuelve a iniciar sesión.'
    case 'en_proceso': return `El ${NOMBRE[formato]} se está preparando. Inténtalo en unos segundos.`
    case 'inexistente': return `El ${NOMBRE[formato]} original ya no está disponible entre tus archivos.`
    case 'sin_archivo': return `Esta versión aún no tiene ${NOMBRE[formato]}.`
    default: return 'No se pudo completar. Inténtalo de nuevo.'
  }
}

type Ocupado = ModoRecuperacion | 'generar' | null

// generable: la versión guarda su contenido canónico. Sin contenido ni
// archivo original no se ofrece generar (el servidor también lo rechaza).
export default function DocumentoVersion({ versionId, formato, disponible, generable, onGenerado }: { versionId: string; formato: FormatoVersionArchivo; disponible: boolean; generable: boolean; onGenerado: () => void }) {
  const [ocupado, setOcupado] = useState<Ocupado>(null)
  const [aviso, setAviso] = useState<string | null>(null)

  const terminar = (r: ResultadoArchivoVersionCliente) => {
    setOcupado(null)
    setAviso(avisoDocumento(r, formato))
  }
  const recuperar = (modo: ModoRecuperacion) => {
    if (ocupado) return
    setOcupado(modo)
    setAviso(null)
    recuperarArchivoDeVersion(versionId, formato, modo, terminar)
  }
  const generar = async () => {
    if (ocupado) return
    setOcupado('generar')
    setAviso(null)
    const r = await generarArchivoDeVersion(versionId, formato)
    terminar(r)
    if (r.estado === 'archivo') onGenerado()
  }

  const estado = ocupado === 'generar' ? 'Preparando…' : disponible ? 'Original guardado' : generable ? 'Aún no generado' : 'Sin contenido para generar'
  return (
    <div className="flex-1 min-w-0 rounded-xl border border-gray-100 bg-gray-50/60 px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <IconoDocumento className={`w-5 h-5 flex-shrink-0 ${disponible ? 'text-green-700' : 'text-gray-400'}`} />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900">{NOMBRE[formato]}</p>
          <p className={`text-[11px] ${disponible ? 'text-green-700' : 'text-gray-500'}`}>{estado}</p>
        </div>
      </div>
      {(disponible || generable) && <div className="mt-2.5 flex gap-1.5">
        {disponible ? (
          modosRecuperacion(formato).map((modo) => (
            <button
              key={modo}
              type="button"
              disabled={ocupado !== null}
              onClick={() => recuperar(modo)}
              className={`flex-1 rounded-full px-2 py-1.5 text-xs font-semibold disabled:opacity-60 ${modo === 'ver' ? 'border border-gray-200 bg-white text-gray-700 hover:bg-gray-50' : 'bg-green-600 text-white hover:bg-green-700'}`}
            >
              {ocupado === modo ? (modo === 'ver' ? 'Abriendo…' : 'Descargando…') : modo === 'ver' ? 'Ver' : 'Descargar'}
            </button>
          ))
        ) : (
          <button
            type="button"
            disabled={ocupado !== null}
            onClick={generar}
            className="flex-1 rounded-full border border-green-200 bg-white px-2 py-1.5 text-xs font-semibold text-green-800 hover:bg-green-50 disabled:opacity-60"
          >
            {ocupado === 'generar' ? 'Preparando…' : `Generar ${NOMBRE[formato]}`}
          </button>
        )}
      </div>}
      {aviso && <p role="status" className="mt-2 text-[11px] leading-snug text-amber-700">{aviso}</p>}
    </div>
  )
}
