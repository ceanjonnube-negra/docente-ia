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

import OpenAI from 'openai'
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
