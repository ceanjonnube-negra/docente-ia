// lib/asistente/instruccionesPresentacion.ts
//
// Formato de una presentación PowerPoint NUEVA (CASO 3 de FINALIZAR
// ARCHIVO en app/api/chat/route.ts): se agrega al system prompt SOLO
// cuando el archivo pedido es PowerPoint, en la misma llamada — nunca
// afecta a Word, PDF o Excel. Reutiliza la estructura canónica de MODO
// DOCUMENTO (títulos en MAYÚSCULAS con emoji, viñetas con "- ") que
// agruparEnDiapositivas (lib/documentGen/parseContenido.ts) ya convierte
// en una diapositiva por sección.
//
// La cantidad se calcula aquí, de forma determinista, y se le da al
// modelo ya resuelta: "N diapositivas" es el TOTAL, portada incluida;
// "N diapositivas de contenido" / "más la portada" son N secciones
// además de la portada.

const NUMEROS: Record<string, number> = {
  una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, trece: 13, catorce: 14, quince: 15,
}
const CANTIDAD = /\b(\d{1,2}|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince)\s+(diapositivas?|laminas?|slides?)\b/
const PORTADA_APARTE = /\bde\s+contenido\b|\bmas\s+(la\s+|una\s+)?portada\b|\bademas\s+de\s+(la\s+)?portada\b|\bsin\s+contar\s+(la\s+)?portada\b|\baparte\s+de\s+(la\s+)?portada\b/
export const TOTAL_DIAPOSITIVAS_POR_DEFECTO = 5
const MAXIMO_SECCIONES = 20

// Secciones de contenido (una diapositiva cada una) además de la portada.
export function seccionesDePresentacion(mensaje: string): number {
  const texto = mensaje.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  const m = texto.match(CANTIDAD)
  if (!m) return TOTAL_DIAPOSITIVAS_POR_DEFECTO - 1
  const n = NUMEROS[m[1]] ?? Number(m[1])
  const secciones = PORTADA_APARTE.test(texto) ? n : n - 1
  return Math.min(Math.max(secciones, 0), MAXIMO_SECCIONES)
}

export function instruccionesPresentacion(mensaje: string): string {
  const secciones = seccionesDePresentacion(mensaje)
  const cuerpo = secciones === 0
    ? 'Es UNA sola diapositiva: justo debajo del título (sin ninguna sección ni otro título en MAYÚSCULAS) escribe de 3 a 4 viñetas que empiecen con "- ", con la información esencial del tema, frases breves (máximo unas 20 palabras cada una). La aplicación agrega en esa misma diapositiva los datos de escuela, docente, grado, grupo y fecha.'
    : `Después escribe EXACTAMENTE ${secciones} ${secciones === 1 ? 'sección' : 'secciones'} — cada sección es una diapositiva:
- Su título en MAYÚSCULAS con un emoji al inicio, en su propia línea (ej. "📚 BENEFICIOS DE LA LECTURA"). Nunca escribas la palabra "DIAPOSITIVA" ni numeres los títulos.
- Debajo, de 3 a 5 viñetas que empiecen con "- ", frases breves (máximo unas 20 palabras cada una).
- Una línea en blanco entre secciones.`
  const total = secciones === 0
    ? 'Total: 1 diapositiva (título, contenido y datos institucionales juntos).'
    : `Total: ${secciones + 1} diapositivas = portada + ${secciones} de contenido.
- Primera línea: 📊 seguido del título de la presentación, en MAYÚSCULAS (es la portada). No escribas nada debajo de ella antes de la primera sección; la portada ya muestra escuela, docente, grado, grupo y fecha.`
  return `PRESENTACIÓN POWERPOINT — formato obligatorio para este documento (la aplicación convierte cada sección en una diapositiva).
${total}${secciones === 0 ? '\n- Primera línea: 📊 seguido del título de la presentación, en MAYÚSCULAS (un título corto, de preferencia menos de 60 caracteres).' : ''}
${cuerpo}
Adapta el contenido al tema pedido y al grado del grupo de esta conversación (DATOS DEL MAESTRO). Sin markdown, sin tablas.`
}
