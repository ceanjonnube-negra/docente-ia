'use client'

// Detalle de solo lectura de una planeación: selector de versión, Word y
// PDF con su disponibilidad real, hoja de evaluación asociada, contenido e
// historial de versiones. Consultar una versión anterior nunca la vuelve
// vigente: aquí no hay ninguna acción que escriba.

import type { EstadoCapturaHoja } from '@/lib/seguimiento/estadoCapturaHoja'
import { formatearFecha, obtenerZonaHorariaDispositivo } from '@/lib/tiempo/TimeService'
import { ORIGEN_VERSION, campoFormativoDe, rangoFechas, sesionesDe, textoSesiones, type DetallePlaneacion as Detalle, type VersionDetalle } from '@/lib/planeacion/vistaPlaneacion'
import ContenidoVersion from './ContenidoVersion'
import DocumentoVersion from './DocumentoVersion'
import { EstadoEvaluacion, InsigniaVersion } from './TarjetaPlaneacion'
import { useState } from 'react'
import { IconoCalendario, IconoCampo, IconoChat, IconoDocumento, IconoHistorial, IconoHoja, IconoSesiones, IconoSiguiente } from './Iconos'

function Seccion({ titulo, icono, children }: { titulo: string; icono: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="bg-white rounded-2xl border border-gray-100 shadow-sm">
      <h2 className="flex items-center gap-2 px-4 pt-3.5 pb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
        <span className="text-gray-500">{icono}</span>{titulo}
      </h2>
      <div className="px-4 pb-4">{children}</div>
    </section>
  )
}

export default function DetallePlaneacion({
  detalle,
  version,
  onSeleccionarVersion,
  estadosHoja,
  evaluacionDistinta,
  onArchivoGenerado,
  onContinuarEnChat,
}: {
  detalle: Detalle
  version: VersionDetalle
  onSeleccionarVersion: (numero: number) => void
  estadosHoja: Record<string, EstadoCapturaHoja>
  // Hoja con capturas o resultados cuyos criterios difieren de los de esta versión.
  evaluacionDistinta: string | null
  // Un Word/PDF recién generado para esta versión (la vista lo marca disponible).
  onArchivoGenerado: (versionId: string, formato: 'word' | 'pdf') => void
  // Abre el único Chat IA con esta planeación y versión (5c). Devuelve un
  // aviso si no se pudo; null si quedó abierto.
  onContinuarEnChat: (versionId: string) => Promise<string | null>
}) {
  const [continuando, setContinuando] = useState(false)
  const [avisoChat, setAvisoChat] = useState<{ versionId: string; texto: string } | null>(null)
  const continuar = async () => {
    if (continuando) return
    setContinuando(true)
    setAvisoChat(null)
    const aviso = await onContinuarEnChat(version.id)
    setContinuando(false)
    if (aviso) setAvisoChat({ versionId: version.id, texto: aviso })
  }
  const vigente = version.numero === detalle.versionVigente
  const fechas = rangoFechas(detalle.fechaInicio, detalle.fechaFin)
  const campo = campoFormativoDe(version.estructura)
  const sesiones = textoSesiones(sesionesDe(version.estructura))
  const indicadores = version.estructura?.proyecto?.indicadores ?? []

  return (
    <div className="space-y-3">
      <div className="px-1">
        <h1 className="text-xl font-semibold text-gray-900 leading-snug">{detalle.nombre}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-gray-600">
          {campo && <span className="inline-flex items-center gap-1"><IconoCampo className="w-3.5 h-3.5 text-gray-500" />{campo}</span>}
          {fechas && <span className="inline-flex items-center gap-1"><IconoCalendario className="w-3.5 h-3.5 text-gray-500" />{fechas}</span>}
          {sesiones && <span className="inline-flex items-center gap-1"><IconoSesiones className="w-3.5 h-3.5 text-gray-500" />{sesiones}</span>}
        </div>
        <label className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] text-gray-600">
          <span className="sr-only">Versión</span>
          <span className="relative">
            <select
              value={version.numero}
              onChange={(e) => onSeleccionarVersion(Number(e.target.value))}
              className="appearance-none rounded-full border border-gray-200 bg-white pl-3 pr-8 py-1.5 text-[13px] font-semibold text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-green-300"
            >
              {detalle.versiones.map((v) => (
                <option key={v.id} value={v.numero}>Versión {v.numero}{v.numero === detalle.versionVigente ? ' · vigente' : ''}</option>
              ))}
            </select>
            <IconoSiguiente className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rotate-90 w-3.5 h-3.5 text-gray-500" />
          </span>
          {!vigente && <span className="text-amber-700">Versión histórica · solo consulta. La vigente es la {detalle.versionVigente}.</span>}
        </label>
        <div className="mt-3">
          <button
            type="button"
            onClick={continuar}
            disabled={continuando}
            className="inline-flex items-center gap-2 rounded-full border border-green-200 bg-white px-3.5 py-1.5 text-[13px] font-semibold text-green-800 hover:bg-green-50 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-green-300"
          >
            <IconoChat className="w-4 h-4" />
            {continuando ? 'Abriendo el Chat…' : 'Continuar en el Chat IA'}
          </button>
          {avisoChat?.versionId === version.id && <p role="status" className="mt-1.5 text-xs text-amber-700">{avisoChat.texto}</p>}
        </div>
      </div>

      <Seccion titulo="Documentos" icono={<IconoDocumento className="w-4 h-4" />}>
        <div className="flex gap-2">
          <DocumentoVersion key={`${version.id}-word`} versionId={version.id} formato="word" disponible={version.tieneWord} onGenerado={() => onArchivoGenerado(version.id, 'word')} />
          <DocumentoVersion key={`${version.id}-pdf`} versionId={version.id} formato="pdf" disponible={version.tienePdf} onGenerado={() => onArchivoGenerado(version.id, 'pdf')} />
        </div>
      </Seccion>

      <Seccion titulo="Evaluación" icono={<IconoHoja className="w-4 h-4" />}>
        {version.hoja ? (
          <div className="space-y-2">
            <a
              href={`/dashboard/evaluacion?proyecto=${version.hoja.proyectoId}`}
              className="flex items-center justify-between gap-3 rounded-xl border border-gray-100 px-3 py-2.5 hover:border-green-200"
            >
              <EstadoEvaluacion hoja={version.hoja} estado={estadosHoja[version.hoja.proyectoId]} />
              <span className="inline-flex items-center gap-0.5 text-xs font-semibold text-green-700 flex-shrink-0">Ver<IconoSiguiente className="w-3.5 h-3.5" /></span>
            </a>
            {version.hoja.reemplazada && <p className="text-xs text-gray-600">Esta hoja fue reemplazada por la de una versión posterior.</p>}
            {evaluacionDistinta && <p className="text-xs text-gray-600">La evaluación registrada con {evaluacionDistinta} conserva sus criterios originales; los indicadores de esta versión son los que se muestran abajo.</p>}
          </div>
        ) : (
          <p className="text-sm text-gray-500">Esta versión no tiene hoja de evaluación asociada.</p>
        )}
      </Seccion>

      <Seccion titulo="Contenido" icono={<IconoCampo className="w-4 h-4" />}>
        {version.contenido?.trim()
          ? <ContenidoVersion contenido={version.contenido} numero={version.numero} indicadores={indicadores} />
          : <p className="text-sm text-gray-500">Esta versión no tiene contenido guardado.</p>}
      </Seccion>

      <Seccion titulo="Historial de versiones" icono={<IconoHistorial className="w-4 h-4" />}>
        <ol className="divide-y divide-gray-100">
          {detalle.versiones.map((v) => {
            const seleccionada = v.numero === version.numero
            const archivos = [v.tieneWord && 'Word', v.tienePdf && 'PDF'].filter(Boolean).join(' · ')
            return (
              <li key={v.id}>
                <button
                  type="button"
                  onClick={() => onSeleccionarVersion(v.numero)}
                  aria-current={seleccionada ? 'true' : undefined}
                  className={`w-full flex items-center gap-3 py-2.5 text-left rounded-lg ${seleccionada ? 'text-gray-900' : 'text-gray-700 hover:text-gray-900'}`}
                >
                  <span className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0 ${seleccionada ? 'bg-green-600 text-white' : 'bg-gray-100 text-gray-600'}`}>{v.numero}</span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-medium">{ORIGEN_VERSION[v.origen] ?? 'Versión'} · {formatearFecha(v.creadaEn, obtenerZonaHorariaDispositivo(), { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                    <span className="block text-[11px] text-gray-500">{archivos || 'Sin archivos generados'}</span>
                  </span>
                  {v.numero === detalle.versionVigente && <InsigniaVersion numero={v.numero} />}
                </button>
              </li>
            )
          })}
        </ol>
      </Seccion>
    </div>
  )
}
