// lib/planeacion/detectarImplementarPlaneacion.ts
//
// IMPLEMENTAR PLANEACIÓN (Fase 3B.4, ver "implementar planeación —
// arquitectura definitiva" aprobada por separado) — detector
// determinista. Nunca usa IA.
//
// Extraído a módulo compartido (ver auditoría "causa raíz — cliente
// envuelve el mensaje como edición documental" aprobada por separado):
// la MISMA función pura debe usarse en app/api/chat/route.ts (fast-path
// server, autoridad final de la transición) Y en
// lib/asistente/AsistenteService.ts (routing previo del cliente, para
// que "Implementa la planeación." nunca se envuelva como edición de
// documento cuando existe documentoActivo) — una sola fuente de verdad,
// nunca dos implementaciones que puedan divergir. Puro, sin I/O, sin
// dependencias de Supabase/NextRequest/Anthropic/browser — solo texto
// entra, boolean sale.
//
// v2 (ver auditoría "falso positivo del detector" aprobada por
// separado) — CORRECCIÓN de la v1: "verbo implementa(r) + mención de
// planeación en cualquier parte del mensaje" resultó demasiado amplia
// para una acción que cambia estado — confirmado por ejecución real
// contra 15 casos adversariales, los 15 eran falsos positivos ("Quiero
// implementar la planeación.", "Cómo implementar la planeación.",
// "Implementa la planeación mañana.", etc. — deseos, preguntas sin
// signo, tiempo futuro, todos disparaban true). Decisión de producto:
// para este fast-path un FALSO NEGATIVO es aceptable (el mensaje cae
// al flujo normal, que sigue funcionando); un FALSO POSITIVO NO lo es
// (cambiaría estado sin una orden real). Por eso la estrategia cambió
// de "buscar verbo + palabra suelta" a una WHITELIST CERRADA de formas
// COMPLETAS de orden, ancladas con ^...$ tras normalizar — para que NO
// exista texto semántico adicional antes/después que convierta la
// frase en deseo/pregunta/explicación/recordatorio/hipótesis/acción
// futura. El anclaje por sí solo ya descarta el tiempo futuro
// ("...mañana.", "...el viernes.") sin necesidad de enumerar cada
// adverbio: cualquier palabra extra rompe el ancla final.
//
// Plantillas reconocidas (normalizado: minúsculas, sin diacríticos,
// trim, espacios colapsados):
//   - "(por favor )?implementa(r)? (la|esta|mi)? planeación( por favor)?[.!]*"
//   - "ya puedes implementar (la|esta|mi)? planeación[.!]*"
//   - "(pon|marca|deja) (la|esta|mi)? planeación como implementada[.!]*"
//   - "(ponla|marcala|dejala) como implementada[.!]*"
//   - "implementala( por favor)?[.!]*" (clítico directo)
// EXCLUSION_IMPLEMENTAR se mantiene como SEGUNDA capa defensiva (no la
// principal — el anclaje ya cubre la mayoría de los casos), por si
// alguna plantilla futura se relajara sin querer.
//
// "aprobar"/"apruébala" NUNCA coincide aquí — ninguna plantilla
// contiene esa raíz — así que el flujo preexistente
// accion_planeacion_generar==='aprobar' (aprobarBorradorPlaneacion,
// Paso 3C, guarda en planeaciones/planeacion_proyectos) queda intacto
// y fuera de esta función, sin ningún caso especial adicional.
//
// Semántica validada con 52 casos reales (16 positivos + 36 negativos,
// 0 duplicados, 0 fallos) antes y después de esta extracción — no
// rediseñar ni ampliar el vocabulario reconocido sin repetir esa
// auditoría completa.
function normalizarParaDeteccionImplementar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
}
const REF_PLANEACION_IMPLEMENTAR = '(la |esta |mi )?planeacion'
const ORDEN_DIRECTA_IMPLEMENTAR = new RegExp(`^(por favor )?implementa(r)? ${REF_PLANEACION_IMPLEMENTAR}( por favor)?[.!]*$`)
const ORDEN_YA_PUEDES_IMPLEMENTAR = new RegExp(`^ya puedes implementar ${REF_PLANEACION_IMPLEMENTAR}[.!]*$`)
const ORDEN_COMO_IMPLEMENTADA_EXPLICITA = new RegExp(`^(pon|marca|deja) ${REF_PLANEACION_IMPLEMENTAR} como implementada[.!]*$`)
const ORDEN_COMO_IMPLEMENTADA_CLITICO = /^(ponla|marcala|dejala) como implementada[.!]*$/
const ORDEN_CLITICO_DIRECTO_IMPLEMENTAR = /^implementala( por favor)?[.!]*$/
const EXCLUSION_IMPLEMENTAR = /\bno\b|[¿?]|\b(antes|despues|luego|primero)\b/
export function detectarImplementarPlaneacion(mensaje: string): boolean {
  const texto = normalizarParaDeteccionImplementar(mensaje || '')
  if (!texto) return false
  if (EXCLUSION_IMPLEMENTAR.test(texto)) return false
  return (
    ORDEN_DIRECTA_IMPLEMENTAR.test(texto) ||
    ORDEN_YA_PUEDES_IMPLEMENTAR.test(texto) ||
    ORDEN_COMO_IMPLEMENTADA_EXPLICITA.test(texto) ||
    ORDEN_COMO_IMPLEMENTADA_CLITICO.test(texto) ||
    ORDEN_CLITICO_DIRECTO_IMPLEMENTAR.test(texto)
  )
}
