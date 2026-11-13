// scripts/verificar-sincronizacion-visible.ts
//
// Sincronización al volver a la app (fase 3B): visibilitychange (visible)
// y pageshow desde bfcache sincronizan en silencio la conversación activa
// con el mecanismo de las fases 1, 2 y 3A (misma sincronización en curso
// y misma hora de la última exitosa). Regreso con y sin novedades,
// eventos próximos, ausencia breve, sincronización en curso o reciente,
// cambio de conversación, cierre de sesión, respuesta en curso, documento
// nuevo, conversación eliminada, sesión vencida y fallo de red,
// integración con el envío (3A), sin duplicados ni escrituras remotas.
//
// Dos "dispositivos" = dos localStorage distintos con la misma cuenta.
// Sin red, sin credenciales, sin IA. Se ejecuta con
// `npx tsx scripts/verificar-sincronizacion-visible.ts`.

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
// Oyentes reales de la página: document (visibilitychange) y window (pageshow).
const oyentes: Record<string, ((e: unknown) => void)[]> = {}
const escuchar = (tipo: string, f: (e: unknown) => void) => { (oyentes[tipo] ??= []).push(f) }
const disparar = (tipo: string, e: unknown = {}) => { for (const f of oyentes[tipo] ?? []) f(e) }
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
  const lecturas: { tabla: string; columnas: string }[] = []
  let alLeer: ((tabla: string, columnas: string) => void) | null = null
  let retrasoLecturas = 0
  let fallarLecturas = false
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
    then(ok: (r: unknown) => unknown, ko?: (e: unknown) => unknown) {
      const retraso = this.op === 'select' ? retrasoLecturas : 0
      return new Promise((r) => setTimeout(r, retraso)).then(() => this.ejecutar()).then(ok, ko)
    }
    private ejecutar() {
      const filas = tablas[this.tabla]
      const coinciden = () => filas.filter((f) => this.filtros.every((x) => x(f)))
      if (this.op === 'select') {
        lecturas.push({ tabla: this.tabla, columnas: this.columnas })
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
  let sesionVigente = true
  ;(s.auth as Record<string, unknown>).getSession = async () => ({ data: { session: sesionVigente ? { user: { id: sesion } } : null }, error: null })
  s.rpc = async () => ({ data: null, error: null })
  s.from = (tabla: string) => new Consulta(tabla)

  const t = Date.now() - 100_000
  const m = (n: number, rol: Mensaje['rol'], texto: string, extra: Partial<Mensaje> = {}): Mensaje => ({ id: `msg-${t + n}-${n}-${String(n).padStart(8, 'a')}`, rol, texto, creadoEn: t + n, ...extra })
  const desdeA = (conv: string, ...mensajes: Mensaje[]) => { for (const x of mensajes) tablas.mensajes_chat.push(p.mensajeAFilaRemota(conv, DOCENTE_A, x as never) as unknown as Fila) }

  // ---- Preparación: X en Supabase y en la copia local de B ----
  almacen = DISPOSITIVO_A
  const iniciales = [m(0, 'usuario', 'Hola'), m(1, 'asistente', 'Respuesta inicial')]
  p.guardarConversacion('conv-a', iniciales as never, null)
  await p.asegurarConversacionRemota('conv-a', DOCENTE_A)
  const X = await p.idRemotoDe(DOCENTE_A, 'conv-a')
  desdeA(X, ...iniciales)
  almacen = DISPOSITIVO_B
  await p.guardarMensajesRemotos('conv-otra', DOCENTE_A, []) // línea base de la etapa 1 en B
  await p.descargarConversacionRemota(DOCENTE_A, X)
  p.guardarConversacion('conv-otra', [m(-50, 'usuario', 'Otra conversación de B')] as never, null)

  const { AsistenteService } = await import('../lib/asistente/AsistenteService')
  type Doc = { id: string; texto: string } | null
  const chat = AsistenteService as unknown as {
    conversacionActivaId: string | null; mensajes: Mensaje[]; documentoActivo: Doc; generando: boolean
    sincronizadaEn: Map<string, number>; abrirConversacion(id: string): void; enviarMensaje(texto: string): Promise<string>; notificar(): void; limpiarConversacionGuardada(): void
  }
  const interno = chat as unknown as Record<string, unknown>
  const envios: { historial: string[] }[] = []
  let historialActual: string[] = []
  const motor = {
    establecerHistorial: (mensajes: { texto: string }[]) => { historialActual = mensajes.map((x) => x.texto) },
    establecerConversacion: () => {},
    enviarTexto: async () => { envios.push({ historial: historialActual }) },
  }
  interno.motorTexto = motor
  interno.motor = motor
  interno.asegurarMotor = async () => {}
  interno.asegurarMotorTexto = async () => motor
  const sinDuplicados = () => new Set(chat.mensajes.map((x) => x.id)).size === chat.mensajes.length
  const consultasDeEstado = () => lecturas.filter((l) => l.columnas === 'id, eliminada_en').length
  const lecturasDeSync = () => lecturas.filter((l) => l.tabla === 'mensajes_chat' || l.columnas === 'id, eliminada_en').length
  const traidosEscritos = (ids: string[]) => escrituras.filter((e) => e.tabla === 'mensajes_chat').flatMap((e) => e.ids ?? []).filter((id) => ids.some((x) => id === `${X}:${x}`))
  // Salir de la app hace `hace` ms y volver; la última sincronización ya es vieja.
  const salir = (hace = 60_000) => { documento.hidden = true; disparar('visibilitychange'); interno.ocultaDesde = Date.now() - hace }
  const volver = () => { documento.hidden = false; disparar('visibilitychange') }
  const vencer = () => chat.sincronizadaEn.set(X, 0)

  chat.abrirConversacion(X)
  await esperar()
  verificar((oyentes.visibilitychange?.length ?? 0) >= 1 && (oyentes.pageshow?.length ?? 0) >= 1, '0a. Oyentes registrados: visibilitychange y pageshow (además de los propios de las bibliotecas)')

  // ---- 1. Regreso con mensajes nuevos ----
  const nuevo1 = m(10, 'usuario', 'Desde A mientras B estaba en otra app')
  const respuesta1 = m(11, 'asistente', 'Respuesta en A')
  desdeA(X, nuevo1, respuesta1)
  salir()
  verificar(p.cargarConversacionPorId(X) !== null, '1a. Al salir se sigue guardando de inmediato (comportamiento previo)')
  vencer()
  escrituras.length = 0
  volver()
  await esperar()
  verificar(chat.mensajes.some((x) => x.id === nuevo1.id) && chat.mensajes.some((x) => x.id === respuesta1.id) && sinDuplicados(), '1b. Al volver aparecen los mensajes de A, sin duplicados')

  // ---- 2. Regreso sin novedades ----
  const antes2 = JSON.stringify(chat.mensajes)
  salir()
  vencer()
  lecturas.length = 0
  volver()
  await esperar()
  verificar(JSON.stringify(chat.mensajes) === antes2 && lecturas.every((l) => !l.columnas.includes('texto')) && consultasDeEstado() === 1, '2a. Sin novedades: nada cambia y solo hay lecturas ligeras')

  // ---- 3. visibilitychange y pageshow próximos ----
  desdeA(X, m(20, 'asistente', 'Desde A antes del bfcache'))
  salir()
  vencer()
  lecturas.length = 0
  volver()
  disparar('pageshow', { persisted: true })
  await esperar()
  verificar(consultasDeEstado() === 1 && chat.mensajes.some((x) => x.id === m(20, 'asistente', '').id) && sinDuplicados(), '3a. visibilitychange + pageshow juntos: una sola sincronización')
  salir()
  vencer()
  lecturas.length = 0
  disparar('pageshow', { persisted: false })
  await esperar()
  verificar(lecturas.length === 0, '3b. pageshow de una carga normal (no bfcache) no sincroniza')
  disparar('pageshow', { persisted: true })
  await esperar()
  verificar(consultasDeEstado() === 1, '3c. pageshow desde bfcache sincroniza aunque no llegue visibilitychange')

  // ---- 4. Regreso rápido / sincronización reciente ----
  salir(1_000)
  vencer()
  lecturas.length = 0
  volver()
  disparar('pageshow', { persisted: true })
  await esperar()
  verificar(lecturas.length === 0, '4a. Ausencia de 1 s: no se consulta (ni con pageshow inmediato)')
  salir()
  chat.sincronizadaEn.set(X, Date.now())
  lecturas.length = 0
  volver()
  await esperar()
  verificar(lecturas.length === 0, '4b. Ya hubo una sincronización exitosa empezada después de ocultarse: no se consulta')

  // ---- 4c-4e. Última sincronización anterior a ocultarse (fallo E2E de la fase 3B) ----
  // Abrió hace 10 s (sincronizó), se ocultó 2 s después, A escribe y vuelve:
  // menos de 15 s desde la apertura, pero esa sincronización no cubre la ausencia.
  const tras4c = m(25, 'asistente', 'Desde A antes de 15 s desde la apertura')
  desdeA(X, tras4c)
  salir()
  chat.sincronizadaEn.set(X, Date.now() - 10_000)
  interno.ocultaDesde = Date.now() - 8_000
  lecturas.length = 0
  volver()
  await esperar()
  verificar(consultasDeEstado() === 1 && chat.mensajes.some((x) => x.id === tras4c.id) && sinDuplicados(), '4c. Regreso antes de 15 s desde la apertura: consulta y aparecen los mensajes de A')
  // Un regreso sin novedades y, dentro de 15 s, otra salida y regreso con novedades.
  const tras4d = m(26, 'asistente', 'Desde A tras un regreso sin novedades')
  desdeA(X, tras4d)
  salir()
  chat.sincronizadaEn.set(X, Date.now() - 8_000) // el regreso anterior (sin novedades) fue hace 8 s
  interno.ocultaDesde = Date.now() - 6_000
  lecturas.length = 0
  volver()
  disparar('pageshow', { persisted: true })
  await esperar()
  verificar(consultasDeEstado() === 1 && chat.mensajes.some((x) => x.id === tras4d.id) && sinDuplicados(), '4d. Segundo regreso dentro de 15 s del primero: vuelve a consultar, una sola vez aunque llegue pageshow')
  // Sincronización empezada ANTES de ocultarse y todavía en curso al volver
  // (tiempos reales: cada lectura tarda 2 s). A escribe después de la última
  // página leída por esa consulta, que por eso no lo trae.
  chat.abrirConversacion('conv-otra')
  await esperar()
  const tras4e = m(27, 'asistente', 'Desde A después de que empezó la consulta')
  let paginas4e = 0
  alLeer = (_tabla, columnas) => { if (columnas === 'id, creado_en' && ++paginas4e === 2) { alLeer = null; desdeA(X, tras4e) } }
  retrasoLecturas = 2_000
  lecturas.length = 0
  chat.abrirConversacion(X) // empieza la sincronización de la apertura
  await esperar()
  salir(0) // se oculta justo después de que empezó
  await esperar(5_200)
  const enCursoAlVolver = (interno.sincronizacionesEnCurso as Map<string, unknown>).size === 1
  volver()
  disparar('pageshow', { persisted: true })
  retrasoLecturas = 0
  for (let ronda = 0; ronda < 2; ronda++) {
    for (let i = 0; i < 200 && (interno.sincronizacionesEnCurso as Map<string, unknown>).size > 0; i++) await esperar()
    await esperar()
  }
  verificar(enCursoAlVolver && consultasDeEstado() === 2 && chat.mensajes.some((x) => x.id === tras4e.id) && sinDuplicados(), '4e. Sincronización empezada antes de ocultarse: al terminar se consulta una vez más (no dos, aunque llegue pageshow) y llega lo escrito durante la ausencia')

  // ---- 5. Sincronización en curso ----
  desdeA(X, m(30, 'asistente', 'Desde A con red lenta'))
  salir()
  vencer()
  lecturas.length = 0
  retrasoLecturas = 30
  volver()
  salir()
  volver()
  disparar('pageshow', { persisted: true })
  for (let i = 0; i < 100 && (interno.sincronizacionesEnCurso as Map<string, unknown>).size > 0; i++) await esperar()
  retrasoLecturas = 0
  verificar(consultasDeEstado() === 1 && chat.mensajes.some((x) => x.id === m(30, 'asistente', '').id) && sinDuplicados(), '5a. Con una sincronización en curso, los regresos siguientes no consultan otra vez')

  // ---- 6. Cambio de conversación durante la consulta ----
  const durante6 = m(40, 'asistente', 'Desde A mientras B cambia de conversación')
  desdeA(X, durante6)
  salir()
  vencer()
  alLeer = (tabla, columnas) => { if (tabla === 'mensajes_chat' && columnas.includes('texto')) { alLeer = null; chat.abrirConversacion('conv-otra') } }
  volver()
  await esperar()
  verificar(chat.conversacionActivaId === 'conv-otra' && chat.mensajes.length === 1 && p.cargarConversacionPorId(X)!.mensajes.some((x) => x.id === durante6.id), '6a. Cambió de conversación: la pantalla no recibe nada de X; queda en su copia local')
  chat.abrirConversacion(X)
  await esperar()

  // ---- 7. Respuesta en curso ----
  const durante7 = m(50, 'asistente', 'Desde A durante una respuesta de B')
  desdeA(X, durante7)
  salir()
  vencer()
  chat.generando = true
  lecturas.length = 0
  volver()
  await esperar()
  verificar(!chat.mensajes.some((x) => x.id === durante7.id), '7a. Con una respuesta en curso no se aplica nada')
  const lecturas7 = lecturas.length
  chat.generando = false
  chat.notificar()
  verificar(chat.mensajes.some((x) => x.id === durante7.id) && lecturas.length === lecturas7 && sinDuplicados(), '7b. Al terminar la respuesta se aplica, sin otra consulta')

  // ---- 8. Documento formal nuevo ----
  const DOC = '📨 AVISO DESDE A\n\nTexto ficticio sin datos de alumnos.'
  const URL_DOC = 'https://proyecto.supabase.co/storage/v1/object/sign/documentos-generados-ia/d/AVISO.pdf?token=firma'
  const doc = m(60, 'asistente', DOC, { creadoEn: Date.now() + 10, archivo: { tipo: 'pdf', nombre: 'AVISO.pdf', url: URL_DOC, archivoId: 'archivo-aviso' } })
  desdeA(X, doc)
  salir()
  vencer()
  volver()
  await esperar()
  const enPantalla = chat.mensajes.find((x) => x.id === doc.id) as unknown as { archivo?: { url: string; archivoId?: string } } | undefined
  verificar(chat.documentoActivo?.id === doc.id && enPantalla?.archivo?.url === URL_DOC && enPantalla.archivo.archivoId === 'archivo-aviso', '8a. Documento formal nuevo: pasa a ser el activo, con archivo y archivoId intactos')

  // ---- 9. Sesión vencida y fallo de red ----
  const sinRed = m(70, 'asistente', 'Desde A: llegará después')
  desdeA(X, sinRed)
  salir()
  const copiaAntes = JSON.stringify(p.cargarConversacionPorId(X)) // tras el guardado al salir
  vencer()
  sesionVigente = false
  lecturas.length = 0
  volver()
  await esperar()
  sesionVigente = true
  verificar(lecturas.length === 0 && chat.conversacionActivaId === X && JSON.stringify(p.cargarConversacionPorId(X)) === copiaAntes && chat.sincronizadaEn.get(X) === 0, '9a. Sin sesión vigente: no consulta, no vacía nada y no cuenta como sincronizada')
  salir()
  vencer()
  const copiaAntes9b = JSON.stringify(p.cargarConversacionPorId(X))
  fallarLecturas = true
  volver()
  await esperar()
  fallarLecturas = false
  verificar(chat.conversacionActivaId === X && JSON.stringify(p.cargarConversacionPorId(X)) === copiaAntes9b && chat.sincronizadaEn.get(X) === 0 && !chat.mensajes.some((x) => x.id === sinRed.id), '9b. Fallo de red o de autorización: la conversación queda intacta y no cuenta como sincronizada')
  salir()
  volver()
  await esperar()
  verificar(chat.mensajes.some((x) => x.id === sinRed.id), '9c. El siguiente regreso vuelve a intentar y trae lo pendiente')

  // ---- 10. Integración con el envío (3A) ----
  desdeA(X, m(80, 'asistente', 'Desde A antes de un envío'))
  salir()
  vencer()
  retrasoLecturas = 30
  lecturas.length = 0
  envios.length = 0
  chat.documentoActivo = null
  volver()
  const resultado10 = await chat.enviarMensaje('Pregunta justo al volver')
  retrasoLecturas = 0
  verificar(resultado10 === 'enviado' && consultasDeEstado() === 1 && envios[0]?.historial.includes('Desde A antes de un envío'), '10a. Envío justo al volver: espera la sincronización del regreso, sin otra consulta, y lleva lo de A')
  lecturas.length = 0
  await chat.enviarMensaje('Otra pregunta seguida')
  verificar(lecturasDeSync() === 0, '10b. La sincronización del regreso cuenta para el envío (sin consultas dentro de los 15 s)')

  // ---- 11. Cierre de sesión durante la consulta ----
  desdeA(X, m(90, 'asistente', 'Desde A al cerrar sesión'))
  salir()
  vencer()
  alLeer = (tabla, columnas) => { if (tabla === 'mensajes_chat' && columnas.includes('texto')) { alLeer = null; chat.limpiarConversacionGuardada() } }
  volver()
  await esperar()
  verificar(chat.conversacionActivaId === null && chat.mensajes.length === 0 && p.cargarConversacionPorId(X) === null && p.listarConversaciones().length === 0, '11a. Cerró sesión durante la consulta: no se recrea ninguna conversación en el dispositivo')

  // ---- 12. Sin escrituras de lo traído ----
  await esperar(2300) // copia remota de la etapa 1 (2 s de espera)
  verificar(traidosEscritos([tras4c.id, tras4d.id, tras4e.id, nuevo1.id, respuesta1.id, m(20, 'asistente', '').id, m(30, 'asistente', '').id, durante6.id, durante7.id, doc.id, sinRed.id, m(80, 'asistente', '').id, m(90, 'asistente', '').id]).length === 0, '12a. Ningún mensaje traído de A se escribe en Supabase')

  // ---- 13. Conversación eliminada ----
  p.guardarConversacion('conv-z', [m(100, 'usuario', 'Z')] as never, null)
  await p.asegurarConversacionRemota('conv-z', DOCENTE_A)
  const Z = await p.idRemotoDe(DOCENTE_A, 'conv-z')
  chat.abrirConversacion('conv-z')
  await esperar()
  tablas.conversaciones_chat.find((c) => c.id === Z)!.eliminada_en = new Date().toISOString()
  chat.sincronizadaEn.set('conv-z', 0)
  salir()
  escrituras.length = 0
  volver()
  await esperar()
  verificar(chat.conversacionActivaId === null && p.cargarConversacionPorId('conv-z') === null && escrituras.length === 0, '13a. Eliminada en otro dispositivo: al volver se retira y la pantalla vuelve a la vista inicial, sin escrituras')

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
