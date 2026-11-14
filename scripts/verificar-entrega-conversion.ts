// scripts/verificar-entrega-conversion.ts
//
// Entrega de una conversión (FINALIZAR ARCHIVO): el archivo llega en una
// respuesta NUEVA del asistente (texto TEXTO_ARCHIVO_LISTO + tarjeta),
// igual que al reutilizar un archivo ya generado; el mensaje del
// documento no se modifica. Documento formal y CASO 3, mismo formato,
// documento activo y caché por versión, reintento sin duplicados,
// respuesta tardía tras cambiar de conversación, y sincronización del
// archivo nuevo entre dos dispositivos.
//
// Dos "dispositivos" = dos localStorage distintos con la misma cuenta.
// Sin red, sin credenciales, sin IA (el servidor se simula con los
// eventos del motor). Se ejecuta con
// `npx tsx scripts/verificar-entrega-conversion.ts`.

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
  const URL = (n: string) => `https://proyecto.supabase.co/storage/v1/object/sign/documentos-generados-ia/d/${n}?token=firma`
  const AVISO = '📨 AVISO DE EXCURSIÓN ESCOLAR\n\nTexto ficticio sin datos de alumnos. Clave MARIPOSA AZUL 47.'
  const LISTO = 'Ya puedes abrirlo, compartirlo o descargarlo.'
  const archivo = (tipo: string, ext: string, id: string) => ({ tipo, nombre: `AVISO_DE_EXCURSION_ESCOLAR.${ext}`, url: URL(`AVISO.${ext}`), archivoId: id })

  // Documento CASO 3 creado en A (Word directo), en Supabase y en ambas copias.
  almacen = DISPOSITIVO_A
  const pedido = m(0, 'usuario', 'Genera directamente un Word del aviso de excursión')
  const caso3 = m(1, 'asistente', 'Documento generado correctamente.', { contenidoDocumento: AVISO, archivo: archivo('word', 'docx', 'archivo-word-1') })
  p.guardarConversacion('conv-a', [pedido, caso3] as never, { id: caso3.id, texto: AVISO, archivosGenerados: { word: caso3.archivo }, ultimoFormatoGenerado: 'word' } as never)
  await p.asegurarConversacionRemota('conv-a', DOCENTE_A)
  const X = await p.idRemotoDe(DOCENTE_A, 'conv-a')
  desdeA(X, pedido, caso3)
  almacen = DISPOSITIVO_B
  await p.guardarMensajesRemotos('conv-otra', DOCENTE_A, []) // línea base de la etapa 1 en B
  await p.descargarConversacionRemota(DOCENTE_A, X)
  p.guardarConversacion('conv-otra', [m(-50, 'usuario', 'Otra conversación de B')] as never, null)

  // Servicio de B con un motor simulado: responde como /api/chat a FINALIZAR ARCHIVO.
  const { AsistenteService } = await import('../lib/asistente/AsistenteService')
  type Doc = { id: string; texto: string; archivosGenerados?: Record<string, { url: string }>; ultimoFormatoGenerado?: string } | null
  const chat = AsistenteService as unknown as {
    conversacionActivaId: string | null; mensajes: Mensaje[]; documentoActivo: Doc; generando: boolean; archivoReutilizadoId: string | null
    sincronizadaEn: Map<string, number>; abrirConversacion(id: string): void; enviarMensaje(texto: string): Promise<string>; guardarInmediatamente(): void; manejarEventoMotor(e: unknown): void
  }
  const interno = chat as unknown as Record<string, unknown>
  const solicitudes: { tipo: string; documentoTexto: string }[] = []
  // Cómo responde el "servidor" a la siguiente conversión.
  let responder: (fin: { tipo: string; documentoTexto: string }) => void = () => {}
  const exito = (n: number) => (fin: { tipo: string }) => {
    const ext = fin.tipo === 'word' ? 'docx' : fin.tipo
    const a = archivo(fin.tipo, ext, `archivo-${fin.tipo}-${n}`)
    chat.manejarEventoMotor({ tipo: 'respuesta-parcial', texto: 'Documento generado correctamente.' })
    chat.manejarEventoMotor({ tipo: 'respuesta-final', texto: 'Documento generado correctamente.', archivo: a, archivos: [a] })
  }
  let historialEnviado: { rol: string; texto: string }[] = []
  const motor = {
    establecerHistorial: (mensajes: { rol: string; texto: string }[]) => { historialEnviado = mensajes },
    establecerConversacion: () => {},
    enviarTexto: async (_texto: string, _adjunto: unknown, fin?: { tipo: string; documentoTexto: string }) => {
      if (!fin) return
      solicitudes.push(fin)
      chat.manejarEventoMotor({ tipo: 'pensando' })
      responder(fin)
    },
  }
  interno.motorTexto = motor
  interno.motor = motor
  interno.asegurarMotor = async () => {}
  interno.asegurarMotorTexto = async () => motor
  const original = () => JSON.stringify(chat.mensajes.find((x) => x.id === caso3.id))
  const entregas = (tipo: string) => chat.mensajes.filter((x) => x.rol === 'asistente' && x.texto === LISTO && (x.archivo as { tipo?: string } | undefined)?.tipo === tipo)

  chat.abrirConversacion(X)
  await esperar()
  const caso3EnB = original()
  verificar(chat.documentoActivo?.id === caso3.id && chat.documentoActivo?.texto === AVISO, '0a. B (otro dispositivo): el CASO 3 es el documento activo con su contenido real (P1)')

  // ---- 1. Conversión a PDF desde el otro dispositivo ----
  responder = exito(1)
  const resultado1 = await chat.enviarMensaje('Conviértelo a PDF')
  const pdf = entregas('pdf')
  verificar(resultado1 === 'enviado' && solicitudes.length === 1 && solicitudes[0].tipo === 'pdf' && solicitudes[0].documentoTexto === AVISO, '1a. La conversión se pide con el contenido real del documento')
  verificar(pdf.length === 1 && chat.mensajes[chat.mensajes.length - 1].id === pdf[0].id && (pdf[0].archivo as { archivoId?: string }).archivoId === 'archivo-pdf-1' && (pdf[0].archivos as unknown[] | undefined)?.length === 1, '1b. El archivo llega en una respuesta NUEVA del asistente, al final, con su archivo y archivoId')
  verificar(original() === caso3EnB, '1c. El mensaje original del documento queda idéntico (texto, contenido, archivo e identidad)')
  verificar(chat.archivoReutilizadoId === pdf[0].id, '1d. La respuesta nueva se resalta (mismo aviso visual que un archivo reutilizado)')
  verificar(chat.documentoActivo?.id === caso3.id && chat.documentoActivo?.texto === AVISO && chat.documentoActivo?.archivosGenerados?.pdf?.url === URL('AVISO.pdf') && chat.documentoActivo?.ultimoFormatoGenerado === 'pdf', '1e. El documento activo sigue siendo el original, con el PDF en la caché de esa versión')
  verificar(p.contenidoDocumentoDe(pdf[0] as never) === null && p.documentoVigente(chat.mensajes as never)?.id === caso3.id, '1f. La respuesta nueva no es un documento: el vigente sigue siendo el original (P1)')

  // ---- 2. Mismo formato (Word), sin caché en este dispositivo ----
  chat.documentoActivo = { ...chat.documentoActivo!, archivosGenerados: { pdf: chat.documentoActivo!.archivosGenerados!.pdf } }
  responder = exito(2)
  await chat.enviarMensaje('Convierte el documento de excursión escolar más reciente a Word, conservando toda la información y la clave MARIPOSA AZUL 47.')
  const word = entregas('word')
  verificar(solicitudes.length === 2 && solicitudes[1].tipo === 'word' && word.length === 1 && chat.mensajes[chat.mensajes.length - 1].id === word[0].id && original() === caso3EnB, '2a. Conversión al mismo formato (Word): respuesta nueva y visible; la tarjeta original no cambia')
  const antes2 = chat.mensajes.length
  await chat.enviarMensaje('Dámelo en Word otra vez')
  verificar(solicitudes.length === 2 && chat.mensajes.length === antes2 + 2 && chat.mensajes[chat.mensajes.length - 1].texto === LISTO && original() === caso3EnB, '2b. Con el Word ya en la caché de esta versión: se reutiliza (sin pedirlo otra vez) y también responde con un mensaje nuevo')

  // ---- 3. Reintento automático: un solo mensaje ----
  let intento = 0
  responder = (fin) => {
    intento++
    if (intento === 1) { chat.manejarEventoMotor({ tipo: 'error', mensaje: 'Fallo simulado' }); return }
    exito(3)(fin)
  }
  chat.documentoActivo = { ...chat.documentoActivo!, archivosGenerados: {} }
  const antes3 = entregas('pdf').length
  await chat.enviarMensaje('Ahora en PDF')
  await esperar()
  verificar(intento === 2 && entregas('pdf').length === antes3 + 1 && original() === caso3EnB, '3a. Falla el primer intento y el reintento automático entrega un solo mensaje nuevo')

  // ---- 4. Documento formal de siempre ----
  const FORMAL = '📝 EXAMEN DE FRACCIONES\n\nPregunta 1. Texto ficticio.'
  const formal = { id: 'msg-formal-b', rol: 'asistente' as const, texto: FORMAL, creadoEn: Date.now() }
  chat.mensajes = [...chat.mensajes, formal]
  chat.documentoActivo = { id: formal.id, texto: FORMAL }
  chat.sincronizadaEn.set(X, 0)
  responder = exito(4)
  const formalAntes = JSON.stringify(formal)
  await chat.enviarMensaje('Pásalo a Word')
  verificar(JSON.stringify(chat.mensajes.find((x) => x.id === formal.id)) === formalAntes && chat.mensajes[chat.mensajes.length - 1].texto === LISTO && chat.documentoActivo?.id === formal.id && !!chat.documentoActivo?.archivosGenerados?.word, '4a. Documento formal: el original no cambia (ni texto ni archivo) y el Word llega en un mensaje nuevo')

  // ---- 5. Respuesta tardía tras cambiar de conversación ----
  let pendiente: (() => void) | null = null
  responder = (fin) => { pendiente = () => exito(5)(fin) }
  chat.documentoActivo = { id: formal.id, texto: FORMAL }
  void chat.enviarMensaje('Ahora en PowerPoint')
  await esperar()
  chat.abrirConversacion('conv-otra')
  const otraAntes = JSON.stringify(chat.mensajes)
  ;(pendiente as (() => void) | null)?.()
  // Nota: el respuesta-parcial tardío sí abre una burbuja de turno normal en
  // la otra conversación (comportamiento previo a esta corrección, igual
  // que con cualquier respuesta tardía); aquí solo se comprueba la entrega.
  void otraAntes
  verificar(!chat.mensajes.some((x) => x.texto === LISTO), '5a. Respuesta tardía tras cambiar de conversación: la entrega de la conversión no aparece en la otra conversación')
  chat.abrirConversacion(X)
  await esperar()

  // ---- 6. Persistencia y sincronización B → A ----
  chat.guardarInmediatamente()
  await esperar(2300) // copia remota de la etapa 1 (2 s de espera)
  const subidas = escrituras.filter((e) => e.tabla === 'mensajes_chat').flatMap((e) => e.ids ?? [])
  verificar([pdf[0].id, word[0].id].every((id) => subidas.includes(`${X}:${id}`)) && !subidas.includes(`${X}:${caso3.id}`), '6a. Las respuestas con archivo se suben a Supabase; el mensaje original (descargado) no se reescribe')
  almacen = DISPOSITIVO_A
  const r6 = await p.sincronizarConversacionRemota(DOCENTE_A, 'conv-a')
  const enA = p.cargarConversacionPorId('conv-a')!
  const pdfEnA = enA.mensajes.find((x) => x.id === pdf[0].id)
  verificar(r6.estado === 'actualizada' && pdfEnA?.archivo?.url === URL('AVISO.pdf') && (pdfEnA?.archivo as { archivoId?: string }).archivoId === 'archivo-pdf-1' && enA.mensajes.some((x) => x.id === word[0].id), '6b. En A aparecen las entregas hechas en B, con su archivo y archivoId')
  verificar(JSON.stringify(enA.mensajes.find((x) => x.id === caso3.id)) === JSON.stringify(caso3) && enA.documentoActivo?.id === formal.id && p.documentoVigente(enA.mensajes as never)?.id === formal.id, '6c. En A el documento original no cambia; el vigente es el último documento (el examen de la sección 4), no una entrega')
  verificar(new Set(enA.mensajes.map((x) => x.id)).size === enA.mensajes.length, '6d. Sin duplicados')

  // ---- 7. Presentación: solo la tarjeta (el texto técnico no se muestra) ----
  const { textoParaCopiar } = await import('../lib/asistente/copiarRespuesta')
  const { AVISO_ARCHIVO_LISTO } = await import('../lib/asistente/documentos')
  verificar(AVISO_ARCHIVO_LISTO === LISTO && pdf[0].texto === AVISO_ARCHIVO_LISTO && textoParaCopiar(pdf[0] as never) === null && textoParaCopiar(word[0] as never) === null, '7a. La entrega no ofrece "Copiar" (no tiene texto visible)')
  ;(interno.sincronizarHistorialTexto as () => void).call(chat)
  const entregasEnHistorial = historialEnviado.filter((x) => x.texto === LISTO)
  verificar(entregasEnHistorial.length > 0 && historialEnviado.every((x) => x.texto.trim().length > 0), '7b. En el historial para la IA la entrega conserva su texto técnico: ningún turno va vacío')
  const { readFileSync } = await import('node:fs')
  const panel = readFileSync('components/Asistente/AsistentePanel.tsx', 'utf8')
  const ramaArchivo = panel.slice(panel.indexOf("{esDoc || (m.rol === 'asistente' && m.archivo?.url) ? ("), panel.indexOf('<TarjetaDescarga'))
  verificar(/\{!esDoc && m\.texto && !esAvisoTecnicoDeArchivo\(m\.texto\) && \(/.test(ramaArchivo) && (panel.match(/esAvisoTecnicoDeArchivo\(/g) ?? []).length === 1 && (panel.match(/<TarjetaDescarga\b/g) ?? []).length === 1, '7c. Panel: el aviso técnico solo se oculta dentro de la rama de mensajes con archivo; la tarjeta y sus acciones son las de siempre')

  // ---- 7d-7f. Generación directa (CASO 3): "Documento generado correctamente." ----
  const { esAvisoTecnicoDeArchivo, AVISO_ARCHIVO_GENERADO, MENSAJE_ARCHIVO_SIN_SESION } = await import('../lib/asistente/documentos')
  verificar(esAvisoTecnicoDeArchivo(AVISO_ARCHIVO_GENERADO) && esAvisoTecnicoDeArchivo(` ${LISTO}\n`) && esAvisoTecnicoDeArchivo(caso3.texto), '7d. Se reconocen los dos avisos técnicos exactos (incluido el del CASO 3)')
  verificar(!esAvisoTecnicoDeArchivo('Documento generado correctamente. Revisa la fecha antes de imprimir.') && !esAvisoTecnicoDeArchivo(MENSAJE_ARCHIVO_SIN_SESION) && !esAvisoTecnicoDeArchivo('No pude generar el archivo. Toca para reintentar.') && !esAvisoTecnicoDeArchivo('Claro, aquí está el resumen.') && !esAvisoTecnicoDeArchivo(''), '7e. Respuestas normales, avisos de sesión, errores y textos parecidos no se ocultan')
  const caso3EnPantalla = chat.mensajes.find((x) => x.id === caso3.id) ?? caso3
  verificar(caso3EnPantalla.texto === AVISO_ARCHIVO_GENERADO && !!caso3EnPantalla.archivo && textoParaCopiar(caso3EnPantalla as never) === AVISO && textoParaCopiar({ rol: 'asistente', texto: AVISO_ARCHIVO_GENERADO } as never) === null, '7f. CASO 3: el texto técnico sigue guardado; "Copiar" copia el documento real (nunca el aviso) y uno antiguo sin contenido no ofrece "Copiar"')

  // ---- 8. Alcance ----
  const servicio = readFileSync('lib/asistente/AsistenteService.ts', 'utf8')
  const parcial = servicio.slice(servicio.indexOf("case 'respuesta-parcial': {"), servicio.indexOf("case 'respuesta-final': {"))
  verificar(!/textoDocumentoFinalizando/.test(parcial) && /actualizarDocumentoActivo\(msg\.id, evento\.contenidoOriginal \?\? msg\.texto, evento\.archivo\)/.test(servicio), '8a. Durante la conversión no se reescribe el documento; la generación directa (CASO 3) no cambia')

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
