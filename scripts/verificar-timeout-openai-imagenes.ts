// scripts/verificar-timeout-openai-imagenes.ts
//
// Fase "coherencia de timeouts del Chat IA — OpenAI Images" (ver
// auditoría READ-ONLY aprobada por separado). Corrección de dos
// partes:
//
//   A) lib/imageGen/proveedores/openaiImagenes.ts — images.generate()
//      e images.edit() NO tenían timeout propio (SDK default = 600s,
//      ver node_modules/openai/client.js: DEFAULT_TIMEOUT=600000). Se
//      agrega TIMEOUT_OPENAI_IMAGENES_MS=140_000 (140s) — evidencia
//      real ~111.4s + margen de ~25%, deja 40s de presupuesto real
//      (maxDuration=180s - 140s) para el resto del pipeline
//      (verificación de buffer, Storage, URL firmada, persistencia).
//
//   B) lib/asistente/motores/motorTextoClaude.ts — finalizarArchivo y
//      regenerarImagen (SÍ pueden llamar a OpenAI Images) salen del
//      bucket TIMEOUT_FETCH_DOCUMENTO_MS (130s) y se unen a
//      TIMEOUT_FETCH_IMAGEN_MS, que sube de 150_000 a 190_000
//      (maxDuration=180s + 10s, mismo criterio ya usado en
//      TIMEOUT_FETCH_MS). esVariasImagenes y esEdicionDocumento
//      CONSERVAN 130s sin cambio — ninguno de los dos llama realmente
//      a OpenAI Images (confirmado por auditoría de código).
//
// Se ejecuta con
// `npx tsx scripts/verificar-timeout-openai-imagenes.ts`.

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

const RAIZ = join(__dirname, '..')
const openaiImagenes = readFileSync(join(RAIZ, 'lib/imageGen/proveedores/openaiImagenes.ts'), 'utf-8')
const motorTexto = readFileSync(join(RAIZ, 'lib/asistente/motores/motorTextoClaude.ts'), 'utf-8')
const chatRoute = readFileSync(join(RAIZ, 'app/api/chat/route.ts'), 'utf-8')
const herramientas = readFileSync(join(RAIZ, 'lib/documentGen/herramientas.ts'), 'utf-8')

const contar = (texto: string, patron: RegExp): number => (texto.match(patron) ?? []).length

async function main() {
  // ============================================================
  // 1-3. images.generate/images.edit reciben timeout explícito, ambas
  // con el MISMO valor canónico.
  // ============================================================
  verificar(/const TIMEOUT_OPENAI_IMAGENES_MS = 140_000/.test(openaiImagenes), '1. TIMEOUT_OPENAI_IMAGENES_MS está declarado en 140_000 (140s)')
  const bloqueGenerate = openaiImagenes.match(/images\.generate\(\s*\{[\s\S]*?\},\s*\{[\s\S]*?\}\s*\)/)?.[0] ?? ''
  const bloqueEdit = openaiImagenes.match(/images\.edit\(\s*\{[\s\S]*?\},\s*\{[\s\S]*?\}\s*\)/)?.[0] ?? ''
  verificar(bloqueGenerate.includes('{ timeout: TIMEOUT_OPENAI_IMAGENES_MS }'), '2. images.generate() recibe { timeout: TIMEOUT_OPENAI_IMAGENES_MS } como segundo argumento real')
  verificar(bloqueEdit.includes('{ timeout: TIMEOUT_OPENAI_IMAGENES_MS }'), '3. images.edit() recibe { timeout: TIMEOUT_OPENAI_IMAGENES_MS } como segundo argumento real — MISMO valor canónico que generate()')

  // ============================================================
  // 4. El timeout interno es menor que maxDuration=180 y deja margen
  //    real para terminar el pipeline (nunca 180s exactos).
  // ============================================================
  const maxDurationMatch = chatRoute.match(/export const maxDuration = (\d+)/)
  const maxDurationMs = Number(maxDurationMatch?.[1] ?? 0) * 1000
  verificar(maxDurationMs === 180_000, `Se confirma maxDuration=180 en app/api/chat/route.ts (leído: ${maxDurationMs}ms)`)
  verificar(140_000 < maxDurationMs, '4a. TIMEOUT_OPENAI_IMAGENES_MS (140_000) es MENOR que maxDuration (180_000)')
  verificar(maxDurationMs - 140_000 === 40_000, '4b. El margen que deja para el resto del pipeline (Storage/URL firmada/persistencia) es de 40000ms — ni 0 ni el presupuesto completo')
  const timeoutOpenaiImagenesMs: number = 140_000
  verificar(timeoutOpenaiImagenesMs !== maxDurationMs, '4c. El timeout interno NUNCA es igual a maxDuration — no agota el presupuesto completo del handler')

  // ============================================================
  // 5-7. Timeouts de cliente coherentes con maxDuration para los 3
  //      caminos que sí pueden llamar a OpenAI Images.
  // ============================================================
  const timeoutFetchImagenMatch = motorTexto.match(/const TIMEOUT_FETCH_IMAGEN_MS = (\d+)_?(\d*)/)
  const timeoutFetchImagenMs = timeoutFetchImagenMatch ? Number(`${timeoutFetchImagenMatch[1]}${timeoutFetchImagenMatch[2]}`) : 0
  verificar(timeoutFetchImagenMs === 190_000, `TIMEOUT_FETCH_IMAGEN_MS es EXACTAMENTE 190000 (encontrado: ${timeoutFetchImagenMs})`)
  verificar(timeoutFetchImagenMs >= maxDurationMs, `5. Imagen nueva desde texto (esImagenNuevaDesdeTexto) usa TIMEOUT_FETCH_IMAGEN_MS (${timeoutFetchImagenMs}ms) — ya NO menor que maxDuration (${maxDurationMs}ms)`)

  const ternarioReal = motorTexto.match(/temporizadorFetch = setTimeout\(\s*\(\) => this\.controlador\?\.abort\(\),\s*([\s\S]*?)\n\s*\)/)?.[1] ?? ''
  verificar(
    /finalizarArchivo \|\| regenerarImagen \|\| esImagenNuevaDesdeTexto\s*\n\s*\? TIMEOUT_FETCH_IMAGEN_MS/.test(ternarioReal),
    '6. regenerarImagen comparte el mismo bucket TIMEOUT_FETCH_IMAGEN_MS que esImagenNuevaDesdeTexto (mismo riesgo real: llama a OpenAI Images)'
  )
  verificar(
    /finalizarArchivo \|\| regenerarImagen \|\| esImagenNuevaDesdeTexto/.test(ternarioReal),
    '7. finalizarArchivo también quedó en el bucket TIMEOUT_FETCH_IMAGEN_MS (documento ilustrado: puede disparar generarImagenesParaDocumento)'
  )

  // ============================================================
  // 8. esEdicionDocumento CONSERVA su timeout/comportamiento actual
  //    (130s) — no se amplió solo porque comparte código con
  //    regenerarImagen/finalizarArchivo.
  // ============================================================
  verificar(/const TIMEOUT_FETCH_DOCUMENTO_MS = 130_000/.test(motorTexto), '8a. TIMEOUT_FETCH_DOCUMENTO_MS sigue en 130_000 — sin cambio de valor')
  verificar(
    /esVariasImagenes \|\| esEdicionDocumento\s*\n\s*\? TIMEOUT_FETCH_DOCUMENTO_MS/.test(ternarioReal),
    '8b. esEdicionDocumento sigue usando TIMEOUT_FETCH_DOCUMENTO_MS (130s) — NO se amplió a 190s'
  )
  verificar(!/finalizarArchivo \|\| esVariasImagenes \|\| regenerarImagen \|\| esEdicionDocumento/.test(motorTexto), '8c. El bucket ANTERIOR (los 4 juntos en TIMEOUT_FETCH_DOCUMENTO_MS) ya no existe en el código')

  // ============================================================
  // 9. esVariasImagenes NO se trata como generación OpenAI Images —
  //    sigue en el bucket de 130s, sin evidencia real que justifique
  //    cambiarlo (solo riesgo teórico, según la propia auditoría).
  // ============================================================
  verificar(
    /esVariasImagenes \|\| esEdicionDocumento\s*\n\s*\? TIMEOUT_FETCH_DOCUMENTO_MS/.test(ternarioReal),
    '9. esVariasImagenes permanece en TIMEOUT_FETCH_DOCUMENTO_MS (130s) — no se movió al bucket de imágenes'
  )
  // Confirmación estructural real: generarImagenesParaDocumento (el
  // único punto donde se generan imágenes embebidas) solo se invoca
  // dentro de CASO 3, nunca en el flujo de esVariasImagenes/esEdicionDocumento.
  const llamadasGenerarImagenesParaDocumento = contar(chatRoute, /generarImagenesParaDocumento\(/g)
  verificar(llamadasGenerarImagenesParaDocumento === 1, `9b. generarImagenesParaDocumento() se invoca EXACTAMENTE una vez en route.ts (dentro de CASO 3) — encontradas: ${llamadasGenerarImagenesParaDocumento}`)
  verificar(chatRoute.includes('const tipoHerramientaSolicitado: TipoHerramienta | null = esEdicionDocumento\n    ? null'), '9c. esEdicionDocumento=true sigue anulando tipoHerramientaSolicitado — nunca llega a CASO 3, nunca puede generar imágenes embebidas')

  // ============================================================
  // 10-11. Cero llamadas IA nuevas, cero operaciones Supabase nuevas.
  // ============================================================
  verificar(contar(openaiImagenes, /\.images\.(generate|edit)\(/g) === 2, `10. openaiImagenes.ts sigue con EXACTAMENTE 2 llamadas reales al proveedor (generate + edit) — encontradas: ${contar(openaiImagenes, /\.images\.(generate|edit)\(/g)}`)
  verificar(!/anthropic|messages\.create/i.test(openaiImagenes), '10b. openaiImagenes.ts sigue sin ninguna referencia a Anthropic/Claude')
  verificar(!/supabase|createClient|SupabaseClient/i.test(openaiImagenes), '11. openaiImagenes.ts sigue sin ninguna referencia a Supabase — cero operaciones de base de datos')
  verificar(contar(motorTexto, /fetch\('\/api\/chat'/g) === 2, `10c. motorTextoClaude.ts sigue con EXACTAMENTE 2 fetch('/api/chat', ...) — encontrados: ${contar(motorTexto, /fetch\('\/api\/chat'/g)}`)

  // ============================================================
  // 12. Ningún parámetro de generación/edición cambió salvo timeout.
  // ============================================================
  verificar(openaiImagenes.includes("model: 'gpt-image-2'") && contar(openaiImagenes, /model: 'gpt-image-2'/g) === 2, '12a. model sigue en gpt-image-2 en ambas llamadas')
  verificar(openaiImagenes.includes('quality: calidad ?? \'medium\'') && openaiImagenes.includes("quality: 'medium'"), '12b. quality no cambió en ninguna de las dos llamadas')
  verificar(openaiImagenes.includes('n: 1') && openaiImagenes.includes("size: 'auto'"), '12c. n/size no cambiaron')
  verificar(!/maxRetries/.test(openaiImagenes), '12d. No se agregó ni se tocó maxRetries — el default del SDK (2 reintentos) sigue exactamente igual, sin cambios')

  // ============================================================
  // 13. La lógica de documentos ilustrados no cambió.
  // ============================================================
  verificar(herramientas.includes("if (!imagenesPorDescripcion && (tipo === 'word' || tipo === 'pdf')) {"), '13. La detección de documentos ilustrados en ejecutarHerramientaDocumento no cambió')
  verificar(contar(herramientas, /generarImagenesParaDocumento\(/g) <= 2, '13b. herramientas.ts no ganó ninguna llamada nueva a generarImagenesParaDocumento (definición + 0-1 uso interno)')

  // ============================================================
  // 14-15. El flujo de planeaciones y "Aprobar y guardar" no cambiaron.
  // ============================================================
  const aprobarBorrador = readFileSync(join(RAIZ, 'lib/planeacion/aprobarBorrador.ts'), 'utf-8')
  verificar(contar(aprobarBorrador, /\.from\(/g) === 11, `14. lib/planeacion/aprobarBorrador.ts sigue con EXACTAMENTE 11 consultas .from() — sin tocar en esta fase (encontradas: ${contar(aprobarBorrador, /\.from\(/g)})`)
  verificar(aprobarBorrador.includes("codigo: 'YA_GUARDADA', mensaje: 'Esta planeación ya está guardada.'"), '15. El chequeo YA_GUARDADA de "Aprobar y guardar" sigue exactamente igual — no se tocó ese archivo en esta fase')
  verificar(!/TIMEOUT_OPENAI_IMAGENES_MS|TIMEOUT_FETCH_IMAGEN_MS|TIMEOUT_FETCH_DOCUMENTO_MS/.test(aprobarBorrador), '15b. aprobarBorrador.ts no referencia ninguno de los timeouts tocados en esta fase — flujo de planeaciones completamente aislado de este cambio')

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
