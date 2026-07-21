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
import { useRouter } from 'next/navigation'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useAsistente } from '@/lib/asistente/hooks'
import { AsistenteService } from '@/lib/asistente/AsistenteService'
import { esDocumentoFormal } from '@/lib/asistente/documentos'
import { analizarContenido, extraerTitulo } from '@/lib/documentGen/parseContenido'
import { formatearFecha, obtenerFechaHora, obtenerZonaHorariaDispositivo } from '@/lib/tiempo/TimeService'
import { clasificarTipoDocumento } from '@/lib/documentGen/extraerTextoDocumento'
import { comprimirImagenes, verificarPresupuestoAdjuntos, MAXIMO_IMAGENES_POR_MENSAJE } from '@/lib/asistente/comprimirImagen'
import type { AdjuntoImagen, ArchivoGeneradoInfo } from '@/lib/asistente/tipos'
import type { TipoHerramienta } from '@/lib/asistente/documentos'

const saludoPorHora = (): string => obtenerFechaHora(obtenerZonaHorariaDispositivo()).saludo

const ICONO_ARCHIVO: Record<string, string> = { word: '📄', pdf: '🖨️', powerpoint: '📊', excel: '📈' }
const NOMBRE_FORMATO: Record<string, string> = { word: 'Word', pdf: 'PDF', powerpoint: 'PowerPoint', excel: 'Excel' }
// Extensión real del archivo — el botón principal dice "Descargar
// (.docx)" en vez de "Descargar Word": con varios formatos posibles a
// la vez, la extensión es lo que de verdad distingue un archivo de
// otro (ver "Tarjeta universal de documentos").
const EXTENSION_FORMATO: Record<string, string> = { word: '.docx', pdf: '.pdf', powerpoint: '.pptx', excel: '.xlsx' }
// Los 4 formatos convertibles hoy (ver TipoHerramienta) — usado para
// ofrecer "Convertir a..." con los que NO sea ya el formato actual.
const FORMATOS_CONVERTIBLES = ['word', 'pdf', 'powerpoint', 'excel'] as const

function formatearTamano(bytes?: number): string | null {
  if (!bytes || bytes <= 0) return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// Ícono para un adjunto del Chat IA según su tipo real (RFC-CHAT-
// ADJUNTOS-003) — imagen/PDF/Word/Excel/PowerPoint. clasificarTipoDocumento
// ya distingue estos 3 últimos por MIME (mismo clasificador que usa
// app/api/chat/route.ts para decidir cómo procesar el adjunto).
function iconoAdjunto(tipo: string): string {
  if (tipo.startsWith('image/')) return '🖼️'
  const clasificado = clasificarTipoDocumento(tipo)
  if (clasificado === 'pdf') return '🖨️'
  if (clasificado === 'docx') return '📄'
  if (clasificado === 'xlsx') return '📈'
  if (clasificado === 'pptx') return '📊'
  return '📎'
}

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

function TarjetaDescarga({
  archivo, creadoEn, mensajeId, esActivo, generando, onConvertir, className = '', resaltado = false,
}: {
  archivo: ArchivoGeneradoInfo
  creadoEn: number
  // mensajeId/esActivo/generando/onConvertir: solo hacen falta para
  // ofrecer "Convertir a..." (ver "Memoria del documento activo") —
  // llegan como props en vez de que la tarjeta llame useAsistente()
  // por su cuenta, para no duplicar la suscripción que ya tiene
  // AsistentePanel.
  mensajeId: string
  esActivo: boolean
  generando: boolean
  onConvertir: (mensajeId: string, tipo: TipoHerramienta) => void
  className?: string
  resaltado?: boolean
}) {
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
  const extension = EXTENSION_FORMATO[archivo.tipo] || ''
  const tamano = formatearTamano(archivo.tamanoBytes)
  const fecha = formatearFecha(new Date(creadoEn), obtenerZonaHorariaDispositivo(), { day: '2-digit', month: 'short' })
  const otrosFormatos = FORMATOS_CONVERTIBLES.filter((t) => t !== archivo.tipo)

  return (
    <div className={`w-full max-w-sm bg-white rounded-2xl shadow-md border overflow-hidden rounded-bl-sm transition-shadow ${resaltado ? 'border-purple-300 ring-2 ring-purple-300' : 'border-green-100'} ${className}`}>
      <div className="px-4 py-3 flex items-center gap-2.5">
        <span className="text-xl flex-shrink-0">{ICONO_ARCHIVO[archivo.tipo] || '📄'}</span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-gray-900 truncate">{archivo.nombre}</p>
          <p className="text-[11px] text-gray-400 flex items-center gap-1 flex-wrap">
            <span>{fecha}</span>
            {tamano && <span>· {tamano}</span>}
            {esActivo && <span className="text-purple-600 font-semibold">· Documento activo</span>}
          </p>
          <p className={`text-xs ${vencido ? 'text-amber-600' : 'text-green-600'}`}>
            {vencido ? 'Enlace vencido — pide el documento de nuevo' : 'Listo'}
          </p>
        </div>
      </div>
      {!vencido && (
        <div className="px-3 pb-3 space-y-1.5">
          <button onClick={() => window.open(archivo.url, '_blank')} className="w-full flex items-center justify-center gap-1 bg-green-600 text-white text-xs font-semibold px-3 py-2 rounded-full hover:bg-green-700">
            ⬇️ Descargar ({extension})
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
          {/* Convertir a otro formato: solo sobre el Documento Activo —
              convertir una tarjeta vieja convertiría por error lo que
              esté activo AHORA, no el documento que se está mirando
              (ver convertirDocumentoActivo en AsistenteService.ts). */}
          {esActivo && otrosFormatos.length > 0 && (
            <div className="flex gap-1.5 flex-wrap pt-0.5">
              {otrosFormatos.map((tipo) => (
                <button
                  key={tipo}
                  onClick={() => onConvertir(mensajeId, tipo)}
                  disabled={generando}
                  className="flex-1 flex items-center justify-center gap-1 border border-gray-200 text-gray-600 text-[11px] font-semibold px-3 py-1.5 rounded-full hover:bg-gray-50 disabled:opacity-40"
                >
                  🔄 {NOMBRE_FORMATO[tipo]}
                </button>
              ))}
            </div>
          )}
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
  const router = useRouter()
  const [input, setInput] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const [menuAbierto, setMenuAbierto] = useState(false)
  const [menuConfigAbierto, setMenuConfigAbierto] = useState(false)

  const [procesandoFoto] = useState(false)
  // Siempre un arreglo — 0 adjuntos, 1 (foto o documento, camino
  // idéntico al que ya existía) o varios (solo fotos, ver "Implementar
  // soporte completo para múltiples fotografías"). Nunca dos estados
  // paralelos para "uno" vs "varios": un solo modelo más simple de
  // mantener.
  const [adjuntosPendientes, setAdjuntosPendientes] = useState<AdjuntoImagen[]>([])
  const [comprimiendo, setComprimiendo] = useState<{ completadas: number; total: number } | null>(null)
  const [avisoAdjunto, setAvisoAdjunto] = useState<string | null>(null)
  const avisoAdjuntoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const adjuntoInputRef = useRef<HTMLInputElement>(null)

  // Panel temporal de diagnóstico del modo voz — solo con ?voiceDebug=1 en
  // la URL. Se lee del navegador (no de useSearchParams/Next) para no
  // exigirle un límite de Suspense a esta pantalla por un flag que casi
  // nadie usa.
  const [voiceDebug] = useState(() =>
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('voiceDebug') === '1'
  )

  // Navegación automática pedida por voz/texto ("Abre a Sergio en la
  // lista") — AsistentePanel es la única pieza con useRouter, así que
  // aquí (y solo aquí) se convierte una AccionNavegacion en un
  // router.push real. Se limpia llamando directo a AsistenteService
  // (no a través de asistente, que es un objeto nuevo cada render —
  // ver useAsistente) para que nunca se repita si el snapshot se
  // vuelve a leer. Hoy solo cubre "lista" — ver ModuloNavegable.
  useEffect(() => {
    const accion = asistente.accionNavegacionPendiente
    if (!accion) return
    if (accion.modulo === 'lista' && accion.alumnoId) {
      const ruta = accion.pestana ? `/dashboard/lista/${accion.alumnoId}?tab=${accion.pestana}` : `/dashboard/lista/${accion.alumnoId}`
      router.push(ruta)
    } else if (accion.modulo === 'lista') {
      // Navegación a nivel de módulo, sin alumnoId — "muéstrame
      // únicamente los ausentes" (ver navegar_lista_filtrada en
      // app/api/chat/route.ts). filtros.filtro coincide con el mismo
      // estado `filtro` que ya existe en app/dashboard/lista/page.tsx.
      const filtro = accion.filtros?.filtro
      router.push(filtro ? `/dashboard/lista?filtro=${filtro}` : '/dashboard/lista')
    }
    AsistenteService.limpiarNavegacionPendiente()
  }, [asistente.accionNavegacionPendiente, router])

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


  const mostrarAvisoAdjunto = (texto: string) => {
    if (avisoAdjuntoTimerRef.current) clearTimeout(avisoAdjuntoTimerRef.current)
    setAvisoAdjunto(texto)
    avisoAdjuntoTimerRef.current = setTimeout(() => setAvisoAdjunto(null), 5000)
  }

  const leerComoBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onloadend = () => resolve((reader.result as string).split(',')[1])
      reader.onerror = () => reject(new Error('No se pudo leer el archivo'))
      reader.readAsDataURL(file)
    })

  // Un solo <input type="file"> nativo, sin menú propio antes — en
  // iPhone/Android/escritorio, el sistema operativo YA ofrece su
  // propio selector (Fototeca/Tomar foto/Elegir archivo en iOS,
  // equivalente en Android/escritorio) en cuanto se llama a
  // adjuntoInputRef.current.click(); un menú propio delante de eso
  // solo producía una segunda capa redundante que no se puede evitar
  // desde HTML (ver commits anteriores). Decisión de UX explícita: un
  // solo flujo, el nativo — ahora con `multiple` para que Fototeca
  // permita elegir varias fotos. "Tomar foto" y "Archivos" comparten
  // el mismo input y siguen funcionando exactamente igual: la cámara
  // solo entrega una foto a la vez de todos modos, y elegir un único
  // documento en Archivos no cambia (ver el camino de "un solo
  // archivo" abajo, idéntico al que ya existía).
  const manejarSeleccionAdjunto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (files.length === 0) return

    // Un solo archivo (foto o documento) — camino idéntico al que ya
    // existía antes de esta mejora, sin compresión ni presupuesto de
    // varias imágenes de por medio.
    if (files.length === 1) {
      const file = files[0]
      const base64 = await leerComoBase64(file)
      // [IMAGEN][FRONTEND] log temporal de auditoría (ver "Revisar
      // pipeline completo de imágenes del Chat IA") — confirma que el
      // archivo elegido de verdad terminó como base64 real en el
      // estado, no solo como referencia de archivo.
      console.log(`[IMAGEN][FRONTEND] imagen seleccionada — tipo=${file.type || 'desconocido'} tamaño=${Math.round(file.size / 1024)}KB base64Listo=${base64.length > 0}`)
      setAdjuntosPendientes([{ base64, tipo: file.type || 'application/octet-stream', nombreArchivo: file.name }])
      return
    }

    // Varias — solo tiene sentido analizarlas juntas si son imágenes
    // (ver el bloque de contenido nuevo en app/api/chat/route.ts). Si
    // el docente multi-seleccionó algo que no es imagen (por ejemplo,
    // varios documentos desde "Archivos"), se avisa con claridad en
    // vez de adivinar cuál de todos usar — nunca se manda un mensaje
    // sin decirle qué pasó.
    const imagenes = files.filter((f) => f.type.startsWith('image/'))
    if (imagenes.length === 0) {
      mostrarAvisoAdjunto('Por ahora solo puedes enviar varias fotos juntas. Selecciona un documento a la vez.')
      return
    }

    const limitadas = imagenes.slice(0, MAXIMO_IMAGENES_POR_MENSAJE)
    if (imagenes.length > MAXIMO_IMAGENES_POR_MENSAJE) {
      mostrarAvisoAdjunto(`Se seleccionaron ${imagenes.length} fotos — se usarán las primeras ${MAXIMO_IMAGENES_POR_MENSAJE}.`)
    }

    setComprimiendo({ completadas: 0, total: limitadas.length })
    try {
      const comprimidas = await comprimirImagenes(limitadas, (completadas, total) => setComprimiendo({ completadas, total }))
      const { cabe } = verificarPresupuestoAdjuntos(comprimidas)
      if (!cabe) {
        mostrarAvisoAdjunto('Estas fotos son demasiado pesadas incluso comprimidas. Intenta con menos fotos.')
        return
      }
      setAdjuntosPendientes(comprimidas.map((img) => ({ base64: img.base64, tipo: img.tipo })))
    } catch {
      mostrarAvisoAdjunto('No pude preparar las fotos. Intenta de nuevo.')
    } finally {
      setComprimiendo(null)
    }
  }

  const eliminarAdjuntoPendiente = (indice: number) => {
    setAdjuntosPendientes((prev) => prev.filter((_, i) => i !== indice))
  }

  const enviar = () => {
    const texto = input.trim()
    // Mientras se están comprimiendo fotos, adjuntosPendientes todavía
    // está vacío — enviar en ese momento mandaría el texto SIN las
    // fotos que el docente acaba de elegir. Se bloquea el envío hasta
    // que termine (comprimiendo se apaga solo, ver manejarSeleccionAdjunto).
    if (!texto || comprimiendo) return
    setInput('')
    const adjuntos = adjuntosPendientes
    setAdjuntosPendientes([])
    // [IMAGEN][FRONTEND] log temporal de auditoría — confirma cuántas
    // imágenes de verdad van dentro del mensaje que se manda, y por
    // cuál parámetro (adjunto único vs. adjuntos[]).
    if (adjuntos.length > 0) {
      console.log(`[IMAGEN][FRONTEND] imagen(es) enviada(s) — cantidad=${adjuntos.length} via=${adjuntos.length > 1 ? 'adjuntos[]' : 'adjunto'}`)
    }
    if (adjuntos.length > 1) {
      asistente.enviarMensaje(texto, undefined, adjuntos)
    } else {
      asistente.enviarMensaje(texto, adjuntos[0] || undefined)
    }
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
    // "Desbloquea" speechSynthesis para el resto de la sesión: varios
    // navegadores (sobre todo iOS Safari — ver la nota de getUserMedia
    // más abajo, mismo tipo de restricción) solo permiten reproducir
    // audio sintetizado si el PRIMER speak() de la página ocurrió
    // síncronamente dentro de un gesto real del usuario (un tap). Como
    // la respuesta real llega mucho después (transcripción + /api/chat
    // de por medio), ese speak() real ya no cuenta como "dentro" del
    // gesto — sin este toque en vacío aquí, el navegador puede
    // descartar en silencio cualquier speak() posterior (ver "Corregir
    // la integración entre el Chat IA y la lectura en voz de las
    // respuestas"). Texto vacío: no se escucha nada, solo registra la
    // activación.
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(''))
    }
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
              <p className="text-sm font-bold text-gray-800 truncate">{asistente.perfil?.nombre || 'Cargando...'}</p>
              <p className="text-xs text-gray-500 truncate">{asistente.perfil?.escuela || ''} {asistente.perfil?.grado ? `· ${asistente.perfil.grado} ${asistente.perfil.grupo || ''}` : ''}</p>
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
            <p className="text-lg font-semibold text-gray-800">{saludoPorHora()}{asistente.perfil?.nombre ? `, ${nombrePila(asistente.perfil.nombre)}` : ''}.</p>
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
                  {/* Un mensaje puede traer archivo (ej. el respaldo del
                      calendario, ver confirmarAccionCalendario) SIN ser un
                      documento formal con título — esDoc solo cubre el
                      caso de planeación/lista/ficha/oficio. Sin esto, el
                      texto real (el resumen "✅ Calendario actualizado...")
                      desaparecería en silencio detrás de la tarjeta. */}
                  {!esDoc && m.texto && (
                    <div className="rounded-2xl px-4 py-3 text-sm leading-relaxed bg-white text-gray-800 shadow-sm rounded-bl-sm w-full">
                      <div className="prose prose-sm max-w-none prose-headings:text-purple-800 prose-headings:font-bold prose-strong:text-gray-900">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.texto.replace(/\n/g, "  \n")}</ReactMarkdown>
                      </div>
                    </div>
                  )}
                  {/* Última condición del flujo: independientemente de si
                      hubo vista previa (esDoc) o de qué tipo de documento
                      sea (planeación, lista, ficha, oficio...), en cuanto
                      el mensaje trae una URL firmada real del archivo, la
                      tarjeta oficial de descarga se renderiza — la vista
                      previa nunca la sustituye. */}
                  {m.archivo?.url && (
                    <TarjetaDescarga
                      archivo={m.archivo}
                      creadoEn={m.creadoEn}
                      mensajeId={m.id}
                      esActivo={asistente.documentoActivoId === m.id}
                      generando={asistente.generando}
                      onConvertir={asistente.convertirDocumentoActivo}
                      resaltado={asistente.archivoReutilizadoId === m.id}
                    />
                  )}
                </div>
              ) : (
                <div className={`flex flex-col gap-1.5 max-w-sm ${m.rol === 'usuario' ? 'items-end' : 'items-start'}`}>
                  {m.imagen && (
                    m.imagen.base64 && m.imagen.tipo.startsWith('image/') ? (
                      <img
                        src={`data:${m.imagen.tipo};base64,${m.imagen.base64}`}
                        alt="Foto adjunta"
                        className="w-32 h-32 object-cover rounded-2xl border border-gray-200 shadow-sm"
                      />
                    ) : (
                      <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-gray-100 text-gray-500 text-xs">
                        {iconoAdjunto(m.imagen.tipo)} {m.imagen.nombreArchivo || (m.imagen.tipo.startsWith('image/') ? 'Foto adjunta' : 'Archivo adjunto')}
                      </div>
                    )
                  )}
                  {/* Varias fotos en un mismo mensaje — grid compacto,
                      igual criterio que la foto sola de arriba: si la
                      conversación se restauró y el base64 ya se
                      aligeró para no llenar localStorage (ver
                      lib/asistente/persistencia.ts), se muestra un
                      chip con el conteo en vez de imágenes rotas. */}
                  {m.imagenes && m.imagenes.length > 0 && (
                    m.imagenes[0].base64 ? (
                      <div className="grid grid-cols-3 gap-1.5 max-w-[280px]">
                        {m.imagenes.map((img, i) => (
                          <img
                            key={i}
                            src={`data:${img.tipo};base64,${img.base64}`}
                            alt={`Foto ${i + 1} adjunta`}
                            className="w-full aspect-square object-cover rounded-xl border border-gray-200 shadow-sm"
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-gray-100 text-gray-500 text-xs">
                        🖼️ {m.imagenes.length} fotos adjuntas
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
                  {/* Botones de confirmación (ver AccionMensaje) — se
                      esconden en cuanto el docente elige uno
                      (accionElegida ya viene marcado, ver
                      confirmarAccionCalendario) para que nunca se pueda
                      confirmar dos veces el mismo mensaje. */}
                  {m.acciones && m.acciones.length > 0 && !m.accionElegida && (
                    <div className="flex gap-2 mt-1.5">
                      {m.acciones.map((accion) => (
                        <button
                          key={accion.id}
                          type="button"
                          onClick={() => m.datosAccionNavegacion ? asistente.confirmarNavegacion(m.id) : asistente.confirmarAccionCalendario(m.id, accion.id)}
                          disabled={asistente.generando}
                          className={
                            accion.estilo === 'primario'
                              ? 'px-4 py-2 rounded-full text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 transition disabled:opacity-40'
                              : 'px-4 py-2 rounded-full text-xs font-semibold bg-gray-100 text-gray-600 hover:bg-gray-200 transition disabled:opacity-40'
                          }
                        >
                          {accion.etiqueta}
                        </button>
                      ))}
                    </div>
                  )}
                  {/* Secuencia visual mientras se aplica la acción
                      confirmada — puramente cosmética (ver
                      iniciarProgresoAccionCalendario en
                      AsistenteService.ts), el mensaje de éxito o error
                      real llega después como un mensaje nuevo. */}
                  {asistente.accionCalendarioEnProgreso?.mensajeId === m.id && (
                    <div className="flex items-center gap-2 px-3 py-2 mt-1.5 rounded-2xl bg-purple-50 text-purple-700 text-xs font-medium animate-pulse">
                      <span className="w-1.5 h-1.5 rounded-full bg-purple-500 flex-shrink-0" />
                      {asistente.accionCalendarioEnProgreso.etapa}
                    </div>
                  )}
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

      {comprimiendo && (
        <div className="px-4 pt-2 bg-white">
          <div className="flex items-center gap-2 px-3 py-2 rounded-2xl bg-purple-50 text-purple-700 text-xs font-medium animate-pulse">
            <span className="w-1.5 h-1.5 rounded-full bg-purple-500 flex-shrink-0" />
            Preparando fotos ({comprimiendo.completadas} de {comprimiendo.total})...
          </div>
        </div>
      )}
      {avisoAdjunto && !comprimiendo && (
        <div className="px-4 pt-2 bg-white">
          <button
            type="button"
            onClick={() => setAvisoAdjunto(null)}
            className="w-full text-left text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2"
          >
            {avisoAdjunto}
          </button>
        </div>
      )}
      {adjuntosPendientes.length === 1 && (
        <div className="px-4 pt-2 bg-white flex items-center gap-2">
          {adjuntosPendientes[0].tipo.startsWith('image/') ? (
            <div className="relative w-16 h-16">
              <img src={`data:${adjuntosPendientes[0].tipo};base64,${adjuntosPendientes[0].base64}`} alt="Foto lista para enviar" className="w-16 h-16 object-cover rounded-lg border border-gray-200" />
              <button
                onClick={() => setAdjuntosPendientes([])}
                className="absolute -top-2 -right-2 bg-gray-800 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs leading-none shadow"
                aria-label="Quitar foto"
              >
                ×
              </button>
            </div>
          ) : (
            <div className="relative flex items-center gap-2 pl-3 pr-7 py-2 rounded-2xl bg-gray-100 border border-gray-200 max-w-[220px]">
              <span className="text-lg flex-shrink-0">{iconoAdjunto(adjuntosPendientes[0].tipo)}</span>
              <p className="text-xs font-medium text-gray-700 truncate">{adjuntosPendientes[0].nombreArchivo || 'Archivo adjunto'}</p>
              <button
                onClick={() => setAdjuntosPendientes([])}
                className="absolute top-1 right-1 bg-gray-800 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs leading-none shadow"
                aria-label="Quitar archivo"
              >
                ×
              </button>
            </div>
          )}
        </div>
      )}
      {/* Tira horizontal de miniaturas — varias fotos en un mismo
          mensaje. Cada una se puede quitar individualmente (la X),
          conservando el resto, sin volver a abrir la galería. */}
      {adjuntosPendientes.length > 1 && (
        <div className="px-4 pt-2 bg-white">
          <div className="flex gap-2 overflow-x-auto pb-1">
            {adjuntosPendientes.map((img, i) => (
              <div key={i} className="relative w-16 h-16 flex-shrink-0">
                <img src={`data:${img.tipo};base64,${img.base64}`} alt={`Foto ${i + 1} lista para enviar`} className="w-16 h-16 object-cover rounded-lg border border-gray-200" />
                <button
                  onClick={() => eliminarAdjuntoPendiente(i)}
                  className="absolute -top-2 -right-2 bg-gray-800 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs leading-none shadow"
                  aria-label={`Quitar foto ${i + 1}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-gray-400 mt-1">{adjuntosPendientes.length} fotos seleccionadas</p>
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
            // Modo voz: el input se convierte en la vista previa en vivo
            // de todo lo reconocido hasta ahora (transcripcionParcial ya
            // incluye los segmentos confirmados entre pausas, no solo el
            // último) — de solo lectura mientras se dicta, para que el
            // docente vea que nada se pierde entre silencios sin poder
            // corromper el texto a medio dictar (ver "Corregir envío
            // prematuro de mensajes durante el dictado por voz"). Nunca
            // se envía desde aquí: solo el segundo toque del micrófono
            // dispara sendMessage.
            value={asistente.modoVoz ? asistente.transcripcionParcial : input}
            onChange={e => { if (!asistente.modoVoz) setInput(e.target.value) }}
            readOnly={asistente.modoVoz}
            onKeyDown={e => e.key === 'Enter' && !asistente.modoVoz && enviar()}
            placeholder={asistente.modoVoz ? 'Escuchando…' : '¿Qué necesitas hoy, maestro?'}
            className="flex-1 bg-gray-100 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-purple-400"
          />
          {!asistente.modoVoz && (
            <>
              <input
                ref={adjuntoInputRef}
                type="file"
                accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
                multiple
                className="hidden"
                onChange={manejarSeleccionAdjunto}
              />
              <button
                type="button"
                onClick={() => adjuntoInputRef.current?.click()}
                disabled={procesandoFoto || !!comprimiendo}
                aria-label="Adjuntar cámara, fotos o archivos"
                className="w-10 h-10 rounded-full flex items-center justify-center bg-gray-100 text-gray-600 hover:bg-gray-200 transition disabled:opacity-40 flex-shrink-0"
              >
                📷
              </button>
            </>
          )}
          <div className="relative">
            {asistente.modoVoz && asistente.estadoEscucha && (
              <span className="absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] font-medium text-gray-500 bg-white/95 px-2 py-0.5 rounded-full shadow-sm">
                {asistente.estadoEscucha === 'escuchando'
                  ? 'Escuchando'
                  : asistente.estadoEscucha === 'confirmando'
                    ? 'Confirmando…'
                    : asistente.estadoEscucha === 'hablando'
                      ? 'Hablando…'
                      : 'Pensando…'}
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
                      : asistente.estadoEscucha === 'hablando'
                        ? 'bg-blue-500 text-white'
                        : 'bg-red-500 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {asistente.modoVoz && (
                <span
                  className={`absolute inset-0 rounded-full animate-ping opacity-75 ${
                    asistente.estadoEscucha === 'confirmando'
                      ? 'bg-amber-400'
                      : asistente.estadoEscucha === 'pensando'
                        ? 'bg-purple-400'
                        : asistente.estadoEscucha === 'hablando'
                          ? 'bg-blue-400'
                          : 'bg-red-400'
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
          <button type="button" onClick={enviar} disabled={asistente.generando || !!comprimiendo} className="w-10 h-10 bg-gradient-to-r from-purple-600 to-blue-500 text-white rounded-full flex items-center justify-center hover:opacity-90 transition disabled:opacity-40 flex-shrink-0">
            ↑
          </button>
        </div>
      </div>
    </div>
    </>
  )
}
