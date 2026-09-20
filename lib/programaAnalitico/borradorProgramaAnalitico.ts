// lib/programaAnalitico/borradorProgramaAnalitico.ts
//
// PA-4B — núcleo determinista de orquestación del Programa Analítico.
// Puro: sin I/O, sin IA, sin Supabase. Resuelve lo que la futura capa
// conversacional (Chat) necesitará antes de poder tocar nada: (1)
// distinguir una respuesta pedagógicamente informativa de una trivial,
// (2) representar el borrador pendiente con una identidad curricular
// fijada (nunca reconstruible contra otra versión silenciosamente),
// (3) operaciones estructuradas de edición (nunca interpretación de
// lenguaje natural — eso es responsabilidad de una capa futura), y (4)
// un resumen compacto sin imprimir el currículo completo.
//
// PA-4A (auditoría) concluyó explícitamente: NO transportar la
// propuesta completa cliente↔servidor; el cliente solo debe llevar una
// identidad/referencia opaca. La persistencia/reanudación real del
// borrador (dónde vive esa referencia) se resuelve en PA-4C — aquí
// solo se define el TIPO puro que esa persistencia futura guardaría.

import { randomUUID } from 'node:crypto'
import type { CatalogoCurricularCerrado } from './candidatosCurriculares'
import type { ItemPropuestaProgramaAnalitico, PropuestaProgramaAnalitico } from './tipos'

// Forma CRUDA que la IA propone (ver generarPropuestaProgramaAnalitico.ts
// — incorporarDeltasIa la produce a partir del JSON del modelo). Vive
// aquí, no allá, porque aplicarDeltasSobreBase/normalizarDecisionesIa
// (el núcleo determinista) no deben depender del módulo que sí llama a
// Anthropic — es el módulo de generación el que depende de este, nunca
// al revés.
export type DecisionDeltaIa =
  | { decision: 'excluir'; curriculoContenidoId: string }
  | { decision: 'contextualizar'; curriculoContenidoId: string; textoContextualizado: string; curriculoPdaGradoIdsSeleccionados?: string[] }
  | { decision: 'nuevo'; textoLocal: string; resultadoEsperadoLocal?: string | null }

export type ErrorAplicarDeltas =
  | { tipo: 'DELTA_CONTENIDO_DUPLICADO'; curriculoContenidoId: string }
  | { tipo: 'DELTA_CONTENIDO_NO_ENCONTRADO_EN_BASE'; curriculoContenidoId: string }

// ============================================================
// 1. Suficiencia de contexto pedagógico — barrera mínima, no un
//    clasificador lingüístico (PA-4B §2/§3).
// ============================================================

// Curada y explícita — mismo criterio que el resto del proyecto (ver
// lib/documentGen/nivelEducativo.ts): nunca un comparador de distancia
// aproximada genérico. Ya normalizadas (minúsculas, sin acentos).
const RESPUESTAS_TRIVIALES = new Set([
  '', 'si', 'ok', 'okay', 'dale', 'hazlo', 'normal', 'bien', 'claro', 'va', 'vale',
  'como tu quieras', 'como usted quiera', 'como quieras', 'tu decides', 'usted decide',
  'no se', 'cualquiera', 'lo que sea', 'esta bien', 'de acuerdo', 'adelante',
  'sigue', 'continua', 'segui', 'ninguna', 'ninguno', 'nada',
])

// Grado hablado + letra opcional ("4b", "4°b", "4to b", "cuarto b") —
// un identificador de grupo/grado NUNCA es, por sí solo, contexto
// pedagógico, aunque no sea trivial en el sentido de "sí"/"ok".
const REGEX_IDENTIFICADOR_GRUPO = /^(?:[1-6]|primero|segundo|tercero|cuarto|quinto|sexto)\s*(?:to|do|er|ro|vo)?\s*[a-z]?$/

// Umbral deliberadamente bajo — es SOLO una de tres señales (lista
// trivial + patrón de identificador + longitud), nunca la única
// barrera. Sube la certeza de que "cualquiera"/"como tú quieras"
// (fuera del umbral si fuera muy alto) sigan cubiertas por la lista
// explícita en vez de depender de un número mágico.
const LONGITUD_MINIMA_INFORMATIVA = 12

function normalizar(texto: string): string {
  return texto
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // acentos
    .replace(/[°º]/g, '')
    .replace(/\s+/g, ' ')
}

// Distingue una respuesta pedagógicamente informativa ("al grupo le
// cuesta comprender textos", "en la comunidad hay escasez de agua") de
// una trivial ("ok", "hazlo", "4°B") o vacía. Una decisión EXPLÍCITA
// de no ajustar nada ("no tengo nada que agregar, usa el currículo
// oficial tal cual") pasa esta función — es una decisión pedagógica
// real del docente, distinta de la ausencia de respuesta (PA-4B §3);
// no se infiere automáticamente, debe venir escrita por el docente.
export function contextoDocenteEsSuficiente(texto: string | null | undefined): boolean {
  if (!texto) return false
  const normalizado = normalizar(texto)
  if (normalizado.length === 0) return false
  if (RESPUESTAS_TRIVIALES.has(normalizado)) return false
  if (REGEX_IDENTIFICADOR_GRUPO.test(normalizado)) return false
  if (normalizado.length < LONGITUD_MINIMA_INFORMATIVA) return false
  return true
}

// ============================================================
// 2. Identidad curricular fijada + borrador puro (PA-4B §6).
// ============================================================

export type IdentidadCurricularFijada = {
  curriculoVersionId: string
  curriculoFaseId: string
  curriculoGradoId: string
}

// Forma NORMALIZADA/autoritativa de un delta — distinta de
// DecisionDeltaIa (la forma cruda que la IA propone, sin identidad
// técnica para "nuevo"). claveLocal de un "nuevo" se asigna AQUÍ,
// server-side, al incorporar — nunca depende de la posición en el
// array ni proviene de la IA (PA-4B §8).
export type DeltaBorrador =
  | { decision: 'excluir'; curriculoContenidoId: string }
  | { decision: 'contextualizar'; curriculoContenidoId: string; textoContextualizado: string; curriculoPdaGradoIdsSeleccionados?: string[] }
  | { decision: 'nuevo'; claveLocal: string; textoLocal: string; resultadoEsperadoLocal?: string | null }

// El borrador NUNCA guarda el catálogo curricular completo ni los
// items base — solo lo mínimo para reconstruir de forma determinista:
// grupoId + identidad curricular fijada (para recuperar la base
// server-side) + deltas vigentes.
export type BorradorProgramaAnalitico = {
  grupoId: string
  // Se crea UNA vez al nacer el borrador y nunca cambia por resumen,
  // ajuste, reconstrucción ni confirmación (PA-4B §11) — solo una
  // intención explícita de crear OTRO Programa Analítico/otra versión
  // produce otra key (responsabilidad de la capa que construye el
  // borrador, no de este módulo).
  idempotencyKey: string
  identidadCurricular: IdentidadCurricularFijada
  contextoDocente: string | null
  contextoNotas: string | null
  deltas: DeltaBorrador[]
}

export function crearBorrador(
  grupoId: string,
  identidadCurricular: IdentidadCurricularFijada,
  contextoDocente: string | null,
  contextoNotas: string | null
): BorradorProgramaAnalitico {
  return {
    grupoId,
    idempotencyKey: randomUUID(),
    identidadCurricular,
    contextoDocente,
    contextoNotas,
    deltas: [],
  }
}

// Convierte los deltas crudos de la IA (sin identidad técnica para
// "nuevo") a la forma normalizada del borrador, asignando claveLocal
// server-side — nunca la IA la propone, nunca depende del índice.
export function normalizarDecisionesIa(decisiones: DecisionDeltaIa[]): DeltaBorrador[] {
  return decisiones.map((d) => {
    if (d.decision === 'nuevo') {
      return { decision: 'nuevo', claveLocal: randomUUID(), textoLocal: d.textoLocal, resultadoEsperadoLocal: d.resultadoEsperadoLocal ?? null }
    }
    return d
  })
}

// ============================================================
// 3. Operaciones deterministas sobre el borrador (PA-4B §7/§9).
//    Reciben identidades YA resueltas — nunca interpretan lenguaje
//    natural (esa es responsabilidad de una capa conversacional
//    futura, fuera de alcance de PA-4B). Como máximo 1 delta vigente
//    por curriculoContenidoId — cada operación REEMPLAZA el delta
//    anterior sobre ese contenido en vez de acumularlo.
// ============================================================

function reemplazarDeltaDeContenido(deltas: DeltaBorrador[], curriculoContenidoId: string, nuevo: DeltaBorrador | null): DeltaBorrador[] {
  const sinExistente = deltas.filter((d) => d.decision === 'nuevo' || d.curriculoContenidoId !== curriculoContenidoId)
  return nuevo ? [...sinExistente, nuevo] : sinExistente
}

// Elimina cualquier delta (excluir/contextualizar) sobre ese
// contenido — el contenido vuelve a su forma de base (sin_ajuste, con
// todos sus PDA oficiales). Idempotente: si no había ningún delta,
// no-op seguro.
export function restaurarContenido(borrador: BorradorProgramaAnalitico, curriculoContenidoId: string): BorradorProgramaAnalitico {
  return { ...borrador, deltas: reemplazarDeltaDeContenido(borrador.deltas, curriculoContenidoId, null) }
}

// Alias explícito — misma operación, distinto nombre de dominio según
// el caso de uso ("elimina la contextualización" vs. "restaura el
// contenido excluido").
export const eliminarContextualizacion = restaurarContenido

export function excluirContenido(borrador: BorradorProgramaAnalitico, curriculoContenidoId: string): BorradorProgramaAnalitico {
  return { ...borrador, deltas: reemplazarDeltaDeContenido(borrador.deltas, curriculoContenidoId, { decision: 'excluir', curriculoContenidoId }) }
}

export function reemplazarContextualizacion(
  borrador: BorradorProgramaAnalitico,
  curriculoContenidoId: string,
  textoContextualizado: string,
  curriculoPdaGradoIdsSeleccionados?: string[]
): BorradorProgramaAnalitico {
  return {
    ...borrador,
    deltas: reemplazarDeltaDeContenido(borrador.deltas, curriculoContenidoId, {
      decision: 'contextualizar',
      curriculoContenidoId,
      textoContextualizado,
      curriculoPdaGradoIdsSeleccionados,
    }),
  }
}

// claveLocal se asigna AQUÍ, server-side, y se devuelve junto con el
// borrador actualizado para que la capa llamadora pueda referenciarlo
// en una operación futura (p.ej. eliminarContenidoNuevo).
export function agregarContenidoLocal(
  borrador: BorradorProgramaAnalitico,
  textoLocal: string,
  resultadoEsperadoLocal?: string | null
): { borrador: BorradorProgramaAnalitico; claveLocal: string } {
  const claveLocal = randomUUID()
  return {
    borrador: { ...borrador, deltas: [...borrador.deltas, { decision: 'nuevo', claveLocal, textoLocal, resultadoEsperadoLocal: resultadoEsperadoLocal ?? null }] },
    claveLocal,
  }
}

export function eliminarContenidoNuevo(borrador: BorradorProgramaAnalitico, claveLocal: string): BorradorProgramaAnalitico {
  return { ...borrador, deltas: borrador.deltas.filter((d) => !(d.decision === 'nuevo' && d.claveLocal === claveLocal)) }
}

// ============================================================
// Combinación base + deltas — única implementación real (PA-3B1
// §6/§7, corregida en PA-4B §8/§9). Cada curriculoContenidoId admite
// como máximo 1 decisión — nunca se duplica un contenido en la
// propuesta final. Un contenido sin ninguna decisión conserva
// exactamente su forma de la base (sin_ajuste, todos sus PDA
// oficiales). claveLocal de "nuevo" viene YA fijo en el delta
// (asignado server-side por normalizarDecisionesIa o por
// agregarContenidoLocal) — nunca se genera aquí por posición, así que
// sobrevive intacto a cualquier reordenamiento/recombinación. orden se
// renumera 1..N de forma determinista sobre el resultado final.
//
// DELTA_CONTENIDO_DUPLICADO sigue siendo un error real aquí — protege
// contra un array de deltas crudo con 2 decisiones simultáneas sobre
// el mismo contenido (p.ej. JSON de IA inválido). Las operaciones
// deterministas del borrador (excluirContenido, reemplazarContextualizacion,
// restaurarContenido) garantizan por construcción que borrador.deltas
// nunca acumula más de 1 delta por contenido — así que en uso normal
// este error nunca se dispara al reconstruir un borrador editado, solo
// ante una respuesta cruda de IA genuinamente inconsistente.
export function aplicarDeltasSobreBase(
  base: ItemPropuestaProgramaAnalitico[],
  deltas: DeltaBorrador[]
): { ok: true; items: ItemPropuestaProgramaAnalitico[] } | { ok: false; error: ErrorAplicarDeltas } {
  const resultadoPorContenido = new Map(base.map((item) => [item.curriculoContenidoId as string, item]))
  const contenidosProcesados = new Set<string>()
  const nuevos: ItemPropuestaProgramaAnalitico[] = []

  for (const d of deltas) {
    if (d.decision === 'nuevo') {
      nuevos.push({
        claveLocal: d.claveLocal,
        tipoDecision: 'nuevo',
        curriculoContenidoId: null,
        textoContextualizado: null,
        textoLocal: d.textoLocal,
        resultadoEsperadoLocal: d.resultadoEsperadoLocal ?? null,
        periodoEvaluacionId: null,
        orden: 0,
        curriculoPdaGradoIds: [],
      })
      continue
    }

    if (contenidosProcesados.has(d.curriculoContenidoId)) {
      return { ok: false, error: { tipo: 'DELTA_CONTENIDO_DUPLICADO', curriculoContenidoId: d.curriculoContenidoId } }
    }
    contenidosProcesados.add(d.curriculoContenidoId)

    const itemBase = resultadoPorContenido.get(d.curriculoContenidoId)
    if (!itemBase) {
      return { ok: false, error: { tipo: 'DELTA_CONTENIDO_NO_ENCONTRADO_EN_BASE', curriculoContenidoId: d.curriculoContenidoId } }
    }

    if (d.decision === 'excluir') {
      resultadoPorContenido.delete(d.curriculoContenidoId)
    } else {
      const pdaSeleccionados = d.curriculoPdaGradoIdsSeleccionados
      resultadoPorContenido.set(d.curriculoContenidoId, {
        ...itemBase,
        tipoDecision: 'contextualizado',
        textoContextualizado: d.textoContextualizado,
        curriculoPdaGradoIds: pdaSeleccionados && pdaSeleccionados.length > 0 ? pdaSeleccionados : itemBase.curriculoPdaGradoIds,
      })
    }
  }

  const itemsFinales = [...resultadoPorContenido.values(), ...nuevos].map((item, idx) => ({ ...item, orden: idx + 1 }))
  return { ok: true, items: itemsFinales }
}

// ============================================================
// 4. Reconstrucción — reutiliza aplicarDeltasSobreBase, nunca una
//    implementación paralela (PA-4B §10).
// ============================================================

export type ErrorReconstruccion =
  | ErrorAplicarDeltas
  | { tipo: 'IDENTIDAD_CURRICULAR_CAMBIO'; esperada: IdentidadCurricularFijada; actual: IdentidadCurricularFijada }

// Falla cerrado si la identidad curricular vigente HOY ya no coincide
// con la que quedó fijada al crear el borrador — nunca reconstruye
// silenciosamente contra una versión/fase/grado curricular distinta
// (p.ej. si el currículo cambió mientras el borrador estaba
// pendiente).
export function reconstruirPropuesta(
  base: ItemPropuestaProgramaAnalitico[],
  identidadCurricularActual: IdentidadCurricularFijada,
  borrador: BorradorProgramaAnalitico
): { ok: true; propuesta: PropuestaProgramaAnalitico } | { ok: false; error: ErrorReconstruccion } {
  const f = borrador.identidadCurricular
  const a = identidadCurricularActual
  if (f.curriculoVersionId !== a.curriculoVersionId || f.curriculoFaseId !== a.curriculoFaseId || f.curriculoGradoId !== a.curriculoGradoId) {
    return { ok: false, error: { tipo: 'IDENTIDAD_CURRICULAR_CAMBIO', esperada: f, actual: a } }
  }

  const combinado = aplicarDeltasSobreBase(base, borrador.deltas)
  if (!combinado.ok) return { ok: false, error: combinado.error }

  return {
    ok: true,
    propuesta: {
      grupoId: borrador.grupoId,
      idempotencyKey: borrador.idempotencyKey,
      contextoNotas: borrador.contextoNotas,
      items: combinado.items,
    },
  }
}

// ============================================================
// 5. Resumen determinista — datos estructurados, nunca texto final de
//    interfaz, nunca imprime los 85 contenidos (PA-4B §5).
// ============================================================

export type ResumenContextualizado = { curriculoContenidoId: string; tituloOficial: string; textoContextualizado: string; cantidadPda: number }
export type ResumenNuevo = { claveLocal: string; textoLocal: string; resultadoEsperadoLocal: string | null }
export type ResumenExcluido = { curriculoContenidoId: string; tituloOficial: string }

export type ResumenPropuesta = {
  totalItems: number
  totalPda: number
  sinAjuste: { cantidad: number }
  contextualizados: ResumenContextualizado[]
  nuevos: ResumenNuevo[]
  excluidos: ResumenExcluido[]
}

// Recibe el catálogo (para los títulos oficiales — NUNCA de la IA) y
// el borrador vigente — no la PropuestaProgramaAnalitico final, porque
// esa ya no contiene los excluidos (aplicarDeltasSobreBase los quita)
// y este resumen no debe "adivinar" exclusiones comparando textos.
export function construirResumenPropuesta(catalogo: CatalogoCurricularCerrado, borrador: BorradorProgramaAnalitico, propuesta: PropuestaProgramaAnalitico): ResumenPropuesta {
  const tituloPorContenidoId = new Map(catalogo.contenidos.map((c) => [c.id, c.titulo]))

  const contextualizados: ResumenContextualizado[] = []
  const nuevos: ResumenNuevo[] = []
  let sinAjusteCantidad = 0
  let totalPda = 0

  for (const item of propuesta.items) {
    totalPda += item.curriculoPdaGradoIds.length
    if (item.tipoDecision === 'sin_ajuste') {
      sinAjusteCantidad++
    } else if (item.tipoDecision === 'contextualizado' && item.curriculoContenidoId) {
      contextualizados.push({
        curriculoContenidoId: item.curriculoContenidoId,
        tituloOficial: tituloPorContenidoId.get(item.curriculoContenidoId) ?? '',
        textoContextualizado: item.textoContextualizado ?? '',
        cantidadPda: item.curriculoPdaGradoIds.length,
      })
    } else if (item.tipoDecision === 'nuevo') {
      nuevos.push({ claveLocal: item.claveLocal, textoLocal: item.textoLocal ?? '', resultadoEsperadoLocal: item.resultadoEsperadoLocal ?? null })
    }
  }

  const excluidos: ResumenExcluido[] = borrador.deltas
    .filter((d): d is Extract<DeltaBorrador, { decision: 'excluir' }> => d.decision === 'excluir')
    .map((d) => ({ curriculoContenidoId: d.curriculoContenidoId, tituloOficial: tituloPorContenidoId.get(d.curriculoContenidoId) ?? '' }))

  return {
    totalItems: propuesta.items.length,
    totalPda,
    sinAjuste: { cantidad: sinAjusteCantidad },
    contextualizados,
    nuevos,
    excluidos,
  }
}
