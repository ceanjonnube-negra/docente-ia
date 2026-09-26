import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { autenticarRequestApi } from '@/lib/server/authApi'
import { descargarBuffer, BUCKET_HOJAS_SEGUIMIENTO } from '@/lib/documentGen/almacenamiento'
import { calcularCantidadPaginasHoja } from '@/lib/documentGen/generarHojaSeguimientoPdf'
import {
  analizarImagenesHojaEvaluacion,
  normalizarImagenesHojaParaVision,
  extraerFotosCapturaPendiente,
} from '@/lib/seguimiento/analisisHojaEvaluacion'
import { normalizarIdentificadorHoja, esIdentificadorHojaValido } from '@/lib/identificadorHoja'

export const runtime = 'nodejs'

// EVAL-1D — extracción visual ESTRUCTURADA de la fotografía ya
// cargada en EVAL-1C. Esta fase SOLO transcribe — deliberadamente NO
// hace matching con alumnos/inscripciones reales, NO escribe
// seguimiento_resultados, NO confirma nada, NO convierte la escala
// 1-4 al enum textual canónico. La transcripción bruta se guarda
// únicamente en proyectos_seguimiento.captura_pendiente.extraidoBruto
// (columna ya preparada en EVAL-1B para exactamente este propósito) —
// nunca en una tabla de historial académico real.
//
// EVAL-1D.1 — antes de la única llamada de visión, cada fotografía
// pasa por normalizarImagenesHojaParaVision()
// (lib/seguimiento/analisisHojaEvaluacion.ts): JPG/PNG/WEBP se usan
// tal cual; HEIC/HEIF (formato por defecto de fotos de iPhone, ya
// aceptado por EVAL-1C en la carga pero no soportado directamente por
// la API de visión) se decodifica y recodifica a JPEG server-side, en
// memoria, sin tocar Storage ni captura_pendiente.fotos. Esa
// conversión nunca cuenta como llamada IA.
//
// EVAL-1D.2 — soporte multipágina. Una hoja puede tener más de una
// fotografía (una por página física, ver foto-hoja/route.ts), pero
// TODAS se analizan juntas en UNA SOLA llamada de visión (nunca una
// llamada por fotografía) — mismo patrón ya probado en
// analizarImagenesListaOficial (lib/listaOficial/analisisListaOficial.ts).
// El número de páginas ESPERADO se deriva de forma puramente
// aritmética (calcularCantidadPaginasHoja, sin IA) a partir de
// roster_congelado.length — si la cantidad de fotografías ya
// cargadas no coincide EXACTAMENTE con ese número, el análisis se
// rechaza fail-closed ANTES de descargar o normalizar nada.

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const REGEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Validación de identidad de hoja (ver auditoría "Los Insectos y su
// Papel en la Naturaleza" — una fotografía de un documento
// completamente distinto fue aceptada como si fuera la hoja oficial
// del proyecto, porque nada comparaba la foto contra la hoja
// esperada). Reutiliza EXCLUSIVAMENTE normalizarIdentificadorHoja/
// esIdentificadorHojaValido de lib/identificadorHoja.ts — misma
// fuente que ya usa generarCodigoHoja() para crear el identificador
// real, nunca una copia separada del alfabeto/formato.
//
// Comparación ESTRICTA, nunca aproximada (regla explícita: sin fuzzy
// matching, sin distancia de edición, sin "se parece a"): el único
// margen que se acepta es trim + mayúsculas — cualquier otra
// diferencia, o un código que no cumpla el formato real, es un
// rechazo. `esperado` viene directo de hojas_evaluacion.identificador_visible
// (generado por generarCodigoHoja(), siempre bien formado) —
// `observado` es lo que el modelo transcribió, sin ninguna garantía.
function identidadHojaValida(observado: string | null, esperado: string): boolean {
  if (observado === null) return false
  const normalizado = normalizarIdentificadorHoja(observado)
  if (!esIdentificadorHojaValido(normalizado)) return false
  return normalizado === normalizarIdentificadorHoja(esperado)
}

// Mensaje único y simple para el docente — nunca menciona OCR,
// schema, roster congelado ni "identity mismatch" (ver instrucción de
// UX). Mismo mensaje tanto si el código no coincide como si no fue
// legible — el docente no necesita distinguir esos dos casos.
const MENSAJE_IDENTIDAD_NO_VALIDA =
  'Esta fotografía no corresponde a la hoja de evaluación de este proyecto. Toma una foto de la hoja correcta e inténtalo de nuevo.'

const ESTADOS_POST_CONFIRMACION = new Set(['confirmado', 'corregido', 'sustituido', 'cerrado'])

type CapturaPendiente = { fotos?: unknown; fotoStoragePath?: string; fotoSubidaEn?: string; extraidoBruto?: unknown; extraidoEn?: string; validacionIdentidad?: unknown } | null

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: proyectoId } = await params
  try {
    if (!REGEX_UUID.test(proyectoId)) {
      return NextResponse.json({ error: 'Identificador de proyecto inválido.' }, { status: 400 })
    }

    const { access_token: accessToken } = (await req.json()) as { access_token: string }

    // El docente real se resuelve SIEMPRE desde el access_token vía
    // auth.getUser() — mismo patrón que el resto de
    // app/api/proyectos-seguimiento/*. Nunca se confía en un
    // docente_id que mande el cliente.
    const auth = await autenticarRequestApi(accessToken)
    if (!auth.ok) {
      return NextResponse.json({ error: auth.mensaje }, { status: auth.status })
    }
    const docenteId = auth.user.id
    const supabase = auth.supabase

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
      return NextResponse.json({ error: 'Esta hoja ya fue confirmada; no se puede volver a analizar.' }, { status: 409 })
    }

    const capturaPendiente = (proyecto.captura_pendiente as CapturaPendiente) ?? null
    const fotos = extraerFotosCapturaPendiente(capturaPendiente)
    if (fotos.length === 0) {
      return NextResponse.json({ error: 'Este proyecto todavía no tiene ninguna fotografía cargada.' }, { status: 409 })
    }
    if (!proyecto.hoja_id) {
      return NextResponse.json({ error: 'Este proyecto todavía no tiene una hoja de evaluación generada.' }, { status: 409 })
    }

    // EVAL-1B — fail-closed: sin roster_congelado no existe una
    // identidad determinista de alumno×posición para esta hoja — la
    // MISMA regla ya aplicada en la carga (EVAL-1C) se repite aquí,
    // nunca se confía en que el estado del proyecto por sí solo
    // implique que la hoja tiene roster congelado.
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
    const rosterCongelado = hoja.roster_congelado as Array<{ posicion: number }> | null
    if (!rosterCongelado || rosterCongelado.length === 0) {
      // Nunca se sustituye por el roster vivo — una hoja sin roster
      // congelado (ej. SG-VXKR, histórica, anterior a EVAL-1B) queda
      // fuera del flujo automático, sin excepción.
      return NextResponse.json({ error: 'Esta hoja fue generada antes de que existiera el registro de alumnos congelado y no admite análisis automático.' }, { status: 409 })
    }

    // EVAL-1D.2 — el número de páginas ESPERADO se deriva, sin ninguna
    // llamada IA, de la MISMA aritmética que usó el renderizador real
    // del PDF para paginar este roster exacto
    // (lib/documentGen/generarHojaSeguimientoPdf.ts). Fail-closed: si
    // el número de fotografías ya cargadas no coincide EXACTAMENTE con
    // ese total, el análisis se rechaza aquí — ANTES de descargar,
    // normalizar o gastar ninguna llamada de visión — nunca se
    // aproxima el resultado con las páginas que sí están presentes.
    const paginasEsperadas = calcularCantidadPaginasHoja(rosterCongelado.length)
    if (fotos.length !== paginasEsperadas) {
      return NextResponse.json(
        {
          error:
            fotos.length < paginasEsperadas
              ? `Esta hoja tiene ${paginasEsperadas} páginas y solo se cargó${fotos.length === 1 ? '' : 'n'} ${fotos.length}. Sube todas las páginas antes de analizar.`
              : `Se cargaron más fotografías (${fotos.length}) de las que corresponden a esta hoja (${paginasEsperadas}).`,
        },
        { status: 409 }
      )
    }

    // fotos ya viene ordenado por página ascendente
    // (extraerFotosCapturaPendiente) — se preserva ese orden en todo
    // el resto del flujo, hasta el arreglo final de bloques de imagen
    // que se le entrega al modelo.
    let buffers: { buffer: Buffer; extension: string }[]
    try {
      buffers = await Promise.all(
        fotos.map(async (foto) => ({
          buffer: await descargarBuffer(supabase, foto.storagePath, BUCKET_HOJAS_SEGUIMIENTO),
          extension: foto.storagePath.split('.').pop()?.toLowerCase() || '',
        }))
      )
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'No se pudo leer una de las fotografías.' }, { status: 500 })
    }

    // EVAL-1D.1/EVAL-1D.2 — normaliza el formato de CADA página ANTES
    // de la única llamada de visión (la conversión NUNCA cuenta como
    // llamada IA): JPG/PNG/WEBP pasan tal cual; HEIC/HEIF se decodifica
    // y recodifica a JPEG en memoria, una sola vez por foto — nunca se
    // sube a Storage, nunca se tocan las rutas originales. Fail-closed
    // por lote completo: si CUALQUIER página falla al normalizarse, el
    // flujo se detiene aquí, ANTES de cualquier llamada a Anthropic —
    // nunca se analiza un subconjunto de páginas.
    let imagenesNormalizadas
    try {
      imagenesNormalizadas = await normalizarImagenesHojaParaVision(buffers)
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'No se pudo preparar una de las fotografías para el análisis.' }, { status: 409 })
    }

    let resultado
    try {
      // EL MODELO NUNCA RECIBE hoja.identificador_visible — analizar-
      // Imagenes/ConstruirInstrucciones no toma ese valor como
      // parámetro en ningún punto de esta llamada; el modelo solo
      // transcribe lo que observa (ver comentario de cabecera de
      // ResultadoAnalisisHojaEvaluacion en analisisHojaEvaluacion.ts).
      // La comparación ocurre EXCLUSIVAMENTE abajo, server-side.
      resultado = await analizarImagenesHojaEvaluacion(
        anthropic,
        imagenesNormalizadas,
        rosterCongelado.length
      )
    } catch (e) {
      // Fail-closed: ningún error de extracción toca captura_pendiente
      // ni el estado del proyecto — la fotografía y el estado previo
      // quedan intactos para un reintento.
      return NextResponse.json({ error: e instanceof Error ? e.message : 'No se pudo analizar la fotografía.' }, { status: 422 })
    }

    // Gate de identidad — ANTES de persistir cualquier fila y ANTES de
    // que exista la más mínima posibilidad de que
    // fila.posicion -> rosterCongelado.posicion -> alumno se ejecute
    // (esa asociación solo vive en construirMatrizRevision/
    // prepararResultadosConfirmacion, lib/seguimiento/
    // confirmarResultadosHoja.ts, que NUNCA se llaman con un
    // extraidoBruto que no haya pasado por aquí primero — ver
    // revisar-hoja/route.ts y confirmar-hoja/route.ts, ambos leen
    // captura_pendiente.extraidoBruto YA persistido, nunca antes).
    //
    // captura_pendiente.extraidoBruto significa EXCLUSIVAMENTE
    // "extracción de una fotografía cuya identidad ya fue validada" —
    // un rechazo NUNCA lo escribe, ni siquiera vacío (eso falsearía
    // esa semántica de cara a consumidores futuros de historial
    // individual/grupal). La señal de rechazo vive en su propio campo,
    // validacionIdentidad, que determinarEstadoCapturaHoja ya sabe
    // distinguir de "todavía no se analizó nada" (estado
    // 'identidad_no_valida', nunca 'lista_para_analizar') sin
    // necesidad de tocar Storage ni captura_pendiente.fotos: en cuanto
    // el docente sube una fotografía nueva, foto-hoja/route.ts
    // reemplaza captura_pendiente por completo y esta señal
    // desaparece sola.
    if (!identidadHojaValida(resultado.identificadorVisibleObservado, hoja.identificador_visible)) {
      const { error: errorRechazo } = await supabase
        .from('proyectos_seguimiento')
        .update({
          captura_pendiente: {
            ...capturaPendiente,
            validacionIdentidad: { estado: 'rechazada', razon: 'identidad_no_valida', validadaEn: new Date().toISOString() },
          },
          actualizado_en: new Date().toISOString(),
        })
        .eq('id', proyectoId)
      if (errorRechazo) {
        return NextResponse.json({ error: 'No se pudo registrar el resultado del análisis. Intenta de nuevo.' }, { status: 500 })
      }
      return NextResponse.json({ error: MENSAJE_IDENTIDAD_NO_VALIDA, razon: 'identidad_no_valida' }, { status: 409 })
    }

    const { error: errorUpdate } = await supabase
      .from('proyectos_seguimiento')
      .update({
        captura_pendiente: {
          ...capturaPendiente,
          // Limpia explícitamente cualquier rechazo previo (defensivo:
          // en el flujo normal ya desaparece al subir una foto nueva,
          // pero esta escritura nunca debe dejar extraidoBruto e
          // validacionIdentidad='rechazada' coexistiendo).
          validacionIdentidad: null,
          extraidoBruto: resultado.extraccion,
          extraidoEn: new Date().toISOString(),
        },
        estado: 'requiere_revision',
        actualizado_en: new Date().toISOString(),
      })
      .eq('id', proyectoId)
    if (errorUpdate) {
      return NextResponse.json({ error: 'El análisis se completó pero no se pudo registrar. Intenta de nuevo.' }, { status: 500 })
    }

    return NextResponse.json({ ok: true, estado: 'requiere_revision', filas: resultado.extraccion.filas.length })
  } catch (err) {
    console.error(`Error en POST /api/proyectos-seguimiento/${proyectoId}/analizar-hoja:`, err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error inesperado.' }, { status: 500 })
  }
}
