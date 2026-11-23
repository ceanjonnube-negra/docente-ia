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
import { seleccionarBorradorVigente, type ResumenBorrador } from './extraerBorrador'
import { esTrazabilidadCanonica, identidadDesdeTrazabilidad, resolverCurricularAprobacion, resolverPeriodoPorFechaInicio, textoDefinitivoConIdentidad, type CurricularAprobado, type TrazabilidadCurricularAprobada } from './curricularAprobacion'
import { validarContenidoBorrador } from './validarContenidoBorrador'
import { crearPlaneacion, confirmarPlaneacion, type DatosProyectoPlaneacion } from './persistencia'
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
  | { ok: true; planeacion: Planeacion; duracionDias: number | null; hoja: { identificadorVisible: string; url: string; urlVer: string; proyectoSeguimientoId: string }; documentoPlaneacion: { word: DocumentoPlaneacionGenerado; pdf: DocumentoPlaneacionGenerado; contenidoDefinitivo: string } | null }
  | { ok: false; codigo: CodigoErrorAprobacion; mensaje: string }

type TurnoHistorial = { role: string; content: string }

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

function construirProyecto(resumen: ResumenBorrador, planeacionId: string, curricular: CurricularAprobado): DatosProyectoPlaneacion & { planeacion_id: string } {
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
const CAMPOS_FORMATIVOS_VALIDOS = new Set<string>(CAMPOS_FORMATIVOS)

function construirIndicadoresSeguimiento(resumen: ResumenBorrador): IndicadorProyecto[] {
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

type FilaHuella = { id: string; version: number }

// Busca una fila EXISTENTE con la misma huella (docente + grupo +
// nombre + fechas exactas) — a propósito NO pasa por listarPlaneaciones
// (que ahora oculta version=0): esta función necesita ver también las
// filas temporales, para poder recuperarlas en vez de duplicarlas.
async function buscarPorHuella(sb: SupabaseClient, sesion: SesionContexto, resumen: ResumenBorrador): Promise<FilaHuella | null> {
  const { data } = await sb
    .from('planeaciones')
    .select('id, version')
    .eq('docente_id', sesion.docente_id)
    .eq('grupo_id', sesion.grupo_activo_id as string)
    .eq('nombre', resumen.nombre)
    .eq('fecha_inicio', resumen.fechaInicio)
    .eq('fecha_fin', resumen.fechaFin)
    .maybeSingle()
  return (data as FilaHuella | null) ?? null
}

type FilaProyectoSeguimiento = { id: string; hoja_id: string | null; planeacion_proyecto_id: string | null; periodo_evaluacion_id: string | null }

// Misma huella (docente + grupo + nombre + fechas) aplicada a
// proyectos_seguimiento — recupera un intento anterior incompleto en
// vez de crear un proyecto duplicado.
async function buscarProyectoSeguimientoPorHuella(sb: SupabaseClient, sesion: SesionContexto, resumen: ResumenBorrador): Promise<FilaProyectoSeguimiento | null> {
  const { data } = await sb
    .from('proyectos_seguimiento')
    .select('id, hoja_id, planeacion_proyecto_id, periodo_evaluacion_id')
    .eq('docente_id', sesion.docente_id)
    .eq('grupo_id', sesion.grupo_activo_id as string)
    .eq('nombre', resumen.nombre)
    .eq('fecha_inicio', resumen.fechaInicio)
    .eq('fecha_fin', resumen.fechaFin)
    .maybeSingle()
  return (data as FilaProyectoSeguimiento | null) ?? null
}

export async function aprobarBorradorPlaneacion(
  sb: SupabaseClient,
  sesion: SesionContexto,
  historial: TurnoHistorial[],
  // Texto que escribió el docente en este turno — solo para detectar
  // si nombra un borrador distinto del vigente (ver seleccionarBorradorVigente).
  mensajeDocente = ''
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
    return { ok: false, codigo: 'YA_GUARDADA', mensaje: 'Esta planeación ya está guardada.' }
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
  const resumen = seleccion.resumen

  // Validación estructural determinista — nunca se persiste un
  // borrador incompleto, sin importar que el bloque de resumen se
  // haya podido extraer.
  const validacion = validarContenidoBorrador(resumen)
  if (!validacion.ok) {
    console.log(`[PLANEACION_GENERAR][aprobar] contenido incompleto: ${validacion.elementosFaltantes.join(', ')}`)
    return { ok: false, codigo: 'BORRADOR_INCOMPLETO', mensaje: validacion.mensaje }
  }

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

    // Huella estable (docente + grupo + nombre + fechas): distingue
    // "ya guardada de verdad" (version>=1) de "hay un intento anterior
    // sin terminar" (version=0, se recupera) de "no existe todavía".
    const existente = await buscarPorHuella(sb, sesion, resumen)
    if (existente && existente.version >= 1) {
      return { ok: false, codigo: 'YA_GUARDADA', mensaje: 'Esta planeación ya está guardada.' }
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

    // Fase 1: planeación temporal (version=0, invisible) — se crea o
    // se recupera, nunca se duplica.
    let planeacionId: string
    if (existente) {
      planeacionId = existente.id
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
          version: 0, // centinela: invisible hasta confirmarPlaneacion()
        }
      )
      if (!creado.ok) {
        console.error('[PLANEACION_GENERAR][aprobar] fallo creando la fila temporal:', creado.error)
        return { ok: false, codigo: 'ERROR_GUARDADO', mensaje: MENSAJE_ERROR_GENERICO }
      }
      planeacionId = creado.datos.id
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
      return { ok: false, codigo: 'ERROR_GUARDADO', mensaje: MENSAJE_ERROR_GENERICO }
    }
    let proyectoPlaneacionId: string
    if (proyectoPlaneacionExistente) {
      proyectoPlaneacionId = (proyectoPlaneacionExistente as { id: string }).id
    } else {
      const { data: proyectoCreado, error: errorProyecto } = await sb.from('planeacion_proyectos').insert(construirProyecto(resumen, planeacionId, curricular)).select('id').single()
      if (errorProyecto || !proyectoCreado) {
        console.error('[PLANEACION_GENERAR][aprobar] fallo creando la relación:', errorProyecto)
        return { ok: false, codigo: 'ERROR_GUARDADO', mensaje: MENSAJE_ERROR_GENERICO }
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

    // Fase 3: proyectos_seguimiento — reutiliza la relación disponible
    // (Seguimiento integrado en Planeación → Proyecto → Seguimiento →
    // Hoja de evaluación, nunca como módulo aparte). Vinculado por la
    // MISMA huella (docente + grupo + nombre + fechas) — sin columna
    // planeacion_id (no existe en el esquema, no se agrega ninguna).
    let proyectoSeguimientoId: string
    let hojaIdExistente: string | null
    const proyectoSeguimientoExistente = await buscarProyectoSeguimientoPorHuella(sb, sesion, resumen)
    if (proyectoSeguimientoExistente) {
      proyectoSeguimientoId = proyectoSeguimientoExistente.id
      hojaIdExistente = proyectoSeguimientoExistente.hoja_id
      // Reintento o proyecto anterior a este vínculo: se completa SOLO lo
      // que falta; un vínculo ya existente con otro proyecto de
      // planeación nunca se reasigna.
      const completar: Record<string, string> = {}
      if (!proyectoSeguimientoExistente.planeacion_proyecto_id) completar.planeacion_proyecto_id = proyectoPlaneacionId
      else if (proyectoSeguimientoExistente.planeacion_proyecto_id !== proyectoPlaneacionId) console.warn('[PLANEACION_GENERAR][aprobar] el proyecto de seguimiento ya está vinculado a otra planeación — no se reasigna')
      if (!proyectoSeguimientoExistente.periodo_evaluacion_id && periodoActual) completar.periodo_evaluacion_id = periodoActual.id
      if (Object.keys(completar).length > 0) {
        const { error: errorCompletar } = await sb.from('proyectos_seguimiento').update(completar).eq('id', proyectoSeguimientoId)
        if (errorCompletar) {
          console.error('[PLANEACION_GENERAR][aprobar] fallo completando el vínculo del proyecto de seguimiento:', errorCompletar)
          return { ok: false, codigo: 'ERROR_GUARDADO', mensaje: MENSAJE_ERROR_GENERICO }
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
      if (errorProyectoSeguimiento || !proyectoSeguimiento) {
        console.error('[PLANEACION_GENERAR][aprobar] fallo creando proyectos_seguimiento:', errorProyectoSeguimiento)
        return { ok: false, codigo: 'ERROR_GUARDADO', mensaje: MENSAJE_ERROR_GENERICO }
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
      return { ok: false, codigo: 'ERROR_GUARDADO', mensaje: MENSAJE_ERROR_GENERICO }
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
    type DocumentoGuardado = { nombre: string; url: string; tamano_bytes?: number; url_ver?: string; archivo_id?: string; grupo_academico?: { grado: string; grupo: string } }
    const evaluacionPrevia = (proyectoPlaneacionExistente as { evaluacion?: { documento_word?: DocumentoGuardado; documento_pdf?: DocumentoGuardado } } | null)?.evaluacion
    let documentoWord: DocumentoGuardado | null = evaluacionPrevia?.documento_word ?? null
    let documentoPdf: DocumentoGuardado | null = evaluacionPrevia?.documento_pdf ?? null
    if (!documentoWord || !documentoPdf) {
      try {
        // El MISMO turno del borrador vigente que se aprobó — no el
        // último del historial, que puede ser un error o una aclaración —,
        // con UNA sola sección de contenidos y PDA: la validada al aprobar.
        const textoCompleto = canonico?.textoDefinitivo ?? ''
        if (textoCompleto) {
          if (!documentoWord) {
            const generado = await ejecutarHerramientaDocumento('word', textoCompleto, perfil, null, sb, sesion.docente_id)
            documentoWord = { nombre: generado.nombre, url: generado.url, tamano_bytes: generado.tamanoBytes, archivo_id: generado.archivoId, grupo_academico: generado.grupoAcademico }
          }
          if (!documentoPdf) {
            const generado = await ejecutarHerramientaDocumento('pdf', textoCompleto, perfil, null, sb, sesion.docente_id)
            documentoPdf = { nombre: generado.nombre, url: generado.url, tamano_bytes: generado.tamanoBytes, url_ver: generado.urlVer, archivo_id: generado.archivoId, grupo_academico: generado.grupoAcademico }
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
    // vínculo, sin relación improvisada nueva.
    const { error: errorVinculo } = await sb
      .from('planeacion_proyectos')
      .update({
        evaluacion: {
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
        },
        actualizado_en: new Date().toISOString(),
      })
      .eq('planeacion_id', planeacionId)
    if (errorVinculo) {
      console.error('[PLANEACION_GENERAR][aprobar] fallo vinculando la hoja a planeacion_proyectos:', errorVinculo)
      return { ok: false, codigo: 'ERROR_GUARDADO', mensaje: MENSAJE_ERROR_GENERICO }
    }

    // Fase 6: promoción — el único punto en el que la planeación se
    // vuelve visible de verdad, ahora que TODO (planeación, proyecto,
    // hoja, PDF) está confirmado como una sola operación lógica.
    const confirmada = await confirmarPlaneacion({ supabase: sb }, planeacionId, ESTADO_FINAL_TRAS_APROBAR)
    if (!confirmada.ok) {
      console.error('[PLANEACION_GENERAR][aprobar] fallo confirmando la planeación:', confirmada.error)
      return { ok: false, codigo: 'ERROR_GUARDADO', mensaje: MENSAJE_ERROR_GENERICO }
    }

    return {
      ok: true,
      planeacion: confirmada.datos,
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
            contenidoDefinitivo: canonico?.textoDefinitivo ?? '',
          }
        : null,
    }
  } catch (e) {
    console.error('[PLANEACION_GENERAR][aprobar] excepción no controlada:', e)
    return { ok: false, codigo: 'ERROR_GUARDADO', mensaje: MENSAJE_ERROR_GENERICO }
  }
}
