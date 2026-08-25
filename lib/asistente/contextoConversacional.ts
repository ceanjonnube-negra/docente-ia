// lib/asistente/contextoConversacional.ts
//
// Infraestructura contextual COMPARTIDA (ver "orquestador contextual —
// fase 1: infraestructura, sin routing todavía") — utilidades puras y
// sin estado sobre MensajeConversacion, pensadas para importarse tanto
// desde AsistenteService.ts (lógica de envío) como desde
// AsistentePanel.tsx (UI), sin que ninguna dependa de la otra y sin
// duplicar el mismo criterio en los dos archivos (ver "problema con la
// propuesta anterior — dos fuentes de verdad").
//
// Esta fase NO decide routing, NO llama IA, NO conoce documentoActivo
// ni materialVisualActivo — esos se incorporarán en el
// ResolvedorContextual de una fase posterior. Aquí solo se resuelve la
// capa de HISTORIAL DE MENSAJES: qué mensaje es contenido reutilizable
// y cuál es el más reciente.

import type { MensajeConversacion, ArchivoGeneradoInfo, ResultadoEmbebidoImagen, ResultadoEmbebidoListaFiltrada } from './tipos'

// Mismo criterio EXACTO que ya validamos para el botón "Copiar" y para
// la prioridad de "copiar texto reciente" (ver "copiar texto reciente
// sin que documentoActivo viejo secuestre la continuación") — ahora
// como única fuente de verdad, para que AsistenteService.ts y
// AsistentePanel.tsx dejen de tener el mismo criterio escrito dos
// veces. Deliberadamente NO conoce estado de UI (ej. "sigue
// generando/streaming") — eso es responsabilidad del llamador (ver
// AsistentePanel: `esMensajeTextoNormalReutilizable(m) &&
// !esUltimoGenerando`), porque `esUltimoGenerando` es estado React
// derivado del índice del mensaje en la lista renderizada, no algo que
// una utilidad pura sobre un solo MensajeConversacion pueda saber.
export function esMensajeTextoNormalReutilizable(mensaje: MensajeConversacion): boolean {
  return (
    mensaje.rol === 'asistente' &&
    !!mensaje.texto?.trim() &&
    !mensaje.archivo &&
    !mensaje.archivos?.length &&
    !mensaje.resultadoEmbebido &&
    !mensaje.acciones?.length &&
    !mensaje.datosAccionCalendario &&
    !mensaje.datosAccionNavegacion &&
    !mensaje.datosAccionAlumno &&
    mensaje.esOperativo !== true
  )
}

// Unión discriminada construida ÚNICAMENTE a partir de campos reales
// ya existentes en MensajeConversacion (archivo/archivos/
// resultadoEmbebido/texto) — ninguno de estos 4 tipos es especulativo,
// son exactamente los 4 tipos de contenido que un mensaje del
// asistente puede traer hoy. `mensajeId` siempre viaja para que un
// llamador futuro (ResolvedorContextual) pueda ubicar el mensaje
// completo en `this.mensajes` si necesita más que este resumen.
export type ContenidoUtilTexto = {
  tipo: 'texto'
  mensajeId: string
  texto: string
}

export type ContenidoUtilDocumento = {
  tipo: 'documento'
  mensajeId: string
  texto: string
  archivo: ArchivoGeneradoInfo
  archivos?: ArchivoGeneradoInfo[]
}

export type ContenidoUtilImagen = {
  tipo: 'imagen'
  mensajeId: string
  resultado: ResultadoEmbebidoImagen
  archivo?: ArchivoGeneradoInfo
}

export type ContenidoUtilListaFiltrada = {
  tipo: 'lista_filtrada'
  mensajeId: string
  resultado: ResultadoEmbebidoListaFiltrada
}

export type ContenidoUtil = ContenidoUtilTexto | ContenidoUtilDocumento | ContenidoUtilImagen | ContenidoUtilListaFiltrada

// Recorre this.mensajes del más reciente al más antiguo y devuelve el
// primer mensaje del ASISTENTE con contenido reutilizable real —
// saltando cualquier mensaje con esOperativo===true (ver "mensajes
// operativos no deben desplazar el referente") y cualquier mensaje sin
// contenido reconocible (ej. una burbuja vacía). NUNCA mira
// documentoActivo/materialVisualActivo — esta función resuelve
// exclusivamente la capa de historial de mensajes; combinarla con esos
// otros estados es trabajo del ResolvedorContextual de una fase
// posterior, no de esta utilidad.
export function obtenerUltimoContenidoUtil(mensajes: MensajeConversacion[]): ContenidoUtil | null {
  for (let i = mensajes.length - 1; i >= 0; i--) {
    const m = mensajes[i]
    if (m.rol !== 'asistente') continue
    if (m.esOperativo === true) continue

    if (m.resultadoEmbebido?.tipo === 'imagen') {
      return { tipo: 'imagen', mensajeId: m.id, resultado: m.resultadoEmbebido, archivo: m.archivo }
    }
    if (m.resultadoEmbebido?.tipo === 'lista_filtrada') {
      return { tipo: 'lista_filtrada', mensajeId: m.id, resultado: m.resultadoEmbebido }
    }
    if (m.archivo || m.archivos?.length) {
      return { tipo: 'documento', mensajeId: m.id, texto: m.texto, archivo: (m.archivo ?? m.archivos![0]), archivos: m.archivos }
    }
    if (m.texto?.trim()) {
      return { tipo: 'texto', mensajeId: m.id, texto: m.texto }
    }
    // Mensaje del asistente sin ningún contenido reconocible (ej. solo
    // acciones/confirmación pendiente sin texto real) — sigue
    // buscando hacia atrás en vez de detenerse aquí.
  }
  return null
}
