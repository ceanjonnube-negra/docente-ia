// scripts/verificar-vista-previa-sin-token.ts
//
// Vistas previas de planeación (Word/PDF de la planeación y PDF de la
// hoja de evaluación) SIN credenciales en la URL. Sin red ni llamadas
// facturables, con JWT y datos 100% ficticios. Comprueba:
// 1. Ningún constructor de app/** o lib/** interpola un token en una URL
//    de vista previa; las plantillas REALES de route.ts, evaluadas con un
//    JWT ficticio, no lo contienen.
// 2. Las tres rutas REALES: POST autentica con el token del CUERPO; GET
//    se rechaza siempre (con o sin ?token=); separación entre docentes y
//    validación de grupo en la hoja; Ver/Descargar con las cabeceras de
//    siempre; errores legibles, sin adjunto y sin eco de credenciales.
// 3. Las funciones REALES de TarjetaDescarga (AsistentePanel.tsx) en un
//    DOM simulado: formulario POST sin query ni token en la acción, token
//    histórico descartado y reemplazado por la sesión vigente, Ver abre la
//    pestaña dentro del clic (Safari), Compartir nunca comparte una URL.
// 4. guardarConversacion quita el token histórico SOLO de la copia local.
//
// Ejecutar: npx tsx --tsconfig ./tsconfig.json scripts/verificar-vista-previa-sin-token.ts
// Opcional: VERIFICAR_RAIZ (raíz alternativa a verificar, p. ej. un índice exportado).

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { gzipSync } from 'node:zlib'

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
const leer = (rel: string) => readFileSync(join(RAIZ, rel), 'utf8')

// JWTs ficticios (cabecera y payload reales en forma, firma inventada).
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (sub: string, marca: string) => `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ sub, role: 'authenticated', session_id: `sesion-${marca}`, exp: 4102444800 })}.firma-ficticia-${marca}`
const DOCENTE_A = '00000000-0000-4000-8000-0000000000aa'
const DOCENTE_B = '00000000-0000-4000-8000-0000000000bb'
const GRUPO_A = '00000000-0000-4000-8000-00000000a001'
const TOKEN_A = jwt(DOCENTE_A, 'a')
const TOKEN_B = jwt(DOCENTE_B, 'b')
const TOKEN_HISTORICO = jwt(DOCENTE_A, 'historico')
const PATRON_JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]+/
const RUTAS = ['app/api/planeaciones/vista-previa-documento/route.ts', 'app/api/planeaciones/vista-previa-documento-word/route.ts', 'app/api/planeaciones/vista-previa-hoja/route.ts']

function archivos(dir: string): string[] {
  const salida: string[] = []
  for (const nombre of readdirSync(dir)) {
    const ruta = join(dir, nombre)
    if (statSync(ruta).isDirectory()) salida.push(...archivos(ruta))
    else if (/\.(ts|tsx)$/.test(nombre)) salida.push(ruta)
  }
  return salida
}

function plantilla(fuente: string, marca: string): string {
  const i = fuente.indexOf(marca)
  if (i < 0) return ''
  const ini = fuente.indexOf('`', i)
  let k = ini + 1, d = 0
  for (; k < fuente.length; k++) {
    const ch = fuente[k]
    if (ch === '\\') { k++; continue }
    if (d === 0 && ch === '`') break
    if (ch === '$' && fuente[k + 1] === '{') { d++; k++; continue }
    if (d > 0 && ch === '{') d++
    else if (d > 0 && ch === '}') d--
  }
  return fuente.slice(ini, k + 1)
}

async function main() {
  // ===== 1. Constructores =====
  console.log('\n— 1. Constructores de URL (código real) —')
  const todos = [...archivos(join(RAIZ, 'app')), ...archivos(join(RAIZ, 'lib')), ...archivos(join(RAIZ, 'components'))]
  const conTokenEnUrl: string[] = []
  for (const p of todos) {
    const fuente = readFileSync(p, 'utf8')
    for (const m of fuente.matchAll(/`[^`]*[?&]token=\$\{[^`]*`/g)) conTokenEnUrl.push(`${relative(RAIZ, p)}:${fuente.slice(0, m.index).split('\n').length}`)
    for (const m of fuente.matchAll(/['"][^'"\n]*vista-previa-[^'"\n]*[?&]token=[^'"\n]*['"]/g)) conTokenEnUrl.push(`${relative(RAIZ, p)}:${fuente.slice(0, m.index).split('\n').length}`)
  }
  verificar(conTokenEnUrl.length === 0, `ningún constructor de app/**, lib/** o components/** interpola un token en una URL (${todos.length} archivos)${conTokenEnUrl.length ? ' → ' + conTokenEnUrl.join(', ') : ''}`)
  const chat = leer('app/api/chat/route.ts')
  const marcas = ['const urlWord = `/api/planeaciones/vista-previa-documento-word', 'const urlDocumento = `/api/planeaciones/vista-previa-documento', 'const urlVerDocumento = `/api/planeaciones/vista-previa-documento', 'const url = `/api/planeaciones/vista-previa-hoja', 'const urlVer = `/api/planeaciones/vista-previa-hoja']
  const urlsNuevas = marcas.map((marca) => {
    const tpl = plantilla(chat, marca)
    return tpl ? (new Function('accessToken', 'datosComprimidos', 'datosCodificados', `return ${tpl}`)(TOKEN_A, 'H4sIAAAAficticio', 'eyJmaWN0aWNpbyI6dHJ1ZX0=') as string) : ''
  })
  verificar(urlsNuevas.every((u) => u.startsWith('/api/planeaciones/vista-previa-') && !u.includes(TOKEN_A) && !/[?&]token=/.test(u) && !PATRON_JWT.test(u.replace('eyJmaWN0aWNpbyI6dHJ1ZX0', ''))), `las 5 plantillas reales (Word, PDF descargar/ver, hoja descargar/ver), evaluadas con un JWT ficticio en scope, no lo contienen (${urlsNuevas.length})`)
  verificar(urlsNuevas.every((u) => /tipoDocumento=(planeacion|hoja_evaluacion)/.test(u) && /[?&]datos=/.test(u)) && urlsNuevas.filter((u) => /modo=ver$/.test(u)).length === 2 && urlsNuevas.filter((u) => /modo=descargar$/.test(u)).length === 2, 'las referencias conservan tipoDocumento, datos y modo (Ver/Descargar separados)')
  const bloqueMensaje = chat.slice(chat.indexOf('const archivosParaMensajeAsistente = ['), chat.indexOf('.filter((a): a is ArchivoGeneradoInfo => !!a)', chat.indexOf('const archivosParaMensajeAsistente = [')))
  verificar(/\[archivoWordParaMensajeAsistente, archivoDocumentoParaMensajeAsistente, archivoEvaluacionParaMensajeAsistente\]/.test(bloqueMensaje) && /url: urlWord,/.test(chat) && /url: urlDocumento,\n\s+urlVer: urlVerDocumento,/.test(chat) && /url,\n\s+urlVer,\n\s+tipoDocumento: 'hoja_evaluacion'/.test(chat), 'el marcador [[DOCUMENTO_ARCHIVO]] y la fila de mensajes_chat del servidor usan exactamente esas referencias sin token')

  // ===== 2. Rutas reales =====
  console.log('\n— 2. Rutas de vista previa (código real, Supabase simulado) —')
  for (const rel of RUTAS) {
    const fuente = leer(rel)
    verificar(/export async function POST\(req: NextRequest\)/.test(fuente) && /export async function GET\(\)/.test(fuente) && !/searchParams/.test(fuente) && /autenticarRequestApi\(token\)/.test(fuente) && /const token = parametros\.get\('token'\)/.test(fuente), `${rel.split('/')[3]}: POST con token del cuerpo; GET sin parámetros; nunca lee la query`)
    verificar([...fuente.matchAll(/console\.(error|log|warn)\(([^\n]*)\)/g)].every((m) => !/token|datos|parametros/.test(m[2])), `${rel.split('/')[3]}: ningún log interpola token, datos ni parámetros`)
  }
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://supabase.prueba.local'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-prueba'
  const llamadasRed: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined))
    llamadasRed.push(url)
    const json = (c: unknown, status = 200) => new Response(JSON.stringify(c), { status, headers: { 'content-type': 'application/json' } })
    const objeto = headers.get('accept')?.includes('vnd.pgrst.object')
    if (url.startsWith('http://supabase.prueba.local/auth/v1/user')) {
      const t = (headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
      if (t === TOKEN_A) return json({ id: DOCENTE_A, aud: 'authenticated', role: 'authenticated' })
      if (t === TOKEN_B) return json({ id: DOCENTE_B, aud: 'authenticated', role: 'authenticated' })
      return json({ code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' }, 401)
    }
    if (url.startsWith('http://supabase.prueba.local/rest/v1/perfiles_docentes')) {
      const fila = { id: DOCENTE_A, nombre: 'Docente Ficticio', escuela: 'Escuela Ficticia', grado: '3', grupo: 'A' }
      return json(objeto ? fila : [fila])
    }
    if (url.startsWith('http://supabase.prueba.local/rest/v1/grupos')) {
      const fila = { id: GRUPO_A, docente_id: DOCENTE_A }
      return json(objeto ? fila : [fila])
    }
    if (url.startsWith('http://supabase.prueba.local/rest/v1/inscripciones')) {
      return json([{ id: 'i1', alumnos: { id: 'al1', nombre: 'Alumna Ficticia Uno', curp: null, sexo: null, fecha_nacimiento: null } }])
    }
    throw new Error('RED BLOQUEADA EN LA PRUEBA: ' + url)
  }) as typeof fetch
  const { NextRequest } = await import('next/server')
  const rutaPdf = await import(join(RAIZ, 'app/api/planeaciones/vista-previa-documento/route.ts'))
  const rutaWord = await import(join(RAIZ, 'app/api/planeaciones/vista-previa-documento-word/route.ts'))
  const rutaHoja = await import(join(RAIZ, 'app/api/planeaciones/vista-previa-hoja/route.ts'))
  const datosPlaneacion = gzipSync(Buffer.from(JSON.stringify({ texto: '# Proyecto ficticio de lectura\n\nPropósito ficticio.\n\nActividades ficticias.', zonaHoraria: 'America/Mexico_City' }), 'utf-8')).toString('base64url')
  const datosHoja = Buffer.from(JSON.stringify({ grupoId: GRUPO_A, nombreProyecto: 'Proyecto ficticio', camposFormativos: ['Lenguajes'], trimestreNombre: 'Trimestre ficticio', fechaInicio: '2026-01-12', fechaFin: '2026-01-23', indicadores: ['Indicador ficticio'], zonaHoraria: 'America/Mexico_City' }), 'utf-8').toString('base64')
  const post = (ruta: string, campos: Record<string, string>) => new NextRequest(`http://localhost${ruta}`, { method: 'POST', body: new URLSearchParams(campos) })
  const texto = async (r: Response) => Buffer.from(await r.arrayBuffer()).toString('latin1')
  const sinCredencial = async (r: Response, ...tokens: string[]) => { const cuerpo = await r.clone().text(); const cab = JSON.stringify([...r.headers.entries()]); return tokens.every((t) => !cuerpo.includes(t) && !cab.includes(t)) }

  const pdfVer = await rutaPdf.POST(post('/api/planeaciones/vista-previa-documento', { tipoDocumento: 'planeacion', datos: datosPlaneacion, modo: 'ver', token: TOKEN_A }))
  const pdfVerBytes = await texto(pdfVer.clone())
  verificar(pdfVer.status === 200 && pdfVer.headers.get('content-type') === 'application/pdf' && /^inline;/.test(pdfVer.headers.get('content-disposition') || '') && pdfVerBytes.startsWith('%PDF'), 'PDF planeación — Ver: POST con token del cuerpo → 200 application/pdf inline (pestaña nueva)')
  const pdfDesc = await rutaPdf.POST(post('/api/planeaciones/vista-previa-documento', { tipoDocumento: 'planeacion', datos: datosPlaneacion, modo: 'descargar', token: TOKEN_A }))
  verificar(pdfDesc.status === 200 && pdfDesc.headers.get('content-type') === 'application/octet-stream' && /^attachment;/.test(pdfDesc.headers.get('content-disposition') || '') && (await texto(pdfDesc.clone())).startsWith('%PDF'), 'PDF planeación — Descargar: 200 octet-stream attachment (Safari guarda, no previsualiza)')
  const word = await rutaWord.POST(post('/api/planeaciones/vista-previa-documento-word', { tipoDocumento: 'planeacion', datos: datosPlaneacion, token: TOKEN_A }))
  verificar(word.status === 200 && /wordprocessingml/.test(word.headers.get('content-type') || '') && /^attachment;/.test(word.headers.get('content-disposition') || '') && (await texto(word.clone())).startsWith('PK'), 'Word planeación — Descargar: 200 .docx attachment')
  const hojaVer = await rutaHoja.POST(post('/api/planeaciones/vista-previa-hoja', { tipoDocumento: 'hoja_evaluacion', datos: datosHoja, modo: 'ver', token: TOKEN_A }))
  const hojaDesc = await rutaHoja.POST(post('/api/planeaciones/vista-previa-hoja', { tipoDocumento: 'hoja_evaluacion', datos: datosHoja, modo: 'descargar', token: TOKEN_A }))
  verificar(hojaVer.status === 200 && hojaVer.headers.get('content-type') === 'application/pdf' && hojaDesc.status === 200 && hojaDesc.headers.get('content-type') === 'application/octet-stream' && (await texto(hojaVer.clone())).startsWith('%PDF'), 'Hoja — Ver (inline) y Descargar (attachment) del docente dueño del grupo')
  verificar(await sinCredencial(pdfVer, TOKEN_A) && await sinCredencial(word, TOKEN_A) && await sinCredencial(hojaDesc, TOKEN_A), 'ninguna respuesta exitosa repite el token (ni en cuerpo ni en cabeceras)')

  const hojaAjena = await rutaHoja.POST(post('/api/planeaciones/vista-previa-hoja', { tipoDocumento: 'hoja_evaluacion', datos: datosHoja, modo: 'ver', token: TOKEN_B }))
  verificar(hojaAjena.status === 403 && !hojaAjena.headers.get('content-disposition') && /text\/html/.test(hojaAjena.headers.get('content-type') || '') && !(await hojaAjena.clone().text()).includes('Alumna Ficticia'), 'separación entre docentes: la hoja de un grupo ajeno → 403, sin PDF ni roster')
  const invalidos = await Promise.all([
    rutaPdf.POST(post('/api/planeaciones/vista-previa-documento', { tipoDocumento: 'planeacion', datos: datosPlaneacion, modo: 'ver', token: 'token-invalido-ficticio' })),
    rutaWord.POST(post('/api/planeaciones/vista-previa-documento-word', { tipoDocumento: 'planeacion', datos: datosPlaneacion, token: 'token-invalido-ficticio' })),
    rutaHoja.POST(post('/api/planeaciones/vista-previa-hoja', { tipoDocumento: 'hoja_evaluacion', datos: datosHoja, token: 'token-invalido-ficticio' })),
  ])
  verificar(invalidos.every((r) => r.status === 401 && !r.headers.get('content-disposition') && /text\/html/.test(r.headers.get('content-type') || '')), 'token inválido o vencido → 401 con página legible (sin adjunto: nunca una descarga vacía)')
  const legible = await invalidos[0].clone().text()
  verificar(/Tu sesión expiró/.test(legible) && !legible.includes('token-invalido-ficticio') && !legible.trim().startsWith('{'), 'el error de sesión es texto claro para el docente, nunca JSON crudo ni eco del token')
  const sinToken = await rutaPdf.POST(post('/api/planeaciones/vista-previa-documento', { tipoDocumento: 'planeacion', datos: datosPlaneacion }))
  const datosRotos = await rutaPdf.POST(post('/api/planeaciones/vista-previa-documento', { tipoDocumento: 'planeacion', datos: 'no-es-gzip', token: TOKEN_A }))
  const sinFormulario = await rutaPdf.POST(new NextRequest('http://localhost/api/planeaciones/vista-previa-documento', { method: 'POST', body: 'x', headers: { 'content-type': 'application/json' } }))
  verificar(sinToken.status === 400 && datosRotos.status === 400 && sinFormulario.status === 400 && [sinToken, datosRotos, sinFormulario].every((r) => !r.headers.get('content-disposition')), 'sin token, datos inválidos o cuerpo que no es formulario → 400 controlado')

  const llamadasAntes = llamadasRed.length
  const gets = await Promise.all([rutaPdf.GET(), rutaWord.GET(), rutaHoja.GET()])
  verificar(gets.every((r) => r.status === 405 && r.headers.get('allow') === 'POST' && !r.headers.get('content-disposition')) && llamadasRed.length === llamadasAntes, 'GET (con o sin ?token=) → 405 en las tres rutas, sin autenticar ni generar nada')
  verificar(RUTAS.every((rel) => /export async function GET\(\) \{\n\s+return respuestaErrorNavegacion\(/.test(leer(rel))), 'GET no recibe la petición: estructuralmente no puede leer ni usar un token de la URL')

  // ===== 3. Cliente real: TarjetaDescarga =====
  console.log('\n— 3. TarjetaDescarga (funciones reales, DOM simulado) —')
  const panel = leer('components/Asistente/AsistentePanel.tsx')
  const iniCli = panel.indexOf('// VISTAS PREVIAS DE PLANEACIÓN')
  const finCli = panel.indexOf('// FASE V1-A ("contexto visual persistente', iniCli)
  const codigoCliente = iniCli > 0 && finCli > iniCli ? panel.slice(iniCli, finCli) : ''
  verificar(codigoCliente.includes('function verVistaPrevia') && codigoCliente.includes('function compartirVistaPrevia'), 'funciones de vista previa localizadas en AsistentePanel.tsx')
  verificar(!/navigator\.clipboard|share\(\{[^}]*url/.test(codigoCliente) && /form\.action = referencia\.ruta/.test(codigoCliente), 'código del cliente: la acción del formulario es solo la ruta; Compartir nunca copia ni comparte una URL')
  const ts = (await import('typescript')).default
  const js = ts.transpileModule(`${codigoCliente}\n return { referenciaVistaPrevia, esVistaPreviaRegenerable, verVistaPrevia, descargarVistaPrevia, compartirVistaPrevia }`, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } }).outputText
  // pares conserva TODOS los campos en orden (un campo duplicado — p. ej. un
  // token histórico además del vigente — llegaría al servidor, que lee el primero).
  type Envio = { action: string; method: string; target: string; campos: Record<string, string>; pares: [string, string][] }
  const crearEntorno = (opciones: { sesion?: string | null; ventana?: boolean; canShare?: boolean; respuestaOk?: boolean } = {}) => {
    const eventos: string[] = []
    const envios: Envio[] = []
    const fetchs: { url: string; metodo: string; campos: Record<string, string>; pares: [string, string][] }[] = []
    const compartidos: unknown[] = []
    let ventanaCerrada = false
    const documento = {
      body: { appendChild: () => {} },
      createElement: (tag: string) => {
        if (tag === 'form') {
          const form: Record<string, unknown> & { hijos: { name: string; value: string }[] } = { method: '', action: '', target: '', style: {}, hijos: [] }
          form.appendChild = (h: { name: string; value: string }) => form.hijos.push(h)
          form.submit = () => { eventos.push('submit'); envios.push({ action: String(form.action), method: String(form.method), target: String(form.target), campos: Object.fromEntries(form.hijos.map((h) => [h.name, h.value])), pares: form.hijos.map((h) => [h.name, h.value] as [string, string]) }) }
          form.remove = () => {}
          return form
        }
        return { type: '', name: '', value: '' }
      },
    }
    const ventana = {
      location: { origin: 'https://docente.prueba.local' },
      open: (url: string, nombre: string) => { eventos.push(`open:${url}:${nombre}`); return opciones.ventana === false ? null : { close: () => { ventanaCerrada = true } } },
    }
    const supabaseSimulado = { auth: { getSession: async () => { eventos.push('getSession'); return { data: { session: opciones.sesion === null ? null : { access_token: opciones.sesion ?? TOKEN_A } } } } } }
    const fetchSimulado = async (url: string, init: { method: string; body: FormData }) => {
      fetchs.push({ url, metodo: init.method, campos: Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, String(v)])), pares: [...init.body.entries()].map(([k, v]) => [k, String(v)] as [string, string]) })
      return new Response(opciones.respuestaOk === false ? 'error' : '%PDF-ficticio', { status: opciones.respuestaOk === false ? 401 : 200 })
    }
    const nav = { canShare: () => opciones.canShare !== false, share: async (d: unknown) => { compartidos.push(d) } }
    const api = new Function('window', 'document', 'supabase', 'navigator', 'fetch', 'FormData', 'File', 'URL', js)(ventana, documento, supabaseSimulado, nav, fetchSimulado, FormData, File, URL) as {
      referenciaVistaPrevia: (u?: string) => { ruta: string; campos: [string, string][] } | null
      esVistaPreviaRegenerable: (a: { url: string }) => boolean
      verVistaPrevia: (a: { url: string; urlVer?: string }, f: () => void) => void
      descargarVistaPrevia: (a: { url: string }, f: () => void) => Promise<void>
      compartirVistaPrevia: (a: { tipo: string; nombre: string; url: string }, f: () => void) => Promise<void>
    }
    return { api, eventos, envios, fetchs, compartidos, cerrada: () => ventanaCerrada }
  }
  const esperar = () => new Promise((r) => setTimeout(r, 0))
  const DATOS_REF = 'H4sIAAAAficticio'
  const historicoPdf = { tipo: 'pdf', nombre: 'vista-previa-planeacion.pdf', url: `/api/planeaciones/vista-previa-documento?tipoDocumento=planeacion&token=${encodeURIComponent(TOKEN_HISTORICO)}&datos=${DATOS_REF}&modo=descargar`, urlVer: `/api/planeaciones/vista-previa-documento?tipoDocumento=planeacion&token=${encodeURIComponent(TOKEN_HISTORICO)}&datos=${DATOS_REF}&modo=ver` }
  const nuevoWord = { tipo: 'word', nombre: 'Proyecto_ficticio.docx', url: `/api/planeaciones/vista-previa-documento-word?tipoDocumento=planeacion&datos=${DATOS_REF}` }
  const noEsTokenViejo = (e: { pares: [string, string][] }) => !JSON.stringify(e).includes(TOKEN_HISTORICO) && !JSON.stringify(e).includes(encodeURIComponent(TOKEN_HISTORICO)) && e.pares.filter(([k]) => k === 'token').length === 1

  const ver = crearEntorno()
  let fallo = false
  ver.api.verVistaPrevia(historicoPdf, () => { fallo = true })
  const abiertoAntesDeSesion = ver.eventos[0]?.startsWith('open::vista-previa-') && ver.eventos[1] === 'getSession'
  await esperar()
  const envioVer = ver.envios[0]
  verificar(abiertoAntesDeSesion && !fallo && ver.envios.length === 1, 'Ver: la pestaña se abre SÍNCRONAMENTE dentro del clic (antes de pedir la sesión) — Safari no la bloquea')
  verificar(envioVer?.method === 'POST' && envioVer.action === '/api/planeaciones/vista-previa-documento' && !envioVer.action.includes('?') && envioVer.target.startsWith('vista-previa-') && ver.eventos[0] === `open::${envioVer.target}`, 'Ver: formulario POST dirigido a esa misma pestaña; la acción es solo la ruta (sin query, sin datos, sin token)')
  verificar(envioVer?.campos.token === TOKEN_A && noEsTokenViejo(envioVer) && envioVer.campos.modo === 'ver' && envioVer.campos.datos === DATOS_REF && envioVer.campos.tipoDocumento === 'planeacion', 'Ver (referencia HISTÓRICA con ?token=): el token antiguo se descarta y viaja el de la sesión vigente, en el cuerpo')
  const verSinSesion = crearEntorno({ sesion: null })
  let falloSinSesion = false
  verSinSesion.api.verVistaPrevia(historicoPdf, () => { falloSinSesion = true })
  await esperar()
  verificar(falloSinSesion && verSinSesion.cerrada() && verSinSesion.envios.length === 0, 'Ver sin sesión vigente: se cierra la pestaña vacía, se avisa en la tarjeta y no se envía nada')
  const verBloqueado = crearEntorno({ ventana: false })
  let falloBloqueado = false
  verBloqueado.api.verVistaPrevia(historicoPdf, () => { falloBloqueado = true })
  await esperar()
  verificar(falloBloqueado && verBloqueado.envios.length === 0, 'Ver con la pestaña bloqueada: aviso en la tarjeta, nunca navega la pestaña del Chat IA')

  const desc = crearEntorno()
  await desc.api.descargarVistaPrevia(historicoPdf, () => {})
  await desc.api.descargarVistaPrevia(nuevoWord, () => {})
  verificar(desc.envios.length === 2 && desc.envios.every((e) => e.method === 'POST' && e.target === '' && !e.action.includes('?') && e.campos.token === TOKEN_A && noEsTokenViejo(e)) && desc.envios[0].campos.modo === 'descargar' && desc.envios[1].action === '/api/planeaciones/vista-previa-documento-word', 'Descargar PDF y Word: POST en la misma pestaña (respuesta attachment), token vigente en el cuerpo, nunca en la acción')
  const descSinSesion = crearEntorno({ sesion: null })
  let falloDesc = false
  await descSinSesion.api.descargarVistaPrevia(nuevoWord, () => { falloDesc = true })
  verificar(falloDesc && descSinSesion.envios.length === 0, 'Descargar sin sesión vigente: no se envía nada (nunca una descarga vacía) y se avisa')

  const comp = crearEntorno()
  await comp.api.compartirVistaPrevia(historicoPdf, () => {})
  const comparte = comp.compartidos[0] as { files?: File[]; url?: string } | undefined
  verificar(comp.fetchs.length === 1 && comp.fetchs[0].metodo === 'POST' && !comp.fetchs[0].url.includes('?') && comp.fetchs[0].campos.token === TOKEN_A && noEsTokenViejo(comp.fetchs[0]), 'Compartir: obtiene el archivo por POST (token vigente en el cuerpo, ruta sin query)')
  verificar(!!comparte?.files?.length && comparte.url === undefined && comparte.files[0].name === 'vista-previa-planeacion.pdf' && comparte.files[0].type === 'application/pdf', 'Compartir: comparte el ARCHIVO, nunca una URL con datos o credenciales')
  const compSinArchivos = crearEntorno({ canShare: false })
  await compSinArchivos.api.compartirVistaPrevia(nuevoWord, () => {})
  verificar(compSinArchivos.compartidos.length === 0 && compSinArchivos.envios.length === 1 && compSinArchivos.envios[0].campos.token === TOKEN_A, 'Compartir sin soporte de archivos: descarga el archivo (nunca cae a copiar/compartir el enlace)')
  const compError = crearEntorno({ respuestaOk: false })
  let falloComp = false
  await compError.api.compartirVistaPrevia(nuevoWord, () => { falloComp = true })
  verificar(falloComp && compError.compartidos.length === 0 && compError.envios.length === 0, 'Compartir con error del servidor: aviso, sin compartir un archivo de error')

  const ref = ver.api
  verificar(!ref.esVistaPreviaRegenerable({ url: 'https://supabase.prueba.local/storage/v1/object/sign/documentos-generados-ia/a/b.docx?token=firma' }) && !ref.esVistaPreviaRegenerable({ url: 'https://otro.prueba.local/api/planeaciones/vista-previa-documento?datos=x' }) && !ref.esVistaPreviaRegenerable({ url: '/api/otra-ruta?datos=x' }) && ref.esVistaPreviaRegenerable(nuevoWord), 'solo las 3 rutas de vista previa del mismo origen usan el flujo POST; documentos de Storage y otros orígenes siguen su camino de siempre')
  verificar(/const vistaPreviaRegenerable = archivos\.every\(\(archivo\) => esVistaPreviaRegenerable\(archivo\)\)/.test(panel) && /const ocultarPorVencido = documentosRenovables \? renovacion\.estado === 'no_disponible' : vencido && !puedeRefrescar && !vistaPreviaRegenerable/.test(panel), 'las vistas previas históricas no se ocultan como "vencidas": se regeneran con la sesión vigente')
  verificar(/onClick=\{\(\) => ver\(archivo\)\}/.test(panel) && (panel.match(/onClick=\{\(\) => descargar\(archivo\)\}/g) || []).length === 2 && /onClick=\{\(\) => compartir\(archivosVista\[0\]\)\}/.test(panel) && /onClick=\{\(\) => compartir\(archivo\)\}/.test(panel), 'TarjetaDescarga conserva Ver, Descargar y Compartir como acciones independientes')

  // ===== 4. Copia local (localStorage) =====
  console.log('\n— 4. Copia local de la conversación —')
  const almacen = new Map<string, string>()
  ;(globalThis as { window?: unknown }).window = { localStorage: { getItem: (k: string) => almacen.get(k) ?? null, setItem: (k: string, v: string) => { almacen.set(k, v) }, removeItem: (k: string) => { almacen.delete(k) } } }
  const persistencia = await import(join(RAIZ, 'lib/asistente/persistencia.ts'))
  const FIRMA_STORAGE = 'https://supabase.prueba.local/storage/v1/object/sign/documentos-generados-ia/a/b.docx?token=firma-storage-ficticia'
  persistencia.guardarConversacion('conv-ficticia', [
    { id: 'm1', rol: 'usuario', texto: 'Planea un proyecto ficticio', creadoEn: 1 },
    { id: 'm2', rol: 'asistente', texto: 'Borrador ficticio', creadoEn: 2, archivo: historicoPdf, archivos: [historicoPdf, { ...nuevoWord, url: `/api/planeaciones/vista-previa-documento-word?tipoDocumento=planeacion&datos=${DATOS_REF}&token=${encodeURIComponent(TOKEN_HISTORICO)}` }, { tipo: 'word', nombre: 'Doc.docx', url: FIRMA_STORAGE }] },
  ], { id: 'm2', texto: 'Borrador ficticio', archivosGenerados: { pdf: historicoPdf } }, null)
  const guardado = [...almacen.values()].find((v) => v.includes('conv-ficticia') || v.includes('Borrador ficticio')) || ''
  const datosLocales = JSON.parse([...almacen.entries()].find(([k]) => k.includes('conv-ficticia'))?.[1] || '{}')
  const urlsLocales: string[] = [...(datosLocales.mensajes?.[1]?.archivos || []).flatMap((a: { url: string; urlVer?: string }) => [a.url, a.urlVer].filter(Boolean)), datosLocales.mensajes?.[1]?.archivo?.url, datosLocales.documentoActivo?.archivosGenerados?.pdf?.url, datosLocales.documentoActivo?.archivosGenerados?.pdf?.urlVer]
  verificar(guardado.length > 0 && !guardado.includes(TOKEN_HISTORICO) && !guardado.includes(encodeURIComponent(TOKEN_HISTORICO)), 'guardarConversacion: la copia LOCAL ya no contiene el token histórico (mensajes y documentoActivo)')
  verificar(urlsLocales.includes(`/api/planeaciones/vista-previa-documento?tipoDocumento=planeacion&datos=${DATOS_REF}&modo=ver`) && urlsLocales.includes(`/api/planeaciones/vista-previa-documento-word?tipoDocumento=planeacion&datos=${DATOS_REF}`) && urlsLocales.includes(FIRMA_STORAGE), 'la referencia local conserva tipoDocumento/datos/modo; las URLs firmadas de Storage no se tocan')
  const persFuente = leer('lib/asistente/persistencia.ts')
  const fnRemota = persFuente.slice(persFuente.indexOf('function mensajeAFilaRemota('), persFuente.indexOf('\n}\n', persFuente.indexOf('function mensajeAFilaRemota(')))
  verificar(!/SinTokenVistaPrevia/.test(fnRemota) && (persFuente.match(/mensajesSinTokenVistaPrevia\(/g) || []).length === 2 && (persFuente.match(/documentoActivoSinTokenVistaPrevia\(/g) || []).length === 2, 'la neutralización solo se aplica a la copia local: la escritura a Supabase (mensajeAFilaRemota) no la usa — no se reescriben registros históricos')

  console.log(fallos === 0 ? '\nTodas las pruebas pasaron.' : `\n${fallos} prueba(s) fallaron.`)
  process.exit(fallos === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('ERROR DEL VERIFICADOR:', e instanceof Error ? `${e.name}: ${e.message}` : 'desconocido')
  process.exit(1)
})
