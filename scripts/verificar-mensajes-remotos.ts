// scripts/verificar-mensajes-remotos.ts
//
// Persistencia remota, etapa 1: los mensajes nuevos del Chat IA se
// copian a mensajes_chat con ids estables por conversación y mensaje,
// solo lo nuevo o cambiado, con cola local y reintentos, sin mezclar
// docentes ni conversaciones y sin tocar el historial anterior.
//
// Sin red, sin credenciales, sin IA (Supabase se sustituye por un
// doble en memoria). Se ejecuta con
// `npx tsx scripts/verificar-mensajes-remotos.ts`.

// Módulo (no script global): sus nombres no chocan con otros scripts.
export {}

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  console.log(`${condicion ? '✓' : '✗'} ${mensaje}`)
  if (!condicion) fallos++
}

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://supabase.invalid'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'clave-ficticia'
const almacen = new Map<string, string>()
const g = globalThis as unknown as Record<string, unknown>
g.window = { localStorage: { getItem: (k: string) => almacen.get(k) ?? null, setItem: (k: string, v: string) => { almacen.set(k, v) }, removeItem: (k: string) => { almacen.delete(k) } }, addEventListener() {}, removeEventListener() {} }
g.localStorage = (g.window as { localStorage: unknown }).localStorage

type Fila = { id: string; conversacion_id: string; docente_id: string; rol: string; texto: string; contenido: Record<string, unknown>; creado_en: string }

async function main() {
  const { supabase } = await import('../lib/supabaseClient')
  const p = await import('../lib/asistente/persistencia')

  // Doble de Supabase: registra cada escritura y deja simular fallos.
  const DOCENTE_A = '11111111-1111-4111-8111-111111111111'
  const DOCENTE_B = '22222222-2222-4222-8222-222222222222'
  let sesion: string | null = DOCENTE_A
  let falloUpsert: string | null = null
  let confirmarSolo: ((f: Fila) => boolean) | null = null
  const upserts: { filas: Fila[]; onConflict?: string }[] = []
  const remotos = new Map<string, Fila>()
  const s = supabase as unknown as Record<string, unknown>
  ;(s.auth as Record<string, unknown>).getSession = async () => ({ data: { session: sesion ? { user: { id: sesion } } : null }, error: null })
  s.rpc = async () => ({ data: null, error: null })
  s.from = (tabla: string) => ({
    insert: async () => ({ error: null }),
    upsert: (filas: Fila[], opciones: { onConflict?: string }) => ({
      select: async () => {
        if (tabla !== 'mensajes_chat') return { data: null, error: { message: 'tabla inesperada' } }
        upserts.push({ filas: JSON.parse(JSON.stringify(filas)), onConflict: opciones?.onConflict })
        if (falloUpsert) return { data: null, error: { code: falloUpsert, message: 'fallo simulado' } }
        const confirmadas = filas.filter((f) => !confirmarSolo || confirmarSolo(f))
        for (const f of confirmadas) remotos.set(f.id, f)
        return { data: confirmadas.map((f) => ({ id: f.id })), error: null }
      },
    }),
  })

  const estado = (d: string) => JSON.parse(almacen.get(`docente-ia:mensajes-remotos:${d}`) ?? 'null') as { desde: number; pendientes: { fila: Fila }[]; huellas: Record<string, string> } | null
  const ahora = Date.now()
  const m = (id: string, rol: 'usuario' | 'asistente', texto: string, extra: Record<string, unknown> = {}) => ({ id, rol, texto, creadoEn: ahora + 1000, ...extra })

  // 1. Línea base: el primer uso fija `desde`; lo anterior no se migra.
  const ANTIGUO = { id: 'msg-1-0', rol: 'usuario' as const, texto: 'Mensaje de antes de la etapa 1', creadoEn: ahora - 60_000 }
  await p.guardarMensajesRemotos('conv-local-1', DOCENTE_A, [ANTIGUO])
  verificar(estado(DOCENTE_A)?.desde !== undefined && upserts.length === 0, '1a. Historial anterior a la etapa 1: no se envía nada (sin migración)')

  // 2. Mensajes nuevos: un upsert con ids compuestos y datos completos.
  const DOC_TEXTO = '📨 CITATORIO\n\nEstimados padres de familia...'
  const nuevos = [
    ANTIGUO,
    m('msg-2-0', 'usuario', 'Hazme un citatorio', { imagen: { base64: 'A'.repeat(5000), tipo: 'image/jpeg', nombreArchivo: 'lista.jpg' } }),
    m('msg-2-1', 'asistente', DOC_TEXTO, { archivo: { tipo: 'pdf', nombre: 'CITATORIO.pdf', url: 'https://x.invalid/a.pdf', urlVer: 'https://x.invalid/v.pdf' }, contenidoDocumento: DOC_TEXTO, datosPropuestaLista: { estado: 'pendiente', expiraEn: new Date(ahora + 3_600_000).toISOString(), token: 'TOKEN-SECRETO', operaciones: [] } }),
  ]
  await p.guardarMensajesRemotos('conv-local-1', DOCENTE_A, nuevos as never)
  const envio = upserts[0]
  const conv1 = envio?.filas[0]?.conversacion_id
  verificar(upserts.length === 1 && envio.filas.length === 2 && envio.onConflict === 'id', '2a. Un solo envío con los 2 mensajes nuevos (el antiguo se excluye)')
  verificar(!!conv1 && envio.filas.every((f) => f.id === `${conv1}:${f.id.split(':')[1]}` && f.conversacion_id === conv1 && f.docente_id === DOCENTE_A), '2b. Id remoto = <conversación remota>:<id local>, del docente y la conversación correctos')
  const doc = envio?.filas.find((f) => f.id.endsWith(':msg-2-1'))
  const usuario = envio?.filas.find((f) => f.id.endsWith(':msg-2-0'))
  verificar(doc?.texto === DOC_TEXTO && (doc?.contenido.archivo as { nombre?: string })?.nombre === 'CITATORIO.pdf' && doc?.contenido.contenidoDocumento === DOC_TEXTO && doc?.rol === 'asistente', '2c. Se conservan texto, rol, archivo (referencia y URLs) y contenidoDocumento')
  verificar((usuario?.contenido.imagen as { base64?: string; nombreArchivo?: string })?.base64 === '' && (usuario?.contenido.imagen as { nombreArchivo?: string })?.nombreArchivo === 'lista.jpg', '2d. Imagen sin base64 (solo tipo y nombre)')
  verificar(!JSON.stringify(envio?.filas).includes('TOKEN-SECRETO') && (doc?.contenido.datosPropuestaLista as { estado?: string })?.estado === 'pendiente', '2e. El token de la propuesta de lista nunca sale del dispositivo')
  verificar(!('id' in (doc?.contenido ?? {})) && !('creadoEn' in (doc?.contenido ?? {})) && doc?.creado_en === new Date(ahora + 1000).toISOString(), '2f. contenido sin campos duplicados; creado_en = creadoEn local')
  verificar(estado(DOCENTE_A)?.pendientes.length === 0 && Object.keys(estado(DOCENTE_A)?.huellas ?? {}).length === 2, '2g. Confirmados por Supabase: cola vacía y 2 huellas registradas')

  // 3. Idempotencia: lo mismo otra vez no escribe nada.
  await p.guardarMensajesRemotos('conv-local-1', DOCENTE_A, nuevos as never)
  verificar(upserts.length === 1, '3a. Mismos mensajes otra vez: cero escrituras')

  // 4. Cambio en un mensaje: solo ese se reenvía, a la MISMA fila.
  const conArchivoNuevo = [...nuevos.slice(0, 2), { ...nuevos[2], archivo: { tipo: 'word', nombre: 'CITATORIO.docx', url: 'https://x.invalid/a.docx' } }]
  await p.guardarMensajesRemotos('conv-local-1', DOCENTE_A, conArchivoNuevo as never)
  verificar(upserts.length === 2 && upserts[1].filas.length === 1 && upserts[1].filas[0].id === doc?.id, '4a. Mensaje modificado: se reenvía solo él, a su misma fila (sin duplicar)')

  // 5. Mismo id local en OTRA conversación: fila distinta, sin colisión.
  await p.guardarMensajesRemotos('conv-local-2', DOCENTE_A, [m('msg-2-1', 'asistente', 'Otra conversación')] as never)
  const otra = upserts[2]?.filas[0]
  verificar(!!otra && otra.id !== doc?.id && otra.conversacion_id !== conv1 && remotos.get(doc!.id)?.texto === DOC_TEXTO, '5a. Mismo id local en otra conversación: fila distinta; la primera no se sobrescribe')

  // 6. Fallo de red: queda en cola, no se marca; el reintento lo envía.
  falloUpsert = 'NETWORK'
  await p.guardarMensajesRemotos('conv-local-1', DOCENTE_A, [...conArchivoNuevo, m('msg-3-0', 'usuario', 'Gracias')] as never)
  const enCola = estado(DOCENTE_A)?.pendientes ?? []
  verificar(enCola.length === 1 && enCola[0].fila.id.endsWith(':msg-3-0') && !estado(DOCENTE_A)?.huellas[enCola[0].fila.id], '6a. Fallo: el mensaje queda en la cola local y NO se marca sincronizado')
  falloUpsert = null
  const antes = upserts.length
  await p.reintentarMensajesRemotosPendientes(DOCENTE_A)
  verificar(upserts.length === antes + 1 && estado(DOCENTE_A)?.pendientes.length === 0 && remotos.has(enCola[0].fila.id), '6b. Reintento: se envía, se confirma y la cola queda vacía')
  await p.reintentarMensajesRemotosPendientes(DOCENTE_A)
  verificar(upserts.length === antes + 1, '6c. Reintento sin pendientes: cero escrituras')

  // 7. Confirmación parcial: solo lo confirmado se marca.
  confirmarSolo = (f) => f.id.endsWith(':msg-4-0')
  await p.guardarMensajesRemotos('conv-local-1', DOCENTE_A, [m('msg-4-0', 'usuario', 'Uno'), m('msg-4-1', 'asistente', 'Dos')] as never)
  confirmarSolo = null
  const tras7 = estado(DOCENTE_A)
  verificar(tras7?.pendientes.length === 1 && tras7.pendientes[0].fila.id.endsWith(':msg-4-1') && Object.keys(tras7.huellas).some((k) => k.endsWith(':msg-4-0')), '7a. Confirmación parcial: el no confirmado sigue pendiente')
  await p.reintentarMensajesRemotosPendientes(DOCENTE_A)

  // 8. Aislamiento: con la sesión de otro docente no se envía nada.
  sesion = DOCENTE_B
  const antes8 = upserts.length
  await p.guardarMensajesRemotos('conv-local-1', DOCENTE_A, [m('msg-5-0', 'usuario', 'Privado de A')] as never)
  verificar(upserts.length === antes8 && estado(DOCENTE_A)?.pendientes.length === 1, '8a. Sesión de otro docente: la cola de A espera, nada se envía')
  sesion = null
  await p.reintentarMensajesRemotosPendientes(DOCENTE_A)
  verificar(upserts.length === antes8, '8b. Sin sesión: nada se envía')
  sesion = DOCENTE_B
  await p.guardarMensajesRemotos('conv-local-1', DOCENTE_B, [m('msg-5-0', 'usuario', 'De B')] as never)
  const deB = upserts[upserts.length - 1]?.filas[0]
  verificar(upserts.length === antes8 + 1 && deB?.docente_id === DOCENTE_B && deB.conversacion_id !== conv1 && upserts[upserts.length - 1].filas.length === 1, '8c. Mismo id local con otro docente: otra conversación remota; la cola de A no viaja con la sesión de B')
  sesion = DOCENTE_A
  await p.reintentarMensajesRemotosPendientes(DOCENTE_A)
  verificar(estado(DOCENTE_A)?.pendientes.length === 0 && upserts[upserts.length - 1].filas.every((f) => f.docente_id === DOCENTE_A), '8d. De vuelta la sesión de A: su cola se envía con su docente_id')

  // 9. Ids deterministas: misma conversación local → misma fila remota.
  upserts.length = 0
  almacen.delete(`docente-ia:mensajes-remotos:${DOCENTE_A}`)
  await p.guardarMensajesRemotos('conv-local-1', DOCENTE_A, [{ id: 'msg-9-0', rol: 'usuario', texto: 'Anterior a la nueva línea base', creadoEn: Date.now() - 1 }] as never)
  verificar(upserts.length === 0, '9a. Estado de sincronización perdido: nueva línea base, sin reenviar historial')
  await p.guardarMensajesRemotos('conv-local-1', DOCENTE_A, [{ id: 'msg-9-1', rol: 'usuario', texto: 'Nuevo', creadoEn: Date.now() + 5000 }] as never)
  verificar(upserts[0]?.filas[0]?.conversacion_id === conv1, '9b. La misma conversación local siempre apunta a la misma conversación remota')

  // 10. AsistenteService: integración (código fuente).
  const { readFileSync } = await import('node:fs')
  const servicio = readFileSync('lib/asistente/AsistenteService.ts', 'utf8')
  const guardarAhora = servicio.slice(servicio.indexOf('private guardarAhora() {'), servicio.indexOf('private copiaRemotaTimer'))
  verificar(/guardarConversacion\(this\.conversacionActivaId, this\.mensajes, this\.documentoActivo\)\s*\n\s*this\.listaConversaciones = listarConversaciones\(\)\s*\n\s*this\.programarCopiaRemota\(this\.conversacionActivaId, this\.mensajes\)/.test(guardarAhora), '10a. La copia remota se programa después del guardado local, sin cambiarlo')
  const envioRemoto = servicio.slice(servicio.indexOf('private async enviarCopiaRemota() {'), servicio.indexOf('// Guardado inmediato, sin esperar el debounce'))
  verificar(/if \(this\.generando\) return/.test(envioRemoto) && !/turnoAbierto\)/.test(envioRemoto) && !/setTimeout/.test(envioRemoto) && /vigentes\.has\(localId\)/.test(envioRemoto) && !/this\.mensajes =|this\.documentoActivo =|notificar\(\)/.test(envioRemoto), '10b. Espera solo a la generación (no a turnoAbierto), sin sondeo, solo conversaciones vigentes y sin tocar el estado del chat')
  verificar(!/fetch\(|\/api\/chat|messages\.create/.test(envioRemoto) && /if \(evento === 'SIGNED_OUT'\) AsistenteService\.limpiarConversacionGuardada\(\)/.test(servicio), '10c. Sin llamadas de IA; el cierre de sesión no cambia')
  const persistencia = readFileSync('lib/asistente/persistencia.ts', 'utf8')
  verificar(!/service_role|SERVICE_ROLE|\.from\([^)]*\)\s*\.delete/.test(persistencia.slice(persistencia.indexOf('// Copia remota de los mensajes'))), '10d. Sin credenciales privilegiadas ni borrados')

  // 11. Ciclo real en AsistenteService: usuario → respuesta parcial →
  // respuesta final → se guardan AMBOS mensajes, una sola vez, y nunca
  // el texto parcial. (Defecto real: turnoAbierto sigue abierto tras la
  // respuesta final y bloqueaba la copia de la respuesta.)
  const espera = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const { AsistenteService } = await import('../lib/asistente/AsistenteService')
  const chat = AsistenteService as unknown as { mensajes: { id: string; rol: string; texto: string }[]; conversacionActivaId: string | null; generando: boolean; turnoAbierto: string | null; copiaRemotaTimer: unknown; manejarEventoMotor(e: unknown): void }
  sesion = DOCENTE_A
  chat.conversacionActivaId = null
  chat.mensajes = []
  upserts.length = 0
  const FINAL = 'Mensaje recibido correctamente.'
  chat.manejarEventoMotor({ tipo: 'mensaje-usuario', texto: 'PRUEBA CICLO REAL' })
  chat.manejarEventoMotor({ tipo: 'respuesta-parcial', texto: 'Mensaje reci' })
  await espera(2600)
  verificar(upserts.length === 0 && chat.generando === true, '11a. Mientras se genera la respuesta: cero escrituras')
  verificar(chat.copiaRemotaTimer === null, '11b. Durante la generación no queda ningún temporizador repitiéndose')
  // Como el motor real: cada parcial trae el texto acumulado y la final repite el completo.
  chat.manejarEventoMotor({ tipo: 'respuesta-parcial', texto: FINAL })
  chat.manejarEventoMotor({ tipo: 'respuesta-final', texto: FINAL })
  verificar(chat.turnoAbierto !== null && chat.generando === false, '11c. Tras la respuesta final turnoAbierto sigue abierto (comportamiento del chat sin cambios)')
  await espera(2600)
  const filas11 = upserts.flatMap((u) => u.filas)
  verificar(upserts.length === 1 && filas11.length === 2 && filas11.some((f) => f.rol === 'usuario' && f.texto === 'PRUEBA CICLO REAL') && filas11.some((f) => f.rol === 'asistente' && f.texto === FINAL), '11d. Tras la respuesta final: se guardan el mensaje del docente Y la respuesta final, en un solo envío')
  verificar(!filas11.some((f) => f.texto === 'Mensaje reci') && filas11.every((f) => f.conversacion_id === filas11[0].conversacion_id && f.docente_id === DOCENTE_A), '11e. Nunca se guarda texto parcial; ambos en la misma conversación y del docente correcto')
  await espera(2600)
  verificar(upserts.length === 1 && chat.copiaRemotaTimer === null, '11f. Sin duplicados ni temporizadores pendientes después')
  verificar(chat.mensajes.length === 2 && chat.mensajes[0].rol === 'usuario' && chat.mensajes[1].texto === FINAL, '11g. Lo que ve el docente no cambia (2 burbujas, respuesta final)')
  chat.manejarEventoMotor({ tipo: 'mensaje-usuario', texto: 'Segundo turno' })
  chat.manejarEventoMotor({ tipo: 'respuesta-parcial', texto: 'Otra resp' })
  chat.manejarEventoMotor({ tipo: 'respuesta-parcial', texto: 'Otra respuesta.' })
  chat.manejarEventoMotor({ tipo: 'respuesta-final', texto: 'Otra respuesta.' })
  await espera(2600)
  const segundo = upserts[1]?.filas ?? []
  verificar(upserts.length === 2 && segundo.length === 2 && segundo.every((f) => f.texto === 'Segundo turno' || f.texto === 'Otra respuesta.') && segundo[0].conversacion_id === filas11[0].conversacion_id, '11h. Segundo turno: solo sus 2 mensajes nuevos, misma conversación, sin reenviar el primero')

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
