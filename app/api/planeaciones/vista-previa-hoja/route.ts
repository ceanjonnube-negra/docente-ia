import { NextRequest, NextResponse } from 'next/server'
import { autenticarRequestApi } from '@/lib/server/authApi'
import { obtenerRosterConPosicion } from '@/lib/rosterGrupo'
import { generarHojaSeguimientoPdfBuffer } from '@/lib/documentGen/generarHojaSeguimientoPdf'
import type { IndicadorProyecto } from '@/lib/seguimiento/tipos'

export const runtime = 'nodejs'

const REGEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const IDENTIFICADOR_VISTA_PREVIA = 'VISTA PREVIA — PENDIENTE DE APROBACIÓN'

type DatosVistaPrevia = {
  grupoId: string
  nombreProyecto: string
  camposFormativos: string[]
  trimestreNombre: string | null
  fechaInicio: string | null
  fechaFin: string | null
  indicadores: string[]
  zonaHoraria: string | null
}

// Vista previa DESCARGABLE de la hoja de evaluación de un borrador de
// planeación TODAVÍA NO APROBADO (C-005, corrección funcional) — a
// propósito NO sube nada a Storage, NO crea filas en planeaciones,
// planeacion_proyectos, proyectos_seguimiento ni hojas_evaluacion:
// genera el PDF en memoria y lo devuelve directo en la respuesta HTTP.
// Reutiliza el mismo generador que la hoja definitiva
// (generarHojaSeguimientoPdfBuffer) — nunca un segundo generador ni
// una segunda interpretación de los datos del proyecto.
//
// GET en vez de POST porque el botón "Descargar" del Chat IA
// (components/Asistente/AsistentePanel.tsx) hace window.open(url) —
// una navegación directa, sin cabeceras — así que la autenticación
// viaja en la propia URL como query param `token`, exactamente el
// mismo access_token de sesión que el resto de la app ya pasa en
// cuerpos de petición, solo reubicado aquí por esa restricción del
// navegador. No hay alumnos ni ningún otro dato de un alumno en la
// URL — el roster real se obtiene aquí mismo, server-side, con RLS.
export async function GET(req: NextRequest) {
  try {
    const token = req.nextUrl.searchParams.get('token')
    const datosCodificados = req.nextUrl.searchParams.get('datos')
    // Validación explícita del tipo de documento (corrección "el
    // adjunto de planeación abre la hoja de evaluación") — esta ruta
    // SOLO genera el instrumento grupal; nunca decide qué generar solo
    // por a qué endpoint llegó la petición ni por el nombre del
    // archivo. Un tipoDocumento ausente o distinto de "hoja_evaluacion"
    // es un error controlado, nunca un valor por defecto silencioso.
    const tipoDocumento = req.nextUrl.searchParams.get('tipoDocumento')
    if (tipoDocumento !== 'hoja_evaluacion') {
      return NextResponse.json({ error: 'Tipo de documento inválido para esta vista previa.' }, { status: 400 })
    }
    if (!token || !datosCodificados) {
      return NextResponse.json({ error: 'Faltan parámetros para generar la vista previa.' }, { status: 400 })
    }
    // modo — mismo criterio que la hermana vista-previa-documento
    // (CORRECCIÓN AISLADA — "separar 'Ver PDF' de 'Descargar PDF'"):
    // 'ver' sirve el mismo pdf en línea; 'descargar' (default) fuerza
    // la descarga con application/octet-stream. Nunca cambia el
    // buffer generado, solo las cabeceras de la respuesta.
    const modo = req.nextUrl.searchParams.get('modo') === 'ver' ? 'ver' : 'descargar'

    const auth = await autenticarRequestApi(token)
    if (!auth.ok) {
      return NextResponse.json({ error: auth.mensaje }, { status: auth.status })
    }
    const docenteId = auth.user.id
    const supabase = auth.supabase

    let datos: DatosVistaPrevia
    try {
      datos = JSON.parse(Buffer.from(datosCodificados, 'base64').toString('utf-8'))
    } catch {
      return NextResponse.json({ error: 'Datos de la vista previa inválidos.' }, { status: 400 })
    }
    if (!datos.grupoId || !REGEX_UUID.test(datos.grupoId) || !datos.nombreProyecto?.trim()) {
      return NextResponse.json({ error: 'Datos de la vista previa inválidos.' }, { status: 400 })
    }

    // El grupo se verifica explícitamente contra el docente real de la
    // sesión — nunca se confía en grupoId solo porque venía codificado
    // en la URL (mismo criterio de siempre: verificar, no asumir).
    const { data: grupo, error: errorGrupo } = await supabase
      .from('grupos')
      .select('id, docente_id')
      .eq('id', datos.grupoId)
      .maybeSingle()
    if (errorGrupo) {
      return NextResponse.json({ error: 'No se pudo verificar el grupo.' }, { status: 500 })
    }
    if (!grupo || grupo.docente_id !== docenteId) {
      return NextResponse.json({ error: 'No tienes acceso a este grupo.' }, { status: 403 })
    }

    const [{ data: roster, error: errorRoster }, { data: perfil }] = await Promise.all([
      obtenerRosterConPosicion(supabase, datos.grupoId),
      supabase.from('perfiles_docentes').select('*').eq('id', docenteId).single(),
    ])
    if (errorRoster) {
      return NextResponse.json({ error: 'No se pudo leer la lista del grupo para generar la vista previa.' }, { status: 500 })
    }

    // Los indicadores del borrador son texto libre (extraídos del bloque
    // de resumen, sin clasificar por aspecto) — 'logro_aprendizaje' es el
    // aspecto general más aplicable de los 5 válidos como valor por
    // defecto; nunca se inventa un valor fuera del enum real.
    const indicadores: IndicadorProyecto[] = (datos.indicadores || []).map((texto) => ({
      indicador_especifico: texto,
      aspecto_general: 'logro_aprendizaje',
    }))

    const bufferPdf = await generarHojaSeguimientoPdfBuffer(
      {
        nombreProyecto: datos.nombreProyecto,
        camposFormativos: datos.camposFormativos || [],
        trimestreNombre: datos.trimestreNombre,
        fechaInicio: datos.fechaInicio,
        fechaFin: datos.fechaFin,
        identificadorVisible: IDENTIFICADOR_VISTA_PREVIA,
        indicadores,
        alumnos: (roster || []).map((a) => ({ nombre: a.nombre, posicion: a.posicion })),
      },
      perfil,
      datos.zonaHoraria
    )

    return new NextResponse(new Uint8Array(bufferPdf), {
      status: 200,
      headers: modo === 'ver'
        ? {
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'inline; filename="vista-previa-hoja-evaluacion.pdf"',
            'Cache-Control': 'no-store',
          }
        : {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': 'attachment; filename="vista-previa-hoja-evaluacion.pdf"',
            'Cache-Control': 'private, no-store, max-age=0',
            'X-Content-Type-Options': 'nosniff',
          },
    })
  } catch (err) {
    console.error('Error en GET /api/planeaciones/vista-previa-hoja:', err)
    return NextResponse.json({ error: 'No fue posible generar la vista previa.' }, { status: 500 })
  }
}
