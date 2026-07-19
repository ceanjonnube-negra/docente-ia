'use client'
import { Fragment, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
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
import { supabase } from '@/lib/supabaseClient'
import {
  type AlumnoPreview,
  type Fase,
  type GrupoParaImportar,
  FASES,
  MENSAJE_FASE,
  necesitaAtencion,
  convertirHeicSiNecesario,
  analizarArchivos,
  guardarAlumnosImportados,
} from '@/lib/importacionInteligente'

type Estado = 'inicial' | 'analizando' | 'revisando' | 'guardando'

type Props = {
  grupo: GrupoParaImportar | null
  onImportacionCompleta: () => void
  triggerClassName?: string
  triggerLabel?: ReactNode
  autoAbrir?: boolean
}

const CLASE_TRIGGER_DEFECTO =
  'px-4 py-2 bg-emerald-600 rounded-full text-xs font-semibold text-white hover:bg-emerald-700 whitespace-nowrap'

// true a partir del breakpoint sm de Tailwind (640px) — escritorio/tablet.
// Empieza en false (mismo valor en servidor y en el primer render del
// cliente, para no causar un hydration mismatch) y se corrige en un efecto:
// este es precisamente el caso de uso legítimo de useEffect que la propia
// regla de lint describe ("sincronizar con una API de plataforma"), no una
// sincronización de estado derivado evitable.
function useEsEscritorio(): boolean {
  const [esEscritorio, setEsEscritorio] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 640px)')
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sincroniza con window.matchMedia (API de plataforma), no con estado derivado de props.
    setEsEscritorio(mq.matches)
    const escuchar = (e: MediaQueryListEvent) => setEsEscritorio(e.matches)
    mq.addEventListener('change', escuchar)
    return () => mq.removeEventListener('change', escuchar)
  }, [])
  return esEscritorio
}

// Botón "Importar" + menú (Popover anclado en escritorio, Bottom Sheet en
// móvil) + análisis automático + revisión final, todo en un solo componente.
// El botón y el panel comparten la misma referencia de posicionamiento, así
// que nunca hay dos implementaciones independientes que mantener.
export default function ImportacionInteligente({
  grupo,
  onImportacionCompleta,
  triggerClassName,
  triggerLabel,
  autoAbrir,
}: Props) {
  // Si autoAbrir viene en true, el menú nace abierto desde el primer render
  // en que grupo ya esté disponible (mientras grupo es null el componente
  // no renderiza nada — ver "if (!grupo) return null" más abajo).
  const [menuAbierto, setMenuAbierto] = useState(() => !!autoAbrir)
  const [estado, setEstado] = useState<Estado>('inicial')
  const [fase, setFase] = useState<Fase>('analizando')
  const [alumnos, setAlumnos] = useState<AlumnoPreview[]>([])
  const [error, setError] = useState<string | null>(null)
  const [progreso, setProgreso] = useState({ completados: 0, total: 0 })
  const [arrastreY, setArrastreY] = useState(0)
  const primeraFilaConAtencionRef = useRef<HTMLInputElement | null>(null)
  const arrastreInicioRef = useRef<number | null>(null)

  const esEscritorio = useEsEscritorio()

  const { refs, floatingStyles, context } = useFloating({
    open: menuAbierto,
    onOpenChange: setMenuAbierto,
    placement: 'bottom-end',
    middleware: [offset(7), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  })

  const click = useClick(context)
  const dismiss = useDismiss(context)
  const role = useRole(context, { role: 'menu' })
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss, role])

  function iniciarArrastre(e: React.PointerEvent) {
    arrastreInicioRef.current = e.clientY
  }
  function moverArrastre(e: React.PointerEvent) {
    if (arrastreInicioRef.current === null) return
    const delta = e.clientY - arrastreInicioRef.current
    if (delta > 0) setArrastreY(delta)
  }
  function terminarArrastre() {
    if (arrastreY > 80) setMenuAbierto(false)
    setArrastreY(0)
    arrastreInicioRef.current = null
  }

  async function handleArchivosDesdeSheet(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    e.target.value = ''
    if (!files || files.length === 0) return

    setMenuAbierto(false)
    setError(null)
    setEstado('analizando')
    setFase('analizando')

    const listos = await convertirHeicSiNecesario(files, (msg) =>
      setError((prev) => (prev ? `${prev} · ` : '') + msg)
    )

    if (listos.length === 0) {
      setEstado('inicial')
      return
    }

    if (!grupo) {
      setEstado('inicial')
      return
    }

    try {
      const combinados = await analizarArchivos(
        listos,
        {
          onFase: setFase,
          onProgreso: (completados, total) => setProgreso({ completados, total }),
        },
        supabase,
        grupo.institucion_id
      )
      setAlumnos(combinados)
      setEstado('revisando')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ocurrió un error al analizar los archivos.')
      setEstado('inicial')
    }
  }

  function actualizarAlumno(index: number, campo: keyof AlumnoPreview, valor: string) {
    setAlumnos((prev) =>
      prev.map((a, i) =>
        i === index
          ? {
              ...a,
              [campo]: campo === 'numero_lista' ? (valor ? parseInt(valor, 10) : null) : valor || null,
              // Al corregir la CURP se asume que el docente ya resolvió el
              // duplicado; si vuelve a coincidir se detectará de nuevo al
              // reintentar la importación.
              ...(campo === 'curp' ? { duplicado: false } : {}),
            }
          : a
      )
    )
  }

  function eliminarAlumno(index: number) {
    setAlumnos((prev) => prev.filter((_, i) => i !== index))
  }

  function agregarFilaVacia() {
    setAlumnos((prev) => [...prev, { numero_lista: prev.length + 1, nombre: '', curp: null, sexo: null }])
  }

  function irACorregir() {
    primeraFilaConAtencionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    primeraFilaConAtencionRef.current?.focus()
  }

  function cancelarRevision() {
    setAlumnos([])
    setError(null)
    setEstado('inicial')
  }

  async function confirmarImportacion() {
    if (!grupo) return
    setError(null)

    const alumnosValidos = alumnos.filter((a) => a.nombre.trim().length > 0 && !a.duplicado)
    if (alumnosValidos.length === 0) {
      setError('No hay alumnos válidos para importar. Verifica que tengan nombre y que no estén ya registrados.')
      return
    }

    setEstado('guardando')
    const { error: guardarError } = await guardarAlumnosImportados(supabase, grupo, alumnosValidos)

    if (guardarError) {
      setError(guardarError)
      setEstado('revisando')
      return
    }

    setAlumnos([])
    setEstado('inicial')
    onImportacionCompleta()
  }

  const indiceFase = FASES.indexOf(fase)
  const fraccionFaseActual = fase === 'analizando' && progreso.total > 0 ? progreso.completados / progreso.total : 1
  const porcentaje = Math.round(((indiceFase + fraccionFaseActual) / FASES.length) * 100)
  const totalConAtencion = alumnos.filter(necesitaAtencion).length
  const primerIndiceConAtencion = alumnos.findIndex(necesitaAtencion)

  if (!grupo) return null

  const contenidoMenu = (
    <div className="divide-y divide-gray-100 py-1">
      <div className="relative flex items-center gap-3 px-4 py-2.5 active:bg-gray-50">
        <input
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          onChange={handleArchivosDesdeSheet}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
        <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-600">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-[18px] w-[18px]">
            <path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1-2h7l1 2h2A1.5 1.5 0 0 1 20 8.5v9A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5v-9z" strokeLinejoin="round" />
            <circle cx="12" cy="12.5" r="3.3" />
          </svg>
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900">Tomar foto</p>
          <p className="text-xs text-gray-400">Fotografía una lista o documento</p>
        </div>
      </div>

      <div className="relative flex items-center gap-3 px-4 py-2.5 active:bg-gray-50">
        <input
          type="file"
          accept="image/*"
          multiple
          onChange={handleArchivosDesdeSheet}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
        <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-600">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-[18px] w-[18px]">
            <rect x="4" y="5.5" width="16" height="13" rx="1.5" strokeLinejoin="round" />
            <circle cx="9" cy="10" r="1.4" />
            <path d="M4.5 16.5l4.5-4.5c.6-.6 1.4-.6 2 0L15.5 16.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M13.5 15l1.5-1.5c.6-.6 1.4-.6 2 0l2.5 2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900">Fotos</p>
          <p className="text-xs text-gray-400">Selecciona una o varias imágenes</p>
        </div>
      </div>

      <div className="relative flex items-center gap-3 px-4 py-2.5 active:bg-gray-50">
        <input
          type="file"
          accept=".pdf,.doc,.docx,.xlsx,.xls,.jpg,.jpeg,.png,.heic,.heif"
          multiple
          onChange={handleArchivosDesdeSheet}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
        <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-600">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-[18px] w-[18px]">
            <path d="M6.5 4h7l4 4v11.5a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5V4.5a.5.5 0 0 1 .5-.5z" strokeLinejoin="round" />
            <path d="M13.5 4v4h4" strokeLinejoin="round" />
          </svg>
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900">Archivos</p>
          <p className="text-xs text-gray-400">PDF, Word, Excel o imágenes</p>
        </div>
      </div>
    </div>
  )

  return (
    <>
      <button
        ref={refs.setReference}
        type="button"
        className={triggerClassName ?? CLASE_TRIGGER_DEFECTO}
        {...getReferenceProps()}
      >
        {triggerLabel ?? '🟢 Importar'}
      </button>

      {/* Escritorio/tablet: Popover anclado al botón */}
      {menuAbierto && esEscritorio && (
        <FloatingFocusManager context={context} modal={false}>
          <div
            // eslint-disable-next-line react-hooks/refs -- patrón oficial de @floating-ui/react: refs.setFloating es un callback ref estable, no una lectura de .current.
            ref={refs.setFloating}
            style={floatingStyles}
            {...getFloatingProps()}
            className="z-50 w-72 overflow-hidden rounded-2xl bg-white/95 shadow-2xl backdrop-blur-xl"
          >
            {contenidoMenu}
          </div>
        </FloatingFocusManager>
      )}

      {/* Móvil: Bottom Sheet nativo, con deslizar hacia abajo para cerrar */}
      {!esEscritorio && (
        <div
          className={`fixed inset-0 z-50 flex items-end justify-center px-4 pb-6 transition-opacity duration-200 ${menuAbierto ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'}`}
        >
          <div className="absolute inset-0 bg-black/20 backdrop-blur-[2px]" onClick={() => setMenuAbierto(false)} />
          <div
            // eslint-disable-next-line react-hooks/refs -- patrón oficial de @floating-ui/react: refs.setFloating es un callback ref estable, no una lectura de .current.
            ref={refs.setFloating}
            {...getFloatingProps()}
            onPointerDown={iniciarArrastre}
            onPointerMove={moverArrastre}
            onPointerUp={terminarArrastre}
            style={{ transform: menuAbierto ? `translateY(${arrastreY}px)` : undefined }}
            className={`relative w-[88%] max-w-[360px] overflow-hidden rounded-3xl bg-white/95 shadow-2xl backdrop-blur-xl transition-all duration-200 ${menuAbierto ? 'translate-y-0 scale-100 opacity-100' : 'translate-y-3 scale-95 opacity-0'}`}
          >
            <div className="mx-auto mb-1 mt-2 h-1.5 w-10 rounded-full bg-gray-200" />
            {contenidoMenu}
          </div>
        </div>
      )}

      {/* Superposición de análisis y revisión — sin cambios respecto a la versión anterior */}
      {estado !== 'inicial' && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-white">
          <div className="mx-auto max-w-2xl px-4 py-8">
            {error && (
              <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
            )}

            {estado === 'analizando' && (
              <div className="rounded-2xl border border-gray-200 px-6 py-12 text-center">
                <p className="text-base font-medium text-gray-800">{MENSAJE_FASE[fase]}</p>
                <div className="mx-auto mt-5 h-2 w-full max-w-xs overflow-hidden rounded-full bg-gray-100">
                  <div
                    className="h-full rounded-full bg-emerald-600 transition-all duration-300"
                    style={{ width: `${porcentaje}%` }}
                  />
                </div>
              </div>
            )}

            {(estado === 'revisando' || estado === 'guardando') && (
              <div>
                <p className="mb-3 text-sm text-gray-600">
                  <span className="font-medium">{alumnos.length}</span> alumno{alumnos.length === 1 ? '' : 's'} detectado{alumnos.length === 1 ? '' : 's'}
                  {totalConAtencion > 0 && (
                    <> · <span className="font-medium text-amber-700">{totalConAtencion} necesita{totalConAtencion === 1 ? '' : 'n'} revisión</span></>
                  )}
                </p>

                <div className="mb-4 overflow-x-auto rounded-2xl border border-gray-200">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 text-left text-xs font-medium uppercase tracking-wide text-gray-500">
                      <tr>
                        <th className="px-3 py-2">#</th>
                        <th className="px-3 py-2">Nombre completo</th>
                        <th className="px-3 py-2">CURP</th>
                        <th className="px-3 py-2">Sexo</th>
                        <th className="px-3 py-2"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {alumnos.map((a, i) => {
                        const requiereAtencion = necesitaAtencion(a)
                        const esPrimeraConAtencion = i === primerIndiceConAtencion
                        return (
                          <Fragment key={i}>
                            <tr
                              className={
                                a.duplicado
                                  ? 'bg-red-50/60 border-l-2 border-red-400'
                                  : requiereAtencion
                                    ? 'bg-amber-50/60 border-l-2 border-amber-400'
                                    : undefined
                              }
                            >
                              <td className="px-2 py-1">
                                <input
                                  type="number"
                                  value={a.numero_lista ?? ''}
                                  onChange={(e) => actualizarAlumno(i, 'numero_lista', e.target.value)}
                                  className="w-14 rounded-lg border border-gray-200 px-2 py-1 text-center"
                                />
                              </td>
                              <td className="px-2 py-1">
                                <input
                                  ref={esPrimeraConAtencion ? primeraFilaConAtencionRef : undefined}
                                  type="text"
                                  value={a.nombre}
                                  onChange={(e) => actualizarAlumno(i, 'nombre', e.target.value)}
                                  placeholder={requiereAtencion && !a.nombre.trim() ? 'Falta el nombre' : undefined}
                                  className={`w-full min-w-[180px] rounded-lg border px-2 py-1 ${!a.nombre.trim() ? 'border-amber-300' : 'border-gray-200'}`}
                                />
                              </td>
                              <td className="px-2 py-1">
                                <input
                                  type="text"
                                  value={a.curp ?? ''}
                                  onChange={(e) => actualizarAlumno(i, 'curp', e.target.value)}
                                  placeholder={!a.curp ? '—' : undefined}
                                  className={`w-36 rounded-lg border px-2 py-1 uppercase ${a.duplicado ? 'border-red-300' : !a.curp ? 'border-amber-300' : 'border-gray-200'}`}
                                />
                              </td>
                              <td className="px-2 py-1">
                                <select
                                  value={a.sexo ?? ''}
                                  onChange={(e) => actualizarAlumno(i, 'sexo', e.target.value)}
                                  className={`rounded-lg border px-2 py-1 ${!a.sexo ? 'border-amber-300' : 'border-gray-200'}`}
                                >
                                  <option value="">—</option>
                                  <option value="H">H</option>
                                  <option value="M">M</option>
                                </select>
                              </td>
                              <td className="px-2 py-1">
                                <button type="button" onClick={() => eliminarAlumno(i)} className="text-gray-400 hover:text-red-600">
                                  ✕
                                </button>
                              </td>
                            </tr>
                            {a.duplicado && (
                              <tr className="bg-red-50/60 border-l-2 border-red-400">
                                <td colSpan={5} className="px-3 pb-2 pt-0 text-xs font-medium text-red-700">
                                  Este alumno ya se encuentra registrado en el sistema.
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                <button
                  type="button"
                  onClick={agregarFilaVacia}
                  className="mb-6 text-sm font-medium text-emerald-700 hover:text-emerald-800"
                >
                  + Agregar alumno
                </button>

                <div className="flex flex-col gap-2.5 sm:flex-row-reverse">
                  <button
                    type="button"
                    onClick={confirmarImportacion}
                    disabled={estado === 'guardando'}
                    className="flex-1 rounded-2xl bg-emerald-600 py-3.5 text-base font-medium text-white transition hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {estado === 'guardando' ? 'Guardando...' : 'Confirmar importación'}
                  </button>
                  <button
                    type="button"
                    onClick={irACorregir}
                    disabled={totalConAtencion === 0 || estado === 'guardando'}
                    className="rounded-2xl border border-gray-300 px-5 py-3.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-40"
                  >
                    Corregir
                  </button>
                  <button
                    type="button"
                    onClick={cancelarRevision}
                    disabled={estado === 'guardando'}
                    className="rounded-2xl px-5 py-3.5 text-sm font-medium text-gray-500 transition hover:bg-gray-50 disabled:opacity-40"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
