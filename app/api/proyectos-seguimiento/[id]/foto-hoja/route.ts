import { NextRequest, NextResponse } from 'next/server'
import { autenticarRequestApi } from '@/lib/server/authApi'
import { subirBuffer, eliminarArchivo, rutaArchivo, BUCKET_HOJAS_SEGUIMIENTO } from '@/lib/documentGen/almacenamiento'
import { calcularCantidadPaginasHoja } from '@/lib/documentGen/generarHojaSeguimientoPdf'
import { extraerFotosCapturaPendiente, type FotoCapturaHoja } from '@/lib/seguimiento/analisisHojaEvaluacion'

export const runtime = 'nodejs'

// EVAL-1C — carga segura de la fotografía de una hoja de evaluación YA
// IMPRESA Y CONTESTADA. Esta fase SOLO recibe, valida y almacena el
// archivo — deliberadamente NO hace: extracción visual, matching contra
// alumnos, cálculo de confianza, ni ninguna escritura en
// seguimiento_resultados. Eso pertenece a fases posteriores (EVAL-1D en
// adelante), que consumirán proyectos_seguimiento.captura_pendiente.fotos
// escrito aquí. Mismo criterio de seguridad que el resto de
// app/api/proyectos-seguimiento/*: nunca service_role, el docente real
// se resuelve siempre desde el access_token vía auth.getUser(), nunca de
// un docente_id que mande el cliente.
//
// EVAL-1D.2 — soporte multipágina. Un campo opcional "pagina" (entero,
// 1-indexado, default 1 — preserva el comportamiento exacto de una
// hoja de 1 sola página sin requerir ningún cambio en un cliente que
// nunca lo envíe) identifica a qué página física de la hoja pertenece
// esta fotografía. El número máximo de página aceptado se deriva, sin
// IA, de calcularCantidadPaginasHoja(roster_congelado.length) — la
// MISMA aritmética que usó el renderizador real del PDF para paginar
// este roster exacto — nunca un límite arbitrario que el cliente
// pueda inflar. Subir una fotografía para una página ya cargada
// REEMPLAZA esa página (nunca duplica); subir una página nueva se
// AGREGA al arreglo, nunca se pierde una página ya cargada. Cualquier
// carga (nueva o de reemplazo) invalida una transcripción previa
// (captura_pendiente.extraidoBruto) — una foto distinta en cualquier
// página vuelve obsoleta cualquier análisis anterior de la hoja
// completa.

const REGEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Mismo whitelist de extensiones de imagen ya usado en
// app/api/importar-alumnos/route.ts (EXTENSIONES_IMAGEN) — se repite
// aquí, no se importa, porque ese archivo no exporta la constante y
// ampliar su superficie pública está fuera de alcance de esta fase.
const MIME_POR_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
}

// Margen amplio para una foto real de celular (una foto típica pesa
// 2-8 MB) sin dejar la puerta abierta a un archivo arbitrariamente
// grande — el runtime de Vercel Functions admite hasta 100 MB de body,
// pero esta ruta nunca necesita algo cercano a eso.
const TAMANO_MAXIMO_BYTES = 10 * 1024 * 1024

// Estados posteriores a una confirmación real (todavía no implementada
// en ningún camino de código, pero ya válidos en el CHECK real de
// proyectos_seguimiento.estado) — una vez ahí, cargar otra fotografía
// debe rechazarse: seguimiento_resultados ya sería la fuente canónica
// definitiva, nunca se sustituye con una nueva captura sin pasar por un
// flujo de corrección explícito (fuera de alcance de esta fase).
const ESTADOS_POST_CONFIRMACION = new Set(['confirmado', 'corregido', 'sustituido', 'cerrado'])

type CapturaPendiente = { fotos?: unknown; fotoStoragePath?: string; fotoSubidaEn?: string } | null

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: proyectoId } = await params
  try {
    if (!REGEX_UUID.test(proyectoId)) {
      return NextResponse.json({ error: 'Identificador de proyecto inválido.' }, { status: 400 })
    }

    const formData = await req.formData()
    const accessToken = formData.get('access_token') as string | null
    const archivo = formData.get('foto') as File | null
    // Opcional — ausente/'' equivale a página 1, así una hoja de 1
    // sola página sigue funcionando exactamente igual sin que el
    // cliente necesite enviar este campo nunca.
    const paginaBruta = formData.get('pagina') as string | null
    const pagina = paginaBruta === null || paginaBruta === '' ? 1 : Number(paginaBruta)

    // El docente real se resuelve SIEMPRE desde el access_token vía
    // auth.getUser() — mismo patrón de lib/server/authApi.ts ya usado en
    // el resto de app/api/proyectos-seguimiento/*. Nunca se confía en un
    // docente_id que mande el cliente.
    const auth = await autenticarRequestApi(accessToken)
    if (!auth.ok) {
      return NextResponse.json({ error: auth.mensaje }, { status: auth.status })
    }
    const docenteId = auth.user.id
    const supabase = auth.supabase

    if (!archivo) {
      return NextResponse.json({ error: 'No se recibió ninguna fotografía.' }, { status: 400 })
    }
    if (!Number.isInteger(pagina) || pagina < 1) {
      return NextResponse.json({ error: 'Número de página inválido.' }, { status: 400 })
    }
    const extension = archivo.name.split('.').pop()?.toLowerCase() || ''
    const mimeType = MIME_POR_EXTENSION[extension]
    if (!mimeType) {
      return NextResponse.json({ error: 'Formato de imagen no soportado. Usa JPG, PNG, WEBP o HEIC.' }, { status: 400 })
    }
    if (archivo.size > TAMANO_MAXIMO_BYTES) {
      return NextResponse.json({ error: 'La fotografía es demasiado grande (máximo 10 MB).' }, { status: 400 })
    }

    // Proyecto real, verificado contra el docente real de la sesión —
    // nunca se delega esa verificación únicamente a RLS (mismo patrón
    // que el resto de este archivo hermano, [id]/hoja/route.ts).
    const { data: proyecto, error: errorProyecto } = await supabase
      .from('proyectos_seguimiento')
      .select('id, docente_id, hoja_id, estado, captura_pendiente')
      .eq('id', proyectoId)
      .maybeSingle()
    if (errorProyecto) {
      return NextResponse.json({ error: 'No se pudo verificar el proyecto.' }, { status: 500 })
    }
    if (!proyecto) {
      return NextResponse.json({ error: 'Proyecto no encontrado.' }, { status: 404 })
    }
    if (proyecto.docente_id !== docenteId) {
      return NextResponse.json({ error: 'No tienes acceso a este proyecto.' }, { status: 403 })
    }
    if (ESTADOS_POST_CONFIRMACION.has(proyecto.estado)) {
      return NextResponse.json({ error: 'Esta hoja ya fue confirmada; no se puede cargar otra fotografía.' }, { status: 409 })
    }
    if (!proyecto.hoja_id) {
      return NextResponse.json({ error: 'Este proyecto todavía no tiene una hoja de evaluación generada.' }, { status: 409 })
    }

    // EVAL-1B — fail-closed: sin roster_congelado no existe una
    // identidad determinista de alumno×posición para esta hoja — nunca
    // se acepta una fotografía que no pueda emparejarse de forma
    // confiable más adelante (ver informe EVAL-1B, "hojas históricas").
    const { data: hoja, error: errorHoja } = await supabase
      .from('hojas_evaluacion')
      .select('id, identificador_visible, roster_congelado')
      .eq('id', proyecto.hoja_id)
      .maybeSingle()
    if (errorHoja) {
      return NextResponse.json({ error: 'No se pudo verificar la hoja de evaluación.' }, { status: 500 })
    }
    if (!hoja) {
      return NextResponse.json({ error: 'Hoja de evaluación no encontrada.' }, { status: 404 })
    }
    if (!hoja.roster_congelado) {
      return NextResponse.json({ error: 'Esta hoja fue generada antes de que existiera el registro de alumnos congelado y no admite carga automática de fotografía.' }, { status: 409 })
    }

    // EVAL-1D.2 — el número máximo de página aceptado para ESTA hoja
    // se deriva, sin IA, de la misma aritmética que usó el
    // renderizador real del PDF para paginar este roster exacto —
    // nunca un límite arbitrario que el cliente pueda inflar subiendo
    // "página 37" de una hoja de 1 sola página.
    const paginasEsperadas = calcularCantidadPaginasHoja((hoja.roster_congelado as unknown[]).length)
    if (pagina > paginasEsperadas) {
      return NextResponse.json(
        { error: `Esta hoja tiene ${paginasEsperadas} página${paginasEsperadas === 1 ? '' : 's'}; la página ${pagina} no existe.` },
        { status: 400 }
      )
    }

    // Subida real a Storage — mismo bucket/RLS ya verificado en
    // PLN-1E-H, mismo patrón rutaArchivo(docenteId, nombre) que ya usa
    // la hoja definitiva — nunca service_role. El número de página en
    // el nombre evita que dos páginas de la misma hoja colisionen en
    // la misma ruta.
    const buffer = Buffer.from(await archivo.arrayBuffer())
    const ruta = rutaArchivo(docenteId, `foto-${hoja.identificador_visible}-p${pagina}.${extension}`)
    try {
      await subirBuffer(supabase, ruta, buffer, mimeType, BUCKET_HOJAS_SEGUIMIENTO)
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'No se pudo subir la fotografía.' }, { status: 500 })
    }

    // EVAL-1D.2 — REEMPLAZA únicamente la foto de esta misma página
    // (nunca duplica esa página), y conserva las demás páginas ya
    // cargadas (nunca las pierde ni las acumula sin límite: el máximo
    // real de entradas queda acotado por paginasEsperadas, validado
    // arriba). extraerFotosCapturaPendiente ya cubre, con
    // compatibilidad retroactiva, tanto el arreglo nuevo como la forma
    // histórica de una sola foto (fotoStoragePath) escrita por EVAL-1C
    // antes de este cambio. Si había una fotografía previa de esta
    // misma página sin confirmar, se elimina de Storage para no dejar
    // archivos huérfanos — mejor esfuerzo, nunca bloquea la respuesta
    // si la limpieza falla.
    const capturaPrevia = (proyecto.captura_pendiente as CapturaPendiente) ?? null
    const fotosPrevias = extraerFotosCapturaPendiente(capturaPrevia)
    const fotoPreviaMismaPagina = fotosPrevias.find((f) => f.pagina === pagina)
    if (fotoPreviaMismaPagina && fotoPreviaMismaPagina.storagePath !== ruta) {
      await eliminarArchivo(supabase, fotoPreviaMismaPagina.storagePath, BUCKET_HOJAS_SEGUIMIENTO)
    }
    const fotosActualizadas: FotoCapturaHoja[] = [
      ...fotosPrevias.filter((f) => f.pagina !== pagina),
      { storagePath: ruta, pagina, subidaEn: new Date().toISOString() },
    ].sort((a, b) => a.pagina - b.pagina)

    // Cualquier carga (nueva página o reemplazo) invalida una
    // transcripción previa — captura_pendiente se reescribe por
    // completo con SOLO el arreglo de fotos actualizado, nunca se
    // conserva un extraidoBruto/extraidoEn que ya no corresponde al
    // conjunto real de fotografías.
    const { error: errorUpdate } = await supabase
      .from('proyectos_seguimiento')
      .update({
        captura_pendiente: { fotos: fotosActualizadas },
        estado: 'fotografia_cargada',
        actualizado_en: new Date().toISOString(),
      })
      .eq('id', proyectoId)
    if (errorUpdate) {
      // El archivo SÍ se subió pero no se pudo registrar — se elimina
      // el archivo huérfano en vez de dejarlo sin referencia (mismo
      // criterio que generarYGuardarHoja.ts).
      await eliminarArchivo(supabase, ruta, BUCKET_HOJAS_SEGUIMIENTO)
      return NextResponse.json({ error: 'No se pudo registrar la fotografía. Intenta de nuevo.' }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      fotoStoragePath: ruta,
      pagina,
      paginasEsperadas,
      paginasCargadas: fotosActualizadas.length,
      estado: 'fotografia_cargada',
    })
  } catch (err) {
    console.error(`Error en POST /api/proyectos-seguimiento/${proyectoId}/foto-hoja:`, err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error inesperado.' }, { status: 500 })
  }
}
