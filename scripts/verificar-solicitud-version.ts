// scripts/verificar-solicitud-version.ts
//
// P2a: solicitudes sobre versiones anteriores de un documento ("regresa al
// documento anterior", "muéstrame cómo estaba antes", "recupera la
// primera versión"). detectarSolicitudVersion las reconoce de forma
// determinista y enviarMensaje las atiende ANTES de la conversión y la
// edición: responde sin IA, sin generar archivos y sin tocar el documento
// activo. Conversiones, ediciones y la generación directa (CASO 3)
// siguen igual.
//
// Sin red, sin credenciales, sin IA. Se ejecuta con
// `npx tsx scripts/verificar-solicitud-version.ts`.

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

  const d = await import('../lib/asistente/documentos')

  // ---- 1. Detector ----
  const casos: [string, 'restaurar' | 'consultar' | 'convertir' | 'editar' | 'ambigua' | null, string?, string?][] = [
    ['Regresa al documento anterior', 'restaurar', 'anterior'],
    ['Recupera la primera versión', 'restaurar', 'primera'],
    ['Vuelve a la versión anterior del citatorio', 'restaurar', 'anterior', 'citatorio'],
    ['Restaura el borrador original', 'restaurar', 'primera'],
    ['Déjalo como estaba antes', 'restaurar', 'anterior'],
    ['Deshaz el último cambio', 'restaurar', 'anterior'],
    ['Quédate con la versión anterior', 'restaurar', 'anterior'],
    ['Muéstrame cómo estaba antes', 'consultar', 'anterior'],
    ['Enséñame la versión anterior', 'consultar', 'anterior'],
    ['¿Cuál era la versión anterior?', 'consultar', 'anterior'],
    ['Quiero ver la primera versión', 'consultar', 'primera'],
    ['La versión anterior', 'ambigua', 'anterior'],
    ['¿Y la versión de antes?', 'ambigua', 'anterior'],
    ['Pasa la versión anterior a PDF', 'convertir', 'anterior'],
    ['Convierte el documento anterior a Word', 'convertir', 'anterior'],
    ['Convierte el citatorio anterior a PDF', 'convertir', 'anterior', 'citatorio'],
    ['Corrige la versión anterior', 'editar', 'anterior'],
    ['Corrige el documento anterior', 'editar', 'anterior'],
    ['Agrégale una conclusión al documento anterior', 'editar', 'anterior'],
    ['Regresa y muéstrame la versión anterior', 'ambigua', 'anterior'],
    ['Pásalo a Word', null],
    ['Convierte el documento a PDF', null],
    ['Convierte el documento de excursión escolar más reciente a Word, conservando toda la información y la clave MARIPOSA AZUL 47.', null],
    ['Convierte la última versión a PDF', null],
    ['Mándame el documento', null],
    ['Agrégale una conclusión', null],
    ['Hazlo más formal', null],
    ['Cambia la fecha', null],
    ['Vuelve a generar el documento', null],
    ['Regresa a la lista de alumnos', null],
    ['Genera directamente un Word con un aviso de excursión', null],
    ['Hazme un documento nuevo sobre fracciones', null],
    ['Muéstrame el documento', null],
    ['Usa un lenguaje más formal', null],
    ['Antes de convertirlo, agrega la fecha', null],
  ]
  const errores = casos.filter(([frase, accion, objetivo, tipo]) => {
    const r = d.detectarSolicitudVersion(frase)
    if (accion === null) return r !== null
    return !r || r.accion !== accion || r.objetivo !== objetivo || (tipo !== undefined && r.tipo !== tipo)
  })
  for (const [frase] of errores) console.log('   detector:', frase, JSON.stringify(d.detectarSolicitudVersion(frase)))
  verificar(errores.length === 0, `1a. Detector: ${casos.length} frases (restaurar, consultar, convertir, editar, ambiguas y negativas) clasificadas como se espera`)
  verificar(d.detectarHerramientaDocumento('Regresa al documento anterior') === 'word', '1b. Sin el detector, "Regresa al documento anterior" caería en Word (la causa sigue en FRASES_FINALIZAR_DOCUMENTO; el detector va antes)')

  // ---- 2. Enrutamiento real ----
  almacen = DISPOSITIVO_A
  await p.guardarMensajesRemotos('conv-x', DOCENTE_A, []) // línea base de la etapa 1
  const AVISO = '📨 AVISO DE EXCURSIÓN ESCOLAR\n\nTexto ficticio sin datos de alumnos.'
  const URL_WORD = 'https://proyecto.supabase.co/storage/v1/object/sign/documentos-generados-ia/d/AVISO.docx?token=firma'
  const caso3 = { id: 'msg-caso3', rol: 'asistente' as const, texto: 'Documento generado correctamente.', creadoEn: Date.now() - 5000, contenidoDocumento: AVISO, archivo: { tipo: 'word', nombre: 'AVISO.docx', url: URL_WORD, archivoId: 'archivo-1' } }
  p.guardarConversacion('conv-x', [{ id: 'msg-u0', rol: 'usuario', texto: 'Genera un aviso en Word', creadoEn: Date.now() - 6000 }, caso3] as never, { id: caso3.id, texto: AVISO, archivosGenerados: { word: caso3.archivo }, ultimoFormatoGenerado: 'word' } as never)
  const { AsistenteService } = await import('../lib/asistente/AsistenteService')
  type Doc = { id: string; texto: string; archivosGenerados?: Record<string, unknown>; ultimoFormatoGenerado?: string } | null
  const chat = AsistenteService as unknown as {
    conversacionActivaId: string | null; mensajes: Mensaje[]; documentoActivo: Doc; generando: boolean
    sincronizadaEn: Map<string, number>; abrirConversacion(id: string): void; enviarMensaje(texto: string): Promise<string>; guardarInmediatamente(): void
  }
  const interno = chat as unknown as Record<string, unknown>
  const llamadas: { texto: string; finalizar?: { tipo: string }; edicion?: boolean }[] = []
  const motor = {
    establecerHistorial: () => {},
    establecerConversacion: () => {},
    enviarTexto: async (texto: string, _adj: unknown, finalizar?: { tipo: string }, edicion?: boolean) => { llamadas.push({ texto, finalizar, edicion }) },
  }
  interno.motorTexto = motor
  interno.motor = motor
  interno.asegurarMotor = async () => {}
  interno.asegurarMotorTexto = async () => motor
  chat.abrirConversacion('conv-x')
  await esperar()
  const docAntes = JSON.stringify(chat.documentoActivo)
  const caso3Antes = JSON.stringify(chat.mensajes.find((x) => x.id === caso3.id))
  const pedir = async (texto: string) => {
    llamadas.length = 0
    interno.editandoDocumentoId = null
    interno.documentoFinalizandoId = null
    chat.sincronizadaEn.set('conv-x', Date.now())
    const antes = chat.mensajes.length
    const resultado = await chat.enviarMensaje(texto)
    return { resultado, nuevos: chat.mensajes.slice(antes) }
  }
  const sinCambios = () => JSON.stringify(chat.documentoActivo) === docAntes && JSON.stringify(chat.mensajes.find((x) => x.id === caso3.id)) === caso3Antes

  const r1 = await pedir('Regresa al documento anterior')
  verificar(r1.resultado === 'enviado' && llamadas.length === 0 && r1.nuevos.length === 2 && r1.nuevos[0].rol === 'usuario' && r1.nuevos[1].rol === 'asistente' && r1.nuevos[1].texto.startsWith('No hay una versión anterior') && !r1.nuevos[1].archivo, '2a. "Regresa al documento anterior": responde sin IA ni archivo (no se convierte a Word)')
  verificar(sinCambios(), '2b. El documento activo y el mensaje del documento no cambian')
  const r2 = await pedir('Muéstrame cómo estaba antes')
  verificar(llamadas.length === 0 && r2.nuevos[1]?.texto.startsWith('No hay una versión anterior') && sinCambios(), '2c. Consultar (P2c-3, documento sin versiones previas): responde claramente y no cambia nada')
  const r3 = await pedir('La versión anterior')
  verificar(llamadas.length === 0 && r3.nuevos[1]?.texto.includes('qué deseas hacer') && sinCambios(), '2d. Ambigua: pide identificar la versión y la intención, sin cambiar nada')
  const r4 = await pedir('Pasa la versión anterior a PDF')
  verificar(llamadas.length === 0 && !r4.nuevos.some((x) => x.archivo) && r4.nuevos[1]?.texto.includes('quieres convertir') && sinCambios(), '2e. "Pasa la versión anterior a PDF": no convierte la versión actual')

  // Caminos legítimos intactos.
  await pedir('Pásalo a PDF')
  verificar(llamadas.length === 1 && llamadas[0].finalizar?.tipo === 'pdf', '2f. "Pásalo a PDF" sigue siendo una conversión')
  const r7 = await pedir('Convierte el documento anterior a Word')
  verificar(llamadas.length === 0 && r7.nuevos.length === 2 && !r7.nuevos.some((x) => x.archivo) && r7.nuevos[1].texto.includes('quieres convertir') && sinCambios(), '2g. "Convierte el documento anterior a Word": no convierte el documento vigente ni reutiliza su archivo; pide identificar el referente')
  const r8 = await pedir('Corrige el documento anterior')
  verificar(llamadas.length === 0 && r8.nuevos.length === 2 && r8.nuevos[1].texto.includes('quieres modificar') && sinCambios(), '2g2. "Corrige el documento anterior": no edita el documento vigente; pide identificar el referente')
  await pedir('Convierte el documento a PDF')
  verificar(llamadas.length === 1 && llamadas[0].finalizar?.tipo === 'pdf', '2g3. "Convierte el documento a PDF" (sin referencia anterior) sigue siendo una conversión')
  await pedir('Convierte la última versión a PDF')
  verificar(llamadas.length === 1 && llamadas[0].finalizar?.tipo === 'pdf', '2g4. "Convierte la última versión a PDF" sigue siendo una conversión del vigente')
  await pedir('Agrégale una conclusión')
  verificar(llamadas.length === 1 && llamadas[0].edicion === true && !llamadas[0].finalizar, '2h. "Agrégale una conclusión" sigue siendo una edición')
  chat.documentoActivo = null
  await pedir('Genera directamente un Word con un aviso de excursión')
  verificar(llamadas.length === 1 && !llamadas[0].finalizar && !llamadas[0].edicion, '2i. La generación directa (CASO 3) sigue yendo al chat normal')
  const r5 = await pedir('Recupera la primera versión')
  verificar(llamadas.length === 0 && r5.nuevos.length === 2 && chat.documentoActivo === null, '2j. Sin documento activo: misma respuesta segura, sin IA y sin fijar ningún documento')

  // Respuesta en curso y persistencia.
  chat.generando = true
  const r6 = await pedir('Regresa al documento anterior')
  chat.generando = false
  verificar(r6.resultado === 'no_enviado' && r6.nuevos.length === 0, '2k. Con una respuesta en curso no se agrega nada (protección existente)')
  const respuestas = chat.mensajes.filter((x) => x.rol === 'asistente' && (x.texto.startsWith('Necesito identificar')))
  chat.guardarInmediatamente()
  await esperar(2300)
  const subidas = escrituras.filter((e) => e.tabla === 'mensajes_chat').flatMap((e) => e.ids ?? [])
  const X = await p.idRemotoDe(DOCENTE_A, 'conv-x')
  verificar(respuestas.length >= 4 && respuestas.every((x) => subidas.includes(`${X}:${x.id}`)), '2l. Las respuestas se guardan y se suben como mensajes normales (se sincronizan)')
  verificar(p.documentoVigente(chat.mensajes as never)?.id === caso3.id, '2m. Las respuestas no son documentos: el documento vigente sigue siendo el mismo')

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
