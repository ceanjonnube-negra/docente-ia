// lib/planeacion/consultaPlaneaciones.ts
//
// Hito 2 — consulta de planeaciones guardadas desde el Chat IA (etapa 2) y
// resolución del referente de un ajuste (etapa 3). Aquí nunca se modifica
// la planeación ni se regeneran archivos.
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
import { GENERAR, MODIFICAR, PARTES_PLANEACION, SENALA_DOCUMENTO, SUSTANTIVO, detectarConsultaPlaneacion, nombreTrasPlaneacion, normalizar, palabras, seleccionEnTexto, versionEnTexto, type RangoFechas, type VersionSolicitada } from './detectarConsultaPlaneacion'
// Detección determinista: vive en un módulo puro, compartido con el cliente.
export { detectarConsultaPlaneacion, nombreTrasPlaneacion, normalizar, rangoDeFechasEnTexto, seleccionEnTexto, type ConsultaPlaneacion, type RangoFechas, type VersionSolicitada } from './detectarConsultaPlaneacion'

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
// modificar (al elegir, se aplica la instrucción pendiente o se pregunta
// qué cambiar). formatoPendiente: archivo pedido junto con el cambio.
// instruccionPendiente: el cambio pedido mientras se aclara a qué planeación
// (o desde qué versión) se aplica. ajustes: identidad de los borradores de
// ajuste (modificarPlaneacion.ts), que se conserva al reescribir la referencia.
export type ReferenciaPlaneacion = { esquema: 'referencia-planeacion-v1'; planeacionId: string | null; numero: number | null; opciones: string[]; intencion?: 'modificar'; instruccionPendiente?: string; formatoPendiente?: 'word' | 'pdf'; ajustes?: unknown[] }

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

// ------------------------------------------------------------------
// Modificar una planeación GUARDADA (Hito 2, etapa 3): referente y ajuste
// ------------------------------------------------------------------
// Resultado de resolver una modificación: un ajuste listo para generarse
// (planeación del docente y grupo activo; se parte de su versión vigente) o
// un texto (aclaración breve). null = no es sobre una planeación guardada.
export type ResolucionAjuste =
  | { tipo: 'texto'; texto: string }
  // formato: archivo pedido junto con el cambio y guardado con la aclaración.
  | { tipo: 'ajuste'; planeacion: Planeacion; instruccion: string; numeroConsultado: number | null; formato?: 'word' | 'pdf' | null }

const AFIRMACION = /^(si|sí|si por favor|claro|de acuerdo|ok|okay|adelante|hazlo|aplicalo|aplicala|esa|esa misma|la vigente)\.?$/

async function planeacionesDelGrupo(sb: SupabaseClient, grupoId: string): Promise<Planeacion[]> {
  const r = await listarPlaneaciones({ supabase: sb }, { grupo_id: grupoId })
  if (!r.ok) throw new Error(r.error.mensaje)
  return r.datos
}

// Versión de una planeación guardada pedida por su nombre (en el grupo de la
// conversación) o, sin nombre, la de la conversación (planeacion_activa):
// la vigente por omisión o la que se pidió. Sin IA. null: no hay referente
// (sigue el camino de siempre).
export async function resolverVersionPedida(sb: SupabaseClient, entrada: { grupoId: string | null; conversacionId: string | null; nombre: string; version: VersionSolicitada | null }): Promise<{ tipo: 'version'; version: VersionPlaneacion; nombre: string } | { tipo: 'texto'; texto: string } | null> {
  const referencia = await leerReferenciaPlaneacion(sb, entrada.conversacionId)
  let planeacion: Planeacion | null = null
  if (palabras(entrada.nombre).length > 0) {
    if (!entrada.grupoId) return { tipo: 'texto', texto: 'Para buscar esa planeación necesito saber de qué grupo es. Ábrela desde Planeación o dime su nombre en una conversación del grupo.' }
    const coincidencias = coincidenciasPorNombre(await planeacionesDelGrupo(sb, entrada.grupoId), entrada.nombre)
    if (coincidencias.length === 0) return { tipo: 'texto', texto: `No encontré una planeación guardada llamada «${entrada.nombre}» en este grupo.` }
    if (coincidencias.length > 1) return { tipo: 'texto', texto: `Encontré varias planeaciones con ese nombre: ${coincidencias.map((p) => `«${p.nombre}»`).join(', ')}. Dime cuál, con su nombre completo.` }
    planeacion = coincidencias[0]
  } else if (referencia?.planeacionId) {
    const { data } = await sb.from('planeaciones').select('*').eq('id', referencia.planeacionId).maybeSingle()
    planeacion = (data as Planeacion | null) ?? null
  }
  if (!planeacion) return null
  const versiones = await versionesDePlaneacion(sb, planeacion.id)
  const mostrada = referencia?.planeacionId === planeacion.id ? referencia.numero : null
  const version = elegirVersion(versiones, planeacion.version, entrada.version, mostrada)
  if (!version) return { tipo: 'texto', texto: `«${planeacion.nombre}» no tiene esa versión guardada.` }
  return { tipo: 'version', version, nombre: planeacion.nombre ?? '' }
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

// Edición (documento activo) cuyo texto es una planeación GUARDADA que el
// servidor confirmó (versión consultada en esta conversación). El contexto
// confirmado manda: es un AJUSTE salvo que sea una consulta, solo pida el
// archivo, pida crear un documento nuevo, cambie de tema o lo rechace —en
// esos casos nunca cae en la edición convencional—. Los verbos son apoyo.
export type DecisionEdicionGuardada = 'ajuste' | 'consulta' | 'archivo' | 'nuevo' | 'negativa' | 'otro_tema'
export function decidirEdicionGuardada(instruccion: string, opciones: { hoy: string; soloArchivo: boolean }): DecisionEdicionGuardada {
  const n = normalizar(instruccion)
  if (opciones.soloArchivo) return 'archivo'
  if (!n) return 'otro_tema'
  if (detectarConsultaPlaneacion(instruccion, opciones.hoy)) return 'consulta'
  if (NEGATIVA.test(n)) return 'negativa'
  if (GENERAR.test(n) && !PARTES_PLANEACION.test(n) && !SENALA_DOCUMENTO.test(n)) return 'nuevo'
  if (pideModificar(instruccion)) return 'ajuste'
  if (NUEVO_TEMA.test(n) || (/\?/.test(instruccion) && !PARTES_PLANEACION.test(n))) return 'otro_tema'
  return 'ajuste'
}

export async function resolverAjustePendiente(entrada: { sb: SupabaseClient; grupoId: string; conversacionId: string | null; mensaje: string; historial: { role: string; content: string }[]; hoy?: string }): Promise<ResolucionAjuste | null> {
  const { sb, grupoId, conversacionId, mensaje } = entrada
  const ultima = [...entrada.historial].reverse().find((h) => h.role === 'assistant')
  if (ultima?.content.startsWith(PREGUNTA_CAMBIO)) {
    if (!esRespuestaDeCambio(mensaje, entrada.hoy ?? new Date().toISOString().slice(0, 10))) return null
    const ref = await leerReferenciaPlaneacion(sb, conversacionId)
    const p = ref?.intencion === 'modificar' && ref.planeacionId ? (await planeacionesDelGrupo(sb, grupoId)).find((x) => x.id === ref.planeacionId) ?? null : null
    const r = p ? await ajusteSobre(sb, conversacionId, p, mensaje, mensaje) : null
    return r?.tipo === 'ajuste' ? { ...r, formato: ref?.formatoPendiente ?? null } : r
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
  return { tipo: 'ajuste', planeacion: elegida, instruccion: ref.instruccionPendiente, numeroConsultado: null, formato: ref.formatoPendiente ?? null }
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

// Una aclaración pendiente de una solicitud compuesta conserva el formato
// pedido ("…y dámela en Word") para aplicarlo al resolverla.
export async function anotarFormatoPendiente(sb: SupabaseClient, conversacionId: string | null, formato: 'word' | 'pdf'): Promise<void> {
  const ref = await leerReferenciaPlaneacion(sb, conversacionId)
  if (ref?.intencion !== 'modificar') return
  const { esquema: _esquema, ajustes: _ajustes, ...resto } = ref
  await guardarReferenciaPlaneacion(sb, conversacionId, { ...resto, formatoPendiente: formato })
}

// Ajuste pedido editando el texto de una planeación consultada (documento
// activo del cliente): el referente es la planeación de esa versión, del
// docente y grupo activo; el texto del cliente NO se usa como base.
export async function ajusteDesdeConsultada(sb: SupabaseClient, grupoId: string, conversacionId: string | null, planeacionId: string, instruccion: string): Promise<ResolucionAjuste | null> {
  const p = (await planeacionesDelGrupo(sb, grupoId)).find((x) => x.id === planeacionId)
  return p ? ajusteSobre(sb, conversacionId, p, instruccion, instruccion) : null
}

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

export function marcador(archivo: Record<string, unknown>): string {
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
