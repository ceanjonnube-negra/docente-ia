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
  | { enviar: false; motivo: 'privacidad' | 'error' | 'social'; resumen: ResumenProteccionEmbedding }

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

// DOCUMENTOS SUBIDOS (app/api/upload-documento) — copia protegida del
// texto extraído para el índice semántico (embeddings, chunk_texto,
// contenido_texto). A diferencia de una consulta, un documento no puede
// "omitirse" palabra por palabra: se protege TODO lo detectable de forma
// determinista con datos del propio docente:
// - las protecciones estructurales de arriba (CURP, correo, teléfono,
//   fecha personal);
// - nombres completos y fragmentos de 2+ palabras de SUS alumnos → "un alumno";
// - nombres/apellidos sueltos de sus alumnos (no partículas; si también
//   son palabra común, solo con mayúscula inicial, o escritos TODO en
//   mayúsculas junto a otra palabra del nombre ya protegida) → "un alumno".
// Además cuenta los alumnos IDENTIFICADOS (ver contarAlumnosIdentificados):
// quien llama decide con ese dato si el documento es un registro personal
// que no debe indexarse. Nunca agrega ni quita otro contenido. Lanza si
// algo falla: quien llama NO debe indexar el documento (falla segura).
export function protegerTextoDocumento(texto: string, nombresAlumnos: readonly string[]): { texto: string; resumen: ResumenProteccionEmbedding; alumnosIdentificados: number } {
  const resumen: ResumenProteccionEmbedding = { nombres: 0, curp: 0, contacto: 0, fechas: 0 }
  let r = protegerEstructurales(texto, resumen)
  const roster = nombresAlumnos.filter((n) => typeof n === 'string' && n.trim()).map((n, i) => ({ alumno_id: String(i), nombre_completo: n }))
  const alumnosIdentificados = contarAlumnosIdentificados(r, roster)
  for (const fragmento of fragmentosDelRoster(roster)) {
    fragmento.patron.lastIndex = 0
    r = r.replace(fragmento.patron, () => { resumen.nombres++; return MARCADOR_ALUMNO })
  }
  const palabrasRoster = new Set(roster.flatMap((a) => a.nombre_completo.trim().split(/\s+/).map(normalizar)).filter((p) => p.length >= 3 && !PARTICULAS.has(p)))
  if (palabrasRoster.size > 0) r = protegerPalabrasSueltas(r, palabrasRoster, roster, resumen)
  return { texto: r, resumen, alumnosIdentificados }
}

// Palabra escrita TODA en mayúsculas («ROSA»; no «Rosa» ni una sola letra).
const esTodoMayusculas = (palabra: string) => palabra.length > 1 && palabra === palabra.toUpperCase() && palabra !== palabra.toLowerCase()
const SOLO_ESPACIOS_EN_LINEA = /^[ \t,]*$/

// Nombres/apellidos sueltos del roster → "un alumno". Una palabra que
// también es común («Rosa», «Paz», «Campos») cuenta solo con mayúscula
// inicial; escrita TODO en mayúsculas («ROSA», «CAMPOS FORMATIVOS») solo si
// en la MISMA línea tiene al lado otra palabra del nombre que sí se protege,
// un "un alumno" ya sustituido u otra palabra en mayúsculas del nombre del
// MISMO alumno — así «ROSA un alumno» y «ROSA CAMPOS» (de «Rosa Campos …»)
// se protegen, y «CAMPOS FORMATIVOS», «LA PAZ» o «LUZ Y SONIDO» se conservan.
function protegerPalabrasSueltas(texto: string, palabrasRoster: Set<string>, roster: AlumnoRoster[], resumen: ResumenProteccionEmbedding): string {
  const tokens = [...texto.matchAll(/\p{L}+/gu)].map((m) => ({ palabra: m[0], inicio: m.index!, fin: m.index! + m[0].length }))
  const proteger = tokens.map(({ palabra }) => {
    const base = normalizar(palabra)
    if (!palabrasRoster.has(base)) return false
    return !PALABRAS_COMUNES.has(base) || esMayusculaInicial(palabra)
  })
  const juntos = (i: number, j: number) => SOLO_ESPACIOS_EN_LINEA.test(texto.slice(tokens[i].fin, tokens[j].inicio))
  const esMarcador = (i: number, j: number) => normalizar(tokens[i].palabra) === 'un' && normalizar(tokens[j].palabra) === 'alumno' && juntos(i, j)
  const nombres = roster.map((a) => new Set(a.nombre_completo.trim().split(/\s+/).map(normalizar)))
  const mismoAlumno = (i: number, j: number) => esTodoMayusculas(tokens[j].palabra) &&
    nombres.some((n) => n.has(normalizar(tokens[i].palabra)) && n.has(normalizar(tokens[j].palabra)) && normalizar(tokens[i].palabra) !== normalizar(tokens[j].palabra))
  const vecinoProtegido = (i: number) =>
    (i > 0 && juntos(i - 1, i) && (proteger[i - 1] || mismoAlumno(i, i - 1) || (i > 1 && esMarcador(i - 2, i - 1)))) ||
    (i + 1 < tokens.length && juntos(i, i + 1) && (proteger[i + 1] || mismoAlumno(i, i + 1) || (i + 2 < tokens.length && esMarcador(i + 1, i + 2))))
  const pendientes = tokens.map(({ palabra }, i) => !proteger[i] && esTodoMayusculas(palabra) && palabrasRoster.has(normalizar(palabra)) && vecinoProtegido(i))
  pendientes.forEach((p, i) => { if (p) proteger[i] = true })
  let salida = ''
  let desde = 0
  tokens.forEach(({ inicio, fin }, i) => {
    if (!proteger[i]) return
    salida += texto.slice(desde, inicio) + MARCADOR_ALUMNO
    desde = fin
    resumen.nombres++
  })
  return salida + texto.slice(desde)
}

// Alumnos del roster IDENTIFICADOS en el texto: una secuencia continua de
// palabras de SU nombre (en cualquier orden — listas oficiales con
// apellidos primero o en columnas separadas —, unidas solo por espacios,
// saltos, comas o partículas) que cubre su nombre completo o al menos 3 de
// sus palabras (nombre y dos apellidos). Un fragmento de 2 palabras
// («Benito Juárez», «Ana Sofía») se enmascara, pero NO basta para tratar el
// documento como un registro del alumno. Solo palabras comunes en
// minúsculas («la rosa, paz y luna») no identifican.
function contarAlumnosIdentificados(texto: string, roster: AlumnoRoster[]): number {
  const alumnos = roster
    .map((a) => new Set(a.nombre_completo.trim().split(/\s+/).map(normalizar).filter((p) => p && !PARTICULAS.has(p))))
    .filter((palabras) => palabras.size >= 2)
  if (alumnos.length === 0) return 0
  const todas = new Set(alumnos.flatMap((palabras) => [...palabras]))
  const identificados = new Set<number>()
  let secuencia: { base: string; palabra: string }[] = []
  let finAnterior = 0
  const cerrar = () => {
    if (secuencia.length >= 2) {
      alumnos.forEach((palabras, i) => {
        const propias = secuencia.filter((t) => palabras.has(t.base))
        if (new Set(propias.map((t) => t.base)).size < Math.min(3, palabras.size)) return
        if (propias.every((t) => PALABRAS_COMUNES.has(t.base) && !esMayusculaInicial(t.palabra) && !esTodoMayusculas(t.palabra))) return
        identificados.add(i)
      })
    }
    secuencia = []
  }
  for (const m of texto.matchAll(/\p{L}+/gu)) {
    const palabra = m[0]
    const base = normalizar(palabra)
    if (secuencia.length > 0 && !/^[\s,]*$/.test(texto.slice(finAnterior, m.index!))) cerrar()
    finAnterior = m.index! + palabra.length
    if (todas.has(base)) secuencia.push({ base, palabra })
    else if (!(secuencia.length > 0 && PARTICULAS.has(base))) cerrar()
  }
  cerrar()
  return identificados.size
}

// Palabras que nunca forman parte de un nombre de persona en un campo o una
// fila (etiquetas de formulario, artículos y arranques de oración).
const NO_NOMBRE = new Set([
  'nombre', 'nombres', 'apellido', 'apellidos', 'paterno', 'materno', 'fecha', 'nacimiento', 'lugar', 'edad', 'sexo', 'curp', 'domicilio',
  'telefono', 'correo', 'firma', 'folio', 'matricula', 'clave', 'turno', 'calificacion', 'calificaciones', 'promedio', 'observaciones',
  'asistencia', 'total', 'el', 'los', 'un', 'una', 'unos', 'unas', 'lo', 'al', 'se', 'es', 'son', 'su', 'sus', 'este', 'esta', 'estos',
  'estas', 'ese', 'esa', 'que', 'quien', 'cada', 'todo', 'toda', 'todos', 'todas', 'ningun', 'ninguna', 'no', 'si', 'para', 'por', 'con',
  'sin', 'en', 'debe', 'debera', 'deberan', 'podra', 'podran', 'sera', 'seran', 'tiene', 'tendra', 'persona', 'personas',
])
const PALABRA_DE_NOMBRE = /^\p{Lu}[\p{L}'’]+$/u

// ¿Empieza `partes` con un nombre de persona? Devuelve cuántas partes lo
// forman (0 si no): palabras con mayúscula inicial o TODO en mayúsculas,
// con partículas intermedias, ninguna etiqueta ni término escolar.
function longitudNombrePersona(partes: string[], minimo: number): number {
  let palabras = 0
  let k = 0
  for (; k < partes.length; k++) {
    const t = partes[k].replace(/[,.;:]+$/, '')
    const base = normalizar(t)
    if (palabras > 0 && PARTICULAS.has(base)) continue
    if (!PALABRA_DE_NOMBRE.test(t)) break
    if (NO_NOMBRE.has(base) || MAYUSCULAS_ESCOLARES.has(base) || INDICIOS_INDIVIDUALES.has(base)) return 0
    palabras++
    if (/,$/.test(partes[k]) && palabras >= minimo) { k++; break }
  }
  return palabras >= minimo && palabras <= 6 ? k : 0
}

// Etiqueta de un campo de persona AL INICIO de una línea o celda. Las
// etiquetas «Nombre del alumno…» admiten el valor en la línea siguiente
// (tablas de Word extraídas celda por celda); las cortas («Alumno(a):»,
// «Tutor:», «Nombre:») exigen dos puntos, tabulador o «|».
const ETIQUETA_LARGA = String.raw`(?:nombre(?:\s+completo)?\s+del?\s+(?:la\s+)?(?:alumn[oa](?:\s*\(a\))?|estudiante|educand[oa]|ni[ñn][oa]|menor|padre|madre|tutor(?:a|\s*\(a\))?)|apellidos?\s+y\s+nombres?(?:\s*\(s\))?)`
const ETIQUETA_CORTA = String.raw`(?:nombre(?:s|\s*\(s\))?(?:\s+completo)?|alumn[oa](?:\s*\(a\))?|estudiante|educand[oa]|padre\s+o\s+tutor(?:\s*\(a\))?|madre\s+o\s+tutor(?:a)?|padre\s*\/\s*madre(?:\s+o\s+tutor(?:\s*\(a\))?)?|tutor(?:a|\s*\(a\))?)`
const RE_CAMPO_PERSONA = new RegExp(String.raw`(?:^|[\n\t|])[ \t]*(?:${ETIQUETA_LARGA}[ \t]*(?::[ \t]*\n*|\t|\|[ \t]*|\n+)|${ETIQUETA_CORTA}[ \t]*(?::[ \t]*\n*|\t|\|))[ \t]*([^\n]*)`, 'giu')
const RE_CALIFICACION = /^(?:10|[0-9])(?:[.,]\d{1,2})?$/
const RE_FECHA_COMPLETA = new RegExp(String.raw`^(?:\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{4}-\d{1,2}-\d{1,2})$`)

// Señales DETERMINISTAS de un registro personal aunque los nombres NO
// estén en el roster (boletas, expedientes, fichas, reportes de
// incidencias, listas nominales de otro grupo o de exalumnos). Exigen un
// VALOR con forma de nombre de persona — nunca basta un término: un
// reglamento que habla de «alumno», «evaluación», «diagnóstico»,
// «inclusión» o «calificación» no las activa:
// - campos: etiqueta de persona al inicio de línea/celda («Alumno(a):»,
//   «Nombre del alumno», «Padre o tutor:», …) seguida de un nombre de 2+
//   palabras con mayúscula;
// - filas: un nombre de 3+ palabras seguido (en la línea o en las 2
//   celdas siguientes) de una fecha completa, una calificación con decimal
//   o 2+ calificaciones. Se exigen 2+ filas: una firma o un encabezado
//   aislado con un número no forman una lista nominal (un índice tiene un
//   solo número entero por línea y no cuenta).
export function detectarDatosPersonalesSinRoster(texto: string): { campos: number; filas: number } {
  let campos = 0
  RE_CAMPO_PERSONA.lastIndex = 0
  for (const m of texto.matchAll(RE_CAMPO_PERSONA)) {
    if (longitudNombrePersona(m[1].trim().split(/[ \t]+/), 2) > 0) campos++
  }
  const lineas = texto.split('\n').map((l) => l.trim()).filter(Boolean)
  let filas = 0
  lineas.forEach((linea, i) => {
    const partes = linea.replace(/^\d{1,3}[.)-]?\s+/, '').split(/[ \t|;]+/).filter(Boolean)
    const largo = longitudNombrePersona(partes, 3)
    if (largo === 0) return
    let valores = partes.slice(largo).map((p) => p.replace(/^[-–—:,]+|[,;]+$/g, '')).filter(Boolean)
    if (valores.length === 0) valores = lineas.slice(i + 1, i + 3)
    const calificaciones = valores.filter((v) => RE_CALIFICACION.test(v))
    if (valores.some((v) => RE_FECHA_COMPLETA.test(v)) || calificaciones.length >= 2 || calificaciones.some((v) => /[.,]/.test(v))) filas++
  })
  return { campos, filas: filas >= 2 ? filas : 0 }
}

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
