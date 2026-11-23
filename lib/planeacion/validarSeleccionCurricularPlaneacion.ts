// lib/planeacion/validarSeleccionCurricularPlaneacion.ts
//
// Validación server-side OBLIGATORIA de los identificadores curriculares
// que propone el modelo, ANTES de tratarlos como reales. Recuperado de
// test/images-v1 (PLN-1C §8) y generalizado a las dos fuentes (Programa
// Analítico y catálogo de la app). Pura, 0 I/O.
//
// Fail-closed: se rechaza todo id que no aparezca EXACTAMENTE en
// `candidatosOfrecidos` — nunca se aproxima al "más parecido". Como esos
// candidatos salen de la carga del grupo (cargarCandidatosCurricularesGrupo:
// su grado, su fase, su versión curricular y su PA vigente), un id
// inventado, de otro grupo, de otro grado o de otra versión nunca puede
// aceptarse.
//
// Responsabilidad del llamador: pasar el conjunto EXACTO que se ofreció
// al modelo (ResultadoContextoCurricularPlaneacion.candidatosOfrecidos),
// nunca uno más amplio.

import { normalizarTexto, type CandidatoCurricularPlaneacion, type PdaCandidatoPlaneacion } from './resolverCurricularPlaneacion'

export type MotivoRechazoItemCurricular = 'UUID_INVALIDO' | 'NO_OFRECIDO'

export type ItemCurricularRechazado = { idPropuesto: string; motivo: MotivoRechazoItemCurricular }

export type ResultadoValidacionSeleccionCurricular = {
  aceptados: CandidatoCurricularPlaneacion[]
  rechazados: ItemCurricularRechazado[]
}

const REGEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function validarSeleccionCurricular(candidatosOfrecidos: CandidatoCurricularPlaneacion[], idsPropuestos: string[]): ResultadoValidacionSeleccionCurricular {
  const porId = new Map(candidatosOfrecidos.map((c) => [c.id.toLowerCase(), c]))
  const aceptados: CandidatoCurricularPlaneacion[] = []
  const rechazados: ItemCurricularRechazado[] = []
  const vistos = new Set<string>()

  for (const idCrudo of idsPropuestos) {
    const id = idCrudo.trim().toLowerCase()
    if (!id || vistos.has(id)) continue // vacío o repetido: no es un rechazo
    vistos.add(id)
    if (!REGEX_UUID.test(id)) {
      rechazados.push({ idPropuesto: idCrudo, motivo: 'UUID_INVALIDO' })
      continue
    }
    const candidato = porId.get(id)
    if (!candidato) {
      rechazados.push({ idPropuesto: idCrudo, motivo: 'NO_OFRECIDO' })
      continue
    }
    aceptados.push(candidato)
  }
  return { aceptados, rechazados }
}

// PDA propuestos contra los PDA REALES de un contenido ya aceptado. Un
// PDA inventado o de otro contenido nunca aparece en item.pda.
export function validarPdaDeItemCurricular(item: CandidatoCurricularPlaneacion, idsPdaPropuestos: string[]): { aceptados: PdaCandidatoPlaneacion[]; rechazados: string[] } {
  const porId = new Map(item.pda.map((p) => [p.id.toLowerCase(), p]))
  const aceptados: PdaCandidatoPlaneacion[] = []
  const rechazados: string[] = []
  const vistos = new Set<string>()
  for (const idCrudo of idsPdaPropuestos) {
    const id = idCrudo.trim().toLowerCase()
    if (!id || vistos.has(id)) continue
    vistos.add(id)
    const pda = porId.get(id)
    if (pda) aceptados.push(pda)
    else rechazados.push(idCrudo)
  }
  return { aceptados, rechazados }
}

// Reconocimiento POR TEXTO de lo que un borrador tomó del catálogo: el
// modelo nunca escribe identificadores; copia los textos. Una entrada
// cuenta como del catálogo solo si su texto normalizado (sin acentos,
// mayúsculas ni puntuación) es IGUAL al de un contenido de
// `candidatos` — nunca por parecido. Los PDA cuentan solo si son PDA
// reales de un contenido reconocido. Puro, 0 I/O; `candidatos` siempre
// sale de la base de datos (cargarCandidatosCurricularesGrupo), nunca del
// texto ni del cliente.
export type EntradaCurricular = { tipo: 'contenido' | 'pda'; texto: string }

export function reconocerCandidatosPorTexto(candidatos: CandidatoCurricularPlaneacion[], entradas: EntradaCurricular[]): { aceptados: CandidatoCurricularPlaneacion[]; noReconocidas: EntradaCurricular[] } {
  const porTexto = new Map<string, CandidatoCurricularPlaneacion>()
  for (const c of candidatos) {
    for (const t of [c.tituloContenido, c.textoContextualizado, c.textoLocal]) {
      const n = t ? normalizarTexto(t) : ''
      if (n && !porTexto.has(n)) porTexto.set(n, c)
    }
  }
  const aceptados: CandidatoCurricularPlaneacion[] = []
  const pendientes: EntradaCurricular[] = []
  for (const e of entradas) {
    const c = e.tipo === 'contenido' ? porTexto.get(normalizarTexto(e.texto)) : undefined
    if (c) {
      if (!aceptados.includes(c)) aceptados.push(c)
    } else pendientes.push(e)
  }
  const pdaReconocidos = new Set(aceptados.flatMap((c) => c.pda.map((p) => normalizarTexto(p.texto))))
  return { aceptados, noReconocidas: pendientes.filter((e) => !(e.tipo === 'pda' && pdaReconocidos.has(normalizarTexto(e.texto)))) }
}
