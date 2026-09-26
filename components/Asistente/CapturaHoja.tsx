'use client'

// components/Asistente/CapturaHoja.tsx
//
// EVAL-1G — acción contextual de la tarjeta "Hoja de evaluación final"
// (ArchivoGeneradoInfo.tipoDocumento==='hoja_evaluacion', ver
// TarjetaDescarga en AsistentePanel.tsx): tomar/subir la(s)
// fotografía(s) de la hoja ya contestada y encadenar
// foto-hoja -> analizar-hoja -> estado-captura/revisar-hoja ->
// (resumen + botón Confirmar) o (enlace a la pantalla de revisión de
// EVAL-1F). Reutiliza ÍNTEGRAMENTE las rutas ya construidas en
// EVAL-1C..1F — este componente NUNCA decide si una celda es
// bloqueante ni construye ninguna matriz por su cuenta: solo lee el
// estado que el backend ya calculó
// (determinarEstadoCapturaHoja/construirMatrizRevision).
//
// ORDEN DE PÁGINAS — nunca se infiere del orden de un FileList de
// selección múltiple: no hay garantía documentada, cross-plataforma
// (Fototeca de iOS, selector de Android, selector de escritorio), de
// que el orden de un FileList con varios archivos coincida con el
// orden físico en que el docente tocó las fotos. En vez de depender de
// eso, el <input> de este componente NUNCA lleva `multiple`: cada
// selección entrega exactamente 1 archivo, y el número de página lo
// asigna el propio estado del componente (paginasCargadas + 1) —
// nunca el navegador ni el sistema operativo. Para una hoja de 1 sola
// página esto es exactamente igual de directo que antes (una sola
// selección → sube → analiza, sin ningún paso extra); para varias
// páginas, el botón "Agregar página N" solo aparece cuando de verdad
// hace falta (analizar-hoja reportó que faltan páginas) — nunca se le
// pregunta al docente de antemano cuántas tiene la hoja.
//
// ESTADO — el componente NUNCA reconstruye/adivina un estado a partir
// de un código HTTP: siempre confía en el campo `estado` (enum
// discreto) que devuelve GET estado-captura o, tras confirmar, en la
// respuesta explícita de confirmar-hoja. Cada acción que cambia algo
// en el servidor termina re-sincronizando vía cargarEstado(), nunca
// dejando que el cliente decida por su cuenta cuál es el estado
// siguiente.

import { useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'

export type EstadoCapturaHoja =
  | 'sin_fotografia'
  | 'captura_incompleta'
  | 'lista_para_analizar'
  | 'revision_pendiente'
  | 'lista_para_confirmar'
  | 'confirmado'

type Fase = 'cargando' | 'listo' | 'subiendo' | 'analizando' | 'confirmando' | 'error'

const EN_CURSO: Fase[] = ['cargando', 'subiendo', 'analizando', 'confirmando']

export default function CapturaHoja({
  proyectoId,
  // EVAL-1I (pulido UX de Evaluación) — callback OPCIONAL, puramente
  // de observación: no cambia en nada el comportamiento interno de
  // este componente (sigue siendo la única fuente de la verdad de
  // CÓMO capturar/analizar/confirmar). Existe solo para que un padre
  // que muestre su propio resumen del estado (ej. la tarjeta de
  // Evaluación) pueda mantenerlo sincronizado EN VIVO mientras este
  // componente está expandido, sin repetir ninguna llamada a
  // estado-captura por su cuenta — se le pasa exactamente el mismo
  // valor que este componente ya obtuvo. La tarjeta de la hoja en el
  // Chat (AsistentePanel.tsx) no lo pasa — sigue funcionando idéntico.
  onEstadoCambiado,
}: {
  proyectoId: string
  onEstadoCambiado?: (estado: EstadoCapturaHoja) => void
}) {
  const [fase, setFase] = useState<Fase>('cargando')
  const [estado, setEstado] = useState<EstadoCapturaHoja | null>(null)
  const [paginasEsperadas, setPaginasEsperadas] = useState(0)
  const [paginasCargadas, setPaginasCargadas] = useState(0)
  const [totalAlumnos, setTotalAlumnos] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // Guarda de doble-tap real (no depende solo de deshabilitar el botón
  // en pantalla): mientras esté en true, ninguna acción nueva arranca,
  // sin importar cuántas veces se dispare el evento.
  const enCursoRef = useRef(false)

  const obtenerAccessToken = async (): Promise<string | null> => {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token ?? null
  }

  const cargarMatrizParaResumen = async (accessToken: string) => {
    const res = await fetch(`/api/proyectos-seguimiento/${proyectoId}/revisar-hoja`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    const json = await res.json()
    if (res.ok) setTotalAlumnos(json.matriz?.alumnos?.length ?? null)
  }

  // analizar()/cargarEstado() envuelven su fetch/json en try/catch: una
  // excepción de red (pestaña suspendida en segundo plano de iOS
  // Safari durante la espera real de la llamada de visión, AbortError,
  // pérdida momentánea de conexión, respuesta no-JSON) NUNCA debe
  // dejar `fase` congelada en 'analizando'/'cargando' — siempre debe
  // resolver a 'error', con un mensaje que no asume que el servidor
  // falló (puede haber terminado bien: por eso el botón "Reintentar"/
  // "Verificar estado" solo vuelve a leer el estado real, nunca vuelve
  // a subir la foto ni a llamar analizar-hoja por su cuenta).
  const analizar = async (accessToken: string) => {
    setFase('analizando')
    try {
      const res = await fetch(`/api/proyectos-seguimiento/${proyectoId}/analizar-hoja`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: accessToken }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error || 'No se pudo leer la fotografía.')
        setFase('error')
        return
      }
      await cargarEstado()
    } catch (err) {
      setError('No pudimos confirmar si la hoja terminó de leerse. Verifica el estado antes de reintentar.')
      setFase('error')
    }
  }

  const cargarEstado = async () => {
    setFase('cargando')
    setError(null)
    try {
      const accessToken = await obtenerAccessToken()
      if (!accessToken) {
        setError('Tu sesión expiró. Vuelve a iniciar sesión.')
        setFase('error')
        return
      }
      const res = await fetch(`/api/proyectos-seguimiento/${proyectoId}/estado-captura`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error || 'No se pudo consultar el estado de esta hoja.')
        setFase('error')
        return
      }
      setEstado(json.estado)
      setPaginasEsperadas(json.paginasEsperadas)
      setPaginasCargadas(json.paginasCargadas)

      // Caso de reanudación: todas las páginas ya estaban cargadas pero
      // el análisis no llegó a dispararse (ej. el docente cerró la app
      // justo después de subir la última página) — se retoma solo, sin
      // pedirle nada de nuevo al docente.
      if (json.estado === 'lista_para_analizar') {
        await analizar(accessToken)
        return
      }
      if (json.estado === 'revision_pendiente' || json.estado === 'lista_para_confirmar') {
        await cargarMatrizParaResumen(accessToken)
      }
      setFase('listo')
    } catch (err) {
      setError('No se pudo consultar el estado de esta hoja. Verifica tu conexión e intenta de nuevo.')
      setFase('error')
    }
  }

  useEffect(() => {
    cargarEstado()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Notifica al padre (si le pasó el callback) cada vez que el estado
  // real cambia — mount inicial, después de subir/analizar/confirmar.
  // Nunca dispara una consulta nueva: solo reenvía el valor que este
  // componente ya obtuvo por su cuenta.
  useEffect(() => {
    if (estado) onEstadoCambiado?.(estado)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estado])

  // onArchivoSeleccionado()/confirmar() envuelven TODO su cuerpo (tras
  // marcar enCursoRef.current=true) en try/finally: sin importar si
  // terminan bien, con un error de servidor, o con una excepción de
  // red/cliente (fetch/res.json/AbortError/pestaña suspendida), el
  // finally SIEMPRE libera la guarda — nunca queda un camino de salida
  // que la deje atascada en true.
  const onArchivoSeleccionado = async (file: File) => {
    if (enCursoRef.current) return
    enCursoRef.current = true
    setFase('subiendo')
    setError(null)
    try {
      const accessToken = await obtenerAccessToken()
      if (!accessToken) {
        setError('Tu sesión expiró. Vuelve a iniciar sesión.')
        setFase('error')
        return
      }

      const formData = new FormData()
      formData.append('access_token', accessToken)
      formData.append('foto', file)
      // Nunca el orden de un FileList — el número de página lo controla
      // el propio estado del componente (ver comentario de cabecera).
      formData.append('pagina', String(paginasCargadas + 1))

      const res = await fetch(`/api/proyectos-seguimiento/${proyectoId}/foto-hoja`, { method: 'POST', body: formData })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error || 'No se pudo subir la fotografía.')
        setFase('error')
        return
      }

      setPaginasCargadas(json.paginasCargadas)
      setPaginasEsperadas(json.paginasEsperadas)

      if (json.paginasCargadas >= json.paginasEsperadas) {
        await analizar(accessToken)
      } else {
        setEstado('captura_incompleta')
        setFase('listo')
      }
    } catch (err) {
      setError('No pudimos confirmar si tu fotografía terminó de subirse. Verifica el estado antes de reintentar.')
      setFase('error')
    } finally {
      enCursoRef.current = false
    }
  }

  const confirmar = async () => {
    if (enCursoRef.current) return
    enCursoRef.current = true
    setFase('confirmando')
    setError(null)
    try {
      const accessToken = await obtenerAccessToken()
      if (!accessToken) {
        setError('Tu sesión expiró. Vuelve a iniciar sesión.')
        setFase('error')
        return
      }
      const res = await fetch(`/api/proyectos-seguimiento/${proyectoId}/confirmar-hoja`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: accessToken }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error || 'No se pudo confirmar. Intenta de nuevo.')
        setFase('error')
        return
      }
      // Estado terminal explícito, tal como lo confirmó el servidor —
      // nunca se vuelve a ofrecer subir/confirmar después de esto.
      setEstado('confirmado')
      setFase('listo')
    } catch (err) {
      setError('No pudimos confirmar si tus resultados se guardaron. Verifica el estado antes de reintentar.')
      setFase('error')
    } finally {
      enCursoRef.current = false
    }
  }

  const abrirSelector = () => {
    if (enCursoRef.current) return
    inputRef.current?.click()
  }

  const claseBoton = (variante: 'primario' | 'secundario') =>
    variante === 'primario'
      ? 'w-full flex items-center justify-center gap-1 bg-blue-600 text-white text-xs font-semibold px-3 py-2 rounded-full hover:bg-blue-700 disabled:opacity-50'
      : 'w-full flex items-center justify-center gap-1 border border-gray-200 text-gray-700 text-xs font-semibold px-3 py-2 rounded-full hover:bg-gray-50 disabled:opacity-50'

  const inputOculto = (
    <input
      ref={inputRef}
      type="file"
      // Mismo whitelist real ya aceptado por foto-hoja/route.ts — HEIC/
      // HEIF explícitos (fotos por defecto de iPhone), sin `multiple`
      // (ver comentario de cabecera: el orden de página nunca depende
      // del navegador).
      accept="image/*,.heic,.heif"
      className="hidden"
      onChange={(e) => {
        const files = Array.from(e.target.files || [])
        e.target.value = ''
        if (files[0]) onArchivoSeleccionado(files[0])
      }}
    />
  )

  if (fase === 'cargando' && estado === null) {
    return (
      <div className="px-3 pb-3 pt-1 border-t border-gray-50">
        <p className="text-[11px] text-gray-400">Consultando el estado de la hoja…</p>
      </div>
    )
  }

  return (
    <div className="px-3 pb-3 pt-2 space-y-1.5 border-t border-gray-50">
      {inputOculto}

      {error && <p className="text-[11px] text-red-600">{error}</p>}
      {fase === 'error' && (
        <button type="button" onClick={cargarEstado} className={claseBoton('secundario')}>
          Reintentar
        </button>
      )}

      {fase === 'subiendo' && <p className="text-[11px] text-gray-500">Subiendo fotografía…</p>}
      {fase === 'analizando' && (
        <div className="space-y-1">
          <p className="text-[11px] text-gray-500">Leyendo la hoja… puede tardar un momento.</p>
          {/* "Verificar estado" llama ÚNICAMENTE a cargarEstado() — nunca
              vuelve a subir la foto ni a llamar analizar-hoja por su
              cuenta. Existe para el caso real donde el servidor ya
              terminó (extraidoBruto/estado ya persistidos) pero el
              cliente nunca llegó a enterarse; es seguro pulsarlo más de
              una vez porque solo lee el estado real, nunca escribe. */}
          <button type="button" onClick={cargarEstado} className="text-[11px] text-gray-400 underline underline-offset-2 hover:text-gray-600">
            Verificar estado
          </button>
        </div>
      )}
      {fase === 'confirmando' && <p className="text-[11px] text-gray-500">Guardando resultados…</p>}
      {fase === 'cargando' && estado !== null && <p className="text-[11px] text-gray-400">Actualizando…</p>}

      {fase !== 'error' && !EN_CURSO.includes(fase) && estado === 'sin_fotografia' && (
        <button type="button" onClick={abrirSelector} className={claseBoton('primario')}>
          📷 Subir foto de la hoja contestada
        </button>
      )}

      {fase !== 'error' && !EN_CURSO.includes(fase) && estado === 'captura_incompleta' && (
        <>
          <p className="text-[11px] text-gray-500">
            Página(s) cargada(s): {paginasCargadas} de {paginasEsperadas}.
          </p>
          <button type="button" onClick={abrirSelector} className={claseBoton('primario')}>
            📷 Agregar página {paginasCargadas + 1}
          </button>
        </>
      )}

      {fase !== 'error' && !EN_CURSO.includes(fase) && estado === 'revision_pendiente' && (
        <>
          <p className="text-[11px] text-amber-700">Algunas respuestas no se leyeron con claridad — necesitan tu revisión antes de confirmar.</p>
          <a href={`/dashboard/seguimiento/${proyectoId}/revisar`} className={claseBoton('primario')}>
            Revisar y corregir
          </a>
        </>
      )}

      {fase !== 'error' && !EN_CURSO.includes(fase) && estado === 'lista_para_confirmar' && (
        <>
          <p className="text-[11px] text-green-700">
            {totalAlumnos != null ? `La hoja se leyó correctamente — ${totalAlumnos} alumno(s) listos.` : 'La hoja se leyó correctamente.'}
          </p>
          <button type="button" onClick={confirmar} className={claseBoton('primario')}>
            ✅ Confirmar resultados
          </button>
        </>
      )}

      {fase !== 'error' && estado === 'confirmado' && <p className="text-[11px] text-green-700">✅ Resultados confirmados.</p>}
    </div>
  )
}
