// lib/planeacion/identidadCurricularVisibleBorrador.ts
//
// Sección VISIBLE de contenidos y PDA de un borrador de planeación
// (chat, Word y PDF), construida por el servidor a partir de candidatos
// YA VALIDADOS — nunca la paráfrasis del modelo bajo la identidad de
// "Contenidos"/"PDA". Recuperado de test/images-v1 (PLN-1D1/PLN-1D2) y
// adaptado para distinguir siempre, en el propio texto:
//   - la fuente: Programa Analítico del grupo o catálogo de la app;
//   - el estado de verificación: oficial vigente o pendiente de
//     validación oficial (una versión curricular en 'borrador' nunca se
//     rotula como oficial);
//   - los contenidos locales del Programa Analítico;
//   - lo indicado explícitamente por el docente (literal);
//   - y, sin catálogo disponible, el aviso de propuesta no verificada.
//
// La sección se inserta en un punto 100% determinista: justo antes del
// bloque "📎 RESUMEN PARA GUARDAR" (ETIQUETA_INICIO_BLOQUE), nunca dentro
// de la prosa libre. Sus etiquetas de línea son DISTINTAS de
// "Contenidos:"/"PDA:" del bloque de resumen, para que nunca se
// confundan con él. Puras, 0 I/O.

import type { CandidatoCurricularPlaneacion, EstadoVerificacionCurricular, FuenteCurricular, ReferenciaDocente } from './resolverCurricularPlaneacion'
import { ETIQUETA_INICIO_BLOQUE } from './extraerBorrador'

export type IdentidadCurricularVisible = {
  fuente: FuenteCurricular | null
  estadoVerificacion: Exclude<EstadoVerificacionCurricular, 'local_del_docente'> | null
  contenidos: string[]
  pda: string[]
  contenidosLocales: string[]
  delDocente: ReferenciaDocente[]
}

export const ENCABEZADO_IDENTIDAD_VISIBLE = '📌 CONTENIDOS Y PDA DE ESTA PLANEACIÓN'
export const ROTULO_PENDIENTE_VALIDACION = 'Catálogo curricular de la app — pendiente de validación oficial'
export const ROTULO_OFICIAL_VIGENTE = 'Programa de estudio oficial vigente'
export const ROTULO_PROPUESTA_NO_VERIFICADA = 'Propuesta — no verificada contra el programa oficial'

// Rótulo único de la fuente y su estado. Nunca dice "oficial" de algo
// que no lo es.
export function rotuloFuenteCurricular(fuente: FuenteCurricular | null, estado: IdentidadCurricularVisible['estadoVerificacion']): string {
  // Solo contenidos locales del PA: no hay currículo de referencia.
  if (fuente === 'programa_analitico' && !estado) return 'Programa Analítico del grupo'
  if (!fuente || !estado) return ROTULO_PROPUESTA_NO_VERIFICADA
  const referencia = estado === 'oficial_vigente' ? ROTULO_OFICIAL_VIGENTE : ROTULO_PENDIENTE_VALIDACION
  return fuente === 'programa_analitico' ? `Programa Analítico del grupo (con base en: ${referencia})` : referencia
}

function agregarUnico(lista: string[], vistos: Set<string>, texto: string | null | undefined) {
  const t = texto?.trim()
  if (t && !vistos.has(t)) {
    vistos.add(t)
    lista.push(t)
  }
}

// Recibe EXCLUSIVAMENTE candidatos ya aceptados por
// validarSeleccionCurricular (nunca la propuesta cruda del modelo) y las
// referencias explícitas del docente sin correspondencia. Los textos se
// copian literales (nunca se alteran) y se deduplican. null cuando no
// hay nada que mostrar — nunca una sección vacía o inventada.
export function construirIdentidadCurricularVisible(
  candidatosValidados: CandidatoCurricularPlaneacion[],
  referenciasDocente: ReferenciaDocente[] = []
): IdentidadCurricularVisible | null {
  const contenidos: string[] = []
  const pda: string[] = []
  const contenidosLocales: string[] = []
  const vistosContenido = new Set<string>()
  const vistosPda = new Set<string>()
  const vistosLocal = new Set<string>()

  for (const c of candidatosValidados) {
    if (c.decision === 'local') {
      agregarUnico(contenidosLocales, vistosLocal, c.textoLocal)
      continue
    }
    agregarUnico(contenidos, vistosContenido, c.decision === 'contextualizado' ? c.textoContextualizado ?? c.tituloContenido : c.tituloContenido)
    for (const p of c.pda) agregarUnico(pda, vistosPda, p.texto)
  }

  const delDocente: ReferenciaDocente[] = []
  const vistosDocente = new Set<string>()
  for (const r of referenciasDocente) {
    const texto = r.texto.trim()
    const clave = `${r.tipo}:${texto}`
    if (texto && !vistosDocente.has(clave)) {
      vistosDocente.add(clave)
      delDocente.push({ tipo: r.tipo, texto })
    }
  }

  if (contenidos.length === 0 && pda.length === 0 && contenidosLocales.length === 0 && delDocente.length === 0) return null
  // La fuente solo existe si hay al menos un candidato validado (con
  // solo referencias del docente no hay currículo que rotular), y el
  // estado solo si alguno no es local. Una sola versión pendiente basta
  // para rotular todo como pendiente: nunca se presenta como oficial.
  const fuente = candidatosValidados[0]?.fuente ?? null
  const estados = candidatosValidados.map((c) => c.estadoVerificacion).filter((e) => e !== 'local_del_docente')
  const estadoVerificacion = estados.length === 0 ? null : estados.every((e) => e === 'oficial_vigente') ? 'oficial_vigente' : 'pendiente_validacion_oficial'
  return {
    fuente,
    estadoVerificacion,
    contenidos,
    pda,
    contenidosLocales,
    delDocente,
  }
}

// Texto plano con el formato "Etiqueta: valor1 · valor2" del resto del
// documento. Sin candidatos validados pero con referencias del docente,
// lo indicado por el docente se muestra sin atribuirlo a ningún
// programa.
export function renderizarBloqueIdentidadCurricularVisible(identidad: IdentidadCurricularVisible): string {
  const lineas = [ENCABEZADO_IDENTIDAD_VISIBLE]
  const hayReferencia = identidad.contenidos.length > 0 || identidad.pda.length > 0 || identidad.contenidosLocales.length > 0
  if (hayReferencia) lineas.push(`Fuente: ${rotuloFuenteCurricular(identidad.fuente, identidad.estadoVerificacion)}`)
  if (identidad.contenidos.length > 0) lineas.push(`Contenidos de referencia: ${identidad.contenidos.join(' · ')}`)
  if (identidad.pda.length > 0) lineas.push(`PDA de referencia: ${identidad.pda.join(' · ')}`)
  if (identidad.contenidosLocales.length > 0) lineas.push(`Contenidos propios del Programa Analítico: ${identidad.contenidosLocales.join(' · ')}`)
  const contenidosDocente = identidad.delDocente.filter((r) => r.tipo === 'contenido').map((r) => r.texto)
  const pdaDocente = identidad.delDocente.filter((r) => r.tipo === 'pda').map((r) => r.texto)
  if (contenidosDocente.length > 0) lineas.push(`Contenidos indicados por el docente: ${contenidosDocente.join(' · ')}`)
  if (pdaDocente.length > 0) lineas.push(`PDA indicados por el docente: ${pdaDocente.join(' · ')}`)
  return lineas.join('\n')
}

// Inserta la sección JUSTO ANTES del bloque de resumen. Fail-closed: sin
// marcador o sin identidad, el texto se devuelve SIN TOCAR.
export function insertarIdentidadCurricularVisibleEnBorrador(textoBorrador: string, identidad: IdentidadCurricularVisible | null): string {
  if (!identidad) return textoBorrador
  const indice = textoBorrador.indexOf(ETIQUETA_INICIO_BLOQUE)
  if (indice === -1) return textoBorrador
  const bloque = renderizarBloqueIdentidadCurricularVisible(identidad)
  return `${textoBorrador.slice(0, indice).trimEnd()}\n\n${bloque}\n\n${textoBorrador.slice(indice)}`
}

// Sustituye SOLO el valor de las líneas "Contenidos:"/"PDA:" DENTRO del
// bloque de resumen (anclado a inicio de línea, a partir del marcador),
// para que el resumen que se guarda coincida con la sección visible.
// Si una etiqueta no aparece ahí, no inserta nada.
export function sustituirContenidosYPdaEnBloqueResumen(textoBorrador: string, identidad: IdentidadCurricularVisible | null): string {
  if (!identidad) return textoBorrador
  const indice = textoBorrador.indexOf(ETIQUETA_INICIO_BLOQUE)
  if (indice === -1) return textoBorrador

  const contenidos = [...identidad.contenidos, ...identidad.contenidosLocales, ...identidad.delDocente.filter((r) => r.tipo === 'contenido').map((r) => r.texto)]
  const pda = [...identidad.pda, ...identidad.delDocente.filter((r) => r.tipo === 'pda').map((r) => r.texto)]
  let bloqueResumen = textoBorrador.slice(indice)
  // Función de reemplazo: un "$" en el texto curricular nunca se
  // interpreta como patrón de reemplazo.
  if (contenidos.length > 0) bloqueResumen = bloqueResumen.replace(/^Contenidos:.*$/m, () => `Contenidos: ${contenidos.join('; ')}`)
  if (pda.length > 0) bloqueResumen = bloqueResumen.replace(/^PDA:.*$/m, () => `PDA: ${pda.join('; ')}`)
  return textoBorrador.slice(0, indice) + bloqueResumen
}
