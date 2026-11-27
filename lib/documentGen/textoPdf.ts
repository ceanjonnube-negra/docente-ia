// lib/documentGen/textoPdf.ts
//
// Limpieza de texto para las fuentes estándar de pdf-lib (compartida por
// los generadores PDF). Movido sin cambios desde generarPdfServidor.ts.

// Igual que en el motor anterior: los emoji del formato MODO DOCUMENTO
// (📋, 🎯, 📅...) no tienen glifo en las fuentes estándar — se quitan
// del texto visible antes de dibujar nada.
export function quitarEmoji(texto: string): string {
  return texto.replace(/\p{Extended_Pictographic}/gu, '').replace(/\s{2,}/g, ' ').trim()
}

// Las fuentes estándar de pdf-lib codifican con WinAnsi (cp1252), que
// cubre todos los acentos y la ñ del español, pero no cualquier
// símbolo Unicode que el modelo pudiera colar (flechas, viñetas
// exóticas, etc.) — drawText lanzaría una excepción real ante un
// carácter no codificable. Se normalizan los signos tipográficos más
// comunes a su equivalente ASCII y se descarta cualquier otro carácter
// fuera de ASCII imprimible + Latin-1 (acentos/ñ/ü), en vez de arriesgar
// que una comilla rara tumbe la generación completa del documento.
export function sanearParaWinAnsi(texto: string): string {
  return texto
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7E -ÿ]/g, '')
}
