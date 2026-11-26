// Contenido de una versión, leído con el MISMO intérprete que los
// generadores de Word/PDF (analizarContenido) y armado con el mismo texto
// canónico (textoDocumentoVersion): lo que se ve es lo que trae el archivo.
// El título del documento no se repite y los emojis se omiten: la
// jerarquía la da la tipografía. Cada sesión ("DÍA N — …") se pliega y se
// presenta como línea de tiempo (Inicio, Desarrollo, Cierre) sin resumir,
// inventar ni reordenar nada: solo cambia la presentación.

import { analizarContenido, type LineaDocumento } from '@/lib/documentGen/parseContenido'
import { textoDocumentoVersion } from '@/lib/planeacion/documentoVersion'

const EMOJI_INICIAL = /^[\p{Extended_Pictographic}\u{1F300}-\u{1FAFF}\u{2190}-\u{2BFF}\uFE0F\s]+/u
const ETIQUETA = /^([A-Za-zÁÉÍÓÚÑÜáéíóúñü ]{3,40}):\s+(.+)$/
const SESION = /^D[IÍ]A\s+(\d+)\s*(?:[—–-]\s*)?(.*)$/i
const FECHA = /^Fecha(?:\s+estimada)?:\s+(.+)$/i
const EVALUACION = /^Evaluaci[oó]n:\s+(.+)$/i
const MOMENTO_SIN_EMOJI = /^(Inicio|Desarrollo|Cierre)\b/i
const MINUTOS = /^(.*?)\s*\((\d+)\s*min(?:utos)?\)\s*$/i
const sinEmoji = (texto: string) => texto.replace(EMOJI_INICIAL, '').trim()

// ------------------------------------------------------------------
// Estructura (pura)
// ------------------------------------------------------------------
type Bloque = { titulo: string | null; lineas: LineaDocumento[] }

function agrupar(lineas: LineaDocumento[]): Bloque[] {
  const bloques: Bloque[] = [{ titulo: null, lineas: [] }]
  for (const l of lineas) {
    if (l.tipo === 'seccion') bloques.push({ titulo: sinEmoji(l.texto), lineas: [] })
    else bloques[bloques.length - 1].lineas.push(l)
  }
  return bloques.filter((b) => b.titulo || b.lineas.length)
}

// "🔷 Inicio (15 min)", "🔶 Desarrollo — Actividad en equipos: … (35 min)":
// momento de la sesión. Con emoji: línea corta, con sus minutos o que
// empieza con Inicio/Desarrollo/Cierre. Sin emoji: solo Inicio/Desarrollo/
// Cierre en una línea corta o con sus minutos (nunca un párrafo largo).
function esMomento(l: LineaDocumento): boolean {
  if (l.tipo !== 'parrafo') return false
  const texto = sinEmoji(l.texto)
  if (ETIQUETA.test(texto)) return false
  const breve = texto.length <= 60 || MINUTOS.test(texto)
  return EMOJI_INICIAL.test(l.texto) ? breve || MOMENTO_SIN_EMOJI.test(texto) : MOMENTO_SIN_EMOJI.test(texto) && breve
}

type Momento = { nombre: string; minutos: number | null; lineas: LineaDocumento[] }
export type Sesion = {
  numero: string
  titulo: string
  fecha: string | null
  minutosTotales: number | null
  antes: LineaDocumento[]
  momentos: Momento[]
  evaluaciones: string[]
}

export function estructurarSesion(titulo: string, lineas: LineaDocumento[]): Sesion | null {
  const m = titulo.match(SESION)
  if (!m) return null
  const sesion: Sesion = { numero: m[1], titulo: m[2].trim(), fecha: null, minutosTotales: null, antes: [], momentos: [], evaluaciones: [] }
  for (const l of lineas) {
    const texto = sinEmoji(l.texto)
    const fecha = l.tipo === 'parrafo' && sesion.fecha === null && sesion.momentos.length === 0 ? texto.match(FECHA) : null
    const evaluacion = l.tipo === 'parrafo' ? texto.match(EVALUACION) : null
    if (fecha) sesion.fecha = fecha[1]
    else if (evaluacion) sesion.evaluaciones.push(evaluacion[1])
    else if (esMomento(l)) {
      const d = texto.match(MINUTOS)
      sesion.momentos.push({ nombre: d ? d[1] : texto, minutos: d ? Number(d[2]) : null, lineas: [] })
    } else if (sesion.momentos.length) sesion.momentos[sesion.momentos.length - 1].lineas.push(l)
    else sesion.antes.push(l)
  }
  // Duración: solo si TODOS los momentos declaran sus minutos.
  if (sesion.momentos.length && sesion.momentos.every((x) => x.minutos !== null)) sesion.minutosTotales = sesion.momentos.reduce((s, x) => s + (x.minutos ?? 0), 0)
  return sesion
}

// ------------------------------------------------------------------
// Presentación
// ------------------------------------------------------------------
function Linea({ linea }: { linea: LineaDocumento }) {
  if (linea.tipo === 'bullet') {
    return (
      <p className="flex gap-2 pl-1">
        <span className="mt-[9px] w-1 h-1 rounded-full bg-green-600 flex-shrink-0" />
        <span>{sinEmoji(linea.texto)}</span>
      </p>
    )
  }
  const conEmoji = EMOJI_INICIAL.test(linea.texto)
  const texto = sinEmoji(linea.texto)
  const etiqueta = texto.match(ETIQUETA)
  if (etiqueta) return <p><span className="font-medium text-gray-900">{etiqueta[1]}:</span> {etiqueta[2]}</p>
  if (conEmoji && texto.length <= 60) return <p className="pt-1.5 text-[13px] font-semibold text-gray-900">{texto}</p>
  return <p>{texto}</p>
}

const Lineas = ({ lineas }: { lineas: LineaDocumento[] }) => <div className="space-y-1.5">{lineas.map((l, j) => <Linea key={j} linea={l} />)}</div>

function SesionPlegable({ sesion }: { sesion: Sesion }) {
  return (
    <details className="group rounded-xl border border-gray-200/80 bg-white open:shadow-sm">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-3 [&::-webkit-details-marker]:hidden">
        <span className="w-8 h-8 rounded-full bg-green-50 text-green-800 text-[13px] font-semibold flex items-center justify-center flex-shrink-0" aria-label={`Día ${sesion.numero}`}>{sesion.numero}</span>
        <span className="flex-1 min-w-0">
          <span className="block text-[14px] font-semibold leading-snug text-gray-900">{sesion.titulo || `Sesión ${sesion.numero}`}</span>
          {(sesion.fecha || sesion.minutosTotales) && (
            <span className="block mt-0.5 text-xs text-gray-600">
              {sesion.fecha}
              {sesion.fecha && sesion.minutosTotales ? ' · ' : ''}
              {sesion.minutosTotales ? <span className="whitespace-nowrap">{sesion.minutosTotales} min</span> : null}
            </span>
          )}
        </span>
        <svg className="w-4 h-4 flex-shrink-0 text-gray-500 transition-transform group-open:rotate-180" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m6 9 6 6 6-6" /></svg>
      </summary>
      <div className="px-3 pb-4 space-y-3">
        {sesion.antes.length > 0 && <Lineas lineas={sesion.antes} />}
        {sesion.momentos.length > 0 && (
          <ol className="relative ml-[15px] border-l border-green-200 pl-5 space-y-4">
            {sesion.momentos.map((m, i) => (
              <li key={i} className="relative">
                <span className="absolute -left-[25.5px] top-[7px] w-2.5 h-2.5 rounded-full bg-green-600 ring-4 ring-white" aria-hidden />
                <p className="flex flex-wrap items-baseline gap-x-2 text-[13px] font-semibold text-gray-900">
                  {m.nombre}
                  {m.minutos !== null && <span className="text-xs font-medium text-gray-600">{m.minutos} min</span>}
                </p>
                {m.lineas.length > 0 && <div className="mt-1"><Lineas lineas={m.lineas} /></div>}
              </li>
            ))}
          </ol>
        )}
        {sesion.evaluaciones.map((e, i) => (
          <div key={i} className="rounded-lg bg-gray-50 border border-gray-100 px-3 py-2.5 text-[13px] leading-relaxed">
            <span className="block text-[11px] font-semibold uppercase tracking-wide text-gray-600">Evaluación</span>
            <span className="text-gray-800">{e}</span>
          </div>
        ))}
      </div>
    </details>
  )
}

export default function ContenidoVersion({ contenido, numero, indicadores }: { contenido: string; numero: number; indicadores: string[] }) {
  const lineas = analizarContenido(textoDocumentoVersion({ contenido, numero, indicadores, mostrarNumero: false })).filter((l) => l.tipo !== 'titulo')
  const bloques = agrupar(lineas)
  return (
    <div className="text-[14px] leading-relaxed text-gray-700">
      {bloques.map((b, i) => {
        const sesion = b.titulo ? estructurarSesion(b.titulo, b.lineas) : null
        if (sesion) {
          const primera = i === 0 || !estructurarSesion(bloques[i - 1].titulo ?? '', [])
          return <div key={i} className={primera ? 'pt-3 pb-1.5' : 'pb-1.5'}><SesionPlegable sesion={sesion} /></div>
        }
        return (
          <section key={i} className={b.titulo ? 'border-t border-gray-100 first:border-t-0 py-3' : 'pb-3'}>
            {b.titulo && <h3 className="mb-1.5 text-[13px] font-semibold uppercase tracking-wide text-green-800">{b.titulo}</h3>}
            <Lineas lineas={b.lineas} />
          </section>
        )
      })}
    </div>
  )
}
