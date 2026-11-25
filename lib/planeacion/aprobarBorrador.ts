// lib/planeacion/aprobarBorrador.ts
//
// Orquestación de la aprobación real de un borrador (C-005, Paso 3C):
// extrae el resumen determinista del borrador vigente (ver seleccionarBorradorVigente)
// (lib/planeacion/extraerBorrador.ts), lo valida estructuralmente
// (lib/planeacion/validarContenidoBorrador.ts), resuelve el contexto
// real del docente desde la sesión autenticada (nunca del texto), y
// guarda en DOS FASES para que una aprobación nunca pueda dejar una
// planeación visible a medio construir (ver "commit en dos fases" más
// abajo). Reutiliza crearPlaneacion/confirmarPlaneacion (Paso 2, sin
// alterar su comportamiento existente). Nunca crea su propio cliente
// de Supabase, nunca usa service_role, nunca ejecuta DELETE.
//
// COMMIT EN DOS FASES (cierre técnico del Paso 3C)
// ---------------------------------------------------------------
// No hay una transacción real disponible sin una función de base de
// datos (fuera de alcance: "no ejecutar migraciones"), así que la
// atomicidad se simula con un CENTINELA sobre una columna que ya
// existe — `version`:
//   1) INSERT en `planeaciones` con version=0 (nunca ocurre por
//      ningún otro camino: crearPlaneacion() y el formulario manual
//      siempre usan version>=1) — la fila existe, pero
//      listarPlaneaciones()/obtenerPlaneacionPorId() la ocultan por
//      completo (filtro `.gt('version', 0)`, ver persistencia.ts).
//   2) INSERT en `planeacion_proyectos`, vinculado a esa planeación.
//   3) Solo si (2) tuvo éxito: confirmarPlaneacion() sube version a 1
//      y fija el estado final — ESE es el único momento en que la
//      planeación se vuelve visible.
// Si (2) o (3) fallan, la fila queda en version=0 — invisible, nunca
// reportada como guardada, y "recuperable": un reintento del MISMO
// borrador (misma huella: docente + grupo + nombre + fechas) reutiliza
// esa fila en vez de crear otra — nunca dos filas para el mismo
// borrador, con o sin fallos de por medio.

import type { SupabaseClient } from '@supabase/supabase-js'
import { mensajeGrupoNoDisponible, type SesionContexto } from '../sesionContexto'
import { periodosEvaluacionDelCiclo } from '../motorContexto'
import { extraerResumenBorrador, seleccionarBorradorVigente, type ResumenBorrador } from './extraerBorrador'
import { esTrazabilidadCanonica, identidadDesdeTrazabilidad, resolverCurricularAprobacion, resolverPeriodoPorFechaInicio, textoDefinitivoConIdentidad, type CurricularAprobado, type TrazabilidadCurricularAprobada } from './curricularAprobacion'
import { validarContenidoBorrador } from './validarContenidoBorrador'
import { crearPlaneacion, type DatosProyectoPlaneacion } from './persistencia'
import { randomUUID } from 'node:crypto'
import { camposDeHistorial } from '../asistente/documentos'
import { crearUrlFirmada, BUCKET_HOJAS_SEGUIMIENTO } from '../documentGen/almacenamiento'
import { nombreArchivoHoja } from '../documentGen/generarHojaSeguimientoPdf'
import { enlacesArchivoPropio, marcarArchivoNoEntregado } from '../documentGen/registroArchivos'
import { ajusteDelBorrador, ETIQUETA_AJUSTE, MENSAJE_AJUSTE_SIN_APROBACION } from './modificarPlaneacion'
import { generarYGuardarHojaSeguimiento } from '../seguimiento/generarYGuardarHoja'
import { CAMPOS_FORMATIVOS, CANTIDAD_INDICADORES_HOJA, type IndicadorProyecto } from '../seguimiento/tipos'
import { ejecutarHerramientaDocumento } from '../documentGen/herramientas'
import { perfilConGrupoAcademico } from '../documentGen/encabezadoDocumento'
import type { Planeacion } from './tipos'

export type CodigoErrorAprobacion =
  | 'SIN_BORRADOR'
  | 'BORRADOR_INCOMPLETO'
  | 'SESION_INVALIDA'
  | 'GRUPO_NO_DISPONIBLE'
  | 'YA_GUARDADA'
  | 'BORRADOR_NO_DETERMINADO'
  | 'ERROR_GUARDADO'
  // Otra solicitud tiene la concesión de esta misma aprobación.
  | 'EN_PROCESO'
  // Borrador de ajuste de una planeación guardada: no se aprueba como nueva.
  | 'AJUSTE_PENDIENTE'
  // El mensaje del borrador aún no está persistido: no hay identidad.
  | 'BORRADOR_NO_PERSISTIDO'

// Un formato definitivo (Word o PDF) de la planeación ya generado y
// subido a Storage — mismo shape que ArchivoGenerado
// (lib/documentGen/almacenamiento.ts), reducido a lo que la tarjeta
// del Chat IA necesita mostrar.
// urlVer (CORRECCIÓN AISLADA — "separar 'Ver PDF' de 'Descargar PDF'"):
// solo presente en el pdf — segunda URL firmada del mismo archivo sin
// `download`, para el botón "Ver PDF". `url` sigue siendo, sin ningún
// cambio, la URL de descarga forzada de siempre.
// archivoId/grupoAcademico (Hito 1, Parte 3): registro real en
// archivos_generados y grado/grupo con que se armó el encabezado — con
// ellos la tarjeta recupera el original (B1) y el historial lo vincula
// (B2). Ausentes en planeaciones anteriores: nunca se inventan.
export type DocumentoPlaneacionGenerado = { nombre: string; url: string; tamanoBytes?: number; urlVer?: string; archivoId?: string; grupoAcademico?: { grado: string; grupo: string } }

export type ResultadoAprobacion =
  // duracionDias viaja solo para el mensaje de confirmación (nunca es
  // una columna real de `planeaciones`) — sale del propio resumen ya
  // extraído, no se recalcula. hoja va siempre que ok:true — la
  // aprobación no se considera completa sin ella (ver "operación
  // lógica única" en el diseño). documentoPlaneacion es MEJOR ESFUERZO
  // (ver Fase 4.5): si Word/PDF no se pudieron generar por cualquier
  // razón transitoria, la aprobación de todos modos se considera
  // completa (la planeación y la hoja ya quedaron guardadas) — el
  // docente siempre puede pedir el archivo después escribiendo en el
  // chat, igual que antes de que existiera esta mejora.
  // contenidoDefinitivo: texto con el que se generaron Word y PDF (el del
  // registro del historial).
  | { ok: true; planeacion: Planeacion; duracionDias: number | null; hoja: HojaAprobacion | null; documentoPlaneacion: { word: DocumentoPlaneacionGenerado | null; pdf: DocumentoPlaneacionGenerado | null; contenidoDefinitivo: string } | null }
  | { ok: false; codigo: CodigoErrorAprobacion; mensaje: string }

// Hoja de evaluación de la versión entregada. reemplazada: una versión
// posterior la sustituyó; se entrega para consulta, SIN el proyecto
// (proyectoSeguimientoId null), para que no se capture sobre ella.
export type HojaAprobacion = { identificadorVisible: string; url: string; urlVer: string; proyectoSeguimientoId: string | null; reemplazada?: true }

type TurnoHistorial = { role: string; content: string }

async function esBorradorDeAjuste(sb: SupabaseClient, conversacionId: string | null, contenido: string): Promise<boolean> {
  if (new RegExp(`^${ETIQUETA_AJUSTE}:`, 'mi').test(contenido)) return true
  if (!conversacionId) return false
  const { data } = await sb.from('conversaciones_chat').select('planeacion_activa').eq('id', conversacionId).maybeSingle()
  return ajusteDelBorrador(contenido, (data as { planeacion_activa?: unknown } | null)?.planeacion_activa ?? null) !== null
}

// Estado final visible tras una aprobación completa y exitosa. Único
// valor real del esquema (EstadoPlaneacion) distinto de 'borrador'
// (que el formulario manual usa como su propio estado normal de
// trabajo-en-progreso — reutilizarlo aquí sería ambiguo con eso) y de
// 'archivada' (no aplica a algo recién creado). 'publicada' señala
// con claridad que pasó por una aprobación deliberada del docente.
const ESTADO_FINAL_TRAS_APROBAR = 'publicada'
const MENSAJE_ERROR_GENERICO = 'No fue posible guardar la planeación en este momento. Intenta de nuevo en unos segundos.'

// Contenidos y PDA que se guardan: los de la identidad validada al aprobar
// (catálogo, locales, del docente y propuestas, sin etiquetas ni
// "ninguno"); sin identidad, los del resumen tal cual.
function listasCurriculares(resumen: ResumenBorrador, curricular: CurricularAprobado): { contenidos: string[]; pda: string[] } {
  const i = curricular.identidad
  if (!i) return { contenidos: resumen.contenidos, pda: resumen.pda }
  const deTipo = (tipo: 'contenido' | 'pda') => [...i.delDocente, ...i.propuestas].filter((r) => r.tipo === tipo).map((r) => r.texto)
  return { contenidos: [...i.contenidos, ...i.contenidosLocales, ...deTipo('contenido')], pda: [...i.pda, ...deTipo('pda')] }
}

export function construirProyecto(resumen: ResumenBorrador, planeacionId: string, curricular: CurricularAprobado): DatosProyectoPlaneacion & { planeacion_id: string } {
  const { contenidos, pda } = listasCurriculares(resumen, curricular)
  return {
    planeacion_id: planeacionId,
    nombre: resumen.nombre,
    campos_formativos: resumen.camposFormativos,
    contenidos,
    pda,
    ejes_articuladores: resumen.ejesArticuladores,
    metodologia: resumen.metodologia,
    duracion_dias: resumen.duracionDias,
    // Mapeo real de la secuencia didáctica (resumen día por día, ver
    // extraerBorrador.ts) — no la estructura completa de
    // inicio/desarrollo/cierre (que solo existe como texto libre en
    // el cuerpo del borrador, y no se duplica aquí a propósito).
    actividades: resumen.secuenciaDidactica,
    recursos: resumen.recursos,
    evaluacion: {
      // Se completa después de generar la hoja real de Seguimiento
      // (ver más abajo) con proyecto_seguimiento_id/hoja_id/url — el
      // vínculo real entre planeacion_proyectos y proyectos_seguimiento
      // vive aquí, en esta columna jsonb, porque proyectos_seguimiento
      // no tiene columna planeacion_id (es anterior a C-005) y no se
      // agrega ninguna.
      indicadores: resumen.indicadores,
      producto_final: resumen.productoFinal,
      evidencias: resumen.evidencias,
      fuente: 'chat_ia',
      // En el MISMO insert que contenidos y pda: cualquier reintento
      // encuentra la identidad curricular ya consolidada y coherente.
      trazabilidad_curricular: curricular.trazabilidad,
    },
    orden: 1,
  }
}

// Campos formativos válidos únicamente (mismo criterio que ya usa
// POST /api/proyectos-seguimiento) — nunca se inserta uno fuera del
// enum real por confiar ciegamente en lo que Claude escribió.
// planeacion_versiones.estructura: los campos estructurados de una versión,
// con los mismos nombres que la proyección (planeaciones +
// planeacion_proyectos) que publicar_version_planeacion actualiza.
export function estructuraDeVersion(resumen: ResumenBorrador, campoFormativo: string, proyecto: ReturnType<typeof construirProyecto>) {
  const evaluacion = proyecto.evaluacion as { indicadores?: unknown; producto_final?: unknown; evidencias?: unknown }
  return {
    planeacion: { nombre: resumen.nombre, proposito: resumen.proposito, fecha_inicio: resumen.fechaInicio, fecha_fin: resumen.fechaFin, campo_formativo: campoFormativo },
    proyecto: {
      nombre: proyecto.nombre,
      campos_formativos: proyecto.campos_formativos,
      contenidos: proyecto.contenidos,
      pda: proyecto.pda,
      ejes_articuladores: proyecto.ejes_articuladores,
      metodologia: proyecto.metodologia,
      duracion_dias: proyecto.duracion_dias,
      actividades: proyecto.actividades,
      recursos: proyecto.recursos,
      indicadores: evaluacion.indicadores ?? null,
      producto_final: evaluacion.producto_final ?? null,
      evidencias: evaluacion.evidencias ?? null,
    },
  }
}

export const CAMPOS_FORMATIVOS_VALIDOS = new Set<string>(CAMPOS_FORMATIVOS)

export function construirIndicadoresSeguimiento(resumen: ResumenBorrador): IndicadorProyecto[] {
  // Los indicadores del borrador son texto libre, sin aspecto general
  // clasificado — 'logro_aprendizaje' es el valor por defecto más
  // aplicable de los 5 reales (ver lib/seguimiento/tipos.ts), nunca un
  // valor inventado fuera del enum.
  //
  // Tope defensivo a CANTIDAD_INDICADORES_HOJA (5): las instrucciones
  // del asistente (lib/asistente/instruccionesPlaneacionGenerar.ts) ya
  // le piden a Claude exactamente 5, pero la hoja (una columna por
  // indicador) nunca debe recibir más de 5 aunque el texto libre traiga
  // otra cantidad. Nunca se rellena con indicadores inventados si
  // llegaran menos de 5 — se usan los que realmente hay.
  return resumen.indicadores
    .slice(0, CANTIDAD_INDICADORES_HOJA)
    .map((texto) => ({ indicador_especifico: texto, aspecto_general: 'logro_aprendizaje' }))
}

// ------------------------------------------------------------------
// IDENTIDAD E IDEMPOTENCIA DE LA APROBACIÓN (migración
// 20261125000000_identidad_aprobacion_planeacion.sql)
//
// Una planeación nace de UN borrador, identificado por el id PERSISTIDO de
// su mensaje: planeaciones.borrador_clave = "msg:<mensajes_chat.id>",
// única por docente. El id se lee con la sesión del docente (RLS) y debe
// pertenecer a SU conversación validada. El cliente confirma la
// persistencia de la conversación antes de enviar una aprobación
// (AsistenteService); si aun así el mensaje no está guardado, no se
// aprueba todavía — nunca se usa el texto como identidad, porque no
// distinguiría dos borradores idénticos. Nombre y fechas no identifican.
//
// Concesión (lease): la aprobación en curso se adquiere con una
// actualización condicional atómica (token propio; libre, o vencida si el
// proceso anterior se interrumpió) y se RENUEVA antes de cada escritura;
// una ejecución que la perdió no escribe, no confirma, y marca como
// 'fallido' (nunca entregado) el archivo que hubiera generado. Cada fase es
// idempotente por relación única y la confirmación exige el token propio.
// Una aprobación ya terminada se recupera tal cual (tarjetas y Historial),
// sin regenerar nada.
// ------------------------------------------------------------------
const DURACION_CONCESION_MS = 2 * 60 * 1000
const MENSAJE_EN_PROCESO = 'Ya estoy guardando esta planeación. En unos segundos aparecerá en Planeación; si no, vuelve a pedírmelo.'
const MENSAJE_YA_GUARDADA = 'Esta planeación ya está guardada. La encuentras en Planeación, Evaluación e Historial.'
export const MENSAJE_NO_PERSISTIDO = 'Todavía estoy guardando esta conversación. Vuelve a pedirme que la apruebe en unos segundos.'
const COLUMNAS_PLANEACION_APROBADA = 'id, docente_id, grupo_id, ciclo_escolar_id, periodo_evaluacion_id, nombre, proposito, fecha_inicio, fecha_fin, estado, version, creado_en, actualizado_en'

// Identidad del borrador vigente: el id persistido de su mensaje en ESTA
// conversación (el más reciente con ese texto exacto). null si no hay
// conversación o el mensaje aún no está guardado.
export async function resolverIdentidadBorrador(sb: SupabaseClient, conversacionId: string | null, contenido: string): Promise<string | null> {
  if (!conversacionId) return null
  try {
    const { data } = await sb
      .from('mensajes_chat')
      .select('id')
      .eq('conversacion_id', conversacionId)
      .eq('rol', 'asistente')
      .eq('texto', contenido)
      .order('creado_en', { ascending: false })
      .limit(1)
    const id = (data?.[0] as { id?: unknown } | undefined)?.id
    // El id persistido es "<conversación>:<mensaje>": se exige que sea de ESTA conversación.
    return typeof id === 'string' && id.startsWith(`${conversacionId}:`) && id.length <= 290 ? `msg:${id}` : null
  } catch {
    return null
  }
}

type FilaIdentidad = { id: string; version: number }

async function buscarPorIdentidad(sb: SupabaseClient, docenteId: string, clave: string): Promise<FilaIdentidad | null> {
  const { data } = await sb.from('planeaciones').select('id, version').eq('docente_id', docenteId).eq('borrador_clave', clave).maybeSingle()
  return (data as FilaIdentidad | null) ?? null
}

type DocumentoGuardado = { nombre: string; url: string; tamano_bytes?: number; url_ver?: string; archivo_id?: string; grupo_academico?: { grado: string; grupo: string } }

// Registro CANÓNICO de la planeación aprobada en Historial (B2), escrito
// por el servidor: no depende de que el cliente reciba la respuesta. Uno
// por archivo original (índice único documentos_generados_archivo_unico):
// un reintento o el registro del cliente chocan y no duplican.
function filaHistorial(contenido: string, word: DocumentoGuardado | null): Record<string, unknown> | null {
  if (!contenido || !word?.archivo_id) return null // sin original registrado no hay registro que vincular
  const campos = camposDeHistorial(contenido)
  return {
    tipo: campos.tipo,
    titulo: campos.titulo,
    contenido,
    campo_formativo: campos.campoFormativo,
    grado: word.grupo_academico?.grado || null,
    grupo: word.grupo_academico?.grupo || null,
    origen: 'archivo',
    archivo_id: word.archivo_id,
    archivo_formato: 'word',
  }
}

// Aprobación ya terminada (reintento cuya respuesta anterior se perdió, o
// confirmación ya visible en el historial): se entregan las tarjetas de la
// VERSIÓN EXACTA que creó ese borrador — planeacion_versiones por su
// identidad (borrador_clave), nunca la proyección vigente: si después se
// publicó otra versión, repetir la aprobación original devuelve la suya
// (texto, Word, PDF, nombre y fechas), jamás los archivos de la vigente.
// Sin regenerar archivos ni hoja, sin IA y SIN escribir: su registro en
// Historial ya se consolidó antes de confirmar. La hoja de evaluación es
// del proyecto (la misma para todas sus versiones).
// Tarjeta de una hoja de evaluación concreta (la de una versión). Si ya
// fue reemplazada se entrega solo para consulta: sin proyecto, sin captura.
// null si la hoja no existe o su PDF aún no está generado.
export type FilaHojaEntregable = { identificador_visible: string; storage_path: string | null; proyecto_id: string; reemplazada_por: string | null }
export async function leerHoja(sb: SupabaseClient, hojaId: string): Promise<FilaHojaEntregable | null> {
  const { data } = await sb.from('hojas_evaluacion').select('identificador_visible, storage_path, proyecto_id, reemplazada_por').eq('id', hojaId).maybeSingle()
  return (data as FilaHojaEntregable | null) ?? null
}
export async function hojaEntregable(sb: SupabaseClient, hojaId: string, fila?: FilaHojaEntregable | null): Promise<HojaAprobacion | null> {
  const filaHoja = fila === undefined ? await leerHoja(sb, hojaId) : fila
  if (!filaHoja?.storage_path) return null
  const url = await crearUrlFirmada(sb, filaHoja.storage_path, nombreArchivoHoja(filaHoja.identificador_visible), BUCKET_HOJAS_SEGUIMIENTO)
  const urlVer = await crearUrlFirmada(sb, filaHoja.storage_path, undefined, BUCKET_HOJAS_SEGUIMIENTO)
  return filaHoja.reemplazada_por
    ? { identificadorVisible: filaHoja.identificador_visible, url, urlVer, proyectoSeguimientoId: null, reemplazada: true }
    : { identificadorVisible: filaHoja.identificador_visible, url, urlVer, proyectoSeguimientoId: filaHoja.proyecto_id }
}

type VersionAprobada = {
  numero: number
  contenido: string | null
  estructura: { planeacion?: { nombre?: string | null; proposito?: string | null; fecha_inicio?: string | null; fecha_fin?: string | null }; proyecto?: { duracion_dias?: number | null } | null } | null
  documento_word_archivo_id: string | null
  documento_pdf_archivo_id: string | null
  hoja_id: string | null
}
async function recuperarAprobacionTerminada(sb: SupabaseClient, docenteId: string, grupoId: string, planeacionId: string, clave: string, duracionDias: number | null): Promise<ResultadoAprobacion> {
  const yaGuardada: ResultadoAprobacion = { ok: false, codigo: 'YA_GUARDADA', mensaje: MENSAJE_YA_GUARDADA }
  // Del docente Y del grupo activo: de otro grupo no se entrega nada.
  const { data: planeacion } = await sb.from('planeaciones').select(COLUMNAS_PLANEACION_APROBADA).eq('id', planeacionId).eq('docente_id', docenteId).eq('grupo_id', grupoId).maybeSingle()
  if (!planeacion || (planeacion as Planeacion).version < 1) return yaGuardada
  const { data: filaVersion } = await sb
    .from('planeacion_versiones')
    .select('numero, contenido, estructura, documento_word_archivo_id, documento_pdf_archivo_id, hoja_id')
    .eq('planeacion_id', planeacionId)
    .eq('docente_id', docenteId)
    .eq('borrador_clave', clave)
    .maybeSingle()
  const version = filaVersion as VersionAprobada | null
  if (!version) return yaGuardada // sin versión de ese borrador (planeación anterior): nada que asociar
  const { data: proyecto } = await sb.from('planeacion_proyectos').select('evaluacion').eq('planeacion_id', planeacionId).maybeSingle()
  const ev = ((proyecto as { evaluacion?: Record<string, unknown> } | null)?.evaluacion ?? {}) as { hoja_id?: string; proyecto_seguimiento_id?: string; documento_word?: DocumentoGuardado; documento_pdf?: DocumentoGuardado }
  // Hoja de ESA versión (planeacion_versiones.hoja_id). Una versión sin
  // hoja registrada solo usa la del proyecto si es la vigente (mismo
  // vínculo explícito); nunca se asocia otra.
  const hojaId = version.hoja_id ?? (version.numero === (planeacion as Planeacion).version ? ev.hoja_id ?? null : null)
  const hojaEntregada = hojaId ? await hojaEntregable(sb, hojaId) : null
  // Archivos ORIGINALES de esa versión (registro propio y activo). El grupo
  // del encabezado solo se toma de la proyección si es ese mismo archivo.
  const word = version.documento_word_archivo_id ? await enlacesArchivoPropio(docenteId, version.documento_word_archivo_id) : null
  const pdf = version.documento_pdf_archivo_id ? await enlacesArchivoPropio(docenteId, version.documento_pdf_archivo_id) : null
  const grupoDe = (guardado: DocumentoGuardado | undefined, id: string | null) => (guardado?.archivo_id && guardado.archivo_id === id ? guardado.grupo_academico : undefined)
  const est = version.estructura?.planeacion ?? {}
  return {
    ok: true,
    // Nombre, propósito y fechas de ESA versión; identidad de la planeación.
    planeacion: {
      ...(planeacion as Planeacion),
      nombre: est.nombre ?? (planeacion as Planeacion).nombre,
      proposito: est.proposito !== undefined ? est.proposito : (planeacion as Planeacion).proposito,
      fecha_inicio: est.fecha_inicio ?? (planeacion as Planeacion).fecha_inicio,
      fecha_fin: est.fecha_fin ?? (planeacion as Planeacion).fecha_fin,
      version: version.numero,
    },
    duracionDias: version.estructura?.proyecto?.duracion_dias ?? duracionDias,
    hoja: hojaEntregada,
    // Cada original por separado: si solo uno está disponible, se entrega ese.
    documentoPlaneacion: word || pdf
      ? {
          word: word ? { nombre: word.nombre, url: word.url, archivoId: version.documento_word_archivo_id!, grupoAcademico: grupoDe(ev.documento_word, version.documento_word_archivo_id) } : null,
          pdf: pdf ? { nombre: pdf.nombre, url: pdf.url, urlVer: pdf.urlVer, archivoId: version.documento_pdf_archivo_id!, grupoAcademico: grupoDe(ev.documento_pdf, version.documento_pdf_archivo_id) } : null,
          contenidoDefinitivo: version.contenido ?? '',
        }
      : null,
  }
}

// El historial ya muestra la confirmación de este borrador. El texto no
// basta: se comprueba el estado persistido por la identidad del borrador
// y, si está confirmada, se entregan sus tarjetas originales (misma
// recuperación que un reintento). Sin identidad (planeaciones anteriores)
// no se busca nada más ni se escribe: el mensaje de siempre.
async function recuperarBorradorConfirmado(sb: SupabaseClient, docenteId: string, grupoId: string, conversacionId: string | null, contenido: string | null): Promise<ResultadoAprobacion> {
  const yaGuardada: ResultadoAprobacion = { ok: false, codigo: 'YA_GUARDADA', mensaje: MENSAJE_YA_GUARDADA }
  const clave = contenido ? await resolverIdentidadBorrador(sb, conversacionId, contenido) : null
  const fila = clave ? await buscarPorIdentidad(sb, docenteId, clave) : null
  if (!fila || !contenido) return yaGuardada
  if (fila.version < 1) return { ok: false, codigo: 'EN_PROCESO', mensaje: MENSAJE_EN_PROCESO }
  return recuperarAprobacionTerminada(sb, docenteId, grupoId, fila.id, clave!, extraerResumenBorrador([{ role: 'assistant', content: contenido }])?.duracionDias ?? null)
}

type FilaProyectoSeguimiento = { id: string; hoja_id: string | null; periodo_evaluacion_id: string | null }

async function buscarProyectoSeguimientoDePlaneacion(sb: SupabaseClient, proyectoPlaneacionId: string): Promise<FilaProyectoSeguimiento | null> {
  const { data } = await sb.from('proyectos_seguimiento').select('id, hoja_id, periodo_evaluacion_id').eq('planeacion_proyecto_id', proyectoPlaneacionId).maybeSingle()
  return (data as FilaProyectoSeguimiento | null) ?? null
}

export async function aprobarBorradorPlaneacion(
  sb: SupabaseClient,
  sesion: SesionContexto,
  historial: TurnoHistorial[],
  // Texto que escribió el docente en este turno — solo para detectar
  // si nombra un borrador distinto del vigente (ver seleccionarBorradorVigente).
  mensajeDocente = '',
  // Conversación del docente ya validada (RLS) — para la identidad del
  // borrador. null sin conversación remota.
  conversacionId: string | null = null
): Promise<ResultadoAprobacion> {
  if (!sesion.grupo_activo_id) {
    return { ok: false, codigo: 'GRUPO_NO_DISPONIBLE', mensaje: mensajeGrupoNoDisponible(sesion) ?? 'No tengo un grupo activo configurado para guardar la planeación.' }
  }

  // El borrador vigente de ESTA conversación, aunque después haya habido
  // un error de guardado o una aclaración (ver seleccionarBorradorVigente).
  const seleccion = seleccionarBorradorVigente(historial, mensajeDocente)
  if (seleccion.estado === 'incompleto') {
    return { ok: false, codigo: 'BORRADOR_INCOMPLETO', mensaje: 'El borrador que tengo no está completo (le falta el nombre o las fechas) — pídeme que lo genere de nuevo antes de guardarlo.' }
  }
  if (seleccion.estado === 'ya_aprobado') {
    return recuperarBorradorConfirmado(sb, sesion.docente_id, sesion.grupo_activo_id, conversacionId, seleccion.contenido)
  }
  if (seleccion.estado === 'otro_documento') {
    return { ok: false, codigo: 'BORRADOR_NO_DETERMINADO', mensaje: 'Después de la planeación trabajamos en otro documento, así que no puedo saber con certeza cuál guardar. Pídeme que vuelva a mostrar la planeación y luego apruébala.' }
  }
  if (seleccion.estado === 'no_reciente') {
    return { ok: false, codigo: 'BORRADOR_NO_DETERMINADO', mensaje: 'El último borrador de planeación quedó varios mensajes atrás y la conversación siguió con otros temas. Pídeme que lo vuelva a mostrar y luego apruébala.' }
  }
  if (seleccion.estado === 'referencia_no_vigente') {
    return { ok: false, codigo: 'BORRADOR_NO_DETERMINADO', mensaje: `La planeación más reciente de esta conversación es «${seleccion.nombreVigente}». Si quieres guardar otra, pídeme que la presente de nuevo y luego apruébala.` }
  }
  if (seleccion.estado === 'sin_borrador') {
    return { ok: false, codigo: 'SIN_BORRADOR', mensaje: 'No encontré un borrador de planeación listo para guardar en esta conversación. ¿Quieres que prepare uno?' }
  }
  // Un borrador de AJUSTE de una planeación guardada (Hito 2, etapa 3a)
  // nunca se guarda como planeación nueva: se reconoce por la metadata del
  // servidor (huella registrada en la conversación) o por su línea de
  // resumen. Su publicación como versión N+1 es la etapa 3b.
  if (await esBorradorDeAjuste(sb, conversacionId, seleccion.contenido)) {
    return { ok: false, codigo: 'AJUSTE_PENDIENTE', mensaje: MENSAJE_AJUSTE_SIN_APROBACION }
  }
  const resumen = seleccion.resumen

  // Validación estructural determinista — nunca se persiste un
  // borrador incompleto, sin importar que el bloque de resumen se
  // haya podido extraer.
  const validacion = validarContenidoBorrador(resumen)
  if (!validacion.ok) {
    console.log(`[PLANEACION_GENERAR][aprobar] contenido incompleto: ${validacion.elementosFaltantes.join(', ')}`)
    return { ok: false, codigo: 'BORRADOR_INCOMPLETO', mensaje: validacion.mensaje }
  }

  // Concesión propia de esta solicitud (para liberarla ante un fallo).
  let concesionPropia: string | null = null
  let liberarAlFallar: (() => Promise<ResultadoAprobacion>) | null = null
  try {
    // Identidad curricular del borrador aprobado, revalidada contra el
    // catálogo del grupo recargado (RLS) — ver curricularAprobacion.ts.
    // Sin IA; si falla, nada se marca como verificado y se sigue.
    const textosDocente = [...historial.filter((h) => h.role === 'user').map((h) => h.content), mensajeDocente]
    const curricular = await resolverCurricularAprobacion(sb, sesion.grupo_activo_id, seleccion.contenido, resumen, textosDocente)

    // Periodo de evaluación: el único del ciclo del grupo que contiene la
    // fecha de inicio de la planeación. Sin periodos o con ambigüedad,
    // ninguno (nunca uno arbitrario) y la aprobación sigue.
    const cicloDelGrupo = curricular.cicloEscolarGrupo ?? sesion.ciclo_escolar_id
    const periodos = cicloDelGrupo ? await periodosEvaluacionDelCiclo(sb, cicloDelGrupo) : []
    const periodoActual = resolverPeriodoPorFechaInicio(periodos, resumen.fechaInicio)

    // Identidad del BORRADOR (no nombre ni fechas): ya guardada de verdad
    // (version>=1), intento anterior sin terminar (version=0, se reanuda
    // con la concesión) o nueva.
    const clave = await resolverIdentidadBorrador(sb, conversacionId, seleccion.contenido)
    if (!clave) return { ok: false, codigo: 'BORRADOR_NO_PERSISTIDO', mensaje: MENSAJE_NO_PERSISTIDO }
    const recuperar = (id: string) => recuperarAprobacionTerminada(sb, sesion.docente_id, sesion.grupo_activo_id!, id, clave, resumen.duracionDias)
    const existente = await buscarPorIdentidad(sb, sesion.docente_id, clave)
    if (existente && existente.version >= 1) return recuperar(existente.id)
    const token = randomUUID()
    const vencimiento = () => new Date(Date.now() + DURACION_CONCESION_MS).toISOString()
    // Adquiere (o renueva) la concesión: solo si está libre, vencida o es
    // propia, y la planeación sigue sin confirmar. Atómico en la base.
    const adquirirConcesion = async (id: string): Promise<'propia' | 'ocupada' | 'error'> => {
      const { data, error } = await sb
        .from('planeaciones')
        .update({ aprobacion_token: token, aprobacion_expira_en: vencimiento() })
        .eq('id', id)
        .eq('version', 0)
        .or(`aprobacion_token.is.null,aprobacion_token.eq.${token},aprobacion_expira_en.lt.${new Date().toISOString()}`)
        .select('id')
      if (error) return 'error'
      return (data ?? []).length === 1 ? 'propia' : 'ocupada'
    }
    // Un fallo controlado libera la concesión propia: el reintento
    // inmediato no espera a que venza.
    const fallar = async (): Promise<ResultadoAprobacion> => {
      if (concesionPropia) await sb.from('planeaciones').update({ aprobacion_token: null, aprobacion_expira_en: null }).eq('id', concesionPropia).eq('aprobacion_token', token)
      return { ok: false, codigo: 'ERROR_GUARDADO', mensaje: MENSAJE_ERROR_GENERICO }
    }
    liberarAlFallar = fallar
    const conConcesion = async (id: string): Promise<ResultadoAprobacion | null> => {
      const estado = await adquirirConcesion(id)
      if (estado === 'error') return fallar()
      if (estado === 'ocupada') return sinConcesion(id)
      concesionPropia = id
      return null
    }
    // Consolida resultados SOLO con la concesión propia, en una transacción
    // (consolidar_aprobacion_planeacion): comprobar el token, renovarlo y
    // escribir son atómicos. 'perdida' = otra ejecución la tiene; no se
    // escribió nada.
    const consolidar = async (id: string, evaluacion: Record<string, unknown>, historial: Record<string, unknown> | null): Promise<'ok' | 'perdida' | 'error'> => {
      const { data, error } = await sb.rpc('consolidar_aprobacion_planeacion', { p_planeacion_id: id, p_token: token, p_evaluacion: evaluacion, p_historial: historial })
      if (error) {
        console.error('[PLANEACION_GENERAR][aprobar] fallo consolidando la aprobación:', error)
        return 'error'
      }
      return data === true ? 'ok' : 'perdida'
    }
    const sinConcesion = async (id: string): Promise<ResultadoAprobacion> => {
      const { data } = await sb.from('planeaciones').select('version').eq('id', id).maybeSingle()
      return ((data as { version?: number } | null)?.version ?? 0) >= 1
        ? recuperar(id)
        : { ok: false, codigo: 'EN_PROCESO', mensaje: MENSAJE_EN_PROCESO }
    }

    // PLN-1E-F-FIX — planeaciones.campo_formativo es NOT NULL sin
    // default (ver informe forense PLN-1E-F, última brecha NOT NULL de
    // esta tabla, expuesta apenas al corregirse institucion_id en
    // 2a82f41). Se deriva EXCLUSIVAMENTE de resumen.camposFormativos
    // (a su vez, con V4 válido, viene de resumenDesdeSnapshotV4 —
    // nunca del cliente ni de una consulta nueva), reutilizando el
    // MISMO CAMPOS_FORMATIVOS_VALIDOS ya usado más abajo para
    // proyectos_seguimiento — el primer valor que de verdad pertenezca
    // al enum real, nunca simplemente camposFormativos[0] (que podría
    // ser texto libre inventado por Claude). Fail-closed: si ninguno
    // es válido, la aprobación se detiene aquí con un resultado
    // explícito — nunca se inventa un campo formativo ni se llama IA
    // para resolverlo.
    const campoFormativoValidado = resumen.camposFormativos.find((c) => CAMPOS_FORMATIVOS_VALIDOS.has(c)) ?? null
    if (!campoFormativoValidado) {
      return { ok: false, codigo: 'BORRADOR_INCOMPLETO', mensaje: 'El borrador no tiene un campo formativo reconocido — pídeme que lo genere de nuevo antes de guardarlo.' }
    }

    // Fase 1: planeación temporal (version=0, invisible) con su identidad
    // y la concesión — se crea o se recupera, nunca se duplica.
    let planeacionId: string
    if (existente) {
      planeacionId = existente.id
      const sinPermiso = await conConcesion(planeacionId)
      if (sinPermiso) return sinPermiso
    } else {
      const creado = await crearPlaneacion(
        { supabase: sb },
        {
          docente_id: sesion.docente_id,
          grupo_id: sesion.grupo_activo_id,
          campo_formativo: campoFormativoValidado,
          periodo_evaluacion_id: periodoActual?.id ?? null,
          nombre: resumen.nombre,
          proposito: resumen.proposito,
          fecha_inicio: resumen.fechaInicio,
          fecha_fin: resumen.fechaFin,
          estado: 'borrador', // estado técnico temporal — fase 1 del commit en dos fases
          version: 0, // centinela: invisible hasta la confirmación final
          identidadAprobacion: { borrador_clave: clave, aprobacion_token: token, aprobacion_expira_en: vencimiento() },
        }
      )
      if (!creado.ok && creado.error.codigo === 'DUPLICADO') {
        // Otra solicitud del MISMO borrador la creó al mismo tiempo.
        const otra = await buscarPorIdentidad(sb, sesion.docente_id, clave)
        if (!otra) return fallar()
        if (otra.version >= 1) return recuperar(otra.id)
        const sinPermiso = await conConcesion(otra.id)
        if (sinPermiso) return sinPermiso
        planeacionId = otra.id
      } else if (!creado.ok) {
        console.error('[PLANEACION_GENERAR][aprobar] fallo creando la fila temporal:', creado.error)
        return fallar()
      } else {
        planeacionId = creado.datos.id
        concesionPropia = planeacionId
      }
    }

    // Fase 2: planeacion_proyectos — se crea solo si no existe ya
    // (recuperación). Se trae también `evaluacion` (no solo `id`) para
    // que la Fase 4.5 pueda saber si un intento anterior YA generó el
    // Word/PDF definitivos, y así nunca regenerarlos ni duplicarlos.
    const { data: proyectoPlaneacionExistente, error: errorBusquedaProyecto } = await sb
      .from('planeacion_proyectos')
      .select('id, evaluacion, contenidos, pda')
      .eq('planeacion_id', planeacionId)
      .maybeSingle()
    if (errorBusquedaProyecto) {
      console.error('[PLANEACION_GENERAR][aprobar] fallo verificando el proyecto existente:', errorBusquedaProyecto)
      return fallar()
    }
    let proyectoPlaneacionId: string
    if (proyectoPlaneacionExistente) {
      proyectoPlaneacionId = (proyectoPlaneacionExistente as { id: string }).id
    } else {
      const { data: proyectoCreado, error: errorProyecto } = await sb.from('planeacion_proyectos').insert(construirProyecto(resumen, planeacionId, curricular)).select('id').single()
      if ((errorProyecto as { code?: string } | null)?.code === '23505') {
        // Único por (planeación, orden): otra solicitud lo creó; la
        // concesión la tiene otra, así que esta no sigue.
        return sinConcesion(planeacionId)
      }
      if (errorProyecto || !proyectoCreado) {
        console.error('[PLANEACION_GENERAR][aprobar] fallo creando la relación:', errorProyecto)
        return fallar()
      }
      proyectoPlaneacionId = (proyectoCreado as { id: string }).id
    }

    // Fuente CANÓNICA de la identidad curricular para los documentos:
    //   - proyecto recién creado → la recién validada (ya persistida);
    //   - reintento con trazabilidad consolidada → SOLO la persistida,
    //     nunca recalculada con el catálogo actual;
    //   - proyecto anterior sin trazabilidad → la recién validada solo si
    //     coincide con los contenidos y PDA ya guardados;
    //   - cualquier otro caso → ninguna: no se reconstruye por
    //     aproximación (no se generan los formatos que falten ni se
    //     escribe trazabilidad).
    const persistido = proyectoPlaneacionExistente as { evaluacion?: { trazabilidad_curricular?: unknown } | null; contenidos?: string[] | null; pda?: string[] | null } | null
    const trazabilidadPersistida = persistido?.evaluacion?.trazabilidad_curricular
    let canonico: { trazabilidad: TrazabilidadCurricularAprobada; textoDefinitivo: string } | null
    if (!persistido) {
      canonico = { trazabilidad: curricular.trazabilidad, textoDefinitivo: curricular.textoDefinitivo }
    } else if (esTrazabilidadCanonica(trazabilidadPersistida)) {
      canonico = { trazabilidad: trazabilidadPersistida, textoDefinitivo: textoDefinitivoConIdentidad(seleccion.contenido, identidadDesdeTrazabilidad(trazabilidadPersistida)) }
    } else {
      const listas = listasCurriculares(resumen, curricular)
      const coincide = trazabilidadPersistida == null
        && JSON.stringify(listas.contenidos) === JSON.stringify(persistido.contenidos ?? [])
        && JSON.stringify(listas.pda) === JSON.stringify(persistido.pda ?? [])
      canonico = coincide ? { trazabilidad: curricular.trazabilidad, textoDefinitivo: curricular.textoDefinitivo } : null
      if (!coincide) console.warn('[PLANEACION_GENERAR][aprobar] sin identidad curricular canónica para este reintento — no se generan formatos faltantes ni se escribe trazabilidad')
    }

    // Fase 3: proyectos_seguimiento del proyecto de ESTA planeación
    // (planeacion_proyecto_id, único) — nunca por nombre y fechas.
    let proyectoSeguimientoId: string
    let hojaIdExistente: string | null
    const proyectoSeguimientoExistente = await buscarProyectoSeguimientoDePlaneacion(sb, proyectoPlaneacionId)
    if (proyectoSeguimientoExistente) {
      proyectoSeguimientoId = proyectoSeguimientoExistente.id
      hojaIdExistente = proyectoSeguimientoExistente.hoja_id
      if (!proyectoSeguimientoExistente.periodo_evaluacion_id && periodoActual) {
        const { error: errorCompletar } = await sb.from('proyectos_seguimiento').update({ periodo_evaluacion_id: periodoActual.id }).eq('id', proyectoSeguimientoId)
        if (errorCompletar) {
          console.error('[PLANEACION_GENERAR][aprobar] fallo completando el periodo del proyecto de seguimiento:', errorCompletar)
          return fallar()
        }
      }
    } else {
      const camposFormativosValidos = resumen.camposFormativos.filter((c) => CAMPOS_FORMATIVOS_VALIDOS.has(c))
      const { data: proyectoSeguimiento, error: errorProyectoSeguimiento } = await sb
        .from('proyectos_seguimiento')
        .insert({
          grupo_id: sesion.grupo_activo_id,
          docente_id: sesion.docente_id,
          ciclo_escolar_id: sesion.ciclo_escolar_id,
          periodo_evaluacion_id: periodoActual?.id ?? null,
          planeacion_proyecto_id: proyectoPlaneacionId,
          nombre: resumen.nombre,
          campos_formativos: camposFormativosValidos,
          fecha_inicio: resumen.fechaInicio,
          fecha_fin: resumen.fechaFin,
        })
        .select('id')
        .single()
      if ((errorProyectoSeguimiento as { code?: string } | null)?.code === '23505') return sinConcesion(planeacionId)
      if (errorProyectoSeguimiento || !proyectoSeguimiento) {
        console.error('[PLANEACION_GENERAR][aprobar] fallo creando proyectos_seguimiento:', errorProyectoSeguimiento)
        return fallar()
      }
      proyectoSeguimientoId = proyectoSeguimiento.id
      hojaIdExistente = null
    }
    void hojaIdExistente // la recuperación real la hace generarYGuardarHojaSeguimiento por proyecto_id

    // Fase 4: hoja de evaluación DEFINITIVA + PDF + Storage — mismo
    // generador y misma función que ya usa Seguimiento (Fase 2),
    // reutilizada tal cual (lib/seguimiento/generarYGuardarHoja.ts).
    const { data: perfilDocente } = await sb.from('perfiles_docentes').select('*').eq('id', sesion.docente_id).single()
    // Hoja, Word y PDF son de ESTE grupo: grado y grupo del grupo de la
    // sesión (nunca del perfil); el resto del perfil, igual.
    const perfil = perfilConGrupoAcademico(perfilDocente, sesion.grupo_activo_datos ?? { grado: null, grupo: null })
    const resultadoHoja = await generarYGuardarHojaSeguimiento(
      sb,
      sesion.docente_id,
      {
        proyectoId: proyectoSeguimientoId,
        grupoId: sesion.grupo_activo_id,
        nombreProyecto: resumen.nombre,
        camposFormativos: resumen.camposFormativos.filter((c) => CAMPOS_FORMATIVOS_VALIDOS.has(c)),
        trimestreNombre: periodoActual?.nombre ?? null,
        fechaInicio: resumen.fechaInicio,
        fechaFin: resumen.fechaFin,
        indicadores: construirIndicadoresSeguimiento(resumen),
      },
      perfil,
      null
    )
    if (!resultadoHoja.ok) {
      // La planeación sigue en version=0 (invisible) porque
      // confirmarPlaneacion todavía no se llamó — "no presentar como
      // completamente aprobada" se cumple sin necesitar un estado
      // técnico adicional.
      console.error('[PLANEACION_GENERAR][aprobar] fallo generando la hoja de evaluación:', resultadoHoja.error)
      return fallar()
    }

    // Fase 4.5: Word + PDF DEFINITIVOS de la planeación (AJUSTE
    // AISLADO — "descarga real en Word y PDF") — mismo generador real
    // ya usado por FINALIZAR ARCHIVO (ejecutarHerramientaDocumento,
    // lib/documentGen/herramientas.ts: sube a Storage y devuelve una
    // URL firmada real, nunca una vista previa por token), aplicado a
    // los DOS formatos desde el MISMO texto completo del borrador —
    // nunca una conversión iniciada por botón ni un segundo paso
    // aparte. A diferencia de la hoja (Fase 4), esto es MEJOR ESFUERZO:
    // si falla, NO se aborta la aprobación — la planeación y la hoja ya
    // son válidas por sí solas, y el docente siempre puede pedir el
    // archivo después escribiendo en el chat (mismo camino que existía
    // antes de esta mejora). Idempotente: si un intento anterior de
    // esta MISMA huella ya generó ambos formatos (evaluacion.documento_word/
    // documento_pdf ya presentes), se reutilizan tal cual — nunca se
    // regeneran ni se duplican archivos en Storage.
    // url_ver (CORRECCIÓN AISLADA — "separar 'Ver PDF' de 'Descargar
    // PDF'"): solo presente en documento_pdf — segunda URL firmada sin
    // `download`, para el botón "Ver PDF". Opcional: una planeación
    // aprobada antes de este ajuste puede tener documento_pdf sin
    // url_ver — TarjetaDescarga simplemente sigue mostrando el botón
    // único de siempre para esos casos, sin romper nada.
    // archivo_id/grupo_academico: registro real del archivo (B1/B2); ausentes
    // en planeaciones anteriores.
    const evaluacionPrevia = (proyectoPlaneacionExistente as { evaluacion?: { documento_word?: DocumentoGuardado; documento_pdf?: DocumentoGuardado } } | null)?.evaluacion
    let documentoWord: DocumentoGuardado | null = evaluacionPrevia?.documento_word ?? null
    let documentoPdf: DocumentoGuardado | null = evaluacionPrevia?.documento_pdf ?? null
    // Cada formato generado se guarda EN SEGUIDA en el proyecto: si el
    // proceso se interrumpe, el reintento lo reutiliza (nunca lo duplica).
    const evaluacionAcumulada: Record<string, unknown> = { ...((evaluacionPrevia as Record<string, unknown> | undefined) ?? construirProyecto(resumen, planeacionId, curricular).evaluacion) }
    // Devuelve un resultado si esta ejecución ya no debe seguir (perdió la
    // concesión): el archivo recién generado nunca se entregó y queda
    // 'fallido' en su registro; nada se escribe en el proyecto.
    const guardarFormato = async (campo: 'documento_word' | 'documento_pdf', documento: DocumentoGuardado): Promise<ResultadoAprobacion | null> => {
      const estado = await consolidar(planeacionId, { ...evaluacionAcumulada, [campo]: documento }, null)
      if (estado === 'perdida') {
        if (documento.archivo_id) await marcarArchivoNoEntregado(documento.archivo_id, 'La aprobación que lo generó perdió su concesión; nunca se entregó.')
        return sinConcesion(planeacionId)
      }
      // Error de escritura: mejor esfuerzo, como siempre (el vínculo final lo reintenta).
      evaluacionAcumulada[campo] = documento
      return null
    }
    if (!documentoWord || !documentoPdf) {
      // Antes de generar archivos se renueva la concesión: si otra
      // solicitud la tomó (la nuestra venció), esta no genera nada.
      const sinPermiso = await conConcesion(planeacionId)
      if (sinPermiso) return sinPermiso
      try {
        // El MISMO turno del borrador vigente que se aprobó — no el
        // último del historial, que puede ser un error o una aclaración —,
        // con UNA sola sección de contenidos y PDA: la validada al aprobar.
        const textoCompleto = canonico?.textoDefinitivo ?? ''
        if (textoCompleto) {
          if (!documentoWord) {
            const generado = await ejecutarHerramientaDocumento('word', textoCompleto, perfil, null, sb, sesion.docente_id)
            documentoWord = { nombre: generado.nombre, url: generado.url, tamano_bytes: generado.tamanoBytes, archivo_id: generado.archivoId, grupo_academico: generado.grupoAcademico }
            const detener = await guardarFormato('documento_word', documentoWord)
            if (detener) return detener
          }
          if (!documentoPdf) {
            const generado = await ejecutarHerramientaDocumento('pdf', textoCompleto, perfil, null, sb, sesion.docente_id)
            documentoPdf = { nombre: generado.nombre, url: generado.url, tamano_bytes: generado.tamanoBytes, url_ver: generado.urlVer, archivo_id: generado.archivoId, grupo_academico: generado.grupoAcademico }
            const detener = await guardarFormato('documento_pdf', documentoPdf)
            if (detener) return detener
          }
        } else {
          console.error('[PLANEACION_GENERAR][aprobar] Fase 4.5: sin texto definitivo canónico — se omiten Word/PDF definitivos')
        }
      } catch (e) {
        console.error('[PLANEACION_GENERAR][aprobar] Fase 4.5: fallo generando Word/PDF definitivos de la planeación (no bloquea la aprobación):', e)
      }
    }

    // Fase 5: vincular la hoja real y el documento real (si se logró
    // generar) dentro de planeacion_proyectos — único lugar del
    // vínculo, sin relación improvisada nueva — y registrar la planeación
    // en Historial (registro canónico del servidor), en UNA transacción
    // protegida por la concesión: nunca sobrescribe lo de otra ejecución.
    const contenidoDefinitivoFinal = canonico?.textoDefinitivo ?? ''
    const vinculo = await consolidar(planeacionId, {
      indicadores: resumen.indicadores,
      producto_final: resumen.productoFinal,
      evidencias: resumen.evidencias,
      fuente: 'chat_ia',
      proyecto_seguimiento_id: proyectoSeguimientoId,
      hoja_id: resultadoHoja.hojaId,
      hoja_identificador_visible: resultadoHoja.identificadorVisible,
      // Trazabilidad ya consolidada (reintento) nunca se sobrescribe;
      // sin fuente canónica no se escribe ninguna.
      ...(trazabilidadPersistida != null ? { trazabilidad_curricular: trazabilidadPersistida } : canonico ? { trazabilidad_curricular: canonico.trazabilidad } : {}),
      ...(documentoWord ? { documento_word: documentoWord } : {}),
      ...(documentoPdf ? { documento_pdf: documentoPdf } : {}),
    }, filaHistorial(contenidoDefinitivoFinal, documentoWord))
    if (vinculo === 'perdida') return sinConcesion(planeacionId)
    if (vinculo === 'error') return fallar()

    // Fase 6: promoción — el único punto en el que la planeación se
    // vuelve visible de verdad, ahora que TODO (planeación, proyecto,
    // hoja, PDF) está confirmado como una sola operación lógica. Solo con
    // la concesión propia (token): si otra solicitud la tomó, esta no
    // confirma; la concesión se libera al confirmar.
    // Con texto canónico, la confirmación publica en la MISMA transacción
    // su versión 1 (planeacion_versiones: fuente canónica de la
    // planeación, migración 20261126000000). Sin texto canónico no se
    // inventa: se confirma como antes y la base deriva la versión de lo
    // ya guardado.
    let confirmada: Planeacion | undefined
    if (contenidoDefinitivoFinal && canonico) {
      const { data: publicacion, error: errorPublicar } = await sb.rpc('publicar_version_planeacion', {
        p_planeacion_id: planeacionId,
        p_version_base: 0,
        p_borrador_clave: clave,
        p_contenido: contenidoDefinitivoFinal,
        p_estructura: estructuraDeVersion(resumen, campoFormativoValidado, construirProyecto(resumen, planeacionId, curricular)),
        p_trazabilidad: canonico.trazabilidad,
        p_documento_word: documentoWord?.archivo_id ?? null,
        p_documento_pdf: documentoPdf?.archivo_id ?? null,
        p_token: token,
      })
      const estado = (publicacion as { estado?: string } | null)?.estado
      if (errorPublicar || (estado !== 'publicada' && estado !== 'ya_publicada' && estado !== 'conflicto')) {
        console.error('[PLANEACION_GENERAR][aprobar] fallo publicando la versión 1:', errorPublicar ?? estado)
        return fallar()
      }
      if (estado === 'conflicto') return sinConcesion(planeacionId)
      const { data: publicada } = await sb.from('planeaciones').select(COLUMNAS_PLANEACION_APROBADA).eq('id', planeacionId).maybeSingle()
      confirmada = (publicada as Planeacion | null) ?? undefined
      if (!confirmada) return fallar()
    } else {
      const { data: confirmadas, error: errorConfirmar } = await sb
        .from('planeaciones')
        .update({ version: 1, estado: ESTADO_FINAL_TRAS_APROBAR, aprobacion_token: null, aprobacion_expira_en: null, actualizado_en: new Date().toISOString() })
        .eq('id', planeacionId)
        .eq('version', 0)
        .eq('aprobacion_token', token)
        .select(COLUMNAS_PLANEACION_APROBADA)
      if (errorConfirmar) {
        console.error('[PLANEACION_GENERAR][aprobar] fallo confirmando la planeación:', errorConfirmar)
        return fallar()
      }
      confirmada = (confirmadas ?? [])[0] as Planeacion | undefined
      if (!confirmada) return sinConcesion(planeacionId)
    }

    return {
      ok: true,
      planeacion: confirmada,
      duracionDias: resumen.duracionDias,
      // EVAL-1G — proyectoSeguimientoId (ya resuelto arriba, Fase 3)
      // viaja de vuelta al llamador para que app/api/chat/route.ts
      // pueda incluirlo en la tarjeta de la hoja — sin él, la acción
      // "Subir foto ya contestada" no puede resolver a qué proyecto
      // pertenece. Aditivo: no cambia ningún consumidor existente de
      // este campo `hoja`.
      hoja: { identificadorVisible: resultadoHoja.identificadorVisible, url: resultadoHoja.url, urlVer: resultadoHoja.urlVer, proyectoSeguimientoId },
      documentoPlaneacion: documentoWord && documentoPdf
        ? {
            word: { nombre: documentoWord.nombre, url: documentoWord.url, tamanoBytes: documentoWord.tamano_bytes, archivoId: documentoWord.archivo_id, grupoAcademico: documentoWord.grupo_academico },
            pdf: { nombre: documentoPdf.nombre, url: documentoPdf.url, tamanoBytes: documentoPdf.tamano_bytes, urlVer: documentoPdf.url_ver, archivoId: documentoPdf.archivo_id, grupoAcademico: documentoPdf.grupo_academico },
            contenidoDefinitivo: contenidoDefinitivoFinal,
          }
        : null,
    }
  } catch (e) {
    console.error('[PLANEACION_GENERAR][aprobar] excepción no controlada:', e)
    if (liberarAlFallar) return liberarAlFallar()
    return { ok: false, codigo: 'ERROR_GUARDADO', mensaje: MENSAJE_ERROR_GENERICO }
  }
}
