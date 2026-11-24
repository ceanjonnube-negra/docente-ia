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
  // Contenidos o PDA sin respaldo en el catálogo ni del docente: se
  // muestran, pero siempre como propuesta no verificada.
  propuestas: ReferenciaDocente[]
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
function referenciasUnicas(referencias: ReferenciaDocente[]): ReferenciaDocente[] {
  const unicas: ReferenciaDocente[] = []
  const vistas = new Set<string>()
  for (const r of referencias) {
    const texto = r.texto.trim()
    const clave = `${r.tipo}:${texto}`
    if (texto && !vistas.has(clave)) {
      vistas.add(clave)
      unicas.push({ tipo: r.tipo, texto })
    }
  }
  return unicas
}

export function construirIdentidadCurricularVisible(
  candidatosValidados: CandidatoCurricularPlaneacion[],
  referenciasDocente: ReferenciaDocente[] = [],
  propuestasNoVerificadas: ReferenciaDocente[] = []
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

  const delDocente = referenciasUnicas(referenciasDocente)
  const propuestas = referenciasUnicas(propuestasNoVerificadas)

  if (contenidos.length === 0 && pda.length === 0 && contenidosLocales.length === 0 && delDocente.length === 0 && propuestas.length === 0) return null
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
    propuestas,
  }
}

// Texto plano en listas legibles: cada grupo es una línea "Etiqueta:"
// seguida de un elemento "- " por línea, sin líneas vacías dentro (la
// sección termina en la primera línea vacía). Sin candidatos validados
// pero con referencias del docente, lo indicado por el docente se muestra
// sin atribuirlo a ningún programa.
export const ETIQUETA_PDA_DE_REFERENCIA = 'PDA de referencia:'

export function renderizarBloqueIdentidadCurricularVisible(identidad: IdentidadCurricularVisible): string {
  const lineas = [ENCABEZADO_IDENTIDAD_VISIBLE]
  const grupo = (etiqueta: string, elementos: string[]) => {
    if (elementos.length > 0) lineas.push(etiqueta, ...elementos.map((e) => `- ${e}`))
  }
  const hayReferencia = identidad.contenidos.length > 0 || identidad.pda.length > 0 || identidad.contenidosLocales.length > 0
  if (hayReferencia) lineas.push(`Fuente: ${rotuloFuenteCurricular(identidad.fuente, identidad.estadoVerificacion)}`)
  grupo('Contenidos de referencia:', identidad.contenidos)
  grupo(ETIQUETA_PDA_DE_REFERENCIA, identidad.pda)
  grupo('Contenidos propios del Programa Analítico:', identidad.contenidosLocales)
  grupo('Contenidos indicados por el docente:', identidad.delDocente.filter((r) => r.tipo === 'contenido').map((r) => r.texto))
  grupo('PDA indicados por el docente:', identidad.delDocente.filter((r) => r.tipo === 'pda').map((r) => r.texto))
  const contenidosPropuestos = identidad.propuestas.filter((r) => r.tipo === 'contenido').map((r) => r.texto)
  const pdaPropuestos = identidad.propuestas.filter((r) => r.tipo === 'pda').map((r) => r.texto)
  if (contenidosPropuestos.length > 0 || pdaPropuestos.length > 0) lineas.push(`${ROTULO_PROPUESTA_NO_VERIFICADA}:`)
  grupo('Contenidos propuestos:', contenidosPropuestos)
  grupo('PDA propuestos:', pdaPropuestos)
  return lineas.join('\n')
}

// Elementos de un grupo de la ÚLTIMA sección curricular del texto
// ("Etiqueta:" + líneas "- "), o del formato anterior en una sola línea
// ("Etiqueta: a · b"). null si el texto no tiene sección.
export function elementosDeGrupoEnSeccion(texto: string, etiqueta: string): string[] | null {
  const inicio = texto.lastIndexOf(ENCABEZADO_IDENTIDAD_VISIBLE)
  if (inicio === -1) return null
  const fin = texto.indexOf('\n\n', inicio)
  const lineas = texto.slice(inicio, fin === -1 ? undefined : fin).split('\n')
  const i = lineas.findIndex((l) => l.startsWith(etiqueta))
  if (i === -1) return []
  const enLinea = lineas[i].slice(etiqueta.length).trim()
  if (enLinea) return enLinea.split(' · ').map((x) => x.trim()).filter(Boolean)
  const elementos: string[] = []
  for (const l of lineas.slice(i + 1)) {
    if (!l.startsWith('- ')) break
    elementos.push(l.slice(2).trim())
  }
  return elementos.filter(Boolean)
}

// ------------------------------------------------------------------
// Normalización de la sección curricular del cuerpo de un borrador o
// documento: la identidad del servidor es la ÚNICA sección de contenidos
// y PDA visible. Una sola función para Chat, vistas previas, documentos
// definitivos e Historial. Determinista e idempotente.
//   - Solo actúa sobre el cuerpo (antes del bloque de resumen, que no se
//     toca).
//   - Sin identidad no cambia nada (borradores históricos o sin datos
//     curriculares: nunca se quita lo que no se reemplaza).
//   - Quita las secciones de contenidos o PDA del modelo: un ENCABEZADO de
//     línea completa (con o sin emoji, markdown, mayúsculas o dos puntos)
//     y su lista; y, antes de la primera sesión o día, las líneas
//     "Contenidos: …" / "PDA: …". Una mención dentro de una actividad no
//     es un encabezado y se conserva.
//   - Inserta la sección canónica después del propósito; si no hay, antes
//     de materiales o recursos, antes de la primera sesión o día, o al
//     final del cuerpo.
// ------------------------------------------------------------------
function normalizarEncabezado(linea: string): string {
  return linea
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[*_#>`]/g, ' ')
    .replace(/[^\p{L}\p{N}():\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}
// Encabezado: toda la línea es un título (termina en ":" o no tiene más
// texto), sin oraciones.
function textoDeEncabezado(linea: string): string | null {
  const n = normalizarEncabezado(linea)
  if (!n || n.length > 80) return null
  const sinDosPuntos = n.replace(/:\s*$/, '').trim()
  return sinDosPuntos.includes(':') ? null : sinDosPuntos
}
const ENCABEZADO_CURRICULAR = /^(los |las )?(contenidos?( curriculares| del programa( analitico| sintetico)?| de aprendizaje| seleccionados| a trabajar)?|pdas?|\(?pda\)?|procesos? de desarrollo (de|del) aprendizaje( \(pdas?\))?|pdas? \(procesos? de desarrollo (de|del) aprendizaje\)|contenidos? y (pdas?|procesos? de desarrollo (de|del) aprendizaje)( \(pdas?\))?|contenidos?, pda y [a-z ]+|contenidos y pda de esta planeacion)$/
const ENCABEZADO_PROPOSITO = /^(proposito|propositos)( general| del proyecto| de la planeacion)?$/
const ENCABEZADO_MATERIALES = /^(materiales|recursos|materiales y recursos|recursos didacticos)$/
const ENCABEZADO_SESION = /^((dia|sesion|semana)\s+\d+|secuencia didactica|desarrollo de las sesiones|actividades)\b/
const LINEA_ETIQUETA_CURRICULAR = /^\s*[-*•]?\s*(\*\*)?(contenidos?|pdas?|procesos? de desarrollo (de|del) aprendizaje( \(pdas?\))?)(\*\*)?\s*:\s*\S/i
const ELEMENTO_LISTA = /^\s*([-*•▪◦]|\d+[.)])\s+/

// Línea que abre otra sección (emoji o símbolo inicial, markdown o
// mayúsculas): termina la lista anterior.
function abreSeccion(linea: string): boolean {
  const t = linea.trim()
  if (!t || ELEMENTO_LISTA.test(t)) return false
  return /^#{1,6}\s/.test(t) || /^\*\*[^*]+\*\*:?$/.test(t) || /^[^\p{L}\p{N}\s]/u.test(t) || (t === t.toUpperCase() && /\p{L}/u.test(t) && t.length <= 80)
}

function quitarSeccionesCurricularesDelModelo(cuerpo: string): string {
  const lineas = cuerpo.split('\n')
  const salida: string[] = []
  let primeraSesion = lineas.findIndex((l) => { const e = textoDeEncabezado(l); return !!e && ENCABEZADO_SESION.test(e) })
  if (primeraSesion === -1) primeraSesion = lineas.length
  for (let i = 0; i < lineas.length; i++) {
    const encabezado = textoDeEncabezado(lineas[i])
    if (encabezado && ENCABEZADO_CURRICULAR.test(encabezado)) {
      // Se salta el encabezado y su contenido hasta una línea vacía seguida
      // de otra sección, o hasta la siguiente sección.
      let j = i + 1
      while (j < lineas.length) {
        const l = lineas[j]
        if (!l.trim()) {
          const siguiente = lineas.slice(j + 1).find((x) => x.trim())
          if (siguiente === undefined || !ELEMENTO_LISTA.test(siguiente)) break
        } else if (abreSeccion(l)) break
        j++
      }
      i = j - 1
      continue
    }
    if (i < primeraSesion && LINEA_ETIQUETA_CURRICULAR.test(lineas[i])) continue
    salida.push(lineas[i])
  }
  return salida.join('\n').replace(/\n{3,}/g, '\n\n')
}

// Índice de línea donde va la sección canónica.
function posicionSeccionCanonica(lineas: string[]): number {
  const encabezados = lineas.map((l) => textoDeEncabezado(l) ?? '')
  const esSeccion = (i: number) => !!lineas[i].trim() && abreSeccion(lineas[i])
  const proposito = encabezados.findIndex((e) => ENCABEZADO_PROPOSITO.test(e))
  if (proposito !== -1) {
    for (let i = proposito + 1; i < lineas.length; i++) if (esSeccion(i)) return i
    return lineas.length
  }
  const materiales = encabezados.findIndex((e) => ENCABEZADO_MATERIALES.test(e))
  if (materiales !== -1) return materiales
  const sesion = encabezados.findIndex((e) => ENCABEZADO_SESION.test(e))
  return sesion !== -1 ? sesion : lineas.length
}

export function normalizarSeccionCurricular(texto: string, identidad: IdentidadCurricularVisible | null): string {
  if (!identidad) return texto
  const indice = texto.indexOf(ETIQUETA_INICIO_BLOQUE)
  const cuerpo = indice === -1 ? texto : texto.slice(0, indice)
  const resto = indice === -1 ? '' : texto.slice(indice)
  const limpio = quitarSeccionesCurricularesDelModelo(cuerpo).trimEnd()
  const lineas = limpio.split('\n')
  const en = posicionSeccionCanonica(lineas)
  const antes = lineas.slice(0, en).join('\n').trimEnd()
  const despues = lineas.slice(en).join('\n').trimStart()
  const seccion = renderizarBloqueIdentidadCurricularVisible(identidad)
  const nuevoCuerpo = [antes, seccion, despues].filter(Boolean).join('\n\n')
  return resto ? `${nuevoCuerpo}\n\n${resto}` : nuevoCuerpo
}

// Compatibilidad: insertar = normalizar (una sola sección, en su lugar).
export function insertarIdentidadCurricularVisibleEnBorrador(textoBorrador: string, identidad: IdentidadCurricularVisible | null): string {
  return normalizarSeccionCurricular(textoBorrador, identidad)
}

// Sustituye SOLO el valor de las líneas "Contenidos:"/"PDA:" DENTRO del
// bloque de resumen (anclado a inicio de línea, a partir del marcador),
// para que el resumen que se guarda coincida con la sección visible.
// Si una etiqueta no aparece ahí, no inserta nada.
export function sustituirContenidosYPdaEnBloqueResumen(textoBorrador: string, identidad: IdentidadCurricularVisible | null): string {
  if (!identidad) return textoBorrador
  const indice = textoBorrador.indexOf(ETIQUETA_INICIO_BLOQUE)
  if (indice === -1) return textoBorrador

  const deTipo = (tipo: ReferenciaDocente['tipo']) => [...identidad.delDocente, ...identidad.propuestas].filter((r) => r.tipo === tipo).map((r) => r.texto)
  const contenidos = [...identidad.contenidos, ...identidad.contenidosLocales, ...deTipo('contenido')]
  const pda = [...identidad.pda, ...deTipo('pda')]
  let bloqueResumen = textoBorrador.slice(indice)
  // Función de reemplazo: un "$" en el texto curricular nunca se
  // interpreta como patrón de reemplazo.
  if (contenidos.length > 0) bloqueResumen = bloqueResumen.replace(/^Contenidos:.*$/m, () => `Contenidos: ${contenidos.join('; ')}`)
  if (pda.length > 0) bloqueResumen = bloqueResumen.replace(/^PDA:.*$/m, () => `PDA: ${pda.join('; ')}`)
  return textoBorrador.slice(0, indice) + bloqueResumen
}
