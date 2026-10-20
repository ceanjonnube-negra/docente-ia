// scripts/verificar-pdf-empaquetado.ts
//
// Regresión de EMPAQUETADO de la extracción de PDF (app/api/upload-documento).
// Los verificadores con tsx ejecutan el código fuente y no ven el bundle:
// en Vercel la función solo contiene lo que el trazado de Next incluye
// (route.js.nft.json), y ahí pdf-parse/pdfjs fallaba con
// "ReferenceError: DOMMatrix is not defined" (@napi-rs/canvas sin trazar) o
// al buscar pdf.worker.mjs junto al chunk.
//
// 1. Estático: @napi-rs/canvas en serverExternalPackages (next.config.ts) y
//    `await import('pdf-parse/worker')` ANTES de `import('pdf-parse')`.
// 2. Bundle: tras `next build`, copia a un directorio temporal SOLO los
//    archivos trazados de la ruta (como la función de Vercel) y ejecuta el
//    route.js COMPILADO con red simulada (sin llamadas reales ni
//    facturables) sobre un PDF, un DOCX y un TXT ficticios.
//
// Ejecutar (tras `npx next build`):
//   npx tsx --tsconfig ./tsconfig.json scripts/verificar-pdf-empaquetado.ts
// Opcional: VERIFICAR_RAIZ (raíz alternativa con su propio .next).

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, normalize, relative } from 'node:path'

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
const RUTA = '.next/server/app/api/upload-documento'

async function main() {
  console.log('\n— 1. Configuración de empaquetado —')
  const config = readFileSync(join(RAIZ, 'next.config.ts'), 'utf8')
  verificar(/serverExternalPackages:\s*\[[^\]]*["']@napi-rs\/canvas["']/.test(config), 'next.config.ts: @napi-rs/canvas como paquete externo (módulo nativo)')
  const fuente = readFileSync(join(RAIZ, 'app/api/upload-documento/route.ts'), 'utf8')
  const iWorker = fuente.indexOf("await import('pdf-parse/worker');"), iParse = fuente.indexOf("await import('pdf-parse');")
  verificar(iWorker > 0 && iParse > iWorker, "la ruta carga pdf-parse/worker ANTES de pdf-parse")

  console.log('\n— 2. Bundle compilado con solo los archivos trazados —')
  const nftRuta = join(RAIZ, RUTA, 'route.js.nft.json')
  if (!existsSync(nftRuta)) {
    verificar(false, `no hay build de Next (${RUTA}/route.js.nft.json): ejecuta \`npx next build\` antes de este verificador`)
    return
  }
  const trazados: string[] = JSON.parse(readFileSync(nftRuta, 'utf8')).files
  verificar(trazados.some((f) => f.includes('node_modules/@napi-rs/canvas/')) && trazados.some((f) => /@napi-rs\/canvas-[^/]+\/.*\.node$/.test(f)), 'el trazado de la función incluye @napi-rs/canvas y su binario nativo (.node)')

  const funcion = mkdtempSync(join(tmpdir(), 'funcion-upload-'))
  try {
    for (const f of [...trazados, 'route.js']) {
      const origen = normalize(join(RAIZ, RUTA, f))
      const rel = relative(RAIZ, origen)
      if (rel.startsWith('..') || !existsSync(origen)) continue
      cpSync(origen, join(funcion, rel), { recursive: true, dereference: true })
    }
    for (const m of ['.next/required-server-files.json', '.next/BUILD_ID', '.next/routes-manifest.json', '.next/prerender-manifest.json', '.next/server/middleware-manifest.json', '.next/server/app-paths-manifest.json']) {
      if (existsSync(join(RAIZ, m))) cpSync(join(RAIZ, m), join(funcion, m))
    }

    // Red simulada: autenticación, sin duplicado, roster vacío, embeddings,
    // Storage y registro atómico. Nada sale a la red.
    let enviado = ''
    const j = (c: unknown, s = 200) => new Response(JSON.stringify(c), { status: s, headers: { 'content-type': 'application/json' } })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/auth/v1/user')) return j({ id: '00000000-0000-4000-8000-0000000000aa', aud: 'authenticated', role: 'authenticated' })
      if (url.includes('/rest/v1/documentos_institucionales') || url.includes('/rest/v1/alumnos')) return j([])
      if (url.includes('/v1/embeddings')) {
        const entradas = JSON.parse(String(init?.body)).input as string[]
        enviado += entradas.join('\n')
        return j({ object: 'list', data: entradas.map((_, index) => ({ object: 'embedding', index, embedding: Buffer.from(new Float32Array(1536).fill(0.01).buffer).toString('base64') })), usage: { prompt_tokens: 1, total_tokens: 1 } })
      }
      if (url.includes('/storage/v1/object/')) return j({ Key: 'ficticio' })
      if (url.includes('/rpc/registrar_documento_institucional')) return j('00000000-0000-4000-8000-00000000c0de')
      throw new Error('RED BLOQUEADA EN LA PRUEBA')
    }) as typeof fetch
    process.env.OPENAI_API_KEY = 'sk-prueba'

    const { generarPdfBuffer } = await import(join(RAIZ, 'lib/documentGen/generarPdfServidor.ts'))
    const { generarWordBuffer } = await import(join(RAIZ, 'lib/documentGen/generarWordServidor.ts'))
    const TEXTO = 'Protocolo FICTICIO de protección civil escolar (marcador garza-ambar).\nPaso 1. Ante un sismo, replegarse a las zonas de menor riesgo.'

    const logs: string[] = []
    const origLog = console.log, origErr = console.error, origWarn = console.warn
    const directorio = process.cwd()
    process.chdir(funcion)
    const modulo = createRequire(join(funcion, 'x.js'))(join(funcion, RUTA, 'route.js'))
    const POST = (modulo.routeModule ?? modulo.default?.routeModule)?.userland?.POST as (r: Request) => Promise<Response>
    verificar(typeof POST === 'function', 'el route.js compilado se carga desde la copia trazada')
    const subir = async (contenido: BlobPart, nombre: string, tipo: string) => {
      const fd = new FormData()
      fd.append('file', new File([contenido], nombre, { type: tipo }))
      console.log = console.error = console.warn = (...a: unknown[]) => { logs.push(a.map(String).join(' ')) }
      try {
        const res = await POST(new Request('http://localhost/api/upload-documento', { method: 'POST', headers: { authorization: 'Bearer ficticio' }, body: fd }))
        return res.status
      } finally { console.log = origLog; console.error = origErr; console.warn = origWarn }
    }
    if (typeof POST === 'function') {
      const sPdf = await subir(new Uint8Array(await generarPdfBuffer(TEXTO, null, 'America/Mexico_City')), 'Protocolo.pdf', 'application/pdf')
      verificar(sPdf === 200 && /garza-ambar/.test(enviado) && /replegarse/.test(enviado), `PDF en el bundle trazado → ${sPdf}; texto extraído completo`)
      verificar(!logs.some((l) => /DOMMatrix|Cannot load "@napi-rs\/canvas"|fake worker|pdf\.worker load error/i.test(l)), 'sin advertencias de DOMMatrix, @napi-rs/canvas ni del worker de pdfjs')
      enviado = ''
      const sDocx = await subir(new Uint8Array(await generarWordBuffer(TEXTO, null, 'America/Mexico_City')), 'Protocolo.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      verificar(sDocx === 200 && /garza-ambar/.test(enviado), `DOCX en el bundle trazado → ${sDocx}`)
      enviado = ''
      const sTxt = await subir('Reglamento FICTICIO (marcador zorzal-violeta).', 'Reglamento.txt', 'text/plain')
      verificar(sTxt === 200 && /zorzal-violeta/.test(enviado), `TXT en el bundle trazado → ${sTxt}`)
    }
    process.chdir(directorio)
  } finally {
    // Solo el directorio que ESTE verificador creó con mkdtempSync bajo el
    // temporal del sistema; nunca otra ruta.
    if (funcion.startsWith(join(tmpdir(), 'funcion-upload-')) && !relative(tmpdir(), funcion).startsWith('..')) rmSync(funcion, { recursive: true, force: true })
  }
}

main()
  .catch((e) => { fallos++; console.error('ERROR DEL VERIFICADOR:', e instanceof Error ? `${e.name}: ${e.message}` : 'desconocido') })
  .finally(() => {
    console.log(fallos === 0 ? '\nTodas las pruebas pasaron.' : `\n${fallos} prueba(s) fallaron.`)
    process.exit(fallos === 0 ? 0 : 1)
  })
