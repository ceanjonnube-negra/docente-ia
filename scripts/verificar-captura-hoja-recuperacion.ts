// scripts/verificar-captura-hoja-recuperacion.ts
//
// Corrección puntual de CapturaHoja.tsx (incidente real: docente subió
// una fotografía real desde iPhone/Safari, analizar-hoja terminó
// correctamente en el servidor —200, extraidoBruto persistido,
// proyecto en 'requiere_revision'— pero el cliente se quedó
// congelado en "Leyendo la hoja…" para siempre, sin ningún botón de
// recuperación visible). Verificación estructural (sin credenciales,
// sin red, sin datos reales) de:
//   1. enCursoRef.current SIEMPRE se libera vía finally, en
//      onArchivoSeleccionado() y en confirmar().
//   2/3. Una excepción de fetch() o de res.json() en analizar()/
//      cargarEstado()/onArchivoSeleccionado()/confirmar() nunca deja
//      `fase` congelada — siempre cae a 'error' vía catch.
//   4-7. El botón "Verificar estado" (visible durante fase==='analizando')
//      ejecuta ÚNICAMENTE cargarEstado() — nunca foto-hoja, nunca
//      analizar-hoja, nunca confirmar-hoja directamente.
//   8. Ninguna llamada IA nueva.
//   9-10. El comportamiento existente (EVAL-1G/EVAL-1I) sigue intacto —
//      se reutilizan, sin modificarlos, los scripts de verificación ya
//      existentes de esa familia.
//
// Se ejecuta con `npx tsx scripts/verificar-captura-hoja-recuperacion.ts`.

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
const capturaHoja = readFileSync(raiz('components', 'Asistente', 'CapturaHoja.tsx'), 'utf-8')

// Extrae el cuerpo de una función nombrada `const nombre = async (...) => { ... }`
// contando llaves balanceadas — evita depender de que el cuerpo no
// tenga llaves anidadas (los try/catch/if de este archivo sí las
// tienen).
function cuerpoDeFuncion(contenido: string, nombre: string): string {
  const inicio = contenido.indexOf(`const ${nombre} = async`)
  if (inicio === -1) throw new Error(`No se encontró la función ${nombre}`)
  const llaveInicial = contenido.indexOf('{', inicio)
  let profundidad = 0
  for (let i = llaveInicial; i < contenido.length; i++) {
    if (contenido[i] === '{') profundidad++
    if (contenido[i] === '}') {
      profundidad--
      if (profundidad === 0) return contenido.slice(llaveInicial, i + 1)
    }
  }
  throw new Error(`No se pudo cerrar el cuerpo de ${nombre}`)
}

function main() {
  const analizarBody = cuerpoDeFuncion(capturaHoja, 'analizar')
  const cargarEstadoBody = cuerpoDeFuncion(capturaHoja, 'cargarEstado')
  const onArchivoBody = cuerpoDeFuncion(capturaHoja, 'onArchivoSeleccionado')
  const confirmarBody = cuerpoDeFuncion(capturaHoja, 'confirmar')

  // ============================================================
  // 1. enCursoRef SIEMPRE se libera mediante finally.
  // ============================================================
  verificar(
    /try\s*\{[\s\S]*\}\s*catch[\s\S]*\}\s*finally\s*\{\s*enCursoRef\.current\s*=\s*false\s*\}/.test(onArchivoBody),
    "1a. onArchivoSeleccionado(): enCursoRef.current=false vive EXCLUSIVAMENTE dentro de un bloque finally (try/catch/finally), nunca en una línea suelta al final del cuerpo"
  )
  verificar(
    /try\s*\{[\s\S]*\}\s*catch[\s\S]*\}\s*finally\s*\{\s*enCursoRef\.current\s*=\s*false\s*\}/.test(confirmarBody),
    '1b. confirmar(): enCursoRef.current=false vive EXCLUSIVAMENTE dentro de un bloque finally'
  )
  // No debe quedar ninguna asignación suelta de enCursoRef.current=false
  // FUERA de un finally en estas dos funciones (los `return` tempranos
  // de antes ya no deben reiniciar la guarda manualmente).
  const asignacionesEnCursoOnArchivo = (onArchivoBody.match(/enCursoRef\.current\s*=\s*false/g) || []).length
  const asignacionesEnCursoConfirmar = (confirmarBody.match(/enCursoRef\.current\s*=\s*false/g) || []).length
  verificar(asignacionesEnCursoOnArchivo === 1, `1c. onArchivoSeleccionado(): exactamente UNA asignación a enCursoRef.current=false (la del finally) — recuento real: ${asignacionesEnCursoOnArchivo}`)
  verificar(asignacionesEnCursoConfirmar === 1, `1d. confirmar(): exactamente UNA asignación a enCursoRef.current=false (la del finally) — recuento real: ${asignacionesEnCursoConfirmar}`)

  // ============================================================
  // 2/3. Una excepción de fetch() o de res.json() no deja `fase`
  // congelada — en particular, nunca 'analizando'/'cargando'.
  // ============================================================
  verificar(
    /try\s*\{[\s\S]*await fetch\([\s\S]*await res\.json\(\)[\s\S]*\}\s*catch[\s\S]*setFase\('error'\)/.test(analizarBody),
    "2a. analizar(): tanto el fetch() como el res.json() de analizar-hoja están dentro del mismo try, y el catch resuelve a setFase('error')"
  )
  verificar(
    /try\s*\{[\s\S]*await fetch\([\s\S]*await res\.json\(\)[\s\S]*\}\s*catch[\s\S]*setFase\('error'\)/.test(cargarEstadoBody),
    "2b. cargarEstado(): tanto el fetch() como el res.json() de estado-captura están dentro del mismo try, y el catch resuelve a setFase('error')"
  )
  verificar(
    /try\s*\{[\s\S]*await fetch\([\s\S]*await res\.json\(\)[\s\S]*\}\s*catch[\s\S]*setFase\('error'\)/.test(onArchivoBody),
    "2c. onArchivoSeleccionado(): el fetch()/res.json() de foto-hoja está dentro del try, y el catch resuelve a setFase('error')"
  )
  verificar(
    /try\s*\{[\s\S]*await fetch\([\s\S]*await res\.json\(\)[\s\S]*\}\s*catch[\s\S]*setFase\('error'\)/.test(confirmarBody),
    "2d. confirmar(): el fetch()/res.json() de confirmar-hoja está dentro del try, y el catch resuelve a setFase('error')"
  )
  // Ninguna de las 4 funciones puede quedar con un catch vacío o que no
  // toque `fase` — si el catch no llama setFase, la UI seguiría
  // congelada visualmente aunque la excepción ya no rompa JavaScript.
  for (const [nombre, cuerpo] of [
    ['analizar', analizarBody],
    ['cargarEstado', cargarEstadoBody],
    ['onArchivoSeleccionado', onArchivoBody],
    ['confirmar', confirmarBody],
  ] as const) {
    const catchMatch = cuerpo.match(/catch\s*\([^)]*\)\s*\{([\s\S]*?)\}\s*(finally|$)/)
    verificar(!!catchMatch && /setFase\('error'\)/.test(catchMatch[1]), `3-${nombre}. El bloque catch de ${nombre}() llama setFase('error') — nunca deja \`fase\` en el valor que tenía al lanzarse la excepción`)
  }

  // ============================================================
  // 4-7. "Verificar estado" ejecuta ÚNICAMENTE cargarEstado().
  // ============================================================
  verificar(
    /fase === 'analizando'[\s\S]{0,600}onClick=\{cargarEstado\}[\s\S]{0,250}Verificar estado/.test(capturaHoja),
    "4. Existe un botón 'Verificar estado' visible durante fase==='analizando' cuyo onClick es literalmente cargarEstado (la misma referencia de función, sin envoltorio adicional)"
  )
  // cargarEstado(), aislado, no referencia ninguna de las 3 rutas que
  // mutan datos — la única llamada POST que puede disparar en cascada
  // (analizar-hoja) es la reanudación YA EXISTENTE de EVAL-1G/1H
  // (json.estado==='lista_para_analizar'), no algo nuevo introducido
  // por el botón.
  verificar(!cargarEstadoBody.includes('/foto-hoja'), '5. cargarEstado() no referencia /foto-hoja — "Verificar estado" nunca puede volver a subir la fotografía')
  verificar(!cargarEstadoBody.includes('/confirmar-hoja'), '7. cargarEstado() no referencia /confirmar-hoja — "Verificar estado" nunca puede confirmar resultados')
  // La única mención de analizar-hoja alcanzable desde cargarEstado()
  // es la llamada PRE-EXISTENTE a analizar(accessToken) (lógica
  // canónica de reanudación, sin tocar), nunca una llamada directa
  // nueva a la ruta.
  verificar(!cargarEstadoBody.includes('/analizar-hoja'), '6. cargarEstado() no hace una llamada DIRECTA a /analizar-hoja — la única vía posible sigue siendo analizar(accessToken), lógica de reanudación preexistente de EVAL-1G/1H, sin cambios')

  // ============================================================
  // 8. Ninguna llamada IA nueva.
  // ============================================================
  verificar(!/anthropic|Anthropic|OpenAI|openai\./i.test(capturaHoja), '8. CapturaHoja.tsx sigue sin ninguna referencia a un cliente de IA — 0 llamadas nuevas')

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
