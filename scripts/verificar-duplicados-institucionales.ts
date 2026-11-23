// scripts/verificar-duplicados-institucionales.ts
//
// Word y PDF ya agregan el encabezado institucional: quitarDuplicadosInstitucionales
// quita del texto SOLO sus duplicados inequívocos (los mismos datos
// confirmados, pegados al título), conserva todo lo demás —las firmas
// siempre, porque el generador no sabe si se pidieron, y los documentos
// pedagógicos completos— y no cambia el texto guardado. Las plantillas del
// prompt ya no piden encabezado ni firma.
//
// Sin red, sin credenciales, sin IA. Se ejecuta con
// `npx tsx scripts/verificar-duplicados-institucionales.ts`.

import { readFileSync } from 'node:fs'
import JSZip from 'jszip'
import { prepararEncabezado, quitarDuplicadosInstitucionales, type EncabezadoDocumento } from '../lib/documentGen/encabezadoDocumento'
import { generarWordBuffer } from '../lib/documentGen/generarWordServidor'
import { generarPdfBuffer } from '../lib/documentGen/generarPdfServidor'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  console.log(`${condicion ? '✓' : '✗'} ${mensaje}`)
  if (!condicion) fallos++
}

const perfil = { escuela: 'Escuela Primaria Ficticia E2E', nombre: 'Docente Prueba E2E', grado: '3°', grupo: 'A', municipio: 'Mazatlán', estado: 'Sinaloa' }
const enc: EncabezadoDocumento = prepararEncabezado(perfil, 'America/Mazatlan')
const limpiar = (t: string) => quitarDuplicadosInstitucionales(t, enc)

// Caso real de E2E: encabezado y firma escritos por el modelo.
const AVISO_DUPLICADO = `📢 AVISO PARA FAMILIAS — LECTURA DIARIA EN CASA
Escuela: Escuela Primaria Ficticia E2E
Ciclo Escolar: ${enc.cicloEscolar}

Estimadas familias:
Les invitamos a leer con sus hijos al menos 20 minutos cada día.

Atentamente,
Docente Prueba E2E
Docente de 3° grado grupo A`
const AVISO_LIMPIO = `📢 AVISO PARA FAMILIAS — LECTURA DIARIA EN CASA

Estimadas familias:
Les invitamos a leer con sus hijos al menos 20 minutos cada día.`
const FIRMA = `\n\nAtentamente,\nDocente Prueba E2E\nDocente de 3° grado grupo A`

const casos: Record<string, string> = {}

// 1. Aviso con encabezado y firma duplicados.
casos.aviso = AVISO_DUPLICADO
const aviso = limpiar(AVISO_DUPLICADO)
verificar(aviso === AVISO_LIMPIO + FIRMA, '1a. Aviso: se quita el encabezado duplicado; título, cuerpo y firma intactos')
const conTitulosAntes = `Escuela: Escuela Primaria Ficticia E2E | Municipio: Mazatlán\nDocente: Docente Prueba E2E\n${AVISO_LIMPIO}`
verificar(limpiar(conTitulosAntes) === AVISO_LIMPIO, '1b. Encabezado escrito ANTES del título → también se quita')
const separado = `📋 PLANEACIÓN DIDÁCTICA\nGrado: 3°\nGrupo: A\nFase: 3\nCampo Formativo: Lenguajes\n\nPropósito: leer en voz alta.`
verificar(limpiar(separado) === separado, '1c. Planeación con Grado y Grupo en líneas propias → documento pedagógico: se conserva completo')
casos.separado = separado

// 2. Aviso sin duplicados.
casos.sinDuplicados = AVISO_LIMPIO
verificar(limpiar(AVISO_LIMPIO) === AVISO_LIMPIO, '2. Aviso sin duplicados → sin ningún cambio')

// 3. Citatorio con fecha de reunión.
const CITATORIO = `📨 CITATORIO
Fecha: ${enc.fecha}

Estimado padre/madre de familia de: _______________
Grado y Grupo: 3° A

Por medio del presente se le cita a una reunión el día 25 de noviembre de 2026 a las 8:00 horas en Escuela Primaria Ficticia E2E.
Fecha de la reunión: 25 de noviembre de 2026
Fecha: 25 de noviembre de 2026`
casos.citatorio = CITATORIO
const citatorio = limpiar(CITATORIO)
verificar(!citatorio.includes(`Fecha: ${enc.fecha}`) || enc.fecha === '25 de noviembre de 2026', '3a. Citatorio: se quita solo la fecha de HOY pegada al título (duplicado del encabezado)')
verificar(['Estimado padre/madre de familia de: _______________', 'Grado y Grupo: 3° A', 'el día 25 de noviembre de 2026 a las 8:00 horas en Escuela Primaria Ficticia E2E', 'Fecha de la reunión: 25 de noviembre de 2026', 'Fecha: 25 de noviembre de 2026'].every((x) => citatorio.includes(x)),
  '3b. Se conservan destinatario, espacio para completar, grado del alumno, la fecha y el lugar de la reunión')
const citatorioOtraFecha = `📨 CITATORIO\nFecha: 25 de diciembre de 2026\n\nEstimado padre/madre de familia de: ____`
verificar(limpiar(citatorioOtraFecha) === citatorioOtraFecha, '3c. Una fecha pegada al título que NO es la de hoy (p. ej. de la reunión) se conserva')

// 4. Oficio con destinatario y firma solicitada.
const OFICIO = `📄 OFICIO
Asunto: Solicitud de material didáctico

C. María López Ramírez
Directora de la Escuela Primaria Ficticia E2E
Presente

Por medio del presente solicito el material para el grupo de 3° A.

Atentamente,
María López Ramírez
Directora`
casos.oficio = OFICIO
verificar(limpiar(OFICIO) === OFICIO, '4a. Oficio con destinatario y firma de otra persona (solicitada) → sin ningún cambio')
const firmaConCargoDistinto = `📄 CONSTANCIA\n\nSe hace constar la participación del grupo.\n\nAtentamente,\nDocente Prueba E2E\nCoordinador del Consejo Técnico`
verificar(limpiar(firmaConCargoDistinto) === firmaConCargoDistinto, '4b. Firma del docente con un cargo distinto al de grupo → se conserva completa')
const soloAtentamente = `📨 AVISO\n\nReunión el viernes.\n\nAtentamente,\nLa dirección`
verificar(limpiar(soloAtentamente) === soloAtentamente, '4c. "Atentamente" sin el nombre del docente → se conserva')

// 5. Datos pedagógicos y valores que no coinciden.
const PLANEACION = `📋 PLANEACIÓN DIDÁCTICA
Grado: 3° | Grupo: A | Fase: 3
Campo Formativo: Lenguajes
---
DÍA 1 — Leemos juntos`
casos.planeacion = PLANEACION
verificar(limpiar(PLANEACION) === PLANEACION, '5a. "Grado | Grupo | Fase" en una línea: tiene un dato pedagógico → la línea se conserva completa')
const otraEscuela = `📢 AVISO\nEscuela: Escuela Secundaria Técnica 5\nDocente: Otra Persona\n\nTexto del aviso.`
verificar(limpiar(otraEscuela) === otraEscuela, '5b. Datos que no coinciden con el encabezado confirmado → se conservan')
const encSinDatos = prepararEncabezado({}, 'America/Mazatlan')
const conDefaults = `📢 AVISO\nEscuela: Escuela\nDocente: Docente\nGrado: 3°\n\nTexto.\n\nAtentamente,\nDocente`
verificar(quitarDuplicadosInstitucionales(conDefaults, encSinDatos) === conDefaults, '5c. Sin datos confirmados en el perfil (valores por defecto) → nada se quita')
const enCuerpo = `📢 AVISO\n\nLes recordamos:\nEscuela: Escuela Primaria Ficticia E2E\nDocente: Docente Prueba E2E`
verificar(limpiar(enCuerpo) === enCuerpo, '5d. Los mismos datos dentro del cuerpo (no pegados al título ni como firma final) → se conservan')

// F. Firmas: el generador no sabe si se pidieron → se conservan siempre.
const avisoConFirma = AVISO_LIMPIO + FIRMA
casos.avisoConFirma = avisoConFirma
verificar(limpiar(avisoConFirma) === avisoConFirma, 'F1. Firma del propio docente (automática o pedida) → se conserva')
const firmaPedida = `📢 CONSTANCIA DE PARTICIPACIÓN\nEscuela: Escuela Primaria Ficticia E2E\n\nSe hace constar la participación del grupo.\n\n_______________\nProfra. Docente Prueba E2E\nDocente de grupo`
verificar(limpiar(firmaPedida) === firmaPedida.replace('Escuela: Escuela Primaria Ficticia E2E\n', '').replace(/\n{3,}/g, '\n\n'),
  'F2. Firma con línea para firmar y tratamiento → se conserva; solo se quita el encabezado duplicado')

// P. Documentos pedagógicos: se conservan completos (también vistas previas de planeación).
const pedagogicos: Record<string, string> = {
  rubrica: `📊 RÚBRICA DE EVALUACIÓN\nGrado: 3°\nGrupo: A\nFase: 3\n---\nCRITERIO 1: Comprensión`,
  examen: `📝 EXAMEN / ACTIVIDAD\nEscuela: Escuela Primaria Ficticia E2E\nGrado y Grupo: 3° A\n---\n1. ¿Cuánto es 3/4 + 1/4?`,
  examenSinEmoji: `EXAMEN DE FRACCIONES\nGrado: 3°\nGrupo: A\n\n1. Suma 1/2 + 1/2.`,
  actividad: `Actividad de lectura en voz alta\nGrado: 3° | Grupo: A\n\nLean el texto por equipos.`,
  lectura: `📖 EL ZORRO Y LAS UVAS\nGrado: 3°\nGrupo: A\n\nHabía una vez un zorro…`,
  vistaPreviaPlaneacion: `📋 PLANEACIÓN DIDÁCTICA\nGrado: 3°\nGrupo: A\nFase: 3\nCampo Formativo: Lenguajes\n---\nDÍA 1 — Leemos juntos\n\nVISTA PREVIA — BORRADOR`,
}
verificar(limpiar(`📢 AVISO SOBRE EL EXAMEN DEL VIERNES\nEscuela: Escuela Primaria Ficticia E2E\n\nEstimadas familias: el examen será el viernes.`) === `📢 AVISO SOBRE EL EXAMEN DEL VIERNES\n\nEstimadas familias: el examen será el viernes.`,
  'P0. Un aviso cuyo TEMA es pedagógico (examen, lectura) no es un documento pedagógico: se limpia su encabezado duplicado')
for (const [nombre, t] of Object.entries(pedagogicos)) {
  casos[nombre] = t
  verificar(limpiar(t) === t, `P. Documento pedagógico (${nombre}) → grado, grupo y datos curriculares se conservan completos`)
}

// 6. Idempotencia.
for (const [nombre, t] of Object.entries(casos)) {
  const una = limpiar(t)
  verificar(limpiar(una) === una, `6. Idempotente: ${nombre}`)
}

async function generar() {
  // 7. Conversión Word → PDF: los dos formatos limpian igual, desde el mismo texto.
  const word = await generarWordBuffer(AVISO_DUPLICADO, perfil, 'America/Mazatlan')
  const zip = await JSZip.loadAsync(word)
  const cuerpo = await zip.file('word/document.xml')!.async('string')
  const encabezadoXml = (await Promise.all(Object.keys(zip.files).filter((f) => /^word\/header\d*\.xml$/.test(f)).map((f) => zip.file(f)!.async('string')))).join('')
  const ocurrencias = (xml: string, s: string) => xml.split(s).length - 1
  verificar(encabezadoXml.includes('Escuela Primaria Ficticia E2E') && ocurrencias(cuerpo, 'Escuela Primaria Ficticia E2E') === 0,
    '7a. Word real: la escuela aparece en el encabezado automático y ya no en el cuerpo')
  verificar(cuerpo.includes('Docente de 3° grado grupo A') && cuerpo.includes('Estimadas familias:'),
    '7b. Word real: la firma del texto se conserva (no se sabe si se pidió) y el cuerpo queda intacto')
  const pdf = await generarPdfBuffer(AVISO_DUPLICADO, perfil, 'America/Mazatlan')
  verificar(pdf.length > 1000 && pdf.subarray(0, 5).toString() === '%PDF-', '7c. PDF real generado desde el mismo texto')
  const wordSrc = readFileSync('lib/documentGen/generarWordServidor.ts', 'utf8')
  const pdfSrc = readFileSync('lib/documentGen/generarPdfServidor.ts', 'utf8')
  verificar(wordSrc.includes('quitarDuplicadosInstitucionales(texto, prepararEncabezado(perfil, zonaHoraria))') && pdfSrc.includes('texto = quitarDuplicadosInstitucionales(texto, enc)'),
    '7d. Word y PDF aplican la misma limpieza con el mismo encabezado (también en la conversión Word → PDF)')

  // 8. Alcance: el texto guardado no cambia; PowerPoint y Excel sin cambios.
  const usos = ['app/api/chat/route.ts', 'lib/documentGen/herramientas.ts', 'lib/asistente/documentos.ts', 'lib/asistente/motores/motorTextoClaude.ts', 'lib/documentGen/generarPptxServidor.ts', 'lib/documentGen/generarXlsxServidor.ts']
    .filter((f) => readFileSync(f, 'utf8').includes('quitarDuplicadosInstitucionales'))
  verificar(usos.length === 0, '8a. Ni la ruta, ni el historial, ni PowerPoint/Excel usan la limpieza: el contenido guardado es el original')
  const ruta = readFileSync('app/api/chat/route.ts', 'utf8')
  verificar(!/Grado: \[grado\]|Escuela: \[escuela\]|Ciclo Escolar: \$\{cicloEscolar\}|\[nombre del maestro\]|Docente de \[grado\] grado grupo \[grupo\]/.test(ruta),
    '8b. Las plantillas del prompt ya no piden encabezado institucional ni firma')
  verificar((ruta.match(/^Fase: \[fase según el grado, ver MARCO CURRICULAR VIGENTE\]$/gm) || []).length === 3 && ruta.includes('Estimado padre/madre de familia de: _______________') && ruta.includes('Grado y Grupo: [grado] [grupo]'),
    '8c. Se conservan Fase (planeación, rúbrica, examen) y los campos del citatorio para el destinatario')

  console.log(fallos === 0 ? '\nTODO OK' : `\n${fallos} verificación(es) fallaron`)
  process.exit(fallos === 0 ? 0 : 1)
}

generar()
