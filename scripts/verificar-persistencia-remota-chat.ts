// Prueba aislada del PASO 2 (persistencia remota del Chat IA en
// Supabase) — NO toca AsistenteService.ts ni la interfaz, solo ejercita
// las funciones nuevas de lib/asistente/persistencia.ts directamente
// contra la base real, con datos temporales que se limpian al final.
//
// Requiere ANTHROPIC/OPENAI nada — esto es puro Supabase, sin IA.

import { createClient } from '@supabase/supabase-js'
import {
  crearConversacionRemota,
  obtenerConversacionRemota,
  guardarMensajeRemoto,
  actualizarConversacionRemota,
  listarConversacionesRemoto,
  eliminarConversacionRemota,
} from '../lib/asistente/persistencia'
import type { MensajeConversacion } from '../lib/asistente/tipos'

const DOCENTE_ID = 'c247d36f-2ecd-4896-ab16-253a92569611'
const sbAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

let fallas = 0
function verificar(cond: boolean, etiqueta: string) {
  console.log(cond ? `✓ ${etiqueta}` : `✗ ${etiqueta}`)
  if (!cond) fallas++
}

// lib/asistente/persistencia.ts llama a supabase.auth.getUser() del
// cliente anon compartido (lib/supabaseClient.ts) — para probar de
// verdad las funciones "remotas" (no solo pegarle directo a la tabla
// con service role) hace falta una sesión real. Se genera un magic
// link para el docente real y se intercambia por una sesión, mismo
// mecanismo que ya usan otros scripts de verificación de este
// proyecto para simular al docente autenticado.
async function iniciarSesionComoDocenteReal() {
  const { supabase } = await import('../lib/supabaseClient')
  const { data: userData } = await sbAdmin.auth.admin.getUserById(DOCENTE_ID)
  const email = userData.user?.email
  if (!email) throw new Error('No se encontró el email del docente real de prueba.')
  const { data: linkData, error } = await sbAdmin.auth.admin.generateLink({ type: 'magiclink', email })
  if (error || !linkData) throw error ?? new Error('No se pudo generar el magic link.')
  const hashedToken = linkData.properties.hashed_token
  const { error: errorVerify } = await supabase.auth.verifyOtp({ token_hash: hashedToken, type: 'email' })
  if (errorVerify) throw errorVerify
  return supabase
}

async function main() {
  const supabase = await iniciarSesionComoDocenteReal()
  const { data: { user } } = await supabase.auth.getUser()
  verificar(user?.id === DOCENTE_ID, 'Sesión real iniciada como el docente de prueba')

  // A — crear conversación
  const conversacionId = await crearConversacionRemota()
  verificar(typeof conversacionId === 'string' && conversacionId.length > 0, 'A. crearConversacionRemota() devuelve un id real')

  // B — recuperarla (recién creada, sin mensajes todavía)
  const vacia = await obtenerConversacionRemota(conversacionId)
  verificar(vacia !== null && vacia.mensajes.length === 0 && vacia.titulo === 'Nueva conversación', 'B. obtenerConversacionRemota() recupera la conversación recién creada')

  // C — guardar varios mensajes, con el id REAL que genera la app
  // (ver nuevoId en AsistenteService.ts: `msg-${Date.now()}-${contadorId++}`)
  // — exactamente el formato que reveló el defecto de esquema ya
  // corregido (mensajes_chat.id era uuid, ahora es text).
  const base = Date.now()
  const idMsg1 = `msg-${base}-0`
  const idMsg2 = `msg-${base + 1}-1`
  const idMsg3 = `msg-${base + 2}-2`
  const mensajes: MensajeConversacion[] = [
    { id: idMsg1, rol: 'usuario', texto: 'Hazme un cuadernillo de actividades sobre el ciclo del agua', creadoEn: base },
    { id: idMsg2, rol: 'asistente', texto: 'Documento generado correctamente.', creadoEn: base + 1000, archivo: { tipo: 'word', nombre: 'cuadernillo.docx', url: 'https://ejemplo.test/cuadernillo.docx' } },
    { id: idMsg3, rol: 'usuario', texto: 'Ahora también en PDF', creadoEn: base + 2000 },
  ]
  for (const m of mensajes) await guardarMensajeRemoto(conversacionId, m)
  console.log('✓ C. guardarMensajeRemoto() insertó 3 mensajes con id real (msg-<timestamp>-<contador>) sin lanzar')

  // D — recuperarlos en orden correcto
  const conDatos = await obtenerConversacionRemota(conversacionId)
  const ordenOk = conDatos !== null
    && conDatos.mensajes.length === 3
    && conDatos.mensajes.map((m) => m.id).join(',') === `${idMsg1},${idMsg2},${idMsg3}`
    && conDatos.mensajes[1].archivo?.nombre === 'cuadernillo.docx'
  verificar(ordenOk, 'D. Los 3 mensajes se recuperan en el orden real en que se crearon, con su id real y contenido extra (archivo) intacto')

  // E — actualizar título y updated_at
  const actualizadaEnAntes = (await listarConversacionesRemoto()).find((c) => c.id === conversacionId)?.actualizadaEn ?? 0
  await new Promise((r) => setTimeout(r, 1100)) // separación real > 1s para que actualizado_en (timestamptz) cambie de forma inequívoca
  await actualizarConversacionRemota(conversacionId, { titulo: 'Cuadernillo — el ciclo del agua' })
  const trasActualizar = await obtenerConversacionRemota(conversacionId)
  const actualizadaEnDespues = (await listarConversacionesRemoto()).find((c) => c.id === conversacionId)?.actualizadaEn ?? 0
  verificar(
    trasActualizar?.titulo === 'Cuadernillo — el ciclo del agua' && actualizadaEnDespues > actualizadaEnAntes,
    'E. actualizarConversacionRemota() actualiza título y adelanta actualizado_en'
  )

  // F — listar ordenadas de más reciente a más antigua
  const otraId = await crearConversacionRemota()
  await guardarMensajeRemoto(otraId, { id: 'msg-prueba-otra', rol: 'usuario', texto: 'Segunda conversación de prueba', creadoEn: Date.now() })
  const lista = await listarConversacionesRemoto()
  const idxConversacion = lista.findIndex((c) => c.id === conversacionId)
  const idxOtra = lista.findIndex((c) => c.id === otraId)
  verificar(idxOtra !== -1 && idxConversacion !== -1 && idxOtra < idxConversacion, 'F. listarConversacionesRemoto() ordena de más reciente a más antigua')

  // G — eliminar y comprobar cascade
  await eliminarConversacionRemota(conversacionId)
  const trasEliminar = await obtenerConversacionRemota(conversacionId)
  const { data: mensajesHuerfanos } = await sbAdmin.from('mensajes_chat').select('id').eq('conversacion_id', conversacionId)
  verificar(trasEliminar === null && (mensajesHuerfanos?.length ?? 0) === 0, 'G. eliminarConversacionRemota() borra la conversación y sus mensajes desaparecen por cascade')

  // H — otro usuario no puede leerla (usa un uuid que no es ningún docente real — RLS debe bloquear igual)
  const { data: { session } } = await supabase.auth.getSession()
  const supabaseComoOtro = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
  // Verificación directa de RLS (no vía las funciones, que ya resuelven
  // su propio docente_id): confirma que otraId NO es visible sin la
  // sesión real del docente dueño.
  const { data: sinSesion } = await supabaseComoOtro.from('conversaciones_chat').select('id').eq('id', otraId)
  verificar((sinSesion?.length ?? 0) === 0, 'H. Sin la sesión del docente dueño (cliente anon), la conversación no es visible')
  verificar(Boolean(session?.access_token), '   (contexto: la sesión real del docente sí seguía activa en este momento)')

  // I — limpiar todos los datos temporales
  await eliminarConversacionRemota(otraId)
  const { data: restos } = await sbAdmin.from('conversaciones_chat').select('id').eq('docente_id', DOCENTE_ID)
  verificar((restos?.length ?? 0) === 0, 'I. Sin datos temporales restantes para el docente de prueba')

  await supabase.auth.signOut()

  console.log(fallas === 0 ? '\nTODAS LAS PRUEBAS PASARON' : `\n${fallas} prueba(s) fallaron.`)
  process.exit(fallas === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('Error ejecutando la verificación:', err)
  process.exit(1)
})
