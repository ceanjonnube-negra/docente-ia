// lib/planeacion/consultaPlaneaciones.ts
//
// Hito 2, etapa 2 — consulta de planeaciones guardadas desde el Chat IA.
// Solo LECTURA de la planeación: nunca la modifica ni regenera archivos.
//
// - Fuente canónica: planeacion_versiones (texto, estructura y archivos
//   originales de cada versión). La vigente por omisión; una anterior solo
//   si se pide explícitamente.
// - Alcance: el docente autenticado (RLS) y el grupo activo de la sesión.
// - Contexto: conversaciones_chat.planeacion_activa guarda solo una
//   REFERENCIA (planeación + versión mostrada, u opciones numeradas de una
//   pregunta pendiente), nunca el contenido.
// - Determinista y sin IA cuando la intención es inequívoca
//   (detectarConsultaPlaneacion); lo demás lo clasifica el orquestador de
//   siempre (planeacion_consultar).

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Planeacion } from './tipos'
import { enlacesArchivoPropio } from '../documentGen/registroArchivos'
import { esDocumentoFormal } from '../asistente/documentos'
import { esBorradorPlaneacion, extraerResumenBorrador } from './extraerBorrador'
import { listarPlaneaciones } from './persistencia'

// ------------------------------------------------------------------
// Texto
// ------------------------------------------------------------------
const RANGO_DIACRITICOS = new RegExp('[̀-ͯ]', 'g')
export function normalizar(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(RANGO_DIACRITICOS, '').replace(/[^a-z0-9ñ\s]/g, ' ').replace(/\s+/g, ' ').trim()
}
const VACIAS = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'e', 'a', 'en', 'sobre', 'mi', 'mis', 'un', 'una', 'que', 'se', 'llama', 'llamada', 'con', 'por', 'para', 'nuestra', 'nuestro'])
function palabras(s: string): string[] {
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
const GENERAR = /\b(elabora|elaborar|genera|generar|crea|crear|haz|hacer|hazme|prepara|preparar|preparame|disena|disenar|redacta|redactar|planea|planear|arma|armar|nueva planeacion|otra planeacion)\b/
const MODIFICAR = /\b(cambia|cambiale|cambiar|modifica|modificar|ajusta|ajustala|ajustar|agrega|agregale|agregar|anade|quita|quitale|quitar|corrige|corregir|reemplaza|sustituye|actualiza|actualizar|edita|editar|mejora|mejorar|alarga|acorta|reduce|amplia)\b/
const APROBAR = /\b(apruebala|aprueba|aprobar|guardala|guarda|guardar)\b/
const SUSTANTIVO = /\bplaneaci(on|ones)\b/
const SENALA_DOCUMENTO = /\b(cambiale|cambiala|modificala|modificale|ajustala|ajustale|corrigela|corrigele|mejorala|editala|agregale|quitale|anadele|actualizala|reducela|ampliala|alargala|acortala)\b/
const PARTES_PLANEACION = /\b(sesion|sesiones|actividad|actividades|proposito|evaluacion|producto|indicador|indicadores|contenido|contenidos|pda|recursos|secuencia|inicio|desarrollo|cierre|campo formativo|ejes?|metodologia|fechas?|duracion|dias)\b/

function versionEnTexto(n: string): VersionSolicitada | null {
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
// Búsqueda
// ------------------------------------------------------------------
// Coincidencia por nombre: todas las palabras significativas buscadas
// aparecen en el nombre. Si alguna coincide EXACTAMENTE, solo esas. Nunca
// se elige una entre varias: el llamador pregunta.
export function coincidenciasPorNombre<T extends { nombre: string | null }>(planeaciones: T[], texto: string): T[] {
  const buscadas = palabras(texto)
  if (buscadas.length === 0) return []
  const exactas = planeaciones.filter((p) => normalizar(p.nombre ?? '') === normalizar(texto))
  if (exactas.length > 0) return exactas
  return planeaciones.filter((p) => {
    const nombre = new Set(palabras(p.nombre ?? ''))
    return buscadas.every((b) => nombre.has(b) || [...nombre].some((x) => x.startsWith(b) && b.length >= 4))
  })
}

export function trabajadasEnRango<T extends { fecha_inicio: string | null; fecha_fin: string | null }>(planeaciones: T[], rango: RangoFechas): T[] {
  return planeaciones.filter((p) => p.fecha_inicio && p.fecha_fin && p.fecha_inicio <= rango.hasta && p.fecha_fin >= rango.desde)
}

// ------------------------------------------------------------------
// Referencia contextual (conversaciones_chat.planeacion_activa)
// ------------------------------------------------------------------
// intencion 'modificar': las opciones pendientes vienen de una petición de
// modificar (al elegir, se responde que aún no está disponible).
// instruccionPendiente: el cambio pedido mientras se aclara a qué planeación
// (o desde qué versión) se aplica. ajustes: identidad de los borradores de
// ajuste (modificarPlaneacion.ts), que se conserva al reescribir la referencia.
export type ReferenciaPlaneacion = { esquema: 'referencia-planeacion-v1'; planeacionId: string | null; numero: number | null; opciones: string[]; intencion?: 'modificar'; instruccionPendiente?: string; ajustes?: unknown[] }

export function esReferenciaPlaneacion(v: unknown): v is ReferenciaPlaneacion {
  const r = v as Partial<ReferenciaPlaneacion> | null
  return !!r && r.esquema === 'referencia-planeacion-v1' && Array.isArray(r.opciones) && r.opciones.every((o) => typeof o === 'string')
    && (r.planeacionId === null || typeof r.planeacionId === 'string') && (r.numero === null || typeof r.numero === 'number')
}

export async function leerReferenciaPlaneacion(sb: SupabaseClient, conversacionId: string | null): Promise<ReferenciaPlaneacion | null> {
  if (!conversacionId) return null
  const { data } = await sb.from('conversaciones_chat').select('planeacion_activa').eq('id', conversacionId).maybeSingle()
  const v = (data as { planeacion_activa?: unknown } | null)?.planeacion_activa
  return esReferenciaPlaneacion(v) ? v : null
}

// Mejor esfuerzo: si no se guarda, la consulta igual se entrega.
export async function guardarReferenciaPlaneacion(sb: SupabaseClient, conversacionId: string | null, ref: Omit<ReferenciaPlaneacion, 'esquema'>): Promise<void> {
  if (!conversacionId) return
  // Conserva los ajustes registrados (identidad de borradores de ajuste).
  const { data } = await sb.from('conversaciones_chat').select('planeacion_activa').eq('id', conversacionId).maybeSingle()
  const ajustes = (data as { planeacion_activa?: { ajustes?: unknown } | null } | null)?.planeacion_activa?.ajustes
  const { error } = await sb.from('conversaciones_chat').update({ planeacion_activa: { esquema: 'referencia-planeacion-v1', ...ref, ...(Array.isArray(ajustes) ? { ajustes } : {}) } }).eq('id', conversacionId)
  if (error) console.error('[PLANEACION_CONSULTA] no se pudo guardar la referencia de la conversación:', error.message)
}

// ------------------------------------------------------------------
// Versiones
// ------------------------------------------------------------------
export type VersionPlaneacion = {
  id: string
  planeacion_id: string
  numero: number
  origen: 'aprobacion' | 'modificacion' | 'derivada'
  contenido: string | null
  documento_word_archivo_id: string | null
  documento_pdf_archivo_id: string | null
  creada_en: string
}

export async function versionesDePlaneacion(sb: SupabaseClient, planeacionId: string): Promise<VersionPlaneacion[]> {
  const { data, error } = await sb
    .from('planeacion_versiones')
    .select('id, planeacion_id, numero, origen, contenido, documento_word_archivo_id, documento_pdf_archivo_id, creada_en')
    .eq('planeacion_id', planeacionId)
    .order('numero', { ascending: true })
  if (error) throw new Error(`No se pudieron leer las versiones de la planeación: ${error.message}`)
  return (data ?? []) as VersionPlaneacion[]
}

// Versión pedida, relativa a la vigente (planeaciones.version) o a la ya
// mostrada en esta conversación ('anterior').
export function elegirVersion(versiones: VersionPlaneacion[], vigente: number, pedida: VersionSolicitada | null, mostrada: number | null): VersionPlaneacion | null {
  const por = (n: number) => versiones.find((v) => v.numero === n) ?? null
  if (pedida === null || pedida === 'vigente') return por(vigente)
  if (pedida === 'original') return versiones[0] ?? null
  if (pedida === 'anterior') return por((mostrada ?? vigente) - 1)
  return por(pedida)
}

// Contenido consultado en esta conversación (para no editar ni regenerar
// archivos de una planeación guardada desde su texto mostrado).
export async function versionConsultada(sb: SupabaseClient, conversacionId: string | null): Promise<VersionPlaneacion | null> {
  const ref = await leerReferenciaPlaneacion(sb, conversacionId)
  if (!ref?.planeacionId || ref.numero === null) return null
  const { data } = await sb
    .from('planeacion_versiones')
    .select('id, planeacion_id, numero, origen, contenido, documento_word_archivo_id, documento_pdf_archivo_id, creada_en')
    .eq('planeacion_id', ref.planeacionId)
    .eq('numero', ref.numero)
    .maybeSingle()
  return (data as VersionPlaneacion | null) ?? null
}

export function contieneContenidoConsultado(texto: string, version: VersionPlaneacion | null): boolean {
  const c = version?.contenido?.trim()
  return !!c && c.length > 40 && texto.includes(c)
}

// ¿La instrucción pide cambiar el documento? (no una pregunta ni un formato)
export function pideModificar(texto: string): boolean {
  return MODIFICAR.test(normalizar(texto))
}

// Archivo ORIGINAL de la versión consultada, en el formato pedido. Nunca se
// regenera: si esa versión no lo tiene, se dice.
export async function respuestaArchivoOriginal(version: VersionPlaneacion, formato: 'word' | 'pdf', firmar: FirmarArchivo): Promise<string> {
  const id = formato === 'word' ? version.documento_word_archivo_id : version.documento_pdf_archivo_id
  const etiqueta = formato === 'word' ? 'Word' : 'PDF'
  const archivo = id ? await firmar(id) : null
  if (!id || !archivo) return `Esta versión de la planeación no tiene su ${etiqueta} original guardado.`
  const datos = formato === 'word'
    ? { tipo: 'word', nombre: archivo.nombre, url: archivo.url, archivoId: id, tipoDocumento: 'planeacion' }
    : { tipo: 'pdf', nombre: archivo.nombre, url: archivo.url, urlVer: archivo.urlVer, archivoId: id, tipoDocumento: 'planeacion' }
  return `Aquí está el ${etiqueta} original de la versión ${version.numero}.\n${marcador(datos)}`
}

// ¿La última respuesta del asistente fue la pregunta de elegir de una lista?
export function ultimaRespuestaEsPregunta(historial: { role: string; content: string }[]): boolean {
  const ultima = [...historial].reverse().find((h) => h.role === 'assistant')
  return !!ultima && (ultima.content.includes(PREGUNTA_ELEGIR) || ultima.content.includes(PREGUNTA_ELEGIR_MODIFICAR))
}

export const PREGUNTA_CAMBIO = '¿Qué cambio quieres hacer en'
export function preguntaCambio(nombre: string): string {
  return `${PREGUNTA_CAMBIO} «${nombre}»?`
}

export function mensajeModificacionNoDisponible(nombre: string): string {
  return `Todavía no puedo modificar «${nombre}» desde el Chat. Puedo mostrártela o darte sus archivos originales.`
}

// ------------------------------------------------------------------
// Modificar una planeación GUARDADA (etapa 3, aún no habilitada)
// ------------------------------------------------------------------
// Resuelve en el servidor a qué se refiere "cambia…/modifica…" cuando el
// cliente no trae documento activo, para que nunca caiga en crear una
// planeación nueva. Referente, en este orden:
//   1. Nombre citado ("…la planeación de las leyendas"): si es el borrador
//      vigente de la conversación, edición normal (null); si coincide con
//      planeaciones guardadas del docente y grupo activo: una → bloqueo;
//      varias → pregunta breve.
//   2. Sin nombre: el ÚLTIMO documento de la conversación. Borrador →
//      edición normal (null). La planeación guardada mostrada aquí (su
//      texto canónico, según la referencia persistida) → bloqueo.
//   3. "…la planeación" sin documentos en la conversación: la planeación
//      en contexto (referencia) → bloqueo; si no hay, se pide su nombre.
// null = no se refiere a una planeación guardada: sigue el flujo normal.
// Resultado de resolver una modificación: un ajuste listo para generarse
// (planeación del docente y grupo activo; se parte de su versión vigente) o
// un texto (aclaración breve). null = no es sobre una planeación guardada.
export type ResolucionAjuste =
  | { tipo: 'texto'; texto: string }
  | { tipo: 'ajuste'; planeacion: Planeacion; instruccion: string; numeroConsultado: number | null }

const AFIRMACION = /^(si|sí|si por favor|claro|de acuerdo|ok|okay|adelante|hazlo|aplicalo|aplicala|esa|esa misma|la vigente)\.?$/

async function planeacionesDelGrupo(sb: SupabaseClient, grupoId: string): Promise<Planeacion[]> {
  const r = await listarPlaneaciones({ supabase: sb }, { grupo_id: grupoId })
  if (!r.ok) throw new Error(r.error.mensaje)
  return r.datos
}

// Ajuste sobre una planeación ya identificada. Si el docente nombró una
// versión que no es la vigente, se aclara (los ajustes parten siempre de la
// vigente) antes de generar nada.
async function ajusteSobre(sb: SupabaseClient, conversacionId: string | null, p: Planeacion, instruccion: string, mensaje: string): Promise<ResolucionAjuste> {
  const ref = await leerReferenciaPlaneacion(sb, conversacionId)
  const pedida = versionEnTexto(normalizar(mensaje))
  const numeroPedido = typeof pedida === 'number' ? pedida : pedida === 'original' ? 1 : pedida === 'anterior' ? p.version - 1 : null
  if (numeroPedido !== null && numeroPedido !== p.version) {
    await guardarReferenciaPlaneacion(sb, conversacionId, { planeacionId: p.id, numero: p.version, opciones: [], intencion: 'modificar', instruccionPendiente: instruccion })
    return { tipo: 'texto', texto: `Los ajustes parten siempre de la versión vigente de «${p.nombre}», que es la ${p.version}; la versión ${numeroPedido} se conserva tal cual. ¿Aplico el cambio sobre la versión ${p.version}? Si querías partir de lo que tenía la versión ${numeroPedido}, dime qué recuperar de ella.` }
  }
  return { tipo: 'ajuste', planeacion: p, instruccion, numeroConsultado: ref?.planeacionId === p.id ? ref.numero : null }
}

// Respuesta a una aclaración pendiente ("la 2", "sí"): aplica la
// instrucción guardada a la planeación elegida.
// Respuesta natural a "¿Qué cambio quieres hacer en «X»?" ("que dure 3
// días", "más dinámicas", "para trabajar en equipos", "con menos
// materiales", "solo la segunda sesión"): sin verbo de modificación. Es una
// instrucción para X salvo que sea una consulta, crear algo nuevo, otro
// tema u otra pregunta, una negativa o un mensaje largo. Determinista.
const RESPUESTA_CAMBIO = /^(que|con|sin|para|mas|menos|solo|solamente|unicamente|nada mas|en (el|la|los|las)|el|la|los|las|un|una|unos|unas|y|tambien|agregale|ponle|quitale|incluye|incluir|usa|usar|usando|mejor|otra|otro|otras|otros)\b/
const NUEVO_TEMA = /\b(asistencia|pasa lista|pasar lista|incidencias?|registra|registrar|calificaciones?|calendario escolar|recordatorios?|muestrame|ensename|busca|buscar|cuantos|cuantas|olvidalo|cancela|cancelalo|cancelar)\b/
const NEGATIVA = /^(no|nada|ninguno|ninguna|ya no|mejor no|gracias|hola|adios|asi esta bien)( (gracias|por ahora|asi esta bien))?\.?$/
export function esRespuestaDeCambio(mensaje: string, hoy: string): boolean {
  const n = normalizar(mensaje)
  if (!n || n.split(/\s+/).length > 30 || /\?/.test(mensaje) && !pideModificar(mensaje)) return false
  if (NEGATIVA.test(n) || GENERAR.test(n) || NUEVO_TEMA.test(n) || detectarConsultaPlaneacion(mensaje, hoy)) return false
  return pideModificar(mensaje) || RESPUESTA_CAMBIO.test(n)
}

export async function resolverAjustePendiente(entrada: { sb: SupabaseClient; grupoId: string; conversacionId: string | null; mensaje: string; historial: { role: string; content: string }[]; hoy?: string }): Promise<ResolucionAjuste | null> {
  const { sb, grupoId, conversacionId, mensaje } = entrada
  const ultima = [...entrada.historial].reverse().find((h) => h.role === 'assistant')
  if (ultima?.content.startsWith(PREGUNTA_CAMBIO)) {
    if (!esRespuestaDeCambio(mensaje, entrada.hoy ?? new Date().toISOString().slice(0, 10))) return null
    const ref = await leerReferenciaPlaneacion(sb, conversacionId)
    const p = ref?.intencion === 'modificar' && ref.planeacionId ? (await planeacionesDelGrupo(sb, grupoId)).find((x) => x.id === ref.planeacionId) ?? null : null
    return p ? ajusteSobre(sb, conversacionId, p, mensaje, mensaje) : null
  }
  const indice = seleccionEnTexto(mensaje)
  const afirma = AFIRMACION.test(normalizar(mensaje))
  if (indice === null && !afirma) return null
  const ref = await leerReferenciaPlaneacion(sb, conversacionId)
  if (ref?.intencion !== 'modificar' || !ref.instruccionPendiente) return null
  const todas = await planeacionesDelGrupo(sb, grupoId)
  let elegida: Planeacion | null = null
  if (indice !== null && ref.opciones.length > 0 && ultimaRespuestaEsPregunta(entrada.historial)) {
    const id = indice === -1 ? ref.opciones[ref.opciones.length - 1] : ref.opciones[indice - 1]
    elegida = todas.find((p) => p.id === id) ?? null
    if (!elegida) return { tipo: 'texto', texto: `Elige un número del 1 al ${ref.opciones.length}.` }
  } else if (afirma && ref.planeacionId) {
    elegida = todas.find((p) => p.id === ref.planeacionId) ?? null
  }
  if (!elegida) return null
  return { tipo: 'ajuste', planeacion: elegida, instruccion: ref.instruccionPendiente, numeroConsultado: null }
}

// Resuelve en el servidor a qué planeación GUARDADA se refiere
// "cambia…/modifica…" (también sin documento activo en el cliente), para
// que nunca caiga en crear una planeación nueva. Referente, en este orden:
//   1. Nombre citado: si es el borrador vigente de la conversación, edición
//      normal (null); si coincide con planeaciones guardadas del docente y
//      grupo activo: una → ajuste; varias → pregunta breve (la instrucción
//      queda pendiente).
//   2. Sin nombre: el ÚLTIMO documento de la conversación. Borrador →
//      edición normal (null). La planeación guardada mostrada aquí (su
//      texto canónico, según la referencia persistida) → ajuste.
//   3. "…la planeación" sin documentos: la planeación en contexto
//      (referencia) → ajuste; si no hay, se pide su nombre.
export async function resolverModificacionGuardada(entrada: {
  sb: SupabaseClient
  grupoId: string
  conversacionId: string | null
  historial: { role: string; content: string }[]
  mensaje: string
  voz?: boolean
  zonaHoraria?: string | null
}): Promise<ResolucionAjuste | null> {
  const { sb, grupoId, conversacionId, historial, mensaje } = entrada
  if (!pideModificar(mensaje)) return null
  const n = normalizar(mensaje)
  if (GENERAR.test(n)) return null // crear una planeación nueva (aunque diga "agrega…")
  const nombre = SUSTANTIVO.test(n) ? nombreTrasPlaneacion(mensaje) : ''
  const ultimoDocumento = [...historial].reverse().find((h) => h.role === 'assistant' && (esBorradorPlaneacion(h.content) || esDocumentoFormal(h.content)))
  const borrador = ultimoDocumento && esBorradorPlaneacion(ultimoDocumento.content) ? ultimoDocumento : null
  const ajustar = (p: Planeacion) => ajusteSobre(sb, conversacionId, p, mensaje, mensaje)

  if (palabras(nombre).length > 0) {
    const nombreBorrador = borrador ? extraerResumenBorrador([{ role: 'assistant', content: borrador.content }])?.nombre : null
    if (nombreBorrador && coincidenciasPorNombre([{ nombre: nombreBorrador }], nombre).length > 0) return null
    const coincidencias = coincidenciasPorNombre(await planeacionesDelGrupo(sb, grupoId), nombre)
    if (coincidencias.length === 0) return null
    if (coincidencias.length === 1) return ajustar(coincidencias[0])
    await guardarReferenciaPlaneacion(sb, conversacionId, { planeacionId: null, numero: null, opciones: coincidencias.slice(0, MAXIMO_OPCIONES).map((p) => p.id), intencion: 'modificar', instruccionPendiente: mensaje })
    return { tipo: 'texto', texto: textoOpciones(`Encontré ${coincidencias.length} planeaciones guardadas con ese nombre.`, coincidencias, entrada.voz ?? false, PREGUNTA_ELEGIR_MODIFICAR, entrada.zonaHoraria) }
  }

  if (borrador) return null
  const consultada = await versionConsultada(sb, conversacionId)
  const enContexto = consultada ? (await planeacionesDelGrupo(sb, grupoId)).find((p) => p.id === consultada.planeacion_id) ?? null : null
  if (ultimoDocumento) {
    // La planeación consultada es el referente si el mensaje habla de
    // partes de una planeación, o si la señala con un pronombre
    // ("cámbiale…", "ajústala") justo después de mostrarla. "Cambia mi
    // grupo a cuarto" no la señala.
    const inmediata = [...historial].reverse().find((h) => h.role === 'assistant') === ultimoDocumento
    const hablaDePlaneacion = SUSTANTIVO.test(n) || PARTES_PLANEACION.test(n) || (inmediata && SENALA_DOCUMENTO.test(n))
    return enContexto && contieneContenidoConsultado(ultimoDocumento.content, consultada) && hablaDePlaneacion ? ajustar(enContexto) : null
  }
  if (!SUSTANTIVO.test(n)) return null
  if (enContexto) return ajustar(enContexto)
  return (await planeacionesDelGrupo(sb, grupoId)).length > 0 ? { tipo: 'texto', texto: '¿Qué planeación guardada quieres modificar? Dime su nombre.' } : null
}

// Ajuste pedido editando el texto de una planeación consultada (documento
// activo del cliente): el referente es la planeación de esa versión, del
// docente y grupo activo; el texto del cliente NO se usa como base.
export async function ajusteDesdeConsultada(sb: SupabaseClient, grupoId: string, conversacionId: string | null, planeacionId: string, instruccion: string): Promise<ResolucionAjuste | null> {
  const p = (await planeacionesDelGrupo(sb, grupoId)).find((x) => x.id === planeacionId)
  return p ? ajusteSobre(sb, conversacionId, p, instruccion, instruccion) : null
}

export const MENSAJE_MODIFICAR_NO_DISPONIBLE = 'Por ahora puedo mostrarte tus planeaciones guardadas, pero todavía no modificarlas desde el Chat. Puedo enseñarte otra versión o sus archivos originales.'

// ------------------------------------------------------------------
// Presentación
// ------------------------------------------------------------------
export type ArchivoOriginal = { nombre: string; url: string; urlVer: string }
export type FirmarArchivo = (archivoId: string) => Promise<ArchivoOriginal | null>
// Enlaces de un original del docente (registro de archivos: propio,
// 'activo', en su carpeta). Sin docente, ninguno.
export function firmarOriginalPropio(docenteId: string | null): FirmarArchivo {
  return (archivoId) => (docenteId ? enlacesArchivoPropio(docenteId, archivoId) : Promise.resolve(null))
}

const FORMATO_FECHA: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', timeZone: 'UTC' }
const ZONA_RESPALDO = 'America/Mexico_City'
// Marca de tiempo de la base (timestamptz, o timestamp sin zona guardado en
// UTC) en la hora local del docente: "24 nov 2026, 21:38".
export function fechaHoraLegible(marca: string, zonaHoraria?: string | null): string {
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(marca) ? marca : `${marca.replace(' ', 'T')}Z`
  const opciones: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }
  const formatear = (zona: string) => new Intl.DateTimeFormat('es-MX', { ...opciones, timeZone: zona }).format(new Date(iso)).replace('.', '')
  try { return formatear(zonaHoraria || ZONA_RESPALDO) } catch { return formatear(ZONA_RESPALDO) }
}
export function rangoLegible(p: { fecha_inicio: string | null; fecha_fin: string | null }): string {
  if (!p.fecha_inicio || !p.fecha_fin) return 'sin fechas'
  const f = (s: string) => new Date(`${s}T00:00:00Z`).toLocaleDateString('es-MX', FORMATO_FECHA).replace('.', '')
  const anio = p.fecha_fin.slice(0, 4)
  return `${f(p.fecha_inicio)} – ${f(p.fecha_fin)} ${anio}`
}

function marcador(archivo: Record<string, unknown>): string {
  return `[[DOCUMENTO_ARCHIVO:${Buffer.from(JSON.stringify(archivo), 'utf-8').toString('base64')}]]`
}

// Lista numerada para elegir (nunca se elige arbitrariamente).
export const PREGUNTA_ELEGIR = '¿Cuál quieres ver?'
export const PREGUNTA_ELEGIR_MODIFICAR = '¿Cuál quieres modificar?'
export const MAXIMO_OPCIONES = 8
// El número va en negrita y no como lista de Markdown: el chat no muestra
// los marcadores de lista (sin estilos tipográficos), y el docente debe ver
// qué número responder. Dos con el mismo nombre y periodo se distinguen por
// su fecha y hora real de creación.
export function textoOpciones(encabezado: string, planeaciones: Pick<Planeacion, 'nombre' | 'fecha_inicio' | 'fecha_fin' | 'creado_en'>[], voz: boolean, pregunta: string = PREGUNTA_ELEGIR, zonaHoraria?: string | null): string {
  const visibles = planeaciones.slice(0, MAXIMO_OPCIONES)
  const clave = (p: Pick<Planeacion, 'nombre' | 'fecha_inicio' | 'fecha_fin'>) => `${normalizar(p.nombre ?? '')}|${p.fecha_inicio}|${p.fecha_fin}`
  const repetida = (p: Pick<Planeacion, 'nombre' | 'fecha_inicio' | 'fecha_fin'>) => visibles.filter((q) => clave(q) === clave(p)).length > 1
  const creacion = (p: Pick<Planeacion, 'nombre' | 'fecha_inicio' | 'fecha_fin' | 'creado_en'>) => (repetida(p) && p.creado_en ? ` · creada el ${fechaHoraLegible(p.creado_en, zonaHoraria)}` : '')
  if (voz) return `${encabezado} ${visibles.map((p, i) => `${i + 1}, ${p.nombre}, ${rangoLegible(p)}${creacion(p)}`).join('; ')}. ${pregunta}`
  const lineas = [encabezado, ...visibles.map((p, i) => `**${i + 1}** · ${p.nombre} · ${rangoLegible(p)}${creacion(p)}`)]
  if (planeaciones.length > MAXIMO_OPCIONES) lineas.push(`…y ${planeaciones.length - MAXIMO_OPCIONES} más. Dime un nombre o un periodo para acotar.`)
  lineas.push(`${pregunta} Responde con su número.`)
  return lineas.join('\n')
}

// Una planeación en su versión elegida: el texto canónico tal cual, sus
// archivos originales como tarjetas y una línea discreta de versión. Sin
// texto recuperable (planeación anterior) no se inventa nada.
export async function textoPlaneacion(p: Planeacion, version: VersionPlaneacion, total: number, firmar: FirmarArchivo, voz: boolean, zonaHoraria?: string | null): Promise<string> {
  const tarjetas: string[] = []
  const word = version.documento_word_archivo_id ? await firmar(version.documento_word_archivo_id) : null
  if (word) tarjetas.push(marcador({ tipo: 'word', nombre: word.nombre, url: word.url, archivoId: version.documento_word_archivo_id, tipoDocumento: 'planeacion' }))
  const pdf = version.documento_pdf_archivo_id ? await firmar(version.documento_pdf_archivo_id) : null
  if (pdf) tarjetas.push(marcador({ tipo: 'pdf', nombre: pdf.nombre, url: pdf.url, urlVer: pdf.urlVer, archivoId: version.documento_pdf_archivo_id, tipoDocumento: 'planeacion' }))

  const vigente = version.numero === p.version
  const etiquetaVersion = total > 1 ? `Versión ${version.numero} de ${total}${vigente ? ' (vigente)' : ''}` : `Versión ${version.numero}`
  const pie = `_${etiquetaVersion} · guardada el ${fechaHoraLegible(version.creada_en, zonaHoraria)} · ${rangoLegible(p)}${total > 1 && vigente ? ' · Pídeme «la versión anterior» si la necesitas.' : ''}_`
  const archivos = tarjetas.length > 0 ? `\n${tarjetas.join('\n')}` : ''

  if (!version.contenido) {
    const conArchivo = tarjetas.length > 0 ? ' Te dejo su archivo original.' : ''
    return `«${p.nombre}» (${rangoLegible(p)}) es una planeación anterior y no tengo su texto completo guardado.${conArchivo}${archivos}`
  }
  // Voz: una frase (no se lee la planeación completa en voz alta).
  if (voz) return `Aquí está «${p.nombre}», ${etiquetaVersion.toLowerCase()}, ${rangoLegible(p)}. ${tarjetas.length > 0 ? 'Te dejo sus archivos.' : 'Pídemela por escrito para verla completa.'}${archivos}`
  return `${version.contenido}\n\n${pie}${archivos}`
}
