// lib/imageGen/proveedores/openaiImagenes.ts
//
// Única implementación real de ProveedorImagenes en esta fase — usa el
// mismo SDK/API key de OpenAI que ya usa este proyecto para RAG
// (app/api/chat/route.ts, openaiRAG) y voz Realtime
// (motorOpenAIRealtime.ts), sin secreto nuevo.
//
// gpt-image-1 siempre devuelve base64 (nunca url) — no hace falta un
// segundo fetch para bajar el archivo, el buffer sale directo de la
// respuesta.

import OpenAI, { toFile } from 'openai'
import { tamanoParaFormato, type SolicitudImagen } from '../reglasVisuales'

// Construcción PEREZOSA (nunca al cargar el módulo) — mismo criterio
// que el resto del proyecto (ver motorOpenAIRealtime.ts): construir un
// cliente real de un proveedor al importar el módulo rompe cualquier
// script `npx tsx` que transitivamente importe este archivo sin tener
// OPENAI_API_KEY en el entorno (ninguna de las 20+ suites verificar-*
// existentes inyecta variables de entorno falsas a propósito).
let client: OpenAI | null = null
function obtenerCliente(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  return client
}

const DIMENSIONES: Record<string, { ancho: number; alto: number }> = {
  '1024x1024': { ancho: 1024, alto: 1024 },
  '1536x1024': { ancho: 1536, alto: 1024 },
  '1024x1536': { ancho: 1024, alto: 1536 },
}

export async function generarImagenOpenAI(
  promptFinal: string,
  formato: SolicitudImagen['formato']
): Promise<{ buffer: Buffer; contentType: string; ancho: number; alto: number }> {
  const size = tamanoParaFormato(formato)
  const respuesta = await obtenerCliente().images.generate({
    model: 'gpt-image-1',
    prompt: promptFinal,
    size,
    quality: 'medium',
    n: 1,
  })
  const b64 = respuesta.data?.[0]?.b64_json
  if (!b64) throw new Error('El proveedor de imágenes no devolvió ningún resultado')
  const dimensiones = DIMENSIONES[size] ?? DIMENSIONES['1024x1024']
  return {
    buffer: Buffer.from(b64, 'base64'),
    contentType: 'image/png',
    ancho: dimensiones.ancho,
    alto: dimensiones.alto,
  }
}

// Edición REAL imagen→imagen (ver "corrección — edición real de
// imágenes con el asset visual anterior como entrada") — usa
// images.edit (no images.generate): recibe el archivo original como
// entrada visual real, así el modelo conserva lo que la instrucción
// no menciona en vez de reinterpretar la escena desde cero.
// input_fidelity:'high' — "controla cuánto esfuerzo hace el modelo
// para igualar el estilo/las características de la imagen de
// entrada" (documentación de OpenAI), exactamente lo que pide
// "preservación de composición". size:'auto' deja que el proveedor
// mantenga proporciones coherentes con la imagen de entrada en vez de
// forzar una de las 3 medidas fijas de generación desde cero.
export async function editarImagenOpenAI(
  bufferOriginal: Buffer,
  promptFinal: string
): Promise<{ buffer: Buffer; contentType: string; ancho: number; alto: number }> {
  const archivoOriginal = await toFile(bufferOriginal, 'imagen-original.png', { type: 'image/png' })
  const respuesta = await obtenerCliente().images.edit({
    model: 'gpt-image-1',
    image: archivoOriginal,
    prompt: promptFinal,
    quality: 'medium',
    input_fidelity: 'high',
    size: 'auto',
  })
  const b64 = respuesta.data?.[0]?.b64_json
  if (!b64) throw new Error('El proveedor de imágenes no devolvió ningún resultado al editar')
  // El tamaño real con size:'auto' puede variar — se reporta el
  // default (1024x1024, el más común en la práctica) porque el SDK no
  // regresa ancho/alto reales en la respuesta; no afecta la
  // generación ni la subida, solo es metadata informativa opcional.
  return {
    buffer: Buffer.from(b64, 'base64'),
    contentType: 'image/png',
    ancho: 1024,
    alto: 1024,
  }
}
