// lib/asistente/marcadoresRespuesta.ts
//
// Funciones PURAS (sin red, sin estado, sin `this`) para extraer los
// marcadores técnicos [[DOCUMENTO_ARCHIVO:...]] / [[DOCUMENTO_CONTENIDO:...]]
// / [[NAVEGACION:...]] / [[PERFIL_ACTUALIZADO]] del texto crudo que
// devuelve /api/chat — EXTRAÍDAS de motores/motorTextoClaude.ts
// (ARQUITECTURA DURABLE — Vercel Workflow + turnos_chat) para que el
// Workflow durable (app/workflows/generarTurnoChat.ts) pueda procesar
// la MISMA respuesta con la MISMA lógica exacta que ya usa el cliente,
// sin duplicar ni reinterpretar nada. motorTextoClaude.ts sigue
// llamando a estas mismas funciones (ver más abajo) — comportamiento
// 100% idéntico al de antes de esta extracción, verificado byte a
// byte con las pruebas existentes de descarga/documentos.
//
// procesarMarcadorDeProceso (continuar tarea larga en varios turnos,
// ver motorTextoClaude.ts) NO se extrajo aquí a propósito: tiene
// efectos reales sobre procesos_activos y depende de la sesión del
// docente — queda fuera del alcance V1 del Workflow durable (ver
// informe de la implementación).

import type { AccionNavegacion, ArchivoGeneradoInfo } from './tipos'

export function procesarMarcadorDeArchivo(respuesta: string): { texto: string; archivo?: ArchivoGeneradoInfo; archivos?: ArchivoGeneradoInfo[] } {
  const regex = /\[\[DOCUMENTO_ARCHIVO:([^\]]+)\]\]/g
  const archivos: ArchivoGeneradoInfo[] = []
  let texto = respuesta
  let match: RegExpExecArray | null
  while ((match = regex.exec(respuesta)) !== null) {
    try {
      const binario = atob(match[1])
      const bytes = Uint8Array.from(binario, (c) => c.charCodeAt(0))
      archivos.push(JSON.parse(new TextDecoder('utf-8').decode(bytes)) as ArchivoGeneradoInfo)
    } catch {
      // marcador corrupto — se quita del texto igual, sin adjuntar nada por él
    }
    texto = texto.replace(match[0], '')
  }
  texto = texto.trim()
  if (archivos.length === 0) return { texto }
  return { texto, archivo: archivos[0], archivos }
}

export function procesarMarcadorDeContenido(respuesta: string): { texto: string; contenidoOriginal?: string } {
  const match = respuesta.match(/\[\[DOCUMENTO_CONTENIDO:([^\]]+)\]\]/)
  if (!match) return { texto: respuesta }
  try {
    const binario = atob(match[1])
    const bytes = Uint8Array.from(binario, (c) => c.charCodeAt(0))
    const contenidoOriginal = new TextDecoder('utf-8').decode(bytes)
    return { texto: respuesta.replace(match[0], '').trim(), contenidoOriginal }
  } catch {
    return { texto: respuesta.replace(match[0], '').trim() }
  }
}

export function procesarMarcadorDeNavegacion(respuesta: string): { texto: string; accionNavegacion?: AccionNavegacion } {
  const match = respuesta.match(/\[\[NAVEGACION:([^\]]+)\]\]/)
  if (!match) return { texto: respuesta }
  try {
    const binario = atob(match[1])
    const bytes = Uint8Array.from(binario, (c) => c.charCodeAt(0))
    const accionNavegacion = JSON.parse(new TextDecoder('utf-8').decode(bytes)) as AccionNavegacion
    return { texto: respuesta.replace(match[0], '').trim(), accionNavegacion }
  } catch {
    return { texto: respuesta.replace(match[0], '').trim() }
  }
}

export function procesarMarcadorDePerfilActualizado(respuesta: string): { texto: string; perfilActualizado: boolean } {
  const match = respuesta.match(/\[\[PERFIL_ACTUALIZADO\]\]/)
  if (!match) return { texto: respuesta, perfilActualizado: false }
  return { texto: respuesta.replace(match[0], '').trim(), perfilActualizado: true }
}
