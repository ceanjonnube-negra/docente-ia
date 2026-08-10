// lib/documentGen/nivelEducativo.ts
//
// Ver "Ilustraciones por nivel educativo, Fase 1 — diseño +
// implementación base". Resuelve, de forma pura y determinista (sin
// red, sin IA), el nivel educativo objetivo de un documento — nunca
// decide por sí solo cambiar el contenido; solo produce el dato que
// route.ts/herramientas.ts usan para ajustar tono/densidad/estilo
// visual (ver perfilNivelEducativo.ts).
//
// PRIORIDAD (ver "Comportamiento esperado" del pedido aprobado):
// 1. Nivel/grado mencionado EXPLÍCITAMENTE en el mensaje actual del
//    docente — siempre gana, aunque el grupo activo diga otra cosa
//    (el docente puede estar pidiendo un documento para OTRO grupo o
//    nivel del que normalmente atiende).
// 2. nivel_educativo + grado del GRUPO ACTIVO real (tabla `grupos` —
//    ya existía, capturado al crear el grupo en
//    app/dashboard/grupos/nuevo/page.tsx, pero nunca se leía de vuelta
//    hacia el Chat; ver lib/sesionContexto.ts). Fuente correcta: a
//    diferencia de perfiles_docentes.grado (legado, solo admite
//    primaria 1°-6°), grupos.nivel_educativo sí distingue
//    preescolar/primaria/secundaria.
// 3. Si ninguna de las dos resuelve nada → null. El llamador debe
//    tratar null exactamente como el comportamiento actual (sin
//    ilustraciones ajustadas por nivel, sin cambiar nada) — nunca
//    inventar un nivel por default.

export type NivelEducativo = 'preescolar' | 'primaria_baja' | 'primaria_media' | 'primaria_alta' | 'secundaria'

const REGEX_PREESCOLAR = /\bpreescolar\b|\bkinder\b|\bkínder\b/i
const REGEX_SECUNDARIA = /\bsecundaria\b/i
const REGEX_PRIMARIA = /\bprimaria\b/i

// Variantes reales de cómo un docente mexicano escribe el grado:
// dígito+°, dígito+ordinal pegado ("4to", "2do", "1er", "3ro"/"3er"),
// o la palabra completa ("cuarto grado"). Curada y explícita, mismo
// criterio que el resto del proyecto (ver documentos.ts) — nunca un
// comparador de distancia aproximada genérico.
const PALABRAS_GRADO: Record<string, number> = {
  primero: 1, primer: 1,
  segundo: 2,
  tercero: 3, tercer: 3,
  cuarto: 4,
  quinto: 5,
  sexto: 6,
}

function extraerNumeroGrado(texto: string): number | null {
  const normalizado = texto.toLowerCase()
  const matchGrado = normalizado.match(/\b([1-6])\s*°/)
  if (matchGrado) return Number(matchGrado[1])
  const matchOrdinal = normalizado.match(/\b([1-6])\s*(?:er|do|ro|to|vo)\b/)
  if (matchOrdinal) return Number(matchOrdinal[1])
  for (const [palabra, numero] of Object.entries(PALABRAS_GRADO)) {
    if (new RegExp(`\\b${palabra}\\b`).test(normalizado)) return numero
  }
  return null
}

function nivelDesdeGradoPrimaria(grado: number | null): NivelEducativo | null {
  if (grado === 1 || grado === 2) return 'primaria_baja'
  if (grado === 3 || grado === 4) return 'primaria_media'
  if (grado === 5 || grado === 6) return 'primaria_alta'
  return null
}

// Solo el texto del mensaje ACTUAL — nunca inventa un nivel que el
// docente no mencionó de verdad.
export function resolverNivelEducativoDeTexto(texto: string): NivelEducativo | null {
  if (REGEX_PREESCOLAR.test(texto)) return 'preescolar'
  if (REGEX_SECUNDARIA.test(texto)) return 'secundaria'
  if (REGEX_PRIMARIA.test(texto)) return nivelDesdeGradoPrimaria(extraerNumeroGrado(texto))

  // Grado mencionado SIN decir el nivel explícitamente (ej. "para
  // 4°"): solo se asume primaria cuando el número es 4, 5 o 6 — esos
  // grados son inequívocos (preescolar y secundaria solo llegan hasta
  // 3, ver GRADOS_POR_NIVEL en app/dashboard/grupos/nuevo/page.tsx).
  // Un grado 1-3 sin nivel dicho es ambiguo a propósito: se deja sin
  // resolver aquí y cae al nivel del grupo activo.
  const grado = extraerNumeroGrado(texto)
  if (grado !== null && grado >= 4) return nivelDesdeGradoPrimaria(grado)
  return null
}

export type GrupoActivoNivelInfo = {
  // Valores crudos tal cual vienen de la tabla `grupos` (ver
  // SesionContexto.nivel_educativo_grupo / grado_grupo).
  nivelEducativoGrupo: string | null
  gradoGrupo: string | null
}

export function resolverNivelEducativoDeGrupo(info: GrupoActivoNivelInfo): NivelEducativo | null {
  if (info.nivelEducativoGrupo === 'preescolar') return 'preescolar'
  if (info.nivelEducativoGrupo === 'secundaria') return 'secundaria'
  if (info.nivelEducativoGrupo === 'primaria') {
    const grado = info.gradoGrupo ? Number(info.gradoGrupo.replace(/\D/g, '')) : null
    return nivelDesdeGradoPrimaria(Number.isFinite(grado) ? grado : null)
  }
  return null
}

export function resolverNivelEducativo(params: {
  textoMensaje: string
  grupoActivo?: GrupoActivoNivelInfo
}): NivelEducativo | null {
  const deTexto = resolverNivelEducativoDeTexto(params.textoMensaje)
  if (deTexto) return deTexto
  if (params.grupoActivo) return resolverNivelEducativoDeGrupo(params.grupoActivo)
  return null
}
