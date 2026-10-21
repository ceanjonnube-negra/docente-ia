// scripts/verificar-rag-sin-documentos.ts
//
// RAG sin documentos (app/api/chat/route.ts → buscarContextoRAG). Ejecuta la
// función REAL (transpilada desde el archivo) con OpenAI y Supabase simulados
// — el Supabase simulado aplica la semántica de la RLS (solo documentos del
// docente) — y compara su salida con la versión de HEAD de la misma función.
// Comprueba: sin documentos accesibles → 0 embeddings y 0 RPC; con documentos
// → exactamente el flujo y la respuesta anteriores; filtro idéntico al de la
// RPC (activo, institución nula o igual); fallo ABIERTO ante error, timeout,
// excepción o respuesta inesperada; UUID inválido nunca se interpola; logs
// [RAG_DOCS] solo con el indicador; y que el WHERE de la RPC en la última
// migración que la define siga siendo el mismo. Sin red ni llamadas reales.
//
// Ejecutar: npx tsx --tsconfig ./tsconfig.json scripts/verificar-rag-sin-documentos.ts
// Opcional: VERIFICAR_RAIZ (raíz alternativa) y VERIFICAR_BASE_CHAT (ruta.ts de referencia;
// por defecto `git show HEAD:app/api/chat/route.ts`).

import { readFileSync, readdirSync } from 'node:fs'
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
const YO = '00000000-0000-4000-8000-0000000000aa', OTRO = '00000000-0000-4000-8000-0000000000bb'
const X = '00000000-0000-4000-8000-0000000000e1', Y = '00000000-0000-4000-8000-0000000000e2'

type Doc = { user_id: string; estado: string; institucion_id: string | null }
type Modo = 'normal' | 'error' | 'colgar' | 'lanzar' | 'inesperada'

// Extrae buscarContextoRAG (autocontenida) de un route.ts
function extraer(fuente: string) {
  const ini = fuente.indexOf('async function buscarContextoRAG(')
  let k = fuente.indexOf('{', fuente.indexOf(')', fuente.indexOf('institucionId: string | null)', ini))), d = 0
  for (; k < fuente.length; k++) { if (fuente[k] === '{') d++; else if (fuente[k] === '}') { d--; if (d === 0) break } }
  // La función debe ser autocontenida (sus constantes, dentro): así la ejecutan también otros verificadores que extraen solo su cuerpo.
  return { codigo: fuente.slice(ini, k + 1), cuerpo: fuente.slice(ini, k + 1) }
}

async function main() {
  const ts = (await import('typescript')).default
  const actual = readFileSync(join(RAIZ, 'app/api/chat/route.ts'), 'utf8')
  const base = process.env.VERIFICAR_BASE_CHAT ? readFileSync(process.env.VERIFICAR_BASE_CHAT, 'utf8') : execFileSync('git', ['show', 'HEAD:app/api/chat/route.ts'], { cwd: RAIZ, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const compilar = (src: string) => ts.transpileModule(`${extraer(src).codigo}\n;return buscarContextoRAG`, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText

  // Corre una versión de buscarContextoRAG con dobles de OpenAI y Supabase
  async function correr(src: string, docs: Doc[], institucion: string | null, modo: Modo = 'normal') {
    const llamadas = { embeddings: 0, rpc: 0, consultas: 0, filtros: [] as string[] }
    const logs: string[] = []
    const consola = { log: (m: string) => logs.push(String(m)), error: (m: string) => logs.push(String(m)) }
    const openaiRAG = { embeddings: { create: async () => { llamadas.embeddings++; return { data: [{ embedding: [0.1, 0.2, 0.3] }] } } } }
    const filas = [{ categoria: 'Reglamentos', nombre_archivo: 'reglamento-ficticio.pdf', chunk_texto: 'Texto ficticio del reglamento.' }]
    // Supabase con semántica de RLS: el SELECT solo ve documentos del docente (YO)
    const sb = {
      rpc: async () => { llamadas.rpc++; return { data: filas, error: null } },
      from(tabla: string) {
        llamadas.consultas++
        if (modo === 'lanzar') throw new Error('fallo ficticio del cliente')
        const f: ((d: Doc) => boolean)[] = [(d) => d.user_id === YO]   // RLS
        let limite = Infinity, senal: AbortSignal | null = null
        const q = {
          select(cols: string) { llamadas.filtros.push(`${tabla}.select(${cols})`); return q },
          eq(c: keyof Doc, v: string) { llamadas.filtros.push(`eq(${c},${v})`); f.push((d) => d[c] === v); return q },
          is(c: keyof Doc, v: null) { llamadas.filtros.push(`is(${c},${v})`); f.push((d) => d[c] === v); return q },
          or(expr: string) {
            llamadas.filtros.push(`or(${expr})`)
            const partes = expr.split(',').map((p) => p.match(/^(\w+)\.(is|eq)\.(.+)$/))
            if (partes.some((p) => !p)) throw new Error('filtro or() mal formado')
            f.push((d) => partes.some((p) => p![2] === 'is' ? p![3] === 'null' && d[p![1] as keyof Doc] === null : d[p![1] as keyof Doc] === p![3]))
            return q
          },
          limit(n: number) { llamadas.filtros.push(`limit(${n})`); limite = n; return q },
          abortSignal(s: AbortSignal) { senal = s; return q },
          then(ok: (r: unknown) => void, mal: (e: unknown) => void) {
            if (modo === 'error') return Promise.resolve({ data: null, error: { code: '57014', message: 'fallo ficticio' } }).then(ok, mal)
            if (modo === 'inesperada') return Promise.resolve({ data: null, error: null }).then(ok, mal)
            if (modo === 'colgar') return new Promise((r) => { const vivo = setInterval(() => {}, 100); senal?.addEventListener('abort', () => { clearInterval(vivo); r({ data: null, error: { code: '', message: 'AbortError: aborted' } }) }) }).then(ok, mal) // como una conexión real: mantiene el proceso vivo hasta el abort
            return Promise.resolve({ data: docs.filter((d) => f.every((g) => g(d))).slice(0, limite).map((_, i) => ({ id: `doc-${i}` })), error: null }).then(ok, mal)
          },
        }
        return q
      },
    }
    const fn = new Function('openaiRAG', 'TIMEOUT_RAG_MS', 'console', compilar(src))(openaiRAG, 50, consola) as (sb: unknown, p: string, i: string | null) => Promise<string>
    const t0 = Date.now()
    const contexto = await fn(sb, 'Pregunta protegida ficticia', institucion)
    return { contexto, llamadas, logs, ms: Date.now() - t0 }
  }

  const activo = (user_id: string, institucion_id: string | null, estado = 'activo'): Doc => ({ user_id, estado, institucion_id })
  console.log('\n— 1. Escenarios —')
  const r1 = await correr(actual, [], X)
  verificar(r1.llamadas.embeddings === 0 && r1.llamadas.rpc === 0 && r1.contexto === '', `sin documentos → 0 embeddings, 0 RPC, contexto vacío (${JSON.stringify(r1.llamadas)})`)
  const conDoc = [activo(YO, X)]
  const r2 = await correr(actual, conDoc, X), b2 = await correr(base, conDoc, X)
  verificar(r2.llamadas.embeddings === 1 && r2.llamadas.rpc === 1 && r2.contexto.length > 0, 'con documento propio activo → 1 embedding y 1 RPC')
  // El formato del contexto documental se fija y prueba en verificar-rag-formato-documental.ts;
  // aquí se exige el mismo flujo que HEAD y que el contenido recuperado llegue al contexto.
  verificar(b2.llamadas.embeddings === 1 && b2.llamadas.rpc === 1 && r2.contexto.includes('Texto ficticio del reglamento.') && b2.contexto.includes('Texto ficticio del reglamento.'), 'con documentos → mismo flujo que HEAD (1 embedding, 1 RPC) y el contenido recuperado llega al contexto')
  const r3 = await correr(actual, [activo(OTRO, X), activo(OTRO, null)], X)
  verificar(r3.llamadas.embeddings === 0 && r3.llamadas.rpc === 0 && r3.contexto === '', 'solo documentos de OTRO docente (la RLS los oculta) → 0 embeddings')
  const r4 = await correr(actual, [activo(YO, Y)], X)
  verificar(r4.llamadas.embeddings === 0 && r4.llamadas.rpc === 0, 'solo documentos propios de OTRA institución → 0 embeddings')
  const r5 = await correr(actual, [activo(YO, null)], X)
  verificar(r5.llamadas.embeddings === 1 && r5.llamadas.rpc === 1, 'documento propio con institución NULA → flujo normal')
  const r6 = await correr(actual, [activo(YO, X, 'inactivo')], X)
  verificar(r6.llamadas.embeddings === 0 && r6.llamadas.rpc === 0, 'solo documentos INACTIVOS → 0 embeddings')
  const r7 = await correr(actual, [], X, 'error')
  verificar(r7.llamadas.embeddings === 1 && r7.llamadas.rpc === 1, 'error devuelto por Supabase → fallo ABIERTO (flujo anterior: 1 embedding, 1 RPC)')
  const r8 = await correr(actual, [], X, 'colgar')
  verificar(r8.llamadas.embeddings === 1 && r8.llamadas.rpc === 1 && r8.ms >= 1900 && r8.ms < 4000, `consulta colgada → se aborta a los ~2 s (${r8.ms} ms) y se sigue con el flujo anterior`)
  const r9 = await correr(actual, [], X, 'lanzar')
  verificar(r9.llamadas.embeddings === 1 && r9.llamadas.rpc === 1, 'excepción del cliente → fallo ABIERTO')
  const r10 = await correr(actual, [], X, 'inesperada')
  verificar(r10.llamadas.embeddings === 1 && r10.llamadas.rpc === 1, 'respuesta inesperada (sin datos ni error) → fallo ABIERTO')
  for (const malo of ['inst-ficticia', `${X},user_id.neq.null`, `${X})`]) {
    const r = await correr(actual, [], malo), b = await correr(base, [], malo)
    verificar(r.llamadas.consultas === 0 && !r.llamadas.filtros.some((x) => x.includes(malo)) && r.llamadas.embeddings === b.llamadas.embeddings && r.llamadas.rpc === b.llamadas.rpc && (r.contexto === '') === (b.contexto === ''), `institución no UUID «${malo}» → nunca se interpola ni se consulta; comportamiento idéntico a HEAD`)
  }
  const r11 = await correr(actual, [activo(YO, null)], null), r12 = await correr(actual, [activo(YO, X)], null)
  verificar(r11.llamadas.embeddings === 1 && r12.llamadas.embeddings === 0, 'institución nula en la sesión → solo cuentan los documentos sin institución (igual que la RPC)')

  console.log('\n— 2. Filtro, contenido y logs —')
  verificar(JSON.stringify(r2.llamadas.filtros) === JSON.stringify(['documentos_institucionales.select(id)', 'eq(estado,activo)', `or(institucion_id.is.null,institucion_id.eq.${X})`, 'limit(1)']), `filtro idéntico al de la RPC: ${r2.llamadas.filtros.join(' → ')}`)
  verificar(JSON.stringify(r11.llamadas.filtros.slice(2, 3)) === JSON.stringify(['is(institucion_id,null)']), 'con institución nula: is(institucion_id, null)')
  const todos = [r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, r11, r12].flatMap((r) => r.logs).filter((l) => l.startsWith('[RAG_DOCS]'))
  verificar(todos.length > 0 && todos.every((l) => /^\[RAG_DOCS\] existencia=(si|no|error|institucion_invalida)$/.test(l)), `[RAG_DOCS] solo con el indicador (${[...new Set(todos)].join(', ')})`)
  verificar(![r1, r2, r7].flatMap((r) => r.logs).some((l) => /Pregunta|ficticia|reglamento|[0-9a-f]{8}-[0-9a-f]{4}/i.test(l)), 'ningún log contiene texto del docente, contenido documental ni identificadores')

  console.log('\n— 3. Estructura —')
  const { cuerpo } = extraer(actual), { cuerpo: cuerpoBase } = extraer(base)
  verificar((cuerpo.match(/openaiRAG\.embeddings\.create\(/g) || []).length === 1 && (cuerpo.match(/sb\.rpc\('buscar_chunks_similares'/g) || []).length === 1, 'sigue habiendo exactamente 1 llamada de embeddings y 1 RPC de similitud')
  // Embedding + RPC + salida vacía, y el manejo de errores final: idénticos a HEAD. El formato
  // del contexto (entre ambos) se fija por SHA-256 en verificar-rag-bajo-demanda.ts.
  const FIN_RPC = "if (error || !data || data.length === 0) return ''"
  const tramoRag = (c: string) => { const a = c.indexOf('    // Sin timeout explícito'), b = c.indexOf(FIN_RPC), z = c.lastIndexOf('  } catch (e) {'); return a < 0 || b < 0 || z < 0 ? '' : c.slice(a, b + FIN_RPC.length) + '\n…\n' + c.slice(z) }
  verificar(tramoRag(cuerpo) !== '' && tramoRag(cuerpo) === tramoRag(cuerpoBase), 'el tramo de embeddings, RPC, salida vacía y manejo de errores es IDÉNTICO al de HEAD')
  verificar(/\.select\('id'\)/.test(cuerpo) && /\.limit\(1\)/.test(cuerpo) && !/select\('\*'\)|chunk_texto.*from\(|embedding'\)/.test(cuerpo.slice(0, cuerpo.indexOf('// Sin timeout explícito'))), "la existencia solo pide select('id') con limit(1): nunca contenido ni embeddings")
  verificar(!/supabaseRAG|SERVICE_ROLE|createClient\(/.test(cuerpo), 'la consulta usa el cliente del docente (sb), nunca service_role')
  const resto = (s: string) => s.replace(extraer(s).cuerpo, '')
  const lineas = (s: string) => resto(s).split('\n').filter((l) => l.trim() !== '')
  const [la, lb] = [lineas(actual), lineas(base)]
  const distintas = la.length === lb.length ? la.filter((l, i) => l !== lb[i]).length : Infinity
  verificar(distintas <= 1, `fuera de buscarContextoRAG, route.ts no cambia respecto de HEAD (líneas distintas: ${distintas}; solo se tolera el cambio local preexistente de LÍMITES REALES DE ACCIÓN)`)

  // ===== 4. La RPC vigente sigue filtrando como la comprobación de existencia =====
  // Sin parser SQL: se localiza la ÚLTIMA migración que define buscar_chunks_similares
  // (comentarios fuera) y su WHERE, normalizado, debe ser exactamente el esperado. Si la
  // definición no se encuentra o es ambigua, falla.
  console.log('\n— 4. RPC de referencia (migración vigente) —')
  const dirMig = join(RAIZ, 'supabase/migrations')
  const sinComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
  const archivos = readdirSync(dirMig).filter((f) => f.endsWith('.sql')).sort().map((f) => ({ f, s: sinComentarios(readFileSync(join(dirMig, f), 'utf8')) }))
  const reDef = /create\s+or\s+replace\s+function\s+(?:public\.)?buscar_chunks_similares\s*\(/gi
  const conDef = archivos.filter((a) => (a.s.match(reDef) || []).length > 0)
  const vigente = conDef.at(-1)
  const nDefs = vigente ? (vigente.s.match(reDef) || []).length : 0
  const posteriores = vigente ? archivos.slice(archivos.indexOf(vigente) + 1) : []
  const alterada = posteriores.some((a) => /(alter|drop)\s+function\s+(?:if\s+exists\s+)?(?:public\.)?buscar_chunks_similares\b/i.test(a.s))
  verificar(!!vigente && nDefs === 1 && !alterada, `definición vigente localizada sin ambigüedad: ${vigente?.f ?? 'ninguna'} (definiciones en el archivo: ${nDefs}; alterada o eliminada después: ${alterada})`)
  const tramoDef = vigente ? vigente.s.slice(vigente.s.search(reDef)) : ''
  const cuerpoSql = tramoDef.match(/\bas\s+(\$[a-z_]*\$)([\s\S]*?)\1/i)
  const cabecera = cuerpoSql ? tramoDef.slice(0, cuerpoSql.index).toLowerCase() : ''
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim()
  const cuerpoN = cuerpoSql ? norm(cuerpoSql[2]) : ''
  const nWhere = (cuerpoN.match(/\bwhere\b/g) || []).length, nOrder = (cuerpoN.match(/\border by\b/g) || []).length
  const where = nWhere === 1 && nOrder === 1 ? cuerpoN.slice(cuerpoN.indexOf(' where ') + 7, cuerpoN.indexOf(' order by ')) : ''
  verificar(!!cuerpoSql && !/security\s+definer/.test(cabecera) && cuerpoN.includes('from documento_chunks dc join documentos_institucionales di on di.id = dc.documento_id'), 'la RPC es SECURITY INVOKER (aplica la RLS del docente) y di es documentos_institucionales')
  verificar(where === "di.estado = 'activo' and di.user_id = auth.uid() and (di.institucion_id is null or di.institucion_id = p_institucion_id)", `WHERE de la RPC idéntico al de la comprobación (dueño = auth.uid(), estado activo, institución nula o igual): «${where || 'no localizado'}»`)

  console.log(fallos === 0 ? '\nTodas las pruebas pasaron.' : `\n${fallos} prueba(s) fallaron.`)
  process.exit(fallos === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('ERROR DEL VERIFICADOR:', e instanceof Error ? `${e.name}: ${e.message}` : 'desconocido')
  process.exit(1)
})
