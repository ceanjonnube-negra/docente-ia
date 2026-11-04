// scripts/verificar-resultados-confirmados-vista.tsx
//
// "Ver resultados" en Evaluación: la tabla de solo lectura de un proyecto
// confirmado se pinta con la matriz real que arma
// construirMatrizResultadosConfirmados (la misma que devuelve
// GET resultados-confirmados), y la pantalla solo ofrece la acción en
// proyectos confirmados.
//
// Sin red, sin credenciales, sin IA. Se ejecuta con
// `npx tsx scripts/verificar-resultados-confirmados-vista.tsx`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { construirMatrizResultadosConfirmados } from '../lib/seguimiento/resultadosConfirmados'
import type { AlumnoRosterCongelado, IndicadorCongelado } from '../lib/seguimiento/tipos'

let fallos = 0
function verificar(condicion: boolean, descripcion: string) {
  console.log(`${condicion ? '✓' : '✗'} ${descripcion}`)
  if (!condicion) fallos++
}

const roster: AlumnoRosterCongelado[] = [
  { alumno_id: 'al-2', inscripcion_id: 'in-2', nombre: 'Beatriz Ruiz', posicion: 2 },
  { alumno_id: 'al-1', inscripcion_id: 'in-1', nombre: 'Ana López', posicion: 1 },
  { alumno_id: 'al-3', inscripcion_id: 'in-3', nombre: 'Carlos Pérez', posicion: 3 },
]
const indicadores: IndicadorCongelado[] = [
  { numero_indicador: 2, indicador_especifico: 'Explica el ciclo del agua', aspecto_general: 'aplicacion_aprendizajes' },
  { numero_indicador: 1, indicador_especifico: 'Identifica fuentes de agua', aspecto_general: 'logro_aprendizaje' },
]

async function main() {
  // Variables públicas ficticias: el módulo del componente importa el
  // cliente de Supabase del navegador; nunca se usa en esta prueba.
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://supabase.invalid'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'clave-ficticia'
  const { TablaResultadosConfirmados } = await import('../components/Asistente/ResultadosConfirmados')

  // --- R1. Matriz completa con todos los niveles ---
  {
    const matriz = construirMatrizResultadosConfirmados(
      [
        { inscripcion_id: 'in-1', indicador_numero: 1, nivel: 'destacado' },
        { inscripcion_id: 'in-1', indicador_numero: 2, nivel: 'logrado' },
        { inscripcion_id: 'in-2', indicador_numero: 1, nivel: 'en_proceso' },
        { inscripcion_id: 'in-2', indicador_numero: 2, nivel: 'requiere_apoyo' },
        { inscripcion_id: 'in-3', indicador_numero: 1, nivel: 'no_evaluado' },
        // in-3 / indicador 2 sin fila real → "—"
      ],
      roster,
      indicadores
    )
    const html = renderToStaticMarkup(<TablaResultadosConfirmados matriz={matriz} />)
    const filas = [...html.matchAll(/<tr class="border-t[^"]*">(.*?)<\/tr>/g)].map((m) => m[1])
    const celdas = (fila: string) => [...fila.matchAll(/<span class="inline-flex[^"]*">([^<]*)<\/span>/g)].map((m) => m[1])

    verificar(filas.length === 3, 'R1. Una fila por alumno del roster congelado (3)')
    verificar(/Ana López/.test(filas[0]) && /Beatriz Ruiz/.test(filas[1]) && /Carlos Pérez/.test(filas[2]), 'R2. Alumnos en el orden de posición de la hoja')
    verificar(html.indexOf('>I1<') < html.indexOf('>I2<'), 'R3. Indicadores en su orden congelado (I1, I2)')
    verificar(JSON.stringify(celdas(filas[0])) === '["4","3"]', 'R4. Destacado = 4 y logrado = 3')
    verificar(JSON.stringify(celdas(filas[1])) === '["2","1"]', 'R5. En proceso = 2 y requiere apoyo = 1')
    verificar(JSON.stringify(celdas(filas[2])) === '["NE","—"]', 'R6. No evaluado = NE; celda sin fila real = "—" (nunca un nivel inventado)')
    verificar(html.includes('Identifica fuentes de agua') && html.includes('Explica el ciclo del agua'), 'R7. Muestra el texto real de cada indicador')
    verificar(html.includes('Logro del aprendizaje') && html.includes('Aplicación de los aprendizajes'), 'R8. Muestra el aspecto general de cada indicador')
    verificar(html.includes('4 = Dominio destacado') && html.includes('NE = No evaluado') && html.includes('— = Sin dato registrado'), 'R9. Leyenda de niveles con las etiquetas oficiales')
    verificar(!/<(button|input|select|textarea|form)\b/.test(html), 'R10. La tabla no tiene ningún control de edición ni de confirmación')
    verificar(!html.includes('No se encontraron resultados'), 'R11. Con datos reales no aparece el aviso de "sin resultados"')
  }

  // --- R12. Celdas duplicadas o niveles desconocidos nunca se adivinan ---
  {
    const matriz = construirMatrizResultadosConfirmados(
      [
        { inscripcion_id: 'in-1', indicador_numero: 1, nivel: 'logrado' },
        { inscripcion_id: 'in-1', indicador_numero: 1, nivel: 'destacado' },
        { inscripcion_id: 'in-1', indicador_numero: 2, nivel: 'excelente' },
      ],
      roster.slice(1, 2),
      indicadores
    )
    const html = renderToStaticMarkup(<TablaResultadosConfirmados matriz={matriz} />)
    const valores = [...html.matchAll(/<span class="inline-flex[^"]*">([^<]*)<\/span>/g)].map((m) => m[1])
    verificar(JSON.stringify(valores) === '["—","—"]', 'R12. Duplicado o nivel desconocido se muestran como "—"')
    verificar(html.includes('No se encontraron resultados registrados para este proyecto.'), 'R13. Sin ningún dato real se avisa claramente')
  }

  // --- R14. Roster vacío ---
  {
    const html = renderToStaticMarkup(<TablaResultadosConfirmados matriz={{ alumnos: [] }} />)
    verificar(html.includes('Esta hoja no tiene alumnos registrados.') && !html.includes('<table'), 'R14. Sin alumnos: mensaje claro y sin tabla vacía')
  }

  // --- Pantalla de Evaluación y componente (fuente) ---
  {
    const raiz = join(__dirname, '..')
    const pagina = readFileSync(join(raiz, 'app/dashboard/evaluacion/page.tsx'), 'utf8')
    const componente = readFileSync(join(raiz, 'components/Asistente/ResultadosConfirmados.tsx'), 'utf8')
    verificar(/const verResultados = estado === 'confirmado' && !expandido/.test(pagina), 'P1. "Ver resultados" solo existe para proyectos confirmados')
    verificar(pagina.includes("'👁️ Ver hoja'"), 'P2. "Ver hoja" se conserva')
    verificar(/confirmado: null,\s*\}/.test(pagina.slice(pagina.indexOf('const ETIQUETA_ACCION'))), 'P3. Un proyecto confirmado sigue sin acción de captura ni confirmación')
    verificar(componente.includes('/api/proyectos-seguimiento/${proyectoId}/resultados-confirmados'), 'P4. Reutiliza el endpoint existente resultados-confirmados')
    verificar(!/method:\s*'(POST|PUT|PATCH|DELETE)'/.test(componente) && !/\.(insert|update|upsert|delete)\(/.test(componente), 'P5. El componente no escribe: solo GET')
    verificar(componente.includes("tipo: 'cargando'") && componente.includes('Reintentar') && componente.includes('Tu sesión expiró'), 'P6. Maneja carga, error con reintento y sesión vencida')
  }

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
