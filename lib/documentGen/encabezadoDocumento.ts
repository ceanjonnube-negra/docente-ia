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
//   documento, así que una firma en el texto se conserva siempre;
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

export function quitarDuplicadosInstitucionales(texto: string, enc: EncabezadoDocumento): string {
  const lineas = texto.split('\n')
  const quitar = new Set<number>()

  // Líneas duplicadas pegadas al título (antes o después). El título es la
  // primera línea que no es un duplicado.
  let titulo: string | null = null
  for (let i = 0; i < lineas.length; i++) {
    const l = lineas[i].trim()
    if (!l) continue
    if (esEncabezadoDuplicado(l, enc)) { quitar.add(i); continue }
    if (titulo !== null) break
    titulo = l
  }

  if (quitar.size === 0 || titulo === null || esDocumentoPedagogico(titulo)) return texto
  const resultado = lineas.filter((_, n) => !quitar.has(n)).join('\n').replace(/\n{3,}/g, '\n\n').trim()
  // Nunca dejar un documento sin contenido propio.
  return resultado.split('\n').filter((l) => l.trim()).length >= 2 ? resultado : texto
}
