// lib/programaAnalitico/sanitizarContextoIndividual.ts
//
// PA-5D — sanitización determinista (0 IA) del contexto pedagógico
// derivado de un adjunto, aplicada UNA SOLA VEZ, justo después de la
// extracción visual y ANTES de que el texto llegue a cualquier otro
// lugar (prompt de generación o persistencia). El Programa Analítico
// es un documento de planeación GRUPAL — la identidad de un alumno
// específico pertenece a seguimiento/evaluación individual, nunca al
// contexto canónico del PA (ver informe PA-5C §J: un nombre real de
// alumno llegó a contexto_notas y se habría vuelto permanente al
// publicar, incluso repetido por la propia síntesis de la llamada de
// generación — por eso esta sanitización corre ANTES de esa llamada,
// nunca solo al final antes de guardar).
//
// Defensa complementaria a la instrucción del prompt visual (ver
// contextoAdjuntoProgramaAnalitico.ts): esta capa nunca depende de que
// el modelo obedezca — es el filtro real, determinista, server-side.

import type { ContextoPedagogicoAdjunto } from './contextoAdjuntoProgramaAnalitico'

export type AlumnoRosterMinimo = { nombreCompleto: string }

const FRASE_NEUTRAL_ALUMNO = 'un alumno del grupo'

// Variantes acentuadas toleradas por letra — mismo criterio de
// normalización (minúsculas + insensible a acentos) ya usado en
// borradorProgramaAnalitico.ts/interpretarAjusteBorrador.ts, aplicado
// aquí carácter por carácter para poder construir un patrón que
// coincida sobre el texto ORIGINAL sin perder los índices (nunca se
// normaliza el texto completo y se intenta remapear posiciones).
const MAPA_ACENTOS: Record<string, string> = {
  a: 'aáà', e: 'eéè', i: 'iíì', o: 'oóò', u: 'uúùü', n: 'nñ', c: 'cç',
}

function escaparRegex(caracter: string): string {
  return caracter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Nunca fuzzy: exige el nombre CANÓNICO COMPLETO del roster (todas sus
// palabras, en el mismo orden) — solo tolera mayúsculas/acentos y
// espacios extra entre palabras. Un valor de una sola palabra o muy
// corto se descarta por completo (nunca se sanitiza contra un nombre
// de pila suelto, para no arriesgar coincidencias con palabras
// comunes). Límites de palabra manuales vía lookaround (\b no maneja
// bien acentos) — nunca coincide dentro de una palabra más larga.
function construirPatronNombreCompleto(nombreCanonico: string): RegExp | null {
  const limpio = nombreCanonico.trim().replace(/\s+/g, ' ')
  if (limpio.length < 4 || !limpio.includes(' ')) return null
  const cuerpo = limpio
    .split('')
    .map((ch) => {
      if (ch === ' ') return '\\s+'
      // Letra BASE del carácter (quita su propio acento, si lo tiene)
      // antes de buscar la clase — así "Á" en el nombre canónico
      // también encuentra la clase de "a" y sigue tolerando cualquier
      // variante (con o sin acento, cualquier mayúscula) del lado del
      // texto a sanitizar. Sin esto, un nombre canónico ya acentuado
      // solo se reconocería a sí mismo, nunca sus variantes reales.
      const base = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      const clase = MAPA_ACENTOS[base]
      return clase ? `[${clase}${clase.toUpperCase()}]` : escaparRegex(ch)
    })
    .join('')
  // 'i' además de las clases manuales de vocales: las clases cubren
  // acentos (que 'i' no resuelve por sí solo), 'i' cubre mayúsculas de
  // consonantes (que las clases no incluyen, solo se construyeron para
  // letras con variante acentuada).
  return new RegExp(`(?<![\\p{L}])${cuerpo}(?![\\p{L}])`, 'giu')
}

function sanitizarNombres(texto: string, patrones: RegExp[]): string {
  let resultado = texto
  for (const patron of patrones) {
    patron.lastIndex = 0
    resultado = resultado.replace(patron, FRASE_NEUTRAL_ALUMNO)
  }
  return resultado
}

// CURP — mismo patrón estructural público (18 caracteres, formato
// oficial) ya usado de forma independiente en otros 2 módulos del
// repo (lib/asistente/documentos.ts, lib/documentGen/
// construirDocumentoWord.ts) — replicado aquí porque ninguno lo expone
// como utilidad importable sin tocar un módulo fuera de esta tarea.
// Matrícula NO se sanitiza aquí (no existe un formato canónico único
// en el proyecto) — ver deuda documentada en el informe PA-5D.
const REGEX_CURP_ESTRUCTURAL = /\b[A-Z]{4}\d{6}[HM][A-Z]{2}[A-Z]{3}[A-Z0-9]\d\b/gi

function sanitizarIdentificadoresEstructurados(texto: string): string {
  REGEX_CURP_ESTRUCTURAL.lastIndex = 0
  return texto.replace(REGEX_CURP_ESTRUCTURAL, '[dato personal omitido]')
}

// Punto único de sanitización del contexto derivado del adjunto.
// Nunca loguea el nombre encontrado ni el texto sanitizado — solo
// devuelve el resultado. 0 llamadas IA: comparación de texto
// determinista contra el roster real ya resuelto (RLS) del grupo.
export function sanitizarContextoPedagogicoAdjunto(contexto: ContextoPedagogicoAdjunto, roster: AlumnoRosterMinimo[]): ContextoPedagogicoAdjunto {
  const patrones = roster.map((a) => construirPatronNombreCompleto(a.nombreCompleto)).filter((p): p is RegExp => p !== null)
  const limpiar = (texto: string) => sanitizarIdentificadoresEstructurados(sanitizarNombres(texto, patrones))
  return {
    hayContextoPedagogico: contexto.hayContextoPedagogico,
    observaciones: contexto.observaciones.map(limpiar),
    lecturasDudosas: contexto.lecturasDudosas.map(limpiar),
  }
}
