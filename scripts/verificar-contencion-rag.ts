// scripts/verificar-contencion-rag.ts
//
// Seguridad — contención del RAG del Chat IA (auditoría "exposición de
// documentos"). Verificación ESTÁTICA (sin credenciales, sin red, sin
// datos reales) de que buscar_chunks_similares se ejecuta SIEMPRE con el
// cliente autenticado del docente y nunca con service_role, mismo
// criterio que el resto de esta familia de scripts: se audita el TEXTO
// real del código.
//
// El aislamiento efectivo (RLS por user_id, documentos sin dueño,
// institución autodeclarada, dos docentes y dos instituciones) se
// validó aparte ejecutando la RPC y las policies reales en PostgreSQL;
// este script fija que el código siga usando el cliente que hace válida
// esa evidencia.
//
// Se ejecuta con `npx tsx scripts/verificar-contencion-rag.ts`.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

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
const RUTA_CHAT = join('app', 'api', 'chat', 'route.ts')
const chat = readFileSync(raiz(RUTA_CHAT), 'utf-8')
const authApi = readFileSync(raiz('lib', 'server', 'authApi.ts'), 'utf-8')

function sinComentarios(codigo: string): string {
  return codigo
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((linea) => linea.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
    .join('\n')
}
const chatCodigo = sinComentarios(chat)

function archivosTs(dir: string): string[] {
  return readdirSync(dir).flatMap((nombre) => {
    const ruta = join(dir, nombre)
    if (statSync(ruta).isDirectory()) return archivosTs(ruta)
    return /\.(ts|tsx)$/.test(nombre) ? [ruta] : []
  })
}
const fuentes = ['app', 'lib', 'components']
  .filter((d) => {
    try {
      return statSync(raiz(d)).isDirectory()
    } catch {
      return false
    }
  })
  .flatMap((d) => archivosTs(raiz(d)))
  .map((ruta) => ({ ruta: relative(raiz(), ruta), codigo: sinComentarios(readFileSync(ruta, 'utf-8')) }))

// Cuerpo de buscarContextoRAG (desde su firma hasta la siguiente
// declaración de nivel superior).
const inicioFn = chatCodigo.indexOf('async function buscarContextoRAG(')
const finFn = chatCodigo.indexOf('\nconst client = new Anthropic(', inicioFn)
const cuerpoFn = chatCodigo.slice(inicioFn, finFn)

function main() {
  // ============================================================
  // 1. La RPC usa el cliente autenticado recibido como parámetro.
  // ============================================================
  verificar(inicioFn !== -1 && finFn !== -1, '1. buscarContextoRAG existe y su cuerpo es localizable')
  verificar(/async function buscarContextoRAG\(sb: SupabaseClient, pregunta: string, institucionId: string \| null\): Promise<string>/.test(cuerpoFn), '1b. buscarContextoRAG recibe el cliente Supabase (sb: SupabaseClient) como primer parámetro')
  verificar(/await sb\.rpc\('buscar_chunks_similares', \{/.test(cuerpoFn), '1c. buscar_chunks_similares se ejecuta con ese cliente (sb.rpc)')
  verificar(/import \{ createClient, type SupabaseClient \} from '@supabase\/supabase-js'/.test(chat), '1d. SupabaseClient se importa solo como tipo')

  // ============================================================
  // 2. No utiliza service_role.
  // ============================================================
  verificar(!/supabaseRAG/.test(cuerpoFn), '2. buscarContextoRAG no referencia supabaseRAG (cliente service_role)')
  verificar(!/SERVICE_ROLE/.test(cuerpoFn) && !/createClient\(/.test(cuerpoFn), '2b. buscarContextoRAG no crea clientes ni lee SUPABASE_SERVICE_ROLE_KEY')
  const llamadas = chatCodigo.match(/buscarContextoRAG\(([^)]*)\)/g) || []
  const invocaciones = llamadas.filter((l) => !l.startsWith('buscarContextoRAG(sb: '))
  verificar(invocaciones.length === 1 && /^buscarContextoRAG\(supabaseUser, mensaje, sesion\.institucion_id\)$/.test(invocaciones[0]), '2c. Única invocación: buscarContextoRAG(supabaseUser, mensaje, sesion.institucion_id)')
  verificar(/const supabaseUser = autenticacion\?\.ok \? autenticacion\.supabase : null/.test(chatCodigo), '2d. supabaseUser es el cliente devuelto por autenticarRequestApi (sesión del docente)')
  verificar(/process\.env\.NEXT_PUBLIC_SUPABASE_ANON_KEY!/.test(authApi) && /Authorization: `Bearer \$\{accessToken\}`/.test(authApi) && !/SERVICE_ROLE/.test(authApi), '2e. autenticarRequestApi crea el cliente con la clave anon + JWT del docente, nunca con service_role (RLS como authenticated)')
  verificar(/mensaje\.trim\(\) && sesion\?\.institucion_id && supabaseUser\s*\n\s*\? buscarContextoRAG\(supabaseUser,/.test(chatCodigo), '2f. Sin cliente autenticado no se ejecuta la búsqueda (falla segura)')

  // ============================================================
  // 3. No existe otra llamada insegura a buscar_chunks_similares.
  // ============================================================
  const llamadasRpc = fuentes.flatMap(({ ruta, codigo }) =>
    (codigo.match(/(\w+)\.rpc\(\s*['"]buscar_chunks_similares['"]/g) || []).map((m) => ({ ruta, m }))
  )
  verificar(llamadasRpc.length === 1 && llamadasRpc[0].ruta === RUTA_CHAT && llamadasRpc[0].m.startsWith('sb.rpc'), `3. En app/, lib/ y components/ existe exactamente 1 llamada a buscar_chunks_similares y es sb.rpc (encontradas: ${llamadasRpc.map((x) => `${x.ruta}:${x.m}`).join(', ') || 'ninguna'})`)
  const lecturasDirectas = fuentes.filter(({ codigo }) => /\.from\(\s*['"]documento_chunks['"]\s*\)\s*\.select/.test(codigo.replace(/\s+/g, ' ')))
  verificar(lecturasDirectas.length === 0, '3b. Ningún archivo lee documento_chunks directamente (solo vía la RPC)')

  // ============================================================
  // 4. Filtros funcionales conservados como restricción adicional.
  // ============================================================
  verificar(/p_institucion_id: institucionId,/.test(cuerpoFn) && /cantidad: 4,/.test(cuerpoFn), '4. Se conservan los parámetros funcionales (institución, cantidad 4) — solo restringen dentro de lo que RLS ya permite')

  // ============================================================
  // 5. Sin documentos accesibles: contexto vacío y la conversación sigue.
  // ============================================================
  verificar(/if \(error \|\| !data \|\| data\.length === 0\) return ''/.test(cuerpoFn), "5. Sin resultados (o con error de RLS/RPC) devuelve '' — sin contexto RAG")
  verificar(/\} catch \(e\) \{\s*\n\s*console\.error\('Error buscando contexto RAG:', e\)\s*\n\s*return ''/.test(cuerpoFn), "5b. Tratamiento seguro de errores conservado: cualquier excepción devuelve ''")
  verificar(/: Promise\.resolve\(''\)/.test(chatCodigo.slice(chatCodigo.indexOf('const contextoRAGPromise'), chatCodigo.indexOf('const contextoRAGPromise') + 400)), "5c. Si no aplica la búsqueda, contextoRAGPromise resuelve ''")
  verificar(/const contextoRAG = await conLimiteDeTiempo\(contextoRAGPromise, TIMEOUT_RAG_MS \+ 5_000, '[^']*'\)\.catch\(\(\) => ''\)/.test(chatCodigo), "5d. El turno nunca falla por el RAG (timeout + .catch(() => ''))")

  // ============================================================
  // 6. Sin llamadas nuevas de IA; otros usos de service_role intactos.
  // ============================================================
  verificar((cuerpoFn.match(/openaiRAG\.embeddings\.create\(/g) || []).length === 1 && !/anthropic|client\.messages/i.test(cuerpoFn), '6. buscarContextoRAG mantiene exactamente 1 llamada de embeddings y ninguna otra llamada de IA')
  verificar(/const supabaseRAG = createClient\(\s*\n\s*process\.env\.NEXT_PUBLIC_SUPABASE_URL!,\s*\n\s*process\.env\.SUPABASE_SERVICE_ROLE_KEY!\s*\n\)/.test(chatCodigo), '6b. supabaseRAG (service_role) sigue definido para sus otros usos legítimos (storage de imágenes y documentos)')
  verificar((chatCodigo.match(/\bsupabaseRAG\b/g) || []).length >= 5, '6c. Los demás usos de supabaseRAG no se eliminaron')

  // ============================================================
  // 7. Las fuentes curriculares oficiales no dependen del RAG.
  // ============================================================
  const curriculares = fuentes.filter(({ ruta }) => ruta.startsWith(join('lib', 'curriculo')) || ruta.startsWith(join('lib', 'programaAnalitico')))
  verificar(curriculares.length > 0 && curriculares.every(({ codigo }) => !/buscar_chunks_similares|documento_chunks|documentos_institucionales/.test(codigo)), '7. lib/curriculo y lib/programaAnalitico (fuentes SEP) no usan documentos institucionales ni el RAG')

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
