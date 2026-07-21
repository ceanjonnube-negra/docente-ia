// lib/asistente/lecturaVoz.ts
//
// Utilidades puras para la lectura en voz de las respuestas del Chat
// IA — compartidas entre el botón de altavoz manual de cada mensaje
// (ver components/Asistente/AsistentePanel.tsx) y la lectura
// automática opcional (ver AsistenteService.ts). Nunca deciden CUÁNDO
// leer ni manejan el ciclo de vida de un SpeechSynthesisUtterance —
// solo transforman datos, para que ambos caminos limpien el texto y
// elijan la voz exactamente igual.

// Limpia el texto de una respuesta para que speechSynthesis no lea en
// voz alta símbolos de formato — conserva números, nombres, acentos y
// la puntuación real del contenido, solo quita la sintaxis de marcado
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

// Prioridad exacta pedida: es-MX > cualquier lang que empiece con
// "es" > lo que decida el navegador por defecto (undefined = no fijar
// utterance.voice, el sistema usa su voz predeterminada).
export function seleccionarVozEspanol(voces: SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  if (voces.length === 0) return undefined
  const exacta = voces.find((v) => v.lang?.toLowerCase() === 'es-mx')
  if (exacta) return exacta
  return voces.find((v) => v.lang?.toLowerCase().startsWith('es'))
}
