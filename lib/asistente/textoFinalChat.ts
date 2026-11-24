// lib/asistente/textoFinalChat.ts
//
// Texto final de una respuesta del Chat fijado por el servidor después del
// streaming (Hito 1 — normalización curricular del borrador de
// planeación): el modelo ya transmitió su texto, y el servidor manda al
// final [[TEXTO_FINAL:base64]] con la versión normalizada (una sola
// sección de contenidos y PDA, en su lugar). El cliente la adopta como
// texto del mensaje, que es el que se guarda y se reenvía en el
// historial. Sin marcador, nada cambia.

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

// Texto parcial durante el streaming: sin el marcador (completo o a
// medias) ni un inicio de marcador cortado al final del fragmento
// ("[[TEXTO_FI"), que nunca debe verse ni un instante.
const INICIO_MARCADOR = '[[TEXTO_FINAL:'
export function sinTextoFinalParcial(texto: string): string {
  const sinMarcador = texto.replace(PATRON_TEXTO_FINAL, '')
  for (let n = Math.min(INICIO_MARCADOR.length - 1, sinMarcador.length); n > 0; n--) {
    if (sinMarcador.endsWith(INICIO_MARCADOR.slice(0, n))) return sinMarcador.slice(0, -n)
  }
  return sinMarcador
}
