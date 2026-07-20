// lib/calendario/analisisCalendario.ts
//
// Compara una foto del calendario oficial contra calendario_eventos
// real y devuelve SIEMPRE un JSON estructurado de diferencias — nunca
// texto libre que luego habría que volver a interpretar. Mismo patrón
// que app/api/importar-alumnos/route.ts (extraerJsonDeRespuesta):
// Claude Vision con la respuesta forzada a JSON, sin streaming, porque
// se necesita el resultado completo para construir los botones de
// confirmación de una sola vez, no ir mostrándolo palabra por palabra.

import Anthropic from '@anthropic-ai/sdk'
import type { AdjuntoImagen, DiferenciaCalendario, TipoAccionCalendario } from '@/lib/asistente/tipos'
import type { EventoCalendarioCompleto, ResultadoCorreccionesCalendario } from '@/lib/motorContexto'

// Detección determinista (mismo estilo que detectarHerramientaDocumento
// en lib/asistente/documentos.ts) — nunca decide con IA si este mensaje
// es una verificación de calendario, para no arriesgar clasificar mal
// una foto de otra cosa. Requiere: una imagen adjunta Y la palabra
// "calendario" Y un verbo de verificación/actualización en el mismo
// mensaje — así "manda una foto de mi salón" o "aquí está la lista"
// nunca dispara este flujo por accidente.
const REGEX_VERBO_CALENDARIO = /\b(verifica|revisa|compara|actualiza|corrige|coteja|checa|checar|sincroniza)\b/i
const REGEX_PALABRA_CALENDARIO = /\bcalendario\b/i

export function esVerificacionCalendarioConImagen(texto: string, adjunto?: AdjuntoImagen): boolean {
  if (!adjunto?.base64 || !adjunto.tipo.startsWith('image/')) return false
  return REGEX_PALABRA_CALENDARIO.test(texto) && REGEX_VERBO_CALENDARIO.test(texto)
}

const ACCIONES_VALIDAS: TipoAccionCalendario[] = ['agregar', 'corregir', 'eliminar']

// tipo en minúsculas, con estas palabras clave — así el evento se
// clasifica con el ícono/color correctos en app/dashboard/calendario/
// page.tsx (categoriaDe) sin tener que tocar esa pantalla.
const INSTRUCCIONES = `Eres un asistente que ayuda a un docente mexicano a verificar su calendario escolar interno contra una fotografía de un calendario oficial (SEP, boletín, calendario impreso o similar).

Se te dan dos cosas:
1. Una foto del calendario oficial.
2. La lista de eventos YA REGISTRADOS en la aplicación, cada uno con su id real.

Tu tarea: comparar la foto contra los eventos registrados e identificar diferencias reales — eventos que faltan, eventos con fecha o tipo incorrectos, o eventos registrados que ya no corresponden según la foto.

Responde ÚNICAMENTE con un JSON válido (sin explicación, sin markdown, sin backticks), con este formato exacto:
{
  "diferencias": [
    { "accion": "agregar", "evento": { "titulo": "...", "fecha": "YYYY-MM-DD", "tipo": "...", "color": "#RRGGBB", "descripcion": "..." }, "motivo": "..." },
    { "accion": "corregir", "id": "<id real del evento REGISTRADO que se corrige>", "evento": { "titulo": "...", "fecha": "YYYY-MM-DD", "tipo": "...", "color": "#RRGGBB", "descripcion": "..." }, "motivo": "..." },
    { "accion": "eliminar", "id": "<id real del evento REGISTRADO que ya no corresponde>", "evento": { "titulo": "...", "fecha": "YYYY-MM-DD", "tipo": "...", "color": "#RRGGBB", "descripcion": "..." }, "motivo": "..." }
  ]
}

Reglas estrictas:
- "id" es OBLIGATORIO en "corregir" y "eliminar", y debe ser EXACTAMENTE uno de los id reales que se te dieron — nunca inventes un id ni lo dejes vacío.
- "id" NUNCA debe aparecer en "agregar" (es un evento nuevo, todavía no tiene id).
- Si la diferencia es sobre un evento marcado como "(oficial compartido)" y no un evento "(propio del docente)", usa "agregar" con tu versión corregida en vez de "corregir" el original — un docente no debe modificar el calendario oficial compartido de otros.
- "tipo" debe ser una palabra simple en minúsculas que refleje la categoría real: "festivo", "cte", "suspension_labores", "inicio_ciclo", "fin_ciclo", "vacaciones", "consejo_tecnico", o "evento_oficial" para cualquier otro evento oficial genérico.
- "color" en formato hexadecimal, según la categoría: festivo #ef4444, cte #eab308, inicio_ciclo/fin_ciclo #22c55e, suspension_labores #f97316, vacaciones #3b82f6, consejo_tecnico/evento_oficial #8b5cf6.
- Si NO hay diferencias reales, responde { "diferencias": [] }.
- Nunca inventes fechas ni eventos que no veas con claridad en la imagen — si algo no es legible, ignóralo en vez de adivinar.`

function limpiarJson(texto: string): string {
  return texto.replace(/```json/g, '').replace(/```/g, '').trim()
}

// Exportada para que scripts/verificar-analisis-calendario.ts pueda
// probarla de forma aislada (sin credenciales de Anthropic) — es la
// única barrera real contra un id inventado o un JSON con forma
// inesperada devuelto por el modelo.
export function validarDiferencia(d: unknown, idsValidos: Set<string>): DiferenciaCalendario | null {
  if (typeof d !== 'object' || d === null) return null
  const obj = d as Record<string, unknown>

  const accion = obj.accion
  if (typeof accion !== 'string' || !ACCIONES_VALIDAS.includes(accion as TipoAccionCalendario)) return null

  const evento = obj.evento
  if (typeof evento !== 'object' || evento === null) return null
  const ev = evento as Record<string, unknown>
  if (typeof ev.titulo !== 'string' || !ev.titulo.trim()) return null
  if (typeof ev.fecha !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ev.fecha)) return null
  if (typeof ev.tipo !== 'string' || !ev.tipo.trim()) return null

  const id = typeof obj.id === 'string' && obj.id.trim() ? obj.id : undefined
  // Nunca confiar en un id que Claude haya podido inventar — debe ser
  // exactamente uno de los que de verdad existen en calendario_eventos.
  if ((accion === 'corregir' || accion === 'eliminar') && (!id || !idsValidos.has(id))) return null
  if (accion === 'agregar' && id) return null

  return {
    accion: accion as TipoAccionCalendario,
    id,
    evento: {
      titulo: ev.titulo,
      fecha: ev.fecha,
      tipo: ev.tipo.toLowerCase(),
      color: typeof ev.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(ev.color) ? ev.color : '#8b5cf6',
      descripcion: typeof ev.descripcion === 'string' ? ev.descripcion : '',
    },
    motivo: typeof obj.motivo === 'string' ? obj.motivo : '',
  }
}

export type ResultadoAnalisisCalendario = { diferencias: DiferenciaCalendario[] }

export async function analizarImagenCalendario(
  anthropic: Anthropic,
  imagenBase64: string,
  imagenTipo: string,
  mensajeDocente: string,
  eventosReales: EventoCalendarioCompleto[]
): Promise<ResultadoAnalisisCalendario> {
  const idsValidos = new Set(eventosReales.map((e) => e.id))
  const listaEventos = eventosReales.length > 0
    ? eventosReales
        .map((e) => `- id=${e.id} | ${e.fecha} | ${e.tipo} | "${e.titulo}"${e.es_sep ? ' (oficial compartido)' : ' (propio del docente)'}`)
        .join('\n')
    : '(el calendario todavía no tiene eventos registrados)'

  const respuesta = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: (imagenTipo || 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: imagenBase64,
            },
          },
          {
            type: 'text',
            text: `EVENTOS YA REGISTRADOS EN LA APLICACIÓN:\n${listaEventos}\n\nMENSAJE DEL DOCENTE: "${mensajeDocente}"\n\n${INSTRUCCIONES}`,
          },
        ],
      },
    ],
  })

  const bloqueTexto = respuesta.content.find((b) => b.type === 'text')
  const textoRespuesta = bloqueTexto && 'text' in bloqueTexto ? bloqueTexto.text : ''

  let parseado: unknown
  try {
    parseado = JSON.parse(limpiarJson(textoRespuesta))
  } catch {
    throw new Error('No pude interpretar el análisis del calendario. Intenta de nuevo con una foto más clara.')
  }

  const bruto =
    typeof parseado === 'object' && parseado !== null && Array.isArray((parseado as Record<string, unknown>).diferencias)
      ? ((parseado as { diferencias: unknown[] }).diferencias)
      : []

  const diferencias = bruto
    .map((d) => validarDiferencia(d, idsValidos))
    .filter((d): d is DiferenciaCalendario => d !== null)

  return { diferencias }
}

// Texto fijo, determinista — NUNCA redactado por la IA en este paso,
// para que la promesa ("crearé un respaldo automático...") sea siempre
// literalmente cierta y nunca varíe de una corrida a otra.
export function construirResumenAnalisis(diferencias: DiferenciaCalendario[]): string {
  if (diferencias.length === 0) {
    return 'Comparé tu calendario con la imagen que enviaste y no encontré diferencias — todo está al día.'
  }
  const plural = diferencias.length === 1 ? 'diferencia' : 'diferencias'
  return [
    `Encontré ${diferencias.length} ${plural} respecto al calendario oficial que enviaste.`,
    'Ya preparé todas las correcciones necesarias.',
    'Si confirmas, actualizaré automáticamente el calendario interno.',
    'Antes de realizar cualquier cambio crearé un respaldo automático para que nunca se pierda información.',
  ].join('\n\n')
}

// singular/plural/género explícitos por categoría — concordancia real
// en español ("1 suspensión de labores agregada", no "agregado"), no
// una "s" pegada de forma genérica al final de cada palabra.
type InfoTipoCalendario = { singular: string; plural: string; genero: 'm' | 'f' }

const INFO_TIPO: Record<string, InfoTipoCalendario> = {
  festivo: { singular: 'festivo', plural: 'festivos', genero: 'm' },
  cte: { singular: 'CTE', plural: 'CTEs', genero: 'm' },
  suspension_labores: { singular: 'suspensión de labores', plural: 'suspensiones de labores', genero: 'f' },
  inicio_ciclo: { singular: 'fecha de inicio de ciclo', plural: 'fechas de inicio de ciclo', genero: 'f' },
  fin_ciclo: { singular: 'fecha de fin de ciclo', plural: 'fechas de fin de ciclo', genero: 'f' },
  vacaciones: { singular: 'periodo vacacional', plural: 'periodos vacacionales', genero: 'm' },
  consejo_tecnico: { singular: 'consejo técnico', plural: 'consejos técnicos', genero: 'm' },
  evento_oficial: { singular: 'evento oficial', plural: 'eventos oficiales', genero: 'm' },
}

function fraseTipoAgregado(tipo: string, cantidad: number): string {
  const info = INFO_TIPO[tipo] || { singular: tipo.replace(/_/g, ' '), plural: `${tipo.replace(/_/g, ' ')}s`, genero: 'm' as const }
  const nombre = cantidad === 1 ? info.singular : info.plural
  const participio = info.genero === 'f' ? (cantidad === 1 ? 'agregada' : 'agregadas') : (cantidad === 1 ? 'agregado' : 'agregados')
  return `${cantidad} ${nombre} ${participio}`
}

// Resumen final — cuenta ÚNICAMENTE lo que aplicarCorreccionesCalendario
// confirmó que de verdad se escribió (resultado.aplicadas), agrupado
// por acción real y, dentro de "agregados", por categoría real de
// tipo — nunca una cifra que la IA haya podido inventar.
export function construirResumenExito(resultado: ResultadoCorreccionesCalendario): string {
  const lineas: string[] = []

  const agregadosPorTipo = new Map<string, number>()
  for (const d of resultado.aplicadas) {
    if (d.accion !== 'agregar') continue
    agregadosPorTipo.set(d.evento.tipo, (agregadosPorTipo.get(d.evento.tipo) || 0) + 1)
  }
  for (const [tipo, cantidad] of agregadosPorTipo) {
    lineas.push(`• ${fraseTipoAgregado(tipo, cantidad)}`)
  }
  if (resultado.corregidos > 0) lineas.push(`• ${resultado.corregidos} evento${resultado.corregidos === 1 ? '' : 's'} corregido${resultado.corregidos === 1 ? '' : 's'}`)
  if (resultado.eliminados > 0) lineas.push(`• ${resultado.eliminados} evento${resultado.eliminados === 1 ? '' : 's'} eliminado${resultado.eliminados === 1 ? '' : 's'}`)

  if (lineas.length === 0) return '✅ Calendario actualizado correctamente.\n\nNo hubo cambios que aplicar.'

  return `✅ Calendario actualizado correctamente.\n\nSe realizaron:\n\n${lineas.join('\n')}\n\nTodo actualizado correctamente.`
}
