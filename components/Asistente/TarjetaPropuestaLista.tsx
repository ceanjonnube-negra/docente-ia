'use client'

// components/Asistente/TarjetaPropuestaLista.tsx
//
// LISTA-P5 (2b) — tarjeta de confirmación de una propuesta de lista
// oficial, dentro de la misma burbuja del Chat IA (ver
// AsistenteService.confirmarPropuestaLista). Solo pinta la vista mínima
// que redactó el servidor (ver lib/listaOficial/vistaPropuestaLista.ts):
// no guarda ni recalcula nada por su cuenta. Las operaciones aplicables
// empiezan sin marcar; las demás solo se muestran. Nunca hay bajas.

import { useState } from 'react'
import { MENSAJE_PROPUESTA_VENCIDA, type PropuestaListaEnMensaje } from '@/lib/asistente/tipos'

export default function TarjetaPropuestaLista({
  datos,
  enCurso,
  ocupado,
  onAplicar,
}: {
  datos: PropuestaListaEnMensaje
  // Esta propuesta se está aplicando ahora mismo.
  enCurso: boolean
  // Hay alguna propuesta aplicándose (esta u otra).
  ocupado: boolean
  onAplicar: (operacionIds: string[]) => void
}) {
  const [seleccion, setSeleccion] = useState<Set<string>>(() => new Set())
  // Vencimiento según la vigencia firmada; el servidor lo vuelve a decidir.
  const [ahora] = useState(() => Date.now())

  const caja = 'mt-1.5 rounded-2xl border border-gray-200 bg-white px-3 py-2.5 text-xs text-gray-700 shadow-sm'
  if (datos.estado === 'aplicada') {
    return <div className={`${caja} text-emerald-700`}>✓ Cambios aplicados a tu lista.</div>
  }
  if (datos.estado === 'cerrada' || !datos.token || !datos.operaciones || ahora >= Date.parse(datos.expiraEn)) {
    return <div className={`${caja} text-gray-500`}>{datos.estado === 'cerrada' && datos.aviso ? datos.aviso : MENSAJE_PROPUESTA_VENCIDA}</div>
  }

  const aplicables = datos.operaciones.filter((op) => op.aplicable)
  const informativas = datos.operaciones.filter((op) => !op.aplicable)
  const alternar = (id: string) =>
    setSeleccion((previa) => {
      const nueva = new Set(previa)
      if (nueva.has(id)) nueva.delete(id)
      else nueva.add(id)
      return nueva
    })

  return (
    <div className={caja}>
      {aplicables.length > 0 && (
        <>
          <p className="mb-1.5 font-semibold text-gray-800">Cambios que puedes aplicar</p>
          <ul className="space-y-1">
            {aplicables.map((op) => (
              <li key={op.operacionId}>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={seleccion.has(op.operacionId)}
                    onChange={() => alternar(op.operacionId)}
                    disabled={ocupado}
                  />
                  <span>{op.etiqueta}</span>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
      {informativas.length > 0 && (
        <ul className="mt-2 space-y-1 text-gray-500">
          {informativas.map((op) => (
            <li key={op.operacionId}>
              {op.etiqueta} — {op.nota ?? 'No se puede aplicar'}
            </li>
          ))}
        </ul>
      )}
      {aplicables.length > 0 && (
        <button
          type="button"
          onClick={() => onAplicar([...seleccion])}
          disabled={ocupado || seleccion.size === 0}
          className="mt-2.5 px-4 py-2 rounded-full text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 transition disabled:opacity-40"
        >
          {enCurso ? 'Aplicando…' : `Aplicar seleccionados${seleccion.size > 0 ? ` (${seleccion.size})` : ''}`}
        </button>
      )}
    </div>
  )
}
