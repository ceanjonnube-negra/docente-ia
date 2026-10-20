// scripts/verificar-upload-documento-privado.ts
//
// Carga privada de documentos institucionales (app/api/upload-documento).
// Sin red ni llamadas facturables, con documentos y alumnos 100% ficticios.
// Ejecuta la RUTA REAL con OpenAI simulado y un Supabase/Storage simulados
// que aplican las MISMAS reglas que los reales:
// - RLS de documentos_institucionales (select/delete: user_id = auth.uid(),
//   SIN update) y alumnos (docente_id = auth.uid());
// - RPC registrar_documento_institucional (migración 20261019010000) como
//   TRANSACCIÓN: user_id = auth.uid(), storage_path en <uid>/, documento +
//   fragmentos todo o nada, índice único (user_id, hash_archivo) → 23505;
// - Storage del bucket documentos-institucionales según la migración
//   20261019000000 (solo authenticated, primer segmento = <uid>).
// La semántica SQL REAL de la RPC (rollback, 23505, RLS, privilegios) se
// prueba aparte contra Postgres (PGlite + pgvector); aquí, el contrato de la
// ruta con ella.
// Comprueba: filtro de privacidad (registros personales con y sin roster,
// CURP, fechas de nacimiento) ANTES de cualquier IA o escritura, documentos
// normativos permitidos y sin falsos positivos, nombres en mayúsculas,
// aislamiento por docente, original intacto, MIME canónico, validación del
// contenido, registro atómico, 23505 → 409, limpieza, resultado desconocido
// sin borrar ni reintentar, plazos globales, límites de tamaño, contrato
// del RAG y logs sin datos personales.
//
// Ejecutar: npx tsx --tsconfig ./tsconfig.json scripts/verificar-upload-documento-privado.ts
// Opcional: VERIFICAR_RAIZ (raíz alternativa a verificar, p. ej. un índice exportado).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

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
const SUPABASE = 'http://supabase.prueba.local'
const DOC_A = '00000000-0000-4000-8000-0000000000aa'
const DOC_B = '00000000-0000-4000-8000-0000000000bb'
const TOKEN_A = 'token-ficticio-a'
const TOKEN_B = 'token-ficticio-b'
const ALUMNOS = [
  { docente_id: DOC_A, nombre: 'Ficticia Ejemplo Ana Sofía' },
  { docente_id: DOC_A, nombre: 'Prueba Inventado Luis Ángel' },
  { docente_id: DOC_B, nombre: 'Ajeno Externo Valentina' },
]
const CURP = 'FIEA150312MDFCJNA9'

// Reloj acelerado (solo en las pruebas de plazos): 1 ms real = 1 s simulado.
const relojReal = { now: Date.now, setTimeout: globalThis.setTimeout }
let factorReloj = 1
let origenReloj = 0
function acelerarReloj(factor: number) {
  factorReloj = factor
  origenReloj = relojReal.now()
}
Date.now = () => (factorReloj === 1 ? relojReal.now() : origenReloj + (relojReal.now() - origenReloj) * factorReloj)
globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...a: unknown[]) => relojReal.setTimeout(fn, Math.max(0, (ms ?? 0) / factorReloj), ...a)) as typeof setTimeout

type Fila = Record<string, unknown> & { id: string }
const nuevoEstado = () => ({
  docs: [] as Fila[], chunks: [] as Fila[], objetos: new Map<string, { bytes: Buffer; tipo: string | null }>(),
  embeddings: [] as string[][], chat: 0, red: [] as string[], rpc: 0, rpcCuerpos: [] as Record<string, unknown>[],
  fallar: { embeddings: false, storage: false, alumnos: false, rpcIntermedio: false, rpcRedTrasConfirmar: false },
  colgar: { embeddings: false, storage: false, rpc: false },
  retrasoRpc: 0, retrasoEmbeddingsMs: 0, barreraRpc: 0, llegadasRpc: 0,
})
let estado = nuevoEstado()
const reiniciar = () => { estado = nuevoEstado() }
const docenteDe = (h: Headers) => {
  const t = (h.get('authorization') || '').replace(/^Bearer\s+/i, '')
  return t === TOKEN_A ? DOC_A : t === TOKEN_B ? DOC_B : null
}
const json = (c: unknown, status = 200) => new Response(JSON.stringify(c), { status, headers: { 'content-type': 'application/json' } })
const eq = (u: URL, campo: string) => u.searchParams.get(campo)?.replace(/^eq\./, '')
// Una petición colgada: nunca responde, pero respeta la cancelación como fetch real.
const colgada = (signal?: AbortSignal | null) => new Promise<Response>((_, rechazar) => {
  signal?.addEventListener('abort', () => rechazar(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })), { once: true })
})
const esperar = (ms: number, signal?: AbortSignal | null) => new Promise<void>((resolver, rechazar) => {
  const t = setTimeout(resolver, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); rechazar(Object.assign(new Error('aborted'), { name: 'AbortError' })) }, { once: true })
})

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const metodo = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase()
  const h = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined))
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
  estado.red.push(`${metodo} ${url.split('?')[0]}`)
  const u = new URL(url)
  const objeto = h.get('accept')?.includes('vnd.pgrst.object')
  const quien = docenteDe(h)
  // OpenAI
  if (url.startsWith('https://api.openai.com/v1/embeddings')) {
    const cuerpo = JSON.parse(String(init?.body)) as { input: string[] | string; encoding_format?: string }
    const entradas = Array.isArray(cuerpo.input) ? cuerpo.input : [cuerpo.input]
    estado.embeddings.push(entradas)
    if (estado.colgar.embeddings) return colgada(signal)
    if (estado.retrasoEmbeddingsMs) await esperar(estado.retrasoEmbeddingsMs, signal)
    if (estado.fallar.embeddings) return json({ error: { message: 'fallo ficticio' } }, 500)
    // Igual que la API real: si el SDK pide base64, el vector viaja como
    // float32 codificado en base64. Orden de respuesta invertido a propósito.
    const vector = (index: number) => cuerpo.encoding_format === 'base64' ? Buffer.from(new Float32Array([index, 0.5, 0.1]).buffer).toString('base64') : [index, 0.5, Math.fround(0.1)]
    return json({ object: 'list', model: 'text-embedding-3-small', data: entradas.map((_, index) => ({ object: 'embedding', index, embedding: vector(index) })).reverse(), usage: { prompt_tokens: 1, total_tokens: 1 } })
  }
  if (url.startsWith('https://api.openai.com/')) { estado.chat++; return json({ error: 'no permitido' }, 500) }
  // Auth
  if (url.startsWith(`${SUPABASE}/auth/v1/user`)) return quien ? json({ id: quien, aud: 'authenticated', role: 'authenticated' }) : json({ msg: 'invalid JWT' }, 401)
  // alumnos (RLS docente_id = auth.uid())
  if (url.startsWith(`${SUPABASE}/rest/v1/alumnos`)) {
    if (estado.fallar.alumnos) return json({ code: '57014', message: 'fallo ficticio' }, 500)
    return json(ALUMNOS.filter((a) => a.docente_id === quien && (!eq(u, 'docente_id') || a.docente_id === eq(u, 'docente_id'))).map((a) => ({ nombre: a.nombre })))
  }
  // RPC registrar_documento_institucional — TRANSACCIÓN simulada (todo o nada)
  if (url.startsWith(`${SUPABASE}/rest/v1/rpc/registrar_documento_institucional`) && metodo === 'POST') {
    estado.rpc++
    const cuerpo = JSON.parse(String(init?.body)) as { p_documento: Record<string, unknown>; p_fragmentos: Record<string, unknown>[] }
    estado.rpcCuerpos.push(cuerpo)
    if (estado.colgar.rpc) return colgada(signal)
    if (estado.retrasoRpc) await esperar(estado.retrasoRpc)
    // Barrera: ninguna transacción confirma hasta que llegan todas (máx. 2 s).
    estado.llegadasRpc++
    for (let i = 0; estado.llegadasRpc < estado.barreraRpc && i < 2000; i++) await esperar(1)
    const d = cuerpo.p_documento
    if (!quien) return json({ code: '42501', message: 'sesión requerida' }, 403)
    if (!d.hash_archivo || !d.storage_path || !Array.isArray(cuerpo.p_fragmentos) || cuerpo.p_fragmentos.length === 0) return json({ code: '22023', message: 'documento incompleto' }, 400)
    if (String(d.storage_path).split('/')[0] !== quien) return json({ code: '42501', message: 'ruta fuera de la carpeta' }, 403)
    if (d.tipo == null || d.nombre_archivo == null) return json({ code: '23502', message: 'null value' }, 400)
    // Transacción: se trabaja sobre copias y se confirma solo al final.
    const docs = [...estado.docs], chunks = [...estado.chunks]
    const id = randomUUID()
    docs.push({ ...d, user_id: quien, id, estado: 'activo', version: 1, num_embeddings: cuerpo.p_fragmentos.length, created_at: new Date().toISOString() })
    for (const [i, f] of cuerpo.p_fragmentos.entries()) {
      if (estado.fallar.rpcIntermedio && i === 1) return json({ code: '22000', message: 'expected 1536 dimensions' }, 400) // rollback: nada confirmado
      if (typeof f.chunk_texto !== 'string' || !/^\[[-0-9.,e]+\]$/i.test(String(f.embedding))) return json({ code: '22P02', message: 'invalid input' }, 400)
      chunks.push({ id: randomUUID(), documento_id: id, chunk_index: f.chunk_index, chunk_texto: f.chunk_texto, embedding: f.embedding })
    }
    if (estado.docs.some((x) => x.user_id === quien && x.hash_archivo === d.hash_archivo)) return json({ code: '23505', message: 'duplicate key value violates unique constraint "documentos_institucionales_user_hash_uidx"' }, 409)
    estado.docs = docs; estado.chunks = chunks // COMMIT
    if (estado.fallar.rpcRedTrasConfirmar) throw new TypeError('fetch failed')
    return json(id)
  }
  // documentos_institucionales (solo lectura en el flujo nuevo)
  if (url.startsWith(`${SUPABASE}/rest/v1/documentos_institucionales`)) {
    if (metodo === 'GET') {
      let filas = estado.docs.filter((d) => d.user_id === quien)
      for (const [k, v] of u.searchParams) if (v.startsWith('eq.')) filas = filas.filter((d) => String(d[k]) === v.slice(3))
      if (u.searchParams.get('limit')) filas = filas.slice(0, Number(u.searchParams.get('limit')))
      return objeto ? (filas[0] ? json(filas[0]) : json({ code: 'PGRST116' }, 406)) : json(filas)
    }
    return json({ code: '42501', message: 'el flujo no debe escribir aquí directamente' }, 403)
  }
  if (url.startsWith(`${SUPABASE}/rest/v1/documento_chunks`)) return json({ code: '42501', message: 'el flujo no debe escribir aquí directamente' }, 403)
  // Storage con la política de la migración: authenticated + primer segmento = uid
  const prefijo = `${SUPABASE}/storage/v1/object/documentos-institucionales`
  if (url.startsWith(prefijo)) {
    if (metodo === 'POST' && url.startsWith(`${prefijo}/`)) {
      const ruta = decodeURIComponent(url.slice(prefijo.length + 1))
      if (estado.colgar.storage) return new Promise<Response>(() => {}) // storage-js no admite cancelación
      if (estado.fallar.storage) return json({ statusCode: '500', error: 'fallo', message: 'fallo ficticio' }, 500)
      if (!quien || ruta.split('/')[0] !== quien) return json({ statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' }, 400)
      if (estado.objetos.has(ruta)) return json({ statusCode: '409', error: 'Duplicate', message: 'The resource already exists' }, 400)
      const cuerpo = init?.body
      const bytes = cuerpo instanceof Blob ? Buffer.from(await cuerpo.arrayBuffer()) : cuerpo instanceof FormData ? Buffer.from(await (cuerpo.get('') as Blob ?? [...cuerpo.values()][1] as Blob).arrayBuffer()) : Buffer.from(cuerpo as ArrayBuffer)
      estado.objetos.set(ruta, { bytes, tipo: h.get('content-type') })
      return json({ Key: `documentos-institucionales/${ruta}`, Id: randomUUID() })
    }
    if (metodo === 'DELETE') {
      const { prefixes } = JSON.parse(String(init?.body)) as { prefixes: string[] }
      for (const p of prefixes) if (p.split('/')[0] === quien) estado.objetos.delete(p)
      return json(prefixes.map((name) => ({ name })))
    }
  }
  throw new Error('RED BLOQUEADA EN LA PRUEBA: ' + metodo + ' ' + url.split('?')[0])
}) as typeof fetch

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-prueba'
  process.env.OPENAI_API_KEY = 'sk-prueba'
  const logs: string[] = []
  const origLog = console.log, origErr = console.error
  // Con conteo: dos cargas simultáneas comparten la captura.
  let capturas = 0
  const capturar = () => { if (capturas++ === 0) { console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')) }; console.error = (...a: unknown[]) => { logs.push(a.map(String).join(' ')) } } }
  const soltar = () => { if (--capturas === 0) { console.log = origLog; console.error = origErr } }
  const ruta = await import(join(RAIZ, 'app/api/upload-documento/route.ts'))
  const proteccion = await import(join(RAIZ, 'lib/asistente/consultaEmbedding.ts'))
  const { generarWordBuffer } = await import(join(RAIZ, 'lib/documentGen/generarWordServidor.ts'))
  const { generarPdfBuffer } = await import(join(RAIZ, 'lib/documentGen/generarPdfServidor.ts'))
  const { Document, Packer, Paragraph, Table, TableRow, TableCell } = await import('docx')
  const subir = async (archivo: File, token: string | null = TOKEN_A, extra: Record<string, string> = {}) => {
    const fd = new FormData()
    fd.append('file', archivo)
    fd.append('categoria', extra.categoria ?? 'Normatividad')
    if (extra.descripcion) fd.append('descripcion', extra.descripcion)
    capturar()
    const t0 = Date.now()
    try {
      const res = await ruta.POST(new Request('http://localhost/api/upload-documento', { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body: fd }))
      return { status: res.status, datos: await res.json(), cache: res.headers.get('cache-control'), duracion: Date.now() - t0 }
    } finally { soltar() }
  }
  const archivoTexto = (nombre: string, texto: string, tipo = 'text/plain') => new File([texto], nombre, { type: tipo })
  const todoEnviado = () => estado.embeddings.flat().join('\n')
  const todoGuardado = () => [...estado.docs.map((d) => `${d.contenido_texto}\n${d.nombre_archivo}\n${d.descripcion}`), ...estado.chunks.map((c) => String(c.chunk_texto))].join('\n')
  const nadaHecho = () => estado.embeddings.length === 0 && estado.chat === 0 && estado.objetos.size === 0 && estado.docs.length === 0 && estado.rpc === 0
  const fuente = readFileSync(join(RAIZ, 'app/api/upload-documento/route.ts'), 'utf8')
  const docxTabla = async (filas: string[][]) => Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Lista ficticia'), new Table({ rows: filas.map((f) => new TableRow({ children: f.map((t) => new TableCell({ children: [new Paragraph(t)] })) })) })] }] }))
  const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

  console.log('\n— 1. Autenticación, propiedad, original y protección —')
  reiniciar()
  verificar((await subir(archivoTexto('a.txt', 'Texto ficticio'), null)).status === 401 && nadaHecho(), 'sin sesión → 401, nada procesado')
  const CIRCULAR = [
    'Circular ficticia de la dirección escolar',
    'Ana Sofía y Luis participaron en la escolta del homenaje; Luis leyó la efeméride.',
    'Dudas: direccion.ficticia@escuela.prueba o al 55 1234 5678.',
    'Reunión de padres el 05/09/2025. La evaluación formativa se reporta con calificación 8.5 como referencia.',
  ].join('\n')
  const archivoCircular = archivoTexto('Circular_Ana_Sofia.txt', CIRCULAR)
  const bytesCircular = Buffer.from(await archivoCircular.arrayBuffer())
  const rCircular = await subir(archivoCircular, TOKEN_A, { descripcion: 'Aviso para Ana Sofía y Luis' })
  const doc = estado.docs[0]
  verificar(rCircular.status === 200 && rCircular.cache === 'no-store' && estado.docs.length === 1 && doc?.user_id === DOC_A && rCircular.datos.documento_id === doc.id, `documento institucional indexado y asociado al docente autenticado (${rCircular.status})`)
  const rutaGuardada = String(doc?.storage_path)
  verificar(rutaGuardada.startsWith(`${DOC_A}/`) && rutaGuardada.endsWith('.txt') && !/ficticia|circular|ana|sofia/i.test(rutaGuardada) && estado.objetos.size === 1, 'original guardado en Storage bajo <uid>/, con ruta sin el nombre del archivo y extensión del formato validado')
  verificar(Buffer.compare(estado.objetos.get(rutaGuardada)!.bytes, bytesCircular) === 0, 'el documento ORIGINAL queda byte a byte intacto')
  const prohibidos = ['Ana', 'Sofía', 'Sofia', 'Luis', '1234 5678', 'direccion.ficticia@']
  verificar(prohibidos.every((p) => !todoEnviado().includes(p)), 'embeddings.create nunca recibe nombres sueltos del roster, teléfono ni correo')
  verificar(prohibidos.every((p) => !todoGuardado().includes(p)), 'chunk_texto, contenido_texto, nombre_archivo y descripción guardados sin esos datos')
  verificar(String(doc?.nombre_archivo) === 'Circular un alumno.txt' && doc?.descripcion === 'Aviso para un alumno y un alumno', `nombre de archivo y descripción protegidos («${doc?.nombre_archivo}»)`)
  verificar(todoGuardado().includes('calificación 8.5') && todoGuardado().includes('05/09/2025') && todoGuardado().includes('evaluación formativa'), 'contenido académico y fechas escolares se conservan')
  verificar(estado.rpc === 1 && doc?.num_embeddings === estado.chunks.length && estado.chunks.length > 0 && estado.chunks.every((c, i) => c.documento_id === doc.id && c.chunk_index === i), 'UN solo registro atómico: documento + fragmentos (documento_id, chunk_index, chunk_texto, embedding)')
  const cuerpoRpc = estado.rpcCuerpos[0] as { p_documento: Record<string, unknown> }
  verificar(!('user_id' in cuerpoRpc.p_documento) && !estado.red.some((r) => /^(POST|PATCH|DELETE) .*\/rest\/v1\/(documentos_institucionales|documento_chunks)/.test(r)), 'la ruta NO envía user_id (lo pone auth.uid() en la RPC) ni escribe tablas directamente')
  verificar(estado.red.filter((r) => r.includes('/rest/v1/alumnos')).length === 1 && !todoEnviado().includes('Valentina'), 'una sola consulta de alumnos, solo del propio docente (nunca alumnos de otro docente)')

  console.log('\n— 2. Filtro de privacidad: registros personales rechazados ANTES de IA y escrituras —')
  const LISTA_ROSTER = [
    'Lista ficticia del grupo 3A',
    `1. Ficticia Ejemplo Ana Sofía — CURP ${CURP} — nació el 12/03/2015`,
    '2. Prueba Inventado Luis Ángel — calificación 8.5 — observación: requiere apoyo en lectura',
  ].join('\n')
  const rechazos: [string, () => Promise<File>][] = [
    ['lista con alumnos del roster', async () => archivoTexto('lista.txt', LISTA_ROSTER)],
    ['lista oficial en MAYÚSCULAS, apellidos primero, del roster', async () => archivoTexto('lista.txt', 'FICTICIA EJEMPLO ANA SOFÍA\nPRUEBA INVENTADO LUIS ÁNGEL')],
    ['boleta individual de un alumno FUERA del roster', async () => archivoTexto('boleta.txt', 'BOLETA DE EVALUACIÓN\nNombre del alumno: MATEO EXTERNO AJENO\nGrado: 3  Grupo: A\nEspañol 8')],
    ['expediente fuera del roster (Alumno(a) + Padre o tutor)', async () => archivoTexto('exp.txt', 'Expediente\nAlumno(a): Carla Ajena Prueba\nPadre o tutor: Juan Ajeno López\nDomicilio: Calle Inventada 12')],
    ['ficha descriptiva individual («Nombre:»)', async () => archivoTexto('ficha.txt', 'Ficha descriptiva\nNombre: Mateo Externo Ajeno\nFortalezas: participa en clase.')],
    ['reporte de incidencia personal', async () => archivoTexto('inc.txt', 'Reporte de incidencia\nNombre del estudiante: Carla Ajena Prueba\nHechos: discusión en el recreo.')],
    ['diagnóstico individual con información identificable', async () => archivoTexto('diag.txt', 'Valoración USAER\nNombre del alumno\nMATEO EXTERNO AJENO\nDiagnóstico: TDAH; requiere ajustes razonables.')],
    ['lista nominal con calificaciones (fuera del roster)', async () => archivoTexto('calif.txt', '1 AJENA EXTERNA CARLA 8.5 9\n2 OTRO EXTERNO MATEO 7 8\n3 TERCERO DEMO JUAN 9.0')],
    ['tabla Word de fechas de nacimiento (fuera del roster)', async () => new File([new Uint8Array(await docxTabla([['Alumno', 'Fecha de nacimiento', 'Grupo'], ['AJENA EXTERNA CARLA', '12/03/2015', '3A'], ['OTRO EXTERNO MATEO', '01/02/2015', '3A']]))], 'nac.docx', { type: MIME_DOCX })],
    ['CURP en un documento', async () => archivoTexto('c.txt', `Trámite ficticio de inscripción. CURP ${CURP}.`)],
    ['fecha de nacimiento personal', async () => archivoTexto('f.txt', 'Constancia ficticia: la persona nació el 12/03/2015 en la ciudad.')],
    ['nombre completo de un alumno del roster en el NOMBRE del archivo', async () => archivoTexto('Boleta_Ficticia_Ejemplo_Ana_Sofia.txt', 'Texto normativo ficticio sin datos.')],
  ]
  for (const [nombre, crear] of rechazos) {
    reiniciar()
    const r = await subir(await crear())
    verificar(r.status === 422 && /datos personales de alumnos/.test(r.datos.error) && nadaHecho(), `${nombre} → 422 claro; 0 llamadas de IA, nada guardado ni registrado`)
  }
  reiniciar()
  const rDesc = await subir(archivoTexto('aviso.txt', 'Aviso ficticio.'), TOKEN_A, { descripcion: 'Ficha de Ficticia Ejemplo Ana Sofía' })
  verificar(rDesc.status === 422 && nadaHecho(), 'nombre completo del roster en la DESCRIPCIÓN → 422, nada procesado')

  console.log('\n— 3. Documentos normativos permitidos (sin falsos positivos) —')
  reiniciar()
  const NORMATIVO = 'REGLAMENTO ESCOLAR FICTICIO\n\nArtículo 1. Los alumnos deberán portar el uniforme durante el ciclo 2024-2025.\n\nArtículo 2. La Secretaría de Educación Pública establece el calendario escolar del 26 de agosto de 2024.'
  const docx = await generarWordBuffer(NORMATIVO, null, 'America/Mexico_City')
  const mammoth = (await import('mammoth') as unknown as { default: { extractRawText: (o: { buffer: Buffer }) => Promise<{ value: string }> } }).default
  const textoDocx = (await mammoth.extractRawText({ buffer: docx })).value
  const rDocx = await subir(new File([docx], 'Reglamento_Escolar.docx', { type: MIME_DOCX }))
  verificar(rDocx.status === 200 && estado.embeddings.flat()[0] === textoDocx.slice(0, 1000), 'DOCX normativo → el texto indexado es EXACTAMENTE el extraído (sin alteraciones)')
  reiniciar()
  const pdf = await generarPdfBuffer(NORMATIVO, null, 'America/Mexico_City')
  const rPdf = await subir(new File([pdf], 'Reglamento.pdf', { type: 'application/pdf' }))
  verificar(rPdf.status === 200 && todoEnviado().includes('uniforme') && estado.docs[0]?.nombre_archivo === 'Reglamento.pdf' && estado.docs[0]?.tipo === 'application/pdf', 'PDF normativo → indexado; nombre de archivo sin datos personales se conserva')
  const TERMINOS = [
    'Lineamientos ficticios de evaluación e inclusión',
    'Alumno: persona inscrita en un plantel de educación básica.',
    'Estudiante: Es la persona que cursa un grado escolar.',
    'Estudiante',
    'Perfil de Egreso',
    'Efeméride: Benito Juárez García 21/03/1806',
    'Tutor: El padre, la madre o quien ejerza la patria potestad.',
    'El diagnóstico, la evaluación y la calificación de cada alumno se registran conforme al Acuerdo publicado el 29/08/2019.',
    'Nombre del alumno: ______________________   Fecha de nacimiento: ____/____/______',
    'Escuela Primaria Benito Juárez, Ciudad de México.',
    'CAMPOS FORMATIVOS: LENGUAJES; SABERES Y PENSAMIENTO CIENTÍFICO',
    'Índice',
    'Marco Normativo Vigente 4',
    'Principios Pedagógicos Fundamentales 8',
    'Atentamente',
    'Mario Delgado Carrillo',
    'Secretario de Educación Pública',
  ].join('\n')
  reiniciar()
  const rTerminos = await subir(archivoTexto('lineamientos.txt', TERMINOS))
  verificar(rTerminos.status === 200 && todoEnviado().includes('29/08/2019') && todoEnviado().includes('Mario Delgado Carrillo') && todoEnviado().includes('CAMPOS FORMATIVOS') && todoEnviado().includes('21/03/1806'), 'normativo con «alumno», «estudiante», «tutor», «diagnóstico», «evaluación», «calificación», formulario en blanco, índice, encabezado + título, firma oficial, efeméride con nombre y fecha, y fecha de 2019 → indexado')
  reiniciar()
  const rTabla = await subir(new File([new Uint8Array(await docxTabla([['Campo formativo', 'Horas'], ['Lenguajes', '8'], ['Saberes y pensamiento científico', '6']]))], 'horas.docx', { type: MIME_DOCX }))
  verificar(rTabla.status === 200, 'tabla Word institucional (campos formativos y horas) → indexada')
  const un = proteccion.protegerTextoDocumento('Escuela Primaria Benito Juárez', ['Benito Juárez Ficticio Demo'])
  verificar(un.alumnosIdentificados === 0, 'un fragmento de 2 palabras que coincide con un alumno («Benito Juárez») NO basta para rechazar')

  console.log('\n— 4. Nombres en mayúsculas (E1) y Chat IA sin cambios —')
  const rosterE1 = ['Rosa Campos Demo', 'Ficticia Ejemplo Ana Sofía']
  const e1 = (t: string) => proteccion.protegerTextoDocumento(t, rosterE1).texto
  verificar(e1('ROSA un alumno asistió.') === 'un alumno un alumno asistió.' && e1('ROSA CAMPOS asistió.') === 'un alumno un alumno asistió.' && e1('ROSA FICTICIA llegó.') === 'un alumno un alumno llegó.', 'nombre identificable en MAYÚSCULAS junto a otra palabra de su nombre → protegido')
  verificar(e1('CAMPOS FORMATIVOS') === 'CAMPOS FORMATIVOS' && e1('LA PAZ Y LA ROSA DE LOS VIENTOS') === 'LA PAZ Y LA ROSA DE LOS VIENTOS' && e1('LUZ Y SONIDO') === 'LUZ Y SONIDO' && e1('la rosa y los campos') === 'la rosa y los campos', 'términos comunes en mayúsculas o minúsculas se conservan («CAMPOS FORMATIVOS», «LA ROSA DE LOS VIENTOS»)')
  verificar(e1('Rosa Campos') === 'un alumno un alumno' && e1('FICTICIA') === 'un alumno', 'nombres con mayúscula inicial y apellidos no comunes en mayúsculas siguen protegidos como antes')
  const consulta = proteccion.prepararConsultaEmbedding('¿Qué dice el reglamento sobre ROSA y CAMPOS FORMATIVOS?', [{ alumno_id: '1', nombre_completo: 'Rosa Campos Demo' }])
  verificar(consulta.enviar === true && consulta.texto === '¿Qué dice el reglamento sobre ROSA y CAMPOS FORMATIVOS?', 'la protección de consultas del Chat IA (prepararConsultaEmbedding) no cambia')

  console.log('\n— 5. Formatos, contenido validado y MIME —')
  reiniciar()
  const rSinMime = await subir(archivoTexto('reglamento.txt', NORMATIVO, ''))
  const rutaSinMime = String(estado.docs[0]?.storage_path)
  verificar(rSinMime.status === 200 && estado.docs[0]?.tipo === 'text/plain' && estado.objetos.get(rutaSinMime)?.tipo === 'text/plain', 'tipo MIME vacío (navegador móvil) → se usa el MIME del formato validado por el servidor (tipo NOT NULL y Storage)')
  reiniciar()
  const rDocxSinMime = await subir(new File([docx], 'Reglamento.docx', { type: '' }))
  verificar(rDocxSinMime.status === 200 && estado.docs[0]?.tipo === MIME_DOCX, 'DOCX sin MIME → registrado con el MIME de Word')
  reiniciar()
  const rFalsoPdf = await subir(archivoTexto('falso.pdf', 'texto que dice ser PDF', 'application/pdf'))
  const rFalsoDocx = await subir(archivoTexto('falso.docx', 'no es un zip', MIME_DOCX))
  const rBinTxt = await subir(new File([Buffer.from([0x41, 0x00, 0x42])], 'bin.txt', { type: 'text/plain' }))
  const rMimeEngañoso = await subir(new File([docx], 'x.txt', { type: 'application/pdf' }))
  verificar([rFalsoPdf, rFalsoDocx, rBinTxt, rMimeEngañoso].every((r) => r.status === 415) && nadaHecho(), 'contenido que no corresponde a su formato (PDF falso, DOCX falso, TXT binario, MIME engañoso) → 415 sin procesar')
  const imagen = new File([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], 'lista.jpg', { type: 'image/jpeg' })
  const rImagen = await subir(imagen)
  verificar(rImagen.status === 422 && /imágenes no se indexan automáticamente/.test(rImagen.datos.error) && nadaHecho(), 'imagen → 422 con mensaje claro; 0 llamadas al OCR (gpt-4o-mini), nada guardado')
  verificar(/const OCR_AUTOMATICO_HABILITADO: boolean = false/.test(fuente) && /async function extractTextFromImage\(/.test(fuente), 'la capacidad de OCR se conserva en la arquitectura, desactivada en esta fase')
  const rDoc = await subir(archivoTexto('viejo.doc', 'binario', 'application/msword'))
  const rExe = await subir(archivoTexto('x.exe', 'MZ', 'application/octet-stream'))
  const rVacio = await subir(archivoTexto('vacio.txt', ''))
  const rGrande = await subir(new File([Buffer.alloc(4 * 1024 * 1024 + 1, 97)], 'grande.txt', { type: 'text/plain' }))
  verificar(rDoc.status === 415 && rExe.status === 415 && rVacio.status === 400 && rGrande.status === 413 && nadaHecho(), 'formato .doc o binario → 415; vacío → 400; > 4 MB → 413; sin procesar nada')
  const rSinTexto = await subir(archivoTexto('espacios.txt', '   \n\n  '))
  const rPdfRoto = await subir(new File([Buffer.from('%PDF-1.4 roto')], 'roto.pdf', { type: 'application/pdf' }))
  verificar(rSinTexto.status === 422 && rPdfRoto.status === 422 && !/roto|%PDF/.test(JSON.stringify(rPdfRoto.datos)) && nadaHecho(), 'archivo sin texto o PDF dañado → 422 con mensaje fijo, sin archivos huérfanos')

  console.log('\n— 6. Lotes, límites y fallos seguros —')
  reiniciar()
  const parrafos = (n: number) => Array.from({ length: n }, (_, i) => `Párrafo ficticio ${i} sobre convivencia escolar y evaluación formativa. `.repeat(12)).join('\n')
  const rLargo = await subir(archivoTexto('largo.txt', parrafos(150)))
  const fragmentosLargo = estado.chunks.length
  verificar(rLargo.status === 200 && fragmentosLargo > 100 && fragmentosLargo <= 200 && estado.embeddings.length === Math.ceil(fragmentosLargo / 100) && estado.embeddings.every((l) => l.length <= 100), `embeddings en lotes: ${fragmentosLargo} fragmentos en ${estado.embeddings.length} llamadas (≤ 100 por llamada)`)
  verificar(estado.chunks.every((c, i) => c.chunk_index === i && c.embedding === `[${i % 100},0.5,0.100000001]`), 'cada fragmento recibe SU embedding (aunque el proveedor responda en otro orden), como texto pgvector sin pérdida de float32')
  reiniciar()
  const rEnorme = await subir(archivoTexto('enorme.txt', 'x'.repeat(200 * 850 + 2000)))
  verificar(rEnorme.status === 413 && nadaHecho(), 'más de 200 fragmentos (límite interno de esta fase) → 413 antes de llamar a embeddings')
  verificar(/const MAX_FRAGMENTOS = 200;/.test(fuente), 'límite interno documentado: MAX_FRAGMENTOS = 200 (≈ 4.2 MB de JSON en el registro)')
  for (const [nombre, falla] of [['embeddings', 'embeddings'], ['alumnos (roster)', 'alumnos']] as const) {
    reiniciar(); estado.fallar[falla] = true
    const r = await subir(archivoTexto('f.txt', NORMATIVO))
    verificar(r.status === 500 && estado.docs.length === 0 && estado.objetos.size === 0 && estado.rpc === 0 && !/fallo ficticio/.test(JSON.stringify(r.datos)), `fallo en ${nombre} → 500 con mensaje fijo y nada escrito (ni documento ni archivo)`)
  }
  reiniciar(); estado.fallar.alumnos = true
  await subir(archivoTexto('f.txt', NORMATIVO))
  verificar(estado.embeddings.length === 0, 'si no se puede obtener el roster, nada se envía a embeddings (falla segura)')
  reiniciar(); estado.fallar.storage = true
  const rStorage = await subir(archivoTexto('f.txt', NORMATIVO))
  verificar(rStorage.status === 500 && estado.docs.length === 0 && estado.rpc === 0 && !/fallo ficticio/.test(JSON.stringify(rStorage.datos)), 'fallo de Storage → 500 fijo, sin registro')

  console.log('\n— 7. Registro atómico: rollback, 23505 y resultado desconocido —')
  reiniciar(); estado.fallar.rpcIntermedio = true
  const rRollback = await subir(archivoTexto('f.txt', parrafos(10)))
  verificar(rRollback.status === 500 && estado.docs.length === 0 && estado.chunks.length === 0 && estado.objetos.size === 0 && !/1536|fallo/.test(JSON.stringify(rRollback.datos)), 'falla a mitad del registro (2.º fragmento) → transacción revertida: sin documento, sin fragmentos y archivo privado borrado')
  reiniciar()
  const mismo = () => archivoTexto('reglamento.txt', NORMATIVO)
  const r1 = await subir(mismo())
  const r2 = await subir(mismo())
  verificar(r1.status === 200 && r2.status === 409 && estado.docs.length === 1 && estado.objetos.size === 1 && estado.rpc === 1 && estado.embeddings.length === 1 && !('nombre_archivo' in (r2.datos.documento ?? {})), 'mismo archivo dos veces del mismo docente → 409 sin pagar embeddings (sin revelar el nombre), un solo documento')
  const rB = await subir(mismo(), TOKEN_B)
  verificar(rB.status === 200 && estado.docs.length === 2 && estado.docs.filter((d) => d.user_id === DOC_B).length === 1, 'el mismo archivo de OTRO docente no se trata como duplicado (aislamiento por docente)')
  // Peor caso: ambos envíos en el MISMO milisegundo (reloj congelado) y
  // ambos pasan la revisión previa antes de que alguno confirme (barrera).
  reiniciar(); estado.barreraRpc = 2
  const ahora = Date.now, congelado = Date.now()
  Date.now = () => congelado
  const [c1, c2] = await Promise.all([subir(mismo()), subir(mismo())]).finally(() => { Date.now = ahora })
  verificar([c1.status, c2.status].sort().join(',') === '200,409' && estado.rpc === 2 && estado.docs.length === 1 && estado.objetos.size === 1 && estado.chunks.every((c) => c.documento_id === estado.docs[0].id) && String(estado.docs[0].storage_path) === [...estado.objetos.keys()][0], 'doble envío CONCURRENTE (ambos pasan la revisión previa) → 23505 en el segundo: un documento, un archivo (el del perdedor se borra) y sus fragmentos')
  reiniciar(); estado.fallar.rpcRedTrasConfirmar = true
  const rDesconocido = await subir(mismo())
  verificar(rDesconocido.status === 503 && estado.rpc === 1 && estado.docs.length === 1 && estado.objetos.size === 1 && /No pudimos confirmar/.test(rDesconocido.datos.error), 'corte de red tras confirmar → 503 «no pudimos confirmar»: NO se borra el archivo ni se reintenta el registro')
  estado.fallar.rpcRedTrasConfirmar = false
  const rReintento = await subir(mismo())
  verificar(rReintento.status === 409 && estado.docs.length === 1 && estado.rpc === 1, 'volver a subirlo → 409 (el documento quedó completo), sin duplicar')

  console.log('\n— 8. Plazo global (reloj acelerado ×1000) —')
  const PRESUPUESTO = 50_000
  const plazo = async (preparar: () => void, archivo = archivoTexto('f.txt', parrafos(150))) => {
    reiniciar(); preparar(); acelerarReloj(1000)
    try { return await subir(archivo) } finally { acelerarReloj(1) }
  }
  const pEmb = await plazo(() => { estado.colgar.embeddings = true })
  verificar(pEmb.status === 503 && pEmb.duracion <= PRESUPUESTO && estado.embeddings.length <= 2 && estado.objetos.size === 0 && estado.rpc === 0 && /no se guardó nada/.test(pEmb.datos.error), `embeddings colgados → 503 en ${(pEmb.duracion / 1000).toFixed(1)} s simulados (≤ 50 s), ${estado.embeddings.length} intento(s) (máx. 1 reintento), nada escrito`)
  const pLento = await plazo(() => { estado.retrasoEmbeddingsMs = 19_000 })
  verificar(pLento.status === 503 && estado.objetos.size === 0 && estado.rpc === 0 && pLento.duracion <= PRESUPUESTO, `embeddings lentos que agotarían la reserva de escrituras → 503 antes de escribir (${(pLento.duracion / 1000).toFixed(1)} s)`)
  const pSto = await plazo(() => { estado.colgar.storage = true })
  verificar(pSto.status === 503 && pSto.duracion <= PRESUPUESTO && estado.rpc === 0 && estado.docs.length === 0, `Storage colgado → 503 en ${(pSto.duracion / 1000).toFixed(1)} s, sin registro`)
  const pRpc = await plazo(() => { estado.colgar.rpc = true })
  verificar(pRpc.status === 503 && pRpc.duracion <= PRESUPUESTO && estado.rpc === 1 && estado.objetos.size === 1 && /No pudimos confirmar/.test(pRpc.datos.error), `registro colgado → 503 en ${(pRpc.duracion / 1000).toFixed(1)} s; resultado desconocido: sin reintento y sin borrar el archivo`)
  const pDocx = await plazo(() => { estado.colgar.rpc = true }, new File([docx], 'Reglamento.docx', { type: MIME_DOCX }))
  verificar(pDocx.status === 503 && pDocx.duracion <= PRESUPUESTO, `extracción + protección + embeddings + Storage + registro + respuesta dentro del presupuesto (${(pDocx.duracion / 1000).toFixed(1)} s ≤ 50 s)`)
  verificar(/maxRetries: REINTENTOS_EMBEDDINGS/.test(fuente) && /const REINTENTOS_EMBEDDINGS = 1;/.test(fuente) && /timeout: Math\.min\(TIMEOUT_EMBEDDINGS_MS, plazo\)/.test(fuente) && /const RESERVA_ESCRITURAS_MS = PLAZO_STORAGE_MS \+ PLAZO_REGISTRO_MS \+ RESERVA_LIMPIEZA_MS;/.test(fuente) && /export const maxDuration = 60;/.test(fuente), 'SDK con 1 reintento y timeout acotado al plazo restante; reserva de escrituras y limpieza; maxDuration 60 s')

  console.log('\n— 9. Contrato, logs, migraciones y ausencia de IA adicional —')
  const chat = readFileSync(join(RAIZ, 'app/api/chat/route.ts'), 'utf8')
  verificar(/sb\.rpc\('buscar_chunks_similares', \{\n\s+query_embedding: queryEmbedding,\n\s+cantidad: 4,\n\s+p_institucion_id: institucionId,\n\s+\}\)/.test(chat) && /`Documento \(categoria: \$\{d\.categoria \|\| "General"\}\): \$\{d\.nombre_archivo\}\\n\$\{d\.chunk_texto\}`/.test(chat), 'la RPC y el formato de buscarContextoRAG no cambian (reciben chunk_texto y nombre_archivo ya protegidos)')
  verificar(!/from '@\/lib\/supabaseClient'/.test(fuente) && !/SERVICE_ROLE/.test(fuente) && /const sb = auth\.supabase/.test(fuente), 'la ruta usa SOLO el cliente autenticado del docente (sin cliente anónimo ni service_role)')
  verificar(estado.chat === 0, 'ninguna llamada a modelos de chat/visión en todo el verificador')
  verificar(logs.length > 0 && logs.every((l) => !/Ficticia|Ejemplo|Ana Sof|Luis|FIEA|ficticia@|1234 5678|Reglamento|fallo ficticio|Lista|MATEO|Carla|Mateo|12\/03\/2015|1536/.test(l)), `logs sin nombres, CURP, contacto, nombres de archivo ni mensajes crudos (${logs.length} líneas)`)
  verificar(logs.some((l) => /resultado=rechazado motivo=datos_personales alumnos:\d+,curp:\d+,fechas:\d+,campos:\d+,filas:\d+$/.test(l)), 'el rechazo por privacidad se registra solo con conteos')
  const migracion = readFileSync(join(RAIZ, 'supabase/migrations/20261019000000_politicas_storage_documentos_institucionales.sql'), 'utf8').replace(/^--.*$/gm, '')
  const politicas = [...migracion.matchAll(/create policy "([^"]+)"\s+on storage\.objects\s+for (select|insert|delete)\s+to authenticated\s+(?:using|with check) \(\s+bucket_id = 'documentos-institucionales'\s+and \(storage\.foldername\(name\)\)\[1\] = auth\.uid\(\)::text\s+\)/g)].map((m) => m[2])
  verificar(JSON.stringify(politicas) === '["select","insert","delete"]' && (migracion.match(/create policy/g) || []).length === 3 && !/storage\.buckets|update|public|anon|bucket_id in/i.test(migracion.replace(/create policy[\s\S]*?;\s*/g, (b) => b.replace(/'documentos-institucionales'/g, ''))) && (migracion.match(/drop policy if exists/g) || []).length === 3, 'migración de Storage: solo 3 políticas (select/insert/delete) de documentos-institucionales, authenticated y <uid>; idempotente')
  const registro = readFileSync(join(RAIZ, 'supabase/migrations/20261019010000_registro_atomico_documentos_institucionales.sql'), 'utf8').replace(/^--.*$/gm, '')
  verificar(/create unique index if not exists documentos_institucionales_user_hash_uidx\s+on public\.documentos_institucionales \(user_id, hash_archivo\);/.test(registro), 'migración de registro: índice único (user_id, hash_archivo), idempotente')
  verificar(/security invoker/.test(registro) && !/security definer/i.test(registro) && /set search_path = ''/.test(registro) && /v_usuario uuid := auth\.uid\(\);/.test(registro) && !/p_documento->>'user_id'/.test(registro) && /values \(\s+v_usuario,/.test(registro) && /split_part\(p_documento->>'storage_path', '\/', 1\) <> v_usuario::text/.test(registro), 'RPC SECURITY INVOKER, search_path vacío, user_id SOLO de auth.uid() y storage_path en <uid>/')
  verificar(/revoke all on function public\.registrar_documento_institucional\(jsonb, jsonb\) from public;/.test(registro) && /revoke all on function public\.registrar_documento_institucional\(jsonb, jsonb\) from anon;/.test(registro) && /grant execute on function public\.registrar_documento_institucional\(jsonb, jsonb\) to authenticated;/.test(registro) && !/alter table|create policy|drop policy|buscar_chunks_similares/i.test(registro), 'EXECUTE solo para authenticated; no altera tablas, políticas ni buscar_chunks_similares')

  console.log(fallos === 0 ? '\nTodas las pruebas pasaron.' : `\n${fallos} prueba(s) fallaron.`)
  process.exit(fallos === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('ERROR DEL VERIFICADOR:', e instanceof Error ? `${e.name}: ${e.message}` : 'desconocido')
  process.exit(1)
})
