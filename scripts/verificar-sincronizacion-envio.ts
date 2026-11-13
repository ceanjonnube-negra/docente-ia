// scripts/verificar-sincronizacion-envio.ts
//
// Contexto al día antes de enviar a la IA (fase 3A): enviarMensaje
// sincroniza la conversación activa (sincronizarConversacion, fases 1 y
// 2) antes de decidir el camino y armar el historial. Historial remoto
// reciente, documento remoto nuevo y conversión, sincronización en curso
// y reciente, tiempo agotado y fallo de red, conversación eliminada,
// cambio de conversación durante la espera, pendientes locales, sin
// duplicados ni escrituras remotas de lo traído.
//
// Dos "dispositivos" = dos localStorage distintos con la misma cuenta.
// Sin red, sin credenciales, sin IA (Supabase y el motor de IA se
// sustituyen por dobles en memoria). Se ejecuta con
// `npx tsx scripts/verificar-sincronizacion-envio.ts`.

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
const esperar = (ms = 50) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const { supabase } = await import('../lib/supabaseClient')
  const p = await import('../lib/asistente/persistencia')
  const { MENSAJE_CONVERSACION_ELIMINADA } = await import('../lib/vinculoConversacion')

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
  ;(s.auth as Record<string, unknown>).getSession = async () => ({ data: { session: { user: { id: sesion } } }, error: null })
  s.rpc = async () => ({ data: null, error: null })
  s.from = (tabla: string) => new Consulta(tabla)

  const t = Date.now() - 100_000
  const m = (n: number, rol: Mensaje['rol'], texto: string, extra: Partial<Mensaje> = {}): Mensaje => ({ id: `msg-${t + n}-${n}-${String(n).padStart(8, 'a')}`, rol, texto, creadoEn: t + n, ...extra })
  const desdeA = (conv: string, ...mensajes: Mensaje[]) => { for (const x of mensajes) tablas.mensajes_chat.push(p.mensajeAFilaRemota(conv, DOCENTE_A, x as never) as unknown as Fila) }

  // ---- Preparación: X existe en Supabase y en la copia local de B ----
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

  // ---- Servicio con un motor de IA simulado (solo registra lo enviado) ----
  const { AsistenteService } = await import('../lib/asistente/AsistenteService')
  type Doc = { id: string; texto: string; archivosGenerados?: Record<string, unknown> } | null
  const chat = AsistenteService as unknown as {
    conversacionActivaId: string | null; mensajes: Mensaje[]; documentoActivo: Doc; generando: boolean; avisoGeneracion: string | null
    sincronizadaEn: Map<string, number>; abrirConversacion(id: string): void; enviarMensaje(texto: string): Promise<string>; actualizarDocumentoActivo(id: string, texto: string, archivo?: unknown): void
  }
  const envios: { texto: string; historial: string[]; argumentos: string }[] = []
  let historialActual: string[] = []
  const motor = {
    establecerHistorial: (mensajes: { texto: string }[]) => { historialActual = mensajes.map((x) => x.texto) },
    establecerConversacion: () => {},
    enviarTexto: async (texto: string, ...resto: unknown[]) => { envios.push({ texto, historial: historialActual, argumentos: JSON.stringify(resto) }) },
  }
  const interno = chat as unknown as Record<string, unknown>
  interno.motorTexto = motor
  interno.motor = motor
  interno.asegurarMotor = async () => {}
  interno.asegurarMotorTexto = async () => motor
  const sinDuplicados = () => new Set(chat.mensajes.map((x) => x.id)).size === chat.mensajes.length
  const vencer = () => chat.sincronizadaEn.set(X, 0) // la última sincronización ya es vieja
  const lecturasDeSync = () => lecturas.filter((l) => l.tabla === 'mensajes_chat' || l.columnas === 'id, eliminada_en').length
  const traidosEscritos = (ids: string[]) => escrituras.filter((e) => e.tabla === 'mensajes_chat').flatMap((e) => e.ids ?? []).filter((id) => ids.some((x) => id === `${X}:${x}`))

  chat.abrirConversacion(X)
  await esperar()

  // ---- 1. Historial remoto reciente antes del envío ----
  const preguntaA = m(10, 'usuario', 'Desde A: ¿qué actividades propones para mañana?')
  const respuestaA = m(11, 'asistente', 'Desde A: propongo un juego de fracciones.')
  desdeA(X, preguntaA, respuestaA)
  vencer()
  envios.length = 0
  await chat.enviarMensaje('¿Y cuánto tiempo dura?')
  verificar(envios.length === 1 && envios[0].historial.includes(respuestaA.texto) && envios[0].historial.includes(preguntaA.texto), '1a. El historial enviado a la IA ya incluye los mensajes de A')
  const ids1 = chat.mensajes.map((x) => x.id)
  verificar(ids1.indexOf(respuestaA.id) < ids1.length - 1 && chat.mensajes[chat.mensajes.length - 1].texto === '¿Y cuánto tiempo dura?' && sinDuplicados(), '1b. En pantalla: los de A antes del mensaje nuevo, sin duplicados')

  // ---- 2. Sincronización reciente: no se vuelve a consultar ----
  lecturas.length = 0
  envios.length = 0
  await chat.enviarMensaje('Otra pregunta seguida')
  verificar(envios.length === 1 && lecturasDeSync() === 0, '2a. Sincronización de hace menos de 15 s: se envía sin consultar')

  // ---- 3. Documento remoto nuevo y solicitud de conversión ----
  const DOC_VIEJO = '📨 AVISO VIEJO\n\nTexto ficticio sin datos de alumnos.'
  // Fechas reales: el documento de A es posterior al de B.
  const viejo = { ...m(20, 'asistente', DOC_VIEJO), creadoEn: Date.now() }
  chat.mensajes = [...chat.mensajes, viejo]
  chat.actualizarDocumentoActivo(viejo.id, DOC_VIEJO, { tipo: 'word', nombre: 'VIEJO.docx', url: 'https://proyecto.supabase.co/storage/v1/object/sign/documentos-generados-ia/d/VIEJO.docx?token=f' })
  desdeA(X, viejo)
  const DOC_NUEVO = '📨 AVISO NUEVO DESDE A\n\nTexto ficticio sin datos de alumnos.'
  const URL_NUEVO = 'https://proyecto.supabase.co/storage/v1/object/sign/documentos-generados-ia/d/NUEVO.pdf?token=firma'
  const nuevo = m(30, 'asistente', DOC_NUEVO, { creadoEn: Date.now() + 10, archivo: { tipo: 'pdf', nombre: 'NUEVO.pdf', url: URL_NUEVO, archivoId: 'archivo-nuevo' } })
  desdeA(X, nuevo)
  vencer()
  envios.length = 0
  await chat.enviarMensaje('Hazlo en Word')
  verificar(chat.documentoActivo?.id === nuevo.id && envios.length === 1 && envios[0].argumentos.includes('AVISO NUEVO DESDE A') && !envios[0].argumentos.includes('AVISO VIEJO'), '3a. "Hazlo en Word" convierte el documento nuevo de A, no el anterior (ni reutiliza su archivo)')
  const nuevoEnPantalla = chat.mensajes.find((x) => x.id === nuevo.id) as unknown as { archivo?: { url: string; archivoId?: string } } | undefined
  verificar(nuevoEnPantalla?.archivo?.url === URL_NUEVO && nuevoEnPantalla.archivo.archivoId === 'archivo-nuevo', '3b. Archivo, URL firmada y archivoId del documento de A intactos')

  // ---- 4. Sincronización en curso: se espera, sin consultas duplicadas ----
  chat.abrirConversacion('conv-otra')
  await esperar()
  const enCurso = m(40, 'asistente', 'Desde A: dato llegado durante la apertura')
  desdeA(X, enCurso)
  vencer()
  lecturas.length = 0
  retrasoLecturas = 30
  chat.abrirConversacion(X) // inicia la sincronización de la apertura
  envios.length = 0
  await chat.enviarMensaje('Pregunta enviada justo al abrir')
  retrasoLecturas = 0
  const lecturasAlEnviar = lecturasDeSync()
  await esperar(200)
  verificar(envios.length === 1 && envios[0].historial.includes(enCurso.texto), '4a. El envío espera la sincronización de la apertura y lleva sus mensajes')
  verificar(lecturasAlEnviar === 4 && lecturasDeSync() === 4, '4b. Una sola sincronización (3 lecturas ligeras + 1 del mensaje nuevo), sin consultas duplicadas')

  // ---- 5. Fallo de red ----
  const trasFallo = m(50, 'asistente', 'Desde A: llegará cuando vuelva la red')
  desdeA(X, trasFallo)
  vencer()
  fallarLecturas = true
  // Sin documento activo: un mensaje normal. Con documento activo, todo
  // mensaje se trata como edición o conversión de ese documento.
  const documento = chat.documentoActivo
  chat.documentoActivo = null
  envios.length = 0
  await chat.enviarMensaje('Pregunta sin red')
  chat.documentoActivo = documento
  verificar(envios.length === 1 && !envios[0].historial.includes(trasFallo.texto), '5a. Fallo de red en un mensaje normal: se envía con lo local')
  lecturas.length = 0
  envios.length = 0
  const enviado5b = await chat.enviarMensaje('Corrige el título del aviso')
  verificar(enviado5b === 'no_enviado' && !chat.mensajes.some((x) => x.texto === 'Corrige el título del aviso') && envios.length === 0 && chat.avisoGeneracion?.includes('No se pudo comprobar') === true && lecturasDeSync() > 0, '5b. Fallo de red al editar el documento activo: no se ejecuta sobre un documento sin verificar y se avisa (un fallo nunca cuenta como al día)')
  fallarLecturas = false
  envios.length = 0
  await chat.enviarMensaje('Pregunta con red')
  verificar(envios.length === 1 && envios[0].historial.includes(trasFallo.texto), '5c. Al volver la red, el siguiente envío vuelve a comprobar y lleva lo de A')

  // ---- 6. Tiempo agotado ----
  const lento = m(60, 'asistente', 'Desde A: respuesta lenta de Supabase')
  desdeA(X, lento)
  vencer()
  retrasoLecturas = 1500 // cada lectura tarda; las tres superan la espera de 2.5 s
  envios.length = 0
  chat.documentoActivo = null
  const inicio = Date.now()
  await chat.enviarMensaje('Pregunta con red lenta')
  const espera = Date.now() - inicio
  chat.documentoActivo = documento
  verificar(envios.length === 1 && !envios[0].historial.includes(lento.texto) && espera >= 2400 && espera < 3500, `6a. Tiempo agotado (${espera} ms): se envía con lo local sin bloquear más de 2.5 s`)
  envios.length = 0
  const enviado6b = await chat.enviarMensaje('Agrega una conclusión al aviso')
  verificar(enviado6b === 'no_enviado' && envios.length === 0 && chat.avisoGeneracion?.includes('No se pudo comprobar') === true, '6b. Tiempo agotado al editar el documento activo: no se ejecuta y se avisa')
  // La consulta lenta sigue en segundo plano (y pagina también lo que B
  // sube mientras tanto): se espera a que termine.
  for (let i = 0; i < 300 && (interno.sincronizacionesEnCurso as Map<string, unknown>).size > 0; i++) await esperar()
  retrasoLecturas = 0
  verificar(chat.mensajes.some((x) => x.id === lento.id) && sinDuplicados(), '6c. La sincronización tardía se aplica al llegar, sin duplicados')

  // ---- 7. Mensajes locales pendientes ----
  const pendiente = { id: 'msg-pendiente-b', rol: 'usuario' as const, texto: 'Pendiente de subir desde B', creadoEn: Date.now() }
  chat.mensajes = [...chat.mensajes, pendiente]
  const remotoMas = m(70, 'asistente', 'Desde A: otro dato')
  desdeA(X, remotoMas)
  vencer()
  envios.length = 0
  await chat.enviarMensaje('Pregunta con un pendiente')
  verificar(envios.length === 1 && envios[0].historial.includes(pendiente.texto) && envios[0].historial.includes(remotoMas.texto) && chat.mensajes.find((x) => x.id === pendiente.id)?.texto === pendiente.texto && sinDuplicados(), '7a. El pendiente local se conserva y el historial lleva lo local y lo de A')

  // ---- 8. Cambio de conversación durante la espera ----
  const durante = m(80, 'asistente', 'Desde A durante la espera')
  desdeA(X, durante)
  vencer()
  alLeer = (tabla, columnas) => { if (tabla === 'mensajes_chat' && columnas === 'id, creado_en') { alLeer = null; chat.abrirConversacion('conv-otra') } }
  envios.length = 0
  const enviado8 = await chat.enviarMensaje('Mensaje escrito para X')
  await esperar()
  verificar(enviado8 === 'otra_conversacion' && envios.length === 0 && chat.conversacionActivaId === 'conv-otra' && !chat.mensajes.some((x) => x.texto === 'Mensaje escrito para X'), '8a. Cambió de conversación durante la espera: no se envía, no aparece en otra conversación y el panel no devuelve el borrador')
  verificar(p.cargarConversacionPorId(X)!.mensajes.some((x) => x.id === durante.id), '8b. Lo traído queda en la copia local de X')

  // ---- 9. Sin escrituras remotas de lo traído ----
  await esperar(2300) // copia remota de la etapa 1 (2 s de espera)
  verificar(traidosEscritos([preguntaA.id, respuestaA.id, nuevo.id, enCurso.id, trasFallo.id, lento.id, remotoMas.id, durante.id]).length === 0, '9a. Ningún mensaje traído de A se escribe en Supabase')

  // ---- 12. Vigencia de 15 s: mensajes normales vs. documento activo ----
  chat.abrirConversacion(X)
  await esperar() // la apertura acaba de sincronizar
  const documento12 = chat.documentoActivo
  chat.documentoActivo = null
  lecturas.length = 0
  envios.length = 0
  const enviado12a = await chat.enviarMensaje('Pregunta normal recién sincronizada')
  verificar(enviado12a === 'enviado' && envios.length === 1 && lecturasDeSync() === 0, '12a. Mensaje normal dentro de los 15 s: se envía sin consultas adicionales')
  chat.documentoActivo = documento12
  const DOC_A2 = '📨 AVISO CORREGIDO EN A\n\nTexto ficticio sin datos de alumnos.'
  const a2 = m(90, 'asistente', DOC_A2, { creadoEn: Date.now() + 10 })
  desdeA(X, a2)
  lecturas.length = 0
  envios.length = 0
  const enviado12b = await chat.enviarMensaje('Hazlo en PDF')
  verificar(enviado12b === 'enviado' && lecturasDeSync() > 0 && chat.documentoActivo?.id === a2.id && envios.length === 1 && envios[0].argumentos.includes('AVISO CORREGIDO EN A') && !envios[0].argumentos.includes('AVISO NUEVO DESDE A'), '12b. Documento cambiado en A dentro de los 15 s: la conversión siempre comprueba y usa el documento de A')
  // Bloqueado y reenviado: el mensaje aparece una sola vez.
  fallarLecturas = true
  envios.length = 0
  const enviado12c = await chat.enviarMensaje('Agrega un párrafo final')
  fallarLecturas = false
  const enviado12d = await chat.enviarMensaje('Agrega un párrafo final')
  verificar(enviado12c === 'no_enviado' && enviado12d === 'enviado' && envios.length === 1 && chat.mensajes.filter((x) => x.texto === 'Agrega un párrafo final').length === 1 && sinDuplicados(), '12c. Bloqueado y reenviado: un solo mensaje y un solo envío a la IA')
  const { readFileSync: leer } = await import('node:fs')
  const panel = leer('components/Asistente/AsistentePanel.tsx', 'utf8')
  verificar(/void envio\.then\(\(resultado\) => \{\s*if \(resultado !== 'no_enviado'\) return\s*setInput\(\(actual\) => actual \|\| texto\)\s*setAdjuntosPendientes\(\(actuales\) => \(actuales\.length > 0 \? actuales : adjuntos\)\)/.test(panel), '12d. Panel: solo con "no_enviado" (misma vista) el texto y las fotos vuelven al campo, sin pisar lo escrito después; con "otra_conversacion", no')

  // ---- 10. Conversación eliminada ----
  chat.abrirConversacion(X)
  await esperar()
  tablas.conversaciones_chat.find((c) => c.id === X)!.eliminada_en = new Date().toISOString()
  vencer()
  envios.length = 0
  escrituras.length = 0
  const enviado10 = await chat.enviarMensaje('Mensaje sobre una conversación eliminada')
  verificar(enviado10 === 'no_enviado' && envios.length === 0 && chat.conversacionActivaId === null && p.cargarConversacionPorId(X) === null && chat.avisoGeneracion === MENSAJE_CONVERSACION_ELIMINADA, '10a. Eliminada en otro dispositivo: no se envía, se retira y se avisa')
  verificar(escrituras.length === 0, '10b. Cero escrituras remotas')

  // ---- 11. Alcance ----
  const { readFileSync } = await import('node:fs')
  const servicio = readFileSync('lib/asistente/AsistenteService.ts', 'utf8')
  const enviar = servicio.slice(servicio.indexOf('  async enviarMensaje('), servicio.indexOf('  private async enviarConMultiplesImagenes('))
  verificar(enviar.indexOf('this.asegurarContextoActualizado(') > 0 && enviar.indexOf('this.asegurarContextoActualizado(') < Math.min(enviar.indexOf('esVerificacionCalendarioConImagen'), enviar.indexOf('enviarConMultiplesImagenes'), enviar.indexOf('this.documentoActivo &&')), '11a. La comprobación ocurre antes de todos los caminos de envío')
  verificar(/addEventListener\('visibilitychange'[\s\S]{0,200}alVolverAPrimerPlano\(\)/.test(servicio) && !/addEventListener\('(visibilitychange|pageshow)'[\s\S]{0,200}enviarMensaje/.test(servicio), '11b. Volver a la app sincroniza por alVolverAPrimerPlano (fase 3B), sin pasar por el envío')

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
