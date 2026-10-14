// lib/asistente/estadoPendiente.ts
//
// SERVER-ONLY. Continuidad conversacional V1 — consultas y propuestas de
// corrección de datos de alumno (consultar_dato_alumno,
// corregir_dato_alumno en modo proponer).
//
// Cuando el servidor pide una aclaración ("¿De qué alumno?", "¿Qué dato?",
// "¿Cuál es el valor correcto?"), adjunta un ESTADO PENDIENTE firmado con
// lo que ya se sabe de la solicitud: intención, alumno (ya validado por la
// identidad canónica C1), candidatos de una ambigüedad y campo. Nunca
// CURP, fechas ni valores personales. El cliente lo guarda en el mensaje
// (persistencia genérica) y lo reenvía SOLO mientras ese mensaje sea el
// último. En el siguiente turno el servidor lo verifica (firma, docente,
// conversación autorizada, vigencia), revalida al alumno contra el grupo
// activo y lo entrega al clasificador (misma llamada); después, una
// fusión determinista rellena únicamente lo que falte. Lo explícito del
// mensaje siempre prevalece; un cambio de tema descarta el estado. Nunca
// produce confirmaciones ni escrituras: a lo sumo una CONSULTA (solo
// lectura) o una PROPUESTA de corrección (que sigue exigiendo firma C4 y
// confirmación explícita).
//
// Firma: HMAC-SHA256 con una SUBCLAVE derivada de
// CORRECCION_ALUMNO_HMAC_SECRET_KEY con separación de dominio — la firma y
// el contrato de las propuestas de C4 (propuestaCorreccionFirmada.ts) no
// cambian, y un sobre de un dominio nunca es válido en el otro.

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { ClasificacionNivel0 } from '../clasificadorNivel0'
import type { AlumnoLigero } from '../sesionContexto'
import type { CampoAlumnoCorregible, PayloadEstadoPendiente, SobreEstadoPendiente } from './tipos'

export const VERSION_ESTADO_PENDIENTE = 1
export const VIGENCIA_ESTADO_PENDIENTE_MS = 30 * 60_000
const TOLERANCIA_RELOJ_MS = 2 * 60_000
const LONGITUD_MINIMA_SECRETO = 32
const DOMINIO_SUBCLAVE = 'docente-ia/estado-pendiente/v1'
const INTENCIONES = ['consultar_dato_alumno', 'corregir_dato_alumno'] as const
const CAMPOS: CampoAlumnoCorregible[] = ['curp', 'sexo', 'fecha_nacimiento']
const FALTANTES = ['alumno', 'campo', 'valor'] as const
const MAX_CANDIDATOS = 5
const CLAVES_PAYLOAD = ['v', 'docenteId', 'conversacionId', 'intencion', 'alumnoId', 'candidatos', 'campo', 'faltante', 'generadoEn'] as const
const CLAVES_SOBRE = ['payload', 'firma'] as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type IntencionEstadoPendiente = (typeof INTENCIONES)[number]
export type FaltanteEstadoPendiente = (typeof FALTANTES)[number]

export function esIntencionContinuable(intencion: string): intencion is IntencionEstadoPendiente {
  return (INTENCIONES as readonly string[]).includes(intencion)
}

function tieneExactamenteLasClaves(obj: Record<string, unknown>, claves: readonly string[]): boolean {
  const propias = Object.keys(obj)
  return propias.length === claves.length && claves.every((c) => Object.prototype.hasOwnProperty.call(obj, c))
}

export function esPayloadEstadoPendienteValido(valor: unknown): valor is PayloadEstadoPendiente {
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) return false
  const o = valor as Record<string, unknown>
  if (!tieneExactamenteLasClaves(o, CLAVES_PAYLOAD)) return false
  return (
    o.v === VERSION_ESTADO_PENDIENTE &&
    typeof o.docenteId === 'string' && UUID.test(o.docenteId) &&
    typeof o.conversacionId === 'string' && UUID.test(o.conversacionId) &&
    typeof o.intencion === 'string' && esIntencionContinuable(o.intencion) &&
    (o.alumnoId === null || (typeof o.alumnoId === 'string' && UUID.test(o.alumnoId))) &&
    Array.isArray(o.candidatos) && o.candidatos.length <= MAX_CANDIDATOS && o.candidatos.every((c) => typeof c === 'string' && UUID.test(c)) &&
    (o.campo === null || (typeof o.campo === 'string' && (CAMPOS as string[]).includes(o.campo))) &&
    typeof o.faltante === 'string' && (FALTANTES as readonly string[]).includes(o.faltante) &&
    typeof o.generadoEn === 'string' && !Number.isNaN(Date.parse(o.generadoEn))
  )
}

function canonico(p: PayloadEstadoPendiente): string {
  return JSON.stringify({
    v: p.v, docenteId: p.docenteId, conversacionId: p.conversacionId, intencion: p.intencion,
    alumnoId: p.alumnoId, candidatos: p.candidatos, campo: p.campo, faltante: p.faltante, generadoEn: p.generadoEn,
  })
}

// Subclave del dominio "estado pendiente": nunca la clave de C4 tal cual.
function subclave(secreto: string): Buffer {
  return createHmac('sha256', secreto).update(DOMINIO_SUBCLAVE).digest()
}

function leerSecretoServerOnly(): string | null {
  const valor = process.env.CORRECCION_ALUMNO_HMAC_SECRET_KEY
  return typeof valor === 'string' && valor.length >= LONGITUD_MINIMA_SECRETO ? valor : null
}

export function firmarEstadoConSecreto(payload: PayloadEstadoPendiente, secreto: string): SobreEstadoPendiente {
  if (!esPayloadEstadoPendienteValido(payload)) throw new Error('Estado pendiente inválido — no se firma.')
  const canon = JSON.parse(canonico(payload)) as PayloadEstadoPendiente
  return { payload: canon, firma: createHmac('sha256', subclave(secreto)).update(canonico(canon)).digest('hex') }
}

export function verificarEstadoConSecreto(
  sobre: unknown,
  secreto: string,
  esperado: { docenteId: string; conversacionId: string; ahora: Date }
): PayloadEstadoPendiente | null {
  if (typeof sobre !== 'object' || sobre === null || Array.isArray(sobre)) return null
  const o = sobre as Record<string, unknown>
  if (!tieneExactamenteLasClaves(o, CLAVES_SOBRE) || typeof o.firma !== 'string' || !/^[0-9a-f]{64}$/.test(o.firma) || !esPayloadEstadoPendienteValido(o.payload)) return null
  const recibida = Buffer.from(o.firma, 'hex')
  const calculada = createHmac('sha256', subclave(secreto)).update(canonico(o.payload)).digest()
  if (recibida.length !== calculada.length || !timingSafeEqual(recibida, calculada)) return null
  const p = o.payload
  if (p.docenteId !== esperado.docenteId || p.conversacionId !== esperado.conversacionId) return null
  const edad = esperado.ahora.getTime() - Date.parse(p.generadoEn)
  if (edad > VIGENCIA_ESTADO_PENDIENTE_MS || edad < -TOLERANCIA_RELOJ_MS) return null
  return p
}

// Construye y firma el estado que acompaña a una aclaración. Sin clave
// del servidor (fail-closed) no hay continuidad: la aclaración se envía
// igual, sin estado.
export function emitirEstadoPendiente(datos: {
  docenteId: string | null
  conversacionId: string | null
  intencion: string
  alumnoId: string | null
  candidatos?: string[]
  campo: string | null
  faltante: FaltanteEstadoPendiente
}, ahora: Date = new Date()): SobreEstadoPendiente | null {
  const secreto = leerSecretoServerOnly()
  if (!secreto || !datos.docenteId || !datos.conversacionId || !esIntencionContinuable(datos.intencion)) return null
  const campo = datos.campo && (CAMPOS as string[]).includes(datos.campo) ? (datos.campo as CampoAlumnoCorregible) : null
  const payload: PayloadEstadoPendiente = {
    v: VERSION_ESTADO_PENDIENTE,
    docenteId: datos.docenteId,
    conversacionId: datos.conversacionId,
    intencion: datos.intencion,
    alumnoId: datos.alumnoId,
    candidatos: (datos.candidatos ?? []).slice(0, MAX_CANDIDATOS),
    campo,
    faltante: datos.faltante,
    generadoEn: ahora.toISOString(),
  }
  return esPayloadEstadoPendienteValido(payload) ? firmarEstadoConSecreto(payload, secreto) : null
}

export function marcadorEstadoPendiente(sobre: SobreEstadoPendiente | null): string {
  return sobre ? `\n[[ESTADO_PENDIENTE:${Buffer.from(JSON.stringify(sobre), 'utf-8').toString('base64')}]]` : ''
}

// Estado entrante ya verificado y revalidado contra el grupo activo.
export type EstadoPendienteVigente = {
  intencion: IntencionEstadoPendiente
  faltante: FaltanteEstadoPendiente
  campo: CampoAlumnoCorregible | null
  alumno: AlumnoLigero | null
  candidatos: AlumnoLigero[]
}

// Verifica el estado que mandó el cliente y revalida sus alumnos contra
// el grupo activo ACTUAL. Cualquier fallo → null (el turno se clasifica
// como siempre, sin continuidad). Un alumno heredado o cualquier candidato
// que ya no esté en el grupo descarta el estado completo.
export function prepararEstadoPendiente(
  sobre: unknown,
  ctx: { docenteId: string | null; conversacionId: string | null; roster: AlumnoLigero[]; ahora?: Date }
): EstadoPendienteVigente | null {
  const secreto = leerSecretoServerOnly()
  if (!secreto || !ctx.docenteId || !ctx.conversacionId || sobre === null || sobre === undefined) return null
  const p = verificarEstadoConSecreto(sobre, secreto, { docenteId: ctx.docenteId, conversacionId: ctx.conversacionId, ahora: ctx.ahora ?? new Date() })
  if (!p) return null
  const delGrupo = (id: string) => ctx.roster.find((a) => a.alumno_id === id) ?? null
  const alumno = p.alumnoId ? delGrupo(p.alumnoId) : null
  if (p.alumnoId && !alumno) return null
  // Si cualquier candidato firmado ya no pertenece al grupo, se descarta
  // el estado completo: una ambigüedad nunca se reduce a un único
  // candidato por eliminación.
  const candidatos = p.candidatos.map(delGrupo)
  if (candidatos.some((a) => !a)) return null
  return { intencion: p.intencion, faltante: p.faltante, campo: p.campo, alumno, candidatos: candidatos as AlumnoLigero[] }
}

// Texto estructurado para el contexto dinámico del clasificador (sin CURP
// ni fechas: solo intención, dato faltante, campo y nombres canónicos).
export function estadoPendienteParaClasificador(e: EstadoPendienteVigente): string {
  return [
    `intencion_en_curso: ${e.intencion}`,
    `dato_que_pidio_el_asistente: ${e.faltante}`,
    `campo_en_curso: ${e.campo ?? 'ninguno'}`,
    `alumno_en_curso: ${e.alumno ? e.alumno.nombre_completo : 'ninguno'}`,
    `alumnos_candidatos: ${e.candidatos.length ? e.candidatos.map((a) => a.nombre_completo).join(' | ') : 'ninguno'}`,
  ].join('\n')
}

export type ResultadoFusionPendiente =
  | { tipo: 'sin_cambios' }
  | { tipo: 'cancelar' }
  | { tipo: 'fusionado'; alumnoHeredadoId: string | null }

const campoExplicito = (c: ClasificacionNivel0): CampoAlumnoCorregible | null =>
  (c.campo_alumno_corregir ?? c.campo_alumno_solicitado ?? null) as CampoAlumnoCorregible | null

// Fusión DETERMINISTA tras la clasificación. Solo actúa si el clasificador
// marcó continua_pendiente=true y el resultado pertenece a la familia de
// datos de alumno. Lo explícito del mensaje nunca se sobrescribe. Muta la
// clasificación recibida (mismo objeto que usa /api/chat).
export function fusionarConPendiente(c: ClasificacionNivel0, e: EstadoPendienteVigente): ResultadoFusionPendiente {
  if (!c.continua_pendiente) return { tipo: 'sin_cambios' }
  // Confirmar/cancelar una PROPUESTA pertenece al flujo C2–C4 (propuesta
  // pendiente firmada), nunca a este estado.
  if (c.accion_correccion_alumno === 'confirmar' || c.accion_correccion_alumno === 'cancelar') return { tipo: 'sin_cambios' }
  const op = c.operacion_pendiente
  if (op === 'cancelar') return { tipo: 'cancelar' }

  // Intención final: la de la operación, o la del clasificador si ya es
  // de la familia; desde conversación general solo con una operación.
  let intencion: IntencionEstadoPendiente | null = null
  if (op === 'consultar_registrado') intencion = 'consultar_dato_alumno'
  else if (op === 'aportar_valor' || op === 'comparar') intencion = 'corregir_dato_alumno'
  else if (esIntencionContinuable(c.intencion_principal)) intencion = c.intencion_principal
  else if (op === 'confirmar_candidato' || op === 'cambiar_campo') intencion = e.intencion
  if (!intencion) return { tipo: 'sin_cambios' }
  if (!esIntencionContinuable(c.intencion_principal) && c.intencion_principal !== 'conversacion_general' && c.intencion_principal !== 'intencion_no_reconocida') {
    return { tipo: 'sin_cambios' } // otra herramienta explícita: cambio de tema
  }

  // Alumno: explícito > candidato confirmado (solo si era uno) > heredado.
  let alumnoHeredadoId: string | null = null
  if (!c.entidades_resueltas.alumno_id && !c.entidades_resueltas.alumno_ambiguo) {
    const heredado = op === 'confirmar_candidato'
      ? (e.candidatos.length === 1 ? e.candidatos[0] : null)
      : e.alumno
    if (heredado) {
      c.entidades_resueltas = { alumno_id: heredado.alumno_id, alumno_nombre_detectado: heredado.nombre_completo, alumno_ambiguo: false, opciones_alumno_ambiguo: [] }
      alumnoHeredadoId = heredado.alumno_id
    } else if (op === 'confirmar_candidato' && e.candidatos.length > 1) {
      c.entidades_resueltas = { alumno_id: null, alumno_nombre_detectado: null, alumno_ambiguo: true, opciones_alumno_ambiguo: e.candidatos.map((a) => a.nombre_completo) }
    }
  }
  const campo = campoExplicito(c) ?? e.campo

  c.intencion_principal = intencion
  const faltan = new Set(c.datos_faltantes)
  if (c.entidades_resueltas.alumno_id) faltan.delete('alumno')
  if (intencion === 'consultar_dato_alumno') {
    // Solo lectura: nunca acción de corrección ni valor.
    c.campo_alumno_solicitado = campo
    c.campo_alumno_corregir = null
    c.accion_correccion_alumno = null
    c.modo_operacion_alumno = null
    c.valor_alumno_propuesto = null
    faltan.delete('valor_alumno')
    if (campo) faltan.delete('campo_alumno'); else faltan.add('campo_alumno')
  } else {
    // Propuesta (nunca confirmación). "compáralo" sin valor → se pide.
    c.campo_alumno_corregir = campo
    c.accion_correccion_alumno = 'proponer'
    c.modo_operacion_alumno = op === 'comparar' ? 'comparar' : (c.modo_operacion_alumno ?? 'corregir')
    if (campo) faltan.delete('campo_alumno'); else faltan.add('campo_alumno')
    if (c.valor_alumno_propuesto) faltan.delete('valor_alumno'); else faltan.add('valor_alumno')
  }
  if (!c.entidades_resueltas.alumno_id && !c.entidades_resueltas.alumno_ambiguo) faltan.add('alumno')
  c.datos_faltantes = [...faltan]
  return { tipo: 'fusionado', alumnoHeredadoId }
}
