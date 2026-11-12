// scripts/verificar-recuperacion-remota.ts
//
// Persistencia remota, etapa 3A: recuperar y continuar en otro
// dispositivo una conversación guardada en Supabase. Lista combinada sin
// duplicados (vacías ocultas), descarga sin pisar lo local, relación
// local → remoto, continuación con el mismo id y su grupo original,
// mensajes descargados de solo inserción, título y fecha condicionales,
// ids de mensaje únicos y aislamiento por docente.
//
// Dos "dispositivos" = dos localStorage distintos con la misma cuenta.
// Sin red, sin credenciales, sin IA (Supabase se sustituye por un doble
// en memoria con RLS por docente). Se ejecuta con
// `npx tsx scripts/verificar-recuperacion-remota.ts`.

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
const DOCENTE_A = '11111111-1111-4111-8111-111111111111'
const DOCENTE_B = '22222222-2222-4222-8222-222222222222'

async function main() {
  const { supabase } = await import('../lib/supabaseClient')
  const p = await import('../lib/asistente/persistencia')

  // ---- Doble de Supabase con RLS por docente ----
  let sesion: string | null = DOCENTE_A
  const grupoActivo: Record<string, string> = { [DOCENTE_A]: 'grupo-1', [DOCENTE_B]: 'grupo-b' }
  const tablas: Record<string, Fila[]> = { conversaciones_chat: [], mensajes_chat: [] }
  const escrituras: { tabla: string; op: string; ids?: string[] }[] = []
  let fallarLecturaMensajes = false
  class Consulta {
    private filtros: ((f: Fila) => boolean)[] = [(f) => f.docente_id === sesion]
    private op = 'select'
    private datos: unknown = null
    private columnas = ''
    private opciones: { ignoreDuplicates?: boolean } = {}
    private unica = false
    private orden: { c: string; asc: boolean } | null = null
    private tope = Infinity
    constructor(private tabla: string) {}
    select(c = '') { if (this.op === 'select') this.columnas = c; return this }
    maybeSingle() { this.unica = true; return this }
    order(c: string, o: { ascending: boolean }) { this.orden = { c, asc: o.ascending }; return this }
    limit(n: number) { this.tope = n; return this }
    in(c: string, v: unknown[]) { this.filtros.push((f) => v.includes(f[c])); return this }
    eq(c: string, v: unknown) { this.filtros.push((f) => f[c] === v); return this }
    is(c: string, v: null) { this.filtros.push((f) => f[c] === v || f[c] === undefined); return this }
    lt(c: string, v: string) { this.filtros.push((f) => Date.parse(String(f[c])) < Date.parse(v)); return this }
    update(c: Fila) { this.op = 'update'; this.datos = c; return this }
    insert(d: Fila) { this.op = 'insert'; this.datos = d; return this }
    upsert(d: Fila[], o: { ignoreDuplicates?: boolean }) { this.op = 'upsert'; this.datos = d; this.opciones = o ?? {}; return this }
    then(ok: (r: unknown) => unknown, ko?: (e: unknown) => unknown) { return Promise.resolve().then(() => this.ejecutar()).then(ok, ko) }
    private ejecutar() {
      const filas = tablas[this.tabla]
      const coinciden = () => filas.filter((f) => this.filtros.every((x) => x(f)))
      if (this.op === 'select') {
        if (fallarLecturaMensajes && this.tabla === 'mensajes_chat') return { data: null, error: { message: 'fallo simulado de red' } }
        let datos = coinciden().map((f) => ({ ...f })) as Fila[]
        if (this.columnas.includes('mensajes_chat(count)')) datos = datos.map((f) => ({ ...f, mensajes_chat: [{ count: tablas.mensajes_chat.filter((m) => m.conversacion_id === f.id && m.docente_id === sesion).length }] }))
        if (this.orden) { const { c, asc } = this.orden; datos.sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : 1) * (asc ? 1 : -1)) }
        datos = datos.slice(0, this.tope)
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
        if (d.docente_id !== sesion) return { data: null, error: { code: '42501', message: 'RLS' } }
        if (filas.some((f) => f.id === d.id)) return { data: null, error: { code: '23505', message: 'duplicado' } }
        filas.push({ titulo: 'Nueva conversación', documento_activo: null, actualizado_en: new Date().toISOString(), grupo_id: null, grupo_contexto_version: 1, ...d })
        escrituras.push({ tabla: this.tabla, op: 'insert', ids: [String(d.id)] })
        return { data: null, error: null }
      }
      const lote = this.datos as Fila[]
      const ids: string[] = []
      for (const f of lote) {
        if (f.docente_id !== sesion) return { data: null, error: { code: '42501', message: 'RLS' } }
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
  s.rpc = async (nombre: string, args: { p_conversacion_id: string }) => {
    // fijar_grupo_conversacion: fija el grupo activo SOLO si aún no tiene.
    const c = tablas.conversaciones_chat.find((f) => f.id === args.p_conversacion_id && f.docente_id === sesion)
    if (nombre === 'fijar_grupo_conversacion' && c && c.grupo_id == null) c.grupo_id = grupoActivo[sesion!]
    return { data: null, error: null }
  }
  s.from = (tabla: string) => new Consulta(tabla)
  const mensajesDe = (conv: string) => tablas.mensajes_chat.filter((m) => m.conversacion_id === conv)

  // ---- Dispositivo A: conversación nueva sincronizada por la etapa 1 ----
  almacen = DISPOSITIVO_A
  await p.guardarMensajesRemotos('conv-a', DOCENTE_A, []) // línea base de la etapa 1
  const t = Date.now() + 1000
  const DOC = '📨 AVISO DE PRUEBA\n\nTexto ficticio sin datos de alumnos.'
  const mensajesA = [
    { id: `msg-${t}-0-aaaaaaaa`, rol: 'usuario' as const, texto: 'Redacta un aviso de prueba', creadoEn: t, imagen: { base64: 'QUJD', tipo: 'image/jpeg', nombreArchivo: 'foto.jpg' } },
    { id: `msg-${t + 1}-1-bbbbbbbb`, rol: 'asistente' as const, texto: DOC, creadoEn: t + 1, archivo: { tipo: 'pdf', nombre: 'AVISO.pdf', url: 'https://x.invalid/a.pdf', urlVer: 'https://x.invalid/v.pdf' }, contenidoDocumento: DOC },
  ]
  p.guardarConversacion('conv-a', mensajesA as never, { id: mensajesA[1].id, texto: DOC })
  await p.asegurarConversacionRemota('conv-a', DOCENTE_A)
  await p.guardarMensajesRemotos('conv-a', DOCENTE_A, mensajesA as never)
  const X = await p.idRemotoDe(DOCENTE_A, 'conv-a')
  const convX = () => tablas.conversaciones_chat.find((c) => c.id === X)!
  verificar(mensajesDe(X).length === 2 && convX().grupo_id === 'grupo-1', '0a. A: conversación X con 2 mensajes, grupo original grupo-1')
  verificar(convX().titulo === 'AVISO DE PRUEBA' || convX().titulo === p.listarConversaciones().find((c) => c.id === 'conv-a')?.titulo, '0b. A: el título local se escribe de forma condicional en la fila remota')
  // Otras filas: una vacía de A y una con mensajes de otro docente.
  tablas.conversaciones_chat.push({ id: '33333333-3333-4333-8333-333333333333', docente_id: DOCENTE_A, titulo: 'Nueva conversación', documento_activo: null, actualizado_en: new Date().toISOString(), grupo_id: 'grupo-1', grupo_contexto_version: 1 })
  const CONV_B = '44444444-4444-4444-8444-444444444444'
  tablas.conversaciones_chat.push({ id: CONV_B, docente_id: DOCENTE_B, titulo: 'De otro docente', documento_activo: null, actualizado_en: new Date().toISOString(), grupo_id: 'grupo-b', grupo_contexto_version: 1 })
  tablas.mensajes_chat.push({ id: `${CONV_B}:msg-1`, conversacion_id: CONV_B, docente_id: DOCENTE_B, rol: 'usuario', texto: 'Privado de B', contenido: {}, creado_en: new Date().toISOString() })

  // ---- 1. Lista combinada ----
  const remotasEnA = await p.conversacionesRemotasSinCopiaLocal(DOCENTE_A)
  verificar(remotasEnA.length === 0, '1a. En A (que tiene la copia local) X no aparece duplicada')
  almacen = DISPOSITIVO_B
  const remotasEnB = await p.conversacionesRemotasSinCopiaLocal(DOCENTE_A)
  verificar(remotasEnB.length === 1 && remotasEnB[0].id === X, '1b. En B aparece solo X: la vacía se oculta y la de otro docente no se ve')
  verificar(tablas.conversaciones_chat.some((c) => c.id === '33333333-3333-4333-8333-333333333333'), '1c. La conversación vacía no se borra')
  const combinada = p.combinarConversaciones([{ id: X, titulo: 'Local', actualizadaEn: 1 }, { id: 'conv-local', titulo: 'L', actualizadaEn: 3 }], [{ id: X, titulo: 'Remota', actualizadaEn: 2 }])
  verificar(combinada.length === 2 && combinada.find((c) => c.id === X)?.titulo === 'Local' && combinada[0].id === 'conv-local', '1d. Combinar: sin duplicados, la local tiene prioridad y se ordena por fecha')

  // ---- 2. Abrir X en B ----
  escrituras.length = 0
  const ok = await p.descargarConversacionRemota(DOCENTE_A, X)
  const copia = p.cargarConversacionPorId(X)
  verificar(ok && copia?.mensajes.length === 2 && escrituras.length === 0, '2a. B descarga X: 2 mensajes y cero escrituras remotas')
  const docB = copia?.mensajes[1]
  verificar(docB?.texto === DOC && docB?.archivo?.nombre === 'AVISO.pdf' && docB?.contenidoDocumento === DOC && docB?.creadoEn === t + 1 && copia?.documentoActivo?.id === mensajesA[1].id, '2b. Texto, archivo, documento, fecha original y documento activo conservados')
  verificar(copia?.mensajes[0].imagen?.base64 === '' && copia?.mensajes[0].imagen?.nombreArchivo === 'foto.jpg', '2c. La foto llega solo como nombre (sin contenido): no se presenta como recuperable')
  verificar(JSON.parse(almacen.get('docente-ia:vinculos-remotos') ?? '{}')[X]?.remotoId === X && (await p.idRemotoDe(DOCENTE_A, X)) === X, '2d. Relación local → remoto guardada: el id remoto resuelto es X')
  escrituras.length = 0
  await p.guardarMensajesRemotos(X, DOCENTE_A, copia!.mensajes)
  verificar(escrituras.length === 0, '2e. Mensajes descargados registrados: la etapa 1 no los reenvía')
  verificar(JSON.parse(almacen.get(`docente-ia:migracion-historial:${DOCENTE_A}`) ?? '{}')[X] === 'migrada', '2f. La etapa 2 no vuelve a procesar la conversación descargada')
  p.guardarConversacion('conv-local-b', [{ id: 'm', rol: 'usuario', texto: 'Local de B', creadoEn: 1 }] as never, null)
  const antes = almacen.get('docente-ia:conversacion:conv-local-b')
  verificar((await p.descargarConversacionRemota(DOCENTE_A, X)) && almacen.get('docente-ia:conversacion:conv-local-b') === antes && p.cargarConversacionPorId(X)?.mensajes.length === 2, '2g. Descargar de nuevo no pisa ninguna copia local')

  // ---- 3. Continuar X en B: mismo id y grupo original ----
  grupoActivo[DOCENTE_A] = 'grupo-2' // el docente cambió de grupo activo
  escrituras.length = 0
  const filasAntes = tablas.conversaciones_chat.length
  const idMotor = await p.asegurarConversacionRemota(X, DOCENTE_A)
  verificar(idMotor === X && tablas.conversaciones_chat.length === filasAntes && !escrituras.some((e) => e.op === 'insert' && e.ids?.[0] !== X), '3a. El motor resuelve X: ninguna conversación remota nueva')
  verificar(convX().grupo_id === 'grupo-1', '3b. El grupo original (grupo-1) se conserva aunque el grupo activo sea otro')
  const nuevo = { id: `msg-${t + 5}-0-cccccccc`, rol: 'usuario' as const, texto: 'Continuación desde B', creadoEn: Date.now() + 5000 }
  const conNuevo = [...copia!.mensajes, nuevo]
  p.guardarConversacion(X, conNuevo, copia!.documentoActivo)
  escrituras.length = 0
  await p.guardarMensajesRemotos(X, DOCENTE_A, conNuevo)
  const enviados = escrituras.filter((e) => e.tabla === 'mensajes_chat').flatMap((e) => e.ids ?? [])
  verificar(enviados.length === 1 && enviados[0] === `${X}:${nuevo.id}` && mensajesDe(X).length === 3, '3c. Solo el mensaje nuevo se inserta, en X (3 mensajes, sin duplicados)')

  // ---- 4. Sin sobrescrituras ----
  const editados = conNuevo.map((m) => (m.id === mensajesA[1].id ? { ...m, texto: 'EDITADO EN B' } : m))
  escrituras.length = 0
  await p.guardarMensajesRemotos(X, DOCENTE_A, editados)
  verificar(!escrituras.some((e) => e.tabla === 'mensajes_chat') && mensajesDe(X).find((m) => String(m.id).endsWith(mensajesA[1].id))?.texto === DOC, '4a. Un mensaje descargado y modificado en B no sobrescribe el remoto')
  convX().titulo = 'Título puesto por A'
  const tituloLocalB = p.listarConversaciones().find((c) => c.id === X)?.titulo
  await p.guardarMensajesRemotos(X, DOCENTE_A, [...editados, { id: `msg-${t + 6}-0-dddddddd`, rol: 'usuario', texto: 'Otro', creadoEn: Date.now() + 6000 }])
  verificar(convX().titulo === 'Título puesto por A' && tituloLocalB !== 'Título puesto por A', '4b. Título cambiado por otro dispositivo: la escritura condicional no lo pisa')
  const fecha = String(convX().actualizado_en)
  convX().actualizado_en = new Date(Date.now() + 86_400_000).toISOString()
  await p.guardarMensajesRemotos(X, DOCENTE_A, [...editados, { id: `msg-${t + 7}-0-eeeeeeee`, rol: 'usuario', texto: 'Más', creadoEn: Date.now() + 7000 }])
  verificar(Date.parse(String(convX().actualizado_en)) > Date.parse(fecha) + 80_000_000, '4c. La fecha remota solo avanza (una más reciente no se retrocede)')

  // ---- 5. Aislamiento por docente ----
  sesion = DOCENTE_B
  const deB = await p.conversacionesRemotasSinCopiaLocal(DOCENTE_B)
  verificar(deB.length === 1 && deB[0].id === CONV_B, '5a. El docente B solo ve su conversación')
  verificar((await p.descargarConversacionRemota(DOCENTE_B, X)) === false && !(await p.conversacionesRemotasSinCopiaLocal(DOCENTE_A)).length, '5b. B no puede descargar ni listar las de A')
  verificar((await p.idRemotoDe(DOCENTE_B, X)) !== X, '5c. La relación de A no aplica a otro docente')
  sesion = DOCENTE_A

  const { readFileSync } = await import('node:fs')

  // ---- 6. AsistenteService: lista, apertura e ids únicos ----
  almacen = new Map()
  const { AsistenteService } = await import('../lib/asistente/AsistenteService')
  const chat = AsistenteService as unknown as { listaConversaciones: { id: string }[]; conversacionActivaId: string | null; mensajes: { id: string; texto: string }[]; refrescarConversacionesRemotas(d: string, f?: boolean): Promise<void>; abrirConversacion(id: string): void; manejarEventoMotor(e: unknown): void; olvidarConversacionesRemotas(): void }
  await chat.refrescarConversacionesRemotas(DOCENTE_A, true)
  verificar(chat.listaConversaciones.some((c) => c.id === X), '6a. Dispositivo nuevo: X aparece en la barra lateral')
  chat.abrirConversacion(X)
  await new Promise((r) => setTimeout(r, 50))
  verificar(chat.conversacionActivaId === X && chat.mensajes.length >= 3 && chat.listaConversaciones.filter((c) => c.id === X).length === 1, '6b. Al tocarla se descarga y se abre, sin duplicarse en la lista')
  chat.manejarEventoMotor({ tipo: 'mensaje-usuario', texto: 'Uno' })
  chat.manejarEventoMotor({ tipo: 'mensaje-usuario', texto: 'Dos' })
  const ids = chat.mensajes.slice(-2).map((m) => m.id)
  verificar(ids.every((id) => /^msg-\d+-\d+-[0-9a-z]{8}$/.test(id)) && ids[0] !== ids[1], '6c. Ids nuevos con sufijo aleatorio, únicos')
  chat.olvidarConversacionesRemotas()
  await chat.refrescarConversacionesRemotas(DOCENTE_B, true)
  verificar(!chat.listaConversaciones.some((c) => c.id === CONV_B), '6d. Con la sesión de A, pedir la lista de B no muestra nada de B')

  // ---- 8. Apertura remota fallida: conserva la conversación y no genera nada ----
  const chat8 = AsistenteService as unknown as { conversacionActivaId: string | null; mensajes: { id: string }[]; avisoGeneracion: string | null; ultimoIntentoEdicion: unknown; editandoDocumentoId: string | null; refrescarConversacionesRemotas(d: string, f?: boolean): Promise<void>; abrirConversacion(id: string): void; reintentarGeneracion(): Promise<void> }
  almacen = new Map()
  sesion = DOCENTE_A
  await chat8.refrescarConversacionesRemotas(DOCENTE_A, true)
  p.guardarConversacion('conv-actual', [{ id: 'm1', rol: 'usuario', texto: 'Conversación abierta', creadoEn: 1 }] as never, null)
  chat8.conversacionActivaId = 'conv-actual'
  chat8.mensajes = [{ id: 'm1', rol: 'usuario', texto: 'Conversación abierta', creadoEn: 1 }] as never
  const intentoPendiente = { idDocumento: 'doc-x', textoParaModelo: 'algo', finalizarArchivo: { tipo: 'pdf', documentoTexto: 'x' } }
  chat8.ultimoIntentoEdicion = intentoPendiente
  fallarLecturaMensajes = true
  chat8.abrirConversacion(X)
  await new Promise((r) => setTimeout(r, 50))
  fallarLecturaMensajes = false
  verificar(chat8.conversacionActivaId === 'conv-actual' && chat8.mensajes.length === 1 && !!chat8.avisoGeneracion?.includes('No se pudo abrir la conversación'), '8a. Fallo al abrir una remota: se conserva la conversación anterior y se muestra el error')
  await chat8.reintentarGeneracion()
  verificar(chat8.avisoGeneracion === null && chat8.editandoDocumentoId === null && chat8.ultimoIntentoEdicion === intentoPendiente, '8b. Tocar ese aviso solo lo cierra: no inicia ninguna generación y no consume el intento pendiente')

  // ---- 9. Eliminar desactivado solo en Preview ----
  const { ELIMINAR_CONVERSACION_DISPONIBLE } = await import('../lib/asistente/AsistenteService')
  const { execFileSync } = await import('node:child_process')
  const disponibleCon = (entorno: Record<string, string>) => execFileSync('npx', ['tsx', '-e', "import('./lib/asistente/AsistenteService').then((m) => { console.log('DISPONIBLE=' + m.ELIMINAR_CONVERSACION_DISPONIBLE); process.exit(0) })"], { env: { ...process.env, ...entorno }, encoding: 'utf8' })
  const enPreviewOtraRama = disponibleCon({ NEXT_PUBLIC_VERCEL_ENV: 'preview', NEXT_PUBLIC_VERCEL_GIT_COMMIT_REF: 'otra-rama' })
  const enPreviewEstaRama = disponibleCon({ NEXT_PUBLIC_VERCEL_ENV: 'preview', NEXT_PUBLIC_VERCEL_GIT_COMMIT_REF: 'fix/chat-documento-nuevo-contextual' })
  const enProduction = disponibleCon({ NEXT_PUBLIC_VERCEL_ENV: 'production' })
  verificar(enPreviewOtraRama.includes('DISPONIBLE=false') && enPreviewEstaRama.includes('DISPONIBLE=true') && enProduction.includes('DISPONIBLE=true') && ELIMINAR_CONVERSACION_DISPONIBLE === true, '9a. Eliminar: solo en las Previews de la rama con eliminación global (3B-1); desactivado en Previews de otras ramas; disponible en Production y en local')
  const servicio9 = readFileSync('lib/asistente/AsistenteService.ts', 'utf8')
  const panel9 = readFileSync('components/Asistente/AsistentePanel.tsx', 'utf8')
  verificar(/eliminarConversacion\(id: string\) \{\s*\n\s*if \(!ELIMINAR_CONVERSACION_DISPONIBLE\) return/.test(servicio9) && /\{ELIMINAR_CONVERSACION_DISPONIBLE && \(\s*\n\s*<button\s*\n\s*onClick=\{\(e\) => \{ e\.stopPropagation\(\); asistente\.eliminarConversacion\(c\.id\) \}\}/.test(panel9), '9b. Donde no está disponible, el botón no se muestra y la acción no hace nada; sin avisos ni ocultamiento local')

  // ---- 7. Integración (código fuente) ----
  const servicio = readFileSync('lib/asistente/AsistenteService.ts', 'utf8')
  const persistencia = readFileSync('lib/asistente/persistencia.ts', 'utf8')
  verificar(!/idConversacionRemota\(docenteId, localId\)/.test(persistencia.replace(/: idConversacionRemota\(docenteId, localId\)/, '')), '7a. Etapas 1 y 2 y el motor resuelven el id con idRemotoDe')
  // Desde la etapa 3B-1 Eliminar es global (ver verificar-eliminacion-global.ts):
  // pasa por eliminarConversacionGlobal y nunca borra filas directamente.
  verificar(/void this\.eliminarConversacionEnTodos\(id\)/.test(servicio) && !/\.delete\(\)/.test(servicio + persistencia.slice(persistencia.indexOf('// Recuperación entre dispositivos'))), '7b. Eliminar pasa por la eliminación global (3B-1), sin borrar filas directamente')
  verificar(!/fetch\(|\/api\/chat|messages\.create/.test(persistencia.slice(persistencia.indexOf('// Recuperación entre dispositivos'))), '7c. Sin llamadas de IA')

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
