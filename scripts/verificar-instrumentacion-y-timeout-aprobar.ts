// scripts/verificar-instrumentacion-y-timeout-aprobar.ts
//
// Fase "medición + protección contra timeout prematuro" (ver auditoría
// READ-ONLY "turno real Aprueba y guarda esa planeación — 6 minutos de
// espera sin respuesta visible en iPhone", aprobada por separado).
// Esta fase NO optimiza el flujo de aprobación — solo:
//
//   A) instrumenta lib/planeacion/aprobarBorrador.ts con marcas de
//      tiempo por fase (Date.now(), sin I/O adicional);
//   B) sube TIMEOUT_FETCH_MS (lib/asistente/motores/motorTextoClaude.ts)
//      de 130_000 a 190_000 — por encima de maxDuration=180s de
//      app/api/chat/route.ts — porque el cliente NO tiene, antes del
//      fetch, ninguna señal determinista de que un turno de texto es
//      una aprobación de planeación (esa clasificación es exclusiva de
//      Nivel0, server-side); inventar una heurística de texto sería
//      frágil y redundante.
//
// Esta prueba verifica, por lectura ESTRUCTURAL del código real (sin
// red, sin Supabase, sin IA — igual que el resto de esta familia de
// scripts) que:
//   1. La instrumentación es puramente aditiva (mismo número de
//      consultas .from(), mismo número de `return {`, mismo número de
//      `await` que ANTES de esta fase — ningún camino de control
//      cambió).
//   2. El chequeo YA_GUARDADA sigue exactamente igual.
//   3. No se agregó ninguna llamada IA (mismo número de fetch()/
//      messages.create en los archivos tocados).
//   4. No se agregó ninguna consulta/escritura Supabase nueva.
//   5. TIMEOUT_FETCH_MS (efectivo para el turno de aprobación, que cae
//      en el bucket "conversacional general") ya no es menor que
//      maxDuration de /api/chat.
//   6. Los presupuestos de los flujos especiales (finalizarArchivo,
//      varias imágenes, edición, imagen nueva, diagnóstico) no se
//      redujeron.
//   7. Los logs de tiempo tienen el prefijo pedido y nunca imprimen
//      contenido de la planeación, nombres de alumnos, CURP ni URLs
//      firmadas.
//
// Se ejecuta con
// `npx tsx scripts/verificar-instrumentacion-y-timeout-aprobar.ts`.

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
const aprobar = readFileSync(join(RAIZ, 'lib/planeacion/aprobarBorrador.ts'), 'utf-8')
const motorTexto = readFileSync(join(RAIZ, 'lib/asistente/motores/motorTextoClaude.ts'), 'utf-8')
const chatRoute = readFileSync(join(RAIZ, 'app/api/chat/route.ts'), 'utf-8')

const contar = (texto: string, patron: RegExp): number => (texto.match(patron) ?? []).length

async function main() {
  // ============================================================
  // 1. La instrumentación de aprobarBorrador.ts es puramente aditiva.
  //    Estos 3 conteos fueron tomados ANTES de esta fase (ver commit
  //    8000c3b, HEAD previo a esta corrección) y deben seguir
  //    EXACTAMENTE iguales: 11 consultas .from(), 20 `return {`, 28
  //    `await` — ni una consulta Supabase nueva, ni un camino de
  //    control nuevo, ni una operación async nueva.
  // ============================================================
  verificar(contar(aprobar, /\.from\(/g) === 11, `aprobarBorrador.ts sigue con EXACTAMENTE 11 consultas .from() (encontradas: ${contar(aprobar, /\.from\(/g)}) — cero consultas Supabase nuevas`)
  verificar(contar(aprobar, /return \{/g) === 20, `aprobarBorrador.ts sigue con EXACTAMENTE 20 \`return {\` (encontrados: ${contar(aprobar, /return \{/g)}) — ningún camino de control nuevo`)
  verificar(contar(aprobar, /await /g) === 28, `aprobarBorrador.ts sigue con EXACTAMENTE 28 \`await\` (encontrados: ${contar(aprobar, /await /g)}) — ninguna operación asíncrona nueva`)
  verificar(!/anthropic|messages\.create|Claude\.\w+\(/i.test(aprobar.replace(/\/\/.*$/gm, '')), 'aprobarBorrador.ts sigue sin ninguna llamada real a Claude/Anthropic (fuera de comentarios) — la aprobación sigue sin volver a redactar la planeación')

  // ============================================================
  // 2. El chequeo YA_GUARDADA no cambió.
  // ============================================================
  verificar(
    aprobar.includes("if (existente && existente.version >= 1) {") && aprobar.includes("codigo: 'YA_GUARDADA', mensaje: 'Esta planeación ya está guardada.'"),
    'El chequeo YA_GUARDADA (huella real contra planeaciones.version) sigue exactamente igual'
  )

  // ============================================================
  // 3. Instrumentación: prefijo consistente, una marca por fase
  //    pedida, y nunca imprime datos sensibles.
  // ============================================================
  const FASES_ESPERADAS = ['fase0_snapshot', 'chequeo_ya_guardada', 'fase1', 'fase2', 'fase3', 'fase4_hoja', 'fase4_5_word', 'fase4_5_pdf', 'fase5', 'fase6_confirmar', 'total']
  for (const fase of FASES_ESPERADAS) {
    verificar(aprobar.includes(`marcarFase('${fase}')`), `Existe una marca de tiempo para la fase "${fase}"`)
  }
  verificar(aprobar.includes('[APROBAR_PLANEACION:TIEMPO]'), 'El prefijo de log pedido [APROBAR_PLANEACION:TIEMPO] está presente')
  verificar((aprobar.match(/console\.log\(`\[APROBAR_PLANEACION:TIEMPO\]/g) ?? []).length === 1, 'Existe UN SOLO punto de emisión del log de tiempo (dentro de marcarFase) — nunca duplicado por fase')
  // La línea de log de marcarFase solo interpola `fase`/duracionMs/
  // acumuladoMs — nunca resumen.nombre, alumnos, CURP ni una URL.
  const lineaLog = aprobar.match(/console\.log\(`\[APROBAR_PLANEACION:TIEMPO\][^`]*`\)/)?.[0] ?? ''
  verificar(lineaLog.length > 0 && !/resumen\.|alumno|curp|CURP|url|Url|URL/.test(lineaLog), 'La línea de log de tiempo nunca interpola contenido de la planeación, alumnos, CURP ni URLs firmadas')

  // Cada return de error/éxito dentro del try principal termina en un
  // marcarFase('total') antes de salir — para que TODA ejecución real
  // (éxito o fallo) deje un total medible, nunca solo el camino feliz.
  const totalesEncontrados = (aprobar.match(/marcarFase\('total'\)/g) ?? []).length
  verificar(totalesEncontrados >= 7, `Existen al menos 7 puntos de marcarFase('total') (uno por cada salida real del try, éxito y fallos) — encontrados: ${totalesEncontrados}`)

  // ============================================================
  // 4. TIMEOUT_FETCH_MS ya no es menor que maxDuration de /api/chat.
  // ============================================================
  const maxDurationMatch = chatRoute.match(/export const maxDuration = (\d+)/)
  verificar(!!maxDurationMatch, 'Se pudo leer el maxDuration real declarado en app/api/chat/route.ts')
  const maxDurationMs = Number(maxDurationMatch?.[1] ?? 0) * 1000
  const timeoutFetchMatch = motorTexto.match(/const TIMEOUT_FETCH_MS = (\d+)_?(\d*)/)
  const timeoutFetchMs = timeoutFetchMatch ? Number(`${timeoutFetchMatch[1]}${timeoutFetchMatch[2]}`) : 0
  verificar(timeoutFetchMs === 190_000, `TIMEOUT_FETCH_MS es EXACTAMENTE 190000 (encontrado: ${timeoutFetchMs})`)
  verificar(timeoutFetchMs >= maxDurationMs, `TIMEOUT_FETCH_MS (${timeoutFetchMs}ms) ya NO es menor que maxDuration del servidor (${maxDurationMs}ms) — el cliente nunca abandona antes de que el servidor agote su propio presupuesto`)
  verificar(timeoutFetchMs - maxDurationMs === 10_000, `El margen sobre maxDuration es de 10000ms (190s - 180s), tal como se pidió (encontrado: ${timeoutFetchMs - maxDurationMs}ms)`)

  // ============================================================
  // 5. Ningún otro presupuesto de timeout se redujo por ESTA fase —
  //    solo se tocó TIMEOUT_FETCH_MS aquí. TIMEOUT_FETCH_DOCUMENTO_MS/
  //    TIMEOUT_FETCH_IMAGEN_MS y la agrupación del ternario cambiaron
  //    después, en la fase "coherencia de timeouts del Chat IA —
  //    OpenAI Images" (aprobada por separado, ver
  //    scripts/verificar-timeout-openai-imagenes.ts para su propia
  //    suite dedicada) — esta prueba solo confirma que ninguno de esos
  //    valores posteriores quedó por DEBAJO de lo que tenía en esta
  //    fase (nunca una reducción), no que sean idénticos para siempre.
  // ============================================================
  verificar(/const TIMEOUT_SESION_MS = 12_000/.test(motorTexto), 'TIMEOUT_SESION_MS sigue en 12_000 — sin cambios')
  verificar(/const TIMEOUT_FETCH_DIAGNOSTICO_MS = 90_000/.test(motorTexto), 'TIMEOUT_FETCH_DIAGNOSTICO_MS sigue en 90_000 — sin cambios')
  verificar(/const TIMEOUT_FETCH_DOCUMENTO_MS = 130_000/.test(motorTexto), 'TIMEOUT_FETCH_DOCUMENTO_MS (esVariasImagenes/esEdicionDocumento) sigue en 130_000 — nunca reducido')
  const timeoutFetchImagenMatchV2 = motorTexto.match(/const TIMEOUT_FETCH_IMAGEN_MS = (\d+)_?(\d*)/)
  const timeoutFetchImagenMsV2 = timeoutFetchImagenMatchV2 ? Number(`${timeoutFetchImagenMatchV2[1]}${timeoutFetchImagenMatchV2[2]}`) : 0
  verificar(timeoutFetchImagenMsV2 >= 150_000, `TIMEOUT_FETCH_IMAGEN_MS nunca quedó por debajo de 150_000 (valor de esta fase) — encontrado: ${timeoutFetchImagenMsV2} (subió a 190_000 en la fase posterior de OpenAI Images, nunca bajó)`)

  // La rama que selecciona el timeout sigue evaluando exactamente las
  // mismas 6 señales deterministas de siempre (finalizarArchivo,
  // esVariasImagenes, regenerarImagen, esEdicionDocumento,
  // esImagenNuevaDesdeTexto, diagnosticoActivo) — la fase posterior de
  // OpenAI Images reagrupó CUÁLES de ellas comparten bucket (ver su
  // propia suite), pero ninguna señal nueva se agregó ni se quitó.
  for (const senal of ['finalizarArchivo', 'esVariasImagenes', 'regenerarImagen', 'esEdicionDocumento', 'esImagenNuevaDesdeTexto', 'diagnosticoActivo']) {
    verificar(motorTexto.includes(senal), `El ternario sigue considerando la señal "${senal}" — ninguna señal determinista se perdió`)
  }

  // ============================================================
  // 6. Cero llamadas IA/fetch nuevas en motorTextoClaude.ts — mismo
  //    número de fetch('/api/chat', ...) que antes de esta fase (2:
  //    enviarTexto y generarArchivoDirecto).
  // ============================================================
  verificar(contar(motorTexto, /fetch\('\/api\/chat'/g) === 2, `motorTextoClaude.ts sigue con EXACTAMENTE 2 fetch('/api/chat', ...) (encontrados: ${contar(motorTexto, /fetch\('\/api\/chat'/g)}) — cero llamadas nuevas`)

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
