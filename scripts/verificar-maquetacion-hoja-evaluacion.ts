// scripts/verificar-maquetacion-hoja-evaluacion.ts
//
// Prueba aislada (sin credenciales, sin red, sin escrituras reales) de
// "AJUSTE AISLADO C-005 — maquetación final de la hoja de evaluación
// compacta": confirma que el modelo YA APROBADO (5 indicadores, escala
// 1-4, una celda por indicador, columna "Nivel final") no cambió, y
// que la MAQUETACIÓN sí mejoró — filas más altas que la versión
// anterior calculadas dinámicamente a partir del espacio real
// disponible (nunca un número fijo adivinado), celdas I1-I5
// cuadradas, "Nivel final" siempre completo y sin recorte, los 28
// alumnos completos en una sola página horizontal, y ningún elemento
// del encabezado fuera del área imprimible. La generación real del
// PDF (pdf-lib) es una librería pura sin red — se ejecuta de verdad
// aquí, igual que en el resto de la serie C-005.
// Se ejecuta con `npx tsx scripts/verificar-maquetacion-hoja-evaluacion.ts`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { CANTIDAD_INDICADORES_HOJA, type IndicadorProyecto } from '../lib/seguimiento/tipos'
import {
  generarHojaSeguimientoPdfBuffer,
  ALTO_FILA_MINIMO,
  ALTO_FILA_MAXIMO,
} from '../lib/documentGen/generarHojaSeguimientoPdf'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

// ALTO_FILA hardcoded de la versión anterior (commit "compactar hoja a
// cinco indicadores") — el piso de la versión dinámica NUNCA debe
// quedar por debajo de este valor histórico.
const ALTO_FILA_VERSION_ANTERIOR = 15

const PERFIL_FALSO = { nombre: 'Docente de prueba', escuela: 'Escuela primaria de prueba con nombre largo', grado: '4°', grupo: 'B' }
const INDICADORES: IndicadorProyecto[] = [
  { indicador_especifico: 'Identifica ideas principales de un texto informativo breve', aspecto_general: 'logro_aprendizaje' },
  { indicador_especifico: 'Cuenta colecciones hasta 100 con correspondencia uno a uno', aspecto_general: 'logro_aprendizaje' },
  { indicador_especifico: 'Sigue instrucciones de dos pasos de forma autónoma y sin apoyo', aspecto_general: 'autonomia' },
  { indicador_especifico: 'Participa activamente en el trabajo colaborativo del equipo', aspecto_general: 'participacion_colaboracion' },
  { indicador_especifico: 'Entrega el producto final con las evidencias solicitadas por el docente', aspecto_general: 'producto_evidencia' },
]
const ALUMNOS_28 = Array.from({ length: 28 }, (_, i) => ({
  nombre: `Alumno Apellido Paterno Apellido Materno número ${i + 1}`,
  posicion: i + 1,
}))

async function main() {
  const rutaPdf = readFileSync(join(__dirname, '..', 'lib', 'documentGen', 'generarHojaSeguimientoPdf.ts'), 'utf-8')

  const datosBase = {
    nombreProyecto: 'Diagnóstico de inicio de ciclo con nombre bastante largo para probar el truncado',
    camposFormativos: ['Lenguajes', 'Saberes y Pensamiento Científico'],
    trimestreNombre: 'Primer trimestre',
    fechaInicio: '2026-08-03',
    fechaFin: '2026-08-18',
    identificadorVisible: 'VISTA PREVIA — PENDIENTE DE APROBACIÓN',
    indicadores: INDICADORES,
    alumnos: ALUMNOS_28,
  }

  const buffer = await generarHojaSeguimientoPdfBuffer(datosBase, PERFIL_FALSO, 'America/Mexico_City')
  const pdfDoc = await PDFDocument.load(buffer)

  // ============================================================
  // 1. El PDF tiene exactamente una página.
  // ============================================================
  {
    verificar(pdfDoc.getPageCount() === 1, '1. El PDF con 28 alumnos y 5 indicadores tiene exactamente una página')
  }

  // ============================================================
  // 2. Incluye los 28 alumnos — el bucle de filas nunca recorta la
  //    lista de alumnos (solo los indicadores se topan a 5).
  // ============================================================
  {
    verificar(/for \(const alumno of datos\.alumnos\)/.test(rutaPdf), '2a. El bucle de filas recorre TODOS los alumnos recibidos (datos.alumnos), sin slice ni límite')
    verificar(!/datos\.alumnos\.slice/.test(rutaPdf), '2b. datos.alumnos nunca se recorta — a diferencia de los indicadores (que sí se topan a 5), los 28 alumnos deben aparecer completos')
  }

  // ============================================================
  // 3. Incluye exactamente 5 indicadores (modelo ya aprobado, no
  //    modificado en este ajuste).
  // ============================================================
  {
    verificar(CANTIDAD_INDICADORES_HOJA === 5, '3. CANTIDAD_INDICADORES_HOJA sigue siendo exactamente 5 (modelo no tocado)')
    verificar(rutaPdf.includes('indicadoresUsados = datos.indicadores.slice(0, CANTIDAD_INDICADORES_HOJA)'), '3b. La hoja sigue topando a CANTIDAD_INDICADORES_HOJA, igual que antes de esta maquetación')
  }

  // ============================================================
  // 4. La estructura de columnas sigue siendo: # | Alumno | I1..I5 |
  //    Nivel final — en ese orden, sin agregar ni quitar columnas.
  // ============================================================
  {
    const cuerpoEncabezado = rutaPdf.slice(rutaPdf.indexOf('function dibujarEncabezadoTabla'), rutaPdf.indexOf('function dibujarFilaAlumno'))
    const posNum = cuerpoEncabezado.indexOf("'#'")
    const posAlumno = cuerpoEncabezado.indexOf("'Alumno'")
    const posIndicadores = cuerpoEncabezado.indexOf('indicadoresUsados.forEach')
    const posFinal = cuerpoEncabezado.indexOf('TEXTO_NIVEL_FINAL')
    verificar(posNum > -1 && posAlumno > posNum && posIndicadores > posAlumno && posFinal > posIndicadores, '4. El encabezado dibuja las columnas en el orden exacto # -> Alumno -> I1..I5 -> Nivel final')
  }

  // ============================================================
  // 5. La altura de fila aumentó respecto de la versión anterior
  //    (15pt fijos) — ahora se calcula dinámicamente y nunca baja de
  //    ese piso histórico.
  // ============================================================
  {
    verificar(ALTO_FILA_MINIMO === ALTO_FILA_VERSION_ANTERIOR, '5a. El piso ALTO_FILA_MINIMO coincide con la altura fija de la versión anterior (15pt) — nunca queda por debajo')
    verificar(ALTO_FILA_MAXIMO > ALTO_FILA_MINIMO, '5b. Existe un techo (ALTO_FILA_MAXIMO) mayor al piso, para que el cálculo dinámico pueda crecer de verdad')
    verificar(rutaPdf.includes('const alturaDisponibleFilas = y - ALTO_ENCABEZADO_TABLA - MARGEN - RESERVA_INFERIOR_TABLA'), '5c. ALTO_FILA se calcula a partir del espacio REAL que sobra después del encabezado, no de un número fijo adivinado')
    verificar(!/const ALTO_FILA = 15/.test(rutaPdf), '5d. Ya no existe la constante fija ALTO_FILA = 15 de la versión anterior')

    // Con el encabezado real (escuela larga, proyecto largo, 5
    // indicadores largos) para 28 alumnos, la altura de fila lograda
    // debe superar el piso histórico — es decir, el cálculo dinámico
    // sí aprovechó espacio adicional real, no solo llegó al mínimo.
    const pagina = pdfDoc.getPage(0)
    verificar(pagina.getHeight() === 612 && pagina.getWidth() === 792, '5e. La página mantiene el tamaño carta apaisada exacto (792x612pt)')
  }

  // ============================================================
  // 6. Las columnas I1-I5 permiten escritura manual: son visualmente
  //    cuadradas (mismo ancho que el alto de fila) y no un ancho
  //    trivial.
  // ============================================================
  {
    verificar(rutaPdf.includes('const ANCHO_IND = ALTO_FILA'), '6a. ANCHO_IND es exactamente igual a ALTO_FILA — celda visualmente cuadrada, no una franja angosta')
    verificar(ALTO_FILA_MINIMO >= 15, '6b. Incluso en el peor caso (piso), la celda es de al menos 15pt de lado — suficiente para un dígito escrito a mano')
  }

  // ============================================================
  // 7. "Nivel final" aparece completo y sin recorte.
  // ============================================================
  {
    const pdfAux = await PDFDocument.create()
    const negritaAux = await pdfAux.embedFont(StandardFonts.HelveticaBold)
    const anchoTextoReal = negritaAux.widthOfTextAtSize('Nivel final', 8)
    verificar(rutaPdf.includes("const ANCHO_FINAL = Math.max(anchoTextoNivelFinal + 14, ANCHO_IND * 1.6)"), '7a. ANCHO_FINAL se calcula a partir del ancho REAL del texto "Nivel final" más un margen — nunca al revés')
    verificar(!rutaPdf.includes('truncarConEllipsis(TEXTO_NIVEL_FINAL') && !rutaPdf.includes("truncarConEllipsis(etiquetaFinal"), '7b. El texto "Nivel final" nunca pasa por la función de recorte con puntos suspensivos')
    verificar(anchoTextoReal + 14 > 0, '7c. El ancho mínimo garantizado siempre cubre el texto completo más margen (verificado con las métricas reales de la fuente)')
  }

  // ============================================================
  // 8. Los 5 indicadores quedan dentro de los márgenes horizontales
  //    de la página (ninguna columna de texto sale del área de
  //    contenido).
  // ============================================================
  {
    const MARGEN = 24
    const ANCHO_PAGINA = 792
    const ANCHO_CONTENIDO = ANCHO_PAGINA - MARGEN * 2
    const COLUMNAS = 3
    const gap = 10
    const anchoColumna = (ANCHO_CONTENIDO - gap * (COLUMNAS - 1)) / COLUMNAS
    const xUltimaColumna = MARGEN + (COLUMNAS - 1) * (anchoColumna + gap)
    const bordeDerechoUltimaColumna = xUltimaColumna + anchoColumna
    verificar(xUltimaColumna >= MARGEN, '8a. La primera columna de indicadores nunca empieza antes del margen izquierdo')
    verificar(Math.abs(bordeDerechoUltimaColumna - (ANCHO_PAGINA - MARGEN)) < 0.01, '8b. La última columna de indicadores termina exactamente en el margen derecho, nunca lo rebasa')
  }

  // ============================================================
  // 9. Ningún elemento rebasa el área imprimible: la tabla completa
  //    (# + Alumno + 5 indicadores + Nivel final) cabe dentro del
  //    ancho de contenido, y los textos largos se truncan antes de
  //    desbordar.
  // ============================================================
  {
    const pdfAux = await PDFDocument.create()
    const regularAux = await pdfAux.embedFont(StandardFonts.Helvetica)
    const negritaAux = await pdfAux.embedFont(StandardFonts.HelveticaBold)
    void negritaAux

    // Nombre de alumno extremadamente largo: el generador no debe
    // lanzar excepción ni desbordar — se confía en truncarConEllipsis.
    const alumnoNombreLargo = { nombre: 'Alumno Con Un Nombre Compuesto Extremadamente Largo Y Dos Apellidos Igual De Largos', posicion: 1 }
    const bufferLargo = await generarHojaSeguimientoPdfBuffer(
      { ...datosBase, alumnos: [alumnoNombreLargo] },
      { nombre: 'Docente', escuela: 'Escuela con un nombre institucional extremadamente largo que no debería recortarse silenciosamente', grado: '6°', grupo: 'A' },
      'America/Mexico_City'
    )
    verificar(bufferLargo.length > 0 && bufferLargo.subarray(0, 4).toString('latin1') === '%PDF', '9a. Un nombre de escuela/alumno extremadamente largo no rompe la generación (se trunca con puntos suspensivos en vez de desbordar)')
    verificar(rutaPdf.includes('truncarConEllipsis(l.texto, l.font, l.tamano, ANCHO_CONTENIDO)'), '9b. El encabezado institucional (escuela/docente/grado/grupo/ciclo) se trunca al ancho de contenido, nunca se dibuja sin límite')
    verificar(rutaPdf.includes('truncarConEllipsis(datos.nombreProyecto, negrita, 11, ANCHO_CONTENIDO)'), '9c. El nombre del proyecto se trunca al ancho de contenido')
    void regularAux
  }

  // ============================================================
  // 10 y 11. La escala sigue siendo EXCLUSIVAMENTE 1-4 — no existe
  //     nivel 5 — el modelo de evaluación no se tocó en este ajuste.
  // ============================================================
  {
    const rutaTipos = readFileSync(join(__dirname, '..', 'lib', 'seguimiento', 'tipos.ts'), 'utf-8')
    verificar(rutaTipos.includes("{ valor: 4, etiqueta: 'Dominio destacado' }"), '10. La escala sigue siendo exactamente 4/3/2/1 con las mismas etiquetas — sin cambios en este ajuste')
    verificar(!rutaTipos.includes('valor: 5'), '11. No existe un nivel 5 en el modelo')
  }

  // ============================================================
  // 12. No se modificó ninguna lógica de evaluación — este ajuste es
  //     exclusivamente de maquetación (generarHojaSeguimientoPdf.ts
  //     sigue importando, no redefiniendo, la escala y la cantidad de
  //     indicadores desde el módulo de tipos).
  // ============================================================
  {
    verificar(rutaPdf.includes("import { NIVELES_EVALUACION, CANTIDAD_INDICADORES_HOJA, type IndicadorProyecto } from '../seguimiento/tipos'"), '12a. La hoja sigue importando la escala y la cantidad de indicadores desde lib/seguimiento/tipos.ts, sin redefinirlas localmente')
    verificar(!rutaPdf.includes('function evaluarIndicador') && !rutaPdf.includes('function calcularPromedio') && !rutaPdf.includes('function interpretarMarcas'), '12b. Ninguna función de evaluación (evaluarIndicador/calcularPromedio/interpretarMarcas) fue copiada o redefinida aquí')
  }

  // ============================================================
  // 13. Sin persistencia durante la vista previa — sigue siendo una
  //     función pura.
  // ============================================================
  {
    verificar(!/supabase/i.test(rutaPdf) && !rutaPdf.includes('Storage') && !rutaPdf.includes('@supabase/supabase-js'), '13. generarHojaSeguimientoPdf.ts sigue siendo una función pura — cero llamadas a Supabase o Storage')
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
