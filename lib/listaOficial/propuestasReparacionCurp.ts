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

import type { ResultadoComparacionListaOficial, AlumnoRosterListaOficial } from './matchingListaOficial'
import { validarEstructuraCurp } from '../motorContexto'

export type CandidatoReparacionCurp = {
  alumnoId: string
  alumnoNombre: string
  curpActual: string
  curpPropuesta: string
  origenMatch: 'nombre'
}

export type ResultadoPropuestasReparacionCurp = {
  candidatos: CandidatoReparacionCurp[]
  totalCurpDiferente: number
  totalNoAccionables: number
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

  for (const r of resultado.resultados) {
    if (r.categoriaDiff !== 'CURP_DIFERENTE') continue
    totalCurpDiferente += 1

    // Regla 2/3 — match EXACTO por nombre únicamente, nunca fuzzy; y
    // nombreConfianza='alta' exigido explícitamente aquí (V1-B no lo
    // condiciona para esta categoría).
    if (r.origenMatch !== 'nombre' || r.registro.nombreConfianza !== 'alta') {
      totalNoAccionables += 1
      continue
    }

    // Regla 4 — alumnoId real y presente en el roster que este mismo
    // llamador ya tiene en memoria.
    if (!r.alumnoId) {
      totalNoAccionables += 1
      continue
    }
    const alumnoActual = rosterPorId.get(r.alumnoId)
    if (!alumnoActual) {
      totalNoAccionables += 1
      continue
    }

    // Regla 5 — CURP actual debe existir y ser estructuralmente
    // inválida (el diagnóstico nuevo que V1-B nunca calcula).
    const curpActual = alumnoActual.curp
    if (!curpActual || !curpActual.trim()) {
      totalNoAccionables += 1
      continue
    }
    if (validarEstructuraCurp(curpActual).valido) {
      totalNoAccionables += 1
      continue
    }

    // Regla 6 — CURP nueva debe existir, ser legible, confianza alta y
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

    candidatos.push({
      alumnoId: r.alumnoId,
      alumnoNombre: alumnoActual.nombre,
      curpActual,
      curpPropuesta: curpNueva,
      origenMatch: 'nombre',
    })
  }

  return { candidatos, totalCurpDiferente, totalNoAccionables }
}
