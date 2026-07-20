'use client'

// components/ui/MenuAdjuntos.tsx
//
// ÚNICO componente de menú de adjuntos de toda la aplicación — Chat IA
// (components/Asistente/AsistentePanel.tsx) y la importación de lista
// de alumnos (components/ImportacionInteligente.tsx) lo usan tal cual,
// sin cada uno mantener su propia implementación. Siempre el mismo
// resultado visual: una ventana pequeña, de esquinas redondeadas,
// sombra ligera, anclada justo junto al botón que la abrió — nunca un
// panel/hoja que sube desde abajo de toda la pantalla, en ningún
// dispositivo (RFC-CHAT-ADJUNTOS-003, corrección de "dos menús").
//
// La causa real del "segundo menú" (con textos como "Fototeca"/"Tomar
// foto"/"Seleccionar archivos", en español del propio sistema
// operativo) no era un componente duplicado: era el selector nativo de
// iOS/Android que aparece SOBRE cualquier <input type="file"> cuando su
// `accept` mezcla el comodín "image/*" con extensiones de documento —
// el teléfono entiende que debe preguntar "¿de dónde sacas la imagen?"
// otra vez, encima de la opción que el maestro ya eligió en este menú.
// La opción "Archivos" evita esa mezcla usando extensiones de imagen
// explícitas en vez de "image/*", igual que ya lo hacía
// ImportacionInteligente (su versión, ya en producción, nunca mostró
// ese selector doble).

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
  type Placement,
} from '@floating-ui/react'

export type OpcionAdjunto = {
  id: string
  icono: string
  titulo: string
  descripcion?: string
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
  // 'top-start' para un botón anclado abajo (Chat IA: el cuadro de
  // texto vive al fondo de la pantalla, no hay espacio debajo). 'bottom-
  // end'/'bottom-start' para un botón arriba de su contenido (Lista).
  // flip() corrige solo si de todos modos no cabe en la dirección
  // preferida — este valor es solo la preferencia inicial.
  placement?: Placement
  // Solo afecta el estado inicial (para autoAbrir al montar); el menú
  // sigue abriéndose/cerrándose normalmente después con cada toque.
  abiertoInicial?: boolean
}

export default function MenuAdjuntos({
  opciones,
  onArchivos,
  triggerLabel,
  triggerClassName,
  triggerAriaLabel,
  disabled,
  placement = 'bottom-start',
  abiertoInicial = false,
}: Props) {
  const [abierto, setAbierto] = useState(abiertoInicial)

  const { refs, floatingStyles, context } = useFloating({
    open: abierto,
    onOpenChange: setAbierto,
    placement,
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
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
            className="z-50 w-72 overflow-hidden rounded-2xl bg-white/95 shadow-lg backdrop-blur-xl border border-gray-100 divide-y divide-gray-100 py-1"
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
                <span className="text-xl flex-shrink-0 w-6 text-center">{op.icono}</span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-900">{op.titulo}</p>
                  {op.descripcion && <p className="text-xs text-gray-400">{op.descripcion}</p>}
                </div>
              </div>
            ))}
          </div>
        </FloatingFocusManager>
      )}
    </>
  )
}
