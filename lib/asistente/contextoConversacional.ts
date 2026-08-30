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
import type { DocumentoActivoGuardado, MaterialVisualActivoGuardado } from './persistencia'

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

// ============================================================
// FASE 2A — RESOLVEDOR DE REFERENTES (ver "contrato del router
// semántico unificado + transporte de referentes contextuales").
// A diferencia de obtenerUltimoContenidoUtil (que solo resuelve la
// capa de HISTORIAL DE MENSAJES), resolverReferentesDisponibles
// combina esa capa con documentoActivo/materialVisualActivo. Sigue
// siendo una función PURA: no decide intención ni capacidad, no llama
// IA — solo responde "¿qué recursos tiene disponibles el turno
// actual?". Quién decide cuál usar es Nivel0 (lib/clasificadorNivel0.ts),
// del lado servidor, con la instrucción real del maestro — nunca esta
// función ni ningún código de cliente.
// ============================================================

// Un candidato nunca duplica contenido pesado innecesariamente: para
// texto/documento sí viaja el texto real completo (útil para cuando
// más adelante se ejecute la capacidad elegida), pero una imagen solo
// viaja como URL/metadata (nunca los bytes). `origen` distingue si el
// candidato vino del HISTORIAL de mensajes o de un estado activo
// explícito (documentoActivo/materialVisualActivo) — útil para
// diagnóstico, nunca para decidir prioridad (ver "no establecer
// prioridad universal imagen > documento > texto — el router decide
// según la intención").
export type OrigenReferente = 'mensaje' | 'documento_activo' | 'material_visual_activo'

export type CandidatoReferenteTexto = {
  tipo: 'texto'
  origen: OrigenReferente
  mensajeId?: string
  texto: string
}

export type CandidatoReferenteDocumento = {
  tipo: 'documento'
  origen: OrigenReferente
  id: string
  texto: string
  ultimoFormatoGenerado?: string
}

export type CandidatoReferenteImagen = {
  tipo: 'imagen'
  origen: OrigenReferente
  id: string
  url?: string
  promptOriginal?: string
}

export type CandidatoReferenteListaFiltrada = {
  tipo: 'lista_filtrada'
  origen: OrigenReferente
  mensajeId: string
  grupoId: string
  filtro: string
}

export type CandidatoReferente =
  | CandidatoReferenteTexto
  | CandidatoReferenteDocumento
  | CandidatoReferenteImagen
  | CandidatoReferenteListaFiltrada

// Produce la lista de candidatos disponibles — nunca uno solo
// "elegido"; esa decisión es de Nivel0, con más contexto (la
// instrucción real del maestro) del que esta función tiene. Acotado
// por construcción a un máximo pequeño (nunca una colección
// ilimitada, ver "límite de candidatos"): como mucho 1 del historial
// (obtenerUltimoContenidoUtil ya solo devuelve el más reciente) + 1
// de documentoActivo + 1 de materialVisualActivo = máximo 3,
// deduplicando por id cuando el mismo recurso ya vino representado
// desde el mensaje.
export function resolverReferentesDisponibles(
  mensajes: MensajeConversacion[],
  documentoActivo: DocumentoActivoGuardado | null,
  materialVisualActivo: MaterialVisualActivoGuardado | null
): CandidatoReferente[] {
  const candidatos: CandidatoReferente[] = []

  const ultimo = obtenerUltimoContenidoUtil(mensajes)
  if (ultimo) {
    if (ultimo.tipo === 'texto') {
      candidatos.push({ tipo: 'texto', origen: 'mensaje', mensajeId: ultimo.mensajeId, texto: ultimo.texto })
    } else if (ultimo.tipo === 'documento') {
      candidatos.push({ tipo: 'documento', origen: 'mensaje', id: ultimo.mensajeId, texto: ultimo.texto, ultimoFormatoGenerado: ultimo.archivo.tipo })
    } else if (ultimo.tipo === 'imagen') {
      candidatos.push({ tipo: 'imagen', origen: 'mensaje', id: ultimo.mensajeId, url: ultimo.archivo?.url, promptOriginal: undefined })
    } else if (ultimo.tipo === 'lista_filtrada') {
      candidatos.push({ tipo: 'lista_filtrada', origen: 'mensaje', mensajeId: ultimo.mensajeId, grupoId: ultimo.resultado.grupoId, filtro: ultimo.resultado.filtro })
    }
  }

  if (documentoActivo && !candidatos.some((c) => c.tipo === 'documento' && c.id === documentoActivo.id)) {
    candidatos.push({ tipo: 'documento', origen: 'documento_activo', id: documentoActivo.id, texto: documentoActivo.texto, ultimoFormatoGenerado: documentoActivo.ultimoFormatoGenerado })
  }

  if (materialVisualActivo && !candidatos.some((c) => c.tipo === 'imagen' && c.id === materialVisualActivo.id)) {
    candidatos.push({ tipo: 'imagen', origen: 'material_visual_activo', id: materialVisualActivo.id, url: materialVisualActivo.url, promptOriginal: materialVisualActivo.promptOriginal })
  }

  return candidatos
}

// ============================================================
// METADATA PARA CLASIFICACIÓN — separada a propósito del candidato
// completo de arriba (ver "separar referente completo de metadata
// para clasificación"). Esto es lo ÚNICO que viaja al prompt de
// Nivel0 (vía /api/chat, mismo request normal, ver
// lib/clasificadorNivel0.ts): id + tipo + origen + una metadata breve
// opcional — NUNCA el texto completo, ninguna URL de imagen, ningún
// dato de alumno. Nivel0 ya recibe el historial reciente por su
// cuenta; no hace falta repetirle el contenido entero para que pueda
// decidir A CUÁL de estos candidatos se refiere el mensaje.
// ============================================================

export type TipoReferenteContextual = 'texto' | 'documento' | 'imagen' | 'lista_filtrada'

export type ReferenteContextualMetadata = {
  id: string
  tipo: TipoReferenteContextual
  origen: OrigenReferente
  // Única metadata breve realmente útil hoy: el formato ya generado
  // de un documento (ayuda a Nivel0 a distinguir "conviértelo a Word"
  // de "ya está en Word, solo dámelo"). Nunca contenido, nunca URLs.
  formato?: string
}

// Exportada (ver Fase 2B2A) para que AsistenteService.ts pueda
// localizar, del lado del cliente, el CANDIDATO COMPLETO (con
// contenido real) que corresponde a un referente ya elegido por
// Nivel0 — nunca duplica este criterio de id a mano en otro archivo.
export function idDeCandidato(c: CandidatoReferente): string | undefined {
  return c.tipo === 'texto' || c.tipo === 'lista_filtrada' ? c.mensajeId : c.id
}

// Pura — nunca llamada por Nivel0 directamente, la usa el cliente
// (AsistenteService.ts) para construir lo que realmente viaja en el
// body de /api/chat, quedándose con el candidato COMPLETO en memoria
// local para cuando haga falta ejecutar (fase posterior).
export function aMetadataReferentes(candidatos: CandidatoReferente[]): ReferenteContextualMetadata[] {
  const resultado: ReferenteContextualMetadata[] = []
  for (const c of candidatos) {
    const id = idDeCandidato(c)
    if (!id) continue
    resultado.push({
      id,
      tipo: c.tipo,
      origen: c.origen,
      formato: c.tipo === 'documento' ? c.ultimoFormatoGenerado : undefined,
    })
  }
  return resultado
}
