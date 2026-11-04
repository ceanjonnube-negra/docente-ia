// scripts/verificar-encabezado-documentos-grupo.ts
//
// Encabezado de documentos académicos de un grupo (lista de alumnos,
// planeación aprobada, hoja de evaluación y sus vistas previas): grado y
// grupo salen del grupo validado (perfilConGrupoAcademico), nunca de
// perfiles_docentes; el resto del perfil se conserva. Documentos sin grupo
// académico: el perfil sin cambios. Genera Word y PDF REALES con los
// generadores de la app y lee su texto; sin red, sin Supabase, sin IA.
//
// Se ejecuta con `npx tsx scripts/verificar-encabezado-documentos-grupo.ts`.

import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import JSZip from 'jszip'
import { PDFDocument, PDFArray, PDFName, PDFRawStream, type PDFStream } from 'pdf-lib'
import { perfilConGrupoAcademico, prepararEncabezado } from '../lib/documentGen/encabezadoDocumento'
import { generarWordBuffer } from '../lib/documentGen/generarWordServidor'
import { generarPdfBuffer } from '../lib/documentGen/generarPdfServidor'
import { generarHojaSeguimientoPdfBuffer } from '../lib/documentGen/generarHojaSeguimientoPdf'
import { construirTextoListaAlumnos } from '../lib/motorContexto'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

// El perfil dice "4° A"; los grupos reales son A y B.
const PERFIL = Object.freeze({ id: 'doc', escuela: 'Escuela Ficticia Benito Juárez', nombre: 'Docente Ficticio', grado: '4°', grupo: 'A', municipio: 'Mexicali', estado: 'Baja California' })
const GRUPO_A = { grado: '4', grupo: 'A' }
const GRUPO_B = { grado: '4', grupo: 'B' }

async function textoWord(buffer: Buffer): Promise<string> {
  // El encabezado institucional vive en word/header*.xml (sección de
  // encabezado de docx), el cuerpo en word/document.xml.
  const zip = await JSZip.loadAsync(buffer)
  const partes = Object.keys(zip.files).filter((n) => /^word\/(document|header\d*)\.xml$/.test(n))
  const xml = (await Promise.all(partes.map((n) => zip.file(n)!.async('string')))).join(' ')
  return xml.replace(/<w:tab\/>/g, ' ').replace(/<\/w:p>/g, ' ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&')
}
async function textoPdf(buffer: Buffer): Promise<string> {
  const doc = await PDFDocument.load(buffer)
  const partes: string[] = []
  for (const p of doc.getPages()) {
    const c = p.node.Contents()
    const flujos = (c instanceof PDFArray ? c.asArray().map((r) => doc.context.lookup(r)) : [c]) as PDFStream[]
    for (const f of flujos) {
      const crudo = (f as PDFRawStream).contents
      const contenido = Buffer.from(f.dict.get(PDFName.of('Filter')) ? inflateSync(crudo) : crudo).toString('latin1')
      for (const m of contenido.matchAll(/<([0-9A-Fa-f]*)> Tj/g)) partes.push(Buffer.from(m[1], 'hex').toString('latin1'))
    }
  }
  return partes.join(' ')
}
const sinEspacios = (t: string) => t.replace(/\s+/g, ' ')
const tieneGrupo = (t: string, grado: string, grupo: string) => new RegExp(`Grado: ${grado} +Grupo: ${grupo}(\\s|$)`).test(sinEspacios(t))

const ALUMNOS_A = [{ alumno_id: 'a1', nombre_completo: 'Ana Grupo A', numero_lista: 1 }]
const ALUMNOS_B = [{ alumno_id: 'b1', nombre_completo: 'Beto Grupo B', numero_lista: 1 }]
const PLANEACION = '📋 PLANEACIÓN DIDÁCTICA\n\nProyecto: Leyendas de mi comunidad\n\nPropósito: que los alumnos investiguen leyendas.\n\nSecuencia didáctica\nDía 1: introducción.\nDía 2: investigación.'

async function main() {
  // 1. Función pura.
  const pB = perfilConGrupoAcademico(PERFIL, GRUPO_B)
  verificar(pB.grado === '4°' && pB.grupo === 'B', '1a. Grupo validado B → grado 4° y grupo B (no el "A" del perfil)')
  verificar(pB.escuela === PERFIL.escuela && pB.nombre === PERFIL.nombre && pB.municipio === PERFIL.municipio && pB.estado === PERFIL.estado, '1b. Se conservan escuela, docente, municipio y estado del perfil')
  verificar(PERFIL.grupo === 'A' && pB !== PERFIL, '1c. El perfil original no se modifica (copia)')
  verificar(perfilConGrupoAcademico(PERFIL, null) === PERFIL, '1d. Documento sin grupo académico: el mismo perfil, sin cambios')
  verificar(perfilConGrupoAcademico(PERFIL, { grado: '5°', grupo: 'C' }).grado === '5°', '1e. Grado que ya trae "°": no se duplica')
  const incompletoLetra = perfilConGrupoAcademico(PERFIL, { grado: '3', grupo: null })
  const incompletoGrado = perfilConGrupoAcademico(PERFIL, { grado: null, grupo: 'B' })
  const vacio = perfilConGrupoAcademico(PERFIL, { grado: null, grupo: null })
  verificar(incompletoLetra.grado === '3°' && incompletoLetra.grupo === '', '1f. Grupo sin letra: letra vacía, nunca la "A" del perfil')
  verificar(incompletoGrado.grado === '' && incompletoGrado.grupo === 'B', '1g. Grupo sin grado: grado vacío, nunca el "4°" del perfil')
  verificar(vacio.grado === '' && vacio.grupo === '' && vacio.escuela === PERFIL.escuela, '1h. Grupo sin grado ni letra: ambos vacíos; el resto del perfil intacto')
  verificar(prepararEncabezado(pB, 'America/Mexico_City').grupo === 'B', '1i. prepararEncabezado (sin cambios) lee el grupo efectivo')

  // 2. Lista de alumnos A y B, Word y PDF reales: aislamiento entre grupos.
  for (const [nombre, grupo, alumnos, otra] of [['A', GRUPO_A, ALUMNOS_A, 'B'], ['B', GRUPO_B, ALUMNOS_B, 'A']] as const) {
    const texto = construirTextoListaAlumnos([...alumnos], `${grupo.grado}°`, grupo.grupo)
    const perfil = perfilConGrupoAcademico(PERFIL, grupo)
    const word = await textoWord(await generarWordBuffer(texto, perfil, 'America/Mexico_City'))
    const pdf = await textoPdf(await generarPdfBuffer(texto, perfil, 'America/Mexico_City'))
    verificar(tieneGrupo(word, '4°', nombre) && !tieneGrupo(word, '4°', otra), `2. Lista ${nombre} en Word: encabezado "Grado: 4° Grupo: ${nombre}", nunca ${otra}`)
    verificar(tieneGrupo(pdf, '4°', nombre) && !tieneGrupo(pdf, '4°', otra), `2. Lista ${nombre} en PDF: encabezado "Grado: 4° Grupo: ${nombre}", nunca ${otra}`)
    verificar(word.includes(PERFIL.escuela) && pdf.includes(PERFIL.escuela), `2. Lista ${nombre}: conserva la escuela del perfil`)
  }

  // 3. Planeación aprobada del grupo B, Word y PDF reales.
  const perfilB = perfilConGrupoAcademico(PERFIL, GRUPO_B)
  const wordPl = await textoWord(await generarWordBuffer(PLANEACION, perfilB, null))
  const pdfPl = await textoPdf(await generarPdfBuffer(PLANEACION, perfilB, null))
  verificar(tieneGrupo(wordPl, '4°', 'B') && !tieneGrupo(wordPl, '4°', 'A'), '3. Planeación B en Word: "Grado: 4° Grupo: B"')
  verificar(tieneGrupo(pdfPl, '4°', 'B') && !tieneGrupo(pdfPl, '4°', 'A'), '3. Planeación B en PDF: "Grado: 4° Grupo: B"')

  // 4. Hoja de evaluación del grupo B (PDF real del generador de hojas).
  const hojaB = await textoPdf(await generarHojaSeguimientoPdfBuffer(
    { nombreProyecto: 'Leyendas', camposFormativos: ['Lenguajes'], trimestreNombre: null, fechaInicio: '2026-11-16', fechaFin: '2026-11-27', identificadorVisible: 'SG-PRUE', indicadores: [{ indicador_especifico: 'Narra una leyenda', aspecto_general: 'logro_aprendizaje' }], alumnos: [{ nombre: 'Beto Grupo B', posicion: 1 }] },
    perfilB, null))
  verificar(tieneGrupo(hojaB, '4°', 'B') && !tieneGrupo(hojaB, '4°', 'A') && hojaB.includes('SG-PRUE'), '4. Hoja de evaluación B: "Grado: 4° Grupo: B" y su código SG intacto')

  // 5. Grupo con datos incompletos y documento general sin grupo.
  const pdfIncompleto = await textoPdf(await generarPdfBuffer(PLANEACION, perfilConGrupoAcademico(PERFIL, { grado: '4', grupo: null }), null))
  verificar(/Grado: 4° +Grupo:(\s|$)/.test(sinEspacios(pdfIncompleto)) && !tieneGrupo(pdfIncompleto, '4°', 'A'), '5a. Grupo sin letra: "Grupo:" vacío, nunca la "A" del perfil')
  const pdfGeneral = await textoPdf(await generarPdfBuffer('Oficio de prueba\n\nTexto del oficio.', perfilConGrupoAcademico(PERFIL, null), null))
  verificar(tieneGrupo(pdfGeneral, '4°', 'A'), '5b. Documento general sin grupo: encabezado del perfil, igual que antes')

  // 6. Integración en los recorridos (estructura del código).
  const ruta = readFileSync('app/api/chat/route.ts', 'utf8')
  verificar(/ejecutarHerramientaDocumento\(tipoHerramientaSolicitado, textoLista, perfilConGrupoAcademico\(perfilLista, sesion\.grupo_activo_datos \?\? \{ grado: null, grupo: null \}\)/.test(ruta), '6a. Lista en Word/PDF: grupo efectivo de la sesión (incompleto → vacío, nunca el perfil)')
  verificar((ruta.match(/ejecutarHerramientaDocumento\(tipoHerramientaSolicitado, (documentoTexto|texto), perfil,/g) ?? []).length === 2, '6b. Documentos generales (convertir y combinado): perfil sin cambios')
  verificar(/grupoId: sesion\.grupo_activo_id \}/.test(ruta), '6c. El enlace de vista previa de la planeación lleva el grupo de la sesión')
  const aprobar = readFileSync('lib/planeacion/aprobarBorrador.ts', 'utf8')
  verificar(/const perfil = perfilConGrupoAcademico\(perfilDocente, sesion\.grupo_activo_datos \?\? \{ grado: null, grupo: null \}\)/.test(aprobar) && /ejecutarHerramientaDocumento\('word', textoCompleto, perfil,/.test(aprobar) && /ejecutarHerramientaDocumento\('pdf', textoCompleto, perfil,/.test(aprobar), '6d. Aprobación: hoja, Word y PDF con el grupo de la sesión')
  const hoja = readFileSync('app/api/proyectos-seguimiento/[id]/hoja/route.ts', 'utf8')
  verificar(/confirmado_en, grupos\(grado, grupo\)'/.test(hoja) && /perfilConGrupoAcademico\(perfilDocente, grupoProyecto \?\? \{ grado: null, grupo: null \}\)/.test(hoja), '6e. POST /hoja: grupo del proyecto, en la misma consulta del proyecto')
  const vpHoja = readFileSync('app/api/planeaciones/vista-previa-hoja/route.ts', 'utf8')
  verificar(/select\('id, docente_id, grado, grupo'\)/.test(vpHoja) && /perfilConGrupoAcademico\(perfil, \{ grado: grupo\.grado, grupo: grupo\.grupo \}\)/.test(vpHoja), '6f. Vista previa de la hoja: grupo ya verificado, sin consulta adicional')
  for (const f of ['app/api/planeaciones/vista-previa-documento/route.ts', 'app/api/planeaciones/vista-previa-documento-word/route.ts']) {
    const c = readFileSync(f, 'utf8')
    verificar(/leerGrupoDelDocente\(supabase, grupoId, docenteId\)/.test(c) && /grupo === 'ajeno'.*403/.test(c) && /perfilConGrupoAcademico\(perfilDocente, grupo\)/.test(c), `6g. ${f.split('/').at(-2)}: grupo verificado contra el docente; ajeno → 403; sin grupoId → perfil`)
  }

  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
    process.exit(0)
  }
}

main()
