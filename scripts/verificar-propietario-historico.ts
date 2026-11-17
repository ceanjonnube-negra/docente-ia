// scripts/verificar-propietario-historico.ts
//
// Etapa 2 del aislamiento por docente: una copia local anterior (sin
// docenteId) solo vuelve a ser visible para el docente con sesión si hay
// evidencia explícita de que es suya —su vínculo remoto, sus marcadores,
// mensajes de la copia en su estado de sincronización o, sin evidencia
// local, su conversación remota verificada con RLS— y de ningún otro. Sin
// evidencia, con evidencia de otro docente o contradictoria, la copia
// queda intacta y aislada. Asignar no cambia mensajes, cola ni marcadores.
//
// Se ejecuta con `npx tsx scripts/verificar-propietario-historico.ts`.

// Módulo (no script global): sus nombres no chocan con otros scripts.
export {}

const PATRON_DOCUMENTO = /^\s*(📋|📊|📝|📨|📄|📖)\s*[A-ZÀ-Ý]/
function esEventoDocumental(f: Record<string, unknown>): boolean {
  const k = (f.contenido ?? {}) as Record<string, unknown>
  if (f.rol === 'usuario') return k.documentoDestinoId != null
  return PATRON_DOCUMENTO.test(String(f.texto)) || (k.contenidoDocumento != null && (k.archivo != null || k.archivos != null)) || k.restauraVersion != null
}

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  console.log(`${condicion ? '✓' : '✗'} ${mensaje}`)
  if (!condicion) fallos++
}

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://supabase.invalid'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'clave-ficticia'
const DISPOSITIVO_A = new Map<string, string>()
let almacen = DISPOSITIVO_A
const g = globalThis as unknown as Record<string, unknown>
// Oyentes reales de la página: document (visibilitychange) y window (pageshow).
const oyentes: Record<string, ((e: unknown) => void)[]> = {}
const escuchar = (tipo: string, f: (e: unknown) => void) => { (oyentes[tipo] ??= []).push(f) }
g.window = { localStorage: { getItem: (k: string) => almacen.get(k) ?? null, setItem: (k: string, v: string) => { almacen.set(k, v) }, removeItem: (k: string) => { almacen.delete(k) }, get length() { return almacen.size }, key: (i: number) => [...almacen.keys()][i] ?? null }, addEventListener: escuchar, removeEventListener() {} }
g.localStorage = (g.window as { localStorage: unknown }).localStorage
const documento = { hidden: false, addEventListener: escuchar }
g.document = documento

type Fila = Record<string, unknown>
type Mensaje = { id: string; rol: 'usuario' | 'asistente'; texto: string; creadoEn: number; [k: string]: unknown }
const DOCENTE_A = '11111111-1111-4111-8111-111111111111'
const esperar = (ms = 50) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const { supabase } = await import('../lib/supabaseClient')
  const p = await import('../lib/asistente/persistencia')

  // ---- Doble de Supabase con RLS por docente ----
  let sesion: string | null = DOCENTE_A
  const tablas: Record<string, Fila[]> = { conversaciones_chat: [], mensajes_chat: [] }
  const escrituras: { tabla: string; op: string; ids?: string[] }[] = []
  const lecturas: { tabla: string; columnas: string; ids?: string[] }[] = []
  const fallarPorId = false
  const fallarIndice = false
  const alLeer: ((tabla: string, columnas: string) => void) | null = null
  let retrasoLecturas = 0
  const fallarLecturas = false
  class Consulta {
    private filtros: ((f: Fila) => boolean)[] = [(f) => f.docente_id === sesion]
    private op = 'select'
    private datos: unknown = null
    private columnas = ''
    private unica = false
    private orden: { c: string; asc: boolean } | null = null
    private tope = Infinity
    private porId = false
    private idsPedidos: string[] = []
    private opciones: { ignoreDuplicates?: boolean } = {}
    constructor(private tabla: string) {}
    select(c = '') { if (this.op === 'select') this.columnas = c; return this }
    maybeSingle() { this.unica = true; return this }
    order(c: string, o: { ascending: boolean }) { this.orden = { c, asc: o.ascending }; return this }
    limit(n: number) { this.tope = n; return this }
    in(c: string, v: unknown[]) { this.porId = true; this.idsPedidos = v as string[]; this.filtros.push((f) => v.includes(f[c])); return this }
    eq(c: string, v: unknown) { this.filtros.push((f) => f[c] === v); return this }
    // Índice documental (P3b): misma semántica que el filtro de PostgREST
    // (verificada contra Supabase E2E con GET reales).
    or(expr: string) { if (!expr.includes('texto.match')) throw new Error('filtro desconocido'); this.filtros.push(esEventoDocumental); return this }
    gt(c: string, v: string) { this.filtros.push((f) => String(f[c]) > v); return this }
    is(c: string, v: null) { this.filtros.push((f) => f[c] === v || f[c] === undefined); return this }
    not(c: string) { this.filtros.push((f) => f[c] != null); return this }
    lt(c: string, v: string) { this.filtros.push((f) => Date.parse(String(f[c])) < Date.parse(v)); return this }
    update(c: Fila) { this.op = 'update'; this.datos = c; return this }
    insert(d: Fila) { this.op = 'insert'; this.datos = d; return this }
    upsert(d: Fila[], o: { ignoreDuplicates?: boolean }) { this.op = 'upsert'; this.datos = d; this.opciones = o ?? {}; return this }
    then(ok: (r: unknown) => unknown, ko?: (e: unknown) => unknown) {
      const retraso = this.op === 'select' ? retrasoLecturas : 0
      return new Promise((r) => setTimeout(r, retraso)).then(() => this.ejecutar()).then(ok, ko)
    }
    private ejecutar() {
      const filas = tablas[this.tabla]
      const coinciden = () => filas.filter((f) => this.filtros.every((x) => x(f)))
      if (this.op === 'select') {
        lecturas.push({ tabla: this.tabla, columnas: this.columnas, ids: this.idsPedidos })
        if (fallarPorId && this.porId && this.tabla === 'mensajes_chat') return { data: null, error: { message: 'fallo simulado de red' } }
        if (fallarLecturas) return { data: null, error: { message: 'fallo simulado de red' } }
        if (fallarIndice && this.columnas.includes('raiz:')) return { data: null, error: { message: 'fallo simulado del índice' } }
        let datos = coinciden().map((f) => JSON.parse(JSON.stringify(f))) as Fila[]
        if (this.orden) { const { c, asc } = this.orden; datos.sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : 1) * (asc ? 1 : -1)) }
        datos = datos.slice(0, this.tope)
        if (this.columnas.includes('raiz:')) {
          const k = (f: Fila) => (f.contenido ?? {}) as Record<string, unknown>
          datos = datos.map((f) => ({ id: f.id, rol: f.rol, creado_en: f.creado_en, raiz: k(f).documentoRaizId ?? null, restaura: k(f).restauraVersion ?? null, destino: k(f).documentoDestinoId ?? null }))
        }
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
  // Eventos de sesión controlados por la prueba (el listener del servicio se captura al importarlo).
  let oyenteAuth: ((evento: string, session: unknown) => void) | null = null
  ;(s.auth as Record<string, unknown>).onAuthStateChange = (cb: (evento: string, session: unknown) => void) => { oyenteAuth = cb; return { data: { subscription: { unsubscribe() {} } } } }
  const evento = (nombre: string, docente: string | null) => { sesion = docente; oyenteAuth?.(nombre, docente ? { user: { id: docente } } : null) }
  s.rpc = async () => ({ data: null, error: null })
  s.from = (tabla: string) => new Consulta(tabla)

  const DOCENTE_B = '22222222-2222-4222-8222-222222222222'
  const crudo = (k: string) => almacen.get(k) ?? null
  const DOC = '📨 CITATORIO A PADRES\n\nCLAVE CITATORIO 2026. 11:00 horas.'
  // Copia anterior al aislamiento (sin docenteId), sembrada tal como quedó en un dispositivo.
  const sembrar = (id: string, mensajes: Mensaje[], titulo = 'CITATORIO') => {
    almacen.set(`docente-ia:conversacion:${id}`, JSON.stringify({ version: 2, titulo, mensajes, documentoActivo: null, actualizadaEn: 1 }))
    almacen.set('docente-ia:conversaciones', JSON.stringify([...JSON.parse(crudo('docente-ia:conversaciones') ?? '[]'), { id, titulo, actualizadaEn: 1 }]))
    return crudo(`docente-ia:conversacion:${id}`)
  }
  type Estado = { desde: number; pendientes: { localId: string; fila: unknown; huella: string }[]; huellas: Record<string, string>; soloInsercion?: Record<string, true> }
  const estadoDe = (d: string): Estado => JSON.parse(crudo(`docente-ia:mensajes-remotos:${d}`) ?? 'null') ?? { desde: 1, pendientes: [], huellas: {}, soloInsercion: {} }
  const guardarEstado = (d: string, e: unknown) => almacen.set(`docente-ia:mensajes-remotos:${d}`, JSON.stringify(e))
  const sinCambiosSalvoPropietario = (id: string, antes: string | null) => { const a = JSON.parse(antes ?? '{}'); const b = JSON.parse(crudo(`docente-ia:conversacion:${id}`) ?? '{}'); delete b.docenteId; return JSON.stringify(a) === JSON.stringify(b) }
  const motivo = (r: { aisladas: { id: string; motivo: string }[] }, id: string) => r.aisladas.find((x) => x.id === id)?.motivo
  almacen = DISPOSITIVO_A

  // ---- 1. CITATORIO con evidencia local (huellas y solo inserción de A) ----
  const cit: Mensaje[] = [{ id: 'msg-cit-1', rol: 'usuario', texto: 'Genera un citatorio', creadoEn: 1000 }, { id: 'msg-cit-2', rol: 'asistente', texto: DOC, creadoEn: 1001 }]
  const citAntes = sembrar('conv-citatorio', cit)
  const remCit = await p.idRemotoDe(DOCENTE_A, 'conv-citatorio')
  guardarEstado(DOCENTE_A, { desde: 1, pendientes: [], huellas: { [`${remCit}:msg-cit-1`]: 'h1', [`${remCit}:msg-cit-2`]: 'h2' }, soloInsercion: { [`${remCit}:msg-cit-2`]: true } })
  const estadoAAntes = crudo(`docente-ia:mensajes-remotos:${DOCENTE_A}`)
  p.establecerPropietarioLocal(DOCENTE_A)
  const r1 = await p.resolverPropietariosLocales(DOCENTE_A)
  verificar(r1.asignadas.includes('conv-citatorio') && p.listarConversaciones().some((c) => c.id === 'conv-citatorio') && p.cargarConversacionPorId('conv-citatorio')?.mensajes.length === 2 && sinCambiosSalvoPropietario('conv-citatorio', citAntes) && crudo(`docente-ia:mensajes-remotos:${DOCENTE_A}`) === estadoAAntes,
    '1a. CITATORIO con huellas de A: se asigna a A; mensajes, huellas y solo inserción intactos')
  const remDesc = '77777777-7777-4777-8777-777777777777'
  sembrar(remDesc, [{ id: 'msg-d', rol: 'usuario', texto: 'Descargada', creadoEn: 2000 }], 'Descargada')
  almacen.set('docente-ia:vinculos-remotos', JSON.stringify({ [remDesc]: { docenteId: DOCENTE_A, remotoId: remDesc } }))
  sembrar('conv-migrada', [{ id: 'msg-mg', rol: 'usuario', texto: 'Migrada', creadoEn: 3000 }], 'Migrada')
  almacen.set(`docente-ia:migracion-historial:${DOCENTE_A}`, JSON.stringify({ 'conv-migrada': 'migrada' }))
  const r1b = await p.resolverPropietariosLocales(DOCENTE_A)
  verificar(r1b.asignadas.includes(remDesc) && r1b.asignadas.includes('conv-migrada'), '1b. Vínculo remoto de A y marcador de migración de A: se asignan')

  // ---- 2. Sin evidencia local: verificación con RLS ----
  const remRls = await p.idRemotoDe(DOCENTE_A, 'conv-rls')
  tablas.conversaciones_chat.push({ id: remRls, docente_id: DOCENTE_A, titulo: 'Histórica', documento_activo: null, actualizado_en: new Date().toISOString(), eliminada_en: null })
  const rlsAntes = sembrar('conv-rls', [{ id: 'msg-r', rol: 'usuario', texto: 'Histórica', creadoEn: 4000 }], 'Histórica')
  const remBorrada = await p.idRemotoDe(DOCENTE_A, 'conv-borrada')
  tablas.conversaciones_chat.push({ id: remBorrada, docente_id: DOCENTE_A, titulo: 'Borrada', documento_activo: null, actualizado_en: new Date().toISOString(), eliminada_en: new Date().toISOString() })
  const borradaAntes = sembrar('conv-borrada', [{ id: 'msg-b', rol: 'usuario', texto: 'Borrada', creadoEn: 4100 }], 'Borrada')
  lecturas.length = 0
  const r2 = await p.resolverPropietariosLocales(DOCENTE_A)
  verificar(r2.asignadas.includes('conv-rls') && sinCambiosSalvoPropietario('conv-rls', rlsAntes) && lecturas.filter((l) => l.tabla === 'conversaciones_chat').length === 1, '2a. Sin evidencia local: la conversación remota de A existe y RLS la devuelve → se asigna (una sola consulta)')
  verificar(motivo(r2, 'conv-borrada') === 'eliminada' && crudo('docente-ia:conversacion:conv-borrada') === borradaAntes && !p.listarConversaciones().some((c) => c.id === 'conv-borrada'), '2b. Conversación remota eliminada: queda aislada e intacta (no se reactiva)')

  // ---- 3. Sin evidencia suficiente ----
  const sinAntes = sembrar('conv-sin-evidencia', [{ id: 'msg-s', rol: 'usuario', texto: 'De nadie', creadoEn: 5000 }], 'Sin evidencia')
  const remDeB = await p.idRemotoDe(DOCENTE_A, 'conv-fila-de-b')
  tablas.conversaciones_chat.push({ id: remDeB, docente_id: DOCENTE_B, titulo: 'De B', documento_activo: null, actualizado_en: new Date().toISOString(), eliminada_en: null })
  sembrar('conv-fila-de-b', [{ id: 'msg-fb', rol: 'usuario', texto: 'x', creadoEn: 5100 }], 'Fila de B')
  const r3 = await p.resolverPropietariosLocales(DOCENTE_A)
  verificar(motivo(r3, 'conv-sin-evidencia') === 'sin_evidencia' && motivo(r3, 'conv-fila-de-b') === 'sin_evidencia' && crudo('docente-ia:conversacion:conv-sin-evidencia') === sinAntes && !p.listarConversaciones().some((c) => c.id === 'conv-sin-evidencia'),
    '3a. Sin evidencia local ni conversación remota de A (aunque A sea la única cuenta conocida): queda aislada e intacta')

  // ---- 4. Evidencias contradictorias y de otro docente ----
  const contraAntes = sembrar('conv-contradictoria', [{ id: 'msg-c', rol: 'usuario', texto: 'Compartida', creadoEn: 6000 }], 'Contradictoria')
  const remCA = await p.idRemotoDe(DOCENTE_A, 'conv-contradictoria')
  const remCB = await p.idRemotoDe(DOCENTE_B, 'conv-contradictoria')
  const eA = estadoDe(DOCENTE_A); eA.huellas[`${remCA}:msg-c`] = 'x'; guardarEstado(DOCENTE_A, eA)
  guardarEstado(DOCENTE_B, { desde: 1, pendientes: [], huellas: { [`${remCB}:msg-c`]: 'y' } })
  sembrar('conv-de-otro', [{ id: 'msg-o', rol: 'usuario', texto: 'De B', creadoEn: 6100 }], 'De B')
  almacen.set(`docente-ia:migracion-historial:${DOCENTE_B}`, JSON.stringify({ 'conv-de-otro': 'migrada' }))
  const r4 = await p.resolverPropietariosLocales(DOCENTE_A)
  verificar(motivo(r4, 'conv-contradictoria') === 'contradictoria' && motivo(r4, 'conv-de-otro') === 'de_otro_docente' && crudo('docente-ia:conversacion:conv-contradictoria') === contraAntes && !p.listarConversaciones().some((c) => ['conv-contradictoria', 'conv-de-otro'].includes(c.id)),
    '4a. Evidencia de A y de B: aislada; evidencia solo de B: A no la recibe; ambas intactas')
  p.establecerPropietarioLocal(DOCENTE_B)
  const r4b = await p.resolverPropietariosLocales(DOCENTE_B)
  verificar(r4b.asignadas.includes('conv-de-otro') && !r4b.asignadas.includes('conv-contradictoria') && p.listarConversaciones().every((c) => c.id === 'conv-de-otro'), '4b. Con la sesión de B: recibe solo la suya; la contradictoria sigue aislada')
  p.establecerPropietarioLocal(DOCENTE_A)

  // ---- 5. Cambio de cuenta durante la verificación ----
  const remCarrera = await p.idRemotoDe(DOCENTE_A, 'conv-carrera')
  tablas.conversaciones_chat.push({ id: remCarrera, docente_id: DOCENTE_A, titulo: 'Carrera', documento_activo: null, actualizado_en: new Date().toISOString(), eliminada_en: null })
  const carreraAntes = sembrar('conv-carrera', [{ id: 'msg-k', rol: 'usuario', texto: 'Carrera', creadoEn: 7000 }], 'Carrera')
  retrasoLecturas = 150
  const enVuelo = p.resolverPropietariosLocales(DOCENTE_A)
  await esperar(20)
  p.establecerPropietarioLocal(DOCENTE_B)
  const r5 = await enVuelo
  retrasoLecturas = 0
  verificar(!r5.asignadas.includes('conv-carrera') && crudo('docente-ia:conversacion:conv-carrera') === carreraAntes, '5a. La sesión cambia durante la verificación con RLS: no se asigna nada')
  p.establecerPropietarioLocal(DOCENTE_A)
  verificar((await p.resolverPropietariosLocales(DOCENTE_A)).asignadas.includes('conv-carrera'), '5b. Con la sesión de A de nuevo, se asigna en la siguiente resolución')

  // ---- 6. Cola pendiente y duplicados ----
  const pend: Mensaje[] = [{ id: 'msg-p1', rol: 'usuario', texto: 'Sin enviar todavía', creadoEn: 8000 }]
  const pendAntes = sembrar('conv-pendiente', pend, 'Pendiente')
  const remPend = await p.idRemotoDe(DOCENTE_A, 'conv-pendiente')
  const e6 = estadoDe(DOCENTE_A); e6.pendientes.push({ localId: 'conv-pendiente', fila: p.mensajeAFilaRemota(remPend, DOCENTE_A, pend[0] as never), huella: 'h' }); guardarEstado(DOCENTE_A, e6)
  const colaAntes = crudo(`docente-ia:mensajes-remotos:${DOCENTE_A}`)
  const r6 = await p.resolverPropietariosLocales(DOCENTE_A)
  verificar(r6.asignadas.includes('conv-pendiente') && sinCambiosSalvoPropietario('conv-pendiente', pendAntes) && crudo(`docente-ia:mensajes-remotos:${DOCENTE_A}`) === colaAntes && (JSON.parse(colaAntes ?? '{}') as Estado).pendientes.some((x) => x.localId === 'conv-pendiente'),
    '6a. Mensaje pendiente en la cola de A: se asigna; la cola y el mensaje pendiente siguen intactos')
  const dupAntes = sembrar('conv-duplicada', [{ id: 'msg-dup', rol: 'usuario', texto: 'Duplicada', creadoEn: 8100 }], 'Duplicada')
  almacen.set('docente-ia:vinculos-remotos', JSON.stringify({ ...JSON.parse(crudo('docente-ia:vinculos-remotos') ?? '{}'), 'conv-duplicada': { docenteId: DOCENTE_A, remotoId: remDesc } }))
  const r6b = await p.resolverPropietariosLocales(DOCENTE_A)
  verificar(motivo(r6b, 'conv-duplicada') === 'duplicada' && crudo('docente-ia:conversacion:conv-duplicada') === dupAntes && p.listarConversaciones().filter((c) => c.id === remDesc || c.id === 'conv-duplicada').length === 1, '6b. Una segunda copia de la misma conversación remota: aislada, sin duplicar')

  // ---- 7. Integración: al confirmar la sesión, la lista recupera lo propio ----
  p.establecerPropietarioLocal(null)
  const { AsistenteService } = await import('../lib/asistente/AsistenteService')
  const chat = AsistenteService as unknown as { listaConversaciones: { id: string }[] }
  sembrar('conv-servicio', [{ id: 'msg-sv', rol: 'usuario', texto: 'Desde el servicio', creadoEn: 9000 }], 'Servicio')
  almacen.set(`docente-ia:migracion-historial:${DOCENTE_A}`, JSON.stringify({ 'conv-migrada': 'migrada', 'conv-servicio': 'migrada' }))
  evento('SIGNED_IN', DOCENTE_A)
  await esperar(300)
  const ids = chat.listaConversaciones.map((c) => c.id)
  verificar(ids.includes('conv-servicio') && ids.includes('conv-citatorio') && !ids.includes('conv-sin-evidencia') && !ids.includes('conv-contradictoria') && !ids.includes('conv-de-otro'), '7a. Al confirmar la sesión de A, la lista muestra lo suyo (también lo recién resuelto) y nada aislado ni de B')
  const totalCopias = [...almacen.keys()].filter((k) => k.startsWith('docente-ia:conversacion:')).length
  verificar(totalCopias === 13, `7b. Ninguna copia local se borró (${totalCopias} de 13 sembradas)`)

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
