// scripts/verificar-escala-evaluacion.ts
//
// Prueba aislada (sin credenciales, sin red, sin escrituras reales) de
// "AJUSTE DEFINITIVO C-005 — modelo compacto de hoja de evaluación con
// 5 indicadores y escala 1-4": confirma que la hoja evalúa EXACTAMENTE
// 5 indicadores esenciales, que cada uno ocupa una sola columna (nunca
// 4 sub-casillas como en el diseño anterior), que existe una única
// columna "Nivel final", que la escala sigue siendo exclusivamente
// 1-4 (nunca letras ni 5 niveles), y que el diseño cabe en una sola
// página legible para 28 alumnos. La generación real del PDF (pdf-lib)
// es una librería pura sin red — se ejecuta de verdad aquí, igual que
// en el resto de la serie C-005; lo único que no se puede probar de
// forma determinista es la lectura óptica real de una foto, que
// todavía no existe como funcionalidad en este proyecto — se verifica
// en su lugar el contrato puro que esa futura lectura deberá cumplir
// (interpretarMarcas / calcularNivelFinalSugerido).
// Se ejecuta con `npx tsx scripts/verificar-escala-evaluacion.ts`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { NIVELES_EVALUACION, CANTIDAD_INDICADORES_HOJA, type IndicadorProyecto } from '../lib/seguimiento/tipos'
import {
  REGLA_CONVERSION_PREDETERMINADA,
  evaluarIndicador,
  calcularPromedio,
  interpretarMarcas,
  calcularNivelFinalSugerido,
  type ResultadoIndicadorEvaluado,
} from '../lib/seguimiento/conversionCalificacion'
import { generarHojaSeguimientoPdfBuffer } from '../lib/documentGen/generarHojaSeguimientoPdf'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

const PERFIL_FALSO = { nombre: 'Docente de prueba', escuela: 'Escuela de prueba', grado: '4°', grupo: 'B' }

// 6 indicadores a propósito — más de los 5 permitidos — para confirmar
// que la hoja NUNCA dibuja más de CANTIDAD_INDICADORES_HOJA columnas
// aunque el llamador entregue más (defensa estructural; la
// consolidación real a 5 ocurre antes, en aprobarBorrador.ts).
const INDICADORES_DE_SOBRA: IndicadorProyecto[] = [
  { indicador_especifico: 'Identifica ideas principales de un texto informativo', aspecto_general: 'logro_aprendizaje' },
  { indicador_especifico: 'Cuenta colecciones hasta 100 con correspondencia uno a uno', aspecto_general: 'logro_aprendizaje' },
  { indicador_especifico: 'Sigue instrucciones de dos pasos de forma autónoma', aspecto_general: 'autonomia' },
  { indicador_especifico: 'Participa activamente en el trabajo colaborativo del equipo', aspecto_general: 'participacion_colaboracion' },
  { indicador_especifico: 'Entrega el producto final con las evidencias solicitadas', aspecto_general: 'producto_evidencia' },
  { indicador_especifico: 'Indicador de sobra que nunca debería llegar a la hoja', aspecto_general: 'logro_aprendizaje' },
]

async function main() {
  const rutaPdf = readFileSync(join(__dirname, '..', 'lib', 'documentGen', 'generarHojaSeguimientoPdf.ts'), 'utf-8')
  const rutaTipos = readFileSync(join(__dirname, '..', 'lib', 'seguimiento', 'tipos.ts'), 'utf-8')
  const rutaAprobar = readFileSync(join(__dirname, '..', 'lib', 'planeacion', 'aprobarBorrador.ts'), 'utf-8')
  const rutaInstrucciones = readFileSync(join(__dirname, '..', 'lib', 'asistente', 'instruccionesPlaneacionGenerar.ts'), 'utf-8')

  // ============================================================
  // 1. Exactamente 5 indicadores esenciales — nunca más.
  // ============================================================
  {
    verificar(CANTIDAD_INDICADORES_HOJA === 5, '1a. CANTIDAD_INDICADORES_HOJA es exactamente 5')
    verificar(rutaAprobar.includes('.slice(0, CANTIDAD_INDICADORES_HOJA)'), '1b. construirIndicadoresSeguimiento recorta a CANTIDAD_INDICADORES_HOJA antes de llegar a la hoja')
    verificar(rutaInstrucciones.includes('exactamente 5 elementos'), '1c. Las instrucciones del asistente exigen exactamente 5 indicadores en el bloque de resumen')
    verificar(rutaPdf.includes('indicadoresUsados = datos.indicadores.slice(0, CANTIDAD_INDICADORES_HOJA)'), '1d. El generador de PDF nunca dibuja más de CANTIDAD_INDICADORES_HOJA columnas, aunque reciba más')
  }

  // ============================================================
  // 2 y 3. Escala EXCLUSIVAMENTE 1, 2, 3, 4 — ningún nivel 5.
  // ============================================================
  {
    verificar(NIVELES_EVALUACION.length === 4, '2a. Existen exactamente 4 niveles en la escala')
    verificar(NIVELES_EVALUACION.map(n => n.valor).join(',') === '4,3,2,1', '2b. Los niveles son exactamente 4, 3, 2 y 1 (mismo orden en la leyenda)')
    verificar(!NIVELES_EVALUACION.some(n => (n.valor as number) === 5), '3. No existe un nivel 5 en la escala')
  }

  // ============================================================
  // 4. Ninguna letra D/L/E/R/N sigue presente en el modelo ni en el
  //    código que genera la hoja.
  // ============================================================
  {
    verificar(!rutaTipos.includes('NivelSeguimiento') && !rutaTipos.includes('NIVELES_SEGUIMIENTO'), '4a. lib/seguimiento/tipos.ts no define la escala de letras (NivelSeguimiento/NIVELES_SEGUIMIENTO)')
    verificar(!rutaPdf.includes('NIVELES_SEGUIMIENTO'), '4b. generarHojaSeguimientoPdf.ts no importa ni usa la escala de letras')
    verificar(!/[DLERN]\s*=\s*(Destacado|Logrado|En proceso|Requiere apoyo|No evaluado)/i.test(rutaPdf), '4c. El código fuente de la hoja no construye ninguna leyenda con letras (D=/L=/E=/R=/N=)')
  }

  // ============================================================
  // 5 y 6. Cada indicador ocupa UNA sola columna — nunca 4
  //    sub-casillas repetidas por indicador (diseño anterior).
  // ============================================================
  {
    verificar(!rutaPdf.includes('ANCHO_NIVEL') && !rutaPdf.includes('NIVELES_EVALUACION.forEach'), '5a. La hoja ya no dibuja una sub-casilla por cada nivel (4/3/2/1) dentro de un indicador')
    verificar(rutaPdf.includes('indicadoresUsados.forEach') && rutaPdf.includes('ANCHO_IND'), '5b. Cada indicador se dibuja como una sola celda de ancho ANCHO_IND')
    verificar(!/4\s*3\s*2\s*1/.test(rutaPdf.replace(/\s+/g, ' ')), '6. El código fuente no vuelve a imprimir las etiquetas 4 3 2 1 dentro de cada indicador')
  }

  // ============================================================
  // 7 y 8. Existe exactamente una columna "Nivel final", nunca
  //    llamada "Calificación", y solo admite 1-4 o vacío (mismo
  //    contrato de lectura que un indicador).
  // ============================================================
  {
    const ocurrenciasNivelFinal = (rutaPdf.match(/Nivel final/g) ?? []).length
    verificar(ocurrenciasNivelFinal >= 1, '7a. La tabla incluye la columna "Nivel final"')
    const lineasCodigo = rutaPdf.split('\n').filter(l => !l.trim().startsWith('//'))
    verificar(!lineasCodigo.some(l => l.includes('Calificación') || l.includes('Calificacion')), '7b. La hoja nunca llama "Calificación" a la columna de nivel final (fuera de comentarios explicativos)')
    verificar(rutaPdf.includes('ANCHO_FINAL') && (rutaPdf.match(/ANCHO_FINAL/g) ?? []).length >= 2, '7c. "Nivel final" es una única columna adicional (ANCHO_FINAL), no una repetida por indicador')
    const lecturaFinal = interpretarMarcas([3])
    verificar(lecturaFinal.estado === 'nivel' && (lecturaFinal as { nivel: number }).nivel === 3, '8. Una celda de "Nivel final" con un solo dígito 1-4 se interpreta igual que un indicador (mismo contrato interpretarMarcas)')
  }

  // ============================================================
  // 9. Una celda vacía (ningún dígito detectado) representa "no
  //    evaluado" — nunca un nivel 0 ni un valor inventado.
  // ============================================================
  {
    verificar(interpretarMarcas([]).estado === 'no_evaluado', '9. Cero dígitos detectados se interpreta como "no evaluado"')
  }

  // ============================================================
  // 10. Los valores vacíos NUNCA cuentan como cero — ni en el
  //     promedio ya convertido ni en la sugerencia de nivel final.
  // ============================================================
  {
    const resultados: ResultadoIndicadorEvaluado[] = [
      evaluarIndicador({ indicador: 'a', proyecto: 'p', alumno: 'x', fecha: '2026-08-10', nivelOriginal: 4 }), // 10
      evaluarIndicador({ indicador: 'b', proyecto: 'p', alumno: 'x', fecha: '2026-08-10', nivelOriginal: 2 }), // 6
      evaluarIndicador({ indicador: 'c', proyecto: 'p', alumno: 'x', fecha: '2026-08-10', nivelOriginal: null }), // sin evaluar
    ]
    verificar(calcularPromedio(resultados) === 8, '10a. El promedio (10+6)/2=8 excluye por completo el indicador sin evaluar — nunca (10+6+0)/3')
    verificar(calcularNivelFinalSugerido([4, 2, null, null, null]) === 3, '10b. La sugerencia de nivel final promedia solo los evaluados (4 y 2 -> 3), excluyendo los vacíos, nunca contándolos como 0')
    verificar(calcularNivelFinalSugerido([null, null, null, null, null]) === null, '10c. Si ningún indicador fue evaluado, la sugerencia es null — nunca 0 ni un nivel inventado')
  }

  // ============================================================
  // 11 y 12. Los 28 alumnos aparecen completos, y el diseño cabe en
  //     una sola página legible en horizontal (fallback de 2 páginas
  //     balanceadas solo si de verdad no cupieran).
  // ============================================================
  {
    const alumnos = Array.from({ length: 28 }, (_, i) => ({ nombre: `Alumno de prueba número ${i + 1} Apellido`, posicion: i + 1 }))
    const buffer = await generarHojaSeguimientoPdfBuffer(
      {
        nombreProyecto: 'Diagnóstico de inicio de ciclo',
        camposFormativos: ['Lenguajes'],
        trimestreNombre: 'Primer trimestre',
        fechaInicio: '2026-08-03',
        fechaFin: '2026-08-18',
        identificadorVisible: 'VISTA PREVIA — PENDIENTE DE APROBACIÓN',
        indicadores: INDICADORES_DE_SOBRA,
        alumnos,
      },
      PERFIL_FALSO,
      'America/Mexico_City'
    )
    verificar(buffer.length > 0 && buffer.subarray(0, 4).toString('latin1') === '%PDF', '11a. El PDF con el modelo compacto (5 columnas de indicador + Nivel final, 28 alumnos) se genera correctamente')

    const pdfDoc = await PDFDocument.load(buffer)
    const paginas = pdfDoc.getPageCount()
    verificar(paginas === 1, `11b. Los 28 alumnos caben en UNA sola página legible (páginas generadas: ${paginas})`)
    verificar(paginas <= 2, '12. En el peor caso el diseño nunca requiere más de 2 páginas para 28 alumnos')

    const primeraPagina = pdfDoc.getPage(0)
    verificar(primeraPagina.getWidth() > primeraPagina.getHeight(), '12b. La hoja se genera en orientación horizontal (carta apaisada)')
  }

  // ============================================================
  // 13. La leyenda aparece exactamente una vez — nunca se repite
  //     dentro de la tabla.
  // ============================================================
  {
    verificar(rutaPdf.includes('function dibujarLeyenda()') && (rutaPdf.match(/function dibujarLeyenda\(\)/g) ?? []).length === 1, '13a. Existe una única función que dibuja la leyenda')
    verificar((rutaPdf.match(/dibujarLeyenda\(\)/g) ?? []).length === 2, '13b. dibujarLeyenda() se invoca exactamente una vez en la secuencia de dibujo (1 definición + 1 llamada)')
    const etiquetaLeyenda = NIVELES_EVALUACION.map(n => `${n.valor} ${n.etiqueta}`).join(' · ') + ' · Vacío No evaluado'
    verificar(etiquetaLeyenda === '4 Dominio destacado · 3 Logro esperado · 2 En proceso · 1 Requiere apoyo · Vacío No evaluado', '13c. La leyenda generada es exactamente la exigida, incluyendo "Vacío No evaluado"')
  }

  // ============================================================
  // 14. No se muestra ninguna conversión a escala 5-10 dentro de la
  //     hoja — esa conversión sigue siendo interna y configurable.
  // ============================================================
  {
    verificar(!/^import.*conversionCalificacion/m.test(rutaPdf) && !rutaPdf.includes('REGLA_CONVERSION'), '14. generarHojaSeguimientoPdf.ts no importa ni muestra la conversión a calificación 5-10')
  }

  // ============================================================
  // 15. Sin persistencia durante la vista previa — el generador de
  //     PDF sigue siendo una función pura (sin Supabase/Storage).
  // ============================================================
  {
    verificar(!/supabase/i.test(rutaPdf) && !rutaPdf.includes('Storage') && !rutaPdf.includes('@supabase/supabase-js'), '15. generarHojaSeguimientoPdf.ts sigue siendo una función pura — cero llamadas a Supabase o Storage')
  }

  // ============================================================
  // 16. La planeación pedagógica (secuencia, contenidos, PDA,
  //     propósito) no fue tocada — solo cambió el bloque de
  //     indicadores de evaluación.
  // ============================================================
  {
    verificar(rutaInstrucciones.includes('secuencia didáctica completa, día por día'), '16a. La instrucción de secuencia didáctica sigue intacta')
    verificar(rutaInstrucciones.includes('PDA (Procesos de Desarrollo de Aprendizaje)'), '16b. La instrucción de PDA sigue intacta')
    verificar(rutaInstrucciones.includes('Secuencia didáctica: [Día 1: resumen breve de ese día'), '16c. El bloque de resumen sigue pidiendo la secuencia didáctica completa, sin cambios')
  }

  // ============================================================
  // 17. La hoja sigue derivando del mismo borrador de planeación —
  //     ninguna ruta nueva ni desconectada del flujo existente.
  // ============================================================
  {
    verificar(rutaAprobar.includes('construirIndicadoresSeguimiento(resumen)'), '17. La hoja sigue construyéndose a partir del resumen extraído del propio borrador aprobado (extraerBorrador.ts), no de una fuente nueva')
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
