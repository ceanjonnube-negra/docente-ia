// lib/planeacion/aprobarBorrador.ts
//
// Orquestación de la aprobación real de un borrador (C-005, Paso 3C):
// extrae el resumen determinista del último turno del asistente
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
import type { SesionContexto } from '../sesionContexto'
import { periodosEvaluacionDelCiclo } from '../motorContexto'
import { resolverPeriodoEvaluacionActual } from './generarBorrador'
import { extraerResumenBorrador, extraerTextoCompletoBorrador, tieneBloqueResumen, type ResumenBorrador } from './extraerBorrador'
import { validarContenidoBorrador } from './validarContenidoBorrador'
import { crearPlaneacion, confirmarPlaneacion, type DatosProyectoPlaneacion } from './persistencia'
import { generarYGuardarHojaSeguimiento } from '../seguimiento/generarYGuardarHoja'
import { CAMPOS_FORMATIVOS, CANTIDAD_INDICADORES_HOJA, type IndicadorProyecto } from '../seguimiento/tipos'
import { ejecutarHerramientaDocumento } from '../documentGen/herramientas'
import { esPlaneacionActivaValida, type TrazabilidadCurricularPlaneacion } from './planeacionActiva'
import type { Planeacion } from './tipos'

export type CodigoErrorAprobacion =
  | 'SIN_BORRADOR'
  | 'BORRADOR_INCOMPLETO'
  | 'SESION_INVALIDA'
  | 'GRUPO_NO_DISPONIBLE'
  | 'YA_GUARDADA'
  | 'ERROR_GUARDADO'

// Un formato definitivo (Word o PDF) de la planeación ya generado y
// subido a Storage — mismo shape que ArchivoGenerado
// (lib/documentGen/almacenamiento.ts), reducido a lo que la tarjeta
// del Chat IA necesita mostrar.
// urlVer (CORRECCIÓN AISLADA — "separar 'Ver PDF' de 'Descargar PDF'"):
// solo presente en el pdf — segunda URL firmada del mismo archivo sin
// `download`, para el botón "Ver PDF". `url` sigue siendo, sin ningún
// cambio, la URL de descarga forzada de siempre.
export type DocumentoPlaneacionGenerado = { nombre: string; url: string; tamanoBytes?: number; urlVer?: string }

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
  | { ok: true; planeacion: Planeacion; duracionDias: number | null; hoja: { identificadorVisible: string; url: string; urlVer: string }; documentoPlaneacion: { word: DocumentoPlaneacionGenerado; pdf: DocumentoPlaneacionGenerado } | null }
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

function construirProyecto(resumen: ResumenBorrador, planeacionId: string): DatosProyectoPlaneacion & { planeacion_id: string } {
  return {
    planeacion_id: planeacionId,
    nombre: resumen.nombre,
    campos_formativos: resumen.camposFormativos,
    contenidos: resumen.contenidos,
    pda: resumen.pda,
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

type FilaProyectoSeguimiento = { id: string; hoja_id: string | null }

// Misma huella (docente + grupo + nombre + fechas) aplicada a
// proyectos_seguimiento — recupera un intento anterior incompleto en
// vez de crear un proyecto duplicado.
async function buscarProyectoSeguimientoPorHuella(sb: SupabaseClient, sesion: SesionContexto, resumen: ResumenBorrador): Promise<FilaProyectoSeguimiento | null> {
  const { data } = await sb
    .from('proyectos_seguimiento')
    .select('id, hoja_id')
    .eq('docente_id', sesion.docente_id)
    .eq('grupo_id', sesion.grupo_activo_id as string)
    .eq('nombre', resumen.nombre)
    .eq('fecha_inicio', resumen.fechaInicio)
    .eq('fecha_fin', resumen.fechaFin)
    .maybeSingle()
  return (data as FilaProyectoSeguimiento | null) ?? null
}

// PLN-1E-B — deep-equal determinista y explicable: comparación de
// texto JSON, no una librería de diff — suficiente porque ambos lados
// siempre provienen de la MISMA estructura (construirTrazabilidadCurricular,
// lib/planeacion/planeacionActiva.ts), nunca de fuentes con orden de
// claves potencialmente distinto.
function trazabilidadesIguales(a: TrazabilidadCurricularPlaneacion, b: TrazabilidadCurricularPlaneacion): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

// PLN-1E-B — conversacionId: la MISMA que route.ts ya resuelve vía
// obtenerConversacionIdAutorizada() (ownership demostrado contra RLS
// antes de llegar aquí) — nunca un id que el cliente pueda inventar.
// null solo en los pocos caminos donde una conversación autorizada no
// existe (mismo criterio que el resto del proyecto) — en ese caso esta
// función simplemente no intenta leer ningún snapshot V4 y usa el
// comportamiento histórico completo, sin ningún cambio.
export async function aprobarBorradorPlaneacion(
  sb: SupabaseClient,
  sesion: SesionContexto,
  historial: TurnoHistorial[],
  conversacionId: string | null
): Promise<ResultadoAprobacion> {
  if (!sesion.grupo_activo_id) {
    return { ok: false, codigo: 'GRUPO_NO_DISPONIBLE', mensaje: 'No tengo un grupo activo configurado para guardar la planeación.' }
  }

  // PLN-1E-B — fuente server-side de identidad curricular Y de
  // contenido completo definitivo cuando existe un snapshot V4 válido
  // para ESTA conversación y ESTE grupo. Como máximo 1 SELECT
  // adicional (RLS existente, mismo supabaseUser de siempre — nunca
  // service_role). NUNCA vuelve a resolver curricularmente: no importa
  // resolverCurricularPlaneacion.ts ni ninguna función de resolución —
  // solo LEE y valida la forma de lo que ya se validó y persistió
  // durante generación/ajuste (PLN-1D/PLN-1D1/PLN-1D2).
  //
  // Condiciones para confiar en el snapshot (todas obligatorias):
  // schemaVersion===4, estado==='borrador' (un snapshot 'implementada'
  // no aplica aquí — ver más abajo, PLN-1E-B nunca los usa ni los
  // crea), y contexto.grupoId === sesion.grupo_activo_id (invariante
  // multigrupo, mismo criterio ya usado en el resto del proyecto). Si
  // CUALQUIERA falla: NUNCA se reconstruye, NUNCA se busca otra
  // conversación — trazabilidadCurricularDeEsteTurno/contenidoCompletoDefinitivo
  // quedan null y el resto de la función sigue exactamente el
  // comportamiento histórico (fallback a historial/ResumenBorrador,
  // V1/V2/V3 incluidos).
  // PLN-1E-E — resumenDesdeSnapshotV4: el MISMO candidato ya leído y
  // validado arriba también trae, desde schemaVersion=1,
  // `borrador: ResumenBorrador` completo (ver CamposComunesPlaneacionActiva
  // en planeacionActiva.ts) — ya pasó por validarContenidoBorrador como
  // precondición de esPlaneacionActivaValida. Con un V4 válido para
  // esta conversación/grupo, ESTE es el ResumenBorrador definitivo:
  // extraerResumenBorrador(historial) deja de ser necesario y, sobre
  // todo, deja de ser CONFIABLE — el historial que manda el cliente
  // puede terminar en cualquier turno posterior (p.ej. el mensaje de
  // error de un intento de aprobación anterior, ver informe forense
  // PLN-1E-D), y extraerResumenBorrador solo mira el ÚLTIMO turno
  // assistant, sin recorrer hacia atrás. NUNCA se reconstruye ni se
  // vuelve a parsear nada aquí — es una lectura directa del mismo
  // objeto ya validado.
  let trazabilidadCurricularDeEsteTurno: TrazabilidadCurricularPlaneacion | null = null
  let contenidoCompletoDefinitivo: string | null = null
  let resumenDesdeSnapshotV4: ResumenBorrador | null = null
  if (conversacionId) {
    const { data: filaConversacion } = await sb.from('conversaciones_chat').select('planeacion_activa').eq('id', conversacionId).maybeSingle()
    const candidato = filaConversacion?.planeacion_activa
    if (candidato != null && esPlaneacionActivaValida(candidato) && candidato.schemaVersion === 4 && candidato.estado === 'borrador' && candidato.contexto.grupoId === sesion.grupo_activo_id) {
      trazabilidadCurricularDeEsteTurno = candidato.trazabilidadCurricular
      contenidoCompletoDefinitivo = candidato.contenidoCompleto
      resumenDesdeSnapshotV4 = candidato.borrador
      console.log(`[PLANEACION_GENERAR][aprobar] snapshot_v4_usado=true trazabilidad_presente=${!!candidato.trazabilidadCurricular} items=${candidato.trazabilidadCurricular?.items.length ?? 0}`)
    } else {
      console.log(`[PLANEACION_GENERAR][aprobar] snapshot_v4_usado=false candidato_presente=${candidato != null}`)
    }
  }

  // PLN-1E-E — precedencia: un V4 válido para esta conversación/grupo
  // SIEMPRE gana sobre el historial, sin importar qué haya en el
  // último turno assistant (ni tieneBloqueResumen se consulta en ese
  // caso). El fallback a extraerResumenBorrador(historial)/tieneBloqueResumen
  // — comportamiento histórico completo, sin ningún cambio — solo
  // corre cuando NO hay V4 válido (V1/V2/V3, sin snapshot, o snapshot
  // inválido/de otro grupo).
  const resumen = resumenDesdeSnapshotV4 ?? extraerResumenBorrador(historial)
  if (!resumen) {
    if (tieneBloqueResumen(historial)) {
      return { ok: false, codigo: 'BORRADOR_INCOMPLETO', mensaje: 'El borrador que tengo no está completo (le falta el nombre o las fechas) — pídeme que lo genere de nuevo antes de guardarlo.' }
    }
    return { ok: false, codigo: 'SIN_BORRADOR', mensaje: 'No encontré un borrador de planeación listo para guardar en esta conversación. ¿Quieres que prepare uno?' }
  }

  // Validación estructural determinista — nunca se persiste un
  // borrador incompleto, sin importar que el bloque de resumen se
  // haya podido extraer.
  const validacion = validarContenidoBorrador(resumen)
  if (!validacion.ok) {
    console.log(`[PLANEACION_GENERAR][aprobar] contenido incompleto: ${validacion.elementosFaltantes.join(', ')}`)
    return { ok: false, codigo: 'BORRADOR_INCOMPLETO', mensaje: validacion.mensaje }
  }

  try {
    const periodos = sesion.ciclo_escolar_id ? await periodosEvaluacionDelCiclo(sb, sesion.ciclo_escolar_id) : []
    const periodoActual = resolverPeriodoEvaluacionActual(periodos, sesion.fecha_actual)

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
      .select('id, evaluacion')
      .eq('planeacion_id', planeacionId)
      .maybeSingle()
    if (errorBusquedaProyecto) {
      console.error('[PLANEACION_GENERAR][aprobar] fallo verificando el proyecto existente:', errorBusquedaProyecto)
      return { ok: false, codigo: 'ERROR_GUARDADO', mensaje: MENSAJE_ERROR_GENERICO }
    }
    if (!proyectoPlaneacionExistente) {
      const { error: errorProyecto } = await sb.from('planeacion_proyectos').insert(construirProyecto(resumen, planeacionId))
      if (errorProyecto) {
        console.error('[PLANEACION_GENERAR][aprobar] fallo creando la relación:', errorProyecto)
        return { ok: false, codigo: 'ERROR_GUARDADO', mensaje: MENSAJE_ERROR_GENERICO }
      }
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
    } else {
      const camposFormativosValidos = resumen.camposFormativos.filter((c) => CAMPOS_FORMATIVOS_VALIDOS.has(c))
      const { data: proyectoSeguimiento, error: errorProyectoSeguimiento } = await sb
        .from('proyectos_seguimiento')
        .insert({
          grupo_id: sesion.grupo_activo_id,
          docente_id: sesion.docente_id,
          ciclo_escolar_id: sesion.ciclo_escolar_id,
          periodo_evaluacion_id: periodoActual?.id ?? null,
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
    const { data: perfil } = await sb.from('perfiles_docentes').select('*').eq('id', sesion.docente_id).single()
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
    type DocumentoGuardado = { nombre: string; url: string; tamano_bytes?: number; url_ver?: string }
    const evaluacionPrevia = (proyectoPlaneacionExistente as { evaluacion?: { documento_word?: DocumentoGuardado; documento_pdf?: DocumentoGuardado; trazabilidad_curricular?: TrazabilidadCurricularPlaneacion } } | null)?.evaluacion
    let documentoWord: DocumentoGuardado | null = evaluacionPrevia?.documento_word ?? null
    let documentoPdf: DocumentoGuardado | null = evaluacionPrevia?.documento_pdf ?? null
    if (!documentoWord || !documentoPdf) {
      try {
        // PLN-1E-B — prioridad al snapshot V4 (contenidoCompletoDefinitivo):
        // elimina la divergencia cliente/servidor detectada en
        // PLN-1E-A (el `historial` que manda el cliente refleja el
        // texto tal como se STREAMEÓ, ANTES de la sustitución
        // server-side de PLN-1D1/PLN-1D2 — el snapshot persistido, en
        // cambio, YA es el texto corregido). El historial sigue siendo
        // el único fallback cuando no hay V4 válido para este turno —
        // nunca al revés.
        const ultimoTurno = historial[historial.length - 1]
        const textoCompleto = contenidoCompletoDefinitivo ?? (ultimoTurno?.role === 'assistant' ? extraerTextoCompletoBorrador(ultimoTurno.content) : '')
        if (textoCompleto) {
          if (!documentoWord) {
            const generado = await ejecutarHerramientaDocumento('word', textoCompleto, perfil, null, sb, sesion.docente_id)
            documentoWord = { nombre: generado.nombre, url: generado.url, tamano_bytes: generado.tamanoBytes }
          }
          if (!documentoPdf) {
            const generado = await ejecutarHerramientaDocumento('pdf', textoCompleto, perfil, null, sb, sesion.docente_id)
            documentoPdf = { nombre: generado.nombre, url: generado.url, tamano_bytes: generado.tamanoBytes, url_ver: generado.urlVer }
          }
        } else {
          console.error('[PLANEACION_GENERAR][aprobar] Fase 4.5: no se encontró el texto completo del borrador en el historial — se omite Word/PDF definitivos')
        }
      } catch (e) {
        console.error('[PLANEACION_GENERAR][aprobar] Fase 4.5: fallo generando Word/PDF definitivos de la planeación (no bloquea la aprobación):', e)
      }
    }

    // PLN-1E-B — trazabilidad_curricular: metadata curricular
    // persistida TEMPORALMENTE dentro del JSONB `evaluacion` existente
    // por compatibilidad de esquema (0 migraciones) — NUNCA se trata
    // conceptualmente como información de evaluación, es la copia
    // exacta de snapshot.trazabilidadCurricular, nunca reconstruida
    // desde strings. Protección contra conflicto (retry/reintento):
    // si planeacion_proyectos YA tiene una trazabilidad persistida de
    // un intento anterior y la de este turno es DISTINTA, la existente
    // GANA — nunca se sobrescribe silenciosamente con una selección
    // curricular diferente (fail-closed ante conflicto de identidad).
    // Si la existente coincide exactamente (mismo retry real) o no
    // había ninguna todavía, se usa/conserva sin cambios.
    const trazabilidadCurricularExistente = evaluacionPrevia?.trazabilidad_curricular ?? null
    let trazabilidadCurricularFinal = trazabilidadCurricularExistente
    if (trazabilidadCurricularDeEsteTurno) {
      if (!trazabilidadCurricularExistente) {
        trazabilidadCurricularFinal = trazabilidadCurricularDeEsteTurno
      } else if (!trazabilidadesIguales(trazabilidadCurricularExistente, trazabilidadCurricularDeEsteTurno)) {
        console.warn('[PLANEACION_GENERAR][aprobar] conflicto de trazabilidad_curricular detectado (huella repetida con selección curricular distinta) — se conserva la ya persistida, nunca se sobrescribe silenciosamente')
      }
    }

    // Fase 5: vincular la hoja real y el documento real (si se logró
    // generar) dentro de planeacion_proyectos — único lugar del
    // vínculo, sin relación improvisada nueva. Objeto `evaluacion`
    // reconstruido EXPLÍCITAMENTE (mismo patrón ya existente para
    // documento_word/documento_pdf, nunca un PATCH jsonb parcial) para
    // que ninguna clave ya persistida (hoja_id, documento_word,
    // documento_pdf, trazabilidad_curricular) se pierda por accidente.
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
          ...(documentoWord ? { documento_word: documentoWord } : {}),
          ...(documentoPdf ? { documento_pdf: documentoPdf } : {}),
          ...(trazabilidadCurricularFinal ? { trazabilidad_curricular: trazabilidadCurricularFinal } : {}),
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
      hoja: { identificadorVisible: resultadoHoja.identificadorVisible, url: resultadoHoja.url, urlVer: resultadoHoja.urlVer },
      documentoPlaneacion: documentoWord && documentoPdf
        ? {
            word: { nombre: documentoWord.nombre, url: documentoWord.url, tamanoBytes: documentoWord.tamano_bytes },
            pdf: { nombre: documentoPdf.nombre, url: documentoPdf.url, tamanoBytes: documentoPdf.tamano_bytes, urlVer: documentoPdf.url_ver },
          }
        : null,
    }
  } catch (e) {
    console.error('[PLANEACION_GENERAR][aprobar] excepción no controlada:', e)
    return { ok: false, codigo: 'ERROR_GUARDADO', mensaje: MENSAJE_ERROR_GENERICO }
  }
}
