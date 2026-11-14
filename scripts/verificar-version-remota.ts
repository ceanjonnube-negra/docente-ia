// scripts/verificar-version-remota.ts
//
// P2c-2: versiones fuera de la ventana local. La versión que se restaura o
// que una restauración vigente referencia se lee de Supabase por su id
// exacto (de ESTA conversación, con RLS; nunca el historial completo) y se
// conserva fijada en la copia local. Al restaurar, al abrir en otro
// dispositivo, al sincronizar y antes de editar o convertir. Lecturas
// simultáneas compartidas; referente inexistente, de otra conversación o
// con la red caída: queda noRecuperado y nunca se usa otro documento.
//
// Se ejecuta con `npx tsx scripts/verificar-version-remota.ts`.

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
const DISPOSITIVO_C = new Map<string, string>()
const DISPOSITIVO_D = new Map<string, string>()
const DISPOSITIVO_E = new Map<string, string>()
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
const esperar = (ms = 50) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const { supabase } = await import('../lib/supabaseClient')
  const p = await import('../lib/asistente/persistencia')

  // ---- Doble de Supabase con RLS por docente ----
  const sesion = DOCENTE_A
  const tablas: Record<string, Fila[]> = { conversaciones_chat: [], mensajes_chat: [] }
  const escrituras: { tabla: string; op: string; ids?: string[] }[] = []
  const lecturas: { tabla: string; columnas: string; ids?: string[] }[] = []
  let fallarPorId = false
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
        let datos = coinciden().map((f) => JSON.parse(JSON.stringify(f))) as Fila[]
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
  const sesionVigente = true
  ;(s.auth as Record<string, unknown>).getSession = async () => ({ data: { session: sesionVigente ? { user: { id: sesion } } : null }, error: null })
  s.rpc = async () => ({ data: null, error: null })
  s.from = (tabla: string) => new Consulta(tabla)

  const AVISO = (n: number) => `📨 AVISO DE EXCURSIÓN ESCOLAR\n\nTexto ficticio sin datos de alumnos. Versión ${n}.`
  const URL = (n: string) => `https://proyecto.supabase.co/storage/v1/object/sign/documentos-generados-ia/d/${n}?token=firma`
  const desde = (conv: string, ...ms: Mensaje[]) => { for (const x of ms) tablas.mensajes_chat.push(p.mensajeAFilaRemota(conv, DOCENTE_A, x as never) as unknown as Fila) }
  const lecturasCompletas = () => lecturas.filter((l) => l.tabla === 'mensajes_chat' && l.columnas.includes('texto'))

  // ---- Preparación: en A, V1 → 90 mensajes → V2 → V3 (V1 queda fuera de los últimos 80) ----
  almacen = DISPOSITIVO_A
  const t0 = Date.now() - 1_000_000
  const v1 = { id: 'msg-v1', rol: 'asistente' as const, texto: AVISO(1), creadoEn: t0 + 1 }
  const relleno = Array.from({ length: 90 }, (_, i) => ({ id: `msg-r${i}`, rol: (i % 2 ? 'asistente' : 'usuario') as Mensaje['rol'], texto: `Mensaje ${i}`, creadoEn: t0 + 10 + i }))
  const v2 = { id: 'msg-v2', rol: 'asistente' as const, texto: AVISO(2), creadoEn: t0 + 200, versionDe: v1.id, documentoRaizId: v1.id }
  const v3 = { id: 'msg-v3', rol: 'asistente' as const, texto: AVISO(3), creadoEn: t0 + 300, versionDe: v2.id, documentoRaizId: v1.id }
  const todos = [{ id: 'msg-u0', rol: 'usuario' as const, texto: 'Haz un aviso', creadoEn: t0 }, v1, ...relleno, v2, v3]
  p.guardarConversacion('conv-a', todos as never, { id: v3.id, texto: AVISO(3) })
  await p.asegurarConversacionRemota('conv-a', DOCENTE_A)
  const X = await p.idRemotoDe(DOCENTE_A, 'conv-a')
  desde(X, ...todos as Mensaje[])
  // Otra conversación del docente con un documento (para la referencia cruzada).
  await p.asegurarConversacionRemota('conv-y', DOCENTE_A)
  const Y = await p.idRemotoDe(DOCENTE_A, 'conv-y')
  desde(Y, { id: 'msg-y1', rol: 'asistente', texto: AVISO(7), creadoEn: t0 + 5 })

  // ---- 1. Restaurar una versión con más de 80 mensajes de antigüedad (B) ----
  almacen = DISPOSITIVO_B
  await p.guardarMensajesRemotos('conv-base-b', DOCENTE_A, []) // línea base de la etapa 1 en B
  await p.descargarConversacionRemota(DOCENTE_A, X)
  verificar(!p.cargarConversacionPorId(X)!.mensajes.some((x) => x.id === v1.id) && p.cargarConversacionPorId(X)!.documentoActivo?.id === v3.id, '1a. Preparación: B tiene los últimos 80 (sin V1) y V3 activa')
  const { AsistenteService } = await import('../lib/asistente/AsistenteService')
  type Doc = { id: string; texto: string; noRecuperado?: true } | null
  const chat = AsistenteService as unknown as {
    conversacionActivaId: string | null; mensajes: Mensaje[]; documentoActivo: Doc; generando: boolean; avisoGeneracion: string | null
    sincronizadaEn: Map<string, number>; abrirConversacion(id: string): void; nuevaConversacion(): void; enviarMensaje(texto: string): Promise<string>; manejarEventoMotor(e: unknown): void; guardarInmediatamente(): void; notificar(): void
  }
  const interno = chat as unknown as Record<string, unknown>
  const llamadas: { texto: string; finalizar?: { tipo: string; documentoTexto: string } }[] = []
  let generados = 0
  const motor = {
    establecerHistorial: () => {},
    establecerConversacion: () => {},
    enviarTexto: async (texto: string, _adj: unknown, fin?: { tipo: string; documentoTexto: string }) => {
      llamadas.push({ texto, finalizar: fin })
      if (!fin) return
      const a = { tipo: fin.tipo, nombre: `AVISO.${fin.tipo}`, url: URL(`AVISO-${++generados}.${fin.tipo}`) }
      chat.manejarEventoMotor({ tipo: 'respuesta-parcial', texto: 'Documento generado correctamente.' })
      chat.manejarEventoMotor({ tipo: 'respuesta-final', texto: 'Documento generado correctamente.', archivo: a, archivos: [a] })
    },
  }
  interno.motorTexto = motor
  interno.motor = motor
  interno.asegurarMotor = async () => {}
  interno.asegurarMotorTexto = async () => motor
  chat.abrirConversacion(X)
  await esperar()
  lecturas.length = 0
  escrituras.length = 0
  llamadas.length = 0
  const r1 = await chat.enviarMensaje('Recupera la primera versión')
  const marcador = chat.mensajes[chat.mensajes.length - 1]
  const lecturasV1 = lecturasCompletas().filter((l) => (l.ids ?? []).includes(`${X}:${v1.id}`))
  verificar(r1 === 'enviado' && marcador.restauraVersion === v1.id && chat.documentoActivo?.id === v1.id && chat.documentoActivo?.texto === AVISO(1) && llamadas.length === 0, '1b. Se trae V1 de Supabase y queda restaurada con su texto exacto (sin IA)')
  verificar(lecturasV1.length === 1 && (lecturasV1[0].ids ?? []).length === 1 && lecturasCompletas().length === 1, '1c. Una sola lectura, solo del id de V1 (no se carga el historial)')
  const v1EnB = chat.mensajes.find((x) => x.id === v1.id)
  verificar(JSON.stringify({ ...v1EnB }) === JSON.stringify({ ...v1 }), '1d. V1 llega idéntica (identidad, texto y fecha); no se crea ni modifica nada')
  chat.guardarInmediatamente()
  const guardadaB = p.cargarConversacionPorId(X)!
  chat.nuevaConversacion()
  chat.abrirConversacion(X)
  await esperar()
  verificar(guardadaB.mensajes.some((x) => x.id === v1.id) && chat.documentoActivo?.id === v1.id && !chat.documentoActivo?.noRecuperado, '1e. V1 queda fijada en la copia local: al reabrir sigue vigente sin red')
  await esperar(2300) // copia remota de la etapa 1
  const subidas = escrituras.filter((e) => e.tabla === 'mensajes_chat').flatMap((e) => e.ids ?? [])
  verificar(subidas.includes(`${X}:${marcador.id}`) && !subidas.includes(`${X}:${v1.id}`), '1f. Se sube el marcador; V1 (recuperada) no se reescribe en Supabase')

  // ---- 2. Abrir desde otro dispositivo (C): la descarga trae la versión referida ----
  almacen = DISPOSITIVO_C
  lecturas.length = 0
  await p.descargarConversacionRemota(DOCENTE_A, X)
  const enC = p.cargarConversacionPorId(X)!
  verificar(enC.documentoActivo?.id === v1.id && enC.documentoActivo?.texto === AVISO(1) && !enC.documentoActivo?.noRecuperado && enC.mensajes.some((x) => x.id === v1.id) && lecturasCompletas().filter((l) => l.ids?.length === 1 && l.ids[0] === `${X}:${v1.id}`).length === 1, '2a. En otro dispositivo la descarga trae V1 por su id y queda vigente y guardada')

  // ---- 3. Red caída, respuesta en curso y recuperación antes de convertir (D) ----
  // El servicio simula un solo dispositivo a la vez: primero se sale de X en B.
  almacen = DISPOSITIVO_B
  chat.nuevaConversacion()
  almacen = DISPOSITIVO_D
  fallarPorId = true
  await p.descargarConversacionRemota(DOCENTE_A, X)
  verificar(p.cargarConversacionPorId(X)!.documentoActivo?.noRecuperado === true && !p.cargarConversacionPorId(X)!.mensajes.some((x) => x.id === v1.id), '3a. Sin red para la lectura por id: la descarga queda con noRecuperado (no usa otra versión)')
  chat.abrirConversacion(X)
  await esperar()
  llamadas.length = 0
  const bloqueado = await chat.enviarMensaje('Pásalo a PDF')
  verificar(bloqueado === 'no_enviado' && llamadas.length === 0 && chat.documentoActivo?.noRecuperado === true && chat.avisoGeneracion?.includes('no está disponible') === true, '3b. Con la red caída se intenta recuperar antes de convertir; al fallar no se convierte otro documento')
  const editarSinRed = await chat.enviarMensaje('Agrégale una conclusión')
  verificar(editarSinRed === 'no_enviado' && llamadas.length === 0, '3b2. Editar con la red caída tampoco opera sobre otro documento')
  // Vuelve la red durante una respuesta en curso: se recupera, pero se aplica al terminar.
  fallarPorId = false
  chat.generando = true
  await (interno.sincronizarConversacion as (id: string) => Promise<string>).call(chat, X)
  verificar(chat.documentoActivo?.noRecuperado === true && p.cargarConversacionPorId(X)!.mensajes.some((x) => x.id === v1.id), '3c. Durante una respuesta en curso: V1 se recupera y se guarda, pero la pantalla no cambia todavía')
  chat.generando = false
  chat.notificar()
  verificar(chat.documentoActivo?.id === v1.id && chat.documentoActivo?.texto === AVISO(1) && !chat.documentoActivo?.noRecuperado, '3d. Al terminar la respuesta, el documento activo pasa a V1 resuelta')
  llamadas.length = 0
  await chat.enviarMensaje('Pásalo a PDF')
  verificar(llamadas.length === 1 && llamadas[0].finalizar?.documentoTexto === AVISO(1), '3e. La conversión usa exactamente V1')
  llamadas.length = 0
  await chat.enviarMensaje('Agrégale una conclusión')
  verificar(llamadas.length === 1 && !llamadas[0].finalizar && llamadas[0].texto.includes(AVISO(1)) && !llamadas[0].texto.includes(AVISO(3)), '3f. La edición parte del texto de V1')

  // ---- 4. Lecturas simultáneas del mismo id ----
  lecturas.length = 0
  const a = p.leerMensajesRemotosPorId(DOCENTE_A, X, [v1.id])
  const b = p.leerMensajesRemotosPorId(DOCENTE_A, X, [v1.id])
  const [ra, rb] = await Promise.all([a, b])
  verificar(a === b && lecturasCompletas().length === 1 && ra.length === 1 && rb[0].id === v1.id, '4a. Dos peticiones simultáneas del mismo id comparten una sola lectura')

  // ---- 5. Referente inexistente o de otra conversación (E) ----
  almacen = DISPOSITIVO_E
  fallarPorId = false
  await p.descargarConversacionRemota(DOCENTE_A, X)
  const conMarcador = (ref: string, raiz: string) => {
    const copia = p.cargarConversacionPorId(X)!
    const m = { id: `msg-m-${ref}`, rol: 'asistente' as const, texto: 'Volví a la versión anterior del documento.', creadoEn: Date.now() + 10_000, restauraVersion: ref, documentoRaizId: raiz }
    p.guardarConversacion(X, [...copia.mensajes, m] as never, copia.documentoActivo)
  }
  conMarcador('msg-inexistente', 'msg-inexistente')
  await p.sincronizarConversacionRemota(DOCENTE_A, X)
  verificar(p.resolverDocumentoVigente(p.cargarConversacionPorId(X)!.mensajes as never)?.documento.noRecuperado === true, '5a. Referente inexistente: sigue noRecuperado')
  conMarcador('msg-y1', 'msg-y1')
  lecturas.length = 0
  await p.sincronizarConversacionRemota(DOCENTE_A, X)
  const vigenteE = p.resolverDocumentoVigente(p.cargarConversacionPorId(X)!.mensajes as never)
  verificar(vigenteE?.documento.noRecuperado === true && !p.cargarConversacionPorId(X)!.mensajes.some((x) => x.id === 'msg-y1') && lecturasCompletas().every((l) => (l.ids ?? []).every((id) => id.startsWith(`${X}:`))), '5b. Referente de otra conversación: se busca solo en ESTA (sin resultado) y sigue noRecuperado')

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
