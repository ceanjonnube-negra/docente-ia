// scripts/verificar-migracion-historial.ts
//
// Persistencia remota, etapa 2: migración del historial local anterior
// a la etapa 1. Solo conversaciones cuya pertenencia se comprueba; los
// mensajes se insertan sin sobrescribir, en lotes, con verificación de
// integridad antes de marcar; título, documento activo y fecha solo se
// escriben si la fila sigue con su valor inicial; se reanuda tras un
// fallo; nada local se borra ni cambia.
//
// Sin red, sin credenciales, sin IA (Supabase se sustituye por un
// doble en memoria que aplica RLS por docente). Se ejecuta con
// `npx tsx scripts/verificar-migracion-historial.ts`.

// Módulo (no script global): sus nombres no chocan con otros scripts.
export {}

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  console.log(`${condicion ? '✓' : '✗'} ${mensaje}`)
  if (!condicion) fallos++
}

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://supabase.invalid'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'clave-ficticia'
const almacen = new Map<string, string>()
const g = globalThis as unknown as Record<string, unknown>
g.window = { localStorage: { getItem: (k: string) => almacen.get(k) ?? null, setItem: (k: string, v: string) => { almacen.set(k, v) }, removeItem: (k: string) => { almacen.delete(k) } }, addEventListener() {}, removeEventListener() {} }
g.localStorage = (g.window as { localStorage: unknown }).localStorage

type Fila = Record<string, unknown>
const DOCENTE_A = '11111111-1111-4111-8111-111111111111'
const DOCENTE_B = '22222222-2222-4222-8222-222222222222'

// Mismo id determinista que persistencia.ts (docente + conversación local).
async function idRemoto(docenteId: string, localId: string): Promise<string> {
  const datos = new TextEncoder().encode(`docente-ia:conversacion-remota:${docenteId}:${localId}`)
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', datos)).slice(0, 16)
  b[6] = (b[6] & 0x0f) | 0x80
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

async function main() {
  const { supabase } = await import('../lib/supabaseClient')
  const p = await import('../lib/asistente/persistencia')

  // ---- Doble de Supabase con RLS por docente ----
  let sesion: string | null = DOCENTE_A
  const tablas: Record<string, Fila[]> = { conversaciones_chat: [], mensajes_chat: [] }
  const registro: { tabla: string; op: string; filas?: number; ignorar?: boolean; cambios?: Fila }[] = []
  let fallarUpsertNumero: number | null = null
  let antesDeUpdate: (() => void) | null = null
  let upsertsMensajes = 0
  class Consulta {
    private filtros: ((f: Fila) => boolean)[] = [(f) => f.docente_id === sesion]
    private op = 'select'
    private datos: unknown = null
    private opciones: { ignoreDuplicates?: boolean } = {}
    private unica = false
    constructor(private tabla: string) {}
    select() { return this }
    maybeSingle() { this.unica = true; return this }
    in(c: string, v: unknown[]) { this.filtros.push((f) => v.includes(f[c])); return this }
    eq(c: string, v: unknown) { this.filtros.push((f) => f[c] === v); return this }
    is(c: string, v: null) { this.filtros.push((f) => f[c] === v || f[c] === undefined); return this }
    lt(c: string, v: string) { this.filtros.push((f) => Date.parse(String(f[c])) < Date.parse(v)); return this }
    update(c: Fila) { this.op = 'update'; this.datos = c; return this }
    insert(d: unknown) { this.op = 'insert'; this.datos = d; return this }
    upsert(d: Fila[], o: { ignoreDuplicates?: boolean }) { this.op = 'upsert'; this.datos = d; this.opciones = o ?? {}; return this }
    then(ok: (r: unknown) => unknown, ko?: (e: unknown) => unknown) { return Promise.resolve().then(() => this.ejecutar()).then(ok, ko) }
    private ejecutar() {
      const filas = tablas[this.tabla]
      if (this.op === 'select') {
        const datos = filas.filter((f) => this.filtros.every((x) => x(f))).map((f) => ({ ...f }))
        return { data: this.unica ? (datos[0] ?? null) : datos, error: null }
      }
      if (this.op === 'update') {
        antesDeUpdate?.()
        antesDeUpdate = null
        const cambios = this.datos as Fila
        registro.push({ tabla: this.tabla, op: 'update', cambios })
        for (const f of filas) if (this.filtros.every((x) => x(f))) Object.assign(f, cambios)
        return { data: null, error: null }
      }
      if (this.op === 'insert') { registro.push({ tabla: this.tabla, op: 'insert' }); return { data: null, error: null } }
      // upsert
      const lote = this.datos as Fila[]
      upsertsMensajes++
      registro.push({ tabla: this.tabla, op: 'upsert', filas: lote.length, ignorar: !!this.opciones.ignoreDuplicates })
      if (fallarUpsertNumero !== null && upsertsMensajes === fallarUpsertNumero) return { data: null, error: { code: 'NETWORK', message: 'fallo simulado' } }
      for (const f of lote) {
        if (f.docente_id !== sesion) return { data: null, error: { code: '42501', message: 'RLS' } }
        const existente = filas.find((x) => x.id === f.id)
        if (existente && this.opciones.ignoreDuplicates) continue
        if (existente) Object.assign(existente, f)
        else filas.push({ ...f })
      }
      return { data: null, error: null }
    }
  }
  const s = supabase as unknown as Record<string, unknown>
  ;(s.auth as Record<string, unknown>).getSession = async () => ({ data: { session: sesion ? { user: { id: sesion } } : null }, error: null })
  s.rpc = async (nombre: string) => { registro.push({ tabla: 'rpc', op: nombre }); return { data: null, error: null } }
  s.from = (tabla: string) => new Consulta(tabla)

  // ---- Historial local sembrado (formato real de persistencia.ts) ----
  const T = Date.now()
  const DESDE = T - 1000 // inicio de la etapa 1 en este dispositivo
  almacen.set(`docente-ia:mensajes-remotos:${DOCENTE_A}`, JSON.stringify({ desde: DESDE, pendientes: [], huellas: {} }))
  const indice: { id: string; titulo: string; actualizadaEn: number }[] = []
  const msg = (id: string, rol: string, texto: string, creadoEn: number, extra: Fila = {}) => ({ id, rol, texto, creadoEn, ...extra })
  const sembrar = (id: string, titulo: string, mensajes: Fila[], documentoActivo: Fila | null, actualizadaEn: number) => {
    almacen.set(`docente-ia:conversacion:${id}`, JSON.stringify({ version: 2, titulo, mensajes, documentoActivo, actualizadaEn }))
    indice.push({ id, titulo, actualizadaEn })
  }
  const VIEJO = T - 86_400_000
  const DOC = '📨 CITATORIO DE PRUEBA\n\nTexto ficticio sin datos de alumnos.'
  sembrar('conv-a', 'Citatorio de prueba', [
    msg('msg-1-0', 'usuario', 'Hazme un citatorio de prueba', VIEJO, { imagen: { base64: '', tipo: 'image/jpeg', nombreArchivo: 'ficticia.jpg' } }),
    msg('msg-1-1', 'asistente', DOC, VIEJO + 1, { archivo: { tipo: 'pdf', nombre: 'CITATORIO.pdf', url: 'https://x.invalid/a.pdf', urlVer: 'https://x.invalid/v.pdf' }, contenidoDocumento: DOC }),
    msg('msg-1-2', 'usuario', 'Gracias', VIEJO + 2),
    msg('msg-9-0', 'usuario', 'Mensaje de la etapa 1', T),
  ], { id: 'msg-1-1', texto: DOC, ultimoFormatoGenerado: 'pdf' }, (VIEJO + 5) * 1000 + 1)
  sembrar('conv-sin-fila', 'Sin prueba de pertenencia', [msg('msg-2-0', 'usuario', 'Anterior a LISTA-P5', VIEJO)], null, VIEJO * 1000)
  sembrar('conv-de-b', 'De otro docente', [msg('msg-3-0', 'usuario', 'Privado de B', VIEJO)], null, VIEJO * 1000)
  sembrar('conv-conflicto', 'Conflicto', [msg('msg-4-0', 'usuario', 'Texto local', VIEJO), msg('msg-4-1', 'asistente', 'Respuesta', VIEJO + 1)], null, VIEJO * 1000)
  sembrar('conv-titulada', 'Título local', [msg('msg-5-0', 'usuario', 'Hola', VIEJO)], { id: 'msg-5-0', texto: 'Hola' }, (VIEJO + 9) * 1000)
  const largos = Array.from({ length: 45 }, (_, i) => msg(`msg-6-${i}`, i % 2 ? 'asistente' : 'usuario', `Mensaje ${i}`, VIEJO + i))
  sembrar('conv-larga', 'Larga', largos, null, (VIEJO + 50) * 1000)
  sembrar('conv-solo-nueva', 'Solo etapa 1', [msg('msg-7-0', 'usuario', 'Nuevo', T)], null, T * 1000)
  almacen.set('docente-ia:conversaciones', JSON.stringify(indice))

  // Filas remotas existentes (creadas por LISTA-P5 al usar cada conversación).
  const R = Object.fromEntries(await Promise.all(['conv-a', 'conv-conflicto', 'conv-titulada', 'conv-larga', 'conv-solo-nueva'].map(async (l) => [l, await idRemoto(DOCENTE_A, l)])))
  const fila = (id: string, docente: string, extra: Fila = {}) => ({ id, docente_id: docente, titulo: 'Nueva conversación', documento_activo: null, actualizado_en: new Date(VIEJO - 60_000).toISOString(), grupo_id: 'grupo-1', ...extra })
  tablas.conversaciones_chat.push(fila(R['conv-a'], DOCENTE_A), fila(R['conv-conflicto'], DOCENTE_A), fila(R['conv-titulada'], DOCENTE_A, { titulo: 'Título remoto', documento_activo: { id: 'remoto' } }), fila(R['conv-larga'], DOCENTE_A), fila(R['conv-solo-nueva'], DOCENTE_A))
  tablas.conversaciones_chat.push(fila(await idRemoto(DOCENTE_B, 'conv-de-b'), DOCENTE_B))
  // Fila previa con contenido distinto al local (no debe sobrescribirse).
  tablas.mensajes_chat.push({ id: `${R['conv-conflicto']}:msg-4-0`, conversacion_id: R['conv-conflicto'], docente_id: DOCENTE_A, rol: 'usuario', texto: 'Texto REMOTO distinto', contenido: {}, creado_en: new Date(VIEJO).toISOString() })

  const localAntes = JSON.stringify([...almacen].filter(([k]) => k.startsWith('docente-ia:conversacion')).sort())

  // ---- 1. Primera ejecución con un fallo de red a mitad de conv-larga ----
  fallarUpsertNumero = 3 // orden más reciente primero: conv-larga lotes 1 y 2 entran, el 3 falla
  const r1 = await p.migrarHistorialLocal(DOCENTE_A)
  fallarUpsertNumero = null
  const migracion = () => JSON.parse(almacen.get(`docente-ia:migracion-historial:${DOCENTE_A}`) ?? '{}')
  const mensajes = (conv: string) => tablas.mensajes_chat.filter((m) => m.conversacion_id === conv)

  verificar(r1.migradas === 1 && r1.conflictos === 2 && r1.sinPertenencia === 2 && r1.fallidas === 1, `1a. Resultado: 1 migrada, 2 conflictos, 2 sin pertenencia, 1 fallida (${JSON.stringify(r1)})`)
  const filasA = mensajes(R['conv-a'])
  verificar(filasA.length === 3 && filasA.every((m) => m.docente_id === DOCENTE_A && String(m.id).startsWith(`${R['conv-a']}:`)), '1b. conv-a: sus 3 mensajes anteriores, con el docente y la conversación correctos')
  verificar(!filasA.some((m) => String(m.id).endsWith(':msg-9-0')) && !tablas.mensajes_chat.some((m) => String(m.id).endsWith(':msg-7-0')), '1c. Los mensajes de la etapa 1 (desde en adelante) no se tocan')
  const docA = filasA.find((m) => String(m.id).endsWith(':msg-1-1'))
  verificar(docA?.texto === DOC && (docA?.contenido as { archivo?: { nombre?: string } }).archivo?.nombre === 'CITATORIO.pdf' && (docA?.contenido as { contenidoDocumento?: string }).contenidoDocumento === DOC && docA?.creado_en === new Date(VIEJO + 1).toISOString(), '1d. Texto, archivo, documento y fecha original conservados')
  const convA = tablas.conversaciones_chat.find((c) => c.id === R['conv-a'])
  verificar(convA?.titulo === 'Citatorio de prueba' && (convA?.documento_activo as { id?: string })?.id === 'msg-1-1' && convA?.actualizado_en === new Date(VIEJO + 5).toISOString() && convA?.grupo_id === 'grupo-1', '1e. Contexto: título, documento activo y fecha local; el grupo fijado no cambia')
  verificar(!registro.some((x) => x.tabla === 'rpc' || (x.tabla === 'conversaciones_chat' && x.op === 'insert')), '1f. No se crea ninguna conversación ni se fija ningún grupo')
  verificar(mensajes(await idRemoto(DOCENTE_A, 'conv-sin-fila')).length === 0 && mensajes(await idRemoto(DOCENTE_A, 'conv-de-b')).length === 0 && !tablas.mensajes_chat.some((m) => m.texto === 'Privado de B' || m.texto === 'Anterior a LISTA-P5'), '1g. Sin pertenencia comprobada (sin fila, o fila de otro docente): nada se migra ni se atribuye')
  const previa = tablas.mensajes_chat.find((m) => m.id === `${R['conv-conflicto']}:msg-4-0`)
  verificar(previa?.texto === 'Texto REMOTO distinto' && migracion()['conv-conflicto'] === 'conflicto', '1h. Mensaje remoto existente distinto: no se sobrescribe; la conversación queda en conflicto')
  const convT = tablas.conversaciones_chat.find((c) => c.id === R['conv-titulada'])
  verificar(convT?.titulo === 'Título remoto' && (convT?.documento_activo as { id?: string })?.id === 'remoto' && migracion()['conv-titulada'] === 'conflicto' && mensajes(R['conv-titulada']).length === 1, '1i. Título y documento remotos distintos de los locales: no se pisan y la conversación queda en conflicto (no migrada)')
  verificar(registro.filter((x) => x.op === 'upsert').every((x) => x.ignorar === true && (x.filas ?? 0) <= 20), '1j. Todos los envíos ignoran existentes (nunca sobrescriben) y en lotes de 20 como máximo')
  verificar(migracion()['conv-larga'] === undefined && mensajes(R['conv-larga']).length === 40, '1k. Fallo de red a mitad (40 de 45 insertados): conv-larga NO se marca y queda pendiente')
  verificar(JSON.stringify([...almacen].filter(([k]) => k.startsWith('docente-ia:conversacion')).sort()) === localAntes, '1l. El historial local queda byte a byte igual')

  // ---- 2. Reanudación ----
  registro.length = 0
  const r2 = await p.migrarHistorialLocal(DOCENTE_A)
  verificar(r2.migradas === 1 && r2.fallidas === 0 && mensajes(R['conv-larga']).length === 45 && migracion()['conv-larga'] === 'migrada', '2a. Segunda ejecución: conv-larga completa (45 mensajes en 3 lotes)')
  const upserts2 = registro.filter((x) => x.op === 'upsert')
  verificar(upserts2.length === 3 && upserts2.every((x) => x.ignorar) && mensajes(R['conv-a']).length === 3, '2b. Solo se reintenta la conversación pendiente (sus lotes ignoran lo ya insertado); las migradas no se tocan')
  const ids = tablas.mensajes_chat.map((m) => m.id)
  verificar(ids.length === new Set(ids).size, '2c. Sin duplicados en mensajes_chat')

  // ---- 3. Idempotencia: sin trabajo pendiente, mínima red ----
  registro.length = 0
  const r3 = await p.migrarHistorialLocal(DOCENTE_A)
  verificar(r3.migradas === 0 && r3.sinPertenencia === 2 && registro.length === 0, '3a. Tercera ejecución: cero escrituras (solo la consulta única de pertenencia)')

  // ---- 4. Aislamiento por sesión ----
  sesion = DOCENTE_B
  registro.length = 0
  const r4 = await p.migrarHistorialLocal(DOCENTE_A)
  verificar(r4.migradas === 0 && registro.length === 0, '4a. Con la sesión de otro docente no se migra nada')
  sesion = DOCENTE_A

  // ---- 5. Concurrencia: el UPDATE condicional no pisa un valor nuevo ----
  const convA2 = tablas.conversaciones_chat.find((c) => c.id === R['conv-a'])!
  convA2.titulo = 'Cambiado por otro dispositivo'
  await supabase.from('conversaciones_chat').update({ titulo: 'Citatorio de prueba' }).eq('id', R['conv-a']).eq('titulo', 'Nueva conversación')
  verificar(convA2.titulo === 'Cambiado por otro dispositivo', '5a. Actualización condicional: si otro ya cambió el título, no se pisa')

  // ---- 5b. Otro dispositivo escribe el título entre la lectura y el UPDATE ----
  const localCarrera = 'conv-carrera'
  const remotoCarrera = await idRemoto(DOCENTE_A, localCarrera)
  almacen.set(`docente-ia:conversacion:${localCarrera}`, JSON.stringify({ version: 2, titulo: 'Título local', mensajes: [msg('msg-8-0', 'usuario', 'Hola', VIEJO)], documentoActivo: null, actualizadaEn: VIEJO * 1000 }))
  almacen.set('docente-ia:conversaciones', JSON.stringify([...indice, { id: localCarrera, titulo: 'Título local', actualizadaEn: VIEJO * 1000 }]))
  tablas.conversaciones_chat.push(fila(remotoCarrera, DOCENTE_A))
  antesDeUpdate = () => { tablas.conversaciones_chat.find((c) => c.id === remotoCarrera)!.titulo = 'Título de otro dispositivo' }
  const r5 = await p.migrarHistorialLocal(DOCENTE_A)
  verificar(r5.conflictos === 1 && migracion()[localCarrera] === 'conflicto' && tablas.conversaciones_chat.find((c) => c.id === remotoCarrera)?.titulo === 'Título de otro dispositivo', '5b. Cambio concurrente del título: no se pisa, se detecta al releer y la conversación queda en conflicto, no migrada')

  // ---- 6. Integración (código fuente) ----
  const { readFileSync } = await import('node:fs')
  const servicio = readFileSync('lib/asistente/AsistenteService.ts', 'utf8')
  const persistencia = readFileSync('lib/asistente/persistencia.ts', 'utf8')
  const migracionCodigo = persistencia.slice(persistencia.indexOf('// Migración del historial local anterior'))
  verificar(/AsistenteService\.iniciarMigracionHistorial\(session\.user\.id\)/.test(servicio) && /if \(this\.migracionesLanzadas\.has\(docenteId\)\) return/.test(servicio), '6a. Se lanza al iniciar o restaurar sesión, una vez por página y docente')
  verificar(!/borrar\(|escribir\(PREFIJO_CONVERSACION|guardarConversacion\(|eliminarConversacion\(|\.delete\(\)|rpc\(|fetch\(|\/api\/chat/.test(migracionCodigo), '6b. La migración no borra ni escribe el historial local, no fija grupo y no llama a la IA')
  verificar(/if \(mensaje\.creadoEn < estado\.desde\) continue/.test(persistencia) && /if \(this\.generando\) return/.test(servicio), '6c. Etapa 1 intacta (mismo filtro de mensajes nuevos y misma espera a la generación)')

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
