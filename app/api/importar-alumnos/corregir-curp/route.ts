// app/api/importar-alumnos/corregir-curp/route.ts
//
// Único camino de aplicación para public.reparar_curp_desde_lista_oficial
// (ver diseño exacto aprobado). Endpoint mínimo, determinista, sin IA, sin
// matching, sin fuzzy, sin HMAC: recibe una propuesta YA identificada por
// la capa de solo lectura (V1-B + capa de propuestas) y solo la reenvía a
// la RPC, que es la única autoridad real de ownership/grupo/CAS/
// estructura/duplicados — este endpoint nunca repite esas reglas.
//
// Autenticación: mismo patrón ya usado por su hermano directo
// /api/importar-alumnos/comparar/route.ts — extraerBearerToken +
// autenticarRequestApi (lib/server/authApi.ts), nunca service_role. La
// llamada a la RPC se hace con auth.supabase (cliente RLS-scoped con el
// token real del docente) para que auth.uid() dentro de la función
// SECURITY INVOKER resuelva al docente real, nunca a un rol elevado.
//
// Normalización: expectedCurrentCurp y newCurp viajan a la RPC EXACTAMENTE
// como llegaron del cliente (RAW) — nunca trim/uppercase en este archivo.
// El compare-and-set de la RPC necesita el valor RAW exacto que vio la
// propuesta; la normalización final (trim+mayúsculas) es responsabilidad
// exclusiva de la RPC, única autoridad, para no introducir una segunda
// implementación que pueda divergir. La única excepción es una COPIA
// usada solo para el fast-fail de UX (ver más abajo) — esa copia nunca
// sustituye al valor RAW que se envía a la RPC.
//
// Privacidad: los logs de este endpoint son exclusivamente endpoint +
// resultado + categoría estable de error — nunca alumnoId, grupoId,
// CURPs, nombres, bearer/token, ni el mensaje/detail/hint crudo de
// Postgres.

import { NextResponse } from 'next/server'
import { extraerBearerToken, autenticarRequestApi } from '@/lib/server/authApi'
import { validarEstructuraCurp } from '@/lib/motorContexto'

export const runtime = 'nodejs'

const CLAVES_PAYLOAD = ['alumnoId', 'grupoId', 'expectedCurrentCurp', 'newCurp'] as const

const REGEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Categorías estables que puede emitir la RPC (RAISE EXCEPTION con el
// nombre exacto de la categoría como mensaje, sin PII — ver migración
// 20260913010000_reparar_curp_desde_lista_oficial.sql). Comparación EXACTA
// contra error.message, nunca "contains", para no confundir categorías.
const MENSAJES_ERROR: Record<string, { status: number; codigo: string; mensaje: string }> = {
  AUTH_REQUIRED: {
    status: 401,
    codigo: 'AUTH_REQUIRED',
    mensaje: 'Tu sesión ya no es válida. Vuelve a iniciar sesión.',
  },
  STUDENT_NOT_AUTHORIZED: {
    status: 403,
    codigo: 'STUDENT_NOT_AUTHORIZED',
    mensaje: 'No fue posible modificar este alumno.',
  },
  GROUP_NOT_AUTHORIZED: {
    status: 403,
    codigo: 'GROUP_NOT_AUTHORIZED',
    mensaje: 'El alumno ya no pertenece al grupo activo.',
  },
  STALE_CURRENT_VALUE: {
    status: 409,
    codigo: 'STALE_CURRENT_VALUE',
    mensaje: 'El dato cambió desde que se generó la vista previa. Actualiza la comparación.',
  },
  CURRENT_CURP_NOT_REPAIRABLE: {
    status: 409,
    codigo: 'CURRENT_CURP_NOT_REPAIRABLE',
    mensaje: 'Este dato ya no requiere esta corrección.',
  },
  NEW_CURP_INVALID: {
    status: 400,
    codigo: 'NEW_CURP_INVALID',
    mensaje: 'La CURP propuesta no tiene una estructura válida.',
  },
  NEW_CURP_DUPLICATE: {
    status: 409,
    codigo: 'NEW_CURP_DUPLICATE',
    mensaje: 'La CURP propuesta ya está registrada en otro alumno.',
  },
}

// Whitelist exacta de claves — ni una de más, ni una de menos (mismo
// principio ya usado en este proyecto para sobres firmados, reimplementado
// aquí localmente porque ese otro módulo pertenece a un flujo distinto y
// no debe importarse). Nunca ignora una clave extra en silencio.
function tieneExactamenteEstasClaves(obj: Record<string, unknown>, claves: readonly string[]): boolean {
  const encontradas = Object.keys(obj)
  if (encontradas.length !== claves.length) return false
  return claves.every((c) => Object.prototype.hasOwnProperty.call(obj, c))
}

function respuestaInvalida(mensaje = 'La solicitud no tiene un formato válido.') {
  return NextResponse.json({ exito: false, codigo: 'INVALID_PAYLOAD', error: mensaje }, { status: 400 })
}

export async function POST(req: Request) {
  try {
    // 1) Autenticación real — mismo patrón que /api/importar-alumnos/comparar.
    const accessToken = extraerBearerToken(req)
    const auth = await autenticarRequestApi(accessToken)
    if (!auth.ok) {
      return NextResponse.json({ exito: false, codigo: 'AUTH_REQUIRED', error: MENSAJES_ERROR.AUTH_REQUIRED.mensaje }, { status: auth.status })
    }

    // 2) Body — parseo fail-closed.
    let cuerpo: unknown
    try {
      cuerpo = await req.json()
    } catch {
      return respuestaInvalida()
    }
    if (typeof cuerpo !== 'object' || cuerpo === null || Array.isArray(cuerpo)) {
      return respuestaInvalida()
    }
    const obj = cuerpo as Record<string, unknown>
    if (!tieneExactamenteEstasClaves(obj, CLAVES_PAYLOAD)) {
      return respuestaInvalida()
    }

    const { alumnoId, grupoId, expectedCurrentCurp, newCurp } = obj

    // 3) Shape — solo forma, nunca reglas de negocio (eso es exclusivo
    // de la RPC: ownership, grupo, CAS, estructura, duplicados).
    if (typeof alumnoId !== 'string' || !REGEX_UUID.test(alumnoId)) {
      return respuestaInvalida()
    }
    if (typeof grupoId !== 'string' || !REGEX_UUID.test(grupoId)) {
      return respuestaInvalida()
    }
    if (typeof expectedCurrentCurp !== 'string' || expectedCurrentCurp.trim().length === 0) {
      return respuestaInvalida()
    }
    if (typeof newCurp !== 'string' || newCurp.trim().length === 0) {
      return respuestaInvalida()
    }

    // 4) Fast-fail de UX — SOLO sobre una copia normalizada de newCurp
    // (validarEstructuraCurp espera un valor ya en mayúsculas/sin bordes,
    // igual que sus demás callers reales). Nunca se reemplaza newCurp por
    // esta copia: lo que se envía a la RPC más abajo sigue siendo el RAW
    // original. expectedCurrentCurp nunca se valida aquí — se espera que
    // sea inválida, y el CAS de la RPC necesita el valor RAW exacto.
    const newCurpParaValidar = newCurp.trim().toUpperCase()
    if (!validarEstructuraCurp(newCurpParaValidar).valido) {
      const info = MENSAJES_ERROR.NEW_CURP_INVALID
      return NextResponse.json({ exito: false, codigo: info.codigo, error: info.mensaje }, { status: info.status })
    }

    // 5) Única llamada a la RPC — RAW en ambos campos de CURP, sin SELECT
    // previo, sin retry, sin segunda escritura.
    const { error } = await auth.supabase.rpc('reparar_curp_desde_lista_oficial', {
      p_alumno_id: alumnoId,
      p_grupo_id: grupoId,
      p_curp_esperada_actual: expectedCurrentCurp,
      p_curp_nueva: newCurp,
    })

    if (error) {
      const info = error.message ? MENSAJES_ERROR[error.message] : undefined
      console.warn('[importar-alumnos/corregir-curp] resultado', { exito: false, codigo: info?.codigo ?? 'UNEXPECTED_ERROR' })
      if (info) {
        return NextResponse.json({ exito: false, codigo: info.codigo, error: info.mensaje }, { status: info.status })
      }
      return NextResponse.json(
        { exito: false, codigo: 'UNEXPECTED_ERROR', error: 'No fue posible aplicar la corrección.' },
        { status: 500 }
      )
    }

    console.log('[importar-alumnos/corregir-curp] resultado', { exito: true })
    return NextResponse.json({ exito: true }, { status: 200 })
  } catch {
    return NextResponse.json(
      { exito: false, codigo: 'UNEXPECTED_ERROR', error: 'No fue posible aplicar la corrección.' },
      { status: 500 }
    )
  }
}
