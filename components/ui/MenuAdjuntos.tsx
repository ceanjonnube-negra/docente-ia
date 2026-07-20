'use client'

// components/ui/MenuAdjuntos.tsx
//
// Menú contextual flotante ANCLADO a un botón, con opciones que abren
// selectores de archivo nativos (cámara/galería/documentos) — RFC-CHAT-
// ADJUNTOS-003. Mismo componente para toda la aplicación: siempre el
// mismo look (anclado al botón, nunca un panel inferior/bottom sheet,
// nunca el menú nativo del sistema operativo) en iPhone, Android y Web.
// Se cierra solo al tocar fuera o al elegir una opción — @floating-ui/
// react ya resuelve ambos casos (useDismiss, cierre explícito en cada
// onChange) y reposiciona automáticamente si el layout cambia (por
// ejemplo, el teclado abriéndose empuja el botón hacia arriba).

import { useState } from 'react'
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  useClick,
  useDismiss,
  useRole,
  useInteractions,
  FloatingFocusManager,
} from '@floating-ui/react'

export type OpcionAdjunto = {
  id: string
  icono: string
  titulo: string
  accept: string
  capture?: 'environment' | 'user'
  multiple?: boolean
}

type Props = {
  opciones: OpcionAdjunto[]
  onArchivos: (opcionId: string, files: FileList) => void
  triggerLabel: React.ReactNode
  triggerClassName: string
  triggerAriaLabel: string
  disabled?: boolean
}

export default function MenuAdjuntos({ opciones, onArchivos, triggerLabel, triggerClassName, triggerAriaLabel, disabled }: Props) {
  const [abierto, setAbierto] = useState(false)

  const { refs, floatingStyles, context } = useFloating({
    open: abierto,
    onOpenChange: setAbierto,
    placement: 'top-start',
    middleware: [offset(10), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  })

  const click = useClick(context)
  const dismiss = useDismiss(context)
  const role = useRole(context, { role: 'menu' })
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss, role])

  return (
    <>
      <button
        ref={refs.setReference}
        type="button"
        disabled={disabled}
        aria-label={triggerAriaLabel}
        className={triggerClassName}
        {...getReferenceProps()}
      >
        {triggerLabel}
      </button>

      {abierto && (
        <FloatingFocusManager context={context} modal={false}>
          <div
            // eslint-disable-next-line react-hooks/refs -- patrón oficial de @floating-ui/react: refs.setFloating es un callback ref estable, no una lectura de .current.
            ref={refs.setFloating}
            style={floatingStyles}
            {...getFloatingProps()}
            className="z-50 w-60 overflow-hidden rounded-2xl bg-white/95 shadow-2xl backdrop-blur-xl border border-gray-100 divide-y divide-gray-100 py-1"
          >
            {opciones.map((op) => (
              <div key={op.id} className="relative flex items-center gap-3 px-4 py-2.5 active:bg-gray-50 cursor-pointer">
                <input
                  type="file"
                  accept={op.accept}
                  capture={op.capture}
                  multiple={op.multiple}
                  onChange={(e) => {
                    const files = e.target.files
                    e.target.value = ''
                    setAbierto(false)
                    if (files && files.length > 0) onArchivos(op.id, files)
                  }}
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                />
                <span className="text-lg flex-shrink-0">{op.icono}</span>
                <p className="text-sm font-semibold text-gray-900">{op.titulo}</p>
              </div>
            ))}
          </div>
        </FloatingFocusManager>
      )}
    </>
  )
}
