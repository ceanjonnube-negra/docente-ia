// lib/listaOficial/propuestaFirmada.ts
//
// V1-C2 — contrato HMAC de la propuesta de actualización de lista
// oficial. MÓDULO SERVER-ONLY: usa node:crypto, nunca debe importarse
// desde código que corre en el navegador (AsistenteService.ts,
// motorTextoClaude.ts) — esos archivos hacen su PROPIA validación de
// forma mínima, deliberadamente duplicada en el shape-check (nunca en
// la lógica criptográfica), precisamente para no arrastrar node:crypto
// al bundle del cliente.
//
// Esta fase (V1-C2) SOLO prepara la infraestructura: firmar/verificar
// la integridad criptográfica del sobre. NUNCA valida aquí auth.uid(),
// ownership de la conversación, expiración, ni ownership del alumno —
// eso es exclusivamente responsabilidad de V1-D, que es quien de
// verdad puede autorizar una escritura real.

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { CambioListaOficialFirmable, PayloadPropuestaListaOficial, PropuestaListaOficialFirmada } from '../asistente/tipos'

const CAMPOS_ACCIONABLES_VALIDOS: CambioListaOficialFirmable['campo'][] = ['curp']

// V1-C2.1 (hardening) — un objeto con TODAS las claves correctas MÁS
// alguna extra ya no cuenta como válido: esa propiedad extra viajaría
// completa dentro de mensajes_chat.contenido sin que la firma HMAC la
// proteja en absoluto (canonicalizar() ya la excluía de lo firmado,
// pero "excluida de la firma" y "rechazada por completo" son cosas
// distintas — este cambio cierra esa diferencia). whitelist exacta:
// mismo número de claves Y mismos nombres, nunca más ni menos.
function tieneExactamenteLasClaves(obj: Record<string, unknown>, clavesPermitidas: readonly string[]): boolean {
  const claves = Object.keys(obj)
  if (claves.length !== clavesPermitidas.length) return false
  return clavesPermitidas.every((clave) => Object.prototype.hasOwnProperty.call(obj, clave))
}

const CLAVES_CAMBIO = ['alumnoId', 'campo', 'valorPropuesto'] as const
const CLAVES_PAYLOAD = ['docenteId', 'conversacionId', 'generadoEn', 'propuesta'] as const
const CLAVES_SOBRE = ['payload', 'firma'] as const

// Validación estructural pura — nunca decide autorización, solo forma.
// Reutilizada por firmar/verificar (nunca una segunda implementación
// server-side) y expuesta para que un futuro V1-D pueda reusarla antes
// de confiar en el resto del sobre.
export function esCambioListaOficialValido(valor: unknown): valor is CambioListaOficialFirmable {
  if (typeof valor !== 'object' || valor === null) return false
  const o = valor as Record<string, unknown>
  if (!tieneExactamenteLasClaves(o, CLAVES_CAMBIO)) return false
  return (
    typeof o.alumnoId === 'string' && o.alumnoId.length > 0 &&
    typeof o.campo === 'string' && (CAMPOS_ACCIONABLES_VALIDOS as string[]).includes(o.campo) &&
    typeof o.valorPropuesto === 'string' && o.valorPropuesto.length > 0
  )
}

export function esPayloadPropuestaListaOficialValido(valor: unknown): valor is PayloadPropuestaListaOficial {
  if (typeof valor !== 'object' || valor === null) return false
  const o = valor as Record<string, unknown>
  if (!tieneExactamenteLasClaves(o, CLAVES_PAYLOAD)) return false
  return (
    typeof o.docenteId === 'string' && o.docenteId.length > 0 &&
    typeof o.conversacionId === 'string' && o.conversacionId.length > 0 &&
    typeof o.generadoEn === 'string' && o.generadoEn.length > 0 &&
    // Una propuesta firmada solo existe cuando V1-C encontró al menos
    // un resultado accionable — propuesta=[] nunca debe poder firmarse
    // ni verificarse como válida (ver diseño aprobado V1-C2.1).
    Array.isArray(o.propuesta) && o.propuesta.length >= 1 && o.propuesta.every(esCambioListaOficialValido)
  )
}

// Reconstruye el objeto canónico EXPLÍCITAMENTE (nunca firma el objeto
// recibido tal cual) — orden de claves fijo a nivel de payload, y por
// cada entrada de `propuesta` solo los 3 campos permitidos, en el
// mismo orden que llegaron (nunca se reordena el array: "el mismo
// payload debe producir siempre la misma firma", no "el mismo
// conjunto"). Cualquier propiedad adicional presente en runtime queda
// fuera de la representación canónica sin excepción.
function construirPayloadCanonico(payload: PayloadPropuestaListaOficial): PayloadPropuestaListaOficial {
  return {
    docenteId: payload.docenteId,
    conversacionId: payload.conversacionId,
    generadoEn: payload.generadoEn,
    propuesta: payload.propuesta.map((c) => ({ alumnoId: c.alumnoId, campo: c.campo, valorPropuesto: c.valorPropuesto })),
  }
}

function canonicalizar(payload: PayloadPropuestaListaOficial): string {
  return JSON.stringify(construirPayloadCanonico(payload))
}

// Validación mínima del secreto — no es una medida de fuerza
// criptográfica (eso lo garantiza HMAC-SHA256 en sí), es una guarda de
// sanidad contra un valor vacío/placeholder que llegara por error
// (".env sin configurar" suele dejar la variable vacía o ausente,
// nunca corta-pero-real).
const LONGITUD_MINIMA_SECRETO = 16

function leerSecretoServerOnly(): string | null {
  const valor = process.env.LISTA_OFICIAL_HMAC_SECRET_KEY
  return typeof valor === 'string' && valor.length >= LONGITUD_MINIMA_SECRETO ? valor : null
}

// --- Núcleo testable — recibe el secreto explícito, nunca lee
// process.env por sí mismo. Únicamente para pruebas mecánicas y para
// las 2 funciones públicas de abajo, que son el ÚNICO camino que debe
// usar código de producción real.

export function firmarConSecreto(payload: PayloadPropuestaListaOficial, secreto: string): PropuestaListaOficialFirmada {
  if (!esPayloadPropuestaListaOficialValido(payload)) {
    throw new Error('Payload de propuesta de lista oficial inválido — no se firma.')
  }
  const payloadCanonico = construirPayloadCanonico(payload)
  const firma = createHmac('sha256', secreto).update(canonicalizar(payloadCanonico)).digest('hex')
  return { payload: payloadCanonico, firma }
}

export function verificarConSecreto(sobre: unknown, secreto: string): boolean {
  if (typeof sobre !== 'object' || sobre === null) return false
  const o = sobre as Record<string, unknown>
  // Mismo criterio de whitelist exacta a nivel del sobre completo — una
  // propiedad extra top-level (ej. "extra": "algo") tampoco pasa.
  if (!tieneExactamenteLasClaves(o, CLAVES_SOBRE)) return false
  if (typeof o.firma !== 'string' || o.firma.length === 0) return false
  if (!esPayloadPropuestaListaOficialValido(o.payload)) return false

  const firmaEsperadaHex = createHmac('sha256', secreto).update(canonicalizar(o.payload)).digest('hex')

  let bufRecibido: Buffer
  let bufEsperado: Buffer
  try {
    bufRecibido = Buffer.from(o.firma, 'hex')
    bufEsperado = Buffer.from(firmaEsperadaHex, 'hex')
  } catch {
    return false
  }
  // timingSafeEqual exige buffers de igual longitud — una firma con
  // longitud/formato inválido nunca debe lanzar, solo ser inválida.
  if (bufRecibido.length !== bufEsperado.length) return false
  try {
    return timingSafeEqual(bufRecibido, bufEsperado)
  } catch {
    return false
  }
}

// --- API de producción — únicas funciones que V1-C3/V1-D deben llamar.
// Fail-closed real: sin secreto real, firmar lanza (nunca genera una
// firma vacía/falsa) y verificar devuelve false (nunca "válido por
// defecto"). El secreto nunca se loguea ni se incluye en ningún error.

export function firmarPropuestaListaOficial(payload: PayloadPropuestaListaOficial): PropuestaListaOficialFirmada {
  const secreto = leerSecretoServerOnly()
  if (!secreto) {
    throw new Error('LISTA_OFICIAL_HMAC_SECRET_KEY ausente o inválida — no se firma sin secreto real (fail-closed).')
  }
  return firmarConSecreto(payload, secreto)
}

export function verificarPropuestaListaOficialFirmada(sobre: unknown): boolean {
  const secreto = leerSecretoServerOnly()
  if (!secreto) return false
  return verificarConSecreto(sobre, secreto)
}
