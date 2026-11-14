// scripts/verificar-restauracion-version.ts
//
// P2c-1: restauración de una versión disponible en la conversación local.
// Un marcador (restauraVersion + documentoRaizId, sin copiar contenido)
// vuelve vigente esa versión; documentoVigente lo resuelve distinguiendo
// la versión del evento que la hace vigente; las ediciones posteriores
// parten de ella (rama del historial) y las conversiones usan su texto
// exacto. Sobrevive a guardar, reabrir y sincronizar; un referente
// ausente o inválido queda como noRecuperado y nunca se opera sobre otro
// documento. Sin títulos, sin IA, sin búsqueda remota (etapa siguiente).
//
// Se ejecuta con `npx tsx scripts/verificar-restauracion-version.ts`.

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

  const AVISO = (titulo: string, n: number) => `📨 ${titulo}\n\nTexto ficticio sin datos de alumnos. Versión ${n}.`
  const URL = (n: string) => `https://proyecto.supabase.co/storage/v1/object/sign/documentos-generados-ia/d/${n}?token=firma`
  const TITULO = 'AVISO DE EXCURSIÓN ESCOLAR'

  almacen = DISPOSITIVO_A
  await p.guardarMensajesRemotos('conv-r', DOCENTE_A, []) // línea base de la etapa 1
  const { AsistenteService } = await import('../lib/asistente/AsistenteService')
  type Doc = { id: string; texto: string; archivosGenerados?: Record<string, unknown>; noRecuperado?: true } | null
  const chat = AsistenteService as unknown as {
    conversacionActivaId: string | null; mensajes: Mensaje[]; documentoActivo: Doc; generando: boolean; avisoGeneracion: string | null
    sincronizadaEn: Map<string, number>; abrirConversacion(id: string): void; nuevaConversacion(): void; enviarMensaje(texto: string): Promise<string>; manejarEventoMotor(e: unknown): void; guardarInmediatamente(): void
  }
  const interno = chat as unknown as Record<string, unknown>
  let respuesta: { texto: string } | null = null
  const llamadas: { finalizar?: { tipo: string; documentoTexto: string }; edicion?: boolean }[] = []
  let historialEnviado: { rol: string; texto: string }[] = []
  let archivosGenerados = 0
  const motor = {
    establecerHistorial: (m: { rol: string; texto: string }[]) => { historialEnviado = m },
    establecerConversacion: () => {},
    enviarTexto: async (_texto: string, _adj: unknown, fin?: { tipo: string; documentoTexto: string }, edicion?: boolean) => {
      llamadas.push({ finalizar: fin, edicion })
      if (fin) {
        const a = { tipo: fin.tipo, nombre: `AVISO.${fin.tipo}`, url: URL(`AVISO-${++archivosGenerados}.${fin.tipo}`) }
        chat.manejarEventoMotor({ tipo: 'respuesta-parcial', texto: 'Documento generado correctamente.' })
        chat.manejarEventoMotor({ tipo: 'respuesta-final', texto: 'Documento generado correctamente.', archivo: a, archivos: [a] })
        return
      }
      if (!respuesta) return
      chat.manejarEventoMotor({ tipo: 'respuesta-parcial', texto: respuesta.texto })
      chat.manejarEventoMotor({ tipo: 'respuesta-final', texto: respuesta.texto })
    },
  }
  interno.motorTexto = motor
  interno.motor = motor
  interno.asegurarMotor = async () => {}
  interno.asegurarMotorTexto = async () => motor
  const ultimo = () => chat.mensajes[chat.mensajes.length - 1]
  const pedir = async (texto: string, r: { texto: string } | null = null) => {
    respuesta = r
    llamadas.length = 0
    chat.sincronizadaEn.set(chat.conversacionActivaId ?? '', Date.now())
    const resultado = await chat.enviarMensaje(texto)
    return { resultado, m: ultimo() }
  }
  const copia = (id: string) => JSON.stringify(chat.mensajes.find((x) => x.id === id))
  const marcadores = () => chat.mensajes.filter((x) => x.restauraVersion)

  chat.nuevaConversacion()
  const convA = chat.conversacionActivaId!
  const v1 = (await pedir('Haz un aviso de excursión', { texto: AVISO(TITULO, 1) })).m
  const v2 = (await pedir('Agrégale una conclusión', { texto: AVISO(TITULO, 2) })).m
  const v3 = (await pedir('Hazlo más formal', { texto: AVISO(TITULO, 3) })).m
  const pdfV3 = (await pedir('Pásalo a PDF')).m
  verificar(v3.versionDe === v2.id && v2.versionDe === v1.id && pdfV3.documentoOrigenId === v3.id && !!(chat.documentoActivo?.archivosGenerados as Record<string, unknown>)?.pdf, '0a. Preparación: V1 → V2 → V3 vinculadas y V3 con su PDF en la caché')
  const historicos = [v1, v2, v3].map((x) => copia(x.id))

  // ---- 1. Restauración V3 → V1 ----
  const r1 = await pedir('Recupera la primera versión')
  const marcador1 = r1.m
  verificar(r1.resultado === 'enviado' && llamadas.length === 0 && marcador1.restauraVersion === v1.id && marcador1.documentoRaizId === v1.id && marcador1.texto.startsWith('Volví a la primera versión') && !marcador1.contenidoDocumento && !marcador1.archivo, '1a. "Recupera la primera versión": marcador nuevo solo con referencias y una confirmación breve (sin IA)')
  verificar(!marcador1.texto.includes('Versión 1') && p.contenidoDocumentoDe(marcador1 as never) === null && marcador1.versionDe === undefined, '1b. El marcador no copia el contenido ni es una versión o edición')
  verificar(chat.documentoActivo?.id === v1.id && chat.documentoActivo?.texto === AVISO(TITULO, 1) && Object.keys(chat.documentoActivo?.archivosGenerados ?? {}).length === 0, '1c. El documento activo es V1 con su texto exacto y sin la caché de otra versión')
  const vigente1 = p.resolverDocumentoVigente(chat.mensajes as never)
  verificar(vigente1?.documento.id === v1.id && vigente1?.origenId === marcador1.id && [v1, v2, v3].every((x, i) => copia(x.id) === historicos[i]), '1d. documentoVigente distingue la versión (V1) del evento que la hace vigente (el marcador); los históricos no cambian')

  // ---- 2. Conversión exacta de V1 ----
  const conv = await pedir('Pásalo a PDF')
  verificar(llamadas.length === 1 && llamadas[0].finalizar?.documentoTexto === AVISO(TITULO, 1) && conv.m.documentoOrigenId === v1.id && (conv.m.archivo as { url?: string } | undefined)?.url !== (pdfV3.archivo as { url?: string } | undefined)?.url, '2a. La conversión usa exactamente V1 y no reutiliza el PDF de V3')

  // ---- 3. Edición posterior V1 → V4 (rama, misma raíz) ----
  const v4 = (await pedir('Agrégale una despedida', { texto: AVISO(TITULO, 4) })).m
  verificar(llamadas[0]?.edicion === true && v4.versionDe === v1.id && v4.documentoRaizId === v1.id && chat.documentoActivo?.id === v4.id && p.documentoVigente(chat.mensajes as never)?.id === v4.id, '3a. La edición posterior parte de V1 (V4 → V1) con la misma raíz y es la vigente')
  verificar(copia(v2.id) === historicos[1] && copia(v3.id) === historicos[2], '3b. La rama no toca V2 ni V3')
  // Volver a la anterior desde V4 (su versionDe es V1) y, desde V1, no hay anterior.
  const r3 = await pedir('Regresa a la versión anterior')
  verificar(r3.m.restauraVersion === v1.id && r3.m.texto.startsWith('Volví a la versión anterior') && chat.documentoActivo?.id === v1.id, '3c. "Regresa a la versión anterior" desde V4 vuelve a V1 (por versionDe)')
  const antes3 = marcadores().length
  const r4 = await pedir('Regresa a la versión anterior')
  verificar(!r4.m.restauraVersion && r4.m.texto.startsWith('No hay una versión anterior') && marcadores().length === antes3 && chat.documentoActivo?.id === v1.id, '3d. Desde la primera versión no hay anterior: no se crea marcador ni cambia nada')

  // ---- 4. Historial para la IA ----
  ;(interno.sincronizarHistorialTexto as () => void).call(chat)
  const ultimoDocEnHistorial = [...historialEnviado].reverse().find((x) => x.rol === 'asistente' && x.texto.startsWith('📨'))
  verificar(ultimoDocEnHistorial?.texto === AVISO(TITULO, 1) && chat.mensajes.find((x) => x.id === r3.m.id)?.texto.startsWith('Volví') === true, '4a. En lo enviado a la IA el último documento es V1 (lo guardado no cambia)')

  // ---- 5. Guardar y reabrir ----
  chat.guardarInmediatamente()
  chat.nuevaConversacion()
  chat.abrirConversacion(convA)
  await esperar()
  verificar(chat.documentoActivo?.id === v1.id && chat.documentoActivo?.texto === AVISO(TITULO, 1) && !chat.documentoActivo?.noRecuperado, '5a. Al reabrir, V1 sigue vigente')
  // Más de 80 mensajes después: V1 queda fijada en la copia local.
  const relleno = Array.from({ length: 90 }, (_, i) => ({ id: `msg-relleno-${i}`, rol: (i % 2 ? 'asistente' : 'usuario') as Mensaje['rol'], texto: `Mensaje ${i}`, creadoEn: Date.now() + i }))
  chat.mensajes = [...chat.mensajes, ...relleno]
  chat.guardarInmediatamente()
  const guardada = p.cargarConversacionPorId(convA)!
  chat.nuevaConversacion()
  chat.abrirConversacion(convA)
  await esperar()
  verificar(guardada.mensajes.length === 81 && guardada.mensajes[0].id === v1.id && !guardada.mensajes.some((x) => x.id === v2.id) && chat.documentoActivo?.id === v1.id && !chat.documentoActivo?.noRecuperado, '5b. Con más de 80 mensajes, la versión restaurada se conserva en la copia local y sigue vigente al reabrir')

  // ---- 6. Dos documentos distintos con el mismo título ----
  const o1 = (await pedir('Hazme otro aviso de excursión para segundo grado', { texto: AVISO(TITULO, 1) })).m
  const o2 = (await pedir('Agrégale una conclusión', { texto: AVISO(TITULO, 2) })).m
  const r6 = await pedir('Recupera la primera versión')
  verificar(o2.documentoRaizId === o1.id && r6.m.restauraVersion === o1.id && r6.m.documentoRaizId === o1.id && chat.documentoActivo?.id === o1.id, '6a. Mismo título que el otro aviso: se restaura la primera versión de ESTE documento (O1), nunca V1')

  // ---- 7. Marcador inválido o referente ausente ----
  const docX = { id: 'msg-doc-x', rol: 'asistente' as const, texto: AVISO('CITATORIO', 1), creadoEn: 1 }
  const charla = { id: 'msg-charla', rol: 'asistente' as const, texto: 'Hola', creadoEn: 2 }
  const marcador = (id: string, ref: string, raiz: string) => ({ id, rol: 'asistente' as const, texto: 'Volví a la versión anterior del documento.', creadoEn: 3, restauraVersion: ref, documentoRaizId: raiz })
  const sinReferente = p.resolverDocumentoVigente([docX, marcador('m1', 'msg-inexistente', 'msg-inexistente')] as never)
  const noDocumento = p.resolverDocumentoVigente([docX, charla, marcador('m2', charla.id, charla.id)] as never)
  const otraRaiz = p.resolverDocumentoVigente([docX, marcador('m3', docX.id, 'otra-raiz')] as never)
  verificar([sinReferente, noDocumento, otraRaiz].every((x) => x?.documento.noRecuperado === true && x.documento.texto === '' && x.origenId.startsWith('m')), '7a. Referente ausente, que no es documento o de otra raíz: noRecuperado (nunca se elige otro documento)')
  p.guardarConversacion('conv-invalida', [docX, marcador('m4', 'msg-inexistente', 'msg-inexistente')] as never, null)
  chat.abrirConversacion('conv-invalida')
  await esperar()
  const antes7 = chat.mensajes.length
  const r7 = await pedir('Pásalo a PDF')
  verificar(chat.documentoActivo?.noRecuperado === true && r7.resultado === 'no_enviado' && llamadas.length === 0 && chat.mensajes.length === antes7 && chat.avisoGeneracion?.includes('no está disponible') === true, '7b. Con el referente no recuperado no se convierte ni edita otro documento: se avisa y no se modifica nada')
  const r7b = await pedir('Recupera la primera versión')
  verificar(!r7b.m.restauraVersion && llamadas.length === 0 && chat.documentoActivo?.noRecuperado === true, '7c. Tampoco se restaura a partir de un referente no recuperado')
  chat.abrirConversacion(convA)
  await esperar()

  // ---- 8. Sincronización del marcador (A → B) ----
  chat.guardarInmediatamente()
  await esperar(2300) // copia remota de la etapa 1
  const remotoA = await p.idRemotoDe(DOCENTE_A, convA)
  almacen = DISPOSITIVO_B
  await p.guardarMensajesRemotos('conv-b', DOCENTE_A, [])
  const filas = tablas.mensajes_chat.filter((f) => String(f.id).startsWith(`${remotoA}:`))
  // B tenía la conversación sin el último marcador (O1 restaurado): se quita de su copia.
  await p.descargarConversacionRemota(DOCENTE_A, remotoA)
  const enB = p.cargarConversacionPorId(remotoA)!
  const sinUltimo = enB.mensajes.filter((x) => x.id !== r6.m.id)
  p.guardarConversacion(remotoA, sinUltimo, { id: o2.id, texto: AVISO(TITULO, 2) })
  const r8 = await p.sincronizarConversacionRemota(DOCENTE_A, remotoA)
  const trasSync = p.cargarConversacionPorId(remotoA)!
  verificar(filas.some((f) => (f.contenido as Record<string, unknown>)?.restauraVersion === o1.id) && r8.estado === 'actualizada' && trasSync.documentoActivo?.id === o1.id && trasSync.mensajes.some((x) => x.id === r6.m.id && x.restauraVersion === o1.id), '8a. El marcador viaja por Supabase y en el otro dispositivo O1 pasa a ser el activo (lo determina el evento)')
  // Una sincronización posterior sin documentos nuevos no lo sobrescribe.
  almacen = DISPOSITIVO_A
  const nota = { id: 'msg-nota-a', rol: 'usuario' as const, texto: 'Gracias', creadoEn: Date.now() + 999999 }
  tablas.mensajes_chat.push(p.mensajeAFilaRemota(remotoA, DOCENTE_A, nota as never) as unknown as Fila)
  almacen = DISPOSITIVO_B
  await p.sincronizarConversacionRemota(DOCENTE_A, remotoA)
  verificar(p.cargarConversacionPorId(remotoA)!.documentoActivo?.id === o1.id, '8b. Otra sincronización sin eventos documentales no sobrescribe la restauración')
  almacen = DISPOSITIVO_A

  // ---- 9. P2a se conserva ----
  const antes9 = marcadores().length
  const c1 = await pedir('Muéstrame la versión anterior')
  const c2 = await pedir('Vuelve a la versión anterior del citatorio')
  const c3 = await pedir('Regresa al documento anterior')
  verificar(marcadores().length === antes9 && llamadas.length === 0 && c1.m.texto.startsWith('No hay una versión anterior') && c2.m.texto.startsWith('El documento actual no corresponde') && c3.m.texto.startsWith('¿Te refieres') && chat.documentoActivo?.id === o1.id, '9a. (P2c-3) Consultar la anterior de O1 (sin padre), nombrar otro tipo o decir "documento anterior" tras restaurar: respuesta clara, sin marcador ni cambios')

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
