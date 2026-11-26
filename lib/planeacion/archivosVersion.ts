// lib/planeacion/archivosVersion.ts
//
// Hito 2, etapa 4 — Word y PDF de una VERSIÓN de planeación, bajo demanda
// y sin IA. El archivo se genera desde el snapshot canónico de la versión
// (planeacion_versiones.contenido + sus indicadores de la estructura), con
// el generador de siempre (ejecutarHerramientaDocumento), y queda ligado a
// esa versión una sola vez (migración 20261202000000):
//
// - Ya ligado: se recupera el original con enlaces firmados nuevos; nunca
//   se regenera ni se sustituye la referencia (inmutable). Si el archivo
//   realmente ya no existe se dice; un error pasajero se distingue.
// - Sin archivo: reserva atómica por versión + formato (una sola
//   generación entre dispositivos y reintentos), generación, y vinculación
//   que el servidor comprueba (propiedad, grupo, formato, estado,
//   procedencia). Una generación que falla se marca y se puede volver a
//   pedir después, sin aprobar de nuevo.
// - Nunca toca hojas de evaluación ni resultados: si la evaluación ya tiene
//   capturas o resultados con criterios distintos a los de la versión, el
//   documento lo dice en una nota discreta.

import type { SupabaseClient } from '@supabase/supabase-js'
import { ejecutarHerramientaDocumento } from '../documentGen/herramientas'
import { perfilConGrupoAcademico } from '../documentGen/encabezadoDocumento'
import { estadoEnlacesArchivo, marcarArchivoNoEntregado, type EnlacesArchivo } from '../documentGen/registroArchivos'
import { marcador } from './consultaPlaneaciones'

export type FormatoVersion = 'word' | 'pdf'
const ETIQUETA: Record<FormatoVersion, string> = { word: 'Word', pdf: 'PDF' }
const normal = (t: string) => t.trim().replace(/\s+/g, ' ').toLowerCase()

// ------------------------------------------------------------------
// Texto del documento (puro)
// ------------------------------------------------------------------
export const ENCABEZADO_INDICADORES = '📊 INDICADORES DE EVALUACIÓN'

// Encabezado de sección del documento: emoji opcional y texto en mayúsculas
// ("🎓 PRODUCTO FINAL", "INDICADORES DE EVALUACIÓN").
const ENCABEZADO_SECCION = /^\s*(?:[\p{Extended_Pictographic}\u{1F300}-\u{1FAFF}]\uFE0F?\s*)?[A-ZÁÉÍÓÚÑÜ][A-ZÁÉÍÓÚÑÜ0-9 ,;:()\/-]{3,}$/u
// Encabezado de una sección de indicadores, en cualquier capitalización,
// ocupando la línea completa.
const ES_INDICADORES = /^\s*(?:[\p{Extended_Pictographic}\u{1F300}-\u{1FAFF}]\uFE0F?\s*)?(?:\d+[.)]\s*)?indicadores(?:\s+de\s+(?:evaluaci[oó]n|logro|desempe[nñ]o))?\s*:?\s*$/iu

// Snapshot canónico de la versión, con su número (discreto, bajo el título)
// y sus indicadores, que solo viven en la estructura. Si el texto ya trae
// una sección de indicadores, se reemplaza por la de la estructura (en su
// lugar): el documento nunca muestra otros indicadores que los canónicos.
// Si la estructura no tiene indicadores, el texto queda como está.
export function textoDocumentoVersion(datos: { contenido: string; numero: number; indicadores: string[]; notaEvaluacion?: string | null }): string {
  const lineas = datos.contenido.trim().split('\n')
  const cuerpo = [lineas[0], `Versión: ${datos.numero}`, ...lineas.slice(1)]
  if (datos.indicadores.length === 0) return cuerpo.join('\n')
  const seccion = [ENCABEZADO_INDICADORES, ...datos.indicadores.map((x, i) => `${i + 1}. ${x.trim()}`), ...(datos.notaEvaluacion ? ['', datos.notaEvaluacion] : [])]
  // Quita toda sección de indicadores previa (hasta el siguiente encabezado).
  const resultado: string[] = []
  let posicion = -1
  for (let i = 0; i < cuerpo.length; i++) {
    if (i > 0 && ES_INDICADORES.test(cuerpo[i])) {
      if (posicion === -1) posicion = resultado.length
      i++
      while (i < cuerpo.length && !ENCABEZADO_SECCION.test(cuerpo[i])) i++
      i--
      continue
    }
    resultado.push(cuerpo[i])
  }
  if (posicion === -1) return `${resultado.join('\n').trimEnd()}\n\n${seccion.join('\n')}`
  const antes = resultado.slice(0, posicion).join('\n').trimEnd()
  const despues = resultado.slice(posicion).join('\n').trim()
  return `${antes}\n\n${seccion.join('\n')}${despues ? `\n\n${despues}` : ''}`
}

export const notaEvaluacionHistorica = (codigo: string) =>
  `Nota: la evaluación registrada con la hoja ${codigo} conserva sus criterios originales; estos indicadores corresponden a esta versión de la planeación.`

export function sufijoNombreVersion(numero: number): string {
  return `version_${numero}`
}

// ------------------------------------------------------------------
// Datos de la versión (RLS del docente)
// ------------------------------------------------------------------
type VersionCompleta = {
  id: string
  planeacion_id: string
  grupo_id: string
  numero: number
  contenido: string | null
  estructura: { proyecto?: { indicadores?: string[] } } | null
  hoja_id: string | null
  documento_word_archivo_id: string | null
  documento_pdf_archivo_id: string | null
}

async function leerVersion(sb: SupabaseClient, versionId: string): Promise<VersionCompleta | null> {
  const { data } = await sb
    .from('planeacion_versiones')
    .select('id, planeacion_id, grupo_id, numero, contenido, estructura, hoja_id, documento_word_archivo_id, documento_pdf_archivo_id')
    .eq('id', versionId)
    .maybeSingle()
  return (data as VersionCompleta | null) ?? null
}

// Evaluación con capturas o resultados (misma condición que la protección
// de publicar_version_planeacion) cuyos criterios difieren de los de la
// versión: el documento lo aclara. Nunca se modifica nada aquí.
export async function notaSiEvaluacionDistinta(sb: SupabaseClient, version: Pick<VersionCompleta, 'hoja_id' | 'estructura'>): Promise<string | null> {
  if (!version.hoja_id) return null
  const { data: hoja } = await sb.from('hojas_evaluacion').select('identificador_visible, indicadores, proyecto_id').eq('id', version.hoja_id).maybeSingle()
  const h = hoja as { identificador_visible: string; indicadores: { indicador_especifico?: string }[] | null; proyecto_id: string } | null
  if (!h) return null
  const deLaHoja = (h.indicadores ?? []).map((x) => normal(x.indicador_especifico ?? ''))
  const deLaVersion = (version.estructura?.proyecto?.indicadores ?? []).map(normal)
  if (deLaHoja.join('|') === deLaVersion.join('|')) return null
  const { data: proyecto } = await sb.from('proyectos_seguimiento').select('estado, captura_pendiente, confirmado_en').eq('id', h.proyecto_id).maybeSingle()
  const p = proyecto as { estado: string; captura_pendiente: unknown; confirmado_en: string | null } | null
  const { count } = await sb.from('seguimiento_resultados').select('id', { count: 'exact', head: true }).eq('proyecto_id', h.proyecto_id)
  const protegida = !!p && (!['planeado', 'hoja_generada'].includes(p.estado) || p.captura_pendiente != null || p.confirmado_en != null || (count ?? 0) > 0)
  return protegida ? notaEvaluacionHistorica(h.identificador_visible) : null
}

// ------------------------------------------------------------------
// Orquestación
// ------------------------------------------------------------------
export type ArchivoDeVersion = { nombre: string; url: string; urlVer: string; archivoId: string }
export type ResultadoArchivoVersion =
  | { tipo: 'archivo'; formato: FormatoVersion; numero: number; archivo: ArchivoDeVersion; generado: boolean }
  | { tipo: 'en_proceso'; formato: FormatoVersion; numero: number }
  | { tipo: 'inexistente'; formato: FormatoVersion; numero: number }
  | { tipo: 'error'; formato: FormatoVersion; numero: number | null }

export type DependenciasArchivoVersion = {
  // Ejecución confiable (service_role): reservar / vincular / fallar.
  servidor: SupabaseClient
  generar: typeof ejecutarHerramientaDocumento
  enlaces: (docenteId: string, archivoId: string) => Promise<EnlacesArchivo>
  descartar: (archivoId: string, causa: string) => Promise<void>
}
export const dependenciasArchivoVersion = (servidor: SupabaseClient): DependenciasArchivoVersion => ({
  servidor,
  generar: ejecutarHerramientaDocumento,
  enlaces: estadoEnlacesArchivo,
  descartar: marcarArchivoNoEntregado,
})

type Rpc = { resultado: string; archivo_id?: string; ejecucion_id?: string }

export async function obtenerArchivoDeVersion(
  deps: DependenciasArchivoVersion,
  entrada: { sb: SupabaseClient; docenteId: string; versionId: string; formato: FormatoVersion; zonaHoraria: string | null }
): Promise<ResultadoArchivoVersion> {
  const { sb, docenteId, versionId, formato } = entrada
  const version = await leerVersion(sb, versionId)
  if (!version) return { tipo: 'error', formato, numero: null }
  const numero = version.numero
  const original = async (archivoId: string): Promise<ResultadoArchivoVersion> => {
    const e = await deps.enlaces(docenteId, archivoId)
    if (e.estado === 'ok') return { tipo: 'archivo', formato, numero, archivo: { nombre: e.nombre, url: e.url, urlVer: e.urlVer, archivoId }, generado: false }
    return e.estado === 'inexistente' ? { tipo: 'inexistente', formato, numero } : { tipo: 'error', formato, numero }
  }
  const ligado = formato === 'word' ? version.documento_word_archivo_id : version.documento_pdf_archivo_id
  if (ligado) return original(ligado)
  if (!version.contenido?.trim()) return { tipo: 'error', formato, numero }

  const reserva = (await deps.servidor.rpc('reservar_archivo_version', { p_docente_id: docenteId, p_version_id: versionId, p_formato: formato })).data as Rpc | null
  if (reserva?.resultado === 'existente' && reserva.archivo_id) return original(reserva.archivo_id)
  if (reserva?.resultado === 'en_proceso') return { tipo: 'en_proceso', formato, numero }
  if (reserva?.resultado !== 'reservado' || !reserva.ejecucion_id) return { tipo: 'error', formato, numero }
  const ejecucion = reserva.ejecucion_id
  const fallar = (error: string) => deps.servidor.rpc('fallar_archivo_version', { p_docente_id: docenteId, p_version_id: versionId, p_formato: formato, p_ejecucion_id: ejecucion, p_error: error })

  let generado: Awaited<ReturnType<typeof ejecutarHerramientaDocumento>>
  try {
    const [{ data: perfil }, { data: grupo }] = await Promise.all([
      sb.from('perfiles_docentes').select('*').eq('id', docenteId).single(),
      sb.from('grupos').select('grado, grupo').eq('id', version.grupo_id).maybeSingle(),
    ])
    const texto = textoDocumentoVersion({
      contenido: version.contenido,
      numero,
      indicadores: version.estructura?.proyecto?.indicadores ?? [],
      notaEvaluacion: await notaSiEvaluacionDistinta(sb, version),
    })
    // Encabezado con el grupo DE LA PLANEACIÓN (no el grupo activo).
    generado = await deps.generar(formato, texto, perfilConGrupoAcademico(perfil, (grupo as { grado: string | null; grupo: string | null } | null) ?? { grado: null, grupo: null }), entrada.zonaHoraria, sb, docenteId, {
      registro: { clase: 'conservar' },
      sufijoNombre: sufijoNombreVersion(numero),
      // Identidad exacta de esta ejecución: la base la exige al ligar.
      origenVersion: { versionId, formato, ejecucionId: ejecucion },
    })
  } catch (e) {
    await fallar(e instanceof Error ? e.message : String(e))
    console.error(`[ARCHIVO_VERSION] no se pudo generar el ${ETIQUETA[formato]} de la versión ${numero}:`, e)
    return { tipo: 'error', formato, numero }
  }

  const archivoId = generado.archivoId
  if (!archivoId) {
    // Sin registro no hay procedencia que verificar: nunca se liga.
    await fallar('archivo generado sin registro')
    return { tipo: 'error', formato, numero }
  }
  const vinculo = (await deps.servidor.rpc('vincular_archivo_version', { p_docente_id: docenteId, p_version_id: versionId, p_formato: formato, p_ejecucion_id: ejecucion, p_archivo_id: archivoId })).data as Rpc | null
  if (vinculo?.resultado === 'vinculado') {
    console.log(`[ARCHIVO_VERSION] ${ETIQUETA[formato]} de la versión ${numero} generado y ligado — sin IA`)
    return { tipo: 'archivo', formato, numero, archivo: { nombre: generado.nombre, url: generado.url, urlVer: generado.urlVer ?? generado.url, archivoId }, generado: true }
  }
  // Otro intento ganó, esta ejecución venció o el archivo no pasó la
  // verificación: el generado nunca se entrega; se entrega el ligado si existe.
  await deps.descartar(archivoId, `No se ligó a la versión ${numero} (${vinculo?.resultado ?? 'sin respuesta'}).`)
  if (vinculo?.resultado === 'existente' && vinculo.archivo_id) return original(vinculo.archivo_id)
  // 'vencido' ya quedó fallido en la base; 'rechazado' es de otra ejecución.
  if (vinculo?.resultado !== 'rechazado' && vinculo?.resultado !== 'vencido') await fallar(`vinculación: ${vinculo?.resultado ?? 'sin respuesta'}`)
  return vinculo?.resultado === 'rechazado' ? { tipo: 'en_proceso', formato, numero } : { tipo: 'error', formato, numero }
}

// ------------------------------------------------------------------
// Respuesta del chat (tarjeta de siempre: Ver, Descargar, Compartir)
// ------------------------------------------------------------------
export function respuestaArchivoVersion(r: ResultadoArchivoVersion): string {
  const etiqueta = ETIQUETA[r.formato]
  const de = r.numero ? `de la versión ${r.numero}` : 'de esta versión'
  switch (r.tipo) {
    case 'archivo': {
      const datos = r.formato === 'word'
        ? { tipo: 'word', nombre: r.archivo.nombre, url: r.archivo.url, archivoId: r.archivo.archivoId, tipoDocumento: 'planeacion' }
        : { tipo: 'pdf', nombre: r.archivo.nombre, url: r.archivo.url, urlVer: r.archivo.urlVer, archivoId: r.archivo.archivoId, tipoDocumento: 'planeacion' }
      return `${r.generado ? `Aquí está el ${etiqueta} ${de}.` : `Aquí está el ${etiqueta} original ${de}.`}\n${marcador(datos)}`
    }
    case 'en_proceso':
      return `Ya estoy preparando el ${etiqueta} ${de}. Pídemelo de nuevo en unos segundos.`
    case 'inexistente':
      return `El ${etiqueta} original ${de} ya no está disponible entre tus archivos. La versión sigue guardada tal cual; no lo reemplazo automáticamente.`
    default:
      return `No pude preparar el ${etiqueta} ${de} en este momento. La planeación sigue guardada; pídemelo de nuevo en unos segundos.`
  }
}

// Formato pedido junto con un ajuste aprobado: el de la versión publicada
// (o la ya publicada en un reintento). Si falla, la versión ya quedó
// guardada y el archivo se puede pedir después, sin aprobar de nuevo ni IA.
export async function archivoPedidoConAjuste(
  aprobacion: { codigo: string; numero?: number; versionId?: string; formatoSolicitado?: FormatoVersion | null },
  entrada: { servidor: SupabaseClient; sb: SupabaseClient; docenteId: string | null; zonaHoraria: string | null },
  deps: DependenciasArchivoVersion = dependenciasArchivoVersion(entrada.servidor)
): Promise<string> {
  if ((aprobacion.codigo !== 'VERSION_PUBLICADA' && aprobacion.codigo !== 'VERSION_YA_PUBLICADA') || !aprobacion.formatoSolicitado || !aprobacion.versionId || !entrada.docenteId) return ''
  const archivo = await obtenerArchivoDeVersion(deps, { sb: entrada.sb, docenteId: entrada.docenteId, versionId: aprobacion.versionId, formato: aprobacion.formatoSolicitado, zonaHoraria: entrada.zonaHoraria })
  console.log(`[PLANEACION_ARCHIVO] ${aprobacion.formatoSolicitado} pedido con el ajuste (versión ${aprobacion.numero}): ${archivo.tipo} — sin IA`)
  return `\n${respuestaArchivoVersion(archivo)}`
}
