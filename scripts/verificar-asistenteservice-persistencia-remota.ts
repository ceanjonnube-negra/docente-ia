// PASO 3 — prueba aislada de la integración de AsistenteService.ts con
// la persistencia remota (Supabase) del PASO 2. NO invoca a Claude (la
// cuenta de Anthropic usada para pruebas sigue sin crédito, ver rondas
// anteriores de esta sesión) — ejercita DIRECTAMENTE los métodos reales
// del singleton (algunos privados, con cast `as any`: es código real
// que se está verificando, no un mock) contra Supabase real, simulando
// lo que enviarMensaje()/manejarEventoMotor() harían con el resultado
// de Claude ya resuelto.
//
// No toca AsistentePanel.tsx ni ningún componente — solo el singleton.

import { createClient } from '@supabase/supabase-js'
import { AsistenteService } from '../lib/asistente/AsistenteService'
import { obtenerConversacionRemota, listarConversacionesRemoto } from '../lib/asistente/persistencia'
import type { MensajeConversacion } from '../lib/asistente/tipos'

const DOCENTE_ID = 'c247d36f-2ecd-4896-ab16-253a92569611'
const sbAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

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
// limpiarTodo() (DELETE ... WHERE docente_id=DOCENTE_ID) se ELIMINÓ por
// completo. DOCENTE_ID sigue usándose SOLO para iniciar sesión (es el
// único docente real disponible para probar, no hay forma de evitarlo
// sin una cuenta de prueba dedicada) — pero YA NUNCA se usa como
// filtro de un DELETE. La única identidad real de "esto es un dato de
// esta corrida" es que su id está en idsConversacionesCreadas —
// nunca una consulta a Supabase que reconstruya "todo lo del docente
// X", que es exactamente el patrón que borró conversaciones reales.
const idsConversacionesCreadas: string[] = []
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Único mecanismo de borrado permitido en este archivo — por diseño,
// NUNCA acepta ni usa docente_id, comodines, ni ningún filtro que no
// sea "id = <uno de los ids que esta misma corrida ya registró>".
// Si la lista viene vacía o con algo que no sea un uuid real, aborta
// sin borrar nada — nunca "mejor borro por si acaso".
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

async function main() {
  await iniciarSesionComoDocenteReal()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = AsistenteService as any

  // Ya NO hay limpieza previa "por si quedó algo de una corrida
  // anterior interrumpida" — esa limpieza era exactamente la que
  // borraba por docente_id. Si quedó un residuo de una corrida
  // anterior, este script ya no sabe cuáles eran sus ids y NO los
  // toca (ver requisito "si no conoce con certeza los ids, no debe
  // borrar nada") — un posible residuo de prueba aislado es un riesgo
  // aceptado, nunca un borrado amplio.

  // 1 — crear una conversación mediante AsistenteService
  const idConv = await svc.obtenerOCrearConversacionActivaRemota()
  idsConversacionesCreadas.push(idConv)
  verificar(typeof idConv === 'string' && idConv.length > 0, '1. AsistenteService crea una conversación real en Supabase')
  verificar(svc.conversacionActivaId === idConv, '   conversacionActivaId del servicio queda igual al id creado')

  // 2 — enviar varios mensajes (usuario + asistente + usuario), tal
  // como enviarMensaje()/manejarEventoMotor() los dejarían en
  // this.mensajes antes de persistirlos.
  const base = Date.now()
  const msgUsuario: MensajeConversacion = { id: `msg-${base}-0`, rol: 'usuario', texto: 'Hazme un resumen de la unidad 3', creadoEn: base }
  const msgAsistente: MensajeConversacion = { id: `msg-${base + 1}-1`, rol: 'asistente', texto: 'Aquí tienes el resumen de la unidad 3...', creadoEn: base + 1000 }
  const msgUsuario2: MensajeConversacion = { id: `msg-${base + 2}-2`, rol: 'usuario', texto: 'Gracias, ahora hazlo más corto', creadoEn: base + 2000 }
  svc.mensajes = [msgUsuario]
  svc.persistirMensajeRemoto(idConv, msgUsuario)
  svc.mensajes = [...svc.mensajes, msgAsistente]
  svc.persistirMensajeRemoto(idConv, msgAsistente)
  svc.mensajes = [...svc.mensajes, msgUsuario2]
  svc.persistirMensajeRemoto(idConv, msgUsuario2)
  await new Promise((r) => setTimeout(r, 900)) // persistirMensajeRemoto es fire-and-forget: se espera a que las 3 escrituras reales terminen

  // 3 — confirmar directo en Supabase (sin pasar por AsistenteService)
  const { data: filasReales } = await sbAdmin.from('mensajes_chat').select('id, rol, texto').eq('conversacion_id', idConv).order('creado_en', { ascending: true })
  verificar((filasReales?.length ?? 0) === 3, '3. Los 3 mensajes aparecen realmente en mensajes_chat')

  // 4/5 — recuperar la conversación y confirmar orden/contenido
  const recuperada = await obtenerConversacionRemota(idConv)
  verificar(
    recuperada !== null && recuperada.mensajes.map((m) => m.id).join(',') === `${msgUsuario.id},${msgAsistente.id},${msgUsuario2.id}`,
    '4/5. obtenerConversacionRemota recupera los 3 mensajes en el orden correcto'
  )

  // 6 — el título se actualizó automáticamente (derivarTitulo)
  verificar(recuperada?.titulo === 'Hazme un resumen de la unidad 3', '6. El título se actualizó automáticamente al guardar mensajes')

  // 7 — listar conversaciones
  const lista = await listarConversacionesRemoto()
  verificar(lista.some((c) => c.id === idConv), '7. listarConversacionesRemoto incluye la conversación recién creada')

  // 8 — cambiar entre dos conversaciones sin mezclar mensajes
  svc.conversacionActivaId = null
  const idConv2 = await svc.obtenerOCrearConversacionActivaRemota()
  idsConversacionesCreadas.push(idConv2)
  const msgOtra: MensajeConversacion = { id: `msg-${base + 3}-3`, rol: 'usuario', texto: 'Otra conversación totalmente distinta', creadoEn: base + 3000 }
  svc.mensajes = [msgOtra]
  svc.persistirMensajeRemoto(idConv2, msgOtra)
  await new Promise((r) => setTimeout(r, 600))

  await svc.abrirConversacion(idConv)
  const mensajesTrasAbrir1: MensajeConversacion[] = [...svc.mensajes]
  await svc.abrirConversacion(idConv2)
  const mensajesTrasAbrir2: MensajeConversacion[] = [...svc.mensajes]
  verificar(
    mensajesTrasAbrir1.length === 3 && mensajesTrasAbrir1.every((m) => m.id !== msgOtra.id) &&
      mensajesTrasAbrir2.length === 1 && mensajesTrasAbrir2[0].id === msgOtra.id,
    '8. abrirConversacion cambia entre las dos conversaciones sin mezclar mensajes'
  )

  // 9 — eliminar una conversación y confirmar cascade
  await svc.eliminarConversacion(idConv2)
  const { data: mensajesHuerfanos } = await sbAdmin.from('mensajes_chat').select('id').eq('conversacion_id', idConv2)
  const { data: conversacionBorrada } = await sbAdmin.from('conversaciones_chat').select('id').eq('id', idConv2)
  verificar((mensajesHuerfanos?.length ?? 0) === 0 && (conversacionBorrada?.length ?? 0) === 0, '9. eliminarConversacion borra la conversación y sus mensajes por cascade')

  // 10 — simular recarga/reinstanciación: dos llamadas casi
  // simultáneas a obtenerOCrearConversacionActivaRemota() desde cero
  // (conversacionActivaId en null) nunca deben crear dos filas.
  svc.conversacionActivaId = null
  svc.conversacionEnCreacion = null
  const [idA, idB] = await Promise.all([svc.obtenerOCrearConversacionActivaRemota(), svc.obtenerOCrearConversacionActivaRemota()])
  idsConversacionesCreadas.push(idA)
  verificar(idA === idB, '10. Dos llamadas simultáneas para crear conversación nunca duplican (comparten la misma promesa)')
  // Cuenta cuántas filas reales tiene el id devuelto por la "carrera"
  // (nunca el total de la tabla: idConv del paso 1 sigue viva a
  // propósito, nunca se borró) — debe ser exactamente 1.
  const { data: conteoConcurrencia } = await sbAdmin.from('conversaciones_chat').select('id').eq('id', idA)
  verificar((conteoConcurrencia?.length ?? 0) === 1, '    y existe exactamente UNA fila real en Supabase para el id devuelto por la carrera')

  // 11 — un fallo de persistencia no debe destruir el estado del chat
  const mensajesAntes = JSON.stringify(svc.mensajes)
  let noLanzo = true
  try {
    // conversacion_id que no existe -> viola la FK -> guardarMensajeRemoto
    // debe rechazar, pero persistirMensajeRemoto (fire-and-forget) nunca
    // debe dejar escapar ese rechazo como excepción no controlada.
    svc.persistirMensajeRemoto('00000000-0000-0000-0000-000000000000', { id: 'msg-fallo', rol: 'usuario', texto: 'esto debe fallar en Supabase', creadoEn: Date.now() })
    await new Promise((r) => setTimeout(r, 600))
  } catch {
    noLanzo = false
  }
  verificar(noLanzo, '11a. Un fallo de escritura remota (FK inválida) no lanza una excepción no controlada')
  verificar(JSON.stringify(svc.mensajes) === mensajesAntes, '11b. this.mensajes del servicio queda intacto tras el fallo')

  // 12 — limpiar ÚNICAMENTE los ids exactos que esta corrida creó
  await borrarSoloEstosIds(idsConversacionesCreadas)
  const { data: restos } = await sbAdmin.from('conversaciones_chat').select('id').in('id', idsConversacionesCreadas)
  verificar((restos?.length ?? 0) === 0, '12. Ninguno de los ids creados por esta corrida sigue existiendo')

  const { supabase } = await import('../lib/supabaseClient')
  await supabase.auth.signOut()

  console.log(fallas === 0 ? '\nTODAS LAS PRUEBAS PASARON' : `\n${fallas} prueba(s) fallaron.`)
  process.exit(fallas === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('Error ejecutando la verificación:', err)
  process.exit(1)
})
