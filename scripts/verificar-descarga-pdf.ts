// scripts/verificar-descarga-pdf.ts
//
// Descarga real de PDF (Safari iOS): POST /api/archivos/descargar recibe
// la URL firmada en el cuerpo, la valida de forma estricta (origen exacto
// del Supabase del entorno, HTTPS, ruta firmada del bucket de documentos
// generados, sin redirecciones, nombre seguro) y devuelve el archivo como
// application/octet-stream + attachment + private, no-store.
//
// Sin red, sin credenciales, sin IA: fetch se sustituye por un doble.
// Se ejecuta con `npx tsx scripts/verificar-descarga-pdf.ts`.

// Módulo (no script global): sus nombres no chocan con otros scripts.
export {}

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  console.log(`${condicion ? '✓' : '✗'} ${mensaje}`)
  if (!condicion) fallos++
}

const BASE = 'https://e2eproyecto000000000.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_URL = BASE
const firmada = (ruta: string, extra = '') => `${BASE}/storage/v1/object/sign/documentos-generados-ia/${ruta}?token=abc${extra}`
const VALIDA = firmada('d0000000-0000-4000-8000-0000000000d0/1794524701227-PRUEBA_REGISTRO.pdf', '&download=PRUEBA_REGISTRO.pdf')

async function main() {
  const v = await import('../lib/documentGen/descargaPdf')
  const { POST } = await import('../app/api/archivos/descargar/route')

  // ---- 1. Validación de la URL ----
  const ok = v.validarUrlFirmadaPdf(VALIDA, BASE)
  verificar(ok.ok && ok.nombre === 'PRUEBA_REGISTRO.pdf', '1a. URL firmada válida del bucket y proyecto del entorno: aceptada, con su nombre')
  const rechazos: [string, unknown][] = [
    ['1b. http (sin TLS)', VALIDA.replace('https://', 'http://')],
    ['1c. otro proyecto de Supabase', VALIDA.replace('e2eproyecto000000000', 'otroproyecto00000000')],
    ['1d. host parecido (sufijo)', VALIDA.replace('.supabase.co', '.supabase.co.evil.example')],
    ['1e. credenciales en la URL', VALIDA.replace('https://', 'https://user:pass@')],
    ['1f. puerto explícito', VALIDA.replace('.supabase.co/', '.supabase.co:8443/')],
    ['1g. otro bucket', VALIDA.replace('documentos-generados-ia', 'hojas-seguimiento')],
    ['1h. ruta pública (no firmada)', VALIDA.replace('/object/sign/', '/object/public/')],
    ['1i. recorrido de ruta codificado (%2e%2e)', firmada('d0/%2e%2e/otro/x.pdf')],
    ['1j. barra invertida codificada', firmada('d0/a%5Cb.pdf')],
    ['1i2. recorrido para salir del bucket', `${BASE}/storage/v1/object/sign/documentos-generados-ia/%2e%2e/hojas-seguimiento/a/x.pdf?token=abc`],
    ['1i3. segmento ".." sin codificar', `${BASE}/storage/v1/object/sign/documentos-generados-ia/a/../b/x.pdf?token=abc`],
    ['1k. sin token', VALIDA.replace('token=abc', 'otro=1')],
    ['1l. no es PDF', firmada('d0/123-archivo.docx')],
    ['1m. con fragmento', `${VALIDA}#x`],
    ['1n. vacía o no texto', 42],
    ['1o. demasiado larga', firmada(`d0/${'a'.repeat(5000)}.pdf`)],
  ]
  for (const [etiqueta, url] of rechazos) verificar(!v.validarUrlFirmadaPdf(url, BASE).ok, `${etiqueta}: rechazada`)
  verificar(!v.validarUrlFirmadaPdf(VALIDA, undefined).ok && !v.validarUrlFirmadaPdf(VALIDA, 'http://e2eproyecto000000000.supabase.co').ok, '1p. Sin URL de Supabase del entorno (o sin HTTPS): rechazada')

  // ---- 2. Nombre seguro ----
  verificar(v.nombreSeguroPdf('../../etc/x"\r\n;evil.pdf') === 'x;evil.pdf'.replace(';', '') && !/["\r\n\\/;]/.test(v.nombreSeguroPdf('a"b\\c\r\n.pdf')), '2a. Sin rutas, comillas, saltos de línea ni ";" (no inyecta encabezados)')
  verificar(v.nombreSeguroPdf('PLANEACIÓN Ñandú') === 'PLANEACIÓN Ñandú.pdf' && v.nombreSeguroPdf('') === 'documento.pdf' && v.nombreSeguroPdf('...oculto.PDF') === 'oculto.pdf', '2b. Conserva acentos, garantiza .pdf y nunca queda vacío ni oculto')
  const cd = v.contentDispositionAdjunto('PLANEACIÓN Ñandú.pdf')
  verificar(cd.startsWith('attachment; ') && cd.includes('filename="PLANEACION Nandu.pdf"') && cd.includes("filename*=UTF-8''PLANEACI%C3%93N%20%C3%91and%C3%BA.pdf"), '2c. Content-Disposition attachment con respaldo ASCII y nombre UTF-8')

  // ---- 3. Ruta POST ----
  const llamadas: { url: string; redirect?: RequestRedirect }[] = []
  let respuestaFalsa: () => Response = () => new Response(new Uint8Array([37, 80, 68, 70, 45]), { status: 200, headers: { 'content-type': 'application/pdf', 'content-length': '5' } })
  ;(globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init?: RequestInit) => {
    llamadas.push({ url, redirect: init?.redirect })
    return respuestaFalsa()
  }
  const pedir = (u: unknown, cabeceras: Record<string, string> = { origin: 'https://docente.example', 'sec-fetch-site': 'same-origin' }) => {
    const cuerpo = new URLSearchParams()
    if (u !== undefined) cuerpo.set('u', String(u))
    return POST(new Request('https://docente.example/api/archivos/descargar', { method: 'POST', body: cuerpo, headers: { 'content-type': 'application/x-www-form-urlencoded', ...cabeceras } }))
  }

  const r = await pedir(VALIDA)
  const bytes = new Uint8Array(await r.arrayBuffer())
  verificar(r.status === 200 && bytes.length === 5 && bytes[0] === 37, '3a. Descarga: 200 con el contenido del archivo')
  verificar(r.headers.get('content-type') === 'application/octet-stream' && /^attachment; filename="PRUEBA_REGISTRO\.pdf"; filename\*=UTF-8''PRUEBA_REGISTRO\.pdf$/.test(r.headers.get('content-disposition') ?? ''), '3b. application/octet-stream + Content-Disposition attachment con nombre')
  verificar(r.headers.get('cache-control') === 'private, no-store' && r.headers.get('x-content-type-options') === 'nosniff' && r.headers.get('content-length') === '5', '3c. Cache-Control private, no-store; nosniff; Content-Length')
  verificar(llamadas.length === 1 && llamadas[0].url === VALIDA && llamadas[0].redirect === 'manual', '3d. Se pide exactamente la URL validada, sin seguir redirecciones')

  llamadas.length = 0
  verificar((await pedir('https://evil.example/storage/v1/object/sign/documentos-generados-ia/a/b.pdf?token=x')).status === 400 && llamadas.length === 0, '3e. URL fuera del proyecto: 400 y NO se hace ninguna petición (sin SSRF)')
  verificar((await pedir(undefined)).status === 400, '3f. Sin URL: 400')
  verificar((await pedir(VALIDA, { origin: 'https://otro-sitio.example' })).status === 403 && (await pedir(VALIDA, { 'sec-fetch-site': 'cross-site' })).status === 403 && llamadas.length === 0, '3g. Desde otro sitio: 403, sin petición')

  respuestaFalsa = () => new Response(null, { status: 302, headers: { location: 'https://evil.example/x.pdf' } })
  verificar((await pedir(VALIDA)).status === 502, '3h. Redirección del origen: no se sigue (502)')
  respuestaFalsa = () => new Response('{"error":"InvalidJWT"}', { status: 400 })
  const vencida = await pedir(VALIDA)
  verificar(vencida.status === 410 && /venció/.test(await vencida.text()), '3i. URL firmada vencida: 410 con mensaje claro')
  respuestaFalsa = () => new Response('no', { status: 404 })
  verificar((await pedir(VALIDA)).status === 404, '3j. Archivo inexistente: 404')
  respuestaFalsa = () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })
  verificar((await pedir(VALIDA)).status === 502, '3k. Contenido que no es PDF: 502 (no se reenvía)')
  respuestaFalsa = () => new Response(new Uint8Array(10), { status: 200, headers: { 'content-type': 'application/pdf', 'content-length': String(v.TAMANO_MAXIMO_DESCARGA_PDF + 1) } })
  verificar((await pedir(VALIDA)).status === 413, '3l. Más grande que el límite de Vercel: 413')
  respuestaFalsa = () => { throw new Error('red') }
  verificar((await pedir(VALIDA)).status === 502, '3m. Fallo de red: 502')

  // ---- 4. Integración (código fuente) ----
  const { readFileSync } = await import('node:fs')
  const { execSync } = await import('node:child_process')
  const ruta = readFileSync('app/api/archivos/descargar/route.ts', 'utf8')
  const panel = readFileSync('components/Asistente/AsistentePanel.tsx', 'utf8')
  verificar(!/export (async )?function GET/.test(ruta) && !/\.from\(|supabase|insert|update|delete/i.test(ruta.replace(/\/\/.*$/gm, '').replace(/NEXT_PUBLIC_SUPABASE_URL/g, '')), '4a. Solo POST; la ruta no escribe nada ni usa la base')
  verificar(/a\.accion === 'ver' \? window\.open\(a\.url, '_blank'\)/.test(panel) && /: descargarArchivo\(a\.url, archivo\.nombre\)/.test(panel) && /compartirArchivo\(archivos\[0\]/.test(panel), '4b. Ver PDF, Compartir y Word/PowerPoint/Excel sin cambios')
  verificar(execSync('git diff --name-only -- app/api/chat lib/documentGen/herramientas.ts lib/documentGen/registroArchivos.ts lib/asistente supabase', { encoding: 'utf8' }).trim() === '', '4c. Sin cambios en generación, registro 3B-2A, conversaciones ni migraciones')

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  }
  console.log('Todas las pruebas pasaron.')
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
