// scripts/verificar-aclaracion-version.ts
//
// Experiencia de versiones (P2c): consultar lleva la vista al mensaje de
// la versión (con o sin archivo) sin que el desplazamiento automático al
// final lo anule; una aclaración guarda su contexto (acción original,
// evento vigente e ids candidatos) en su propio mensaje, y la respuesta
// inmediata ("A la versión anterior", "Al otro documento") completa la
// operación sin repetirla, solo si el documento vigente no cambió.
//
// Se ejecuta con `npx tsx scripts/verificar-aclaracion-version.ts`.

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
  // Aislamiento por docente: la sesión simulada abre la puerta de las copias locales.
  p.establecerPropietarioLocal(sesion)

  const DOC = (titulo: string, n: number) => `📨 ${titulo}\n\nTexto ficticio sin datos de alumnos. Versión ${n}.`
  const AVISO = 'AVISO DE EXCURSIÓN ESCOLAR'
  const URL_PDF = 'https://proyecto.supabase.co/storage/v1/object/sign/documentos-generados-ia/d/K1.pdf?token=firma'

  almacen = DISPOSITIVO_A
  await p.guardarMensajesRemotos('conv-base-a', DOCENTE_A, []) // línea base de la etapa 1
  const { AsistenteService } = await import('../lib/asistente/AsistenteService')
  type Doc = { id: string; texto: string } | null
  const chat = AsistenteService as unknown as {
    conversacionActivaId: string | null; mensajes: Mensaje[]; documentoActivo: Doc; archivoReutilizadoId: string | null
    sincronizadaEn: Map<string, number>; abrirConversacion(id: string): void; nuevaConversacion(): void; enviarMensaje(texto: string): Promise<string>; manejarEventoMotor(e: unknown): void; guardarInmediatamente(): void; actualizarDocumentoActivo(id: string, texto: string): void
  }
  const interno = chat as unknown as Record<string, unknown>
  let respuesta: { texto: string; archivo?: unknown; contenidoOriginal?: string } | null = null
  const llamadas: unknown[] = []
  const motor = {
    establecerHistorial: () => {},
    establecerConversacion: () => {},
    enviarTexto: async (...args: unknown[]) => {
      llamadas.push(args)
      if (!respuesta) return
      chat.manejarEventoMotor({ tipo: 'respuesta-parcial', texto: respuesta.texto })
      chat.manejarEventoMotor({ tipo: 'respuesta-final', texto: respuesta.texto, ...(respuesta.archivo ? { archivo: respuesta.archivo, archivos: [respuesta.archivo] } : {}), ...(respuesta.contenidoOriginal ? { contenidoOriginal: respuesta.contenidoOriginal } : {}) })
    },
  }
  interno.motorTexto = motor
  interno.motor = motor
  interno.asegurarMotor = async () => {}
  interno.asegurarMotorTexto = async () => motor
  const ultimo = () => chat.mensajes[chat.mensajes.length - 1]
  const pedir = async (texto: string, r: typeof respuesta = null) => {
    respuesta = r
    llamadas.length = 0
    chat.sincronizadaEn.set(chat.conversacionActivaId ?? '', Date.now())
    const resultado = await chat.enviarMensaje(texto)
    return { resultado, m: ultimo() }
  }
  const marcadores = () => chat.mensajes.filter((x) => x.restauraVersion)
  type Aclaracion = { accion?: string; version?: string; otroDocumento?: string } | undefined
  const aclaracionDe = (m: Mensaje) => m.aclaracionVersion as Aclaracion
  // Conversación con dos documentos distintos: A1, y B1 → B2 (vigente).
  const preparar = async () => {
    chat.nuevaConversacion()
    const a1 = (await pedir('Haz un aviso', { texto: DOC(AVISO, 1) })).m
    const b1 = (await pedir('Hazme otro aviso de excursión para segundo grado', { texto: DOC(AVISO, 1) })).m
    const b2 = (await pedir('Agrégale una conclusión', { texto: DOC(AVISO, 2) })).m
    return { conv: chat.conversacionActivaId!, a1, b1, b2 }
  }

  // ---- 1. Consulta: con y sin archivo, y desplazamiento ----
  chat.nuevaConversacion()
  const k1 = (await pedir('Genera directamente un PDF del aviso', { texto: 'Documento generado correctamente.', archivo: { tipo: 'pdf', nombre: 'K1.pdf', url: URL_PDF }, contenidoOriginal: DOC(AVISO, 1) })).m
  const k2 = (await pedir('Agrégale una conclusión', { texto: DOC(AVISO, 2) })).m
  const conArchivo = await pedir('Muéstrame la versión anterior')
  verificar(k2.versionDe === k1.id && !!k1.archivo && chat.archivoReutilizadoId === k1.id && chat.documentoActivo?.id === k2.id && conArchivo.m.texto.startsWith('Esta es la versión anterior') && marcadores().length === 0, '1a. Consulta de una versión con archivo (CASO 3): se resalta su mensaje; el vigente no cambia')
  const { b1: sinArchivo, b2: vigenteB } = await preparar()
  await pedir('Muéstrame la versión anterior')
  verificar(!sinArchivo.archivo && chat.archivoReutilizadoId === sinArchivo.id && chat.documentoActivo?.id === vigenteB.id, '1b. Consulta de una versión sin archivo: también se resalta su mensaje')
  const { readFileSync } = await import('node:fs')
  const panel = readFileSync('components/Asistente/AsistentePanel.tsx', 'utf8')
  const efectoFinal = panel.slice(panel.indexOf('const mensajesAlFinalRef'), panel.indexOf('[asistente.mensajes, asistente.panelAbierto, asistente.archivoReutilizadoId])'))
  verificar(/if \(mensajesAlFinalRef\.current === asistente\.mensajes\) return/.test(efectoFinal) && /if \(!asistente\.archivoReutilizadoId\) bottomRef\.current\?\.scrollIntoView/.test(efectoFinal) && /document\.getElementById\(`asistente-msg-\$\{asistente\.archivoReutilizadoId\}`\)\?\.scrollIntoView\(\{ behavior: 'smooth', block: 'center' \}\)/.test(panel), '1c. Desplazamiento: con un mensaje resaltado no se baja al final, y al apagarse el resaltado no se vuelve a bajar (los mensajes no cambiaron)')
  verificar(/resaltado=\{asistente\.archivoReutilizadoId === m\.id\}\s*\n\s*\/>/.test(panel) && /function VistaPreviaDocumento\(\{ texto, escribiendo, generandoArchivo, resaltado = false \}/.test(panel) && (panel.match(/<TarjetaDescarga\b/g) ?? []).length === 1, '1d. La vista previa de un documento sin archivo usa el mismo resaltado que la tarjeta (sin componentes nuevos)')

  // ---- 2. Aclaración seguida de "A la versión anterior" ----
  const x2 = await preparar()
  const ac2 = await pedir('Regresa al documento anterior')
  verificar(ac2.m.texto.startsWith('¿Te refieres a una versión anterior') && aclaracionDe(ac2.m)?.version === x2.b1.id && aclaracionDe(ac2.m)?.otroDocumento === x2.a1.id && aclaracionDe(ac2.m)?.accion === 'restaurar' && marcadores().length === 0, '2a. La aclaración guarda la acción original y los ids candidatos (sin títulos)')
  const r2 = await pedir('A la versión anterior')
  verificar(r2.resultado === 'enviado' && llamadas.length === 0 && r2.m.restauraVersion === x2.b1.id && chat.documentoActivo?.id === x2.b1.id, '2b. "A la versión anterior": se restaura B1 sin repetir la solicitud (sin IA)')

  // ---- 3. Aclaración seguida de "Al otro documento" ----
  const x3 = await preparar()
  await pedir('Regresa al documento anterior')
  const r3 = await pedir('Al otro documento')
  verificar(r3.m.restauraVersion === x3.a1.id && r3.m.texto.startsWith('Volví al documento anterior') && chat.documentoActivo?.id === x3.a1.id, '3a. "Al otro documento": se restaura A1 (identidad por id, aunque tenga el mismo título)')

  // ---- 4. Se conserva la acción original (consultar) ----
  const x4 = await preparar()
  const ac4 = await pedir('Muéstrame el documento anterior')
  const r4 = await pedir('La versión anterior')
  verificar(aclaracionDe(ac4.m)?.accion === 'consultar' && !r4.m.restauraVersion && chat.archivoReutilizadoId === x4.b1.id && chat.documentoActivo?.id === x4.b2.id, '4a. Una aclaración de consulta se completa como consulta (sin marcador ni cambios)')

  // ---- 5. Respuesta todavía ambigua: solo se pide la precisión que falta ----
  const x5 = await preparar()
  await pedir('Regresa al documento anterior')
  const imp = await pedir('A la versión anterior o al otro')
  verificar(imp.m.texto === '¿La versión anterior de este documento o el otro documento?' && aclaracionDe(imp.m)?.otroDocumento === x5.a1.id && marcadores().length === 0, '5a. Respuesta que nombra las dos opciones: se repite solo la precisión, con el mismo contexto')
  const r5 = await pedir('El otro documento')
  verificar(r5.m.restauraVersion === x5.a1.id, '5b. Con la precisión, se completa la operación original')

  // ---- 6. Cambio de conversación durante una aclaración ----
  const x6 = await preparar()
  await pedir('Regresa al documento anterior')
  const y6 = await preparar()
  const antesY = marcadores().length
  const enY = await pedir('A la versión anterior')
  verificar(marcadores().length === antesY && !enY.m.restauraVersion && chat.documentoActivo?.id === y6.b2.id, '6a. La respuesta en otra conversación no usa la aclaración de la primera')
  chat.abrirConversacion(x6.conv)
  await esperar()
  const deVuelta = await pedir('A la versión anterior')
  verificar(deVuelta.m.restauraVersion === x6.b1.id, '6b. Al volver, la aclaración (último mensaje, contexto vigente) se puede completar')

  // ---- 7. Cambio del documento vigente antes de responder ----
  const x7 = await preparar()
  const ac7 = await pedir('Regresa al documento anterior')
  // Llega (de otro dispositivo, con un reloj atrasado) una versión nueva B3
  // que queda antes de la aclaración: el vigente cambió aunque la
  // aclaración siga siendo el último mensaje.
  const b3 = { id: 'msg-b3', rol: 'asistente' as const, texto: DOC(AVISO, 3), creadoEn: ac7.m.creadoEn - 1, versionDe: x7.b2.id, documentoRaizId: x7.b1.id }
  chat.mensajes = [...chat.mensajes.slice(0, -1), b3, ac7.m]
  chat.actualizarDocumentoActivo(b3.id, b3.texto)
  const r7 = await pedir('A la versión anterior')
  verificar(!r7.m.restauraVersion && marcadores().length === 0 && chat.documentoActivo?.id === b3.id, '7a. Si el documento vigente cambió, la aclaración ya no es válida: no se ejecuta nada')

  // ---- 8. Respuesta no relacionada invalida la aclaración ----
  const x8 = await preparar()
  await pedir('Regresa al documento anterior')
  await pedir('Hazme un examen nuevo de fracciones', { texto: 'Claro, ¿para qué grado?' })
  const r8 = await pedir('A la versión anterior')
  verificar(!r8.m.restauraVersion && marcadores().length === 0 && chat.documentoActivo?.id === x8.b2.id, '8a. Después de otro mensaje, la aclaración antigua ya no afecta solicitudes posteriores')

  // ---- 8b. Una solicitud nueva completa no se toma como respuesta ----
  const x8b = await preparar()
  await pedir('Regresa al documento anterior')
  const conTipo = await pedir('Vuelve a la versión anterior del citatorio')
  verificar(!conTipo.m.restauraVersion && conTipo.m.texto.startsWith('El documento actual no corresponde') && chat.documentoActivo?.id === x8b.b2.id, '8b. Con un tipo nombrado no es la respuesta: se valida como solicitud nueva (aclaración por tipo)')
  await pedir('Regresa al documento anterior')
  const consultaNueva = await pedir('Muéstrame la versión anterior')
  verificar(!consultaNueva.m.restauraVersion && chat.archivoReutilizadoId === x8b.b1.id && chat.documentoActivo?.id === x8b.b2.id, '8c. Si la respuesta trae su propio verbo ("Muéstrame"), manda ese verbo: se consulta, no se restaura')

  // ---- 9. Sincronización: la aclaración viaja y se puede completar en otro dispositivo ----
  const x9 = await preparar()
  const ac9 = await pedir('Regresa al documento anterior')
  chat.guardarInmediatamente()
  await esperar(2300) // copia remota de la etapa 1
  const remoto9 = await p.idRemotoDe(DOCENTE_A, x9.conv)
  chat.nuevaConversacion()
  almacen = DISPOSITIVO_B
  await p.guardarMensajesRemotos('conv-base-b', DOCENTE_A, [])
  await p.descargarConversacionRemota(DOCENTE_A, remoto9)
  const enB = p.cargarConversacionPorId(remoto9)!
  verificar(enB.mensajes.find((x) => x.id === ac9.m.id)?.aclaracionVersion?.otroDocumento === x9.a1.id, '9a. La aclaración llega al otro dispositivo con su contexto')
  chat.abrirConversacion(remoto9)
  await esperar()
  const r9 = await pedir('Al otro documento')
  verificar(r9.m.restauraVersion === x9.a1.id && chat.documentoActivo?.id === x9.a1.id, '9b. En el otro dispositivo, "Al otro documento" completa la restauración')

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
