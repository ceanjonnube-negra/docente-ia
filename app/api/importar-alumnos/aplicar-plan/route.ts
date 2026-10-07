// app/api/importar-alumnos/aplicar-plan/route.ts
//
// V1-D2B — frontera HTTP server-side de PREVALIDACIÓN, deliberadamente
// READ-ONLY: 0 INSERT, 0 UPDATE, 0 DELETE, 0 RPC de escritura. Llega
// hasta AUTENTICAR → VERIFICAR SOBRE HMAC → REVALIDAR CONTEXTO →
// RECALCULAR ROSTER → COMPARAR FINGERPRINT → VALIDAR OPERACIONES
// CONTRA BD, y se detiene ahí — ver diseño aprobado V1-D2B.
//
// *** ADVERTENCIA ARQUITECTÓNICA OBLIGATORIA ***
// Esta ruta es fast-fail/UX. NUNCA es la barrera transaccional
// definitiva. La futura RPC de aplicación (V1-D2C, todavía sin
// construir) deberá volver a validar TODO esto — ownership,
// roster/estado, CAS, duplicados, inscripción, estructura de CURP,
// concurrencia — dentro de su PROPIA transacción, exactamente como ya
// hacen reparar_curp_desde_lista_oficial/importar_alumnos_a_grupo/
// dar_de_baja_inscripcion hoy. Esta ruta NUNCA debe tratarse como "ya
// se validó aquí" por ningún código futuro: una respuesta ok:true de
// este endpoint es solo una señal de UX de que el lote PARECE
// aplicable en este instante — nunca una autorización de escritura.
//
// Body EXACTO permitido: { sobre: SobreAplicacionListaOficial } — nada
// más. Todo ID/valor proviene EXCLUSIVAMENTE del sobre ya firmado (ver
// lib/listaOficial/aplicacionFirmada.ts); este endpoint nunca acepta
// docenteId/grupoId/conversacionId/rosterFingerprint/operaciones por
// separado — eso reabriría exactamente el riesgo que el contrato HMAC
// de V1-D2A ya cierra (el cliente nunca es fuente de verdad de
// identidad).
//
// Autenticación: mismo patrón real ya usado por sus hermanos directos
// (comparar/route.ts, corregir-curp/route.ts) — extraerBearerToken +
// autenticarRequestApi (lib/server/authApi.ts), nunca service_role. La
// MISMA auth.supabase (cliente RLS-scoped con el token real del
// docente) se usa para TODAS las consultas de este archivo.
//
// Privacidad: los logs de este endpoint son exclusivamente endpoint +
// resultado + categoría estable de error — nunca CURP, nombre
// completo, HMAC, payload completo ni el Bearer token.

import { NextRequest, NextResponse } from 'next/server'
import { extraerBearerToken, autenticarRequestApi } from '@/lib/server/authApi'
import { verificarAplicacionListaOficialFirmada, type SobreAplicacionListaOficial, type OperacionAplicableListaOficial } from '@/lib/listaOficial/aplicacionFirmada'
import { calcularRosterFingerprint } from '@/lib/listaOficial/rosterFingerprint'
import { obtenerRosterConPosicion } from '@/lib/rosterGrupo'
import {
  prevalidarOperaciones,
  primerFallo,
  type ContextoPrevalidacion,
  type AlumnoActualCargado,
  type InscripcionActualCargada,
  type CodigoErrorPrevalidacion,
} from '@/lib/listaOficial/prevalidacionAplicacion'

export const runtime = 'nodejs'

const CLAVES_BODY = ['sobre'] as const

type CodigoErrorEndpoint = 'AUTH_REQUIRED' | 'INVALID_BODY' | 'INVALID_SIGNATURE' | 'STALE_ROSTER' | 'UNEXPECTED_ERROR' | CodigoErrorPrevalidacion

const INFO_ERROR: Record<CodigoErrorEndpoint, { status: number; mensaje: string }> = {
  AUTH_REQUIRED: { status: 401, mensaje: 'Tu sesión ya no es válida. Vuelve a iniciar sesión.' },
  INVALID_BODY: { status: 400, mensaje: 'La solicitud no tiene un formato válido.' },
  INVALID_SIGNATURE: { status: 403, mensaje: 'La propuesta no pudo verificarse. Vuelve a generarla.' },
  STALE_ROSTER: { status: 409, mensaje: 'La lista del grupo cambió desde que se generó esta propuesta. Vuelve a compararla.' },
  UNEXPECTED_ERROR: { status: 500, mensaje: 'No fue posible prevalidar la propuesta. Intenta de nuevo.' },
  OWNERSHIP_MISMATCH: { status: 403, mensaje: 'No fue posible verificar uno o más datos de esta propuesta.' },
  STALE_CURRENT_VALUE: { status: 409, mensaje: 'Un dato cambió desde que se generó esta propuesta. Vuelve a compararla.' },
  DUPLICATE_CURP: { status: 409, mensaje: 'Esa CURP ya está registrada en otro alumno.' },
  // V1-D2B2 — reemplaza DUPLICATE_ACTIVE_ENROLLMENT (ver auditoría
  // aprobada "persona vs. inscripción", sección 11): este código SOLO
  // se emite después de comprobar read-only una inscripción ACTIVA
  // real para alta_inscripcion — nunca por coincidencia de nombre.
  ACTIVE_ENROLLMENT_EXISTS: { status: 409, mensaje: 'Este alumno ya tiene una inscripción activa en este grupo.' },
  INVALID_OPERATION: { status: 400, mensaje: 'Una de las operaciones de la propuesta no es válida.' },
}

function respuestaError(codigo: CodigoErrorEndpoint) {
  const info = INFO_ERROR[codigo]
  console.warn('[importar-alumnos/aplicar-plan] resultado', { ok: false, codigo })
  return NextResponse.json({ ok: false, codigo, error: info.mensaje }, { status: info.status })
}

function tieneExactamenteLasClaves(obj: Record<string, unknown>, claves: readonly string[]): boolean {
  const encontradas = Object.keys(obj)
  if (encontradas.length !== claves.length) return false
  return claves.every((c) => Object.prototype.hasOwnProperty.call(obj, c))
}

export async function POST(req: NextRequest) {
  try {
    // 1) AUTENTICAR — mismo patrón real de comparar/corregir-curp.
    const accessToken = extraerBearerToken(req)
    const auth = await autenticarRequestApi(accessToken)
    if (!auth.ok) {
      return respuestaError('AUTH_REQUIRED')
    }

    // 2) Body — EXACTAMENTE { sobre }, fail-closed.
    let cuerpo: unknown
    try {
      cuerpo = await req.json()
    } catch {
      return respuestaError('INVALID_BODY')
    }
    if (typeof cuerpo !== 'object' || cuerpo === null || Array.isArray(cuerpo)) {
      return respuestaError('INVALID_BODY')
    }
    const obj = cuerpo as Record<string, unknown>
    if (!tieneExactamenteLasClaves(obj, CLAVES_BODY)) {
      return respuestaError('INVALID_BODY')
    }
    const sobre = obj.sobre as unknown

    // 3) VERIFICAR SOBRE HMAC — ANTES de usar cualquier ID del payload
    // para consultar datos sensibles. El contrato V1-D2A ya exige
    // forma completa (docenteId/conversacionId/grupoId/generadoEn/
    // rosterFingerprint/operaciones no vacías) — no se duplica esa
    // validación aquí.
    if (!verificarAplicacionListaOficialFirmada(sobre)) {
      return respuestaError('INVALID_SIGNATURE')
    }
    // A partir de aquí, TypeScript no lo sabe automáticamente (la
    // función solo devuelve boolean), pero el contrato HMAC ya validado
    // garantiza la forma — se afirma el tipo una sola vez, en este
    // punto exacto, nunca antes de la verificación de arriba.
    const sobreVerificado = sobre as SobreAplicacionListaOficial
    const { payload } = sobreVerificado

    // 4) docenteId del payload DEBE coincidir con el docente real
    // autenticado — el payload nunca es fuente de verdad de identidad
    // por sí solo, aunque la firma sea válida (una firma válida demuestra
    // que ESTE servidor lo generó alguna vez, nunca que quien lo envía
    // ahora es el mismo docente).
    if (payload.docenteId !== auth.user.id) {
      return respuestaError('OWNERSHIP_MISMATCH')
    }

    // 5) GRUPO — server-side, nunca aceptar institución/ciclo del
    // cliente. Mismo patrón real de comparar/route.ts, ampliado con
    // institucion_id (usado más abajo para acotar la consulta de CURP a
    // esta institución — ver advertencia junto a curpsVisiblesDocenteBuilder
    // sobre lo que esa consulta realmente puede observar bajo RLS).
    const { data: grupo, error: errorGrupo } = await auth.supabase
      .from('grupos')
      .select('id, institucion_id')
      .eq('id', payload.grupoId)
      .eq('docente_id', auth.user.id)
      .maybeSingle()
    if (errorGrupo) {
      return respuestaError('OWNERSHIP_MISMATCH')
    }
    if (!grupo) {
      return respuestaError('OWNERSHIP_MISMATCH')
    }

    // 6) CONVERSACIÓN — mismo patrón real que obtenerConversacionAutorizadaCompleta
    // en app/api/chat/route.ts: el cliente RLS-scoped (auth.supabase)
    // ya solo puede ver conversaciones_chat propias (docente_id=auth.uid()),
    // así que un SELECT por id que no regrese fila significa "no existe
    // o no es del docente" — mismo mensaje genérico para ambos casos.
    const { data: conversacion, error: errorConversacion } = await auth.supabase
      .from('conversaciones_chat')
      .select('id')
      .eq('id', payload.conversacionId)
      .maybeSingle()
    if (errorConversacion) {
      return respuestaError('OWNERSHIP_MISMATCH')
    }
    if (!conversacion) {
      return respuestaError('OWNERSHIP_MISMATCH')
    }

    // 7) ROSTER ACTUAL — EXACTAMENTE la misma fuente/población que ya
    // usa compararListaOficial (comparar/route.ts): obtenerRosterConPosicion,
    // nunca una segunda definición. Esa función ya filtra
    // estatus='activo' — es la ÚNICA población lógica real del grupo
    // que existe hoy en el código, así que recalcular el fingerprint
    // sobre cualquier otra población sería, por definición, nunca
    // reproducible contra lo que el productor del sobre haya firmado.
    const roster = await obtenerRosterConPosicion(auth.supabase, payload.grupoId)
    if (roster.error) {
      return respuestaError('STALE_ROSTER')
    }

    // 8) FINGERPRINT — mismos 3 campos exactos de V1-D1, sin ampliar
    // (ver lib/listaOficial/rosterFingerprint.ts): inscripcionId,
    // estatus ('activo', ya garantizado por el filtro de la consulta
    // anterior), curpNormalizada (la función ya normaliza).
    const fingerprintActual = calcularRosterFingerprint(
      roster.data.map((a) => ({ inscripcionId: a.inscripcion_id, estatus: 'activo', curp: a.curp }))
    )
    if (fingerprintActual !== payload.rosterFingerprint) {
      return respuestaError('STALE_ROSTER')
    }

    // 9) VALIDAR OPERACIONES CONTRA BD — precargar en lotes (nunca una
    // consulta por operación, ver diseño aprobado V1-D2B sección 14) y
    // delegar la decisión determinista a prevalidarOperaciones (lib/
    // listaOficial/prevalidacionAplicacion.ts), que es pura y nunca
    // toca Supabase por sí misma.
    //
    // V1-D2B2 — adaptado al contrato cerrado V1-D2A2. alumnoIdsEnRosterActivo
    // (ya calculado para el fingerprint, arriba) se reutiliza TAL CUAL
    // como la señal de "ya tiene inscripción activa en este grupo" para
    // alta_inscripcion — nunca una segunda consulta para decir lo mismo
    // dos veces (ver comentario de ContextoPrevalidacion en
    // prevalidacionAplicacion.ts). La consulta de `alumnos` ahora cubre,
    // en una sola llamada batch, los alumnoId referenciados tanto por
    // actualizar_dato como por alta_inscripcion — nunca una query por
    // tipo de operación ni por operación individual. La consulta por
    // nombre (que producía el defecto DUPLICATE_ACTIVE_ENROLLMENT sin
    // haber consultado jamás `inscripciones`) se ELIMINÓ por completo:
    // alta_persona ya no examina nombre para nada.
    const operaciones: OperacionAplicableListaOficial[] = payload.operaciones
    const alumnoIdsEnRosterActivo = new Set(roster.data.map((a) => a.id))

    const idsActualizarDato = operaciones.filter((o) => o.tipo === 'actualizar_dato').map((o) => o.alumnoId)
    const idsAltaInscripcion = operaciones.filter((o) => o.tipo === 'alta_inscripcion').map((o) => o.alumnoId)
    const idsBaja = operaciones.filter((o) => o.tipo === 'baja').map((o) => o.inscripcionId)
    const idsAlumnosRelevantes = Array.from(new Set([...idsActualizarDato, ...idsAltaInscripcion]))
    const curpsACotejar = operaciones
      .flatMap((o) => (o.tipo === 'actualizar_dato' ? [o.valorPropuesto] : o.tipo === 'alta_persona' && o.curp !== null ? [o.curp] : []))
      .map((c) => c.trim().toUpperCase())

    const alumnosCargados = new Map<string, AlumnoActualCargado>()
    if (idsAlumnosRelevantes.length > 0) {
      const { data: alumnos, error: errorAlumnos } = await auth.supabase
        .from('alumnos')
        .select('id, curp, institucion_id')
        .in('id', idsAlumnosRelevantes)
        .eq('docente_id', auth.user.id)
      if (errorAlumnos) {
        return respuestaError('OWNERSHIP_MISMATCH')
      }
      for (const a of alumnos ?? []) {
        alumnosCargados.set(a.id as string, { curpActual: (a.curp as string | null) ?? null, institucionId: a.institucion_id as string })
      }
    }

    const inscripcionesCargadas = new Map<string, InscripcionActualCargada>()
    if (idsBaja.length > 0) {
      const { data: inscripciones, error: errorInscripciones } = await auth.supabase
        .from('inscripciones')
        .select('id, alumno_id, grupo_id, estatus')
        .in('id', idsBaja)
        .eq('docente_id', auth.user.id)
      if (errorInscripciones) {
        return respuestaError('OWNERSHIP_MISMATCH')
      }
      for (const i of inscripciones ?? []) {
        inscripcionesCargadas.set(i.id as string, { alumnoId: i.alumno_id as string, grupoId: i.grupo_id as string, estatus: i.estatus as string })
      }
    }

    // *** ADVERTENCIA DE ALCANCE REAL (ver auditoría aprobada "focalizada
    // ACTIVE_ENROLLMENT_EXISTS/privacidad CURP") ***
    // Esta consulta corre bajo auth.supabase (cliente RLS-scoped del
    // docente autenticado — NUNCA service_role, ver cabecera del
    // archivo). La policy real de `alumnos` ("Docentes ven sus
    // alumnos", FOR ALL, docente_id=auth.uid()) restringe el resultado,
    // SIEMPRE, a filas del propio docente — el filtro explícito
    // `.eq('institucion_id', ...)` de abajo NUNCA amplía esa visibilidad
    // más allá de RLS, solo la acota todavía más dentro de lo ya
    // visible. Por tanto esta consulta NUNCA observa "toda la
    // institución" — solo los alumnos VISIBLES PARA ESTE DOCENTE dentro
    // de la institución destino. Acumula TODOS los propietarios
    // OBSERVADOS por CURP (nunca sobrescribe — ver auditoría aprobada
    // "riesgo Map.set/CURP duplicada"): si 2+ alumnos visibles ya
    // comparten la misma CURP, ambos quedan registrados, sin que el
    // orden de llegada de las filas oculte al segundo.
    //
    // Esto es una PREVALIDACIÓN fast-fail. DUPLICATE_CURP emitido desde
    // aquí significa que YA se encontró un conflicto real entre las
    // filas visibles — pero su AUSENCIA nunca demuestra que la CURP
    // esté libre en toda la institución (podría pertenecer a un alumno
    // de OTRO docente de la misma institución, invisible bajo esta
    // RLS). La futura RPC de aplicación (V1-D2C) DEBE volver a
    // comprobar la CURP a nivel institucional completo mediante su
    // propio mecanismo server-side autorizado (igual que hoy ya hacen
    // importar_alumnos_a_grupo/reparar_curp_desde_lista_oficial, dentro
    // de su propia transacción) antes de cualquier INSERT/UPDATE — D2B
    // nunca es la autoridad final de unicidad de CURP.
    const curpsVisiblesDocenteBuilder = new Map<string, string[]>()
    if (curpsACotejar.length > 0) {
      const { data: alumnosConCurp, error: errorCurps } = await auth.supabase
        .from('alumnos')
        .select('id, curp')
        .eq('institucion_id', grupo.institucion_id)
        .not('curp', 'is', null)
      if (errorCurps) {
        return respuestaError('OWNERSHIP_MISMATCH')
      }
      for (const a of alumnosConCurp ?? []) {
        const curpNormalizada = (a.curp as string).trim().toUpperCase()
        const propietarios = curpsVisiblesDocenteBuilder.get(curpNormalizada) ?? []
        propietarios.push(a.id as string)
        curpsVisiblesDocenteBuilder.set(curpNormalizada, propietarios)
      }
    }

    const contexto: ContextoPrevalidacion = {
      grupoId: payload.grupoId,
      institucionId: grupo.institucion_id as string,
      alumnoIdsEnRosterActivo,
      alumnosCargados,
      inscripcionesCargadas,
      curpsVisiblesDocente: curpsVisiblesDocenteBuilder,
    }

    const resultados = prevalidarOperaciones(operaciones, contexto)
    const fallo = primerFallo(resultados)
    if (fallo && !fallo.ok) {
      return respuestaError(fallo.codigo)
    }

    // ÉXITO — solo señal de UX de que el lote parece aplicable AHORA
    // mismo. Nunca "aplicado", nunca cambia ningún estado, nunca
    // devuelve datos sensibles de más (ver advertencia de cabecera: la
    // futura RPC de aplicación revalida todo esto de nuevo dentro de su
    // propia transacción).
    console.log('[importar-alumnos/aplicar-plan] resultado', { ok: true, readyToApply: true, totalOperaciones: operaciones.length })
    return NextResponse.json({ ok: true, readyToApply: true }, { status: 200 })
  } catch {
    return respuestaError('UNEXPECTED_ERROR')
  }
}
