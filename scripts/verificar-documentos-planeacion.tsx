// Hito 2, etapa 5b — Word/PDF de una versión desde la pestaña Planeación.
// Sin red, sin IA: la ruta con el orquestador REAL de la etapa 4
// (obtenerArchivoDeVersion) sobre datos en memoria, el cliente con
// ventana y formulario simulados, y el render de los documentos.
//   npx tsx scripts/verificar-documentos-planeacion.tsx

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { obtenerArchivoDeVersion, type DependenciasArchivoVersion } from '../lib/planeacion/archivosVersion'
import { atenderArchivoVersion, estadoHttp, zonaHorariaValida, type DependenciasApiArchivoVersion } from '../lib/planeacion/archivoVersionApi'

process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://127.0.0.1:9'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'sin-clave-pruebas'

let fallos = 0
let total = 0
function verificar(ok: boolean, nombre: string) {
  total++
  if (!ok) fallos++
  console.log(`${ok ? '✓' : '✗'} ${nombre}`)
}
const leer = (r: string) => readFileSync(join(__dirname, '..', r), 'utf-8')
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const V2 = 'e2000000-0000-4000-8000-000000000002'
const V4 = 'e4000000-0000-4000-8000-000000000004'
const VB = 'eb000000-0000-4000-8000-000000000001'
// Versiones históricas sin contenido canónico: sin archivos / con su PDF original.
const V0 = 'e0000000-0000-4000-8000-000000000001'
const V0F = 'e0000000-0000-4000-8000-000000000002'
const MIME = { word: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pdf: 'application/pdf' } as const
type Fila = Record<string, unknown>

// Base en memoria con RLS por docente y las RPC de la etapa 4 (misma semántica).
function escenario(opciones: { demora?: number } = {}) {
  const bd = {
    planeacion_versiones: [
      { id: V2, docente_id: A, planeacion_id: 'p1', grupo_id: 'g1', numero: 2, contenido: '📋 PLANEACIÓN\nTexto v2', estructura: { proyecto: { indicadores: ['Ind v2'] } }, hoja_id: null, documento_word_archivo_id: 'w2', documento_pdf_archivo_id: null },
      { id: V4, docente_id: A, planeacion_id: 'p1', grupo_id: 'g1', numero: 4, contenido: '📋 PLANEACIÓN\nTexto v4', estructura: { proyecto: { indicadores: ['Ind v4'] } }, hoja_id: null, documento_word_archivo_id: null, documento_pdf_archivo_id: 'f4' },
      { id: V0, docente_id: A, planeacion_id: 'p0', grupo_id: 'g1', numero: 1, contenido: null, estructura: {}, hoja_id: null, documento_word_archivo_id: null, documento_pdf_archivo_id: null },
      { id: V0F, docente_id: A, planeacion_id: 'p0f', grupo_id: 'g1', numero: 1, contenido: null, estructura: {}, hoja_id: null, documento_word_archivo_id: null, documento_pdf_archivo_id: 'f0' },
      { id: VB, docente_id: B, planeacion_id: 'pb', grupo_id: 'gb', numero: 1, contenido: 'ajeno', estructura: {}, hoja_id: null, documento_word_archivo_id: null, documento_pdf_archivo_id: null },
    ] as Fila[],
    perfiles_docentes: [{ id: A, docente_id: A }] as Fila[],
    grupos: [{ id: 'g1', docente_id: A, grado: '3', grupo: 'A' }] as Fila[],
  }
  const cliente = (docente: string) => ({
    from: (t: keyof typeof bd) => {
      let filas = bd[t].filter((f) => f.docente_id === docente)
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => { filas = filas.filter((f) => f[c] === v); return q },
        maybeSingle: async () => ({ data: filas[0] ?? null, error: null }),
        single: async () => ({ data: filas[0] ?? null, error: null }),
      }
      return q
    },
  }) as unknown as SupabaseClient
  const registro = new Map<string, { docente: string; mime: string; origen: Fila }>()
  const reservas = new Map<string, { estado: string; ejecucion: string }>()
  const rpcs: string[] = []
  let n = 0
  const servidor = {
    rpc: async (fn: string, a: Record<string, string>) => {
      rpcs.push(fn)
      const v = bd.planeacion_versiones.find((x) => x.id === a.p_version_id && x.docente_id === a.p_docente_id)
      const col = a.p_formato === 'word' ? 'documento_word_archivo_id' : 'documento_pdf_archivo_id'
      const k = `${a.p_version_id}:${a.p_formato}`
      const r = reservas.get(k)
      if (fn === 'reservar_archivo_version') {
        if (!v) return { data: { resultado: 'version_invalida' } }
        if (v[col]) return { data: { resultado: 'existente', archivo_id: v[col] } }
        if (r?.estado === 'generando') return { data: { resultado: 'en_proceso' } }
        const nueva = { estado: 'generando', ejecucion: `e${++n}` }
        reservas.set(k, nueva)
        return { data: { resultado: 'reservado', ejecucion_id: nueva.ejecucion } }
      }
      if (fn === 'fallar_archivo_version') { if (r) r.estado = 'fallido'; return { data: { resultado: 'fallido' } } }
      const f = registro.get(a.p_archivo_id)
      if (!r || !v || r.ejecucion !== a.p_ejecucion_id) return { data: { resultado: 'rechazado' } }
      if (!f || f.docente !== a.p_docente_id || f.mime !== MIME[a.p_formato as 'word'] || f.origen.versionId !== a.p_version_id || f.origen.ejecucionId !== r.ejecucion) return { data: { resultado: 'archivo_invalido' } }
      v[col] = a.p_archivo_id
      r.estado = 'vinculado'
      return { data: { resultado: 'vinculado', archivo_id: a.p_archivo_id } }
    },
  } as unknown as SupabaseClient
  const generados: Fila[] = []
  const deps: DependenciasArchivoVersion = {
    servidor,
    generar: (async (tipo: 'word' | 'pdf', texto: string, _p: unknown, zona: string | null, _sb: unknown, userId: string, o: Fila) => {
      generados.push({ tipo, texto, zona, origen: o.origenVersion })
      if (opciones.demora) await new Promise((r) => setTimeout(r, opciones.demora))
      const id = `nuevo-${generados.length}`
      registro.set(id, { docente: userId, mime: MIME[tipo], origen: o.origenVersion as Fila })
      return { nombre: `PLANEACION_${o.sufijoNombre}.${tipo === 'word' ? 'docx' : 'pdf'}`, url: `https://firmada/${id}`, urlVer: `https://ver/${id}`, tamanoBytes: 1, archivoId: id }
    }) as unknown as DependenciasArchivoVersion['generar'],
    enlaces: async (_d, id) => ({ estado: 'ok', nombre: `original-${id}`, url: `https://nueva/${id}`, urlVer: `https://nueva-ver/${id}` }),
    descartar: async () => {},
  }
  const autenticaciones: (string | null)[] = []
  const api: DependenciasApiArchivoVersion = {
    autenticar: async (token) => {
      autenticaciones.push(token)
      if (token === 'tkn-a') return { ok: true, docenteId: A, sb: cliente(A) }
      return { ok: false }
    },
    obtener: obtenerArchivoDeVersion,
    dependencias: () => deps,
  }
  const pedir = (versionId: string, cuerpo: unknown, token: string | null = 'tkn-a') => atenderArchivoVersion(api, { token, versionId, cuerpo })
  return { bd, rpcs, generados, autenticaciones, pedir }
}

async function main() {
  console.log('== 1. Ruta: archivo exacto de la versión, sin IA')
  {
    const e = escenario()
    const invalidos = [await e.pedir('no-uuid', { formato: 'pdf' }), await e.pedir(V4, { formato: 'excel' }), await e.pedir(V4, null)]
    verificar(invalidos.every((r) => r.estado === 'invalido' && estadoHttp(r) === 400) && e.autenticaciones.length === 0, '1a. Identificador o formato inválidos: 400, sin consultar nada')
    const sinSesion = await e.pedir(V4, { formato: 'pdf' }, null)
    const ajena = await e.pedir(VB, { formato: 'pdf' })
    verificar(sinSesion.estado === 'sesion' && estadoHttp(sinSesion) === 401 && ajena.estado === 'no_disponible' && estadoHttp(ajena) === 404 && e.rpcs.length === 0 && e.generados.length === 0,
      '1b. Sin sesión: 401; versión de otro docente (RLS): 404, sin reservar ni generar')
    const pdf = await e.pedir(V4, { formato: 'pdf', soloExistente: true })
    verificar(pdf.estado === 'archivo' && pdf.archivoId === 'f4' && !pdf.generado && e.generados.length === 0 && e.rpcs.length === 0, '1c. Existente: el original exacto de esa versión, sin regenerar ni reservar')
    verificar(!/https?:\/\//.test(JSON.stringify(pdf)), '1d. La respuesta nunca lleva enlaces (se recupera por archivoId con la verificación de propiedad)')
    const w2 = await e.pedir(V2, { formato: 'word', soloExistente: true })
    verificar(w2.estado === 'archivo' && w2.archivoId === 'w2' && w2.numero === 2, '1e. Versión 2: su propio Word (no el de otra versión)')
    const sinArchivo = await e.pedir(V4, { formato: 'word', soloExistente: true })
    verificar(sinArchivo.estado === 'sin_archivo' && e.rpcs.length === 0 && e.generados.length === 0, '1f. Ver/Descargar sobre un archivo que falta: sin_archivo, nunca genera')
  }
  {
    const e = escenario()
    const r = await e.pedir(V4, { formato: 'word', zonaHoraria: 'America/Hermosillo' })
    const g = e.generados[0]
    verificar(r.estado === 'archivo' && r.generado && e.generados.length === 1 && (g.origen as Fila).versionId === V4 && String(g.texto).includes('Texto v4') && String(g.texto).includes('Ind v4') && g.zona === 'America/Hermosillo',
      '1g. Generar el que falta: una vez, desde el snapshot de ESA versión, con su identidad de procedencia')
    verificar(e.bd.planeacion_versiones[1].documento_word_archivo_id === 'nuevo-1' && e.bd.planeacion_versiones[0].documento_word_archivo_id === 'w2', '1h. Queda ligado solo a esa versión')
    const otra = await e.pedir(V4, { formato: 'word' })
    verificar(otra.estado === 'archivo' && otra.archivoId === 'nuevo-1' && !otra.generado && e.generados.length === 1, '1i. Volver a pedirlo: el mismo archivo, sin regenerar')
  }
  {
    const e = escenario({ demora: 30 })
    const [x, y] = await Promise.all([e.pedir(V4, { formato: 'word' }), e.pedir(V4, { formato: 'word' })])
    const proceso = x.estado === 'en_proceso' ? x : y
    verificar(e.generados.length === 1 && [x.estado, y.estado].sort().join() === 'archivo,en_proceso' && estadoHttp(proceso) === 202, '1j. Dos solicitudes simultáneas: una sola generación; la otra recibe 202 en proceso')
  }
  verificar(zonaHorariaValida('America/Mexico_City') === 'America/Mexico_City' && zonaHorariaValida('Nada/Inventada') === null && zonaHorariaValida(42) === null, '1k. Zona horaria del cliente validada')

  console.log('== 2. Cliente')
  const recuperacion = await import('../lib/asistente/recuperacionArchivo')
  const { supabase } = await import('../lib/supabaseClient')
  {
    const pedidas: { url: string; init: RequestInit }[] = []
    const respuestas = [{ estado: 'en_proceso' }, { estado: 'en_proceso' }, { estado: 'archivo', archivoId: 'nuevo-1', generado: true }]
    const solicitar = (async (url: string, init: RequestInit) => { pedidas.push({ url, init }); return { json: async () => respuestas.shift() } }) as unknown as typeof fetch
    let esperas = 0
    const r = await recuperacion.pedirArchivoDeVersion(V4, 'word', { token: 'tkn', soloExistente: false, solicitar, esperar: async () => { esperas++ } })
    const cuerpo = JSON.parse(String(pedidas[0].init.body))
    verificar(r.estado === 'archivo' && r.archivoId === 'nuevo-1' && pedidas.length === 3 && esperas === 2, '2a. En proceso: espera y vuelve a preguntar (nunca genera en paralelo)')
    verificar(pedidas[0].url === `/api/planeaciones/versiones/${V4}/archivo` && (pedidas[0].init.headers as Record<string, string>).Authorization === 'Bearer tkn' && cuerpo.formato === 'word' && cuerpo.soloExistente === false,
      '2b. Pide la versión exacta con la sesión en la cabecera')
    const agotado = await recuperacion.pedirArchivoDeVersion(V4, 'word', { token: 't', soloExistente: false, intentos: 3, esperar: async () => {}, solicitar: (async () => ({ json: async () => ({ estado: 'en_proceso' }) })) as unknown as typeof fetch })
    const caida = await recuperacion.pedirArchivoDeVersion(V4, 'word', { token: 't', soloExistente: true, solicitar: (async () => { throw new Error('sin red') }) as unknown as typeof fetch })
    const raro = await recuperacion.pedirArchivoDeVersion(V4, 'word', { token: 't', soloExistente: true, solicitar: (async () => ({ json: async () => ({ estado: 'otro' }) })) as unknown as typeof fetch })
    verificar(agotado.estado === 'en_proceso' && caida.estado === 'error' && raro.estado === 'error', '2c. Límite de espera, falla de red y respuesta desconocida: estados claros')
  }
  {
    // Ventana y formulario simulados (Safari: la ventana se abre en el mismo toque).
    const eventos: string[] = []
    const formularios: { target: string; campos: Record<string, string>; action: string }[] = []
    const ventana = { cerrada: false, close() { this.cerrada = true; eventos.push('cerrar') } }
    const g = globalThis as unknown as Record<string, unknown>
    g.window = { open: (_u: string, nombre: string) => { eventos.push(`abrir:${nombre.startsWith('archivo-')}`); return ventana } }
    g.document = {
      createElement: () => {
        const f = { method: '', action: '', target: '', style: {}, hijos: [] as { name: string; value: string }[], appendChild(h: { name: string; value: string }) { this.hijos.push(h) }, submit() { formularios.push({ target: f.target, action: f.action, campos: Object.fromEntries(f.hijos.map((h) => [h.name, h.value])) }) }, remove() {} }
        return f
      },
      body: { appendChild: () => {} },
    }
    ;(supabase.auth as unknown as { getSession: unknown }).getSession = async () => ({ data: { session: { access_token: 'tkn-real' } } })
    const g2 = globalThis as unknown as { fetch: typeof fetch }
    const fetchOriginal = g2.fetch
    let respuesta: Fila = { estado: 'archivo', archivoId: 'f4', generado: false }
    g2.fetch = (async (_u: string, init: RequestInit) => { eventos.push(`pedir:${JSON.parse(String(init.body)).soloExistente}`); return { json: async () => respuesta } }) as unknown as typeof fetch
    const fin = (r: unknown) => new Promise<unknown>((ok) => setTimeout(() => ok(r), 0))
    let resultado: unknown = null
    recuperacion.recuperarArchivoDeVersion(V4, 'pdf', 'ver', (r) => { resultado = r })
    const abiertaAntes = eventos[0] === 'abrir:true' && eventos.length === 1
    await fin(null); await fin(null); await fin(null)
    verificar(abiertaAntes && eventos.includes('pedir:true'), '2d. Ver: la ventana se abre en el mismo toque, antes de cualquier espera; nunca pide generar')
    verificar(formularios.length === 1 && formularios[0].action === '/api/archivos/descargar' && formularios[0].target.startsWith('archivo-') && formularios[0].campos.archivoId === 'f4' && formularios[0].campos.modo === 'ver' && formularios[0].campos.token === 'tkn-real' && (resultado as Fila)?.estado === 'archivo',
      '2e. …y el original se abre con la recuperación autenticada de siempre (archivoId + verificación de propiedad)')
    eventos.length = 0; formularios.length = 0; respuesta = { estado: 'sin_archivo', numero: 4 }
    recuperacion.recuperarArchivoDeVersion(V4, 'pdf', 'ver', (r) => { resultado = r })
    await fin(null); await fin(null); await fin(null)
    verificar(eventos.includes('cerrar') && formularios.length === 0 && (resultado as Fila).estado === 'sin_archivo', '2f. Sin archivo: la ventana se cierra y no se envía nada')
    eventos.length = 0; formularios.length = 0; respuesta = { estado: 'archivo', archivoId: 'w2', generado: false }
    recuperacion.recuperarArchivoDeVersion(V2, 'word', 'descargar', () => {})
    await fin(null); await fin(null); await fin(null)
    verificar(!eventos.some((x) => x.startsWith('abrir')) && formularios.length === 1 && formularios[0].target === '' && formularios[0].campos.modo === 'descargar' && formularios[0].campos.archivoId === 'w2',
      '2g. Descargar: sin ventana nueva, descarga directa del original (iPhone, Android y web)')
    eventos.length = 0
    respuesta = { estado: 'archivo', archivoId: 'nuevo-1', generado: true }
    const generado = await recuperacion.generarArchivoDeVersion(V4, 'word')
    verificar(generado.estado === 'archivo' && eventos.join() === 'pedir:false' && formularios.length === 1, '2h. Generar: pide generar una vez y no abre ni descarga por su cuenta')
    g2.fetch = fetchOriginal
  }

  console.log('== 3. Pantalla')
  const { default: DocumentoVersion, avisoDocumento } = await import('../components/Planeacion/DocumentoVersion')
  const falta = renderToStaticMarkup(<DocumentoVersion versionId={V4} formato="word" disponible={false} generable onGenerado={() => {}} />)
  const pdf = renderToStaticMarkup(<DocumentoVersion versionId={V4} formato="pdf" disponible generable onGenerado={() => {}} />)
  const word = renderToStaticMarkup(<DocumentoVersion versionId={V2} formato="word" disponible generable onGenerado={() => {}} />)
  const sinContenido = renderToStaticMarkup(<DocumentoVersion versionId={V0} formato="word" disponible={false} generable={false} onGenerado={() => {}} />)
  const sinContenidoConOriginal = renderToStaticMarkup(<DocumentoVersion versionId={V0F} formato="pdf" disponible generable={false} onGenerado={() => {}} />)
  const botones = (h: string) => [...h.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1])
  verificar(botones(falta).join() === 'Generar Word' && falta.includes('Aún no generado'), '3a. Sin archivo: solo «Generar Word»')
  verificar(botones(pdf).join() === 'Ver,Descargar' && pdf.includes('Original guardado'), '3b. PDF existente: Ver y Descargar')
  verificar(botones(word).join() === 'Descargar', '3c. Word existente: solo Descargar (el navegador no lo muestra en línea)')
  verificar(botones(sinContenido).length === 0 && sinContenido.includes('Sin contenido para generar') && !sinContenido.includes('Aún no generado'), '3f. Sin contenido canónico ni original: no se ofrece generar')
  verificar(botones(sinContenidoConOriginal).join() === 'Ver,Descargar' && sinContenidoConOriginal.includes('Original guardado'), '3g. Sin contenido pero con original: conserva Ver y Descargar')
  verificar(/generable=\{!!version\.contenido\?\.trim\(\)\}/.test(leer('components/Planeacion/DetallePlaneacion.tsx')), '3h. La pantalla decide con el contenido canónico real de la versión')
  {
    const e = escenario()
    const r = await e.pedir(V0, { formato: 'pdf' })
    const r2 = await e.pedir(V0F, { formato: 'pdf' })
    verificar(r.estado !== 'archivo' && e.generados.length === 0 && !e.rpcs.includes('reservar_archivo_version') && r2.estado === 'archivo' && !('generado' in r2 && r2.generado), `3i. Servidor: sin contenido no reserva ni genera (${r.estado}); con original lo entrega sin regenerar`)
  }
  verificar(avisoDocumento({ estado: 'inexistente' }, 'pdf')!.includes('ya no está disponible') && avisoDocumento({ estado: 'en_proceso' }, 'word')!.includes('se está preparando')
    && avisoDocumento({ estado: 'sesion' }, 'pdf')!.includes('sesión') && avisoDocumento({ estado: 'archivo', archivoId: 'x', generado: false }, 'pdf') === null, '3d. Mensajes claros para cada resultado')
  const detalle = leer('components/Planeacion/DetallePlaneacion.tsx')
  verificar(/key=\{`\$\{version\.id\}-word`\} versionId=\{version\.id\}/.test(detalle) && /key=\{`\$\{version\.id\}-pdf`\} versionId=\{version\.id\}/.test(detalle), '3e. Cada documento pertenece a la versión seleccionada (cambiar de versión reinicia su estado)')

  console.log('== 4. Fuentes')
  const ruta = leer('app/api/planeaciones/versiones/[id]/archivo/route.ts')
  const api = leer('lib/planeacion/archivoVersionApi.ts')
  const cliente = leer('lib/asistente/recuperacionArchivo.ts') + leer('components/Planeacion/DocumentoVersion.tsx')
  verificar(/obtener: obtenerArchivoDeVersion/.test(ruta) && /dependenciasArchivoVersion\(clienteServidorArchivos\(\)\)/.test(ruta) && /autenticarRequestApi/.test(ruta), '4a. La ruta reutiliza el orquestador, las dependencias y la autenticación existentes (sin arquitectura paralela)')
  const codigo = (ruta + api + cliente).replace(/^\s*\/\/.*$/gm, '')
  verificar(!/anthropic|motorTexto|generateText|streamText|openai|\/api\/chat/i.test(codigo), '4b. Cero IA')
  verificar(!/from '[^']*(archivosVersion|herramientas|registroArchivos|SERVICE_ROLE)/.test(leer('components/Planeacion/DocumentoVersion.tsx') + leer('lib/asistente/recuperacionArchivo.ts')), '4c. El cliente no importa módulos del servidor')
  verificar(!/\.(insert|update|upsert|delete)\(/.test(codigo), '4d. Nada escribe en versiones, hojas ni resultados (la única escritura es el ligado canónico de la etapa 4)')

  console.log(`\n${total - fallos}/${total} pruebas pasaron.`)
  if (fallos) process.exit(1)
}
main().catch((e) => { console.error(e); process.exit(1) })
