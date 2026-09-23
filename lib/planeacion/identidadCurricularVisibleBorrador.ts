// lib/planeacion/identidadCurricularVisibleBorrador.ts
//
// PLN-1D1 — cierra la brecha que PLN-1D dejó abierta: trazabilidadCurricular
// (snapshot V4) ya es correcta y validada, pero el TEXTO VISIBLE del
// borrador (chat, Word, PDF) seguía mostrando el "Contenidos:"/"PDA:"
// tal como Claude los redactó — una paráfrasis libre, nunca el texto
// canónico real — bajo la identidad de "PDA"/"Contenidos" (informe
// PLN-1D-E2E §L).
//
// Decisión de arquitectura (auditoría previa a implementar, ver
// informe PLN-1D1 §A/§B): NO se reescribe la sección narrativa libre
// que Claude ya redacta en el cuerpo del documento — localizar y
// sustituir esa prosa de forma determinista sería frágil (esa sección
// no tiene ningún formato garantizado, a diferencia del bloque "📎
// RESUMEN PARA GUARDAR", que SÍ lo tiene desde su diseño original). En
// vez de "sustituir" ahí, se "construye" (PLN-1D1 §2 lo permite
// explícitamente) una sección NUEVA, inequívocamente rotulada como la
// identidad curricular oficial validada, insertada en un punto 100%
// determinista: justo antes de ETIQUETA_INICIO_BLOQUE (el mismo
// marcador que extraerTextoCompletoBorrador/extraerResumenBorrador ya
// usan de forma confiable en producción) — nunca dentro de la prosa
// libre de Claude, nunca adivinando límites de sección.
//
// PLN-1D2 — cierra la brecha residual que PLN-1D1 dejó explícita
// (informe PLN-1D1 §N): PLN-1D1 insertaba esta sección nueva SIN
// impedir que Claude, además, siguiera escribiendo su propia sección
// narrativa "PROCESOS DE DESARROLLO DE APRENDIZAJE (PDA)" — dos
// representaciones visibles bajo la misma identidad de "PDA". PLN-1D2
// resuelve esto en el prompt (lib/asistente/instruccionesPlaneacionGenerar.ts):
// cuando existe contexto curricular canónico, se le instruye a Claude
// NO escribir esa sección narrativa en absoluto — la ÚNICA sección
// "Contenidos"/"PDA" que puede existir en el cuerpo del documento es
// la que esta función inserta. Los encabezados de línea de esta
// sección se renombraron a "Contenidos oficiales:"/"PDA oficiales:"
// (antes "Contenidos:"/"PDA:") a propósito: el bloque "📎 RESUMEN PARA
// GUARDAR" usa exactamente las etiquetas "Contenidos:"/"PDA:" con
// significado propio (extraerLista) — reutilizar el mismo literal aquí
// haría que sustituirContenidosYPdaEnBloqueResumen (más abajo) pudiera
// coincidir por error con ESTA sección en vez de con el resumen real,
// si algún día se buscara sin acotar al índice del marcador.
//
// Consecuencia deliberada y ya aceptada: si Claude, pese a la
// instrucción, redactara de todos modos alguna prosa que MENCIONE
// contenidos/PDA de forma narrativa (sin usar el encabezado "PDA"),
// esa prosa seguiría existiendo como explicación pedagógica — el
// objetivo nunca fue prohibir toda mención pedagógica, solo impedir
// que algo se presente BAJO LA IDENTIDAD de "PDA"/"Contenidos" sin ser
// canónico. Ver informe PLN-1D2 §O para el riesgo residual explícito.

import type { CandidatoCurricularPlaneacion } from './resolverCurricularPlaneacion'
import { ETIQUETA_INICIO_BLOQUE } from './extraerBorrador'

export type IdentidadCurricularVisible = {
  contenidos: string[]
  pda: string[]
}

// El texto que un docente reconocería como "el contenido" de un item
// YA VALIDADO — mismo criterio que construirTextoEfectivo en
// resolverCurricularPlaneacion.ts (contextualizado > oficial; local
// usa su propio texto), reutilizado aquí en vez de reescrito, salvo
// que aquella función antepone "[LOCAL] " (para el catálogo que ve
// Claude) y esta NO — aquí la etiqueta de procedencia ya la da el
// encabezado de la sección completa, no cada línea individual.
function textoIdentidadCandidato(c: CandidatoCurricularPlaneacion): string | null {
  if (c.procedencia === 'local') return c.textoLocal
  if (c.procedencia === 'contextualizado') return c.textoContextualizado ?? c.contenidoOficial
  return c.contenidoOficial
}

// Pura, 0 I/O. Recibe EXCLUSIVAMENTE los candidatos YA ACEPTADOS por
// validarSeleccionItemsProgramaAnalitico — nunca la propuesta cruda de
// Claude, nunca el catálogo completo ofrecido. Deduplica por texto
// exacto (PLN-1D1 §8: "evita duplicados si varios items terminan
// referenciando el mismo PDA canónico" — un mismo PDA real puede
// aparecer legítimamente asociado a más de un item si el docente/Claude
// seleccionó dos contenidos que comparten un PDA). Nunca altera el
// texto canónico (PLN-1D1 §9) — se copia literal, tal como vive en
// curriculo_pda.texto / curriculo_contenido.titulo /
// programa_analitico_item.texto_contextualizado/texto_local.
// null cuando no hay nada que mostrar (0 candidatos aceptados) — nunca
// una sección vacía o inventada.
export function construirIdentidadCurricularVisible(candidatosValidados: CandidatoCurricularPlaneacion[]): IdentidadCurricularVisible | null {
  if (candidatosValidados.length === 0) return null

  const contenidos: string[] = []
  const vistosContenido = new Set<string>()
  const pda: string[] = []
  const vistosPda = new Set<string>()

  for (const candidato of candidatosValidados) {
    const texto = textoIdentidadCandidato(candidato)
    if (texto && !vistosContenido.has(texto)) {
      vistosContenido.add(texto)
      contenidos.push(texto)
    }
    // Item local: pda=[] siempre (invariante ya garantizado por
    // cargarCandidatosProgramaAnaliticoVigente) — el bucle simplemente
    // no aporta nada, nunca se fabrica un PDA para él (PLN-1D1 §7).
    for (const p of candidato.pda) {
      if (!vistosPda.has(p.texto)) {
        vistosPda.add(p.texto)
        pda.push(p.texto)
      }
    }
  }

  if (contenidos.length === 0 && pda.length === 0) return null
  return { contenidos, pda }
}

const ENCABEZADO_IDENTIDAD_VISIBLE = '📌 IDENTIDAD CURRICULAR OFICIAL VALIDADA (Programa Analítico)'

// Pura, 0 I/O. Renderiza la identidad ya construida como texto plano,
// mismo formato "Etiqueta: valor1 · valor2" que ya usa el resto del
// documento — nunca JSON, nunca un formato nuevo que el docente no
// reconozca.
export function renderizarBloqueIdentidadCurricularVisible(identidad: IdentidadCurricularVisible): string {
  const lineas = [ENCABEZADO_IDENTIDAD_VISIBLE]
  // "Contenidos oficiales:"/"PDA oficiales:" — deliberadamente
  // DISTINTAS de las etiquetas exactas "Contenidos:"/"PDA:" que usa el
  // bloque "📎 RESUMEN PARA GUARDAR" (ver cabecera del archivo) — nunca
  // deben coincidir por accidente con esas.
  if (identidad.contenidos.length > 0) lineas.push(`Contenidos oficiales: ${identidad.contenidos.join(' · ')}`)
  if (identidad.pda.length > 0) lineas.push(`PDA oficiales: ${identidad.pda.join(' · ')}`)
  return lineas.join('\n')
}

// Pura, 0 I/O. Inserta el bloque JUSTO ANTES de ETIQUETA_INICIO_BLOQUE
// — el único punto del documento cuya posición ya es 100% determinista
// en producción (extraerTextoCompletoBorrador/extraerResumenBorrador
// lo localizan así desde su diseño original). Fail-closed: si el
// marcador no aparece (borrador incompleto, conflicto=true, o
// identidad=null porque no había contexto curricular canónico este
// turno) el texto se devuelve SIN TOCAR — nunca se adivina dónde
// insertar, nunca se inserta al final ni al principio "por si acaso".
export function insertarIdentidadCurricularVisibleEnBorrador(textoBorrador: string, identidad: IdentidadCurricularVisible | null): string {
  if (!identidad) return textoBorrador
  const indice = textoBorrador.indexOf(ETIQUETA_INICIO_BLOQUE)
  if (indice === -1) return textoBorrador

  const bloque = renderizarBloqueIdentidadCurricularVisible(identidad)
  return `${textoBorrador.slice(0, indice).trimEnd()}\n\n${bloque}\n\n${textoBorrador.slice(indice)}`
}

// PLN-1D2 §G — el bloque "📎 RESUMEN PARA GUARDAR" sigue siendo texto
// VISIBLE completo para el docente en el chat (extraerBorrador.ts,
// cabecera: "el docente lo ve como parte del borrador") y además
// alimenta ResumenBorrador.contenidos/.pda (parseados por
// extraerResumenBorrador vía extraerLista). Sin esta función, ese
// bloque seguiría mostrando — y persistiendo — la paráfrasis de Claude
// como una SEGUNDA representación de "Contenidos"/"PDA", distinta de
// la insertada arriba: exactamente la ambigüedad que PLN-1D2 elimina.
//
// Sustituye EXCLUSIVAMENTE el valor de las líneas "Contenidos:"/"PDA:"
// — mismas etiquetas EXACTAS que ya usa extraerLista, mismo separador
// ";" — dentro del bloque de resumen (nunca antes del marcador, nunca
// en la sección insertada por insertarIdentidadCurricularVisibleEnBorrador,
// que usa etiquetas distintas a propósito). Determinista: opera con
// una expresión regular ANCLADA a inicio de línea sobre la porción de
// texto que empieza EXACTAMENTE en ETIQUETA_INICIO_BLOQUE — nunca
// sobre el documento completo, para que sea imposible que coincida con
// cualquier otra ocurrencia. Reemplaza como máximo 1 línea por
// etiqueta (el propio formato ya exige que solo exista una). Si la
// etiqueta no aparece ahí (borrador no conforme al formato esperado),
// no cambia nada — nunca inserta una línea que Claude no escribió.
export function sustituirContenidosYPdaEnBloqueResumen(textoBorrador: string, identidad: IdentidadCurricularVisible | null): string {
  if (!identidad) return textoBorrador
  const indice = textoBorrador.indexOf(ETIQUETA_INICIO_BLOQUE)
  if (indice === -1) return textoBorrador

  const antes = textoBorrador.slice(0, indice)
  let bloqueResumen = textoBorrador.slice(indice)

  if (identidad.contenidos.length > 0) {
    bloqueResumen = bloqueResumen.replace(/^Contenidos:.*$/m, `Contenidos: ${identidad.contenidos.join('; ')}`)
  }
  if (identidad.pda.length > 0) {
    bloqueResumen = bloqueResumen.replace(/^PDA:.*$/m, `PDA: ${identidad.pda.join('; ')}`)
  }

  return antes + bloqueResumen
}
