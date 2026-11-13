// scripts/verificar-sincronizacion-apertura.ts
//
// Sincronización al abrir una conversación con copia local (fase 2):
// AsistenteService.abrirConversacion muestra la copia local al instante
// y después incorpora los mensajes escritos en otro dispositivo
// (sincronizarConversacionRemota + combinarMensajes). Copia
// desactualizada, sin novedades, cambio de conversación durante la
// consulta, mensajes locales creados mientras tanto, respuesta en
// curso, conversación eliminada, integridad de documentos y archivos,
// sin duplicados ni escrituras remotas.
//
// Dos "dispositivos" = dos localStorage distintos con la misma cuenta.
// Sin red, sin credenciales, sin IA (Supabase se sustituye por un doble
// en memoria con RLS por docente). Se ejecuta con
// `npx tsx scripts/verificar-sincronizacion-apertura.ts`.

// Módulo (no script global): sus nombres no chocan con otros scripts.
export {}

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  console.log(`${condicion ? '✓' : '✗'} ${mensaje}`)
  if (!condicion) fallos++
}

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://supabase.invalid'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'clave-ficticia'
const DISPOSITIVO_A = new Map<string, string>()
const DISPOSITIVO_B = new Map<string, string>()
let almacen = DISPOSITIVO_A
const g = globalThis as unknown as Record<string, unknown>
g.window = { localStorage: { getItem: (k: string) => almacen.get(k) ?? null, setItem: (k: string, v: string) => { almacen.set(k, v) }, removeItem: (k: string) => { almacen.delete(k) } }, addEventListener() {}, removeEventListener() {} }
g.localStorage = (g.window as { localStorage: unknown }).localStorage

type Fila = Record<string, unknown>
type Mensaje = { id: string; rol: 'usuario' | 'asistente'; texto: string; creadoEn: number; [k: string]: unknown }
const DOCENTE_A = '11111111-1111-4111-8111-111111111111'
const esperar = () => new Promise((r) => setTimeout(r, 50))

async function main() {
  const { supabase } = await import('../lib/supabaseClient')
  const p = await import('../lib/asistente/persistencia')

  // ---- Doble de Supabase con RLS por docente ----
  const sesion: string | null = DOCENTE_A
  const tablas: Record<string, Fila[]> = { conversaciones_chat: [], mensajes_chat: [] }
  const escrituras: { tabla: string; op: string; ids?: string[] }[] = []
  const lecturas: { tabla: string; columnas: string }[] = []
  // Se ejecuta dentro de una lectura (lo que pasa mientras la consulta
  // está en curso).
  let alLeer: ((tabla: string, columnas: string) => void) | null = null
  class Consulta {
    private filtros: ((f: Fila) => boolean)[] = [(f) => f.docente_id === sesion]
    private op = 'select'
    private datos: unknown = null
    private columnas = ''
    private unica = false
    private orden: { c: string; asc: boolean } | null = null
    private tope = Infinity
    private opciones: { ignoreDuplicates?: boolean } = {}
    constructor(private tabla: string) {}
    select(c = '') { if (this.op === 'select') this.columnas = c; return this }
    maybeSingle() { this.unica = true; return this }
    order(c: string, o: { ascending: boolean }) { this.orden = { c, asc: o.ascending }; return this }
    limit(n: number) { this.tope = n; return this }
    in(c: string, v: unknown[]) { this.filtros.push((f) => v.includes(f[c])); return this }
    eq(c: string, v: unknown) { this.filtros.push((f) => f[c] === v); return this }
    gt(c: string, v: string) { this.filtros.push((f) => String(f[c]) > v); return this }
    is(c: string, v: null) { this.filtros.push((f) => f[c] === v || f[c] === undefined); return this }
    not(c: string) { this.filtros.push((f) => f[c] != null); return this }
    lt(c: string, v: string) { this.filtros.push((f) => Date.parse(String(f[c])) < Date.parse(v)); return this }
    update(c: Fila) { this.op = 'update'; this.datos = c; return this }
    insert(d: Fila) { this.op = 'insert'; this.datos = d; return this }
    upsert(d: Fila[], o: { ignoreDuplicates?: boolean }) { this.op = 'upsert'; this.datos = d; this.opciones = o ?? {}; return this }
    then(ok: (r: unknown) => unknown, ko?: (e: unknown) => unknown) { return Promise.resolve().then(() => this.ejecutar()).then(ok, ko) }
    private ejecutar() {
      const filas = tablas[this.tabla]
      const coinciden = () => filas.filter((f) => this.filtros.every((x) => x(f)))
      if (this.op === 'select') {
        lecturas.push({ tabla: this.tabla, columnas: this.columnas })
        let datos = coinciden().map((f) => JSON.parse(JSON.stringify(f))) as Fila[]
        if (this.columnas.includes('mensajes_chat(count)')) datos = datos.map((f) => ({ ...f, mensajes_chat: [{ count: tablas.mensajes_chat.filter((m) => m.conversacion_id === f.id).length }] }))
        if (this.orden) { const { c, asc } = this.orden; datos.sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : 1) * (asc ? 1 : -1)) }
        datos = datos.slice(0, this.tope)
        alLeer?.(this.tabla, this.columnas)
        return { data: this.unica ? (datos[0] ?? null) : datos, error: null }
      }
      if (this.op === 'update') {
        const afectadas = coinciden()
        for (const f of afectadas) Object.assign(f, this.datos as Fila)
        escrituras.push({ tabla: this.tabla, op: 'update', ids: afectadas.map((f) => String(f.id)) })
        return { data: afectadas.map((f) => ({ id: f.id })), error: null }
      }
      if (this.op === 'insert') {
        const d = this.datos as Fila
        if (filas.some((f) => f.id === d.id)) return { data: null, error: { code: '23505', message: 'duplicado' } }
        filas.push({ titulo: 'Nueva conversación', documento_activo: null, actualizado_en: new Date().toISOString(), eliminada_en: null, ...d })
        escrituras.push({ tabla: this.tabla, op: 'insert', ids: [String(d.id)] })
        return { data: null, error: null }
      }
      const ids: string[] = []
      for (const f of this.datos as Fila[]) {
        const existente = filas.find((x) => x.id === f.id)
        if (existente && this.opciones.ignoreDuplicates) continue
        if (existente) Object.assign(existente, f)
        else filas.push({ ...f })
        ids.push(String(f.id))
      }
      escrituras.push({ tabla: this.tabla, op: 'upsert', ids })
      return { data: ids.map((id) => ({ id })), error: null }
    }
  }
  const s = supabase as unknown as Record<string, unknown>
  ;(s.auth as Record<string, unknown>).getSession = async () => ({ data: { session: sesion ? { user: { id: sesion } } : null }, error: null })
  s.rpc = async () => ({ data: null, error: null })
  s.from = (tabla: string) => new Consulta(tabla)

  // Mensajes de A con fechas pasadas: lo que B escribe ahora es más reciente.
  const t = Date.now() - 100_000
  const m = (n: number, rol: Mensaje['rol'], texto: string, extra: Partial<Mensaje> = {}): Mensaje => ({ id: `msg-${t + n}-${n}-${String(n).padStart(8, 'a')}`, rol, texto, creadoEn: t + n, ...extra })
  // Mensaje escrito en A y ya guardado en Supabase.
  const desdeA = (conv: string, ...mensajes: Mensaje[]) => { for (const x of mensajes) tablas.mensajes_chat.push(p.mensajeAFilaRemota(conv, DOCENTE_A, x as never) as unknown as Fila) }
  const sinEscrituras = () => escrituras.length === 0
  const lecturasDeIds = () => lecturas.filter((l) => l.columnas === 'id, creado_en').length

  // ---- Preparación: A crea X; B la descarga con el chat (etapa 3A) ----
  almacen = DISPOSITIVO_A
  const iniciales = [m(0, 'usuario', 'Hola'), m(1, 'asistente', 'Respuesta inicial')]
  p.guardarConversacion('conv-a', iniciales as never, null)
  await p.asegurarConversacionRemota('conv-a', DOCENTE_A)
  const X = await p.idRemotoDe(DOCENTE_A, 'conv-a')
  desdeA(X, ...iniciales)

  almacen = DISPOSITIVO_B
  await p.guardarMensajesRemotos('conv-otra', DOCENTE_A, []) // línea base de la etapa 1 en B
  const { AsistenteService } = await import('../lib/asistente/AsistenteService')
  type Doc = { id: string; texto: string; archivosGenerados?: Record<string, { url: string }> } | null
  const chat = AsistenteService as unknown as {
    conversacionActivaId: string | null; mensajes: Mensaje[]; documentoActivo: Doc; generando: boolean; listaConversaciones: { id: string }[]
    abrirConversacion(id: string): void; refrescarConversacionesRemotas(d: string, f?: boolean): Promise<void>; manejarEventoMotor(e: unknown): void; guardarInmediatamente(): void; notificar(): void
  }
  const idsEnPantalla = () => chat.mensajes.map((x) => x.id)
  const sinDuplicados = () => new Set(idsEnPantalla()).size === chat.mensajes.length
  p.guardarConversacion('conv-otra', [m(-50, 'usuario', 'Otra conversación de B')] as never, null)
  await chat.refrescarConversacionesRemotas(DOCENTE_A, true)
  lecturas.length = 0
  chat.abrirConversacion(X)
  await esperar()
  verificar(chat.conversacionActivaId === X && chat.mensajes.length === 2 && lecturasDeIds() === 0, '0a. Descarga 3A desde el chat: sin una sincronización extra inmediata')

  chat.abrirConversacion('conv-otra')
  await esperar()
  // Documento activo con archivos ya generados en B (caché que no debe perderse).
  const DOC_B = '📨 AVISO INICIAL\n\nTexto ficticio sin datos de alumnos.'
  const docLocal = m(2, 'asistente', DOC_B)
  p.guardarConversacion(X, [...p.cargarConversacionPorId(X)!.mensajes, docLocal] as never, { id: docLocal.id, texto: DOC_B, archivosGenerados: { pdf: { tipo: 'pdf', nombre: 'AVISO.pdf', url: 'https://proyecto.supabase.co/storage/v1/object/sign/documentos-generados-ia/d/AVISO.pdf?token=f' } } } as never)
  desdeA(X, docLocal)
  const estado = JSON.parse(almacen.get(`docente-ia:mensajes-remotos:${DOCENTE_A}`)!)
  estado.huellas[`${X}:${docLocal.id}`] = 'enviado'
  almacen.set(`docente-ia:mensajes-remotos:${DOCENTE_A}`, JSON.stringify(estado))

  // ---- 1. Copia local desactualizada ----
  const nuevoUsuario = m(10, 'usuario', 'Pregunta desde A')
  const nuevaRespuesta = m(11, 'asistente', 'Respuesta desde A')
  desdeA(X, nuevoUsuario, nuevaRespuesta)
  escrituras.length = 0
  chat.abrirConversacion(X)
  verificar(chat.conversacionActivaId === X && chat.mensajes.length === 3, '1a. La copia local se muestra al instante')
  await esperar()
  verificar(JSON.stringify(idsEnPantalla().slice(-2)) === JSON.stringify([nuevoUsuario.id, nuevaRespuesta.id]) && chat.mensajes.length === 5 && sinDuplicados(), '1b. Después aparecen los mensajes de A, en orden y sin duplicados')
  verificar(chat.documentoActivo?.id === docLocal.id && chat.documentoActivo?.archivosGenerados?.pdf?.url.includes('AVISO.pdf') === true, '1c. Sin documento nuevo: el documento activo y sus archivos generados se conservan')
  chat.guardarInmediatamente()
  await esperar()
  verificar(p.cargarConversacionPorId(X)!.mensajes.length === 5 && sinEscrituras(), '1d. Se guarda en el navegador y no se escribe nada en Supabase')

  // ---- 2. Sin novedades ----
  chat.abrirConversacion('conv-otra')
  await esperar()
  lecturas.length = 0
  const antes2 = JSON.stringify(p.cargarConversacionPorId(X)!.mensajes)
  chat.abrirConversacion(X)
  await esperar()
  verificar(chat.mensajes.length === 5 && sinDuplicados() && lecturas.every((l) => !l.columnas.includes('texto')), '2a. Sin novedades: nada cambia y solo hay lecturas ligeras')
  verificar(JSON.stringify(chat.mensajes) === antes2 && sinEscrituras(), '2b. Los mensajes en pantalla no cambian y no hay escrituras remotas')
  lecturas.length = 0
  chat.abrirConversacion(X)
  await esperar()
  verificar(lecturas.length === 0, '2c. Volver a tocar la conversación abierta no repite la consulta')

  // ---- 3. Cambio de conversación durante la consulta ----
  const durante3 = m(20, 'usuario', 'Desde A mientras B cambia de conversación')
  desdeA(X, durante3)
  chat.abrirConversacion('conv-otra')
  await esperar()
  alLeer = (tabla, columnas) => { if (tabla === 'mensajes_chat' && columnas.includes('texto')) { alLeer = null; chat.abrirConversacion('conv-otra') } }
  chat.abrirConversacion(X)
  await esperar()
  verificar(chat.conversacionActivaId === 'conv-otra' && chat.mensajes.length === 1 && chat.mensajes[0].texto === 'Otra conversación de B', '3a. Cambió de conversación: la pantalla no recibe mensajes de X')
  verificar(p.cargarConversacionPorId(X)!.mensajes.some((x) => x.id === durante3.id) && p.cargarConversacionPorId(X)!.mensajes.length === 6, '3b. El mensaje de A queda en la copia local de X para la próxima apertura')
  lecturas.length = 0
  chat.abrirConversacion(X)
  await esperar()
  verificar(chat.mensajes.length === 6 && sinDuplicados() && lecturas.every((l) => !l.columnas.includes('texto')), '3c. Al reabrir X ya aparece, sin volver a descargarlo')

  // ---- 4. Mensajes locales creados durante la sincronización ----
  chat.abrirConversacion('conv-otra')
  await esperar()
  const durante4 = m(30, 'asistente', 'Desde A mientras B escribe')
  desdeA(X, durante4)
  alLeer = (tabla, columnas) => { if (tabla === 'mensajes_chat' && columnas.includes('texto')) { alLeer = null; chat.manejarEventoMotor({ tipo: 'mensaje-usuario', texto: 'Escrito en B durante la consulta' }) } }
  chat.abrirConversacion(X)
  await esperar()
  const enB = chat.mensajes.find((x) => x.texto === 'Escrito en B durante la consulta')
  verificar(!!enB && chat.mensajes.some((x) => x.id === durante4.id) && chat.mensajes.length === 8 && sinDuplicados(), '4a. Lo escrito en B durante la consulta se conserva junto a lo de A')
  verificar(idsEnPantalla().indexOf(durante4.id) < idsEnPantalla().indexOf(enB!.id), '4b. Orden por fecha')
  chat.guardarInmediatamente()
  await esperar()
  verificar(p.cargarConversacionPorId(X)!.mensajes.length === 8 && escrituras.filter((e) => e.tabla === 'mensajes_chat').flatMap((e) => e.ids ?? []).every((id) => id === `${X}:${enB!.id}`), '4c. Solo el mensaje propio de B se sube; nada de lo traído se reenvía')
  escrituras.length = 0

  // ---- 5. Respuesta en curso ----
  chat.abrirConversacion('conv-otra')
  await esperar()
  const DOC_A = '📨 AVISO DESDE A\n\nTexto ficticio sin datos de alumnos.'
  const URL_FIRMADA = 'https://proyecto.supabase.co/storage/v1/object/sign/documentos-generados-ia/d/OTRO.pdf?token=firma'
  const docA = m(40, 'asistente', DOC_A, { contenidoDocumento: DOC_A, archivo: { tipo: 'pdf', nombre: 'OTRO.pdf', url: URL_FIRMADA, urlVer: URL_FIRMADA, archivoId: 'archivo-2' }, archivos: [{ tipo: 'pdf', nombre: 'OTRO.pdf', url: URL_FIRMADA }, { tipo: 'docx', nombre: 'OTRO.docx', url: '/api/planeaciones/vista-previa-documento-word?tipoDocumento=aviso&modo=descargar' }] })
  desdeA(X, docA)
  chat.abrirConversacion(X)
  chat.generando = true
  const fijado = chat.mensajes.length
  await esperar()
  verificar(chat.mensajes.length === fijado && !chat.mensajes.some((x) => x.id === docA.id), '5a. Con una respuesta en curso no se aplica nada')
  lecturas.length = 0
  chat.notificar()
  chat.notificar()
  verificar(chat.mensajes.length === fijado && lecturas.length === 0, '5b. Mientras sigue en curso no se aplica ni se vuelve a consultar')
  chat.generando = false
  chat.notificar()
  verificar(chat.mensajes.some((x) => x.id === docA.id) && sinDuplicados() && lecturas.length === 0, '5c. Al terminar la respuesta se aplica sin otra consulta')

  // ---- 6. Integridad de documentos y archivos ----
  const docEnPantalla = chat.mensajes.find((x) => x.id === docA.id) as unknown as { contenidoDocumento?: string; archivo?: { url: string; urlVer?: string; archivoId?: string }; archivos?: { url: string }[] }
  verificar(docEnPantalla.contenidoDocumento === DOC_A && docEnPantalla.archivo?.url === URL_FIRMADA && docEnPantalla.archivo?.urlVer === URL_FIRMADA && docEnPantalla.archivo?.archivoId === 'archivo-2' && docEnPantalla.archivos?.length === 2 && docEnPantalla.archivos[1].url.includes('tipoDocumento=aviso'), '6a. Documento, archivo (URL firmada, archivoId) y varios archivos intactos')
  verificar(chat.documentoActivo?.id === docA.id && chat.documentoActivo?.texto === DOC_A && Object.keys(chat.documentoActivo?.archivosGenerados ?? {}).length === 0, '6b. El documento formal nuevo pasa a ser el activo (sin heredar archivos del anterior)')
  chat.guardarInmediatamente()
  await esperar()
  verificar(p.cargarConversacionPorId(X)!.documentoActivo?.id === docA.id && sinEscrituras(), '6c. Guardado en el navegador, sin escrituras remotas')

  // ---- 9. Guardados mientras hay mensajes remotos por incorporar ----
  const enLocal = () => p.cargarConversacionPorId(X)!.mensajes.map((x) => x.id)
  const escritosDe = (ids: string[]) => escrituras.filter((e) => e.tabla === 'mensajes_chat').flatMap((e) => e.ids ?? []).filter((id) => ids.some((x) => id === `${X}:${x}`))
  const preparar = async (n: number) => {
    chat.abrirConversacion('conv-otra')
    await esperar()
    const remoto = m(n, 'usuario', `Desde A (${n})`)
    desdeA(X, remoto)
    chat.abrirConversacion(X)
    chat.generando = true
    await esperar()
    return remoto
  }
  // 9a-9b: termina durante el streaming; se guarda varias veces; la respuesta termina bien.
  const r9 = await preparar(50)
  chat.mensajes = [...chat.mensajes, { id: 'msg-streaming-9', rol: 'asistente', texto: 'Respuesta en cur', creadoEn: Date.now() }]
  chat.guardarInmediatamente()
  chat.notificar()
  chat.guardarInmediatamente()
  verificar(!chat.mensajes.some((x) => x.id === r9.id) && enLocal().includes(r9.id) && enLocal().includes('msg-streaming-9'), '9a. Guardar durante el streaming no quita de la copia local el mensaje remoto recuperado (ni el que se está generando)')
  verificar(chat.mensajes.find((x) => x.id === 'msg-streaming-9')?.texto === 'Respuesta en cur', '9b. El mensaje en streaming no se altera')
  chat.mensajes = chat.mensajes.map((x) => (x.id === 'msg-streaming-9' ? { ...x, texto: 'Respuesta en curso, completa' } : x))
  chat.generando = false
  chat.notificar()
  chat.guardarInmediatamente()
  await esperar()
  verificar(chat.mensajes.some((x) => x.id === r9.id) && sinDuplicados() && new Set(enLocal()).size === enLocal().length && enLocal().includes(r9.id), '9c. Respuesta terminada: se incorpora a la pantalla, sin duplicados en pantalla ni en la copia local')
  verificar(p.cargarConversacionPorId(X)!.mensajes.find((x) => x.id === 'msg-streaming-9')?.texto === 'Respuesta en curso, completa', '9d. La versión final de la respuesta es la que queda guardada')
  // 9e: la respuesta termina con error.
  const r9e = await preparar(60)
  chat.guardarInmediatamente()
  chat.manejarEventoMotor({ tipo: 'error', mensaje: 'Fallo simulado' })
  verificar(!chat.generando && chat.mensajes.some((x) => x.id === r9e.id) && sinDuplicados() && enLocal().includes(r9e.id), '9e. Respuesta con error: el mensaje remoto se incorpora igual y no se pierde')
  // 9f: cambia de conversación antes de aplicarlos.
  const r9f = await preparar(70)
  chat.guardarInmediatamente()
  chat.abrirConversacion('conv-otra')
  chat.generando = false
  await esperar()
  verificar(chat.conversacionActivaId === 'conv-otra' && !chat.mensajes.some((x) => x.id === r9f.id) && enLocal().includes(r9f.id), '9f. Cambio de conversación antes de aplicar: el mensaje sigue en la copia local de X')
  lecturas.length = 0
  chat.abrirConversacion(X)
  await esperar()
  verificar(chat.mensajes.some((x) => x.id === r9f.id) && sinDuplicados() && lecturas.every((l) => !l.columnas.includes('texto')), '9g. Al reabrir X aparece sin volver a descargarlo')
  chat.guardarInmediatamente()
  await esperar()
  verificar(escritosDe([r9.id, r9e.id, r9f.id]).length === 0, '9h. Ningún mensaje recuperado se escribe en Supabase')

  // ---- 10. Documento activo tras recargar con mensajes por incorporar ----
  type Interno = { sincronizacionDiferida: unknown }
  const recargar = () => {
    // Lo que queda tras recargar la página: solo la copia del navegador.
    chat.generando = false
    ;(chat as unknown as Interno).sincronizacionDiferida = null
    chat.conversacionActivaId = null
    chat.mensajes = []
    chat.documentoActivo = null
  }
  const URL_D2 = 'https://proyecto.supabase.co/storage/v1/object/sign/documentos-generados-ia/d/D2.pdf?token=firma'
  const D2 = m(80, 'asistente', '📨 AVISO D2\n\nTexto ficticio sin datos de alumnos.', { contenidoDocumento: 'D2', archivo: { tipo: 'pdf', nombre: 'D2.pdf', url: URL_D2, urlVer: URL_D2, archivoId: 'archivo-d2' }, archivos: [{ tipo: 'pdf', nombre: 'D2.pdf', url: URL_D2 }, { tipo: 'docx', nombre: 'D2.docx', url: '/api/planeaciones/vista-previa-documento-word?tipoDocumento=aviso&modo=descargar' }] })
  chat.abrirConversacion('conv-otra')
  await esperar()
  desdeA(X, D2)
  chat.abrirConversacion(X)
  const documentoAnterior = chat.documentoActivo?.id
  chat.generando = true
  await esperar()
  chat.mensajes = [...chat.mensajes, { id: 'msg-streaming-10', rol: 'asistente', texto: 'Respuesta en cur', creadoEn: Date.now() }]
  chat.guardarInmediatamente()
  verificar(documentoAnterior !== D2.id && chat.documentoActivo?.id === documentoAnterior && chat.mensajes.find((x) => x.id === 'msg-streaming-10')?.texto === 'Respuesta en cur', '10a. Durante la respuesta, la pantalla y el mensaje en curso no cambian')
  verificar(p.cargarConversacionPorId(X)!.documentoActivo?.id === D2.id, '10b. La copia local guarda como activo el documento que llegó de A')
  recargar()
  chat.abrirConversacion(X)
  await esperar()
  const d2 = chat.mensajes.find((x) => x.id === D2.id) as unknown as { archivo?: { url: string; urlVer?: string; archivoId?: string }; archivos?: { url: string }[] } | undefined
  verificar(chat.documentoActivo?.id === D2.id && chat.documentoActivo?.texto === D2.texto && chat.mensajes.some((x) => x.id === documentoAnterior), '10c. Tras recargar, el activo es el documento más reciente (no el anterior, que sigue en el historial)')
  verificar(d2?.archivo?.archivoId === 'archivo-d2' && d2?.archivo?.url === URL_D2 && d2?.archivo?.urlVer === URL_D2 && d2?.archivos?.length === 2 && d2.archivos[1].url.includes('tipoDocumento=aviso'), '10d. archivoId, URL firmada y referencias del documento se conservan')
  // Documento local más reciente (en curso o pendiente): el que llega de A, más viejo, no se elige.
  const D4 = m(90, 'asistente', '📨 AVISO D4\n\nTexto ficticio sin datos de alumnos.')
  chat.abrirConversacion('conv-otra')
  await esperar()
  desdeA(X, D4)
  chat.abrirConversacion(X)
  chat.generando = true
  await esperar()
  const D5 = { id: 'msg-streaming-d5', rol: 'asistente' as const, texto: '📨 BORRADOR EN CURSO\n\nTexto ficticio', creadoEn: Date.now() }
  chat.mensajes = [...chat.mensajes, D5]
  chat.guardarInmediatamente()
  verificar(p.cargarConversacionPorId(X)!.documentoActivo?.id === D2.id && p.cargarConversacionPorId(X)!.mensajes.some((x) => x.id === D4.id), '10e. Si el último documento es local (en curso), el que llega de A no se vuelve activo')
  chat.generando = false
  chat.notificar()
  verificar(chat.documentoActivo?.id === D2.id && chat.mensajes.find((x) => x.id === D5.id)?.texto === D5.texto && chat.mensajes.some((x) => x.id === D4.id) && sinDuplicados(), '10f. Al incorporar tampoco: el documento local en curso queda intacto')

  // ---- 7. Conversación eliminada en otro dispositivo ----
  chat.abrirConversacion('conv-otra')
  await esperar()
  escrituras.length = 0
  tablas.conversaciones_chat.find((c) => c.id === X)!.eliminada_en = new Date().toISOString()
  chat.abrirConversacion(X)
  await esperar()
  verificar(chat.conversacionActivaId === null && chat.mensajes.length === 0 && p.cargarConversacionPorId(X) === null && !chat.listaConversaciones.some((c) => c.id === X), '7a. Eliminada: se retira la copia local y la pantalla vuelve a la vista inicial (3B-1)')
  verificar(sinEscrituras(), '7b. Cero escrituras remotas')

  // ---- 8. Alcance ----
  const { readFileSync } = await import('node:fs')
  const servicio = readFileSync('lib/asistente/AsistenteService.ts', 'utf8')
  verificar((servicio.match(/this\.sincronizarConversacion\(/g) ?? []).length === 1 && /if \(sincronizar\) void this\.sincronizarConversacion\(id\)/.test(servicio), '8a. Solo abrirConversacion inicia la sincronización (no visibilitychange, online ni el envío)')

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
