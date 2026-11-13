// scripts/verificar-vista-previa-sin-token.ts
//
// Vistas previas de planeación (PDF y Word) y de hoja de evaluación SIN
// credenciales en la URL: /api/chat construye referencias sin token; las
// rutas solo aceptan POST con el token de la sesión VIGENTE en el cuerpo
// (GET → 405) y conservan la verificación de identidad y de grupo; la
// tarjeta abre Ver/Descargar/Compartir por POST y descarta cualquier token
// histórico; nada con token se guarda en el navegador ni en mensajes_chat.
//
// Sin red, sin credenciales reales, sin IA: Supabase (Auth + PostgREST con
// RLS por docente) y el navegador se sustituyen por dobles. Se ejecuta con
// `npx tsx scripts/verificar-vista-previa-sin-token.ts`.

import { gzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'

export {}

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  console.log(`${condicion ? '✓' : '✗'} ${mensaje}`)
  if (!condicion) fallos++
}

process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://supabase.invalid'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'clave-ficticia'

const DOCENTE_A = 'a0000000-0000-4000-8000-0000000000a0'
const DOCENTE_B = 'b0000000-0000-4000-8000-0000000000b0'
const GRUPO_A = '6a000000-0000-4000-8000-0000000000a6'
const TOKEN_A = 'TOKEN-SESION-A-VIGENTE'
const TOKEN_B = 'TOKEN-SESION-B'
const TOKEN_HISTORICO = 'TOKEN-HISTORICO-QUE-NUNCA-SE-REUTILIZA'

// ---- Supabase falso: Auth por token y PostgREST con RLS por docente ----
const usuarioPorToken: Record<string, string> = { [TOKEN_A]: DOCENTE_A, [TOKEN_B]: DOCENTE_B }
const grupos = [{ id: GRUPO_A, docente_id: DOCENTE_A, grado: '4', grupo: 'B' }]
const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json' } })
const fetchSupabase = async (entrada: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof entrada === 'string' ? entrada : entrada instanceof URL ? entrada.href : entrada.url)
  const cabeceras = new Headers(init?.headers ?? (entrada instanceof Request ? entrada.headers : undefined))
  const token = (cabeceras.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const docente = usuarioPorToken[token]
  if (url.pathname === '/auth/v1/user') return docente ? json({ id: docente, aud: 'authenticated', role: 'authenticated' }) : json({ msg: 'invalid JWT' }, 401)
  const unico = (cabeceras.get('accept') ?? '').includes('vnd.pgrst.object')
  const responder = (filas: unknown[]) => (unico ? (filas.length === 1 ? json(filas[0]) : json({ code: 'PGRST116', message: 'sin filas' }, 406)) : json(filas))
  if (url.pathname === '/rest/v1/grupos') {
    const id = (url.searchParams.get('id') ?? '').replace(/^eq\./, '')
    return responder(grupos.filter((g) => g.id === id && g.docente_id === docente)) // RLS
  }
  if (url.pathname === '/rest/v1/perfiles_docentes') return responder(docente ? [{ id: docente, nombre: 'Docente ficticio', escuela: 'Escuela ficticia' }] : [])
  if (url.pathname === '/rest/v1/inscripciones') return json([])
  return json({ message: `ruta no simulada: ${url.pathname}` }, 404)
}
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSupabase as typeof fetch

const datosPlaneacion = gzipSync(Buffer.from(JSON.stringify({ texto: '📋 PLANEACIÓN DIDÁCTICA\nTema: Fracciones ficticias\n\nInicio: actividad ficticia.', zonaHoraria: 'America/Mexico_City', grupoId: GRUPO_A }))).toString('base64url')
const datosHoja = Buffer.from(JSON.stringify({ grupoId: GRUPO_A, nombreProyecto: 'Proyecto ficticio', camposFormativos: ['Lenguajes'], trimestreNombre: null, fechaInicio: null, fechaFin: null, indicadores: ['Indicador ficticio'], zonaHoraria: null })).toString('base64')

async function main() {
  const documento = await import('../app/api/planeaciones/vista-previa-documento/route')
  const word = await import('../app/api/planeaciones/vista-previa-documento-word/route')
  const hoja = await import('../app/api/planeaciones/vista-previa-hoja/route')
  const { NextRequest } = await import('next/server')
  const post = (ruta: string, campos: Record<string, string>) => new NextRequest(`http://localhost${ruta}`, { method: 'POST', body: new URLSearchParams(campos) })
  const RUTAS = [
    { nombre: 'PDF de planeación', ruta: '/api/planeaciones/vista-previa-documento', modulo: documento, campos: { tipoDocumento: 'planeacion', datos: datosPlaneacion }, firma: '%PDF' },
    { nombre: 'Word de planeación', ruta: '/api/planeaciones/vista-previa-documento-word', modulo: word, campos: { tipoDocumento: 'planeacion', datos: datosPlaneacion }, firma: 'PK' },
    { nombre: 'hoja de evaluación', ruta: '/api/planeaciones/vista-previa-hoja', modulo: hoja, campos: { tipoDocumento: 'hoja_evaluacion', datos: datosHoja }, firma: '%PDF' },
  ] as const

  // ---- 1. Rutas: solo POST, identidad y grupo ----
  for (const r of RUTAS) {
    const g = r.modulo.GET()
    verificar(g.status === 405 && g.headers.get('allow') === 'POST' && !(await g.text()).includes('token'), `1a. ${r.nombre}: GET → 405 (Allow: POST)`)
    const sinToken = await r.modulo.POST(post(r.ruta, { ...r.campos }))
    verificar(sinToken.status === 400 && (sinToken.headers.get('content-type') ?? '').startsWith('text/html') && !/^attachment/.test(sinToken.headers.get('content-disposition') ?? ''), `1b. ${r.nombre}: POST sin token → 400 (faltan parámetros), página legible y ningún archivo`)
    const invalido = await r.modulo.POST(post(r.ruta, { ...r.campos, token: 'TOKEN-FALSO-SECRETO-123' }))
    const textoInvalido = await invalido.text()
    verificar(invalido.status === 401 && !textoInvalido.includes('TOKEN-FALSO-SECRETO-123') && !textoInvalido.includes(r.campos.datos.slice(0, 20)), `1c. ${r.nombre}: token inválido → 401 sin repetir credencial ni datos`)
    const ajeno = await r.modulo.POST(post(r.ruta, { ...r.campos, token: TOKEN_B, modo: 'descargar' }))
    verificar(ajeno.status === 403 && !(await ajeno.text()).includes(TOKEN_B), `1d. ${r.nombre}: sesión de OTRO docente con este grupo → 403 (aislamiento)`)
    const ok = await r.modulo.POST(post(r.ruta, { ...r.campos, token: TOKEN_A, modo: 'descargar' }))
    const bytes = Buffer.from(await ok.arrayBuffer())
    verificar(ok.status === 200 && bytes.subarray(0, r.firma.length).toString('latin1') === r.firma && /^attachment;/.test(ok.headers.get('content-disposition') ?? '') && /no-store/.test(ok.headers.get('cache-control') ?? ''), `1e. ${r.nombre}: sesión vigente del docente → archivo real, attachment, no-store`)
  }
  for (const r of [RUTAS[0], RUTAS[2]]) {
    const ver = await r.modulo.POST(post(r.ruta, { ...r.campos, token: TOKEN_A, modo: 'ver' }))
    verificar(ver.status === 200 && ver.headers.get('content-type') === 'application/pdf' && /^inline;/.test(ver.headers.get('content-disposition') ?? ''), `1f. ${r.nombre}: modo=ver → application/pdf inline`)
    const descargar = await r.modulo.POST(post(r.ruta, { ...r.campos, token: TOKEN_A, modo: 'descargar' }))
    verificar(descargar.headers.get('content-type') === 'application/octet-stream', `1g. ${r.nombre}: modo=descargar → application/octet-stream`)
  }
  const tipoIncorrecto = await documento.POST(post('/api/planeaciones/vista-previa-documento', { tipoDocumento: 'hoja_evaluacion', datos: datosPlaneacion, token: TOKEN_A }))
  verificar(tipoIncorrecto.status === 400, '1h. tipoDocumento incorrecto → 400 antes de autenticar')

  // ---- 2. /api/chat construye referencias sin credenciales ----
  const rutaChat = readFileSync('app/api/chat/route.ts', 'utf8')
  const plantillas = [...rutaChat.matchAll(/`\/api\/planeaciones\/vista-previa-[^`]*`/g)].map((m) => m[0])
  verificar(plantillas.length === 5 && plantillas.every((p) => !/token|accessToken/i.test(p)) && plantillas.every((p) => /tipoDocumento=/.test(p) && /datos=/.test(p)), '2a. Las 5 URL de vista previa de /api/chat no llevan token y conservan tipoDocumento y datos')

  // ---- 3. Persistencia: nada con token en el navegador ni en mensajes_chat ----
  const almacen = new Map<string, string>()
  const g = globalThis as unknown as Record<string, unknown>
  g.window = { localStorage: { getItem: (k: string) => almacen.get(k) ?? null, setItem: (k: string, v: string) => { almacen.set(k, v) }, removeItem: (k: string) => { almacen.delete(k) } }, addEventListener() {}, removeEventListener() {} }
  const p = await import('../lib/asistente/persistencia')
  const conToken = (ruta: string, extra: string) => `${ruta}?tipoDocumento=planeacion&token=${TOKEN_HISTORICO}&datos=${datosPlaneacion}${extra}`
  const firmada = 'https://proyecto.supabase.co/storage/v1/object/sign/documentos-generados-ia/d/1-X.pdf?token=TOKEN-STORAGE-FIRMADA&download=X.pdf'
  const mensaje = {
    id: 'm1', rol: 'asistente' as const, texto: 'Vista previa', creadoEn: Date.now(),
    archivos: [
      { tipo: 'word', nombre: 'PLANEACION.docx', url: conToken('/api/planeaciones/vista-previa-documento-word', '') },
      { tipo: 'pdf', nombre: 'vista-previa.pdf', url: conToken('/api/planeaciones/vista-previa-documento', '&modo=descargar'), urlVer: conToken('/api/planeaciones/vista-previa-documento', '&modo=ver') },
      { tipo: 'pdf', nombre: 'hoja.pdf', url: `/api/planeaciones/vista-previa-hoja?tipoDocumento=hoja_evaluacion&token=${TOKEN_HISTORICO}&datos=${datosHoja}&modo=descargar` },
    ],
  }
  const mensajeFirmado = { id: 'm2', rol: 'asistente' as const, texto: 'Documento', creadoEn: Date.now(), archivo: { tipo: 'pdf', nombre: 'X.pdf', url: firmada } }
  p.guardarConversacion('conv-1', [mensaje, mensajeFirmado] as never, { id: 'm1', texto: 'x', archivosGenerados: { pdf: { tipo: 'pdf', nombre: 'v.pdf', url: conToken('/api/planeaciones/vista-previa-documento', '&modo=descargar') } } } as never)
  const guardado = almacen.get('docente-ia:conversacion:conv-1') ?? ''
  verificar(guardado.length > 0 && !guardado.includes(TOKEN_HISTORICO), '3a. Guardado local: ningún token de sesión en mensajes ni en documentoActivo')
  verificar(guardado.includes('TOKEN-STORAGE-FIRMADA') && guardado.includes(datosPlaneacion) && guardado.includes('modo=ver') && guardado.includes('tipoDocumento=hoja_evaluacion'), '3b. Se conservan tipoDocumento, datos, modo y la URL firmada de Supabase intacta')
  const fila = p.mensajeAFilaRemota('11111111-1111-4111-8111-111111111111', DOCENTE_A, mensaje as never)
  verificar(!JSON.stringify(fila).includes(TOKEN_HISTORICO) && JSON.stringify(fila).includes(datosHoja), '3c. Fila para mensajes_chat: sin token de sesión, con sus datos')
  verificar(p.sinTokenVistaPrevia(firmada) === firmada && p.sinTokenVistaPrevia(undefined) === undefined && p.sinTokenVistaPrevia(`/api/planeaciones/vista-previa-hoja?token=${TOKEN_HISTORICO}` as string) === '/api/planeaciones/vista-previa-hoja', '3d. Solo se sanean rutas de vista previa; las firmadas y vacías no cambian')
  const recuperado = p.cargarConversacionPorId('conv-1')
  verificar(recuperado?.mensajes[0].archivos?.length === 3 && recuperado.mensajes[1].archivo?.url === firmada, '3e. El historial conserva su estructura (3 vistas previas + documento firmado)')
  const persistencia = readFileSync('lib/asistente/persistencia.ts', 'utf8')
  verificar(/update\(\{ documento_activo: documentoActivoSinTokenVistaPrevia\(c\.documentoActivo\) \}\)/.test(persistencia), '3f. La etapa 2 tampoco sube documento_activo con token')

  // ---- 4. Cliente: Ver, Descargar y Compartir con la sesión VIGENTE ----
  const { supabase } = await import('../lib/supabaseClient')
  let sesion: string | null = TOKEN_A
  ;(supabase.auth as unknown as { getSession: unknown }).getSession = async () => ({ data: { session: sesion ? { access_token: sesion } : null }, error: null })
  type Elemento = Record<string, unknown> & { tag: string; hijos: Elemento[]; enviado: number }
  const creados: Elemento[] = []
  const ventanas: { nombre: string; cerrada: boolean; antesDeSesion: boolean }[] = []
  let sesionPedida = false
  g.document = {
    createElement: (tag: string) => {
      const el: Elemento = { tag, hijos: [], enviado: 0, style: {} } as Elemento
      Object.assign(el, { appendChild: (h: Elemento) => el.hijos.push(h), submit: () => { el.enviado++ }, remove: () => {}, click: () => {} })
      creados.push(el)
      return el
    },
    body: { appendChild: () => {} },
    addEventListener() {},
    removeEventListener() {},
    hidden: false,
  }
  ;(g.window as Record<string, unknown>).open = (_u: string, nombre: string) => { const v = { nombre, cerrada: false, antesDeSesion: !sesionPedida, close() { v.cerrada = true } }; ventanas.push(v); return v }
  const supa = supabase.auth as unknown as { getSession: () => Promise<unknown> }
  const original = supa.getSession
  supa.getSession = async () => { sesionPedida = true; return original() }
  const panel = await import('../components/Asistente/AsistentePanel')
  const campos = (f: Elemento) => Object.fromEntries(f.hijos.map((h) => [h.name as string, h.value as string]))
  const espera = () => new Promise((r) => setTimeout(r, 10))
  let fallo = 0
  const alFallar = () => { fallo++ }

  creados.length = 0; sesionPedida = false
  panel.verVistaPrevia(mensaje.archivos[1].urlVer!, alFallar)
  await espera()
  const formVer = creados.find((e) => e.tag === 'form')!
  verificar(ventanas.length === 1 && ventanas[0].antesDeSesion && formVer.target === ventanas[0].nombre && formVer.method === 'POST' && formVer.action === '/api/planeaciones/vista-previa-documento', '4a. Ver PDF: la pestaña se abre dentro del clic y el POST va a esa pestaña, a la ruta sin consulta')
  verificar(campos(formVer).token === TOKEN_A && campos(formVer).modo === 'ver' && campos(formVer).datos === datosPlaneacion && !JSON.stringify(formVer).includes(TOKEN_HISTORICO), '4b. Ver PDF: token de la sesión VIGENTE; el histórico se descarta')

  for (const [i, ruta] of [[1, '/api/planeaciones/vista-previa-documento'], [0, '/api/planeaciones/vista-previa-documento-word'], [2, '/api/planeaciones/vista-previa-hoja']] as const) {
    creados.length = 0
    await panel.descargarVistaPrevia(mensaje.archivos[i].url, alFallar)
    const f = creados.find((e) => e.tag === 'form')!
    verificar(!!f && f.action === ruta && !f.target && f.enviado === 1 && campos(f).token === TOKEN_A && !JSON.stringify(f).includes(TOKEN_HISTORICO), `4c. Descargar (${ruta.split('/').pop()}): POST en la misma pestaña con la sesión vigente`)
  }

  let compartido: Record<string, unknown> | null = null
  const fetchCompartir: { cuerpo: FormData | null; url: string } = { cuerpo: null, url: '' }
  ;(globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init: RequestInit) => { fetchCompartir.url = url; fetchCompartir.cuerpo = init.body as FormData; return new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 }) }
  let puedeArchivos = true
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { canShare: () => puedeArchivos, share: async (d: Record<string, unknown>) => { compartido = d }, clipboard: { writeText: async () => { compartido = { portapapeles: true } } } } })
  await panel.compartirVistaPrevia(mensaje.archivos[1], alFallar)
  verificar(!!compartido && Array.isArray((compartido as { files?: unknown }).files) && !('url' in (compartido as object)) && fetchCompartir.url === '/api/planeaciones/vista-previa-documento' && fetchCompartir.cuerpo?.get('token') === TOKEN_A && fetchCompartir.cuerpo?.get('modo') === 'descargar', '4d. Compartir: comparte el ARCHIVO (pedido por POST con la sesión vigente), nunca una URL')
  compartido = null; puedeArchivos = false; creados.length = 0
  await panel.compartirVistaPrevia(mensaje.archivos[2], alFallar)
  verificar(compartido === null && creados.some((e) => e.tag === 'form' && e.enviado === 1), '4e. Sin soporte para compartir archivos: se descarga; nunca se comparte ni copia una URL')

  sesion = null; fallo = 0; creados.length = 0; ventanas.length = 0
  panel.verVistaPrevia(mensaje.archivos[1].urlVer!, alFallar)
  await panel.descargarVistaPrevia(mensaje.archivos[2].url, alFallar)
  await espera()
  verificar(fallo === 2 && ventanas[0].cerrada && !creados.some((e) => e.tag === 'form'), '4f. Sin sesión: se avisa, la pestaña vacía se cierra y no se envía nada')

  verificar(panel.referenciaVistaPrevia('//evil.example/api/planeaciones/vista-previa-hoja?x=1') === null && panel.referenciaVistaPrevia('https://evil.example/api/planeaciones/vista-previa-hoja?x=1') === null && panel.referenciaVistaPrevia(firmada) === null, '4g. Solo rutas internas exactas son vista previa (ni "//", ni otros orígenes, ni URL firmadas)')
  const codigoPanel = readFileSync('components/Asistente/AsistentePanel.tsx', 'utf8')
  const bloque = codigoPanel.slice(codigoPanel.indexOf('// VISTAS PREVIAS DE PLANEACIÓN'), codigoPanel.indexOf('async function compartirArchivo('))
  verificar(!/share\(\{[^}]*url/.test(bloque) && !/clipboard/.test(bloque) && !/\.action = .*\?/.test(bloque), '4h. El código de vistas previas no comparte URL, no usa el portapapeles y no pone consulta en el action')

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
