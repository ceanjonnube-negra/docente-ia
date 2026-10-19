// scripts/verificar-renovar-url-documento.ts
//
// Recuperación de documentos históricos con URL firmada vencida
// (POST /api/archivos/renovar-url). Sin red ni llamadas facturables, con
// JWT, rutas y documentos 100% ficticios y un Supabase simulado que
// aplica RLS (base de datos y Storage) igual que el real:
// 1. La ruta REAL: documento propio (Word/PDF/PowerPoint, hoja), ajeno,
//    de otra conversación, documento_activo propio/ajeno, URL vencida y
//    vigente, rutas manipuladas, bucket no permitido, host externo,
//    archivo inexistente, índices inválidos; nunca firma sin verificar el
//    acceso, nunca usa service_role, vigencia de 1 hora, no-store, logs
//    sin URLs/rutas/nombres, sin llamadas de IA.
// 2. El intermediario de descarga PDF (same-origin) acepta hojas de
//    evaluación sin relajar host/protocolo/bucket.
// 3. El cliente REAL (lib/asistente/renovarUrlDocumento.ts): vencimiento
//    real por `exp`, una sola petición ante llamadas concurrentes, sin
//    reintentos en bucle, sin consultar referencias no persistidas.
// 4. El hook REAL de TarjetaDescarga con un React mínimo simulado y la
//    conversión REAL (ejecutarConversionFormato) con dependencias simuladas.
//
// Ejecutar: npx tsx --tsconfig ./tsconfig.json scripts/verificar-renovar-url-documento.ts
// Opcional: VERIFICAR_RAIZ (raíz alternativa a verificar, p. ej. un índice exportado).

import { readFileSync } from 'node:fs'
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

const RAIZ = process.env.VERIFICAR_RAIZ || join(__dirname, '..')
const leer = (rel: string) => readFileSync(join(RAIZ, rel), 'utf8')

const SUPABASE = 'https://supabase.prueba.local'
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwtSesion = (sub: string, marca: string) => `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ sub, role: 'authenticated', exp: 4102444800 })}.firma-sesion-${marca}`
const firmaStorage = (ruta: string, expSeg: number) => `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ url: ruta, iat: expSeg - 3600, exp: expSeg })}.firma-storage`
const DOC_A = '00000000-0000-4000-8000-0000000000aa'
const DOC_B = '00000000-0000-4000-8000-0000000000bb'
const CONV_A = '00000000-0000-4000-8000-00000000c0a1'
const CONV_A2 = '00000000-0000-4000-8000-00000000c0a2'
const CONV_B = '00000000-0000-4000-8000-00000000c0b1'
const TOKEN_A = jwtSesion(DOC_A, 'a')
const TOKEN_B = jwtSesion(DOC_B, 'b')
const AHORA_S = Math.floor(Date.now() / 1000)
const VENCIDA = AHORA_S - 30 * 24 * 3600
const VIGENTE = AHORA_S + 6 * 24 * 3600
const urlFirmada = (bucket: string, ruta: string, exp = VENCIDA, origen = SUPABASE, download = 'archivo') => `${origen}/storage/v1/object/sign/${bucket}/${ruta}?token=${firmaStorage(`${bucket}/${ruta}`, exp)}&download=${download}`

const R_WORD = `${DOC_A}/1700000000001-Proyecto_ficticio.docx`
const R_PDF = `${DOC_A}/1700000000002-Proyecto_ficticio.pdf`
const R_PPT = `${DOC_A}/1700000000003-Presentacion_ficticia.pptx`
const R_HOJA = `${DOC_A}/1700000000004-hoja-evaluacion-FICT01.pdf`
const R_B = `${DOC_B}/1700000000005-Documento_ajeno.docx`
const OBJETOS = new Set([`documentos-generados-ia/${R_WORD}`, `documentos-generados-ia/${R_PDF}`, `documentos-generados-ia/${R_PPT}`, `hojas-seguimiento/${R_HOJA}`, `documentos-generados-ia/${R_B}`, `imagenes-generadas-ia/${DOC_A}/1700000000006-Imagen.png`])

type Fila = { id: string; conversacion_id: string; docente_id: string; contenido: unknown }
const MENSAJES: Fila[] = [
  { id: 'msg-1700000000001-1', conversacion_id: CONV_A, docente_id: DOC_A, contenido: { archivo: { tipo: 'word', nombre: 'Proyecto_ficticio.docx', url: urlFirmada('documentos-generados-ia', R_WORD) } } },
  { id: 'msg-1700000000002-2', conversacion_id: CONV_A, docente_id: DOC_A, contenido: { archivo: { tipo: 'word', nombre: 'Proyecto_ficticio.docx', url: urlFirmada('documentos-generados-ia', R_WORD) }, archivos: [{ tipo: 'word', nombre: 'Proyecto_ficticio.docx', url: urlFirmada('documentos-generados-ia', R_WORD) }, { tipo: 'pdf', nombre: 'Proyecto_ficticio.pdf', url: urlFirmada('documentos-generados-ia', R_PDF), urlVer: urlFirmada('documentos-generados-ia', R_PDF) }, { tipo: 'pdf', nombre: 'hoja-evaluacion-FICT01.pdf', url: urlFirmada('hojas-seguimiento', R_HOJA), tipoDocumento: 'hoja_evaluacion' }] } },
  { id: 'msg-1700000000003-3', conversacion_id: CONV_A, docente_id: DOC_A, contenido: { archivo: { tipo: 'powerpoint', nombre: 'Presentacion_ficticia.pptx', url: urlFirmada('documentos-generados-ia', R_PPT, VIGENTE) } } },
  { id: 'msg-1700000000004-4', conversacion_id: CONV_B, docente_id: DOC_B, contenido: { archivo: { tipo: 'word', nombre: 'Documento_ajeno.docx', url: urlFirmada('documentos-generados-ia', R_B) } } },
  // Referencias guardadas manipuladas / no permitidas (todas del docente A).
  { id: 'msg-manipulada-ajena', conversacion_id: CONV_A, docente_id: DOC_A, contenido: { archivo: { tipo: 'word', nombre: 'x.docx', url: urlFirmada('documentos-generados-ia', R_B) } } },
  { id: 'msg-manipulada-puntos', conversacion_id: CONV_A, docente_id: DOC_A, contenido: { archivo: { tipo: 'word', nombre: 'x.docx', url: `${SUPABASE}/storage/v1/object/sign/documentos-generados-ia/${DOC_A}/%2E%2E/${R_B}?token=x` } } },
  { id: 'msg-manipulada-doble', conversacion_id: CONV_A, docente_id: DOC_A, contenido: { archivo: { tipo: 'word', nombre: 'x.docx', url: `${SUPABASE}/storage/v1/object/sign/documentos-generados-ia/${DOC_A}%252F..%252F${DOC_B}/1700000000005-Documento_ajeno.docx?token=x` } } },
  { id: 'msg-manipulada-barra', conversacion_id: CONV_A, docente_id: DOC_A, contenido: { archivo: { tipo: 'word', nombre: 'x.docx', url: `${SUPABASE}/storage/v1/object/sign/documentos-generados-ia/${DOC_A}/sub%2F..%2F..%2Fx.docx?token=x` } } },
  { id: 'msg-manipulada-vacio', conversacion_id: CONV_A, docente_id: DOC_A, contenido: { archivo: { tipo: 'word', nombre: 'x.docx', url: `${SUPABASE}/storage/v1/object/sign/documentos-generados-ia/${DOC_A}//1700000000001-Proyecto_ficticio.docx?token=x` } } },
  { id: 'msg-bucket-imagen', conversacion_id: CONV_A, docente_id: DOC_A, contenido: { archivo: { tipo: 'word', nombre: 'x.docx', url: urlFirmada('imagenes-generadas-ia', `${DOC_A}/1700000000006-Imagen.png`) } } },
  { id: 'msg-tipo-imagen', conversacion_id: CONV_A, docente_id: DOC_A, contenido: { archivo: { tipo: 'imagen', nombre: 'Imagen.png', url: urlFirmada('documentos-generados-ia', R_WORD), assetId: 'a1' } } },
  { id: 'msg-host-externo', conversacion_id: CONV_A, docente_id: DOC_A, contenido: { archivo: { tipo: 'word', nombre: 'x.docx', url: urlFirmada('documentos-generados-ia', R_WORD, VENCIDA, 'https://otro.prueba.local') } } },
  { id: 'msg-vista-previa', conversacion_id: CONV_A, docente_id: DOC_A, contenido: { archivo: { tipo: 'pdf', nombre: 'v.pdf', url: '/api/planeaciones/vista-previa-documento?tipoDocumento=planeacion&datos=x&modo=descargar' } } },
  { id: 'msg-inexistente', conversacion_id: CONV_A, docente_id: DOC_A, contenido: { archivo: { tipo: 'word', nombre: 'Borrado.docx', url: urlFirmada('documentos-generados-ia', `${DOC_A}/1700000000009-Borrado.docx`) } } },
]
const CONVERSACIONES = [
  { id: CONV_A, docente_id: DOC_A, documento_activo: { id: 'msg-1700000000002-2', texto: 'Documento ficticio', archivosGenerados: { word: { tipo: 'word', nombre: 'Proyecto_ficticio.docx', url: urlFirmada('documentos-generados-ia', R_WORD) }, pdf: { tipo: 'pdf', nombre: 'Proyecto_ficticio.pdf', url: urlFirmada('documentos-generados-ia', R_PDF) } } } },
  { id: CONV_B, docente_id: DOC_B, documento_activo: { id: 'msg-1700000000004-4', texto: 'Ajeno', archivosGenerados: { word: { tipo: 'word', nombre: 'Documento_ajeno.docx', url: urlFirmada('documentos-generados-ia', R_B) } } } },
]

const registroRed: string[] = []
const firmas: { bucket: string; ruta: string; expiresIn: number; docente: string }[] = []
const infos: string[] = []
const docenteDe = (headers: Headers) => {
  const t = (headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  return t === TOKEN_A ? DOC_A : t === TOKEN_B ? DOC_B : null
}
let rutaRenovar: { POST: (r: Request) => Promise<Response> } | null = null
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined))
  registroRed.push(url.split('?')[0])
  const json = (c: unknown, status = 200) => new Response(JSON.stringify(c), { status, headers: { 'content-type': 'application/json' } })
  const objeto = headers.get('accept')?.includes('vnd.pgrst.object')
  if (url.startsWith('/api/archivos/renovar-url') && rutaRenovar) {
    const { NextRequest } = await import('next/server')
    return rutaRenovar.POST(new NextRequest(`https://docente.prueba.local${url}`, { method: init?.method, headers: init?.headers, body: init?.body as BodyInit }))
  }
  if (url.startsWith(`${SUPABASE}/auth/v1/user`)) {
    const d = docenteDe(headers)
    return d ? json({ id: d, aud: 'authenticated', role: 'authenticated' }) : json({ msg: 'invalid JWT' }, 401)
  }
  const docente = docenteDe(headers)
  const u = new URL(url)
  const eq = (campo: string) => u.searchParams.get(campo)?.replace(/^eq\./, '')
  if (url.startsWith(`${SUPABASE}/rest/v1/mensajes_chat`)) {
    const filas = MENSAJES.filter((f) => f.docente_id === docente && f.id === eq('id') && f.conversacion_id === eq('conversacion_id')).map((f) => ({ contenido: f.contenido }))
    return objeto ? (filas[0] ? json(filas[0]) : json({ code: 'PGRST116' }, 406)) : json(filas)
  }
  if (url.startsWith(`${SUPABASE}/rest/v1/conversaciones_chat`)) {
    const filas = CONVERSACIONES.filter((c) => c.docente_id === docente && c.id === eq('id')).map((c) => ({ documento_activo: c.documento_activo }))
    return objeto ? (filas[0] ? json(filas[0]) : json({ code: 'PGRST116' }, 406)) : json(filas)
  }
  // Storage con RLS: solo objetos existentes cuya primera carpeta es el docente.
  const accesible = (bucketRuta: string) => OBJETOS.has(bucketRuta) && bucketRuta.split('/')[1] === docente
  if (url.startsWith(`${SUPABASE}/storage/v1/object/info/`)) {
    const bucketRuta = decodeURIComponent(u.pathname.slice('/storage/v1/object/info/'.length))
    infos.push(bucketRuta)
    return accesible(bucketRuta) ? json({ id: 'obj', name: bucketRuta.split('/').slice(1).join('/'), size: 10 }) : json({ statusCode: '404', error: 'not_found', message: 'Object not found' }, 400)
  }
  if (url.startsWith(`${SUPABASE}/storage/v1/object/sign/`) && init?.method === 'POST') {
    const bucketRuta = decodeURIComponent(u.pathname.slice('/storage/v1/object/sign/'.length))
    const { expiresIn } = JSON.parse(String(init.body)) as { expiresIn: number }
    if (!accesible(bucketRuta)) return json({ statusCode: '404', error: 'not_found', message: 'Object not found' }, 400)
    firmas.push({ bucket: bucketRuta.split('/')[0], ruta: bucketRuta.split('/').slice(1).join('/'), expiresIn, docente: docente! })
    return json({ signedURL: `/object/sign/${bucketRuta}?token=${firmaStorage(bucketRuta, Math.floor(Date.now() / 1000) + expiresIn)}` })
  }
  if (url.startsWith(`${SUPABASE}/storage/v1/object/sign/`)) return new Response('%PDF-1.7 ficticio', { status: 200, headers: { 'content-length': '17' } })
  throw new Error('RED BLOQUEADA EN LA PRUEBA: ' + url.split('?')[0])
}) as typeof fetch

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-prueba'
  const logs: string[] = []
  const origLog = console.log, origErr = console.error
  const capturar = () => {
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')) }
    console.error = (...a: unknown[]) => { logs.push(a.map(String).join(' ')) }
  }
  const soltar = () => { console.log = origLog; console.error = origErr }
  const { NextRequest } = await import('next/server')
  rutaRenovar = await import(join(RAIZ, 'app/api/archivos/renovar-url/route.ts'))
  const pedir = async (cuerpo: unknown, token: string | null = TOKEN_A) => {
    capturar()
    try {
      const res = await rutaRenovar!.POST(new NextRequest('https://docente.prueba.local/api/archivos/renovar-url', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(cuerpo) }))
      const datos = await res.json().catch(() => null)
      return { status: res.status, cache: res.headers.get('cache-control'), datos }
    } finally { soltar() }
  }
  const rutaDe = (url: string) => decodeURIComponent(new URL(url).pathname.replace('/storage/v1/object/sign/', ''))
  const expDe = (url: string) => (JSON.parse(Buffer.from((new URL(url).searchParams.get('token') || '').split('.')[1], 'base64url').toString()) as { exp: number }).exp
  const msg = (mensajeId: string, indice = 0, conversacionId = CONV_A) => ({ origen: 'mensaje', conversacionId, mensajeId, indice })

  // ===== 1. Ruta real =====
  console.log('\n— 1. POST /api/archivos/renovar-url (código real, RLS simulada) —')
  const fuente = leer('app/api/archivos/renovar-url/route.ts')
  verificar(!/SERVICE_ROLE|createClient\(/.test(fuente) && /auth\.supabase\.storage\.from\(referencia\.bucket\)\.info\(ruta\)/.test(fuente) && /crearUrlFirmada\(auth\.supabase,/.test(fuente) && !/anthropic|openai/i.test(fuente), 'sin service_role ni cliente propio: verifica (info) y firma con el cliente autenticado del docente; sin IA')
  const iInfo = fuente.indexOf('.info(ruta)'), iFirma = fuente.indexOf('crearUrlFirmada(auth.supabase')
  verificar(iInfo > 0 && iFirma > iInfo, 'la nueva firma se crea únicamente DESPUÉS de verificar el acceso al objeto')
  verificar(!/cuerpo\.url|body\.url|\.url\b[^\n]*cuerpo/.test(fuente) && /referenciaStorage\(archivo\.url\)/.test(fuente), 'la referencia sale SIEMPRE de la base de datos (archivo.url leído con RLS); el cuerpo del cliente nunca aporta una URL')

  const word = await pedir(msg('msg-1700000000001-1'))
  verificar(word.status === 200 && word.cache === 'no-store' && rutaDe(word.datos.url) === `documentos-generados-ia/${R_WORD}` && !word.datos.urlVer && /download=/.test(word.datos.url), `Word propio con URL VENCIDA → 200 no-store, mismo objeto, con download (${word.status})`)
  const expRenovada = expDe(word.datos.url)
  verificar(Math.abs(expRenovada - (AHORA_S + 3600)) < 120 && Math.abs(Date.parse(word.datos.expiraEn) / 1000 - (AHORA_S + 3600)) < 120 && firmas.every((f) => f.expiresIn === 3600), 'vigencia renovada de 1 hora (firma y expiraEn)')
  const firmasAntes = firmas.length
  const pdf = await pedir(msg('msg-1700000000002-2', 1))
  const hoja = await pedir(msg('msg-1700000000002-2', 2))
  const ppt = await pedir(msg('msg-1700000000003-3'))
  verificar(pdf.status === 200 && rutaDe(pdf.datos.url) === `documentos-generados-ia/${R_PDF}` && !!pdf.datos.urlVer && !/download=/.test(pdf.datos.urlVer) && /download=/.test(pdf.datos.url), 'PDF (índice 1 de `archivos`) → url de descarga + urlVer sin download (Ver/Descargar separados)')
  verificar(hoja.status === 200 && rutaDe(hoja.datos.url) === `hojas-seguimiento/${R_HOJA}` && !!hoja.datos.urlVer, 'hoja de evaluación (bucket hojas-seguimiento) → renovada')
  verificar(ppt.status === 200 && rutaDe(ppt.datos.url) === `documentos-generados-ia/${R_PPT}` && firmas.length === firmasAntes + 5, 'PowerPoint con URL todavía VIGENTE → también se renueva (no depende del token guardado)')
  const conUrlIntrusa = await pedir({ ...msg('msg-1700000000001-1'), url: urlFirmada('documentos-generados-ia', R_B) })
  verificar(conUrlIntrusa.status === 200 && rutaDe(conUrlIntrusa.datos.url) === `documentos-generados-ia/${R_WORD}`, 'una URL enviada por el cliente se ignora: se firma solo la referencia guardada del mensaje')

  const nFirmas = firmas.length
  const ajenoPorB = await pedir(msg('msg-1700000000001-1'), TOKEN_B)
  const ajenoConvB = await pedir(msg('msg-1700000000004-4', 0, CONV_B))
  const otraConversacion = await pedir(msg('msg-1700000000001-1', 0, CONV_A2))
  verificar(ajenoPorB.status === 404 && ajenoConvB.status === 404 && otraConversacion.status === 404 && firmas.length === nFirmas, 'documento de otro docente, conversación ajena o mensaje de otra conversación → 404 sin firmar')
  const activo = await pedir({ origen: 'documento_activo', conversacionId: CONV_A, tipo: 'pdf' })
  const activoAjeno = await pedir({ origen: 'documento_activo', conversacionId: CONV_B, tipo: 'word' })
  const activoSinTipo = await pedir({ origen: 'documento_activo', conversacionId: CONV_A, tipo: 'excel' })
  verificar(activo.status === 200 && rutaDe(activo.datos.url) === `documentos-generados-ia/${R_PDF}` && !!activo.datos.urlVer && activoAjeno.status === 404 && activoSinTipo.status === 404, 'documento_activo propio → renovado; ajeno o sin ese formato → 404')

  const nInfos = infos.length, nF = firmas.length
  const manipuladas = await Promise.all(['msg-manipulada-ajena', 'msg-manipulada-puntos', 'msg-manipulada-doble', 'msg-manipulada-barra', 'msg-manipulada-vacio', 'msg-bucket-imagen', 'msg-tipo-imagen', 'msg-host-externo', 'msg-vista-previa'].map((id) => pedir(msg(id))))
  verificar(manipuladas.every((r) => r.status === 404) && infos.length === nInfos && firmas.length === nF, 'ruta de otro docente, %2E%2E, doble codificación, barra codificada, segmento vacío, bucket de imágenes, tipo imagen, host externo y URL de vista previa → 404 sin consultar Storage ni firmar')
  const inexistente = await pedir(msg('msg-inexistente'))
  verificar(inexistente.status === 404 && inexistente.datos?.error === 'Este documento ya no está disponible.' && firmas.length === nF && infos.length === nInfos + 1, 'archivo eliminado de Storage → 404 "ya no está disponible" (verificado con info, nunca se inventa una URL)')
  const invalidos = await Promise.all([
    pedir(msg('msg-1700000000001-1', -1)), pedir(msg('msg-1700000000001-1', 1.5)), pedir({ ...msg('msg-1700000000001-1'), indice: '0' }), pedir(msg('msg-1700000000001-1', 99)),
    pedir({ origen: 'otro', conversacionId: CONV_A }), pedir({ ...msg('msg-1700000000001-1'), conversacionId: 'conv-local-1' }), pedir(msg('msg con espacios/../x')), pedir({ origen: 'documento_activo', conversacionId: CONV_A, tipo: 'imagen' }),
  ])
  verificar(invalidos.every((r) => r.status === 400) && firmas.length === nF, 'índice negativo, decimal, texto o fuera de rango; origen desconocido; conversación no persistida; id malformado; formato no documental → 400')
  const indiceSinArchivo = await pedir(msg('msg-1700000000001-1', 3))
  const sinSesion = await pedir(msg('msg-1700000000001-1'), null)
  const sesionInvalida = await pedir(msg('msg-1700000000001-1'), 'token-invalido')
  verificar(indiceSinArchivo.status === 404 && sinSesion.status === 401 && sesionInvalida.status === 401, 'índice válido sin archivo → 404; sin sesión o sesión inválida → 401')
  verificar(logs.length > 0 && logs.every((l) => /^\[RENOVAR_URL\] origen=(mensaje|documento_activo|desconocido) (resultado=(renovada tipo=(word|pdf|powerpoint|excel)|no_disponible)|fallo: tipo=\w+)/.test(l) && !/storage|token|\.docx|\.pdf|\.pptx|ficticio|0000-4000/i.test(l)), `logs: solo origen/resultado/tipo — nunca URLs, firmas, rutas, nombres ni ids (${logs.length} líneas)`)
  verificar(registroRed.every((u) => u.startsWith(SUPABASE) || u.startsWith('/api/')), 'ninguna llamada fuera del Supabase simulado (sin IA)')

  // ===== 2. Intermediario de descarga PDF =====
  console.log('\n— 2. /api/archivos/descargar (same-origin) —')
  const descargar = await import(join(RAIZ, 'app/api/archivos/descargar/route.ts'))
  const formulario = (url: string) => new NextRequest('https://docente.prueba.local/api/archivos/descargar', { method: 'POST', body: new URLSearchParams({ url, nombre: 'Proyecto_ficticio.pdf' }) })
  const dHoja = await descargar.POST(formulario(hoja.datos.url))
  const dDoc = await descargar.POST(formulario(pdf.datos.url))
  verificar(dHoja.status === 200 && dHoja.headers.get('content-type') === 'application/octet-stream' && /^attachment;/.test(dHoja.headers.get('content-disposition') || '') && dDoc.status === 200, 'PDF de hoja de evaluación y PDF de documento → descarga real (octet-stream attachment)')
  const rechazados = await Promise.all([
    descargar.POST(formulario(urlFirmada('imagenes-generadas-ia', `${DOC_A}/1700000000006-Imagen.png`, VIGENTE))),
    descargar.POST(formulario(urlFirmada('documentos-generados-ia', R_WORD, VIGENTE, 'https://otro.prueba.local'))),
    descargar.POST(formulario(urlFirmada('hojas-seguimiento', R_HOJA, VIGENTE).replace('https://', 'http://'))),
    descargar.POST(formulario(`${SUPABASE}/storage/v1/object/public/hojas-seguimiento/${R_HOJA}`)),
  ])
  verificar(rechazados.every((r) => r.status === 400), 'el intermediario sigue rechazando: bucket de imágenes, host externo, http y rutas que no son URL firmada')
  const conPuntos = await Promise.all([
    descargar.POST(formulario(`${SUPABASE}/storage/v1/object/sign/hojas-seguimiento/../imagenes-generadas-ia/${DOC_A}/1700000000006-Imagen.png?token=x`)),
    descargar.POST(formulario(`${SUPABASE}/storage/v1/object/sign/hojas-seguimiento/%2e%2e/imagenes-generadas-ia/${DOC_A}/1700000000006-Imagen.png?token=x`)),
  ])
  verificar(conPuntos.every((r) => r.status === 400), 'segmentos ".." o "%2e%2e" no permiten saltar de hojas-seguimiento a otro bucket (la URL se normaliza antes de validar el prefijo)')
  const fuenteDescargar = leer('app/api/archivos/descargar/route.ts')
  verificar(/if \(url\.protocol !== 'https:'\) return null/.test(fuenteDescargar) && /if \(url\.hostname !== hostSupabase\) return null/.test(fuenteDescargar) && !/SERVICE_ROLE|createClient/.test(fuenteDescargar), 'intermediario: mismas restricciones de protocolo y host, sin service_role — solo reenvía una URL firmada que ya es por sí misma la autorización del objeto exacto')

  // ===== 3. Cliente real =====
  console.log('\n— 3. lib/asistente/renovarUrlDocumento.ts (código real) —')
  const { supabase } = await import(join(RAIZ, 'lib/supabaseClient.ts'))
  ;(supabase.auth as unknown as { getSession: () => Promise<unknown> }).getSession = async () => ({ data: { session: { access_token: TOKEN_A } }, error: null })
  const cliente = await import(join(RAIZ, 'lib/asistente/renovarUrlDocumento.ts'))
  const urlVencida = urlFirmada('documentos-generados-ia', R_WORD)
  verificar(cliente.vencimientoUrlDocumento(urlVencida) === VENCIDA * 1000 && cliente.urlDocumentoVencida(urlVencida) && !cliente.urlDocumentoPorVencer(urlFirmada('documentos-generados-ia', R_PPT, VIGENTE)) && cliente.urlDocumentoPorVencer(urlFirmada('documentos-generados-ia', R_PPT, AHORA_S + 60)), 'vencimiento REAL leído del exp de la firma (vencida, vigente y por vencer en 1 min)')
  verificar([urlFirmada('imagenes-generadas-ia', 'a/b.png'), '/api/planeaciones/vista-previa-documento?datos=x', 'https://otro.prueba.local/x', undefined].every((u) => cliente.vencimientoUrlDocumento(u) === null), 'imágenes, vistas previas y URLs externas no se tratan como documentos renovables (siguen sus mecanismos)')
  const antes = registroRed.filter((u) => u === '/api/archivos/renovar-url').length
  const ref = { origen: 'mensaje', conversacionId: CONV_A, mensajeId: 'msg-1700000000002-2', indice: 1 } as const
  const concurrentes = await Promise.all([cliente.renovarUrlDocumento(ref), cliente.renovarUrlDocumento(ref), cliente.renovarUrlDocumento({ ...ref })])
  const despues = registroRed.filter((u) => u === '/api/archivos/renovar-url').length
  verificar(concurrentes.every((r: { url: string } | null) => r && r.url === concurrentes[0]!.url) && despues - antes === 1, 'tres renovaciones concurrentes de la misma referencia → UNA sola petición compartida')
  await cliente.renovarUrlDocumento(ref)
  verificar(registroRed.filter((u) => u === '/api/archivos/renovar-url').length === despues, 'resultado vigente reutilizado: no se vuelve a pedir mientras no esté por vencer')
  const refInexistente = { origen: 'mensaje', conversacionId: CONV_A, mensajeId: 'msg-inexistente', indice: 0 } as const
  const f1 = await cliente.renovarUrlDocumento(refInexistente)
  const n1 = registroRed.filter((u) => u === '/api/archivos/renovar-url').length
  const f2 = await cliente.renovarUrlDocumento(refInexistente)
  verificar(f1 === null && f2 === null && registroRed.filter((u) => u === '/api/archivos/renovar-url').length === n1, 'una falla no se reintenta en bucle (misma referencia → sin nueva petición)')
  const nLocal = registroRed.length
  const local = await cliente.renovarUrlDocumento({ origen: 'mensaje', conversacionId: 'conv-1700000000000-abc', mensajeId: 'msg-1', indice: 0 })
  verificar(local === null && registroRed.length === nLocal, 'conversación local no persistida (conv-…) → no se consulta el servidor')

  // ===== 4a. Hook real de TarjetaDescarga con React mínimo simulado =====
  console.log('\n— 4. TarjetaDescarga y conversión de formatos (código real) —')
  const panel = leer('components/Asistente/AsistentePanel.tsx')
  const iniHook = panel.indexOf('function useRenovacionDocumentos(')
  let kH = panel.indexOf('{', panel.indexOf(')', panel.indexOf('indices: number[] | undefined)'))), dH = 0
  for (; kH < panel.length; kH++) { if (panel[kH] === '{') dH++; else if (panel[kH] === '}') { dH--; if (dH === 0) break } }
  const textoHook = iniHook > 0 ? panel.slice(iniHook, kH + 1) : ''
  const ts = (await import('typescript')).default
  const jsHook = ts.transpileModule(`${textoHook}\nreturn useRenovacionDocumentos`, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText
  // React mínimo: estado por posición, efectos con comparación de
  // dependencias (limpieza + nueva ejecución solo si cambian), y
  // temporizadores/oyentes simulados observables.
  type PropsHook = [unknown[], string | null, string | undefined, number[] | undefined]
  const montar = (archivos: unknown[], conversacionId: string | null, mensajeId: string | undefined, indices: number[] | undefined) => {
    let props: PropsHook = [archivos, conversacionId, mensajeId, indices]
    const estados: unknown[] = []
    let slot = 0
    let pendiente: { fn: () => void | (() => void); deps: unknown[] } | null = null
    let previo: { deps: unknown[]; limpieza?: void | (() => void) } | null = null
    const oyentes: Record<string, () => void> = {}
    const temporizadores = new Set<{ f: () => void; ms: number }>()
    const programados: number[] = []
    const useState = (inicial: unknown) => { const i = slot++; if (!(i in estados)) estados[i] = inicial; return [estados[i], (v: unknown) => { estados[i] = typeof v === 'function' ? (v as (x: unknown) => unknown)(estados[i]) : v }] }
    const useEffect = (fn: () => void | (() => void), deps: unknown[]) => { pendiente = { fn, deps } }
    const documento = { visibilityState: 'visible', addEventListener: (t: string, f: () => void) => { oyentes[t] = f }, removeEventListener: (t: string) => { delete oyentes[t] } }
    const setTimeoutFalso = (f: () => void, ms: number) => { const t = { f, ms }; temporizadores.add(t); programados.push(ms); return t }
    const clearTimeoutFalso = (t: { f: () => void; ms: number }) => { temporizadores.delete(t) }
    const hook = new Function('useState', 'useEffect', 'document', 'renovarUrlDocumento', 'urlDocumentoPorVencer', 'urlDocumentoVencida', 'vencimientoUrlDocumento', 'MARGEN_RENOVACION_MS', 'setTimeout', 'clearTimeout', jsHook)(useState, useEffect, documento, cliente.renovarUrlDocumento, cliente.urlDocumentoPorVencer, cliente.urlDocumentoVencida, cliente.vencimientoUrlDocumento, cliente.MARGEN_RENOVACION_MS, setTimeoutFalso, clearTimeoutFalso) as (...a: unknown[]) => { archivosRenovados: { url: string; urlVer?: string }[]; estado: string }
    const render = () => {
      slot = 0
      pendiente = null
      const r = hook(...props)
      const e = pendiente as { fn: () => void | (() => void); deps: unknown[] } | null
      if (e && (!previo || e.deps.some((d, i) => d !== previo!.deps[i]))) {
        if (typeof previo?.limpieza === 'function') previo.limpieza()
        previo = { deps: e.deps, limpieza: e.fn() }
      }
      return r
    }
    const primero = render()
    return {
      primero, render, oyentes, temporizadores, programados,
      actualizar: (...nuevos: PropsHook) => { props = nuevos; return render() },
      desmontar: () => { if (typeof previo?.limpieza === 'function') previo.limpieza() },
    }
  }
  const esperar = () => new Promise((r) => setTimeout(r, 20))
  const archivosMsg2 = (MENSAJES[1].contenido as { archivos: { url: string }[] }).archivos
  const nHook = registroRed.length
  const tarjeta = montar(archivosMsg2.slice(0, 2), CONV_A, 'msg-1700000000002-2', [0, 1])
  await esperar(); await esperar()
  const tras = tarjeta.render()
  verificar(tarjeta.primero.estado === 'listo' && tras.estado === 'listo' && tras.archivosRenovados.every((a) => !cliente.urlDocumentoVencida(a.url)) && rutaDe(tras.archivosRenovados[1].url) === `documentos-generados-ia/${R_PDF}` && !!tras.archivosRenovados[1].urlVer, 'tarjeta con Word+PDF vencidos: se renuevan al mostrarla (antes del clic) y la vista usa las URLs vigentes')
  verificar(registroRed.length - nHook <= 1 + 4, 'renovación de la tarjeta: solo las peticiones necesarias (las concurrentes se comparten)')
  verificar(!!tarjeta.oyentes.visibilitychange, 'al volver a la pestaña se revisa otra vez el vencimiento (sin temporizadores en bucle)')
  tarjeta.desmontar()
  verificar(!tarjeta.oyentes.visibilitychange, 'al desmontar la tarjeta se quita el oyente y el temporizador')
  const nVigente = registroRed.length
  const vigente = montar([{ tipo: 'powerpoint', nombre: 'p.pptx', url: urlFirmada('documentos-generados-ia', R_PPT, VIGENTE) }], CONV_A, 'msg-1700000000003-3', [0])
  await esperar()
  verificar(vigente.render().estado === 'listo' && registroRed.length === nVigente, 'URL todavía vigente → ninguna petición')
  const borrado = montar([{ tipo: 'word', nombre: 'Borrado.docx', url: urlFirmada('documentos-generados-ia', `${DOC_A}/1700000000009-Borrado.docx`) }], CONV_A, 'msg-inexistente', [0])
  await esperar(); await esperar()
  const sinRef = montar([{ tipo: 'word', nombre: 'x.docx', url: urlVencida }], 'conv-local-1', 'msg-x', [0])
  await esperar()
  verificar(borrado.render().estado === 'no_disponible' && sinRef.render().estado === 'no_disponible', 'archivo eliminado o mensaje no persistido → "no disponible" (la tarjeta muestra su aviso de siempre, sin URL inventada)')
  const nImg = registroRed.length
  const imagen = montar([{ tipo: 'imagen', nombre: 'i.png', url: urlFirmada('imagenes-generadas-ia', `${DOC_A}/1700000000006-Imagen.png`), assetId: 'a1' }], CONV_A, 'msg-img', [0])
  await esperar()
  verificar(imagen.render().estado === 'listo' && registroRed.length === nImg, 'imágenes: el hook no interviene (su renovación por assetId queda igual)')

  // Ciclo de vida: cambio de conversación (desmontar y volver), estado de
  // una tarjeta anterior, errores sin bucles y temporizadores únicos.
  const nVolver = registroRed.filter((u) => u === '/api/archivos/renovar-url').length
  const deVuelta = montar(archivosMsg2.slice(0, 2), CONV_A, 'msg-1700000000002-2', [0, 1])
  await esperar(); await esperar()
  verificar(registroRed.filter((u) => u === '/api/archivos/renovar-url').length === nVolver && deVuelta.render().archivosRenovados.every((a) => !cliente.urlDocumentoVencida(a.url)), 'volver a una conversación ya renovada (desmontar/montar) → cero solicitudes nuevas, URLs vigentes desde la caché')
  const otraTarjeta = deVuelta.actualizar([{ tipo: 'word', nombre: 'Borrado.docx', url: urlFirmada('documentos-generados-ia', `${DOC_A}/1700000000009-Borrado.docx`) }], CONV_A, 'msg-inexistente', [0])
  verificar(otraTarjeta.estado === 'listo' && otraTarjeta.archivosRenovados[0].url.includes('Borrado') && !otraTarjeta.archivosRenovados[0].url.includes('Proyecto_ficticio'), 'la misma tarjeta con otros archivos nunca aplica URLs ni estado de la anterior')
  await esperar(); await esperar()
  verificar(deVuelta.render().estado === 'no_disponible', '…y llega a su propio estado real (archivo eliminado → no disponible)')
  deVuelta.desmontar()
  const PROXIMA = AHORA_S + 120
  const enMargen = montar([{ tipo: 'word', nombre: 'm.docx', url: urlFirmada('documentos-generados-ia', `${DOC_A}/1700000000009-Borrado.docx`, PROXIMA) }], CONV_A, 'msg-inexistente', [0])
  await esperar(); await esperar()
  const msProgramado = Math.max(...enMargen.programados)
  verificar(enMargen.render().estado === 'listo' && enMargen.temporizadores.size === 1 && msProgramado > 100_000, `URL dentro del margen con renovación fallida: sigue disponible hasta su vencimiento real y se programa UNA revisión en ese vencimiento (${Math.round(msProgramado / 1000)} s), nunca un sondeo cada segundo`)
  const nAntesVisible = registroRed.length
  enMargen.oyentes.visibilitychange(); enMargen.oyentes.visibilitychange()
  await esperar(); await esperar()
  verificar(enMargen.temporizadores.size === 1 && registroRed.length === nAntesVisible, 'revisiones simultáneas (volver a la pestaña dos veces) → un solo temporizador activo y sin nuevas solicitudes tras la falla')
  enMargen.desmontar()
  verificar(enMargen.temporizadores.size === 0 && !enMargen.oyentes.visibilitychange, 'al desmontar no queda ningún temporizador ni oyente')
  const yaVencido = montar([{ tipo: 'word', nombre: 'm.docx', url: urlFirmada('documentos-generados-ia', `${DOC_A}/1700000000009-Borrado.docx`, AHORA_S - 1) }], CONV_A, 'msg-inexistente', [0])
  await esperar(); await esperar()
  verificar(yaVencido.render().estado === 'no_disponible' && yaVencido.temporizadores.size === 0, 'enlace vencido sin renovación posible → no disponible, sin temporizadores ni reintentos')
  yaVencido.desmontar()

  // Identidad: índices calculados con las funciones REALES del render
  // (archivosDelMensaje + agruparArchivosPorDocumento) sobre un mensaje
  // con documentos agrupados → cada índice firma exactamente su archivo.
  const iniArch = panel.indexOf('function archivosDelMensaje(')
  const finAgr = panel.indexOf('\nfunction formatearTamano(')
  const jsAgrupar = ts.transpileModule(`${panel.slice(iniArch, finAgr)}\nreturn { archivosDelMensaje, agruparArchivosPorDocumento }`, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText
  const render2 = new Function(jsAgrupar)() as { archivosDelMensaje: (m: unknown) => { url: string }[]; agruparArchivosPorDocumento: (a: unknown[]) => { url: string }[][] }
  const contenidoMsg2 = MENSAJES[1].contenido as { archivo: { url: string }; archivos: { url: string; tipoDocumento?: string }[] }
  const conPlaneacion = { id: 'msg-1700000000002-2', archivo: contenidoMsg2.archivo, archivos: contenidoMsg2.archivos.map((a, i) => (i < 2 ? { ...a, tipoDocumento: 'planeacion' } : a)) }
  const listaMsg = render2.archivosDelMensaje(conPlaneacion)
  const grupos = render2.agruparArchivosPorDocumento(listaMsg)
  const indicesGrupos = grupos.map((g) => g.map((a) => listaMsg.indexOf(a)))
  const firmadosPorIndice = await Promise.all(indicesGrupos.flat().map((indice) => pedir(msg('msg-1700000000002-2', indice))))
  verificar(JSON.stringify(indicesGrupos) === '[[0,1],[2]]' && firmadosPorIndice.map((r) => rutaDe(r.datos.url)).join('|') === [`documentos-generados-ia/${R_WORD}`, `documentos-generados-ia/${R_PDF}`, `hojas-seguimiento/${R_HOJA}`].join('|'), 'grupos Word+PDF de planeación y hoja: índices [[0,1],[2]] y cada uno firma exactamente su propio archivo persistido')
  const soloArchivo = render2.archivosDelMensaje({ archivo: (MENSAJES[0].contenido as { archivo: unknown }).archivo })
  const sinNada = render2.archivosDelMensaje({})
  verificar(soloArchivo.length === 1 && soloArchivo.indexOf(soloArchivo[0]) === 0 && sinNada.length === 0 && (await pedir(msg('msg-1700000000001-1', 0))).status === 200, 'mensaje con solo `archivo` → índice 0, el mismo criterio que usa el servidor')
  verificar(/const documentosRenovables = archivos\.every\(\(archivo\) => vencimientoUrlDocumento\(archivo\.url\) !== null\)/.test(panel) && /const ocultarPorVencido = documentosRenovables \? renovacion\.estado === 'no_disponible' : vencido && !puedeRefrescar && !vistaPreviaRegenerable/.test(panel), 'TarjetaDescarga: los documentos renovables usan el estado real; imágenes y vistas previas conservan su lógica')
  verificar((panel.match(/\n\s+disabled=\{renovando\}\n/g) || []).length === 5 && /const renovando = renovacion\.estado === 'renovando'/.test(panel), 'Ver/Descargar/Compartir solo se deshabilitan mientras se renueva una URL ya vencida (sin botones ni avisos nuevos)')
  verificar(/onClick=\{\(\) => ver\(archivo\)\}/.test(panel) && /: abrirArchivo\(archivo\)\)/.test(panel) && /: descargarArchivoDirecto\(archivo\)\)/.test(panel) && /function abrirArchivo\(archivo: \{ url: string; urlVer\?: string \}\) \{\n\s+window\.open\(archivo\.urlVer \?\? archivo\.url, '_blank'\)/.test(panel), 'Ver y Descargar siguen siendo síncronos en el clic (window.open / formulario same-origin) con la URL ya renovada')
  verificar(/conversacionId=\{asistente\.conversacionActivaId\}\n\s+mensajeId=\{m\.id\}\n\s+indices=\{grupo\.map\(\(archivo\) => archivosDelMensaje\(m\)\.indexOf\(archivo\)\)\}/.test(panel) && /return m\.archivos && m\.archivos\.length > 0 \? m\.archivos : m\.archivo \? \[m\.archivo\] : \[\]/.test(panel), 'la tarjeta recibe la conversación activa, el id real del mensaje y la posición de cada archivo con el MISMO orden que guarda mensajes_chat')

  // ===== 4b. Conversión real =====
  const servicio = leer('lib/asistente/AsistenteService.ts')
  const iniConv = servicio.indexOf('  private async ejecutarConversionFormato(')
  let kC = servicio.indexOf('{', servicio.indexOf(')', iniConv)), dC = 0
  for (; kC < servicio.length; kC++) { if (servicio[kC] === '{') dC++; else if (servicio[kC] === '}') { dC--; if (dC === 0) break } }
  const cuerpoConv = servicio.slice(servicio.indexOf('{', servicio.indexOf(')', iniConv)) + 1, kC)
  const jsConv = ts.transpileModule(`async function __conv(this: any, tipoResuelto: any, textoVisible: any) {\n${cuerpoConv}\n}\nreturn __conv`, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText
  const conv = new Function('renovarUrlDocumento', 'urlDocumentoPorVencer', jsConv)(cliente.renovarUrlDocumento, cliente.urlDocumentoPorVencer) as (this: unknown, t: string, v: string) => Promise<void>
  const servicioFalso = (archivosGenerados: Record<string, unknown>, conversacionActivaId: string | null) => {
    const llamadas: { metodo: string; args: unknown[] }[] = []
    const estadosGenerando: boolean[] = []
    const self = {
      documentoActivo: { id: 'msg-1700000000002-2', texto: 'Documento ficticio', archivosGenerados },
      conversacionActivaId,
      generando: false,
      notificar: () => { estadosGenerando.push(self.generando) },
      reutilizarArchivoExistente: (...a: unknown[]) => { llamadas.push({ metodo: 'reutilizar', args: a }) },
      informarArchivoNoRecuperable: (...a: unknown[]) => { llamadas.push({ metodo: 'noRecuperable', args: a }) },
      enviarComoFinalizacion: async (...a: unknown[]) => { llamadas.push({ metodo: 'regenerar', args: a }) },
    }
    return { self, llamadas, estadosGenerando }
  }
  const cacheVencida = servicioFalso({ pdf: { tipo: 'pdf', nombre: 'Proyecto_ficticio.pdf', url: urlFirmada('documentos-generados-ia', R_PDF) } }, CONV_A)
  await conv.call(cacheVencida.self, 'pdf', 'conviértelo a PDF')
  const entregado = cacheVencida.llamadas[0]?.args[1] as { url: string; urlVer?: string } | undefined
  verificar(cacheVencida.llamadas.length === 1 && cacheVencida.llamadas[0].metodo === 'reutilizar' && !!entregado && !cliente.urlDocumentoVencida(entregado.url) && rutaDe(entregado.url) === `documentos-generados-ia/${R_PDF}` && !!entregado.urlVer, 'conversión con archivo en caché VENCIDO → se entrega el MISMO archivo con la URL vigente (sin regenerar)')
  verificar(cacheVencida.estadosGenerando[0] === true && cacheVencida.self.generando === false, 'durante la recuperación se bloquea el envío (generando) y luego se libera')
  const cacheAjena = servicioFalso({ word: { tipo: 'word', nombre: 'x.docx', url: urlVencida } }, CONV_A2)
  await conv.call(cacheAjena.self, 'word', 'pásalo a Word')
  verificar(cacheAjena.llamadas.length === 1 && cacheAjena.llamadas[0].metodo === 'noRecuperable' && cacheAjena.self.generando === false, 'si la renovación falla → respuesta honesta "no pude recuperar"; nunca se muestra como disponible ni se regenera')
  const nConv = registroRed.length
  const cacheVigente = servicioFalso({ powerpoint: { tipo: 'powerpoint', nombre: 'p.pptx', url: urlFirmada('documentos-generados-ia', R_PPT, VIGENTE) } }, CONV_A)
  await conv.call(cacheVigente.self, 'powerpoint', 'en PowerPoint')
  verificar(cacheVigente.llamadas.length === 1 && cacheVigente.llamadas[0].metodo === 'reutilizar' && registroRed.length === nConv, 'caché con URL vigente → se reutiliza tal cual, sin peticiones')
  const sinCache = servicioFalso({}, CONV_A)
  await conv.call(sinCache.self, 'excel', 'en Excel')
  verificar(sinCache.llamadas.length === 1 && sinCache.llamadas[0].metodo === 'regenerar', 'sin archivo en caché → el camino de siempre (finalizar el documento), sin cambios')
  const iniInf = servicio.indexOf('  private informarArchivoNoRecuperable(')
  let kI = servicio.indexOf('{', servicio.indexOf(')', iniInf)), dI = 0
  for (; kI < servicio.length; kI++) { if (servicio[kI] === '{') dI++; else if (servicio[kI] === '}') { dI--; if (dI === 0) break } }
  const jsInf = ts.transpileModule(`function __inf(this: any, textoVisible: any) {${servicio.slice(servicio.indexOf('{', servicio.indexOf(')', iniInf)) + 1, kI)}}\nreturn __inf`, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText
  let contadorIds = 0
  const inf = new Function('nuevoId', jsInf)(() => `msg-${Date.now()}-${contadorIds++}`) as (this: unknown, t: string) => void
  const persistidos: { id: string; rol: string; texto: string; creadoEn: number; archivo?: unknown }[] = []
  let notificaciones = 0
  const svc = { mensajes: [] as unknown[], turnoAbierto: 'x', notificar: () => { notificaciones++ }, persistirMensajeAsegurandoConversacion: (m: { id: string; rol: string; texto: string; creadoEn: number }) => { persistidos.push(m) } }
  inf.call(svc, 'conviértelo a PDF')
  const recarga = [...persistidos].sort((a, b) => b.creadoEn - a.creadoEn).reverse()
  verificar(persistidos.length === 2 && persistidos[0].rol === 'usuario' && persistidos[0].texto === 'conviértelo a PDF' && persistidos[1].rol === 'asistente' && persistidos[1].creadoEn > persistidos[0].creadoEn && recarga[0].rol === 'usuario' && notificaciones === 1 && (svc.mensajes as unknown[]).length === 2 && svc.turnoAbierto === null && persistidos.every((m) => !m.archivo), 'no recuperable: el mensaje del usuario y la respuesta se guardan con el mecanismo de siempre (remoto + copia local vía notificar), en orden estable al recargar y sin archivo')
  verificar(/private informarArchivoNoRecuperable\(textoVisible: string\)/.test(servicio) && !/informarArchivoNoRecuperable[\s\S]{0,600}archivo[,:]/.test(servicio.slice(servicio.indexOf('private informarArchivoNoRecuperable'), servicio.indexOf('private informarArchivoNoRecuperable') + 700)), 'la respuesta de no recuperable no adjunta ningún archivo')

  console.log(fallos === 0 ? '\nTodas las pruebas pasaron.' : `\n${fallos} prueba(s) fallaron.`)
  process.exit(fallos === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('ERROR DEL VERIFICADOR:', e instanceof Error ? `${e.name}: ${e.message}` : 'desconocido')
  process.exit(1)
})
