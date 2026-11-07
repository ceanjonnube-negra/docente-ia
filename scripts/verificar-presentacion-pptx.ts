// scripts/verificar-presentacion-pptx.ts
//
// Presentaciones PowerPoint nuevas: la cantidad pedida (N = total con
// portada, salvo "N de contenido" / "más la portada") se resuelve de
// forma determinista, y el generador produce un PPTX real con una
// diapositiva por sección — sin juntar secciones, sin duplicar el título
// en una diapositiva vacía y sin perder texto. Las planeaciones (DÍA n)
// y rúbricas (CRITERIO n) siguen igual.
//
// Sin red, sin credenciales, sin IA. Se ejecuta con
// `npx tsx scripts/verificar-presentacion-pptx.ts`.

import { readFileSync } from 'node:fs'
import JSZip from 'jszip'
import { generarPptxBuffer } from '../lib/documentGen/generarPptxServidor'
import { instruccionesPresentacion, seccionesDePresentacion } from '../lib/asistente/instruccionesPresentacion'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  console.log(`${condicion ? '✓' : '✗'} ${mensaje}`)
  if (!condicion) fallos++
}

// Como llega al generador: perfil documental del grupo efectivo (perfilConGrupoAcademico).
const PERFIL = { escuela: 'Escuela Ficticia', nombre: 'Docente Ficticio', grado: '3°', grupo: 'A' }

// Texto de cada diapositiva del PPTX real, en orden.
async function diapositivas(buffer: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(buffer)
  const nombres = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
  const xmls = await Promise.all(nombres.map((n) => zip.file(n)!.async('string')))
  return xmls.map((x) => x.replace(/<\/a:p>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim())
}

// Cajas de texto de cada diapositiva (EMU): ninguna sale de la diapositiva
// 16:9 (9144000 × 5143500) ni se encima con otra; tamaño de letra máximo.
type Caja = { x: number; y: number; cx: number; cy: number }
async function geometria(buffer: Buffer): Promise<{ cajas: Caja[]; letras: number[] }[]> {
  const zip = await JSZip.loadAsync(buffer)
  const nombres = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
  return Promise.all(nombres.map(async (n) => {
    const xml = await zip.file(n)!.async('string')
    const cajas = [...xml.matchAll(/<a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/g)].map((m) => ({ x: +m[1], y: +m[2], cx: +m[3], cy: +m[4] }))
    const letras = [...xml.matchAll(/ sz="(\d+)"/g)].map((m) => +m[1] / 100)
    return { cajas, letras }
  }))
}
const dentroYSinEncimarse = (cajas: Caja[]) =>
  cajas.length >= 1 && cajas.every((c) => c.x + c.cx <= 9144000 && c.y + c.cy <= 5143500) &&
  cajas.every((a, i) => cajas.every((b, j) => i === j || a.y + a.cy <= b.y || b.y + b.cy <= a.y))

// Contenido con el formato que pide la plantilla: portada + n secciones.
function presentacion(n: number): string {
  const secciones = Array.from({ length: n }, (_, i) => `📚 TEMA NÚMERO ${i + 1}\n- Idea A del tema ${i + 1}\n- Idea B del tema ${i + 1}\n- Idea C del tema ${i + 1}`)
  return ['📊 LA IMPORTANCIA DE LA LECTURA', ...secciones].join('\n\n')
}

async function revisarPresentacion(n: number, etiqueta: string) {
  const slides = await diapositivas(await generarPptxBuffer(presentacion(n), PERFIL, null))
  verificar(slides.length === n + 1, `${etiqueta}: ${n + 1} diapositivas (portada + ${n}); obtenidas ${slides.length}`)
  verificar(slides[0].includes('LA IMPORTANCIA DE LA LECTURA') && slides[0].includes('Grado 3° Grupo A') && !slides[0].includes('Idea'), `${etiqueta}: la portada lleva el título y el grupo, sin contenido de secciones`)
  const ok = slides.slice(1).every((s, i) => {
    const k = i + 1
    const propias = s.includes(`TEMA NÚMERO ${k}`) && ['A', 'B', 'C'].every((l) => s.includes(`Idea ${l} del tema ${k}`))
    const ajenas = Array.from({ length: n }, (_, j) => j + 1).filter((j) => j !== k).some((j) => s.includes(`del tema ${j} `) || s.endsWith(`del tema ${j}`) || s.includes(`TEMA NÚMERO ${j} `))
    return propias && !ajenas
  })
  verificar(ok, `${etiqueta}: cada diapositiva tiene su título y sus 3 viñetas, sin texto de otra sección`)
  verificar(!slides.slice(1).some((s) => s.includes('LA IMPORTANCIA DE LA LECTURA')), `${etiqueta}: el título principal no se repite como diapositiva de contenido`)
}

async function main() {
  // 1. Cantidad solicitada → secciones de contenido (además de la portada).
  const CANTIDADES: [string, number][] = [
    ['Haz una presentación en PowerPoint de 4 diapositivas sobre la lectura', 3],
    ['Genera un PowerPoint de cuatro diapositivas sobre la lectura', 3],
    ['Crea un PowerPoint de 1 diapositiva sobre la lectura', 0],
    ['Crea un PowerPoint de siete diapositivas sobre la lectura', 6],
    ['Genera un PowerPoint con 4 diapositivas de contenido más la portada', 4],
    ['Genera un PowerPoint de 7 diapositivas además de la portada', 7],
    ['Genera un PowerPoint de cuatro diapositivas sin contar la portada', 4],
    ['Genera una presentación en PowerPoint sobre la lectura', 4],
  ]
  for (const [mensaje, esperado] of CANTIDADES) {
    verificar(seccionesDePresentacion(mensaje) === esperado, `1. "${mensaje}" → ${esperado} secciones (obtenido ${seccionesDePresentacion(mensaje)})`)
  }
  const inst4 = instruccionesPresentacion('PowerPoint de 4 diapositivas')
  verificar(inst4.includes('Total: 4 diapositivas = portada + 3') && inst4.includes('EXACTAMENTE 3 secciones') && inst4.includes('Nunca escribas la palabra "DIAPOSITIVA"'), '1b. La instrucción da al modelo la cantidad ya resuelta (4 en total = portada + 3)')
  const inst1 = instruccionesPresentacion('PowerPoint de 1 diapositiva')
  verificar(inst1.includes('Total: 1 diapositiva') && inst1.includes('de 3 a 4 viñetas') && inst1.includes('información esencial del tema'), '1c. 1 diapositiva en total: la instrucción pide contenido útil del tema bajo el título')

  // 2. PPTX reales: 1, 4 y 7 diapositivas en total, y N de contenido + portada.
  const UNA = '📊 LA IMPORTANCIA DE LA LECTURA\n- Leer amplía el vocabulario de los alumnos.\n- Mejora la comprensión en todas las materias.\n- Despierta la imaginación y la curiosidad.'
  const bufUna = await generarPptxBuffer(UNA, PERFIL, null)
  const una = await diapositivas(bufUna)
  verificar(una.length === 1 && ['LA IMPORTANCIA DE LA LECTURA', 'amplía el vocabulario', 'Mejora la comprensión', 'Despierta la imaginación', 'Escuela Ficticia', 'Docente Ficticio', 'Grado 3° Grupo A'].every((t) => una[0].includes(t)), `2a. 1 diapositiva en total: título, contenido útil y datos institucionales en la misma diapositiva (obtenidas ${una.length})`)
  verificar(dentroYSinEncimarse((await geometria(bufUna))[0].cajas), '2a2. Diapositiva única: título, viñetas y datos institucionales dentro de la diapositiva y sin encimarse')
  const portadaSola = await diapositivas(await generarPptxBuffer('📊 LA IMPORTANCIA DE LA LECTURA', PERFIL, null))
  verificar(portadaSola.length === 1 && portadaSola[0].includes('LA IMPORTANCIA DE LA LECTURA'), `2a3. Solo un título, sin contenido: la portada (obtenidas ${portadaSola.length})`)
  await revisarPresentacion(3, '2b. 4 en total')
  await revisarPresentacion(6, '2c. 7 en total')
  await revisarPresentacion(4, '2d. 4 de contenido + portada')
  await revisarPresentacion(7, '2e. 7 de contenido + portada')

  // 3. Respaldo: el formato que produjo el defecto ("DIAPOSITIVA n: título"
  // en mayúsculas y minúsculas) ya no se junta en una sola diapositiva.
  const defecto = ['📊 La importancia de la lectura', ...[1, 2, 3, 4].map((k) => `DIAPOSITIVA ${k}: Beneficio número ${k}\n- Detalle uno del beneficio ${k}\n- Detalle dos del beneficio ${k}`)].join('\n\n')
  const slidesDefecto = await diapositivas(await generarPptxBuffer(defecto, PERFIL, null))
  verificar(slidesDefecto.length === 5 && [1, 2, 3, 4].every((k) => slidesDefecto[k].includes(`Beneficio número ${k}`) && slidesDefecto[k].includes(`Detalle dos del beneficio ${k}`)), `3a. "DIAPOSITIVA n: título": una diapositiva por sección (obtenidas ${slidesDefecto.length})`)

  // 4. Sin pérdida de información: texto bajo el título principal se
  // conserva en su propia diapositiva.
  const conIntro = '📊 LA IMPORTANCIA DE LA LECTURA\nUna introducción breve.\n\n📚 TEMA UNO\n- Idea del tema uno'
  const slidesIntro = await diapositivas(await generarPptxBuffer(conIntro, PERFIL, null))
  verificar(slidesIntro.length === 3 && slidesIntro[1].includes('Una introducción breve.') && slidesIntro[2].includes('Idea del tema uno'), '4a. Contenido bajo el título principal: se conserva (no se pierde texto)')

  // 5. Planeaciones y rúbricas: una diapositiva por DÍA/CRITERIO, igual que antes.
  const planeacion = '📋 PLANEACIÓN DIDÁCTICA\nGrado: 3° | Grupo: A\n\n📅 DÍA 1 — Inicio\n- Actividad del día uno\n\n📅 DÍA 2 — Desarrollo\n- Actividad del día dos'
  const slidesPlan = await diapositivas(await generarPptxBuffer(planeacion, PERFIL, null))
  verificar(slidesPlan.length === 4 && slidesPlan[2].includes('Actividad del día uno') && slidesPlan[3].includes('Actividad del día dos'), `5a. Planeación: portada + datos + una diapositiva por DÍA (obtenidas ${slidesPlan.length})`)
  const rubrica = '📊 RÚBRICA DE EVALUACIÓN\n\nCRITERIO 1: Comprensión\n- Nivel alto\n\nCRITERIO 2: Fluidez\n- Nivel medio'
  const slidesRub = await diapositivas(await generarPptxBuffer(rubrica, PERFIL, null))
  verificar(slidesRub.length === 3 && slidesRub[1].includes('Comprensión') && slidesRub[2].includes('Fluidez'), `5b. Rúbrica: una diapositiva por CRITERIO (obtenidas ${slidesRub.length})`)

  // 7. Contenido que excede el espacio: sin desbordes, sin encimarse y
  // sin perder texto.
  const tituloLargo = 'LA IMPORTANCIA DE LA LECTURA EN LA FORMACIÓN INTEGRAL DE LOS NIÑOS Y NIÑAS DE EDUCACIÓN PRIMARIA EN LA NUEVA ESCUELA MEXICANA Y SU COMUNIDAD'
  const vinetas = Array.from({ length: 14 }, (_, i) => `- Viñeta extensa número ${i + 1}: la lectura diaria en el aula fortalece la comprensión, el vocabulario, la escritura y el pensamiento crítico de cada alumno del grupo`)
  const largo = [`📊 ${tituloLargo}`, `📚 ${tituloLargo}\n${vinetas.join('\n')}`].join('\n\n')
  const bufLargo = await generarPptxBuffer(largo, PERFIL, null)
  const slidesLargo = await diapositivas(bufLargo)
  const geoLargo = await geometria(bufLargo)
  verificar(geoLargo.every((g) => dentroYSinEncimarse(g.cajas)), '7a. Título largo y 14 viñetas extensas: todas las cajas dentro de la diapositiva y sin encimarse')
  verificar(slidesLargo.length > 2 && slidesLargo.slice(2).every((s) => s.includes('(continuación)')), `7b. El contenido que no cabe sigue en diapositivas de continuación (obtenidas ${slidesLargo.length})`)
  verificar(vinetas.every((v, i) => slidesLargo.filter((s) => s.includes(`número ${i + 1}:`)).length === 1 && slidesLargo.join(' ').includes(v.slice(2))), '7c. Cada viñeta aparece completa y una sola vez (no se pierde ni se duplica texto)')
  verificar(geoLargo[1].letras.some((l) => l < 24) && slidesLargo[1].includes(tituloLargo), '7d. Título largo: reduce su letra y se muestra completo')
  const enorme = Array.from({ length: 400 }, (_, i) => `palabra${i + 1}`).join(' ')
  const bufEnorme = await generarPptxBuffer(`📊 TÍTULO\n\n📚 SECCIÓN ÚNICA\n- ${enorme}`, PERFIL, null)
  const slidesEnorme = await diapositivas(bufEnorme)
  const palabras = slidesEnorme.slice(1).join(' ').match(/palabra\d+/g) ?? []
  verificar(slidesEnorme.length > 2 && palabras.length === 400 && palabras.every((p, i) => p === `palabra${i + 1}`) && (await geometria(bufEnorme)).every((g) => dentroYSinEncimarse(g.cajas)), `7e. Una sola viñeta enorme: se reparte por palabras en continuaciones, completa y en orden (diapositivas ${slidesEnorme.length})`)
  const unaDemasiada = `📊 LA LECTURA\n${vinetas.join('\n')}`
  const slidesUnaDemasiada = await diapositivas(await generarPptxBuffer(unaDemasiada, PERFIL, null))
  verificar(slidesUnaDemasiada.length > 1 && vinetas.every((_, i) => slidesUnaDemasiada.join(' ').includes(`número ${i + 1}:`)), `7f. "Una diapositiva" con más contenido del que cabe: portada + continuaciones, sin perder texto (obtenidas ${slidesUnaDemasiada.length})`)
  verificar((await Promise.all([3, 6].map(async (n) => geometria(await generarPptxBuffer(presentacion(n), PERFIL, null))))).flat().every((g) => dentroYSinEncimarse(g.cajas)), '7g. Presentaciones normales (4 y 7): cajas dentro de la diapositiva y sin encimarse')

  // 8. Sin duplicados: la portada tiene exactamente un título y un bloque
  // institucional; cada diapositiva de contenido, un título y a lo sumo un
  // bloque de viñetas; ningún título de sección se repite fuera de sus
  // continuaciones.
  // Elementos de texto (<p:sp>) por diapositiva, en orden.
  const formas = async (buffer: Buffer) => {
    const zip = await JSZip.loadAsync(buffer)
    const nombres = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((x, y) => Number(x.match(/\d+/)![0]) - Number(y.match(/\d+/)![0]))
    return Promise.all(nombres.map(async (n) => ((await zip.file(n)!.async('string')).match(/<p:sp>/g) ?? []).length))
  }
  const buf4 = await generarPptxBuffer(presentacion(3), PERFIL, null)
  const slides4 = await diapositivas(buf4)
  const formas4 = await formas(buf4)
  verificar(slides4.length === 4 && formas4[0] === 2 && formas4.slice(1).every((n) => n === 2), `8a. 4 en total: portada con 2 elementos (título + datos) y cada diapositiva con 2 (título + viñetas); obtenidas ${JSON.stringify(formas4)}`)
  verificar(slides4.filter((s) => s.includes('LA IMPORTANCIA DE LA LECTURA')).length === 1 && slides4[0].split('Escuela Ficticia').length === 2 && [1, 2, 3].every((k) => slides4.filter((s) => s.includes(`TEMA NÚMERO ${k}`)).length === 1), '8b. 4 en total: título, datos institucionales y cada sección aparecen una sola vez')
  const formasLargo = await formas(bufLargo)
  verificar(formasLargo[0] === 2 && formasLargo.slice(1).every((n) => n === 2) && slidesLargo[0].split('Escuela Ficticia').length === 2, `8c. Con continuaciones: portada con 2 elementos y cada diapositiva con 2; obtenidas ${JSON.stringify(formasLargo)}`)
  verificar(slidesLargo.slice(1).filter((s) => !s.includes('(continuación)')).length === 1 && slidesLargo.slice(2).every((s) => s.split('(continuación)').length === 2), '8d. Con continuaciones: la sección abre una sola diapositiva sin "(continuación)" y cada continuación lleva el rótulo una sola vez')
  verificar((await formas(bufUna))[0] === 3 && una[0].split('Escuela Ficticia').length === 2 && una[0].split('LA IMPORTANCIA DE LA LECTURA').length === 2, '8e. Diapositiva única: exactamente 3 elementos (título, viñetas, datos), sin repetir título ni datos')
  const fuente = readFileSync('lib/documentGen/generarPptxServidor.ts', 'utf8')
  verificar((fuente.match(/portada\.addText\(/g) ?? []).length === 2 && (fuente.match(/pptx\.addSlide\(\)/g) ?? []).length === 3, '8f. Fuente: la portada tiene exactamente 2 addText y solo hay 3 addSlide (única, portada y cada página de sección)')

  // 9. Cantidad pedida respetada también por el generador (seccionesEsperadas,
  // solo PowerPoint nuevo): las secciones de más se integran en la última,
  // sin perder ni duplicar texto, con la paginación existente.
  const inst = instruccionesPresentacion('Genera un PowerPoint de 4 diapositivas sobre la lectura y en la última diapositiva coloca la frase X')
  verificar(inst.includes('N es el TOTAL e incluye la portada') && inst.includes('se integra DENTRO de las 3 secciones ya previstas') && inst.includes('última viñeta de la ÚLTIMA sección') && inst.includes('Nunca crees una sección adicional') && inst.includes('deben ser exactamente 3'), '9a. Plantilla: total con portada, requisitos dentro de las secciones previstas, frase final en la última sección y conteo antes de terminar')
  verificar(instruccionesPresentacion('PowerPoint de 1 diapositiva').includes('va como una viñeta más debajo del título'), '9a2. Plantilla de 1 diapositiva: los requisitos adicionales van como viñetas bajo el título')
  const seccion = (titulo: string, k: number, n = 3) => [`📚 ${titulo}`, ...Array.from({ length: n }, (_, i) => `- Punto ${i + 1} de ${titulo.toLowerCase()} (${k})`)].join('\n')
  const conSecciones = (titulos: string[], n = 3) => ['📊 LA IMPORTANCIA DE LA LECTURA', ...titulos.map((t, i) => seccion(t, i + 1, n))].join('\n\n')
  const textoCompleto = (ss: string[]) => ss.join(' ')
  const legibles = async (buffer: Buffer) => (await geometria(buffer)).every((g) => dentroYSinEncimarse(g.cajas) && g.letras.every((l) => l >= 11))
  const unaVez = (ss: string[], frases: string[]) => frases.every((f) => textoCompleto(ss).split(f).length === 2)

  const tresMasConclusion = conSecciones(['POR QUÉ LEER', 'ESTRATEGIAS', 'ACTIVIDADES', 'CONCLUSIÓN'])
  const bufConclusion = await generarPptxBuffer(tresMasConclusion, PERFIL, null, 3)
  const sConclusion = await diapositivas(bufConclusion)
  verificar(sConclusion.length === 4 && sConclusion[3].includes('ACTIVIDADES') && sConclusion[3].includes('CONCLUSIÓN') && sConclusion[3].includes('Punto 3 de conclusión (4)'), `9b. 4 pedidas + sección de conclusión: 4 diapositivas, la conclusión integrada en la última (obtenidas ${sConclusion.length})`)
  verificar(unaVez(sConclusion, ['CONCLUSIÓN', ...[1, 2, 3].map((i) => `Punto ${i} de conclusión (4)`), ...[1, 2, 3].map((i) => `Punto ${i} de actividades (3)`)]) && await legibles(bufConclusion), '9b2. Conclusión integrada: cada texto una sola vez, cajas dentro y letra legible')

  const conFrase = ['📊 LA IMPORTANCIA DE LA LECTURA', seccion('POR QUÉ LEER', 1), seccion('ESTRATEGIAS', 2), seccion('ACTIVIDADES', 3), '✅ VALIDACIÓN DEL DOCUMENTO\n- Documento de validación E2E PowerPoint'].join('\n\n')
  const sFrase = await diapositivas(await generarPptxBuffer(conFrase, PERFIL, null, 3))
  verificar(sFrase.length === 4 && sFrase[3].includes('Documento de validación E2E PowerPoint') && unaVez(sFrase, ['Documento de validación E2E PowerPoint', 'VALIDACIÓN DEL DOCUMENTO']), `9c. Frase pedida para la última diapositiva: queda dentro de la diapositiva 4, una sola vez (obtenidas ${sFrase.length})`)

  const cinco = conSecciones(['UNO', 'DOS', 'TRES', 'CUATRO', 'CINCO'], 2)
  const bufCinco = await generarPptxBuffer(cinco, PERFIL, null, 3)
  const sCinco = await diapositivas(bufCinco)
  verificar(sCinco.length === 4 && ['CUATRO', 'CINCO', 'Punto 2 de cuatro (4)', 'Punto 2 de cinco (5)'].every((t) => sCinco[3].includes(t)) && unaVez(sCinco, ['Punto 1 de uno (1)', 'Punto 2 de tres (3)', 'Punto 1 de cuatro (4)', 'Punto 2 de cinco (5)']) && await legibles(bufCinco), `9d. Varias secciones sobrantes: 4 diapositivas, todo integrado en la última sin pérdida (obtenidas ${sCinco.length})`)

  const dos = conSecciones(['UNO', 'DOS'])
  const sDos = await diapositivas(await generarPptxBuffer(dos, PERFIL, null, 3))
  verificar(sDos.length === 3 && sDos.slice(1).every((x) => x.includes('Punto 1')), `9e. Menos secciones de las esperadas: no se inventan ni se agregan diapositivas vacías (obtenidas ${sDos.length})`)

  const unaConSecciones = conSecciones(['IDEA PRINCIPAL', 'CIERRE'], 2)
  const sUnaSec = await diapositivas(await generarPptxBuffer(unaConSecciones, PERFIL, null, 0))
  verificar(sUnaSec.length === 1 && ['IDEA PRINCIPAL', 'CIERRE', 'Punto 2 de cierre (2)', 'Escuela Ficticia', 'Grado 3° Grupo A'].every((t) => sUnaSec[0].includes(t)), `9f. Una sola diapositiva con secciones escritas: todo el contenido y los datos institucionales en 1 (obtenidas ${sUnaSec.length})`)

  const excesivo = conSecciones(['UNO', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS'], 5)
  const bufExc = await generarPptxBuffer(excesivo, PERFIL, null, 3)
  const sExc = await diapositivas(bufExc)
  const fijas = sExc.slice(1).filter((x) => !x.includes('(continuación)'))
  verificar(sExc.length > 4 && fijas.length === 3 && sExc.slice(4).every((x) => x.includes('TRES (continuación)')), `9g. Contenido excesivo: 3 secciones como se pidió y lo que no cabe sigue en "(continuación)" de la última (obtenidas ${sExc.length}, límite físico)`)
  verificar(unaVez(sExc, ['Punto 5 de seis (6)', 'Punto 1 de cuatro (4)', 'Punto 3 de cinco (5)', 'SEIS']) && await legibles(bufExc), '9g2. Contenido excesivo: nada oculto ni duplicado, cajas dentro y letra legible (sin encoger viñetas)')

  const sConv = await diapositivas(await generarPptxBuffer(tresMasConclusion, PERFIL, null))
  verificar(sConv.length === 5 && sConv[4].includes('CONCLUSIÓN') && !sConv[3].includes('CONCLUSIÓN'), `9h. Conversión existente (sin seccionesEsperadas): sin cambios, una diapositiva por sección (obtenidas ${sConv.length})`)
  const herramientas = readFileSync('lib/documentGen/herramientas.ts', 'utf8')
  verificar(/powerpoint: async \(\) => \(\{ buffer: await generarPptxBuffer\(texto, perfil, zonaHoraria, opciones\?\.seccionesEsperadas\)/.test(herramientas) && (herramientas.match(/seccionesEsperadas/g) ?? []).length === 2, '9i. Herramientas: seccionesEsperadas solo llega al generador PowerPoint')
  const rutaChat = readFileSync('app/api/chat/route.ts', 'utf8')
  verificar((rutaChat.match(/seccionesEsperadas: seccionesDePresentacion\(instruccionDocente \?\? ''\)/g) ?? []).length === 1 && /const opcionesArchivo = plantillaPresentacion \? \{ seccionesEsperadas/.test(rutaChat) && /ejecutarHerramientaDocumento\(tipoHerramientaSolicitado, documentoTexto, perfil, zonaHoraria, supabaseRAG, userId\)/.test(rutaChat), '9j. /api/chat: solo el CASO 3 de PowerPoint (con plantilla) pasa seccionesEsperadas; la conversión de un documento existente no')

  // 6. Solo PowerPoint recibe la plantilla.
  const ruta = readFileSync('app/api/chat/route.ts', 'utf8')
  verificar(/const plantillaPresentacion = tipoHerramientaSolicitado === 'powerpoint' && instruccionDocente !== null && \(!esEdicion \|\| tieneCantidadExplicita\(instruccionDocente\)\)/.test(ruta) && /const systemCaso3 = plantillaPresentacion\s*\n\s*\? `\$\{parametrosClaude\.system\}\\n\\n\$\{instruccionesPresentacion\(instruccionDocente \?\? ''\)\}`\s*\n\s*: parametrosClaude\.system/.test(ruta) && /client\.messages\.create\(\{ \.\.\.parametrosClaude, system: systemCaso3, stream: false \}/.test(ruta), '6a. CASO 3: la plantilla de presentación solo se agrega para PowerPoint (Word, PDF y Excel sin cambios); en una edición, solo con cantidad explícita')
  verificar((ruta.match(/instruccionesPresentacion\(/g) ?? []).length === 1, '6b. Ningún otro camino usa la plantilla de presentación')

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  }
  console.log('Todas las pruebas pasaron.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
