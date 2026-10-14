// app/api/alumnos/aplicar-correccion/route.ts
//
// Aplica la corrección de UN campo de UN alumno que el docente ya vio
// y confirmó con el botón "Corregir" (ver
// AsistenteService.confirmarCorreccionAlumno) — ver "PASO 2:
// corrección individual segura de UN campo de UN alumno". Mismo
// patrón de autenticación y estructura que
// app/api/calendario/aplicar/route.ts: nunca decide QUÉ corregir
// (eso ya se decidió y se mostró al docente antes), solo ejecuta lo
// ya confirmado — y NUNCA confía en lo que el cliente mande: solo
// ejecuta la propuesta firmada por el servidor (C4), verificada antes de
// escribir, sobre un alumno que sigue en el grupo autorizado; la RPC
// confirmar_correccion_alumno revalida propiedad, grupo, valor anterior y
// uso único en la misma transacción.

import { NextRequest, NextResponse } from 'next/server'
import { autenticarRequestApi } from '@/lib/server/authApi'
import { aplicarCorreccionAlumno } from '@/lib/motorContexto'
import { MENSAJE_PROPUESTA_NO_VALIDA, verificarPropuestaCorreccion } from '@/lib/asistente/propuestaCorreccionFirmada'
import { obtenerSesionContexto, type OpcionesSesionContexto } from '@/lib/sesionContexto'
import { alumnoDelGrupoActivo } from '@/lib/asistente/identidadAlumno'
import type { SupabaseClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'


// Grupo autorizado para esta confirmación — mismo criterio de solo
// lectura que /api/chat (MG-B): la conversación debe ser del docente
// (RLS); si ya tiene grupo fijado (grupo_contexto_version=1), ese es el
// grupo; si es anterior a los snapshots, el grupo activo del docente.
// Nunca se acepta un grupo enviado por el cliente, y aquí nunca se fija
// el snapshot (eso solo ocurre al conversar). null = no autorizado.
async function opcionesGrupoAutorizado(sb: SupabaseClient, conversacionId: unknown): Promise<OpcionesSesionContexto | undefined | null> {
  if (typeof conversacionId !== 'string' || !conversacionId) return undefined
  const { data, error } = await sb
    .from('conversaciones_chat')
    .select('id, grupo_contexto_version, grupo_id')
    .eq('id', conversacionId)
    .maybeSingle()
  if (error || !data) return null
  if (data.grupo_contexto_version !== 1) return undefined
  return data.grupo_id ? { modo: 'snapshot', grupoIdForzado: data.grupo_id as string } : null
}

export async function POST(req: NextRequest) {
  try {
    const cuerpo = await req.json()
    const { sobre, conversacionId, accessToken } = cuerpo
    // Identidad SIEMPRE del JWT verificado (getUser), nunca de un userId
    // que mande el cliente — ese campo, si llega, se ignora.
    const auth = await autenticarRequestApi(typeof accessToken === 'string' ? accessToken : null)
    if (!auth.ok) {
      return NextResponse.json({ error: 'Sesión no válida. Vuelve a iniciar sesión e intenta de nuevo.' }, { status: 401 })
    }
    if (typeof conversacionId !== 'string' || !conversacionId) {
      return NextResponse.json({ exito: false, error: `${MENSAJE_PROPUESTA_NO_VALIDA.OTRA_CONVERSACION}.`, codigo: 'OTRA_CONVERSACION', definitivo: true }, { status: 200 })
    }

    // Propuesta FIRMADA por el servidor (C4): se verifica ANTES de usar
    // cualquier dato — firma, docente del JWT, conversación activa y
    // vigencia. A partir de aquí solo se usan los valores firmados; nada
    // de lo que mande el cliente (alumno, campo, valores) los sustituye.
    const verificacion = verificarPropuestaCorreccion(sobre, { docenteId: auth.user.id, conversacionId })
    if (!verificacion.ok) {
      return NextResponse.json({ exito: false, error: `${MENSAJE_PROPUESTA_NO_VALIDA[verificacion.codigo]}.`, codigo: verificacion.codigo, definitivo: verificacion.codigo !== 'FIRMA_NO_DISPONIBLE' }, { status: 200 })
    }
    const firmada = verificacion.payload

    // Pertenencia ACTUAL del alumno firmado al grupo autorizado de la
    // conversación (ver opcionesGrupoAutorizado), con las mismas consultas
    // que arman la sesión del Chat, y con el mismo nombre canónico que se
    // le mostró al docente. Si no, no se escribe.
    const opcionesGrupo = await opcionesGrupoAutorizado(auth.supabase, firmada.conversacionId)
    const sesion = opcionesGrupo === null ? null : await obtenerSesionContexto(auth.supabase, auth.user.id, null, opcionesGrupo)
    const alumno = sesion ? alumnoDelGrupoActivo(sesion.alumnos_del_grupo_activo, firmada.alumnoId) : null
    if (!alumno) {
      return NextResponse.json({ exito: false, error: 'Ese alumno ya no pertenece a tu grupo activo, así que no hice el cambio. Pídeme de nuevo la corrección.', codigo: 'ALUMNO_FUERA_DE_GRUPO', definitivo: true }, { status: 200 })
    }
    if (alumno.nombre_completo !== firmada.alumnoNombre) {
      return NextResponse.json({ exito: false, error: 'El nombre registrado del alumno cambió desde la propuesta, así que no hice el cambio. Pídeme de nuevo la corrección.', codigo: 'NOMBRE_NO_COINCIDE', definitivo: true }, { status: 200 })
    }

    // Única escritura: public.confirmar_correccion_alumno (compare-and-set,
    // trazabilidad y uso único en una sola transacción) — ver
    // lib/motorContexto.ts.
    const resultado = await aplicarCorreccionAlumno(auth.supabase, firmada, 'texto')

    if (!resultado.exito) {
      return NextResponse.json({ exito: false, error: resultado.error, codigo: resultado.codigo, definitivo: resultado.definitivo === true }, { status: 200 })
    }
    if (resultado.sinCambios) {
      return NextResponse.json({ exito: true, estado: 'sin_cambios', texto: 'Ese valor ya coincidía con el registrado — no hice ningún cambio.' })
    }
    return NextResponse.json({ exito: true, estado: 'aplicada', texto: `Listo. Corregí el dato: ahora es ${resultado.valorNuevo}.` })
  } catch (error) {
    console.error('[alumnos/aplicar-correccion] Error:', error)
    const mensajeError = error instanceof Error ? error.message : 'No pude aplicar la corrección. Intenta de nuevo.'
    return NextResponse.json({ error: mensajeError }, { status: 502 })
  }
}
