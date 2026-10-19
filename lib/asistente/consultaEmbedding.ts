// lib/asistente/consultaEmbedding.ts
//
// Privacidad del contexto RAG — prepara, de forma DETERMINISTA y pura
// (0 IA, 0 consultas), el ÚNICO texto que sale hacia el proveedor de
// embeddings desde la búsqueda de documentos del Chat IA. Nunca modifica
// el mensaje original, el historial ni el prompt conversacional: solo
// produce una copia protegida para `embeddings.create`.
//
// Cobertura REAL (patrones específicos, no "todos los datos personales"):
// - Nombres del roster confirmado del GRUPO ACTIVO (ya cargado en la
//   sesión): el nombre completo y fragmentos de 2+ palabras del nombre de
//   un alumno → "un alumno" (también si el fragmento lo comparten varios
//   alumnos, p. ej. apellidos de hermanos: se elimina igual por completo).
//   Un nombre/apellido suelto del roster que sigue en el texto se trata
//   como identidad no protegible → se omite RAG.
// - CURP: la forma completa de 18 caracteres (válida o con errores de
//   validación) y la forma con espacios o guiones con la estructura
//   característica (4 letras, 6 dígitos, H/M/X, 5 letras, 1 alfanumérico,
//   1 dígito), AUNQUE falle la validación oficial → "una CURP".
// - Correos electrónicos y teléfonos de 10 dígitos (opcional +52).
// - Fechas en contexto personal (nacimiento, cumpleaños). Las demás
//   fechas (ciclos, calendarios, acuerdos) se conservan.
// - Nombres fuera del roster (otro grupo, sin grupo activo) → se omite RAG
//   cuando hay un posible nombre de persona: dos palabras seguidas con
//   mayúscula no reconocidas como términos escolares/institucionales, o
//   una palabra con mayúscula justo después de alumno(s)/niño(s)/hijo(s)…
// Limitaciones: un nombre de una sola palabra fuera del roster y sin esos
// indicios ("¿Cómo va Valentina?"), nombres en minúsculas, domicilios y
// matrículas sin formato canónico no se detectan. Nombres propios que no
// son de personas pueden omitir RAG innecesariamente (falla segura).
//
// Falla segura: cualquier excepción → { enviar: false } — nunca el texto
// original como alternativa.

import { construirPatronNombreCompleto } from '../programaAnalitico/sanitizarContextoIndividual'

export const MARCADOR_ALUMNO = 'un alumno'
const MARCADOR_CURP = 'una CURP'

export type ResumenProteccionEmbedding = { nombres: number; curp: number; contacto: number; fechas: number }

export type ConsultaEmbedding =
  | { enviar: true; texto: string; resumen: ResumenProteccionEmbedding }
  | { enviar: false; motivo: 'privacidad' | 'error'; resumen: ResumenProteccionEmbedding }

type AlumnoRoster = { alumno_id: string; nombre_completo: string }

// Partículas de nombres compuestos: nunca cuentan como palabra
// identificadora ("de la" jamás basta para identificar a nadie).
const PARTICULAS = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e', 'da', 'das', 'do', 'dos', 'di', 'du', 'san', 'santa', 'van', 'von'])
// Nombres/apellidos que también son palabras comunes del español: solo
// cuentan como mención de un alumno si aparecen con mayúscula inicial, y
// un fragmento formado solo por ellas no basta para sustituir.
const PALABRAS_COMUNES = new Set([
  'paz', 'luz', 'rosa', 'mar', 'sol', 'cruz', 'reyes', 'leon', 'rey', 'flores', 'campos', 'vega', 'rivera', 'luna', 'mora', 'santos', 'salas',
  'rios', 'rio', 'prado', 'nieves', 'blanco', 'castillo', 'montes', 'fuentes', 'valle', 'soto', 'gracia', 'gloria', 'esperanza', 'consuelo',
  'dolores', 'pilar', 'rocio', 'aurora', 'alba', 'alegria', 'angel', 'cielo', 'clara', 'victoria', 'iris', 'abril', 'paloma', 'perla',
  'estrella', 'fe', 'amparo', 'socorro', 'merced', 'mercedes', 'guadalupe', 'jesus', 'trinidad', 'pena', 'vida', 'leal', 'franco', 'bravo',
])
// Palabras que señalan una consulta sobre un alumno en particular.
const INDICIOS_INDIVIDUALES = new Set(['alumno', 'alumna', 'alumnos', 'alumnas', 'nino', 'nina', 'ninos', 'ninas', 'estudiante', 'estudiantes', 'hijo', 'hija', 'hijos', 'hijas', 'menor', 'menores'])
// Términos con mayúscula habituales en consultas curriculares/escolares
// (nunca nombres de personas) — no cuentan como nombre propio.
const MAYUSCULAS_ESCOLARES = new Set([
  'lenguajes', 'saberes', 'pensamiento', 'cientifico', 'etica', 'naturaleza', 'sociedad', 'humano', 'comunitario', 'programa', 'analitico',
  'sintetico', 'consejo', 'tecnico', 'escolar', 'nueva', 'escuela', 'mexicana', 'matematicas', 'espanol', 'ingles', 'historia', 'geografia',
  'ciencias', 'naturales', 'artes', 'educacion', 'fisica', 'formacion', 'civica', 'mexico', 'campo', 'campos', 'formativo', 'formativos',
  'proyecto', 'proyectos', 'plan', 'estudio', 'estudios', 'acuerdo', 'reglamento', 'protocolo', 'lineamientos', 'normas', 'primaria',
  'preescolar', 'secundaria', 'grado', 'grupo', 'trimestre', 'bimestre', 'ciclo', 'tecnologia', 'vida', 'saludable', 'lectura', 'escritura',
  'ley', 'general', 'nacional', 'federal', 'estatal', 'municipal', 'ciudad', 'estado', 'estados', 'secretaria', 'subsecretaria', 'direccion',
  'supervision', 'zona', 'sector', 'unidad', 'centro', 'instituto', 'gobierno', 'constitucion', 'articulo', 'diario', 'oficial', 'federacion',
  'politica', 'publica', 'reforma', 'junta', 'comite', 'asociacion', 'padres', 'familia', 'dia', 'semana', 'independencia', 'revolucion',
  'navidad', 'primavera', 'verano', 'otono', 'invierno', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
  'septiembre', 'octubre', 'noviembre', 'diciembre', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo', 'usaer',
  'tdah', 'inclusion', 'convivencia', 'evaluacion', 'diagnostica', 'formativa', 'sumativa', 'rubrica', 'lista', 'cotejo', 'guia',
])

const normalizar = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

// CURP: forma completa de 18 caracteres con el arranque característico
// (4 letras + 6 dígitos) — se protege aunque tenga errores de validación.
const RE_CURP_COMPLETA = /(?<![A-Za-z0-9])[A-Za-z]{4}\d{6}[A-Za-z0-9]{8}(?![A-Za-z0-9])/g
// CURP con espacios o guiones (al menos uno): basta la ESTRUCTURA
// característica — sexo H/M/X en la posición 11 y letras en 12-16 —, aunque
// falle la validación oficial (fecha, entidad, consonantes, dígito): esa
// validación sirve para corregir registros, no para decidir qué proteger.
// Un código escolar con otra forma (p. ej. sin H/M/X en esa posición) no
// coincide.
const RE_CURP_SEPARADA = /(?<![A-Za-z0-9])[A-Za-z]{4}[\s-]?\d{6}[\s-]?[HMXhmx][\s-]?[A-Za-z]{2}[\s-]?[A-Za-z]{3}[\s-]?[A-Za-z0-9][\s-]?\d(?![A-Za-z0-9])/g
const RE_CORREO = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![A-Za-z0-9-])/g
const RE_TELEFONO = /(?<![\w+])(?:\+?52[\s.-]?)?(?:\(\d{2,3}\)|\d{2,3})[\s.-]?\d{3,4}[\s.-]?\d{4}(?![\w])/g
const FECHA = String.raw`(?:\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\s+de\s+[A-Za-záéíóúÁÉÍÓÚ]+(?:\s+de(?:l)?\s+\d{4})?)`
const RE_FECHA_PERSONAL = new RegExp(String.raw`(\b(?:naci[oó]|nacimiento|naci[oó]\s+el|cumplea[ñn]os|cumple)\b[^\n.?!]{0,25}?)(${FECHA})`, 'gi')

function protegerEstructurales(texto: string, resumen: ResumenProteccionEmbedding): string {
  let r = texto.replace(RE_CORREO, () => { resumen.contacto++; return 'un correo' })
  r = r.replace(RE_CURP_COMPLETA, () => { resumen.curp++; return MARCADOR_CURP })
  r = r.replace(RE_CURP_SEPARADA, () => { resumen.curp++; return MARCADOR_CURP })
  r = r.replace(RE_TELEFONO, (m) => {
    const digitos = m.replace(/\D/g, '')
    if (digitos.length !== 10 && !(digitos.length === 12 && digitos.startsWith('52'))) return m
    resumen.contacto++
    return 'un teléfono'
  })
  r = r.replace(RE_FECHA_PERSONAL, (_m, contexto: string) => { resumen.fechas++; return `${contexto}una fecha` })
  return r
}

type Fragmento = { patron: RegExp; palabras: number }

// Nombre completo de cada alumno + todos sus fragmentos contiguos de 2+
// palabras con al menos 2 palabras identificadoras (no partículas) y no
// formados SOLO por palabras comunes. Mismo patrón de coincidencia que
// el Programa Analítico (construirPatronNombreCompleto): insensible a
// mayúsculas/acentos, nunca dentro de otra palabra.
function fragmentosDelRoster(roster: AlumnoRoster[]): Fragmento[] {
  const porClave = new Map<string, Fragmento>()
  for (const alumno of roster) {
    const palabras = (alumno.nombre_completo || '').trim().split(/\s+/).filter(Boolean)
    for (let largo = palabras.length; largo >= 2; largo--) {
      for (let inicio = 0; inicio + largo <= palabras.length; inicio++) {
        const parte = palabras.slice(inicio, inicio + largo)
        const identificadoras = parte.map(normalizar).filter((p) => !PARTICULAS.has(p))
        const completo = largo === palabras.length
        if (!completo && (identificadoras.length < 2 || identificadoras.every((p) => PALABRAS_COMUNES.has(p)))) continue
        const clave = normalizar(parte.join(' '))
        if (porClave.has(clave)) continue
        const patron = construirPatronNombreCompleto(parte.join(' '))
        if (patron) porClave.set(clave, { patron, palabras: largo })
      }
    }
  }
  return [...porClave.values()].sort((a, b) => b.palabras - a.palabras)
}

// ¿La palabra en `indice` empieza una oración? (inicio del texto o tras . ! ? ¿ ¡)
function iniciaOracion(texto: string, indice: number): boolean {
  const previo = texto.slice(0, indice).trimEnd()
  return previo.length === 0 || /[.!?¿¡:\n]$/.test(previo)
}

const esMayusculaInicial = (palabra: string) => palabra[0] !== palabra[0].toLowerCase() && palabra.slice(1) !== palabra.slice(1).toUpperCase()

export function prepararConsultaEmbedding(mensaje: string, roster: readonly AlumnoRoster[] | null | undefined): ConsultaEmbedding {
  const resumen: ResumenProteccionEmbedding = { nombres: 0, curp: 0, contacto: 0, fechas: 0 }
  try {
    let texto = protegerEstructurales(mensaje, resumen)
    const alumnos = (roster ?? []).filter((a) => a && typeof a.nombre_completo === 'string' && a.nombre_completo.trim())

    // 1. Nombres completos y fragmentos específicos (de más largo a más corto).
    for (const fragmento of fragmentosDelRoster(alumnos)) {
      // Un fragmento compartido por varios alumnos (apellidos de hermanos)
      // es ambiguo para IDENTIFICAR a quién se refiere, pero se elimina
      // igual por completo del texto — para embeddings no hace falta
      // saber de quién se trata.
      fragmento.patron.lastIndex = 0
      texto = texto.replace(fragmento.patron, () => { resumen.nombres++; return MARCADOR_ALUMNO })
    }

    // 2. Indicios de identidad que NO se pudieron proteger → no se envía.
    const palabrasRoster = new Set(alumnos.flatMap((a) => a.nombre_completo.trim().split(/\s+/).map(normalizar)).filter((p) => p.length >= 3 && !PARTICULAS.has(p)))
    const sinMarcadores = texto.split(MARCADOR_ALUMNO).join(' ')
    // Posible nombre de persona no protegible (otro grupo, sin grupo
    // activo): dos palabras seguidas con mayúscula que no son términos
    // escolares/institucionales ("Fulano Inventado"), o una palabra con
    // mayúscula a pocas palabras de un indicio individual ("la alumna
    // Valentina", "los alumnos llamados Fulano…").
    const palabras = [...sinMarcadores.matchAll(/\p{L}+/gu)].map((c) => {
      const palabra = c[0]
      const base = normalizar(palabra)
      const mayuscula = esMayusculaInicial(palabra)
      const posibleNombre = mayuscula && base.length >= 2 && !MAYUSCULAS_ESCOLARES.has(base) && !PARTICULAS.has(base)
      return { base, mayuscula, posibleNombre, aMitad: mayuscula && !iniciaOracion(sinMarcadores, c.index ?? 0) }
    })
    for (let i = 0; i < palabras.length; i++) {
      const { base, mayuscula, posibleNombre } = palabras[i]
      // Nombre o apellido suelto de un alumno del grupo activo (si además
      // es palabra común, solo cuando va con mayúscula inicial).
      if (palabrasRoster.has(base) && (!PALABRAS_COMUNES.has(base) || mayuscula)) return { enviar: false, motivo: 'privacidad', resumen }
      const siguiente = palabras[i + 1]
      if (posibleNombre && siguiente?.posibleNombre && siguiente.aMitad) return { enviar: false, motivo: 'privacidad', resumen }
      if (INDICIOS_INDIVIDUALES.has(base) && palabras.slice(i + 1, i + 3).some((p) => p.posibleNombre && p.aMitad)) return { enviar: false, motivo: 'privacidad', resumen }
    }

    return { enviar: true, texto, resumen }
  } catch {
    return { enviar: false, motivo: 'error', resumen }
  }
}
