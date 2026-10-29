// lib/listaOficial/sobreCifrado.ts
//
// LISTA-P5 (2b) — el navegador nunca recibe el sobre firmado de una
// propuesta (lleva identificadores internos, CURP actuales y lecturas de
// la foto). Recibe un token opaco: el sobre completo cifrado con
// AES-256-GCM (confidencialidad e integridad), con una clave derivada por
// HKDF del mismo secreto HMAC, en un dominio propio. El sobre de dentro
// conserva su firma HMAC y se verifica igual que antes: el token no
// sustituye ninguna validación, solo oculta el contenido.
//
// También normaliza las dos formas de solicitar la aplicación (la de 2a
// con el sobre y confirmaciones, y la de 2b con token e identificadores)
// a un único { sobre, confirmaciones } para el mismo camino de validación.
//
// MÓDULO SERVER-ONLY (node:crypto).

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { leerSecretoServerOnly } from './propuestaFirmada'
import { construirVistaPropuesta, type PropuestaListaParaCliente } from './vistaPropuestaLista'
import type { ConfirmacionOperacionLista, SobrePropuestaActualizacionLista } from './propuestaActualizacionLista'

const VERSION_TOKEN = 'v1'
const SAL_HKDF = 'docente-ia:lista-oficial'
const INFO_HKDF = 'docente-ia:lista-oficial:cifrado-propuesta:v1'
const LARGO_IV = 12
const LARGO_ETIQUETA = 16

function claveCifrado(secreto: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secreto, SAL_HKDF, INFO_HKDF, 32))
}

export function cifrarSobrePropuesta(sobre: SobrePropuestaActualizacionLista, secreto: string): string {
  const iv = randomBytes(LARGO_IV)
  const cifrador = createCipheriv('aes-256-gcm', claveCifrado(secreto), iv)
  cifrador.setAAD(Buffer.from(VERSION_TOKEN))
  const cifrado = Buffer.concat([cifrador.update(JSON.stringify(sobre), 'utf8'), cifrador.final()])
  return [VERSION_TOKEN, iv.toString('base64url'), cifrado.toString('base64url'), cifrador.getAuthTag().toString('base64url')].join('.')
}

// null ante cualquier token mal formado, alterado o de otra clave.
export function descifrarSobrePropuesta(token: unknown, secreto: string): unknown {
  if (typeof token !== 'string') return null
  const partes = token.split('.')
  if (partes.length !== 4 || partes[0] !== VERSION_TOKEN) return null
  try {
    const iv = Buffer.from(partes[1], 'base64url')
    const cifrado = Buffer.from(partes[2], 'base64url')
    const etiqueta = Buffer.from(partes[3], 'base64url')
    if (iv.length !== LARGO_IV || etiqueta.length !== LARGO_ETIQUETA || cifrado.length === 0) return null
    const descifrador = createDecipheriv('aes-256-gcm', claveCifrado(secreto), iv, { authTagLength: LARGO_ETIQUETA })
    descifrador.setAAD(Buffer.from(VERSION_TOKEN))
    descifrador.setAuthTag(etiqueta)
    const plano = Buffer.concat([descifrador.update(cifrado), descifrador.final()]).toString('utf8')
    return JSON.parse(plano)
  } catch {
    return null
  }
}

// Lo que /api/chat entrega al navegador. null sin secreto (no se envía nada).
export function prepararPropuestaParaCliente(sobre: SobrePropuestaActualizacionLista): PropuestaListaParaCliente | null {
  const secreto = leerSecretoServerOnly()
  if (!secreto) return null
  return { token: cifrarSobrePropuesta(sobre, secreto), expiraEn: sobre.payload.expiraEn, operaciones: construirVistaPropuesta(sobre.payload) }
}

export type SolicitudAplicacionNormalizada =
  | { ok: true; sobre: unknown; confirmaciones: unknown }
  | { ok: false; codigo: 'SOLICITUD_INVALIDA' | 'TOKEN_INVALIDO' }

// Formato 2a: { sobre, confirmaciones } — pasa tal cual.
// Formato 2b: { token, operacionIds } — se descifra y cada confirmación se
// arma desde la operación firmada (alumno e inscripción del sobre, nunca
// del cliente; sin autorización de baja). Un id que no esté en la
// propuesta viaja tal cual para que la evaluación lo rechace.
// La firma, la identidad y todo lo demás lo sigue validando el llamador
// con evaluarSolicitudAplicacionLista y la RPC.
export function normalizarSolicitudAplicacion(cuerpo: Record<string, unknown>, secreto: string): SolicitudAplicacionNormalizada {
  const conToken = cuerpo.token !== undefined
  const conSobre = cuerpo.sobre !== undefined
  if (conToken === conSobre) return { ok: false, codigo: 'SOLICITUD_INVALIDA' }
  if (conSobre) return { ok: true, sobre: cuerpo.sobre, confirmaciones: cuerpo.confirmaciones }

  if (cuerpo.confirmaciones !== undefined) return { ok: false, codigo: 'SOLICITUD_INVALIDA' }
  const sobre = descifrarSobrePropuesta(cuerpo.token, secreto)
  if (sobre === null) return { ok: false, codigo: 'TOKEN_INVALIDO' }
  const ids = cuerpo.operacionIds
  if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string' && x.length > 0)) return { ok: false, codigo: 'SOLICITUD_INVALIDA' }
  const operaciones = (sobre as { payload?: { operaciones?: unknown } }).payload?.operaciones
  const porId = new Map((Array.isArray(operaciones) ? operaciones : []).map((op) => [(op as { operacionId: string }).operacionId, op as { alumnoId: string | null; inscripcionId: string | null }]))
  const confirmaciones: ConfirmacionOperacionLista[] = (ids as string[]).map((operacionId) => {
    const op = porId.get(operacionId)
    return { operacionId, alumnoId: op?.alumnoId ?? null, inscripcionId: op?.inscripcionId ?? null, autorizaBaja: false }
  })
  return { ok: true, sobre, confirmaciones }
}
