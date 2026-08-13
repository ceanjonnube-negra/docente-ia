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
import { createClient } from '@supabase/supabase-js'
import { aplicarCorreccionAlumno, validarValorCampoAlumno } from '@/lib/motorContexto'
import type { CampoAlumnoCorregible } from '@/lib/asistente/tipos'

export const runtime = 'nodejs'

const CAMPOS_VALIDOS: CampoAlumnoCorregible[] = ['curp', 'sexo', 'fecha_nacimiento']
const FUENTES_VALIDAS = ['texto', 'imagen', 'documento', 'voz', 'manual'] as const

export async function POST(req: NextRequest) {
  try {
    const { alumnoId, campo, valorNuevo, fuente, conversacionId, userId, accessToken } = await req.json()

    if (!userId || !accessToken) {
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

    const supabaseUser = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    })

    // aplicarCorreccionAlumno vuelve a comprobar propiedad real
    // (.eq('docente_id', userId)) en cada lectura/escritura, relee el
    // valor actual REAL (nunca el que mande el cliente), y verifica el
    // valor guardado después del UPDATE antes de reportar éxito — ver
    // lib/motorContexto.ts.
    const resultado = await aplicarCorreccionAlumno(supabaseUser, userId, alumnoId, campo as CampoAlumnoCorregible, validacion.valorNormalizado, {
      tipo: fuenteTipo as 'texto' | 'imagen' | 'documento' | 'voz' | 'manual',
      conversacionId: typeof conversacionId === 'string' ? conversacionId : null,
      mensajeId: null,
    })

    if (!resultado.exito) {
      return NextResponse.json({ exito: false, error: resultado.error }, { status: 200 })
    }
    if (resultado.sinCambios) {
      return NextResponse.json({ exito: true, texto: 'Ese valor ya coincidía con el registrado — no hice ningún cambio.' })
    }
    return NextResponse.json({ exito: true, texto: `Listo. Corregí el dato: ahora es ${resultado.valorNuevo}.` })
  } catch (error) {
    console.error('[alumnos/aplicar-correccion] Error:', error)
    const mensajeError = error instanceof Error ? error.message : 'No pude aplicar la corrección. Intenta de nuevo.'
    return NextResponse.json({ error: mensajeError }, { status: 502 })
  }
}
