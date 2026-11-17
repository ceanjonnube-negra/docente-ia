// scripts/verificar-documento-nombrado.ts
//
// P3a: con varios documentos en la conversación, el que nombra el docente
// ("Cambia la fecha del citatorio" con el examen activo) es el destino —
// nunca el más reciente por ser el activo. Se reconoce por la estructura
// de la frase (destino, no tema ni documento nuevo) y el título de la
// versión vigente de cada documento (también una restaurada); varios
// candidatos o un historial posiblemente incompleto piden aclaración. La
// selección viaja en el mensaje del docente (documentoDestinoId), no es una
// restauración y se sincroniza como cualquier mensaje.
//
// Se ejecuta con `npx tsx scripts/verificar-documento-nombrado.ts`.

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
  const lecturas: { tabla: string; columnas: string; ids?: string[] }[] = []
  let fallarPorId = false
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

  const CITATORIO = (n: number, motivo = 'A REUNIÓN DE PADRES') => `📨 CITATORIO ${motivo}\n\nTexto ficticio sin datos de alumnos. Fecha: ${n} de mayo.`
  const EXAMEN = (n: number) => `📝 EXAMEN DE FRACCIONES\n\nPregunta ficticia ${n}.`
  const REPORTE = `📊 REPORTE DE LECTURA\n\nTexto ficticio.`
  const d = await import('../lib/asistente/documentos')

  // ---- 1. Detector: destino, tema y documento nuevo ----
  const casos: [string, string | null][] = [
    ['Cambia la fecha del citatorio', 'citatorio'], ['Convierte el citatorio a PDF', 'citatorio'], ['Agrega al examen una pregunta sobre el reporte', 'examen'],
    ['Cambia el resumen del examen', 'examen'], ['Corrige el segundo citatorio', 'citatorio#2'], ['Corrige el citatorio más reciente', 'citatorio#-1'],
    ['Regresa al examen', 'examen!'], ['Trabajemos con el citatorio', 'citatorio!'], ['Cambia la fecha', null], ['Haz un examen sobre la Revolución', null],
  ]
  const errores = casos.filter(([f, esperado]) => {
    const r = d.esPedidoDocumentoNuevo(f) ? null : d.destinoNombrado(f)
    const obtenido = r ? `${r.tipos.join('+')}${r.ordinal ? `#${r.ordinal}` : ''}${r.seleccion ? '!' : ''}` : null
    if (obtenido !== esperado) console.log('   detector:', f, obtenido)
    return obtenido !== esperado
  })
  verificar(errores.length === 0 && d.esPedidoDocumentoNuevo('Haz un examen sobre la Revolución'), '1a. Destino, tema ("sobre el reporte"), parte ("el resumen del examen"), ordinal, selección y documento nuevo')
  const t = ['📨 CITATORIO A REUNIÓN', '📨 CITATORIO POR CONDUCTA']
  verificar(d.respuestaAclaracionDocumento('El segundo', t) === 1 && d.respuestaAclaracionDocumento('2', t) === 1 && d.respuestaAclaracionDocumento('el más reciente', t) === 1 && d.respuestaAclaracionDocumento('El de la reunión', t) === 0
    && d.respuestaAclaracionDocumento('el primero o el segundo', t) === 'imprecisa' && d.respuestaAclaracionDocumento('sí', t) === null && d.respuestaAclaracionDocumento('Sí', [t[0]]) === 0 && d.respuestaAclaracionDocumento('el tercero', t) === 'imprecisa', '1b. Respuestas a la aclaración: número, ordinal, "el más reciente", palabra del título, "sí" con un candidato; varias o inexistentes: imprecisa')

  // ---- Servicio ----
  almacen = DISPOSITIVO_A
  await p.guardarMensajesRemotos('conv-base-a', DOCENTE_A, [])
  const { AsistenteService } = await import('../lib/asistente/AsistenteService')
  type Doc = { id: string; texto: string; archivosGenerados?: Record<string, unknown>; noRecuperado?: true } | null
  const chat = AsistenteService as unknown as {
    conversacionActivaId: string | null; mensajes: Mensaje[]; documentoActivo: Doc; archivoReutilizadoId: string | null; avisoGeneracion: string | null
    sincronizadaEn: Map<string, number>; abrirConversacion(id: string): void; nuevaConversacion(): void; enviarMensaje(texto: string): Promise<string>; manejarEventoMotor(e: unknown): void; guardarInmediatamente(): void
  }
  const interno = chat as unknown as Record<string, unknown>
  let respuesta: { texto: string } | null = null
  const llamadas: { texto: string; finalizar?: { tipo: string; documentoTexto: string }; edicion?: boolean }[] = []
  const motor = {
    establecerHistorial: () => {},
    establecerConversacion: () => {},
    enviarTexto: async (texto: string, _adj: unknown, finalizar?: { tipo: string; documentoTexto: string }, edicion?: boolean) => {
      llamadas.push({ texto, finalizar, edicion })
      if (finalizar || !respuesta) return
      chat.manejarEventoMotor({ tipo: 'respuesta-parcial', texto: respuesta.texto })
      chat.manejarEventoMotor({ tipo: 'respuesta-final', texto: respuesta.texto })
    },
  }
  interno.motorTexto = motor
  interno.motor = motor
  interno.asegurarMotor = async () => {}
  interno.asegurarMotorTexto = async () => motor
  const ultimo = () => chat.mensajes[chat.mensajes.length - 1]
  const candidatosDe = (m: Mensaje) => (m.aclaracionDocumento as { candidatos?: string[] } | undefined)?.candidatos
  const docente = () => [...chat.mensajes].reverse().find((m) => m.rol === 'usuario')!
  const pedir = async (texto: string, r: { texto: string } | null = null) => {
    respuesta = r
    llamadas.length = 0
    interno.editandoDocumentoId = null
    interno.documentoFinalizandoId = null
    chat.archivoReutilizadoId = null
    chat.avisoGeneracion = null
    chat.sincronizadaEn.set(chat.conversacionActivaId ?? '', Date.now())
    const resultado = await chat.enviarMensaje(texto)
    interno.editandoDocumentoId = null
    interno.documentoFinalizandoId = null
    return { resultado, m: ultimo() }
  }
  const editoCon = (texto: string) => llamadas.length === 1 && llamadas[0].edicion === true && llamadas[0].texto.includes(texto)

  // ---- 2. Citatorio + examen ----
  chat.nuevaConversacion()
  const conv = chat.conversacionActivaId!
  const c1 = (await pedir('Haz un citatorio para padres', { texto: CITATORIO(10) })).m
  const c2 = (await pedir('Agrégale la hora', { texto: CITATORIO(11) })).m
  const ex = (await pedir('Hazme un examen de fracciones', { texto: EXAMEN(1) })).m
  verificar(chat.documentoActivo?.id === ex.id && c2.versionDe === c1.id && !ex.versionDe, '2a. Preparación: citatorio (V1→V2) y después un examen, que queda activo')
  const e1 = await pedir('Cambia la fecha del citatorio', { texto: CITATORIO(12) })
  const pidio = docente()
  verificar(editoCon('Fecha: 11 de mayo') && !llamadas[0].texto.includes('EXAMEN') && pidio.documentoDestinoId === c2.id, '2b. "Cambia la fecha del citatorio": edita la versión vigente del citatorio (V2), no el examen; el mensaje del docente registra el destino')
  const c3 = e1.m
  verificar(c3.versionDe === c2.id && c3.documentoRaizId === c1.id && chat.documentoActivo?.id === c3.id && ex.texto === EXAMEN(1) && !chat.mensajes.some((m) => m.restauraVersion), '2c. La versión nueva queda en el historial del citatorio y vigente; el examen no cambia; no se usa restauraVersion')

  // ---- 3. Conversión del citatorio con el examen activo ----
  await pedir('Agrégale una pregunta al examen', { texto: EXAMEN(2) })
  const ex2 = ultimo()
  verificar(chat.documentoActivo?.id === ex2.id && ex2.versionDe === ex.id, '3a. Preparación: el examen vuelve a quedar activo (V2)')
  await pedir('Convierte el citatorio a PDF')
  verificar(llamadas.length === 1 && llamadas[0].finalizar?.tipo === 'pdf' && llamadas[0].finalizar.documentoTexto === CITATORIO(12) && docente().documentoDestinoId === c3.id && chat.documentoActivo?.id === c3.id, '3b. "Convierte el citatorio a PDF": convierte el citatorio vigente; el destino queda registrado y activo')
  await pedir('Pasa el examen a Word')
  verificar(llamadas[0]?.finalizar?.tipo === 'word' && llamadas[0].finalizar.documentoTexto === EXAMEN(2) && docente().documentoDestinoId === ex2.id, '3c. "Pasa el examen a Word": vuelve al examen y lo convierte')

  // ---- 4. Tema, consulta y selección expresa ----
  const rep = (await pedir('Hazme un reporte de lectura', { texto: REPORTE })).m
  await pedir('Pasa el examen a PDF')
  verificar(chat.documentoActivo?.id === ex2.id && rep.id !== ex2.id, '4a. Preparación: un reporte y otra vez el examen activo')
  await pedir('Agrega al examen una pregunta sobre el reporte', { texto: EXAMEN(3) })
  const ex3 = ultimo()
  verificar(editoCon('EXAMEN DE FRACCIONES') && !docente().documentoDestinoId && ex3.versionDe === ex2.id, '4b. "Agrega al examen una pregunta sobre el reporte": edita el examen (el reporte es el tema), sin registrar selección')
  const consulta = await pedir('Muéstrame el citatorio')
  verificar(consulta.resultado === 'enviado' && llamadas.length === 0 && chat.archivoReutilizadoId === c3.id && chat.documentoActivo?.id === ex3.id && !docente().documentoDestinoId && p.documentoVigente(chat.mensajes as never)?.id === ex3.id, '4c. "Muéstrame el citatorio": lo resalta sin IA y sin cambiar el documento activo ni registrar selección')
  const seleccion = await pedir('Regresa al citatorio')
  verificar(llamadas.length === 0 && docente().documentoDestinoId === c3.id && chat.documentoActivo?.id === c3.id && /ahora trabajo con «CITATORIO A REUNIÓN DE PADRES»/.test(seleccion.m.texto) && !seleccion.m.restauraVersion, '4d. "Regresa al citatorio": lo elige sin IA ni archivo; queda vigente y registrado en el mensaje del docente')
  const vigenteSeleccion = p.resolverDocumentoVigente(chat.mensajes as never)
  const seleccionGuardada = chat.mensajes.find((m) => m.id === vigenteSeleccion?.origenId)
  const conDestinoAntes = chat.mensajes.filter((m) => m.documentoDestinoId).length
  await pedir('Muéstrame el examen')
  const vigenteTrasVer = p.resolverDocumentoVigente(chat.mensajes as never)
  verificar(llamadas.length === 0 && chat.archivoReutilizadoId === ex3.id && chat.documentoActivo?.id === c3.id && vigenteTrasVer?.origenId === vigenteSeleccion?.origenId && vigenteTrasVer?.documento.id === c3.id
    && seleccionGuardada?.documentoDestinoId === c3.id && chat.mensajes.filter((m) => m.documentoDestinoId).length === conDestinoAntes, '4d-2. "Muéstrame el examen" tras elegir el citatorio: lo resalta sin tocar documentoDestinoId ni la selección vigente')
  await pedir('Cambia la fecha', { texto: CITATORIO(13) })
  const c4 = ultimo()
  verificar(editoCon('Fecha: 12 de mayo') && c4.versionDe === c3.id, '4e. Después, una edición sin nombrar documento trabaja sobre el citatorio elegido')
  await pedir('Regresa a la versión anterior')
  verificar(llamadas.length === 0 && ultimo().restauraVersion === c3.id && chat.documentoActivo?.id === c3.id, '4f. P2 sigue igual: "Regresa a la versión anterior" restaura la versión anterior del citatorio (no el examen)')
  await pedir('Regresa al citatorio')
  verificar(/Ya estamos trabajando/.test(ultimo().texto) && !docente().documentoDestinoId && chat.documentoActivo?.id === c3.id, '4g. Elegir el documento que ya está activo: solo lo confirma, sin registrar selección')

  // ---- 5. Restauración previa: el destino es la versión restaurada ----
  await pedir('Pasa el examen a Word')
  verificar(chat.documentoActivo?.id === ex3.id, '5a. Preparación: citatorio con la V3 restaurada y el examen activo')
  await pedir('Agrégale al citatorio una nota', { texto: CITATORIO(14) })
  verificar(editoCon('Fecha: 12 de mayo') && ultimo().versionDe === c3.id && docente().documentoDestinoId === c3.id, '5b. "Agrégale al citatorio una nota": parte de la versión restaurada (V3), no de la V4 descartada')

  // ---- 6. Sincronización y reapertura ----
  chat.guardarInmediatamente()
  await esperar(2300)
  const remoto = await p.idRemotoDe(DOCENTE_A, conv)
  const fila = tablas.mensajes_chat.find((f) => f.id === `${remoto}:${docente().id}`)
  verificar((fila?.contenido as Record<string, unknown> | undefined)?.documentoDestinoId === c3.id, '6a. La selección viaja en el mensaje del docente (contenido JSONB), sin filas ni tablas nuevas')
  const remotos = await p.leerMensajesRemotosPorId(DOCENTE_A, remoto, chat.mensajes.map((m) => m.id))
  remotos.sort((a, b) => a.creadoEn - b.creadoEn)
  verificar(p.documentoVigente(remotos)?.id === chat.documentoActivo?.id, '6b. Otro dispositivo, con los mensajes de Supabase, resuelve el mismo documento vigente')
  const activoAntes = chat.documentoActivo?.id
  const antigua = { id: 'msg-seleccion-antigua', rol: 'usuario' as const, texto: 'Regresa al examen', creadoEn: c4.creadoEn - 1, documentoDestinoId: ex3.id }
  tablas.mensajes_chat.push(p.mensajeAFilaRemota(remoto, DOCENTE_A, antigua as never) as unknown as Fila)
  await pedir('Muéstrame el documento actual')
  verificar(chat.mensajes.some((m) => m.id === antigua.id) && chat.documentoActivo?.id === activoAntes && chat.archivoReutilizadoId === activoAntes, '6c. Una selección antigua que llega tarde de otro dispositivo no reemplaza el documento vigente más reciente')
  chat.nuevaConversacion()
  chat.abrirConversacion(conv)
  await esperar(300)
  verificar(chat.documentoActivo?.id === activoAntes, '6d. Al reabrir la conversación, el documento activo es el mismo')

  // ---- 7. Dos citatorios: aclaración ----
  chat.nuevaConversacion()
  const a1 = (await pedir('Haz un citatorio para padres', { texto: CITATORIO(1, 'A REUNIÓN DE PADRES') })).m
  const b1 = (await pedir('Hazme otro citatorio', { texto: CITATORIO(2, 'POR CONDUCTA') })).m
  const e7 = (await pedir('Hazme un examen de fracciones', { texto: EXAMEN(1) })).m
  const aclara = await pedir('Corrige el citatorio')
  verificar(llamadas.length === 0 && chat.documentoActivo?.id === e7.id && JSON.stringify(candidatosDe(aclara.m)) === JSON.stringify([a1.id, b1.id]) && /1\. «CITATORIO A REUNIÓN DE PADRES»\n2\. «CITATORIO POR CONDUCTA»/.test(aclara.m.texto), '7a. "Corrige el citatorio" con dos citatorios: aclaración con ambos títulos, sin IA ni cambios')
  await pedir('gracias')
  verificar(llamadas.length === 0 && !!ultimo().aclaracionDocumento && chat.documentoActivo?.id === e7.id, '7b. Una respuesta que no elige ninguno repite la pregunta (nunca edita el examen)')
  await pedir('El segundo', { texto: CITATORIO(3, 'POR CONDUCTA') })
  verificar(editoCon('POR CONDUCTA') && llamadas[0].texto.includes('Corrige el citatorio') && docente().texto === 'El segundo' && docente().documentoDestinoId === b1.id && ultimo().versionDe === b1.id, '7c. "El segundo": completa la solicitud original sobre ese citatorio y registra el destino')
  await pedir('Pasa el examen a Word')
  await pedir('Corrige el citatorio')
  await pedir('El de la reunión', { texto: CITATORIO(4, 'A REUNIÓN DE PADRES') })
  verificar(editoCon('A REUNIÓN DE PADRES') && ultimo().versionDe === a1.id, '7d. Respuesta con una palabra del título ("el de la reunión")')
  await pedir('Pasa el examen a Word')
  await pedir('Corrige el primer citatorio', { texto: CITATORIO(5, 'A REUNIÓN DE PADRES') })
  verificar(editoCon('A REUNIÓN DE PADRES') && docente().documentoDestinoId !== undefined, '7e. Con la conversación completa, "el primer citatorio" se resuelve por su orden')
  await pedir('Corrige el tercer citatorio')
  verificar(llamadas.length === 0 && /No encuentro ese documento/.test(ultimo().texto), '7f. Ordinal sin documento: aviso, sin cambios')
  await pedir('Cambia la fecha del oficio')
  verificar(llamadas.length === 0 && /No encuentro un oficio/.test(ultimo().texto), '7g. Tipo sin ningún documento: aviso, sin editar el activo')

  // ---- 8. Historial posiblemente incompleto (P3a: confirmar, sin ordinales) ----
  chat.nuevaConversacion()
  const cit = (await pedir('Haz un citatorio para padres', { texto: CITATORIO(20) })).m
  const relleno: Mensaje[] = Array.from({ length: 80 }, (_, i) => ({ id: `msg-relleno-${i}`, rol: i % 2 ? 'asistente' as const : 'usuario' as const, texto: `Charla ${i}`, creadoEn: cit.creadoEn + 1 + i }))
  chat.mensajes = [...chat.mensajes, ...relleno]
  const exa = (await pedir('Hazme un examen de fracciones', { texto: EXAMEN(1) })).m
  await pedir('Cambia la fecha del citatorio')
  verificar(llamadas.length === 0 && chat.documentoActivo?.id === exa.id && /Esta conversación es larga/.test(ultimo().texto) && JSON.stringify(candidatosDe(ultimo())) === JSON.stringify([cit.id]), '8a. Conversación posiblemente incompleta: el único citatorio visible se confirma antes de editar')
  await pedir('Sí', { texto: CITATORIO(21) })
  verificar(editoCon('Fecha: 20 de mayo') && docente().documentoDestinoId === cit.id, '8b. "Sí": edita ese citatorio')
  await pedir('Pasa el examen a Word')
  verificar(llamadas.length === 0 && JSON.stringify(candidatosDe(ultimo())) === JSON.stringify([exa.id]), '8c. Volver al examen también se confirma (el historial puede estar incompleto)')
  await pedir('Corrige el primer citatorio')
  verificar(llamadas.length === 0 && /no puedo saber cuál es por su orden/.test(ultimo().texto) && chat.documentoActivo?.id !== exa.id, '8d. Una solicitud nueva con ordinal no se toma como respuesta a la aclaración pendiente; con historial incompleto el ordinal no se resuelve')

  // ---- 9. Fallo de recuperación ----
  chat.nuevaConversacion()
  const f1 = (await pedir('Haz un citatorio para padres', { texto: CITATORIO(30) })).m
  chat.mensajes = [...chat.mensajes, { id: 'msg-marcador-perdido', rol: 'asistente', texto: 'Volví a la versión anterior del documento.', creadoEn: f1.creadoEn + 1, restauraVersion: 'msg-version-perdida', documentoRaizId: f1.id }]
  const fx = (await pedir('Hazme un examen de fracciones', { texto: EXAMEN(1) })).m
  fallarPorId = true
  await pedir('Cambia la fecha del citatorio')
  fallarPorId = false
  verificar(llamadas.length === 0 && chat.documentoActivo?.id === fx.id && !docente().documentoDestinoId && /no está disponible/.test(ultimo().texto), '9a. La versión vigente del citatorio no se puede recuperar: aviso; el activo no cambia y no se registra selección')
  await pedir('Agrégale una pregunta', { texto: EXAMEN(2) })
  verificar(editoCon('EXAMEN DE FRACCIONES'), '9b. Después, lo implícito sigue sobre el examen')

  // ---- 10. Un solo documento: nombrar otro tipo nunca opera sobre él ----
  chat.nuevaConversacion()
  const unico = (await pedir('Hazme un examen de fracciones', { texto: EXAMEN(1) })).m
  const antesUnico = chat.mensajes.length
  const corrige = await pedir('Corrige el citatorio', { texto: CITATORIO(40) })
  const sinDestino = !chat.mensajes.some((m) => m.documentoDestinoId)
  verificar(corrige.resultado === 'enviado' && llamadas.length === 0 && /No encuentro un citatorio en esta conversación/.test(corrige.m.texto) && chat.documentoActivo?.id === unico.id
    && chat.mensajes.length === antesUnico + 2 && !chat.mensajes.slice(antesUnico).some((m) => p.contenidoDocumentoDe(m as never)) && sinDestino && p.documentoVigente(chat.mensajes as never)?.id === unico.id, '10a. Examen como único documento y "Corrige el citatorio": aviso; no edita ni convierte el examen, no crea versión ni registra destino')
  await pedir('Convierte el citatorio a PDF')
  verificar(llamadas.length === 0 && /No encuentro un citatorio/.test(ultimo().texto) && chat.documentoActivo?.id === unico.id && !chat.mensajes.some((m) => m.documentoDestinoId), '10b. "Convierte el citatorio a PDF" con solo un examen: aviso, sin archivo')
  await pedir('Muéstrame el citatorio')
  verificar(llamadas.length === 0 && /No encuentro un citatorio/.test(ultimo().texto) && chat.archivoReutilizadoId === null && chat.documentoActivo?.id === unico.id, '10c. "Muéstrame el citatorio" con solo un examen: aviso (no muestra el examen como si fuera el citatorio)')
  await pedir('Agrégale una pregunta', { texto: EXAMEN(2) })
  verificar(editoCon('EXAMEN DE FRACCIONES') && ultimo().versionDe === unico.id, '10d. Lo implícito sigue editando el examen')
  await pedir('Hazme un citatorio para padres', { texto: CITATORIO(41) })
  verificar(llamadas.length === 1 && !llamadas[0].edicion && !llamadas[0].finalizar && !docente().documentoDestinoId && chat.documentoActivo?.texto === CITATORIO(41), '10e. Crear un citatorio nuevo sigue el camino normal')

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
