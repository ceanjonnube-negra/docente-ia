// scripts/verificar-evaluacion-accion-exhaustiva.ts
//
// Corrección "tarjeta de Evaluación queda inaccesible tras recargar":
// el botón que alterna `seleccionado` (única forma de expandir/
// re-expandir una tarjeta en app/dashboard/evaluacion/page.tsx) solo
// se renderiza cuando ETIQUETA_ACCION tiene una entrada para el
// estado real — con Partial<Record<...>>, identidad_no_valida quedaba
// sin entrada, sin botón, sin forma de reabrir la tarjeta tras
// recargar. Corrección: ETIQUETA_ACCION/ICONO_ACCION pasan de
// Partial a Record COMPLETO (string | null), con confirmado: null
// explícito como única exclusión intencional — cualquier estado
// futuro que se agregue al enum EstadoCapturaHoja y no se agregue
// aquí ahora rompe el build, en vez de fallar en silencio.
//
// Verificación estructural (sin credenciales, sin red, sin datos
// reales, sin renderizar el componente — mismo criterio que el resto
// de esta familia de scripts).
//
// Se ejecuta con `npx tsx scripts/verificar-evaluacion-accion-exhaustiva.ts`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
const pagina = readFileSync(raiz('app', 'dashboard', 'evaluacion', 'page.tsx'), 'utf-8')

const ESTADOS: string[] = [
  'sin_fotografia',
  'captura_incompleta',
  'lista_para_analizar',
  'identidad_no_valida',
  'revision_pendiente',
  'lista_para_confirmar',
  'confirmado',
]

function bloqueDeConst(nombre: string): string {
  const inicio = pagina.indexOf(`const ${nombre}`)
  if (inicio === -1) throw new Error(`No se encontró ${nombre}`)
  const llaveInicial = pagina.indexOf('{', inicio)
  let profundidad = 0
  for (let i = llaveInicial; i < pagina.length; i++) {
    if (pagina[i] === '{') profundidad++
    if (pagina[i] === '}') {
      profundidad--
      if (profundidad === 0) return pagina.slice(inicio, i + 1)
    }
  }
  throw new Error(`No se pudo cerrar el bloque de ${nombre}`)
}

function main() {
  const bloqueEtiqueta = bloqueDeConst('ETIQUETA_ACCION')
  const bloqueIcono = bloqueDeConst('ICONO_ACCION')

  // ============================================================
  // Tipo: Record completo, ya no Partial — para ambos mapas.
  // ============================================================
  verificar(bloqueEtiqueta.includes('const ETIQUETA_ACCION: Record<EstadoCapturaHoja, string | null> = {'), '1. ETIQUETA_ACCION es Record<EstadoCapturaHoja, string | null> — ya no Partial')
  verificar(bloqueIcono.includes('const ICONO_ACCION: Record<EstadoCapturaHoja, string | null> = {'), '2. ICONO_ACCION es Record<EstadoCapturaHoja, string | null> — ya no Partial')
  verificar(!bloqueEtiqueta.includes('Partial<') && !bloqueIcono.includes('Partial<'), '3. Ninguno de los dos mapas usa Partial<...> en su declaración')

  // ============================================================
  // Exhaustividad: los 7 valores reales de EstadoCapturaHoja
  // aparecen como clave en AMBOS mapas.
  // ============================================================
  for (const estado of ESTADOS) {
    verificar(new RegExp(`\\b${estado}:`).test(bloqueEtiqueta), `4-${estado}. ETIQUETA_ACCION tiene una entrada explícita para '${estado}'`)
    verificar(new RegExp(`\\b${estado}:`).test(bloqueIcono), `5-${estado}. ICONO_ACCION tiene una entrada explícita para '${estado}'`)
  }

  // ============================================================
  // identidad_no_valida tiene una acción REAL (no null).
  // ============================================================
  verificar(bloqueEtiqueta.includes("identidad_no_valida: 'Corregir fotografía',"), "6. identidad_no_valida -> 'Corregir fotografía' en ETIQUETA_ACCION")
  verificar(bloqueIcono.includes("identidad_no_valida: '📷',"), "7. identidad_no_valida -> '📷' en ICONO_ACCION")

  // ============================================================
  // confirmado tiene null EXPLÍCITO (única exclusión intencional).
  // ============================================================
  verificar(bloqueEtiqueta.includes('confirmado: null,') || bloqueEtiqueta.trim().endsWith('confirmado: null\n}') || /confirmado: null\s*[,}]/.test(bloqueEtiqueta), '8. ETIQUETA_ACCION: confirmado tiene null explícito')
  verificar(/confirmado: null\s*[,}]/.test(bloqueIcono), '9. ICONO_ACCION: confirmado tiene null explícito')

  // ============================================================
  // Los demás 5 estados conservan EXACTAMENTE su texto/ícono anterior
  // (ningún cambio de copy accidental al hacer el mapa exhaustivo).
  // ============================================================
  const ETIQUETAS_PREVIAS: Record<string, string> = {
    sin_fotografia: 'Capturar resultados',
    captura_incompleta: 'Continuar captura',
    lista_para_analizar: 'Continuar',
    revision_pendiente: 'Revisar resultados',
    lista_para_confirmar: 'Confirmar resultados',
  }
  for (const [estado, texto] of Object.entries(ETIQUETAS_PREVIAS)) {
    verificar(bloqueEtiqueta.includes(`${estado}: '${texto}'`), `10-${estado}. ETIQUETA_ACCION conserva exactamente '${texto}' (sin cambios de copy)`)
  }
  const ICONOS_PREVIOS: Record<string, string> = {
    sin_fotografia: '📷',
    captura_incompleta: '📷',
    lista_para_analizar: '▶️',
    revision_pendiente: '🔍',
    lista_para_confirmar: '✅',
  }
  for (const [estado, icono] of Object.entries(ICONOS_PREVIOS)) {
    verificar(bloqueIcono.includes(`${estado}: '${icono}'`), `11-${estado}. ICONO_ACCION conserva exactamente '${icono}' (sin cambios)`)
  }

  // ============================================================
  // Nada más se tocó: seleccionado/alternarSeleccion/expandido y el
  // montaje de CapturaHoja siguen exactamente iguales.
  // ============================================================
  verificar(pagina.includes('const alternarSeleccion = (proyectoId: string) => {'), '12. alternarSeleccion sigue existiendo tal cual, sin cambios de firma')
  verificar(pagina.includes("const expandido = seleccionado === proyecto.id"), '13. La lógica de expansión (expandido) sigue siendo exactamente la misma comparación')
  verificar(pagina.includes('{accion && ('), '14. El render del botón sigue gateado por el mismo patrón {accion && (...)} — null y undefined se comportan igual (falsy)')

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
