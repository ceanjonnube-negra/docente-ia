'use client'
import { Fragment, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
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

// Un solo <input type="file"> nativo, sin menú propio delante — mismo
// patrón ya validado en producción para el botón de adjuntar del Chat
// IA (ver components/Asistente/AsistentePanel.tsx, commit "eliminar la
// doble capa de menús"). Un menú propio (con opciones "Tomar
// foto"/"Fotos"/"Archivos") que abre por debajo un <input type="file">
// sin `capture` seguía disparando el selector nativo del sistema
// operativo (Fototeca/Tomar foto/Elegir archivo) ENCIMA del menú propio
// — esa es la causa exacta del "doble menú" reportado. Al tocar
// "Importar" se llama directamente a este único input: el sistema
// operativo muestra su propio selector una sola vez, con esas mismas 3
// opciones, sin ningún menú previo.
const ACCEPT_IMPORTACION = 'image/*,.heic,.heif,.pdf,.doc,.docx,.xlsx,.xls'

// Botón "Importar" (dispara el único <input type="file"> nativo) +
// análisis automático + revisión final, todo en un solo componente.
export default function ImportacionInteligente({
  grupo,
  onImportacionCompleta,
  triggerClassName,
  triggerLabel,
  autoAbrir,
}: Props) {
  const [estado, setEstado] = useState<Estado>('inicial')
  const [fase, setFase] = useState<Fase>('analizando')
  const [alumnos, setAlumnos] = useState<AlumnoPreview[]>([])
  const [error, setError] = useState<string | null>(null)
  const [progreso, setProgreso] = useState({ completados: 0, total: 0 })
  const primeraFilaConAtencionRef = useRef<HTMLInputElement | null>(null)
  const inputArchivoRef = useRef<HTMLInputElement | null>(null)

  // autoAbrir: la pantalla de importación por foto de grupo dispara la
  // selección de archivo en cuanto se monta, sin que el docente tenga
  // que tocar primero el botón "Importar" (ver
  // app/dashboard/grupos/[id]/importar/page.tsx).
  useEffect(() => {
    if (autoAbrir) inputArchivoRef.current?.click()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function manejarArchivosSeleccionados(files: FileList) {
    if (!files || files.length === 0) return

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

  return (
    <>
      <input
        ref={inputArchivoRef}
        type="file"
        accept={ACCEPT_IMPORTACION}
        multiple
        className="hidden"
        onChange={(e) => {
          const files = e.target.files
          e.target.value = ''
          if (files && files.length > 0) manejarArchivosSeleccionados(files)
        }}
      />
      <button
        type="button"
        onClick={() => inputArchivoRef.current?.click()}
        aria-label="Importar lista de alumnos"
        className={triggerClassName ?? CLASE_TRIGGER_DEFECTO}
      >
        {triggerLabel ?? '🟢 Importar'}
      </button>

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
