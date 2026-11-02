// lib/planeacion/extraerBorrador.ts
//
// Extracción DETERMINISTA (sin una segunda llamada a Claude) del
// bloque "📎 RESUMEN PARA GUARDAR" que instruccionesPlaneacionGenerar.ts
// exige al final de todo borrador completo — C-005, Paso 3C.
//
// Por qué existe este archivo: el borrador de planeación NUNCA se
// persiste (Paso 3B) — vive solo como texto dentro del historial de
// la conversación. Un marcador oculto tipo [[BORRADOR:...]] no sirve
// porque el cliente (lib/asistente/motores/motorTextoClaude.ts) limpia
// cualquier marcador conocido ANTES de guardar el historial que se
// reenvía al servidor en el siguiente turno — y modificar el cliente
// está fuera de alcance ("no modificar interfaz"). El bloque de
// resumen, en cambio, es texto normal y visible: sobrevive intacto en
// el historial que el servidor ya recibe, así que se puede parsear de
// forma confiable sin tocar ni la interfaz ni la base de datos.

import { esDocumentoFormal } from '../asistente/documentos'

export type DiaSecuenciaDidactica ={ dia: number; resumen: string }

export type ResumenBorrador = {
  nombre: string
  grupoTexto: string | null
  periodoTexto: string | null
  fechaInicio: string
  fechaFin: string
  duracionDias: number | null
  proposito: string | null
  camposFormativos: string[]
  contenidos: string[]
  pda: string[]
  ejesArticuladores: string[]
  metodologia: string | null
  productoFinal: string | null
  // Un resumen breve por día, no la estructura completa de
  // inicio/desarrollo/cierre (que solo existe como texto libre en el
  // cuerpo del borrador) — es lo único que se extrae de forma
  // confiable sin una segunda llamada a Claude. Ver
  // lib/planeacion/aprobarBorrador.ts para cómo se usa en
  // planeacion_proyectos.actividades.
  secuenciaDidactica: DiaSecuenciaDidactica[]
  recursos: string[]
  evidencias: string[]
  indicadores: string[]
}

const ETIQUETA_INICIO_BLOQUE = '📎 RESUMEN PARA GUARDAR'

// true si el texto es un borrador de planeación (trae el bloque de
// resumen). Lo usa el cliente para saber si "Apruébala" se refiere a una
// planeación (ver detectarAprobarPlaneacion) sin duplicar la etiqueta.
export function esBorradorPlaneacion(texto: string): boolean {
  return texto.includes(ETIQUETA_INICIO_BLOQUE)
}
const REGEX_FECHA = /^\d{4}-\d{2}-\d{2}$/

function extraerCampo(texto: string, etiqueta: string): string | null {
  const regex = new RegExp(`^${etiqueta}:\\s*(.+)$`, 'mi')
  const match = texto.match(regex)
  const valor = match?.[1]?.trim()
  return valor ? valor : null
}

function extraerLista(texto: string, etiqueta: string): string[] {
  const valor = extraerCampo(texto, etiqueta)
  if (!valor) return []
  return valor
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
}

function extraerDuracion(texto: string): number | null {
  const valor = extraerCampo(texto, 'Duración')
  if (!valor) return null
  const numero = parseInt(valor, 10)
  return Number.isFinite(numero) && numero > 0 ? numero : null
}

const REGEX_DIA = /^d[ií]a\s*(\d+)\s*:\s*(.+)$/i

function extraerSecuenciaDidactica(texto: string): DiaSecuenciaDidactica[] {
  const items = extraerLista(texto, 'Secuencia didáctica')
  const dias: DiaSecuenciaDidactica[] = []
  for (const item of items) {
    const match = item.match(REGEX_DIA)
    if (!match) continue
    const dia = parseInt(match[1], 10)
    const resumen = match[2].trim()
    if (Number.isFinite(dia) && dia > 0 && resumen) dias.push({ dia, resumen })
  }
  return dias
}

// Busca el bloque solo en el ÚLTIMO turno del asistente — "el borrador
// activo exacto" es siempre el más reciente, nunca uno más antiguo en
// la conversación (una corrección o una generación nueva invalida
// implícitamente cualquier resumen previo, ver instruccionesPlaneacionGenerar.ts).
// Devuelve null si no hay un turno de asistente al final, si no
// contiene el bloque, o si al bloque le faltan los datos indispensables
// (nombre y ambas fechas en formato YYYY-MM-DD) — en cualquiera de esos
// casos, quien llame debe tratarlo como "no hay borrador listo para guardar".
export function extraerResumenBorrador(historial: { role: string; content: string }[]): ResumenBorrador | null {
  const ultimo = historial[historial.length - 1]
  if (!ultimo || ultimo.role !== 'assistant') return null
  return extraerResumenDeTexto(ultimo.content)
}

function extraerResumenDeTexto(contenido: string): ResumenBorrador | null {
  const indiceBloque = contenido.indexOf(ETIQUETA_INICIO_BLOQUE)
  if (indiceBloque === -1) return null
  const bloque = contenido.slice(indiceBloque)

  const nombre = extraerCampo(bloque, 'Nombre')
  const fechaInicio = extraerCampo(bloque, 'Fecha de inicio')
  const fechaFin = extraerCampo(bloque, 'Fecha de fin')

  if (!nombre || !fechaInicio || !fechaFin) return null
  if (!REGEX_FECHA.test(fechaInicio) || !REGEX_FECHA.test(fechaFin)) return null

  return {
    nombre,
    grupoTexto: extraerCampo(bloque, 'Grupo'),
    periodoTexto: extraerCampo(bloque, 'Periodo de evaluación'),
    fechaInicio,
    fechaFin,
    duracionDias: extraerDuracion(bloque),
    proposito: extraerCampo(bloque, 'Propósito'),
    camposFormativos: extraerLista(bloque, 'Campos formativos'),
    contenidos: extraerLista(bloque, 'Contenidos'),
    pda: extraerLista(bloque, 'PDA'),
    ejesArticuladores: extraerLista(bloque, 'Ejes articuladores'),
    metodologia: extraerCampo(bloque, 'Metodología'),
    productoFinal: extraerCampo(bloque, 'Producto final'),
    secuenciaDidactica: extraerSecuenciaDidactica(bloque),
    recursos: extraerLista(bloque, 'Recursos'),
    evidencias: extraerLista(bloque, 'Evidencias'),
    indicadores: extraerLista(bloque, 'Indicadores de evaluación'),
  }
}

// Distingue "no hay ningún borrador presentado" de "hay un borrador,
// pero el bloque de resumen le falta un dato indispensable" — el
// mismo null de extraerResumenBorrador() no alcanza a diferenciar
// estos dos casos, y el docente merece un mensaje distinto para cada
// uno (ver Paso 3C, manejo de errores).
export function tieneBloqueResumen(historial: { role: string; content: string }[]): boolean {
  const ultimo = historial[historial.length - 1]
  return !!ultimo && ultimo.role === 'assistant' && ultimo.content.includes(ETIQUETA_INICIO_BLOQUE)
}

// Inicio fijo del mensaje con que /api/chat confirma una aprobación
// exitosa (ver app/api/chat/route.ts) — una sola fuente para que
// seleccionarBorradorVigente reconozca "esta planeación ya se guardó".
export const PREFIJO_CONFIRMACION_APROBACION = 'Listo, guardé la planeación de '

export type SeleccionBorrador =
  | { estado: 'listo'; resumen: ResumenBorrador; contenido: string }
  | { estado: 'sin_borrador' }
  | { estado: 'incompleto' }
  | { estado: 'ya_aprobado' }
  | { estado: 'otro_documento' }
  | { estado: 'no_reciente' }
  | { estado: 'referencia_no_vigente'; nombreVigente: string }

function normalizarNombre(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// El borrador VIGENTE para aprobar, dentro del historial de ESTA
// conversación (el que el cliente envía — nunca se consultan otras).
// A diferencia de extraerResumenBorrador, tolera respuestas intermedias
// (un error de guardado, una aclaración, "No encontré un borrador…")
// entre el borrador y la orden de aprobar. Reglas, recorriendo los
// turnos del asistente del más reciente al más antiguo:
// - El PRIMER turno con bloque de resumen es el único candidato: nunca
//   se cae a un borrador más antiguo, ni siquiera si el vigente está
//   incompleto (→ 'incompleto').
// - Si antes de llegar a él aparece la confirmación de una aprobación
//   exitosa (PREFIJO_CONFIRMACION_APROBACION), ese borrador ya se
//   guardó (→ 'ya_aprobado').
// - Si antes aparece otro documento formal (examen, circular…), no hay
//   certeza de qué se quiere aprobar (→ 'otro_documento').
// - Si entre el borrador y ahora hubo más de
//   MAXIMO_RESPUESTAS_DESPUES_DEL_BORRADOR respuestas del asistente, la
//   conversación ya siguió por otro lado: un bloque antiguo nunca basta
//   por sí solo para guardar (→ 'no_reciente').
// - Si mensajeDocente nombra otro borrador de la conversación distinto
//   del vigente (→ 'referencia_no_vigente'): nunca se aprueba uno viejo.
// Alcanza para un error de guardado, su reintento fallido y una
// aclaración — no para una conversación que ya cambió de tema.
export const MAXIMO_RESPUESTAS_DESPUES_DEL_BORRADOR = 3

export function seleccionarBorradorVigente(historial: { role: string; content: string }[], mensajeDocente = ''): SeleccionBorrador {
  let indiceVigente = -1
  let otroDocumentoDespues = false
  let respuestasDespues = 0
  for (let i = historial.length - 1; i >= 0; i--) {
    const turno = historial[i]
    if (turno.role !== 'assistant') continue
    if (turno.content.includes(ETIQUETA_INICIO_BLOQUE)) {
      indiceVigente = i
      break
    }
    if (turno.content.trim().startsWith(PREFIJO_CONFIRMACION_APROBACION)) return { estado: 'ya_aprobado' }
    if (esDocumentoFormal(turno.content)) otroDocumentoDespues = true
    respuestasDespues++
  }
  if (indiceVigente === -1) return { estado: 'sin_borrador' }
  if (otroDocumentoDespues) return { estado: 'otro_documento' }
  if (respuestasDespues > MAXIMO_RESPUESTAS_DESPUES_DEL_BORRADOR) return { estado: 'no_reciente' }

  const contenido = historial[indiceVigente].content
  const resumen = extraerResumenDeTexto(contenido)
  if (!resumen) return { estado: 'incompleto' }

  const mensaje = normalizarNombre(mensajeDocente)
  if (mensaje) {
    const nombreVigente = normalizarNombre(resumen.nombre)
    const restante = mensaje.split(nombreVigente).join(' ')
    for (let i = 0; i < indiceVigente; i++) {
      const turno = historial[i]
      if (turno.role !== 'assistant' || !turno.content.includes(ETIQUETA_INICIO_BLOQUE)) continue
      const bloque = turno.content.slice(turno.content.indexOf(ETIQUETA_INICIO_BLOQUE))
      const otro = normalizarNombre(extraerCampo(bloque, 'Nombre') ?? '')
      if (otro.length >= 4 && otro !== nombreVigente && restante.includes(otro)) {
        return { estado: 'referencia_no_vigente', nombreVigente: resumen.nombre }
      }
    }
  }

  return { estado: 'listo', resumen, contenido }
}

// El texto COMPLETO del borrador tal como Claude lo redactó (todos los
// elementos pedidos en instruccionesPlaneacionGenerar.ts — secuencia
// didáctica día por día completa, no el resumen breve que sí recorta
// secuenciaDidactica arriba) — usado para generar el documento de
// planeación descargable (corrección funcional "falta mostrar y
// descargar la planeación"): nunca un resumen reducido, la misma
// fuente completa que ya vio el docente en pantalla. Corta antes del
// bloque "📎 RESUMEN PARA GUARDAR" (ese bloque es un artefacto interno
// para guardar, no contenido del documento) y antes de la pregunta de
// cierre de aprobación si quedó pegada al final del bloque.
export function extraerTextoCompletoBorrador(texto: string): string {
  const indiceBloque = texto.indexOf(ETIQUETA_INICIO_BLOQUE)
  const sinResumen = indiceBloque === -1 ? texto : texto.slice(0, indiceBloque)
  return sinResumen.trim()
}
