// scripts/verificar-documento-remoto.ts
//
// P3b: con la conversación más larga que la ventana local (80 mensajes), los
// documentos anteriores se conocen por el índice documental de Supabase
// (eventos sin texto, paginado por id, bajo RLS y conversacion_id) y la
// MISMA regla canónica del vigente que P2/P3a. Sin índice (falla de red o
// lectura incompleta) sigue la protección de P3a. Las conversaciones cortas
// y lo que trabaja sobre el documento activo no leen el índice.
//
// Se ejecuta con `npx tsx scripts/verificar-documento-remoto.ts`.

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
  const sesion = DOCENTE_A
  const tablas: Record<string, Fila[]> = { conversaciones_chat: [], mensajes_chat: [] }
  const escrituras: { tabla: string; op: string; ids?: string[] }[] = []
  const lecturas: { tabla: string; columnas: string; ids?: string[] }[] = []
  let fallarPorId = false
  let fallarIndice = false
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

  const CITATORIO = (n: number, motivo = 'A PADRES') => `📨 CITATORIO ${motivo}\n\nTexto ficticio sin datos de alumnos. Fecha: ${n} de mayo.`
  const EXAMEN = (n: number) => `📝 EXAMEN DE FRACCIONES\n\nPregunta ficticia ${n}.`
  const REPORTE = (n: number) => `📊 REPORTE DE LECTURA\n\nVersión ficticia ${n}.`

  almacen = DISPOSITIVO_A
  await p.guardarMensajesRemotos('conv-base-a', DOCENTE_A, [])
  const { AsistenteService } = await import('../lib/asistente/AsistenteService')
  type Doc = { id: string; texto: string; noRecuperado?: true } | null
  const chat = AsistenteService as unknown as {
    conversacionActivaId: string | null; mensajes: Mensaje[]; documentoActivo: Doc; archivoReutilizadoId: string | null; avisoGeneracion: string | null
    sincronizadaEn: Map<string, number>; abrirConversacion(id: string): void; nuevaConversacion(): void; enviarMensaje(texto: string): Promise<string>; manejarEventoMotor(e: unknown): void; guardarInmediatamente(): void
  }
  const interno = chat as unknown as Record<string, unknown>
  let respuesta: { texto: string } | null = null
  const llamadas: { texto: string; finalizar?: { tipo: string; documentoTexto: string }; edicion?: boolean }[] = []
  const motor = {
    establecerHistorial: () => {},
    establecerConversacion: () => {},
    enviarTexto: async (texto: string, _adj: unknown, finalizar?: { tipo: string; documentoTexto: string }, edicion?: boolean) => {
      llamadas.push({ texto, finalizar, edicion })
      if (finalizar || !respuesta) return
      chat.manejarEventoMotor({ tipo: 'respuesta-parcial', texto: respuesta.texto })
      chat.manejarEventoMotor({ tipo: 'respuesta-final', texto: respuesta.texto })
    },
  }
  interno.motorTexto = motor
  interno.motor = motor
  interno.asegurarMotor = async () => {}
  interno.asegurarMotorTexto = async () => motor
  const ultimo = () => chat.mensajes[chat.mensajes.length - 1]
  const docente = () => [...chat.mensajes].reverse().find((m) => m.rol === 'usuario')!
  const candidatosDe = (m: Mensaje) => (m.aclaracionDocumento as { candidatos?: string[] } | undefined)?.candidatos
  const lecturasIndice = () => lecturas.filter((l) => l.columnas.includes('raiz:')).length
  const lecturasPorId = () => lecturas.filter((l) => (l.ids ?? []).length > 0).length
  const pedir = async (texto: string, r: { texto: string } | null = null) => {
    respuesta = r
    llamadas.length = 0
    lecturas.length = 0
    interno.editandoDocumentoId = null
    interno.documentoFinalizandoId = null
    chat.archivoReutilizadoId = null
    chat.sincronizadaEn.set(chat.conversacionActivaId ?? '', Date.now())
    const resultado = await chat.enviarMensaje(texto)
    interno.editandoDocumentoId = null
    interno.documentoFinalizandoId = null
    return { resultado, m: ultimo() }
  }
  const editoCon = (texto: string) => llamadas.length === 1 && llamadas[0].edicion === true && llamadas[0].texto.includes(texto)

  // Conversación larga: los documentos antiguos solo están en Supabase; en
  // el dispositivo, 80 mensajes de charla y el examen activo al final.
  let base = Date.now() - 10 * 86400000
  const doc = (id: string, texto: string, extra: Record<string, unknown> = {}): Mensaje => ({ id, rol: 'asistente', texto, creadoEn: base++, ...extra })
  const larga = async (antiguos: Mensaje[]) => {
    chat.nuevaConversacion()
    const conv = chat.conversacionActivaId!
    const ahora = Date.now() - 200000
    const charla: Mensaje[] = Array.from({ length: 80 }, (_, i) => ({ id: `${conv}-charla-${i}`, rol: i % 2 ? 'asistente' as const : 'usuario' as const, texto: `Charla ${i}`, creadoEn: ahora + i }))
    const examen: Mensaje = { id: `${conv}-examen`, rol: 'asistente', texto: EXAMEN(1), creadoEn: ahora + 100 }
    chat.mensajes = [...charla, examen]
    chat.documentoActivo = { id: examen.id, texto: examen.texto }
    chat.guardarInmediatamente()
    await esperar(2300)
    const remoto = await p.idRemotoDe(DOCENTE_A, conv)
    for (const m of antiguos) tablas.mensajes_chat.push(p.mensajeAFilaRemota(remoto, DOCENTE_A, m as never) as unknown as Fila)
    return { conv, remoto, examen }
  }

  // ---- 1. Regla canónica: el índice reconstruye lo mismo que los mensajes completos ----
  {
    const a1 = doc('eq-a1', CITATORIO(1)); const a2 = doc('eq-a2', CITATORIO(2), { versionDe: 'eq-a1', documentoRaizId: 'eq-a1' })
    const r1 = doc('eq-r1', 'Volví a la versión anterior del documento.', { restauraVersion: 'eq-a1', documentoRaizId: 'eq-a1' })
    const b1 = doc('eq-b1', REPORTE(1)); const s1: Mensaje = { id: 'eq-s1', rol: 'usuario', texto: 'Regresa al reporte', creadoEn: base++, documentoDestinoId: 'eq-b1' }
    const x1 = doc('eq-x1', 'Volví a la versión anterior del documento.', { restauraVersion: 'eq-perdida', documentoRaizId: 'eq-b1' })
    const e1 = doc('eq-e1', EXAMEN(1))
    const todos = [a1, a2, r1, b1, s1, x1, e1] as never[]
    const completo = p.documentosDeConversacion(todos).map((d) => [d.raiz, d.id, !!d.noRecuperado])
    const indice = todos.slice(0, 5).flatMap((m) => p.eventoDocumentalDe(m) ?? [])
    const parcial = p.documentosDeConversacion(todos.slice(5), indice).map((d) => [d.raiz, d.id, !!d.noRecuperado])
    const vigentes = [todos.slice(0, 3), todos.slice(0, 5), todos.slice(0, 6), todos].map((ms) => JSON.stringify(p.resolverDocumentoVigente(ms)?.documento.id) + JSON.stringify(p.vigenteDeEventos((ms as Mensaje[]).flatMap((m) => p.eventoDocumentalDe(m as never) ?? []))?.id))
    verificar(JSON.stringify(completo) === JSON.stringify([['eq-a1', 'eq-a1', false], ['eq-b1', 'eq-perdida', true], ['eq-e1', 'eq-e1', false]]) && JSON.stringify(parcial) === JSON.stringify(completo)
      && vigentes.every((v) => { const [x, y] = v.split('"').filter((t) => t.startsWith('eq-')); return x === y }), '1a. Una sola regla: con eventos del índice (sin texto) se obtiene el mismo vigente por documento que con los mensajes completos (restauración, selección y versión perdida)')
  }

  // ---- 2. Sin consultas extra: conversaciones cortas y operaciones sobre el activo ----
  chat.nuevaConversacion()
  await pedir('Haz un citatorio', { texto: CITATORIO(1) })
  await pedir('Hazme un examen de fracciones', { texto: EXAMEN(1) })
  await pedir('Cambia la fecha del citatorio', { texto: CITATORIO(2) })
  verificar(lecturasIndice() === 0 && editoCon('Fecha: 1 de mayo'), '2a. Conversación corta: P3a resuelve en memoria, sin leer el índice')
  const v1 = doc('c-v1', CITATORIO(1, 'A REUNIÓN'))
  const v2 = doc('c-v2', CITATORIO(2, 'A REUNIÓN'), { versionDe: 'c-v1', documentoRaizId: 'c-v1' })
  const restaura = doc('c-r', 'Volví a la versión anterior del documento.', { restauraVersion: 'c-v1', documentoRaizId: 'c-v1' })
  const A = await larga([v1, v2, restaura])
  await pedir('Agrégale una pregunta', { texto: EXAMEN(2) })
  const ex2 = ultimo()
  await pedir('Agrega al examen otra pregunta', { texto: EXAMEN(3) })
  verificar(lecturasIndice() === 0 && editoCon('EXAMEN DE FRACCIONES') && ex2.versionDe === A.examen.id, '2b. Conversación larga, edición implícita o del mismo documento activo: sin leer el índice')

  // ---- 3. Más de 80 mensajes: versión restaurada fuera de la ventana ----
  const r3 = await pedir('Cambia la fecha del citatorio', { texto: CITATORIO(3, 'A REUNIÓN') })
  verificar(r3.resultado === 'enviado' && editoCon('Fecha: 1 de mayo') && !llamadas[0].texto.includes('Fecha: 2 de mayo') && docente().documentoDestinoId === 'c-v1' && ultimo().versionDe === 'c-v1' && ultimo().documentoRaizId === 'c-v1',
    '3a. Citatorio solo en Supabase, con su V1 restaurada: sin confirmación, edita la V1 (no la V2), registra el destino y vincula la versión')
  verificar(lecturasIndice() === 2 && lecturasPorId() === 2, `3b. Consultas: índice 1 página + página vacía, y 2 lecturas por id (título de la última versión y la versión vigente)`)
  const nueva = ultimo().id
  chat.guardarInmediatamente()
  await esperar(2300)
  const otroDispositivo = p.documentosDeConversacion([], await p.leerIndiceDocumental(DOCENTE_A, A.conv))
  verificar(otroDispositivo.find((d) => d.raiz === 'c-v1')?.id === nueva, '3c. Otro dispositivo, solo con el índice de Supabase, reconstruye la misma versión vigente del citatorio')
  chat.nuevaConversacion()
  chat.abrirConversacion(A.conv)
  await esperar(300)
  verificar(chat.documentoActivo?.id === nueva && chat.mensajes.some((m) => m.id === nueva), '3d. Al reabrir, el citatorio editado sigue activo')

  // ---- 4. Consulta: no cambia el documento activo ----
  const C = await larga([doc('d-c1', CITATORIO(7, 'POR CONDUCTA'))])
  await pedir('Muéstrame el citatorio')
  verificar(llamadas.length === 0 && chat.archivoReutilizadoId === 'd-c1' && chat.documentoActivo?.id === C.examen.id && !chat.mensajes.some((m) => m.documentoDestinoId) && chat.mensajes.some((m) => m.id === 'd-c1'), '4a. "Muéstrame el citatorio" (solo en Supabase): lo trae y resalta; no cambia el documento activo ni registra selección')

  // ---- 5. Más de 30 documentos del mismo tipo, ordinales y respuesta por número ----
  // Ids en orden INVERSO a su creación: el orden debe salir de la fecha real.
  const idT = (n: number) => `t-${String(100 - n).padStart(3, '0')}`
  const treinta = Array.from({ length: 35 }, (_, i) => doc(idT(i + 1), CITATORIO(i + 1, `NÚMERO ${i + 1}`)))
  await larga(treinta)
  const aclara = await pedir('Corrige el citatorio')
  verificar(llamadas.length === 0 && candidatosDe(aclara.m)?.length === 35 && candidatosDe(aclara.m)?.[0] === idT(1) && candidatosDe(aclara.m)?.[34] === idT(35) && /35\. «CITATORIO NÚMERO 35»/.test(aclara.m.texto), '5a. 35 citatorios fuera de la ventana: aclaración con los 35, en orden de creación (sin tope de 30)')
  await pedir('12', { texto: CITATORIO(99, 'NÚMERO 12') })
  verificar(editoCon('NÚMERO 12') && docente().documentoDestinoId === idT(12), '5b. Respuesta "12": el citatorio 12, aunque no estaba en memoria')
  await pedir('Pasa el examen a Word')
  await pedir('Corrige el primer citatorio', { texto: CITATORIO(98, 'NÚMERO 1') })
  verificar(editoCon('NÚMERO 1\n') && docente().documentoDestinoId === idT(1), '5c. "El primer citatorio": el más antiguo por fecha real de creación')
  await pedir('Pasa el examen a Word')
  await pedir('Corrige el segundo citatorio', { texto: CITATORIO(97, 'NÚMERO 2') })
  verificar(editoCon('NÚMERO 2\n') && docente().documentoDestinoId === idT(2), '5d. "El segundo citatorio"')
  await pedir('Pasa el examen a Word')
  await pedir('Corrige el último citatorio', { texto: CITATORIO(96, 'NÚMERO 35') })
  verificar(editoCon('NÚMERO 35') && docente().documentoDestinoId === idT(35), '5e. "El último citatorio": el más reciente (aunque el 12, el 1 y el 2 se editaron después)')

  // ---- 6. Paginación: más de 1000 eventos ----
  const versiones = Array.from({ length: 1100 }, (_, i) => doc(`r-${String(i).padStart(4, '0')}`, REPORTE(i), i ? { versionDe: `r-${String(i - 1).padStart(4, '0')}`, documentoRaizId: 'r-0000' } : {}))
  await larga([doc('p-c1', CITATORIO(5)), ...versiones])
  await pedir('Cambia el título del reporte', { texto: REPORTE(2000) })
  verificar(editoCon('Versión ficticia 1099') && docente().documentoDestinoId === 'r-1099' && lecturasIndice() === 3, '6a. 1101 eventos documentales: el índice se lee en 2 páginas (+ la vacía) y el vigente es la versión 1099')

  // ---- 7. Dos documentos con el mismo título ----
  await larga([doc('m-1', CITATORIO(1)), doc('m-2', CITATORIO(2))])
  const mismo = await pedir('Corrige el citatorio')
  verificar(JSON.stringify(candidatosDe(mismo.m)) === JSON.stringify(['m-1', 'm-2']) && /1\. «CITATORIO A PADRES» \(\d\d\/\d\d \d\d:\d\d\)\n2\. «CITATORIO A PADRES» \(\d\d\/\d\d \d\d:\d\d\)/.test(mismo.m.texto), '7a. Mismo título: la aclaración agrega la fecha de cada uno')
  await pedir('El 2', { texto: CITATORIO(3) })
  verificar(editoCon('Fecha: 2 de mayo') && docente().documentoDestinoId === 'm-2', '7b. "El 2": el segundo')

  // ---- 8. Fallo de red o lectura incompleta: protección de P3a ----
  const F = await larga([doc('f-viejo', CITATORIO(1, 'ANTIGUO'))])
  chat.mensajes = [...chat.mensajes.slice(0, -1), { id: 'f-reciente', rol: 'asistente', texto: CITATORIO(2, 'RECIENTE'), creadoEn: F.examen.creadoEn - 1 }, F.examen]
  fallarIndice = true
  const sinIndice = await pedir('Cambia la fecha del citatorio')
  fallarIndice = false
  verificar(llamadas.length === 0 && JSON.stringify(candidatosDe(sinIndice.m)) === JSON.stringify(['f-reciente']) && /Esta conversación es larga/.test(sinIndice.m.texto) && chat.documentoActivo?.id === F.examen.id, '8a. Índice no disponible: se confirma el único citatorio visible (P3a); nada se edita')
  await pedir('Pasa el examen a Word')
  const conIndice = await pedir('Cambia la fecha del citatorio')
  verificar(JSON.stringify(candidatosDe(conIndice.m)) === JSON.stringify(['f-viejo', 'f-reciente']) && !/Esta conversación es larga/.test(conIndice.m.texto), '8b. Con el índice: aparecen los dos citatorios (también el que no estaba en memoria)')
  const G = await larga([doc('g-solo', CITATORIO(1))])
  fallarPorId = true
  const incompleto = await pedir('Cambia la fecha del citatorio')
  fallarPorId = false
  verificar(llamadas.length === 0 && /No encuentro un citatorio en esta conversación/.test(incompleto.m.texto) && /más atrás/.test(incompleto.m.texto) && chat.documentoActivo?.id === G.examen.id && !chat.mensajes.some((m) => m.documentoDestinoId), '8c. El índice se leyó pero el título no se pudo traer: aviso de P3a, sin elegir otro documento')
  await pedir('Pasa el examen a Word')
  fallarIndice = true
  await pedir('Corrige el primer citatorio')
  fallarIndice = false
  verificar(llamadas.length === 0 && /no puedo saber cuál es por su orden/.test(ultimo().texto), '8d. Ordinal sin índice: no se resuelve (P3a)')

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
