// scripts/verificar-consulta-version.ts
//
// P2c-3: consultar y restaurar versiones desde el chat, solo con vínculos
// explícitos (P2b). Consultar responde y lleva la vista a la versión (sin
// cambiar el documento activo ni crear versiones; si estaba fuera de la
// ventana local, se trae por id sin reescribirla en Supabase). Restaurar
// registra el marcador (P2c-1). "Documento anterior", tipo nombrado y
// ramas se resuelven de forma determinista o con una aclaración breve.
//
// Se ejecuta con `npx tsx scripts/verificar-consulta-version.ts`.

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
  const fallarPorId = false
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

  const DOC = (titulo: string, n: number) => `📨 ${titulo}\n\nTexto ficticio sin datos de alumnos. Versión ${n}.`
  const AVISO = 'AVISO DE EXCURSIÓN ESCOLAR'
  const CITATORIO = 'CITATORIO A PADRES DE FAMILIA'
  const desde = (conv: string, ...ms: Mensaje[]) => { for (const x of ms) tablas.mensajes_chat.push(p.mensajeAFilaRemota(conv, DOCENTE_A, x as never) as unknown as Fila) }

  almacen = DISPOSITIVO_A
  await p.guardarMensajesRemotos('conv-base-a', DOCENTE_A, []) // línea base de la etapa 1
  const { AsistenteService } = await import('../lib/asistente/AsistenteService')
  type Doc = { id: string; texto: string; noRecuperado?: true } | null
  const chat = AsistenteService as unknown as {
    conversacionActivaId: string | null; mensajes: Mensaje[]; documentoActivo: Doc; generando: boolean; archivoReutilizadoId: string | null
    sincronizadaEn: Map<string, number>; abrirConversacion(id: string): void; nuevaConversacion(): void; enviarMensaje(texto: string): Promise<string>; manejarEventoMotor(e: unknown): void; guardarInmediatamente(): void; actualizarDocumentoActivo(id: string, texto: string): void
  }
  const interno = chat as unknown as Record<string, unknown>
  let respuesta: { texto: string } | null = null
  const llamadas: unknown[] = []
  const motor = {
    establecerHistorial: () => {},
    establecerConversacion: () => {},
    enviarTexto: async (..._args: unknown[]) => {
      llamadas.push(_args)
      if (!respuesta) return
      chat.manejarEventoMotor({ tipo: 'respuesta-parcial', texto: respuesta.texto })
      chat.manejarEventoMotor({ tipo: 'respuesta-final', texto: respuesta.texto })
    },
  }
  interno.motorTexto = motor
  interno.motor = motor
  interno.asegurarMotor = async () => {}
  interno.asegurarMotorTexto = async () => motor
  const ultimo = () => chat.mensajes[chat.mensajes.length - 1]
  const pedir = async (texto: string, r: { texto: string } | null = null) => {
    respuesta = r
    llamadas.length = 0
    chat.sincronizadaEn.set(chat.conversacionActivaId ?? '', Date.now())
    const resultado = await chat.enviarMensaje(texto)
    return { resultado, m: ultimo() }
  }
  const marcadores = () => chat.mensajes.filter((x) => x.restauraVersion)
  const copia = (id: string) => JSON.stringify(chat.mensajes.find((x) => x.id === id))

  // ---- Conversación 1: V1 → V2 → V3 ----
  chat.nuevaConversacion()
  const conv1 = chat.conversacionActivaId!
  const v1 = (await pedir('Haz un aviso', { texto: DOC(AVISO, 1) })).m
  const v2 = (await pedir('Agrégale una conclusión', { texto: DOC(AVISO, 2) })).m
  const v3 = (await pedir('Hazlo más formal', { texto: DOC(AVISO, 3) })).m
  const historicos = [v1, v2, v3].map((x) => copia(x.id))

  // 1. Consultar sin cambiar el vigente.
  const c1 = await pedir('Muéstrame la versión anterior')
  verificar(c1.resultado === 'enviado' && llamadas.length === 0 && c1.m.texto.startsWith('Esta es la versión anterior') && chat.archivoReutilizadoId === v2.id && chat.documentoActivo?.id === v3.id && marcadores().length === 0, '1a. "Muéstrame la versión anterior": se lleva la vista a V2; V3 sigue vigente y no hay marcador')
  const c2 = await pedir('Enséñame la primera versión')
  const c3 = await pedir('Quiero ver cómo estaba antes')
  verificar(c2.m.texto.startsWith('Esta es la primera versión') && c3.m.texto.startsWith('Esta es la versión anterior') && chat.documentoActivo?.id === v3.id && [v1, v2, v3].every((x, i) => copia(x.id) === historicos[i]) && p.documentoVigente(chat.mensajes as never)?.id === v3.id, '1b. "Enséñame la primera versión" y "Quiero ver cómo estaba antes": consultas sin cambios ni versiones nuevas')

  // 2. Restaurar inequívoco y retroceder paso a paso (sin ambigüedad de ramas).
  const r1 = await pedir('Regresa a la versión anterior')
  const r2 = await pedir('Regresa a la versión anterior')
  verificar(r1.m.restauraVersion === v2.id && r2.m.restauraVersion === v1.id && chat.documentoActivo?.id === v1.id, '2a. Restaurar paso a paso: V3 → V2 → V1 (V3 desciende de V2, no es otra rama)')

  // 3. "Documento anterior" con un solo documento: es la versión anterior.
  const v4 = (await pedir('Agrégale una despedida', { texto: DOC(AVISO, 4) })).m
  const d1 = await pedir('Regresa al documento anterior')
  verificar(v4.versionDe === v1.id && d1.m.restauraVersion === v1.id && chat.documentoActivo?.id === v1.id, '3a. Sin otros documentos, "documento anterior" es la versión anterior (V4 → V1)')

  // 4. Ramas: activo restaurado cuyo uso previo es de OTRA rama.
  const v5 = (await pedir('Hazlo más breve', { texto: DOC(AVISO, 5) })).m // V5 → V1 (rama nueva)
  const marcadorV2 = { id: 'msg-marcador-v2', rol: 'asistente' as const, texto: 'Volví a la versión anterior del documento.', creadoEn: Date.now(), restauraVersion: v2.id, documentoRaizId: v1.id }
  chat.mensajes = [...chat.mensajes, marcadorV2]
  chat.actualizarDocumentoActivo(v2.id, DOC(AVISO, 2))
  const antesRama = marcadores().length
  const rama = await pedir('Regresa a la versión anterior')
  verificar(v5.versionDe === v1.id && rama.m.texto.startsWith('Esta versión se restauró') && marcadores().length === antesRama && chat.documentoActivo?.id === v2.id, '4a. Activo restaurado (V2) tras usar otra rama (V5): "anterior" es ambiguo → aclaración, sin cambios')

  // 5. Tipo nombrado: solo valida.
  const t1 = await pedir('Vuelve a la versión anterior del citatorio')
  verificar(t1.m.texto.startsWith('El documento actual no corresponde') && chat.documentoActivo?.id === v2.id, '5a. "…del citatorio" con un aviso vigente: aclaración (nunca se elige otro documento por su título)')
  chat.nuevaConversacion()
  const c1v1 = (await pedir('Haz un citatorio', { texto: DOC(CITATORIO, 1) })).m
  await pedir('Agrégale la fecha', { texto: DOC(CITATORIO, 2) })
  const t2 = await pedir('Vuelve a la versión anterior del citatorio')
  verificar(t2.m.restauraVersion === c1v1.id && chat.documentoActivo?.id === c1v1.id, '5b. "…del citatorio" con un citatorio vigente: se valida y se restaura su versión anterior')

  // 6. Documento anterior distinto, varios documentos y mismo título.
  chat.nuevaConversacion()
  const convD = chat.conversacionActivaId!
  const a1 = (await pedir('Haz un aviso', { texto: DOC(AVISO, 1) })).m
  const b1 = (await pedir('Hazme otro aviso de excursión para segundo grado', { texto: DOC(AVISO, 1) })).m
  const doc1 = await pedir('Regresa al documento anterior')
  verificar(b1.versionDe === undefined && doc1.m.restauraVersion === a1.id && doc1.m.documentoRaizId === a1.id && doc1.m.texto.startsWith('Volví al documento anterior') && chat.documentoActivo?.id === a1.id, '6a. Activo nuevo sin versiones y un solo documento distinto: "documento anterior" es ese documento (por identidad, aunque tenga el mismo título)')
  const b2 = (await pedir('Hazme otro aviso de excursión para tercer grado', { texto: DOC(AVISO, 1) })).m
  const amb = await pedir('Regresa al documento anterior')
  verificar(b2.versionDe === undefined && amb.m.texto.startsWith('Hay varios documentos anteriores') && chat.documentoActivo?.id === b2.id, '6b. Con varios documentos anteriores: aclaración, sin elegir ninguno')
  const b3 = (await pedir('Agrégale una conclusión', { texto: DOC(AVISO, 2) })).m
  const amb2 = await pedir('Regresa al documento anterior')
  verificar(b3.versionDe === b2.id && amb2.m.texto.startsWith('¿Te refieres a una versión anterior') && chat.documentoActivo?.id === b3.id, '6c. Con versión previa y otros documentos: "¿versión anterior u otro documento?"')
  const vers = await pedir('Muéstrame la primera versión')
  verificar(chat.archivoReutilizadoId === b2.id && chat.documentoActivo?.id === b3.id && vers.m.texto.startsWith('Esta es la primera versión'), '6d. La primera versión es la de ESTE documento (B2), no la de los otros con el mismo título')

  // 7. Referente inexistente o de otra conversación.
  const huerfana = { id: 'msg-huerfana', rol: 'asistente' as const, texto: DOC(AVISO, 9), creadoEn: Date.now(), versionDe: 'msg-no-existe', documentoRaizId: 'msg-no-existe' }
  chat.mensajes = [...chat.mensajes, huerfana]
  chat.actualizarDocumentoActivo(huerfana.id, huerfana.texto)
  const inex = await pedir('Regresa a la versión anterior')
  verificar(inex.m.texto.startsWith('Esa versión no está disponible') && chat.documentoActivo?.id === huerfana.id && !inex.m.restauraVersion, '7a. Versión anterior inexistente (ni local ni en Supabase): no se cambia nada')
  await p.asegurarConversacionRemota('conv-ajena', DOCENTE_A)
  const ajena = await p.idRemotoDe(DOCENTE_A, 'conv-ajena')
  desde(ajena, { id: 'msg-de-otra', rol: 'asistente', texto: DOC(AVISO, 7), creadoEn: 1 })
  const cruzada = { id: 'msg-cruzada', rol: 'asistente' as const, texto: DOC(AVISO, 8), creadoEn: Date.now(), versionDe: 'msg-de-otra', documentoRaizId: 'msg-de-otra' }
  chat.mensajes = [...chat.mensajes, cruzada]
  chat.actualizarDocumentoActivo(cruzada.id, cruzada.texto)
  const cruz = await pedir('Muéstrame la versión anterior')
  verificar(cruz.m.texto.startsWith('Esa versión no está disponible') && !chat.mensajes.some((x) => x.id === 'msg-de-otra'), '7b. Referencia a una versión de otra conversación: no se trae ni se muestra')

  // 8. Consulta durante una respuesta en curso.
  const antes8 = chat.mensajes.length
  chat.generando = true
  const enCurso = await chat.enviarMensaje('Muéstrame la versión anterior')
  chat.generando = false
  verificar(enCurso === 'no_enviado' && chat.mensajes.length === antes8, '8a. Con una respuesta en curso no se atiende (el borrador vuelve al campo)')

  // 9. Consultar V1 fuera de la ventana local (otro dispositivo).
  almacen = DISPOSITIVO_A
  chat.abrirConversacion(conv1)
  await esperar()
  const relleno = Array.from({ length: 90 }, (_, i) => ({ id: `msg-relleno-${i}`, rol: (i % 2 ? 'asistente' : 'usuario') as Mensaje['rol'], texto: `Mensaje ${i}`, creadoEn: Date.now() + i }))
  chat.mensajes = [...chat.mensajes, ...relleno]
  await esperar(150) // la versión nueva, posterior al relleno
  const w = (await pedir('Agrégale un saludo', { texto: DOC(AVISO, 6) })).m // versión nueva de V2 (vigente)
  chat.guardarInmediatamente()
  await esperar(2300) // copia remota de la etapa 1
  const remoto1 = await p.idRemotoDe(DOCENTE_A, conv1)
  almacen = DISPOSITIVO_B
  await p.guardarMensajesRemotos('conv-base-b', DOCENTE_A, [])
  chat.nuevaConversacion()
  await p.descargarConversacionRemota(DOCENTE_A, remoto1)
  chat.abrirConversacion(remoto1)
  await esperar()
  escrituras.length = 0
  const fuera = await pedir('Enséñame la primera versión')
  verificar(!p.cargarConversacionPorId(remoto1)!.mensajes.some((x) => x.id === v1.id) && fuera.m.texto.startsWith('Esta es la primera versión') && chat.archivoReutilizadoId === v1.id && chat.mensajes.find((x) => x.id === v1.id)?.texto === DOC(AVISO, 1) && chat.documentoActivo?.id === w.id, '9a. V1 fuera de la ventana: se trae por id y se muestra en su lugar; el documento activo no cambia')
  chat.guardarInmediatamente()
  await esperar(2300)
  verificar(!escrituras.some((e) => (e.ids ?? []).includes(`${remoto1}:${v1.id}`)), '9b. La versión consultada no se reescribe en Supabase')

  // 10. Sincronización Mac ↔ iPhone de una restauración por "documento anterior".
  almacen = DISPOSITIVO_A
  chat.nuevaConversacion()
  chat.abrirConversacion(convD)
  await esperar()
  chat.guardarInmediatamente()
  await esperar(2300)
  const remotoD = await p.idRemotoDe(DOCENTE_A, convD)
  almacen = DISPOSITIVO_C
  await p.descargarConversacionRemota(DOCENTE_A, remotoD)
  const marcadorDoc = p.cargarConversacionPorId(remotoD)!.mensajes.find((x) => x.id === doc1.m.id)
  verificar(marcadorDoc?.restauraVersion === a1.id && p.documentoVigente(p.cargarConversacionPorId(remotoD)!.mensajes as never) !== null, '10a. El marcador de "documento anterior" viaja al otro dispositivo con sus referencias')

  // 11. P2a: convertir o editar una versión anterior sigue con la respuesta segura.
  almacen = DISPOSITIVO_A
  chat.nuevaConversacion()
  chat.abrirConversacion(conv1)
  await esperar()
  const p1 = await pedir('Convierte la versión anterior a PDF')
  const p2 = await pedir('Corrige la versión anterior')
  verificar(llamadas.length === 0 && p1.m.texto.includes('quieres convertir') && p2.m.texto.includes('quieres modificar'), '11a. Convertir o editar una versión anterior: respuesta segura de P2a (no opera sobre el vigente)')

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
