// scripts/verificar-rag-bajo-demanda.ts
//
// P0-C1 — RAG bajo demanda y exclusión de la ficha descriptiva. Sin red
// ni llamadas facturables: comprueba sobre el código REAL de
// app/api/chat/route.ts que
// - el embedding + RPC solo se ejecuta desde un getter memoizado con un
//   único consumidor, situado después de TODAS las salidas anticipadas
//   (herramientas deterministas, aclaraciones, registros, lista oficial,
//   conversión…) y antes de las llamadas a Sonnet;
// - la ficha descriptiva nunca dispara el embedding;
// - conversación general / documento: exactamente 1 ejecución;
// - nunca más de 1 ejecución por petición; mismo contenido, errores y
//   timeout de siempre.
//
// Ejecutar: npx tsx --tsconfig ./tsconfig.json scripts/verificar-rag-bajo-demanda.ts
// Opcional: VERIFICAR_RUTA_CHAT (archivo a verificar), VERIFICAR_BASE_ARCHIVO
// o VERIFICAR_BASE_REF (route.ts anterior, para comparar buscarContextoRAG).

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    fallos++
    console.error(`✗ ${mensaje}`)
  }
}

const RAIZ = join(__dirname, '..')
const RUTA = process.env.VERIFICAR_RUTA_CHAT || join(RAIZ, 'app/api/chat/route.ts')
const BASE_REF = process.env.VERIFICAR_BASE_REF || '31257c2aebd5934d59f15bc591b54a00068f2a9f'
// SHA-256 del bloque de existencia de documentos autorizado en buscarContextoRAG (ver sección 3).
const HASH_BLOQUE_EXISTENCIA = 'b4681b48d149a588bde04afdd5a5fd7edc06b333d67d14ef4713255ac7b1064e'
// SHA-256 del formato autorizado del contexto documental (fuentes, delimitadores y normalización).
const HASH_FORMATO_DOCUMENTAL = '1b9254651850d241e73e5de7921d5d2ffb7e7f7a5b33c624c73fd8458476c99b'

function cuerpoFuncion(s: string, firma: string): string {
  const i = s.indexOf(firma)
  if (i < 0) return ''
  let d = 0
  for (let k = s.indexOf('{', i + firma.length - 1); k < s.length; k++) {
    if (s[k] === '{') d++
    else if (s[k] === '}') { d--; if (d === 0) return s.slice(i, k + 1) }
  }
  return ''
}

async function main() {
  const fuente = readFileSync(RUTA, 'utf8')
  let base = ''
  try {
    base = process.env.VERIFICAR_BASE_ARCHIVO ? readFileSync(process.env.VERIFICAR_BASE_ARCHIVO, 'utf8') : execFileSync('git', ['show', `${BASE_REF}:app/api/chat/route.ts`], { cwd: RAIZ, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch {
    base = ''
  }

  // ===== 1. Estructura: un solo camino y un solo consumidor =====
  console.log('\n— 1. Estructura (código real) —')
  const pGetter = fuente.indexOf('  const obtenerContextoRAGPromise = (): Promise<string> => {')
  const finGetter = fuente.indexOf('\n  }\n', pGetter) + 4
  const getter = fuente.slice(pGetter, finGetter)
  // Privacidad RAG: la consulta protegida (consultaRAG) se declara junto
  // al getter y forma parte del mismo tramo.
  const pDeclaracion = fuente.indexOf('  let consultaRAGPreparada: ConsultaEmbedding | null = null')
  verificar(pDeclaracion > 0 && pGetter > pDeclaracion && finGetter > pGetter, 'getter memoizado obtenerContextoRAGPromise() declarado (promesa en una variable de la petición)')
  verificar(/if \(!contextoRAGPromise\) \{/.test(getter) && /return contextoRAGPromise/.test(getter), 'el getter reutiliza la promesa ya creada (memoización)')
  const invocaciones = (fuente.match(/buscarContextoRAG\(supabaseUser/g) || []).length
  verificar(invocaciones === 1 && getter.includes('buscarContextoRAG(supabaseUser, consulta.texto, sesion.institucion_id)') && getter.includes('consulta?.enviar'), 'buscarContextoRAG solo se invoca dentro del getter, con la copia protegida del mensaje (y solo si la consulta puede enviarse)')
  const usos = [...fuente.matchAll(/obtenerContextoRAGPromise\(\)/g)].map((m) => m.index!)
  verificar(usos.length === 1, `el getter tiene exactamente 1 consumidor (${usos.length})`)
  const pConsumo = usos[0] ?? -1
  const fueraDelGetter = fuente.slice(0, pDeclaracion) + fuente.slice(finGetter)
  verificar(!/contextoRAGPromise(?!\))/.test(fueraDelGetter.replace(/\/\/.*$/gm, '').replace(/obtenerContextoRAGPromise/g, '')), 'la promesa no se usa fuera del getter (nadie la arranca por adelantado)')
  const pParametros = fuente.indexOf('  const parametrosClaude = {')
  const llamadasSonnet = [...fuente.matchAll(/client\.messages\.create\(\{ \.\.\.parametrosClaude|client\.messages\.create\(\{\n\s+\.\.\.parametrosClaude,/g)].map((m) => m.index!)
  verificar(pConsumo > 0 && pConsumo < pParametros && llamadasSonnet.length === 3 && llamadasSonnet.every((p) => p > pConsumo), 'el consumidor está antes de armar el prompt y antes de las 3 llamadas a Sonnet (conversación, documento, continuación)')
  const salidas = [...fuente.matchAll(/return (respuestaTexto|NextResponse\.json|new Response)\(/g)].map((m) => m.index!).filter((p) => p > finGetter && p < pParametros)
  verificar(salidas.length >= 40 && salidas.every((p) => p < pConsumo), `las ${salidas.length} salidas anticipadas (herramientas, aclaraciones, registros, lista oficial, conversión…) quedan ANTES del consumidor: ninguna puede generar embedding`)
  const pFicha = fuente.indexOf('esTurnoFichaDescriptiva = true')
  verificar(pFicha > 0 && pFicha < pConsumo && (fuente.match(/esTurnoFichaDescriptiva = true/g) || []).length === 1, 'la marca de ficha descriptiva se decide antes del consumidor')

  // ===== 2. Comportamiento con el código real del getter y del consumidor =====
  console.log('\n— 2. Comportamiento (mocks, sin red) —')
  const iniConsumo = fuente.lastIndexOf('  const consultaRAGTurno = esTurnoFichaDescriptiva', pConsumo)
  const finConsumo = fuente.indexOf('\n', fuente.indexOf(".catch(() => '')", pConsumo))
  const consumo = fuente.slice(iniConsumo, finConsumo)
  verificar(iniConsumo > 0 && /const contextoRAG = esTurnoFichaDescriptiva\n\s+\? ''\n\s+: await conLimiteDeTiempo\(obtenerContextoRAGPromise\(\), TIMEOUT_RAG_MS \+ 5_000, '[^']+'\)\.catch\(\(\) => ''\)/.test(consumo), 'consumidor: ficha → \'\'; resto → timeout + .catch(() => \'\') de siempre')
  const ts = (await import('typescript')).default
  const { prepararConsultaEmbedding } = await import(join(RAIZ, 'lib/asistente/consultaEmbedding.ts'))
  const js = ts.transpileModule(`async function __tramo(env: any) { const { mensaje, sesion, supabaseUser, buscarContextoRAG, conLimiteDeTiempo, TIMEOUT_RAG_MS, esTurnoFichaDescriptiva, console, consumirDosVeces, prepararConsultaEmbedding } = env\n${fuente.slice(pDeclaracion, finGetter)}\n if (consumirDosVeces) { void obtenerContextoRAGPromise() }\n${consumo}\n return { contextoRAG, rag } }`, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText
  const tramo = new Function(`${js}; return __tramo`)() as (env: Record<string, unknown>) => Promise<{ contextoRAG: string; rag: string }>
  const conLimiteDeTiempo = <T,>(p: Promise<T>, ms: number, msg: string) => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(msg)), ms))])
  const RECUPERADO = '\n\nINFORMACION DE DOCUMENTOS INSTITUCIONALES DISPONIBLES ...fragmento ficticio...'
  const correr = async (extra: Record<string, unknown> = {}, buscar?: (...a: unknown[]) => Promise<string>) => {
    const llamadas: unknown[][] = []
    const logs: string[] = []
    const env = {
      mensaje: 'Pregunta ficticia sobre el reglamento escolar', sesion: { institucion_id: '00000000-0000-4000-8000-0000000000aa' }, supabaseUser: { cliente: 'ficticio' },
      buscarContextoRAG: (...a: unknown[]) => { llamadas.push(a); return buscar ? buscar(...a) : Promise.resolve(RECUPERADO) },
      conLimiteDeTiempo, TIMEOUT_RAG_MS: 50, esTurnoFichaDescriptiva: false, console: { log: (m: string) => logs.push(m), error: () => {} }, consumirDosVeces: false, prepararConsultaEmbedding, ...extra,
    }
    const r = await tramo(env)
    return { ...r, llamadas, logs, env }
  }
  const general = await correr()
  verificar(general.llamadas.length === 1 && general.contextoRAG === RECUPERADO && general.rag === 'ejecutado', 'conversación general / documento: 1 ejecución y el contenido recuperado llega sin cambios')
  verificar(JSON.stringify(general.llamadas[0]) === JSON.stringify([general.env.supabaseUser, general.env.mensaje, (general.env.sesion as { institucion_id: string }).institucion_id]), 'argumentos idénticos a los de siempre (cliente autenticado, mensaje, institución de la sesión)')
  const ficha = await correr({ esTurnoFichaDescriptiva: true })
  verificar(ficha.llamadas.length === 0 && ficha.contextoRAG === '' && ficha.rag === 'omitido_ficha', 'ficha descriptiva: 0 embeddings y sin documentos institucionales')
  const doble = await correr({ consumirDosVeces: true })
  verificar(doble.llamadas.length === 1 && doble.contextoRAG === RECUPERADO, 'dos consumos en la misma petición → 1 sola ejecución (memoizada)')
  const noAplica = await Promise.all([correr({ mensaje: '   ' }), correr({ sesion: { institucion_id: null } }), correr({ sesion: null }), correr({ supabaseUser: null })])
  verificar(noAplica.every((r) => r.llamadas.length === 0 && r.contextoRAG === '' && r.rag === 'no_aplica'), 'sin texto, sin institución, sin sesión o sin cliente autenticado → 0 embeddings y \'\' (falla segura de siempre)')
  const conError = await correr({}, () => Promise.reject(new Error('fallo ficticio')))
  const conTimeout = await correr({}, () => new Promise<string>(() => {}))
  verificar(conError.contextoRAG === '' && conTimeout.contextoRAG === '' && conError.llamadas.length === 1, 'error o timeout del RAG → \'\' y el turno continúa (manejo de siempre)')
  const estados = [general, ficha, ...noAplica].flatMap((r) => r.logs)
  verificar(estados.every((l) => /^\[RAG_USO\] estado=(ejecutado|omitido_ficha|no_aplica|omitido_privacidad|omitido_error)( nombres=\d+ curp=\d+ contacto=\d+ fechas=\d+)?$/.test(l)), 'telemetría [RAG_USO]: solo un estado de lista cerrada y conteos (nunca mensaje, documentos ni ids)')

  // ===== 3. Recuperación y protecciones intactas =====
  console.log('\n— 3. Recuperación sin cambios —')
  const fnActual = cuerpoFuncion(fuente, 'async function buscarContextoRAG(')
  const fnBase = base ? cuerpoFuncion(base, 'async function buscarContextoRAG(') : ''
  // La única diferencia admitida es la comprobación previa de existencia de documentos
  // (constantes + bloque hasta «if (existencia === 'no') return ''»), verificada aparte en
  // verificar-rag-sin-documentos.ts. Ese bloque exacto queda fijado por su SHA-256: cualquier
  // cambio en él falla aquí hasta revisarlo y actualizar el hash a propósito. Todo lo demás
  // debe seguir idéntico byte a byte.
  const bloqueExistencia = fnActual.match(/\n  const RE_UUID_INSTITUCION = [^\n]*\n  const TIMEOUT_EXISTENCIA_RAG_MS = [^\n]*(\n  try \{\n)[\s\S]*?\n    if \(existencia === 'no'\) return ''\n\n/)
  const hashBloque = bloqueExistencia ? createHash('sha256').update(bloqueExistencia[0]).digest('hex') : ''
  verificar(hashBloque === HASH_BLOQUE_EXISTENCIA, `bloque de existencia autorizado intacto (sha256 ${hashBloque.slice(0, 12) || 'no encontrado'})`)
  const sinExistencia = bloqueExistencia ? fnActual.replace(bloqueExistencia[0], () => bloqueExistencia[1]) : fnActual
  // Segunda diferencia admitida: el formato del contexto documental (entre «return ''» tras la RPC
  // y el catch final), fijado también por su SHA-256 y probado en verificar-rag-formato-documental.ts.
  const FIN_RPC = "    if (error || !data || data.length === 0) return ''\n\n"
  const formato = (f: string) => { const a = f.indexOf(FIN_RPC), b = a < 0 ? -1 : f.indexOf('  } catch (e) {', a); return a < 0 || b < 0 ? null : f.slice(a + FIN_RPC.length, b) }
  const sinFormato = (f: string) => { const x = formato(f); return x === null ? f : f.replace(FIN_RPC + x, () => FIN_RPC + '«formato»\n') }
  const formatoActual = formato(fnActual)
  const hashFormato = formatoActual === null ? '' : createHash('sha256').update(formatoActual).digest('hex')
  verificar(hashFormato === HASH_FORMATO_DOCUMENTAL, `formato del contexto documental autorizado intacto (sha256 ${hashFormato.slice(0, 12) || 'no encontrado'})`)
  verificar(!!fnBase && formato(fnBase) !== null && sinFormato(sinExistencia) === sinFormato(fnBase), `buscarContextoRAG idéntica byte a byte a la versión base (${BASE_REF.slice(0, 7)}) salvo la comprobación previa de existencia y el formato documental: mismo embedding, misma RPC, mismos errores`)
  verificar(/\$\{contextoEnriquecido\}` : ''\}\$\{contextoRAG\}\$\{contextoProceso\}/.test(fuente), 'el contenido recuperado se sigue insertando en el mismo punto del prompt (bloque C, sin caché)')
  verificar(/messages: \[\n\s+\.\.\.proyeccionSonnet\.historial,/.test(fuente) && /clasificarNivel0\(mensaje, sesion, proyeccionNivel0\.historial\.slice\(-4\)/.test(fuente) && (fuente.match(/cache_control: /g) || []).length === 2, 'P0-B y caché de Sonnet intactos')

  console.log(fallos === 0 ? '\nTodas las pruebas pasaron.' : `\n${fallos} prueba(s) fallaron.`)
  process.exit(fallos === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('ERROR DEL VERIFICADOR:', e)
  process.exit(1)
})
