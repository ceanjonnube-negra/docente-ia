// lib/documentGen/parseContenido.ts
//
// Interpreta el texto plano estructurado que ya produce el system prompt
// de MODO DOCUMENTO (títulos en MAYÚSCULAS con emoji, viñetas con "- ",
// párrafos normales) — compartido por los generadores de PDF, PowerPoint
// y Excel (Word tiene su propio parseo más rico en
// construirDocumentoWord.ts, con detección de tablas de alumnos/CURP).

export type LineaDocumento =
  | { tipo: 'titulo'; texto: string }
  | { tipo: 'seccion'; texto: string }
  | { tipo: 'bullet'; texto: string }
  | { tipo: 'parrafo'; texto: string }

export function analizarContenido(texto: string): LineaDocumento[] {
  const lineas = texto
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('|') && !/^[-|:\s]+$/.test(l) && l !== '---' && !/^-{2,}$/.test(l))
    .map(l =>
      l
        .replace(/\*\*(.*?)\*\*/g, '$1')
        .replace(/\*(.*?)\*/g, '$1')
        .replace(/^#{1,6}\s+/, '')
        .replace(/^>\s+/, '')
        .trim()
    )
    .filter(l => l.length > 0)

  // Algunos encabezados del formato real (ver MODO DOCUMENTO en
  // app/api/chat/route.ts) no son 100% mayúsculas porque incluyen un
  // título variable: "DÍA 1 — [título del día]", "RESUMEN — [nombre de
  // la ley]", "CRITERIO 1: [nombre]". Se reconocen por patrón además de
  // por mayúsculas puras.
  const PATRON_SECCION_MIXTA = /^(📅\s*)?D[IÍ]A\s+\d+\b|^CRITERIO\s+\d+\b|^(📄\s*)?RESUMEN\s*—/i

  const resultado: LineaDocumento[] = []
  let tituloUsado = false
  let esPrimeraLinea = true
  for (const linea of lineas) {
    // La primera línea del documento siempre es su encabezado principal
    // (📋/📊/📝/📨/📄/📖 + título) aunque el título en sí —como el de un
    // cuento o fábula generado por el modelo— no venga en mayúsculas.
    const esTitulo = esPrimeraLinea || (linea === linea.toUpperCase() && linea.length > 3) || PATRON_SECCION_MIXTA.test(linea)
    const esBullet = /^-\s+/.test(linea)
    esPrimeraLinea = false
    if (esTitulo) {
      resultado.push({ tipo: tituloUsado ? 'seccion' : 'titulo', texto: linea })
      tituloUsado = true
    } else if (esBullet) {
      resultado.push({ tipo: 'bullet', texto: linea.replace(/^-\s+/, '') })
    } else {
      resultado.push({ tipo: 'parrafo', texto: linea })
    }
  }
  return resultado
}

export type Diapositiva = { titulo: string; contenido: string[] }

// Agrupa las líneas en diapositivas: cada título/sección principal abre
// una diapositiva nueva; lo que sigue (viñetas, párrafos) es su
// contenido — así una PLANEACIÓN con "DÍA 1", "DÍA 2"... o una RÚBRICA
// con "CRITERIO 1", "CRITERIO 2"... se convierte en una presentación con
// una diapositiva por sección, sin que el maestro tenga que pedirlo así.
export function agruparEnDiapositivas(lineas: LineaDocumento[]): Diapositiva[] {
  const diapositivas: Diapositiva[] = []
  let actual: Diapositiva | null = null
  for (const l of lineas) {
    if (l.tipo === 'titulo' || l.tipo === 'seccion') {
      actual = { titulo: l.texto, contenido: [] }
      diapositivas.push(actual)
    } else if (actual) {
      actual.contenido.push(l.texto)
    } else {
      actual = { titulo: 'Contenido', contenido: [l.texto] }
      diapositivas.push(actual)
    }
  }
  return diapositivas
}

// Para Excel: si el contenido trae líneas separadas por "|" (el formato
// tabular real que ya usa el system prompt para listas de alumnos,
// calificaciones, horarios — ver EXCEPCION A LA REGLA 3 en
// app/api/chat/route.ts), se extraen como filas/columnas reales.
export function extraerFilasTabulares(texto: string): string[][] | null {
  const lineas = texto
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.includes('|') && !/^[\s|:-]+$/.test(l))
  if (lineas.length < 2) return null
  return lineas.map(l => l.split('|').map(c => c.trim()).filter(c => c.length > 0))
}

export function extraerTitulo(texto: string): string {
  const primera = texto.split('\n').map(l => l.trim()).find(Boolean) || 'Documento'
  return primera.replace(/^(📋|📊|📝|📨|📄|📖)\s*/, '')
}
