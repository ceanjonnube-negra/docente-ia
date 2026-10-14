// lib/asistente/identidadAlumno.ts
//
// Identidad canónica del alumno para consultas y correcciones de datos
// personales (CURP, sexo, fecha de nacimiento) desde el Chat IA.
//
// El Clasificador de Nivel 0 (LLM) PROPONE un alumno_id; esta capa,
// 100% determinista y sin I/O, decide si esa propuesta se acepta:
//   1. el alumno_id debe pertenecer a alumnos_del_grupo_activo — la
//      lista que el servidor arma con la sesión autenticada del docente
//      (ver obtenerSesionContexto). Un id de otro grupo, de otra cuenta o
//      inexistente nunca está en esa lista;
//   2. el nombre que el LLM dice haber detectado debe corresponder a ese
//      mismo alumno (sin discrepancia entre nombre e id);
//   3. el texto del docente (mensaje actual o sus turnos previos) debe
//      mencionar a ese alumno, y él debe ser la ÚNICA mejor coincidencia;
//      si hay varias, se pide aclaración con los nombres canónicos. Sin
//      ninguna mención reconocible no hay evidencia independiente del LLM
//      y tampoco se acepta — nunca se elige por aproximación.
// Esta capa nunca elige un alumno por su cuenta: solo confirma, rechaza
// o convierte en ambigüedad lo que propuso el LLM.

import type { AlumnoLigero } from '../sesionContexto'

export const MENSAJE_ALUMNO_NO_IDENTIFICADO =
  'No pude identificar con certeza a ese alumno en tu grupo activo, así que no continué. ¿Puedes escribir su nombre completo tal como aparece en tu lista?'

// Partículas de nombres y apellidos que no distinguen a nadie.
const PARTICULAS = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e', 'el'])

export function normalizarTextoNombre(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function tokens(texto: string): string[] {
  return normalizarTextoNombre(texto)
    .split(' ')
    .filter((t) => t.length >= 2 && !PARTICULAS.has(t))
}

// Mención FUERTE: la palabra del docente es igual a un token del nombre,
// o un prefijo de al menos 4 letras ("Kimb" → "kimberly").
function coincide(palabra: string, tokenNombre: string): boolean {
  return palabra === tokenNombre || (palabra.length >= 4 && tokenNombre.startsWith(palabra))
}

// Mención DÉBIL: prefijo de exactamente 3 letras ("Kim" → "kimberly").
// Solo se considera si el texto no trae ninguna mención fuerte, y nunca
// con palabras comunes de 3 letras que podrían confundirse con nombres.
const PALABRAS_COMUNES_3 = new Set(['que', 'por', 'una', 'uno', 'con', 'sus', 'mal', 'hay', 'son', 'fue', 'sin', 'era', 'muy', 'mas', 'dia', 'ano', 'ese', 'esa', 'eso', 'les', 'nos', 'sea', 'ser', 'han', 'has', 'hoy', 'ver', 'dar', 'sal', 'sol', 'mar', 'luz', 'paz', 'voz', 'fin', 'mes', 'ahi', 'tal', 'van', 'vez', 'pon', 'dio', 'den', 'tus', 'mis', 'pie', 'red', 'rey', 'ley', 'oro', 'gas', 'dos', 'mil'])
function coincideDebil(palabra: string, tokenNombre: string): boolean {
  return palabra.length === 3 && !PALABRAS_COMUNES_3.has(palabra) && tokenNombre.length > 3 && tokenNombre.startsWith(palabra)
}

// Cuántos tokens distintos del nombre del alumno aparecen en el texto.
function puntaje(alumno: AlumnoLigero, palabras: string[], criterio: (p: string, t: string) => boolean): number {
  return tokens(alumno.nombre_completo).filter((t) => palabras.some((p) => criterio(p, t))).length
}

// Mejores candidatos del primer texto (del más reciente al más antiguo)
// que mencione a algún alumno: primero por mención fuerte; si ese texto
// no tiene ninguna, por mención débil.
function mejoresCandidatos(lista: AlumnoLigero[], textosDocente: string[]): AlumnoLigero[] {
  for (const texto of textosDocente) {
    const palabras = tokens(texto)
    for (const criterio of [coincide, coincideDebil]) {
      const puntajes = lista.map((a) => ({ a, p: puntaje(a, palabras, criterio) }))
      const maximo = Math.max(0, ...puntajes.map((x) => x.p))
      if (maximo > 0) return puntajes.filter((x) => x.p === maximo).map((x) => x.a)
    }
  }
  return []
}

export function alumnoDelGrupoActivo(lista: AlumnoLigero[], alumnoId: string | null | undefined): AlumnoLigero | null {
  if (!alumnoId) return null
  return lista.find((a) => a.alumno_id === alumnoId) ?? null
}

export type ResultadoIdentidadAlumno =
  | { tipo: 'sin_alumno' }
  | { tipo: 'resuelto'; alumno: AlumnoLigero }
  | { tipo: 'ambiguo'; opciones: string[]; ids: string[] }
  | { tipo: 'rechazado'; motivo: 'fuera_de_grupo' | 'discrepancia' | 'ambiguedad_sin_opciones' | 'sin_evidencia' }

export function validarAlumnoClasificado(
  propuesta: { alumnoId: string | null; nombreDetectado: string | null; ambiguo: boolean; opciones: string[] },
  lista: AlumnoLigero[],
  // Texto del docente, del más reciente al más antiguo (mensaje actual
  // y sus turnos previos). Se usa el primero que mencione a algún alumno.
  textosDocente: string[],
  // Continuidad V1: alumno heredado de un estado pendiente FIRMADO por el
  // servidor y revalidado contra el grupo (ver estadoPendiente.ts). Es
  // evidencia de confianza solo cuando el texto no menciona a nadie.
  alumnoHeredadoId: string | null = null
): ResultadoIdentidadAlumno {
  const mejores = mejoresCandidatos(lista, textosDocente)

  if (propuesta.ambiguo) {
    if (mejores.length > 1) return { tipo: 'ambiguo', opciones: mejores.map((a) => a.nombre_completo), ids: mejores.map((a) => a.alumno_id) }
    const desdeOpciones = lista.filter((a) =>
      propuesta.opciones.some((o) => {
        const t = tokens(o)
        const delAlumno = tokens(a.nombre_completo)
        return t.length > 0 && t.every((x) => delAlumno.some((y) => coincide(x, y)))
      })
    )
    if (desdeOpciones.length > 1) return { tipo: 'ambiguo', opciones: desdeOpciones.map((a) => a.nombre_completo), ids: desdeOpciones.map((a) => a.alumno_id) }
    return { tipo: 'rechazado', motivo: 'ambiguedad_sin_opciones' }
  }

  if (!propuesta.alumnoId) return { tipo: 'sin_alumno' }

  const alumno = alumnoDelGrupoActivo(lista, propuesta.alumnoId)
  if (!alumno) return { tipo: 'rechazado', motivo: 'fuera_de_grupo' }

  if (propuesta.nombreDetectado) {
    const delLlm = tokens(propuesta.nombreDetectado)
    const delAlumno = tokens(alumno.nombre_completo)
    if (delLlm.length === 0 || !delLlm.every((x) => delAlumno.some((y) => coincide(x, y)))) {
      return { tipo: 'rechazado', motivo: 'discrepancia' }
    }
  }

  // Sin ninguna mención reconocible del docente, la identidad dependería
  // solo del LLM: se pide aclaración.
  if (mejores.length === 0) {
    return alumnoHeredadoId && alumno.alumno_id === alumnoHeredadoId ? { tipo: 'resuelto', alumno } : { tipo: 'rechazado', motivo: 'sin_evidencia' }
  }
  if (!mejores.some((a) => a.alumno_id === alumno.alumno_id)) return { tipo: 'rechazado', motivo: 'discrepancia' }
  if (mejores.length > 1) return { tipo: 'ambiguo', opciones: mejores.map((a) => a.nombre_completo), ids: mejores.map((a) => a.alumno_id) }

  return { tipo: 'resuelto', alumno }
}
