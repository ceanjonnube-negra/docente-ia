// app/api/alumnos/aplicar-correccion/route.ts
//
// Aplica la corrección de UN campo de UN alumno que el docente ya vio
// y confirmó con el botón "Corregir" (ver
// AsistenteService.confirmarCorreccionAlumno) — ver "PASO 2:
// corrección individual segura de UN campo de UN alumno". Mismo
// patrón de autenticación y estructura que
// app/api/calendario/aplicar/route.ts: nunca decide QUÉ corregir
// (eso ya se decidió y se mostró al docente antes), solo ejecuta lo
// ya confirmado — y NUNCA confía ciegamente en lo que el cliente
// mande: revalida campo permitido, formato del valor, y propiedad
// real del alumno antes de escribir nada.

import { NextRequest, NextResponse } from 'next/server'
import { autenticarRequestApi } from '@/lib/server/authApi'
import { aplicarCorreccionAlumno, validarValorCampoAlumno } from '@/lib/motorContexto'
import type { CampoAlumnoCorregible } from '@/lib/asistente/tipos'

export const runtime = 'nodejs'

const CAMPOS_VALIDOS: CampoAlumnoCorregible[] = ['curp', 'sexo', 'fecha_nacimiento']
const FUENTES_VALIDAS = ['texto', 'imagen', 'documento', 'voz', 'manual'] as const

export async function POST(req: NextRequest) {
  try {
    const cuerpo = await req.json()
    const { alumnoId, campo, valorNuevo, fuente, conversacionId, accessToken } = cuerpo
    // Identidad SIEMPRE del JWT verificado (getUser), nunca del userId
    // que mande el cliente — ese campo, si llega, se ignora.
    const auth = await autenticarRequestApi(typeof accessToken === 'string' ? accessToken : null)
    if (!auth.ok) {
      return NextResponse.json({ error: 'Sesión no válida. Vuelve a iniciar sesión e intenta de nuevo.' }, { status: 401 })
    }
    if (typeof alumnoId !== 'string' || !alumnoId) {
      return NextResponse.json({ error: 'Falta el alumno a corregir.' }, { status: 400 })
    }
    // Nunca confiar en un `campo` arbitrario que mande el cliente —
    // aunque ya se validó del lado del clasificador/Herramienta al
    // presentar la propuesta, este endpoint es una superficie
    // autenticada independiente y revalida por su cuenta.
    if (typeof campo !== 'string' || !CAMPOS_VALIDOS.includes(campo as CampoAlumnoCorregible)) {
      return NextResponse.json({ error: 'Ese campo no está autorizado para corregirse desde aquí.' }, { status: 400 })
    }
    if (typeof valorNuevo !== 'string' || !valorNuevo.trim()) {
      return NextResponse.json({ error: 'Falta el valor nuevo.' }, { status: 400 })
    }
    const fuenteTipo = typeof fuente === 'string' && (FUENTES_VALIDAS as readonly string[]).includes(fuente) ? fuente : 'manual'

    // Revalidación de FORMATO — la misma función que ya se usó al
    // presentar la propuesta (nunca una segunda regla paralela), pero
    // vuelta a correr aquí: un payload que viaja de vuelta desde el
    // cliente, aunque haya salido del propio servidor momentos antes,
    // nunca se confía a ciegas.
    const validacion = validarValorCampoAlumno(campo as CampoAlumnoCorregible, valorNuevo)
    if (!validacion.valido) {
      return NextResponse.json({ error: `Ese valor ya no tiene un formato válido: ${validacion.motivo}.` }, { status: 400 })
    }

    // CURP: solo se ejecuta la propuesta ORIGINAL — su valor anterior
    // exacto (compare-and-set de actualizar_curp_alumno) y la misma
    // conversación en la que el servidor la generó. Si falta cualquiera
    // de los dos, no se ejecuta y se pide una propuesta nueva.
    let valorEsperado: string | null | undefined
    if (campo === 'curp') {
      const traeValorAnterior = Object.prototype.hasOwnProperty.call(cuerpo, 'valorAnterior') && (typeof cuerpo.valorAnterior === 'string' || cuerpo.valorAnterior === null)
      const mismaConversacion = typeof conversacionId === 'string' && conversacionId.length > 0 && cuerpo.propuestaConversacionId === conversacionId
      if (!traeValorAnterior || !mismaConversacion) {
        return NextResponse.json({ exito: false, error: 'No pude vincular esta corrección con su propuesta original. Pídeme de nuevo la corrección para mostrarte el dato actual.', definitivo: true }, { status: 200 })
      }
      valorEsperado = cuerpo.valorAnterior as string | null
    }

    // aplicarCorreccionAlumno: CURP vía la RPC canónica (atómica, con
    // trazabilidad incluida); sexo/fecha_nacimiento con su flujo de
    // siempre (propiedad real, relectura y verificación) — ver
    // lib/motorContexto.ts.
    const resultado = await aplicarCorreccionAlumno(auth.supabase, auth.user.id, alumnoId, campo as CampoAlumnoCorregible, validacion.valorNormalizado, {
      tipo: fuenteTipo as 'texto' | 'imagen' | 'documento' | 'voz' | 'manual',
      conversacionId: typeof conversacionId === 'string' ? conversacionId : null,
      mensajeId: null,
    }, valorEsperado)

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
