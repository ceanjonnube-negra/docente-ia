// scripts/verificar-rag-mensaje-social.ts
//
// RAG — omisión para mensajes PURAMENTE sociales (lib/asistente/mensajeSocial.ts
// y su uso en consultaRAG de app/api/chat/route.ts). Sin red ni llamadas reales.
// 1. esMensajePuramenteSocial (código real): lista cerrada, sin coincidencias
//    parciales; mixtos, académicos cortos, seguimientos y ambiguos → false.
// 2. Tramo REAL de route.ts (consulta protegida + getter + consumidor +
//    buscarContextoRAG) con Supabase y OpenAI simulados, comparado con HEAD:
//    social → 0 existencia, 0 embeddings, 0 RPC y [RAG_USO] estado=omitido_social;
//    cualquier otro mensaje → exactamente las mismas llamadas y el mismo contexto.
// 3. Estructura: una sola invocación, antes de prepararConsultaEmbedding; el
//    módulo no importa nada ni hace red.
//
// Ejecutar: npx tsx --tsconfig ./tsconfig.json scripts/verificar-rag-mensaje-social.ts
// Opcional: VERIFICAR_RAIZ (raíz alternativa) y VERIFICAR_BASE_CHAT (route.ts de
// referencia; por defecto `git show HEAD:app/api/chat/route.ts`).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    fallos++
    console.error(`✗ ${mensaje}`)
  }
}

const RAIZ = process.env.VERIFICAR_RAIZ || join(__dirname, '..')

const SOCIALES = ['Hola', 'hola', '  HOLA  ', '¡Hola!', 'Hola, buenas noches', 'Buenos días', 'buenos dias', 'Buenas noches, ¿cómo estás?', '¿Qué tal?',
  'Gracias', '¡Muchas gracias!', 'Gracias, eso es todo', 'Mil gracias.', 'Ok', 'OK.', 'Ok, perfecto', 'Perfecto', 'Entendido', 'De acuerdo', 'Listo, gracias', 'Hasta mañana']
const MIXTOS = ['Hola, ¿qué dice el reglamento?', 'Gracias, ¿y los retardos?', 'Ok, explícame la evaluación formativa.', 'Buenas noches, necesito una planeación.',
  'Gracias!!! ¿y la feria?', 'Perfecto, ahora la rúbrica', 'Hola, soy la maestra de 4.º B', 'Buenas noches, ¿cómo estás? ¿qué dice el protocolo?', 'Gracias por el reglamento']
const ACADEMICOS_CORTOS = ['retardos', 'tolerancia', 'feria de ciencias', '¿retroalimentación?', 'uniforme', 'planeación', 'evaluación formativa', 'acoso']
const SEGUIMIENTOS = ['¿Y cuántos son una falta?', '¿Y si no la entrego a tiempo?', '¿y luego?', '¿Y eso?', '¿Y para tercer grado?']
const AMBIGUOS = ['Sí', 'sí', 'Claro', 'Dale', 'Hazlo', 'Sí, por favor', 'No', 'Va', 'Ok hazlo', 'Hola buenas noches', 'Hola 👋', 'gracias gracias gracias',
  'Hola, hola, hola, hola', 'Buenos días a todos', '', '   ', '¿?', 'Hola, ' + 'x'.repeat(90)]

function tramoReal(fuente: string) {
  const iniFn = fuente.indexOf('async function buscarContextoRAG(')
  let k = fuente.indexOf('{', fuente.indexOf(')', fuente.indexOf('institucionId: string | null)', iniFn))), d = 0
  for (; k < fuente.length; k++) { if (fuente[k] === '{') d++; else if (fuente[k] === '}') { d--; if (d === 0) break } }
  const pDecl = fuente.indexOf('  let consultaRAGPreparada: ConsultaEmbedding | null = null')
  const pGetter = fuente.indexOf('  const obtenerContextoRAGPromise = (): Promise<string> => {')
  const finGetter = fuente.indexOf('\n  }\n', pGetter) + 4
  const pConsumo = fuente.indexOf('  const contextoRAG = esTurnoFichaDescriptiva')
  const iniConsumo = fuente.lastIndexOf('  const consultaRAGTurno = esTurnoFichaDescriptiva', pConsumo)
  const finConsumo = fuente.indexOf('\n', fuente.indexOf(".catch(() => '')", pConsumo))
  if (iniFn < 0 || pDecl < 0 || pGetter < pDecl || iniConsumo < finGetter) throw new Error('tramos reales no localizados')
  return `${fuente.slice(iniFn, k + 1)}\nasync function __tramo(env: any) { const { mensaje, sesion, supabaseUser, conLimiteDeTiempo, TIMEOUT_RAG_MS, esTurnoFichaDescriptiva, console, prepararConsultaEmbedding, esMensajePuramenteSocial } = env\n${fuente.slice(pDecl, finGetter)}\n${fuente.slice(iniConsumo, finConsumo)}\n return { contextoRAG, rag } }`
}

async function main() {
  const ts = (await import('typescript')).default
  const { esMensajePuramenteSocial } = await import(join(RAIZ, 'lib/asistente/mensajeSocial.ts'))
  const { prepararConsultaEmbedding } = await import(join(RAIZ, 'lib/asistente/consultaEmbedding.ts'))
  const actual = readFileSync(join(RAIZ, 'app/api/chat/route.ts'), 'utf8')
  const base = process.env.VERIFICAR_BASE_CHAT ? readFileSync(process.env.VERIFICAR_BASE_CHAT, 'utf8') : execFileSync('git', ['show', 'HEAD:app/api/chat/route.ts'], { cwd: RAIZ, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

  console.log('\n— 1. esMensajePuramenteSocial (código real) —')
  const malSociales = SOCIALES.filter((m) => esMensajePuramenteSocial(m) !== true)
  verificar(malSociales.length === 0, `saludos, agradecimientos y acuses triviales → social (${SOCIALES.length} casos${malSociales.length ? `; fallan: ${malSociales.join(' | ')}` : ''})`)
  for (const [nombre, casos] of [['mensajes mixtos', MIXTOS], ['consultas académicas cortas', ACADEMICOS_CORTOS], ['preguntas de seguimiento', SEGUIMIENTOS], ['ambiguos, asentimientos, emojis, sin puntuación, >3 partes, vacíos y largos', AMBIGUOS]] as const) {
    const mal = casos.filter((m) => esMensajePuramenteSocial(m) !== false)
    verificar(mal.length === 0, `${nombre} → NUNCA social, el RAG sigue igual (${casos.length} casos${mal.length ? `; fallan: ${mal.join(' | ')}` : ''})`)
  }
  verificar([null, undefined, 42, {}].every((v) => esMensajePuramenteSocial(v as unknown as string) === false), 'entrada que no es texto → false')

  console.log('\n— 2. Tramo real de route.ts frente a HEAD (mocks, sin red) —')
  const compilar = (src: string) => ts.transpileModule(tramoReal(src), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText
  const jsActual = compilar(actual), jsBase = compilar(base)
  const correr = async (js: string, mensaje: string, extra: Record<string, unknown> = {}) => {
    const llamadas = { existencia: 0, embeddings: 0, rpc: 0 }
    const logs: string[] = []
    const openaiRAG = { embeddings: { create: async () => { llamadas.embeddings++; return { data: [{ embedding: [0.1, 0.2] }] } } } }
    const consulta: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'is', 'or', 'limit', 'abortSignal']) consulta[m] = () => consulta
    consulta.then = (ok: (v: unknown) => unknown) => ok({ data: [{ id: 'doc-ficticio' }], error: null })
    const supabaseUser = {
      from: () => { llamadas.existencia++; return consulta },
      rpc: async () => { llamadas.rpc++; return { data: [{ categoria: 'Reglamentos', nombre_archivo: 'reglamento-ficticio.pdf', chunk_texto: 'Texto ficticio del reglamento.', similitud: 0.5 }], error: null } },
    }
    // El mismo console simulado para buscarContextoRAG ([RAG_DOCS]) y para el consumidor ([RAG_USO])
    const consola = { log: (m: string) => logs.push(String(m)), error: (m: string) => logs.push(String(m)) }
    const tramo = new Function('openaiRAG', 'TIMEOUT_RAG_MS', 'console', `${js}; return __tramo`)(openaiRAG, 50, consola) as (env: Record<string, unknown>) => Promise<{ contextoRAG: string; rag: string }>
    const env = { mensaje, sesion: { institucion_id: '00000000-0000-4000-8000-0000000000e1', alumnos_del_grupo_activo: [] }, supabaseUser, conLimiteDeTiempo: <T,>(p: Promise<T>) => p, TIMEOUT_RAG_MS: 50, esTurnoFichaDescriptiva: false,
      console: consola, prepararConsultaEmbedding, esMensajePuramenteSocial, ...extra }
    const r = await tramo(env)
    return { ...r, llamadas, logs }
  }

  const socialesRuta = ['Hola', 'Gracias, eso es todo', 'Ok, perfecto', 'Buenas noches, ¿cómo estás?']
  for (const m of socialesRuta) {
    const a = await correr(jsActual, m), b = await correr(jsBase, m)
    verificar(a.llamadas.existencia === 0 && a.llamadas.embeddings === 0 && a.llamadas.rpc === 0 && a.contextoRAG === '' && a.rag === 'omitido_social',
      `«${m}» → 0 existencia, 0 embeddings, 0 RPC, contexto '' y estado omitido_social (antes: ${b.llamadas.existencia}/${b.llamadas.embeddings}/${b.llamadas.rpc}, ${b.rag})`)
    verificar(a.logs.includes('[RAG_USO] estado=omitido_social nombres=0 curp=0 contacto=0 fechas=0') && a.logs.every((l) => !l.startsWith('[RAG_DOCS]')), `«${m}» → log solo [RAG_USO] estado=omitido_social (sin [RAG_DOCS])`)
  }
  const otros = [...MIXTOS, ...ACADEMICOS_CORTOS, ...SEGUIMIENTOS, ...AMBIGUOS.filter((m) => m.trim())]
  const diferencias: string[] = []
  for (const m of otros) {
    const a = await correr(jsActual, m), b = await correr(jsBase, m)
    if (JSON.stringify([a.llamadas, a.contextoRAG, a.rag, a.logs]) !== JSON.stringify([b.llamadas, b.contextoRAG, b.rag, b.logs])) diferencias.push(m)
  }
  verificar(diferencias.length === 0, `mensajes no sociales (${otros.length}) → mismas llamadas, mismo contexto, mismo estado y mismos logs que HEAD${diferencias.length ? `; difieren: ${diferencias.join(' | ')}` : ''}`)
  const mixto = await correr(jsActual, 'Hola, ¿qué dice el reglamento?')
  verificar(mixto.llamadas.existencia === 1 && mixto.llamadas.embeddings === 1 && mixto.llamadas.rpc === 1 && mixto.rag === 'ejecutado' && mixto.contextoRAG.includes('Texto ficticio del reglamento.') && mixto.logs.includes('[RAG_DOCS] existencia=si'), 'mensaje mixto → flujo RAG completo (1 existencia, 1 embedding, 1 RPC) y el contexto llega')
  const ficha = await correr(jsActual, 'Hola', { esTurnoFichaDescriptiva: true })
  verificar(ficha.rag === 'omitido_ficha' && ficha.llamadas.embeddings === 0, 'ficha descriptiva conserva su estado omitido_ficha aunque el mensaje sea social')
  const sinSesion = await correr(jsActual, 'Hola', { sesion: null })
  verificar(sinSesion.rag === 'no_aplica' && sinSesion.llamadas.embeddings === 0, 'sin sesión conserva no_aplica')

  console.log('\n— 3. Estructura —')
  const modulo = readFileSync(join(RAIZ, 'lib/asistente/mensajeSocial.ts'), 'utf8')
  verificar(!/^import /m.test(modulo) && !/fetch\(|openai|supabase|anthropic|require\(/i.test(modulo.replace(/^\/\/.*$/gm, '')), 'mensajeSocial.ts no importa nada ni hace red (determinista, sin IA)')
  const usos = (actual.match(/esMensajePuramenteSocial\(/g) || []).length
  const pUso = actual.indexOf('if (esMensajePuramenteSocial(mensaje))'), pPrep = actual.indexOf('consultaRAGPreparada = prepararConsultaEmbedding(mensaje')
  const pDecl = actual.indexOf('  const consultaRAG = (): ConsultaEmbedding => {')
  verificar(usos === 1 && pDecl > 0 && pUso > pDecl && pUso < pPrep, 'una sola invocación, dentro de consultaRAG y antes de prepararConsultaEmbedding (es decir, antes de existencia, embedding y RPC)')

  console.log(fallos === 0 ? '\nTodas las pruebas pasaron.' : `\n${fallos} prueba(s) fallaron.`)
  process.exit(fallos === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('ERROR DEL VERIFICADOR:', e instanceof Error ? `${e.name}: ${e.message}` : 'desconocido')
  process.exit(1)
})
