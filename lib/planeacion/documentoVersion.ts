// lib/planeacion/documentoVersion.ts
//
// Texto canónico de una versión de planeación (contenido + indicadores
// de su estructura) y regla de "evaluación protegida con criterios
// distintos". Módulo ligero, sin generadores ni servidor: lo usan los
// Word/PDF por versión (archivosVersion.ts) y la pestaña Planeación, para
// que el documento y la pantalla muestren exactamente lo mismo.

import type { SupabaseClient } from '@supabase/supabase-js'

const normal = (t: string) => t.trim().replace(/\s+/g, ' ').toLowerCase()

// ------------------------------------------------------------------
// Texto del documento (puro)
// ------------------------------------------------------------------
export const ENCABEZADO_INDICADORES = '📊 INDICADORES DE EVALUACIÓN'

// Encabezado de sección del documento: emoji opcional y texto en mayúsculas
// ("🎓 PRODUCTO FINAL", "INDICADORES DE EVALUACIÓN").
const ENCABEZADO_SECCION = /^\s*(?:[\p{Extended_Pictographic}\u{1F300}-\u{1FAFF}]\uFE0F?\s*)?[A-ZÁÉÍÓÚÑÜ][A-ZÁÉÍÓÚÑÜ0-9 ,;:()\/-]{3,}$/u
// Encabezado de una sección de indicadores, en cualquier capitalización,
// ocupando la línea completa.
const ES_INDICADORES = /^\s*(?:[\p{Extended_Pictographic}\u{1F300}-\u{1FAFF}]\uFE0F?\s*)?(?:\d+[.)]\s*)?indicadores(?:\s+de\s+(?:evaluaci[oó]n|logro|desempe[nñ]o))?\s*:?\s*$/iu

// Snapshot canónico de la versión, con su número (discreto, bajo el título)
// y sus indicadores, que solo viven en la estructura. Si el texto ya trae
// una sección de indicadores, se reemplaza por la de la estructura (en su
// lugar): el documento nunca muestra otros indicadores que los canónicos.
// Si la estructura no tiene indicadores, el texto queda como está.
// mostrarNumero: false para mostrarlo en pantalla, donde la versión ya se
// indica aparte (el documento siempre la lleva bajo el título).
export function textoDocumentoVersion(datos: { contenido: string; numero: number; indicadores: string[]; notaEvaluacion?: string | null; mostrarNumero?: boolean }): string {
  const lineas = datos.contenido.trim().split('\n')
  const cuerpo = datos.mostrarNumero === false ? lineas : [lineas[0], `Versión: ${datos.numero}`, ...lineas.slice(1)]
  if (datos.indicadores.length === 0) return cuerpo.join('\n')
  const seccion = [ENCABEZADO_INDICADORES, ...datos.indicadores.map((x, i) => `${i + 1}. ${x.trim()}`), ...(datos.notaEvaluacion ? ['', datos.notaEvaluacion] : [])]
  // Quita toda sección de indicadores previa (hasta el siguiente encabezado).
  const resultado: string[] = []
  let posicion = -1
  for (let i = 0; i < cuerpo.length; i++) {
    if (i > 0 && ES_INDICADORES.test(cuerpo[i])) {
      if (posicion === -1) posicion = resultado.length
      i++
      while (i < cuerpo.length && !ENCABEZADO_SECCION.test(cuerpo[i])) i++
      i--
      continue
    }
    resultado.push(cuerpo[i])
  }
  if (posicion === -1) return `${resultado.join('\n').trimEnd()}\n\n${seccion.join('\n')}`
  const antes = resultado.slice(0, posicion).join('\n').trimEnd()
  const despues = resultado.slice(posicion).join('\n').trim()
  return `${antes}\n\n${seccion.join('\n')}${despues ? `\n\n${despues}` : ''}`
}

export const notaEvaluacionHistorica = (codigo: string) =>
  `Nota: la evaluación registrada con la hoja ${codigo} conserva sus criterios originales; estos indicadores corresponden a esta versión de la planeación.`

export function sufijoNombreVersion(numero: number): string {
  return `version_${numero}`
}

// Evaluación con capturas o resultados (misma condición que la protección
// de publicar_version_planeacion) cuyos criterios difieren de los de la
// versión: el documento lo aclara. Nunca se modifica nada aquí.
export type EvaluacionDeVersion = { hoja_id: string | null; estructura: { proyecto?: { indicadores?: string[] } } | null }
export async function evaluacionConCriteriosDistintos(sb: SupabaseClient, version: EvaluacionDeVersion): Promise<{ codigo: string } | null> {
  if (!version.hoja_id) return null
  const { data: hoja } = await sb.from('hojas_evaluacion').select('identificador_visible, indicadores, proyecto_id').eq('id', version.hoja_id).maybeSingle()
  const h = hoja as { identificador_visible: string; indicadores: { indicador_especifico?: string }[] | null; proyecto_id: string } | null
  if (!h) return null
  const deLaHoja = (h.indicadores ?? []).map((x) => normal(x.indicador_especifico ?? ''))
  const deLaVersion = (version.estructura?.proyecto?.indicadores ?? []).map(normal)
  if (deLaHoja.join('|') === deLaVersion.join('|')) return null
  const { data: proyecto } = await sb.from('proyectos_seguimiento').select('estado, captura_pendiente, confirmado_en').eq('id', h.proyecto_id).maybeSingle()
  const p = proyecto as { estado: string; captura_pendiente: unknown; confirmado_en: string | null } | null
  const { count } = await sb.from('seguimiento_resultados').select('id', { count: 'exact', head: true }).eq('proyecto_id', h.proyecto_id)
  const protegida = !!p && (!['planeado', 'hoja_generada'].includes(p.estado) || p.captura_pendiente != null || p.confirmado_en != null || (count ?? 0) > 0)
  return protegida ? { codigo: h.identificador_visible } : null
}

export async function notaSiEvaluacionDistinta(sb: SupabaseClient, version: EvaluacionDeVersion): Promise<string | null> {
  const distinta = await evaluacionConCriteriosDistintos(sb, version)
  return distinta ? notaEvaluacionHistorica(distinta.codigo) : null
}
