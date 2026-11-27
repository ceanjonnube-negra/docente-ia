// lib/documentGen/maquetaDocumento.ts
//
// Maqueta compartida (pura y determinista) de una planeación didáctica:
// QUÉ es cada parte del texto canónico (título, datos generales, sección,
// sesión, momento didáctico, párrafo, elemento de lista, indicador,
// evaluación, nota, firma). Sin React ni bibliotecas de render: la usan la
// pestaña Planeación (sesiones) y los generadores de documentos. La
// presentación nunca es una segunda fuente de verdad: cada bloque conserva
// el texto canónico de su línea (textoMaqueta lo reconstruye en orden).

import { analizarContenido, type LineaDocumento } from './parseContenido'

export const EMOJI_INICIAL = /^[\p{Extended_Pictographic}\u{1F300}-\u{1FAFF}\u{2190}-\u{2BFF}\uFE0F\s]+/u
export const ETIQUETA = /^([A-Za-zÁÉÍÓÚÑÜáéíóúñü ]{3,40}):\s+(.+)$/
export const SESION = /^D[IÍ]A\s+(\d+)\s*(?:[—–-]\s*)?(.*)$/i
const FECHA = /^Fecha(?:\s+estimada)?:\s+(.+)$/i
const EVALUACION = /^Evaluaci[oó]n:\s+(.+)$/i
const MOMENTO_SIN_EMOJI = /^(Inicio|Desarrollo|Cierre)\b/i
const MINUTOS = /^(.*?)\s*\((\d+)\s*min(?:utos)?\)\s*$/i
export const sinEmoji = (texto: string) => texto.replace(EMOJI_INICIAL, '').trim()

// ------------------------------------------------------------------
// Estructura (pura)
// ------------------------------------------------------------------
export type GrupoSeccion = { titulo: string | null; lineas: LineaDocumento[] }

export function agrupar(lineas: LineaDocumento[]): GrupoSeccion[] {
  const bloques: GrupoSeccion[] = [{ titulo: null, lineas: [] }]
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
export function esMomento(l: LineaDocumento): boolean {
  if (l.tipo !== 'parrafo') return false
  const texto = sinEmoji(l.texto)
  if (ETIQUETA.test(texto)) return false
  const breve = texto.length <= 60 || MINUTOS.test(texto)
  return EMOJI_INICIAL.test(l.texto) ? breve || MOMENTO_SIN_EMOJI.test(texto) : MOMENTO_SIN_EMOJI.test(texto) && breve
}

export type Momento = { nombre: string; minutos: number | null; lineas: LineaDocumento[] }
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
// Bloques de la planeación para documentos
// ------------------------------------------------------------------
// "📋 PLANEACIÓN DIDÁCTICA…": la nueva composición se aplica solo a
// planeaciones; los demás documentos conservan su generador de siempre.
export function esPlaneacionDidactica(texto: string): boolean {
  const primera = texto.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  return /PLANEACI[OÓ]N\s+DID[AÁ]CTICA/i.test(sinEmoji(primera))
}

export type BloqueMaqueta =
  | { tipo: 'titulo'; texto: string }
  | { tipo: 'dato'; etiqueta: string; valor: string }
  | { tipo: 'seccion'; texto: string }
  // "📅 DÍA 1 — Título" (+ su "Fecha estimada:" si viene inmediatamente).
  | { tipo: 'sesion'; numero: string; titulo: string; fecha: string | null; original: string; fechaOriginal: string | null }
  | { tipo: 'momento'; nombre: string; minutos: number | null; original: string }
  | { tipo: 'parrafo'; texto: string; etiqueta: string | null; valor: string | null; enSesion: boolean }
  | { tipo: 'item'; texto: string; enSesion: boolean }
  | { tipo: 'numerado'; numero: string; texto: string }
  | { tipo: 'evaluacion'; texto: string; original: string }
  | { tipo: 'nota'; texto: string }

const NUMERADO = /^(\d{1,2})[.)]\s+(.+)$/

// Bloques en el orden exacto de las líneas canónicas (analizarContenido).
export function construirMaqueta(texto: string): BloqueMaqueta[] {
  const bloques: BloqueMaqueta[] = []
  let enSesion = false
  let antesDePrimeraSeccion = true
  let sesionAbierta: Extract<BloqueMaqueta, { tipo: 'sesion' }> | null = null
  let momentosEnSesion = 0
  for (const l of analizarContenido(texto)) {
    const limpio = sinEmoji(l.texto)
    if (!limpio) continue
    if (l.tipo === 'titulo') { bloques.push({ tipo: 'titulo', texto: limpio }); continue }
    if (l.tipo === 'seccion') {
      antesDePrimeraSeccion = false
      const s = limpio.match(SESION)
      if (s) {
        sesionAbierta = { tipo: 'sesion', numero: s[1], titulo: s[2].trim(), fecha: null, original: limpio, fechaOriginal: null }
        bloques.push(sesionAbierta)
        enSesion = true
        momentosEnSesion = 0
      } else {
        bloques.push({ tipo: 'seccion', texto: limpio })
        enSesion = false
        sesionAbierta = null
      }
      continue
    }
    if (l.tipo === 'bullet') { bloques.push({ tipo: 'item', texto: limpio, enSesion }); continue }
    // Párrafo
    const fecha = limpio.match(FECHA)
    if (sesionAbierta && fecha && sesionAbierta.fecha === null && momentosEnSesion === 0 && bloques[bloques.length - 1] === sesionAbierta) {
      sesionAbierta.fecha = fecha[1]
      sesionAbierta.fechaOriginal = limpio
      continue
    }
    const evaluacion = enSesion ? limpio.match(EVALUACION) : null
    if (evaluacion) { bloques.push({ tipo: 'evaluacion', texto: evaluacion[1], original: limpio }); continue }
    if (enSesion && esMomento(l)) {
      const d = limpio.match(MINUTOS)
      bloques.push({ tipo: 'momento', nombre: d ? d[1] : limpio, minutos: d ? Number(d[2]) : null, original: limpio })
      momentosEnSesion++
      continue
    }
    const numerado = limpio.match(NUMERADO)
    if (numerado && !enSesion) { bloques.push({ tipo: 'numerado', numero: numerado[1], texto: numerado[2] }); continue }
    if (/^Nota\b/i.test(limpio)) { bloques.push({ tipo: 'nota', texto: limpio }); continue }
    const etiqueta = limpio.match(ETIQUETA)
    if (antesDePrimeraSeccion && etiqueta) { bloques.push({ tipo: 'dato', etiqueta: etiqueta[1], valor: etiqueta[2] }); continue }
    bloques.push({ tipo: 'parrafo', texto: limpio, etiqueta: etiqueta ? etiqueta[1] : null, valor: etiqueta ? etiqueta[2] : null, enSesion })
  }
  return bloques
}

// Texto canónico (sin emojis) que representa cada bloque, en orden: debe
// coincidir línea por línea con analizarContenido (la maqueta no agrega,
// quita ni reordena contenido).
export function textoMaqueta(bloques: BloqueMaqueta[]): string[] {
  const salida: string[] = []
  for (const b of bloques) {
    switch (b.tipo) {
      case 'titulo': case 'seccion': case 'item': case 'nota': salida.push(b.texto); break
      case 'dato': salida.push(`${b.etiqueta}: ${b.valor}`); break
      case 'sesion': salida.push(b.original); if (b.fechaOriginal) salida.push(b.fechaOriginal); break
      case 'momento': case 'evaluacion': salida.push(b.original); break
      case 'parrafo': salida.push(b.texto); break
      case 'numerado': salida.push(`${b.numero}. ${b.texto}`); break
    }
  }
  return salida
}

// Versión real del documento ("Versión: N" que agrega textoDocumentoVersion);
// null si no la trae (nunca se inventa).
export function versionDeMaqueta(bloques: BloqueMaqueta[]): string | null {
  const dato = bloques.find((b) => b.tipo === 'dato' && /^versi[oó]n$/i.test(b.etiqueta)) as Extract<BloqueMaqueta, { tipo: 'dato' }> | undefined
  return dato && /^\d{1,4}$/.test(dato.valor.trim()) ? dato.valor.trim() : null
}
