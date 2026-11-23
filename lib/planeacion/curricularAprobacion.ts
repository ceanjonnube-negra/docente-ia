// lib/planeacion/curricularAprobacion.ts
//
// Hito 1, Parte 3 — identidad curricular y trazabilidad de una planeación
// al APROBARLA. Misma regla que la Parte 2 (completarBorradorCurricular),
// aplicada al texto del borrador vigente con el catálogo del grupo
// RECARGADO de la base de datos con la sesión del docente (RLS):
//   - un contenido cuenta como del catálogo solo si su texto coincide
//     exactamente con el de un contenido del catálogo del grupo (su grado,
//     fase, versión curricular o Programa Analítico vigente);
//   - de sus PDA, solo cuentan los que el docente REVISÓ en el borrador
//     (la línea "PDA de referencia" de la sección del servidor, o la línea
//     "PDA:" del resumen en borradores anteriores): nunca se añade ni se
//     sustituye en silencio un PDA que no vio, aunque el catálogo haya
//     cambiado;
//   - lo no reconocido se conserva literal: indicado por el docente (está
//     en sus mensajes) o propuesta no verificada.
// Ninguna etiqueta escrita por el modelo o el cliente cuenta como
// verificación. Sin IA; una sola carga curricular. Si la carga falla, la
// aprobación sigue: nada se marca como verificado.

import type { SupabaseClient } from '@supabase/supabase-js'
import { extraerTextoCompletoBorrador, type ResumenBorrador } from './extraerBorrador'
import { cargarCandidatosCurricularesGrupo, normalizarTexto, type CandidatoCurricularPlaneacion, type CargaCurricularGrupo, type ReferenciaDocente } from './resolverCurricularPlaneacion'
import { reconocerCandidatosPorTexto, type EntradaCurricular } from './validarSeleccionCurricularPlaneacion'
import { construirIdentidadCurricularVisible, insertarIdentidadCurricularVisibleEnBorrador, ENCABEZADO_IDENTIDAD_VISIBLE, type IdentidadCurricularVisible } from './identidadCurricularVisibleBorrador'
import { clasificarNoReconocidas, entradasCurricularesDelResumen, quitarSeccionCurricularCopiada } from './completarBorradorCurricular'

// Trazabilidad guardada en planeacion_proyectos.evaluacion.trazabilidad_curricular.
// Conserva los nombres de los registros anteriores (programaAnaliticoId,
// programaAnaliticoVersionId, items[].programaAnaliticoItemId, pda[]) y
// añade el contexto completo; `esquema` distingue esta forma.
export type TrazabilidadCurricularAprobada = {
  esquema: 'planeacion-curricular-v1'
  grupoId: string
  nivelEducativo: string | null
  gradoClave: string | null
  curriculoGradoId: string | null
  curriculoFaseId: string | null
  curriculoFaseClave: string | null
  curriculoVersionId: string | null
  fuente: 'programa_analitico' | 'catalogo_app' | null
  estadoVerificacion: 'oficial_vigente' | 'pendiente_validacion_oficial' | null
  programaAnaliticoId: string | null
  programaAnaliticoVersionId: string | null
  // Por qué no hubo catálogo (sin cobertura, carga fallida…), si aplica.
  motivoSinCatalogo: string | null
  items: {
    id: string
    programaAnaliticoItemId: string | null
    fuente: 'programa_analitico' | 'catalogo_app'
    decision: 'sin_ajuste' | 'contextualizado' | 'local' | null
    estadoVerificacion: 'oficial_vigente' | 'pendiente_validacion_oficial' | 'local_del_docente'
    curriculoContenidoId: string | null
    campoFormativo: { id: string; nombre: string } | null
    texto: string
    pda: { id: string; curriculoPdaGradoId: string; curriculoPdaId: string; texto: string }[]
  }[]
  delDocente: ReferenciaDocente[]
  propuestasNoVerificadas: ReferenciaDocente[]
}

export type CurricularAprobado = {
  identidad: IdentidadCurricularVisible | null
  trazabilidad: TrazabilidadCurricularAprobada
  // Texto definitivo para Word/PDF: el borrador aprobado con UNA sola
  // sección de contenidos y PDA (la validada), sin resumen ni pregunta.
  textoDefinitivo: string
  // Ciclo escolar del grupo (para el periodo de evaluación), si se resolvió.
  cicloEscolarGrupo: string | null
}

const ETIQUETA_PDA_REVISADOS = 'PDA de referencia: '

// PDA que el docente vio en la última sección curricular del borrador.
// null si el borrador no tiene sección (borradores anteriores).
export function pdaRevisadosEnSeccion(contenido: string): string[] | null {
  const inicio = contenido.lastIndexOf(ENCABEZADO_IDENTIDAD_VISIBLE)
  if (inicio === -1) return null
  const fin = contenido.indexOf('\n\n', inicio)
  const seccion = contenido.slice(inicio, fin === -1 ? undefined : fin)
  const linea = seccion.split('\n').find((l) => l.startsWith(ETIQUETA_PDA_REVISADOS))
  return linea ? linea.slice(ETIQUETA_PDA_REVISADOS.length).split(' · ').map((p) => p.trim()).filter(Boolean) : []
}

function textoDeCandidato(c: CandidatoCurricularPlaneacion): string {
  if (c.decision === 'local') return c.textoLocal ?? ''
  if (c.decision === 'contextualizado') return c.textoContextualizado ?? c.tituloContenido ?? ''
  return c.tituloContenido ?? ''
}

// Pura: decide con el catálogo ya cargado. Exportada para las pruebas.
export function decidirCurricularAprobacion(
  carga: CargaCurricularGrupo | { ok: false; motivo: string },
  grupoId: string,
  contenidoBorrador: string,
  resumen: Pick<ResumenBorrador, 'contenidos' | 'pda'>,
  textosDocente: string[]
): CurricularAprobado {
  const revisados = pdaRevisadosEnSeccion(contenidoBorrador)
  const entradasResumen = entradasCurricularesDelResumen(resumen.contenidos, resumen.pda)
  const entradasPda: EntradaCurricular[] = revisados === null ? [] : revisados.map((texto) => ({ tipo: 'pda' as const, texto }))
  const entradas = [...entradasResumen, ...entradasPda.filter((e) => !entradasResumen.some((r) => r.tipo === 'pda' && normalizarTexto(r.texto) === normalizarTexto(e.texto)))]

  const candidatos = carga.ok ? carga.candidatos : []
  const { aceptados, noReconocidas } = reconocerCandidatosPorTexto(candidatos, entradas)
  // Solo los PDA del catálogo que el docente revisó.
  const pdaVistos = new Set(entradas.filter((e) => e.tipo === 'pda').map((e) => normalizarTexto(e.texto)))
  const validados = aceptados.map((c) => ({ ...c, pda: c.pda.filter((p) => pdaVistos.has(normalizarTexto(p.texto))) }))
  const { delDocente, propuestas } = clasificarNoReconocidas(noReconocidas, textosDocente)
  const identidad = construirIdentidadCurricularVisible(validados, delDocente, propuestas)

  const contexto = carga.ok ? carga.contexto : null
  const trazabilidad: TrazabilidadCurricularAprobada = {
    esquema: 'planeacion-curricular-v1',
    grupoId,
    nivelEducativo: contexto?.nivelEducativo ?? null,
    gradoClave: contexto?.gradoGrupo ?? null,
    curriculoGradoId: contexto?.curriculoGradoId ?? null,
    curriculoFaseId: contexto?.curriculoFaseId ?? null,
    curriculoFaseClave: contexto?.curriculoFaseClave ?? null,
    curriculoVersionId: contexto?.curriculoVersionId ?? null,
    fuente: carga.ok ? carga.fuente : null,
    estadoVerificacion: carga.ok ? carga.estadoVerificacion : null,
    programaAnaliticoId: carga.ok ? carga.programaAnalitico?.id ?? null : null,
    programaAnaliticoVersionId: carga.ok ? carga.programaAnalitico?.versionId ?? null : null,
    motivoSinCatalogo: carga.ok ? null : carga.motivo,
    items: validados.map((c) => ({
      id: c.id,
      programaAnaliticoItemId: c.fuente === 'programa_analitico' ? c.id : null,
      fuente: c.fuente,
      decision: c.decision,
      estadoVerificacion: c.estadoVerificacion,
      curriculoContenidoId: c.curriculoContenidoId,
      campoFormativo: c.campoFormativo ? { id: c.campoFormativo.id, nombre: c.campoFormativo.nombre } : null,
      texto: textoDeCandidato(c),
      pda: c.pda.map((p) => ({ id: p.id, curriculoPdaGradoId: p.curriculoPdaGradoId, curriculoPdaId: p.curriculoPdaId, texto: p.texto })),
    })),
    delDocente: identidad?.delDocente ?? [],
    propuestasNoVerificadas: identidad?.propuestas ?? [],
  }

  return { identidad, trazabilidad, textoDefinitivo: textoDefinitivoConIdentidad(contenidoBorrador, identidad), cicloEscolarGrupo: contexto?.cicloEscolarId ?? null }
}

export async function resolverCurricularAprobacion(
  sb: SupabaseClient,
  grupoId: string,
  contenidoBorrador: string,
  resumen: Pick<ResumenBorrador, 'contenidos' | 'pda'>,
  textosDocente: string[]
): Promise<CurricularAprobado> {
  let carga: CargaCurricularGrupo | { ok: false; motivo: string }
  try {
    carga = await cargarCandidatosCurricularesGrupo(sb, grupoId)
  } catch (e) {
    console.error('[PLANEACION_GENERAR][aprobar] fallo cargando el catálogo curricular (nada se marca como verificado):', e)
    carga = { ok: false, motivo: 'CARGA_FALLIDA' }
  }
  return decidirCurricularAprobacion(carga, grupoId, contenidoBorrador, resumen, textosDocente)
}

// Periodo de evaluación de la planeación: el ÚNICO periodo del ciclo del
// grupo que contiene su fecha de inicio. Sin periodos, sin coincidencia o
// con más de una (solapados) → null: nunca se elige uno arbitrario.
export function resolverPeriodoPorFechaInicio<T extends { id: string; fecha_inicio: string | null; fecha_fin: string | null }>(periodos: T[], fechaInicio: string): T | null {
  const coinciden = periodos.filter((p) => p.fecha_inicio && p.fecha_fin && p.fecha_inicio <= fechaInicio && fechaInicio <= p.fecha_fin)
  return coinciden.length === 1 ? coinciden[0] : null
}

// ------------------------------------------------------------------
// Fuente canónica en reintentos: si un intento anterior ya consolidó la
// trazabilidad, la identidad se reconstruye EXCLUSIVAMENTE desde ella
// (nunca desde el catálogo actual, que pudo cambiar). Una trazabilidad
// con otra forma (registros anteriores) no se interpreta: null.
// ------------------------------------------------------------------
export function esTrazabilidadCanonica(valor: unknown): valor is TrazabilidadCurricularAprobada {
  const t = valor as Partial<TrazabilidadCurricularAprobada> | null
  return !!t && typeof t === 'object' && t.esquema === 'planeacion-curricular-v1'
    && Array.isArray(t.items) && Array.isArray(t.delDocente) && Array.isArray(t.propuestasNoVerificadas)
    && t.items.every((i) => !!i && typeof i.texto === 'string' && Array.isArray(i.pda) && i.pda.every((p) => !!p && typeof p.texto === 'string'))
}

export function identidadDesdeTrazabilidad(t: TrazabilidadCurricularAprobada): IdentidadCurricularVisible | null {
  const unicos = (lista: string[]) => [...new Set(lista.map((x) => x.trim()).filter(Boolean))]
  const contenidos = unicos(t.items.filter((i) => i.decision !== 'local').map((i) => i.texto))
  const contenidosLocales = unicos(t.items.filter((i) => i.decision === 'local').map((i) => i.texto))
  const pda = unicos(t.items.flatMap((i) => i.pda.map((p) => p.texto)))
  if (contenidos.length + contenidosLocales.length + pda.length + t.delDocente.length + t.propuestasNoVerificadas.length === 0) return null
  return {
    fuente: t.items.length > 0 ? t.fuente : null,
    estadoVerificacion: contenidos.length > 0 || pda.length > 0 ? t.estadoVerificacion : null,
    contenidos,
    pda,
    contenidosLocales,
    delDocente: t.delDocente,
    propuestas: t.propuestasNoVerificadas,
  }
}

// Texto definitivo para Word/PDF a partir de una identidad ya decidida.
export function textoDefinitivoConIdentidad(contenidoBorrador: string, identidad: IdentidadCurricularVisible | null): string {
  return extraerTextoCompletoBorrador(insertarIdentidadCurricularVisibleEnBorrador(quitarSeccionCurricularCopiada(contenidoBorrador), identidad))
}
