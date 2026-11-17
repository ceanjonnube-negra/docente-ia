// scripts/verificar-orden-mensajes.ts
//
// P2c: el historial conserva el orden conversacional en cualquier
// dispositivo. La pregunta del docente recibe su id y su fecha antes que la
// respuesta; las fechas de creación no se repiten en un dispositivo; el
// orden canónico (fecha, pregunta antes que respuesta, secuencia numérica
// del id) se aplica al combinar, al descargar (antes de recortar a 80) y a
// los empates de copias locales anteriores. Los cuatro pares históricos de
// CITATORIO (E2E) se ordenan sin tocar sus registros.
//
// Se ejecuta con `npx tsx scripts/verificar-orden-mensajes.ts`.

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
g.window = { localStorage: { getItem: (k: string) => almacen.get(k) ?? null, setItem: (k: string, v: string) => { almacen.set(k, v) }, removeItem: (k: string) => { almacen.delete(k) } }, addEventListener: escuchar, removeEventListener() {} }
g.localStorage = (g.window as { localStorage: unknown }).localStorage
const documento = { hidden: false, addEventListener: escuchar }
g.document = documento

type Fila = Record<string, unknown>
type Mensaje = { id: string; rol: 'usuario' | 'asistente'; texto: string; creadoEn: number; [k: string]: unknown }
const DOCENTE_A = '11111111-1111-4111-8111-111111111111'

async function main() {
  const { supabase } = await import('../lib/supabaseClient')
  const p = await import('../lib/asistente/persistencia')

  // ---- Doble de Supabase con RLS por docente ----
  const sesion = DOCENTE_A
  const tablas: Record<string, Fila[]> = { conversaciones_chat: [], mensajes_chat: [] }
  const escrituras: { tabla: string; op: string; ids?: string[] }[] = []
  const lecturas: { tabla: string; columnas: string; ids?: string[] }[] = []
  const fallarPorId = false
  const fallarIndice = false
  const alLeer: ((tabla: string, columnas: string) => void) | null = null
  const retrasoLecturas = 0
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
  const sesionVigente = true
  ;(s.auth as Record<string, unknown>).getSession = async () => ({ data: { session: sesionVigente ? { user: { id: sesion } } : null }, error: null })
  s.rpc = async () => ({ data: null, error: null })
  s.from = (tabla: string) => new Consulta(tabla)
  // Aislamiento por docente: la sesión simulada abre la puerta de las copias locales.
  p.establecerPropietarioLocal(sesion)

  const DOC = (n: number) => `📨 CITATORIO A PADRES\n\nTexto ficticio. Versión ${n}.`
  type Clave = { id: string; rol: 'usuario' | 'asistente'; creadoEn: number }
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id)

  // ---- 1. Pares históricos de CITATORIO (ids, roles y fechas reales de E2E) ----
  const reales: Clave[] = `msg-1794806918596-0-2p5v5u5o usuario 1794806918596
msg-1794806929323-1-4z1a3438 asistente 1794806929323
msg-1794806946755-2-6u4o705x usuario 1794806946755
msg-1794806955463-3-4c2f2e5u asistente 1794806955464
msg-1794807004946-4-154g5l6m usuario 1794807004946
msg-1794807010517-5-3410503u asistente 1794807010517
msg-1794807043878-6-51346n60 asistente 1794807043879
msg-1794807043879-7-5x253903 usuario 1794807043879
msg-1794807082495-8-706m032g usuario 1794807082495
msg-1794807084658-9-6b1t6y4z asistente 1794807084658
msg-1794807164662-0-4l4f2z3c asistente 1794807164663
msg-1794807164663-1-6y1d2j4w usuario 1794807164663
msg-1794807536132-0-29676z3m asistente 1794807536133
msg-1794807536133-1-340w345u usuario 1794807536133
msg-1794872613203-2-382p355k usuario 1794872613203
msg-1794872613203-3-6s4d0r2y asistente 1794872613208
msg-1794872975346-0-3v103800 asistente 1794872975347
msg-1794872975347-1-19676r29 usuario 1794872975347
msg-1794873447832-0-2m1h654c usuario 1794873447833
msg-1794873450793-1-1i63636t asistente 1794873450793`.split('\n').map((l) => { const [id, rol, t] = l.split(' '); return { id, rol: rol as Clave['rol'], creadoEn: Number(t) } })
  const pares = [['msg-1794807043879-7-5x253903', 'msg-1794807043878-6-51346n60'], ['msg-1794807164663-1-6y1d2j4w', 'msg-1794807164662-0-4l4f2z3c'], ['msg-1794807536133-1-340w345u', 'msg-1794807536132-0-29676z3m'], ['msg-1794872975347-1-19676r29', 'msg-1794872975346-0-3v103800']]
  const mezclados = [...reales].reverse()
  const ordenados = p.combinarMensajes<Clave>([], mezclados)
  const pos = (id: string) => ordenados.findIndex((m) => m.id === id)
  verificar(pares.every(([u, a]) => pos(u) + 1 === pos(a)) && ordenados.every((m, i) => i === 0 || ordenados[i - 1].creadoEn <= m.creadoEn), '1a. Los 4 pares históricos de CITATORIO quedan pregunta → respuesta, sin modificar ids ni fechas; el resto sigue por fecha')
  const sinTocar = reales.filter((m) => !pares.flat().includes(m.id))
  verificar(JSON.stringify(ids(ordenados.filter((m) => !pares.flat().includes(m.id)))) === JSON.stringify(ids(sinTocar)), '1b. Los 12 mensajes sin empate conservan exactamente su orden')

  // ---- 2. Reglas de desempate ----
  const t = 1794900000000
  const c = (id: string, rol: Clave['rol'], creadoEn = t): Clave => ({ id, rol, creadoEn })
  const ord = (xs: Clave[]) => ids(p.combinarMensajes<Clave>([], xs))
  verificar(JSON.stringify(ord([c('msg-1794900000000-10-aa', 'usuario'), c('msg-1794900000000-9-bb', 'usuario')])) === JSON.stringify(['msg-1794900000000-9-bb', 'msg-1794900000000-10-aa'])
    && JSON.stringify(ord([c('msg-1794900000000-100-aa', 'asistente'), c('msg-1794900000000-99-bb', 'asistente')])) === JSON.stringify(['msg-1794900000000-99-bb', 'msg-1794900000000-100-aa']), '2a. Contador 9→10 y 99→100 con la misma fecha y rol: orden numérico, no de texto')
  verificar(JSON.stringify(ord([c('msg-1794900000000-10-aa', 'usuario'), c('msg-1794900000000-9-bb', 'asistente')])) === JSON.stringify(['msg-1794900000000-10-aa', 'msg-1794900000000-9-bb']), '2b. Contador 9→10 con la pregunta después en el contador: la pregunta sigue primero')
  verificar(JSON.stringify(ord([c('b-usuario', 'usuario', t + 1), c('a-asistente', 'asistente', t)])) === JSON.stringify(['a-asistente', 'b-usuario']), '2c. Con fechas distintas nunca se reordena por rol (respuesta anterior a la siguiente pregunta)')
  verificar(JSON.stringify(ord([c('msg-1794900000000-3-cc', 'asistente'), c('msg-1794900000000-2-bb', 'asistente'), c('msg-1794900000000-1-aa', 'usuario')])) === JSON.stringify(['msg-1794900000000-1-aa', 'msg-1794900000000-2-bb', 'msg-1794900000000-3-cc']), '2d. Varios mensajes del mismo rol con la misma fecha: por su secuencia')
  const ev = p.combinarMensajes([], [{ id: 'msg-1794900000000-5-r', creadoEn: t, rol: 'asistente' as const, tipo: 'restauracion' as const, objetivo: 'x', raiz: 'x' }, { id: 'msg-1794900000000-6-s', creadoEn: t, rol: 'usuario' as const, tipo: 'seleccion' as const, objetivo: 'y' }])
  verificar(ids(ev)[0] === 'msg-1794900000000-6-s', '2e. Eventos documentales (índice P3b): el mismo criterio que los mensajes')

  // ---- 3. Pares nuevos: la pregunta antes que la respuesta ----
  almacen = DISPOSITIVO_A
  await p.guardarMensajesRemotos('conv-base-a', DOCENTE_A, [])
  const { AsistenteService } = await import('../lib/asistente/AsistenteService')
  type Doc = { id: string; texto: string; archivosGenerados?: Record<string, unknown> } | null
  const chat = AsistenteService as unknown as { conversacionActivaId: string | null; mensajes: Mensaje[]; documentoActivo: Doc; sincronizadaEn: Map<string, number>; nuevaConversacion(): void; enviarMensaje(texto: string): Promise<string>; manejarEventoMotor(e: unknown): void }
  const interno = chat as unknown as Record<string, unknown>
  let respuesta: { texto: string } | null = null
  const llamadas: unknown[] = []
  const motor = {
    establecerHistorial: () => {},
    establecerConversacion: () => {},
    enviarTexto: async (texto: string, _a: unknown, finalizar?: unknown) => {
      llamadas.push(texto)
      if (finalizar || !respuesta) return
      chat.manejarEventoMotor({ tipo: 'respuesta-parcial', texto: respuesta.texto })
      chat.manejarEventoMotor({ tipo: 'respuesta-final', texto: respuesta.texto })
    },
  }
  interno.motorTexto = motor
  interno.motor = motor
  interno.asegurarMotor = async () => {}
  interno.asegurarMotorTexto = async () => motor
  const pedir = async (texto: string, r: { texto: string } | null = null) => {
    respuesta = r
    llamadas.length = 0
    interno.editandoDocumentoId = null
    interno.documentoFinalizandoId = null
    chat.sincronizadaEn.set(chat.conversacionActivaId ?? '', Date.now())
    await chat.enviarMensaje(texto)
    interno.editandoDocumentoId = null
    interno.documentoFinalizandoId = null
    return chat.mensajes.slice(-2)
  }
  const parBien = ([preg, resp]: Mensaje[]) => preg.rol === 'usuario' && resp.rol === 'asistente' && preg.creadoEn < resp.creadoEn && p.compararOrden(preg as never, resp as never) < 0 && JSON.stringify(ids(p.combinarMensajes([], [resp, preg] as never[]))) === JSON.stringify([preg.id, resp.id])
  chat.nuevaConversacion()
  await pedir('Haz un citatorio', { texto: DOC(1) })
  await pedir('Agrégale la hora', { texto: DOC(2) })
  const consulta = await pedir('Muéstrame el documento actual')
  const version = await pedir('Muéstrame la versión anterior')
  const restaura = await pedir('Regresa a la versión anterior')
  chat.documentoActivo = { ...chat.documentoActivo!, archivosGenerados: { pdf: { tipo: 'pdf', nombre: 'CITATORIO.pdf', url: 'https://ficticio.invalid/a.pdf' } } }
  const reutiliza = await pedir('Pásalo a PDF')
  const aviso = await pedir('Cambia la fecha del oficio')
  verificar([consulta, version, restaura, reutiliza, aviso].every(parBien) && llamadas.length === 0, '3a. Consulta, versión, restauración, archivo reutilizado y aviso: la pregunta tiene fecha e id anteriores a la respuesta y queda primero en otro dispositivo')
  verificar(chat.mensajes.every((m, i) => i === 0 || chat.mensajes[i - 1].creadoEn < m.creadoEn), '3b. Ningún mensaje creado en el dispositivo repite fecha (fechas estrictamente crecientes)')
  verificar(restaura[1].restauraVersion !== undefined && p.documentoVigente(chat.mensajes as never)?.id === restaura[1].restauraVersion, '3c. La restauración sigue determinando el documento vigente')

  // ---- 4. Aclaración P2c entre dispositivos ----
  await pedir('Hazme un examen de fracciones', { texto: '📝 EXAMEN DE FRACCIONES\n\nPregunta ficticia.' })
  await pedir('Agrégale otra pregunta', { texto: '📝 EXAMEN DE FRACCIONES\n\nPregunta ficticia 2.' })
  const [pregA, aclaracion] = await pedir('Muéstrame el documento anterior')
  verificar(!!aclaracion.aclaracionVersion, '4a. Preparación: el dispositivo A pide aclarar (versión o documento)')
  const base = chat.mensajes.slice(0, -2)
  const enB = p.combinarMensajes(base as never[], [aclaracion, pregA] as never[]) as unknown as Mensaje[]
  chat.mensajes = enB
  const r4 = await pedir('La versión anterior')
  verificar(enB[enB.length - 1].id === aclaracion.id && llamadas.length === 0 && /versión anterior/.test(r4[1].texto) && !r4[1].aclaracionVersion, '4b. En el dispositivo B la aclaración llega como último mensaje y "La versión anterior" la completa, sin IA')

  // ---- 5. Copias locales anteriores: empates en orden, el resto intacto ----
  const viejos: Mensaje[] = [
    { id: 'msg-1794807043878-6-51346n60', rol: 'asistente', texto: 'Respuesta', creadoEn: 1794807043879 },
    { id: 'msg-1794807043879-7-5x253903', rol: 'usuario', texto: 'Pregunta', creadoEn: 1794807043879 },
    { id: 'msg-tarde', rol: 'usuario', texto: 'Otra', creadoEn: 1794807043900 },
    { id: 'msg-antes', rol: 'asistente', texto: 'Desfasada', creadoEn: 1794807043890 },
  ]
  p.guardarConversacion('conv-vieja', viejos as never, null)
  const cargados = p.cargarConversacionPorId('conv-vieja')!.mensajes
  verificar(JSON.stringify(ids(cargados)) === JSON.stringify(['msg-1794807043879-7-5x253903', 'msg-1794807043878-6-51346n60', 'msg-tarde', 'msg-antes']), '5a. Al cargar una copia anterior, el par empatado queda pregunta → respuesta; mensajes con fechas distintas conservan su orden guardado')

  // ---- 6. Descarga con empates en el límite de 80 ----
  const remoto = '22222222-2222-4222-8222-222222222222'
  tablas.conversaciones_chat.push({ id: remoto, docente_id: DOCENTE_A, titulo: 'Larga', documento_activo: null, actualizado_en: new Date().toISOString(), eliminada_en: null })
  const T0 = Date.parse('2026-11-10T10:00:00.000Z')
  const largos: Mensaje[] = []
  for (let i = 0; i < 79; i++) largos.push({ id: `msg-${T0 + 10 + i}-${i}-z`, rol: i % 2 ? 'asistente' : 'usuario', texto: `m${i}`, creadoEn: T0 + 10 + i })
  // Tres mensajes con la misma fecha, justo en el límite (82 en total): en
  // orden canónico van la pregunta (usuario) y luego las respuestas 10 y 11;
  // la ventana de 80 deja fuera exactamente la pregunta y la respuesta 10.
  const empate = [
    { id: `msg-${T0}-11-aa`, rol: 'asistente' as const, texto: 'r2', creadoEn: T0 },
    { id: `msg-${T0}-9-bb`, rol: 'usuario' as const, texto: 'pregunta', creadoEn: T0 },
    { id: `msg-${T0}-10-cc`, rol: 'asistente' as const, texto: 'r1', creadoEn: T0 },
  ]
  for (const m of [...empate, ...largos]) tablas.mensajes_chat.push(p.mensajeAFilaRemota(remoto, DOCENTE_A, m as never) as unknown as Fila)
  const canonico = p.combinarMensajes([], [...empate, ...largos] as never[]).slice(-80) as unknown as Mensaje[]
  lecturas.length = 0
  await p.descargarConversacionRemota(DOCENTE_A, remoto)
  const bajados = p.cargarConversacionPorId(remoto)!.mensajes
  verificar(JSON.stringify(ids(bajados)) === JSON.stringify(ids(canonico)) && bajados.length === 80 && ids(bajados)[0] === `msg-${T0}-11-aa` && !ids(bajados).includes(`msg-${T0}-9-bb`) && !ids(bajados).includes(`msg-${T0}-10-cc`), '6a. Descarga: con empates en el límite se eligen los últimos 80 en orden canónico (desempate antes de recortar)')
  verificar(lecturas.filter((l) => l.tabla === 'mensajes_chat').length === 2, '6b. Una sola lectura adicional, solo de las filas empatadas en el límite')
  const corto = '33333333-3333-4333-8333-333333333333'
  tablas.conversaciones_chat.push({ id: corto, docente_id: DOCENTE_A, titulo: 'Corta', documento_activo: null, actualizado_en: new Date().toISOString(), eliminada_en: null })
  for (const m of [{ id: 'msg-1794900000002-1-a', rol: 'asistente', texto: 'Respuesta', creadoEn: 1794900000002 }, { id: 'msg-1794900000002-2-b', rol: 'usuario', texto: 'Pregunta', creadoEn: 1794900000002 }]) tablas.mensajes_chat.push(p.mensajeAFilaRemota(corto, DOCENTE_A, m as never) as unknown as Fila)
  lecturas.length = 0
  await p.descargarConversacionRemota(DOCENTE_A, corto)
  verificar(JSON.stringify(ids(p.cargarConversacionPorId(corto)!.mensajes)) === JSON.stringify(['msg-1794900000002-2-b', 'msg-1794900000002-1-a']) && lecturas.filter((l) => l.tabla === 'mensajes_chat').length === 1, '6c. Conversación de menos de 80: sin lectura adicional, y el par empatado queda pregunta → respuesta')

  // ---- 7. Sincronización: empate histórico en el límite de la ventana ----
  // V1 → V2 del citatorio y la restauración a V1 (marcador anterior a P2c:
  // misma fecha que la pregunta e id menor), seguida de 79 mensajes. Un
  // dispositivo que solo tenía V1 y V2 recibe todo al sincronizar.
  const T7 = Date.parse('2026-11-12T10:00:00.000Z')
  const v1 = { id: `msg-${T7}-1-v1`, rol: 'asistente' as const, texto: '📨 CITATORIO A PADRES\n\nV1', creadoEn: T7 }
  const v2 = { id: `msg-${T7 + 1}-2-v2`, rol: 'asistente' as const, texto: '📨 CITATORIO A PADRES\n\nV2', creadoEn: T7 + 1, versionDe: v1.id, documentoRaizId: v1.id }
  const marcador = { id: `msg-${T7 + 9}-6-mm`, rol: 'asistente' as const, texto: 'Volví a la versión anterior del documento.', creadoEn: T7 + 10, restauraVersion: v1.id, documentoRaizId: v1.id }
  const pide = { id: `msg-${T7 + 10}-7-qq`, rol: 'usuario' as const, texto: 'Regresa a la versión anterior', creadoEn: T7 + 10 }
  const charla = Array.from({ length: 79 }, (_, i) => ({ id: `msg-${T7 + 20 + i}-${8 + i}-c${i}`, rol: (i % 2 ? 'asistente' : 'usuario') as Clave['rol'], texto: `charla ${i}`, creadoEn: T7 + 20 + i }))
  const local7 = 'conv-limite-ventana'
  p.guardarConversacion(local7, [v1, v2] as never, { id: v2.id, texto: v2.texto })
  const remoto7 = await p.idRemotoDe(DOCENTE_A, local7)
  tablas.conversaciones_chat.push({ id: remoto7, docente_id: DOCENTE_A, titulo: 'Citatorio', documento_activo: null, actualizado_en: new Date().toISOString(), eliminada_en: null })
  for (const m of [v1, v2, marcador, pide, ...charla]) tablas.mensajes_chat.push(p.mensajeAFilaRemota(remoto7, DOCENTE_A, m as never) as unknown as Fila)
  const ordenTotal = p.combinarMensajes<Clave>([], [v1, v2, marcador, pide, ...charla])
  verificar(ordenTotal.slice(-80).some((m) => m.id === marcador.id) && !ordenTotal.slice(-80).some((m) => m.id === pide.id), '7a. Preparación: en orden canónico el marcador entra en la ventana de 80 y la pregunta queda fuera (empate en el límite)')
  await p.sincronizarConversacionRemota(DOCENTE_A, local7)
  const copia7 = p.cargarConversacionPorId(local7)!
  const sinFijada = copia7.mensajes.filter((m) => m.id !== v1.id)
  verificar(copia7.mensajes.some((m) => m.id === marcador.id) && copia7.documentoActivo?.id === v1.id && p.documentoVigente(copia7.mensajes)?.id === v1.id && sinFijada.length === 80 && copia7.mensajes.length === 81,
    '7b. El dispositivo sin el par recupera el marcador: el documento vigente es V1, y la copia queda en 80 mensajes más V1 fijada')
  tablas.mensajes_chat.push(p.mensajeAFilaRemota(remoto7, DOCENTE_A, { id: `msg-${T7 + 500}-99-n`, rol: 'usuario', texto: 'Un mensaje más', creadoEn: T7 + 500 } as never) as unknown as Fila)
  await p.sincronizarConversacionRemota(DOCENTE_A, local7)
  const copia7b = p.cargarConversacionPorId(local7)!
  verificar(copia7b.documentoActivo?.id === v1.id && p.documentoVigente(copia7b.mensajes)?.id === v1.id && copia7b.mensajes.some((m) => m.id === `msg-${T7 + 500}-99-n`), '7c. Después de un mensaje adicional, el documento vigente sigue siendo V1')
  const filas7 = tablas.mensajes_chat.filter((f) => String(f.id).startsWith(remoto7 + ':'))
  verificar(new Set(filas7.map((f) => f.id)).size === filas7.length && filas7.length === 84 && new Set(copia7b.mensajes.map((m) => m.id)).size === copia7b.mensajes.length, '7d. Sin duplicados ni escrituras remotas: 84 filas en Supabase y la copia local sin ids repetidos')

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
