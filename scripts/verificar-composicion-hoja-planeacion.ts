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

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
