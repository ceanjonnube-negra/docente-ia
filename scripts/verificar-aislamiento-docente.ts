// scripts/verificar-aislamiento-docente.ts
//
// Etapa 1 del aislamiento por docente: las copias locales solo las ve,
// guarda, sincroniza y migra el docente con sesión confirmada. Sin sesión
// no se ve nada; al cambiar de cuenta se cierra el acceso de inmediato y
// se vacía la memoria, sin borrar copias, colas ni marcadores. Lo que la
// cuenta anterior tenía en curso no termina escribiendo ni mostrando datos
// bajo la nueva. Las copias sin propietario quedan intactas y aisladas.
//
// Se ejecuta con `npx tsx scripts/verificar-aislamiento-docente.ts`.

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
  const DOC = (n: number) => `📨 CITATORIO A PADRES\n\nTexto ficticio. Versión ${n}.`
  const crudo = (k: string) => almacen.get(k) ?? null
  const claves = (prefijo: string) => [...almacen.keys()].filter((k) => k.startsWith(prefijo))
  almacen = DISPOSITIVO_A
  const { AsistenteService } = await import('../lib/asistente/AsistenteService')
  const chat = AsistenteService as unknown as {
    conversacionActivaId: string | null; mensajes: Mensaje[]; documentoActivo: { id: string } | null; listaConversaciones: { id: string }[]; sincronizadaEn: Map<string, number>
    nuevaConversacion(): void; abrirConversacion(id: string): void; enviarMensaje(texto: string): Promise<string>; manejarEventoMotor(e: unknown): void; guardarInmediatamente(): void
  }
  const interno = chat as unknown as Record<string, unknown>
  let respuesta: { texto: string } | null = null
  let retenerRespuesta = false
  let respuestaRetenida: (() => void) | null = null
  const motor = {
    establecerHistorial: () => {},
    establecerConversacion: () => {},
    enviarTexto: async (_t: string, _a: unknown, finalizar?: unknown) => {
      if (finalizar || !respuesta) return
      const r = respuesta
      const responder = () => { chat.manejarEventoMotor({ tipo: 'respuesta-parcial', texto: r.texto }); chat.manejarEventoMotor({ tipo: 'respuesta-final', texto: r.texto }) }
      if (retenerRespuesta) respuestaRetenida = responder
      else responder()
    },
  }
  interno.motorTexto = motor
  interno.motor = motor
  interno.asegurarMotor = async () => {}
  interno.asegurarMotorTexto = async () => motor
  const pedir = async (texto: string, r: { texto: string } | null = null) => {
    respuesta = r
    chat.sincronizadaEn.set(chat.conversacionActivaId ?? '', Date.now())
    return chat.enviarMensaje(texto)
  }

  // ---- 1. Sesión nula: la puerta empieza cerrada ----
  p.guardarConversacion('conv-sin-sesion', [{ id: 'm1', rol: 'usuario', texto: 'hola', creadoEn: 1 }] as never, null)
  verificar(p.propietarioLocal() === null && p.listarConversaciones().length === 0 && chat.listaConversaciones.length === 0 && crudo('docente-ia:conversacion:conv-sin-sesion') === null, '1a. Sin sesión confirmada: no se lista nada ni se guarda ninguna copia')
  evento('INITIAL_SESSION', null)
  verificar(p.propietarioLocal() === null && chat.listaConversaciones.length === 0, '1b. INITIAL_SESSION sin sesión: la puerta sigue cerrada')

  // ---- 2. Docente A ----
  evento('INITIAL_SESSION', DOCENTE_A)
  chat.nuevaConversacion()
  const convA = chat.conversacionActivaId!
  await pedir('Haz un citatorio', { texto: DOC(1) })
  chat.guardarInmediatamente()
  const copiaA = JSON.parse(crudo(`docente-ia:conversacion:${convA}`) ?? '{}')
  verificar(p.propietarioLocal() === DOCENTE_A && copiaA.docenteId === DOCENTE_A && p.listarConversaciones().some((c) => c.id === convA) && JSON.parse(crudo('docente-ia:conversaciones') ?? '[]').find((c: { id: string }) => c.id === convA)?.docenteId === DOCENTE_A, '2a. Con la sesión de A: la copia nueva y su entrada del índice llevan a A como propietario')
  await esperar(2300)
  const remotoA = await p.idRemotoDe(DOCENTE_A, convA)

  // ---- 3. Pendiente de A al cambiar de cuenta (guardado diferido) ----
  await pedir('Agrégale la hora', { texto: DOC(2) })
  const pendienteA = chat.mensajes[chat.mensajes.length - 1].id
  evento('SIGNED_IN', DOCENTE_B)
  await esperar(100)
  const copiaA2 = JSON.parse(crudo(`docente-ia:conversacion:${convA}`) ?? '{}')
  const colaA = JSON.parse(crudo(`docente-ia:mensajes-remotos:${DOCENTE_A}`) ?? '{}')
  const enColaA = (colaA.pendientes ?? []).some((x: { fila: { id: string } }) => x.fila.id === `${remotoA}:${pendienteA}`) || !!colaA.huellas?.[`${remotoA}:${pendienteA}`]
  verificar(copiaA2.mensajes.some((m: { id: string }) => m.id === pendienteA) && enColaA, '3a. Lo último de A se guarda en SU copia y en SU cola antes de cerrar el acceso (sin pérdida)')
  verificar(!tablas.mensajes_chat.some((f) => f.id === `${remotoA}:${pendienteA}` && f.docente_id === DOCENTE_B), '3b. Nada de A se escribe en Supabase con la cuenta de B')

  // ---- 4. Cuenta B: no ve, no abre ni pisa lo de A ----
  verificar(chat.mensajes.length === 0 && chat.conversacionActivaId === null && chat.documentoActivo === null && p.listarConversaciones().length === 0 && p.cargarConversacionPorId(convA) === null && p.obtenerConversacionActivaId() === null, '4a. Al cambiar a B: memoria vacía; A no se lista, no se carga y no es la conversación activa')
  const antes = crudo(`docente-ia:conversacion:${convA}`)
  p.guardarConversacion(convA, [{ id: 'intruso', rol: 'usuario', texto: 'x', creadoEn: Date.now() }] as never, null)
  p.eliminarConversacion(convA)
  verificar(crudo(`docente-ia:conversacion:${convA}`) === antes, '4b. B no puede sobrescribir ni eliminar la copia de A con el mismo id')
  chat.nuevaConversacion()
  const convB = chat.conversacionActivaId!
  await pedir('Haz un examen', { texto: '📝 EXAMEN\n\nPregunta ficticia.' })
  chat.guardarInmediatamente()
  verificar(JSON.parse(crudo(`docente-ia:conversacion:${convB}`) ?? '{}').docenteId === DOCENTE_B && JSON.stringify(p.listarConversaciones().map((c) => c.id)) === JSON.stringify([convB]), '4c. B trabaja con lo suyo: su copia lleva a B y solo ve la suya')
  const migracionB = await p.migrarHistorialLocal(DOCENTE_B)
  verificar(migracionB.migradas === 0 && JSON.parse(crudo(`docente-ia:conversacion:${convA}`) ?? '{}').docenteId === DOCENTE_A, '4d. La migración de B nunca toma conversaciones de A')

  // ---- 5. Operaciones de A que terminan bajo B ----
  evento('SIGNED_IN', DOCENTE_A)
  chat.abrirConversacion(convA)
  await esperar(200)
  tablas.mensajes_chat.push(p.mensajeAFilaRemota(remotoA, DOCENTE_A, { id: 'msg-otro-dispositivo', rol: 'usuario', texto: 'Desde el iPhone', creadoEn: Date.now() } as never) as unknown as Fila)
  retrasoLecturas = 150
  const sincronizacion = p.sincronizarConversacionRemota(DOCENTE_A, convA)
  await esperar(20)
  evento('SIGNED_IN', DOCENTE_B)
  await sincronizacion.catch(() => null)
  retrasoLecturas = 0
  verificar(!JSON.parse(crudo(`docente-ia:conversacion:${convA}`) ?? '{}').mensajes.some((m: { id: string }) => m.id === 'msg-otro-dispositivo') && chat.mensajes.length === 0, '5a. Una sincronización de A que termina con la sesión de B no escribe la copia ni muestra nada')
  const remotoD = '44444444-4444-4444-8444-444444444444'
  tablas.conversaciones_chat.push({ id: remotoD, docente_id: DOCENTE_A, titulo: 'Remota', documento_activo: null, actualizado_en: new Date().toISOString(), eliminada_en: null })
  tablas.mensajes_chat.push(p.mensajeAFilaRemota(remotoD, DOCENTE_A, { id: 'msg-d1', rol: 'usuario', texto: 'Hola', creadoEn: Date.now() } as never) as unknown as Fila)
  evento('SIGNED_IN', DOCENTE_A)
  retrasoLecturas = 150
  const descarga = p.descargarConversacionRemota(DOCENTE_A, remotoD)
  await esperar(20)
  evento('SIGNED_IN', DOCENTE_B)
  const descargo = await descarga
  retrasoLecturas = 0
  verificar(descargo === false && crudo(`docente-ia:conversacion:${remotoD}`) === null, '5b. Una descarga de A que termina con la sesión de B no crea ninguna copia')
  evento('SIGNED_IN', DOCENTE_A)
  chat.abrirConversacion(convA)
  await esperar(200)
  retenerRespuesta = true
  const envioA = pedir('Agrégale una despedida', { texto: DOC(3) })
  await esperar(50)
  evento('SIGNED_IN', DOCENTE_B)
  ;(respuestaRetenida as (() => void) | null)?.()
  retenerRespuesta = false
  await envioA
  verificar(chat.mensajes.length === 0 && chat.conversacionActivaId === null, '5c. La respuesta de la IA pedida con A que llega con B no aparece en la sesión de B')

  // ---- 6. Copia sin propietario: intacta y aislada ----
  const legado = { version: 1, titulo: 'Conversación anterior', mensajes: [{ id: 'msg-legado', rol: 'usuario', texto: 'Dato anterior', creadoEn: 1700000000000 }], documentoActivo: null, actualizadaEn: 1 }
  const remotoLegado = '55555555-5555-4555-8555-555555555555'
  almacen.set(`docente-ia:conversacion:${remotoLegado}`, JSON.stringify(legado))
  almacen.set('docente-ia:conversaciones', JSON.stringify([...JSON.parse(crudo('docente-ia:conversaciones') ?? '[]'), { id: remotoLegado, titulo: 'Conversación anterior', actualizadaEn: 1 }]))
  const legadoAntes = crudo(`docente-ia:conversacion:${remotoLegado}`)
  tablas.conversaciones_chat.push({ id: remotoLegado, docente_id: DOCENTE_B, titulo: 'Remota', documento_activo: null, actualizado_en: new Date().toISOString(), eliminada_en: null })
  tablas.mensajes_chat.push(p.mensajeAFilaRemota(remotoLegado, DOCENTE_B, { id: 'msg-r', rol: 'usuario', texto: 'r', creadoEn: Date.now() } as never) as unknown as Fila)
  const sinCopiaB = await p.conversacionesRemotasSinCopiaLocal(DOCENTE_B)
  const bajoB = await p.descargarConversacionRemota(DOCENTE_B, remotoLegado)
  p.guardarConversacion(remotoLegado, [{ id: 'x', rol: 'usuario', texto: 'x', creadoEn: Date.now() }] as never, null)
  verificar(!p.listarConversaciones().some((c) => c.id === remotoLegado) && p.cargarConversacionPorId(remotoLegado) === null && !sinCopiaB.some((c) => c.id === remotoLegado) && bajoB === false && crudo(`docente-ia:conversacion:${remotoLegado}`) === legadoAntes,
    '6a. Copia sin propietario: no se lista, no se carga, no se descarga encima ni se sobrescribe; queda intacta')
  evento('SIGNED_IN', DOCENTE_A)
  await p.migrarHistorialLocal(DOCENTE_A)
  verificar(!p.listarConversaciones().some((c) => c.id === remotoLegado) && !tablas.mensajes_chat.some((f) => String(f.id).endsWith(':msg-legado')) && crudo(`docente-ia:conversacion:${remotoLegado}`) === legadoAntes, '6b. Tampoco la ve ni la migra otra cuenta')

  // ---- 7. Cierre de sesión: nada visible, nada borrado ----
  const llavesAntes = claves('docente-ia:').sort().join('|')
  evento('SIGNED_OUT', null)
  verificar(p.propietarioLocal() === null && chat.listaConversaciones.length === 0 && chat.mensajes.length === 0 && p.listarConversaciones().length === 0 && claves('docente-ia:').sort().join('|') === llavesAntes && crudo(`docente-ia:mensajes-remotos:${DOCENTE_A}`) !== null, '7a. SIGNED_OUT: acceso cerrado y memoria vacía; copias, colas y marcadores intactos')

  // ---- 8. El mismo docente vuelve ----
  evento('SIGNED_IN', DOCENTE_A)
  chat.abrirConversacion(convA)
  await esperar(300)
  verificar(p.listarConversaciones().some((c) => c.id === convA) && chat.mensajes.some((m) => m.id === pendienteA) && chat.documentoActivo !== null, '8a. A vuelve: ve su conversación con lo último que escribió y su documento activo')
  verificar(chat.mensajes.every((m, i) => i === 0 || p.compararOrden(chat.mensajes[i - 1] as never, m as never) <= 0), '8b. El orden canónico (P2c) se conserva al volver')
  const remotoE = '66666666-6666-4666-8666-666666666666'
  tablas.conversaciones_chat.push({ id: remotoE, docente_id: DOCENTE_A, titulo: 'Del iPhone', documento_activo: null, actualizado_en: new Date().toISOString(), eliminada_en: null })
  tablas.mensajes_chat.push(p.mensajeAFilaRemota(remotoE, DOCENTE_A, { id: 'msg-e1', rol: 'usuario', texto: 'Escrito en el iPhone', creadoEn: Date.now() } as never) as unknown as Fila)
  const bajada = await p.descargarConversacionRemota(DOCENTE_A, remotoE)
  verificar(bajada && JSON.parse(crudo(`docente-ia:conversacion:${remotoE}`) ?? '{}').docenteId === DOCENTE_A && p.cargarConversacionPorId(remotoE)?.mensajes.length === 1, '8c. Una conversación nueva de A escrita en otro dispositivo se descarga como suya')

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
