// lib/planeacion/detectarConsultaPlaneacion.ts
//
// Detección determinista (sin IA, sin red, sin dependencias de servidor)
// de una consulta de planeaciones GUARDADAS. Módulo puro: lo usan el
// servidor (consultaPlaneaciones.ts, /api/chat) y el cliente
// (AsistenteService), para que una consulta de una planeación guardada
// siempre se resuelva con la versión vigente del servidor y nunca con un
// documento local desactualizado. Una sola fuente de verdad.

import { esConsultaDocumentoActual } from '../asistente/documentos'
import { esBorradorDeAjuste, esBorradorPlaneacion, esConfirmacionDePlaneacionGuardada, esVersionGuardadaMostrada } from './extraerBorrador'

// ------------------------------------------------------------------
// Texto
// ------------------------------------------------------------------
const RANGO_DIACRITICOS = new RegExp('[̀-ͯ]', 'g')
export function normalizar(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(RANGO_DIACRITICOS, '').replace(/[^a-z0-9ñ\s]/g, ' ').replace(/\s+/g, ' ').trim()
}
const VACIAS = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'e', 'a', 'en', 'sobre', 'mi', 'mis', 'un', 'una', 'que', 'se', 'llama', 'llamada', 'con', 'por', 'para', 'nuestra', 'nuestro'])
export function palabras(s: string): string[] {
  return normalizar(s).split(' ').filter((p) => p.length > 1 && !VACIAS.has(p))
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']
const ORDINALES: Record<string, number> = { primera: 1, primero: 1, segunda: 2, segundo: 2, tercera: 3, tercero: 3, cuarta: 4, cuarto: 4, quinta: 5, quinto: 5, sexta: 6, septima: 7, octava: 8, novena: 9, decima: 10, ultima: -1 }

// ------------------------------------------------------------------
// Detección determinista
// ------------------------------------------------------------------
// etiqueta: complemento listo para la frase ("en noviembre", "esta semana",
// "del 3 al 14 de noviembre"): "Trabajaste 4 planeaciones en noviembre".
export type RangoFechas = { desde: string; hasta: string; etiqueta: string }
export type VersionSolicitada = number | 'anterior' | 'original' | 'vigente'
export type ConsultaPlaneacion =
  | { tipo: 'por_nombre'; nombre: string; version: VersionSolicitada | null }
  | { tipo: 'listado' }
  | { tipo: 'por_fechas'; rango: RangoFechas }
  | { tipo: 'actual' }
  | { tipo: 'ultima' }
  // Seguimiento de la conversación (requiere la referencia guardada):
  | { tipo: 'seleccion'; indice: number }
  | { tipo: 'version'; version: VersionSolicitada }

const VERBO_CONSULTA = /\b(muestrame|muestramela|ensename|ensenamela|abreme|abre|abrir|abrela|consulta|consultar|recupera|recuperar|recuperame|busca|buscar|buscame|quiero ver|ver|mostrar|mostrarme|revisar|revisa|lee|leeme|cual es|cuales son|que planeaciones|cuantas planeaciones)\b/
// "haz"/"hacer" solo crean algo nuevo con artículo ("haz una planeación"); "haz más dinámica…" es un cambio.
export const GENERAR = /\b(elabora|elaborar|genera|generar|crea|crear|haz (un|una|unos|unas)|hacer (un|una)|hazme|prepara|preparar|preparame|disena|disenar|redacta|redactar|planea|planear|arma|armar|nueva planeacion|otra planeacion)\b/
// Apoyo para entender un cambio sin documento activo; con una planeación
// guardada confirmada como documento activo manda el contexto
// (decidirEdicionGuardada), no esta lista.
export const MODIFICAR = /\b(haz|hazla|hazle|ponle|vuelvela|incorpora|incorporale|incluye|incluyele|integra|integrale|elimina|eliminale|simplifica|simplificala|enriquece|enriquecela|adapta|adaptala|reorganiza|reorganizala|extiende|extiendela|cambia|cambiale|cambiar|modifica|modificar|ajusta|ajustala|ajustar|agrega|agregale|agregar|anade|quita|quitale|quitar|corrige|corregir|reemplaza|sustituye|actualiza|actualizar|edita|editar|mejora|mejorar|alarga|acorta|reduce|amplia)\b/
const APROBAR = /\b(apruebala|aprueba|aprobar|guardala|guarda|guardar)\b/
export const SUSTANTIVO = /\bplaneaci(on|ones)\b/
export const SENALA_DOCUMENTO = /\b(cambiale|cambiala|modificala|modificale|ajustala|ajustale|corrigela|corrigele|mejorala|editala|agregale|quitale|anadele|actualizala|reducela|ampliala|alargala|acortala)\b/
export const PARTES_PLANEACION = /\b(sesion|sesiones|actividad|actividades|proposito|evaluacion|producto|indicador|indicadores|contenido|contenidos|pda|recursos|secuencia|inicio|desarrollo|cierre|campo formativo|ejes?|metodologia|fechas?|duracion|dias)\b/

export function versionEnTexto(n: string): VersionSolicitada | null {
  const m = n.match(/\bversion\s+(\d{1,3})\b/)
  if (m) return Number(m[1])
  if (/\bversion\s+(anterior|previa|pasada)\b|\b(anterior|previa)\s+version\b/.test(n)) return 'anterior'
  if (/\bversion\s+(original|inicial|primera)\b|\bprimera\s+version\b/.test(n)) return 'original'
  if (/\bversion\s+(vigente|actual|ultima|mas reciente)\b|\bultima\s+version\b/.test(n)) return 'vigente'
  const o = n.match(/\b(primera|segunda|tercera|cuarta|quinta)\s+version\b/)
  if (o) return ORDINALES[o[1]]
  return null
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10)
}
function fechaDe(hoy: string): Date {
  return new Date(`${hoy}T12:00:00Z`)
}

// Periodo de fechas dicho en lenguaje natural (determinista). hoy = AAAA-MM-DD.
export function rangoDeFechasEnTexto(texto: string, hoy: string): RangoFechas | null {
  const n = normalizar(texto)
  const h = fechaDe(hoy)
  const anio = h.getUTCFullYear()
  const lunes = (d: Date) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x }
  const masDias = (d: Date, dias: number) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + dias); return x }
  if (/\besta semana\b/.test(n)) { const l = lunes(h); return { desde: iso(l), hasta: iso(masDias(l, 6)), etiqueta: 'esta semana' } }
  if (/\bsemana pasada\b/.test(n)) { const l = masDias(lunes(h), -7); return { desde: iso(l), hasta: iso(masDias(l, 6)), etiqueta: 'la semana pasada' } }
  if (/\beste mes\b/.test(n)) { const d = new Date(Date.UTC(anio, h.getUTCMonth(), 1)); return { desde: iso(d), hasta: iso(new Date(Date.UTC(anio, h.getUTCMonth() + 1, 0))), etiqueta: 'este mes' } }
  if (/\bmes pasado\b/.test(n)) { const d = new Date(Date.UTC(anio, h.getUTCMonth() - 1, 1)); return { desde: iso(d), hasta: iso(new Date(Date.UTC(anio, h.getUTCMonth(), 0))), etiqueta: 'el mes pasado' } }
  const mes = `(${MESES.join('|')})`
  // del 3 al 14 de noviembre | del 28 de octubre al 5 de noviembre
  const r = n.match(new RegExp(`\\bdel? (\\d{1,2})(?: de ${mes})? al (\\d{1,2}) de ${mes}(?: de (\\d{4}))?`))
  if (r) {
    const mesFin = MESES.indexOf(r[4])
    const mesIni = r[2] ? MESES.indexOf(r[2]) : mesFin
    const a = r[5] ? Number(r[5]) : anio
    const desde = new Date(Date.UTC(mesIni > mesFin ? a - 1 : a, mesIni, Number(r[1])))
    const hasta = new Date(Date.UTC(a, mesFin, Number(r[3])))
    if (desde <= hasta) return { desde: iso(desde), hasta: iso(hasta), etiqueta: `del ${r[1]}${r[2] ? ` de ${r[2]}` : ''} al ${r[3]} de ${r[4]}` }
  }
  const m = n.match(new RegExp(`\\b(?:(?:en|de|durante|del mes de) )?${mes}(?: (?:de )?(\\d{4}))?\\b`))
  if (m) {
    const i = MESES.indexOf(m[1])
    const a = m[2] ? Number(m[2]) : (i > h.getUTCMonth() ? anio - 1 : anio)
    return { desde: iso(new Date(Date.UTC(a, i, 1))), hasta: iso(new Date(Date.UTC(a, i + 1, 0))), etiqueta: `en ${m[1]}${m[2] ? ` de ${m[2]}` : ''}` }
  }
  return null
}

// Selección en respuesta a una lista numerada ("la 2", "la segunda", "opción 3").
export function seleccionEnTexto(texto: string): number | null {
  const n = normalizar(texto)
  const m = n.match(/^(?:la |el |opcion |numero |la numero |la opcion )?(\d{1,2})$/)
  if (m) return Number(m[1])
  const o = n.match(/^(?:la |el )?(primera|primero|segunda|segundo|tercera|tercero|cuarta|cuarto|quinta|quinto|sexta|septima|octava|novena|decima|ultima)(?: opcion| planeacion)?$/)
  return o ? ORDINALES[o[1]] : null
}

// Consulta inequívoca de planeaciones GUARDADAS, sin IA. null si el
// mensaje genera, modifica o aprueba, o si no es claro (lo decide el
// clasificador de siempre).
export function detectarConsultaPlaneacion(texto: string, hoy: string): ConsultaPlaneacion | null {
  const n = normalizar(texto)
  if (!n || n.length > 220) return null
  if (GENERAR.test(n) || MODIFICAR.test(n) || APROBAR.test(n)) return null
  // "una planeación de…", "ejemplo de planeación", ideas o recomendaciones:
  // no son planeaciones guardadas; lo decide el orquestador.
  if (/\b(una|un|alguna|algun|ejemplo de|ejemplos de|modelo de) planeacion(es)?\b/.test(n) || /\b(recomiendas|recomienda|sugieres|sugiere|ideas|ejemplo|ejemplos)\b/.test(n)) return null

  const seleccion = seleccionEnTexto(texto)
  if (seleccion !== null) return { tipo: 'seleccion', indice: seleccion }
  const version = versionEnTexto(n)
  const tieneSustantivo = SUSTANTIVO.test(n)
  // "muéstrame la versión anterior" (sin nombre): sobre la planeación en contexto.
  if (version !== null && !tieneSustantivo && n.split(' ').length <= 8) return { tipo: 'version', version }

  if (!tieneSustantivo) return null
  const listado = /\bplaneaciones\b/.test(n) || /\b(que|cuales|cuantas) planeaciones\b/.test(n)
  if (!VERBO_CONSULTA.test(n) && !/^(mis )?planeaciones\b/.test(n) && !/\b(tengo|hice|he hecho|trabaje|guarde|guardadas|hechas)\b/.test(n)) return null

  const rango = rangoDeFechasEnTexto(texto, hoy)
  if (listado) return rango ? { tipo: 'por_fechas', rango } : { tipo: 'listado' }
  if (/\b(planeacion )?(de hoy|vigente|actual|de esta semana|en curso)\b/.test(n) && !/\bde (las|los|la|el) \w+/.test(n.replace(/\bde hoy\b/, ''))) return { tipo: 'actual' }
  if (/\b(ultima|mas reciente) planeacion\b|\bplaneacion mas reciente\b/.test(n)) return { tipo: 'ultima' }

  const nombre = nombreTrasPlaneacion(texto)
  if (palabras(nombre).length === 0) return null
  return { tipo: 'por_nombre', nombre, version }
}

// Nombre citado: lo que sigue a "planeación [de|sobre|llamada]" hasta la
// primera puntuación o el primer verbo de cambio, sin la versión ni
// muletillas. '' si no hay.
export function nombreTrasPlaneacion(texto: string): string {
  const original = texto.normalize('NFD').replace(RANGO_DIACRITICOS, '')
  const i = original.search(/planeaci[oó]n(?!es)/i)
  if (i === -1) return ''
  const tramo = normalizar(original.slice(i).replace(/^planeaci[oó]n/i, '').split(/[,:;.?!¿¡\n]/)[0])
  const palabrasTramo = tramo.split(' ')
  const corte = palabrasTramo.findIndex((w) => MODIFICAR.test(w))
  return (corte === -1 ? tramo : palabrasTramo.slice(0, corte).join(' '))
    .replace(/\b(version\s+(\d{1,3}|anterior|previa|pasada|original|inicial|primera|vigente|actual|ultima|mas reciente)|(primera|segunda|tercera|cuarta|quinta|ultima|anterior|previa)\s+version)\b/g, ' ')
    .replace(/\b(por favor|porfa|que guarde|que hice|que tengo|guardada|completa|otra vez|de nuevo)\b/g, ' ')
    .replace(/^\s*(de|del|sobre|llamada|que se llama|con el nombre)\s+/, '')
    .replace(/\s+(para|porque|pero|y que|que)\s.*$/, '')
    .trim()
}

// ------------------------------------------------------------------
// Cliente: ¿la resuelve el servidor?
// ------------------------------------------------------------------
// Consultas de planeaciones guardadas que siempre resuelve el servidor con
// la versión VIGENTE (por nombre, la actual, la última, listados y
// periodos). "La 2" y "la versión anterior" dependen de la conversación y
// siguen su camino.
const TIPOS_CONSULTA_GUARDADA = new Set<ConsultaPlaneacion['tipo']>(['por_nombre', 'actual', 'ultima', 'listado', 'por_fechas'])

// ¿El documento activo es una planeación YA guardada? Una versión mostrada
// por el servidor, o un borrador (nuevo o de ajuste) cuya aprobación se
// confirmó después. Un borrador sin esa confirmación es local: todavía no
// existe como versión.
export function esPlaneacionYaGuardada(documentoActivo: string, respuestasPosteriores: string[]): boolean {
  return esVersionGuardadaMostrada(documentoActivo) || (esBorradorPlaneacion(documentoActivo) && respuestasPosteriores.some(esConfirmacionDePlaneacionGuardada))
}

// true: va como mensaje normal y el servidor la resuelve con la versión
// VIGENTE (sin IA), nunca con un documento local que pudo quedar
// desactualizado. respuestasPosteriores: las respuestas del asistente
// posteriores al documento activo.
// - Por nombre, listados, periodos, la última: siempre, salvo que el
//   documento activo sea el borrador de una planeación nueva sin guardar
//   (solo existe en la conversación).
// - Sin nombre ("Muéstrame la planeación", "Enséñamela", "Muéstramelo"):
//   solo si el documento activo es una planeación YA guardada (el servidor
//   la identifica con planeacion_activa). Un borrador nuevo o un ajuste
//   todavía pendiente se sigue mostrando en el cliente.
export function consultaPlaneacionEnServidor(texto: string, hoy: string, documentoActivo: string | null, respuestasPosteriores: string[]): boolean {
  const consulta = detectarConsultaPlaneacion(texto, hoy)
  if (consulta && TIPOS_CONSULTA_GUARDADA.has(consulta.tipo)) {
    if (!documentoActivo || !esBorradorPlaneacion(documentoActivo) || esBorradorDeAjuste(documentoActivo)) return true
    return respuestasPosteriores.some(esConfirmacionDePlaneacionGuardada)
  }
  return !consulta && !!documentoActivo && esConsultaDocumentoActual(texto, documentoActivo) && esPlaneacionYaGuardada(documentoActivo, respuestasPosteriores)
}
