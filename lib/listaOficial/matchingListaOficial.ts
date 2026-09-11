// lib/listaOficial/matchingListaOficial.ts
//
// V1-B — matching + diff 100% determinista contra el roster real del
// grupo. Puro: no llama IA, no toca Supabase, no decide nada sobre
// escritura. El LLM (V1-A) SOLO transcribió; aquí el código, nunca un
// modelo, decide a qué alumno corresponde cada fila y qué categoría de
// diferencia representa.
//
// Reutiliza las primitivas REALES ya existentes en el proyecto — nunca
// una segunda implementación:
//   - normalizarNombre/calcularSimilitud de lib/emparejarAlumno.ts
//     (verificado antes de este cambio: solo tenían imports de tipo,
//     ningún archivo del proyecto importaba desde lib/listaOficial
//     todavía, así que exportarlas no introduce dependencia circular
//     ni cambia ningún caller existente — se les agregó `export` sin
//     tocar su implementación).
//   - validarEstructuraCurp de lib/motorContexto.ts (misma
//     verificación: solo imports de tipo, DIAS_POR_MES/
//     ENTIDADES_CURP_VALIDAS siguen siendo privadas del módulo — una
//     función exportada puede seguir usando constantes privadas del
//     mismo archivo sin exportarlas también).

import type { RegistroExtraidoListaOficial } from './analisisListaOficial'
import { normalizarNombre, calcularSimilitud } from '../emparejarAlumno'
import { validarEstructuraCurp } from '../motorContexto'

export type AlumnoRosterListaOficial = {
  id: string
  nombre: string
  curp: string | null
}

export type EstadoMatchListaOficial = 'MATCH_EXACTO' | 'MATCH_PROBABLE' | 'MATCH_AMBIGUO' | 'SIN_MATCH'

export type CategoriaDiffListaOficial =
  | 'SIN_CAMBIO'
  | 'CURP_FALTANTE_EN_DB'
  | 'CURP_DIFERENTE'
  | 'LECTURA_DUDOSA'
  | 'MATCH_AMBIGUO'
  | 'NUEVO_POSIBLE'
  | 'CURP_DUPLICADA'
  // Distinta de CURP_DUPLICADA (esa es "la CURP leída pertenece a OTRO
  // alumno del roster"): esta es "dos o más filas del documento
  // terminaron asociadas al MISMO alumno" — invariante uno-a-uno
  // documento↔alumno, aplicado en compararListaOficial DESPUÉS del
  // matching individual, nunca decidido por orden de aparición.
  | 'REGISTRO_DUPLICADO_EN_DOCUMENTO'

export type ResultadoMatchRegistro = {
  registro: RegistroExtraidoListaOficial
  estadoMatch: EstadoMatchListaOficial
  alumnoId?: string
  alumnoNombre?: string
  similitudTop1?: number
  similitudTop2?: number
  margen?: number
  categoriaDiff: CategoriaDiffListaOficial
  accionableV1: boolean
  // Trazabilidad interna de CÓMO se llegó al match — no es
  // estrictamente parte del contrato pedido, pero hace auditable (y
  // defendible en código, no solo "por construcción lógica") que
  // accionableV1 nunca puede ser true salvo por match de nombre
  // exacto — ver la sección de política de acción V1.
  origenMatch?: 'curp' | 'nombre' | 'fuzzy'
}

export type ResultadoComparacionListaOficial = {
  resultados: ResultadoMatchRegistro[]
  ausentesEnDocumento: Array<{ alumnoId: string; alumnoNombre: string }>
}

const UMBRAL_SIMILITUD = 0.72
const MARGEN_MINIMO_NO_AMBIGUO = 0.15

type CandidatoRoster = { alumno: AlumnoRosterListaOficial; nombreNormalizado: string }

function curpNormalizada(curp: string): string {
  return curp.trim().toUpperCase()
}

function compararUnRegistro(registro: RegistroExtraidoListaOficial, roster: CandidatoRoster[]): ResultadoMatchRegistro {
  // curpUtilizable: única puerta de entrada para CUALQUIER uso real de
  // la CURP leída (matching por CURP y decisión de diff) — fail-closed
  // por diseño: basta que falte legibilidad, confianza alta, o
  // estructura válida (validarEstructuraCurp real, importada) para que
  // la CURP leída se trate como no utilizable, nunca como "casi
  // utilizable".
  const curpLeida = registro.curpLeida ? curpNormalizada(registro.curpLeida) : null
  const curpUtilizable = !!curpLeida && registro.curpLegible && registro.curpConfianza === 'alta' && validarEstructuraCurp(curpLeida).valido

  const coincidenciasPorCurp = curpUtilizable && curpLeida ? roster.filter((c) => c.alumno.curp && curpNormalizada(c.alumno.curp) === curpLeida) : []

  // PRIORIDAD A, siempre primero, sin excepción — regla L: la misma
  // CURP en más de un alumno del roster NUNCA produce un match
  // automático, aunque el nombre pareciera ayudar a desempatar.
  if (coincidenciasPorCurp.length > 1) {
    return { registro, estadoMatch: 'MATCH_AMBIGUO', categoriaDiff: 'MATCH_AMBIGUO', accionableV1: false }
  }

  const candidatoPorCurp = coincidenciasPorCurp[0]?.alumno
  const nombreLeidoNormalizado = registro.nombreLeido ? normalizarNombre(registro.nombreLeido) : null
  const coincidenciasPorNombre = nombreLeidoNormalizado ? roster.filter((c) => c.nombreNormalizado === nombreLeidoNormalizado) : []

  // PRIORIDAD A (continuación) — una CURP única y utilizable GANA de
  // inmediato. Un nombre compartido por varios alumnos del roster deja
  // de importar aquí: no es evidencia en contra de un match ya
  // resuelto sin ambigüedad por CURP. Solo se trata como conflicto
  // real cuando el nombre resuelve a EXACTAMENTE un alumno y ese
  // alumno es distinto del que ya identificó la CURP — ahí sí hay
  // evidencia incompatible real (sección "duplicidad").
  if (candidatoPorCurp) {
    if (coincidenciasPorNombre.length === 1 && coincidenciasPorNombre[0].alumno.id !== candidatoPorCurp.id) {
      const alumnoConflicto = coincidenciasPorNombre[0].alumno
      return {
        registro,
        estadoMatch: 'MATCH_EXACTO',
        alumnoId: alumnoConflicto.id,
        alumnoNombre: alumnoConflicto.nombre,
        categoriaDiff: 'CURP_DUPLICADA',
        accionableV1: false,
        origenMatch: 'nombre',
      }
    }
    return construirResultado(registro, 'MATCH_EXACTO', candidatoPorCurp, curpLeida, curpUtilizable, roster, 'curp')
  }

  // PRIORIDAD B — sin CURP que resuelva, decide el nombre. Aquí SÍ
  // importa la duplicidad de nombre (regla K): sin una CURP que
  // desempate, dos alumnos con el mismo nombre normalizado son
  // ambiguos de verdad.
  if (coincidenciasPorNombre.length > 1) {
    return { registro, estadoMatch: 'MATCH_AMBIGUO', categoriaDiff: 'MATCH_AMBIGUO', accionableV1: false }
  }
  if (coincidenciasPorNombre.length === 1) {
    return construirResultado(registro, 'MATCH_EXACTO', coincidenciasPorNombre[0].alumno, curpLeida, curpUtilizable, roster, 'nombre')
  }

  // PRIORIDAD C — fuzzy, solo si no hubo ningún match exacto y hay
  // nombre que comparar.
  if (!nombreLeidoNormalizado || roster.length === 0) {
    return { registro, estadoMatch: 'SIN_MATCH', categoriaDiff: 'NUEVO_POSIBLE', accionableV1: false }
  }

  const puntuados = roster
    .map((c) => ({ candidato: c, score: calcularSimilitud(nombreLeidoNormalizado, c.nombreNormalizado) }))
    .sort((a, b) => b.score - a.score)

  const top1 = puntuados[0]
  const top2 = puntuados[1]
  const similitudTop1 = top1.score
  const similitudTop2 = top2?.score ?? 0
  const margen = similitudTop1 - similitudTop2

  if (similitudTop1 < UMBRAL_SIMILITUD) {
    return { registro, estadoMatch: 'SIN_MATCH', categoriaDiff: 'NUEVO_POSIBLE', accionableV1: false, similitudTop1, similitudTop2, margen }
  }
  if (margen < MARGEN_MINIMO_NO_AMBIGUO) {
    return { registro, estadoMatch: 'MATCH_AMBIGUO', categoriaDiff: 'MATCH_AMBIGUO', accionableV1: false, similitudTop1, similitudTop2, margen }
  }

  const resultadoFuzzy = construirResultado(registro, 'MATCH_PROBABLE', top1.candidato.alumno, curpLeida, curpUtilizable, roster, 'fuzzy')
  return { ...resultadoFuzzy, similitudTop1, similitudTop2, margen }
}

// Único punto donde se decide categoriaDiff/accionableV1 una vez que
// YA se tiene un candidato no ambiguo (MATCH_EXACTO o MATCH_PROBABLE)
// — nunca duplica esta decisión en los puntos de llamada de arriba.
function construirResultado(
  registro: RegistroExtraidoListaOficial,
  estadoMatch: 'MATCH_EXACTO' | 'MATCH_PROBABLE',
  alumno: AlumnoRosterListaOficial,
  curpLeida: string | null,
  curpUtilizable: boolean,
  roster: CandidatoRoster[],
  origenMatch: 'curp' | 'nombre' | 'fuzzy'
): ResultadoMatchRegistro {
  const base = { registro, estadoMatch, alumnoId: alumno.id, alumnoNombre: alumno.nombre, origenMatch }

  // "LECTURA DUDOSA": cualquier CURP leída pero no utilizable
  // (ilegible, confianza no alta, o estructura inválida) hace el
  // registro dudoso — nunca se compara como si no existiera. Un
  // registro sin ninguna CURP leída (curpLeida null desde el origen)
  // también cae aquí: no hay base real para afirmar SIN_CAMBIO ni para
  // proponer nada — fail-closed, nunca se asume "sin cambios" por
  // ausencia de dato.
  if (registro.curpLeida && !curpUtilizable) {
    return { ...base, categoriaDiff: 'LECTURA_DUDOSA', accionableV1: false }
  }
  if (!curpLeida) {
    return { ...base, categoriaDiff: 'LECTURA_DUDOSA', accionableV1: false }
  }

  // Duplicidad — respaldo defensivo: el caso real (nombre exacto a A,
  // CURP perteneciente de verdad a B, o CURP única a A con nombre
  // duplicado) ya se resuelve ANTES de llegar aquí, en
  // compararUnRegistro. Esta comprobación nunca debería activarse dado
  // cómo se llama esta función hoy, pero si algún cambio futuro
  // alterara esos puntos de llamada, sigue impidiendo que una CURP
  // ajena se trate como CURP_FALTANTE_EN_DB o CURP_DIFERENTE en vez de
  // como conflicto.
  const perteneceAOtro = roster.some((c) => c.alumno.id !== alumno.id && c.alumno.curp && curpNormalizada(c.alumno.curp) === curpLeida)
  if (perteneceAOtro) {
    return { ...base, categoriaDiff: 'CURP_DUPLICADA', accionableV1: false }
  }

  const curpEnDb = alumno.curp ? curpNormalizada(alumno.curp) : null
  let categoriaDiff: CategoriaDiffListaOficial
  if (!curpEnDb) {
    categoriaDiff = 'CURP_FALTANTE_EN_DB'
  } else if (curpEnDb === curpLeida) {
    categoriaDiff = 'SIN_CAMBIO'
  } else {
    categoriaDiff = 'CURP_DIFERENTE'
  }

  // Política de acción V1 — ÚNICA combinación accionable: match por
  // NOMBRE EXACTO (nunca por CURP ni fuzzy — un match por CURP jamás
  // podría producir CURP_FALTANTE_EN_DB por construcción, ya que
  // matchear por CURP exige que el alumno YA tenga esa CURP guardada;
  // este chequeo explícito es defensa en profundidad, no solo una
  // consecuencia lógica implícita), nombreConfianza alta,
  // categoriaDiff exactamente CURP_FALTANTE_EN_DB, y curpUtilizable ya
  // garantizado arriba (legible + confianza alta + estructura válida
  // real, vía validarEstructuraCurp importada).
  const accionableV1 = categoriaDiff === 'CURP_FALTANTE_EN_DB' && origenMatch === 'nombre' && registro.nombreConfianza === 'alta' && curpUtilizable

  return { ...base, categoriaDiff, accionableV1 }
}

// Invariante uno-a-uno documento↔alumno — se aplica DESPUÉS del
// matching individual (compararUnRegistro nunca la conoce ni la
// decide fila por fila), sobre el LOTE completo, y nunca usa orden de
// aparición: cuenta cuántos resultados no ambiguos (los únicos que
// llevan alumnoId — MATCH_AMBIGUO y SIN_MATCH nunca lo llevan) apuntan
// a cada alumno; si son 2 o más, TODOS esos resultados (sin excepción,
// sin elegir "el primero" ni "el más confiable") se sobrescriben a
// REGISTRO_DUPLICADO_EN_DOCUMENTO/accionableV1=false — nunca se borra
// el vínculo encontrado (estadoMatch/alumnoId/alumnoNombre/
// similitudes/origenMatch se preservan tal cual), solo se impide que
// se considere seguro para acción. Aplica igual sin importar la
// categoría previa (SIN_CAMBIO, CURP_FALTANTE_EN_DB, CURP_DIFERENTE,
// CURP_DUPLICADA...): dos filas del documento apuntando al mismo
// alumno es en sí mismo un conflicto de origen, independientemente de
// lo que cada fila individual haya calculado por su cuenta.
function aplicarInvarianteUnAlumnoUnaAccion(resultados: ResultadoMatchRegistro[]): ResultadoMatchRegistro[] {
  const conteoPorAlumno = new Map<string, number>()
  for (const r of resultados) {
    if (r.alumnoId) conteoPorAlumno.set(r.alumnoId, (conteoPorAlumno.get(r.alumnoId) ?? 0) + 1)
  }
  return resultados.map((r) => {
    if (r.alumnoId && (conteoPorAlumno.get(r.alumnoId) ?? 0) > 1) {
      return { ...r, categoriaDiff: 'REGISTRO_DUPLICADO_EN_DOCUMENTO', accionableV1: false }
    }
    return r
  })
}

export function compararListaOficial(registros: RegistroExtraidoListaOficial[], roster: AlumnoRosterListaOficial[]): ResultadoComparacionListaOficial {
  const candidatos: CandidatoRoster[] = roster.map((alumno) => ({ alumno, nombreNormalizado: normalizarNombre(alumno.nombre) }))

  const resultadosCrudos = registros.map((registro) => compararUnRegistro(registro, candidatos))
  const resultados = aplicarInvarianteUnAlumnoUnaAccion(resultadosCrudos)

  // ausentesEnDocumento — decisión explícita: un alumno cuenta como
  // "encontrado" (fuera de esta lista) si CUALQUIER resultado le
  // asignó alumnoId — eso incluye MATCH_EXACTO y MATCH_PROBABLE (este
  // último puede reportarse como asociado, aunque accionableV1 sea
  // siempre false para fuzzy) y también un resultado ya marcado
  // REGISTRO_DUPLICADO_EN_DOCUMENTO (el alumno SÍ aparece en el
  // documento, solo que más de una vez — no es lo mismo que estar
  // ausente). MATCH_AMBIGUO y SIN_MATCH nunca llevan alumnoId (ver
  // compararUnRegistro), así que estructuralmente nunca pueden quitar
  // a nadie de esta lista por una asociación que no existe de verdad.
  const idsMatcheados = new Set(resultados.filter((r) => r.alumnoId).map((r) => r.alumnoId as string))
  const ausentesEnDocumento = roster.filter((a) => !idsMatcheados.has(a.id)).map((a) => ({ alumnoId: a.id, alumnoNombre: a.nombre }))

  return { resultados, ausentesEnDocumento }
}
