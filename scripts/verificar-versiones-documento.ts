// scripts/verificar-versiones-documento.ts
//
// P2b: vínculos persistentes entre versiones de un documento. Una edición
// que produce un documento guarda versionDe (versión inmediata anterior) y
// documentoRaizId (identidad estable del documento, aunque cambie el
// título); una entrega de archivo guarda documentoOrigenId (versión exacta
// usada) y no es una versión. Documentos distintos con el mismo título no
// se vinculan; los históricos sin campos siguen válidos y no se tocan.
// Persistencia, sincronización entre dispositivos y reapertura.
//
// Sin red, sin credenciales, sin IA (el servidor se simula con los
// eventos del motor). Se ejecuta con
// `npx tsx scripts/verificar-versiones-documento.ts`.

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
  // Aislamiento por docente: la sesión simulada abre la puerta de las copias locales.
  p.establecerPropietarioLocal(sesion)

  const AVISO = (titulo: string, n: number) => `📨 ${titulo}\n\nTexto ficticio sin datos de alumnos. Versión ${n}.`
  const URL = (n: string) => `https://proyecto.supabase.co/storage/v1/object/sign/documentos-generados-ia/d/${n}?token=firma`

  almacen = DISPOSITIVO_A
  await p.guardarMensajesRemotos('conv-v', DOCENTE_A, []) // línea base de la etapa 1
  const { AsistenteService } = await import('../lib/asistente/AsistenteService')
  type Doc = { id: string; texto: string } | null
  const chat = AsistenteService as unknown as {
    conversacionActivaId: string | null; mensajes: Mensaje[]; documentoActivo: Doc; generando: boolean
    sincronizadaEn: Map<string, number>; abrirConversacion(id: string): void; nuevaConversacion(): void; enviarMensaje(texto: string): Promise<string>; manejarEventoMotor(e: unknown): void; guardarInmediatamente(): void
  }
  const interno = chat as unknown as Record<string, unknown>
  // Respuesta del "servidor" a la siguiente solicitud.
  let respuesta: { texto: string; archivo?: { tipo: string; nombre: string; url: string }; contenidoOriginal?: string } | null = null
  const motor = {
    establecerHistorial: () => {},
    establecerConversacion: () => {},
    enviarTexto: async (_texto: string, _adj: unknown, fin?: { tipo: string }) => {
      if (fin) {
        const a = { tipo: fin.tipo, nombre: `AVISO.${fin.tipo}`, url: URL(`AVISO.${fin.tipo}`) }
        chat.manejarEventoMotor({ tipo: 'respuesta-parcial', texto: 'Documento generado correctamente.' })
        chat.manejarEventoMotor({ tipo: 'respuesta-final', texto: 'Documento generado correctamente.', archivo: a, archivos: [a] })
        return
      }
      if (!respuesta) return // (voz: la respuesta llega después por eventos)
      const r = respuesta
      chat.manejarEventoMotor({ tipo: 'respuesta-parcial', texto: r.texto })
      chat.manejarEventoMotor({ tipo: 'respuesta-final', texto: r.texto, ...(r.archivo ? { archivo: r.archivo, archivos: [r.archivo] } : {}), ...(r.contenidoOriginal ? { contenidoOriginal: r.contenidoOriginal } : {}) })
    },
  }
  interno.motorTexto = motor
  interno.motor = motor
  interno.asegurarMotor = async () => {}
  interno.asegurarMotorTexto = async () => motor
  const ultimo = () => chat.mensajes[chat.mensajes.length - 1]
  const pedir = async (texto: string, r: typeof respuesta = null) => {
    respuesta = r
    chat.sincronizadaEn.set(chat.conversacionActivaId ?? '', Date.now())
    await chat.enviarMensaje(texto)
    return ultimo()
  }
  const copia = (id: string) => JSON.stringify(chat.mensajes.find((x) => x.id === id))

  chat.nuevaConversacion()
  const convA = chat.conversacionActivaId!

  // ---- 1. Original y dos ediciones sucesivas ----
  const d0 = await pedir('Haz un aviso de excursión', { texto: AVISO('AVISO DE EXCURSIÓN ESCOLAR', 0) })
  verificar(chat.documentoActivo?.id === d0.id && d0.versionDe === undefined && d0.documentoRaizId === undefined && p.documentoRaizDe(d0 as never) === d0.id, '1a. Documento original: sin vínculos; es su propia raíz')
  const d0Antes = copia(d0.id)
  const d1 = await pedir('Agrégale una conclusión', { texto: AVISO('AVISO DE EXCURSIÓN ESCOLAR', 1) })
  verificar(d1.id !== d0.id && d1.versionDe === d0.id && d1.documentoRaizId === d0.id && chat.documentoActivo?.id === d1.id, '1b. Primera edición: versión nueva vinculada al original (versionDe y raíz)')
  const d1Antes = copia(d1.id)
  const d2 = await pedir('Hazlo más formal', { texto: AVISO('AVISO DE EXCURSIÓN ESCOLAR', 2) })
  verificar(d2.versionDe === d1.id && d2.documentoRaizId === d0.id && p.documentoRaizDe(d2 as never) === d0.id, '1c. Segunda edición: apunta a la versión inmediata anterior y conserva la raíz')
  verificar(copia(d0.id) === d0Antes && copia(d1.id) === d1Antes, '1d. Append-only: las versiones anteriores no se modifican')

  // ---- 2. Cambio de título entre versiones ----
  const d3 = await pedir('Cámbiale el título a Salida al museo', { texto: AVISO('SALIDA AL MUSEO', 3) })
  verificar(d3.versionDe === d2.id && d3.documentoRaizId === d0.id, '2a. Con otro título sigue siendo el mismo documento (misma raíz)')

  // ---- 3. Conversión de una versión sin crear otra ----
  const e1 = await pedir('Pásalo a PDF')
  verificar(e1.documentoOrigenId === d3.id && e1.versionDe === undefined && e1.documentoRaizId === undefined && p.contenidoDocumentoDe(e1 as never) === null && chat.documentoActivo?.id === d3.id, '3a. La entrega guarda la versión exacta convertida y no es una versión nueva')
  const e2 = await pedir('Dámelo en PDF otra vez')
  verificar(e2.id !== e1.id && e2.documentoOrigenId === d3.id && chat.documentoActivo?.id === d3.id, '3b. Al reutilizar el archivo ya generado, la entrega también guarda su versión')

  // ---- 4. Editar y entregar (CASO 3 vía edición) ----
  const contenido4 = AVISO('SALIDA AL MUSEO', 4)
  const d4 = await pedir('Agrega una conclusión y pásalo a Word', { texto: 'Documento generado correctamente.', archivo: { tipo: 'word', nombre: 'AVISO.docx', url: URL('AVISO4.docx') }, contenidoOriginal: contenido4 })
  verificar(d4.contenidoDocumento === contenido4 && d4.versionDe === d3.id && d4.documentoRaizId === d0.id && chat.documentoActivo?.id === d4.id, '4a. Editar y entregar: la versión CASO 3 queda vinculada igual')

  // ---- 5. Una edición que no devuelve un documento no se vincula ----
  const aclaracion = await pedir('Cambia la fecha', { texto: '¿A qué fecha quieres cambiarla?' })
  verificar(aclaracion.versionDe === undefined && aclaracion.documentoRaizId === undefined && chat.documentoActivo?.id === d4.id, '5a. Una aclaración (no un documento) no se vincula y el activo no cambia')

  // ---- 6. Dos documentos distintos con el mismo título ----
  const otro0 = await pedir('Hazme otro aviso de excursión para segundo grado', { texto: AVISO('AVISO DE EXCURSIÓN ESCOLAR', 0) })
  verificar(otro0.versionDe === undefined && otro0.documentoRaizId === undefined && p.documentoRaizDe(otro0 as never) !== p.documentoRaizDe(d0 as never), '6a. Documento nuevo con el mismo título que otro: identidad propia, sin vínculo')
  const otro1 = await pedir('Agrégale una conclusión', { texto: AVISO('AVISO DE EXCURSIÓN ESCOLAR', 1) })
  verificar(otro1.versionDe === otro0.id && otro1.documentoRaizId === otro0.id && otro1.documentoRaizId !== d0.id, '6b. Su edición se vincula a SU documento, no al otro del mismo título')

  // ---- 7. Persistencia, sincronización y reapertura ----
  chat.guardarInmediatamente()
  await esperar(2300) // copia remota de la etapa 1 (2 s de espera)
  const remotoA = await p.idRemotoDe(DOCENTE_A, convA)
  const fila = (id: string) => tablas.mensajes_chat.find((f) => f.id === `${remotoA}:${id}`)?.contenido as Record<string, unknown> | undefined
  verificar(fila(d2.id)?.versionDe === d1.id && fila(d2.id)?.documentoRaizId === d0.id && fila(e1.id)?.documentoOrigenId === d3.id && fila(d4.id)?.versionDe === d3.id, '7a. Los vínculos se guardan en Supabase con el mensaje (mensajes_chat.contenido)')
  chat.nuevaConversacion()
  chat.abrirConversacion(convA)
  await esperar()
  const reabierto = (id: string) => chat.mensajes.find((x) => x.id === id)
  verificar(reabierto(d2.id)?.versionDe === d1.id && reabierto(d3.id)?.documentoRaizId === d0.id && reabierto(e2.id)?.documentoOrigenId === d3.id, '7b. Al reabrir la conversación en el mismo dispositivo, los vínculos siguen ahí')
  almacen = DISPOSITIVO_B
  await p.guardarMensajesRemotos('conv-b', DOCENTE_A, []) // línea base de la etapa 1 en B
  await p.descargarConversacionRemota(DOCENTE_A, remotoA)
  const enB = p.cargarConversacionPorId(remotoA)!
  const deB = (id: string) => enB.mensajes.find((x) => x.id === id)
  verificar(deB(d1.id)?.versionDe === d0.id && deB(d3.id)?.documentoRaizId === d0.id && deB(e1.id)?.documentoOrigenId === d3.id && deB(otro1.id)?.documentoRaizId === otro0.id && deB(d0.id)?.versionDe === undefined, '7c. En el otro dispositivo (descarga) llegan los mismos vínculos; el original sigue sin campos')
  // Una versión nueva hecha en A llega a B por la sincronización (fase 1).
  almacen = DISPOSITIVO_A
  const otro2 = await pedir('Hazlo más breve', { texto: AVISO('AVISO DE EXCURSIÓN ESCOLAR', 2) })
  chat.guardarInmediatamente()
  await esperar(2300)
  almacen = DISPOSITIVO_B
  const r7 = await p.sincronizarConversacionRemota(DOCENTE_A, remotoA)
  const sincronizado = p.cargarConversacionPorId(remotoA)!.mensajes.find((x) => x.id === otro2.id)
  verificar(r7.estado === 'actualizada' && sincronizado?.versionDe === otro1.id && sincronizado?.documentoRaizId === otro0.id && p.cargarConversacionPorId(remotoA)!.documentoActivo?.id === otro2.id, '7d. Sincronización Mac ↔ iPhone: la versión nueva llega con sus vínculos y es la vigente')

  // ---- 9. Voz: la respuesta final espera a la burbuja del docente (finalPendiente) ----
  almacen = DISPOSITIVO_A
  const contar = (origen: string) => chat.mensajes.filter((x) => x.versionDe === origen).length
  const editarPorVoz = async (orden: string, texto: string) => {
    respuesta = null
    chat.sincronizadaEn.set(convA, Date.now())
    await chat.enviarMensaje(orden) // edición en curso (el motor responde por eventos)
    chat.manejarEventoMotor({ tipo: 'inicio-turno-usuario' })
    chat.manejarEventoMotor({ tipo: 'respuesta-parcial', texto })
    chat.manejarEventoMotor({ tipo: 'respuesta-final', texto }) // queda pendiente
    chat.manejarEventoMotor({ tipo: 'mensaje-usuario', texto: orden }) // llega la transcripción y se vuelca
    return ultimo()
  }
  const origenVoz = chat.documentoActivo!.id
  const raizVoz = p.documentoRaizDe(chat.mensajes.find((x) => x.id === origenVoz)! as never)
  const v1 = await editarPorVoz('Agrégale una conclusión', AVISO('AVISO DE EXCURSIÓN ESCOLAR', 3))
  verificar(v1.versionDe === origenVoz && v1.documentoRaizId === raizVoz && chat.documentoActivo?.id === v1.id && interno.editandoDocumentoId === null, '9a. Edición por voz (finalPendiente): versión vinculada como en texto y estado de edición limpio')
  const v2 = await editarPorVoz('Hazlo más breve', AVISO('AVISO DE EXCURSIÓN ESCOLAR', 4))
  verificar(v2.versionDe === v1.id && v2.documentoRaizId === raizVoz, '9b. Dos ediciones por voz consecutivas conservan la misma raíz')
  const charla = await editarPorVoz('Cambia la fecha', '¿A qué fecha quieres cambiarla?')
  verificar(charla.versionDe === undefined && charla.documentoRaizId === undefined && chat.documentoActivo?.id === v2.id && interno.editandoDocumentoId === null, '9c. Respuesta conversacional por voz: sin vínculos y el documento activo no cambia')
  // Finalización repetida: no crea otra versión ni reescribe el vínculo.
  const antes9 = chat.mensajes.length
  chat.manejarEventoMotor({ tipo: 'respuesta-final', texto: '¿A qué fecha quieres cambiarla?' })
  const w1 = await pedir('Agrégale una despedida', { texto: AVISO('AVISO DE EXCURSIÓN ESCOLAR', 5) })
  const antesRepetido = chat.mensajes.length
  chat.manejarEventoMotor({ tipo: 'respuesta-final', texto: AVISO('AVISO DE EXCURSIÓN ESCOLAR', 5) })
  chat.manejarEventoMotor({ tipo: 'respuesta-final', texto: AVISO('AVISO DE EXCURSIÓN ESCOLAR', 5) })
  verificar(chat.mensajes.length === antesRepetido && antesRepetido === antes9 + 2 && contar(v2.id) === 1 && contar(String(w1.versionDe)) === 1 && ultimo().id === w1.id && w1.versionDe === v2.id, '9d. Finalización repetida (voz o texto): ninguna versión duplicada ni vínculo reescrito')
  verificar(w1.documentoRaizId === raizVoz && chat.documentoActivo?.id === w1.id, '9e. La edición escrita después de las de voz sigue vinculada a la misma raíz')

  // ---- 8. Compatibilidad con históricos ----
  const historico = { id: 'msg-historico', rol: 'asistente' as const, texto: AVISO('AVISO DE EXCURSIÓN ESCOLAR', 9), creadoEn: 1 }
  verificar(p.documentoRaizDe(historico) === historico.id && p.contenidoDocumentoDe(historico as never) === historico.texto && p.documentoVigente([historico] as never)?.id === historico.id, '8a. Un mensaje histórico sin campos es su propia raíz y sigue siendo documento válido')
  const { readFileSync } = await import('node:fs')
  const servicio = readFileSync('lib/asistente/AsistenteService.ts', 'utf8')
  const vincular = servicio.slice(servicio.indexOf('  private vincularVersion('), servicio.indexOf('  // --- Versiones de un documento: consultar y restaurar (P2c) ---'))
  verificar((servicio.match(/versionDe: origen\.id, documentoRaizId:/g) ?? []).length === 1 && vincular.includes('versionDe: origen.id, documentoRaizId: documentoRaizDe(origen)') && !/titulo|extraerTitulo/i.test(vincular), '8b. Sin reconstrucción por títulos: el vínculo solo se asigna en vincularVersion y solo con identificadores')

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
