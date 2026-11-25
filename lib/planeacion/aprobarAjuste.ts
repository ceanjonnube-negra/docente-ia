// lib/planeacion/aprobarAjuste.ts
//
// Hito 2, etapa 3b — aprobar un borrador de AJUSTE de una planeación
// guardada: se publica como versión N+1 de la MISMA planeación y proyecto
// (publicarVersionPlaneacion → publicar_version_planeacion), con la
// protección de evaluación ya implementada. Sin IA y sin generar Word ni
// PDF de la planeación (etapa 4).
//
// - Identidad: SOLO la metadata del servidor (conversaciones_chat.
//   planeacion_activa.ajustes: huella del borrador, planeación, versión
//   base, grupo). La línea del resumen nunca autoriza publicar: sin
//   metadata confiable, no se publica (falla de forma segura).
// - Se validan docente (RLS + RPC), grupo activo, planeación y versión base.
// - Idempotencia: la clave del borrador es el id persistido de su mensaje
//   ("msg:<id>"); un reintento recupera exactamente la versión publicada.
// - Conflicto: si la versión base dejó de ser la vigente, no se sobrescribe.
// - Hoja de evaluación: la tarjeta de la hoja de ESA versión (no es Word
//   ni PDF de la planeación).

import type { SupabaseClient } from '@supabase/supabase-js'
import type { SesionContexto } from '../sesionContexto'
import { seleccionarBorradorVigente, type ResumenBorrador } from './extraerBorrador'
import { CAMPOS_FORMATIVOS_VALIDOS, MENSAJE_NO_PERSISTIDO, construirProyecto, estructuraDeVersion, hojaEntregable, leerHoja, resolverIdentidadBorrador, type HojaAprobacion } from './aprobarBorrador'
import { resolverCurricularAprobacion, type CurricularAprobado, type TrazabilidadCurricularAprobada } from './curricularAprobacion'
import { validarContenidoBorrador } from './validarContenidoBorrador'
import { ETIQUETA_AJUSTE, ajustePublicable, baseDeVersion, separarResumen, type BaseAjuste } from './modificarPlaneacion'
import { avisoEvaluacionDeVersion, completarHojaConGenerador, publicarVersionPlaneacion, type CompletarHoja } from './publicarVersion'
import { guardarReferenciaPlaneacion } from './consultaPlaneaciones'
import { perfilConGrupoAcademico } from '../documentGen/encabezadoDocumento'

export type CodigoAprobacionAjuste = 'VERSION_PUBLICADA' | 'VERSION_YA_PUBLICADA' | 'AJUSTE_SIN_IDENTIDAD' | 'AJUSTE_OTRO_GRUPO' | 'CONFLICTO_VERSION' | 'BORRADOR_NO_PERSISTIDO' | 'BORRADOR_INCOMPLETO' | 'ERROR_GUARDADO'
// hoja: tarjeta de la hoja de evaluación de la versión publicada (la misma
// si se conservó, la nueva si se reemplazó; reemplazada después → solo
// consulta). Sin hoja o con su PDF pendiente, no hay tarjeta.
export type ResultadoAprobacionAjuste = { codigo: CodigoAprobacionAjuste; mensaje: string; numero?: number; hoja?: HojaAprobacion | null }

export const MENSAJE_AJUSTE_SIN_IDENTIDAD = 'No puedo confirmar de qué versión guardada viene este ajuste, así que no lo guardo. Pídeme de nuevo el cambio sobre la planeación y lo preparo otra vez.'
const MENSAJE_ERROR = 'No pude guardar la nueva versión en este momento; la planeación sigue como estaba. Intenta de nuevo en unos segundos.'

const mensajeConflicto = (nombre: string, vigente: number, base: number) =>
  `«${nombre}» cambió desde que preparé este ajuste: ahora su versión vigente es la ${vigente} y el ajuste partía de la ${base}. No sobrescribo esos cambios; pídeme que aplique de nuevo tu ajuste sobre la versión ${vigente}.`
const mensajeYaPublicada = (nombre: string, numero: number) => `Este ajuste ya está guardado como la versión ${numero} de «${nombre}».`

// Hoja de evaluación de la versión EXACTA publicada (planeacion_versiones.
// hoja_id). Si es la vigente y su PDF quedó pendiente, se completa con el
// generador idempotente de siempre (nunca crea otra hoja); si sigue
// pendiente, se indica cómo recuperarla.
async function hojaDeVersion(sb: SupabaseClient, docenteId: string, planeacionId: string, numero: number, completar: CompletarHoja, reintentarPdf: boolean): Promise<{ hoja: HojaAprobacion | null; aviso: string }> {
  const { data } = await sb.from('planeacion_versiones').select('hoja_id').eq('planeacion_id', planeacionId).eq('docente_id', docenteId).eq('numero', numero).maybeSingle()
  const hojaId = (data as { hoja_id?: string | null } | null)?.hoja_id
  if (!hojaId) return { hoja: null, aviso: '' }
  let fila = await leerHoja(sb, hojaId)
  if (fila && !fila.storage_path && !fila.reemplazada_por && reintentarPdf) {
    try {
      if (await completar(fila.proyecto_id)) fila = await leerHoja(sb, hojaId)
    } catch (e) {
      console.error('[PLANEACION_VERSION] la hoja sigue sin PDF (pendiente):', e)
    }
  }
  if (fila && !fila.storage_path) {
    return { hoja: null, aviso: fila.reemplazada_por ? '' : ` La hoja de evaluación ${fila.identificador_visible} todavía no tiene su PDF; pídeme de nuevo que guarde este ajuste para recuperarla.` }
  }
  return { hoja: fila ? await hojaEntregable(sb, hojaId, fila) : null, aviso: '' }
}

const iguales = (a: string[] | null | undefined, b: string[] | null | undefined) =>
  JSON.stringify((a ?? []).map((x) => x.trim().toLowerCase())) === JSON.stringify((b ?? []).map((x) => x.trim().toLowerCase()))

// Curricular de la versión: si contenidos, PDA y campos son los de la base,
// se conserva su trazabilidad tal cual (no se recalcula la selección); si
// el ajuste los cambió, se revalida como en la primera aprobación (sin IA).
async function curricularDeVersion(sb: SupabaseClient, grupoId: string, base: BaseAjuste, contenido: string, cuerpo: string, resumen: ResumenBorrador, textosDocente: string[]): Promise<CurricularAprobado> {
  const p = base.estructura.proyecto
  if (iguales(resumen.contenidos, p?.contenidos) && iguales(resumen.pda, p?.pda) && iguales(resumen.camposFormativos, p?.campos_formativos)) {
    return { identidad: null, trazabilidad: base.trazabilidad as TrazabilidadCurricularAprobada, textoDefinitivo: cuerpo, cicloEscolarGrupo: null }
  }
  return resolverCurricularAprobacion(sb, grupoId, contenido, resumen, textosDocente)
}

// null: el borrador vigente no es un ajuste (sigue la primera aprobación).
export async function aprobarAjusteSiCorresponde(
  sb: SupabaseClient,
  sesion: SesionContexto,
  historial: { role: string; content: string }[],
  mensajeDocente: string,
  conversacionId: string | null,
  completarHoja?: CompletarHoja,
  zonaHoraria: string | null = null
): Promise<ResultadoAprobacionAjuste | null> {
  const seleccion = seleccionarBorradorVigente(historial, mensajeDocente)
  if (seleccion.estado !== 'listo') return null
  const { contenido, resumen } = seleccion
  const { data: conv } = conversacionId ? await sb.from('conversaciones_chat').select('planeacion_activa').eq('id', conversacionId).maybeSingle() : { data: null }
  const ajuste = ajustePublicable(contenido, (conv as { planeacion_activa?: unknown } | null)?.planeacion_activa ?? null)
  if (!ajuste) {
    // Solo la línea del resumen: es un ajuste, pero sin identidad confiable.
    return new RegExp(`^${ETIQUETA_AJUSTE}:`, 'mi').test(contenido) ? { codigo: 'AJUSTE_SIN_IDENTIDAD', mensaje: MENSAJE_AJUSTE_SIN_IDENTIDAD } : null
  }
  if (!sesion.grupo_activo_id || ajuste.grupoId !== sesion.grupo_activo_id) {
    return { codigo: 'AJUSTE_OTRO_GRUPO', mensaje: 'Este ajuste es de una planeación de otro grupo. Cambia a ese grupo para guardarlo.' }
  }
  const { data: fila } = await sb.from('planeaciones').select('id, nombre, version, grupo_id').eq('id', ajuste.planeacionId).eq('docente_id', sesion.docente_id).eq('grupo_id', sesion.grupo_activo_id).maybeSingle()
  const planeacion = fila as { id: string; nombre: string; version: number; grupo_id: string } | null
  if (!planeacion || planeacion.version < 1) return { codigo: 'AJUSTE_SIN_IDENTIDAD', mensaje: MENSAJE_AJUSTE_SIN_IDENTIDAD }

  const completar: CompletarHoja = completarHoja ?? (async (ps) => {
    const { data: perfilDocente } = await sb.from('perfiles_docentes').select('*').eq('id', sesion.docente_id).single()
    const perfil = perfilConGrupoAcademico(perfilDocente, sesion.grupo_activo_datos ?? { grado: null, grupo: null })
    return completarHojaConGenerador(sb, sesion.docente_id, perfil, zonaHoraria)(ps)
  })
  const yaPublicada = async (numero: number): Promise<ResultadoAprobacionAjuste> => {
    const h = await hojaDeVersion(sb, sesion.docente_id, planeacion.id, numero, completar, true)
    return { codigo: 'VERSION_YA_PUBLICADA', mensaje: `${mensajeYaPublicada(planeacion.nombre, numero)}${h.aviso}`, numero, hoja: h.hoja }
  }

  const clave = await resolverIdentidadBorrador(sb, conversacionId, contenido)
  if (!clave) return { codigo: 'BORRADOR_NO_PERSISTIDO', mensaje: MENSAJE_NO_PERSISTIDO }
  // Reintento: este borrador ya se publicó → esa versión exacta.
  const { data: publicada } = await sb.from('planeacion_versiones').select('numero, planeacion_id').eq('docente_id', sesion.docente_id).eq('borrador_clave', clave).maybeSingle()
  const previa = publicada as { numero: number; planeacion_id: string } | null
  if (previa) {
    return previa.planeacion_id === planeacion.id
      ? yaPublicada(previa.numero)
      : { codigo: 'AJUSTE_SIN_IDENTIDAD', mensaje: MENSAJE_AJUSTE_SIN_IDENTIDAD }
  }
  if (planeacion.version !== ajuste.versionBase) {
    return { codigo: 'CONFLICTO_VERSION', mensaje: mensajeConflicto(planeacion.nombre, planeacion.version, ajuste.versionBase) }
  }

  const validacion = validarContenidoBorrador(resumen)
  if (!validacion.ok) return { codigo: 'BORRADOR_INCOMPLETO', mensaje: validacion.mensaje }
  const base = await baseDeVersion(sb, planeacion.id, planeacion.grupo_id, ajuste.versionBase)
  if (!base) return { codigo: 'ERROR_GUARDADO', mensaje: MENSAJE_ERROR }
  const campoFormativo = resumen.camposFormativos.find((c) => CAMPOS_FORMATIVOS_VALIDOS.has(c)) ?? base.estructura.planeacion?.campo_formativo ?? null
  if (!campoFormativo) return { codigo: 'BORRADOR_INCOMPLETO', mensaje: 'El ajuste no tiene un campo formativo reconocido — pídeme que lo prepare de nuevo antes de guardarlo.' }

  // Texto canónico de la versión: el documento, sin resumen, línea de ajuste ni pregunta.
  const cuerpo = separarResumen(contenido).cuerpo
  const textosDocente = [...historial.filter((h) => h.role === 'user').map((h) => h.content), mensajeDocente]
  const curricular = await curricularDeVersion(sb, sesion.grupo_activo_id, base, contenido, cuerpo, resumen, textosDocente)
  const r = await publicarVersionPlaneacion(sb, {
    planeacionId: planeacion.id,
    versionBase: ajuste.versionBase,
    borradorClave: clave,
    contenido: curricular.textoDefinitivo || cuerpo,
    estructura: estructuraDeVersion(resumen, campoFormativo, construirProyecto(resumen, planeacion.id, curricular)),
    trazabilidad: curricular.trazabilidad ?? null,
    resumen,
  }, completar)

  if (r.estado === 'ya_publicada' && r.numero) return yaPublicada(r.numero)
  if (r.estado === 'conflicto') {
    const vigente = r.numero ?? planeacion.version
    return { codigo: 'CONFLICTO_VERSION', mensaje: mensajeConflicto(planeacion.nombre, vigente, ajuste.versionBase) }
  }
  if (r.estado !== 'publicada' || !r.numero) {
    console.error(`[PLANEACION_VERSION] publicación no completada: ${r.estado}`)
    return { codigo: 'ERROR_GUARDADO', mensaje: MENSAJE_ERROR }
  }
  // La conversación queda referida a la versión recién publicada (los ajustes registrados se conservan).
  await guardarReferenciaPlaneacion(sb, conversacionId, { planeacionId: planeacion.id, numero: r.numero, opciones: [] })
  let codigoHoja: string | null = null
  if (r.hoja?.estado === 'reemplazada' && r.hoja.id) {
    const { data: hoja } = await sb.from('hojas_evaluacion').select('identificador_visible').eq('id', r.hoja.id).maybeSingle()
    codigoHoja = (hoja as { identificador_visible?: string } | null)?.identificador_visible ?? null
  }
  const aviso = avisoEvaluacionDeVersion(r, codigoHoja)
  // Si el PDF de la hoja nueva acaba de fallar, no se reintenta en esta misma solicitud.
  const h = await hojaDeVersion(sb, sesion.docente_id, planeacion.id, r.numero, completar, r.pdfHoja !== 'pendiente')
  console.log(`[PLANEACION_VERSION] publicada versión ${r.numero} hoja=${r.hoja?.estado ?? 'sin_hoja'}`)
  return {
    codigo: 'VERSION_PUBLICADA',
    numero: r.numero,
    mensaje: `Listo: guardé «${planeacion.nombre}» como versión ${r.numero}. La versión ${ajuste.versionBase} y las anteriores se conservan para consulta.${aviso ? ` ${aviso}` : ''}${r.pdfHoja === 'pendiente' ? '' : h.aviso}`,
    hoja: h.hoja,
  }
}
