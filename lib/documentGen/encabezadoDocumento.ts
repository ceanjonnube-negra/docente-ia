// lib/documentGen/encabezadoDocumento.ts
//
// Fuente única de los datos del encabezado y pie institucional —
// escuela, docente, grado, grupo, lugar, fecha, ciclo escolar — para
// CUALQUIER documento oficial (lista, planeación, oficio, reporte,
// ficha...). generarWordServidor.ts y generarPdfServidor.ts llaman
// aquí en vez de armar cada uno su propio texto: son librerías
// distintas (docx vs pdf-lib) que no pueden compartir un componente de
// render literal, pero SÍ comparten esta misma preparación de datos —
// así el encabezado nunca puede divergir entre Word y PDF, ni
// duplicarse (antes también lo escribía Claude en el cuerpo del
// documento — ver regla 9 de MODO DOCUMENTO en app/api/chat/route.ts,
// ahora se lo prohíbe explícitamente).

import { obtenerFechaHora } from '../tiempo/TimeService'

export type EncabezadoDocumento = {
  escuela: string
  docente: string
  // Ya incluyen el símbolo real cuando aplica (el selector de
  // onboarding guarda "3°", no "3" — ver app/onboarding/page.tsx) así
  // que nunca se le debe concatenar un "°" extra al usarlos.
  grado: string
  grupo: string
  lugar: string
  fecha: string
  cicloEscolar: string
}

// Grado y grupo de un grupo académico VALIDADO (grupos.grado/grupos.grupo)
// para el encabezado de un documento de ese grupo. Con varios grupos, el
// perfil no dice a cuál pertenece el documento: si el documento tiene
// grupo, grado y grupo salen SIEMPRE de él (vacíos si el grupo no los
// tiene; nunca del perfil, que podría ser de otro grupo). El resto del
// perfil (escuela, docente, lugar…) se conserva tal cual. grupo = null:
// documento sin grupo académico, el perfil sin cambios.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function perfilConGrupoAcademico(perfil: any, grupo: { grado: string | null; grupo: string | null } | null): any {
  if (!grupo) return perfil
  const grado = (grupo.grado ?? '').trim().replace(/°+$/, '')
  return { ...(perfil ?? {}), grado: grado ? `${grado}°` : '', grupo: (grupo.grupo ?? '').trim() }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function prepararEncabezado(perfil: any, zonaHoraria: string | null | undefined): EncabezadoDocumento {
  const { fechaLegible, cicloEscolar } = obtenerFechaHora(zonaHoraria)
  const lugar = [perfil?.municipio, perfil?.estado].filter(Boolean).join(', ')

  return {
    escuela: perfil?.escuela || 'Escuela',
    docente: perfil?.nombre || 'Docente',
    grado: perfil?.grado || '',
    grupo: perfil?.grupo || '',
    lugar,
    fecha: fechaLegible,
    cicloEscolar,
  }
}

// --- Encabezado institucional duplicado en el cuerpo ---
// Word y PDF ya agregan el encabezado institucional (construirDocumentoWord.ts,
// generarPdfServidor.ts). Si el texto redactado también lo trae, se repite.
// Esta limpieza es CONSERVADORA: solo quita las líneas "Clave: valor" pegadas
// al título (antes o después de él) que repiten exactamente los datos
// confirmados de este encabezado. Nunca quita una línea por contener
// "Escuela", "Fecha" o "Grupo": una fecha de reunión, un destinatario o un
// espacio para completar se conservan siempre. Tampoco toca:
// - las firmas: el generador no sabe si el docente pidió firmar el
//   documento, así que una firma en el texto se conserva siempre (fórmula,
//   nombre y cargo); de ella solo se quitan las líneas que repiten
//   exactamente la escuela, el ciclo o el grupo del encabezado;
// - los documentos pedagógicos (planeación, rúbrica, examen, actividad,
//   lectura…): su grado, grupo y datos curriculares son parte de su
//   contenido, también en las vistas previas de planeación.
// No cambia el texto guardado: se aplica solo al armar el archivo, y es
// idempotente.

const normalizarDato = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\*\*|__|[°º]/g, '').replace(/[.,;]+$/, '').replace(/\s+/g, ' ').trim()

// ¿El par "clave: valor" (ya normalizados) repite exactamente un dato
// confirmado del encabezado? Sin dato confirmado (escuela o docente por
// defecto, grado o grupo vacíos), nunca coincide y la línea se conserva.
function coincideCampo(clave: string, valor: string, enc: EncabezadoDocumento): boolean {
  const e = (s: string) => normalizarDato(s)
  const escuela = enc.escuela && enc.escuela !== 'Escuela' ? e(enc.escuela) : null
  const docente = enc.docente && enc.docente !== 'Docente' ? e(enc.docente) : null
  const grado = e(enc.grado) || null
  const grupo = e(enc.grupo) || null
  const lugares = e(enc.lugar).split(',').map((x) => x.trim()).filter(Boolean)
  switch (clave) {
    case 'escuela': return escuela !== null && valor === escuela
    case 'docente': case 'maestro': case 'maestra': case 'profesor': case 'profesora': return docente !== null && valor === docente
    case 'grado': return grado !== null && valor.replace(/\s*grado$/, '') === grado
    case 'grupo': return grupo !== null && valor === grupo
    case 'grado y grupo': return grado !== null && grupo !== null && valor.replace(/\s+/g, '') === `${grado}${grupo}`.replace(/\s+/g, '')
    case 'ciclo escolar': case 'ciclo': return !!enc.cicloEscolar && valor === e(enc.cicloEscolar)
    case 'fecha': return !!enc.fecha && valor.endsWith(e(enc.fecha))
    case 'lugar': case 'municipio': case 'estado': case 'localidad':
      return lugares.length > 0 && (valor === lugares.join(', ') || lugares.includes(valor))
    default: return false
  }
}

// "Escuela: X | Municipio: Y": TODOS sus pares deben ser campos
// institucionales que coinciden con el encabezado.
function esEncabezadoDuplicado(linea: string, enc: EncabezadoDocumento): boolean {
  const pares = linea.split('|').map((p) => p.trim()).filter(Boolean)
  if (pares.length === 0) return false
  return pares.every((par) => {
    const m = par.match(/^([^:]{2,30}):\s*(.+)$/)
    return !!m && coincideCampo(normalizarDato(m[1]), normalizarDato(m[2]), enc)
  })
}

// Documento pedagógico, reconocido por su título: el prefijo de sus
// plantillas (📋 planeación, 📊 rúbrica, 📝 examen/actividad, 📖 lectura) o
// el tipo con el que EMPIEZA ("EXAMEN DE FRACCIONES"). Una palabra que solo
// es el tema ("AVISO … LECTURA DIARIA") no lo convierte en pedagógico.
const PREFIJO_PEDAGOGICO = /^(📋|📊|📝|📖)/u
const TIPO_PEDAGOGICO = /^(planeacion|rubrica|examen|actividad|evaluacion|lectura|cuento|fabula|guia|ejercicios|practica|secuencia didactica|proyecto|ficha descriptiva)\b/
function esDocumentoPedagogico(titulo: string): boolean {
  const sinSimbolos = normalizarDato(titulo).replace(/^[^a-z0-9]+/, '')
  return PREFIJO_PEDAGOGICO.test(titulo.trim()) || TIPO_PEDAGOGICO.test(sinSimbolos)
}

// Línea suelta que repite un dato confirmado del encabezado: la escuela tal
// cual, o el ciclo escolar sin dos puntos ("Ciclo Escolar 2026-2027").
function esDatoInstitucionalSuelto(linea: string, enc: EncabezadoDocumento): boolean {
  const n = normalizarDato(linea)
  if (enc.escuela && enc.escuela !== 'Escuela' && n === normalizarDato(enc.escuela)) return true
  const ciclo = n.match(/^ciclo(?: escolar)? (.+)$/)
  return !!ciclo && !!enc.cicloEscolar && ciclo[1] === normalizarDato(enc.cicloEscolar)
}
function esLineaInstitucionalRedundante(linea: string, enc: EncabezadoDocumento): boolean {
  return esEncabezadoDuplicado(linea, enc) || esDatoInstitucionalSuelto(linea, enc)
}

export function quitarDuplicadosInstitucionales(texto: string, enc: EncabezadoDocumento): string {
  const lineas = texto.split('\n')
  const quitar = new Set<number>()

  // 1. Líneas duplicadas pegadas al título (antes o después), también la
  // escuela o el ciclo como línea suelta. El título es la primera línea que
  // no es un duplicado; la primera línea distinta después de él detiene la
  // revisión.
  let titulo: string | null = null
  for (let i = 0; i < lineas.length; i++) {
    const l = lineas[i].trim()
    if (!l) continue
    if (esLineaInstitucionalRedundante(l, enc)) { quitar.add(i); continue }
    if (titulo !== null) break
    titulo = l
  }

  // 2. Firma con la que termina el documento (fórmula de cierre y lo que la
  // sigue): se conservan la fórmula, el nombre y el cargo; solo se quitan
  // las líneas que repiten exactamente un dato del encabezado (la escuela,
  // el ciclo, "Grado y Grupo"). Si no queda firmante, la firma automática
  // completa el cierre (ver agregarFirmaAutomatica).
  const finales: number[] = []
  for (let j = lineas.length - 1; j >= 0 && finales.length < LINEAS_FINALES; j--) {
    if (lineas[j].trim()) finales.unshift(j)
  }
  const cierre = finales.findIndex((n) => CIERRE_FIRMA.test(normalizarDato(lineas[n]).replace(/[:!]+$/, '')))
  if (cierre !== -1) {
    for (const n of finales.slice(cierre + 1)) {
      if (esLineaInstitucionalRedundante(lineas[n].trim(), enc)) quitar.add(n)
    }
  }

  if (quitar.size === 0 || titulo === null || esDocumentoPedagogico(titulo)) return texto
  const resultado = lineas.filter((_, n) => !quitar.has(n)).join('\n').replace(/\n{3,}/g, '\n\n').trim()
  // Nunca dejar un documento sin contenido propio.
  return resultado.split('\n').filter((l) => l.trim()).length >= 2 ? resultado : texto
}

// --- Firma automática ---
// Word y PDF terminan con la firma del docente. Se agrega solo si el texto no
// termina ya con una firma propia, que se conserva íntegra (nunca se quita
// ni se reescribe una firma: pudo pedirla el docente). Firma propia, en las
// últimas líneas del documento:
// - una fórmula de cierre ("Atentamente", "Cordialmente"…) seguida de al
//   menos una línea —quien firma, su cargo, su escuela—, o
// - el nombre confirmado del docente en una línea propia.
// Un "Atentamente," sin nada después no es una firma: la automática lo
// completa. Un espacio para que firme otra persona ("____ Firma del padre o
// tutor") tampoco. Los documentos pedagógicos (y sus vistas previas)
// conservan siempre su firma automática.
const CIERRE_FIRMA = /^(atentamente|atte|cordialmente|saludos cordiales|respetuosamente|sinceramente|reciba un cordial saludo)$/
const TRATAMIENTO = /^(profr?a?|prof|mtr[oa]|lic|lcda?)\.?\s+/
const LINEAS_FINALES = 6

export function tieneFirmaPropia(texto: string, enc: EncabezadoDocumento): boolean {
  const finales = texto.split('\n').map((l) => l.trim()).filter(Boolean).slice(-LINEAS_FINALES)
  const cierre = finales.findIndex((l) => CIERRE_FIRMA.test(normalizarDato(l).replace(/[:!]+$/, '')))
  if (cierre !== -1 && cierre < finales.length - 1) return true
  const docente = enc.docente && enc.docente !== 'Docente' ? normalizarDato(enc.docente) : null
  return docente !== null && finales.slice(-3).some((l) => normalizarDato(l).replace(TRATAMIENTO, '') === docente)
}

export function agregarFirmaAutomatica(texto: string, enc: EncabezadoDocumento): boolean {
  const titulo = texto.split('\n').map((l) => l.trim()).find((l) => l && !esEncabezadoDuplicado(l, enc))
  if (titulo && esDocumentoPedagogico(titulo)) return true
  return !tieneFirmaPropia(texto, enc)
}
