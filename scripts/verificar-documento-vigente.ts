// scripts/verificar-documento-vigente.ts
//
// Documento vigente entre dispositivos (continuidad, P1): un documento
// entregado directo como archivo (CASO 3) guarda su texto real en
// contenidoDocumento junto al archivo; contenidoDocumentoDe y
// documentoVigente (persistencia.ts) lo reconocen como documento, igual
// que a los documentos formales de siempre. Se comprueba en la descarga
// (3A), la sincronización (fase 1), la apertura, el envío (3A), el regreso
// (3B) y durante una respuesta en curso (fase 2).
//
// Dos "dispositivos" = dos localStorage distintos con la misma cuenta.
// Sin red, sin credenciales, sin IA. Se ejecuta con
// `npx tsx scripts/verificar-documento-vigente.ts`.

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
  const sesionVigente = true
  ;(s.auth as Record<string, unknown>).getSession = async () => ({ data: { session: sesionVigente ? { user: { id: sesion } } : null }, error: null })
  s.rpc = async () => ({ data: null, error: null })
  s.from = (tabla: string) => new Consulta(tabla)

  const t = Date.now() - 100_000
  const m = (n: number, rol: Mensaje['rol'], texto: string, extra: Partial<Mensaje> = {}): Mensaje => ({ id: `msg-${t + n}-${n}-${String(n).padStart(8, 'a')}`, rol, texto, creadoEn: t + n, ...extra })
  const desdeA = (conv: string, ...mensajes: Mensaje[]) => { for (const x of mensajes) tablas.mensajes_chat.push(p.mensajeAFilaRemota(conv, DOCENTE_A, x as never) as unknown as Fila) }
  const URL_PDF = 'https://proyecto.supabase.co/storage/v1/object/sign/documentos-generados-ia/d/CITATORIO.pdf?token=firma'
  const URL_WORD = 'https://proyecto.supabase.co/storage/v1/object/sign/documentos-generados-ia/d/EXAMEN.docx?token=firma'
  const EXAMEN = '📝 EXAMEN DE FRACCIONES\n\nPregunta 1. Texto ficticio.'
  const CITATORIO = '📨 CITATORIO A PADRES DE FAMILIA\n\nTexto ficticio sin datos de alumnos.'
  const GENERADO = 'Documento generado correctamente.'
  // Documento de siempre (texto formal), con y sin archivo; documento CASO 3.
  const formal = (n: number, texto = EXAMEN, extra: Partial<Mensaje> = {}) => m(n, 'asistente', texto, extra)
  const caso3 = (n: number, contenido = CITATORIO) => m(n, 'asistente', GENERADO, { contenidoDocumento: contenido, archivo: { tipo: 'pdf', nombre: 'CITATORIO.pdf', url: URL_PDF, archivoId: `archivo-${n}` } })

  // ---- 1. Helper compartido (sin red) ----
  const de = (x: Mensaje) => p.contenidoDocumentoDe(x as never)
  verificar(de(formal(0)) === EXAMEN, '1a. Documento formal de siempre: su texto')
  verificar(de(caso3(1)) === CITATORIO, '1b. Documento CASO 3: su contenidoDocumento, no "Documento generado correctamente."')
  verificar(de(formal(8, EXAMEN, { contenidoDocumento: 'texto anterior', archivo: { tipo: 'pdf', nombre: 'E.pdf', url: URL_PDF } })) === EXAMEN, '1b2. Si el texto visible ya es un documento formal (p. ej. editado a mano), se usa ese texto')
  verificar(de(m(2, 'asistente', 'Claro, aquí tienes algunas ideas.')) === null && de(m(3, 'usuario', EXAMEN)) === null, '1c. Mensajes normales (y del docente, aunque parezcan documento) no son documentos')
  verificar(de(m(4, 'asistente', GENERADO, { contenidoDocumento: CITATORIO })) === null, '1d. contenidoDocumento sin archivo no basta (solo el dato estructurado completo)')
  verificar(de(m(5, 'asistente', EXAMEN) as Mensaje) === EXAMEN && de(m(6, 'asistente', GENERADO)) === null, '1e. Mensajes antiguos sin metadata: se reconocen por el título como antes; el aviso suelto no es documento')
  const conWord = formal(7, EXAMEN, { archivo: { tipo: 'word', nombre: 'EXAMEN.docx', url: URL_WORD } })
  const v1 = p.documentoVigente([conWord] as never)
  verificar(v1?.id === conWord.id && v1.texto === EXAMEN && v1.ultimoFormatoGenerado === 'word' && v1.archivosGenerados === undefined, '1f. Documento con archivo generado: conserva su formato (sin reconstruir la caché de archivos)')
  const varios = [formal(10), m(11, 'usuario', 'Ahora un citatorio en PDF'), caso3(12), m(13, 'asistente', '¿Algo más?')]
  verificar(p.documentoVigente(varios as never)?.id === varios[2].id, '1g. Varios documentos: el vigente es el último (CASO 3), no el examen anterior')
  const variosB = [caso3(14), formal(15, EXAMEN.replace('FRACCIONES', 'DECIMALES'))]
  verificar(p.documentoVigente(variosB as never)?.id === variosB[1].id && p.documentoVigente([m(16, 'asistente', 'Hola')] as never) === null, '1h. Un documento formal posterior al CASO 3 lo sustituye; sin documentos, ninguno')

  // ---- 2. Recuperación desde otro dispositivo (descarga 3A) ----
  almacen = DISPOSITIVO_A
  const examenA = formal(20)
  const citatorioA = caso3(21)
  const inicialesA = [m(19, 'usuario', 'Hazme un examen'), examenA, m(22 - 1.5, 'usuario', 'Ahora un citatorio en PDF'), citatorioA]
  p.guardarConversacion('conv-a', inicialesA as never, null)
  await p.asegurarConversacionRemota('conv-a', DOCENTE_A)
  const X = await p.idRemotoDe(DOCENTE_A, 'conv-a')
  desdeA(X, ...inicialesA)
  // La columna remota guarda un documento ANTERIOR (no debe ganar).
  tablas.conversaciones_chat.find((c) => c.id === X)!.documento_activo = { id: examenA.id, texto: EXAMEN }
  almacen = DISPOSITIVO_B
  await p.guardarMensajesRemotos('conv-otra', DOCENTE_A, []) // línea base de la etapa 1 en B
  await p.descargarConversacionRemota(DOCENTE_A, X)
  const descargada = p.cargarConversacionPorId(X)!
  verificar(descargada.documentoActivo?.id === citatorioA.id && descargada.documentoActivo?.texto === CITATORIO && descargada.documentoActivo?.ultimoFormatoGenerado === 'pdf', '2a. Otro dispositivo: el activo es el citatorio CASO 3 (contenido real y formato), no el examen de la columna remota')
  const citEnB = descargada.mensajes.find((x) => x.id === citatorioA.id)!
  verificar(citEnB.archivo?.url === URL_PDF && (citEnB.archivo as { archivoId?: string }).archivoId === `archivo-21` && citEnB.contenidoDocumento === CITATORIO, '2b. El mensaje conserva identidad, archivo, archivoId y contenido')

  // ---- 3. Servicio: apertura, envío (3A), regreso (3B) y respuesta en curso (fase 2) ----
  p.guardarConversacion('conv-otra', [m(-50, 'usuario', 'Otra conversación de B')] as never, null)
  const { AsistenteService } = await import('../lib/asistente/AsistenteService')
  type Doc = { id: string; texto: string; archivosGenerados?: Record<string, unknown>; ultimoFormatoGenerado?: string } | null
  const chat = AsistenteService as unknown as {
    conversacionActivaId: string | null; mensajes: Mensaje[]; documentoActivo: Doc; generando: boolean
    sincronizadaEn: Map<string, number>; abrirConversacion(id: string): void; enviarMensaje(texto: string): Promise<string>; notificar(): void; guardarInmediatamente(): void
  }
  const interno = chat as unknown as Record<string, unknown>
  const envios: { texto: string; argumentos: string }[] = []
  const motor = {
    establecerHistorial: () => {},
    establecerConversacion: () => {},
    enviarTexto: async (texto: string, ...resto: unknown[]) => { envios.push({ texto, argumentos: JSON.stringify(resto) }) },
  }
  interno.motorTexto = motor
  interno.motor = motor
  interno.asegurarMotor = async () => {}
  interno.asegurarMotorTexto = async () => motor
  const salir = (hace = 60_000) => { documento.hidden = true; disparar('visibilitychange'); interno.ocultaDesde = Date.now() - hace }
  const volver = () => { documento.hidden = false; disparar('visibilitychange') }

  // 3a. Apertura con un documento activo guardado ANTERIOR (estado previo a esta corrección).
  p.guardarConversacion(X, descargada.mensajes, { id: examenA.id, texto: EXAMEN, archivosGenerados: { word: { tipo: 'word', nombre: 'EXAMEN.docx', url: URL_WORD } } } as never)
  chat.abrirConversacion(X)
  verificar(chat.documentoActivo?.id === citatorioA.id && chat.documentoActivo?.texto === CITATORIO, '3a. Al abrir: el activo es el último documento (CASO 3), aunque lo guardado apunte al anterior')
  await esperar()
  // 3b. Lo guardado que SÍ es el vigente se conserva tal cual (con su caché de archivos).
  chat.abrirConversacion('conv-otra')
  await esperar()
  p.guardarConversacion(X, p.cargarConversacionPorId(X)!.mensajes, { id: citatorioA.id, texto: CITATORIO, archivosGenerados: { pdf: { tipo: 'pdf', nombre: 'CITATORIO.pdf', url: URL_PDF } }, ultimoFormatoGenerado: 'pdf' } as never)
  chat.abrirConversacion(X)
  verificar(chat.documentoActivo?.id === citatorioA.id && !!chat.documentoActivo?.archivosGenerados?.pdf, '3b. Si lo guardado es el vigente, se conserva con su caché de archivos')
  await esperar()

  // 3c. Envío (3A): A genera un nuevo citatorio CASO 3; B pide "Pásalo a Word".
  const CITATORIO_2 = CITATORIO.replace('PADRES DE FAMILIA', 'TUTORES')
  const citatorio2 = caso3(30, CITATORIO_2)
  desdeA(X, citatorio2)
  chat.sincronizadaEn.set(X, 0)
  envios.length = 0
  const resultado3c = await chat.enviarMensaje('Pásalo a Word')
  verificar(resultado3c === 'enviado' && chat.documentoActivo?.id === citatorio2.id && envios.length === 1 && envios[0].argumentos.includes('TUTORES') && !envios[0].argumentos.includes('PADRES DE FAMILIA'), '3c. Sincronización antes de convertir: "Pásalo a Word" convierte el CASO 3 nuevo de A con su contenido real')

  // 3d. Regreso (3B): A genera otro documento CASO 3 mientras B está fuera.
  const CITATORIO_3 = CITATORIO.replace('PADRES DE FAMILIA', 'LA COMUNIDAD')
  const citatorio3 = caso3(40, CITATORIO_3)
  desdeA(X, citatorio3)
  salir()
  chat.sincronizadaEn.set(X, 0)
  volver()
  await esperar()
  verificar(chat.documentoActivo?.id === citatorio3.id && chat.documentoActivo?.texto === CITATORIO_3 && chat.documentoActivo?.ultimoFormatoGenerado === 'pdf', '3d. Al volver a la app: el activo pasa al CASO 3 nuevo, con contenido y formato')

  // 3e. Respuesta en curso (fase 2): llega un CASO 3 mientras B genera; se guarda como vigente y se aplica al terminar.
  const CITATORIO_4 = CITATORIO.replace('PADRES DE FAMILIA', 'DIRECTIVOS')
  const citatorio4 = caso3(50, CITATORIO_4)
  desdeA(X, citatorio4)
  salir()
  chat.sincronizadaEn.set(X, 0)
  chat.generando = true
  volver()
  await esperar()
  chat.guardarInmediatamente()
  const enEspera = chat.documentoActivo?.id
  verificar(enEspera === citatorio3.id && p.cargarConversacionPorId(X)!.documentoActivo?.id === citatorio4.id, '3e. Durante la respuesta: la pantalla no cambia y la copia local guarda el CASO 3 nuevo como vigente')
  chat.generando = false
  chat.notificar()
  verificar(chat.documentoActivo?.id === citatorio4.id && chat.documentoActivo?.texto === CITATORIO_4, '3f. Al terminar la respuesta: el activo es el CASO 3 nuevo')

  // 3g. Fase 1 directa: un formal posterior a un CASO 3 gana; mensajes normales no cambian el activo.
  const examen2 = formal(60, EXAMEN.replace('FRACCIONES', 'PORCENTAJES'))
  desdeA(X, examen2, m(61, 'asistente', 'Listo, ¿necesitas algo más?'))
  salir()
  chat.sincronizadaEn.set(X, 0)
  volver()
  await esperar()
  verificar(chat.documentoActivo?.id === examen2.id && new Set(chat.mensajes.map((x) => x.id)).size === chat.mensajes.length, '3g. Un documento formal posterior gana; un mensaje normal posterior no cambia el activo; sin duplicados')

  // ---- 4. Alcance ----
  const { readFileSync } = await import('node:fs')
  const persistencia = readFileSync('lib/asistente/persistencia.ts', 'utf8')
  const servicio = readFileSync('lib/asistente/AsistenteService.ts', 'utf8')
  verificar(!persistencia.includes('ultimoDocumentoFormal') && (persistencia.match(/documentoVigente\(/g) ?? []).length === 3 && (servicio.match(/documentoVigente\(/g) ?? []).length === 2, '4a. Un solo criterio: la descarga, la sincronización, la apertura y la incorporación usan documentoVigente')
  verificar(/actualizarDocumentoActivo\(msg\.id, evento\.contenidoOriginal \?\? msg\.texto, evento\.archivo\)/.test(servicio) && /else if \(msg && esDocumentoFormal\(msg\.texto\)\)/.test(servicio), '4b. Generación, conversión y edición sin cambios')

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
