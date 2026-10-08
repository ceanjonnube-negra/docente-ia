// lib/listaOficial/enriquecimientoIdentidad.ts
//
// V1-D2C1-B1 — read-model READ-ONLY para enriquecer operaciones
// ALUMNO_NUEVO (ver planActualizacionLista.ts, V1-D2C1-A) con
// candidatos de identidad entre los alumnos del MISMO docente, dentro
// de la MISMA institución, fuera del roster activo del grupo destino.
//
// Puro + 2 funciones de consulta de solo lectura — mismo patrón ya
// usado por lib/rosterGrupo.ts. 0 escritura, 0 RPC, 0 IA.
//
// Este módulo NUNCA decide identidad ni autoriza ninguna escritura:
// produce CANDIDATOS, no autorizaciones. Las reglas ya cerradas del
// diseño V1-D siguen vigentes sin excepción:
//   - nombre, posición y CURP dudosa NUNCA prueban identidad;
//   - nunca se fusiona alumnos.id ni se transfiere historial;
//   - nunca se modifica ninguna inscripción existente (0 UPDATE aquí);
//   - alta_persona, alta_inscripcion y baja requieren SIEMPRE
//     confirmación humana en una fase posterior — este módulo no las
//     produce, solo evidencia en qué podría basarse esa decisión.
//
// LIMITACIÓN RLS, documentada explícitamente (ver auditoría
// V1-D2C1-B0, sección C, y la revisión V1-D2C1-B1): la política de
// `inscripciones` autoriza visibilidad por PERTENENCIA DEL GRUPO
// (grupos.docente_id = auth.uid(), o grupo compartido vía
// docente_grupos — no usado por este módulo, ver "alcance" abajo),
// NUNCA simplemente porque el alumno pertenezca al docente. Por tanto:
//
//   0 filas de inscripciones visibles para un alumno NO significa
//   "0 inscripciones existen" — solo significa "0 inscripciones
//   visibles bajo las políticas RLS vigentes para este docente,
//   en este momento". Todo estado de este módulo es una OBSERVACIÓN
//   RLS-scoped, nunca una certeza institucional o global. La futura
//   RPC transaccional (SECURITY DEFINER) deberá comprobar el estado
//   completo y autorizado antes de escribir — este módulo nunca
//   sustituye esa revalidación.
//
// Alcance de autorización de grupo: igual que importar_alumnos_a_grupo
// hoy, solo propiedad DIRECTA del grupo — docente_grupos (grupos
// compartidos) queda deliberadamente fuera de alcance en esta fase.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { EvidenciaDocumentoAlumnoNuevo } from './planActualizacionLista'
import { validarEstructuraCurp } from '../motorContexto'

// ============================================================
// Tipos — read-model puro
// ============================================================

export type EstadoCandidatoIdentidad =
  | 'SIN_INSCRIPCION_VISIBLE_EN_DESTINO'
  | 'BAJA_HISTORICA_EN_DESTINO'
  | 'CAMBIO_ESCUELA_EN_DESTINO'
  | 'ACTIVA_EN_OTRO_GRUPO_MISMO_CICLO'
  | 'NO_ACTIVA_EN_OTRO_GRUPO_MISMO_CICLO'
  | 'OTRO_CICLO'
  | 'ACTIVA_EN_DESTINO'
  // Combinación que el esquema real no debería permitir (ver
  // auditoría V1-D2C1-B0 sección H: UNIQUE total alumno_id+
  // ciclo_escolar_id) pero que este módulo NUNCA asume imposible por
  // construcción — si las filas visibles contradicen esa invariante
  // (p. ej. 2+ filas para el mismo alumno+ciclo, o un estatus fuera
  // del CHECK conocido), se reporta ANOMALIA y nunca se elige una fila
  // arbitrariamente.
  | 'ANOMALIA'

export type CandidatoIdentidad = {
  alumnoId: string
  estado: EstadoCandidatoIdentidad
  // Presentes solo cuando hay exactamente una fila inequívoca que los
  // respalde (nunca en ANOMALIA, que por definición no tiene una fila
  // única que reportar).
  inscripcionId?: string
  grupoId?: string
  // Expresa ÚNICAMENTE que el UNIQUE total (alumno_id,
  // ciclo_escolar_id) de la base real impide crear una fila nueva para
  // este ciclo (ver V1-D2C1-B0 sección H). NO propone UPDATE, NO
  // propone reactivación, NO propone reutilizar inscripcionId — esas
  // decisiones siguen pendientes de una fase futura.
  bloqueadoPorRestriccionCiclo: boolean
}

export type ResultadoEnriquecimientoAlumnoNuevo = {
  // false si la evidencia documental no califica como candidata a
  // búsqueda (ver curpEsUtilizable) — misma fórmula ya definida en
  // matchingListaOficial.ts, nunca una segunda definición. Si es
  // false, candidatos siempre es [] y no se intentó ninguna búsqueda.
  curpUtilizable: boolean
  // Todos los alumnos propios cuya CURP normalizada coincide — nunca
  // se oculta ninguno, incluso cuando hay más de uno (ver
  // multiplesCoincidencias). [] significa "0 coincidencia entre los
  // alumnos propios visibles" — NUNCA "CURP libre en la institución"
  // (el gap cross-docente de V1-D2C1-B0 sección E/F/G sigue sin
  // resolverse; esta fase no lo cierra).
  candidatos: CandidatoIdentidad[]
  // true si candidatos.length > 1 — conflicto real entre alumnos
  // propios, nunca resuelto aquí, siempre requiere decisión humana.
  multiplesCoincidencias: boolean
}

export type AlumnoPropioConCurp = { id: string; curp: string }
export type InscripcionPropia = {
  id: string
  alumnoId: string
  grupoId: string
  cicloEscolarId: string
  estatus: string
}

export type DestinoEnriquecimiento = { grupoId: string; cicloEscolarId: string }

// ============================================================
// Normalización y utilizabilidad de CURP — misma regla ya definida en
// matchingListaOficial.ts (curpNormalizada/curpUtilizable), repetida
// aquí como el mismo one-liner trivial, siguiendo el MISMO precedente
// ya establecido en este proyecto por rosterFingerprint.ts
// (curpNormalizadaOrNull) — nunca una segunda implementación del
// ALGORITMO (que sigue viviendo únicamente en matchingListaOficial.ts
// y en validarEstructuraCurp, ambos reutilizados aquí tal cual).
// ============================================================

function normalizarCurpParaComparacion(curp: string): string {
  return curp.trim().toUpperCase()
}

// Misma composición exacta que curpUtilizable en
// matchingListaOficial.ts:105 — curpLeida existe, es legible,
// confianza alta, y estructuralmente válida. No se reimplementa el
// algoritmo de validarEstructuraCurp, solo se reutiliza importado.
function curpEsUtilizable(ev: EvidenciaDocumentoAlumnoNuevo): boolean {
  return !!ev.curpLeida && ev.curpLegible && ev.curpConfianza === 'alta' && validarEstructuraCurp(ev.curpLeida).valido
}

// ============================================================
// Clasificación pura — 0 Supabase, 0 IA, testable con fixtures.
// Conserva el orden de las evidencias recibidas: resultado[i]
// corresponde SIEMPRE a evidencias[i] — misma convención posicional ya
// usada por compararListaOficial (registros[i] ↔ resultados[i]).
// Nunca se usa nombre ni CURP como identificador de operación: la
// correspondencia es exclusivamente por índice.
// ============================================================

function clasificarInscripcionParaAlumno(
  alumnoId: string,
  inscripciones: InscripcionPropia[],
  destino: DestinoEnriquecimiento
): Omit<CandidatoIdentidad, 'alumnoId'> {
  const filasDelAlumno = inscripciones.filter((i) => i.alumnoId === alumnoId)
  const filasEnCicloDestino = filasDelAlumno.filter((i) => i.cicloEscolarId === destino.cicloEscolarId)

  if (filasEnCicloDestino.length === 0) {
    const filasOtroCiclo = filasDelAlumno.filter((i) => i.cicloEscolarId !== destino.cicloEscolarId)
    if (filasOtroCiclo.length === 0) {
      return { estado: 'SIN_INSCRIPCION_VISIBLE_EN_DESTINO', bloqueadoPorRestriccionCiclo: false }
    }
    if (filasOtroCiclo.length === 1) {
      // Caso inequívoco — exactamente una fila histórica de otro ciclo,
      // se reporta tal cual (identificación mínima, nunca se carga el
      // historial completo del alumno).
      const referencia = filasOtroCiclo[0]
      return {
        estado: 'OTRO_CICLO',
        inscripcionId: referencia.id,
        grupoId: referencia.grupoId,
        bloqueadoPorRestriccionCiclo: false,
      }
    }
    // 2+ filas en ciclos distintos al destino — ver auditoría
    // V1-D2C1-B1 (hallazgo bloqueante corregido aquí): nunca se elige
    // ninguna arbitrariamente (ni por orden de llegada ni por ningún
    // otro criterio). Se reporta el estado SIN inscripcionId/grupoId —
    // mismo criterio que ya usa ANOMALIA cuando no hay una fila única
    // e inequívoca que señalar.
    return { estado: 'OTRO_CICLO', bloqueadoPorRestriccionCiclo: false }
  }

  if (filasEnCicloDestino.length > 1) {
    // Viola la invariante real de la base (UNIQUE total alumno_id+
    // ciclo_escolar_id, V1-D2C1-B0 sección H) — nunca debería ocurrir,
    // pero si ocurre, fail-closed total: nunca se elige ninguna fila.
    return { estado: 'ANOMALIA', bloqueadoPorRestriccionCiclo: true }
  }

  const fila = filasEnCicloDestino[0]
  const mismoGrupo = fila.grupoId === destino.grupoId

  if (mismoGrupo) {
    if (fila.estatus === 'activo') {
      return { estado: 'ACTIVA_EN_DESTINO', inscripcionId: fila.id, grupoId: fila.grupoId, bloqueadoPorRestriccionCiclo: true }
    }
    if (fila.estatus === 'baja') {
      return { estado: 'BAJA_HISTORICA_EN_DESTINO', inscripcionId: fila.id, grupoId: fila.grupoId, bloqueadoPorRestriccionCiclo: true }
    }
    if (fila.estatus === 'cambio_escuela') {
      return { estado: 'CAMBIO_ESCUELA_EN_DESTINO', inscripcionId: fila.id, grupoId: fila.grupoId, bloqueadoPorRestriccionCiclo: true }
    }
    // estatus fuera del CHECK conocido (activo|baja|cambio_escuela) —
    // nunca debería ocurrir; fail-closed defensivo.
    return { estado: 'ANOMALIA', bloqueadoPorRestriccionCiclo: true }
  }

  // Grupo distinto, mismo ciclo.
  if (fila.estatus === 'activo') {
    return { estado: 'ACTIVA_EN_OTRO_GRUPO_MISMO_CICLO', inscripcionId: fila.id, grupoId: fila.grupoId, bloqueadoPorRestriccionCiclo: true }
  }
  if (fila.estatus === 'baja' || fila.estatus === 'cambio_escuela') {
    return { estado: 'NO_ACTIVA_EN_OTRO_GRUPO_MISMO_CICLO', inscripcionId: fila.id, grupoId: fila.grupoId, bloqueadoPorRestriccionCiclo: true }
  }
  return { estado: 'ANOMALIA', bloqueadoPorRestriccionCiclo: true }
}

export function clasificarCandidatosIdentidad(
  evidencias: EvidenciaDocumentoAlumnoNuevo[],
  alumnosPropios: AlumnoPropioConCurp[],
  inscripciones: InscripcionPropia[],
  destino: DestinoEnriquecimiento
): ResultadoEnriquecimientoAlumnoNuevo[] {
  // Índice por CURP normalizada — construido una sola vez para todo el
  // lote, nunca recalculado por evidencia (evita cualquier forma de
  // N+1 dentro de esta función pura).
  const alumnoIdsPorCurpNormalizada = new Map<string, string[]>()
  for (const a of alumnosPropios) {
    if (!a.curp) continue
    const normalizada = normalizarCurpParaComparacion(a.curp)
    const existentes = alumnoIdsPorCurpNormalizada.get(normalizada) ?? []
    existentes.push(a.id)
    alumnoIdsPorCurpNormalizada.set(normalizada, existentes)
  }

  return evidencias.map((ev): ResultadoEnriquecimientoAlumnoNuevo => {
    if (!curpEsUtilizable(ev)) {
      return { curpUtilizable: false, candidatos: [], multiplesCoincidencias: false }
    }

    // curpEsUtilizable ya garantizó ev.curpLeida !== null.
    const normalizada = normalizarCurpParaComparacion(ev.curpLeida as string)
    const alumnoIds = alumnoIdsPorCurpNormalizada.get(normalizada) ?? []

    // Orden determinista por alumnoId — ver auditoría V1-D2C1-B1
    // (hallazgo bloqueante corregido aquí): alumnoIds hereda el orden
    // en que Supabase devolvió alumnosPropios (sin ORDER BY explícito,
    // nunca garantizado) — se ordena aquí por el propio alumnoId
    // (nunca por nombre ni CURP) para que el resultado no dependa del
    // orden de llegada. El orden es un criterio arbitrario pero FIJO
    // (comparación de cadena simple) — nunca se elimina ningún
    // duplicado, solo se reordena.
    const idsOrdenados = [...alumnoIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

    const candidatos: CandidatoIdentidad[] = idsOrdenados.map((alumnoId) => ({
      alumnoId,
      ...clasificarInscripcionParaAlumno(alumnoId, inscripciones, destino),
    }))

    return {
      curpUtilizable: true,
      candidatos,
      multiplesCoincidencias: candidatos.length > 1,
    }
  })
}

// ============================================================
// Interpretación de la respuesta de Supabase — pura, testable sin
// conexión real. Centraliza la regla "0 resultados parciales
// silenciosos": si el total real (count) excede el límite seguro, o
// si el conteo no pudo determinarse, se rechaza explícitamente en vez
// de devolver una página incompleta como si fuera el conjunto
// completo.
// ============================================================

export type ErrorConsultaIdentidad =
  | { tipo: 'ERROR_SUPABASE'; detalle: unknown }
  | { tipo: 'LIMITE_EXCEDIDO'; limite: number; total: number | null }
  // count es válido y está dentro del límite, pero no coincide con la
  // cantidad de filas realmente recibidas — respuesta inconsistente o
  // incompleta, nunca se acepta como si fuera el conjunto completo
  // (ver auditoría V1-D2C1-B1, hallazgo bloqueante corregido aquí).
  | { tipo: 'RESPUESTA_INCONSISTENTE'; count: number; recibidas: number }

export type ResultadoConsultaIdentidad<T> = { ok: true; data: T[] } | { ok: false; error: ErrorConsultaIdentidad }

export function interpretarRespuestaSupabase<T>(
  respuesta: { data: T[] | null; error: unknown; count: number | null },
  limite: number
): ResultadoConsultaIdentidad<T> {
  if (respuesta.error) {
    return { ok: false, error: { tipo: 'ERROR_SUPABASE', detalle: respuesta.error } }
  }
  // data=null NUNCA se convierte silenciosamente en [] — fail-closed:
  // un data=null sin error asociado es una respuesta anómala, nunca
  // "0 filas legítimas" (ver auditoría V1-D2C1-B1, hallazgo bloqueante
  // corregido aquí).
  if (respuesta.data === null) {
    return { ok: false, error: { tipo: 'ERROR_SUPABASE', detalle: 'Supabase devolvió data=null sin error asociado' } }
  }
  // count === null (el cliente no lo pudo calcular) se trata igual que
  // "excede el límite" — fail-closed: nunca se asume "no truncado" sin
  // saberlo con certeza.
  if (respuesta.count === null) {
    return { ok: false, error: { tipo: 'LIMITE_EXCEDIDO', limite, total: null } }
  }
  // respuesta.data.length > limite es una segunda defensa por si count
  // y data llegaran a divergir en el sentido de "más filas de las
  // esperadas".
  if (respuesta.count > limite || respuesta.data.length > limite) {
    return { ok: false, error: { tipo: 'LIMITE_EXCEDIDO', limite, total: respuesta.count } }
  }
  // count válido y dentro del límite, pero distinto de la cantidad
  // real de filas recibidas — nunca se acepta como completo.
  if (respuesta.data.length !== respuesta.count) {
    return { ok: false, error: { tipo: 'RESPUESTA_INCONSISTENTE', count: respuesta.count, recibidas: respuesta.data.length } }
  }
  return { ok: true, data: respuesta.data }
}

// ============================================================
// Consultas Supabase read-only — auth.supabase únicamente (RLS),
// nunca service_role, nunca RPC. 2 llamadas batch en total, sin
// importar cuántas operaciones ALUMNO_NUEVO se enriquezcan.
// ============================================================

// Límites defensivos — mismo criterio que el límite de 200 ya
// existente en importar_alumnos_a_grupo: muy por encima de cualquier
// docente real de educación básica, solo para acotar el costo de una
// consulta anómala. No introduce ninguna semántica de producto nueva.
export const LIMITE_ALUMNOS_PROPIOS = 500
export const LIMITE_INSCRIPCIONES = 2000

// Query 1 — alumnos propios con CURP no nula, de la institución
// autorizada. docenteId/institucionId deben haberse derivado
// server-side del grupo destino YA validado por el llamador (mismo
// patrón que comparar/route.ts) — esta función no revalida ownership,
// lo asume como precondición del caller, para no triplicar esa lógica.
export async function obtenerAlumnosPropiosConCurp(
  sb: SupabaseClient,
  params: { docenteId: string; institucionId: string }
): Promise<ResultadoConsultaIdentidad<AlumnoPropioConCurp>> {
  const respuesta = await sb
    .from('alumnos')
    .select('id, curp', { count: 'exact' })
    .eq('docente_id', params.docenteId)
    .eq('institucion_id', params.institucionId)
    .not('curp', 'is', null)
    .range(0, LIMITE_ALUMNOS_PROPIOS - 1)

  return interpretarRespuestaSupabase(
    respuesta as unknown as { data: AlumnoPropioConCurp[] | null; error: unknown; count: number | null },
    LIMITE_ALUMNOS_PROPIOS
  )
}

// Query 2 — inscripciones de los alumnos ya encontrados en la Query 1.
// Visibilidad real sujeta a la política RLS de `inscripciones` (ver
// comentario de cabecera): puede NO reflejar la totalidad de las
// inscripciones del alumno si alguna perteneciera a un grupo fuera de
// la autorización vigente del docente — observación RLS-scoped, nunca
// certeza completa.
export async function obtenerInscripcionesDeAlumnos(
  sb: SupabaseClient,
  alumnoIds: string[]
): Promise<ResultadoConsultaIdentidad<InscripcionPropia>> {
  if (alumnoIds.length === 0) {
    return { ok: true, data: [] }
  }
  // Defensa adicional antes de consultar: un llamador correcto nunca
  // debería pasar más de LIMITE_ALUMNOS_PROPIOS ids (ya acotados por
  // la Query 1), pero se verifica explícitamente en vez de asumirlo.
  if (alumnoIds.length > LIMITE_ALUMNOS_PROPIOS) {
    return { ok: false, error: { tipo: 'LIMITE_EXCEDIDO', limite: LIMITE_ALUMNOS_PROPIOS, total: alumnoIds.length } }
  }

  const respuesta = await sb
    .from('inscripciones')
    .select('id, alumno_id, grupo_id, ciclo_escolar_id, estatus', { count: 'exact' })
    .in('alumno_id', alumnoIds)
    .range(0, LIMITE_INSCRIPCIONES - 1)

  const interpretado = interpretarRespuestaSupabase(
    respuesta as unknown as {
      data: Array<{ id: string; alumno_id: string; grupo_id: string; ciclo_escolar_id: string; estatus: string }> | null
      error: unknown
      count: number | null
    },
    LIMITE_INSCRIPCIONES
  )

  if (!interpretado.ok) {
    return interpretado
  }

  return {
    ok: true,
    data: interpretado.data.map((fila) => ({
      id: fila.id,
      alumnoId: fila.alumno_id,
      grupoId: fila.grupo_id,
      cicloEscolarId: fila.ciclo_escolar_id,
      estatus: fila.estatus,
    })),
  }
}
