// scripts/verificar-atribucion-fuentes.ts
//
// Atribución de fuentes del Chat IA (app/api/chat/route.ts, bloque C del prompt).
// Comprueba sobre el código real, sin red ni llamadas de IA:
// - CITAR LA FUENTE distingue 3 etiquetas por evidencia del turno: «Fuente
//   consultada» (solo resultados reales de la búsqueda oficial, URL solo si la
//   herramienta la dio), «Documento del docente» (solo RAG del turno; SEP no es
//   oficial verificado) y «Referencia general» (conocimiento propio);
// - prohíbe inventar enlaces, fechas, autoridades, documentos y resultados, y
//   no añade bloques a saludos, conversación ni acciones;
// - el ejemplo de la búsqueda oficial usa «Fuente consultada»;
// - nada más cambia: bloques cacheados A y B, buscarContextoRAG, filtro social
//   y el resto de route.ts idénticos a HEAD (salvo el residuo local de LÍMITES).
//
// Ejecutar: npx tsx --tsconfig ./tsconfig.json scripts/verificar-atribucion-fuentes.ts
// Opcional: VERIFICAR_RUTA_CHAT (route.ts a verificar) y VERIFICAR_BASE_CHAT
// (route.ts de referencia; por defecto `git show HEAD:app/api/chat/route.ts`).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
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

const RAIZ = join(__dirname, '..')
const RUTA = process.env.VERIFICAR_RUTA_CHAT || join(RAIZ, 'app/api/chat/route.ts')
const HASH_CITAR = 'f120b94a273c0f6750a9a6e2304d8d4857d4515a0ee6b91cb4deb101a8945cdf'
const FRASE_BUSQUEDA_ANTERIOR = 'cita la fuente y autoridad (ej. "Fuente: calendario oficial SEP, publicado el [fecha]")'
const FRASE_BUSQUEDA_ACTUAL = 'cita la fuente y autoridad con la etiqueta de CITAR LA FUENTE (ej. "Fuente consultada: calendario oficial SEP, publicado el [fecha] — [URL del resultado]"), solo con datos que aparezcan en el resultado real'

const sha = (t: string) => createHash('sha256').update(t).digest('hex')
const sinLimites = (t: string) => t.split('\n').filter((l) => !l.startsWith('LÍMITES REALES DE ACCIÓN')).join('\n')
const bloqueCitar = (s: string) => { const i = s.indexOf('CITAR LA FUENTE — '), f = i < 0 ? -1 : s.indexOf('\n\nMODO CONSULTA — aplica cuando', i); return i < 0 || f < 0 ? '' : s.slice(i, f) }
function funcion(s: string, firma: string) {
  const i = s.indexOf(firma); if (i < 0) return ''
  let k = s.indexOf('{', s.indexOf(')', s.indexOf('institucionId: string | null)', i))), d = 0
  for (; k < s.length; k++) { if (s[k] === '{') d++; else if (s[k] === '}') { d--; if (d === 0) break } }
  return s.slice(i, k + 1)
}
// Literales A, B y C del system (mismas marcas que verificar-cache-prompt-principal)
function bloques(s: string) {
  const ini = s.indexOf('    system: [\n')
  const marcas = ["      { type: 'text' as const, cache_control: { type: 'ephemeral' as const }, text: `Eres Docente IA,", "      { type: 'text' as const, cache_control: { type: 'ephemeral' as const }, text: `${fuentesDisponiblesTexto}", "      { type: 'text' as const, text: `FECHA Y HORA ACTUALES DEL SISTEMA"]
  const p = marcas.map((m) => s.indexOf(m, ini))
  if (ini < 0 || p.some((x) => x < 0)) return null
  const fin = s.indexOf('\n    ],\n', ini)
  return { A: s.slice(p[0], p[1]), B: s.slice(p[1], p[2]), C: s.slice(p[2], fin) }
}

function main() {
  const actual = readFileSync(RUTA, 'utf8')
  const base = process.env.VERIFICAR_BASE_CHAT ? readFileSync(process.env.VERIFICAR_BASE_CHAT, 'utf8') : execFileSync('git', ['show', 'HEAD:app/api/chat/route.ts'], { cwd: RAIZ, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const bA = bloques(actual), bB = bloques(base)
  verificar(!!bA && !!bB, 'system en 3 bloques A → B → C localizado en ambas versiones')
  if (!bA || !bB) { console.log(`\n${fallos} prueba(s) fallaron.`); process.exit(1) }

  console.log('\n— 1. CITAR LA FUENTE: tres etiquetas por evidencia —')
  const citar = bloqueCitar(actual)
  verificar(citar !== '' && sha(citar) === HASH_CITAR && actual.split('CITAR LA FUENTE — ').length === 2, `bloque autorizado presente una sola vez (sha256 ${sha(citar).slice(0, 12)})`)
  verificar(bA.C.includes(citar) && bA.C.indexOf('PRIORIZACIÓN DE FUENTES —') < bA.C.indexOf(citar) && bA.C.indexOf(citar) < bA.C.indexOf('MODO CONSULTA — aplica cuando'), 'vive en el bloque C (sin caché), después de PRIORIZACIÓN DE FUENTES y antes de MODO CONSULTA')
  const lineas = citar.split('\n')
  verificar(['Fuente consultada: ', 'Documento del docente: ', 'Referencia general: '].every((e) => lineas.filter((l) => l.startsWith(e)).length === 1), 'las tres etiquetas diferenciadas, una línea cada una')
  const linea = (e: string) => lineas.find((l) => l.startsWith(e)) ?? ''
  verificar(linea('Fuente consultada: ').includes('solo con un resultado real de la búsqueda oficial de este turno') && linea('Fuente consultada: ').includes('[URL, solo si la herramienta la dio]'), '«Fuente consultada» solo con resultados reales del turno; URL solo si la herramienta la proporcionó')
  verificar(linea('Documento del docente: ').includes('solo para documentos de INFORMACION DE DOCUMENTOS INSTITUCIONALES de este turno') && linea('Documento del docente: ').includes('categoría SEP no es fuente oficial verificada'), '«Documento del docente» solo para lo recuperado por el RAG del turno; un archivo clasificado SEP no es oficial verificado')
  verificar(linea('Referencia general: ').includes('si explicaste con tu propio conocimiento, sin búsqueda ni documento'), '«Referencia general» para el conocimiento propio del modelo')
  const ref = linea('Referencia general: ')
  verificar(ref.startsWith('Referencia general: [solo el programa, plan o marco oficial que conozcas con certeza, p. ej. «Plan de Estudio 2022, Nueva Escuela Mexicana»]'), '«Referencia general» solo identifica un programa, plan o marco oficial conocido con certeza (ejemplo permitido: Plan de Estudio 2022, Nueva Escuela Mexicana)')
  verificar(ref.includes('nunca añadas subtítulos, nombres de documentos, orientaciones, acuerdos, artículos ni fechas que no verificaste') && ref.endsWith('Si no hay un referente concreto que identifiques con certeza, omite esta línea.'), '«Referencia general» prohíbe títulos, subtítulos, orientaciones, acuerdos, artículos y fechas no verificados, y se omite sin un referente concreto')
  verificar(!ref.includes('Orientaciones para la evaluación'), 'el prompt no repite el título que debe evitarse (no se induce al modelo a reproducirlo)')
  verificar(citar.includes('Nunca inventes enlaces, fechas de publicación, autoridades, nombres de documentos ni resultados de búsqueda; omite lo que no aparezca en el resultado.'), 'prohíbe inventar enlaces, fechas de publicación, autoridades, documentos y resultados')
  verificar(citar.includes('Sin un referente identificable con certeza, no agregues ninguna línea.') && citar.includes('(nunca en saludos, conversación general ni acciones dentro de la app)') && citar.includes('Sin advertencias extra'), 'sin referencia inventada para completar el formato, sin bloques en saludos/conversación/acciones y sin advertencias extra')
  verificar(!actual.includes('SEP – [nombre') && !actual.includes('Fuentes consultadas:') && !actual.includes('"Fuente: calendario oficial SEP'), 'desaparecen los formatos que disfrazaban conocimiento como fuente consultada («SEP – [nombre…]», «Fuentes consultadas:»)')

  console.log('\n— 2. Búsqueda oficial —')
  const pBloque = actual.indexOf('  const bloqueConsultaOficial = requiereConsultaOficial ? `')
  const litBusqueda = pBloque < 0 ? '' : actual.slice(pBloque, actual.indexOf("` : ''", pBloque))
  verificar(litBusqueda.includes(FRASE_BUSQUEDA_ACTUAL) && !litBusqueda.includes(FRASE_BUSQUEDA_ANTERIOR), 'el ejemplo de bloqueConsultaOficial usa «Fuente consultada», con URL del resultado y solo datos que aparezcan en él')

  console.log('\n— 3. Nada más cambia —')
  verificar(sinLimites(bA.A) === sinLimites(bB.A) && bA.B === bB.B, 'bloques cacheados A y B idénticos a HEAD (caché intacta; se ignora solo el residuo local de LÍMITES)')
  verificar(funcion(actual, 'async function buscarContextoRAG(') === funcion(base, 'async function buscarContextoRAG(') && funcion(actual, 'async function buscarContextoRAG(') !== '', 'buscarContextoRAG (existencia, embeddings, RPC, formato documental) idéntica a HEAD')
  const tramoSocial = (s: string) => { const i = s.indexOf('  let consultaRAGPreparada: ConsultaEmbedding | null = null'), g = s.indexOf('  const obtenerContextoRAGPromise = (): Promise<string> => {'); return i < 0 || g < 0 ? '' : s.slice(i, s.indexOf('\n  }\n', g) + 4) }
  verificar(tramoSocial(actual) !== '' && tramoSocial(actual) === tramoSocial(base) && actual.includes("import { esMensajePuramenteSocial } from '@/lib/asistente/mensajeSocial'"), 'filtro social (consultaRAG + getter) idéntico a HEAD')
  // Comparación SIMÉTRICA (vale antes y después del commit): en ambos lados, el bloque exacto
  // CITAR LA FUENTE y el ejemplo exacto de la búsqueda oficial (versión anterior o actual) se
  // sustituyen por marcadores; sus contenidos ya se verificaron arriba (huella y reglas). Cada
  // marcador debe quedar exactamente una vez por lado, y el resto se compara byte a byte.
  const normalizar = (s: string) => {
    const c = bloqueCitar(s)
    const t = c ? s.replace(c, () => '«CITAR LA FUENTE»') : s
    return t.replace(FRASE_BUSQUEDA_ACTUAL, () => '«EJEMPLO BÚSQUEDA»').replace(FRASE_BUSQUEDA_ANTERIOR, () => '«EJEMPLO BÚSQUEDA»')
  }
  const una = (s: string, m: string) => s.split(m).length === 2
  const [nA, nB] = [normalizar(actual), normalizar(base)]
  verificar([nA, nB].every((n) => una(n, '«CITAR LA FUENTE»') && una(n, '«EJEMPLO BÚSQUEDA»')) && sinLimites(nA) === sinLimites(nB), 'fuera de los dos textos autorizados, route.ts es idéntico a HEAD byte a byte (salvo el residuo local de LÍMITES)')

  console.log(fallos === 0 ? '\nTodas las pruebas pasaron.' : `\n${fallos} prueba(s) fallaron.`)
  process.exit(fallos === 0 ? 0 : 1)
}

try { main() } catch (e) {
  console.error('ERROR DEL VERIFICADOR:', e instanceof Error ? `${e.name}: ${e.message}` : 'desconocido')
  process.exit(1)
}
