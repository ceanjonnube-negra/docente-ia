// lib/asistente/textoFinalChat.ts
//
// Texto final de una respuesta del Chat fijado por el servidor después del
// streaming (Hito 1 — normalización curricular del borrador de
// planeación): el modelo ya transmitió su texto, y el servidor manda al
// final [[TEXTO_FINAL:base64]] con la versión normalizada (una sola
// sección de contenidos y PDA, en su lugar). El cliente la adopta como
// texto del mensaje, que es el que se guarda y se reenvía en el
// historial. Sin marcador, nada cambia.

import { extraerMarcadorRecuperado } from './documentos'
import type { ArchivoGeneradoInfo } from './tipos'

export const PATRON_TEXTO_FINAL = /\[\[TEXTO_FINAL:([^\]]*)(\]\])?/

export function extraerTextoFinal(respuesta: string): { texto: string; textoFinal?: string } {
  const match = respuesta.match(PATRON_TEXTO_FINAL)
  if (!match) return { texto: respuesta }
  const texto = respuesta.replace(match[0], '').trim()
  if (!match[2]) return { texto } // marcador incompleto: se ignora
  try {
    const bytes = Uint8Array.from(atob(match[1]), (c) => c.charCodeAt(0))
    const textoFinal = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim()
    return textoFinal ? { texto, textoFinal } : { texto }
  } catch {
    return { texto }
  }
}

// Texto parcial durante el streaming: sin los marcadores de cierre
// (completos o a medias) ni un inicio de marcador cortado al final del
// fragmento ("[[TEXTO_FI", "[[TUR"), que nunca debe verse ni un instante.
const INICIOS_MARCADOR = ['[[TEXTO_FINAL:', '[[TURNO:']
export function sinTextoFinalParcial(texto: string): string {
  const sinMarcador = texto.replace(PATRON_TEXTO_FINAL, '').replace(PATRON_TURNO, '')
  for (let n = Math.min(Math.max(...INICIOS_MARCADOR.map((m) => m.length)) - 1, sinMarcador.length); n > 0; n--) {
    if (INICIOS_MARCADOR.some((m) => n < m.length && sinMarcador.endsWith(m.slice(0, n)))) return sinMarcador.slice(0, -n)
  }
  return sinMarcador
}

// ---------------------------------------------------------------------
// Turnos duraderos (lib/chat/turnosChat.ts). Solo con clientes que envían
// protocoloTurno: 1, el servidor cierra el stream con
// [[TURNO:base64(json)]] DESPUÉS de guardar el turno. Es la ÚNICA señal de
// que la respuesta quedó guardada: un stream que termina sin ella (o con
// estado 'fallido') nunca se da por guardado; el cliente consulta el turno.
// creadoEn: hora del servidor del mensaje canónico (el cliente la conserva).
export type MarcaTurno = { estado: 'completado' | 'fallido'; requestId: string; turnoId?: string; mensajeAsistenteId?: string | null; codigoError?: string | null; creadoEn?: string | null }
export const PATRON_TURNO = /\n?\[\[TURNO:([^\]]*)(\]\])?/

function base64Utf8(texto: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(texto)))
}

export function marcadorTurno(datos: MarcaTurno): string {
  return `\n[[TURNO:${base64Utf8(JSON.stringify(datos))}]]`
}

export function extraerMarcadorTurno(respuesta: string): { texto: string; turno?: MarcaTurno } {
  const match = respuesta.match(PATRON_TURNO)
  if (!match) return { texto: respuesta }
  const texto = respuesta.replace(match[0], '')
  if (!match[2]) return { texto }
  try {
    const datos = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(match[1]), (c) => c.charCodeAt(0)))) as MarcaTurno
    return (datos?.estado === 'completado' || datos?.estado === 'fallido') && typeof datos.requestId === 'string' ? { texto, turno: datos } : { texto }
  } catch {
    return { texto }
  }
}

// ---------------------------------------------------------------------
// Tarjetas de archivo y contenido (marcadores del servidor): datos puros
// del mensaje. Una sola implementación para el motor del cliente y para el
// servidor, que guarda el mensaje con sus tarjetas (turnos duraderos).
function decodificarBase64Utf8(b64: string): string {
  return new TextDecoder('utf-8').decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
}

export function extraerArchivos(respuesta: string): { texto: string; archivo?: ArchivoGeneradoInfo; archivos?: ArchivoGeneradoInfo[] } {
  const regex = /\[\[DOCUMENTO_ARCHIVO:([^\]]+)\]\]/g
  const archivos: ArchivoGeneradoInfo[] = []
  let texto = respuesta
  let match: RegExpExecArray | null
  while ((match = regex.exec(respuesta)) !== null) {
    try {
      archivos.push(JSON.parse(decodificarBase64Utf8(match[1])) as ArchivoGeneradoInfo)
    } catch {
      // marcador corrupto — se quita del texto igual, sin adjuntar nada por él
    }
    texto = texto.replace(match[0], '')
  }
  texto = texto.trim()
  if (archivos.length === 0) return { texto }
  return { texto, archivo: archivos[0], archivos }
}

export function extraerContenidoDocumento(respuesta: string): { texto: string; contenidoOriginal?: string } {
  const match = respuesta.match(/\[\[DOCUMENTO_CONTENIDO:([^\]]+)\]\]/)
  if (!match) return { texto: respuesta }
  try {
    return { texto: respuesta.replace(match[0], '').trim(), contenidoOriginal: decodificarBase64Utf8(match[1]) }
  } catch {
    return { texto: respuesta.replace(match[0], '').trim() }
  }
}

// Una vista previa de planeación/hoja nunca guarda el `token=` de la
// sesión (ni en el dispositivo ni en mensajes_chat): solo su referencia.
export function sinTokenVistaPrevia<T extends string | undefined>(url: T): T {
  if (!url || !url.startsWith('/api/planeaciones/vista-previa-') || !url.includes('?')) return url
  const [ruta, consulta] = [url.slice(0, url.indexOf('?')), url.slice(url.indexOf('?') + 1)]
  const parametros = consulta.split('&').filter((par) => par !== '' && !/^token(=|$)/i.test(par))
  return (parametros.length > 0 ? `${ruta}?${parametros.join('&')}` : ruta) as T
}

export function archivoSinTokenVistaPrevia(archivo: ArchivoGeneradoInfo): ArchivoGeneradoInfo {
  const url = sinTokenVistaPrevia(archivo.url)
  const urlVer = sinTokenVistaPrevia(archivo.urlVer)
  return url === archivo.url && urlVer === archivo.urlVer ? archivo : { ...archivo, url, ...(archivo.urlVer !== undefined ? { urlVer } : {}) }
}

// Mensaje del asistente tal como lo guarda el chat a partir de la
// respuesta cruda: texto visible (el texto final del servidor si lo hay) y
// sus tarjetas de archivo/contenido, sin tokens de vista previa. null si
// quedan marcadores que dependen del estado del cliente (navegación,
// propuesta de lista, perfil, proceso): esos mensajes los guarda el cliente.
export type MensajeDeRespuesta = { texto: string; archivo?: ArchivoGeneradoInfo; archivos?: ArchivoGeneradoInfo[]; contenidoDocumento?: string }
export function mensajeDeRespuesta(crudo: string): MensajeDeRespuesta | null {
  const { texto: sinRecuperado } = extraerMarcadorRecuperado(crudo)
  const { texto: sinFinal, textoFinal } = extraerTextoFinal(sinRecuperado)
  const { texto: sinArchivo, archivo, archivos } = extraerArchivos(sinFinal)
  const { texto: restante, contenidoOriginal } = extraerContenidoDocumento(sinArchivo)
  const texto = (textoFinal ?? restante).trim()
  if (!texto || /\[\[[A-Z_]+(?::|\]\])/.test(restante) || /\[\[[A-Z_]+(?::|\]\])/.test(texto)) return null
  return {
    texto,
    ...(archivo ? { archivo: archivoSinTokenVistaPrevia(archivo), archivos: archivos!.map(archivoSinTokenVistaPrevia) } : {}),
    ...(contenidoOriginal ? { contenidoDocumento: contenidoOriginal } : {}),
  }
}

// Texto visible de una respuesta tal como la guarda el chat (ver
// mensajeDeRespuesta). El servidor lo usa como texto del mensaje que
// materializa; el cliente, como texto del mensaje que adopta.
export function textoVisibleDeRespuesta(crudo: string): string | null {
  return mensajeDeRespuesta(crudo)?.texto ?? null
}
