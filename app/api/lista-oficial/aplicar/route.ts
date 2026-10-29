// app/api/lista-oficial/aplicar/route.ts
//
// LISTA-P5 (etapa 2a) — aplica las operaciones de una propuesta de
// actualización de lista oficial que el docente confirmó una por una.
// Nunca decide QUÉ cambiar: solo ejecuta operaciones de una propuesta
// firmada por el servidor y registrada en la base.
//
// Nada de lo que mande el cliente cambia docente, conversación, grupo u
// operación:
//   - docente: el del JWT verificado (getUser), nunca un userId del body;
//   - propuesta: se verifica la firma HMAC ANTES de leer cualquier dato;
//     su docente debe ser el del JWT;
//   - conversación y grupo: se leen de la base con RLS (la conversación
//     debe ser del docente, con grupo fijado y ese grupo debe ser el de
//     la propuesta); el contexto de evaluación sale de ahí;
//   - lista: la huella se recalcula con la lista actual del grupo;
//   - operaciones: evaluarSolicitudAplicacionLista exige una confirmación
//     explícita por operación aplicable que repita su identificación; la
//     confirmación para la RPC se deriva solo de la operación firmada.
// La única escritura es aplicar_propuesta_lista_oficial con la sesión del
// docente, que revalida todo en una transacción (uso único, vigencia,
// foto del grupo, valores actuales) y es la que deja historial.
//
// Dos formas de solicitud, un solo camino (normalizarSolicitudAplicacion):
//   - 2b (chat): { token, operacionIds } — el token es el sobre cifrado
//     (sobreCifrado.ts); las confirmaciones se arman desde lo firmado;
//   - 2a: { sobre, confirmaciones }, compatible mientras dura la transición.

import { NextRequest, NextResponse } from 'next/server'
import { autenticarRequestApi } from '@/lib/server/authApi'
import { obtenerRosterParaPropuesta } from '@/lib/rosterGrupo'
import { calcularRosterFingerprint } from '@/lib/listaOficial/rosterFingerprint'
import { leerSecretoServerOnly } from '@/lib/listaOficial/propuestaFirmada'
import { normalizarSolicitudAplicacion } from '@/lib/listaOficial/sobreCifrado'
import {
  confirmacionParaRpc,
  evaluarSolicitudAplicacionLista,
  verificarPropuestaActualizacionConSecreto,
} from '@/lib/listaOficial/propuestaActualizacionLista'

export const runtime = 'nodejs'

const VOLVER_A_ENVIAR = 'Vuelve a enviarme las fotos de la lista para generar una propuesta nueva.'

// Rechazos definitivos: la propuesta ya no puede aplicarse tal cual.
const MENSAJE_RECHAZO: Record<string, string> = {
  FIRMA_INVALIDA: `La propuesta no es válida. ${VOLVER_A_ENVIAR}`,
  DOCENTE_NO_CORRESPONDE: 'Esta propuesta no pertenece a tu sesión.',
  CONVERSACION_NO_CORRESPONDE: 'Esta propuesta no pertenece a esta conversación.',
  GRUPO_NO_CORRESPONDE: 'Esta propuesta es de otro grupo.',
  PROPUESTA_NO_VIGENTE: `La propuesta todavía no es válida. ${VOLVER_A_ENVIAR}`,
  PROPUESTA_CADUCADA: `La propuesta venció. ${VOLVER_A_ENVIAR}`,
  PROPUESTA_YA_APLICADA: 'Esta propuesta ya se aplicó.',
  ROSTER_CAMBIO: `Tu lista cambió desde que se generó la propuesta, así que no apliqué nada. ${VOLVER_A_ENVIAR}`,
  SIN_CONFIRMACIONES: 'No seleccionaste ningún cambio para aplicar.',
  CONFIRMACIONES_INVALIDAS: 'Alguno de los cambios seleccionados no corresponde a la propuesta, así que no apliqué nada.',
}

// Códigos de aplicar_propuesta_lista_oficial (se revierte todo).
const MENSAJE_RPC: Record<string, string> = {
  AUTH_REQUIRED: 'Sesión no válida. Vuelve a iniciar sesión e intenta de nuevo.',
  PROPOSAL_NOT_FOUND: `No encontré esta propuesta. ${VOLVER_A_ENVIAR}`,
  PROPOSAL_ALREADY_USED: 'Esta propuesta ya se aplicó.',
  PROPOSAL_EXPIRED: `La propuesta venció. ${VOLVER_A_ENVIAR}`,
  INVALID_CONFIRMATION: 'Alguno de los cambios seleccionados no corresponde a la propuesta, así que no apliqué nada.',
  CONVERSATION_NOT_AUTHORIZED: 'Esta conversación ya no está autorizada para tu grupo, así que no apliqué nada.',
  GROUP_NOT_AUTHORIZED: 'Este grupo ya no está autorizado para tu sesión, así que no apliqué nada.',
  STUDENT_NOT_AUTHORIZED: 'Uno de los alumnos ya no pertenece a tu grupo, así que no apliqué nada.',
  ROSTER_CHANGED: `Tu lista cambió desde que se generó la propuesta, así que no apliqué nada. ${VOLVER_A_ENVIAR}`,
  STALE_CURRENT_VALUE: `Un dato cambió desde la propuesta, así que no apliqué nada. ${VOLVER_A_ENVIAR}`,
  NAME_DUPLICATE: 'Ya tienes un alumno con ese nombre, así que no apliqué nada.',
  CURP_DUPLICATE: 'Ya tienes un alumno con esa CURP, así que no apliqué nada.',
}

const rechazo = (codigo: string, error: string, status = 200) =>
  NextResponse.json({ exito: false, codigo, error }, { status })

export async function POST(req: NextRequest) {
  try {
    const cuerpo = await req.json().catch(() => null)
    const datos = (cuerpo ?? {}) as Record<string, unknown>
    const { accessToken } = datos

    const auth = await autenticarRequestApi(typeof accessToken === 'string' ? accessToken : null)
    if (!auth.ok) return rechazo('SESION_INVALIDA', 'Sesión no válida. Vuelve a iniciar sesión e intenta de nuevo.', 401)

    const secreto = leerSecretoServerOnly()
    if (!secreto) {
      console.error('[LISTA_OFICIAL][aplicar] secreto=ausente')
      return rechazo('NO_DISPONIBLE', 'Aplicar cambios de la lista oficial no está disponible en este momento.', 503)
    }

    const solicitud = normalizarSolicitudAplicacion(datos, secreto)
    if (!solicitud.ok) return rechazo(solicitud.codigo === 'TOKEN_INVALIDO' ? 'FIRMA_INVALIDA' : 'SOLICITUD_INVALIDA', solicitud.codigo === 'TOKEN_INVALIDO' ? MENSAJE_RECHAZO.FIRMA_INVALIDA : 'La solicitud no es válida.')
    const { sobre, confirmaciones } = solicitud

    // Firma primero: hasta aquí no se usa ningún dato de la propuesta.
    if (!verificarPropuestaActualizacionConSecreto(sobre, secreto)) return rechazo('FIRMA_INVALIDA', MENSAJE_RECHAZO.FIRMA_INVALIDA)
    const payload = sobre.payload
    if (payload.docenteId !== auth.user.id) return rechazo('DOCENTE_NO_CORRESPONDE', MENSAJE_RECHAZO.DOCENTE_NO_CORRESPONDE)

    // Conversación y grupo desde la base, con RLS del docente.
    const { data: conversacion, error: errorConversacion } = await auth.supabase
      .from('conversaciones_chat')
      .select('id, grupo_id, grupo_contexto_version')
      .eq('id', payload.conversacionId)
      .maybeSingle()
    if (errorConversacion) return rechazo('ERROR_TEMPORAL', 'No pude confirmar la conversación. Intenta de nuevo en unos segundos.', 503)
    if (!conversacion || conversacion.grupo_contexto_version !== 1 || !conversacion.grupo_id) {
      return rechazo('CONVERSACION_NO_CORRESPONDE', MENSAJE_RECHAZO.CONVERSACION_NO_CORRESPONDE)
    }
    const grupoId = conversacion.grupo_id as string

    const { data: roster, error: errorRoster } = await obtenerRosterParaPropuesta(auth.supabase, grupoId)
    if (errorRoster) return rechazo('ERROR_TEMPORAL', 'No pude leer la lista de tu grupo. Intenta de nuevo en unos segundos.', 503)

    const evaluacion = evaluarSolicitudAplicacionLista({
      sobre,
      secreto,
      confirmaciones,
      contexto: {
        docenteId: auth.user.id,
        conversacionId: conversacion.id as string,
        grupoId,
        rosterFingerprintActual: calcularRosterFingerprint(roster.map((a) => ({ inscripcionId: a.inscripcionId, estatus: a.estatus, curp: a.curp }))),
        ahora: new Date(),
        // La tabla de propuestas no es legible desde la API: el uso único
        // lo garantiza la RPC (PROPOSAL_ALREADY_USED).
        propuestaYaAplicada: false,
      },
    })
    if (!evaluacion.ok) {
      console.log(`[LISTA_OFICIAL][aplicar] evaluacion=rechazada codigo=${evaluacion.codigo} rechazos=${evaluacion.rechazos.length}`)
      return NextResponse.json({ exito: false, codigo: evaluacion.codigo, error: MENSAJE_RECHAZO[evaluacion.codigo], rechazos: evaluacion.rechazos })
    }

    const { data, error } = await auth.supabase.rpc('aplicar_propuesta_lista_oficial', {
      p_propuesta_id: evaluacion.propuestaId,
      p_confirmaciones: evaluacion.operacionesAutorizadas.map(confirmacionParaRpc),
    })
    if (error) {
      const codigo = error.code === 'P0001' ? error.message : 'ERROR_TEMPORAL'
      console.error(`[LISTA_OFICIAL][aplicar] rpc=rechazada codigo=${codigo}`)
      return rechazo(codigo, MENSAJE_RPC[codigo] ?? 'No pude aplicar los cambios. No se modificó nada; intenta de nuevo en unos segundos.')
    }

    const resultado = data as { aplicadas?: number; altas?: unknown[] } | null
    const aplicadas = resultado?.aplicadas ?? 0
    const altas = Array.isArray(resultado?.altas) ? resultado.altas.length : 0
    console.log(`[LISTA_OFICIAL][aplicar] rpc=aplicada aplicadas=${aplicadas} altas=${altas}`)
    return NextResponse.json({
      exito: true,
      aplicadas,
      altas,
      mensaje: `Listo: apliqué ${aplicadas} cambio${aplicadas === 1 ? '' : 's'} a tu lista.`,
    })
  } catch {
    console.error('[LISTA_OFICIAL][aplicar] error=inesperado')
    return rechazo('ERROR_TEMPORAL', 'No pude aplicar los cambios. No se modificó nada; intenta de nuevo en unos segundos.', 500)
  }
}
