// lib/listaOficial/propuestasReparacionCurp.ts
//
// Capa POSTERIOR a V1-B, fuera de matchingListaOficial.ts — clasifica
// algunos resultados CURP_DIFERENTE ya producidos por compararListaOficial
// como CANDIDATO_REPARACION_CURP o NO_ACCIONABLE. Pura y determinista:
// no llama IA, no toca Supabase, no muta nada, no duplica ninguna regla
// de matching (nunca reevalúa nombre/similitud/ambigüedad — eso ya lo
// decidió V1-B). Solo agrega UN diagnóstico nuevo que V1-B nunca calcula:
// si la CURP ACTUAL del alumno en el roster es estructuralmente inválida.
//
// Ver auditoría aprobada "arquitectura de reparación de CURP histórica":
// V1-B sigue siendo el motor neutral de comparación — esta función nunca
// se importa desde matchingListaOficial.ts ni le agrega parámetros.
//
// Política deliberadamente conservadora (perder automatización antes que
// arriesgar identidad): exige match EXACTO por nombre (nunca fuzzy),
// nombreConfianza='alta' (V1-B no lo exige para CURP_DIFERENTE por sí
// solo — este archivo lo añade como requisito extra), CURP actual
// estructuralmente inválida, y CURP nueva utilizable (legible + confianza
// alta + estructura válida) — reconfirmado aquí como defensa en
// profundidad aunque V1-B ya lo garantiza para cualquier CURP_DIFERENTE.
//
// Instrumentación temporal (ver auditoría aprobada "embudo diagnóstico
// CURP_DIFERENTE → 0 candidatos"): esta ronda agrega un objeto
// `diagnostico` puramente agregado (conteos y nombres de reglas, nunca
// nombres/CURPs/alumnoId/objetos de candidato) para medir en qué paso
// real se están perdiendo los 20 casos observados en la prueba E2E. NO
// cambia ninguna regla de clasificación: el bloque secuencial que decide
// `candidatos` es funcionalmente idéntico al de antes de esta ronda —
// solo se descompuso el chequeo combinado "origenMatch/nombreConfianza"
// en dos pasos sucesivos para poder medir cada uno por separado, sin
// alterar el resultado final (misma condición AND, mismo orden real).
// El objeto diagnóstico NUNCA se persiste, nunca se muestra en la UI,
// nunca se reenvía a ningún modelo — el endpoint solo puede imprimirlo
// en logs de servidor, siempre agregado.

import type { ResultadoComparacionListaOficial, AlumnoRosterListaOficial } from './matchingListaOficial'
import { validarEstructuraCurp } from '../motorContexto'

export type CandidatoReparacionCurp = {
  alumnoId: string
  alumnoNombre: string
  curpActual: string
  curpPropuesta: string
  origenMatch: 'nombre'
}

export type DiagnosticoPropuestasReparacionCurp = {
  totalCurpDiferente: number
  // Conteos INDEPENDIENTES — cada condición evaluada sobre TODOS los
  // CURP_DIFERENTE que tengan el dato necesario para evaluarla, sin
  // importar si ya fueron descartados por una condición anterior. Sirven
  // para ver el peso individual de cada regla, no el efecto acumulado.
  origenMatchExacto: number
  origenMatchNoExacto: number
  nombreConfianzaAlta: number
  nombreConfianzaNoAlta: number
  // Solo contabilizados entre los casos donde se pudo resolver
  // alumnoId → roster → curp actual (no todos los 20 necesariamente
  // llegan a tener este dato disponible).
  curpDbInvalida: number
  curpDbValida: number
  alumnoIdPresente: number
  alumnoIdAusente: number
  alumnoEncontradoEnRoster: number
  alumnoNoEncontradoEnRoster: number
  // No depende de resolver alumno — se evalúa sobre los 20 completos.
  curpNuevaValida: number
  curpNuevaInvalida: number
  // Embudo ACUMULATIVO — mismo orden real de validación de
  // clasificarPropuestasReparacionCurp, nunca reordenado para el
  // diagnóstico. Cada paso solo cuenta lo que sobrevivió al anterior.
  embudo: {
    totalCurpDiferente: number
    despuesOrigenMatchExacto: number
    despuesNombreConfianzaAlta: number
    despuesAlumnoIdYRoster: number
    despuesCurpDbInvalida: number
    despuesCurpNuevaValida: number
    candidatosFinales: number
  }
}

// INTERNO — lo que devuelve clasificarPropuestasReparacionCurp. Incluye
// `diagnostico` (instrumentación temporal, solo agregados/sin PII) para
// que el caller pueda loguearlo del lado servidor. NUNCA debe enviarse
// tal cual en una respuesta HTTP al cliente — para eso existe el
// contrato explícito ResultadoPropuestasReparacionCurpPublico, más abajo.
export type ResultadoPropuestasReparacionCurp = {
  candidatos: CandidatoReparacionCurp[]
  totalCurpDiferente: number
  totalNoAccionables: number
  diagnostico: DiagnosticoPropuestasReparacionCurp
}

// PÚBLICO / client-safe — exactamente lo que el endpoint debe enviar en
// la respuesta HTTP: sin `diagnostico`, sin ningún campo interno. Mismo
// contrato que la UI ya consumía antes de agregar la instrumentación.
export type ResultadoPropuestasReparacionCurpPublico = Omit<ResultadoPropuestasReparacionCurp, 'diagnostico'>

// Deriva el contrato público a partir del resultado interno — único
// punto que decide qué campos son seguros para el cliente, para que
// esa decisión no se repita/diverja en cada caller (hoy solo el
// endpoint de comparación, pero evita que un futuro caller olvide
// excluir `diagnostico` a mano).
export function aResultadoPublico(resultado: ResultadoPropuestasReparacionCurp): ResultadoPropuestasReparacionCurpPublico {
  return {
    candidatos: resultado.candidatos,
    totalCurpDiferente: resultado.totalCurpDiferente,
    totalNoAccionables: resultado.totalNoAccionables,
  }
}

export function clasificarPropuestasReparacionCurp(
  resultado: ResultadoComparacionListaOficial,
  roster: AlumnoRosterListaOficial[]
): ResultadoPropuestasReparacionCurp {
  // Mismo cliente en memoria que ya recibió el llamador — nunca una
  // segunda consulta, nunca una segunda fuente de verdad del roster.
  const rosterPorId = new Map(roster.map((a) => [a.id, a]))

  const candidatos: CandidatoReparacionCurp[] = []
  let totalCurpDiferente = 0
  let totalNoAccionables = 0

  const diag = {
    origenMatchExacto: 0,
    origenMatchNoExacto: 0,
    nombreConfianzaAlta: 0,
    nombreConfianzaNoAlta: 0,
    curpDbInvalida: 0,
    curpDbValida: 0,
    alumnoIdPresente: 0,
    alumnoIdAusente: 0,
    alumnoEncontradoEnRoster: 0,
    alumnoNoEncontradoEnRoster: 0,
    curpNuevaValida: 0,
    curpNuevaInvalida: 0,
    despuesOrigenMatchExacto: 0,
    despuesNombreConfianzaAlta: 0,
    despuesAlumnoIdYRoster: 0,
    despuesCurpDbInvalida: 0,
    despuesCurpNuevaValida: 0,
  }

  for (const r of resultado.resultados) {
    if (r.categoriaDiff !== 'CURP_DIFERENTE') continue
    totalCurpDiferente += 1

    // --- Conteos independientes (no afectan el flujo de decisión) ---
    if (r.origenMatch === 'nombre') diag.origenMatchExacto += 1
    else diag.origenMatchNoExacto += 1

    if (r.registro.nombreConfianza === 'alta') diag.nombreConfianzaAlta += 1
    else diag.nombreConfianzaNoAlta += 1

    if (r.alumnoId) diag.alumnoIdPresente += 1
    else diag.alumnoIdAusente += 1

    const alumnoParaDiagnostico = r.alumnoId ? rosterPorId.get(r.alumnoId) : undefined
    if (alumnoParaDiagnostico) diag.alumnoEncontradoEnRoster += 1
    else diag.alumnoNoEncontradoEnRoster += 1

    if (alumnoParaDiagnostico?.curp && alumnoParaDiagnostico.curp.trim()) {
      if (validarEstructuraCurp(alumnoParaDiagnostico.curp).valido) diag.curpDbValida += 1
      else diag.curpDbInvalida += 1
    }
    // Si no hay alumno resuelto o no tiene CURP, no se cuenta en ninguno
    // de los dos — no hay dato real que evaluar, nunca se aproxima.

    const curpNuevaParaDiagnostico = r.registro.curpLeida
    if (
      curpNuevaParaDiagnostico &&
      curpNuevaParaDiagnostico.trim() &&
      r.registro.curpLegible &&
      r.registro.curpConfianza === 'alta' &&
      validarEstructuraCurp(curpNuevaParaDiagnostico).valido
    ) {
      diag.curpNuevaValida += 1
    } else {
      diag.curpNuevaInvalida += 1
    }

    // --- Embudo real de decisión — MISMO orden y MISMA lógica final que
    // antes de esta ronda; el único cambio es descomponer el chequeo
    // combinado origenMatch+nombreConfianza en dos pasos sucesivos para
    // poder medir cada uno, sin alterar el resultado (misma condición
    // AND aplicada en el mismo punto de la secuencia). ---

    // Paso 1 — match EXACTO por nombre.
    if (r.origenMatch !== 'nombre') {
      totalNoAccionables += 1
      continue
    }
    diag.despuesOrigenMatchExacto += 1

    // Paso 2 — nombreConfianza='alta' (V1-B no lo exige para
    // CURP_DIFERENTE por sí solo — requisito extra de esta capa).
    if (r.registro.nombreConfianza !== 'alta') {
      totalNoAccionables += 1
      continue
    }
    diag.despuesNombreConfianzaAlta += 1

    // Paso 3 — alumnoId real y presente en el roster ya en memoria.
    if (!r.alumnoId) {
      totalNoAccionables += 1
      continue
    }
    const alumnoActual = rosterPorId.get(r.alumnoId)
    if (!alumnoActual) {
      totalNoAccionables += 1
      continue
    }
    diag.despuesAlumnoIdYRoster += 1

    // Paso 4 — CURP actual debe existir y ser estructuralmente inválida
    // (el diagnóstico nuevo que V1-B nunca calcula).
    const curpActual = alumnoActual.curp
    if (!curpActual || !curpActual.trim()) {
      totalNoAccionables += 1
      continue
    }
    if (validarEstructuraCurp(curpActual).valido) {
      totalNoAccionables += 1
      continue
    }
    diag.despuesCurpDbInvalida += 1

    // Paso 5 — CURP nueva debe existir, ser legible, confianza alta y
    // estructuralmente válida. CURP_DIFERENTE de V1-B ya lo garantiza
    // (curpUtilizable), pero se reconfirma aquí como defensa en
    // profundidad, nunca asumido ciegamente.
    const curpNueva = r.registro.curpLeida
    if (
      !curpNueva ||
      !curpNueva.trim() ||
      !r.registro.curpLegible ||
      r.registro.curpConfianza !== 'alta' ||
      !validarEstructuraCurp(curpNueva).valido
    ) {
      totalNoAccionables += 1
      continue
    }
    diag.despuesCurpNuevaValida += 1

    candidatos.push({
      alumnoId: r.alumnoId,
      alumnoNombre: alumnoActual.nombre,
      curpActual,
      curpPropuesta: curpNueva,
      origenMatch: 'nombre',
    })
  }

  const diagnostico: DiagnosticoPropuestasReparacionCurp = {
    totalCurpDiferente,
    origenMatchExacto: diag.origenMatchExacto,
    origenMatchNoExacto: diag.origenMatchNoExacto,
    nombreConfianzaAlta: diag.nombreConfianzaAlta,
    nombreConfianzaNoAlta: diag.nombreConfianzaNoAlta,
    curpDbInvalida: diag.curpDbInvalida,
    curpDbValida: diag.curpDbValida,
    alumnoIdPresente: diag.alumnoIdPresente,
    alumnoIdAusente: diag.alumnoIdAusente,
    alumnoEncontradoEnRoster: diag.alumnoEncontradoEnRoster,
    alumnoNoEncontradoEnRoster: diag.alumnoNoEncontradoEnRoster,
    curpNuevaValida: diag.curpNuevaValida,
    curpNuevaInvalida: diag.curpNuevaInvalida,
    embudo: {
      totalCurpDiferente,
      despuesOrigenMatchExacto: diag.despuesOrigenMatchExacto,
      despuesNombreConfianzaAlta: diag.despuesNombreConfianzaAlta,
      despuesAlumnoIdYRoster: diag.despuesAlumnoIdYRoster,
      despuesCurpDbInvalida: diag.despuesCurpDbInvalida,
      despuesCurpNuevaValida: diag.despuesCurpNuevaValida,
      candidatosFinales: candidatos.length,
    },
  }

  return { candidatos, totalCurpDiferente, totalNoAccionables, diagnostico }
}
