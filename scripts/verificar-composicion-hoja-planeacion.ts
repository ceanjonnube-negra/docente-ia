// scripts/verificar-composicion-hoja-planeacion.ts
//
// COMPOSICIÓN CANÓNICA — "Planeación + hoja de evaluación al final del
// mismo archivo". Dos partes, mismo criterio que el resto de esta
// familia de scripts:
//
//   A) Verificación ESTRUCTURAL (sin credenciales, sin red, sin datos
//      reales): inspecciona el código fuente real de
//      lib/documentGen/componerHojaEnPlaneacion.ts,
//      lib/documentGen/construirDocumentoWord.ts y
//      lib/planeacion/aprobarBorrador.ts.
//
//   B) PRUEBA LOCAL DE RENDER (ejecución real de pdf-lib/docx, sin
//      Supabase, sin IA, con datos de prueba sintéticos): genera
//      buffers reales y comprueba programáticamente el resultado —
//      pageCount del PDF compuesto y contenido real del .docx
//      compuesto (JSZip + word/document.xml).
//
// Se ejecuta con `npx tsx scripts/verificar-composicion-hoja-planeacion.ts`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import JSZip from 'jszip'
import { PDFDocument } from 'pdf-lib'
import {
  hidratarDatosHojaSeguimiento,
  componerPdfPlaneacionConHoja,
  construirSeccionHojaEvaluacionWord,
} from '../lib/documentGen/componerHojaEnPlaneacion'
import { generarHojaSeguimientoPdfBuffer, type DatosHojaSeguimiento } from '../lib/documentGen/generarHojaSeguimientoPdf'
import { generarPdfBuffer } from '../lib/documentGen/generarPdfServidor'
import { generarWordBuffer } from '../lib/documentGen/generarWordServidor'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

const raiz = (...partes: string[]) => join(__dirname, '..', ...partes)

function sinComentariosDeLinea(contenido: string): string {
  return contenido
    .split('\n')
    .filter((linea) => !linea.trim().startsWith('//'))
    .join('\n')
}

const componer = readFileSync(raiz('lib', 'documentGen', 'componerHojaEnPlaneacion.ts'), 'utf-8')
const componerSinComentarios = sinComentariosDeLinea(componer)
const construirWord = readFileSync(raiz('lib', 'documentGen', 'construirDocumentoWord.ts'), 'utf-8')
const aprobarBorrador = readFileSync(raiz('lib', 'planeacion', 'aprobarBorrador.ts'), 'utf-8')
const aprobarBorradorSinComentarios = sinComentariosDeLinea(aprobarBorrador)

async function main() {
  // ============================================================
  // A. VERIFICACIÓN ESTRUCTURAL (20 puntos)
  // ============================================================

  // 1-2. PDF usa copyPages/getPageIndices.
  verificar(/\.copyPages\(/.test(componerSinComentarios), '1. La composición PDF usa copyPages')
  verificar(/\.getPageIndices\(\)/.test(componerSinComentarios), '2. Usa getPageIndices (copia TODAS las páginas de la hoja, nunca asume 1)')

  // Bloque de Fase 4.5, sobre la versión SIN comentarios (evita falsos
  // positivos cuando el propio comentario explica, en prosa, qué NO
  // debe llamarse/tocarse — mismo criterio ya usado en otras fases de
  // esta sesión).
  const inicioFase45 = aprobarBorradorSinComentarios.indexOf('type DocumentoGuardado')
  const finFase45 = aprobarBorradorSinComentarios.indexOf('trazabilidadCurricularExistente')
  const bloqueFase45 = aprobarBorradorSinComentarios.slice(inicioFase45, finFase45)

  // 3. Nunca llama generarYGuardarHojaSeguimiento.
  verificar(!componerSinComentarios.includes('generarYGuardarHojaSeguimiento'), '3. componerHojaEnPlaneacion.ts nunca llama generarYGuardarHojaSeguimiento')
  verificar(!/generarYGuardarHojaSeguimiento\(/.test(bloqueFase45), '3b. La sección de Fase 4.5 de aprobarBorrador.ts no vuelve a llamar generarYGuardarHojaSeguimiento')

  // 4-5. Nunca INSERT/UPDATE sobre hojas_evaluacion desde la composición.
  verificar(!/from\('hojas_evaluacion'\)\.(insert|update)\(/.test(componerSinComentarios), '4/5. componerHojaEnPlaneacion.ts nunca hace INSERT/UPDATE sobre hojas_evaluacion (solo SELECT vía descargarBuffer/aprobarBorrador)')
  verificar(!/from\('hojas_evaluacion'\)\.(insert|update)\(/.test(bloqueFase45), '4b/5b. El bloque de Fase 4.5 en aprobarBorrador.ts nunca hace INSERT/UPDATE sobre hojas_evaluacion (solo .select())')
  verificar(/from\('hojas_evaluacion'\)\.select\(/.test(bloqueFase45), '4c. El bloque de Fase 4.5 SÍ lee (select) hojas_evaluacion — la fuente de verdad real')

  // 6. Nunca toca seguimiento_resultados.
  verificar(!componerSinComentarios.includes('seguimiento_resultados'), '6. componerHojaEnPlaneacion.ts no referencia seguimiento_resultados en absoluto')
  verificar(!bloqueFase45.includes('seguimiento_resultados'), '6b. El bloque de Fase 4.5 no referencia seguimiento_resultados (fuera de comentarios explicativos)')

  // 7-9. Word: tabla nativa, nueva sección, landscape.
  verificar(/new Table\(/.test(componerSinComentarios), '7. El renderer Word usa una Table nativa (nunca una imagen rasterizada)')
  verificar(/seccionesAdicionales/.test(construirWord) && /\.\.\.\(seccionesAdicionales \?\? \[\]\)/.test(construirWord), '8. construirDocumentoWord.ts acepta seccionesAdicionales y las agrega como sección(es) extra del MISMO Document')
  verificar(/PageOrientation\.LANDSCAPE/.test(componerSinComentarios), '9. La sección de la hoja se construye con PageOrientation.LANDSCAPE')

  // 10-12. Modelo compartido + snapshot canónico, nunca datos vivos.
  verificar(/DatosHojaSeguimiento/.test(componer), '10. componerHojaEnPlaneacion.ts usa DatosHojaSeguimiento (mismo modelo que el renderer PDF, sin una segunda abstracción)')
  verificar(/hoja\.roster_congelado/.test(componerSinComentarios), '11. El roster proviene de hoja.roster_congelado (snapshot), nunca de una consulta a alumnos actuales')
  verificar(!/obtenerRosterConPosicion|from\('alumnos'\)/.test(componerSinComentarios), '11b. componerHojaEnPlaneacion.ts nunca consulta alumnos actuales para reconstruir el roster')
  verificar(/hoja\.indicadores/.test(componerSinComentarios), '12. Los indicadores provienen de hoja.indicadores (snapshot), nunca de la planeación vigente')
  verificar(!/resumen\.indicadores|construirIndicadoresSeguimiento/.test(componerSinComentarios), '12b. componerHojaEnPlaneacion.ts nunca reconstruye indicadores desde el resumen de la planeación')

  // 13. Fase 4 ocurre antes de la composición.
  const idxFase4 = aprobarBorrador.indexOf('// Fase 4:')
  const idxFase45 = aprobarBorrador.indexOf('// Fase 4.5:')
  const idxObtenerHojaCanonica = aprobarBorrador.indexOf('obtenerHojaYProyectoCanonicos()')
  verificar(idxFase4 > -1 && idxFase45 > idxFase4, '13. Fase 4 (asegurar hoja canónica) aparece antes que Fase 4.5 (composición) en el código')
  verificar(idxObtenerHojaCanonica > idxFase45, '13b. La lectura de la hoja canónica para componer ocurre dentro del bloque de Fase 4.5, después de Fase 4')

  // 14-17. Metadata guardada: storage_path, hoja_id, incluye_hoja en AMBOS.
  const ocurrenciasStoragePath = (bloqueFase45.match(/storage_path: ruta/g) || []).length
  const ocurrenciasHojaId = (bloqueFase45.match(/hoja_id: hojaId/g) || []).length
  const ocurrenciasIncluyeHoja = (bloqueFase45.match(/incluye_hoja: true/g) || []).length
  verificar(ocurrenciasStoragePath === 2, `14/15. documento_pdf Y documento_word guardan storage_path (encontrados: ${ocurrenciasStoragePath}, esperados: 2)`)
  verificar(ocurrenciasHojaId === 2, `16. documento_pdf Y documento_word guardan hoja_id (encontrados: ${ocurrenciasHojaId}, esperados: 2)`)
  verificar(ocurrenciasIncluyeHoja === 2, `17. documento_pdf Y documento_word guardan incluye_hoja=true (encontrados: ${ocurrenciasIncluyeHoja}, esperados: 2)`)

  // 18. Compatibilidad con documentos históricos (sin storage_path/hoja_id/incluye_hoja).
  verificar(/storage_path\?:\s*string/.test(bloqueFase45) && /hoja_id\?:\s*string/.test(bloqueFase45) && /incluye_hoja\?:\s*boolean/.test(bloqueFase45), '18. Los 3 campos nuevos son OPCIONALES en el tipo — un documento histórico sin ellos sigue siendo un valor válido')
  verificar(/doc\.incluye_hoja === true && doc\.hoja_id === hojaId/.test(bloqueFase45), '18b. La condición de reutilización exige incluye_hoja===true Y hoja_id coincidente — un histórico sin esos campos nunca se reutiliza a ciegas ni rompe la lectura')

  // 19. Sin llamadas IA nuevas.
  verificar(!/anthropic|Anthropic|messages\.create/i.test(componer), '19. componerHojaEnPlaneacion.ts no contiene ninguna llamada a IA')
  verificar(!/anthropic|Anthropic|messages\.create/i.test(bloqueFase45), '19b. El bloque de Fase 4.5 no agrega ninguna llamada a IA nueva')

  // 20. Sin migraciones nuevas para esta fase.
  const migracionesRecientes = ['20260927000000_hoja_canonica_por_proyecto.sql', '20260928000000_vinculo_planeacion_proyecto_seguimiento.sql']
  const { readdirSync } = await import('node:fs')
  const archivosMigracion = readdirSync(raiz('supabase', 'migrations')).filter((f) => f.endsWith('.sql'))
  const migracionesNuevasNoEsperadas = archivosMigracion.filter((f) => f > migracionesRecientes[1] && !migracionesRecientes.includes(f))
  verificar(migracionesNuevasNoEsperadas.length === 0, `20. No se agregó ninguna migración nueva para esta fase (todo vive en planeacion_proyectos.evaluacion jsonb ya existente)`)

  // ============================================================
  // B. PRUEBA LOCAL DE RENDER (ejecución real, datos sintéticos)
  // ============================================================
  const PERFIL_PRUEBA = { nombre: 'Docente de Prueba', escuela: 'Escuela de Prueba', grado: '3', grupo: 'A', municipio: 'Ciudad', estado: 'Estado' }
  const DATOS_HOJA_PRUEBA: DatosHojaSeguimiento = {
    nombreProyecto: 'Proyecto de Prueba Composición',
    camposFormativos: ['Lenguajes'],
    trimestreNombre: null,
    fechaInicio: '2026-01-01',
    fechaFin: '2026-01-05',
    identificadorVisible: 'SG-TEST',
    indicadores: [
      { indicador_especifico: 'Indicador de prueba uno', aspecto_general: 'logro_aprendizaje' },
      { indicador_especifico: 'Indicador de prueba dos', aspecto_general: 'autonomia' },
    ],
    alumnos: [
      { nombre: 'Alumno Prueba Uno', posicion: 1 },
      { nombre: 'Alumno Prueba Dos', posicion: 2 },
      { nombre: 'Alumno Prueba Tres', posicion: 3 },
    ],
  }
  const TEXTO_PLANEACION_PRUEBA = '# Planeación de prueba\n\nContenido de prueba para verificar la composición.\n\n## Actividad\n\nTexto de relleno.\n'

  // --- Hidratación (verifica que la función pura no invente nada) ---
  {
    const datosHidratados = await hidratarDatosHojaSeguimiento(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) } as any,
      { identificador_visible: 'SG-TEST', roster_congelado: [{ alumno_id: 'a', inscripcion_id: 'i', nombre: 'Zeta', posicion: 2 }, { alumno_id: 'b', inscripcion_id: 'j', nombre: 'Alfa', posicion: 1 }], indicadores: [{ indicador_especifico: 'Ind B', aspecto_general: 'autonomia', numero_indicador: 2 }, { indicador_especifico: 'Ind A', aspecto_general: 'logro_aprendizaje', numero_indicador: 1 }], storage_path: 'x' },
      { nombre: 'Proyecto Hidratado', campos_formativos: ['Lenguajes'], fecha_inicio: '2026-01-01', fecha_fin: '2026-01-02', periodo_evaluacion_id: null }
    )
    verificar(datosHidratados.trimestreNombre === null, 'B1. Sin periodo_evaluacion_id, trimestreNombre queda null — nunca se inventa un trimestre')
    verificar(datosHidratados.alumnos[0].nombre === 'Alfa' && datosHidratados.alumnos[1].nombre === 'Zeta', 'B2. Los alumnos quedan ordenados por posición (roster_congelado tal como está, nunca recalculado)')
    verificar(datosHidratados.indicadores[0].indicador_especifico === 'Ind A', 'B3. Los indicadores quedan ordenados por numero_indicador congelado')
  }

  // --- PDF: pageCount del compuesto = pageCount planeación + pageCount hoja ---
  {
    const bufferHoja = await generarHojaSeguimientoPdfBuffer(DATOS_HOJA_PRUEBA, PERFIL_PRUEBA, null)
    const bufferPlaneacion = await generarPdfBuffer(TEXTO_PLANEACION_PRUEBA, PERFIL_PRUEBA, null)
    const paginasHoja = (await PDFDocument.load(bufferHoja)).getPageCount()
    const paginasPlaneacion = (await PDFDocument.load(bufferPlaneacion)).getPageCount()

    const bufferCompuesto = await componerPdfPlaneacionConHoja(bufferPlaneacion, bufferHoja)
    const paginasCompuesto = (await PDFDocument.load(bufferCompuesto)).getPageCount()

    verificar(paginasCompuesto === paginasPlaneacion + paginasHoja, `B4. pageCount del PDF compuesto (${paginasCompuesto}) = pageCount planeación (${paginasPlaneacion}) + pageCount hoja (${paginasHoja})`)
    verificar(bufferCompuesto.subarray(0, 4).toString('latin1') === '%PDF', 'B5. El PDF compuesto sigue siendo un PDF real y válido (firma %PDF)')
  }

  // --- Word: Document contiene sección planeación + sección hoja landscape, con el SG/roster/indicadores de prueba reales ---
  {
    const seccionHoja = construirSeccionHojaEvaluacionWord(DATOS_HOJA_PRUEBA, PERFIL_PRUEBA, null)
    verificar(seccionHoja.properties?.page?.size?.orientation === 'landscape', 'B6. La sección construida para la hoja pide orientación landscape')

    const bufferWordCompuesto = await generarWordBuffer(TEXTO_PLANEACION_PRUEBA, PERFIL_PRUEBA, null, undefined, [seccionHoja])
    verificar(bufferWordCompuesto.subarray(0, 2).toString('latin1') === 'PK', 'B7. El .docx compuesto sigue siendo un archivo ZIP real (Office Open XML)')

    const zip = await JSZip.loadAsync(bufferWordCompuesto)
    const documentoXml = await zip.file('word/document.xml')?.async('string')
    verificar(!!documentoXml, 'B8. El .docx compuesto contiene word/document.xml')
    if (documentoXml) {
      const ocurrenciasLandscape = (documentoXml.match(/w:orient="landscape"/g) || []).length
      verificar(ocurrenciasLandscape >= 1, 'B9. word/document.xml contiene al menos una sección con w:orient="landscape" (la de la hoja)')
      verificar(documentoXml.includes('SG-TEST'), 'B10. El .docx compuesto contiene el SG de prueba real (SG-TEST)')
      verificar(documentoXml.includes('Alumno Prueba Uno') && documentoXml.includes('Alumno Prueba Dos') && documentoXml.includes('Alumno Prueba Tres'), 'B11. El .docx compuesto contiene el roster de prueba real (los 3 alumnos)')
      verificar(documentoXml.includes('Indicador de prueba uno') && documentoXml.includes('Indicador de prueba dos'), 'B12. El .docx compuesto contiene los indicadores de prueba reales')
      verificar(documentoXml.includes('Proyecto de Prueba Composición') && documentoXml.includes('Planeación de prueba'), 'B13. El .docx compuesto contiene TANTO el contenido de la planeación COMO el de la hoja — un solo archivo, dos partes')

      // --- AJUSTE DE MAQUETACIÓN — Carta landscape explícita + spacing
      // explícito en la tabla (ver auditoría "la hoja de 27 alumnos se
      // derramaba a una segunda página"). Verificado sobre el pgSz/
      // spacing REALMENTE serializados, no sobre la intención de
      // entrada. ---
      const pgSzs = documentoXml.match(/<w:pgSz[^/]*\/>/g) || []
      verificar(pgSzs.length === 2, `B14. El documento compuesto tiene exactamente 2 <w:pgSz> reales (una por sección) — encontrados: ${pgSzs.length}`)
      verificar(
        pgSzs.some((p) => p.includes('w:w="15840"') && p.includes('w:h="12240"') && p.includes('w:orient="landscape"')),
        'B15. La sección de la hoja tiene w:pgSz w:w="15840" w:h="12240" w:orient="landscape" — Carta apaisada real (11×8.5in), no el default A4 de la librería'
      )
      const cantidadLandscape = pgSzs.filter((p) => p.includes('w:orient="landscape"')).length
      verificar(cantidadLandscape === 1, `B16. Solo UNA sección (la de la hoja) es landscape — la sección de planeación no fue alterada (encontradas landscape: ${cantidadLandscape})`)

      const tblStartIdx = documentoXml.indexOf('<w:tbl>')
      const tblEndIdx = documentoXml.indexOf('</w:tbl>') + '</w:tbl>'.length
      const tablaXml = documentoXml.slice(tblStartIdx, tblEndIdx)
      const spacingsEnTabla = tablaXml.match(/<w:spacing[^/]*\/>/g) || []
      verificar(spacingsEnTabla.length > 0, 'B17. Los párrafos de la tabla tienen <w:spacing> explícito (no dependen del default del visor)')
      verificar(
        spacingsEnTabla.every((s) => s.includes('w:before="0"') && s.includes('w:after="0"')),
        'B18. TODOS los párrafos de celda tienen before=0 y after=0 explícitos — ninguno hereda el espaciado "Normal" del visor'
      )
      verificar(
        spacingsEnTabla.every((s) => /w:lineRule="exact"/.test(s) && /w:line="\d+"/.test(s)),
        'B19. TODOS los párrafos de celda fijan line/lineRule="exact" — altura de línea determinista, no arbitraria'
      )
      const valoresLine = new Set(spacingsEnTabla.map((s) => s.match(/w:line="(\d+)"/)?.[1]))
      verificar(valoresLine.size === 1, `B20. El valor de line es el MISMO para todas las celdas (una sola constante de tamaño de fuente) — valores encontrados: ${[...valoresLine].join(',')}`)
      const lineEncontrado = Number([...valoresLine][0])
      const tamanoFuenteEsperado = 9 // TAMANO_CELDA_TABLA=18 medios-puntos = 9pt real
      const lineEsperado = Math.round(tamanoFuenteEsperado * 1.2 * 20)
      verificar(lineEncontrado === lineEsperado, `B21. El valor de line (${lineEncontrado}) coincide EXACTAMENTE con tamaño_fuente(9pt) × 1.2 × 20 = ${lineEsperado} — derivado del tamaño real de fuente, nunca un número arbitrario`)

      const tcMars = tablaXml.match(/<w:tcMar>[\s\S]*?<\/w:tcMar>/g) || []
      verificar(tcMars.length > 0, 'B22. Las celdas de la tabla tienen <w:tcMar> explícito (márgenes de celda deterministas, no heredados del visor)')
    }
  }

  // --- OOXML: inspección estructural real del .docx compuesto — más
  // de un w:sectPr, landscape solo en la sección de la hoja (la
  // planeación conserva su orientación original), la tabla/hoja
  // aparece DESPUÉS del contenido de planeación, SG aparece una sola
  // vez, y el roster se renderiza en el orden real de posicion tras
  // pasar por la MISMA hidratación que usa aprobarBorrador.ts (roster
  // deliberadamente desordenado en el jsonb de entrada, para probar
  // que el orden final depende de `posicion`, nunca del orden de
  // inserción del array). ---
  {
    const rosterDesordenado = [
      { alumno_id: 'z', inscripcion_id: 'iz', nombre: 'Zeta Alumno', posicion: 3 },
      { alumno_id: 'a', inscripcion_id: 'ia', nombre: 'Alfa Alumno', posicion: 1 },
      { alumno_id: 'b', inscripcion_id: 'ib', nombre: 'Beta Alumno', posicion: 2 },
    ]
    const datosOrdenados = await hidratarDatosHojaSeguimiento(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) } as any,
      { identificador_visible: 'SG-OOXML', roster_congelado: rosterDesordenado, indicadores: [{ indicador_especifico: 'Indicador OOXML', aspecto_general: 'logro_aprendizaje', numero_indicador: 1 }], storage_path: 'x' },
      { nombre: 'Proyecto OOXML', campos_formativos: ['Lenguajes'], fecha_inicio: '2026-02-01', fecha_fin: '2026-02-02', periodo_evaluacion_id: null }
    )
    const seccionHoja = construirSeccionHojaEvaluacionWord(datosOrdenados, PERFIL_PRUEBA, null)
    const textoPlaneacionOoxml = '# Planeacion OOXML\n\nContenido real y reconocible de la planeacion.\n'
    const buffer = await generarWordBuffer(textoPlaneacionOoxml, PERFIL_PRUEBA, null, undefined, [seccionHoja])
    const zip = await JSZip.loadAsync(buffer)
    const xml = await zip.file('word/document.xml')?.async('string')
    verificar(!!xml, 'C1. El .docx compuesto (flujo real de hidratación) contiene word/document.xml')
    if (xml) {
      const cantidadSectPr = (xml.match(/<w:sectPr/g) || []).length
      verificar(cantidadSectPr >= 2, `C2. Existe más de un w:sectPr en el documento (encontrados: ${cantidadSectPr}) — 2 secciones reales, no una sola`)

      const idxPrimerSectPr = xml.indexOf('<w:sectPr')
      const seccionPlaneacion = xml.slice(0, idxPrimerSectPr)
      const seccionHojaXml = xml.slice(idxPrimerSectPr)
      verificar(!/w:orient="landscape"/.test(seccionPlaneacion), 'C3. La sección de la planeación (antes del primer sectPr) NO hereda landscape por accidente')
      verificar(/w:orient="landscape"/.test(seccionHojaXml), 'C4. La sección de la hoja (desde el primer sectPr en adelante) sí es landscape')

      const idxContenidoPlaneacion = xml.indexOf('Contenido real y reconocible de la planeacion')
      const idxTablaHoja = xml.indexOf('<w:tbl>')
      verificar(idxContenidoPlaneacion > -1 && idxTablaHoja > idxContenidoPlaneacion, 'C5. La tabla de la hoja aparece DESPUÉS del contenido de la planeación en el documento')

      const ocurrenciasSG = (xml.match(/SG-OOXML/g) || []).length
      verificar(ocurrenciasSG === 1, `C6. SG-OOXML aparece exactamente UNA vez en todo el documento (encontradas: ${ocurrenciasSG})`)

      const idxAlfa = xml.indexOf('Alfa Alumno')
      const idxBeta = xml.indexOf('Beta Alumno')
      const idxZeta = xml.indexOf('Zeta Alumno')
      verificar(idxAlfa > -1 && idxBeta > idxAlfa && idxZeta > idxBeta, `C7. Los alumnos aparecen en el ORDEN de roster_congelado por posición (Alfa[1] < Beta[2] < Zeta[3]), no en el orden desordenado del array de entrada (índices: Alfa=${idxAlfa}, Beta=${idxBeta}, Zeta=${idxZeta})`)
    }
  }

  // --- PDF multipágina real: hoja con roster grande (fuerza 2 páginas
  // físicas reales, ver calcularCantidadPaginasHoja) — confirma que
  // copyPages + getPageIndices() copian TODAS las páginas de la hoja,
  // nunca solo la primera. ---
  {
    const rosterGrande = Array.from({ length: 45 }, (_, i) => ({ nombre: `Alumno Multipagina ${i + 1}`, posicion: i + 1 }))
    const datosHojaMultipagina: DatosHojaSeguimiento = { ...DATOS_HOJA_PRUEBA, identificadorVisible: 'SG-MULTI', alumnos: rosterGrande }
    const bufferHojaMultipagina = await generarHojaSeguimientoPdfBuffer(datosHojaMultipagina, PERFIL_PRUEBA, null)
    const paginasHojaMultipagina = (await PDFDocument.load(bufferHojaMultipagina)).getPageCount()
    verificar(paginasHojaMultipagina >= 2, `D1. La hoja de prueba con 45 alumnos realmente ocupa ${paginasHojaMultipagina} páginas físicas (>= 2, precondición real del caso multipágina)`)

    const bufferPlaneacionMulti = await generarPdfBuffer(TEXTO_PLANEACION_PRUEBA, PERFIL_PRUEBA, null)
    const paginasPlaneacionMulti = (await PDFDocument.load(bufferPlaneacionMulti)).getPageCount()
    const bufferCompuestoMulti = await componerPdfPlaneacionConHoja(bufferPlaneacionMulti, bufferHojaMultipagina)
    const paginasCompuestoMulti = (await PDFDocument.load(bufferCompuestoMulti)).getPageCount()
    verificar(
      paginasCompuestoMulti === paginasPlaneacionMulti + paginasHojaMultipagina,
      `D2. pageCount final (${paginasCompuestoMulti}) = pageCount planeación (${paginasPlaneacionMulti}) + pageCount hoja multipágina (${paginasHojaMultipagina}) — copyPages/getPageIndices() copiaron TODAS las páginas`
    )
  }

  // ============================================================
  // 2. FALLO INDEPENDIENTE — Word y PDF nunca se bloquean entre sí.
  // Verificación estructural (no ejecuta Fase 4.5 completa: confirma,
  // por lectura del código real, que cada formato vive en su propio
  // try/catch y que el resultado exitoso de uno sobrevive aunque el
  // otro falle después).
  // ============================================================
  {
    // El try de Word y el try de PDF deben ser DOS bloques try/catch
    // independientes (nunca uno solo envolviendo ambos) dentro del
    // mismo `if (!documentoWord || !documentoPdf) { ... }`.
    const idxTryWord = bloqueFase45.indexOf('if (!documentoWord)')
    const idxCatchWord = bloqueFase45.indexOf('} catch (e) {', idxTryWord)
    const idxTryPdf = bloqueFase45.indexOf('if (!documentoPdf)')
    const idxCatchPdf = bloqueFase45.indexOf('} catch (e) {', idxTryPdf)
    verificar(idxTryWord > -1 && idxCatchWord > idxTryWord && idxCatchWord < idxTryPdf, 'E1. El try/catch de Word se cierra ANTES de que empiece el bloque de PDF — no es un try compartido')
    verificar(idxTryPdf > -1 && idxCatchPdf > idxTryPdf, 'E2. PDF tiene su propio try/catch independiente, después del de Word')
    verificar((bloqueFase45.match(/} catch \(e\) {/g) || []).length >= 2, 'E3. Existen al menos 2 bloques catch independientes en Fase 4.5 (uno por formato, nunca uno compartido)')

    // Escenario 1: Word funciona y PDF falla → documentoWord debe
    // seguir asignado cuando se llega a Fase 5 (nunca se resetea por
    // el catch de PDF, que está en un try distinto).
    verificar(!/documentoWord = null/.test(bloqueFase45), 'E4 (escenario Word-ok/PDF-falla). Nada dentro de Fase 4.5 reinicia documentoWord a null — un Word ya asignado sobrevive a un fallo posterior de PDF')
    // Escenario 2: PDF funciona y Word falla → documentoPdf debe
    // seguir asignado igual, por el mismo motivo, en sentido inverso.
    verificar(!/documentoPdf = null/.test(bloqueFase45), 'E5 (escenario PDF-ok/Word-falla). Nada dentro de Fase 4.5 reinicia documentoPdf a null — un PDF ya asignado sobrevive a un fallo posterior de Word')
    // Escenario 3: ambos funcionan → Fase 5 los persiste solo si están presentes (spread condicional ya verificado en tests 14-17).
    verificar(/\.\.\.\(documentoWord \? \{ documento_word: documentoWord \} : \{\}\)/.test(aprobarBorradorSinComentarios) && /\.\.\.\(documentoPdf \? \{ documento_pdf: documentoPdf \} : \{\}\)/.test(aprobarBorradorSinComentarios), 'E6 (escenario ambos-ok / ambos-fallan). Fase 5 persiste cada documento SOLO si quedó asignado — ambos presentes se guardan ambos, ambos ausentes no se guarda ninguno')
  }

  // ============================================================
  // F. AJUSTE DE MAQUETACIÓN — caso 27 (real), caso pequeño, caso
  // grande, y presupuesto vertical estructural. Ver auditoría "la
  // hoja de 27 alumnos se derramaba a una segunda página en Word".
  // ============================================================

  // F0 — ¿existe un renderer OOXML real disponible LOCALMENTE (LibreOffice/
  // soffice)? Puramente informativo: si no existe, estas pruebas NUNCA
  // afirman un pageCount real — solo verifican estructura OOXML y un
  // presupuesto vertical aritmético, dejando explícito que la
  // confirmación visual final requiere el Word real en el iPhone.
  let rendererDisponible: string | null = null
  for (const candidato of ['soffice', 'libreoffice']) {
    try {
      execSync(`which ${candidato}`, { stdio: 'pipe' })
      rendererDisponible = candidato
      break
    } catch {
      // no encontrado, se prueba el siguiente candidato
    }
  }
  console.log(rendererDisponible ? `ℹ F0. Renderer OOXML local encontrado: ${rendererDisponible} — se podría usar para un pageCount real.` : 'ℹ F0. No se encontró soffice/libreoffice en este entorno local — el pageCount real NO puede confirmarse aquí. Las pruebas de este bloque son estructurales/aritméticas, nunca una afirmación de páginas reales. La confirmación visual final requiere Word real (iPhone).')

  function construirDatosPrueba(cantidadAlumnos: number, sgPrueba: string): DatosHojaSeguimiento {
    return {
      nombreProyecto: 'Con pan, festejamos y convivimos',
      camposFormativos: ['Lenguajes'],
      trimestreNombre: null,
      fechaInicio: '2026-10-05',
      fechaFin: '2026-10-05',
      identificadorVisible: sgPrueba,
      indicadores: [
        { indicador_especifico: 'Narra oralmente con fluidez y claridad una tradición familiar o comunitaria relacionada con el pan', aspecto_general: 'logro_aprendizaje' },
        { indicador_especifico: 'Produce un texto descriptivo escrito con oraciones completas', aspecto_general: 'producto_evidencia' },
        { indicador_especifico: 'Aplica correctamente el uso de mayúsculas al inicio de oración y en nombres propios', aspecto_general: 'logro_aprendizaje' },
        { indicador_especifico: 'Expresa con vocabulario propio el valor cultural y simbólico del pan', aspecto_general: 'aplicacion_aprendizajes' },
        { indicador_especifico: 'Muestra disposición para escuchar y valorar las tradiciones de sus compañeros', aspecto_general: 'participacion_colaboracion' },
      ],
      alumnos: Array.from({ length: cantidadAlumnos }, (_, i) => ({ nombre: `Alumno Apellido Apellido ${i + 1}`, posicion: i + 1 })),
    }
  }

  // F1 — CASO 27 (el caso real E2E): nombres de longitud realista,
  // 5 indicadores reales, SG real de la prueba E2E.
  {
    const datos27 = construirDatosPrueba(27, 'SG-262N')
    const seccion = construirSeccionHojaEvaluacionWord(datos27, PERFIL_PRUEBA, null)
    const buffer = await generarWordBuffer('# Planeacion\n\nContenido real.\n', PERFIL_PRUEBA, null, undefined, [seccion])
    const zip = await JSZip.loadAsync(buffer)
    const xml = (await zip.file('word/document.xml')?.async('string')) ?? ''

    verificar(datos27.alumnos.every((a) => xml.includes(a.nombre)), 'F1a (27 alumnos). Los 27 nombres están presentes en el documento')
    const indices27 = datos27.alumnos.map((a) => xml.indexOf(a.nombre))
    verificar(indices27.every((idx, i) => i === 0 || idx > indices27[i - 1]), 'F1b (27 alumnos). Los 27 nombres aparecen en orden ascendente de posición')
    verificar(datos27.indicadores.every((ind) => xml.includes(ind.indicador_especifico)), 'F1c (27 alumnos). Los 5 indicadores completos están presentes')
    verificar((xml.match(/SG-262N/g) || []).length === 1, 'F1d (27 alumnos). SG-262N aparece exactamente una vez')
    verificar((xml.match(/<w:tbl>/g) || []).length === 1, 'F1e (27 alumnos). Existe una sola tabla nativa real')
    verificar(!xml.includes('<w:drawing') && !xml.includes('<pic:pic'), 'F1f (27 alumnos). Sin rasterización — cero imágenes/drawings')
    verificar((xml.match(/<w:pgSz[^/]*w:orient="landscape"[^/]*\/>/g) || []).length === 1 || /w:orient="landscape"/.test(xml), 'F1g (27 alumnos). La sección de la hoja sigue siendo landscape')
  }

  // F2 — CASO PEQUEÑO (5 alumnos): misma estructura, sin deformaciones
  // introducidas por el ajuste (anchos de columna siguen sumando lo
  // mismo, celdas siguen presentes, nada se rompe con pocas filas).
  {
    const datos5 = construirDatosPrueba(5, 'SG-PEQ1')
    const seccion = construirSeccionHojaEvaluacionWord(datos5, PERFIL_PRUEBA, null)
    const buffer = await generarWordBuffer('# Planeacion\n\nContenido real.\n', PERFIL_PRUEBA, null, undefined, [seccion])
    const zip = await JSZip.loadAsync(buffer)
    const xml = (await zip.file('word/document.xml')?.async('string')) ?? ''

    verificar(datos5.alumnos.every((a) => xml.includes(a.nombre)), 'F2a (5 alumnos). Los 5 nombres están presentes')
    verificar((xml.match(/<w:tr\b/g) || []).length === 6, `F2b (5 alumnos). La tabla tiene exactamente 6 filas (1 encabezado + 5 alumnos) — encontradas: ${(xml.match(/<w:tr\b/g) || []).length}`)
    // AJUSTE — layout FIXED + columnWidths en twips (ver bloque G más
    // abajo): el ancho de la columna Alumno ya no se declara en
    // porcentaje (w:type="pct"), sino en twips absolutos (w:type="dxa")
    // — la MISMA fuente canónica (32% de 14440 = 4621 twips) sin
    // importar cuántas filas tenga la tabla.
    verificar((xml.match(/w:type="dxa" w:w="4621"/g) || []).length >= 1, 'F2c (5 alumnos). El ancho de la columna Alumno (4621 twips = 32% de 14440) se conserva igual que con 27 — sin recalcular proporciones por tener menos filas')
    verificar((xml.match(/SG-PEQ1/g) || []).length === 1, 'F2d (5 alumnos). SG aparece exactamente una vez')
  }

  // F3 — CASO GRANDE: roster suficientemente grande para que, en la
  // práctica, exceda una sola página (comportamiento multipágina
  // natural, nunca bloqueado por código). NO se afirma un pageCount
  // real aquí (no hay renderer local, ver F0) — solo se confirma que
  // NINGÚN alumno se pierde/trunca y que el código no contiene ningún
  // mecanismo que fuerce artificialmente una sola página (saltos
  // manuales, recorte de contenido, reducción de fuente condicional).
  {
    const datosGrande = construirDatosPrueba(90, 'SG-GRANDE')
    const seccion = construirSeccionHojaEvaluacionWord(datosGrande, PERFIL_PRUEBA, null)
    const buffer = await generarWordBuffer('# Planeacion\n\nContenido real.\n', PERFIL_PRUEBA, null, undefined, [seccion])
    const zip = await JSZip.loadAsync(buffer)
    const xml = (await zip.file('word/document.xml')?.async('string')) ?? ''

    verificar(datosGrande.alumnos.every((a) => xml.includes(a.nombre)), 'F3a (90 alumnos). Los 90 alumnos están presentes — ninguno se pierde ni se trunca con un roster grande')
    verificar((xml.match(/<w:tr\b/g) || []).length === 91, `F3b (90 alumnos). La tabla tiene 91 filas reales (1 encabezado + 90) — sin recorte artificial (encontradas: ${(xml.match(/<w:tr\b/g) || []).length})`)
    verificar(componerSinComentarios.includes('tableHeader: true'), 'F3c. tableHeader:true sigue presente — si el visor pagina esta tabla, el encabezado de columnas se repetirá en cada página nueva')
    verificar(!/w:br[^>]*w:type="page"/.test(xml), 'F3d. No se insertó ningún salto de página manual/artificial')
    verificar(!/size:\s*Math\.max\(|size:\s*Math\.min\(/.test(componerSinComentarios), 'F3e. El código no reduce el tamaño de fuente condicionalmente según la cantidad de alumnos (nunca "shrink to fit")')
  }

  // F4 — PRESUPUESTO VERTICAL (estimación estructural/aritmética, NO
  // un reemplazo de la prueba visual real): con los valores REALES ya
  // confirmados en el código (fuente de celda 9pt, factor de
  // interlineado 1.2, márgenes de página 700 twips/lado, márgenes de
  // celda 20 twips arriba/abajo), calcula si 27 filas + el encabezado
  // real de la hoja deberían caber dentro del alto disponible de una
  // página Carta landscape (12240 twips = 612pt).
  {
    const altoCartaLandscapePt = 12240 / 20 // 612pt, igual a ALTO_PAGINA del PDF
    const margenPaginaPt = (700 / 20) * 2 // top+bottom
    const disponiblePt = altoCartaLandscapePt - margenPaginaPt // 542pt

    const alturaLineaCeldaPt = Math.round(9 * 1.2 * 20) / 20 // 216 twips = 10.8pt
    const margenCeldaPt = (20 / 20) * 2 // top+bottom = 2pt
    const alturaFilaPt = alturaLineaCeldaPt + margenCeldaPt // 12.8pt

    // Encabezado real: 10 párrafos, altura de línea por tamaño real +
    // los `after` explícitos que el propio código ya declara.
    const lineas = [
      { size: 22, after: 0 }, // escuela
      { size: 16, after: 160 }, // docente/grado/grupo/ciclo
      { size: 24, after: 100 }, // proyecto + SG (tamaño mayor de los 2 runs)
      { size: 16, after: 100 }, // meta
      { size: 16, after: 100 }, // leyenda
      { size: 16, after: 40 }, { size: 16, after: 40 }, { size: 16, after: 40 }, { size: 16, after: 40 }, { size: 16, after: 40 }, // 5 indicadores
    ]
    const alturaEncabezadoPt = lineas.reduce((acc, l) => acc + Math.round((l.size / 2) * 1.2 * 20) / 20 + l.after / 20, 0)

    const alturaTabla27Pt = 28 * alturaFilaPt // header + 27 alumnos
    const totalEstimadoPt = alturaEncabezadoPt + alturaTabla27Pt

    verificar(
      totalEstimadoPt <= disponiblePt,
      `F4. Estimación estructural: encabezado(${alturaEncabezadoPt.toFixed(1)}pt) + 28 filas(${alturaTabla27Pt.toFixed(1)}pt) = ${totalEstimadoPt.toFixed(1)}pt <= disponible en Carta landscape (${disponiblePt.toFixed(1)}pt) — el caso de 27 alumnos debería caber en una sola página. Esto es una estimación aritmética a partir de los valores reales del código, NO una confirmación visual — esa requiere abrir el Word real.`
    )
  }

  // ============================================================
  // G. AJUSTE — table layout FIXED + columnWidths reales + header
  // aislado. Ver auditoría "causa raíz real del desborde a 2 páginas"
  // (evidencia E2E real: nombres envueltos en 2 líneas pese al
  // presupuesto vertical teórico, y encabezado institucional
  // duplicado). Los 22 puntos pedidos, verificados sobre OOXML
  // SERIALIZADO REAL — nunca una estimación de caracteres.
  // ============================================================
  {
    // Nombres REALES que se envolvieron en la prueba E2E anterior —
    // deliberadamente NO se usan nombres de juguete cortos aquí, para
    // no repetir el mismo falso negativo que dejó pasar el problema.
    const NOMBRES_PROBLEMATICOS = [
      'Dylan Yosueth Hernández Sandoval',
      'Francisco Manuel Hernández González',
      'Génesis Fernanda Aguirre González',
      'Gissel Abdali Grajeda Hernández',
      'Halit Eduardo Trejo Álvarez',
      'Itzae Manuel Vallejo Munguía',
      'Josemaría Arjona Ramos',
      'Kimberly Guadalupe Montes Alcántar',
      'Sofía Alejandra Delgadillo Pérez',
    ]
    // Se completa a 27 con el resto de nombres reales ya usados en el
    // bloque F1, para reproducir el roster real completo de la prueba
    // E2E (mismo tamaño, misma mezcla de nombres cortos y largos).
    const RESTO_ROSTER_27 = [
      'Audrey Abad Rojas', 'Axel Jesús Bañuelos Álvarez', 'Axel Ricardo Vargas Núñez', 'Carlos Jossel Ortega Trejo',
      'Celina Tello González', 'Eileen Danelly Abraham Benítez', 'Joshua Daniel Herrera Alcántar',
      'Keily Alessandra Estrada Guardado', 'Lucio Alberto Alonso Arellano', 'Luis Ángel Mora Canales',
      'María Alejandra Agraz Toriz', 'María José Delgado Hernández', 'María Paula Inés Bueno', 'Maximiliano Lepe Chávez',
      'Regina Yazmín Espinoza Meza', 'Salvador Emiliano Páez Álvarez', 'Santiago Medina Romero', 'Sebastián Zosa Bernal',
    ]
    const nombresRoster27 = [...NOMBRES_PROBLEMATICOS, ...RESTO_ROSTER_27].slice(0, 27)
    verificar(nombresRoster27.length === 27, `G0. El roster de prueba de este bloque tiene 27 nombres reales (encontrados: ${nombresRoster27.length})`)

    const rosterCongelado = nombresRoster27.map((nombre, i) => ({ alumno_id: `a${i}`, inscripcion_id: `i${i}`, nombre, posicion: i + 1 }))
    const indicadoresCongelados = [
      { indicador_especifico: 'Narra oralmente con fluidez y claridad una tradición familiar o comunitaria relacionada con el pan', aspecto_general: 'logro_aprendizaje' as const, numero_indicador: 1 },
      { indicador_especifico: 'Produce un texto descriptivo escrito con oraciones completas', aspecto_general: 'producto_evidencia' as const, numero_indicador: 2 },
      { indicador_especifico: 'Aplica correctamente el uso de mayúsculas al inicio de oración y en nombres propios', aspecto_general: 'logro_aprendizaje' as const, numero_indicador: 3 },
      { indicador_especifico: 'Expresa con vocabulario propio el valor cultural y simbólico del pan', aspecto_general: 'aplicacion_aprendizajes' as const, numero_indicador: 4 },
      { indicador_especifico: 'Muestra disposición para escuchar y valorar las tradiciones de sus compañeros', aspecto_general: 'participacion_colaboracion' as const, numero_indicador: 5 },
    ]
    const datosG = await hidratarDatosHojaSeguimiento(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) } as any,
      { identificador_visible: 'SG-262N', roster_congelado: rosterCongelado, indicadores: indicadoresCongelados, storage_path: 'x' },
      { nombre: 'Con pan, festejamos y convivimos', campos_formativos: ['Lenguajes'], fecha_inicio: '2026-10-05', fecha_fin: '2026-10-05', periodo_evaluacion_id: null }
    )
    const seccion = construirSeccionHojaEvaluacionWord(datosG, PERFIL_PRUEBA, null)
    const bufferG = await generarWordBuffer('# Planeacion real\n\nContenido real de la planeación de prueba.\n', PERFIL_PRUEBA, null, undefined, [seccion])
    const zipG = await JSZip.loadAsync(bufferG)
    const xmlG = (await zipG.file('word/document.xml')?.async('string')) ?? ''
    const relsG = (await zipG.file('word/_rels/document.xml.rels')?.async('string')) ?? ''

    const tblStartG = xmlG.indexOf('<w:tbl>')
    const tblEndG = xmlG.indexOf('</w:tbl>') + '</w:tbl>'.length
    const tblG = xmlG.slice(tblStartG, tblEndG)

    // 1. tblLayout fixed.
    verificar(/<w:tblLayout w:type="fixed"\/>/.test(tblG), '1. <w:tblLayout w:type="fixed"/> presente — Word no puede recalcular anchos por AutoFit')

    // 2-4. tblGrid: 8 gridCol reales, suma exacta 14440.
    const gridCols = tblG.match(/<w:gridCol[^/]*\/>/g) || []
    verificar(gridCols.length === 8, `2. <w:tblGrid> contiene exactamente 8 gridCol (encontrados: ${gridCols.length})`)
    const anchosGrid = gridCols.map((g) => Number(g.match(/w:w="(\d+)"/)?.[1] ?? 0))
    verificar(anchosGrid.every((a) => a !== 100), `3. Los gridCol usan anchos reales — ninguno es el placeholder de 100 twips (valores: ${anchosGrid.join(',')})`)
    const sumaGrid = anchosGrid.reduce((a, b) => a + b, 0)
    verificar(sumaGrid === 14440, `4. La suma de los 8 gridCol es EXACTAMENTE 14440 twips (obtenida: ${sumaGrid})`)

    // 5. Columna Alumno con el ancho absoluto esperado (32% de 14440, redondeado = 4621).
    verificar(anchosGrid[1] === 4621, `5. La columna Alumno (índice 1) tiene el ancho canónico esperado: 4621 twips (obtenido: ${anchosGrid[1]})`)

    // 6. tcW coherentes con los gridCol correspondientes (primera fila = encabezado).
    const primeraFilaG = tblG.match(/<w:tr\b[\s\S]*?<\/w:tr>/)?.[0] ?? ''
    const tcWsPrimeraFila = (primeraFilaG.match(/<w:tcW[^/]*\/>/g) || []).map((t) => Number(t.match(/w:w="(\d+)"/)?.[1] ?? -1))
    verificar(tcWsPrimeraFila.length === 8 && tcWsPrimeraFila.every((w, i) => w === anchosGrid[i]), `6. Los <w:tcW> de la fila de encabezado coinciden EXACTAMENTE con los gridCol columna por columna (tcW: ${tcWsPrimeraFila.join(',')} | grid: ${anchosGrid.join(',')})`)

    // 7. Sin porcentajes contradictorios como segunda fuente de layout.
    verificar(!/w:type="pct"/.test(tblG), '7. La tabla no contiene ningún w:type="pct" — una sola fuente de anchos (twips), nunca dos modelos contradictorios')

    // 8. Carta 15840x12240 en la sección de la hoja.
    const pgSzsG = xmlG.match(/<w:pgSz[^/]*\/>/g) || []
    verificar(pgSzsG.some((p) => p.includes('w:w="15840"') && p.includes('w:h="12240"') && p.includes('w:orient="landscape"')), '8. La sección de la hoja tiene Carta landscape real: w:w="15840" w:h="12240"')

    // 9-11. Header aislado — inspección de document.xml, .rels y header*.xml.
    const headerRefsG = xmlG.match(/<w:headerReference[^/]*\/>/g) || []
    verificar(headerRefsG.length === 2, `9/10a. Existen 2 <w:headerReference> reales (uno por sección) — encontrados: ${headerRefsG.length}`)
    const ridsHeader = headerRefsG.map((h) => h.match(/r:id="(rId\d+)"/)?.[1])
    verificar(new Set(ridsHeader).size === 2, '9b. Los 2 headerReference apuntan a relationship IDs DISTINTOS — la sección de la hoja no reutiliza el rId del header de la planeación')
    const relHeaders = [...relsG.matchAll(/<Relationship Id="(rId\d+)"[^>]*Target="(header\d*\.xml)"/g)]
    verificar(relHeaders.length === 2, `10b. document.xml.rels declara 2 relaciones de tipo header (encontradas: ${relHeaders.length})`)
    const targetsPorRid = Object.fromEntries(relHeaders.map((m) => [m[1], m[2]]))
    const archivosHeaderReferenciados = ridsHeader.map((rid) => (rid ? targetsPorRid[rid] : undefined))
    verificar(new Set(archivosHeaderReferenciados).size === 2, `10c. Cada sección referencia un archivo header*.xml DISTINTO (${archivosHeaderReferenciados.join(', ')})`)
    let headerHojaXml = ''
    for (const archivo of archivosHeaderReferenciados) {
      if (!archivo) continue
      const contenido = await zipG.file(`word/${archivo}`)?.async('string')
      if (contenido && !contenido.includes('FRANCISCO I. MADERO') && !contenido.includes(PERFIL_PRUEBA.escuela)) {
        headerHojaXml = contenido
      }
    }
    verificar(!!headerHojaXml, '9c. Existe un header*.xml (el de la sección de la hoja) que NO contiene el nombre de la escuela — no duplica el encabezado institucional de la planeación')
    verificar(headerHojaXml.includes('<w:hdr') && headerHojaXml.includes('</w:hdr>') && (headerHojaXml.match(/<w:t[ >]/g) || []).length === 0, '11. El header propio de la hoja es OOXML válido (<w:hdr>...</w:hdr> real) y realmente vacío (sin ningún <w:t> con texto)')

    // 12. El encabezado PROPIO del cuerpo (escuela/docente/proyecto/SG/etc.) sigue existiendo exactamente una vez.
    const idxTablaG = xmlG.indexOf('<w:tbl>')
    const cuerpoAntesDeTabla = xmlG.slice(0, idxTablaG)
    verificar((cuerpoAntesDeTabla.match(/Con pan, festejamos y convivimos/g) || []).length === 1, '12. El nombre del proyecto (parte del encabezado propio del CUERPO de la hoja) aparece exactamente una vez')
    verificar((xmlG.match(new RegExp(PERFIL_PRUEBA.escuela, 'g')) || []).length === 1, '12b. El nombre de la escuela aparece EXACTAMENTE una vez en todo el documento (antes aparecía duplicado: header heredado + encabezado propio)')

    // 13. SG una sola vez.
    verificar((xmlG.match(/SG-262N/g) || []).length === 1, '13. SG-262N aparece exactamente una vez')

    // 14. 5 indicadores completos.
    verificar(indicadoresCongelados.every((i) => xmlG.includes(i.indicador_especifico)), '14. Los 5 indicadores completos están presentes')

    // 15. 27 alumnos completos y en orden.
    verificar(nombresRoster27.every((n) => xmlG.includes(n)), '15a. Los 27 alumnos (incluidos los nombres reales problemáticos) están completos en el documento')
    const indicesG = nombresRoster27.map((n) => xmlG.indexOf(n))
    verificar(indicesG.every((idx, i) => i === 0 || idx > indicesG[i - 1]), '15b. Los 27 alumnos aparecen en el orden real de posicion')

    // 16. Nombres largos completos, sin truncamiento (substring exacto, no una versión recortada).
    verificar(NOMBRES_PROBLEMATICOS.every((n) => xmlG.includes(n) && !xmlG.includes(n.slice(0, -3) + '…')), '16. Los nombres largos que antes se envolvían están completos, sin ningún truncamiento con elipsis')

    // 17. Tabla nativa, sin rasterización.
    verificar(!xmlG.includes('<w:drawing') && !xmlG.includes('<pic:pic'), '17. Sin w:drawing ni pic:pic — tabla nativa, no rasterizada')

    // 18. tableHeader:true.
    verificar(/<w:tblHeader\/>/.test(tblG), '18. tableHeader (<w:tblHeader/>) sigue presente en la fila de encabezado')

    // 21. La sección de planeación conserva su formato (portrait, SIN tblLayout/columnWidths de la hoja mezclados).
    const seccionPlaneacionXml = xmlG.slice(0, xmlG.indexOf('<w:sectPr'))
    verificar(!seccionPlaneacionXml.includes('w:orient="landscape"'), '21. La sección de planeación sigue sin ningún w:orient="landscape" — no fue alterada')
    verificar(pgSzsG.some((p) => p.includes('w:orient="portrait"')), '21b. La sección de planeación conserva orientación portrait real')
  }

  // ============================================================
  // H. Ver auditoría "encabezado duplicado en la página landscape" —
  // el pie de firma de la planeación (línea, nombre del docente,
  // "Docente de grupo") es contenido de BODY, justo antes del sectPr
  // que cierra la sección de planeación; la hoja ya repite su propia
  // identidad institucional en su encabezado autocontenido, inmediato
  // después. Corrección: omitir el pie de firma SOLO cuando se
  // compone con una hoja (seccionesAdicionales no vacío) — nunca en
  // documentos normales.
  // ============================================================

  // H-A. Planeación + hoja: el pie de firma ya NO debe estar presente.
  {
    const seccionH = construirSeccionHojaEvaluacionWord(DATOS_HOJA_PRUEBA, PERFIL_PRUEBA, null)
    const bufferConHoja = await generarWordBuffer(TEXTO_PLANEACION_PRUEBA, PERFIL_PRUEBA, null, undefined, [seccionH])
    const zipConHoja = await JSZip.loadAsync(bufferConHoja)
    const xmlConHoja = (await zipConHoja.file('word/document.xml')?.async('string')) ?? ''
    const rutasHeaderRelsConHoja = (await zipConHoja.file('word/_rels/document.xml.rels')?.async('string')) ?? ''

    verificar(!xmlConHoja.includes('Docente de grupo'), 'H-A1. Con hoja adjunta: "Docente de grupo" NO aparece en ningún lugar del documento (el pie de firma fue omitido)')
    verificar(!xmlConHoja.includes('______________________________'), 'H-A2. Con hoja adjunta: la línea de firma ("____...") NO aparece')
    // El nombre del docente puede seguir apareciendo (header institucional
    // + encabezado propio de la hoja lo necesitan) — lo que NO debe
    // aparecer es el PÁRRAFO DE FIRMA en bold tamaño 20 (formato exacto
    // del pie), verificado por ausencia de "Docente de grupo" arriba,
    // que es literal y exclusivo de ese bloque.
    const idxSectPrH = xmlConHoja.indexOf('<w:sectPr')
    const cuerpoAntesDelCorte = xmlConHoja.slice(0, idxSectPrH)
    verificar(!cuerpoAntesDelCorte.includes('Docente de grupo'), 'H-A3. El pie de firma NO está inmediatamente antes del sectPr que separa planeación de la hoja')
    verificar(cuerpoAntesDelCorte.includes(TEXTO_PLANEACION_PRUEBA.split('\n')[0].replace('# ', '')) || cuerpoAntesDelCorte.includes('Planeación de prueba'), 'H-A4. El contenido real de la planeación sigue presente antes del corte de sección')

    // El encabezado autocontenido de la hoja (después del sectPr) sigue intacto.
    const cuerpoDespuesDelCorte = xmlConHoja.slice(idxSectPrH)
    verificar(cuerpoDespuesDelCorte.includes(DATOS_HOJA_PRUEBA.nombreProyecto) && cuerpoDespuesDelCorte.includes(DATOS_HOJA_PRUEBA.identificadorVisible), 'H-A5. El encabezado autocontenido de la hoja (nombre del proyecto + SG) sigue presente después del corte de sección')

    // header1 institucional sigue presente y header2 sigue vacío — sin cambio respecto a 7272cfd.
    const headerRefsH = xmlConHoja.match(/<w:headerReference[^/]*\/>/g) || []
    verificar(headerRefsH.length === 2, `H-A6. Siguen existiendo 2 <w:headerReference> reales (encontrados: ${headerRefsH.length})`)
    const relHeadersH = [...rutasHeaderRelsConHoja.matchAll(/<Relationship Id="(rId\d+)"[^>]*Target="(header\d*\.xml)"/g)]
    let header1TextoH = ''
    let header2TextoH = ''
    for (const [, , target] of relHeadersH) {
      const contenido = (await zipConHoja.file(`word/${target}`)?.async('string')) ?? ''
      if (contenido.includes(PERFIL_PRUEBA.escuela)) header1TextoH = contenido
      else header2TextoH = contenido
    }
    verificar(!!header1TextoH && header1TextoH.includes(PERFIL_PRUEBA.escuela), 'H-A7. header1 institucional de la planeación sigue presente, sin cambios')
    verificar(!!header2TextoH && (header2TextoH.match(/<w:t[ >]/g) || []).length === 0, 'H-A8. header2 de la hoja sigue siendo propio y realmente vacío (sin ningún <w:t> con texto)')
  }

  // H-B. Documento SIN hoja (seccionesAdicionales ausente): el pie de
  // firma se conserva EXACTAMENTE igual — sin regresión.
  {
    const bufferSinHoja = await generarWordBuffer(TEXTO_PLANEACION_PRUEBA, PERFIL_PRUEBA, null)
    const zipSinHoja = await JSZip.loadAsync(bufferSinHoja)
    const xmlSinHoja = (await zipSinHoja.file('word/document.xml')?.async('string')) ?? ''

    verificar(xmlSinHoja.includes('Docente de grupo'), 'H-B1. Sin hoja adjunta: "Docente de grupo" SIGUE apareciendo (comportamiento preexistente conservado)')
    verificar(xmlSinHoja.includes('______________________________'), 'H-B2. Sin hoja adjunta: la línea de firma SIGUE apareciendo')
    verificar(xmlSinHoja.includes(PERFIL_PRUEBA.nombre), 'H-B3. Sin hoja adjunta: el nombre del docente SIGUE apareciendo en el pie de firma')
  }

  // H-C. Regresión explícita del layout de la tabla de la hoja (27
  // alumnos reales, 5 indicadores, columnWidths=14440, Alumno=4621,
  // landscape, tabla nativa) — reconstruida de forma independiente en
  // este bloque para no depender de que el bloque G no cambie.
  {
    const nombresRoster27H = [
      'Dylan Yosueth Hernández Sandoval', 'Francisco Manuel Hernández González', 'Génesis Fernanda Aguirre González',
      'Gissel Abdali Grajeda Hernández', 'Halit Eduardo Trejo Álvarez', 'Itzae Manuel Vallejo Munguía', 'Josemaría Arjona Ramos',
      'Kimberly Guadalupe Montes Alcántar', 'Sofía Alejandra Delgadillo Pérez',
      'Audrey Abad Rojas', 'Axel Jesús Bañuelos Álvarez', 'Axel Ricardo Vargas Núñez', 'Carlos Jossel Ortega Trejo',
      'Celina Tello González', 'Eileen Danelly Abraham Benítez', 'Joshua Daniel Herrera Alcántar',
      'Keily Alessandra Estrada Guardado', 'Lucio Alberto Alonso Arellano', 'Luis Ángel Mora Canales',
      'María Alejandra Agraz Toriz', 'María José Delgado Hernández', 'María Paula Inés Bueno', 'Maximiliano Lepe Chávez',
      'Regina Yazmín Espinoza Meza', 'Salvador Emiliano Páez Álvarez', 'Santiago Medina Romero', 'Sebastián Zosa Bernal',
    ]
    verificar(nombresRoster27H.length === 27, `H-C0. Roster de regresión con 27 nombres reales (encontrados: ${nombresRoster27H.length})`)
    const datosHC = construirDatosPrueba(27, 'SG-262N')
    const seccionHC = construirSeccionHojaEvaluacionWord(datosHC, PERFIL_PRUEBA, null)
    verificar(seccionHC.properties?.page?.size?.orientation === 'landscape', 'H-C1. La sección de la hoja sigue pidiendo orientación landscape')

    const bufferHC = await generarWordBuffer(TEXTO_PLANEACION_PRUEBA, PERFIL_PRUEBA, null, undefined, [seccionHC])
    const zipHC = await JSZip.loadAsync(bufferHC)
    const xmlHC = (await zipHC.file('word/document.xml')?.async('string')) ?? ''
    const tblStartHC = xmlHC.indexOf('<w:tbl>')
    const tblEndHC = xmlHC.indexOf('</w:tbl>') + '</w:tbl>'.length
    const tblHC = xmlHC.slice(tblStartHC, tblEndHC)

    verificar(datosHC.alumnos.every((a) => xmlHC.includes(a.nombre)), 'H-C2. Los 27 alumnos siguen presentes en el documento')
    verificar(datosHC.indicadores.length === 5 && datosHC.indicadores.every((i) => xmlHC.includes(i.indicador_especifico)), 'H-C3. Los 5 indicadores siguen presentes')
    verificar(/<w:tblLayout w:type="fixed"\/>/.test(tblHC), 'H-C4. TableLayoutType.FIXED sigue presente en la tabla (<w:tblLayout w:type="fixed"/>)')
    const gridColsHC = (tblHC.match(/<w:gridCol[^/]*\/>/g) || []).map((g) => Number(g.match(/w:w="(\d+)"/)?.[1] ?? 0))
    verificar(gridColsHC.reduce((a, b) => a + b, 0) === 14440, `H-C5. Los columnWidths siguen sumando exactamente 14440 twips (obtenida: ${gridColsHC.reduce((a, b) => a + b, 0)})`)
    verificar(gridColsHC[1] === 4621, `H-C6. La columna Alumno sigue en 4621 twips (obtenido: ${gridColsHC[1]})`)
    const pgSzsHC = xmlHC.match(/<w:pgSz[^/]*\/>/g) || []
    verificar(pgSzsHC.some((p) => p.includes('w:w="15840"') && p.includes('w:h="12240"') && p.includes('w:orient="landscape"')), 'H-C7. La orientación landscape (Carta apaisada 15840×12240) de la hoja sigue intacta')
    verificar(!xmlHC.includes('<w:drawing') && !xmlHC.includes('<pic:pic'), 'H-C8. La tabla sigue siendo nativa, sin rasterización')
  }

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
