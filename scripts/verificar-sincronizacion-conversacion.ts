// scripts/verificar-sincronizacion-conversacion.ts
//
// Sincronización de una conversación que YA tiene copia local
// (sincronizarConversacionRemota, fase 1: sin conectar al chat). Mensajes
// nuevos de otro dispositivo, conversación larga (lectura paginada),
// repetición sin duplicados, pendientes y ediciones locales intactos,
// cambios locales durante la consulta, conversación eliminada, integridad
// de archivos y documentos, cero escrituras remotas y aislamiento.
//
// Dos "dispositivos" = dos localStorage distintos con la misma cuenta.
// Sin red, sin credenciales, sin IA (Supabase se sustituye por un doble
// en memoria con RLS por docente). Se ejecuta con
// `npx tsx scripts/verificar-sincronizacion-conversacion.ts`.

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
type Mensaje = { id: string; rol: 'usuario' | 'asistente'; texto: string; creadoEn: number; [k: string]: unknown }
const DOCENTE_A = '11111111-1111-4111-8111-111111111111'
const DOCENTE_B = '22222222-2222-4222-8222-222222222222'

async function main() {
  const { supabase } = await import('../lib/supabaseClient')
  const p = await import('../lib/asistente/persistencia')

  // ---- Doble de Supabase con RLS por docente ----
  let sesion: string | null = DOCENTE_A
  const tablas: Record<string, Fila[]> = { conversaciones_chat: [], mensajes_chat: [] }
  const escrituras: { tabla: string; op: string; ids?: string[] }[] = []
  const lecturas: { tabla: string; columnas: string }[] = []
  // Se ejecuta dentro de una lectura (simula lo que pasa mientras la
  // consulta está en curso).
  let alLeer: ((tabla: string, columnas: string) => void) | null = null
  let fallarUpsert = false
  // Límite de filas por respuesta del servidor (PostgREST max-rows).
  let topeServidor = 1000
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
    not() { return this }
    lt(c: string, v: string) { this.filtros.push((f) => Date.parse(String(f[c])) < Date.parse(v)); return this }
    update(c: Fila) { this.op = 'update'; this.datos = c; return this }
    insert(d: Fila) { this.op = 'insert'; this.datos = d; return this }
    upsert(d: Fila[], o: { ignoreDuplicates?: boolean }) { this.op = 'upsert'; this.datos = d; this.opciones = o ?? {}; return this }
    then(ok: (r: unknown) => unknown, ko?: (e: unknown) => unknown) { return Promise.resolve().then(() => this.ejecutar()).then(ok, ko) }
    private ejecutar() {
      const filas = tablas[this.tabla]
      const coinciden = () => filas.filter((f) => this.filtros.every((x) => x(f)))
      if (this.op === 'select') {
        lecturas.push({ tabla: this.tabla, columnas: this.columnas })
        let datos = coinciden().map((f) => JSON.parse(JSON.stringify(f))) as Fila[]
        if (this.orden) { const { c, asc } = this.orden; datos.sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : 1) * (asc ? 1 : -1)) }
        datos = datos.slice(0, Math.min(this.tope, topeServidor))
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
        if (d.docente_id !== sesion) return { data: null, error: { code: '42501', message: 'RLS' } }
        if (filas.some((f) => f.id === d.id)) return { data: null, error: { code: '23505', message: 'duplicado' } }
        filas.push({ titulo: 'Nueva conversación', documento_activo: null, actualizado_en: new Date().toISOString(), eliminada_en: null, ...d })
        escrituras.push({ tabla: this.tabla, op: 'insert', ids: [String(d.id)] })
        return { data: null, error: null }
      }
      if (fallarUpsert) return { data: null, error: { code: 'XX000', message: 'fallo simulado de red' } }
      const ids: string[] = []
      for (const f of this.datos as Fila[]) {
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
  s.rpc = async () => ({ data: null, error: null })
  s.from = (tabla: string) => new Consulta(tabla)

  const mensajesDe = (conv: string) => tablas.mensajes_chat.filter((m) => m.conversacion_id === conv)
  const filaDe = (conv: string, m: Mensaje) => p.mensajeAFilaRemota(conv, DOCENTE_A, m as never) as unknown as Fila
  const estadoSync = () => JSON.parse(almacen.get(`docente-ia:mensajes-remotos:${DOCENTE_A}`) ?? '{}') as { pendientes: { fila: { id: string } }[]; huellas: Record<string, string>; soloInsercion?: Record<string, true> }
  const copia = (id: string) => p.cargarConversacionPorId(id)!
  const ids = (id: string) => copia(id).mensajes.map((m) => m.id)
  const sinEscrituras = () => escrituras.length === 0

  // ---- Preparación: A crea X y B la descarga (etapa 3A) ----
  almacen = DISPOSITIVO_A
  await p.guardarMensajesRemotos('conv-a', DOCENTE_A, []) // línea base de la etapa 1
  const t = Date.now() + 1000
  const m = (n: number, rol: Mensaje['rol'], texto: string, extra: Partial<Mensaje> = {}): Mensaje => ({ id: `msg-${t + n}-${n}-${String(n).padStart(8, 'a')}`, rol, texto, creadoEn: t + n, ...extra })
  const mensajesA = [m(0, 'usuario', 'Hola'), m(1, 'asistente', 'Respuesta inicial')]
  p.guardarConversacion('conv-a', mensajesA as never, null)
  await p.asegurarConversacionRemota('conv-a', DOCENTE_A)
  await p.guardarMensajesRemotos('conv-a', DOCENTE_A, mensajesA as never)
  const X = await p.idRemotoDe(DOCENTE_A, 'conv-a')
  almacen = DISPOSITIVO_B
  await p.guardarMensajesRemotos('conv-otra', DOCENTE_A, []) // línea base de la etapa 1 en B
  verificar(await p.descargarConversacionRemota(DOCENTE_A, X), '0a. Preparación: B descarga X (etapa 3A, ahora con el mapeo y registro compartidos)')
  verificar(estadoSync().soloInsercion?.[`${X}:${mensajesA[0].id}`] === true && copia(X).mensajes.length === 2, '0b. La descarga 3A sigue registrando huellas y solo inserción')

  // ---- 1. Mensajes nuevos de otro dispositivo + integridad ----
  almacen = DISPOSITIVO_A
  const DOC = '📨 AVISO DE PRUEBA\n\nTexto ficticio sin datos de alumnos.'
  const URL_FIRMADA = 'https://proyecto.supabase.co/storage/v1/object/sign/documentos-generados-ia/d/AVISO.pdf?token=firma-supabase'
  const nuevosA = [
    m(2, 'usuario', 'Redacta un aviso', { imagen: { base64: 'QUJD', tipo: 'image/jpeg', nombreArchivo: 'foto.jpg' }, imagenes: [{ base64: 'REVG', tipo: 'image/png' }, { base64: 'R0hJ', tipo: 'image/png' }] }),
    m(3, 'asistente', DOC, {
      contenidoDocumento: DOC,
      archivo: { tipo: 'pdf', nombre: 'AVISO.pdf', url: URL_FIRMADA, urlVer: URL_FIRMADA, archivoId: 'archivo-1' },
      archivos: [{ tipo: 'pdf', nombre: 'AVISO.pdf', url: URL_FIRMADA }, { tipo: 'docx', nombre: 'AVISO.docx', url: '/api/planeaciones/vista-previa-documento-word?tipoDocumento=aviso&modo=descargar' }],
    }),
  ]
  const todosA = [...mensajesA, ...nuevosA]
  p.guardarConversacion('conv-a', todosA as never, null)
  await p.guardarMensajesRemotos('conv-a', DOCENTE_A, todosA as never)
  // Una fila histórica con token en la vista previa (anterior a la corrección de seguridad).
  const conToken = m(4, 'asistente', 'Vista previa', { archivo: { tipo: 'pdf', nombre: 'P.pdf', url: '/api/planeaciones/vista-previa-documento?tipoDocumento=planeacion&token=secreto&modo=ver' } })
  tablas.mensajes_chat.push({ ...filaDe(X, conToken), contenido: { archivo: conToken.archivo } })
  verificar(mensajesDe(X).length === 5, '1a. A: X tiene 5 mensajes remotos')

  almacen = DISPOSITIVO_B
  const antesB = copia(X)
  escrituras.length = 0
  const r1 = await p.sincronizarConversacionRemota(DOCENTE_A, X)
  verificar(r1.estado === 'actualizada' && r1.nuevos.length === 3, '1b. B: actualizada con los 3 mensajes que faltaban')
  verificar(JSON.stringify(ids(X)) === JSON.stringify([...todosA.map((x) => x.id), conToken.id]), '1c. Orden por fecha, sin duplicados')
  verificar(JSON.stringify(copia(X).mensajes.slice(0, 2)) === JSON.stringify(antesB.mensajes), '1d. Los mensajes locales previos quedan idénticos')
  const doc = copia(X).mensajes.find((x) => x.id === nuevosA[1].id)!
  verificar(doc.texto === DOC && doc.contenidoDocumento === DOC && doc.archivo?.url === URL_FIRMADA && doc.archivo?.urlVer === URL_FIRMADA && (doc.archivo as { archivoId?: string }).archivoId === 'archivo-1' && doc.archivos?.length === 2 && doc.archivos?.[1].url.includes('tipoDocumento=aviso'), '1e. Documento, archivo (URL firmada intacta, archivoId) y varios archivos conservados')
  const foto = copia(X).mensajes.find((x) => x.id === nuevosA[0].id)!
  verificar(foto.imagen?.base64 === '' && foto.imagen?.nombreArchivo === 'foto.jpg' && foto.imagenes?.length === 2 && foto.imagenes.every((i) => i.base64 === ''), '1f. Fotos: solo el marcador ligero (igual que la etapa 3A)')
  const saneado = copia(X).mensajes.find((x) => x.id === conToken.id)!
  verificar(!saneado.archivo?.url.includes('token') && saneado.archivo?.url.includes('modo=ver') === true && r1.estado === 'actualizada' && !JSON.stringify(r1.nuevos).includes('secreto'), '1g. Una vista previa con token llega sin el token (copia local y resultado)')
  verificar(copia(X).documentoActivo?.id === nuevosA[1].id && copia(X).documentoActivo?.texto === DOC, '1h. El documento formal nuevo pasa a ser el documento activo')
  verificar(copia(X).titulo === antesB.titulo, '1i. El título local no cambia')
  verificar(sinEscrituras(), '1j. Cero escrituras remotas al sincronizar')
  await p.guardarMensajesRemotos(X, DOCENTE_A, copia(X).mensajes)
  verificar(sinEscrituras() && r1.estado === 'actualizada' && r1.nuevos.every((x) => estadoSync().soloInsercion?.[`${X}:${x.id}`]), '1k. Lo traído queda registrado: la etapa 1 no lo reenvía')

  // ---- 2. Sincronización repetida ----
  const guardadoAntes = almacen.get(`docente-ia:conversacion:${X}`)
  const indiceAntes = almacen.get('docente-ia:conversaciones')
  lecturas.length = 0
  const r2 = await p.sincronizarConversacionRemota(DOCENTE_A, X)
  const r3 = await p.sincronizarConversacionRemota(DOCENTE_A, X)
  verificar(r2.estado === 'sin_cambios' && r3.estado === 'sin_cambios' && copia(X).mensajes.length === 5, '2a. Repetir: sin cambios y sin duplicados')
  verificar(almacen.get(`docente-ia:conversacion:${X}`) === guardadoAntes && almacen.get('docente-ia:conversaciones') === indiceAntes, '2b. Sin novedades no se reescribe la copia local ni se reordena la lista')
  verificar(lecturas.length === 6 && lecturas.every((l) => !l.columnas.includes('texto')), '2c. Sin novedades: 3 lecturas ligeras por vez (estado + ids + página vacía final), sin textos')
  const [c1, c2] = [p.sincronizarConversacionRemota(DOCENTE_A, X), p.sincronizarConversacionRemota(DOCENTE_A, X)]
  verificar(c1 === c2 && (await c1).estado === 'sin_cambios', '2d. Dos llamadas simultáneas comparten la misma sincronización')
  verificar(sinEscrituras(), '2e. Cero escrituras remotas')

  // ---- 3. Pendientes y ediciones locales ----
  const editado = { ...copia(X).mensajes[1], texto: 'EDITADO SOLO EN B' }
  const pendiente = m(10, 'usuario', 'Pendiente de subir desde B')
  fallarUpsert = true
  const localB = [...copia(X).mensajes.map((x) => (x.id === editado.id ? editado : x)), pendiente]
  p.guardarConversacion(X, localB as never, copia(X).documentoActivo)
  await p.guardarMensajesRemotos(X, DOCENTE_A, localB as never)
  fallarUpsert = false
  const enCola = () => estadoSync().pendientes.some((q) => q.fila.id === `${X}:${pendiente.id}`)
  verificar(enCola(), '3a. Preparación: el mensaje de B quedó pendiente en la cola')
  almacen = DISPOSITIVO_A
  const intercalado = m(7, 'usuario', 'Desde A, antes del pendiente de B')
  const posterior = m(12, 'asistente', 'Desde A, después del pendiente de B')
  tablas.mensajes_chat.push(filaDe(X, intercalado), filaDe(X, posterior))
  almacen = DISPOSITIVO_B
  escrituras.length = 0
  const r4 = await p.sincronizarConversacionRemota(DOCENTE_A, X)
  const final4 = copia(X).mensajes
  verificar(r4.estado === 'actualizada' && r4.nuevos.length === 2, '3b. Llegan los 2 mensajes nuevos de A')
  verificar(final4.some((x) => x.id === pendiente.id) && enCola(), '3c. El pendiente local se conserva en la copia y en la cola')
  verificar(final4.find((x) => x.id === editado.id)?.texto === 'EDITADO SOLO EN B', '3d. La versión local editada no se sustituye por la remota')
  verificar(JSON.stringify(final4.map((x) => x.id).slice(-3)) === JSON.stringify([intercalado.id, pendiente.id, posterior.id]), '3e. Intercalado por fecha alrededor del pendiente')
  verificar(sinEscrituras(), '3f. Cero escrituras remotas')
  const desordenados = [{ id: 'b', creadoEn: 5 }, { id: 'a', creadoEn: 3 }]
  const combinado = p.combinarMensajes(desordenados, [{ id: 'c', creadoEn: 4 }, { id: 'a', creadoEn: 1 }, { id: 'c', creadoEn: 4 }])
  verificar(JSON.stringify(combinado.map((x) => x.id)) === JSON.stringify(['c', 'b', 'a']) && combinado[2] === desordenados[1], '3g. combinarMensajes: no reordena ni sustituye locales y no duplica remotos')

  // ---- 4. Cambios locales durante la consulta ----
  tablas.mensajes_chat.push(filaDe(X, m(20, 'usuario', 'Desde A durante la consulta')))
  const creadoDurante = m(21, 'usuario', 'Escrito en B mientras se consultaba')
  alLeer = (tabla, columnas) => {
    if (tabla !== 'mensajes_chat' || !columnas.includes('texto')) return
    const actual = copia(X)
    p.guardarConversacion(X, [...actual.mensajes, creadoDurante] as never, actual.documentoActivo)
  }
  const r5 = await p.sincronizarConversacionRemota(DOCENTE_A, X)
  alLeer = null
  verificar(r5.estado === 'actualizada' && ids(X).includes(creadoDurante.id) && ids(X).includes(m(20, 'usuario', '').id), '4a. Lo escrito localmente durante la consulta se conserva junto a lo remoto')
  tablas.mensajes_chat.push(filaDe(X, m(30, 'usuario', 'Otro de A')))
  alLeer = (tabla, columnas) => { if (tabla === 'mensajes_chat' && columnas.includes('texto')) p.eliminarConversacion(X) }
  const respaldo = copia(X)
  const r6 = await p.sincronizarConversacionRemota(DOCENTE_A, X)
  alLeer = null
  verificar(r6.estado === 'sin_copia_local' && p.cargarConversacionPorId(X) === null, '4b. Si la copia local se retira durante la consulta, no se recrea')
  p.guardarConversacion(X, respaldo.mensajes, respaldo.documentoActivo)
  verificar(sinEscrituras(), '4c. Cero escrituras remotas')

  // ---- 5. Conversación larga (lectura paginada) ----
  const L = '55555555-5555-4555-8555-555555555555'
  tablas.conversaciones_chat.push({ id: L, docente_id: DOCENTE_A, titulo: 'Larga', documento_activo: null, actualizado_en: new Date().toISOString(), eliminada_en: null })
  const largos = Array.from({ length: 2500 }, (_, i) => m(1000 + i, i % 2 ? 'asistente' : 'usuario', `Mensaje ${i}`))
  for (const x of largos) tablas.mensajes_chat.push(filaDe(L, x))
  // B tiene los últimos 80 de los primeros 2400, salvo uno del medio.
  const huecoId = largos[2350].id
  const localLarga = largos.slice(2320, 2400).filter((x) => x.id !== huecoId)
  p.guardarConversacion(L, localLarga as never, null)
  const vinculos = JSON.parse(almacen.get('docente-ia:vinculos-remotos') ?? '{}')
  vinculos[L] = { docenteId: DOCENTE_A, remotoId: L }
  almacen.set('docente-ia:vinculos-remotos', JSON.stringify(vinculos))
  lecturas.length = 0
  const r7 = await p.sincronizarConversacionRemota(DOCENTE_A, L)
  const paginas = lecturas.filter((l) => l.tabla === 'mensajes_chat' && l.columnas === 'id, creado_en').length
  verificar(paginas === 4, '5a. 2500 mensajes: se leen todos los ids (3 páginas + la vacía que cierra)')
  verificar(r7.estado === 'actualizada' && r7.nuevos.length === 80 && JSON.stringify(ids(L)) === JSON.stringify(largos.slice(-80).map((x) => x.id)), '5b. La copia local queda con los 80 más recientes (tope local existente)')
  verificar(lecturas.filter((l) => l.columnas.includes('texto')).length === 4, '5c. Solo se descargan completos los 80 que caben en la copia local (4 lotes de 20)')
  // Hueco en medio de la ventana: se detecta aunque haya 2500 mensajes.
  const recientes = largos.slice(-80).filter((x) => x.id !== largos[2460].id)
  p.guardarConversacion(L, recientes as never, null)
  const r8 = await p.sincronizarConversacionRemota(DOCENTE_A, L)
  verificar(r8.estado === 'actualizada' && r8.nuevos.length === 1 && r8.nuevos[0].id === largos[2460].id && ids(L).length === 80, '5d. Un faltante en medio de una conversación larga se detecta y se intercala')
  verificar(sinEscrituras(), '5e. Cero escrituras remotas')

  // ---- 5b. Servidor con un límite de filas menor que la página pedida ----
  topeServidor = 300
  const conHueco = largos.slice(-80).filter((x) => x.id !== largos[2430].id)
  p.guardarConversacion(L, conHueco as never, null)
  lecturas.length = 0
  const rTope = await p.sincronizarConversacionRemota(DOCENTE_A, L)
  const paginasTope = lecturas.filter((l) => l.tabla === 'mensajes_chat' && l.columnas === 'id, creado_en').length
  verificar(paginasTope === 10, '5f. Límite del servidor de 300 filas: 9 páginas de ids + la vacía (2500 ids leídos)')
  verificar(rTope.estado === 'actualizada' && rTope.nuevos.length === 1 && rTope.nuevos[0].id === largos[2430].id && JSON.stringify(ids(L)) === JSON.stringify(largos.slice(-80).map((x) => x.id)), '5g. Con ese límite se detecta el faltante igual que con 1000')
  topeServidor = 1000

  // ---- 5c. Ventana local de 80: pendientes, recientes y dos dispositivos ----
  // W: B tiene 10 mensajes, el último pendiente de subir; A escribe 90 más nuevos.
  const W = '66666666-6666-4666-8666-666666666666'
  tablas.conversaciones_chat.push({ id: W, docente_id: DOCENTE_A, titulo: 'Ventana', documento_activo: null, actualizado_en: new Date().toISOString(), eliminada_en: null })
  const vinculosW = JSON.parse(almacen.get('docente-ia:vinculos-remotos') ?? '{}')
  vinculosW[W] = { docenteId: DOCENTE_A, remotoId: W }
  almacen.set('docente-ia:vinculos-remotos', JSON.stringify(vinculosW))
  const deB = Array.from({ length: 10 }, (_, i) => m(5000 + i, 'usuario', `B ${i}`))
  for (const x of deB.slice(0, 9)) tablas.mensajes_chat.push(filaDe(W, x))
  p.guardarConversacion(W, deB as never, null)
  const yaEnviados = estadoSync()
  for (const x of deB.slice(0, 9)) yaEnviados.huellas[`${W}:${x.id}`] = 'enviado'
  almacen.set(`docente-ia:mensajes-remotos:${DOCENTE_A}`, JSON.stringify(yaEnviados))
  fallarUpsert = true
  await p.guardarMensajesRemotos(W, DOCENTE_A, [deB[9]] as never)
  fallarUpsert = false
  const pendienteW = `${W}:${deB[9].id}`
  const deA = Array.from({ length: 90 }, (_, i) => m(6000 + i, i % 2 ? 'asistente' : 'usuario', `A ${i}`))
  for (const x of deA) tablas.mensajes_chat.push(filaDe(W, x))
  escrituras.length = 0
  const rW = await p.sincronizarConversacionRemota(DOCENTE_A, W)
  verificar(rW.estado === 'actualizada' && JSON.stringify(ids(W)) === JSON.stringify(deA.slice(-80).map((x) => x.id)), '5h. Se conservan los 80 más recientes (los necesarios para continuar), en orden')
  verificar(estadoSync().pendientes.some((q) => q.fila.id === pendienteW) && sinEscrituras(), '5i. El pendiente que sale de la copia local sigue en la cola de salida (recorte existente)')
  await p.reintentarMensajesRemotosPendientes(DOCENTE_A)
  verificar(tablas.mensajes_chat.some((f) => f.id === pendienteW) && !estadoSync().pendientes.some((q) => q.fila.id === pendienteW), '5j. Ese pendiente se sube después: no se pierde')
  const conPendiente = p.combinarMensajes(deB, deA as never[])
  verificar(conPendiente.slice(-80).every((x, i) => x.id === deA[10 + i].id), '5k. El recorte de la combinación coincide con el de guardarConversacion')

  // Z: dos dispositivos escriben intercalado; tras sincronizar, ambas copias coinciden.
  almacen = DISPOSITIVO_A
  const zA = [m(7000, 'usuario', 'Z inicio'), m(7001, 'asistente', 'Z respuesta')]
  p.guardarConversacion('conv-z', zA as never, null)
  await p.asegurarConversacionRemota('conv-z', DOCENTE_A)
  await p.guardarMensajesRemotos('conv-z', DOCENTE_A, zA as never)
  const Z = await p.idRemotoDe(DOCENTE_A, 'conv-z')
  almacen = DISPOSITIVO_B
  await p.descargarConversacionRemota(DOCENTE_A, Z)
  const zB = [...copia(Z).mensajes, m(7010, 'usuario', 'B en medio'), m(7030, 'usuario', 'B al final')]
  p.guardarConversacion(Z, zB as never, null)
  await p.guardarMensajesRemotos(Z, DOCENTE_A, zB as never)
  almacen = DISPOSITIVO_A
  const zA2 = [...zA, m(7020, 'asistente', 'A en medio'), m(7040, 'asistente', 'A al final')]
  p.guardarConversacion('conv-z', zA2 as never, null)
  await p.guardarMensajesRemotos('conv-z', DOCENTE_A, zA2 as never)
  escrituras.length = 0
  const rZA = await p.sincronizarConversacionRemota(DOCENTE_A, 'conv-z')
  const idsA = ids('conv-z')
  almacen = DISPOSITIVO_B
  const rZB = await p.sincronizarConversacionRemota(DOCENTE_A, Z)
  const esperado = [7000, 7001, 7010, 7020, 7030, 7040].map((n) => zA2.concat(zB as never[]).find((x) => x.creadoEn === t + n)!.id)
  verificar(rZA.estado === 'actualizada' && rZB.estado === 'actualizada' && JSON.stringify(idsA) === JSON.stringify(ids(Z)) && JSON.stringify(idsA) === JSON.stringify(esperado), '5l. Dos dispositivos intercalados: ambas copias quedan iguales y en orden')
  verificar(sinEscrituras() && (await p.sincronizarConversacionRemota(DOCENTE_A, Z)).estado === 'sin_cambios', '5m. Sin escrituras y estable al repetir')

  // ---- 6. Aislamiento ----
  sesion = DOCENTE_B
  const r9 = await p.sincronizarConversacionRemota(DOCENTE_A, X)
  verificar(r9.estado === 'sin_remota' && copia(X).mensajes.length === respaldo.mensajes.length, '6a. Con la sesión de otro docente no se lee ni se cambia nada')
  sesion = DOCENTE_A
  verificar((await p.sincronizarConversacionRemota(DOCENTE_A, 'conv-inexistente')).estado === 'sin_copia_local', '6b. Sin copia local: no se descarga nada (eso es la etapa 3A)')

  // ---- 7. Conversación eliminada ----
  let retirada: string | null = null
  p.registrarAlRetirarConversacion((id) => { retirada = id })
  tablas.conversaciones_chat.find((c) => c.id === X)!.eliminada_en = new Date().toISOString()
  escrituras.length = 0
  const r10 = await p.sincronizarConversacionRemota(DOCENTE_A, X)
  verificar(r10.estado === 'eliminada' && p.cargarConversacionPorId(X) === null && retirada === X, '7a. Eliminada en otro dispositivo: se retira la copia local y se avisa (mecanismo 3B-1)')
  verificar(!enCola() && !Object.keys(estadoSync().huellas).some((h) => h.startsWith(`${X}:`)) && !p.listarConversaciones().some((c) => c.id === X), '7b. Su cola, huellas e índice local también se retiran')
  verificar(sinEscrituras(), '7c. Cero escrituras remotas')

  // ---- 8. Código ----
  const { readFileSync } = await import('node:fs')
  const fuente = readFileSync('lib/asistente/persistencia.ts', 'utf8')
  const seccion = fuente.slice(fuente.indexOf('// Sincronización de una conversación que YA tiene copia local'), fuente.indexOf('// Eliminación global (etapa 3B-1)'))
  verificar(!/\.(insert|upsert|update)\(|\.delete\(\)|\.rpc\(|fetch\(|setInterval|setTimeout/.test(seccion), '8a. La sincronización no escribe en Supabase, no llama IA ni programa sondeos')
  verificar((fuente.match(/f\.id\.slice\(prefijo\.length\), rol: f\.rol/g) ?? []).length === 1 && (fuente.match(/estado\.soloInsercion\[fila\.id\] = true/g) ?? []).length === 1, '8b. Mapeo y registro de mensajes en un solo lugar (compartidos con la 3A)')
  const servicio = readFileSync('lib/asistente/AsistenteService.ts', 'utf8')
  verificar(!servicio.includes('sincronizarConversacionRemota'), '8c. Fase 1: todavía no se llama desde el chat')

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
