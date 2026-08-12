// PASO 3C — prueba aislada: actualizarMensaje() debe sincronizar la
// edición a Supabase (upsert por id, mismo mecanismo ya validado en
// PASO 3/3B), actualizando exactamente la fila existente sin crear
// una nueva ni cambiar el orden.
//
// No invoca a Claude — ejercita directamente el singleton real contra
// Supabase real, con datos temporales que se limpian al final.

import { createClient } from '@supabase/supabase-js'
import { AsistenteService } from '../lib/asistente/AsistenteService'
import { obtenerConversacionRemota } from '../lib/asistente/persistencia'
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

async function limpiarTodo() {
  const { data } = await sbAdmin.from('conversaciones_chat').select('id').eq('docente_id', DOCENTE_ID)
  for (const fila of data ?? []) await sbAdmin.from('conversaciones_chat').delete().eq('id', fila.id)
}

async function main() {
  await iniciarSesionComoDocenteReal()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = AsistenteService as any

  await limpiarTodo()

  // A — crear conversación remota
  svc.conversacionActivaId = null
  svc.mensajes = []
  const idConv = await svc.obtenerOCrearConversacionActivaRemota()
  verificar(typeof idConv === 'string' && idConv.length > 0, 'A. Conversación remota creada')

  // B — guardar varios mensajes
  const base = Date.now()
  const msg1: MensajeConversacion = { id: `msg-${base}-0`, rol: 'usuario', texto: 'Redacta un citatorio para el padre de Juan', creadoEn: base }
  const msg2: MensajeConversacion = { id: `msg-${base + 1}-1`, rol: 'asistente', texto: 'Aquí tienes el borrador del citatorio...', creadoEn: base + 1000 }
  const msg3: MensajeConversacion = { id: `msg-${base + 2}-2`, rol: 'usuario', texto: 'Gracias', creadoEn: base + 2000 }
  svc.mensajes = [msg1, msg2, msg3]
  svc.persistirMensajeAsegurandoConversacion(msg1)
  svc.persistirMensajeAsegurandoConversacion(msg2)
  svc.persistirMensajeAsegurandoConversacion(msg3)
  await new Promise((r) => setTimeout(r, 900))
  const { data: filasIniciales } = await sbAdmin.from('mensajes_chat').select('id').eq('conversacion_id', idConv)
  verificar((filasIniciales?.length ?? 0) === 3, 'B. Los 3 mensajes quedaron guardados en Supabase')

  // C — editar uno mediante actualizarMensaje() (el método real del
  // servicio, no una llamada directa a persistencia.ts)
  svc.actualizarMensaje(msg2.id, 'Aquí tienes el borrador CORREGIDO del citatorio...')
  await new Promise((r) => setTimeout(r, 700))
  console.log('✓ C. actualizarMensaje() ejecutado sin lanzar')

  // D/E — recuperar la conversación desde Supabase y confirmar el texto editado
  const recuperada = await obtenerConversacionRemota(idConv)
  const mensajeEditado = recuperada?.mensajes.find((m) => m.id === msg2.id)
  verificar(mensajeEditado?.texto === 'Aquí tienes el borrador CORREGIDO del citatorio...', 'D/E. La conversación recuperada desde Supabase muestra el texto ya editado')

  // F — sigue existiendo una sola fila para ese message id
  const { data: filasParaEseId } = await sbAdmin.from('mensajes_chat').select('id').eq('id', msg2.id)
  verificar((filasParaEseId?.length ?? 0) === 1, 'F. Sigue existiendo exactamente UNA fila para ese message id (nunca se duplicó)')

  // G — el orden no cambió
  verificar(
    recuperada !== null && recuperada.mensajes.map((m) => m.id).join(',') === `${msg1.id},${msg2.id},${msg3.id}`,
    'G. El orden de los 3 mensajes sigue siendo el mismo tras la edición'
  )

  // H — editar de nuevo el mismo mensaje: debe seguir siendo la misma fila
  svc.actualizarMensaje(msg2.id, 'Tercera versión del borrador del citatorio...')
  await new Promise((r) => setTimeout(r, 700))
  const { data: filasTrasSegundaEdicion } = await sbAdmin.from('mensajes_chat').select('id, texto').eq('id', msg2.id)
  verificar(
    (filasTrasSegundaEdicion?.length ?? 0) === 1 && filasTrasSegundaEdicion?.[0]?.texto === 'Tercera versión del borrador del citatorio...',
    'H. Una segunda edición del mismo mensaje vuelve a actualizar la MISMA fila (sigue habiendo solo una)'
  )

  // I — RLS: sin la sesión del docente dueño, la fila no es visible
  const supabaseAnon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
  const { data: sinSesion } = await supabaseAnon.from('mensajes_chat').select('id').eq('id', msg2.id)
  verificar((sinSesion?.length ?? 0) === 0, 'I. Sin la sesión del docente dueño, el mensaje editado no es visible (RLS)')

  // J — limpiar todos los datos temporales
  await limpiarTodo()
  const { data: restos } = await sbAdmin.from('conversaciones_chat').select('id').eq('docente_id', DOCENTE_ID)
  verificar((restos?.length ?? 0) === 0, 'J. Sin datos temporales restantes para el docente de prueba')

  const { supabase } = await import('../lib/supabaseClient')
  await supabase.auth.signOut()

  console.log(fallas === 0 ? '\nTODAS LAS PRUEBAS PASARON' : `\n${fallas} prueba(s) fallaron.`)
  process.exit(fallas === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('Error ejecutando la verificación:', err)
  process.exit(1)
})
