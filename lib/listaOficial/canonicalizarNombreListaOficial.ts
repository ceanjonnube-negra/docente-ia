// lib/listaOficial/canonicalizarNombreListaOficial.ts
//
// FASE 1 — función pura y AISLADA (ver diseño aprobado "equivalencia de
// nombre por formato explícito"). NO se integra todavía a ningún flujo
// real: no la importa matchingListaOficial.ts, ni propuestasReparacionCurp.ts,
// ni ningún endpoint. Esta fase es únicamente crear y probar la función.
//
// Objetivo: reconocer, de forma 100% determinista, el formato explícito de
// lista oficial `APELLIDO1[/APELLIDO2]*NOMBRES` y reconstruirlo como
// "NOMBRES APELLIDO1 APELLIDO2" — nunca una aproximación, nunca fuzzy,
// nunca Levenshtein, nunca IA. Si la sintaxis no calza EXACTAMENTE con la
// gramática aceptada, se rechaza (fail-closed) — nunca se adivina una
// interpretación alternativa.
//
// Deliberadamente NO importa normalizarNombre de lib/emparejarAlumno.ts:
// el diseño aprobado exige que esta fase permanezca aislada, sin tocar
// matching existente. Se reimplementa aquí, localmente, exactamente la
// misma regla de normalización de caracteres (NFD, quitar diacríticos,
// minúsculas, puntuación a espacio, colapsar espacios, trim) — una
// duplicación deliberada y documentada, no un descuido. Si en una fase
// futura se decide compartir una sola implementación, ese sería un
// cambio aparte, explícito, que sí tocaría lib/emparejarAlumno.ts.
//
// Gramática aceptada, sin excepciones:
//   BLOQUE_APELLIDO [ / BLOQUE_APELLIDO ] * BLOQUE_NOMBRES
// - Exactamente un `*` en toda la cadena.
// - Como máximo un `/`, y si existe, debe estar ANTES del `*`.
// - Ningún bloque puede quedar vacío tras trim().
// - Cada bloque solo puede contener letras (con acentos/ñ/ü) y espacios
//   — cualquier otro carácter (dígitos, comas, guiones, puntos, etc.)
//   dentro de un bloque invalida la cadena completa. Esto es lo que
//   distingue "MEDINA ROMERO*SANTIAGO" (válido: un bloque de apellido
//   compuesto, un solo espacio interno) de "MEDINA,ROMERO*SANTIAGO"
//   (inválido: la coma no es un carácter de nombre válido y NUNCA se
//   interpreta como equivalente a `/`).
// - Sin `/`: el bloque completo antes del `*` se trata como UN SOLO
//   bloque de apellido atómico (puede tener espacios internos — nunca
//   se parte para "adivinar" dónde termina un apellido y empieza otro;
//   ver decisión aprobada "un solo apellido").
// - Con `/`: exactamente dos bloques de apellido, cada uno preservado
//   tal cual (incluye partículas como DE/DEL/DE LA/DE LOS/SAN/SANTA,
//   que nunca se separan de su bloque).
//
// Prohibido siempre, sin excepción: reordenar tokens dentro de un
// bloque, eliminar/mover partículas, eliminar tokens repetidos,
// corregir ortografía, tolerar una sola letra de diferencia, inferir
// separación de apellidos sin `/`, inferir nombres sin `*`, usar
// distancia Levenshtein o cualquier medida de similitud, usar IA,
// tocar Supabase.

export type ResultadoCanonicalizacionNombre =
  | { valido: true; nombreCanonical: string }
  | { valido: false; motivo: string }

// Solo letras (incluye vocales acentuadas, Ñ/ñ, Ü/ü) y espacios — mismo
// alfabeto real de un nombre propio en español. Cualquier otro carácter
// dentro de un bloque (dígitos, coma, guion, punto, apóstrofo, etc.)
// invalida la cadena completa: nunca se interpreta como separador
// alternativo ni se ignora en silencio.
const BLOQUE_VALIDO = /^[A-Za-zÁÉÍÓÚáéíóúÑñÜü\s]+$/

// Misma regla de normalización de caracteres que ya usa normalizarNombre
// (lib/emparejarAlumno.ts) — reimplementada aquí de forma aislada,
// deliberadamente, ver cabecera del archivo. Aplicada por bloque, nunca
// sobre toda la cadena reconstruida de una sola vez, para que cada
// bloque quede limpio antes de unirlos con un único espacio.
function normalizarBloque(bloque: string): string {
  return bloque
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

export function canonicalizarNombreListaOficial(nombreDocumento: string): ResultadoCanonicalizacionNombre {
  if (typeof nombreDocumento !== 'string' || !nombreDocumento.trim()) {
    return { valido: false, motivo: 'Cadena vacía o no válida.' }
  }

  const totalAsteriscos = (nombreDocumento.match(/\*/g) || []).length
  if (totalAsteriscos !== 1) {
    return { valido: false, motivo: 'Se requiere exactamente un separador "*".' }
  }

  const [bloqueApellidosCrudo, bloqueNombresCrudo] = nombreDocumento.split('*')

  const bloqueNombres = bloqueNombresCrudo.trim()
  if (!bloqueNombres) {
    return { valido: false, motivo: 'El bloque de nombres está vacío.' }
  }
  if (bloqueNombresCrudo.includes('/')) {
    return { valido: false, motivo: 'No se permite "/" después del "*".' }
  }
  if (!BLOQUE_VALIDO.test(bloqueNombres)) {
    return { valido: false, motivo: 'El bloque de nombres contiene caracteres no válidos.' }
  }

  const bloqueApellidos = bloqueApellidosCrudo.trim()
  if (!bloqueApellidos) {
    return { valido: false, motivo: 'El bloque de apellido(s) está vacío.' }
  }

  const totalSlashes = (bloqueApellidosCrudo.match(/\//g) || []).length
  if (totalSlashes > 1) {
    return { valido: false, motivo: 'Se permite como máximo un separador "/".' }
  }

  let apellido1: string
  let apellido2: string | null

  if (totalSlashes === 1) {
    const [crudo1, crudo2] = bloqueApellidosCrudo.split('/')
    apellido1 = crudo1.trim()
    apellido2 = crudo2.trim()
    if (!apellido1 || !apellido2) {
      return { valido: false, motivo: 'Alguno de los dos bloques de apellido está vacío.' }
    }
  } else {
    // Sin "/" — el bloque completo es UN SOLO apellido atómico (puede
    // ser compuesto, con espacios internos). Nunca se parte para
    // adivinar límites entre dos apellidos independientes.
    apellido1 = bloqueApellidos
    apellido2 = null
  }

  if (!BLOQUE_VALIDO.test(apellido1) || (apellido2 !== null && !BLOQUE_VALIDO.test(apellido2))) {
    return { valido: false, motivo: 'Alguno de los bloques de apellido contiene caracteres no válidos.' }
  }

  const partes = [normalizarBloque(bloqueNombres), normalizarBloque(apellido1)]
  if (apellido2 !== null) partes.push(normalizarBloque(apellido2))

  return { valido: true, nombreCanonical: partes.join(' ') }
}
