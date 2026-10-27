// Lista oficial desde el Chat IA — etapa de SOLO LECTURA (LISTA-P3).
//
// El docente adjunta una o varias fotos de su lista oficial y pide
// actualizarla/compararla. Este flujo:
//   1. reconoce la solicitud de forma determinista (sin clasificador),
//   2. resuelve el grupo con reglas estrictas: nunca compara contra un
//      grupo supuesto,
//   3. extrae los registros de las fotos con la IA (única llamada),
//   4. lee la lista actual del grupo respetando RLS y la compara de forma
//      determinista (matchingListaOficial),
//   5. devuelve el resumen en texto.
// No escribe nada, no firma propuestas ni ofrece confirmaciones: aplicar
// cambios es una etapa posterior. Los logs solo llevan conteos.

import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { analizarImagenesListaOficial, type ImagenListaOficial, type MediaTypeImagenListaOficial } from './analisisListaOficial'
import { compararListaOficial, type ResultadoComparacionListaOficial, type ResultadoMatchRegistro } from './matchingListaOficial'
import { obtenerRosterConPosicion } from '../rosterGrupo'
import { normalizarNombre } from '../emparejarAlumno'
import { validarEstructuraCurp } from '../motorContexto'

const MAXIMO_FOTOS_LISTA_OFICIAL = 4
const MEDIA_TYPES_FOTO: MediaTypeImagenListaOficial[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']

// "Actualiza mi lista oficial", "compara esta lista con mis alumnos",
// "revisa la lista oficial de mi grupo 4.º B"... Siempre exige pedir
// actualizar, comparar, cotejar o revisar una lista ("¿qué es la lista
// oficial?" no cuenta), y que sea la lista oficial o la de esta foto o de
// los alumnos.
export function esSolicitudListaOficial(mensaje: string | null | undefined): boolean {
  const texto = (mensaje || '').toLowerCase()
  if (!/\b(actualiz|compar|cotej|revis)\w*/.test(texto) || !/\blista\b/.test(texto)) return false
  if (/\blista\s+oficial\b/.test(texto)) return true
  // Una hoja de asistencia o de calificaciones no es la lista oficial.
  if (/asistenc|calificac|evaluac/.test(texto)) return false
  return /(\bfoto|\bfotograf|\bimagen|\bimágenes|\besta\b|\bestas\b|\balumnos\b)/.test(texto)
}

// Sin foto solo se atiende si nombra la lista oficial (para pedir las fotos);
// "compara esta lista con mis alumnos" sin adjunto sigue el flujo normal.
export function mencionaListaOficial(mensaje: string | null | undefined): boolean {
  return /\blista\s+oficial\b/i.test(mensaje || '')
}

// "4.º B", "4° B", "4B", "4 B", "grupo 4 B", "4o. B".
export function extraerGrupoMencionado(mensaje: string | null | undefined): { grado: string; letra: string } | null {
  const m = (mensaje || '').match(/\b([1-6])\s*(?:\.?\s*[°ºo]\.?)?\s*(?:grado\s*)?(?:grupo\s*)?["“']?([A-Ha-h])\b/)
  return m ? { grado: m[1], letra: m[2].toUpperCase() } : null
}

type GrupoVigente = { id: string; grado: string; grupo: string; etiqueta: string }

export type ResolucionGrupoListaOficial =
  | { ok: true; grupo: GrupoVigente }
  | { ok: false; motivo: 'sin_grupo' | 'no_encontrado' | 'ambiguo' | 'error'; opciones: string[]; mencionado: string | null }

const etiquetaGrupo = (grado: string, grupo: string) => `${grado}.º ${grupo}`
const soloDigitos = (v: string | null | undefined) => (v || '').replace(/\D/g, '')

// Solo grupos donde el docente es el titular (grupos.docente_id) y cuyo
// ciclo escolar está activo, con RLS del propio docente. Con un único grupo
// vigente se usa ese; con varios, solo si el mensaje nombra exactamente uno.
// Si el mensaje nombra un grupo que no es suyo o no está vigente, no se usa
// otro en su lugar.
export async function resolverGrupoListaOficial(sb: SupabaseClient, docenteId: string, mensaje: string): Promise<ResolucionGrupoListaOficial> {
  const { data, error } = await sb
    .from('grupos')
    .select('id, grado, grupo, activo, ciclos_escolares!inner(activo)')
    .eq('docente_id', docenteId)
    .eq('ciclos_escolares.activo', true)
  if (error || !data) return { ok: false, motivo: 'error', opciones: [], mencionado: null }

  const vigentes: GrupoVigente[] = (data as Array<{ id: string; grado: string | null; grupo: string | null; activo: boolean | null }>)
    .filter((g) => g.activo !== false && soloDigitos(g.grado) && (g.grupo || '').trim())
    .map((g) => ({ id: g.id, grado: soloDigitos(g.grado), grupo: (g.grupo || '').trim().toUpperCase(), etiqueta: etiquetaGrupo(soloDigitos(g.grado), (g.grupo || '').trim().toUpperCase()) }))
  const opciones = vigentes.map((g) => g.etiqueta).sort()
  const mencion = extraerGrupoMencionado(mensaje)
  const mencionado = mencion ? etiquetaGrupo(mencion.grado, mencion.letra) : null

  if (vigentes.length === 0) return { ok: false, motivo: 'sin_grupo', opciones, mencionado }
  if (mencion) {
    const coincidentes = vigentes.filter((g) => g.grado === mencion.grado && g.grupo === mencion.letra)
    if (coincidentes.length === 1) return { ok: true, grupo: coincidentes[0] }
    return { ok: false, motivo: coincidentes.length === 0 ? 'no_encontrado' : 'ambiguo', opciones, mencionado }
  }
  if (vigentes.length === 1) return { ok: true, grupo: vigentes[0] }
  return { ok: false, motivo: 'ambiguo', opciones, mencionado }
}

const linea = (texto: string) => `- ${texto}`
const curpOGuion = (curp: string | null | undefined) => (curp && curp.trim() ? curp.trim().toUpperCase() : 'sin CURP legible')

export function formatearComparacionListaOficial(
  comparacion: ResultadoComparacionListaOficial,
  roster: Array<{ id: string; nombre: string; curp: string | null }>,
  etiqueta: string,
  cantidadFotos: number
): string {
  const porId = new Map(roster.map((a) => [a.id, a]))
  const r = comparacion.resultados
  const nombreDe = (x: ResultadoMatchRegistro) => x.alumnoNombre || (x.alumnoId ? porId.get(x.alumnoId)?.nombre : null) || x.registro.nombreLeido || 'registro sin nombre legible'
  const leido = (x: ResultadoMatchRegistro) => x.registro.nombreLeido || 'nombre ilegible'

  const coincidentes = r.filter((x) => x.categoriaDiff === 'SIN_CAMBIO' || x.categoriaDiff === 'CURP_FALTANTE_EN_DB')
  const nombreDistinto = coincidentes.filter((x) => x.alumnoId && x.registro.nombreLeido && normalizarNombre(x.registro.nombreLeido) !== normalizarNombre(porId.get(x.alumnoId)?.nombre || ''))
  const curpCompletable = r.filter((x) => x.categoriaDiff === 'CURP_FALTANTE_EN_DB' && x.accionableV1 === true)
  const curpFaltanteRevisar = r.filter((x) => x.categoriaDiff === 'CURP_FALTANTE_EN_DB' && x.accionableV1 !== true)
  const curpDiferente = r.filter((x) => x.categoriaDiff === 'CURP_DIFERENTE')
  // Un registro que no coincide con nadie solo se presenta como posible alta
  // si su nombre se leyó con confianza alta y su CURP, si viene, es legible,
  // segura y estructuralmente válida; si no, es una lectura dudosa.
  const lecturaConfiable = (x: ResultadoMatchRegistro) =>
    x.registro.nombreConfianza === 'alta' && !!x.registro.nombreLeido &&
    (!x.registro.curpLeida || (x.registro.curpLegible && x.registro.curpConfianza === 'alta' && validarEstructuraCurp(x.registro.curpLeida.trim().toUpperCase()).valido))
  const nuevos = r.filter((x) => x.categoriaDiff === 'NUEVO_POSIBLE')
  const altas = nuevos.filter(lecturaConfiable)
  const duplicados = r.filter((x) => x.categoriaDiff === 'CURP_DUPLICADA' || x.categoriaDiff === 'REGISTRO_DUPLICADO_EN_DOCUMENTO')
  const dudosas = [...r.filter((x) => x.categoriaDiff === 'LECTURA_DUDOSA'), ...nuevos.filter((x) => !lecturaConfiable(x))]
  const ambiguas = r.filter((x) => x.categoriaDiff === 'MATCH_AMBIGUO')
  const ausentes = comparacion.ausentesEnDocumento

  const partes: string[] = [
    `Comparé ${r.length} registro${r.length === 1 ? '' : 's'} de ${cantidadFotos} foto${cantidadFotos === 1 ? '' : 's'} con la lista del grupo ${etiqueta}.`,
    'Esto es solo una comparación: no guardé ni cambié nada.',
    '',
    `Coinciden con tu lista: ${coincidentes.length}.`,
  ]
  const seccion = (titulo: string, filas: string[], nota?: string) => {
    if (filas.length === 0) return
    partes.push('', `${titulo} (${filas.length}):`, ...filas.map(linea))
    if (nota) partes.push(nota)
  }
  seccion('Posibles diferencias de nombre', nombreDistinto.map((x) => `En tu lista: ${porId.get(x.alumnoId!)?.nombre}. En la foto: ${leido(x)}.`))
  seccion('CURP que faltan en tu lista y se leyeron con claridad', curpCompletable.map((x) => `${nombreDe(x)}: ${curpOGuion(x.registro.curpLeida)}.`),
    'Podrás confirmarlas en una siguiente versión; por ahora no se guardan.')
  seccion('CURP que faltan en tu lista y no se leyeron con seguridad', curpFaltanteRevisar.map((x) => `${nombreDe(x)}: en la foto ${curpOGuion(x.registro.curpLeida)}.`))
  seccion('CURP distinta a la registrada', curpDiferente.map((x) => `${nombreDe(x)}: en tu lista ${curpOGuion(x.alumnoId ? porId.get(x.alumnoId)?.curp : null)}, en la foto ${curpOGuion(x.registro.curpLeida)}.`))
  seccion('Posibles altas (no están en tu lista)', altas.map((x) => `${leido(x)} — ${curpOGuion(x.registro.curpLeida)}.`))
  seccion('Posibles duplicados', duplicados.map((x) => `${leido(x)} — ${curpOGuion(x.registro.curpLeida)}.`))
  seccion('Lecturas dudosas', dudosas.map((x) => `${leido(x)} — ${curpOGuion(x.registro.curpLeida)}.`))
  seccion('Coincidencias que no pude decidir', ambiguas.map((x) => `${leido(x)} — ${curpOGuion(x.registro.curpLeida)}.`))
  seccion('Alumnos de tu lista que no aparecen en las fotos', ausentes.map((a) => a.alumnoNombre),
    'Que no aparezcan no significa que sean bajas: la foto puede no incluir todas las páginas.')
  return partes.join('\n')
}

export type FotoAdjunta = { base64: string; tipo: string }

// Flujo completo de lectura. Devuelve el texto para el chat; nunca lanza.
export async function responderListaOficial(
  params: { anthropic: Anthropic; sb: SupabaseClient; docenteId: string; mensaje: string; fotos: FotoAdjunta[]; esPdf: boolean }
): Promise<string> {
  const { anthropic, sb, docenteId, mensaje, fotos, esPdf } = params
  if (esPdf) return 'Por ahora comparo la lista oficial a partir de fotografías. Envíame fotos claras de las hojas de la lista.'
  const imagenes = fotos.filter((f) => MEDIA_TYPES_FOTO.includes(f.tipo as MediaTypeImagenListaOficial))
  if (imagenes.length === 0) return 'Para comparar tu lista oficial necesito una o varias fotos claras de la lista (JPG o PNG). Adjúntalas y vuelve a pedírmelo.'
  if (imagenes.length > MAXIMO_FOTOS_LISTA_OFICIAL) return `Recibí demasiadas fotos para procesar la lista de una vez (máximo ${MAXIMO_FOTOS_LISTA_OFICIAL}). Envíame hasta ${MAXIMO_FOTOS_LISTA_OFICIAL} fotos claras de la lista.`

  const grupo = await resolverGrupoListaOficial(sb, docenteId, mensaje)
  console.log(`[LISTA_OFICIAL] grupo_resuelto=${grupo.ok} motivo=${grupo.ok ? 'ok' : grupo.motivo} grupos_vigentes=${grupo.ok ? 1 : grupo.opciones.length}`)
  if (!grupo.ok) {
    if (grupo.motivo === 'error') return 'No pude confirmar tu grupo en este momento. Intenta de nuevo en unos segundos.'
    if (grupo.motivo === 'sin_grupo') return 'No encontré un grupo tuyo con ciclo escolar vigente. Revisa tus grupos antes de comparar la lista oficial.'
    if (grupo.motivo === 'no_encontrado') return `No encontré el grupo ${grupo.mencionado} entre tus grupos vigentes (${grupo.opciones.join(', ')}). Dime cuál es el grupo correcto.`
    return `Tienes varios grupos vigentes (${grupo.opciones.join(', ')}). Dime de qué grupo es esta lista, por ejemplo: "Actualiza la lista oficial de mi grupo ${grupo.opciones[0]}".`
  }

  let extraccion: Awaited<ReturnType<typeof analizarImagenesListaOficial>>
  try {
    const paraAnalisis: ImagenListaOficial[] = imagenes.map((f) => ({ base64: f.base64, mediaType: f.tipo as MediaTypeImagenListaOficial }))
    extraccion = await analizarImagenesListaOficial(anthropic, paraAnalisis)
  } catch {
    console.error('[LISTA_OFICIAL] extraccion_ok=false')
    return 'No pude leer la lista con claridad suficiente. Intenta de nuevo con fotos más claras y bien iluminadas.'
  }
  console.log(`[LISTA_OFICIAL] extraccion_ok=true registros=${extraccion.registros.length} fotos=${imagenes.length}`)
  if (extraccion.registros.length === 0) return 'No encontré ningún registro legible en la foto. Intenta de nuevo con una foto más clara.'

  const { data: roster, error } = await obtenerRosterConPosicion(sb, grupo.grupo.id)
  if (error) {
    console.error('[LISTA_OFICIAL] roster_ok=false')
    return 'No pude leer la lista de tu grupo en este momento. Intenta de nuevo en unos segundos.'
  }
  const rosterParaMatching = roster.map((a) => ({ id: a.id, nombre: a.nombre, curp: a.curp }))
  const comparacion = compararListaOficial(extraccion.registros, rosterParaMatching)
  const conteo = (c: string) => comparacion.resultados.filter((x) => x.categoriaDiff === c).length
  console.log(`[LISTA_OFICIAL] comparacion_ok=true roster=${rosterParaMatching.length} sin_cambio=${conteo('SIN_CAMBIO')} curp_faltante=${conteo('CURP_FALTANTE_EN_DB')} curp_diferente=${conteo('CURP_DIFERENTE')} nuevos=${conteo('NUEVO_POSIBLE')} dudosas=${conteo('LECTURA_DUDOSA')} ambiguas=${conteo('MATCH_AMBIGUO')} ausentes=${comparacion.ausentesEnDocumento.length}`)
  return formatearComparacionListaOficial(comparacion, rosterParaMatching, grupo.grupo.etiqueta, imagenes.length)
}
