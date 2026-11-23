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
import { agregarFirmaAutomatica, prepararEncabezado, quitarDuplicadosInstitucionales, tieneFirmaPropia, type EncabezadoDocumento } from '../lib/documentGen/encabezadoDocumento'
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

  // S. Firma automática: solo si el texto no termina con una firma propia (Word y PDF).
  const CUERPO = '📢 AVISO PARA FAMILIAS — LECTURA DIARIA EN CASA\n\nEstimadas familias:\nLes invitamos a leer cada día.'
  const casoReal = `${CUERPO}\n\nAtentamente,\nDocente de 3.º A\nEscuela Primaria Ficticia E2E\nCiclo Escolar ${enc.cicloEscolar}`
  const firmaS: [string, string, boolean][] = [
    ['S1. Caso real de Preview: cierre con cargo, escuela y ciclo (sin el nombre del docente)', casoReal, false],
    ['S2. Sin firma propia', CUERPO, true],
    ['S3. «Atentamente,» como última línea, sin firmante → la automática lo completa', `${CUERPO}\n\nAtentamente,`, true],
    ['S4. Firma solicitada de otra persona (Directora)', `${CUERPO}\n\nAtentamente,\nMaría López Ramírez\nDirectora`, false],
    ['S5. Nombre del docente como línea propia, sin fórmula de cierre', `${CUERPO}\n\nProfra. Docente Prueba E2E\nDocente de 3° grado grupo A`, false],
    ['S6. Espacio para que firme otra persona (padre o tutor)', `${CUERPO}\n\n_______________\nFirma del padre, madre o tutor`, true],
    ['S7. Cierre con «Cordialmente» y firmante', `${CUERPO}\n\nCordialmente:\nLa Dirección Escolar`, false],
    ['S8. «Atentamente» dentro del cuerpo, lejos del final', `📢 AVISO\n\nAtentamente les pedimos puntualidad.\n\nLínea 1\nLínea 2\nLínea 3\nLínea 4\nLínea 5\nLínea 6\nLínea 7`, true],
  ]
  for (const [nombre, texto, agrega] of firmaS) {
    verificar(agregarFirmaAutomatica(texto, enc) === agrega, `${nombre} → firma automática: ${agrega ? 'sí' : 'no'}`)
  }
  verificar(agregarFirmaAutomatica(`📋 PLANEACIÓN DIDÁCTICA\nFase: 3\n\nCierre.\n\nAtentamente,\nLa maestra`, enc) && agregarFirmaAutomatica(pedagogicos.vistaPreviaPlaneacion, enc),
    'S9. Documentos pedagógicos y vistas previas de planeación: conservan siempre su firma automática')
  verificar(!tieneFirmaPropia(CUERPO, prepararEncabezado({}, 'America/Mazatlan')), 'S10. Sin datos del docente, el nombre por defecto «Docente» nunca cuenta como firma')

  const zipReal = await JSZip.loadAsync(await generarWordBuffer(casoReal, perfil, 'America/Mazatlan'))
  const cuerpoReal = await zipReal.file('word/document.xml')!.async('string')
  verificar(cuerpoReal.includes('Atentamente,') && cuerpoReal.includes('Docente de 3.º A') && !cuerpoReal.includes(`Ciclo Escolar ${enc.cicloEscolar}`) && !cuerpoReal.includes('Docente de grupo'),
    'S11. Word real (caso de Preview): se conservan la fórmula y el cargo de la firma del texto, sin su escuela ni su ciclo repetidos, y NO se agrega la automática')
  const zipSin = await JSZip.loadAsync(await generarWordBuffer(CUERPO, perfil, 'America/Mazatlan'))
  const cuerpoSin = await zipSin.file('word/document.xml')!.async('string')
  verificar(cuerpoSin.includes('Docente de grupo') && cuerpoSin.includes('Docente Prueba E2E'), 'S12. Word real sin firma propia: se agrega la firma automática como siempre')
  const pdfConFirma = await generarPdfBuffer(casoReal, perfil, 'America/Mazatlan')
  verificar(pdfConFirma.subarray(0, 5).toString() === '%PDF-', 'S13. PDF real del caso de Preview generado')
  const srcWord = readFileSync('lib/documentGen/construirDocumentoWord.ts', 'utf8')
  const srcPdf = readFileSync('lib/documentGen/generarPdfServidor.ts', 'utf8')
  verificar(srcWord.includes('const piePagina = !agregarFirmaAutomatica(texto, enc) ? [] : [') && srcPdf.includes('if (agregarFirmaAutomatica(texto, enc)) {'),
    'S14. Word y PDF aplican la misma regla de firma automática')
  verificar(limpiar(casoReal) === `${CUERPO}\n\nAtentamente,\nDocente de 3.º A`, 'S15. De la firma del texto solo se quitan la escuela y el ciclo que repiten el encabezado')

  // R. Caso real de E2E (aviso PDF de 3.º A en Preview) y controles contra falsos positivos.
  const REAL = `📨 AVISO PARA PADRES Y MADRES DE FAMILIA

Escuela Primaria Ficticia E2E
Grado y Grupo: 3° A
Ciclo Escolar: ${enc.cicloEscolar}

Estimadas madres y padres de familia:

Les recordamos la importancia de la puntualidad.

Atentamente,
Docente Prueba E2E
Docente de 3° A
Escuela Primaria Ficticia E2E
Ciclo Escolar ${enc.cicloEscolar}`
  const ESPERADO = `📨 AVISO PARA PADRES Y MADRES DE FAMILIA

Estimadas madres y padres de familia:

Les recordamos la importancia de la puntualidad.

Atentamente,
Docente Prueba E2E
Docente de 3° A`
  verificar(limpiar(REAL) === ESPERADO, 'R1. Caso real: se quitan escuela, grado y ciclo junto al título y la escuela y el ciclo de la firma; quedan fórmula, nombre y cargo')
  verificar(limpiar(ESPERADO) === ESPERADO && limpiar(limpiar(REAL)) === limpiar(REAL), 'R2. Idempotente')
  verificar(!agregarFirmaAutomatica(limpiar(REAL), enc), 'R3. La firma del texto (nombre y cargo) sigue siendo la firma: no se agrega otra')
  const zipR = await JSZip.loadAsync(await generarWordBuffer(REAL, perfil, 'America/Mazatlan'))
  const cuerpoR = await zipR.file('word/document.xml')!.async('string')
  const encabezadoR = (await Promise.all(Object.keys(zipR.files).filter((f) => /^word\/header\d*\.xml$/.test(f)).map((f) => zipR.file(f)!.async('string')))).join('')
  verificar(encabezadoR.includes('Escuela Primaria Ficticia E2E') && !cuerpoR.includes('Escuela Primaria Ficticia E2E') && !cuerpoR.includes('Ciclo Escolar') && !cuerpoR.includes('Grado y Grupo')
    && (cuerpoR.split('Docente Prueba E2E').length - 1) === 1 && !cuerpoR.includes('Docente de grupo'),
    'R4. Word real: escuela, grado y ciclo solo en el encabezado automático; una sola firma')
  verificar((await generarPdfBuffer(REAL, perfil, 'America/Mazatlan')).subarray(0, 5).toString() === '%PDF-', 'R5. PDF real generado desde el mismo texto, con la misma limpieza')

  const controles: [string, string][] = [
    ['Otra escuela como línea suelta junto al título', `📢 AVISO\nEscuela Secundaria Técnica 5\n\nTexto del aviso.`],
    ['La escuela dentro de una frase del cuerpo', `📢 AVISO\n\nLa Escuela Primaria Ficticia E2E invita a la kermés.\n\nGracias.`],
    ['La escuela como línea suelta en el cuerpo (lejos del título y de la firma)', `📢 AVISO\n\nLugar del evento:\nEscuela Primaria Ficticia E2E\n\nGracias.`],
    ['Firma de otra persona con su propia escuela', `📢 AVISO\n\nTexto.\n\nAtentamente,\nMaría López Ramírez\nDirectora\nEscuela Secundaria Técnica 5`],
    ['Citatorio: destinatario y grado del alumno', `📨 CITATORIO\n\nEstimado padre/madre de familia de: _______________\nGrado y Grupo: 3° A\n\nSe le cita el día ____.`],
    ['El ciclo dentro de una frase', `📢 AVISO\n\nDurante el Ciclo Escolar ${enc.cicloEscolar} habrá tres reuniones.\n\nGracias.`],
    ['Ciclo distinto en la firma', `📢 AVISO\n\nTexto.\n\nAtentamente,\nDocente Prueba E2E\nCiclo Escolar 2019-2020`],
    ['Documento pedagógico con escuela suelta', `📝 EXAMEN DE FRACCIONES\nEscuela Primaria Ficticia E2E\nGrado y Grupo: 3° A\n\n1. Suma 1/2 + 1/2.`],
  ]
  for (const [nombre, t] of controles) verificar(limpiar(t) === t, `R6. Sin cambios (falso positivo evitado): ${nombre}`)
  const sinFirmante = `📢 AVISO\n\nTexto del aviso.\n\nAtentamente,\nEscuela Primaria Ficticia E2E`
  verificar(limpiar(sinFirmante) === `📢 AVISO\n\nTexto del aviso.\n\nAtentamente,` && agregarFirmaAutomatica(limpiar(sinFirmante), enc),
    'R7. Cierre cuyo único "firmante" era la escuela: queda "Atentamente," y la firma automática lo completa')
  verificar(limpiar(REAL.replace('Escuela Primaria Ficticia E2E\nGrado', 'Escuela Primaria Ficticia E2E\nGrado')) === ESPERADO
    && quitarDuplicadosInstitucionales(REAL, prepararEncabezado({}, 'America/Mazatlan')).includes('Escuela Primaria Ficticia E2E'),
    'R8. Sin datos institucionales confirmados, la escuela nunca se quita')

  // P. Prompt y contexto de sesión coherentes con la limpieza.
  const rutaP = readFileSync('app/api/chat/route.ts', 'utf8')
  verificar(rutaP.includes('y también a CUALQUIER otro documento que se entrega como archivo o como documento formal (aviso, comunicado, circular, oficio, constancia, carta, reporte, invitación…)'),
    'P1. Las reglas del MODO DOCUMENTO cubren avisos, comunicados, oficios, constancias, circulares…')
  verificar(rutaP.includes('termina con una fórmula de cortesía en su propia línea (por ejemplo "Atentamente,") y nada después: la aplicación pone la firma debajo')
    && rutaP.includes('conserva siempre los campos del destinatario que pida el formato'),
    'P2. Cierre natural sin firma del maestro; campos del destinatario conservados')
  verificar(rutaP.includes('Estimado padre/madre de familia de: _______________\nGrado y Grupo: [grado] [grupo]'), 'P3. La plantilla del citatorio conserva los campos del destinatario')
  const sesionP = readFileSync('lib/sesionContexto.ts', 'utf8')
  verificar(!sesionP.includes('(encabezado y cuerpo)') && sesionP.includes('la aplicación ya los imprime en el encabezado: no los repitas como encabezado ni en la firma'),
    'P4. El contexto de sesión ya no pide escribir el grupo en el encabezado')

  console.log(fallos === 0 ? '\nTODO OK' : `\n${fallos} verificación(es) fallaron`)
  process.exit(fallos === 0 ? 0 : 1)
}

generar()
