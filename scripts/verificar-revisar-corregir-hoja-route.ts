// scripts/verificar-revisar-corregir-hoja-route.ts
//
// EVAL-1F — verificación estructural (sin credenciales, sin red, sin
// datos reales) de
// app/api/proyectos-seguimiento/[id]/revisar-hoja/route.ts (GET) y
// app/api/proyectos-seguimiento/[id]/corregir-celda/route.ts (POST).
// Mismo criterio ya usado en el resto de rutas hermanas de esta
// familia: autenticarRequestApi hace una llamada de red real, no
// puede inyectarse — se confirma por inspección del código fuente.
//
// Se ejecuta con `npx tsx scripts/verificar-revisar-corregir-hoja-route.ts`.

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

const RUTA_REVISAR = join(__dirname, '..', 'app', 'api', 'proyectos-seguimiento', '[id]', 'revisar-hoja', 'route.ts')
const RUTA_CORREGIR = join(__dirname, '..', 'app', 'api', 'proyectos-seguimiento', '[id]', 'corregir-celda', 'route.ts')
const revisar = readFileSync(RUTA_REVISAR, 'utf-8')
const corregir = readFileSync(RUTA_CORREGIR, 'utf-8')

function main() {
  // ============================================================
  // revisar-hoja/route.ts (GET) — solo lectura.
  // ============================================================
  verificar(!revisar.includes('SERVICE_ROLE') && !revisar.includes('createClient('), '1. revisar-hoja: no referencia SERVICE_ROLE ni crea su propio cliente')
  verificar(revisar.includes('extraerBearerToken'), '2. revisar-hoja: se autentica vía Authorization Bearer (mismo patrón que el GET de app/api/proyectos-seguimiento/route.ts) — un GET no lleva body')
  verificar(revisar.includes('const docenteId = auth.user.id'), '3. revisar-hoja: docenteId se resuelve SIEMPRE de auth.user.id')
  verificar(/proyecto\.docente_id !== docenteId/.test(revisar), '4. revisar-hoja: rechaza explícitamente un proyecto que no pertenece al docente real')
  verificar(revisar.includes('construirMatrizRevision'), '5. revisar-hoja: usa construirMatrizRevision (lógica pura ya probada) en vez de reimplementar el matching')
  verificar(!revisar.includes('.insert(') && !revisar.includes('.update(') && !revisar.includes('.upsert(') && !revisar.includes('.delete('), '6. revisar-hoja: 0 escrituras — es un endpoint puramente de lectura (ni siquiera actualizado_en)')
  verificar(!/anthropic\.messages|new Anthropic/i.test(revisar), '7. revisar-hoja: 0 llamadas IA')
  verificar(!revisar.includes(".from('seguimiento_resultados')"), '8. revisar-hoja: nunca lee/escribe seguimiento_resultados — solo captura_pendiente/hoja')

  // ============================================================
  // corregir-celda/route.ts (POST) — única escritura: captura_pendiente.
  // ============================================================
  verificar(!corregir.includes('SERVICE_ROLE') && !corregir.includes('createClient('), '9. corregir-celda: no referencia SERVICE_ROLE ni crea su propio cliente')
  verificar(corregir.includes('autenticarRequestApi'), '10. corregir-celda: se autentica con autenticarRequestApi (access_token en el body, mismo patrón que foto-hoja/analizar-hoja/confirmar-hoja)')
  verificar(corregir.includes('const docenteId = auth.user.id'), '11. corregir-celda: docenteId se resuelve SIEMPRE de auth.user.id (nunca de un campo del body)')
  verificar(/proyecto\.docente_id !== docenteId/.test(corregir), '12. corregir-celda: rechaza explícitamente un proyecto que no pertenece al docente real')
  verificar(/proyecto\.estado !== 'requiere_revision'/.test(corregir), "13. corregir-celda: solo permite corregir mientras el proyecto está en 'requiere_revision' (rechaza tanto 'no analizado' como 'ya confirmado')")
  verificar(/nivel < 1 \|\| nivel > 4/.test(corregir), '14. corregir-celda: valida que el nivel corregido esté en 1-4 (o sea null)')
  verificar(corregir.includes("estado: 'no_evaluado'") && corregir.includes("estado: 'nivel'"), '15. corregir-celda: nivel=null se convierte en no_evaluado; un número 1-4 en nivel — nunca se aproxima')
  verificar(corregir.includes('corregidoManualmente: true'), '16. corregir-celda: la celda corregida siempre queda marcada corregidoManualmente=true')
  verificar(corregir.includes("confianza: 'alta'"), "17. corregir-celda: la confianza de una celda corregida por el docente siempre es 'alta' — es la fuente directa, no una lectura de la IA")
  verificar(!corregir.includes(".from('seguimiento_resultados')") && !corregir.includes('.insert(') , '18. corregir-celda: nunca escribe en seguimiento_resultados — solo actualiza captura_pendiente (el scratch area de EVAL-1B)')
  verificar(!/anthropic\.messages|new Anthropic/i.test(corregir), '19. corregir-celda: 0 llamadas IA — una corrección manual es lo opuesto a una lectura automática')
  verificar(!corregir.includes('.delete('), '20. corregir-celda: nunca ejecuta DELETE sobre filas de base de datos')

  // Reemplaza solo la celda corregida — el resto de filas/celdas se
  // conserva intacto (nunca reconstruye toda la transcripción).
  verificar(/celdas: fila\.celdas\.map\(\(celda, j\) => \(j === indiceCelda \? celdaCorregida : celda\)\)/.test(corregir), '21. corregir-celda: al reemplazar, conserva TODAS las demás celdas de la fila sin tocarlas (map por índice, solo la celda corregida cambia)')
  verificar(/i !== indiceFila\) return fila/.test(corregir), '22. corregir-celda: al reemplazar, conserva TODAS las demás filas sin tocarlas')

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
