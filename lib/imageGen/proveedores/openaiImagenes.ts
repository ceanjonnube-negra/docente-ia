// lib/imageGen/proveedores/openaiImagenes.ts
//
// Única implementación real de ProveedorImagenes en esta fase — usa el
// mismo SDK/API key de OpenAI que ya usa este proyecto para RAG
// (app/api/chat/route.ts, openaiRAG) y voz Realtime
// (motorOpenAIRealtime.ts), sin secreto nuevo.
//
// gpt-image-2 siempre devuelve base64 (nunca url) — no hace falta un
// segundo fetch para bajar el archivo, el buffer sale directo de la
// respuesta. MIGRACIÓN gpt-image-1 -> gpt-image-2 (ver auditoría
// "gpt-image-2 vs gpt-image-1"): mismo SDK (ya soporta 'gpt-image-2'
// como ImageModel, sin actualizar dependencias), mismos parámetros de
// generación (prompt/size/quality/n/b64_json). Único cambio real de
// comportamiento: gpt-image-2 NO acepta input_fidelity (el modelo
// procesa toda entrada de imagen en alta fidelidad automáticamente,
// según documentación oficial) — se retira de editarImagenOpenAI, ver
// abajo. size:'auto' en edición sigue siendo compatible.

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

// CAUSA RAÍZ real (ver auditoría "coherencia de timeouts del Chat IA"
// aprobada por separado): ni images.generate() ni images.edit() traían
// timeout explícito — sin él, el SDK de OpenAI aplica su propio default
// (OpenAI.DEFAULT_TIMEOUT = 600_000ms = 10 minutos, ver
// node_modules/openai/client.js), muy por encima de maxDuration=180s
// de app/api/chat/route.ts. El único límite real que existía era el
// kill duro de Vercel a los 180s — sin ningún error controlado antes
// de eso, y sin dejar presupuesto para que el resto del pipeline
// (verificación de buffer, subida a Storage, URL firmada, persistencia
// en assets_visuales) pudiera terminar después.
//
// 140_000 (140s) — valor elegido, no arbitrario:
//   - evidencia real histórica (dbg_1787065556208_ai557w): ~111.4s
//     medidos para una generación real con gpt-image-2. 140s da un
//     margen real de ~28.6s (~25%) sobre ese máximo observado — mismo
//     criterio de margen ya usado en el resto de esta app para
//     calibrar timeouts sobre evidencia real, nunca un número al azar.
//   - maxDuration=180s (app/api/chat/route.ts) menos 140s deja 40s de
//     presupuesto real para el resto del pipeline de ese mismo
//     request (verificación de buffer, subida a Storage, URL firmada,
//     verificación HEAD de la URL, persistencia en assets_visuales) —
//     ninguno de esos pasos, medido en otras fases de esta app
//     (composición Word/PDF de la hoja de evaluación: 664/563ms),
//     necesita más de unos pocos segundos en un caso real.
//   - NUNCA 180s: eso agotaría el presupuesto completo del handler y
//     no dejaría margen para que el pipeline posterior a la llamada
//     termine de forma controlada.
// Aplica IGUAL a generación y a edición — ambas comparten el mismo
// riesgo real (la misma llamada sin timeout al mismo proveedor), así
// que comparten el mismo valor canónico, nunca dos números
// independientes que pudieran desalinearse.
const TIMEOUT_OPENAI_IMAGENES_MS = 140_000

const DIMENSIONES: Record<string, { ancho: number; alto: number }> = {
  '1024x1024': { ancho: 1024, alto: 1024 },
  '1536x1024': { ancho: 1536, alto: 1024 },
  '1024x1536': { ancho: 1024, alto: 1536 },
}

export async function generarImagenOpenAI(
  promptFinal: string,
  formato: SolicitudImagen['formato'],
  calidad?: 'medium' | 'high'
): Promise<{ buffer: Buffer; contentType: string; ancho: number; alto: number }> {
  const size = tamanoParaFormato(formato)
  const respuesta = await obtenerCliente().images.generate(
    {
      model: 'gpt-image-2',
      prompt: promptFinal,
      size,
      quality: calidad ?? 'medium',
      n: 1,
    },
    { timeout: TIMEOUT_OPENAI_IMAGENES_MS }
  )
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
// MIGRACIÓN gpt-image-1 -> gpt-image-2: input_fidelity ya NO se manda
// — gpt-image-2 procesa toda entrada de imagen en alta fidelidad
// automáticamente y no acepta este parámetro (ver auditoría
// "gpt-image-2 vs gpt-image-1"); antes servía para pedir esa misma
// preservación de composición explícitamente, ahora es el
// comportamiento por defecto del modelo, sin que este código tenga
// que pedirlo. size:'auto' sigue siendo compatible y sigue
// funcionando igual: deja que el proveedor mantenga proporciones
// coherentes con la imagen de entrada en vez de forzar una de las 3
// medidas fijas de generación desde cero.
export async function editarImagenOpenAI(
  bufferOriginal: Buffer,
  promptFinal: string
): Promise<{ buffer: Buffer; contentType: string; ancho: number; alto: number }> {
  const archivoOriginal = await toFile(bufferOriginal, 'imagen-original.png', { type: 'image/png' })
  const respuesta = await obtenerCliente().images.edit(
    {
      model: 'gpt-image-2',
      image: archivoOriginal,
      prompt: promptFinal,
      quality: 'medium',
      size: 'auto',
    },
    { timeout: TIMEOUT_OPENAI_IMAGENES_MS }
  )
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
