import type { SupabaseClient } from '@supabase/supabase-js'

// Chat IA — Registro escolar: Claude lee nombres de una imagen (no
// conoce los alumno_id reales de tu base). Esta funcion resuelve cada
// nombre leido contra los alumnos REALES del grupo activo, usando
// normalizacion de texto + distancia de Levenshtein — nunca inventa un
// alumno_id, y nunca asume una coincidencia de baja confianza (mejor
// reportar "no resuelto" que guardar en el alumno equivocado).

function normalizarNombre(nombre: string): string {
  return nombre
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function distanciaLevenshtein(a: string, b: string): number {
  const filas = a.length + 1
  const columnas = b.length + 1
  const matriz: number[][] = Array.from({ length: filas }, () => new Array(columnas).fill(0))

  for (let i = 0; i < filas; i++) matriz[i][0] = i
  for (let j = 0; j < columnas; j++) matriz[0][j] = j

  for (let i = 1; i < filas; i++) {
    for (let j = 1; j < columnas; j++) {
      const costo = a[i - 1] === b[j - 1] ? 0 : 1
      matriz[i][j] = Math.min(
        matriz[i - 1][j] + 1,
        matriz[i][j - 1] + 1,
        matriz[i - 1][j - 1] + costo
      )
    }
  }
  return matriz[filas - 1][columnas - 1]
}

function calcularSimilitud(a: string, b: string): number {
  if (!a || !b) return 0

  const distancia = distanciaLevenshtein(a, b)
  const maxLen = Math.max(a.length, b.length)
  const similitudDirecta = maxLen === 0 ? 1 : 1 - distancia / maxLen

  const palabrasA = new Set(a.split(' ').filter(Boolean))
  const palabrasB = new Set(b.split(' ').filter(Boolean))
  const interseccion = [...palabrasA].filter((p) => palabrasB.has(p)).length
  const union = new Set([...palabrasA, ...palabrasB]).size
  const similitudPalabras = union === 0 ? 0 : interseccion / union

  return Math.max(similitudDirecta, similitudPalabras)
}

export type AlumnoResuelto = {
  nombreOriginal: string
  alumnoId: string | null
  nombreEmparejado: string | null
  confianza: number
}

const UMBRAL_CONFIANZA = 0.72

export async function resolverAlumnosPorNombre(
  sb: SupabaseClient,
  grupoId: string,
  nombres: string[]
): Promise<AlumnoResuelto[]> {
  const { data: alumnos, error } = await sb
    .from('alumnos')
    .select('id, nombre')
    .eq('grupo_id', grupoId)

  if (error || !alumnos) {
    console.error('[EMPAREJAR_ALUMNO] No se pudo leer la lista de alumnos del grupo:', error)
    return nombres.map((n) => ({ nombreOriginal: n, alumnoId: null, nombreEmparejado: null, confianza: 0 }))
  }

  const alumnosNormalizados = alumnos.map((a) => ({
    id: a.id as string,
    nombreOriginal: a.nombre as string,
    nombreNormalizado: normalizarNombre(a.nombre as string),
  }))

  return nombres.map((nombreLeido) => {
    const normalizado = normalizarNombre(nombreLeido)
    let mejor: { id: string; nombre: string; score: number } | null = null

    for (const alumno of alumnosNormalizados) {
      const score = calcularSimilitud(normalizado, alumno.nombreNormalizado)
      if (!mejor || score > mejor.score) {
        mejor = { id: alumno.id, nombre: alumno.nombreOriginal, score }
      }
    }

    if (mejor && mejor.score >= UMBRAL_CONFIANZA) {
      return { nombreOriginal: nombreLeido, alumnoId: mejor.id, nombreEmparejado: mejor.nombre, confianza: mejor.score }
    }
    return { nombreOriginal: nombreLeido, alumnoId: null, nombreEmparejado: null, confianza: mejor?.score ?? 0 }
  })
}
