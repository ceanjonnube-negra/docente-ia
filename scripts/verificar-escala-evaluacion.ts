// scripts/verificar-escala-evaluacion.ts
//
// Prueba aislada (sin credenciales, sin red, sin escrituras reales) de
// "AJUSTE DE DISEÑO Y MODELO DE EVALUACIÓN — sustituir letras por
// escala numérica simple": confirma que la hoja de evaluación ya no
// usa la escala D/L/E/R/N, que el nuevo diseño de 4 casillas por
// indicador (4/3/2/1) se genera correctamente, y que el modelo de
// conversión (lib/seguimiento/conversionCalificacion.ts) conserva el
// nivel original, convierte dentro del rango esperado y excluye del
// promedio los indicadores sin evaluar. La generación real del PDF
// (pdf-lib) es una librería pura sin red — se ejecuta de verdad aquí,
// igual que en el resto de la serie C-005; lo único que no se puede
// probar de forma determinista es la lectura óptica real de una foto,
// que todavía no existe como funcionalidad en este proyecto — se
// verifica en su lugar el contrato puro que esa futura lectura deberá
// cumplir (interpretarMarcas).
// Se ejecuta con `npx tsx scripts/verificar-escala-evaluacion.ts`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NIVELES_EVALUACION, type IndicadorProyecto } from '../lib/seguimiento/tipos'
import {
  REGLA_CONVERSION_PREDETERMINADA,
  evaluarIndicador,
  calcularPromedio,
  interpretarMarcas,
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
const INDICADORES: IndicadorProyecto[] = [
  { indicador_especifico: 'Identifica ideas principales', aspecto_general: 'logro_aprendizaje' },
  { indicador_especifico: 'Cuenta colecciones', aspecto_general: 'logro_aprendizaje' },
  { indicador_especifico: 'Sigue instrucciones', aspecto_general: 'autonomia' },
]

async function main() {
  const rutaPdf = readFileSync(join(__dirname, '..', 'lib', 'documentGen', 'generarHojaSeguimientoPdf.ts'), 'utf-8')
  const rutaTipos = readFileSync(join(__dirname, '..', 'lib', 'seguimiento', 'tipos.ts'), 'utf-8')

  // ============================================================
  // 1. Ya no aparece la escala de letras D/L/E/R/N en ningún lado del
  //    código fuente que genera la hoja ni en los tipos.
  // ============================================================
  {
    verificar(!rutaTipos.includes('NivelSeguimiento') && !rutaTipos.includes('NIVELES_SEGUIMIENTO'), '1a. lib/seguimiento/tipos.ts ya no define la escala de letras (NivelSeguimiento/NIVELES_SEGUIMIENTO)')
    verificar(!rutaTipos.includes("'destacado'") && !rutaTipos.includes("'logrado'") && !rutaTipos.includes("'requiere_apoyo'") && !rutaTipos.includes("'no_evaluado'"), '1b. Ninguno de los valores de la escala de letras sigue presente en tipos.ts')
    verificar(!rutaPdf.includes('NIVELES_SEGUIMIENTO'), '1c. generarHojaSeguimientoPdf.ts ya no importa ni usa la escala de letras')
    verificar(!/[DLERN]\s*=\s*(Destacado|Logrado|En proceso|Requiere apoyo|No evaluado)/i.test(rutaPdf), '1d. El código fuente de la hoja no construye ninguna leyenda con letras (D=/L=/E=/R=/N=)')

    // La leyenda REAL que se dibuja (misma función y mismos datos que
    // usa dibujarLeyenda) nunca contiene las letras como código de nivel.
    const etiquetaLeyenda = NIVELES_EVALUACION.map(n => `${n.valor} ${n.etiqueta}`).join('  ·  ')
    verificar(!/\bD\b|\bL\b|\bE\b|\bR\b|\bN\b/.test(etiquetaLeyenda.replace(/Dominio|Destacado|Logro|Esperado|En|Proceso|Requiere|Apoyo/gi, '')), '1e. La leyenda real generada no contiene las letras D/L/E/R/N como código de nivel')
    verificar(etiquetaLeyenda === '4 Dominio destacado  ·  3 Logro esperado  ·  2 En proceso  ·  1 Requiere apoyo', '1f. La leyenda generada es exactamente la exigida (4/3/2/1 con sus etiquetas)')
  }

  // ============================================================
  // 2. Existen EXACTAMENTE las columnas 4, 3, 2 y 1 — ni más, ni
  //    menos, ni con otro orden.
  // ============================================================
  {
    verificar(NIVELES_EVALUACION.length === 4, '2a. Existen exactamente 4 niveles en la escala')
    verificar(NIVELES_EVALUACION.map(n => n.valor).join(',') === '4,3,2,1', '2b. Las columnas son exactamente 4, 3, 2 y 1, en ese orden (mismo orden en encabezado y leyenda)')
    verificar(rutaPdf.includes('NIVELES_EVALUACION.forEach'), '2c. El encabezado de la tabla dibuja una columna por cada nivel de la escala (nunca una cantidad fija hardcodeada aparte)')
  }

  // ============================================================
  // 3. Una casilla vacía (ninguna marca) representa "no evaluado" —
  //    nunca un nivel 0 ni un valor inventado.
  // ============================================================
  {
    verificar(interpretarMarcas([]).estado === 'no_evaluado', '3. Cero casillas marcadas se interpreta como "no evaluado"')
  }

  // ============================================================
  // 4. El modelo conserva el nivel ORIGINAL 1-4, nunca solo la
  //    calificación ya convertida.
  // ============================================================
  {
    const resultado = evaluarIndicador({ indicador: 'Identifica ideas principales', proyecto: 'Diagnóstico', alumno: 'Ana López', fecha: '2026-08-10', nivelOriginal: 3 })
    verificar(resultado.nivelOriginal === 3, '4a. nivelOriginal se conserva tal cual, sin transformarlo')
    verificar('nivelOriginal' in resultado && 'calificacionConvertida' in resultado && 'reglaConversion' in resultado && 'indicador' in resultado && 'proyecto' in resultado && 'alumno' in resultado && 'fecha' in resultado, '4b. El resultado conserva TODOS los campos exigidos: nivelOriginal, calificacionConvertida, reglaConversion, indicador, proyecto, alumno, fecha')
    const sinEvaluar = evaluarIndicador({ indicador: 'x', proyecto: 'p', alumno: 'a', fecha: '2026-08-10', nivelOriginal: null })
    verificar(sinEvaluar.nivelOriginal === null && sinEvaluar.calificacionConvertida === null, '4c. Un indicador no evaluado conserva nivelOriginal=null y calificacionConvertida=null (nunca 0)')
  }

  // ============================================================
  // 5. La conversión predeterminada genera valores entre 5 y 10 —
  //    exactamente 4→10, 3→8, 2→6, 1→5.
  // ============================================================
  {
    const conversiones = { 4: REGLA_CONVERSION_PREDETERMINADA.convertir(4), 3: REGLA_CONVERSION_PREDETERMINADA.convertir(3), 2: REGLA_CONVERSION_PREDETERMINADA.convertir(2), 1: REGLA_CONVERSION_PREDETERMINADA.convertir(1) }
    verificar(conversiones[4] === 10, '5a. Nivel 4 convierte exactamente a 10')
    verificar(conversiones[3] === 8, '5b. Nivel 3 convierte exactamente a 8')
    verificar(conversiones[2] === 6, '5c. Nivel 2 convierte exactamente a 6')
    verificar(conversiones[1] === 5, '5d. Nivel 1 convierte exactamente a 5')
    verificar(Object.values(conversiones).every(v => v >= 5 && v <= 10), '5e. Las 4 conversiones caen dentro del rango 5-10, sin excepción')
  }

  // ============================================================
  // 6. Los indicadores NO evaluados quedan fuera del promedio — no
  //    cuentan como cero ni lo reducen.
  // ============================================================
  {
    const resultados: ResultadoIndicadorEvaluado[] = [
      evaluarIndicador({ indicador: 'a', proyecto: 'p', alumno: 'x', fecha: '2026-08-10', nivelOriginal: 4 }), // 10
      evaluarIndicador({ indicador: 'b', proyecto: 'p', alumno: 'x', fecha: '2026-08-10', nivelOriginal: 2 }), // 6
      evaluarIndicador({ indicador: 'c', proyecto: 'p', alumno: 'x', fecha: '2026-08-10', nivelOriginal: null }), // sin evaluar
    ]
    const promedio = calcularPromedio(resultados)
    verificar(promedio === 8, '6a. El promedio (10+6)/2=8 excluye por completo el indicador sin evaluar — nunca (10+6+0)/3')
    verificar(calcularPromedio([evaluarIndicador({ indicador: 'a', proyecto: 'p', alumno: 'x', fecha: '2026-08-10', nivelOriginal: null })]) === null, '6b. Si NINGÚN indicador fue evaluado, el promedio es null — nunca 0')
  }

  // ============================================================
  // 7. Reconocimiento por fotografía — contrato puro de posición de
  //    marca (nunca reconocimiento de caracteres escritos), exactamente
  //    los escenarios pedidos.
  // ============================================================
  {
    verificar(interpretarMarcas([4]).estado === 'nivel' && (interpretarMarcas([4]) as { nivel: number }).nivel === 4, '7a. Marca en columna 4 -> nivel 4')
    verificar(interpretarMarcas([3]).estado === 'nivel' && (interpretarMarcas([3]) as { nivel: number }).nivel === 3, '7b. Marca en columna 3 -> nivel 3')
    verificar(interpretarMarcas([2]).estado === 'nivel' && (interpretarMarcas([2]) as { nivel: number }).nivel === 2, '7c. Marca en columna 2 -> nivel 2')
    verificar(interpretarMarcas([1]).estado === 'nivel' && (interpretarMarcas([1]) as { nivel: number }).nivel === 1, '7d. Marca en columna 1 -> nivel 1')
    verificar(interpretarMarcas([]).estado === 'no_evaluado', '7e. Ninguna marca -> pendiente/no evaluado')
    verificar(interpretarMarcas([4, 2]).estado === 'lectura_dudosa', '7f. Más de una marca en la misma fila/indicador -> lectura dudosa que requiere revisión (nunca se adivina)')

    // El PDF real se genera sin errores con el nuevo diseño de 4
    // casillas por indicador — confirma que el diseño es
    // estructuralmente válido para imprimirse y fotografiarse.
    const alumnos = Array.from({ length: 28 }, (_, i) => ({ nombre: `Alumno ${i + 1}`, posicion: i + 1 }))
    const buffer = await generarHojaSeguimientoPdfBuffer(
      {
        nombreProyecto: 'Diagnóstico de inicio de ciclo',
        camposFormativos: ['Lenguajes'],
        trimestreNombre: 'Primer trimestre',
        fechaInicio: '2026-08-03',
        fechaFin: '2026-08-18',
        identificadorVisible: 'VISTA PREVIA — PENDIENTE DE APROBACIÓN',
        indicadores: INDICADORES,
        alumnos,
      },
      PERFIL_FALSO,
      'America/Mexico_City'
    )
    verificar(buffer.length > 0 && buffer.subarray(0, 4).toString('latin1') === '%PDF', '7g. El PDF con el nuevo diseño (4 casillas por indicador, 28 alumnos) se genera correctamente')
  }

  // ============================================================
  // 8. Sin persistencia durante la vista previa — el generador de PDF
  //    sigue siendo una función pura (mismo criterio que el resto de
  //    C-005), y la ruta de vista previa sigue sin tocar Storage/DB.
  // ============================================================
  {
    verificar(!/supabase/i.test(rutaPdf) && !rutaPdf.includes('Storage') && !rutaPdf.includes('@supabase/supabase-js'), '8. generarHojaSeguimientoPdf.ts sigue siendo una función pura — cero llamadas a Supabase o Storage')
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
