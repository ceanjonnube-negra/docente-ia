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
export type MarcaTurno = { estado: 'completado' | 'fallido'; requestId: string; turnoId?: string; mensajeAsistenteId?: string | null; codigoError?: string | null }
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

// Texto visible de una respuesta tal como la guarda el chat: el texto final
// del servidor si lo hay, o el texto sin marcadores. null si quedan
// marcadores que solo el cliente procesa (archivos, navegación…). El
// servidor lo usa como texto del mensaje que materializa; el cliente, como
// texto del mensaje que adopta: los dos son idénticos.
export function textoVisibleDeRespuesta(crudo: string): string | null {
  const { texto: sinRecuperado } = extraerMarcadorRecuperado(crudo)
  const { texto, textoFinal } = extraerTextoFinal(sinRecuperado)
  const visible = (textoFinal ?? texto).trim()
  if (!visible || /\[\[[A-Z_]+(?::|\]\])/.test(visible)) return null
  return visible
}
