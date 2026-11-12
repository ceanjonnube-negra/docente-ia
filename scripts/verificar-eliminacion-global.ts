// scripts/verificar-eliminacion-global.ts
//
// Etapa 3B-1 (cliente y servidor de la app): eliminar una conversación en
// todos los dispositivos. Confirmación nativa, eliminación por
// eliminar_conversacion (marca persistente), copia local retirada solo
// tras confirmación, detección en otro dispositivo, colas descartadas,
// nada revive, aislamiento por docente y /api/chat sin continuar una
// conversación eliminada.
//
// Sin red, sin credenciales, sin IA: Supabase se sustituye por un doble
// en memoria que reproduce la semántica de la migración
// 20261112000000_eliminacion_global_conversaciones (las pruebas SQL de
// esa migración están en supabase/pruebas/). Se ejecuta con
// `npx tsx scripts/verificar-eliminacion-global.ts`.

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
let confirmar = true
let confirmaciones = 0
const g = globalThis as unknown as Record<string, unknown>
g.window = {
  localStorage: { getItem: (k: string) => almacen.get(k) ?? null, setItem: (k: string, v: string) => { almacen.set(k, v) }, removeItem: (k: string) => { almacen.delete(k) } },
  addEventListener() {}, removeEventListener() {},
  confirm: () => { confirmaciones++; return confirmar },
}
g.localStorage = (g.window as { localStorage: unknown }).localStorage

type Fila = Record<string, unknown>
const DOCENTE_A = '11111111-1111-4111-8111-111111111111'
const DOCENTE_B = '22222222-2222-4222-8222-222222222222'

async function main() {
  const { supabase } = await import('../lib/supabaseClient')
  const p = await import('../lib/asistente/persistencia')

  // ---- Doble de Supabase con la semántica de la migración 3B-1 ----
  let sesion: string | null = DOCENTE_A
  let fallarRpc = false
  const tablas: Record<string, Fila[]> = { conversaciones_chat: [], mensajes_chat: [], propuestas_lista_oficial: [] }
  const llamadas: { op: string; tabla?: string; id?: string }[] = []
  const escribible = (convId: unknown) => tablas.conversaciones_chat.some((c) => c.id === convId && c.docente_id === sesion && !c.eliminada_en)
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
    is(c: string, v: null) { this.filtros.push((f) => f[c] === v || f[c] === undefined); return this }
    not(c: string, _op: 'is', v: null) { this.filtros.push((f) => f[c] !== v && f[c] !== undefined); return this }
    lt(c: string, v: string) { this.filtros.push((f) => Date.parse(String(f[c])) < Date.parse(v)); return this }
    update(c: Fila) { this.op = 'update'; this.datos = c; return this }
    insert(d: Fila) { this.op = 'insert'; this.datos = d; return this }
    upsert(d: Fila[], o: { ignoreDuplicates?: boolean }) { this.op = 'upsert'; this.datos = d; this.opciones = o ?? {}; return this }
    then(ok: (r: unknown) => unknown, ko?: (e: unknown) => unknown) { return Promise.resolve().then(() => this.ejecutar()).then(ok, ko) }
    private ejecutar() {
      const filas = tablas[this.tabla]
      const coinciden = () => filas.filter((f) => this.filtros.every((x) => x(f)))
      if (this.op === 'select') {
        let datos = coinciden().map((f) => ({ ...f })) as Fila[]
        if (this.columnas.includes('mensajes_chat(count)')) datos = datos.map((f) => ({ ...f, mensajes_chat: [{ count: tablas.mensajes_chat.filter((m) => m.conversacion_id === f.id && m.docente_id === sesion).length }] }))
        if (this.orden) { const { c, asc } = this.orden; datos.sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : 1) * (asc ? 1 : -1)) }
        datos = datos.slice(0, this.tope)
        return { data: this.unica ? (datos[0] ?? null) : datos, error: null }
      }
      llamadas.push({ op: this.op, tabla: this.tabla })
      if (this.op === 'update') {
        // Política nueva: solo filas no eliminadas.
        const afectadas = coinciden().filter((f) => this.tabla !== 'conversaciones_chat' || !f.eliminada_en)
        for (const f of afectadas) Object.assign(f, this.datos as Fila)
        return { data: afectadas.map((f) => ({ id: f.id })), error: null }
      }
      if (this.op === 'insert') {
        const d = this.datos as Fila
        if (d.docente_id !== sesion) return { data: null, error: { code: '42501', message: 'RLS' } }
        if (filas.some((f) => f.id === d.id)) return { data: null, error: { code: '23505', message: 'duplicado' } }
        filas.push({ titulo: 'Nueva conversación', documento_activo: null, actualizado_en: new Date().toISOString(), grupo_id: null, grupo_contexto_version: 1, eliminada_en: null, ...d })
        return { data: null, error: null }
      }
      const lote = this.datos as Fila[]
      for (const f of lote) if (f.docente_id !== sesion || !escribible(f.conversacion_id)) return { data: null, error: { code: '42501', message: 'new row violates row-level security policy' } }
      const ids: string[] = []
      for (const f of lote) {
        const existente = filas.find((x) => x.id === f.id)
        if (existente && this.opciones.ignoreDuplicates) continue
        if (existente) Object.assign(existente, f)
        else filas.push({ ...f })
        ids.push(String(f.id))
      }
      return { data: ids.map((id) => ({ id })), error: null }
    }
  }
  const s = supabase as unknown as Record<string, unknown>
  ;(s.auth as Record<string, unknown>).getSession = async () => ({ data: { session: sesion ? { user: { id: sesion } } : null }, error: null })
  s.rpc = async (nombre: string, args: { p_conversacion_id: string }) => {
    llamadas.push({ op: 'rpc', tabla: nombre, id: args.p_conversacion_id })
    if (nombre === 'fijar_grupo_conversacion') return { data: null, error: null }
    if (nombre !== 'eliminar_conversacion') return { data: null, error: { message: 'rpc desconocida' } }
    if (fallarRpc) return { data: null, error: { message: 'fallo simulado de red' } }
    const c = tablas.conversaciones_chat.find((f) => f.id === args.p_conversacion_id && f.docente_id === sesion)
    if (!c) return { data: { estado: 'no_encontrada' }, error: null }
    if (c.eliminada_en) return { data: { estado: 'ya_eliminada' }, error: null }
    const antes = tablas.mensajes_chat.length
    tablas.mensajes_chat = tablas.mensajes_chat.filter((m) => m.conversacion_id !== c.id)
    Object.assign(c, { eliminada_en: new Date().toISOString(), titulo: 'Conversación eliminada', documento_activo: null })
    return { data: { estado: 'eliminada', mensajes: antes - tablas.mensajes_chat.length }, error: null }
  }
  s.from = (tabla: string) => new Consulta(tabla)
  const mensajesDe = (conv: string) => tablas.mensajes_chat.filter((m) => m.conversacion_id === conv)
  const llaves = () => [...almacen.keys()].join('|')

  // ---- Conversación X creada en A (etapa 1) y descargada en B (3A) ----
  almacen = DISPOSITIVO_A
  await p.guardarMensajesRemotos('conv-a', DOCENTE_A, [])
  const t = Date.now() + 1000
  const mensajesA = [
    { id: `msg-${t}-0-aaaaaaaa`, rol: 'usuario' as const, texto: 'Mensaje ficticio', creadoEn: t },
    { id: `msg-${t + 1}-1-bbbbbbbb`, rol: 'asistente' as const, texto: 'Respuesta ficticia', creadoEn: t + 1 },
  ]
  p.guardarConversacion('conv-a', mensajesA as never, null)
  await p.asegurarConversacionRemota('conv-a', DOCENTE_A)
  await p.guardarMensajesRemotos('conv-a', DOCENTE_A, mensajesA as never)
  const X = await p.idRemotoDe(DOCENTE_A, 'conv-a')
  // Registro canónico ligado a X (en Supabase lo protege que la fila no se borra).
  tablas.propuestas_lista_oficial.push({ propuesta_id: 'prop-1', docente_id: DOCENTE_A, conversacion_id: X })
  // Otra conversación de A que no debe tocarse.
  p.guardarConversacion('conv-otra', [{ id: 'msg-1-0-cccccccc', rol: 'usuario', texto: 'Otra', creadoEn: t + 2 }] as never, null)
  await p.asegurarConversacionRemota('conv-otra', DOCENTE_A)
  await p.guardarMensajesRemotos('conv-otra', DOCENTE_A, p.cargarConversacionPorId('conv-otra')!.mensajes)
  const OTRA = await p.idRemotoDe(DOCENTE_A, 'conv-otra')
  almacen = DISPOSITIVO_B
  await p.guardarMensajesRemotos(X, DOCENTE_A, [])
  await p.descargarConversacionRemota(DOCENTE_A, X)
  // B deja un mensaje en su cola (sin enviar todavía).
  const estadoB = JSON.parse(almacen.get(`docente-ia:mensajes-remotos:${DOCENTE_A}`)!)
  estadoB.pendientes.push({ localId: X, fila: { id: `${X}:msg-cola`, conversacion_id: X, docente_id: DOCENTE_A, rol: 'usuario', texto: 'en cola', contenido: {}, creado_en: new Date().toISOString() }, huella: 'h' })
  almacen.set(`docente-ia:mensajes-remotos:${DOCENTE_A}`, JSON.stringify(estadoB))
  verificar(mensajesDe(X).length === 2 && !!p.cargarConversacionPorId(X), '0a. X existe en A y en B, con 2 mensajes remotos')

  // ---- 1. Eliminar en A desde la interfaz ----
  almacen = DISPOSITIVO_A
  const { AsistenteService } = await import('../lib/asistente/AsistenteService')
  const chat = AsistenteService as unknown as { conversacionActivaId: string | null; mensajes: unknown[]; listaConversaciones: { id: string }[]; avisoGeneracion: string | null; eliminarConversacion(id: string): void; abrirConversacion(id: string): void; refrescarConversacionesRemotas(d: string, f?: boolean): Promise<void> }
  const esperar = () => new Promise((r) => setTimeout(r, 30))
  chat.abrirConversacion('conv-a')
  confirmar = false
  llamadas.length = 0
  chat.eliminarConversacion('conv-a')
  await esperar()
  verificar(confirmaciones === 1 && !llamadas.some((l) => l.op === 'rpc') && !!p.cargarConversacionPorId('conv-a'), '1a. Confirmación nativa cancelada: no se elimina nada')
  confirmar = true
  fallarRpc = true
  chat.eliminarConversacion('conv-a')
  await esperar()
  fallarRpc = false
  verificar(!!p.cargarConversacionPorId('conv-a') && chat.conversacionActivaId === 'conv-a' && !!chat.avisoGeneracion?.includes('No se pudo eliminar') && !tablas.conversaciones_chat.find((c) => c.id === X)?.eliminada_en, '1b. Si Supabase falla: la copia local y la conversación abierta se conservan, con aviso')
  chat.eliminarConversacion('conv-a')
  await esperar()
  const convX = tablas.conversaciones_chat.find((c) => c.id === X)!
  verificar(llamadas.some((l) => l.op === 'rpc' && l.tabla === 'eliminar_conversacion' && l.id === X) && !!convX.eliminada_en && mensajesDe(X).length === 0, '1c. Se llama a eliminar_conversacion con el id remoto: marca puesta y mensajes borrados')
  verificar(!p.cargarConversacionPorId('conv-a') && chat.conversacionActivaId === null && chat.mensajes.length === 0 && !chat.listaConversaciones.some((c) => c.id === 'conv-a'), '1d. A: la copia local se retira y, como estaba abierta, se vuelve a la vista inicial')
  verificar(!llaves().includes(X) || !JSON.stringify(JSON.parse(almacen.get(`docente-ia:mensajes-remotos:${DOCENTE_A}`) ?? '{}').huellas ?? {}).includes(X), '1e. A: huellas y relación de X retiradas del dispositivo')
  verificar(tablas.conversaciones_chat.some((c) => c.id === X) && tablas.propuestas_lista_oficial.length === 1 && mensajesDe(OTRA).length === 1 && !!p.cargarConversacionPorId('conv-otra'), '1f. La fila de X persiste como marca; la propuesta de Lista Oficial y la otra conversación siguen intactas')
  verificar((await p.eliminarConversacionGlobal(DOCENTE_A, 'conv-a', X)) === 'ya_eliminada', '1g. Eliminar de nuevo: ya_eliminada, sin error')

  // ---- 2. Nada la revive desde A ----
  llamadas.length = 0
  const filasAntes = tablas.conversaciones_chat.length
  const idMotor = await p.asegurarConversacionRemota('conv-a', DOCENTE_A)
  verificar(idMotor === X && tablas.conversaciones_chat.length === filasAntes && !!convX.eliminada_en, '2a. El motor no recrea la conversación (el INSERT choca con la marca)')

  // ---- 3. Dispositivo B: la conversación desaparece ----
  almacen = DISPOSITIVO_B
  const eliminadas = await p.conversacionesLocalesEliminadas(DOCENTE_A)
  verificar(eliminadas.length === 1 && eliminadas[0].localId === X, '3a. B detecta que X fue eliminada en otro dispositivo (una consulta)')
  verificar(!(await p.conversacionesRemotasSinCopiaLocal(DOCENTE_A)).some((c) => c.id === X), '3b. La lista remota no muestra conversaciones eliminadas')
  // La cola pendiente de B se envía: RLS la rechaza → se descarta y se retira X.
  llamadas.length = 0
  await p.reintentarMensajesRemotosPendientes(DOCENTE_A)
  const colaB = JSON.parse(almacen.get(`docente-ia:mensajes-remotos:${DOCENTE_A}`)!)
  verificar(colaB.pendientes.length === 0 && !p.cargarConversacionPorId(X) && mensajesDe(X).length === 0, '3c. La cola de B se rechaza, se descarta (sin reintentos) y su copia local se retira')
  verificar(!JSON.parse(almacen.get('docente-ia:vinculos-remotos') ?? '{}')[X], '3d. B: relación local → remoto retirada')

  // B vuelve a tener la copia descargada (con su relación, como al
  // descargarla) y refresca la lista desde la interfaz.
  p.guardarConversacion(X, mensajesA as never, null)
  almacen.set('docente-ia:vinculos-remotos', JSON.stringify({ [X]: { docenteId: DOCENTE_A, remotoId: X } }))
  ;(chat as unknown as { olvidarConversacionesRemotas(): void }).olvidarConversacionesRemotas()
  chat.abrirConversacion(X)
  await chat.refrescarConversacionesRemotas(DOCENTE_A, true)
  verificar(!p.cargarConversacionPorId(X) && chat.conversacionActivaId === null && !chat.listaConversaciones.some((c) => c.id === X), '3e. Al refrescar, B retira la copia y sale de la conversación si estaba abierta')

  // ---- 4. Etapa 2 no migra una eliminada ----
  almacen = new Map()
  const viejo = Date.now() - 86_400_000
  almacen.set(`docente-ia:mensajes-remotos:${DOCENTE_A}`, JSON.stringify({ desde: Date.now(), pendientes: [], huellas: {} }))
  almacen.set('docente-ia:vinculos-remotos', JSON.stringify({ [X]: { docenteId: DOCENTE_A, remotoId: X } }))
  p.guardarConversacion(X, [{ id: 'msg-viejo', rol: 'usuario', texto: 'Antiguo', creadoEn: viejo }] as never, null)
  llamadas.length = 0
  await p.migrarHistorialLocal(DOCENTE_A)
  verificar(!llamadas.some((l) => l.op === 'upsert') && !p.cargarConversacionPorId(X), '4a. La migración no sube nada a una eliminada y retira su copia local')

  // ---- 5. Aislamiento entre docentes ----
  sesion = DOCENTE_B
  almacen = new Map()
  const resultadoB = await p.eliminarConversacionGlobal(DOCENTE_B, 'conv-cualquiera', OTRA)
  verificar(resultadoB === 'no_encontrada' && mensajesDe(OTRA).length === 1 && !tablas.conversaciones_chat.find((c) => c.id === OTRA)?.eliminada_en, '5a. Otro docente no puede eliminar una conversación ajena (no_encontrada, intacta)')
  verificar((await p.conversacionesLocalesEliminadas(DOCENTE_B)).length === 0, '5b. Otro docente no ve marcas ajenas')
  sesion = DOCENTE_A

  // ---- 6. Conversación que solo existe en Supabase (id local = remoto) ----
  almacen = new Map()
  const SOLO = '55555555-5555-4555-8555-555555555555'
  tablas.conversaciones_chat.push({ id: SOLO, docente_id: DOCENTE_A, titulo: 'Solo remota', documento_activo: null, actualizado_en: new Date().toISOString(), grupo_id: null, grupo_contexto_version: 1, eliminada_en: null })
  tablas.mensajes_chat.push({ id: `${SOLO}:m1`, conversacion_id: SOLO, docente_id: DOCENTE_A, rol: 'usuario', texto: 'x', contenido: {}, creado_en: new Date().toISOString() })
  ;(chat as unknown as { olvidarConversacionesRemotas(): void }).olvidarConversacionesRemotas()
  await chat.refrescarConversacionesRemotas(DOCENTE_A, true)
  llamadas.length = 0
  chat.eliminarConversacion(SOLO)
  await esperar()
  verificar(llamadas.some((l) => l.op === 'rpc' && l.id === SOLO) && !!tablas.conversaciones_chat.find((c) => c.id === SOLO)?.eliminada_en && !chat.listaConversaciones.some((c) => c.id === SOLO), '6a. Eliminar una conversación solo remota usa su propio id y la quita de la lista')

  // ---- 7. Servidor: /api/chat no continúa una eliminada ----
  const { leerVinculoConversacion, MENSAJE_CONVERSACION_ELIMINADA } = await import('../lib/vinculoConversacion')
  const clienteFalso = (fila: Fila | null) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: fila, error: null }) }) }) }) }) as never
  verificar((await leerVinculoConversacion(clienteFalso({ id: X, grupo_contexto_version: 1, grupo_id: 'g', eliminada_en: '2026-11-12T00:00:00Z' }), X)).estado === 'eliminada', '7a. El vínculo de una conversación eliminada es "eliminada"')
  verificar((await leerVinculoConversacion(clienteFalso({ id: X, grupo_contexto_version: 1, grupo_id: 'g', eliminada_en: null }), X)).estado === 'con_grupo', '7b. Una vigente sigue igual (con_grupo)')
  const { readFileSync } = await import('node:fs')
  const ruta = readFileSync('app/api/chat/route.ts', 'utf8')
  const posGuardia = ruta.indexOf("(await vinculoConversacionPromise).estado === 'eliminada'")
  const llamadasModelo = [...ruta.matchAll(/client\.messages\.create\(|await clasificarNivel0\(/g)].map((m) => m.index ?? 0)
  verificar(posGuardia > 0 && llamadasModelo.every((i) => i > posGuardia) && /return respuestaTexto\(MENSAJE_CONVERSACION_ELIMINADA\)/.test(ruta) && MENSAJE_CONVERSACION_ELIMINADA.includes('eliminada'), '7c. /api/chat responde el aviso antes de Nivel 0 y de cualquier llamada al modelo')

  // ---- 8. Código: sin escrituras privilegiadas ni borrados directos ----
  const servicio = readFileSync('lib/asistente/AsistenteService.ts', 'utf8')
  const persistencia = readFileSync('lib/asistente/persistencia.ts', 'utf8')
  verificar(!/\.from\('conversaciones_chat'\)\s*\.delete\(|\.from\('mensajes_chat'\)\s*\.delete\(/.test(servicio + persistencia + ruta), '8a. Ningún borrado directo de conversaciones o mensajes: solo la función')
  verificar(/window\.confirm\('¿Eliminar esta conversación\? Se eliminará en todos tus dispositivos y no se puede deshacer\.'\)/.test(servicio), '8b. Confirmación nativa antes de eliminar')
  const migracion = readFileSync('supabase/migrations/20261112000000_eliminacion_global_conversaciones.sql', 'utf8')
  const codigoMigracion = migracion.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
  verificar(!/storage\.objects|storage\.from|\.remove\(|delete from public\.(hojas_evaluacion|planeaciones|propuestas_lista_oficial|operaciones_propuesta_lista|evidencias|documentos_institucionales|correcciones_alumno)/i.test(codigoMigracion) && /delete from public\.mensajes_chat m where m\.conversacion_id = p_conversacion_id/.test(codigoMigracion), '8c. La migración no borra archivos ni registros académicos')

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
