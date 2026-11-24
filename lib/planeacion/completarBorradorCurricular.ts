// lib/planeacion/completarBorradorCurricular.ts
//
// Etapa posterior al streaming de un borrador de planeación (Hito 1,
// Parte 2). Sin IA y sin consultas: usa el contexto curricular que ya se
// cargó en este mismo turno.
//
// El modelo NO redacta la sección de contenidos y PDA ni escribe
// identificadores: solo copia, en las líneas "Contenidos:" y "PDA:" del
// bloque de resumen, los textos del catálogo que eligió (y lo que indicó
// el docente). Aquí:
//   1. cada entrada se reconoce POR TEXTO EXACTO contra el catálogo del
//      grupo cargado de la base de datos (reconocerCandidatosPorTexto) —
//      nunca por un identificador escrito por el modelo o el cliente;
//   2. lo no reconocido se clasifica: indicado por el docente (aparece
//      literal en sus mensajes) o propuesta no verificada — nunca se
//      sustituye ni se descarta lo que dijo el docente;
//   3. el texto se normaliza (normalizarSeccionCurricular): fuera las
//      secciones de contenidos o PDA del modelo y UNA sola sección
//      canónica, con los PDA reales, después del propósito; más la
//      pregunta de cierre una sola vez. Ese es el texto final del mensaje
//      del Chat ([[TEXTO_FINAL]]) y el de las vistas previas (Word/PDF).
//
// La aprobación (Parte 3) aplica la MISMA regla al texto del borrador
// vigente, con el catálogo recargado de la base de datos: ningún dato del
// texto o del cliente es autoridad sobre qué está verificado.

import { extraerResumenBorrador, ETIQUETA_INICIO_BLOQUE } from './extraerBorrador'
import { normalizarTexto, type ReferenciaDocente, type ResultadoContextoCurricularPlaneacion } from './resolverCurricularPlaneacion'
import { reconocerCandidatosPorTexto, type EntradaCurricular } from './validarSeleccionCurricularPlaneacion'
import {
  construirIdentidadCurricularVisible,
  normalizarSeccionCurricular,
  type IdentidadCurricularVisible,
} from './identidadCurricularVisibleBorrador'

export const PREGUNTA_CIERRE_BORRADOR = 'Ya preparé la planeación. ¿Deseas corregir algo o aprobarla para guardarla?'

export type EntradaCompletarBorrador = {
  textoModelo: string
  curricular: ResultadoContextoCurricularPlaneacion
  // Mensajes del DOCENTE (nunca del asistente) de esta conversación.
  textosDocente: string[]
}

export type BorradorCompletado = {
  // Texto FINAL del mensaje del Chat (el que se guarda y se reenvía):
  // cuerpo normalizado con la única sección curricular, resumen y la
  // pregunta de cierre una sola vez.
  textoFinal: string
  // El mismo texto normalizado, para las vistas previas.
  textoParaVistaPrevia: string
  identidad: IdentidadCurricularVisible | null
}

// Etiquetas que el modelo puede añadir al final de una entrada.
const ETIQUETAS_ENTRADA = /\s*\((indicado por el docente|contenido propio del programa anal[ií]tico)\)\s*$/i
const ENTRADAS_VACIAS = new Set(['ninguno', 'ninguna', 'no aplica', 'n a', 'sin pda', 'sin contenidos'])
// Una entrada cuenta como del docente si aparece completa en sus mensajes
// y no es tan corta que pueda coincidir por azar.
const LONGITUD_MINIMA_DOCENTE = 8

// Mensajes del docente que pueden respaldar una entrada. Un mensaje que
// contiene un borrador (p. ej. una edición que reenvía el documento) no
// cuenta: ahí el texto es del asistente, no del docente.
export function textosPropiosDelDocente(mensajes: string[]): string {
  return mensajes.filter((m) => m && !m.includes(ETIQUETA_INICIO_BLOQUE)).map(normalizarTexto).join(' \n ')
}

// Entradas de las líneas "Contenidos:" y "PDA:" del resumen, sin las
// etiquetas que el modelo pudiera añadir ni los valores vacíos.
export function entradasCurricularesDelResumen(contenidos: string[], pda: string[]): EntradaCurricular[] {
  const entradas: EntradaCurricular[] = []
  for (const [tipo, lista] of [['contenido', contenidos], ['pda', pda]] as const) {
    for (const texto of lista) {
      const limpio = texto.replace(ETIQUETAS_ENTRADA, '').trim()
      const n = normalizarTexto(limpio)
      if (n && !ENTRADAS_VACIAS.has(n)) entradas.push({ tipo, texto: limpio })
    }
  }
  return entradas
}

export function clasificarNoReconocidas(entradas: EntradaCurricular[], textosDocente: string[]): { delDocente: ReferenciaDocente[]; propuestas: ReferenciaDocente[] } {
  const docente = textosPropiosDelDocente(textosDocente)
  const delDocente: ReferenciaDocente[] = []
  const propuestas: ReferenciaDocente[] = []
  for (const e of entradas) {
    const n = normalizarTexto(e.texto)
    if (n.length >= LONGITUD_MINIMA_DOCENTE && docente.includes(n)) delDocente.push(e)
    else propuestas.push(e)
  }
  return { delDocente, propuestas }
}

// ¿El modelo ya escribió una pregunta de cierre? Una pregunta después del
// bloque de resumen que no sea una línea "Etiqueta: valor" del propio
// resumen, o la pregunta de aprobación en cualquier parte del texto.
function yaTienePreguntaDeCierre(texto: string): boolean {
  const indice = texto.indexOf(ETIQUETA_INICIO_BLOQUE)
  const tras = indice === -1 ? texto : texto.slice(indice)
  const preguntaSuelta = tras.split('\n').some((l) => l.includes('¿') && !/^[\p{L} ]+:\s/u.test(l.trim()))
  return preguntaSuelta || normalizarTexto(texto).includes('aprobarla para guardarla')
}

export function completarBorradorCurricular(entrada: EntradaCompletarBorrador): BorradorCompletado | null {
  const resumen = extraerResumenBorrador([{ role: 'assistant', content: entrada.textoModelo }])
  if (!resumen) return null // sin borrador completo (p. ej. conflicto de fechas): nada que añadir

  const entradas = entradasCurricularesDelResumen(resumen.contenidos, resumen.pda)
  const { aceptados, noReconocidas } = reconocerCandidatosPorTexto(entrada.curricular.candidatosGrupo, entradas)
  const { delDocente, propuestas } = clasificarNoReconocidas(noReconocidas, entrada.textosDocente)
  const identidad = construirIdentidadCurricularVisible(aceptados, [...entrada.curricular.paraPrompt.referenciasDocente, ...delDocente], propuestas)

  const normalizado = normalizarSeccionCurricular(entrada.textoModelo, identidad)
  const textoFinal = yaTienePreguntaDeCierre(entrada.textoModelo) ? normalizado : `${normalizado.trimEnd()}\n\n${PREGUNTA_CIERRE_BORRADOR}`
  return { textoFinal, textoParaVistaPrevia: normalizado, identidad }
}
