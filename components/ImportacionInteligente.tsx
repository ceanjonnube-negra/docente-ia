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
  esLoteComparableConRoster,
  compararConRosterActual,
  tieneRosterActivo,
} from '@/lib/importacionInteligente'
import type { CategoriaDiffListaOficial } from '@/lib/listaOficial/matchingListaOficial'
import type { ResultadoCompararConRoster } from '@/lib/importacionInteligente'

type Estado = 'inicial' | 'analizando' | 'revisando' | 'guardando' | 'comparando' | 'revisando_comparacion'

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

// Límite interno silencioso de archivos por lote — el selector nativo de
// iOS/Android no permite que una página web restrinja visualmente cuántos
// elementos puede marcar el docente dentro de Fotos/Archivos, así que el
// límite se aplica aquí, después de la selección: si llegan más de
// MAX_ARCHIVOS_IMPORTACION, se toman solo los primeros y el resto del
// flujo continúa exactamente igual, sin ningún aviso — nunca se
// manipula ni se intenta restringir el picker nativo en sí.
const MAX_ARCHIVOS_IMPORTACION = 10

// Etiquetas visibles para la preview READ-ONLY de la rama de
// comparación (fase 1) — texto únicamente, no cambia ningún criterio de
// clasificación (eso vive por completo en V1-B, matchingListaOficial.ts).
const CATEGORIA_LABEL: Record<CategoriaDiffListaOficial, string> = {
  SIN_CAMBIO: 'Sin cambio',
  NUEVO_POSIBLE: 'Posible alumno nuevo',
  CURP_FALTANTE_EN_DB: 'CURP faltante en el sistema',
  CURP_DIFERENTE: 'CURP diferente (conflicto)',
  LECTURA_DUDOSA: 'Lectura dudosa',
  MATCH_AMBIGUO: 'Coincidencia ambigua',
  CURP_DUPLICADA: 'CURP ya pertenece a otro alumno',
  REGISTRO_DUPLICADO_EN_DOCUMENTO: 'Duplicado dentro del documento',
}

const ORDEN_CATEGORIAS: CategoriaDiffListaOficial[] = [
  'SIN_CAMBIO',
  'NUEVO_POSIBLE',
  'CURP_FALTANTE_EN_DB',
  'CURP_DIFERENTE',
  'LECTURA_DUDOSA',
  'MATCH_AMBIGUO',
  'CURP_DUPLICADA',
  'REGISTRO_DUPLICADO_EN_DOCUMENTO',
]

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
  const [resultadoComparacion, setResultadoComparacion] = useState<ResultadoCompararConRoster | null>(null)
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

  // CORRECCIÓN — "selección de Fotos en iOS no llegaba al análisis"
  // (ver PENDIENTE 1, evidencia real de Safari Web Inspector): recibe
  // ya un File[] real, nunca el FileList vivo del input — la copia a
  // array ahora ocurre en el propio onChange, ANTES de resetear
  // input.value, porque en iOS Safari ese reset puede vaciar el
  // FileList original si todavía no se copió su contenido.
  async function manejarArchivosSeleccionados(files: File[]) {
    if (!files || files.length === 0) return

    setError(null)
    setEstado('analizando')
    setFase('analizando')

    const seleccionados = files.slice(0, MAX_ARCHIVOS_IMPORTACION)

    const listos = await convertirHeicSiNecesario(seleccionados, (msg) =>
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

    // Fuente de verdad REAL para decidir ALTA vs COMPARACIÓN: lectura
    // FRESCA de existencia de roster en este mismo instante — nunca un
    // valor calculado en un render anterior (podría estar desactualizado
    // si el roster cambió en otra pestaña/dispositivo o vía Chat IA
    // mientras esta pantalla permanecía abierta). Fail-closed explícito:
    // si esta verificación falla, NO se intenta ni ALTA ni comparación.
    let rosterActivo: boolean
    try {
      rosterActivo = await tieneRosterActivo(supabase, grupo.id)
    } catch {
      setError('No se pudo verificar el estado actual del grupo. Intenta de nuevo.')
      setEstado('inicial')
      return
    }

    // Grupo YA poblado (confirmado ahora mismo): la ÚNICA rama permitida
    // a partir de aquí es comparación/actualización — NUNCA el alta
    // clásica. Un PDF/Word/Excel o un lote de 5+ imágenes en un grupo
    // con roster jamás debe caer en analizarArchivos/
    // guardarAlumnosImportados (ese camino podría intentar dar de alta
    // alumnos que ya existen); si el lote no es comparable todavía, se
    // falla cerrado con un mensaje claro, sin ninguna escritura.
    if (rosterActivo) {
      if (!esLoteComparableConRoster(listos)) {
        setError('Para actualizar una lista existente, por ahora selecciona de 1 a 4 imágenes.')
        setEstado('inicial')
        return
      }
      try {
        setEstado('comparando')
        const resultado = await compararConRosterActual(listos, supabase, grupo.id)
        setResultadoComparacion(resultado)
        setEstado('revisando_comparacion')
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Ocurrió un error al comparar la lista.')
        setEstado('inicial')
      }
      return
    }

    // Grupo sin roster activo (confirmado ahora mismo): flujo de ALTA
    // histórico, sin cambios — soporta imágenes, PDF, Word y Excel
    // exactamente como antes.
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

  // Fase 1 de la rama de comparación es exclusivamente de revisión: no
  // existe ningún "confirmar" aquí — cerrar es la única salida posible,
  // y no cambia ningún dato.
  function cerrarComparacion() {
    setResultadoComparacion(null)
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
          // CORRECCIÓN — "selección de Fotos en iOS no llegaba al
          // análisis" (evidencia real: Safari Web Inspector mostró
          // [ARCHIVOS][lista] change count=1 seguido de post_reset
          // count=0 — resetear input.value vaciaba el FileList antes
          // de que se copiara su contenido). Array.from(...) copia los
          // File reales ANTES del reset, igual que ya hace de forma
          // segura el input de adjuntos del Chat IA.
          const files = Array.from(e.target.files || [])
          e.target.value = ''
          if (files.length > 0) manejarArchivosSeleccionados(files)
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

            {estado === 'comparando' && (
              <div className="rounded-2xl border border-gray-200 px-6 py-12 text-center">
                <p className="text-base font-medium text-gray-800">Comparando con la lista actual del grupo...</p>
              </div>
            )}

            {estado === 'revisando_comparacion' && resultadoComparacion && (() => {
              const { comparacion, propuestasReparacionCurp } = resultadoComparacion
              const conteos = ORDEN_CATEGORIAS.reduce((acc, cat) => {
                acc[cat] = 0
                return acc
              }, {} as Record<CategoriaDiffListaOficial, number>)
              for (const r of comparacion.resultados) conteos[r.categoriaDiff] += 1
              const filasParaRevisar = comparacion.resultados.filter((r) => r.categoriaDiff !== 'SIN_CAMBIO')
              const ausentes = comparacion.ausentesEnDocumento
              const candidatosReparacion = propuestasReparacionCurp?.candidatos ?? []

              return (
                <div>
                  <div className="mb-4 rounded-lg bg-blue-50 px-4 py-3 text-sm text-blue-800">
                    Vista previa de solo lectura. Ningún dato del grupo se ha modificado.
                  </div>

                  <p className="mb-3 text-sm text-gray-600">
                    <span className="font-medium">{comparacion.resultados.length}</span> registro{comparacion.resultados.length === 1 ? '' : 's'} leído{comparacion.resultados.length === 1 ? '' : 's'} del documento
                  </p>

                  <div className="mb-5 flex flex-wrap gap-2">
                    {ORDEN_CATEGORIAS.filter((cat) => conteos[cat] > 0).map((cat) => (
                      <span key={cat} className="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-700">
                        {CATEGORIA_LABEL[cat]}: {conteos[cat]}
                      </span>
                    ))}
                    {ausentes.length > 0 && (
                      <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-700">
                        Ausentes en el documento: {ausentes.length}
                      </span>
                    )}
                  </div>

                  {candidatosReparacion.length > 0 && (
                    <div className="mb-5">
                      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">Datos que podrían corregirse</p>
                      <div className="divide-y divide-gray-100 rounded-2xl border border-gray-200">
                        {candidatosReparacion.map((c) => (
                          <div key={c.alumnoId} className="px-3 py-2 text-sm">
                            <p className="mb-1 font-medium text-gray-800">{c.alumnoNombre}</p>
                            <p className="text-xs text-gray-500">Dato actual: <span className="text-gray-700">{c.curpActual}</span></p>
                            <p className="text-xs text-gray-500">Dato encontrado en la lista oficial: <span className="text-gray-700">{c.curpPropuesta}</span></p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {filasParaRevisar.length > 0 && (
                    <div className="mb-5">
                      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">Casos que requieren revisión</p>
                      <div className="divide-y divide-gray-100 rounded-2xl border border-gray-200">
                        {filasParaRevisar.map((r, i) => (
                          <div key={i} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                            <div className="min-w-0">
                              <p className="truncate font-medium text-gray-800">
                                {r.alumnoNombre || r.registro.nombreLeido || 'Sin nombre legible'}
                              </p>
                              {r.registro.curpLeida && (
                                <p className="truncate text-xs text-gray-400">{r.registro.curpLeida}</p>
                              )}
                            </div>
                            <span className="shrink-0 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700">
                              {CATEGORIA_LABEL[r.categoriaDiff]}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {ausentes.length > 0 && (
                    <div className="mb-5">
                      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">
                        Ausentes en el documento (solo informativo — no se da de baja a nadie)
                      </p>
                      <div className="divide-y divide-gray-100 rounded-2xl border border-gray-200">
                        {ausentes.map((a) => (
                          <div key={a.alumnoId} className="px-3 py-2 text-sm text-gray-700">
                            {a.alumnoNombre}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={cerrarComparacion}
                    className="w-full rounded-2xl border border-gray-300 py-3.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                  >
                    Cerrar
                  </button>
                </div>
              )
            })()}

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
