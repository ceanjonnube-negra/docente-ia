// lib/asistente/lecturaVoz.ts
//
// Utilidad pura para preparar el texto de una respuesta del Chat IA
// antes de pedirle a OpenAI Realtime que lo lea en voz alta (ver
// MotorOpenAIRealtime.reproducirRespuestaEnVoz — "Rediseñar el modo
// voz como conversación continua"). Nunca decide CUÁNDO leer ni
// gestiona el ciclo de vida de la sesión — solo transforma texto.

// Limpia el texto de una respuesta para que no se lea en voz alta
// símbolos de formato — conserva números, nombres, acentos y la
// puntuación real del contenido, solo quita la sintaxis de marcado
// (Markdown, emoji decorativos, marcadores técnicos) que no aporta
// nada hablado.
export function limpiarTextoParaVoz(texto: string): string {
  return texto
    // Marcadores técnicos que a veces sobreviven en el texto mostrado
    // (defensivo — normalmente ya vienen quitados antes de llegar
    // aquí, ver motorTextoClaude.ts).
    .replace(/\[\[[A-Z_]+:?[^\]]*\]\]/g, '')
    // Encabezados Markdown ("## Título" -> "Título").
    .replace(/^#{1,6}\s+/gm, '')
    // Negritas/cursivas (**texto**, __texto__, *texto*, _texto_) -> texto.
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    // Código en línea o en bloque.
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    // Enlaces [texto](url) -> texto.
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Viñetas al inicio de línea (-, *, •) -> se quita el símbolo, el
    // contenido de la línea se conserva.
    .replace(/^[ \t]*[-*•]\s+/gm, '')
    // Emoji comunes usados como viñetas/decoración en las respuestas
    // (✅❌🟡⚪📋📊 etc.) — no son contenido, y varios motores TTS los
    // deletrean o los leen de forma inconsistente.
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
