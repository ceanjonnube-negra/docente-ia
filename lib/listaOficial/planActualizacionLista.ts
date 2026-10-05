// lib/listaOficial/planActualizacionLista.ts
//
// V1-D1 — read-model determinista, puro (0 Supabase, 0 IA, 0 red),
// producido DESPUÉS de V1-A (extracción) + V1-B (matchingListaOficial,
// compararListaOficial) + la capa de propuestas de reparación de CURP
// (propuestasReparacionCurp.ts), y ANTES de cualquier escritura real —
// ver diseño aprobado "V1-D — ACTUALIZACIÓN SEGURA DE LISTA OFICIAL",
// sección G.
//
// Esta fase (V1-D1) SOLO construye el plan. Deliberadamente NO aplica
// nada, NO llama ninguna RPC, NO decide identidad por texto ambiguo —
// cada operación transporta únicamente IDs y valores ya resueltos por
// V1-B/la capa de reparación de CURP, nunca una decisión nueva.
//
// Regla central, repetida y obligatoria en todo el diseño aprobado:
// nombre exacto, formato explícito o fuzzy NUNCA autorizan por sí
// solos SIN_CAMBIOS ni ACTUALIZAR_DATOS — solo CURP exacta+válida+
// utilizable+única (origenMatch='curp', que por construcción de
// matchingListaOficial.ts SIEMPRE corresponde a categoriaDiff=
// 'SIN_CAMBIO', nunca a otra categoría) puede resolver una operación
// sin intervención humana. ACTUALIZAR_DATOS reutiliza EXACTAMENTE las
// mismas 2 vías ya construidas y ya probadas en producción —
// accionableV1 (CURP_FALTANTE_EN_DB vía nombre/formato exacto +
// confianza alta) y los candidatos de propuestasReparacionCurp.ts
// (CURP_DIFERENTE vía nombre/formato exacto + confianza alta + CURP
// actual inválida) — nunca una tercera regla nueva inventada aquí.
// Todo lo demás que no caiga en esas 2 vías cae en
// REQUIERE_CONFIRMACION, nunca se aproxima.

import type { ResultadoComparacionListaOficial, ResultadoMatchRegistro } from './matchingListaOficial'
import type { ResultadoPropuestasReparacionCurpPublico, CandidatoReparacionCurp } from './propuestasReparacionCurp'

// Señal tipada y discriminable (nunca comparación frágil de texto del
// mensaje) — ver auditoría "revisión técnica final V1-D1, hallazgo
// sección 1.7/10": comparacion.ausentesEnDocumento y roster deben
// derivar del MISMO roster real; si un alumnoId de ausentesEnDocumento
// no existe en el roster recibido, los dos insumos son internamente
// incompatibles entre sí — nunca un dato parcial o recuperable dentro
// de esta función pura (0 Supabase, nunca se intenta "completar" el
// roster consultando algo). construirPlanDeActualizacionLista debe
// fallar cerrado por completo (nunca devolver un plan con una
// operación RETIRAR_INSCRIPCION sin inscripcionId) — la única forma
// correcta de comunicar eso desde una función pura que no puede
// devolver un valor parcial es lanzar antes de regresar nada.
export class ErrorRosterIncompatibleParaPlanLista extends Error {}

export type CategoriaOperacionPlanLista =
  | 'SIN_CAMBIOS'
  | 'ACTUALIZAR_DATOS'
  | 'ALUMNO_NUEVO'
  | 'RETIRAR_INSCRIPCION'
  | 'REQUIERE_CONFIRMACION'
  | 'CONFLICTO_BLOQUEANTE'

// Único campo soportado hoy (mismo alcance real que
// reparar_curp_desde_lista_oficial) — aditivo: una fase futura que
// soporte nombre/sexo/fecha_nacimiento ampliaría esta unión sin
// romper ningún consumidor de las operaciones ya existentes.
export type CampoActualizablePlanLista = 'curp'

export type OperacionPlanLista = {
  categoria: CategoriaOperacionPlanLista
  // Ausente únicamente en ALUMNO_NUEVO (SIN_MATCH nunca resuelve un
  // alumnoId, ver matchingListaOficial.ts) — presente en todas las
  // demás categorías.
  alumnoId?: string
  // Presente SOLO en RETIRAR_INSCRIPCION — es el identificador que de
  // verdad exige dar_de_baja_inscripcion (p_inscripcion_id), nunca
  // alumnoId. No se resuelve para ninguna otra categoría: las
  // operaciones sobre `alumnos` (ACTUALIZAR_DATOS, y la propia
  // identificación de SIN_CAMBIOS) usan alumnoId, igual que ya hace
  // reparar_curp_desde_lista_oficial hoy. Garantizado presente en toda
  // operación RETIRAR_INSCRIPCION que de verdad llegue a existir —
  // construirPlanDeActualizacionLista lanza ErrorRosterIncompatibleParaPlanLista
  // en vez de devolver una con este campo undefined (sigue opcional a
  // nivel de tipo solo porque el resto de las categorías nunca lo
  // llevan, nunca porque pueda faltar dentro de un RETIRAR_INSCRIPCION
  // real).
  inscripcionId?: string
  campo?: CampoActualizablePlanLista
  // null explícito cuando el valor anterior es una ausencia real
  // (CURP_FALTANTE_EN_DB) — nunca confundido con "no aplica" (ausente
  // del objeto, categorías sin campo).
  valorActual?: string | null
  valorPropuesto?: string
  // Trazabilidad de CÓMO se llegó a esta categoría — nunca un criterio
  // de decisión para quien consuma el plan (esa decisión ya está
  // tomada en `categoria`).
  origenMatch?: ResultadoMatchRegistro['origenMatch']
}

export type PlanDeActualizacionLista = {
  grupoId: string
  // Huella determinista del roster activo usado para construir este
  // plan (ver lib/listaOficial/rosterFingerprint.ts) — una fase
  // posterior de aplicación la compara contra el roster real en ese
  // momento y rechaza el plan si ya no coincide (ver diseño aprobado,
  // sección J). Esta fase (V1-D1) solo la transporta; nunca la valida
  // ni la aplica.
  rosterFingerprint: string
  generadoEn: string
  operaciones: OperacionPlanLista[]
}

// Mínimo real que esta función necesita del roster — nunca el tipo
// completo de AlumnoConPosicion (lib/rosterGrupo.ts), para no atar
// este archivo a cada campo que esa función devuelva.
export type AlumnoRosterParaPlan = { id: string; inscripcionId: string }

function categorizarResultado(
  r: ResultadoMatchRegistro,
  candidatosReparacionPorAlumnoId: Map<string, CandidatoReparacionCurp>
): OperacionPlanLista {
  // Prioridad 1 — bloqueante, sin importar origenMatch: ambigüedad,
  // CURP ajena o documento duplicado NUNCA se resuelven aquí.
  if (r.categoriaDiff === 'MATCH_AMBIGUO' || r.categoriaDiff === 'CURP_DUPLICADA' || r.categoriaDiff === 'REGISTRO_DUPLICADO_EN_DOCUMENTO') {
    return { categoria: 'CONFLICTO_BLOQUEANTE', alumnoId: r.alumnoId, origenMatch: r.origenMatch }
  }

  // Prioridad 2 — SIN_MATCH/NUEVO_POSIBLE nunca lleva alumnoId (ver
  // matchingListaOficial.ts) — candidato de alta, siempre con
  // confirmación humana en una fase posterior.
  if (r.categoriaDiff === 'NUEVO_POSIBLE') {
    return { categoria: 'ALUMNO_NUEVO' }
  }

  // A partir de aquí, categoriaDiff es SIN_CAMBIO | CURP_FALTANTE_EN_DB
  // | CURP_DIFERENTE | LECTURA_DUDOSA — las 4 SIEMPRE llevan alumnoId
  // (solo se producen dentro de construirResultado, que exige un
  // candidato ya resuelto).

  // Única vía segura para SIN_CAMBIOS: origenMatch='curp' implica, por
  // construcción de matchingListaOficial.ts (candidatoPorCurp exige
  // curpUtilizable=true, que a su vez excluye LECTURA_DUDOSA, y la
  // igualdad de CURP ya resuelta excluye CURP_DIFERENTE/
  // CURP_FALTANTE_EN_DB), categoriaDiff==='SIN_CAMBIO' siempre — pero
  // se verifica explícitamente aquí también (defensa en profundidad,
  // nunca se asume ciegamente una invariante de otro módulo).
  if (r.origenMatch === 'curp') {
    if (r.categoriaDiff === 'SIN_CAMBIO') {
      return { categoria: 'SIN_CAMBIOS', alumnoId: r.alumnoId, origenMatch: 'curp' }
    }
    // Nunca debería alcanzarse dado lo anterior — fail-closed: si
    // alguna vez ocurriera, se trata como confirmación requerida,
    // nunca como un SIN_CAMBIOS forzado ni un error lanzado que
    // interrumpa el resto del plan.
    return { categoria: 'REQUIERE_CONFIRMACION', alumnoId: r.alumnoId, origenMatch: r.origenMatch }
  }

  // Vía 1 ya construida y en producción — accionableV1 (ver
  // matchingListaOficial.ts): origenMatch='nombre', nombreConfianza
  // alta, categoriaDiff==='CURP_FALTANTE_EN_DB', CURP leída utilizable.
  // Único caso donde el "valor actual" es una ausencia real.
  if (r.accionableV1) {
    return {
      categoria: 'ACTUALIZAR_DATOS',
      alumnoId: r.alumnoId,
      campo: 'curp',
      valorActual: null,
      valorPropuesto: r.registro.curpLeida ?? undefined,
      origenMatch: r.origenMatch,
    }
  }

  // Vía 2 ya construida y en producción —
  // clasificarPropuestasReparacionCurp (propuestasReparacionCurp.ts):
  // CURP_DIFERENTE vía nombre/formato exacto + confianza alta + CURP
  // actual estructuralmente inválida + CURP nueva válida. Nunca
  // reevalúa esas reglas aquí — solo consulta el resultado ya
  // calculado, en memoria, sin una segunda implementación.
  const candidato = r.alumnoId ? candidatosReparacionPorAlumnoId.get(r.alumnoId) : undefined
  if (candidato) {
    return {
      categoria: 'ACTUALIZAR_DATOS',
      alumnoId: r.alumnoId,
      campo: 'curp',
      valorActual: candidato.curpActual,
      valorPropuesto: candidato.curpPropuesta,
      origenMatch: r.origenMatch,
    }
  }

  // Todo lo demás — SIN_CAMBIO/CURP_DIFERENTE/CURP_FALTANTE_EN_DB vía
  // nombre/formato/fuzzy sin calificar para ninguna de las 2 vías de
  // arriba, y LECTURA_DUDOSA siempre — requiere confirmación humana.
  // Nunca se aproxima ni se fuerza una de las categorías automáticas.
  return { categoria: 'REQUIERE_CONFIRMACION', alumnoId: r.alumnoId, origenMatch: r.origenMatch }
}

export function construirPlanDeActualizacionLista(params: {
  grupoId: string
  rosterFingerprint: string
  generadoEn: string
  comparacion: ResultadoComparacionListaOficial
  propuestasReparacionCurp: ResultadoPropuestasReparacionCurpPublico
  roster: AlumnoRosterParaPlan[]
}): PlanDeActualizacionLista {
  const candidatosReparacionPorAlumnoId = new Map(params.propuestasReparacionCurp.candidatos.map((c) => [c.alumnoId, c]))
  const inscripcionIdPorAlumnoId = new Map(params.roster.map((a) => [a.id, a.inscripcionId]))

  const operacionesDesdeResultados = params.comparacion.resultados.map((r) => categorizarResultado(r, candidatosReparacionPorAlumnoId))

  // Ausentes — siempre RETIRAR_INSCRIPCION, nunca ejecutado
  // automáticamente por esta función (solo construye el plan; la
  // decisión de aplicar vive exclusivamente en una fase posterior con
  // confirmación humana explícita, ver diseño aprobado sección L).
  // inscripcionId se resuelve del MISMO roster ya recibido — nunca una
  // segunda consulta — porque dar_de_baja_inscripcion exige
  // p_inscripcion_id, no alumnoId.
  //
  // Invariante obligatorio (ver ErrorRosterIncompatibleParaPlanLista):
  // toda operación RETIRAR_INSCRIPCION debe llevar alumnoId E
  // inscripcionId simultáneamente — nunca uno sin el otro. Si
  // inscripcionIdPorAlumnoId no resuelve un alumnoId que SÍ viene en
  // ausentesEnDocumento, eso significa que `comparacion` y `roster` no
  // derivan del mismo roster real — fail-closed total: se lanza ANTES
  // de que .map() complete, así que construirPlanDeActualizacionLista
  // nunca llega a su `return` y nunca existe un PlanDeActualizacionLista
  // parcial. Nunca se ignora la fila, nunca se inventa un inscripcionId,
  // nunca se consulta Supabase para "completar" el dato faltante.
  const operacionesDesdeAusentes: OperacionPlanLista[] = params.comparacion.ausentesEnDocumento.map((a) => {
    const inscripcionId = inscripcionIdPorAlumnoId.get(a.alumnoId)
    if (inscripcionId === undefined) {
      throw new ErrorRosterIncompatibleParaPlanLista(
        `El alumno ${a.alumnoId} aparece en comparacion.ausentesEnDocumento pero no existe en el roster recibido por construirPlanDeActualizacionLista — comparacion y roster deben derivar del mismo roster real.`
      )
    }
    return { categoria: 'RETIRAR_INSCRIPCION' as const, alumnoId: a.alumnoId, inscripcionId }
  })

  return {
    grupoId: params.grupoId,
    rosterFingerprint: params.rosterFingerprint,
    generadoEn: params.generadoEn,
    operaciones: [...operacionesDesdeResultados, ...operacionesDesdeAusentes],
  }
}
