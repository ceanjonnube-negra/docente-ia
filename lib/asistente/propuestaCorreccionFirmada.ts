// lib/asistente/propuestaCorreccionFirmada.ts
//
// SERVER-ONLY. Propuestas de corrección de datos de alumno (CURP, sexo,
// fecha de nacimiento) firmadas con HMAC-SHA256 — fase C4.
//
// El servidor firma la propuesta EXACTA que muestra al docente (alumno,
// nombre canónico, campo, valor anterior y nuevo, conversación, docente,
// fecha de generación y un propuestaId aleatorio). Al confirmar —por
// botón o por texto— el servidor verifica la firma ANTES de cualquier
// escritura y usa exclusivamente los valores firmados: nada que mande el
// cliente puede sustituirlos. El uso único lo garantiza la base de datos
// (propuestas_correccion_consumidas, PK = propuestaId, en la misma
// transacción que la escritura — ver
// 20261015000000_confirmar_correccion_alumno.sql).
//
// Mismo patrón que lib/listaOficial/propuestaFirmada.ts (JSON canónico,
// claves estrictas, comparación en tiempo constante, fail-closed sin
// secreto), con una clave INDEPENDIENTE: CORRECCION_ALUMNO_HMAC_SECRET_KEY.

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { CampoAlumnoCorregible, PayloadCorreccionAlumno, SobreCorreccionAlumno } from './tipos'

export const VERSION_PROPUESTA_CORRECCION = 1
export const VIGENCIA_PROPUESTA_CORRECCION_MS = 15 * 60_000
const TOLERANCIA_RELOJ_MS = 2 * 60_000
const LONGITUD_MINIMA_SECRETO = 32
const CAMPOS: CampoAlumnoCorregible[] = ['curp', 'sexo', 'fecha_nacimiento']
const CLAVES_PAYLOAD = ['v', 'propuestaId', 'docenteId', 'conversacionId', 'alumnoId', 'alumnoNombre', 'campo', 'valorAnterior', 'valorNuevo', 'generadoEn'] as const
const CLAVES_SOBRE = ['payload', 'firma'] as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type CodigoPropuestaNoValida =
  | 'PROPUESTA_SIN_FIRMA'
  | 'FIRMA_INVALIDA'
  | 'DOCENTE_NO_COINCIDE'
  | 'OTRA_CONVERSACION'
  | 'PROPUESTA_CADUCADA'
  | 'FIRMA_NO_DISPONIBLE'

export type ResultadoVerificacionPropuesta =
  | { ok: true; payload: PayloadCorreccionAlumno }
  | { ok: false; codigo: CodigoPropuestaNoValida }

// Mensaje claro para el docente. FIRMA_NO_DISPONIBLE es el único
// transitorio (falta configuración del servidor); los demás cierran la
// propuesta: hay que pedir una nueva.
export const MENSAJE_PROPUESTA_NO_VALIDA: Record<CodigoPropuestaNoValida, string> = {
  PROPUESTA_SIN_FIRMA: 'No apliqué la corrección: esta propuesta no tiene la verificación de seguridad necesaria. Pídeme de nuevo la corrección para mostrarte el dato actual',
  FIRMA_INVALIDA: 'No apliqué la corrección: la propuesta no pasó la verificación de seguridad. Pídeme de nuevo la corrección',
  DOCENTE_NO_COINCIDE: 'No apliqué la corrección: la propuesta no pasó la verificación de seguridad. Pídeme de nuevo la corrección',
  OTRA_CONVERSACION: 'No apliqué la corrección: esta propuesta pertenece a otra conversación. Pídeme de nuevo la corrección en esta conversación',
  PROPUESTA_CADUCADA: 'No apliqué la corrección: la propuesta caducó (son válidas 15 minutos). Pídeme de nuevo la corrección para revisar el dato actual',
  FIRMA_NO_DISPONIBLE: 'No pude verificar la propuesta en este momento, así que no hice ningún cambio. Intenta de nuevo más tarde',
}

function tieneExactamenteLasClaves(obj: Record<string, unknown>, claves: readonly string[]): boolean {
  const propias = Object.keys(obj)
  return propias.length === claves.length && claves.every((c) => Object.prototype.hasOwnProperty.call(obj, c))
}

const textoNoVacio = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0

export function esPayloadCorreccionValido(valor: unknown): valor is PayloadCorreccionAlumno {
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) return false
  const o = valor as Record<string, unknown>
  if (!tieneExactamenteLasClaves(o, CLAVES_PAYLOAD)) return false
  return (
    o.v === VERSION_PROPUESTA_CORRECCION &&
    typeof o.propuestaId === 'string' && UUID.test(o.propuestaId) &&
    typeof o.docenteId === 'string' && UUID.test(o.docenteId) &&
    typeof o.conversacionId === 'string' && UUID.test(o.conversacionId) &&
    typeof o.alumnoId === 'string' && UUID.test(o.alumnoId) &&
    textoNoVacio(o.alumnoNombre) &&
    typeof o.campo === 'string' && (CAMPOS as string[]).includes(o.campo) &&
    (o.valorAnterior === null || typeof o.valorAnterior === 'string') &&
    textoNoVacio(o.valorNuevo) &&
    o.valorAnterior !== o.valorNuevo &&
    textoNoVacio(o.generadoEn) && !Number.isNaN(Date.parse(o.generadoEn))
  )
}

// Orden fijo de claves: la firma nunca depende del orden en que llegó el JSON.
function canonico(p: PayloadCorreccionAlumno): string {
  return JSON.stringify({
    v: p.v,
    propuestaId: p.propuestaId,
    docenteId: p.docenteId,
    conversacionId: p.conversacionId,
    alumnoId: p.alumnoId,
    alumnoNombre: p.alumnoNombre,
    campo: p.campo,
    valorAnterior: p.valorAnterior,
    valorNuevo: p.valorNuevo,
    generadoEn: p.generadoEn,
  })
}

function leerSecretoServerOnly(): string | null {
  const valor = process.env.CORRECCION_ALUMNO_HMAC_SECRET_KEY
  return typeof valor === 'string' && valor.length >= LONGITUD_MINIMA_SECRETO ? valor : null
}

export function construirPayloadCorreccion(
  datos: Omit<PayloadCorreccionAlumno, 'v' | 'propuestaId' | 'generadoEn'>,
  ahora: Date = new Date()
): PayloadCorreccionAlumno {
  return { v: VERSION_PROPUESTA_CORRECCION, propuestaId: randomUUID(), ...datos, generadoEn: ahora.toISOString() }
}

export function firmarConSecreto(payload: PayloadCorreccionAlumno, secreto: string): SobreCorreccionAlumno {
  if (!esPayloadCorreccionValido(payload)) throw new Error('Payload de propuesta de corrección inválido — no se firma.')
  const canon = JSON.parse(canonico(payload)) as PayloadCorreccionAlumno
  return { payload: canon, firma: createHmac('sha256', secreto).update(canonico(canon)).digest('hex') }
}

export function verificarConSecreto(
  sobre: unknown,
  secreto: string,
  esperado: { docenteId: string; conversacionId: string; ahora: Date }
): ResultadoVerificacionPropuesta {
  if (sobre === null || sobre === undefined) return { ok: false, codigo: 'PROPUESTA_SIN_FIRMA' }
  if (typeof sobre !== 'object' || Array.isArray(sobre)) return { ok: false, codigo: 'FIRMA_INVALIDA' }
  const o = sobre as Record<string, unknown>
  if (!tieneExactamenteLasClaves(o, CLAVES_SOBRE) || typeof o.firma !== 'string' || !/^[0-9a-f]{64}$/.test(o.firma) || !esPayloadCorreccionValido(o.payload)) {
    return { ok: false, codigo: 'FIRMA_INVALIDA' }
  }
  const recibida = Buffer.from(o.firma, 'hex')
  const calculada = createHmac('sha256', secreto).update(canonico(o.payload)).digest()
  if (recibida.length !== calculada.length || !timingSafeEqual(recibida, calculada)) return { ok: false, codigo: 'FIRMA_INVALIDA' }
  const payload = o.payload
  if (payload.docenteId !== esperado.docenteId) return { ok: false, codigo: 'DOCENTE_NO_COINCIDE' }
  if (payload.conversacionId !== esperado.conversacionId) return { ok: false, codigo: 'OTRA_CONVERSACION' }
  const edad = esperado.ahora.getTime() - Date.parse(payload.generadoEn)
  if (edad > VIGENCIA_PROPUESTA_CORRECCION_MS || edad < -TOLERANCIA_RELOJ_MS) return { ok: false, codigo: 'PROPUESTA_CADUCADA' }
  return { ok: true, payload }
}

// API de producción. Fail-closed: sin secreto real no se firma (null) y
// la verificación nunca da "válido por defecto". El secreto nunca se
// registra ni se incluye en ningún error.
export function firmarPropuestaCorreccion(payload: PayloadCorreccionAlumno): SobreCorreccionAlumno | null {
  const secreto = leerSecretoServerOnly()
  return secreto ? firmarConSecreto(payload, secreto) : null
}

export function verificarPropuestaCorreccion(
  sobre: unknown,
  esperado: { docenteId: string; conversacionId: string; ahora?: Date }
): ResultadoVerificacionPropuesta {
  const secreto = leerSecretoServerOnly()
  if (!secreto) return { ok: false, codigo: 'FIRMA_NO_DISPONIBLE' }
  return verificarConSecreto(sobre, secreto, { ...esperado, ahora: esperado.ahora ?? new Date() })
}
