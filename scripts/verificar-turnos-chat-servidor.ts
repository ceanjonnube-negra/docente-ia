// scripts/verificar-turnos-chat-servidor.ts
//
// Turnos duraderos del Chat IA, etapa del servidor (lib/chat/turnosChat.ts),
// sin red ni IA: Supabase simulado (las funciones SQL se prueban en
// PostgreSQL local con scripts/verificar-turnos-chat-sql.sh) y un manejador
// de /api/chat simulado que transmite por fragmentos.
//   npx tsx scripts/verificar-turnos-chat-servidor.ts

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { conTurnoDuradero, huellaSolicitud, MENSAJE_CONVERSACION_OCUPADA, PLAZO_TURNO_SEGUNDOS, textoVisibleDeRespuesta, type DependenciasTurno } from '../lib/chat/turnosChat'
import { registrarAjuste } from '../lib/planeacion/modificarPlaneacion'

let fallos = 0
function verificar(condicion: boolean, nombre: string) {
  if (condicion) console.log(`✓ ${nombre}`)
  else { fallos++; console.log(`✗ ${nombre}`) }
}

const CONV = 'ca000000-0000-4000-8000-000000000001'
const TURNO = 'f0000000-0000-4000-8000-000000000001'
const EJECUCION = 'e0000000-0000-4000-8000-000000000001'
const AJUSTE = { planeacionId: 'da000000-0000-4000-8000-000000000001', versionBase: 2, grupoId: 'a1000000-0000-4000-8000-000000000001', huella: 'a'.repeat(64), formatoSolicitado: null }
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms))
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')

type Llamada = { nombre: string; args: Record<string, unknown> }
function entorno(opciones: { adquisicion?: unknown; errorAdquisicion?: boolean; completar?: (args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> } = {}) {
  const docente: Llamada[] = []
  const servidor: Llamada[] = []
  const tareas: Promise<unknown>[] = []
  const deps: DependenciasTurno = {
    clienteDocente: () => ({ rpc: async (nombre: string, args: Record<string, unknown>) => {
      docente.push({ nombre, args })
      if (opciones.errorAdquisicion) return { data: null, error: { message: 'Could not find the function public.adquirir_turno_chat' } }
      return { data: opciones.adquisicion ?? { resultado: 'adquirido', turno: { id: TURNO, estado: 'generating' }, ejecucion_id: EJECUCION }, error: null }
    } }) as unknown as SupabaseClient,
    clienteServidor: () => ({ rpc: async (nombre: string, args: Record<string, unknown>) => {
      servidor.push({ nombre, args })
      if (nombre === 'completar_turno_chat') return opciones.completar ? opciones.completar(args) : { data: { resultado: 'completado', turno: { id: TURNO, mensaje_asistente_id: args.p_materializar ? `${CONV}:turno-${TURNO}` : null } }, error: null }
      return { data: { resultado: 'fallido' }, error: null }
    } }) as unknown as SupabaseClient,
    despues: (tarea) => { tareas.push(tarea()) },
  }
  return { deps, docente, servidor, terminar: () => Promise.all(tareas) }
}

// Manejador simulado de /api/chat: transmite fragmentos con pausas (como el
// modelo) y, si se pide, registra un ajuste a mitad del stream.
function manejador(fragmentos: string[], opciones: { ajuste?: boolean; fallaEn?: number; sbDirecto?: { escrituras: number } } = {}) {
  const llamadas = { veces: 0 }
  const procesar = async () => {
    llamadas.veces++
    const encoder = new TextEncoder()
    return new Response(new ReadableStream({
      async start(c) {
        for (let i = 0; i < fragmentos.length; i++) {
          await espera(5)
          if (opciones.fallaEn === i) { c.error(new Error('RESPUESTA_INTERRUMPIDA')); return }
          c.enqueue(encoder.encode(fragmentos[i]))
          if (opciones.ajuste && i === 0) {
            const sb = { from: () => { opciones.sbDirecto!.escrituras++; return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }), update: () => ({ eq: async () => ({ error: null }) }) } } } as unknown as SupabaseClient
            await registrarAjuste(sb, CONV, AJUSTE)
          }
        }
        c.close()
      },
    }), { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Prueba': 'si' } })
  }
  return { procesar, llamadas }
}

const peticion = (cuerpo: Record<string, unknown>) => new Request('http://local/api/chat', { method: 'POST', body: JSON.stringify({ mensaje: 'Reemplaza el quinto indicador', accessToken: 'token', conversacionId: CONV, formatoEntrega: null, ...cuerpo }) })
async function leerTodo(r: Response) { return new TextDecoder().decode(new Uint8Array(await new Response(r.body).arrayBuffer())) }

async function main() {
  const FRAGMENTOS = ['📋 PLANEACIÓN', ' — Día 2', `\n\n[[TEXTO_FINAL:${b64('📋 PLANEACIÓN — Día 2 (final)')}]]`]
  const ORIGINAL = FRAGMENTOS.join('')

  // ============================================================
  // 1. Cliente actual (sin requestId ni protocolo)
  // ============================================================
  {
    const e = entorno()
    const sbDirecto = { escrituras: 0 }
    const m = manejador(FRAGMENTOS, { ajuste: true, sbDirecto })
    const r = await conTurnoDuradero(peticion({}), m.procesar, e.deps)
    const texto = await leerTodo(r)
    await e.terminar()
    const adq = e.docente[0]
    verificar(texto === ORIGINAL && r.headers.get('X-Prueba') === 'si' && m.llamadas.veces === 1, '1a. El cliente actual recibe exactamente el mismo stream y encabezados (sin marcadores nuevos)')
    verificar(adq?.nombre === 'adquirir_turno_chat' && String(adq.args.p_request_id).startsWith('srv-') && adq.args.p_protocolo === 0 && adq.args.p_mensaje_usuario_id === null && adq.args.p_plazo_segundos === PLAZO_TURNO_SEGUNDOS,
      '1b. Turno con identidad generada por el servidor; el cliente actual no materializa mensajes')
    const completar = e.servidor.find((c) => c.nombre === 'completar_turno_chat')
    verificar(!!completar && completar.args.p_texto_crudo === ORIGINAL && completar.args.p_texto_final === '📋 PLANEACIÓN — Día 2 (final)' && completar.args.p_materializar === false,
      '1c. La respuesta completa se guarda en el servidor (crudo y texto final); sin mensaje del servidor para el cliente actual')
    verificar(JSON.stringify(completar?.args.p_ajuste) === JSON.stringify(AJUSTE) && sbDirecto.escrituras === 0,
      '1d. El ajuste registrado durante el turno se difiere y se escribe en la misma transacción que el turno (no por separado)')
    verificar(e.docente.every((c) => c.nombre === 'adquirir_turno_chat') && e.servidor.every((c) => ['completar_turno_chat', 'fallar_turno_chat'].includes(c.nombre)),
      '1e. El docente solo adquiere; completar y fallar los hace solo el cliente del servidor (service_role)')
  }

  // ============================================================
  // 2. Desconexión del dispositivo a mitad del stream
  // ============================================================
  {
    const e = entorno()
    const m = manejador(FRAGMENTOS)
    const r = await conTurnoDuradero(peticion({}), m.procesar, e.deps)
    const lector = r.body!.getReader()
    const primero = await lector.read()
    await lector.cancel()
    await e.terminar()
    const completar = e.servidor.find((c) => c.nombre === 'completar_turno_chat')
    verificar(!primero.done && completar?.args.p_texto_crudo === ORIGINAL, '2a. El cliente se desconecta tras el primer fragmento: la generación sigue y la respuesta COMPLETA queda guardada')
    verificar(!e.servidor.some((c) => c.nombre === 'fallar_turno_chat'), '2b. Una desconexión del cliente no es una falla del turno')
  }

  // ============================================================
  // 3. Persistencia antes del cierre (protocolo 1)
  // ============================================================
  {
    let guardado = false
    const e = entorno({ completar: async (args) => { await espera(40); guardado = true; return { data: { resultado: 'completado', turno: { id: TURNO, mensaje_asistente_id: args.p_materializar ? `${CONV}:turno-${TURNO}` : null } }, error: null } } })
    const m = manejador(FRAGMENTOS)
    const r = await conTurnoDuradero(peticion({ requestId: 'req-cliente-0001', mensajeUsuarioId: `${CONV}:msg-1`, protocoloTurno: 1 }), m.procesar, e.deps)
    const lector = r.body!.getReader()
    let texto = ''
    let guardadoAlCerrar = false
    for (;;) { const { done, value } = await lector.read(); if (done) { guardadoAlCerrar = guardado; break } texto += new TextDecoder().decode(value) }
    await e.terminar()
    const marcador = texto.match(/\[\[TURNO:([^\]]+)\]\]$/)
    const datos = marcador ? JSON.parse(Buffer.from(marcador[1], 'base64').toString('utf8')) : null
    verificar(guardadoAlCerrar && texto.startsWith(ORIGINAL), '3a. El stream se cierra solo DESPUÉS de guardar el turno')
    verificar(datos?.estado === 'completado' && datos.turnoId === TURNO && datos.mensajeAsistenteId === `${CONV}:turno-${TURNO}` && datos.requestId === 'req-cliente-0001',
      '3b. Con protocolo, el cierre trae la identidad del turno y del mensaje del asistente (creado atómicamente por el servidor)')
    const adq = e.docente[0].args
    verificar(adq.p_request_id === 'req-cliente-0001' && adq.p_protocolo === 1 && adq.p_mensaje_usuario_id === `${CONV}:msg-1` && e.servidor[0].args.p_materializar === true, '3c. Identidad del cliente (requestId y mensaje) y materialización del mensaje del asistente')
  }

  // ============================================================
  // 3d. Respuesta con tarjeta (protocolo 1): mensaje con su archivo
  // ============================================================
  {
    const e = entorno()
    const archivo = { nombre: 'Hoja SG-TEST.pdf', tipo: 'pdf', url: '/api/planeaciones/vista-previa-hoja?id=1&token=secreto', archivoId: 'arch-1' }
    const texto = 'Listo: guardé «Cuentos» como versión 3.'
    const r = await conTurnoDuradero(peticion({ requestId: 'req-cliente-0009', mensajeUsuarioId: `${CONV}:msg-9`, protocoloTurno: 1 }), manejador([texto, `\n[[DOCUMENTO_ARCHIVO:${b64(JSON.stringify(archivo))}]]`]).procesar, e.deps)
    await leerTodo(r)
    await e.terminar()
    const c = e.servidor.find((x) => x.nombre === 'completar_turno_chat')?.args
    const contenido = c?.p_contenido as { archivo?: { url: string; archivoId: string }; archivos?: unknown[] } | null
    verificar(c?.p_materializar === true && c.p_texto_final === texto && contenido?.archivo?.archivoId === 'arch-1' && contenido.archivo.url === '/api/planeaciones/vista-previa-hoja?id=1' && contenido.archivos?.length === 1,
      '3d. Respuesta con tarjeta: se materializa con su archivo (referencia ya generada, sin token de vista previa)')
    const sinProtocolo = entorno()
    await leerTodo(await conTurnoDuradero(peticion({}), manejador([texto, `\n[[DOCUMENTO_ARCHIVO:${b64(JSON.stringify(archivo))}]]`]).procesar, sinProtocolo.deps))
    await sinProtocolo.terminar()
    const c0 = sinProtocolo.servidor.find((x) => x.nombre === 'completar_turno_chat')?.args
    verificar(c0?.p_materializar === false && c0.p_contenido === null, '3e. Cliente anterior: sin mensaje del servidor (tampoco con tarjetas)')
    const nav = entorno()
    await leerTodo(await conTurnoDuradero(peticion({ requestId: 'req-cliente-0010', mensajeUsuarioId: `${CONV}:msg-10`, protocoloTurno: 1 }), manejador(['Abriendo la lista', '\n[[NAVEGACION:abc]]']).procesar, nav.deps))
    await nav.terminar()
    const cn = nav.servidor.find((x) => x.nombre === 'completar_turno_chat')?.args
    verificar(cn?.p_materializar === false && cn.p_texto_final === null, '3f. Tarjeta que depende del estado del cliente (navegación): la guarda el cliente, como siempre')
  }

  // ============================================================
  // 4. Fallas
  // ============================================================
  {
    const e = entorno()
    const m = manejador(FRAGMENTOS, { fallaEn: 2 })
    const r = await conTurnoDuradero(peticion({}), m.procesar, e.deps)
    let error: unknown = null
    try { await leerTodo(r) } catch (x) { error = x }
    await e.terminar()
    const fallar = e.servidor.find((c) => c.nombre === 'fallar_turno_chat')
    verificar(!!error && fallar?.args.p_codigo === 'error_generacion' && fallar.args.p_texto_parcial === FRAGMENTOS[0] + FRAGMENTOS[1] && !e.servidor.some((c) => c.nombre === 'completar_turno_chat'),
      '4a. Generación interrumpida: turno fallido con su texto parcial; el cliente recibe el error de siempre; nunca se completa')
  }
  {
    const e = entorno({ completar: async () => ({ data: null, error: { message: 'ajuste_invalido' } }) })
    const r = await conTurnoDuradero(peticion({}), manejador(FRAGMENTOS).procesar, e.deps)
    const texto = await leerTodo(r)
    await e.terminar()
    verificar(texto === ORIGINAL && e.servidor.some((c) => c.nombre === 'fallar_turno_chat' && c.args.p_codigo === 'error_persistencia'),
      '4b. No se pudo guardar: el turno queda fallido (error_persistencia), nunca completado; el cliente actual recibe lo mismo')
  }
  {
    const e = entorno()
    const sbDirecto = { escrituras: 0 }
    const r = await conTurnoDuradero(peticion({ requestId: 'req-cliente-0002', mensajeUsuarioId: `${CONV}:msg-2`, protocoloTurno: 1 }), manejador(['[[ARCHIVO:x]]'], { ajuste: true, sbDirecto }).procesar, e.deps)
    const texto = await leerTodo(r)
    await e.terminar()
    verificar(!e.servidor.some((c) => c.nombre === 'completar_turno_chat') && e.servidor.some((c) => c.nombre === 'fallar_turno_chat' && c.args.p_codigo === 'error_persistencia') && texto.includes('[[TURNO:'),
      '4c. Borrador de ajuste sin texto final materializable: no se declara completado (no sería aprobable)')
  }
  {
    const e = entorno()
    const procesar = async () => new Response('Error detectado', { status: 500 })
    const r = await conTurnoDuradero(peticion({}), procesar, e.deps)
    verificar(r.status === 500 && (await r.text()) === 'Error detectado' && e.servidor.some((c) => c.nombre === 'fallar_turno_chat' && c.args.p_codigo === 'error_generacion'), '4d. Respuesta de error de la ruta: se conserva tal cual y el turno queda fallido')
  }

  // ============================================================
  // 5. Recuperar sin reejecutar y respuestas sin turno
  // ============================================================
  {
    const e = entorno({ adquisicion: { resultado: 'completado', turno: { id: TURNO, texto_crudo: ORIGINAL, mensaje_asistente_id: `${CONV}:turno-${TURNO}` } } })
    const m = manejador(FRAGMENTOS)
    const r = await conTurnoDuradero(peticion({ requestId: 'req-cliente-0003', mensajeUsuarioId: `${CONV}:msg-3`, protocoloTurno: 1 }), m.procesar, e.deps)
    const texto = await leerTodo(r)
    verificar(m.llamadas.veces === 0 && texto.startsWith(ORIGINAL) && texto.includes('[[TURNO:') && e.servidor.length === 0, '5a. Reenviar un turno terminado: su respuesta guardada, sin ejecutar la ruta ni llamar a la IA')
  }
  for (const resultado of ['en_proceso', 'fallido', 'reintento_requerido', 'conflicto', 'mensaje_en_curso']) {
    const e = entorno({ adquisicion: { resultado, turno: { id: TURNO, estado: 'failed', reintentable: true } } })
    const m = manejador(FRAGMENTOS)
    const r = await conTurnoDuradero(peticion({ requestId: 'req-cliente-0004', mensajeUsuarioId: `${CONV}:msg-4`, protocoloTurno: 1 }), m.procesar, e.deps)
    const cuerpo = await r.json()
    verificar(m.llamadas.veces === 0 && r.status === 409 && cuerpo.estadoTurno === resultado, `5b. ${resultado}: se informa (409) sin ejecutar; nunca se reintenta automáticamente`)
  }
  {
    const e = entorno({ adquisicion: { resultado: 'ocupada' } })
    const m = manejador(FRAGMENTOS)
    const r = await conTurnoDuradero(peticion({}), m.procesar, e.deps)
    verificar(m.llamadas.veces === 0 && (await r.text()) === MENSAJE_CONVERSACION_OCUPADA, '5c. Conversación con otro turno activo: el cliente actual recibe un aviso claro, sin ejecutar')
  }
  {
    const e = entorno({ adquisicion: { resultado: 'conversacion_invalida' } })
    const m = manejador(FRAGMENTOS)
    const r = await conTurnoDuradero(peticion({}), m.procesar, e.deps)
    const r2 = await conTurnoDuradero(peticion({ requestId: 'req-cliente-0005', mensajeUsuarioId: `${CONV}:msg-5`, protocoloTurno: 1 }), m.procesar, e.deps)
    verificar((await leerTodo(r)) === ORIGINAL && m.llamadas.veces === 1 && r2.status === 400, '5d. Identidad no válida: el cliente actual sigue como siempre; con protocolo, envío rechazado')
  }
  {
    const e = entorno({ errorAdquisicion: true })
    const sbDirecto = { escrituras: 0 }
    const m = manejador(FRAGMENTOS, { ajuste: true, sbDirecto })
    const r = await conTurnoDuradero(peticion({}), m.procesar, e.deps)
    verificar((await leerTodo(r)) === ORIGINAL && m.llamadas.veces === 1 && e.servidor.length === 0 && sbDirecto.escrituras > 0, '5e. Sin infraestructura de turnos (migración pendiente): responde como siempre y el ajuste se registra directo')
  }
  for (const [nombre, cuerpo] of [['imagen', { imagenBase64: 'x' }], ['archivo por finalizar', { finalizarArchivo: { tipo: 'word' } }], ['entrega con formato', { formatoEntrega: 'pdf' }], ['voz', { channel: 'voice' }], ['sin conversación', { conversacionId: null }]] as const) {
    const e = entorno()
    const m = manejador(FRAGMENTOS)
    await leerTodo(await conTurnoDuradero(peticion(cuerpo), m.procesar, e.deps))
    verificar(e.docente.length === 0 && m.llamadas.veces === 1, `5f. Fuera del alcance de esta etapa (${nombre}): sin turno, como siempre`)
  }

  // ============================================================
  // 6. Piezas puras y ruta
  // ============================================================
  verificar(textoVisibleDeRespuesta(ORIGINAL) === '📋 PLANEACIÓN — Día 2 (final)' && textoVisibleDeRespuesta('Hola, ¿en qué te ayudo?') === 'Hola, ¿en qué te ayudo?' && textoVisibleDeRespuesta('Listo [[ARCHIVO:abc]]') === null && textoVisibleDeRespuesta('  ') === null,
    '6a. Texto visible: el texto final del servidor, o el texto sin marcadores; null si quedan marcadores del cliente')
  const base = { mensaje: 'a', conversacionId: CONV }
  verificar(huellaSolicitud(base) === huellaSolicitud({ ...base }) && huellaSolicitud(base) !== huellaSolicitud({ ...base, mensaje: 'b' }) && huellaSolicitud(base) !== huellaSolicitud({ ...base, esEdicionDocumento: true }) && /^[0-9a-f]{64}$/.test(huellaSolicitud(base)),
    '6b. Huella del contenido del envío: estable y distinta si cambia el contenido')
  const ruta = readFileSync(join(__dirname, '..', 'app', 'api', 'chat', 'route.ts'), 'utf-8')
  const modulo = readFileSync(join(__dirname, '..', 'lib', 'chat', 'turnosChat.ts'), 'utf-8')
  const consulta = readFileSync(join(__dirname, '..', 'app', 'api', 'chat', 'turno', 'route.ts'), 'utf-8')
  verificar(ruta.includes('return conTurnoDuradero(req, (r) => atenderChat(r as NextRequest))') && /export const maxDuration = (\d+)/.exec(ruta)?.[1] === '180' && PLAZO_TURNO_SEGUNDOS > 180,
    '6c. /api/chat envuelve su manejador; el plazo del turno supera la duración máxima de la función')
  verificar(modulo.includes("despues: (tarea) => after(tarea)") && !/anthropic|messages\.create/.test(modulo + consulta), '6d. after() mantiene viva la persistencia; ni el módulo ni la consulta llaman a la IA')
  verificar(consulta.includes("rpc('consultar_turno_chat'") && consulta.includes('autenticarRequestApi(') && !consulta.includes('SERVICE_ROLE'), '6e. Consulta de turnos: docente autenticado, solo lectura de lo suyo (sin service_role)')

  console.log(fallos === 0 ? '\nTodas las pruebas pasaron.' : `\n${fallos} prueba(s) fallaron.`)
  process.exit(fallos === 0 ? 0 : 1)
}

main()
