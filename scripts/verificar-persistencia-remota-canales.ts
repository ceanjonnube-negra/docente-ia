// PASO 3B — prueba aislada: unificación de la persistencia remota
// (Supabase) entre TODOS los canales del Chat IA (texto, voz,
// multifoto, trabajo asíncrono, calendario/navegación), no solo el
// texto normal ya probado en el PASO 3.
//
// NO invoca a Claude de verdad (créditos de Anthropic agotados, ver
// rondas anteriores) — ejercita DIRECTAMENTE los métodos reales del
// singleton (algunos privados, cast `as any`: es el código real que
// se está verificando) simulando lo que cada canal haría con el
// resultado ya resuelto. Donde el código real SÍ intenta una llamada
// de red real (multifoto → /api/chat), se deja que falle de forma
// natural (try/catch ya existente en AsistenteService) y solo se
// verifica la parte de persistencia, que ocurre ANTES de esa llamada.

import { createClient } from '@supabase/supabase-js'
import { AsistenteService } from '../lib/asistente/AsistenteService'
import type { MensajeConversacion, AdjuntoImagen } from '../lib/asistente/tipos'

const DOCENTE_ID = 'c247d36f-2ecd-4896-ab16-253a92569611'
const sbAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

let fallas = 0
function verificar(cond: boolean, etiqueta: string) {
  console.log(cond ? `✓ ${etiqueta}` : `✗ ${etiqueta}`)
  if (!cond) fallas++
}

async function iniciarSesionComoDocenteReal() {
  const { supabase } = await import('../lib/supabaseClient')
  const { data: userData } = await sbAdmin.auth.admin.getUserById(DOCENTE_ID)
  const email = userData.user?.email
  if (!email) throw new Error('No se encontró el email del docente real de prueba.')
  const { data: linkData, error } = await sbAdmin.auth.admin.generateLink({ type: 'magiclink', email })
  if (error || !linkData) throw error ?? new Error('No se pudo generar el magic link.')
  const { error: errorVerify } = await supabase.auth.verifyOtp({ token_hash: linkData.properties.hashed_token, type: 'email' })
  if (errorVerify) throw errorVerify
  return supabase
}

// BLINDAJE — ver "el script de prueba borró conversaciones reales":
// limpiarTodo() (DELETE ... WHERE docente_id=DOCENTE_ID) se ELIMINÓ
// por completo. DOCENTE_ID sigue usándose SOLO para iniciar sesión —
// nunca más como filtro de un DELETE ni de una consulta de la que
// dependa un borrado. La única identidad real de "esto es un dato de
// esta corrida" es que su id está en idsUsadosParaConversaciones (este
// archivo YA llevaba ese arreglo desde antes para sus propias
// verificaciones — ahora también es la fuente exclusiva de qué
// borrar).
async function borrarSoloEstosIds(ids: string[]) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('SEGURIDAD: lista de ids a borrar vacía — abortando sin borrar nada (nunca se borra por docente_id ni con filtro vacío/general).')
  }
  for (const id of ids) {
    if (typeof id !== 'string' || !UUID_REGEX.test(id)) {
      throw new Error(`SEGURIDAD: id inválido en la lista de borrado ("${id}") — abortando sin borrar nada.`)
    }
  }
  for (const id of ids) {
    await sbAdmin.from('conversaciones_chat').delete().eq('id', id)
  }
}

async function mensajesDe(conversacionId: string) {
  const { data } = await sbAdmin.from('mensajes_chat').select('id, rol, texto').eq('conversacion_id', conversacionId).order('creado_en', { ascending: true })
  return data ?? []
}

async function main() {
  await iniciarSesionComoDocenteReal()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = AsistenteService as any
  const idsUsadosParaMensajes: string[] = []
  const idsUsadosParaConversaciones: string[] = []

  // Ya NO hay limpieza previa "por si quedó algo de una corrida
  // anterior" — esa limpieza era exactamente la que borraba por
  // docente_id. Si quedó un residuo de una corrida anterior, este
  // script ya no sabe cuáles eran sus ids y NO los toca.

  // A — texto → texto (regresión rápida del PASO 3, ya probado a fondo ahí)
  svc.conversacionActivaId = null
  svc.mensajes = []
  const idConvA = await svc.obtenerOCrearConversacionActivaRemota()
  idsUsadosParaConversaciones.push(idConvA)
  const msgA1: MensajeConversacion = { id: `msg-${Date.now()}-a1`, rol: 'usuario', texto: 'Primer mensaje de texto', creadoEn: Date.now() }
  svc.mensajes = [msgA1]
  svc.persistirMensajeAsegurandoConversacion(msgA1)
  const msgA2: MensajeConversacion = { id: `msg-${Date.now() + 1}-a2`, rol: 'usuario', texto: 'Segundo mensaje de texto', creadoEn: Date.now() + 1 }
  svc.mensajes = [...svc.mensajes, msgA2]
  svc.persistirMensajeAsegurandoConversacion(msgA2)
  idsUsadosParaMensajes.push(msgA1.id, msgA2.id)
  await new Promise((r) => setTimeout(r, 700))
  const filasA = await mensajesDe(idConvA)
  verificar(filasA.length === 2 && filasA[0].texto === msgA1.texto && filasA[1].texto === msgA2.texto, 'A. texto → texto: ambos mensajes en la misma conversación, en orden')

  // B — voz → texto: el turno de voz (manejarEventoMotor real, caso
  // 'mensaje-usuario') debe crear la conversación remota él mismo
  // (antes usaba crearNuevaConversacion(), legacy) y el mensaje de
  // texto que sigue debe reutilizar EXACTAMENTE ese mismo id.
  svc.conversacionActivaId = null
  svc.mensajes = []
  svc.manejarEventoMotor({ tipo: 'mensaje-usuario', texto: 'Hola, esto lo dije por voz' })
  await new Promise((r) => setTimeout(r, 900))
  const idConvB = svc.conversacionActivaId
  verificar(typeof idConvB === 'string' && UUID_REGEX.test(idConvB), 'B1. La conversación iniciada por voz quedó con un uuid real de Supabase (no un id legacy)')
  idsUsadosParaConversaciones.push(idConvB)
  const msgBTexto: MensajeConversacion = { id: `msg-${Date.now()}-b2`, rol: 'usuario', texto: 'Y esto lo sigo por texto', creadoEn: Date.now() }
  svc.mensajes = [...svc.mensajes, msgBTexto]
  svc.persistirMensajeAsegurandoConversacion(msgBTexto)
  idsUsadosParaMensajes.push(msgBTexto.id)
  await new Promise((r) => setTimeout(r, 700))
  const filasB = await mensajesDe(idConvB)
  verificar(
    filasB.length === 2 && filasB[0].texto === 'Hola, esto lo dije por voz' && filasB[1].texto === 'Y esto lo sigo por texto',
    'B2. voz → texto: ambos mensajes quedan bajo el MISMO conversation_id, en orden'
  )

  // C — texto → voz: arranca por texto (simulado, igual que A), sigue
  // con un turno real de voz (manejarEventoMotor) — debe reusar
  // conversacionActivaId en vez de crear una conversación nueva.
  svc.conversacionActivaId = null
  svc.mensajes = []
  const idConvC = await svc.obtenerOCrearConversacionActivaRemota()
  idsUsadosParaConversaciones.push(idConvC)
  const msgCTexto: MensajeConversacion = { id: `msg-${Date.now()}-c1`, rol: 'usuario', texto: 'Empiezo por texto', creadoEn: Date.now() }
  svc.mensajes = [msgCTexto]
  svc.persistirMensajeAsegurandoConversacion(msgCTexto)
  idsUsadosParaMensajes.push(msgCTexto.id)
  await new Promise((r) => setTimeout(r, 500))
  svc.manejarEventoMotor({ tipo: 'mensaje-usuario', texto: 'Y ahora sigo por voz' })
  await new Promise((r) => setTimeout(r, 900))
  verificar(svc.conversacionActivaId === idConvC, 'C1. texto → voz: el turno de voz reutiliza conversacionActivaId, no crea una nueva')
  const filasC = await mensajesDe(idConvC)
  verificar(
    filasC.length === 2 && filasC[0].texto === 'Empiezo por texto' && filasC[1].texto === 'Y ahora sigo por voz',
    'C2. texto → voz: ambos mensajes quedan bajo el MISMO conversation_id, en orden'
  )

  // D — multifoto dentro de la MISMA conversación (la de la prueba C,
  // ya activa) — ejercita enviarConMultiplesImagenes real; la llamada
  // de red a /api/chat fallará de forma natural en este entorno de
  // script (sin servidor Next corriendo), pero eso ocurre DESPUÉS de
  // que el mensaje del docente ya se agregó y persistió.
  const adjuntosFalsos: AdjuntoImagen[] = [
    { base64: 'ZmFrZQ==', tipo: 'image/jpeg', nombreArchivo: 'foto1.jpg' },
    { base64: 'ZmFrZQ==', tipo: 'image/jpeg', nombreArchivo: 'foto2.jpg' },
  ]
  try {
    await svc.enviarConMultiplesImagenes('Compara estas dos evidencias', adjuntosFalsos)
  } catch {
    // esperado: sin servidor Next real detrás de /api/chat en este script
  }
  await new Promise((r) => setTimeout(r, 700))
  const filasD = await mensajesDe(idConvC)
  const multifotoGuardada = filasD.some((f) => f.texto === 'Compara estas dos evidencias')
  verificar(multifotoGuardada, 'D. El mensaje de multifoto queda en Supabase bajo la conversación ya activa')

  // E — cambiar entre dos conversaciones sin mezclar mensajes
  await svc.abrirConversacion(idConvA)
  const mensajesTrasAbrirA: MensajeConversacion[] = [...svc.mensajes]
  await svc.abrirConversacion(idConvB)
  const mensajesTrasAbrirB: MensajeConversacion[] = [...svc.mensajes]
  verificar(
    mensajesTrasAbrirA.length === 2 &&
      mensajesTrasAbrirA.map((m) => m.texto).join('|') === 'Primer mensaje de texto|Segundo mensaje de texto' &&
      mensajesTrasAbrirB.length === 2 &&
      mensajesTrasAbrirB.map((m) => m.texto).join('|') === 'Hola, esto lo dije por voz|Y esto lo sigo por texto',
    'E. abrirConversacion cambia entre conversaciones de distintos canales sin mezclar mensajes'
  )

  // F — simular recarga/reinstanciación: dos llamadas casi simultáneas
  // para crear conversación desde cero nunca deben duplicar.
  svc.conversacionActivaId = null
  svc.conversacionEnCreacion = null
  const [idF1, idF2] = await Promise.all([svc.obtenerOCrearConversacionActivaRemota(), svc.obtenerOCrearConversacionActivaRemota()])
  verificar(idF1 === idF2, 'F. Dos llamadas simultáneas nunca duplican la conversación (comparten la misma promesa)')
  idsUsadosParaConversaciones.push(idF1)

  // G — todos los mensajes de las pruebas A-D quedan en Supabase bajo
  // su conversation_id correcto (ya verificado arriba, punto por
  // punto) — chequeo agregado final. Verificado por id EXACTO (nunca
  // por docente_id — evita también falsos negativos si hubiera otra
  // conversación real ajena a esta corrida en la cuenta).
  const { data: todasLasConversaciones } = await sbAdmin.from('conversaciones_chat').select('id').in('id', idsUsadosParaConversaciones)
  verificar(
    (todasLasConversaciones?.length ?? 0) === idsUsadosParaConversaciones.length,
    `G. Supabase tiene exactamente las ${idsUsadosParaConversaciones.length} conversaciones reales creadas por esta prueba (A, B, C, F)`
  )

  // H — ausencia de ids legacy incompatibles: toda conversación creada
  // por estos canales es un uuid real; todo mensaje usa el formato
  // real de la app (msg-<timestamp>-<contador>), ya compatible con la
  // columna text corregida en el PASO 3.
  const { data: todosLosMensajes } = await sbAdmin.from('mensajes_chat').select('id, conversacion_id').in('conversacion_id', idsUsadosParaConversaciones)
  const idsConversacionValidos = (todasLasConversaciones ?? []).every((c) => UUID_REGEX.test(c.id))
  const idsMensajeValidos = (todosLosMensajes ?? []).every((m) => /^msg-\d+-/.test(m.id))
  verificar(idsConversacionValidos, 'H1. Todas las conversaciones creadas por estos canales tienen un id uuid real')
  verificar(idsMensajeValidos, 'H2. Todos los mensajes usan el formato real de id de la app (msg-<timestamp>-...), ya compatible con mensajes_chat.id')

  // I — limpiar ÚNICAMENTE los ids exactos que esta corrida creó
  await borrarSoloEstosIds(idsUsadosParaConversaciones)
  const { data: restos } = await sbAdmin.from('conversaciones_chat').select('id').in('id', idsUsadosParaConversaciones)
  verificar((restos?.length ?? 0) === 0, 'I. Ninguno de los ids creados por esta corrida sigue existiendo')

  const { supabase } = await import('../lib/supabaseClient')
  await supabase.auth.signOut()

  console.log(fallas === 0 ? '\nTODAS LAS PRUEBAS PASARON' : `\n${fallas} prueba(s) fallaron.`)
  process.exit(fallas === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('Error ejecutando la verificación:', err)
  process.exit(1)
})
