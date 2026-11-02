// lib/planeacion/detectarAprobarPlaneacion.ts
//
// APROBAR PLANEACIÓN — detector determinista de una orden inequívoca de
// aprobar/guardar el borrador de planeación. Nunca usa IA.
//
// Para qué: con un documentoActivo, el cliente (AsistenteService)
// envuelve casi cualquier mensaje como edición de ese documento
// (construirPromptEdicion, esEdicionDocumento=true). "Apruébala y
// guárdala" no es una edición: debe llegar a /api/chat como mensaje
// normal para que el flujo de aprobación existente
// (accion_planeacion_generar==='aprobar' → aprobarBorradorPlaneacion)
// lo atienda. Este detector NO aprueba nada ni decide la intención en el
// servidor — solo evita el envoltorio de edición.
//
// Mismo patrón que detectarImplementarPlaneacion (test/images-v1,
// a7e476b): módulo puro (texto entra, boolean sale, sin I/O ni
// dependencias de navegador/servidor), una sola fuente de verdad que
// cliente y servidor pueden importar; WHITELIST CERRADA de órdenes
// COMPLETAS ancladas con ^...$ tras normalizar, más una exclusión
// defensiva de negaciones, preguntas y secuencias ("antes", "después"…).
// Un falso negativo es aceptable (el mensaje sigue el flujo de edición
// de siempre); un falso positivo no.
//
// Dos familias:
// - EXPLÍCITAS (nombran "planeación"): "Aprueba la planeación",
//   "Guarda esta planeación", "Aprueba y guarda la planeación".
// - PRONOMINALES ("Apruébala", "Apruébala y guárdala"): el "la" solo
//   significa planeación si el documento activo ES un borrador de
//   planeación — por eso exigen contexto.hayBorradorPlaneacion; con otro
//   documento activo (un examen, una carta) siguen siendo una edición.
//
// Formas reconocidas (normalizado: minúsculas, sin diacríticos, sin
// comas, espacios colapsados; "por favor" opcional al inicio o al
// final; "sí"/"ya" opcionales al inicio; [.!] finales opcionales):
//   - "(aprueba|guarda|aprueba y guarda|guarda y aprueba) (la|esta|mi)? planeacion"
//   - "apruebala", "apruebala y guardala", "guardala y apruebala"

export type ContextoAprobarPlaneacion = {
  // true solo si el documento activo es un borrador de planeación (trae
  // el bloque "📎 RESUMEN PARA GUARDAR", ver extraerBorrador.ts).
  hayBorradorPlaneacion: boolean
}

function normalizarParaDeteccionAprobar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/,/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

const PREFIJO = '(si |ya )?(por favor )?'
const SUFIJO = '( por favor)?[.!]*'
const ORDEN_APROBAR_EXPLICITA = new RegExp(`^${PREFIJO}(aprueba|guarda|aprueba y guarda|guarda y aprueba) (la |esta |mi )?planeacion${SUFIJO}$`)
const ORDEN_APROBAR_PRONOMINAL = new RegExp(`^${PREFIJO}(apruebala|apruebala y guardala|guardala y apruebala)${SUFIJO}$`)
const EXCLUSION_APROBAR = /\bno\b|[¿?]|\b(antes|despues|luego|primero)\b/

export function detectarAprobarPlaneacion(mensaje: string, contexto: ContextoAprobarPlaneacion): boolean {
  const texto = normalizarParaDeteccionAprobar(mensaje || '')
  if (!texto) return false
  if (EXCLUSION_APROBAR.test(texto)) return false
  if (ORDEN_APROBAR_EXPLICITA.test(texto)) return true
  return contexto.hayBorradorPlaneacion && ORDEN_APROBAR_PRONOMINAL.test(texto)
}
