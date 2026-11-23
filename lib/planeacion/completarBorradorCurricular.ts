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
//   3. se añade al final del turno la sección visible (identidad
//      curricular, con los PDA reales) y la pregunta de cierre, una sola
//      vez; el mensaje queda solo con información pedagógica;
//   4. las vistas previas (Word/PDF) usan el texto con la sección
//      insertada una sola vez antes del bloque de resumen.
//
// La aprobación (Parte 3) aplica la MISMA regla al texto del borrador
// vigente, con el catálogo recargado de la base de datos: ningún dato del
// texto o del cliente es autoridad sobre qué está verificado.

import { extraerResumenBorrador, ETIQUETA_INICIO_BLOQUE } from './extraerBorrador'
import { normalizarTexto, type ReferenciaDocente, type ResultadoContextoCurricularPlaneacion } from './resolverCurricularPlaneacion'
import { reconocerCandidatosPorTexto, type EntradaCurricular } from './validarSeleccionCurricularPlaneacion'
import {
  construirIdentidadCurricularVisible,
  insertarIdentidadCurricularVisibleEnBorrador,
  renderizarBloqueIdentidadCurricularVisible,
  ENCABEZADO_IDENTIDAD_VISIBLE,
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
  // Texto que se añade al final del turno (ya empieza con salto de línea).
  bloqueServidor: string
  // Texto del borrador con la sección curricular insertada, para las
  // vistas previas.
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

// Quita del texto del modelo una copia de la sección curricular (puede
// reproducirla en una corrección, porque la ve en el turno anterior): la
// sección válida es solo la que arma el servidor. La sección termina en
// la primera línea vacía.
export function quitarSeccionCurricularCopiada(texto: string): string {
  const inicio = texto.indexOf(ENCABEZADO_IDENTIDAD_VISIBLE)
  if (inicio === -1) return texto
  const fin = texto.indexOf('\n\n', inicio)
  return quitarSeccionCurricularCopiada(`${texto.slice(0, inicio).trimEnd()}${fin === -1 ? '' : `\n\n${texto.slice(fin).trimStart()}`}`)
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

  const partes: string[] = []
  if (identidad) partes.push(renderizarBloqueIdentidadCurricularVisible(identidad))
  if (!yaTienePreguntaDeCierre(entrada.textoModelo)) partes.push(PREGUNTA_CIERRE_BORRADOR)

  return {
    bloqueServidor: partes.length > 0 ? `\n\n${partes.join('\n\n')}` : '',
    textoParaVistaPrevia: insertarIdentidadCurricularVisibleEnBorrador(quitarSeccionCurricularCopiada(entrada.textoModelo), identidad),
    identidad,
  }
}
