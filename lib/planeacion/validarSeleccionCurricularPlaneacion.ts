// lib/planeacion/validarSeleccionCurricularPlaneacion.ts
//
// PLN-1C §8 — validación server-side OBLIGATORIA de lo que Claude
// devolvió en la línea PROGRAMA_ANALITICO_ITEMS (ver
// lib/planeacion/extraerBorrador.ts,
// ResumenBorrador.programaAnaliticoItemIdsPropuestos), ANTES de tratar
// esa identidad como real. Pura, 0 I/O: recibe el conjunto EXACTO de
// candidatos que de verdad se le ofreció a Claude este turno (nunca
// "todo el catálogo posible" — para MODO A eso es candidatosCerrados,
// para MODO B es candidatosDisponibles completo, ver route.ts) y los
// ids crudos que propuso.
//
// Fail-closed por diseño: cualquier id que no aparezca EXACTAMENTE en
// `candidatosOfrecidos` se rechaza — nunca se aproxima al "más
// parecido", nunca se acepta un id sintácticamente válido pero no
// ofrecido, nunca se acepta un id de otra versión (que, por
// construcción, nunca puede estar en candidatosOfrecidos: ver
// cargarCandidatosProgramaAnaliticoVigente en resolverCurricularPlaneacion.ts,
// que ya filtra por programa_analitico_version_id=vigente).

import type { CandidatoCurricularPlaneacion, PdaCandidatoPlaneacion } from './resolverCurricularPlaneacion'

export type MotivoRechazoItemCurricular = 'UUID_INVALIDO' | 'NO_OFRECIDO'

export type ItemCurricularRechazado = { idPropuesto: string; motivo: MotivoRechazoItemCurricular }

export type ResultadoValidacionSeleccionCurricular = {
  aceptados: CandidatoCurricularPlaneacion[]
  rechazados: ItemCurricularRechazado[]
}

const REGEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// `candidatosOfrecidos` debe ser EXACTAMENTE el conjunto que se le
// mostró a Claude este turno:
//   - MODO A: contexto.candidatosCerrados (el conjunto pequeño).
//   - MODO B: los candidatos cuyo id aparece en el catalogoCompacto
//     ofrecido (en la práctica, todos los candidatosDisponibles de esa
//     resolución — ver idsOfrecidos en resolverCurricularPlaneacion.ts).
// Pasar aquí un conjunto MÁS AMPLIO que el realmente ofrecido (p.ej.
// "todo el PA vigente" cuando en realidad se usó MODO A con un
// subconjunto) rompería la garantía de "nunca aceptar un id real del
// PA que no formaba parte del conjunto cerrado ofrecido" (PLN-1C §8,
// CASO I) — responsabilidad del llamador, documentada aquí porque esta
// función no tiene forma de verificarlo por sí sola.
export function validarSeleccionItemsProgramaAnalitico(candidatosOfrecidos: CandidatoCurricularPlaneacion[], idsPropuestos: string[]): ResultadoValidacionSeleccionCurricular {
  const porId = new Map(candidatosOfrecidos.map((c) => [c.programaAnaliticoItemId, c]))
  const aceptados: CandidatoCurricularPlaneacion[] = []
  const rechazados: ItemCurricularRechazado[] = []
  const vistos = new Set<string>()

  for (const idCrudo of idsPropuestos) {
    const id = idCrudo.trim()
    if (vistos.has(id)) continue // duplicado — no es un rechazo, simplemente no se repite
    vistos.add(id)

    if (!REGEX_UUID.test(id)) {
      rechazados.push({ idPropuesto: idCrudo, motivo: 'UUID_INVALIDO' })
      continue
    }
    const candidato = porId.get(id)
    if (!candidato) {
      // Cubre, con el MISMO mecanismo, tres casos distintos del
      // informe (§8/§13): id inventado que por azar tiene forma de
      // UUID, id real pero de OTRA versión (nunca puede estar en
      // candidatosOfrecidos porque este ya viene filtrado a la
      // versión vigente), e id real del PA pero fuera del conjunto
      // cerrado que se ofreció en MODO A.
      rechazados.push({ idPropuesto: idCrudo, motivo: 'NO_OFRECIDO' })
      continue
    }
    aceptados.push(candidato)
  }

  return { aceptados, rechazados }
}

// PLN-1C §6 — defensa reutilizable para validar PDA propuestos contra
// los PDA REALES de un item ya aceptado (candidato). Hoy (PLN-1C) el
// contrato de salida NO le pide a Claude que elija PDA individuales en
// MODO B (ver informe §I): cuando un item se acepta, sus PDA
// persistidos/mostrados se derivan siempre de item.pda completo, nunca
// de una selección de Claude. Esta función existe para cuando esa
// selección exista (MODO A ya trae PDA reales por candidato, y una
// futura fase podría pedir a Claude elegir un subconjunto) — nunca se
// deja sin uso silenciosamente: los tests de PLN-1C la ejercen
// directamente (CASO J/K).
export function validarPdaDeItemCurricular(item: CandidatoCurricularPlaneacion, curriculoPdaGradoIdsPropuestos: string[]): { aceptados: PdaCandidatoPlaneacion[]; rechazados: string[] } {
  const porId = new Map(item.pda.map((p) => [p.curriculoPdaGradoId, p]))
  const aceptados: PdaCandidatoPlaneacion[] = []
  const rechazados: string[] = []
  const vistos = new Set<string>()

  for (const idCrudo of curriculoPdaGradoIdsPropuestos) {
    const id = idCrudo.trim()
    if (vistos.has(id)) continue
    vistos.add(id)
    const pda = porId.get(id)
    if (!pda) {
      // Cubre tanto un PDA inventado como un PDA real pero de OTRO
      // contenido/item — ninguno de los dos aparece en item.pda.
      rechazados.push(idCrudo)
      continue
    }
    aceptados.push(pda)
  }

  return { aceptados, rechazados }
}
