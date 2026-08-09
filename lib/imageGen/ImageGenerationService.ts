// lib/imageGen/ImageGenerationService.ts
//
// Capa desacoplada de generación de imágenes (ver diseño técnico
// aprobado: "Implementar en Docente IA la capacidad de generar
// imágenes y documentos ilustrados", Fase 0+1). Server-only — nunca se
// importa desde código de cliente (mismo criterio que
// lib/documentGen/herramientas.ts).
//
// Cambiar de proveedor en el futuro (Gemini, Stability, etc.) es
// escribir una nueva implementación de ProveedorImagenes y cambiar
// PROVEEDOR_ACTIVO — nada más en la aplicación se entera, igual que
// MotorConversacional para los proveedores de texto/voz (ver
// lib/asistente/tipos.ts).

import type { SolicitudImagen } from './reglasVisuales'
import { construirPromptFinal } from './reglasVisuales'
import { generarImagenOpenAI } from './proveedores/openaiImagenes'

export type ImagenGenerada = {
  buffer: Buffer
  contentType: string
  ancho: number
  alto: number
  promptUsado: string
  proveedor: string
}

export interface ProveedorImagenes {
  nombre: string
  generar(promptFinal: string, formato: SolicitudImagen['formato']): Promise<{ buffer: Buffer; contentType: string; ancho: number; alto: number }>
}

const proveedorOpenAI: ProveedorImagenes = {
  nombre: 'openai',
  generar: generarImagenOpenAI,
}

// Único proveedor real en esta fase — el punto de extensión ya existe
// (ProveedorImagenes) aunque todavía no haya un segundo proveedor que
// lo necesite.
const PROVEEDOR_ACTIVO: ProveedorImagenes = proveedorOpenAI

export async function generarImagen(solicitud: SolicitudImagen): Promise<ImagenGenerada> {
  const promptFinal = construirPromptFinal(solicitud)
  const resultado = await PROVEEDOR_ACTIVO.generar(promptFinal, solicitud.formato)
  return { ...resultado, promptUsado: promptFinal, proveedor: PROVEEDOR_ACTIVO.nombre }
}
