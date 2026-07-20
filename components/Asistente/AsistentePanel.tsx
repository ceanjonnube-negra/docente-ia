'use client'

// components/Asistente/AsistentePanel.tsx
//
// El Asistente IA como servicio global: se monta UNA sola vez en
// app/dashboard/layout.tsx, no en una ruta. Aparece como una burbuja
// flotante en cualquier pantalla de la aplicación; al abrirse, la
// conversación y el contexto vienen de AsistenteService (useAsistente),
// no de estado local — por eso sobrevive a la navegación entre módulos.
//
// El botón de micrófono inicia/termina el "modo conversación" real:
// AsistenteService cambia de MotorTextoClaude a MotorOpenAIRealtime (voz
// en tiempo real, con interrupción real) sin que este componente sepa
// nada del cambio — solo lee asistente.modoVoz. No hay cronómetro, no hay
// "Escuchando...", no hay texto de estado: esa lógica es interna al
// motor; aquí solo se ve la conversación.

import { useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useAsistente } from '@/lib/asistente/hooks'
import { esDocumentoFormal } from '@/lib/asistente/documentos'
import { analizarContenido, extraerTitulo } from '@/lib/documentGen/parseContenido'
import { obtenerFechaHora, obtenerZonaHorariaDispositivo } from '@/lib/tiempo/TimeService'

const saludoPorHora = (): string => obtenerFechaHora(obtenerZonaHorariaDispositivo()).saludo

const ICONO_ARCHIVO: Record<string, string> = { word: '📄', pdf: '🖨️', powerpoint: '📊', excel: '📈' }
const NOMBRE_FORMATO: Record<string, string> = { word: 'Word', pdf: 'PDF', powerpoint: 'PowerPoint', excel: 'Excel' }

// Tarjeta de descarga — un único componente para cualquier tipo de
// documento oficial (planeación, lista, ficha, oficio...) y cualquier
// formato (Word/PDF/...); nunca se duplica ni se crea una variante por
// tipo de documento. Se renderiza SIEMPRE que el mensaje traiga un
// archivo real, en paralelo a la vista previa si la hay — nunca en su
// lugar (ver el render de mensajes más abajo: nunca es
// `esDoc ? Preview : TarjetaDescarga`, siempre ambas si aplican).
// Mismo criterio que VENCIMIENTO_URL_SEGUNDOS en
// lib/documentGen/almacenamiento.ts (7 días) — la URL firmada real no
// se puede consultar sin gastar una llamada de red, así que se estima
// a partir de cuándo se creó el mensaje que trae el archivo (mismo
// instante en que se generó), un dato que ya existe y no hay que
// duplicar.
const VENCIMIENTO_URL_MS = 7 * 24 * 60 * 60 * 1000

async function compartirArchivo(archivo: { tipo: string; nombre: string; url: string }, alCopiarEnlace: () => void) {
  const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { canShare?: (data?: ShareData) => boolean }) : null
  try {
    if (nav?.canShare) {
      try {
        const res = await fetch(archivo.url)
        const blob = await res.blob()
        const file = new File([blob], archivo.nombre, { type: blob.type || 'application/octet-stream' })
        if (nav.canShare({ files: [file] })) {
          await nav.share({ files: [file], title: archivo.nombre })
          return
        }
      } catch {
        // el archivo no se pudo traer para compartir como adjunto —
        // sigue al siguiente nivel de respaldo (compartir la URL)
      }
    }
    if (nav?.share) {
      await nav.share({ title: archivo.nombre, url: archivo.url })
      return
    }
    await navigator.clipboard.writeText(archivo.url)
    alCopiarEnlace()
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return // el docente canceló la hoja de compartir, no es un error
    window.open(archivo.url, '_blank')
  }
}

function TarjetaDescarga({ archivo, creadoEn, className = '', resaltado = false }: { archivo: { tipo: string; nombre: string; url: string }; creadoEn: number; className?: string; resaltado?: boolean }) {
  const [enlaceCopiado, setEnlaceCopiado] = useState(false)
  // Date.now() no puede llamarse en el cuerpo del render (impuro para
  // el linter de React) — se calcula una sola vez al montar/cambiar
  // creadoEn. No necesita reactividad en vivo (nadie espera que la
  // tarjeta cambie de "vigente" a "vencida" sola mientras la mira): la
  // ventana real es de días, así que el único momento en que importa
  // es cuando se abre la conversación.
  const [vencido, setVencido] = useState(false)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- valor derivado de Date.now() (impuro por definición); solo se necesita una vez al montar, no reactividad continua.
    setVencido(Date.now() - creadoEn > VENCIMIENTO_URL_MS)
  }, [creadoEn])
  const nombreFormato = NOMBRE_FORMATO[archivo.tipo] ? ` ${NOMBRE_FORMATO[archivo.tipo]}` : ''

  return (
    <div className={`w-full max-w-sm bg-white rounded-2xl shadow-md border overflow-hidden rounded-bl-sm transition-shadow ${resaltado ? 'border-purple-300 ring-2 ring-purple-300' : 'border-green-100'} ${className}`}>
      <div className="px-4 py-3 flex items-center gap-2.5">
        <span className="text-xl flex-shrink-0">{ICONO_ARCHIVO[archivo.tipo] || '📄'}</span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-gray-900 truncate">{archivo.nombre}</p>
          <p className={`text-xs ${vencido ? 'text-amber-600' : 'text-green-600'}`}>
            {vencido ? 'Enlace vencido — pide el documento de nuevo' : 'Documento oficial listo'}
          </p>
        </div>
      </div>
      {!vencido && (
        <div className="px-3 pb-3 space-y-1.5">
          <button onClick={() => window.open(archivo.url, '_blank')} className="w-full flex items-center justify-center gap-1 bg-green-600 text-white text-xs font-semibold px-3 py-2 rounded-full hover:bg-green-700">
            ⬇️ Descargar{nombreFormato}
          </button>
          <div className="flex gap-1.5">
            <button onClick={() => window.open(archivo.url, '_blank')} className="flex-1 flex items-center justify-center gap-1 border border-gray-200 text-gray-600 text-[11px] font-semibold px-3 py-1.5 rounded-full hover:bg-gray-50">
              🔗 Abrir
            </button>
            <button
              onClick={() => compartirArchivo(archivo, () => { setEnlaceCopiado(true); setTimeout(() => setEnlaceCopiado(false), 2000) })}
              className="flex-1 flex items-center justify-center gap-1 border border-gray-200 text-gray-600 text-[11px] font-semibold px-3 py-1.5 rounded-full hover:bg-gray-50"
            >
              {enlaceCopiado ? '✅ Enlace copiado' : '📤 Compartir'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// Vista previa de solo lectura del documento activo — se ve como un
// documento real (título centrado, secciones, viñetas), no como un
// mensaje de chat más. Reemplaza la tarjeta anterior de "título +
// adelanto truncado + botones": ya no hay Editar/Word/PDF que tocar —
// toda modificación y toda descarga se piden escribiendo o hablando
// (ver AsistenteService.enviarMensaje), así que esta vista nunca
// necesita controles propios.
// Un documento grande (Word/PDF de varias páginas) puede tardar
// legítimamente decenas de segundos en generarse — nunca es un
// cuelgue (ver TIMEOUT_FETCH_DOCUMENTO_MS en motorTextoClaude.ts).
// Este texto rotativo es solo tranquilidad visual para el maestro
// mientras espera, no un reporte literal de en qué línea de código
// está el servidor en ese instante — se queda en la última frase si
// el proceso tarda más que el ciclo completo.
const ETAPAS_GENERACION = ['Preparando documento...', 'Generando contenido...', 'Creando archivo...', 'Finalizando...']

function useEtapaGeneracion(activo: boolean): string {
  const [indice, setIndice] = useState(0)
  useEffect(() => {
    if (!activo) return
    const intervalo = setInterval(() => {
      setIndice(i => Math.min(i + 1, ETAPAS_GENERACION.length - 1))
    }, 4000)
    return () => clearInterval(intervalo)
  }, [activo])
  return ETAPAS_GENERACION[indice]
}

function VistaPreviaDocumento({ texto, escribiendo, generandoArchivo }: { texto: string; escribiendo: boolean; generandoArchivo: boolean }) {
  const lineas = analizarContenido(texto)
  const titulo = extraerTitulo(texto)
  const etapaGeneracion = useEtapaGeneracion(generandoArchivo)
  return (
    <div className="w-full max-w-sm bg-white rounded-2xl shadow-md border border-gray-200 rounded-bl-sm overflow-hidden">
      <div className="px-3 pt-2 pb-1.5 bg-gray-50 border-b border-gray-100 flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-gray-300 flex-shrink-0" aria-hidden="true" />
        <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide truncate">Vista previa · {titulo}</p>
      </div>
      <div className="max-h-80 overflow-y-auto px-5 py-4 space-y-2">
        {lineas.map((l, idx) => {
          if (l.tipo === 'titulo') {
            return <p key={idx} className="text-[15px] font-bold text-green-800 text-center leading-snug mb-1">{l.texto}</p>
          }
          if (l.tipo === 'seccion') {
            return <p key={idx} className="text-[13px] font-bold text-green-700 mt-3">{l.texto}</p>
          }
          if (l.tipo === 'bullet') {
            return (
              <p key={idx} className="text-xs text-gray-700 pl-4 relative leading-relaxed before:content-['•'] before:absolute before:left-1 before:text-green-600">
                {l.texto}
              </p>
            )
          }
          return <p key={idx} className="text-xs text-gray-600 leading-relaxed">{l.texto}</p>
        })}
        {escribiendo && (
          <p className="flex items-center gap-1 pt-1" aria-label="Escribiendo">
            <span className="w-1 h-1 rounded-full bg-gray-300 animate-pulse" />
            <span className="w-1 h-1 rounded-full bg-gray-300 animate-pulse [animation-delay:150ms]" />
            <span className="w-1 h-1 rounded-full bg-gray-300 animate-pulse [animation-delay:300ms]" />
          </p>
        )}
      </div>
      {generandoArchivo && (
        <div className="flex items-center justify-center gap-2 px-3 py-2.5 bg-gray-50 border-t border-gray-100 text-xs font-semibold text-purple-600">
          <span className="w-3.5 h-3.5 border-2 border-purple-300 border-t-purple-600 rounded-full animate-spin" aria-hidden="true" />
          {etapaGeneracion}
        </div>
      )}
    </div>
  )
}

const nombrePila = (nombreCompleto: string | undefined): string => {
  if (!nombreCompleto) return ''
  return nombreCompleto
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

export default function AsistentePanel() {
  const asistente = useAsistente()
  const [input, setInput] = useState('')
  const [perfil, setPerfil] = useState<any>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const [menuAbierto, setMenuAbierto] = useState(false)
  const [menuConfigAbierto, setMenuConfigAbierto] = useState(false)

  const fotoInputRef = useRef<HTMLInputElement>(null)
  const [procesandoFoto] = useState(false)
  const [imagenPendiente, setImagenPendiente] = useState<string | null>(null)
  const [imagenTipoPendiente, setImagenTipoPendiente] = useState<string>('image/jpeg')

  // Panel temporal de diagnóstico del modo voz — solo con ?voiceDebug=1 en
  // la URL. Se lee del navegador (no de useSearchParams/Next) para no
  // exigirle un límite de Suspense a esta pantalla por un flag que casi
  // nadie usa.
  const [voiceDebug] = useState(() =>
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('voiceDebug') === '1'
  )

  useEffect(() => {
    const cargarPerfil = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const { data } = await supabase.from('perfiles_docentes').select('*').eq('id', user.id).single()
      if (data) setPerfil(data)
    }
    cargarPerfil()
  }, [])

  useEffect(() => {
    if (asistente.panelAbierto) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [asistente.mensajes, asistente.panelAbierto])

  // "No regenerar archivos existentes" (reutilizarArchivoExistente en
  // AsistenteService): en vez de esperar a que el nuevo mensaje quede
  // al fondo del scroll normal, se baja explícitamente hasta la
  // tarjeta reutilizada — así queda claro que "ya está listo" en vez de
  // sentirse como que no pasó nada. El resaltado en sí (prop
  // `resaltado` de TarjetaDescarga, más abajo) se deriva directo de
  // asistente.archivoReutilizadoId — ese valor ya se apaga solo del
  // lado del servicio (mismo patrón que avisoGeneracion/avisoVoz), así
  // que este efecto solo toca el DOM (el scroll), nunca llama a
  // setState.
  useEffect(() => {
    if (!asistente.archivoReutilizadoId) return
    document.getElementById(`asistente-msg-${asistente.archivoReutilizadoId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [asistente.archivoReutilizadoId])


  const tomarFotoChat = () => fotoInputRef.current?.click()

  const manejarFotoChat = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onloadend = () => {
      const base64 = (reader.result as string).split(',')[1]
      setImagenPendiente(base64)
      setImagenTipoPendiente(file.type || 'image/jpeg')
    }
    reader.readAsDataURL(file)
    if (fotoInputRef.current) fotoInputRef.current.value = ''
  }

  const enviar = () => {
    const texto = input.trim()
    if (!texto) return
    setInput('')
    const adjunto = imagenPendiente ? { base64: imagenPendiente, tipo: imagenTipoPendiente } : undefined
    setImagenPendiente(null)
    asistente.enviarMensaje(texto, adjunto)
  }

  // --- Acciones sobre un documento generado ---
  // Todo se escribe directo en el chat — "Agrégale...", "hazlo más
  // sencillo...", "con portada...", "en Word..." — AsistenteService
  // decide si es una edición del documento activo o una descarga real
  // (ver enviarMensaje). No hay botones de edición ni de descarga
  // manual: la vista previa es de solo lectura (ver VistaPreviaDocumento
  // más abajo), el maestro controla todo escribiendo o hablando.

  // --- Modo conversación por voz ---
  // Un solo botón, sin estados nuevos en la interfaz:
  // - Primer toque (modoVoz aún false, no conectando): conecta y empieza
  //   a escuchar.
  // - Toque MIENTRAS conecta: cancela ese intento en vez de esperar a que
  //   falle o se quede colgado — nunca queda deshabilitado esperando.
  // - Toques siguientes (ya conectado): el motor decide qué significan
  //   según su propio estado (¿está hablando la IA? ¿el docente ya dijo
  //   algo?) — ver MotorOpenAIRealtime.alternarTurno(). Si no hay nada
  //   que enviar, se interpreta como salir del modo voz.
  const toggleModoVoz = () => {
    if (asistente.estadoMotor === 'conectando') asistente.cancelarConexionVoz()
    else if (asistente.modoVoz) asistente.alternarTurnoVoz()
    else asistente.activarModoVoz()
  }

  useEffect(() => {
    return () => {
      if (asistente.modoVoz) asistente.desactivarModoVoz()
      else asistente.cancelarConexionVoz()
    }
    // Solo al desmontar (el panel es global y no se desmonta en uso normal).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- Burbuja flotante (colapsada) ---
  if (!asistente.panelAbierto) {
    return (
      <button
        onClick={() => asistente.abrirPanel()}
        aria-label="Abrir Asistente IA"
        className="fixed bottom-5 right-5 z-40 w-14 h-14 rounded-full shadow-xl overflow-hidden border-2 border-white bg-white flex items-center justify-center hover:scale-105 transition-transform"
      >
        <img src="/logo.png" alt="Asistente Docente IA" className="w-full h-full object-cover" />
        {asistente.mensajes.length > 0 && (
          <span className="absolute top-1 right-1 w-3 h-3 rounded-full bg-green-500 border-2 border-white" aria-hidden="true" />
        )}
      </button>
    )
  }

  return (
    <>
    <div className="fixed inset-0 z-50 flex flex-col bg-gray-50 print:hidden">
      <header className="flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-100 shadow-sm">
        <div onClick={() => setMenuAbierto(true)} className="w-8 h-8 flex items-center justify-center text-2xl mr-2 flex-shrink-0 mt-1 cursor-pointer">🍎</div>
        <div className="flex-1">
          <p className="font-bold text-gray-900 text-sm">Asistente Docente IA</p>
          <p className="text-xs text-green-500">● En linea</p>
        </div>
        <button
          onClick={() => asistente.cerrarPanel()}
          aria-label="Minimizar asistente"
          className="w-8 h-8 rounded-full flex items-center justify-center text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition"
        >
          ⌄
        </button>
      </header>

      <div
        onMouseEnter={() => setMenuAbierto(true)}
        onTouchStart={() => setMenuAbierto(true)}
        className="fixed left-0 top-0 h-full w-4 z-40"
      ></div>

      <div className={`fixed inset-0 z-50 flex transition-opacity duration-300 ${menuAbierto ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}>
        <div className={`w-72 bg-white h-full shadow-xl flex flex-col transition-transform duration-300 ease-out ${menuAbierto ? 'translate-x-0' : '-translate-x-full'}`}>
          <div className="flex items-center gap-2 px-4 pt-5 pb-3">
            <div className="relative">
              <div onClick={() => setMenuConfigAbierto(!menuConfigAbierto)} className="w-9 h-9 rounded-xl bg-green-50 border border-green-100 flex items-center justify-center text-lg cursor-pointer">🍎</div>
              {menuConfigAbierto && (
                <div className="absolute left-0 top-11 w-52 bg-white rounded-xl shadow-lg border border-gray-100 py-1 z-50">
                  <a href="/documentos" className="flex items-center gap-2 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50">📤 Subir documentos</a>
                  <a href="/dashboard/configuracion" className="flex items-center gap-2 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50">⚙️ Configuración</a>
                </div>
              )}
            </div>
            <div className="font-serif font-bold text-gray-900 text-base">Docente <span className="text-green-600">IA</span></div>
          </div>

          <div className="mx-3 mb-3 bg-gray-50 rounded-xl p-3 flex items-center gap-2">
            <div className="w-10 h-10 rounded-full bg-green-100 border-2 border-green-400 flex items-center justify-center text-lg flex-shrink-0">👨‍🏫</div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-gray-800 truncate">{perfil?.nombre || 'Cargando...'}</p>
              <p className="text-xs text-gray-500 truncate">{perfil?.escuela || ''} {perfil?.grado ? `· ${perfil.grado}° ${perfil.grupo || ''}` : ''}</p>
            </div>
          </div>

          <nav className="px-3 flex flex-col gap-0.5 mb-2">
            {/* "Inicio" ahora significa el Chat IA — es el root/home
                funcional real de la app (ver app/page.tsx). La portada
                verde sigue existiendo en /dashboard/inicio pero ya no es
                el destino de este control. */}
            <a href="/" className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-gray-50">
              <span className="w-8 h-8 rounded-lg bg-green-50 flex items-center justify-center text-sm">🏠</span>
              <span className="text-sm font-semibold text-gray-800">Inicio</span>
            </a>
            <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-green-50">
              <span className="w-8 h-8 rounded-lg bg-purple-100 flex items-center justify-center text-sm">💬</span>
              <span className="text-sm font-semibold text-gray-800">Chat IA</span>
            </div>
            <a href="/dashboard/lista" className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-gray-50">
              <span className="w-8 h-8 rounded-lg bg-rose-50 flex items-center justify-center text-sm">📝</span>
              <span className="text-sm font-semibold text-gray-800">Lista</span>
            </a>
            <a href="/dashboard/planeacion" className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-gray-50">
              <span className="w-8 h-8 rounded-lg bg-amber-50 flex items-center justify-center text-sm">📋</span>
              <span className="text-sm font-semibold text-gray-800">Planeación</span>
            </a>
            <a href="/dashboard/calendario" className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-gray-50">
              <span className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center text-sm">📅</span>
              <span className="text-sm font-semibold text-gray-800">Calendario</span>
            </a>
            <a href="/documentos" className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-gray-50">
              <span className="w-8 h-8 rounded-lg bg-purple-50 flex items-center justify-center text-sm">📄</span>
              <span className="text-sm font-semibold text-gray-800">Documentos</span>
            </a>
          </nav>

          <div className="mx-3 mb-3 bg-indigo-50 border border-indigo-100 rounded-xl px-3 py-2">
            <p className="text-[11px] font-semibold text-indigo-400 uppercase tracking-wide">Viendo ahora</p>
            <p className="text-xs text-indigo-700 truncate">{asistente.contexto.pantalla}{asistente.contexto.alumnoNombre ? ` · ${asistente.contexto.alumnoNombre}` : ''}</p>
          </div>

          <div className="border-t border-gray-100 mx-4"></div>

          <div className="flex items-center justify-between px-4 pt-3 pb-1">
            <span className="text-xs font-bold uppercase tracking-wide text-gray-400">Conversaciones</span>
            <button
              onClick={() => { asistente.nuevaConversacion(); setMenuAbierto(false) }}
              aria-label="Nueva conversación"
              className="text-purple-600 text-lg leading-none w-6 h-6 flex items-center justify-center rounded-full hover:bg-purple-50"
            >
              +
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-2">
            {asistente.listaConversaciones.length === 0 ? (
              <p className="text-xs text-gray-400 text-center mt-4">Sin conversaciones aún</p>
            ) : (
              asistente.listaConversaciones.map((c) => (
                <div
                  key={c.id}
                  onClick={() => { asistente.abrirConversacion(c.id); setMenuAbierto(false) }}
                  className={`w-full flex items-center gap-1 px-3 py-2.5 rounded-xl text-sm cursor-pointer ${
                    c.id === asistente.conversacionActivaId ? 'bg-purple-50 text-purple-700 font-semibold' : 'text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  <span className="flex-1 truncate">{c.titulo}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); asistente.eliminarConversacion(c.id) }}
                    aria-label="Eliminar conversación"
                    className="text-gray-300 hover:text-red-500 text-xs px-2 py-1.5 rounded-lg flex-shrink-0"
                  >
                    🗑️
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
        <div onClick={() => setMenuAbierto(false)} className="flex-1 bg-black/40"></div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 flex flex-col">
        {asistente.mensajes.length === 0 && !asistente.generando && (
          <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
            <p className="text-lg font-semibold text-gray-800">{saludoPorHora()}{perfil?.nombre ? `, ${nombrePila(perfil.nombre)}` : ''}.</p>
            <p className="text-sm text-gray-500 mt-1">¿En qué te puedo echar la mano hoy?</p>
          </div>
        )}
        {asistente.mensajes.map((m, i) => {
          const esUltimoGenerando = asistente.generando && i === asistente.mensajes.length - 1
          const esDoc = m.rol === 'asistente' && esDocumentoFormal(m.texto)
          return (
            <div key={m.id} id={`asistente-msg-${m.id}`} className={`flex flex-col ${m.rol === 'usuario' ? 'items-end' : 'items-start'} w-full`}>
              {m.rol === 'asistente' && (
                <div className="w-7 h-7 bg-gradient-to-br from-purple-600 to-blue-500 rounded-xl flex items-center justify-center text-xs mr-2 flex-shrink-0 mt-1"><img src="/logo.png" alt="Docente IA" className="w-full h-full object-contain" /></div>
              )}
              {esDoc || (m.rol === 'asistente' && m.archivo?.url) ? (
                <div className="flex flex-col items-start gap-2 w-full">
                  {esDoc && (
                    <VistaPreviaDocumento
                      texto={m.texto}
                      escribiendo={esUltimoGenerando}
                      generandoArchivo={asistente.documentoFinalizandoId === m.id}
                    />
                  )}
                  {/* Última condición del flujo: independientemente de si
                      hubo vista previa (esDoc) o de qué tipo de documento
                      sea (planeación, lista, ficha, oficio...), en cuanto
                      el mensaje trae una URL firmada real del archivo, la
                      tarjeta oficial de descarga se renderiza — la vista
                      previa nunca la sustituye. */}
                  {m.archivo?.url && <TarjetaDescarga archivo={m.archivo} creadoEn={m.creadoEn} resaltado={asistente.archivoReutilizadoId === m.id} />}
                </div>
              ) : (
                <div className={`flex flex-col gap-1.5 max-w-sm ${m.rol === 'usuario' ? 'items-end' : 'items-start'}`}>
                  {m.imagen && (
                    m.imagen.base64 ? (
                      <img
                        src={`data:${m.imagen.tipo};base64,${m.imagen.base64}`}
                        alt="Foto adjunta"
                        className="w-32 h-32 object-cover rounded-2xl border border-gray-200 shadow-sm"
                      />
                    ) : (
                      <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-gray-100 text-gray-500 text-xs">
                        📷 Foto adjunta
                      </div>
                    )
                  )}
                  <div className={
                    m.rol === 'usuario'
                      ? 'rounded-2xl px-4 py-3 text-sm leading-relaxed bg-gradient-to-r from-purple-600 to-blue-500 text-white rounded-br-sm'
                      : 'rounded-2xl px-4 py-3 text-sm leading-relaxed bg-white text-gray-800 shadow-sm rounded-bl-sm'
                  }>
                    {m.rol === 'asistente' ? (
                      <div className="prose prose-sm max-w-none prose-headings:text-purple-800 prose-headings:font-bold prose-strong:text-gray-900">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.texto.replace(/\n/g, "  \n")}</ReactMarkdown>
                      </div>
                    ) : m.texto}
                  </div>
                </div>
              )}
            </div>
          )
        })}
        {asistente.generando && (asistente.mensajes.length === 0 || asistente.mensajes[asistente.mensajes.length - 1]?.rol !== 'asistente') && (
          <div className="flex justify-start">
            <div className="bg-white shadow-sm rounded-2xl rounded-bl-sm px-4 py-3">
              <p className="text-xs text-purple-600 font-medium animate-pulse">Generando...</p>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {imagenPendiente && (
        <div className="px-4 pt-2 bg-white flex items-center gap-2">
          <div className="relative w-16 h-16">
            <img src={`data:${imagenTipoPendiente};base64,${imagenPendiente}`} className="w-16 h-16 object-cover rounded-lg border border-gray-200" />
            <button
              onClick={() => setImagenPendiente(null)}
              className="absolute -top-2 -right-2 bg-gray-800 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs leading-none shadow"
              aria-label="Quitar foto"
            >
              ×
            </button>
          </div>
        </div>
      )}
      {voiceDebug && (
        <div className="px-4 py-2 bg-black text-white text-[10px] font-mono max-h-56 overflow-y-auto border-t border-gray-700">
          <p className="text-yellow-400 font-bold mb-1">🛠 voiceDebug — estado: {asistente.estadoMotor} / modoVoz: {String(asistente.modoVoz)}</p>
          {asistente.debugVoz.length === 0 ? (
            <p className="text-gray-400">Sin pasos todavía. Toca el micrófono.</p>
          ) : (
            asistente.debugVoz.map((p, i) => {
              const anterior = asistente.debugVoz[i - 1]
              const delta = anterior ? p.ms - anterior.ms : null
              return (
                <p key={i} className={p.resultado === 'error' ? 'text-red-400' : p.resultado === 'ok' ? 'text-green-400' : 'text-gray-300'}>
                  {p.hora} {delta !== null ? <span className="text-cyan-400">(+{delta}ms)</span> : ''} · {p.paso} · {p.resultado}{p.detalle ? ` · ${p.detalle}` : ''}
                </p>
              )
            })
          )}
        </div>
      )}
      <div className="px-4 py-3 bg-white border-t border-gray-100">
        {asistente.avisoVoz && (
          <button
            type="button"
            onClick={() => asistente.activarModoVoz()}
            className="mb-2 w-full text-left text-xs text-red-600 bg-red-50 border border-red-100 rounded-xl px-3 py-2"
          >
            {asistente.avisoVoz}
          </button>
        )}
        {asistente.avisoGeneracion && (
          <button
            type="button"
            onClick={() => asistente.reintentarGeneracion()}
            className="mb-2 w-full text-left text-xs text-red-600 bg-red-50 border border-red-100 rounded-xl px-3 py-2 whitespace-pre-line"
          >
            {asistente.avisoGeneracion}
          </button>
        )}
        <div className="flex gap-2 items-center">
          <input
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && enviar()}
            placeholder="¿Qué necesitas hoy, maestro?"
            className="flex-1 bg-gray-100 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-purple-400"
          />
          <input ref={fotoInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={manejarFotoChat} />
          {!asistente.modoVoz && (
            <button type="button" onClick={tomarFotoChat} disabled={procesandoFoto} className="w-10 h-10 rounded-full flex items-center justify-center bg-gray-100 text-gray-600 hover:bg-gray-200 transition disabled:opacity-40 flex-shrink-0">📷</button>
          )}
          <div className="relative">
            {asistente.modoVoz && asistente.estadoEscucha && (
              <span className="absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] font-medium text-gray-500 bg-white/95 px-2 py-0.5 rounded-full shadow-sm">
                {asistente.estadoEscucha === 'escuchando' ? 'Escuchando' : asistente.estadoEscucha === 'confirmando' ? 'Confirmando…' : 'Pensando…'}
              </span>
            )}
            <button
              type="button"
              onClick={toggleModoVoz}
              aria-label={asistente.modoVoz ? 'Finalizar conversación' : asistente.estadoMotor === 'conectando' ? 'Cancelar conexión de voz' : 'Iniciar conversación por voz'}
              className={`relative w-10 h-10 rounded-full flex items-center justify-center transition flex-shrink-0 ${
                asistente.modoVoz
                  ? asistente.estadoEscucha === 'confirmando'
                    ? 'bg-amber-500 text-white'
                    : asistente.estadoEscucha === 'pensando'
                      ? 'bg-purple-500 text-white'
                      : 'bg-red-500 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {asistente.modoVoz && (
                <span
                  className={`absolute inset-0 rounded-full animate-ping opacity-75 ${
                    asistente.estadoEscucha === 'confirmando' ? 'bg-amber-400' : asistente.estadoEscucha === 'pensando' ? 'bg-purple-400' : 'bg-red-400'
                  }`}
                  aria-hidden="true"
                />
              )}
              <span className="relative">
                {asistente.estadoMotor === 'conectando'
                  ? <span className="block w-4 h-4 rounded-full border-2 border-purple-200 border-t-purple-600 animate-spin" />
                  : asistente.modoVoz ? '🛑' : '🎤'}
              </span>
            </button>
          </div>
          <button type="button" onClick={enviar} disabled={asistente.generando} className="w-10 h-10 bg-gradient-to-r from-purple-600 to-blue-500 text-white rounded-full flex items-center justify-center hover:opacity-90 transition disabled:opacity-40 flex-shrink-0">
            ↑
          </button>
        </div>
      </div>
    </div>
    </>
  )
}
