// scripts/verificar-analisis-hoja-multipagina.ts
//
// EVAL-1D.2 — pruebas deterministas (sin credenciales de Anthropic,
// sin red, sin datos reales) del soporte multipágina agregado a
// lib/seguimiento/analisisHojaEvaluacion.ts,
// lib/documentGen/generarHojaSeguimientoPdf.ts (calcularCantidadPaginasHoja)
// y app/api/proyectos-seguimiento/[id]/{foto-hoja,analizar-hoja}/route.ts.
//
// Las pruebas de UNA sola página (JPG/PNG/WEBP passthrough, conversión
// HEIC aislada, validación estructural de validarResultadoExtraccionHoja)
// ya viven en scripts/verificar-analisis-hoja-evaluacion.ts y NO se
// repiten aquí — este archivo cubre específicamente lo nuevo: cálculo
// real de páginas, varias fotografías en una sola llamada de visión,
// orden, fail-closed ante página faltante/exceso/conversión fallida, y
// compatibilidad retroactiva con captura_pendiente de una sola foto.
//
// Se ejecuta con `npx tsx scripts/verificar-analisis-hoja-multipagina.ts`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import type Anthropic from '@anthropic-ai/sdk'
import { CANTIDAD_INDICADORES_HOJA, type IndicadorProyecto } from '../lib/seguimiento/tipos'
import {
  generarHojaSeguimientoPdfBuffer,
  calcularCantidadPaginasHoja,
} from '../lib/documentGen/generarHojaSeguimientoPdf'
import {
  analizarImagenesHojaEvaluacion,
  normalizarImagenesHojaParaVision,
  extraerFotosCapturaPendiente,
  MAXIMO_PAGINAS_HOJA,
  type ConvertidorHeic,
} from '../lib/seguimiento/analisisHojaEvaluacion'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

function celda(numeroIndicador: number, valor: number) {
  return { numeroIndicador, digitosDetectados: [valor], confianza: 'alta' as const }
}
function filaCompleta(posicion: number, valor: number) {
  return { posicion, celdas: Array.from({ length: CANTIDAD_INDICADORES_HOJA }, (_, i) => celda(i + 1, valor)) }
}

// Doble mínimo de Anthropic que cuenta invocaciones y captura el
// content real enviado — mismo criterio ya usado en
// verificar-analisis-hoja-evaluacion.ts.
function crearAnthropicFalso(respuesta: unknown) {
  let llamadas = 0
  const contenidosEnviados: Array<Array<{ type: string; source?: { data: string; media_type: string }; text?: string }>> = []
  const anthropic = {
    messages: {
      create: async (params: { messages: Array<{ content: typeof contenidosEnviados[number] }> }) => {
        llamadas++
        contenidosEnviados.push(params.messages[0].content)
        return { content: [{ type: 'text', text: JSON.stringify(respuesta) }] }
      },
    },
  } as unknown as Anthropic
  return { anthropic, contarLlamadas: () => llamadas, contenidosEnviados }
}

const PERFIL_FALSO = { nombre: 'Docente de prueba', escuela: 'Escuela primaria de prueba', grado: '4°', grupo: 'B' }
const INDICADORES: IndicadorProyecto[] = [
  { indicador_especifico: 'Identifica ideas principales de un texto informativo breve', aspecto_general: 'logro_aprendizaje' },
  { indicador_especifico: 'Cuenta colecciones hasta 100 con correspondencia uno a uno', aspecto_general: 'logro_aprendizaje' },
  { indicador_especifico: 'Sigue instrucciones de dos pasos de forma autónoma y sin apoyo', aspecto_general: 'autonomia' },
  { indicador_especifico: 'Participa activamente en el trabajo colaborativo del equipo', aspecto_general: 'participacion_colaboracion' },
  { indicador_especifico: 'Entrega el producto final con las evidencias solicitadas por el docente', aspecto_general: 'producto_evidencia' },
]

function alumnosFalsos(n: number) {
  return Array.from({ length: n }, (_, i) => ({ nombre: `Alumno número ${i + 1} con nombre y apellidos de longitud típica`, posicion: i + 1 }))
}

async function generarPdfReal(n: number) {
  const datos = {
    nombreProyecto: 'Diagnóstico de inicio de ciclo',
    camposFormativos: ['Lenguajes', 'Saberes y Pensamiento Científico'],
    trimestreNombre: 'Primer trimestre',
    fechaInicio: '2026-08-03',
    fechaFin: '2026-08-18',
    identificadorVisible: 'VISTA PREVIA — PENDIENTE DE APROBACIÓN',
    indicadores: INDICADORES,
    alumnos: alumnosFalsos(n),
  }
  const buffer = await generarHojaSeguimientoPdfBuffer(datos, PERFIL_FALSO, 'America/Mexico_City')
  const pdfDoc = await PDFDocument.load(buffer)
  return pdfDoc.getPageCount()
}

async function main() {
  // ============================================================
  // 1. calcularCantidadPaginasHoja == pageCount del PDF real, en
  //    varios tamaños, incluyendo los límites donde cambia de 1 a 2
  //    páginas (y de 2 a 3). Nunca una aproximación: se renderiza el
  //    PDF de verdad con pdf-lib y se compara contra el resultado.
  // ============================================================
  {
    const tamanos = [1, 2, 15, 27, 28, 29, 30, 31, 32, 33, 50, 60, 67, 68, 69, 100]
    let todosCoinciden = true
    for (const n of tamanos) {
      const paginasReales = await generarPdfReal(n)
      const calculado = calcularCantidadPaginasHoja(n)
      if (paginasReales !== calculado) {
        todosCoinciden = false
        console.error(`  ✗ discrepancia en n=${n}: PDF real=${paginasReales}, calculado=${calculado}`)
      }
    }
    verificar(todosCoinciden, `1. calcularCantidadPaginasHoja coincide EXACTAMENTE con pdf-lib.getPageCount() del PDF real para ${tamanos.length} tamaños distintos, incluyendo los cambios de página`)
  }

  // ============================================================
  // 2. Una hoja de 28 alumnos (fixture real ya usado en
  //    verificar-maquetacion-hoja-evaluacion.ts) sigue siendo de 1
  //    sola página — el caso de 1 página nunca se rompe.
  // ============================================================
  {
    verificar(calcularCantidadPaginasHoja(28) === 1, '2. Una hoja de 28 alumnos sigue calculando exactamente 1 página (caso real ya validado en producción)')
  }

  const BUF_JPG_1 = Buffer.from('pagina-1-contenido-jpg')
  const BUF_JPG_2 = Buffer.from('pagina-2-contenido-jpg')
  const BUF_HEIC_1 = Buffer.from('pagina-1-contenido-heic')
  const respuesta2Filas = { hojaLegible: true, filas: [filaCompleta(1, 4), filaCompleta(2, 3)] }

  // ============================================================
  // 3. 1 página JPG — flujo completo (normalizar + analizar) sigue
  //    funcionando idéntico con un arreglo de 1 elemento.
  // ============================================================
  {
    const { anthropic, contarLlamadas } = crearAnthropicFalso({ hojaLegible: true, filas: [filaCompleta(1, 4)] })
    const imagenes = await normalizarImagenesHojaParaVision([{ buffer: BUF_JPG_1, extension: 'jpg' }])
    const r = await analizarImagenesHojaEvaluacion(anthropic, imagenes, 1)
    verificar(contarLlamadas() === 1, '3. 1 página JPG: exactamente 1 llamada IA')
    verificar(r.filas.length === 1, '3b. 1 página JPG: se extrae la única fila esperada')
  }

  // ============================================================
  // 4. 1 página HEIC — la conversión ocurre antes de la única
  //    llamada IA, y la IA recibe image/jpeg, nunca HEIC.
  // ============================================================
  {
    const convertidor: ConvertidorHeic = async () => new Uint8Array([0xff, 0xd8, 0xff])
    const { anthropic, contarLlamadas, contenidosEnviados } = crearAnthropicFalso({ hojaLegible: true, filas: [filaCompleta(1, 4)] })
    const imagenes = await normalizarImagenesHojaParaVision([{ buffer: BUF_HEIC_1, extension: 'heic' }], convertidor)
    await analizarImagenesHojaEvaluacion(anthropic, imagenes, 1)
    verificar(contarLlamadas() === 1, '4. 1 página HEIC: exactamente 1 llamada IA')
    const bloqueImagen = contenidosEnviados[0].find((b) => b.type === 'image')
    verificar(bloqueImagen?.source?.media_type === 'image/jpeg', '4b. 1 página HEIC: la IA recibe la imagen ya convertida como image/jpeg')
  }

  // ============================================================
  // 5. 2 páginas JPG — UNA sola llamada IA con AMBOS bloques de
  //    imagen dentro del mismo content, nunca una llamada por foto.
  // ============================================================
  {
    const { anthropic, contarLlamadas, contenidosEnviados } = crearAnthropicFalso(respuesta2Filas)
    const imagenes = await normalizarImagenesHojaParaVision([
      { buffer: BUF_JPG_1, extension: 'jpg' },
      { buffer: BUF_JPG_2, extension: 'jpg' },
    ])
    const r = await analizarImagenesHojaEvaluacion(anthropic, imagenes, 2)
    verificar(contarLlamadas() === 1, '5. 2 páginas JPG: exactamente 1 llamada IA total (nunca 1 por foto)')
    const bloquesImagen = contenidosEnviados[0].filter((b) => b.type === 'image')
    verificar(bloquesImagen.length === 2, '5b. 2 páginas JPG: el ÚNICO mensaje enviado contiene 2 bloques de imagen')
    const bloquesTexto = contenidosEnviados[0].filter((b) => b.type === 'text')
    verificar(bloquesTexto.length === 1, '5c. 2 páginas JPG: exactamente 1 bloque de texto (instrucciones) en el mismo mensaje')
    verificar(r.filas.length === 2, '5d. 2 páginas JPG: se extraen las filas de ambas páginas del resultado')
  }

  // ============================================================
  // 6. Mezcla HEIC + JPG — cada imagen se normaliza según su propio
  //    formato (solo la HEIC pasa por conversión), y AMBAS llegan
  //    igual a la única llamada IA.
  // ============================================================
  {
    let vecesConvertidor = 0
    const convertidor: ConvertidorHeic = async () => { vecesConvertidor++; return new Uint8Array([0xff, 0xd8, 0xff]) }
    const { anthropic, contarLlamadas, contenidosEnviados } = crearAnthropicFalso(respuesta2Filas)
    const imagenes = await normalizarImagenesHojaParaVision(
      [
        { buffer: BUF_HEIC_1, extension: 'heic' },
        { buffer: BUF_JPG_2, extension: 'jpg' },
      ],
      convertidor
    )
    await analizarImagenesHojaEvaluacion(anthropic, imagenes, 2)
    verificar(vecesConvertidor === 1, '6. Mezcla HEIC+JPG: el convertidor HEIC se invoca exactamente 1 vez (solo para la foto HEIC, nunca para la JPG)')
    verificar(contarLlamadas() === 1, '6b. Mezcla HEIC+JPG: sigue siendo exactamente 1 llamada IA total')
    const bloquesImagen = contenidosEnviados[0].filter((b) => b.type === 'image')
    verificar(bloquesImagen.length === 2, '6c. Mezcla HEIC+JPG: ambas páginas llegan como bloques de imagen a la misma llamada')
    verificar(bloquesImagen[0].source?.media_type === 'image/jpeg' && bloquesImagen[1].source?.media_type === 'image/jpeg', '6d. Mezcla HEIC+JPG: ambos bloques llegan como image/jpeg (la HEIC convertida, la JPG ya lo era)')
  }

  // ============================================================
  // 7. Preservación exacta del orden página 1 -> página 2 -> página 3.
  // ============================================================
  {
    const BUF_P1 = Buffer.from('CONTENIDO-UNICO-PAGINA-1')
    const BUF_P2 = Buffer.from('CONTENIDO-UNICO-PAGINA-2')
    const BUF_P3 = Buffer.from('CONTENIDO-UNICO-PAGINA-3')
    const { anthropic, contenidosEnviados } = crearAnthropicFalso({ hojaLegible: true, filas: [filaCompleta(1, 4), filaCompleta(2, 3), filaCompleta(3, 2)] })
    const imagenes = await normalizarImagenesHojaParaVision([
      { buffer: BUF_P1, extension: 'jpg' },
      { buffer: BUF_P2, extension: 'jpg' },
      { buffer: BUF_P3, extension: 'jpg' },
    ])
    await analizarImagenesHojaEvaluacion(anthropic, imagenes, 3)
    const bloquesImagen = contenidosEnviados[0].filter((b) => b.type === 'image')
    verificar(
      bloquesImagen[0].source?.data === BUF_P1.toString('base64') &&
        bloquesImagen[1].source?.data === BUF_P2.toString('base64') &&
        bloquesImagen[2].source?.data === BUF_P3.toString('base64'),
      '7. El orden de los bloques de imagen enviados a la IA coincide EXACTAMENTE con el orden de entrada (página 1 -> 2 -> 3), sin importar el contenido de cada una'
    )
  }

  // ============================================================
  // 8. Una conversión HEIC fallida (en cualquier página del lote) =>
  //    fail-closed ANTES de la IA — 0 llamadas IA, ninguna página del
  //    lote se analiza.
  // ============================================================
  {
    const convertidorQueFalla: ConvertidorHeic = async () => { throw new Error('HEIC corrupto simulado (página 2)') }
    const { anthropic, contarLlamadas } = crearAnthropicFalso(respuesta2Filas)
    let lanzo = false
    try {
      const imagenes = await normalizarImagenesHojaParaVision(
        [
          { buffer: BUF_JPG_1, extension: 'jpg' }, // página 1 SÍ es válida
          { buffer: BUF_HEIC_1, extension: 'heic' }, // página 2 falla al convertir
        ],
        convertidorQueFalla
      )
      await analizarImagenesHojaEvaluacion(anthropic, imagenes, 2)
    } catch {
      lanzo = true
    }
    verificar(lanzo, '8. Una conversión HEIC fallida en cualquier página rechaza el lote completo (fail-closed)')
    verificar(contarLlamadas() === 0, '8b. Ninguna llamada IA ocurre — ni siquiera con la página 1, que sí era válida (nunca se analiza un subconjunto)')
  }

  // ============================================================
  // 9. Exceso de fotografías — rechazo antes de gastar la llamada IA.
  // ============================================================
  {
    const { anthropic, contarLlamadas } = crearAnthropicFalso({ hojaLegible: true, filas: [] })
    const demasiadas = Array.from({ length: MAXIMO_PAGINAS_HOJA + 1 }, (_, i) => ({ base64: Buffer.from(`p${i}`).toString('base64'), mediaType: 'image/jpeg' as const }))
    let lanzo = false
    try {
      await analizarImagenesHojaEvaluacion(anthropic, demasiadas, 50)
    } catch {
      lanzo = true
    }
    verificar(lanzo, `9. Más de ${MAXIMO_PAGINAS_HOJA} fotografías se rechazan explícitamente`)
    verificar(contarLlamadas() === 0, '9b. El rechazo por exceso ocurre ANTES de invocar anthropic.messages.create (0 llamadas IA)')
  }

  // ============================================================
  // 10. Página ilegible en un lote multipágina: rechaza TODO el
  //     resultado, nunca persiste las páginas que sí parecían legibles.
  // ============================================================
  {
    const { anthropic } = crearAnthropicFalso({ hojaLegible: false, filas: [] })
    const imagenes = await normalizarImagenesHojaParaVision([
      { buffer: BUF_JPG_1, extension: 'jpg' },
      { buffer: BUF_JPG_2, extension: 'jpg' },
    ])
    let lanzo = false
    try {
      await analizarImagenesHojaEvaluacion(anthropic, imagenes, 2)
    } catch {
      lanzo = true
    }
    verificar(lanzo, '10. hojaLegible=false en un análisis multipágina rechaza TODO el resultado — nunca se aceptan filas parciales de las páginas que sí se pudieron leer')
  }

  // ============================================================
  // 11. Fail-closed estructural: analizar-hoja/route.ts rechaza el
  //     análisis ANTES de descargar/normalizar/llamar IA si el número
  //     de fotos cargadas no coincide con calcularCantidadPaginasHoja.
  // ============================================================
  {
    const rutaContenido = readFileSync(join(__dirname, '..', 'app', 'api', 'proyectos-seguimiento', '[id]', 'analizar-hoja', 'route.ts'), 'utf-8')
    verificar(rutaContenido.includes('calcularCantidadPaginasHoja'), '11. analizar-hoja/route.ts usa calcularCantidadPaginasHoja para saber cuántas páginas espera esta hoja')
    verificar(/fotos\.length !== paginasEsperadas/.test(rutaContenido), '11b. Rechaza explícitamente si fotos.length !== paginasEsperadas (tanto de menos como de más)')
    // La validación de páginas debe ocurrir ANTES de descargarBuffer —
    // nunca se descarga ni normaliza nada de un lote incompleto/excedido.
    const idxValidacion = rutaContenido.indexOf('fotos.length !== paginasEsperadas')
    const idxDescarga = rutaContenido.indexOf('descargarBuffer(supabase, foto.storagePath')
    verificar(idxValidacion > -1 && idxDescarga > -1 && idxValidacion < idxDescarga, '11c. La validación de páginas ocurre ANTES de descargar ninguna fotografía de Storage')
  }

  // ============================================================
  // 12. 0 escrituras en seguimiento_resultados en TODOS los archivos
  //     tocados por EVAL-1D.2 (estructural).
  // ============================================================
  {
    const libContenido = readFileSync(join(__dirname, '..', 'lib', 'seguimiento', 'analisisHojaEvaluacion.ts'), 'utf-8')
    const fotoRuta = readFileSync(join(__dirname, '..', 'app', 'api', 'proyectos-seguimiento', '[id]', 'foto-hoja', 'route.ts'), 'utf-8')
    const analizarRuta = readFileSync(join(__dirname, '..', 'app', 'api', 'proyectos-seguimiento', '[id]', 'analizar-hoja', 'route.ts'), 'utf-8')
    verificar(!libContenido.includes(".from('seguimiento_resultados')"), '12. analisisHojaEvaluacion.ts (con soporte multipágina) sigue sin escribir en seguimiento_resultados')
    verificar(!fotoRuta.includes(".from('seguimiento_resultados')"), '12b. foto-hoja/route.ts (con soporte multipágina) sigue sin escribir en seguimiento_resultados')
    verificar(!analizarRuta.includes(".from('seguimiento_resultados')"), '12c. analizar-hoja/route.ts (con soporte multipágina) sigue sin escribir en seguimiento_resultados')
  }

  // ============================================================
  // 13. 0 llamadas IA adicionales: exactamente 1 referencia a
  //     anthropic.messages.create en todo el archivo, sin importar
  //     cuántas páginas soporte.
  // ============================================================
  {
    const libContenido = readFileSync(join(__dirname, '..', 'lib', 'seguimiento', 'analisisHojaEvaluacion.ts'), 'utf-8')
    verificar((libContenido.match(/anthropic\.messages\.create/g) || []).length === 1, '13. analisisHojaEvaluacion.ts contiene exactamente 1 referencia a anthropic.messages.create, incluso con el soporte multipágina agregado')
  }

  // ============================================================
  // 14. Compatibilidad con captura_pendiente histórica de 1 sola foto
  //     (forma escrita por EVAL-1C antes de EVAL-1D.2, sin "fotos").
  // ============================================================
  {
    const capturaHistorica = { fotoStoragePath: 'docentes/abc/foto-SG-VXKR.jpg', fotoSubidaEn: '2026-08-01T10:00:00.000Z' }
    const fotos = extraerFotosCapturaPendiente(capturaHistorica)
    verificar(fotos.length === 1, '14. Una captura_pendiente histórica (solo fotoStoragePath) se lee como exactamente 1 foto')
    verificar(fotos[0]?.pagina === 1, '14b. La foto histórica se interpreta siempre como página 1')
    verificar(fotos[0]?.storagePath === capturaHistorica.fotoStoragePath, '14c. La ruta real del archivo histórico se preserva sin modificar')

    // Forma nueva (EVAL-1D.2) con varias páginas, deliberadamente
    // fuera de orden, para confirmar que también aquí se reordena.
    const capturaNueva = {
      fotos: [
        { storagePath: 'docentes/abc/foto-SG-XYZ-p2.jpg', pagina: 2, subidaEn: '2026-09-25T10:05:00.000Z' },
        { storagePath: 'docentes/abc/foto-SG-XYZ-p1.jpg', pagina: 1, subidaEn: '2026-09-25T10:00:00.000Z' },
      ],
    }
    const fotosNuevas = extraerFotosCapturaPendiente(capturaNueva)
    verificar(fotosNuevas.length === 2 && fotosNuevas[0].pagina === 1 && fotosNuevas[1].pagina === 2, '14d. captura_pendiente.fotos (forma nueva) se lee completa y SIEMPRE ordenada por página ascendente, sin importar el orden de escritura en el arreglo')

    // Fail-closed: páginas duplicadas en el arreglo nunca se aceptan
    // en silencio (no se adivina cuál copia es la buena).
    const capturaCorrupta = { fotos: [{ storagePath: 'a.jpg', pagina: 1, subidaEn: 'x' }, { storagePath: 'b.jpg', pagina: 1, subidaEn: 'y' }] }
    verificar(extraerFotosCapturaPendiente(capturaCorrupta).length === 0, '14e. Páginas duplicadas dentro de captura_pendiente.fotos se rechazan por completo (fail-closed), nunca se adivina cuál es la correcta')

    // Ausencia total (proyecto recién creado, sin ninguna fotografía).
    verificar(extraerFotosCapturaPendiente(null).length === 0, '14f. captura_pendiente=null se lee como 0 fotos (proyecto sin ninguna fotografía cargada todavía)')
    verificar(extraerFotosCapturaPendiente({}).length === 0, '14g. captura_pendiente={} (sin fotos ni fotoStoragePath) se lee como 0 fotos')
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
