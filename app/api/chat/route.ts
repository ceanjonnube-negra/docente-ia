import { NextRequest, NextResponse } from 'next/server'
import { gzipSync } from 'node:zlib'
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'
import { clasificarNivel0 } from '@/lib/clasificadorNivel0'
import type { ReferenteContextualMetadata } from '@/lib/asistente/contextoConversacional'
import { validarDecisionOrquestador, esCandidataAShortCircuitCliente, HEADER_DECISION_ORQUESTADOR, HEADER_DECISION_ORQUESTADOR_MODO, type DecisionOrquestador } from '@/lib/asistente/decisionOrquestador'
import { obtenerSesionContexto } from '@/lib/sesionContexto'
import { autenticarRequestApi } from '@/lib/server/authApi'
import {
  actualizarPerfilDocente,
  calendarioCicloCompleto,
  categoriaEventoCalendario,
  construirTextoListaAlumnos,
  contextoAlumno,
  escribirAsistencia,
  registrarAsistenciaMasiva,
  registrarIncidencia,
  ejecutarRegistroEscolar,
} from '@/lib/motorContexto'
import { ejecutarHerramientaDeModulo } from '@/lib/asistente/herramientasModulo'
import { obtenerFechaHora, calcularDiasSemanaDeFechasExplicitas } from '@/lib/tiempo/TimeService'
import { MARCO_CURRICULAR_VIGENTE } from '@/lib/asistente/marcoCurricular'
import { INSTRUCCIONES_PLANEACION_GENERAR } from '@/lib/asistente/instruccionesPlaneacionGenerar'
import { prepararContextoGeneracionPlaneacion } from '@/lib/planeacion/generarBorrador'
import { aprobarBorradorPlaneacion } from '@/lib/planeacion/aprobarBorrador'
import { extraerResumenBorrador, extraerTextoCompletoBorrador } from '@/lib/planeacion/extraerBorrador'
import { construirHerramientaConsultaOficial } from '@/lib/fuentesOficiales'
import { construirHerramientaRegistroEscolar } from '@/lib/registroEscolarTool'
import { detectarHerramientaDocumento, detectarFormatosExplicitosMultiples, esDocumentoFormal, pareceNuevoDocumento, quiereIlustracion, type TipoHerramienta } from '@/lib/asistente/documentos'
import type { AccionNavegacion, TrazaDiagnosticoCurp, LlamadaIA } from '@/lib/asistente/tipos'
import { ejecutarHerramientaDocumento, generarImagenesParaDocumento, ErrorHerramientaDocumento, HerramientaNoDisponibleError, ETIQUETA_MODULO, MAX_IMAGENES_POR_DOCUMENTO } from '@/lib/documentGen/herramientas'
import { clasificarTipoDocumento, extraerTextoDocumento } from '@/lib/documentGen/extraerTextoDocumento'
import { nombreArchivoWordServidor } from '@/lib/documentGen/generarWordServidor'
import { extraerTitulo, analizarContenido, extraerDescripcionesDeImagen } from '@/lib/documentGen/parseContenido'
import { resolverNivelEducativo } from '@/lib/documentGen/nivelEducativo'
import { obtenerPerfilNivel } from '@/lib/documentGen/perfilNivelEducativo'
import { subirBuffer, rutaArchivo, eliminarArchivo, BUCKET_IMAGENES_GENERADAS } from '@/lib/documentGen/almacenamiento'
import { guardarAssetVisual } from '@/lib/assetsVisuales'

// Límite explícito de duración de la función — sin esto, Vercel aplica
// el límite implícito del plan/proyecto, que puede ser más corto que
// el nuevo TIMEOUT_ANTHROPIC_MS (120s) más el resto del trabajo de la
// petición (clasificador, lecturas de Supabase, construcción de los
// descriptores). 180s da margen real por encima de eso sin acercarse
// al límite máximo del runtime Node.js de Vercel (ver "corrección —
// Error al conectar con la IA después de mostrar parte de la
// planeación").
export const maxDuration = 180

const supabaseRAG = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)
const openaiRAG = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

async function buscarContextoRAG(pregunta: string, institucionId: string | null): Promise<string> {
  try {
    // Sin timeout explícito, esta llamada podía quedarse esperando
    // indefinidamente (ver TIMEOUT_NIVEL0_MS en lib/clasificadorNivel0.ts
    // — mismo problema, otro proveedor) — buscarContextoRAG se dispara
    // para CUALQUIER mensaje, no solo los que pasan por el Clasificador
    // de Nivel 0, así que este límite protege la ruta completa de chat.
    const embeddingResponse = await openaiRAG.embeddings.create(
      {
        model: 'text-embedding-3-small',
        input: pregunta,
      },
      { timeout: TIMEOUT_RAG_MS }
    )
    const queryEmbedding = embeddingResponse.data[0].embedding

    const { data, error } = await supabaseRAG.rpc('buscar_chunks_similares', {
      query_embedding: queryEmbedding,
      cantidad: 4,
      p_institucion_id: institucionId,
    })

    if (error || !data || data.length === 0) return ''

    const fragmentos = data
      .map((d: any) => `Documento (categoria: ${d.categoria || "General"}): ${d.nombre_archivo}\n${d.chunk_texto}`)
      .join('\n\n---\n\n')

    return `\n\nINFORMACION DE DOCUMENTOS INSTITUCIONALES DISPONIBLES (posible Fuente 2 o 3, ver PRIORIZACION DE FUENTES):\n${fragmentos}\n\nSi la categoria del documento es SEP, es informacion oficial de la SEP subida a este sistema. Para cualquier otra categoria (Reglamentos, Normatividad, Acuerdos, Protocolos, Planeacion, Consejos Tecnicos, Formatos Oficiales, Personalizadas, etc) es un documento interno de la escuela — NUNCA la atribuyas a la SEP, di que proviene del reglamento/documento interno correspondiente por su nombre real.`
  } catch (e) {
    console.error('Error buscando contexto RAG:', e)
    return ''
  }
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ARQUITECTURA — REGLA OBLIGATORIA: si existe una herramienta capaz de
// responder la intención del maestro, el modelo NUNCA responde
// directamente sin haberla consultado primero. El Clasificador de
// Nivel 0 (ver lib/clasificadorNivel0.ts) es lo único que decide eso,
// así que se llama SIEMPRE que hay sesión real — nunca detrás de un
// filtro de palabras clave.
//
// Antes existía aquí un filtro local (REQUIERE_CLASIFICADOR_NIVEL0,
// una regex) que decidía si valía la pena la llamada extra a Claude
// antes de gastarla — pura optimización de latencia. Se retiró por
// completo, no se amplió una vez más: es estructuralmente imposible
// que una lista de palabras clave cubra cada forma real en que un
// maestro pregunta algo en español ("¿quién faltó?" vs "¿quién está
// ausente?" vs cualquier otra frase no anticipada) — cada vez que el
// mensaje no matcheaba, clasificarNivel0() JAMÁS se llamaba y el
// mensaje caía directo al modelo grande sin ningún dato real, que
// entonces respondía (con razón, dado lo que recibía) que no tenía
// acceso. Esto ya causó dos rondas de "parchar la regex" con el mismo
// bug reapareciendo con una frase distinta cada vez — la causa raíz
// real era la existencia misma del filtro, no las palabras que le
// faltaban.
//
// Por qué es seguro llamarlo siempre: es una llamada compacta
// (max_tokens: 500, JSON de clasificación, no generación de
// contenido), con timeout propio (TIMEOUT_NIVEL0_MS) y ya envuelta en
// try/catch — si falla o tarda, cae exactamente al mismo flujo normal
// de conversación que ya existía, nunca a un error nuevo. El costo real
// es un poco más de latencia en mensajes que de todos modos van a
// "conversacion_general" (un cuento, un saludo) — se acepta ese costo
// a cambio de la garantía estructural de que ninguna consulta real a
// un módulo se pierda jamás por una palabra que no estaba en una
// lista.

// LISTA DE ALUMNOS — detección 100% determinista (expresión regular),
// nunca un juicio de la IA: los nombres de los alumnos son un dato
// oficial y jamás deben pasar por Claude para ser redactados (ver
// construirTextoListaAlumnos en lib/motorContexto.ts). "de alumnos"/
// "del grupo" son obligatorios para no confundirse con "pasar lista"
// (tomar asistencia, ver el Clasificador de Nivel 0 más abajo) cuando
// el mensaje no pide ningún archivo. Cuando SÍ se pidió un formato
// real (tipoHerramientaSolicitado ya resuelto, ver más abajo) no hace
// falta esa precisión — "pasar lista" nunca coincide con un formato de
// archivo, así que ahí basta con "lista"/"listado"/"padrón" a secas.
const SOLICITA_LISTA_ALUMNOS = /\b(lista(do)?|padr[oó]n)\s+(de\s+)?(mis\s+|los\s+)?alumnos\b|\blista(do)?\s+del\s+grupo\b/i

// Envuelve un texto ya resuelto (sin pasar por el modelo grande) en el
// mismo formato de streaming de texto plano que el cliente ya espera,
// para no tener que tocar app/dashboard/chat/page.tsx.
function respuestaTexto(texto: string): Response {
  const encoder = new TextEncoder()
  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(texto))
      controller.close()
    },
  })
  return new Response(readable, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}

// Postprocesado determinístico del día de la semana (ver "postprocesado
// determinístico del día de la semana para consultas factuales con año
// explícito") — solo se invoca cuando anioDiaSemanaAutorizado existe
// (ver más abajo en el POST). normalizarDiaSemana compara tolerando
// mayúsculas/acentos, mismo criterio que normalizar() en documentos.ts.
function normalizarDiaSemana(dia: string): string {
  return dia.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}
const PATRON_DIA_SEMANA_TEXTO = 'lunes|martes|mi[ée]rcoles|jueves|viernes|s[áa]bado|domingo'
const REGEX_DIA_SEMANA_ANTES_FECHA = new RegExp(`(${PATRON_DIA_SEMANA_TEXTO})\\s*,?\\s*$`, 'i')
const REGEX_DIA_SEMANA_DESPUES_FECHA = new RegExp(`^\\s*,?\\s*(?:que\\s+)?(?:cae\\s+en\\s+|ser[áa]\\s+|es\\s+)?(${PATRON_DIA_SEMANA_TEXTO})\\b`, 'i')
// Ancla de detección únicamente (nunca de cálculo — TimeService sigue
// siendo la única autoridad del calendario) para el FALLBACK DÍA+MES
// (ver "fallback conservador día+mes para consultas factuales con año
// explícito"): reconoce "16 de septiembre" cuando Claude separa el año
// del resto de la fecha al redactar ("...cae en martes en 2026"), pero
// el lookahead negativo excluye deliberadamente cualquier aparición
// seguida de inmediato por "de AAAA" — esa ya es una fecha completa de
// OTRO año (ej. "23 de noviembre de 1825") y nunca debe tratarse como
// candidata parcial de 2026.
const PATRON_MES_TEXTO = 'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre'
const REGEX_DIA_MES_PARCIAL = new RegExp(`\\b(\\d{1,2})\\s+de\\s+(${PATRON_MES_TEXTO})\\b(?!\\s+de\\s+\\d{4})`, 'gi')
// Mismo propósito que el lookahead de arriba, pero aplicado en el
// momento de CORREGIR: `fechaTexto` de una candidata parcial (ej. "23
// de noviembre") es una subcadena literal que también puede aparecer
// DENTRO de una fecha histórica completa (ej. "23 de noviembre de
// 1825") — la búsqueda por indexOf() de aplicarCorreccionDiaSemana no
// distingue eso por sí sola, así que este regex se usa para saltar esa
// aparición sin tocarla.
const REGEX_ANIO_INMEDIATO_DESPUES = /^\s+de\s+\d{4}\b/

// Corrige (o completa, si falta) el día de la semana asociado a UNA
// fecha específica dentro del texto — nunca toca un día de la semana
// que pertenezca a otra fecha (ventanas cortas e inmediatamente
// adyacentes a cada aparición literal de `fechaTexto`, ver "asociación
// segura"). Si no hay ningún día de semana asociado a esa aparición,
// agrega el dato mínimo determinístico ("...fecha, que cae en X") —
// nunca inventa ni cambia nada más del texto. `evitarSiAnioInmediatoDespues`
// (solo lo usa el FALLBACK DÍA+MES) salta cualquier aparición de
// `fechaTexto` que en realidad sea parte de una fecha completa de otro
// año — ver REGEX_ANIO_INMEDIATO_DESPUES arriba.
function aplicarCorreccionDiaSemana(texto: string, fechaTexto: string, diaCorrecto: string, evitarSiAnioInmediatoDespues = false): { texto: string; corregido: boolean } {
  const VENTANA_ANTES = 15
  const VENTANA_DESPUES = 40
  let salida = ''
  let cursor = 0
  let corregido = false
  while (true) {
    const idx = texto.indexOf(fechaTexto, cursor)
    if (idx === -1) { salida += texto.slice(cursor); break }
    const finFechaCandidata = idx + fechaTexto.length
    if (evitarSiAnioInmediatoDespues && REGEX_ANIO_INMEDIATO_DESPUES.test(texto.slice(finFechaCandidata, finFechaCandidata + 10))) {
      salida += texto.slice(cursor, finFechaCandidata)
      cursor = finFechaCandidata
      continue
    }
    const inicioVentanaAntes = Math.max(cursor, idx - VENTANA_ANTES)
    const ventanaAntes = texto.slice(inicioVentanaAntes, idx)
    const finFecha = idx + fechaTexto.length
    const ventanaDespues = texto.slice(finFecha, finFecha + VENTANA_DESPUES)
    const matchAntes = ventanaAntes.match(REGEX_DIA_SEMANA_ANTES_FECHA)
    const matchDespues = !matchAntes ? ventanaDespues.match(REGEX_DIA_SEMANA_DESPUES_FECHA) : null

    if (matchAntes) {
      const diaEscrito = matchAntes[1]
      const inicioMatchAbsoluto = inicioVentanaAntes + matchAntes.index!
      salida += texto.slice(cursor, inicioMatchAbsoluto)
      if (normalizarDiaSemana(diaEscrito) !== normalizarDiaSemana(diaCorrecto)) { salida += diaCorrecto; corregido = true }
      else { salida += diaEscrito }
      salida += texto.slice(inicioMatchAbsoluto + diaEscrito.length, idx)
      salida += fechaTexto
      cursor = finFecha
    } else if (matchDespues) {
      const diaEscrito = matchDespues[1]
      const inicioMatchAbsoluto = finFecha + matchDespues.index! + matchDespues[0].lastIndexOf(diaEscrito)
      salida += texto.slice(cursor, idx)
      salida += fechaTexto
      salida += texto.slice(finFecha, inicioMatchAbsoluto)
      if (normalizarDiaSemana(diaEscrito) !== normalizarDiaSemana(diaCorrecto)) { salida += diaCorrecto; corregido = true }
      else { salida += diaEscrito }
      cursor = inicioMatchAbsoluto + diaEscrito.length
    } else {
      // Sin día de semana asociado a esta aparición de la fecha (ver
      // "caso 9: Claude omite el día") — se agrega el dato mínimo.
      salida += texto.slice(cursor, idx)
      salida += fechaTexto
      salida += `, que cae en ${diaCorrecto}`
      corregido = true
      cursor = finFecha
    }
  }
  return { texto: salida, corregido }
}

// El maestro nunca debe ver detalle técnico (HTTP, JSON, mensajes crudos
// de la API de Anthropic/OpenAI, stack traces) — ver ARQUITECTURA
// MAESTRA, principio de ERRORES. El detalle real siempre se registra con
// console.error para diagnóstico; esto es lo único que llega al chat.
const MENSAJE_ERROR_GENERICO = 'No fue posible completar la solicitud en este momento. Intenta de nuevo en unos segundos.'
const MENSAJE_ERROR_DOCUMENTO = 'No fue posible generar el documento en este momento. Toca para intentar de nuevo.'

// Tiempo máximo que se espera la respuesta de Anthropic antes de darla
// por colgada — sin esto, una llamada que nunca resuelve (no rechaza, no
// responde) deja al maestro viendo "Generando..." indefinidamente, sin
// que ningún catch se dispare nunca.
//
// CORRECCIÓN ("Error al conectar con la IA" después de mostrar parte de
// la planeación) — causa real confirmada por código: a diferencia de lo
// que decía este comentario antes, el `timeout` del SDK de Anthropic NO
// es "tiempo al primer byte" — cubre la petición HTTP completa,
// streaming incluido, exactamente el mismo problema que ya se había
// diagnosticado y corregido abajo para TIMEOUT_ANTHROPIC_DOCUMENTO_MS
// (stream:false). planeacion_generar es la primera intención de la app
// que produce respuestas realmente largas en streaming (una secuencia
// didáctica completa de hasta 10 días, cerca del límite de max_tokens)
// — con 25s, el SDK abortaba la conexión A MITAD del streaming en
// cuanto la respuesta era larga de verdad, cortando el texto ya
// transmitido sin ningún error de la aplicación que registrar (el
// aborto ocurre dentro de la librería HTTP, no como una excepción de
// negocio). 120s da margen real para los mismos ~8000 tokens de
// max_tokens que ya usa el resto de la app, sin penalizar respuestas
// cortas (un timeout más alto nunca alarga una respuesta que ya
// terminó antes).
const TIMEOUT_ANTHROPIC_MS = 120_000
// CASO 3 de FINALIZAR ARCHIVO (más abajo) llama a Claude con
// stream:false — a diferencia del streaming normal, esa llamada no
// devuelve NADA hasta que termina de redactar el documento COMPLETO
// (hasta 8000 tokens: una planeación de varios días, un examen largo).
// Usar el mismo límite de "tiempo al primer byte" (25s) para una
// respuesta que necesita completarse entera antes de responder algo
// era la causa real de "Tardó demasiado en responder" en documentos
// grandes que en realidad iban bien, solo tardados — nunca colgados.
const TIMEOUT_ANTHROPIC_DOCUMENTO_MS = 55_000
// Mismo criterio para las dos llamadas externas que corren ANTES de
// llegar siquiera a Claude — la búsqueda RAG (OpenAI) y la sesión de
// contexto (Supabase). Ninguna de las dos tenía límite: si cualquiera
// se quedaba esperando, /api/chat entero nunca respondía nada, sin
// importar qué tan bien protegida estuviera la llamada principal a
// Claude más abajo.
const TIMEOUT_RAG_MS = 10_000
const TIMEOUT_SESION_MS = 10_000

class ErrorLimiteDeTiempo extends Error {}

async function conLimiteDeTiempo<T>(promesa: Promise<T>, ms: number, mensaje: string): Promise<T> {
  let temporizador!: ReturnType<typeof setTimeout>
  const limite = new Promise<never>((_, reject) => {
    temporizador = setTimeout(() => reject(new ErrorLimiteDeTiempo(mensaje)), ms)
  })
  try {
    return await Promise.race([promesa, limite])
  } finally {
    clearTimeout(temporizador)
  }
}

// DIAGNÓSTICO DE FALLAS DEL MODELO — clasifica cualquier error real de
// la llamada a Anthropic en una de 5 categorías, para poder decidir
// automáticamente si vale la pena reintentar (ver debeReintentar) y para
// que el registro interno (console.error) diga la causa real en vez de
// un stack trace suelto. Nunca se expone al maestro — ver MENSAJE_ERROR_*.
type CategoriaErrorIA = 'conexion' | 'timeout' | 'creditos' | 'configuracion' | 'proveedor' | 'desconocido'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function clasificarErrorIA(err: any): CategoriaErrorIA {
  // HerramientaNoDisponibleError (imagen/audio/video sin proveedor) es
  // un límite real y permanente — reintentar manda exactamente la
  // misma petición y falla igual, así que jamás debe clasificarse como
  // transitorio.
  if (err instanceof HerramientaNoDisponibleError) return 'configuracion'
  // ErrorHerramientaDocumento (conversión/subida/URL del pipeline de
  // documentos) no tiene forma de error de Anthropic — sin esta rama
  // caía siempre en 'desconocido' (no reintentable) y una falla de
  // Storage momentánea nunca se reintentaba, ni una sola vez. Es el
  // mismo tipo de falla transitoria de infraestructura que 'proveedor'
  // (un segundo o tercer intento después suele funcionar).
  if (err instanceof ErrorHerramientaDocumento) return 'proveedor'

  const nombre = String(err?.name || '')
  const mensaje = String(err?.error?.error?.message || err?.error?.message || err?.message || '')

  // TIMEOUT — se disparó el AbortController de TIMEOUT_ANTHROPIC_MS
  // (ver conReintento) o el propio SDK reporta timeout de conexión.
  if (nombre === 'AbortError' || /timeout|timed out/i.test(nombre) || /timeout|timed out/i.test(mensaje)) {
    return 'timeout'
  }

  const status: number | undefined = err?.status
  const tipo: string | undefined = err?.error?.error?.type || err?.error?.type || err?.type

  // CONEXIÓN — nunca hubo respuesta HTTP real de Anthropic (DNS, TLS,
  // conexión rechazada/reiniciada a medio camino).
  if (status === undefined && /fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN|network/i.test(mensaje)) {
    return 'conexion'
  }

  // CONFIGURACIÓN — API key ausente/inválida/sin permiso. Reintentar NO
  // ayuda: la petición siguiente falla exactamente igual.
  if (status === 401 || tipo === 'authentication_error' || tipo === 'permission_error') {
    return 'configuracion'
  }

  // CRÉDITOS INSUFICIENTES — falla real y actual confirmada en
  // producción (ver diagnóstico). Es un estado de facturación, no un
  // problema técnico — reintentar jamás lo resuelve.
  if (status === 400 && /credit balance|insufficient/i.test(mensaje)) {
    return 'creditos'
  }

  // PROVEEDOR — límite de tasa (429) o falla del lado de Anthropic
  // (5xx/sobrecarga). Genuinamente transitorio: un segundo intento
  // segundos después suele funcionar.
  if (status === 429 || tipo === 'rate_limit_error' || tipo === 'overloaded_error' || (status !== undefined && status >= 500)) {
    return 'proveedor'
  }

  // Cualquier otro 400 (parámetros inválidos, payload mal formado) es un
  // error de CONFIGURACIÓN de la petición misma — reintentar manda
  // exactamente el mismo payload otra vez y falla igual.
  if (status === 400) return 'configuracion'

  return 'desconocido'
}

// Solo estas categorías son genuinamente transitorias — reintentar
// cualquier otra es tiempo perdido (falla garantizada otra vez) y en el
// caso de CRÉDITOS además desperdicia una llamada más contra el saldo.
const CATEGORIAS_REINTENTABLES: ReadonlySet<CategoriaErrorIA> = new Set(['conexion', 'timeout', 'proveedor'])

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function debeReintentar(err: any, categoria: CategoriaErrorIA): boolean {
  // Anthropic mismo manda esta cabecera indicando si reintentar tiene
  // caso — si dice que no, se respeta sin importar la categoría.
  const encabezadoNoReintentar = typeof err?.headers?.get === 'function' && err.headers.get('x-should-retry') === 'false'
  if (encabezadoNoReintentar) return false
  return CATEGORIAS_REINTENTABLES.has(categoria)
}

// Reintenta SOLO cuando la falla es de una categoría transitoria (ver
// clasificarErrorIA/debeReintentar) — nunca contra créditos insuficientes
// ni problemas de configuración, que fallan garantizado otra vez y en el
// caso de créditos desperdician una llamada más. `etiqueta` identifica el
// sitio de la llamada en los logs (hay 3: conversación normal, CASO 3 de
// documento combinado, generación/subida del archivo).
async function conReintento<T>(fn: () => Promise<T>, etiqueta: string): Promise<T> {
  try {
    return await fn()
  } catch (primerError) {
    const categoria = clasificarErrorIA(primerError)
    console.error(`[IA:${etiqueta}] Falla (categoría=${categoria}):`, primerError)
    if (!debeReintentar(primerError, categoria)) throw primerError
    console.error(`[IA:${etiqueta}] Categoría transitoria (${categoria}) — reintentando una vez...`)
    try {
      return await fn()
    } catch (segundoError) {
      const categoria2 = clasificarErrorIA(segundoError)
      console.error(`[IA:${etiqueta}] Reintento también falló (categoría=${categoria2}):`, segundoError)
      throw segundoError
    }
  }
}

export async function POST(req: NextRequest) {
  // Telemetría segura del ciclo de vida de la petición ("Error al
  // conectar con la IA" después de mostrar parte de la planeación) —
  // solo indicadores booleanos/duraciones/nombres de error, nunca
  // tokens, cookies, contenido de documentos ni datos de alumnos (ver
  // diagnóstico). inicioRequestMs vive en este scope y lo captura el
  // closure del ReadableStream de más abajo.
  const inicioRequestMs = Date.now()
  console.log('[STREAM][chat] chatRequestIniciado=true')
  const { mensaje, historial, contexto, institucionId, imagenBase64, imagenTipo, nombreArchivo, imagenesBase64, userId: userIdCliente, accessToken, zonaHoraria, finalizarArchivo, esEdicionDocumento, channel, turnId, voiceDebug, regenerarImagen, debugRequestId, referentesContextuales: referentesContextualesCliente, conversacionId, mensajeUsuarioId } = await req.json()
  // VINCULACIÓN DE ASSETS VISUALES A SU CONVERSACIÓN (V1-C) — metadata
  // estructural top-level, NUNCA transportada dentro de `contexto`
  // (ese sigue siendo el string de construirInstrucciones, nunca un
  // objeto — de ahí que contexto?.conversacionId SIEMPRE fuera
  // undefined). Solo se normaliza la FORMA aquí; la propiedad —que
  // esta conversación sea realmente del docente autenticado— se
  // resuelve más abajo, y solo cuando de verdad hace falta (ver
  // obtenerConversacionIdAutorizada).
  const conversacionIdSolicitada = typeof conversacionId === 'string' && conversacionId.trim() ? conversacionId.trim() : null
  // PERSISTENCIA DURABLE DE ADJUNTOS VISUALES (V2) — mismo criterio
  // exacto que conversacionIdSolicitada: metadata estructural top-level,
  // nunca dentro de `contexto`/prompt/historial/referentes. Solo se
  // normaliza la FORMA aquí — el cliente ya garantiza que este id solo
  // viaja cuando el mensaje con foto quedó persistido remotamente (ver
  // AsistenteService.persistirMensajeRemotoConfirmado), pero el
  // servidor nunca confía en eso a ciegas: la pertenencia real de este
  // mensaje se demuestra más abajo con supabaseUser + RLS antes de
  // usarlo para nada (ver bloque V2 después de obtenerConversacionIdAutorizada).
  const mensajeUsuarioIdSolicitado = typeof mensajeUsuarioId === 'string' && mensajeUsuarioId.trim() ? mensajeUsuarioId.trim() : null
  // FASE 2A (ver "contrato del router semántico unificado + transporte
  // de referentes contextuales") — SEGURIDAD (ver "auditoría 11"): el
  // cliente puede mandar CUALQUIER COSA en este campo, así que nunca
  // se confía ciegamente — se valida forma completa (id/tipo/origen
  // dentro de los enums reales) antes de dejarlo llegar al prompt de
  // Nivel0; cualquier entrada malformada se descarta en silencio, sin
  // tronar el request. Esto NUNCA es una superficie de permisos: solo
  // decide qué metadata de CONTENIDO CONVERSACIONAL ve el clasificador,
  // nunca autoriza ninguna operación sobre datos de alumnos/institución.
  const TIPOS_REFERENTE_VALIDOS = new Set(['texto', 'documento', 'imagen', 'lista_filtrada'])
  const ORIGENES_REFERENTE_VALIDOS = new Set(['mensaje', 'documento_activo', 'material_visual_activo'])
  const referentesContextuales: ReferenteContextualMetadata[] = Array.isArray(referentesContextualesCliente)
    ? referentesContextualesCliente.filter(
        (r): r is ReferenteContextualMetadata =>
          !!r &&
          typeof r.id === 'string' &&
          r.id.length > 0 &&
          TIPOS_REFERENTE_VALIDOS.has(r.tipo) &&
          ORIGENES_REFERENTE_VALIDOS.has(r.origen) &&
          (r.formato === undefined || typeof r.formato === 'string')
      )
    : []

  // INSTRUMENTACIÓN DIAGNÓSTICA TEMPORAL — ROUNDTRIP (ver "diagnóstico
  // roundtrip de comparación de CURP sin depender de vercel logs") — YA
  // NO depende de vercel logs: la traza viaja de vuelta al cliente
  // dentro de la propia respuesta HTTP, como un marcador técnico
  // invisible (mismo mecanismo exacto que [[CORRECCION_ALUMNO:...]] /
  // [[DOCUMENTO_ARCHIVO:...]] / [[NAVEGACION:...]], ver
  // motorTextoClaude.ts) — el cliente lo extrae y lo quita ANTES de
  // mostrar/guardar el mensaje, así nunca contamina Supabase ni el
  // historial que se le manda al modelo en turnos posteriores. Solo
  // corre cuando el cliente manda debugRequestId (opt-in por request,
  // nunca automático) Y estamos fuera de Production (doble compuerta —
  // este gate del servidor SÍ es confiable, VERCEL_ENV nunca se sustituye
  // en build time como sí le pasaba al gate roto del cliente). SOLO
  // indicadores técnicos — NUNCA el texto del mensaje, el nombre del
  // alumno, la CURP ni el roster. Retirar este bloque completo (y el
  // parámetro debugRequestId) cuando termine el diagnóstico.
  const diagnosticoCurpActivo = !!debugRequestId && process.env.VERCEL_ENV !== 'production'
  const trazaDebug: TrazaDiagnosticoCurp = {
    debugRequestId: debugRequestId || '',
    resultado: 'ok',
    etapa: 'mensaje recibido',
    mensajeLongitud: typeof mensaje === 'string' ? mensaje.length : null,
    intencionPrincipal: null,
    accionCorreccionAlumno: null,
    modoOperacionAlumno: null,
    alumnoDetectado: null,
    campo: null,
    valorPropuestoPresente: null,
    valorLongitud: null,
    datosFaltantes: null,
    herramientaEjecutada: null,
    documentoPresente: null,
    tamanoPayloadVisual: null,
    imagenSeleccionada: null,
    imagenPreparada: null,
    imagenEnAsistente: null,
    imagenEnMotor: null,
    imagenEnFetch: null,
    imagenRecibidaServidor: null,
    imagenEntregadaVision: null,
    statusHttp: null,
    tipoError: null,
    // --- TIEMPOS/CONSUMO — ver "instrumentación temporal de tiempos y
    // consumo". inicioRequestMs (ya existía arriba) es la referencia
    // para todas las duraciones relativas de este bloque.
    msClienteAntesFetch: null, // lo llena el cliente, nunca el servidor
    msFetchHastaRespuesta: null, // ídem
    msTotalCliente: null, // ídem
    clasificacionEjecutada: false,
    msClasificacion: null,
    consultaDatosEjecutada: false,
    msConsultaDatos: null, // requeriría tocar herramientasModulo.ts para separarlo de msHerramienta — fuera del alcance autorizado esta ronda, ver informe
    msHerramienta: null,
    msAntesNivel4: null,
    nivel4Ejecutado: false,
    msTotalServidor: null,
    llamadasIA: [],
    numeroLlamadasIA: 0,
    numeroLlamadasAnthropic: 0,
    numeroLlamadasOpenAI: 0,
    clienteAbortado: null, // lo llena el cliente cuando de verdad ocurre
    servidorRecibioRequest: true, // si este objeto existe, el servidor ya recibió el request
    servidorInicioProveedor: null,
    servidorTerminoProveedor: null,
    respuestaServidorTerminada: null,
  }
  // Ver "no inventar valores": agrega una LlamadaIA real a la traza y
  // mantiene sincronizados los contadores — única función que escribe
  // en trazaDebug.llamadasIA, para no duplicar la lógica de conteo.
  function registrarLlamadaIA(llamada: LlamadaIA) {
    trazaDebug.llamadasIA.push(llamada)
    trazaDebug.numeroLlamadasIA = trazaDebug.llamadasIA.length
    trazaDebug.numeroLlamadasAnthropic = trazaDebug.llamadasIA.filter((l) => l.proveedor === 'anthropic').length
    trazaDebug.numeroLlamadasOpenAI = trazaDebug.llamadasIA.filter((l) => l.proveedor === 'openai').length
    trazaDebug.servidorInicioProveedor = true
  }
  // Marcador técnico — mismo patrón exacto que los otros 3 marcadores ya
  // existentes en este archivo (ver [[DOCUMENTO_ARCHIVO:...]] más abajo).
  function marcadorDiagnostico(): string {
    trazaDebug.msTotalServidor = Date.now() - inicioRequestMs
    trazaDebug.servidorTerminoProveedor = trazaDebug.llamadasIA.every((l) => l.ms !== null)
    trazaDebug.respuestaServidorTerminada = true
    return `\n\n[[DIAGNOSTICO_CURP:${Buffer.from(JSON.stringify(trazaDebug), 'utf-8').toString('base64')}]]`
  }
  function conDiagnostico(texto: string): string {
    return diagnosticoCurpActivo ? `${texto}${marcadorDiagnostico()}` : texto
  }

  // TELEMETRÍA TEMPORAL de latencia del modo voz (ver "Medir con
  // precisión el pipeline de voz antes de optimizar" — no cambia
  // NINGÚN comportamiento, solo mide). Bandera de diagnóstico explícita
  // (voiceDebug, la misma que ya usa ?voiceDebug=1 en el cliente):
  // apagada en uso normal, nunca corre este console.log de más. Nunca
  // registra API keys, tokens, ni contenido de mensajes/documentos —
  // solo nombres de etapa y milisegundos.
  const telemetriaVozActiva = channel === 'voice' && voiceDebug === true
  const marcasServidor: Record<string, number> = {}
  function marcarTelemetria(etapa: string) {
    if (!telemetriaVozActiva) return
    const ahora = Date.now()
    const previas = Object.values(marcasServidor)
    const anterior = previas.length > 0 ? Math.max(...previas) : null
    marcasServidor[etapa] = ahora
    console.log(`[VOZ-TELEMETRIA][${turnId || 'sin-turnId'}] ${etapa} · +${anterior !== null ? ahora - anterior : 0}ms`)
  }
  marcarTelemetria('chat:request_received')

  // [IMAGEN][API] — log temporal de auditoría del pipeline de imágenes
  // (ver "Revisar pipeline completo de imágenes del Chat IA"): confirma
  // que lo que salió del cliente de verdad llegó aquí, con tamaño real
  // en KB para detectar payloads truncados o vacíos silenciosamente.
  if (imagenBase64 || (Array.isArray(imagenesBase64) && imagenesBase64.length > 0)) {
    if (imagenBase64) {
      console.log(`[IMAGEN][API] imagen recibida — tipo=${imagenTipo || 'desconocido'} tamañoBase64=${Math.round((imagenBase64.length * 3) / 4 / 1024)}KB nombreArchivo=${nombreArchivo || '(sin nombre)'}`)
    }
    if (Array.isArray(imagenesBase64) && imagenesBase64.length > 0) {
      console.log(
        `[IMAGEN][API] ${imagenesBase64.length} imágenes recibidas — ${imagenesBase64.map((img: { tipo?: string; base64?: string }, i: number) => `#${i + 1}:${img.tipo || '?'}(${Math.round(((img.base64?.length || 0) * 3) / 4 / 1024)}KB)`).join(', ')}`
      )
    }
  }

  // Varias fotos en un mismo mensaje (ver "Implementar soporte
  // completo para múltiples fotografías") — arreglo de {base64, tipo},
  // siempre imágenes (el cliente solo llena esto desde el flujo de
  // varias fotos, nunca junto con imagenBase64/imagenTipo). Validación
  // mínima de forma: nunca se confía a ciegas en un payload del
  // cliente para construir bloques de contenido hacia Claude.
  // Tope defensivo del lado del servidor (20) independiente del límite
  // que ya aplica el cliente (MAXIMO_IMAGENES_POR_MENSAJE en
  // lib/asistente/comprimirImagen.ts) — nunca se confía únicamente en
  // una validación hecha en el navegador.
  const imagenesValidas: { base64: string; tipo: string }[] = Array.isArray(imagenesBase64)
    ? imagenesBase64
        .filter((img: unknown): img is { base64: string; tipo: string } => {
          if (typeof img !== 'object' || img === null) return false
          const { base64, tipo } = img as Record<string, unknown>
          return typeof base64 === 'string' && typeof tipo === 'string' && tipo.startsWith('image/')
        })
        .slice(0, 20)
    : []

  // Adjunto de documento (Word/Excel/PowerPoint) del menú de adjuntos
  // del Chat IA — RFC-CHAT-ADJUNTOS-003. Claude no puede leer estos
  // formatos directamente (a diferencia de imagen/PDF, que sí se le
  // pasan como bloque nativo más abajo), así que el texto se extrae
  // aquí, ANTES de construir el mensaje para Claude, y se agrega como
  // contexto de texto plano. Si la extracción falla (archivo dañado o
  // protegido), se responde de inmediato con un error claro — nunca se
  // sigue adelante fingiendo que no había adjunto.
  const LIMITE_CARACTERES_DOCUMENTO = 60_000
  const tipoDocumentoAdjunto = clasificarTipoDocumento(imagenTipo)
  let mensajeConDocumento: string = mensaje
  if (tipoDocumentoAdjunto && tipoDocumentoAdjunto !== 'pdf' && imagenBase64) {
    try {
      const buffer = Buffer.from(imagenBase64, 'base64')
      let texto = await extraerTextoDocumento(buffer, tipoDocumentoAdjunto)
      if (!texto.trim()) {
        return NextResponse.json({ error: `No encontré texto legible en "${nombreArchivo || 'el archivo'}". Verifica que no esté vacío o sea solo imágenes escaneadas.` }, { status: 502 })
      }
      let truncado = false
      if (texto.length > LIMITE_CARACTERES_DOCUMENTO) {
        texto = texto.slice(0, LIMITE_CARACTERES_DOCUMENTO)
        truncado = true
      }
      mensajeConDocumento = `${mensaje}\n\n[Contenido del archivo adjunto "${nombreArchivo || 'documento'}"${truncado ? ' — se muestran solo los primeros caracteres, el archivo es más largo' : ''}]\n${texto}`
    } catch (err) {
      console.error('[CHAT:adjunto-documento] Falló la extracción de texto:', err)
      return NextResponse.json({ error: `No pude leer "${nombreArchivo || 'el archivo adjunto'}". Verifica que no esté dañado o protegido con contraseña.` }, { status: 502 })
    }
  }

  // Turnos previos reales de la conversación (ver MotorTextoClaude.
  // establecerHistorial) — sin esto Claude solo ve el mensaje suelto de
  // ahora mismo y "olvida" de qué se habló un turno antes.
  const historialMensajes: { role: 'user' | 'assistant'; content: string }[] = Array.isArray(historial)
    ? historial.filter((h: unknown): h is { role: 'user' | 'assistant'; content: string } =>
        typeof h === 'object' && h !== null &&
        typeof (h as { content?: unknown }).content === 'string' &&
        ((h as { role?: unknown }).role === 'user' || (h as { role?: unknown }).role === 'assistant')
      )
    : []

  // Cliente con la sesión real del docente (necesario para que
  // auth.uid() funcione dentro de las RPC del Motor de Contexto).
  // supabaseRAG (service role) se sigue usando solo para RAG y
  // procesos_activos, sin cambios.
  //
  // Identidad autoritativa resuelta EN EL SERVIDOR contra el propio
  // accessToken (mismo patrón ya sancionado de lib/server/authApi.ts
  // que usan los endpoints nuevos de C-005) — CAUSA RAÍZ real
  // confirmada ("CORRECCIÓN CRÍTICA C-005 — contexto real del
  // docente"): antes, supabaseUser se autenticaba con accessToken pero
  // userId se tomaba tal cual del cuerpo de la petición, resuelto en
  // el cliente con una llamada APARTE a supabase.auth.getUser()
  // (validación de red independiente de session.access_token — ver
  // lib/asistente/perfilDocente.ts). Si esa llamada del cliente fallaba
  // o se demoraba (blip de red, típico justo después de un refresh de
  // token), el cliente mandaba userId=null aunque accessToken siguiera
  // siendo válido, y toda la sesión de contexto (grupo activo,
  // calendario, alumnos) se perdía en el servidor sin ningún error
  // visible — el Chat IA respondía como si no tuviera acceso a nada.
  // Resolver aquí, contra el mismo accessToken que ya se usa para las
  // consultas, elimina esa dependencia innecesaria y evita confiar en
  // un userId no verificado que manda el cliente.
  const autenticacion = accessToken
    ? await conLimiteDeTiempo(autenticarRequestApi(accessToken), TIMEOUT_SESION_MS, 'Tiempo de espera agotado validando la sesión').catch(
        () => ({ ok: false as const, status: 401 as const, mensaje: 'Tiempo de espera agotado validando la sesión' })
      )
    : null
  const supabaseUser = autenticacion?.ok ? autenticacion.supabase : null
  const userId = autenticacion?.ok ? autenticacion.user.id : null

  // OWNERSHIP LAZY de conversacionIdSolicitada (V1-C) — nunca se
  // confía en el UUID tal cual lo manda el cliente: se demuestra
  // contra conversaciones_chat con el cliente AUTENTICADO del docente
  // (RLS conversaciones_chat_select_propio, docente_id = auth.uid()),
  // nunca con supabaseRAG/service_role. Deliberadamente LAZY (nunca
  // eager): conversacionIdSolicitada viaja en prácticamente todos los
  // turnos, incluidos los que jamás generan/editan un asset visual —
  // un SELECT por turno normal sería una consulta desperdiciada en el
  // hot path del chat. Cacheada por request (promesaConversacionAutorizada)
  // para que los sitios que sí lo necesitan (varios pueden coexistir en
  // el mismo request, ej. CASO 3 más abajo) compartan el mismo único
  // SELECT en vez de repetirlo. Fail-closed: id inexistente, de otro
  // docente, o cualquier fallo de la consulta → null — la generación
  // de la imagen puede seguir igual, simplemente sin vincularse a
  // ninguna conversación no demostrada.
  let promesaConversacionAutorizada: Promise<string | null> | null = null
  async function obtenerConversacionIdAutorizada(): Promise<string | null> {
    if (!conversacionIdSolicitada || !supabaseUser) return null
    if (!promesaConversacionAutorizada) {
      promesaConversacionAutorizada = (async () => {
        const { data, error } = await supabaseUser
          .from('conversaciones_chat')
          .select('id')
          .eq('id', conversacionIdSolicitada)
          .maybeSingle()
        return error || !data ? null : (data.id as string)
      })()
    }
    return promesaConversacionAutorizada
  }

  // Indicadores seguros de diagnóstico (nunca tokens, claves ni cookies
  // completas) — permite confirmar en los logs de producción, sin
  // exponer nada sensible, en qué punto se pierde el contexto si vuelve
  // a pasar (ver "DIAGNÓSTICO OBLIGATORIO" en la corrección crítica).
  console.log(
    `[AUTH][chat] accessTokenPresente=${!!accessToken} usuarioPresente=${!!autenticacion?.ok} docenteIdPresente=${!!userId}${userIdCliente && userId && userIdCliente !== userId ? ' userIdClienteNoCoincide=true' : ''}`
  )

  // Sesión rota (el cliente mandó un accessToken, pero el servidor no
  // pudo validarlo — expiró, es inválido, o auth.getUser() nunca
  // devolvió usuario) — ver "CORRECCIÓN CRÍTICA — DOCENTE NO
  // IDENTIFICADO". Nunca dejar que Claude conteste como si conociera
  // al docente ni que vuelva a pedir grado/grupo/calendario: eso ya
  // pasó una vez y fue exactamente el síntoma reportado. Distinto de
  // "sin accessToken en absoluto" (ver más abajo), que sigue
  // funcionando como el asistente general sin sesión (por ejemplo en
  // la página pública antes de iniciar sesión) — aquí el cliente SÍ
  // cree tener sesión y no la tiene, así que el mensaje debe ser
  // explícito, nunca una degradación silenciosa.
  if (accessToken && !autenticacion?.ok) {
    return respuestaTexto('Inicia sesión para cargar tu grupo.')
  }

  // PERSISTENCIA DURABLE DE ADJUNTOS VISUALES (V2 CORE) — cuando el
  // docente adjunta una o varias FOTOS (nunca un PDF/documento para
  // OCR, ver el filtro tipo.startsWith('image/') de abajo), se suben a
  // Storage privado y se registran en assets_visuales, vinculadas a la
  // conversación real — y el mismo mensaje YA persistido en
  // mensajes_chat (ver AsistenteService.persistirMensajeRemotoConfirmado)
  // se actualiza para incluir el assetId real. Esto es persistencia
  // ADICIONAL, nunca una precondición para que Claude vea la imagen:
  // Vision/OCR más abajo sigue usando exactamente los mismos
  // imagenBase64/imagenesBase64 tal como llegaron, sin importar si este
  // bloque tiene éxito, falla parcialmente, o ni siquiera se ejecuta.
  // Envuelto en su propio try/catch — ningún fallo de aquí puede
  // convertirse en "Error al conectar con la IA" para un turno que de
  // otra forma sería válido.
  //
  // GATE (costo cero en turnos sin imagen real): antes de tocar
  // supabaseUser/conversación/mensaje, se exige al menos una imagen
  // image/* real. Ni conversacionIdSolicitada ni mensajeUsuarioIdSolicitado
  // se resuelven contra Supabase todavía en este punto — eso ocurre
  // solo dentro del bloque, y solo si el gate ya pasó.
  const adjuntosV2Candidatos: { index: number; base64: string; tipo: string; nombreArchivo?: string }[] = []
  if (typeof imagenBase64 === 'string' && imagenBase64 && typeof imagenTipo === 'string' && imagenTipo.startsWith('image/')) {
    adjuntosV2Candidatos.push({ index: 0, base64: imagenBase64, tipo: imagenTipo, nombreArchivo: typeof nombreArchivo === 'string' ? nombreArchivo : undefined })
  } else if (Array.isArray(imagenesBase64)) {
    // Índice ORIGINAL preservado a propósito (ver punto 6/11 del diseño
    // aprobado) — un elemento no-imagen simplemente no entra a la
    // lista, pero los que sí entran conservan su posición real dentro
    // de imagenesBase64, para que el UPDATE final nunca desplace un
    // assetId al índice equivocado de contenido.imagenes[].
    imagenesBase64.forEach((img: unknown, index: number) => {
      if (typeof img !== 'object' || img === null) return
      const { base64, tipo } = img as Record<string, unknown>
      if (typeof base64 === 'string' && base64 && typeof tipo === 'string' && tipo.startsWith('image/')) {
        adjuntosV2Candidatos.push({ index, base64, tipo })
      }
    })
  }

  if (adjuntosV2Candidatos.length > 0 && supabaseUser && userId && mensajeUsuarioIdSolicitado) {
    // Capturados en const locales, no reasignables — evita depender de
    // que TypeScript narrowe supabaseUser/userId dentro de funciones
    // anidadas definidas más abajo en este mismo bloque.
    const supabaseUserV2 = supabaseUser
    const userIdV2 = userId
    try {
      const conversacionIdActualV2 = await obtenerConversacionIdAutorizada()
      if (conversacionIdActualV2) {
        // OWNERSHIP DEL MENSAJE EXACTO — nunca se confía en
        // mensajeUsuarioIdSolicitado tal cual (ver diseño aprobado,
        // punto 5): debe existir, pertenecer a ESTA conversación ya
        // autorizada, y ser un mensaje de rol 'usuario'. Cualquier
        // desviación (otra conversación del mismo docente incluida)
        // deja mensajeAutorizadoV2 en null y el bloque completo se
        // omite sin tocar nada.
        const { data: mensajeAutorizadoV2, error: errorMensajeV2 } = await supabaseUserV2
          .from('mensajes_chat')
          .select('id, contenido, conversacion_id, rol')
          .eq('id', mensajeUsuarioIdSolicitado)
          .eq('conversacion_id', conversacionIdActualV2)
          .eq('rol', 'usuario')
          .maybeSingle()

        if (errorMensajeV2 || !mensajeAutorizadoV2) {
          console.log('[V2_ADJUNTO] mensaje_autorizado=false')
        } else {
          // Extensión segura derivada del MIME real — nunca del nombre
          // de archivo que mande el cliente (ver punto 10 del diseño
          // aprobado: un nombre de archivo jamás determina la ruta).
          const extensionDesdeMime = (mime: string): string => {
            const sub = (mime.split('/')[1] || 'jpg').toLowerCase().split('+')[0]
            const limpio = sub.replace(/[^a-z0-9]/g, '')
            return limpio || 'jpg'
          }

          // Storage → assets_visuales, en ese orden estricto, para UNA
          // imagen candidata. Nunca lanza — cualquier fallo se traduce
          // en { assetId: null } para ese índice, sin afectar a las
          // demás (ver punto 14 del diseño aprobado).
          const persistirUnaImagenV2 = async (item: { index: number; base64: string; tipo: string; nombreArchivo?: string }): Promise<{ index: number; assetId: string | null }> => {
            let storagePath: string | null = null
            // Clasificación técnica de la etapa — nunca el error en sí
            // (ver "logs V2 requieren sanitización"): el propio mensaje
            // de un error de Storage/Postgres puede ecoar rutas, valores
            // o metadata de la fila. Solo se registra EN QUÉ ETAPA
            // ocurrió, nunca el detalle.
            let etapaV2: 'decode' | 'storage_upload' | 'asset_insert' = 'decode'
            try {
              const buffer = Buffer.from(item.base64, 'base64')
              const extension = extensionDesdeMime(item.tipo)
              storagePath = rutaArchivo(userIdV2, `adjunto-${item.index}.${extension}`)
              etapaV2 = 'storage_upload'
              await subirBuffer(supabaseRAG, storagePath, buffer, item.tipo, BUCKET_IMAGENES_GENERADAS)
              etapaV2 = 'asset_insert'
              const assetGuardado = await guardarAssetVisual(supabaseUserV2, {
                docenteId: userIdV2,
                conversacionId: conversacionIdActualV2,
                tipo: 'imagen',
                formatoArchivo: extension,
                // Texto veraz y libre, nunca un enum encubierto — jamás
                // se compara este valor en código para inferir origen.
                promptOriginal: item.nombreArchivo || 'Imagen adjunta del docente',
                storagePath,
                tamanoBytes: buffer.length,
                grado: null,
                grupo: null,
                versionAnteriorId: null,
              })
              return { index: item.index, assetId: assetGuardado.id }
            } catch {
              console.error(`[V2_ADJUNTO] fallo_persistencia_imagen index=${item.index} etapa=${etapaV2}`)
              // Si el archivo alcanzó a subirse pero guardarAssetVisual
              // falló después, limpieza best-effort con el helper ya
              // existente — nunca lanza, nunca bloquea el resultado.
              if (storagePath) await eliminarArchivo(supabaseRAG, storagePath, BUCKET_IMAGENES_GENERADAS).catch(() => null)
              return { index: item.index, assetId: null }
            }
          }

          // CONCURRENCIA LIMITADA — lotes de máximo 4, secuenciales
          // entre sí, Promise.allSettled dentro de cada lote (ver punto
          // 10 del diseño aprobado). Una sola imagen usa exactamente
          // esta misma función, en un lote de 1.
          const TAMANO_LOTE_V2 = 4
          const resultadosV2: { index: number; assetId: string | null }[] = []
          for (let i = 0; i < adjuntosV2Candidatos.length; i += TAMANO_LOTE_V2) {
            const lote = adjuntosV2Candidatos.slice(i, i + TAMANO_LOTE_V2)
            const resultadosLote = await Promise.allSettled(lote.map((item) => persistirUnaImagenV2(item)))
            for (const r of resultadosLote) {
              if (r.status === 'fulfilled') resultadosV2.push(r.value)
            }
          }

          const huboExito = resultadosV2.some((r) => r.assetId)
          if (huboExito) {
            // MERGE SEGURO — parte del contenido REAL ya recuperado en
            // el SELECT autorizado de arriba (nunca uno fabricado, ver
            // punto 12 del diseño aprobado). Un índice fallido nunca se
            // toca; base64/tipo/nombreArchivo/cualquier otro campo
            // existente se conserva intacto.
            const contenidoOriginalV2 = (mensajeAutorizadoV2.contenido ?? {}) as Record<string, unknown>
            const contenidoNuevoV2: Record<string, unknown> = { ...contenidoOriginalV2 }

            const imagenOriginalV2 = contenidoOriginalV2.imagen as Record<string, unknown> | undefined
            const resultadoIndice0 = resultadosV2.find((r) => r.index === 0)
            if (imagenOriginalV2 && resultadoIndice0?.assetId) {
              contenidoNuevoV2.imagen = { ...imagenOriginalV2, assetId: resultadoIndice0.assetId }
            }

            const imagenesOriginalesV2 = contenidoOriginalV2.imagenes
            if (Array.isArray(imagenesOriginalesV2)) {
              const imagenesNuevasV2 = [...imagenesOriginalesV2]
              for (const r of resultadosV2) {
                if (r.assetId && r.index >= 0 && r.index < imagenesNuevasV2.length) {
                  imagenesNuevasV2[r.index] = { ...(imagenesNuevasV2[r.index] as Record<string, unknown>), assetId: r.assetId }
                }
              }
              contenidoNuevoV2.imagenes = imagenesNuevasV2
            }

            const { data: filaActualizadaV2, error: errorUpdateV2 } = await supabaseUserV2
              .from('mensajes_chat')
              .update({ contenido: contenidoNuevoV2 })
              .eq('id', mensajeUsuarioIdSolicitado)
              .eq('conversacion_id', conversacionIdActualV2)
              .eq('rol', 'usuario')
              .select('id')
              .maybeSingle()

            if (errorUpdateV2 || !filaActualizadaV2) {
              // Nunca message/details/hint/payload — pueden ecoar
              // contenido o metadata de la fila. Solo el código corto
              // de error si existe, o una razón estática cuando el
              // UPDATE simplemente no afectó ninguna fila (RLS/mismatch,
              // no un error real de Postgres).
              const codigoUpdateV2 = typeof errorUpdateV2?.code === 'string' ? errorUpdateV2.code : 'sin_codigo'
              console.error(`[V2_ADJUNTO] mensaje_actualizado=false ${errorUpdateV2 ? `code=${codigoUpdateV2}` : 'reason=sin_fila'}`)
            } else {
              console.log(`[V2_ADJUNTO] mensaje_actualizado=true assets=${resultadosV2.filter((r) => r.assetId).length}`)
            }
          }
        }
      }
    } catch {
      // Mensaje estático a propósito — este catch envuelve todo el
      // pipeline (incluida la lectura de `contenido`), así que no hay
      // garantía de qué traería el objeto de excepción.
      console.error('[V2_ADJUNTO] fallo_inesperado_pipeline')
    }
  }

  // REGENERAR IMAGEN (ver "Implementar en Docente IA la capacidad de
  // generar imágenes...", Fase 0+1) — mismo principio que FINALIZAR
  // ARCHIVO más abajo: acción mecánica, nunca pasa por Claude. El
  // cliente ya combinó el prompt original con la instrucción nueva
  // (ver AsistenteService.construirPromptRegeneracionImagen) y manda
  // ese texto ya combinado como `mensaje` — aquí solo se genera de
  // nuevo con ese prompt y se versiona (nunca se borra la anterior,
  // ver lib/assetsVisuales.ts).
  if (supabaseUser && userId && regenerarImagen && typeof regenerarImagen === 'object' && typeof regenerarImagen.assetIdAnterior === 'string' && mensaje) {
    console.log(`[IMAGEN_EXPORT] userId=${userId} — regeneración solicitada (assetIdAnterior=${regenerarImagen.assetIdAnterior})`)
    try {
      const { data: perfil } = await supabaseUser.from('perfiles_docentes').select('*').eq('id', userId).single()
      // tipo==='imagen' siempre en esta rama — SIEMPRE puede terminar en
      // guardarAssetVisual (ver ejecutarGeneracionImagen), así que
      // ownership se demuestra antes de usarlo.
      const conversacionIdActual = await obtenerConversacionIdAutorizada()
      const archivo = await conReintento(
        () => ejecutarHerramientaDocumento('imagen', mensaje, perfil, zonaHoraria, supabaseRAG, userId, supabaseUser, conversacionIdActual, regenerarImagen.assetIdAnterior),
        'regenerar-imagen'
      )
      const marcador = `[[DOCUMENTO_ARCHIVO:${Buffer.from(JSON.stringify(archivo), 'utf-8').toString('base64')}]]`
      return respuestaTexto(`Imagen generada correctamente.\n${marcador}`)
    } catch (err) {
      const codigo = err instanceof ErrorHerramientaDocumento ? err.codigo : 'IMAGEN-GEN'
      console.error(`[IMAGEN_EXPORT] Error regenerando la imagen [${codigo}]:`, err)
      return NextResponse.json({ error: 'No fue posible generar la imagen en este momento. Intenta de nuevo.' }, { status: 502 })
    }
  }

  // FINALIZAR ARCHIVO — cuando el maestro pide el documento activo en un
  // formato real (Word/PDF/PowerPoint/Excel), se genera y sube el
  // archivo directo, SIN pasar por Claude: es una acción mecánica (el
  // contenido ya se acordó en la conversación), no una decisión que el
  // modelo deba tomar. Así se garantiza que la herramienta SIEMPRE se
  // ejecute — nunca depende de que una llamada al modelo grande decida
  // responder con texto en vez de generar el archivo (la falla real que
  // se venía reportando), ni de que la API de Anthropic esté disponible.
  //
  // Dos caminos llegan aquí:
  // 1. El cliente ya detectó la intención (ver detectarHerramientaDocumento
  //    en lib/asistente/documentos.ts) y manda el texto del documento
  //    activo directo — ver `finalizarArchivo` en el cuerpo.
  // 2. Red de seguridad: el cliente NO mandó finalizarArchivo (por
  //    ejemplo, perdió el rastro del documento activo tras recargar la
  //    página — documentoActivo vive solo en memoria del navegador), pero
  //    el mensaje de todos modos nombra un formato real Y el historial
  //    real de la conversación trae un documento recuperable. Nunca debe
  //    depender solo de la memoria del cliente.
  // Formato real que el maestro pidió (o null si no pidió ninguno) —
  // calculado una sola vez aquí porque lo necesitan TANTO el camino
  // rápido de abajo (documento recuperable) COMO el CASO 3 más adelante
  // (nada que recuperar, Claude tiene que redactarlo primero).
  //
  // esEdicionDocumento=true (ver enviarComoEdicion en AsistenteService.ts)
  // — CAUSA RAÍZ real confirmada con logs de producción (tipo=imagen,
  // fuenteContenido=historial, 502 "Herramienta solicitada... falta
  // proveedor" en solicitudes que el maestro nunca pidió como imagen):
  // cuando el maestro edita un documento activo ("hay errores en el
  // orden alfabético", cualquier instrucción que no nombre un formato),
  // el `mensaje` que llega aquí NO es su texto suelto — es el prompt
  // envuelto por construirPromptEdicion(), que incluye instrucciones
  // fijas para Claude sobre cómo tratar íconos/ilustraciones dentro del
  // documento. Ese texto de plantilla (ajeno al maestro) coincidía con
  // el patrón de detección de "imagen" (PATRONES_FORMATO en
  // lib/asistente/documentos.ts), así que la red de seguridad de abajo
  // (pensada solo para mensajes sueltos reales del maestro, ver
  // comentario "2." arriba) reclasificaba CUALQUIER edición como una
  // solicitud de imagen. Una edición nunca debe pasar por
  // detectarHerramientaDocumento — de por sí ya sabemos que no es un
  // pedido de archivo, es exactamente lo contrario (seguir editando el
  // mismo documento).
  const tipoHerramientaSolicitado: TipoHerramienta | null = esEdicionDocumento
    ? null
    : finalizarArchivo && typeof finalizarArchivo === 'object' && typeof finalizarArchivo.documentoTexto === 'string'
      ? finalizarArchivo.tipo
      : detectarHerramientaDocumento(mensaje || '')

  if (supabaseUser && userId && tipoHerramientaSolicitado) {
    let documentoTexto = ''
    let fuenteContenido: 'cliente' | 'historial' | 'ninguna' = 'ninguna'

    // CAUSA RAÍZ REAL, confirmada con evidencia de runtime (ver
    // "fallo real confirmado otra vez en iPhone" — se descargó y leyó
    // el .docx entregado de verdad, era la lista de alumnos, byte a
    // byte): la corrección anterior solo protegía la rama de
    // "historial" (abajo) con pareceNuevoDocumento — la rama de
    // `finalizarArchivo` (el cliente manda el texto del documento
    // activo directo) quedó SIN NINGUNA protección, confiando a
    // ciegas en lo que el cliente mande. Si por cualquier razón el
    // cliente manda finalizarArchivo con contenido viejo (bundle de
    // navegador desactualizado, condición de carrera, o cualquier otro
    // camino no previsto) mientras el mensaje ACTUAL describe un
    // documento nuevo, el servidor lo aceptaba igual. Ahora NINGUNA de
    // las dos fuentes (ni cliente ni historial) se usa cuando
    // pareceNuevoDocumento(mensaje) es cierto — nunca se confía
    // ciegamente en el cliente para decidir esto, es una validación
    // real del servidor, independiente de lo que mande el navegador.
    if (!pareceNuevoDocumento(mensaje || '')) {
      if (finalizarArchivo && typeof finalizarArchivo === 'object' && typeof finalizarArchivo.documentoTexto === 'string') {
        documentoTexto = finalizarArchivo.documentoTexto
        fuenteContenido = 'cliente'
      } else {
        // "Red de seguridad": busca en el HISTORIAL COMPLETO de la
        // conversación cualquier mensaje anterior que "parezca
        // documento formal" — pensada para cuando el cliente perdió
        // documentoActivo (recargó la página) pero el mensaje SÍ pide
        // seguir trabajando sobre algo ya conversado. Nunca se ejecuta
        // si el mensaje describe algo nuevo (ver arriba).
        const ultimoDocumento = [...historialMensajes].reverse().find((h) => h.role === 'assistant' && esDocumentoFormal(h.content))
        if (ultimoDocumento) {
          documentoTexto = ultimoDocumento.content
          fuenteContenido = 'historial'
        }
      }
    }

    // ETAPA 1 (detección de la intención): ya se resolvió arriba —
    // tipoHerramientaSolicitado. ETAPA 2 (obtención del contenido): el
    // texto no se redacta aquí, se recupera ya hecho — de dónde exactamente
    // es lo único que varía.
    console.log(`[PIPELINE ${ETIQUETA_MODULO[tipoHerramientaSolicitado]}:deteccion] tipo=${tipoHerramientaSolicitado} fuenteContenido=${fuenteContenido}`)

    if (documentoTexto && esDocumentoFormal(documentoTexto)) {
      console.log(`[PIPELINE ${ETIQUETA_MODULO[tipoHerramientaSolicitado]}:contenido] OK — ${documentoTexto.length} caracteres (fuente=${fuenteContenido})`)
      try {
        const { data: perfil } = await supabaseUser.from('perfiles_docentes').select('*').eq('id', userId).single()
        // Storage necesita el cliente de service role: el bucket
        // documentos-generados-ia se creó sin políticas RLS explícitas
        // (no hay acceso a SQL/migraciones desde este proyecto — ver
        // lib/documentGen/almacenamiento.ts), así que el cliente
        // autenticado como el docente (supabaseUser) no tiene permiso
        // para escribir ahí. supabaseRAG (service role) sí — causa raíz
        // real confirmada en producción: "new row violates row-level
        // security policy" en la etapa de subida.
        // tipoHerramientaSolicitado puede ser 'imagen' directo, o 'word'/
        // 'pdf' con ilustraciones embebidas ([[IMAGEN:...]] — ver
        // ejecutarHerramientaDocumento) — cualquiera de los dos puede
        // terminar en guardarAssetVisual, así que ownership se demuestra
        // antes de usarlo.
        const conversacionIdActual = await obtenerConversacionIdAutorizada()
        const archivo = await conReintento(() => ejecutarHerramientaDocumento(tipoHerramientaSolicitado, documentoTexto, perfil, zonaHoraria, supabaseRAG, userId, supabaseUser, conversacionIdActual, null), 'generar-archivo')
        const marcador = `[[DOCUMENTO_ARCHIVO:${Buffer.from(JSON.stringify(archivo), 'utf-8').toString('base64')}]]`
        console.log(`[PIPELINE ${ETIQUETA_MODULO[tipoHerramientaSolicitado]}:entrega] OK — ${archivo.nombre}`)
        return respuestaTexto(`Documento generado correctamente.\n${marcador}`)
      } catch (err) {
        if (err instanceof HerramientaNoDisponibleError) {
          // No es una falla real — el maestro pidió algo que a propósito
          // todavía no está implementado (imagen/audio/video). Un mensaje
          // honesto y en español simple no viola ERRORES: no expone
          // nada técnico, solo el límite real de la app.
          return NextResponse.json({ error: err.message }, { status: 502 })
        }
        const codigo = err instanceof ErrorHerramientaDocumento ? err.codigo : `${ETIQUETA_MODULO[tipoHerramientaSolicitado]}-GEN`
        console.error(`Error ejecutando herramienta de documento [${codigo}]:`, err)
        return NextResponse.json({ error: MENSAJE_ERROR_DOCUMENTO }, { status: 502 })
      }
    }
    // No había documento recuperable (ni mandado por el cliente ni en el
    // historial) — cae al flujo normal de abajo. Si tipoHerramientaSolicitado
    // sigue puesto, el CASO 3 (justo antes de "let stream") intercepta la
    // respuesta de Claude en vez de dejarla pasar como texto normal.
  }

  // RAG y "proceso activo" no dependen del Clasificador de Nivel 0 ni de
  // su resultado — se disparan de inmediato en paralelo con él en vez de
  // esperar a que termine para empezar recién ahí (eran ~2 llamadas de
  // red seguidas antes de llegar siquiera a Claude).
  const contextoRAGPromise = buscarContextoRAG(mensaje, institucionId || null)
  const procesoActivoPromise = userId
    ? Promise.resolve(
        supabaseRAG
          .from('procesos_activos')
          .select('*')
          .eq('user_id', userId)
          .eq('estado', 'activo')
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle()
      )
        .then(({ data }) => data)
        .catch(() => null)
    : Promise.resolve(null)

  // La sesión real (grupo activo + lista de alumnos con nombre e ID) se
  // obtiene SIEMPRE que haya un docente autenticado — no solo cuando el
  // mensaje parece pedir una acción concreta. Son 2 consultas indexadas
  // y corren en paralelo con el resto (RAG, proceso activo), así que no
  // agregan una vuelta de red extra. Esto es lo que le permite al Chat
  // IA responder "sí, ya tengo acceso a tu lista, hay 28 alumnos" en vez
  // de fingir que no sabe — ver CONCIENCIA DE DATOS REALES abajo.
  const sesion = (supabaseUser && userId)
    ? await conLimiteDeTiempo(obtenerSesionContexto(supabaseUser, userId, zonaHoraria), TIMEOUT_SESION_MS, 'Tiempo de espera agotado obteniendo la sesión de contexto').catch((e) => {
        console.error('Error obteniendo sesión de contexto:', e)
        return null
      })
    : null

  // Indicadores seguros de diagnóstico — mismo criterio que el log
  // [AUTH][chat] de arriba, nunca datos sensibles (ver "DIAGNÓSTICO
  // OBLIGATORIO" en la corrección crítica de contexto).
  console.log(
    `[SESION][chat] sesionPresente=${!!sesion} grupoIdPresente=${!!sesion?.grupo_activo_id} cicloEscolarPresente=${!!sesion?.ciclo_escolar_id} cantidadAlumnos=${sesion?.alumnos_del_grupo_activo.length ?? 0}`
  )

  // Resumen SIEMPRE disponible del grupo activo y su lista de alumnos —
  // se inyecta en DATOS DEL MAESTRO más abajo pase lo que pase, sin
  // depender del clasificador. Es lo que hace posible responder "sí,
  // tengo acceso a la lista del grupo 3°B, hay 28 alumnos" en vez de
  // "no tengo acceso directo a tu lista".
  const resumenGrupoTexto = sesion
    ? sesion.grupo_activo_id
      ? (() => {
          const alumnos = sesion.alumnos_del_grupo_activo
          const ninas = alumnos.filter((a) => a.sexo === 'M').length
          const ninos = alumnos.filter((a) => a.sexo === 'H').length
          const listaConNumero = alumnos
            .slice()
            .sort((a, b) => (a.numero_lista ?? 999) - (b.numero_lista ?? 999))
            .map((a) => `${a.numero_lista ?? '—'}. ${a.nombre_completo} (${a.sexo === 'M' ? 'niña' : a.sexo === 'H' ? 'niño' : 'sexo no registrado'})`)
            .join('\n')
          return `Grupo activo: sí hay un grupo configurado (ID interno ${sesion.grupo_activo_id}).\nAlumnos inscritos activos: ${alumnos.length} (${ninas} niñas, ${ninos} niños${alumnos.length - ninas - ninos > 0 ? `, ${alumnos.length - ninas - ninos} sin sexo registrado` : ''}).${
            alumnos.length > 0 ? `\nLista de alumnos con número de lista real (úsalo tal cual, nunca inventes uno distinto):\n${listaConNumero}` : ''
          }`
        })()
      : 'Grupo activo: el maestro todavía no tiene un grupo configurado como activo.'
    : null

  // LISTA DE ALUMNOS — igual principio que FINALIZAR ARCHIVO más arriba
  // (y con la misma prioridad: antes del Clasificador de Nivel 0 y
  // antes de CASO 3, para que Claude nunca llegue a redactar esto). Se
  // excluye esEdicionDocumento por la misma razón que tipoHerramientaSolicitado
  // más arriba: `mensaje` sería el prompt interno de construirPromptEdicion
  // (AsistenteService.ts), que puede traer el contenido del documento
  // activo — incluida una lista de alumnos ya generada — y coincidir
  // con SOLICITA_LISTA_ALUMNOS sin que el maestro haya pedido nada de
  // eso en su instrucción real.
  // CAUSA RAÍZ real de "consultar_asistencia_grupo no devuelve el
  // resumen de asistencia" (ver "Depuración de la herramienta de
  // asistencia — único origen de verdad"): esta detección corre ANTES
  // del Clasificador de Nivel 0, así que un mensaje como "revisa la
  // lista del grupo" o "consulta la lista de asistencia" — frases que
  // la propia regla 5 de clasificadorNivel0.ts ya reconoce como
  // consultar_asistencia_grupo — nunca llegaba a esa herramienta: se
  // interceptaba aquí primero y se devolvía la lista de NOMBRES en vez
  // del resumen de presentes/faltas/retardos. Si el mensaje ya suena a
  // consulta de estado de asistencia (no de nombres), nunca se
  // intercepta aquí — se deja pasar al Clasificador de Nivel 0, que sí
  // sabe enrutarlo a la Herramienta real (ver
  // lib/asistente/herramientasModulo.ts).
  // CAUSA RAÍZ REAL de "la guía ilustrada devolvió LISTA_OFICIAL_DE_
  // ALUMNOS.docx" (ver "sigue fallando la prueba en iPhone" —
  // confirmado con evidencia de runtime: se descargó el .docx real
  // entregado y era la lista de alumnos, byte a byte): NINGUNA de las
  // correcciones anteriores (CASO 1/2) podía arreglar esto porque el
  // problema real vive AQUÍ, en un interceptor completamente distinto
  // que corre ANTES — "lista" en español también es un ADJETIVO común
  // ("ready", como en "...limpia y lista para imprimir"), no solo el
  // sustantivo "una lista de alumnos". El patrón suelto de abajo
  // (`/\blista(do)?\b|\bpadr[oó]n\b/i`) no distinguía entre ambos usos:
  // cualquier mensaje que nombrara un formato Y contuviera la palabra
  // "lista" EN CUALQUIER SENTIDO disparaba esta rama — incluida una
  // guía sobre el ciclo del agua que de pura casualidad terminaba con
  // "...lista para imprimir. Genera también Word y PDF." Se agrega
  // `(?!\s+para\b)` para excluir el uso adjetivo más común ("lista
  // para X"), y — como defensa adicional, mismo criterio ya aplicado
  // en CASO 1/2 — pareceNuevoDocumento(mensaje) para que NINGÚN
  // interceptor temprano (este incluido) pueda sustituir un documento
  // nuevo real por otra cosa, sin importar qué palabra suelta
  // contenga.
  const PARECE_CONSULTA_DE_ASISTENCIA = /asistenc|\bfalt(a|as|ó|aron)\b|retardo|presente(s)?|ausente(s)?/i
  const PATRON_LISTA_SUELTA = /\b(lista(do)?|padr[oó]n)\b(?!\s+para\b)/i
  const pideListaAlumnos =
    !esEdicionDocumento &&
    !pareceNuevoDocumento(mensaje || '') &&
    !PARECE_CONSULTA_DE_ASISTENCIA.test(mensaje || '') &&
    (SOLICITA_LISTA_ALUMNOS.test(mensaje || '') ||
      (Boolean(tipoHerramientaSolicitado) && PATRON_LISTA_SUELTA.test(mensaje || '')))

  if (supabaseUser && userId && sesion?.grupo_activo_id && pideListaAlumnos) {
    console.log(`[LISTA_ALUMNOS] detección determinista — tipoHerramientaSolicitado=${tipoHerramientaSolicitado ?? 'ninguno'} alumnos=${sesion.alumnos_del_grupo_activo.length}`)
    if (sesion.alumnos_del_grupo_activo.length === 0) {
      return respuestaTexto('No encontré alumnos inscritos activos en tu grupo actual. Si acabas de dar de alta al grupo, revisa que la importación o el alta de alumnos haya quedado guardada en Lista.')
    }

    const { data: perfilLista } = await supabaseUser.from('perfiles_docentes').select('*').eq('id', userId).single()
    const textoLista = construirTextoListaAlumnos(sesion.alumnos_del_grupo_activo, perfilLista?.grado, perfilLista?.grupo)

    if (tipoHerramientaSolicitado) {
      try {
        const archivo = await conReintento(
          () => ejecutarHerramientaDocumento(tipoHerramientaSolicitado, textoLista, perfilLista, zonaHoraria, supabaseRAG, userId),
          'generar-lista-alumnos'
        )
        const marcador = `[[DOCUMENTO_ARCHIVO:${Buffer.from(JSON.stringify(archivo), 'utf-8').toString('base64')}]]`
        console.log(`[LISTA_ALUMNOS] entrega OK — ${archivo.nombre}`)
        return respuestaTexto(`Documento generado correctamente.\n${marcador}`)
      } catch (err) {
        if (err instanceof HerramientaNoDisponibleError) {
          return NextResponse.json({ error: err.message }, { status: 502 })
        }
        const codigo = err instanceof ErrorHerramientaDocumento ? err.codigo : `${ETIQUETA_MODULO[tipoHerramientaSolicitado]}-GEN`
        console.error(`[LISTA_ALUMNOS] Error generando el archivo [${codigo}]:`, err)
        return NextResponse.json({ error: MENSAJE_ERROR_DOCUMENTO }, { status: 502 })
      }
    }

    return respuestaTexto(textoLista)
  }

  // CAUSA RAÍZ de "el Chat responde como si nunca hubiera recibido la
  // imagen" (ver "Revisar pipeline completo de imágenes del Chat IA"):
  // calculado aquí, ANTES del Clasificador de Nivel 0, para poder
  // usarse como guardia de ejecutarHerramientaDeModulo más abajo — ver
  // esa nota junto al dispatcher. También alimenta el bloque FUENTES
  // DISPONIBLES más adelante (una sola fuente de verdad para "¿hay
  // imagen este turno?", nunca calculado dos veces).
  const tieneImagenAdjunta = Boolean(imagenBase64) || (Array.isArray(imagenesBase64) && imagenesBase64.length > 0)
  // Chat IA — Registro escolar: la tool solo se agrega cuando hay
  // imagen adjunta este turno (ver lib/registroEscolarTool.ts). En
  // texto plano ya lo cubre el Clasificador de Nivel 0.
  const requiereRegistroEscolar = tieneImagenAdjunta
  const cantidadImagenesAdjuntas = Array.isArray(imagenesBase64) ? imagenesBase64.length : (imagenBase64 ? 1 : 0)

  // INSTRUMENTACIÓN DIAGNÓSTICA TEMPORAL — checkpoint del lado servidor
  // del pipeline visual (ver bloque de arriba). tieneImagenAdjunta ya es
  // la MISMA señal que decide el resto del comportamiento real de la
  // app — nunca se calcula distinto para el diagnóstico.
  if (diagnosticoCurpActivo) {
    trazaDebug.imagenRecibidaServidor = tieneImagenAdjunta
    trazaDebug.imagenEntregadaVision = tieneImagenAdjunta
    trazaDebug.tamanoPayloadVisual = imagenBase64
      ? (typeof imagenBase64 === 'string' ? imagenBase64.length : null)
      : (Array.isArray(imagenesBase64) ? imagenesBase64.reduce((acc: number, i: { base64?: string }) => acc + (i?.base64?.length || 0), 0) : null)
  }

  // --- Clasificador de Nivel 0 — se llama SIEMPRE que hay sesión real,
  // sin ningún filtro de palabras clave delante (ver la nota de
  // arquitectura junto a los imports: ningún filtro local puede
  // garantizar que cubre cada forma de preguntar algo). Si el mensaje
  // no tiene nada que clasificar, el propio clasificador devuelve
  // "conversacion_general" y el flujo sigue exactamente igual. ---
  let contextoEnriquecido = [contexto || '', resumenGrupoTexto || ''].filter(Boolean).join('\n\n')
  // Ver "Consultar información oficial vigente de la SEP" — true solo si
  // el Clasificador de Nivel 0 (regla 18) autorizó este turno específico
  // para usar la herramienta de búsqueda oficial. Declarado en este
  // scope (antes del try) para que parametrosClaude, más abajo, pueda
  // leerlo sin importar qué pasó dentro del bloque del clasificador.
  let requiereConsultaOficial = false
  // Corrección funcional de C-005 — vista previa descargable de la
  // hoja de evaluación mientras el borrador de planeación TODAVÍA NO
  // se aprueba. Declarado aquí (antes del try del clasificador) para
  // que el bloque de streaming, mucho más abajo, pueda leerlo sin
  // importar qué pasó dentro de ese try — mismo criterio ya usado por
  // requiereConsultaOficial.
  let esTurnoDeBorradorPlaneacion = false
  // FASE 2B1 (ver "transporte interno de la decisión del orquestador")
  // — mismo criterio que las dos variables de arriba: declarada antes
  // del try del clasificador para que el Response final (mucho más
  // abajo) pueda leerla sin importar qué pasó dentro de ese try. Solo
  // se llena cuando Nivel0 ya normalizó una decisión contextual válida
  // (ver más abajo) — cualquier error o ausencia de decisión la deja en
  // null, y entonces el header de más abajo simplemente no se agrega.
  let decisionOrquestadorParaHeader: DecisionOrquestador | null = null
  // FASE 2B2A (ver "short-circuit + ejecución de capacidades de
  // recurso") — mismo criterio que la variable de arriba: declarada
  // antes del try para que el bloque de streaming, mucho más abajo,
  // pueda leerla. true SOLO cuando esCandidataAShortCircuitCliente ya
  // confirmó (contra referentesContextuales REALES, no lo que dijo el
  // modelo) que el cliente puede ejecutar esta decisión — en ese caso
  // route.ts omite la segunda llamada Sonnet conversacional (ver más
  // abajo, justo antes de client.messages.create).
  let esShortCircuitOrquestador = false
  // FASE 2B2B1 (ver "transformar_texto — misma llamada Sonnet
  // conversacional ya planeada, sin short-circuit a cliente") — mismo
  // criterio de las variables de arriba: declarada antes del try para
  // que el bloque `bloqueTransformarTexto` (más abajo, junto a
  // bloqueVoz/bloqueModoImagen/etc.) pueda leerla. true SOLO cuando
  // Nivel0 ya resolvió capacidad_contextual==='transformar_texto' con
  // confianza_contextual==='alta' y referente_elegido.tipo==='texto'
  // — referente tipo 'documento' queda EXCLUIDO a propósito esta fase
  // (puede representar solo el texto-envoltorio del mensaje, nunca el
  // contenido documental real, ver auditoría 2B2B).
  let activarTransformarTexto = false
  // FASE 2B2B2 (ver "convertir_documento desde referente textual") —
  // mismo criterio que las variables de arriba: declaradas antes del
  // try para que el bloque de ejecución (más abajo, después del
  // short-circuit de 2B2A, antes de la llamada conversacional) pueda
  // leerlas. `esCandidataConvertirDocumento` es true SOLO cuando
  // Nivel0 ya resolvió capacidad_contextual==='convertir_documento'
  // con confianza_contextual==='alta' y referente_elegido.tipo==='texto'
  // — mismo criterio de exclusión de referente tipo 'documento' que
  // 2B2B1 (texto-envoltorio, nunca contenido real). `referenteIdParaConvertirDocumento`
  // guarda el id exacto para recuperar el texto real vía mensajes_chat
  // más abajo — nunca se reconstruye por heurística sobre historialMensajes.
  let esCandidataConvertirDocumento = false
  let referenteIdParaConvertirDocumento: string | null = null
  if (supabaseUser && userId && sesion) {
    try {
      // Últimos turnos reales — solo para que el clasificador pueda
      // resolver una confirmación breve ("sí") como continuación de su
      // propia pregunta "¿Te refieres a...?" del turno anterior (ver
      // regla 13 en clasificadorNivel0.ts). No es historial "de
      // edición" (esEdicionDocumento), así que no aplica ese riesgo.
      const tClasificacionInicio = diagnosticoCurpActivo ? Date.now() : 0
      // Ver "medición de usage real del Clasificador de Nivel 0" —
      // clasificarNivel0 acepta un callback opcional que expone el
      // usage real de su propia llamada a Anthropic (respuesta.usage,
      // ya presente en el SDK). Local a este request (nunca una
      // variable de módulo), así que es segura bajo requests
      // concurrentes. Envuelto en un objeto (no un "let" reasignado
      // directo) porque TypeScript no logra rastrear correctamente el
      // ensanchamiento de tipo de un "let" reasignado dentro de un
      // callback pasado a otra función — con el objeto, la propiedad
      // conserva su tipo declarado sin ese falso positivo.
      const usageClasificacion: { valor: Anthropic.Usage | null } = { valor: null }
      const clasificacion = await clasificarNivel0(mensaje, sesion, historialMensajes.slice(-4), tieneImagenAdjunta, (usage) => {
        usageClasificacion.valor = usage
      }, referentesContextuales)
      marcarTelemetria('intent:classification_finished')
      if (diagnosticoCurpActivo) {
        const msClasificacion = Date.now() - tClasificacionInicio
        trazaDebug.clasificacionEjecutada = true
        trazaDebug.msClasificacion = msClasificacion
        // Modelo tomado del código ya existente (literal
        // 'claude-sonnet-4-6' en clasificadorNivel0.ts), no de una
        // llamada adicional. usage real de ESTA petición, nunca
        // inventado — si el SDK entrega null (ej. sin caching activo
        // todavía, cache_read_input_tokens/cache_creation_input_tokens
        // vienen null), se preserva null, nunca se sustituye por 0.
        const usage = usageClasificacion.valor
        registrarLlamadaIA({
          proveedor: 'anthropic',
          modelo: 'claude-sonnet-4-6',
          finalidad: 'clasificacion',
          ms: msClasificacion,
          usageDisponible: usage !== null,
          inputTokens: usage?.input_tokens ?? null,
          outputTokens: usage?.output_tokens ?? null,
          cacheReadTokens: usage?.cache_read_input_tokens ?? null,
          cacheWriteTokens: usage?.cache_creation_input_tokens ?? null,
        })
      }
      requiereConsultaOficial = clasificacion.requiere_consulta_oficial === true
      if (requiereConsultaOficial) {
        console.log(`[CONSULTA_OFICIAL] activada — intencion=${clasificacion.intencion_principal}`)
      }
      // Diagnóstico — nunca visible al maestro. Con esto se puede ver en
      // vercel logs EXACTAMENTE por qué una consulta como "¿cuántas
      // faltas tiene Audrey?" no llegó a responder con el dato real: si
      // el clasificador no resolvió al alumno, si sesion.ciclo_escolar_id
      // viene null (el contexto activo del docente no tiene ciclo
      // escolar configurado), o si consultarAsistenciaAlumno falló.
      console.log(
        `[NIVEL0] intencion=${clasificacion.intencion_principal} nivel=${clasificacion.nivel_ejecucion} alumno_id=${clasificacion.entidades_resueltas.alumno_id} alumno_detectado=${clasificacion.entidades_resueltas.alumno_nombre_detectado} datos_faltantes=${JSON.stringify(clasificacion.datos_faltantes)} ciclo_escolar_id=${sesion.ciclo_escolar_id}`
      )
      // FASE 2A (ver "contrato del router semántico unificado +
      // transporte de referentes contextuales") — SOLO diagnóstico:
      // esta app todavía NO ejecuta nada con capacidad_contextual (ver
      // "validar el cerebro antes de conectarle las manos" — parte 6,
      // "no ejecutar todavía"). Nunca loguea contenido/prompts/datos de
      // alumnos, solo la forma de la decisión. `descartada` distingue
      // por qué terminó en null: por prioridad de intención interna,
      // por no haber candidatos, o porque el propio modelo no encontró
      // evidencia suficiente.
      console.log(
        `[NIVEL0_CONTEXTUAL] candidatos=${referentesContextuales.length} capacidad=${clasificacion.capacidad_contextual ?? 'null'} referente_tipo=${clasificacion.referente_elegido?.tipo ?? 'null'} confianza=${clasificacion.confianza_contextual ?? 'null'} descartada_por_intencion_interna=${clasificacion.intencion_principal !== 'conversacion_general'}`
      )
      // FASE 2B1 (ver "transporte interno de la decisión del
      // orquestador") — construye el candidato a header SOLO a partir
      // de la salida YA NORMALIZADA de Nivel0 (nunca reconstruye en
      // paralelo la regla de prioridad de normalizarClasificacionNivel0):
      // cuando cualquiera de los 3 campos es null (ya sea porque
      // intencion_principal !== 'conversacion_general' o porque el
      // propio modelo no encontró evidencia suficiente), esto se queda
      // en null y el header, más abajo, simplemente no se agrega.
      // validarDecisionOrquestador se usa aquí también (no solo en el
      // cliente) para garantizar que el header nunca transporte una
      // forma distinta a la única fuente de verdad compartida.
      if (clasificacion.capacidad_contextual && clasificacion.referente_elegido && clasificacion.confianza_contextual) {
        decisionOrquestadorParaHeader = validarDecisionOrquestador({
          capacidad: clasificacion.capacidad_contextual,
          referente: clasificacion.referente_elegido,
          confianza: clasificacion.confianza_contextual,
        })
      }
      // FASE 2B2A (ver "short-circuit + ejecución de capacidades de
      // recurso") — misma función pura y centralizada que usa el
      // cliente (defense in depth, ver AsistenteService.ts): decide si
      // ESTA decisión ya es candidata a ejecutarse en el cliente, SOLO
      // contra `referentesContextuales` (los mismos ya validados por
      // route.ts contra la lista real enviada, nunca lo que el modelo
      // dijo sin más). En esta fase solo generar_imagen/editar_imagen
      // pueden dar true — convertir_documento/transformar_texto
      // siempre dan false aquí (ver auditoría 2B2A).
      if (decisionOrquestadorParaHeader) {
        esShortCircuitOrquestador = esCandidataAShortCircuitCliente(decisionOrquestadorParaHeader, referentesContextuales)
        if (esShortCircuitOrquestador) {
          console.log(
            `[ORQUESTADOR_SHORT_CIRCUIT] activo=true capacidad=${decisionOrquestadorParaHeader.capacidad} referente_tipo=${decisionOrquestadorParaHeader.referente.tipo}`
          )
        }
      }
      // FASE 2B2B1 — a diferencia de 2B2A, esto NUNCA implica omitir la
      // llamada conversacional: solo decide si el bloque
      // `bloqueTransformarTexto` (más abajo) se agrega al system prompt
      // de la MISMA llamada Sonnet que este turno ya iba a hacer. Se
      // calcula directamente desde `clasificacion` (ya normalizada por
      // clasificarNivel0 — nunca reconstruye la regla de prioridad en
      // paralelo), nunca desde el header de decisión.
      activarTransformarTexto =
        clasificacion.capacidad_contextual === 'transformar_texto' &&
        clasificacion.confianza_contextual === 'alta' &&
        clasificacion.referente_elegido?.tipo === 'texto'
      if (activarTransformarTexto) {
        console.log('[TRANSFORMAR_TEXTO] activo=true referente_tipo=texto')
      }
      // FASE 2B2B2 — mismo criterio directamente desde `clasificacion`
      // ya normalizada (nunca reconstruye la regla de prioridad en
      // paralelo). Solo guarda el candidato aquí — la recuperación real
      // del texto (mensajes_chat) y la ejecución ocurren más abajo,
      // después del short-circuit de 2B2A, para no hacer una consulta
      // a la base de datos en turnos que de todos modos no la
      // necesitan (ej. cuando 2B2A ya va a ejecutar generar_imagen/
      // editar_imagen para este mismo turno).
      esCandidataConvertirDocumento =
        clasificacion.capacidad_contextual === 'convertir_documento' &&
        clasificacion.confianza_contextual === 'alta' &&
        clasificacion.referente_elegido?.tipo === 'texto'
      if (esCandidataConvertirDocumento) {
        referenteIdParaConvertirDocumento = clasificacion.referente_elegido!.id
        console.log('[CONVERTIR_DOCUMENTO] candidato=true')
      }
      // INSTRUMENTACIÓN DIAGNÓSTICA TEMPORAL — solo indicadores, NUNCA el
      // nombre del alumno ni el valor propuesto crudo (ver TrazaDiagnosticoCurp).
      if (diagnosticoCurpActivo) {
        trazaDebug.etapa = 'clasificación Nivel 0 completa'
        trazaDebug.intencionPrincipal = clasificacion.intencion_principal
        trazaDebug.accionCorreccionAlumno = clasificacion.accion_correccion_alumno
        trazaDebug.modoOperacionAlumno = clasificacion.modo_operacion_alumno
        trazaDebug.alumnoDetectado = !!clasificacion.entidades_resueltas.alumno_id
        trazaDebug.campo = clasificacion.campo_alumno_corregir ?? clasificacion.campo_alumno_solicitado
        trazaDebug.valorPropuestoPresente = !!clasificacion.valor_alumno_propuesto
        trazaDebug.valorLongitud = clasificacion.valor_alumno_propuesto ? clasificacion.valor_alumno_propuesto.length : null
        trazaDebug.datosFaltantes = clasificacion.datos_faltantes
      }

      // PREDICADO ÚNICO — COMPARACIÓN VISUAL DE DATO DE ALUMNO (ver
      // "diseñar una condición determinista y única" — reemplaza la
      // dependencia anterior de clasificacion.nivel_ejecucion===4, que
      // una prueba real demostró no confiable: el modelo puede resolver
      // correctamente intención/modo/alumno/campo pero no sincronizar
      // nivel_ejecucion ni limpiar datos_faltantes en la misma llamada).
      // Construido ÚNICAMENTE con señales ya demostradas fiables en
      // pruebas reales de esta sesión: tieneImagenAdjunta (hecho de
      // runtime, no depende del modelo) + campos del clasificador que
      // SIEMPRE se resolvieron bien en cada prueba (intención, modo,
      // alumno, campo). Deliberadamente NO usa nivel_ejecucion,
      // datos_faltantes ni accion_correccion_alumno — ver auditoría de
      // diseño. Se declara UNA sola vez y se reutiliza tal cual en los
      // tres puntos que antes podían desincronizarse: el bloque de
      // aclaración de abajo, el bypass de la Herramienta determinista, y
      // la entrada al enriquecimiento de Nivel4 — nunca se recalcula ni
      // se aproxima de otra forma en ningún otro lugar.
      const valorAlumnoPropuestoAusente =
        !clasificacion.valor_alumno_propuesto || clasificacion.valor_alumno_propuesto.trim() === ''
      const esComparacionVisualDeAlumno =
        tieneImagenAdjunta &&
        clasificacion.intencion_principal === 'corregir_dato_alumno' &&
        clasificacion.modo_operacion_alumno === 'comparar' &&
        !!clasificacion.entidades_resueltas.alumno_id &&
        !clasificacion.entidades_resueltas.alumno_ambiguo &&
        !!clasificacion.campo_alumno_corregir &&
        valorAlumnoPropuestoAusente

      // Caso: falta un dato esencial o hay ambigüedad → no se ejecuta
      // nada todavía, se le pide al docente que aclare.
      if (clasificacion.datos_faltantes.length > 0 || clasificacion.entidades_resueltas.alumno_ambiguo) {
        if (clasificacion.entidades_resueltas.alumno_ambiguo) {
          const opciones = clasificacion.entidades_resueltas.opciones_alumno_ambiguo.join(', ')
          return respuestaTexto(conDiagnostico(`Tengo más de un alumno que coincide con ese nombre: ${opciones}. ¿A cuál te refieres?`))
        }
        if (clasificacion.datos_faltantes.includes('alumno')) {
          return respuestaTexto(conDiagnostico('¿De qué alumno se trata?'))
        }
        if (clasificacion.datos_faltantes.includes('descripcion_incidencia')) {
          return respuestaTexto(conDiagnostico('¿Qué fue lo que pasó exactamente?'))
        }
        if (clasificacion.datos_faltantes.includes('fecha_o_duracion')) {
          return respuestaTexto(conDiagnostico('¿Para cuántos días o qué fechas te gustaría esta planeación?'))
        }
        if (clasificacion.datos_faltantes.includes('campo_alumno')) {
          return respuestaTexto(conDiagnostico('¿Qué dato necesitas — CURP, sexo o fecha de nacimiento?'))
        }
        if (clasificacion.datos_faltantes.includes('valor_alumno') && !esComparacionVisualDeAlumno) {
          return respuestaTexto(conDiagnostico('¿Cuál es el valor correcto?'))
        }
      }

      // Separación estricta entre conversación libre y consultas de
      // módulos internos (ver lib/asistente/herramientasModulo.ts): si
      // la intención clasificada pertenece a un módulo con Herramienta
      // registrada (Asistencias, Incidencias, Apoyo, Documentos, y
      // cualquier futura que se registre ahí), la respuesta sale
      // ÚNICAMENTE de esa Herramienta — nunca del modelo grande. Único
      // punto de entrada para todas ellas; ver ese archivo para la
      // lista completa y por qué ficha_descriptiva/planeacion_generar/
      // consultar_calendario NO están ahí (generación/razonamiento
      // real, no una cifra fija).
      marcarTelemetria('tool:execution_started')
      const tHerramientaInicio = diagnosticoCurpActivo ? Date.now() : 0
      // EXCEPCIÓN — comparar dato de alumno con imagen adjunta como
      // fuente del valor (ver "ajuste mínimo de clasificación para
      // imagen adjunta" y "diseñar una condición determinista y
      // única"): herramientaCorregirDatoAlumno en herramientasModulo.ts
      // es 100% determinista y SIEMPRE exige valor_alumno_propuesto
      // como texto — nunca sabe leer una imagen. Se salta la
      // Herramienta determinista aquí y cae al enriquecimiento de
      // Nivel 4 de abajo, que sí sabe leer imágenes (Claude Vision, ya
      // en uso en conversación general). Usa el predicado único
      // esComparacionVisualDeAlumno (declarado arriba, antes del
      // bloque de aclaración) — misma señal exacta reutilizada en los
      // otros dos puntos, nunca una aproximación local distinta.
      const respuestaDeModulo = esComparacionVisualDeAlumno
        ? null
        : await ejecutarHerramientaDeModulo(clasificacion, {
            sb: supabaseUser,
            sesion,
            userId,
            zonaHoraria,
            canal: channel === 'voice' ? 'voice' : 'text',
            // ALCANCE V1-C: este dispatcher (correcciones_alumno) nunca
            // llega a guardarAssetVisual — V1-C solo vincula assets
            // visuales, no amplía qué conversacionId reciben otros
            // consumos históricos. Semántica efectiva idéntica a la de
            // antes de este cambio (contexto?.conversacionId, un string
            // que siempre daba undefined → null). Una corrección real de
            // trazabilidad para correcciones_alumno, si algún día hace
            // falta, es una fase aparte con su propia semántica de
            // ownership — no se adelanta aquí.
            conversacionId: null,
          })
      marcarTelemetria('tool:execution_finished')
      if (diagnosticoCurpActivo) {
        // "consulta de datos" vive DENTRO de la herramienta (ej.
        // contextoAlumno en herramientasModulo.ts) — separarla de este
        // tiempo requeriría tocar ese archivo, fuera del alcance
        // autorizado esta ronda (ver informe). Se mide como una sola
        // etapa combinada; consultaDatosEjecutada refleja si la
        // intención SÍ tenía una Herramienta registrada.
        trazaDebug.msHerramienta = Date.now() - tHerramientaInicio
        trazaDebug.consultaDatosEjecutada = respuestaDeModulo !== null
      }
      if (respuestaDeModulo !== null) {
        if (tieneImagenAdjunta) {
          // CAUSA RAÍZ real del bug de imágenes: este dispatcher no
          // sabe nada de imágenes (clasificarNivel0 solo recibe texto)
          // y antes regresaba su respuesta de inmediato sin importar
          // si el maestro había adjuntado una foto — el modelo grande
          // (el único que puede ver imágenes) nunca llegaba a
          // ejecutarse ese turno. Con imagen adjunta, los datos reales
          // ya obtenidos se inyectan como contexto en vez de
          // devolverse como respuesta final, para que el modelo grande
          // SIEMPRE vea la imagen (ver punto 6: nunca debe requerir
          // que el maestro la vuelva a describir) sin perder la
          // garantía de que la parte de datos del módulo sigue viniendo
          // de la Herramienta real, nunca inventada.
          console.log(`[IMAGEN][DISPATCHER] ${clasificacion.intencion_principal} coincidió con una Herramienta, pero hay ${cantidadImagenesAdjuntas} imagen(es) este turno — se inyecta como contexto real y se deja pasar al modelo grande en vez de responder directo`)
          contextoEnriquecido += `\n\nDATOS REALES YA CONSULTADOS PARA ESTE TURNO (usa esto junto con la imagen adjunta — nunca inventes ni ignores ninguno de los dos):\n${respuestaDeModulo}`
        } else {
          if (diagnosticoCurpActivo) {
            trazaDebug.etapa = 'herramienta de módulo ejecutada — respuesta directa'
            trazaDebug.herramientaEjecutada = clasificacion.intencion_principal
          }
          return respuestaTexto(conDiagnostico(respuestaDeModulo))
        }
      }

      // Nivel 1: registrar_asistencia ("pasa lista", "toma asistencia", etc.
      // — todas la misma acción real) — marca a todo el grupo activo como
      // presente por default, sin pasar por el modelo grande.
      if (
        clasificacion.intencion_principal === 'registrar_asistencia' &&
        clasificacion.nivel_ejecucion === 1 &&
        sesion.grupo_activo_id
      ) {
        try {
          await registrarAsistenciaMasiva(supabaseUser, sesion.grupo_activo_id, sesion.fecha_actual, [])

          // La tabla legada `asistencias` (alumno_id, no inscripcion_id) no
          // la toca la RPC — se sincroniza aquí para que los contadores de
          // Lista no queden desfasados con lo registrado desde el chat.
          if (sesion.alumnos_del_grupo_activo.length > 0) {
            const filasLegadas = sesion.alumnos_del_grupo_activo.map((a) => ({
              alumno_id: a.alumno_id,
              fecha: sesion.fecha_actual,
              presente: true,
            }))
            const { error: errorLegado } = await supabaseUser
              .from('asistencias')
              .upsert(filasLegadas, { onConflict: 'alumno_id,fecha' })
            if (errorLegado) console.error('Error sincronizando asistencias (legado) desde el chat:', errorLegado)
          }

          return respuestaTexto('Listo. Ya pasé lista — todos tus alumnos quedaron como presentes por default. Si alguien faltó o llegó tarde, dime su nombre y lo corrijo.')
        } catch (e) {
          // NUNCA dejar caer esto al flujo normal: si la escritura real
          // falló, Claude no debe tener oportunidad de responder algo
          // conversacional que suene a éxito ("listo, ya pasé lista")
          // sin que haya pasado de verdad (ver CORRECCIÓN — nunca
          // confirmar una operación antes de verificarla).
          console.error('[NIVEL0] registrar_asistencia — la escritura falló, respondiendo con honestidad:', e)
          return respuestaTexto('No fue posible pasar lista en este momento. Intenta de nuevo en unos segundos.')
        }
      }

      // Nivel 1: marcar_asistencia_individual — un alumno específico,
      // por nombre. Nunca responde éxito sin que Supabase confirme la
      // escritura real (ver escribirAsistencia en lib/motorContexto.ts)
      // y, si el nombre solo coincidió por semejanza fonética (típico
      // de dictado por voz, ej. "Outrid" por "Audrey"), pide
      // confirmación explícita ANTES de escribir nada.
      if (clasificacion.intencion_principal === 'marcar_asistencia_individual' && clasificacion.nivel_ejecucion === 1) {
        const alumnoId = clasificacion.entidades_resueltas.alumno_id
        const estado = clasificacion.estado_asistencia_solicitado
        const nombreReal = clasificacion.entidades_resueltas.alumno_nombre_detectado || 'ese alumno'

        if (!alumnoId || !estado) {
          console.log(`[NIVEL0] marcar_asistencia_individual sin alumno_id (${alumnoId}) o estado (${estado}) resuelto — cae al flujo normal`)
        } else if (clasificacion.requiere_confirmacion) {
          console.log(`[NIVEL0] marcar_asistencia_individual requiere confirmación (motivo=${clasificacion.motivo_confirmacion}) — alumno_id=${alumnoId}, todavía NO se escribió nada`)
          return respuestaTexto(`¿Te refieres a ${nombreReal}? Confírmamelo y registro la asistencia.`)
        } else {
          try {
            const resultado = await escribirAsistencia(supabaseUser, [{ alumno_id: alumnoId, estado }], sesion.fecha_actual, sesion.grupo_activo_id)
            if (!resultado.exito) {
              console.error(`[NIVEL0] marcar_asistencia_individual — Supabase rechazó la escritura, alumno_id=${alumnoId}:`, resultado.error)
              return respuestaTexto('No fue posible guardar la asistencia. Intenta de nuevo en unos segundos.')
            }
            const etiqueta = estado === 'presente' ? 'presente' : estado === 'falta' ? 'con falta' : 'con retardo'
            console.log(`[NIVEL0] marcar_asistencia_individual OK — alumno_id=${alumnoId} estado=${estado}`)
            return respuestaTexto(`Listo, ${nombreReal} quedó registrado ${etiqueta} el día de hoy.`)
          } catch (e) {
            console.error(`[NIVEL0] marcar_asistencia_individual — excepción escribiendo, alumno_id=${alumnoId}:`, e)
            return respuestaTexto('No fue posible guardar la asistencia. Intenta de nuevo en unos segundos.')
          }
        }
      }

      // Nivel 1: registrar_incidencia — un alumno específico, por
      // nombre. Nivel 2 de riesgo (aditivo, reversible: un registro de
      // más se corrige o se borra después sin perder ningún otro dato),
      // por eso NO pide confirmación explícita antes de escribir —
      // única diferencia real frente a marcar_asistencia_individual.
      // tipo_incidencia/descripcion_incidencia ya vienen extraídos por
      // el Clasificador de Nivel 0 (regla 19) directo de las palabras
      // del maestro, nunca inventados aquí.
      if (clasificacion.intencion_principal === 'registrar_incidencia' && clasificacion.nivel_ejecucion === 1) {
        const alumnoId = clasificacion.entidades_resueltas.alumno_id
        const descripcion = clasificacion.descripcion_incidencia
        const tipo = clasificacion.tipo_incidencia || 'Incidencia'
        const nombreReal = clasificacion.entidades_resueltas.alumno_nombre_detectado || 'ese alumno'
        const grupoId = sesion.grupo_activo_id

        if (!alumnoId || !descripcion || !grupoId) {
          console.log(`[NIVEL0] registrar_incidencia sin alumno_id (${alumnoId}), descripcion (${descripcion}) o grupo_id (${grupoId}) resuelto — cae al flujo normal`)
        } else {
          try {
            const resultado = await registrarIncidencia(supabaseUser, alumnoId, grupoId, userId, sesion.fecha_actual, tipo, descripcion)
            if (!resultado.exito) {
              console.error(`[NIVEL0] registrar_incidencia — Supabase rechazó la escritura, alumno_id=${alumnoId}:`, resultado.error)
              return respuestaTexto('No fue posible registrar la incidencia. Intenta de nuevo en unos segundos.')
            }
            console.log(`[NIVEL0] registrar_incidencia OK — alumno_id=${alumnoId} tipo=${tipo}`)
            return respuestaTexto(`Listo. Registré la incidencia de ${nombreReal} (${tipo}).`)
          } catch (e) {
            console.error(`[NIVEL0] registrar_incidencia — excepción escribiendo, alumno_id=${alumnoId}:`, e)
            return respuestaTexto('No fue posible registrar la incidencia. Intenta de nuevo en unos segundos.')
          }
        }
      }

      // planeacion_generar, aprobación (C-005, Paso 3C) — la ÚNICA
      // escritura real de este intent, y a propósito NUNCA pasa por
      // Claude: el guardado se decide y se confirma 100% en código,
      // igual que registrar_asistencia/marcar_asistencia_individual/
      // registrar_incidencia arriba. accion_planeacion_generar==='aprobar'
      // ya viene acotado por el clasificador (ver regla 4) a que el
      // turno anterior presentó un borrador completo y este mensaje lo
      // confirma sin ambigüedad — aun así, aprobarBorradorPlaneacion
      // vuelve a extraer y validar el borrador de forma determinista,
      // nunca confía ciegamente en la clasificación.
      if (clasificacion.intencion_principal === 'planeacion_generar' && clasificacion.accion_planeacion_generar === 'aprobar') {
        try {
          const resultado = await aprobarBorradorPlaneacion(supabaseUser, sesion, historialMensajes)
          if (!resultado.ok) {
            console.log(`[NIVEL0] planeacion_generar — aprobación no completada (${resultado.codigo}): ${resultado.mensaje}`)
            return respuestaTexto(resultado.mensaje)
          }
          const p = resultado.planeacion
          const fechas = p.fecha_inicio && p.fecha_fin ? `, del ${p.fecha_inicio} al ${p.fecha_fin}` : ''
          const duracion = resultado.duracionDias ? ` para ${resultado.duracionDias} días efectivos` : ''
          console.log(`[NIVEL0] planeacion_generar — aprobación OK, planeacion_id=${p.id}, hoja=${resultado.hoja.identificadorVisible}`)
          const mensajeVoz = `Listo, guardé la planeación de ${p.nombre}${duracion}${fechas}.`
          const mensajeTexto = `${mensajeVoz} Ya aparece en Planeación, queda disponible para consulta, y la hoja de evaluación se utilizará al finalizar el proyecto.`
          // Documento(s) DEFINITIVO(s) — mismo marcador [[DOCUMENTO_ARCHIVO:...]]
          // que la vista previa, ahora con URLs firmadas reales de
          // Storage (nunca tokens de vista previa). AJUSTE AISLADO —
          // "descarga real en Word y PDF": si Fase 4.5 de
          // aprobarBorradorPlaneacion logró generar ambos formatos de
          // la planeación, se adjuntan los DOS con tipoDocumento='planeacion'
          // (TarjetaDescarga los agrupa en una sola tarjeta); si no
          // (mejor esfuerzo, ver esa función), se omiten sin bloquear
          // nada — el docente puede pedirlos después escribiendo en el
          // chat. La hoja de evaluación sigue siendo solo PDF.
          const marcadores: string[] = []
          if (resultado.documentoPlaneacion) {
            const archivoWord = { tipo: 'word', nombre: resultado.documentoPlaneacion.word.nombre, url: resultado.documentoPlaneacion.word.url, tipoDocumento: 'planeacion' as const }
            marcadores.push(`[[DOCUMENTO_ARCHIVO:${Buffer.from(JSON.stringify(archivoWord), 'utf-8').toString('base64')}]]`)
            const archivoPdfPlaneacion = { tipo: 'pdf', nombre: resultado.documentoPlaneacion.pdf.nombre, url: resultado.documentoPlaneacion.pdf.url, urlVer: resultado.documentoPlaneacion.pdf.urlVer, tipoDocumento: 'planeacion' as const }
            marcadores.push(`[[DOCUMENTO_ARCHIVO:${Buffer.from(JSON.stringify(archivoPdfPlaneacion), 'utf-8').toString('base64')}]]`)
          }
          const archivoHoja = { tipo: 'pdf', nombre: `hoja-evaluacion-${resultado.hoja.identificadorVisible}.pdf`, url: resultado.hoja.url, urlVer: resultado.hoja.urlVer, tipoDocumento: 'hoja_evaluacion' as const }
          marcadores.push(`[[DOCUMENTO_ARCHIVO:${Buffer.from(JSON.stringify(archivoHoja), 'utf-8').toString('base64')}]]`)
          return respuestaTexto(`${channel === 'voice' ? mensajeVoz : mensajeTexto}\n${marcadores.join('\n')}`)
        } catch (e) {
          console.error('[NIVEL0] planeacion_generar — excepción aprobando el borrador:', e)
          return respuestaTexto('No fue posible guardar la planeación en este momento. Intenta de nuevo en unos segundos.')
        }
      }

      // Nivel 1: actualizar_perfil_docente — "Ya somos cuarto.", "Cambia
      // el grado.", "Ahora es 4° B." Escribe DIRECTO en
      // perfiles_docentes.grado/grupo (ver actualizarPerfilDocente en
      // lib/motorContexto.ts): es la ÚNICA fuente que usa TODO el
      // pipeline de documentos (encabezados, PDA/contenidos vía
      // MARCO_CURRICULAR_VIGENTE, planeaciones), así que este cambio
      // por sí solo hace que Word/PDF, el contenido pedagógico y el
      // resto de la conversación (no hay caché — cada llamada a
      // /api/chat vuelve a leer perfiles_docentes) usen el grado/grupo
      // nuevo sin ningún paso adicional. Deliberadamente NO toca la
      // tabla `grupos` (grupo activo de Lista/asistencia) — un docente
      // puede tener varias filas ahí (una por grado/grupo distinto en
      // el mismo ciclo), y no hay forma segura de adivinar cuál
      // "actualizar" desde una frase de chat sin arriesgar corromper el
      // roster/asistencia de un grupo equivocado.
      if (clasificacion.intencion_principal === 'actualizar_perfil_docente' && clasificacion.nivel_ejecucion === 1) {
        const gradoSolicitado = clasificacion.grado_solicitado
        const grupoSolicitado = clasificacion.grupo_solicitado

        if (!gradoSolicitado && !grupoSolicitado) {
          console.log('[NIVEL0] actualizar_perfil_docente sin grado ni grupo resuelto — cae al flujo normal')
        } else {
          try {
            const resultado = await actualizarPerfilDocente(supabaseUser, userId, {
              grado: gradoSolicitado ?? undefined,
              grupo: grupoSolicitado ?? undefined,
            })
            if (!resultado.exito) {
              console.error('[NIVEL0] actualizar_perfil_docente — Supabase rechazó la escritura:', resultado.error)
              return respuestaTexto('No fue posible actualizar tu grado o grupo en este momento. Intenta de nuevo en unos segundos.')
            }
            const gradoFinal = gradoSolicitado ?? resultado.anterior.grado
            const grupoFinal = grupoSolicitado ?? resultado.anterior.grupo
            const etiqueta = gradoFinal && grupoFinal ? `${gradoFinal} ${grupoFinal}` : gradoFinal || grupoFinal || 'actualizado'
            console.log(`[NIVEL0] actualizar_perfil_docente OK — grado=${gradoFinal ?? '(sin cambio)'} grupo=${grupoFinal ?? '(sin cambio)'} (anterior: grado=${resultado.anterior.grado ?? 'ninguno'} grupo=${resultado.anterior.grupo ?? 'ninguno'})`)
            // [[PERFIL_ACTUALIZADO]]: señal (sin datos propios) para que
            // el cliente vuelva a leer perfiles_docentes — ver
            // procesarMarcadorDePerfilActualizado en motorTextoClaude.ts
            // y EstadoAsistente.perfil en AsistenteService.ts. Así el
            // menú lateral, /dashboard/inicio y cualquier otra pantalla
            // dejan de mostrar el grado/grupo anterior sin recargar la
            // página.
            return respuestaTexto(`Listo. El grupo activo ahora es ${etiqueta}. A partir de este momento toda la información y los documentos se generarán utilizando ese grado.\n[[PERFIL_ACTUALIZADO]]`)
          } catch (e) {
            console.error('[NIVEL0] actualizar_perfil_docente — excepción escribiendo:', e)
            return respuestaTexto('No fue posible actualizar tu grado o grupo en este momento. Intenta de nuevo en unos segundos.')
          }
        }
      }

      // Nivel 1: consultar_alumno_lista / navegar_alumno_lista — "no
      // debe cambiar automáticamente de pantalla" vs. "sí debe
      // navegar" (ver DIFERENCIA ENTRE CONSULTAR Y NAVEGAR del RFC de
      // navegación). Ninguna de las dos escribe nada — un mensaje de
      // texto real + un marcador técnico con la AccionNavegacion, que
      // el cliente (motorTextoClaude.ts) extrae y AsistentePanel
      // ejecuta con router.push. `automatica` es lo único que decide
      // si el docente ve un botón "Abrir en Lista" o si ya navegó.
      if (
        (clasificacion.intencion_principal === 'consultar_alumno_lista' || clasificacion.intencion_principal === 'navegar_alumno_lista') &&
        clasificacion.nivel_ejecucion === 1
      ) {
        const alumnoId = clasificacion.entidades_resueltas.alumno_id
        const nombreReal = clasificacion.entidades_resueltas.alumno_nombre_detectado

        if (clasificacion.entidades_resueltas.alumno_ambiguo && clasificacion.entidades_resueltas.opciones_alumno_ambiguo.length > 0) {
          console.log(`[NIVEL0] ${clasificacion.intencion_principal} — alumno ambiguo: ${clasificacion.entidades_resueltas.opciones_alumno_ambiguo.join(', ')}`)
          return respuestaTexto(`¿Te refieres a ${clasificacion.entidades_resueltas.opciones_alumno_ambiguo.join(' o a ')}?`)
        }

        if (!alumnoId || !nombreReal) {
          console.log(`[NIVEL0] ${clasificacion.intencion_principal} sin alumno_id resuelto — cae al flujo normal`)
        } else {
          const esNavegar = clasificacion.intencion_principal === 'navegar_alumno_lista'
          const accionNavegacion: AccionNavegacion = {
            modulo: 'lista',
            accion: 'abrir_registro',
            alumnoId,
            pestana: clasificacion.pestana_lista ?? undefined,
            automatica: esNavegar,
          }
          const marcador = `[[NAVEGACION:${Buffer.from(JSON.stringify(accionNavegacion), 'utf-8').toString('base64')}]]`
          const texto = esNavegar
            ? `Abriendo a ${nombreReal} en Lista.`
            : `${nombreReal} está en tu grupo activo.`
          console.log(`[NIVEL0] ${clasificacion.intencion_principal} OK — alumno_id=${alumnoId} pestana=${clasificacion.pestana_lista ?? '(ninguna)'}`)
          return respuestaTexto(`${texto}\n${marcador}`)
        }
      }

      // consultar_incidencias_alumno ya se resolvió arriba, en
      // ejecutarHerramientaDeModulo — ver lib/asistente/herramientasModulo.ts.

      // Nivel 1: navegar_lista_filtrada — igual que navegar_alumno_lista
      // pero a nivel de módulo completo (sin alumnoId), con un filtro
      // ya aplicado (ver AccionNavegacion.filtros — declarado desde la
      // etapa de navegación pero sin ningún productor real hasta ahora).
      if (clasificacion.intencion_principal === 'navegar_lista_filtrada' && clasificacion.nivel_ejecucion === 1) {
        const filtro = clasificacion.filtro_lista ?? 'todos'
        const accionNavegacion: AccionNavegacion = {
          modulo: 'lista',
          accion: 'abrir_modulo',
          filtros: { filtro },
          // Aditivo — ver "ventana contextual de Lista filtrada desde
          // el Chat IA". sesion.grupo_activo_id ya está resuelto en
          // este punto (obtenerSesionContexto, más arriba) — nunca una
          // consulta nueva. Permite que la sheet del cliente consulte
          // roster/asistencia sin volver a resolver el grupo activo.
          grupoId: sesion.grupo_activo_id,
          automatica: true,
        }
        const marcador = `[[NAVEGACION:${Buffer.from(JSON.stringify(accionNavegacion), 'utf-8').toString('base64')}]]`
        const etiquetaFiltro: Record<string, string> = { ausentes: 'los ausentes', presentes: 'los presentes', ninas: 'las niñas', ninos: 'los niños', todos: 'toda la lista' }
        console.log(`[NIVEL0] navegar_lista_filtrada OK — filtro=${filtro}`)
        return respuestaTexto(`Mostrando ${etiquetaFiltro[filtro] ?? 'la lista'}.\n${marcador}`)
      }

      // Nivel 4: ficha_descriptiva / planeacion_generar / consultar_calendario
      // — estos tres siguen pasando por Claude a propósito (generación
      // real de un documento, o razonamiento sobre un rango de fechas
      // en lenguaje natural), pero SIEMPRE con datos reales ya
      // inyectados, nunca a ciegas. Las consultas de cifra fija
      // (asistencia, incidencias, apoyo, documentos) ya NO viven aquí
      // — se resuelven arriba, en ejecutarHerramientaDeModulo, sin
      // pasar nunca por el modelo grande (ver
      // lib/asistente/herramientasModulo.ts).
      if ((clasificacion.nivel_ejecucion === 4 && clasificacion.requiere_contexto_memoria) || esComparacionVisualDeAlumno) {
        try {
          if (clasificacion.intencion_principal === 'ficha_descriptiva' && clasificacion.entidades_resueltas.alumno_id && sesion.ciclo_escolar_id) {
            const ctxAlumno = await contextoAlumno(supabaseUser, clasificacion.entidades_resueltas.alumno_id, sesion.ciclo_escolar_id)
            contextoEnriquecido += `\n\nCONTEXTO REAL DEL ALUMNO (usa estos datos, no inventes otros):\n${JSON.stringify(ctxAlumno)}`
          } else if (clasificacion.intencion_principal === 'planeacion_generar' && sesion.grupo_activo_id) {
            // C-005, Paso 3B — reemplaza lo que antes era planeacion_nueva
            // (solo inyectaba contextoGrupo). Ahora también calcula fechas
            // reales (calcularFechasPlaneacion, única autoridad — ver
            // lib/planeacion/generarBorrador.ts), resuelve el periodo de
            // evaluación vigente y trae un resumen de planeaciones previas
            // para evitar repetir tema — todo de solo lectura, sin
            // persistir nada en este paso.
            const resultadoGeneracion = await prepararContextoGeneracionPlaneacion(supabaseUser, sesion, {
              tema: clasificacion.tema_planeacion,
              fechaInicio: clasificacion.fecha_inicio_planeacion,
              fechaFin: clasificacion.fecha_fin_planeacion,
              duracionDias: clasificacion.duracion_dias_planeacion,
              duracionSemanas: clasificacion.duracion_semanas_planeacion,
              momentoRelativo: clasificacion.momento_relativo_planeacion,
            })
            contextoEnriquecido += `\n\nCONTEXTO REAL PARA GENERAR LA PLANEACIÓN (usa estos datos, no inventes otros):\n${JSON.stringify(resultadoGeneracion)}`
            contextoEnriquecido += `\n\n${INSTRUCCIONES_PLANEACION_GENERAR}`
            esTurnoDeBorradorPlaneacion = true
            console.log(
              `[NIVEL4][planeacion_generar] calendarioConsultado=true diasExcluidosPorCalendario=${resultadoGeneracion.eventosCalendarioDelPeriodo.length} cicloEscolarPresente=${!!sesion.ciclo_escolar_id} periodoEvaluacionPresente=${!!resultadoGeneracion.periodoEvaluacionActual} conflicto=${resultadoGeneracion.fechas.conflicto} totalDiasEfectivos=${resultadoGeneracion.fechas.totalDiasEfectivos}`
            )
          } else if (clasificacion.intencion_principal === 'planeacion_generar' && !sesion.grupo_activo_id) {
            // Docente autenticado (auth.getUser() sí devolvió usuario)
            // pero sin grupo activo asociado — ver "CORRECCIÓN CRÍTICA
            // — DOCENTE NO IDENTIFICADO": error controlado y
            // determinista, nunca se le pide al docente grado/grupo
            // por chat (esos datos no se inventan aquí, se resuelven
            // solos cuando existan) y nunca se deja que Claude
            // improvise una respuesta genérica como si tuviera acceso.
            console.log(`[NIVEL4][planeacion_generar] sin grupo activo — docenteIdPresente=true grupoIdPresente=false`)
            return respuestaTexto('No encontré un grupo activo asociado a tu cuenta. Verifica que tengas un grupo configurado en la aplicación.')
          } else if (clasificacion.intencion_principal === 'consultar_calendario' && userId) {
            // Ciclo completo (no solo "próximos 10") para que el Chat IA
            // pueda responder cualquier pregunta natural sobre el
            // calendario — de esta semana, de este mes, ya pasada, o de
            // más adelante en el ciclo — sin depender de que el docente
            // diga explícitamente "revisa el calendario". Mismo cálculo
            // de ciclo escolar (agosto→julio) que ya usa
            // app/api/calendario/analizar/route.ts.
            const { anio, mes } = obtenerFechaHora(zonaHoraria)
            const inicioAnioCiclo = mes >= 8 ? anio : anio - 1
            const inicioCiclo = `${inicioAnioCiclo}-08-01`
            const finCiclo = `${inicioAnioCiclo + 1}-07-31`
            const eventosCiclo = await calendarioCicloCompleto(supabaseUser, userId, inicioCiclo, finCiclo)
            const eventosConCategoria = eventosCiclo.map((e) => ({
              titulo: e.titulo,
              fecha: e.fecha,
              categoria: categoriaEventoCalendario(e),
            }))
            contextoEnriquecido += `\n\nCALENDARIO ESCOLAR COMPLETO DEL CICLO ${inicioAnioCiclo}-${inicioAnioCiclo + 1} (usa estos datos reales para responder cualquier pregunta sobre fechas, actividades o eventos escolares — de hoy (${sesion.fecha_actual}), de esta semana, de este mes, ya pasados, o de más adelante en el ciclo; no inventes otros; si no hay eventos en el rango que se pregunta, dilo con honestidad; distingue siempre en tu respuesta entre eventos oficiales SEP y actividades propias que el maestro agregó — nunca los mezcles sin indicarlo):\n${JSON.stringify(eventosConCategoria)}`
          } else if (esComparacionVisualDeAlumno && sesion.ciclo_escolar_id) {
            // Ver "ajuste mínimo de clasificación para imagen adjunta" y
            // "diseñar una condición determinista y única" — única forma
            // de llegar aquí: el predicado esComparacionVisualDeAlumno
            // (declarado arriba, antes del bloque de aclaración, misma
            // señal reutilizada en el bypass de la Herramienta) ya
            // garantiza intención/modo/alumno_id/campo — solo falta
            // aquí el ciclo escolar para poder consultar. Reutiliza
            // contextoAlumno, la MISMA función que ya usa
            // herramientaCorregirDatoAlumno para el camino de solo
            // texto — una sola fuente de verdad del valor real
            // registrado.
            const ctxAlumnoComparar = await contextoAlumno(supabaseUser, clasificacion.entidades_resueltas.alumno_id!, sesion.ciclo_escolar_id)
            const datosPersonalesComparar = (ctxAlumnoComparar as { datos_personales?: Record<string, string | null> })?.datos_personales ?? {}
            const valorRegistradoComparar = datosPersonalesComparar[clasificacion.campo_alumno_corregir!] ?? null
            contextoEnriquecido += `\n\nCOMPARACIÓN DE DATO PERSONAL DE ALUMNO CONTRA UNA IMAGEN ADJUNTA (ver "ajuste mínimo de clasificación para imagen adjunta"):\nEl maestro adjuntó una imagen para comparar el campo "${clasificacion.campo_alumno_corregir}" del alumno "${clasificacion.entidades_resueltas.alumno_nombre_detectado}".\nValor REAL ya registrado en la aplicación para ese campo (no lo inventes, es el dato real): ${valorRegistradoComparar ?? '(no hay ningún valor registrado todavía para este campo)'}.\nAunque la Lista de alumnos general de arriba no muestre este dato personal (se omite ahí a propósito, por privacidad — nunca expone CURP/sexo/fecha de nacimiento de todo el grupo en cada turno), eso NO significa que el dato no esté registrado: para ESTA comparación específica, el valor de arriba es el valor real y completo consultado directamente para este alumno, y tiene prioridad total sobre la ausencia de ese campo en la lista general. Si el valor de arriba no es "(no hay ningún valor registrado todavía para este campo)", úsalo como fuente de verdad para comparar — nunca digas que no tienes ese dato o que no está registrado.\nLee el valor real que aparece en la imagen adjunta y compáralo EXACTAMENTE, carácter por carácter, contra el valor registrado de arriba. Responde ÚNICAMENTE con: el valor que leíste en la imagen, el valor registrado, y si coinciden o no. Esto es EXCLUSIVAMENTE de solo lectura: bajo ninguna circunstancia propongas, apliques, confirmes ni des a entender que ya aplicaste ninguna corrección en este turno — ni siquiera si el maestro pide corregirlo explícitamente en este mismo mensaje; en ese caso dile que puede pedir la corrección por separado, dándote el valor correcto en un mensaje aparte, una vez que confirmen juntos cuál es.`
            console.log(`[NIVEL4][corregir_dato_alumno][comparar+imagen] alumno_id=${clasificacion.entidades_resueltas.alumno_id} campo=${clasificacion.campo_alumno_corregir} valorRegistradoPresente=${valorRegistradoComparar !== null}`)
          } else {
            // Diagnóstico obligatorio (ver "Corrección de arquitectura —
            // lectura real del módulo de Asistencias"): antes, si la
            // intención se clasificaba bien pero la condición extra de
            // la rama (sesion.grupo_activo_id, sesion.ciclo_escolar_id,
            // userId, alumno_id) venía falsa, ninguna rama del if/else-if
            // de arriba coincidía y el enriquecimiento se saltaba EN
            // SILENCIO — nada en los logs distinguía "no era este
            // intent" de "era este intent pero faltó un dato". Con esto,
            // cualquier caso futuro similar (Incidencias, Evaluaciones,
            // Fichas, Historial, lo que sea) queda diagnosticable de
            // inmediato en vercel logs en vez de otra ronda de reportar
            // "el Chat dice que no tiene acceso" a ciegas.
            console.log(
              `[NIVEL4] ${clasificacion.intencion_principal} clasificado pero SIN enriquecer — grupo_activo_id=${sesion.grupo_activo_id ?? 'null'} ciclo_escolar_id=${sesion.ciclo_escolar_id ?? 'null'} userId=${userId ? 'presente' : 'null'} alumno_id=${clasificacion.entidades_resueltas.alumno_id ?? 'null'}`
            )
          }
        } catch (e) {
          console.error('Error ensamblando contexto Nivel 4:', e)
          // Si falla, seguimos sin el contexto enriquecido en vez de romper la respuesta.
        }
      }
    } catch (e) {
      console.error('Error en Clasificador de Nivel 0, continuando con flujo normal:', e)
      if (diagnosticoCurpActivo) {
        trazaDebug.etapa = 'error en el bloque Nivel 0'
        trazaDebug.resultado = 'error'
        trazaDebug.tipoError = e instanceof Error ? e.name : 'desconocido'
      }
    }
  }
  // --- Fin Clasificador de Nivel 0 ---

  // FASE 2B2B2 (ver "convertir_documento desde referente textual") —
  // ejecución determinista PRE-conversacional: si todas las
  // condiciones se cumplen, termina el request aquí mismo con el
  // archivo real (mismo respuestaTexto/marcador [[DOCUMENTO_ARCHIVO:...]]
  // que ya usa CASO 3 más abajo) y NUNCA llega a la llamada Sonnet
  // conversacional de abajo. Nunca usa el header/short-circuit de
  // 2B2A (esto no es una decisión que el cliente ejecute — se resuelve
  // enteramente aquí, en el mismo response que Nivel0 ya iba a dar).
  // Cualquier fallo en cualquier paso (fila no encontrada, error de
  // Supabase, texto vacío, contenido no reutilizable, formato no
  // conectado) dejar simplemente de activar esta rama — jamás convierte
  // contenido aproximado, jamás lanza error nuevo al maestro por esta
  // fase: el flujo normal de abajo continúa exactamente como si esta
  // fase no existiera.
  // REUBICACIÓN (ver "corrección arquitectónica — alcanzabilidad de
  // 2B2B2"): posicionado aquí, ANTES de CASO 3 (más abajo, gate por
  // tipoHerramientaSolicitado), a propósito — tipoHerramientaSolicitado
  // se calcula muy temprano en la función y permanece verdadero durante
  // toda la ejecución incluso cuando la "red de seguridad" temprana no
  // encontró contenido recuperable; como CASO 3 siempre retorna en
  // cualquiera de sus caminos internos, 2B2B2 nunca podía alcanzarse
  // estando después de él. Ninguna lógica de este bloque cambió — solo
  // su posición en el archivo.
  if (esCandidataConvertirDocumento && referenteIdParaConvertirDocumento && supabaseUser && userId) {
    try {
      // CORRECCIÓN — "conversacionIdReferente siempre null" (ver
      // diagnóstico real: contexto llega como string, nunca como objeto
      // con conversacionId, así que ese filtro nunca podía coincidir —
      // PostgREST 22P02 contra la columna uuid/not-null, filaValida
      // siempre false). id ya es PRIMARY KEY (text) en mensajes_chat, y
      // supabaseUser corre con RLS real del docente (docente_id =
      // auth.uid()) — el filtro por id solo, bajo ese cliente, es
      // inequívoco y suficiente sin necesitar conversacion_id.
      const { data: filaReferente, error: errorReferente } = await supabaseUser
        .from('mensajes_chat')
        .select('rol, texto, contenido')
        .eq('id', referenteIdParaConvertirDocumento)
        .maybeSingle()

      const contenidoFila = (filaReferente?.contenido ?? {}) as Record<string, unknown>
      const filaValida =
        !errorReferente &&
        !!filaReferente &&
        filaReferente.rol === 'asistente' &&
        !!filaReferente.texto?.trim() &&
        !contenidoFila.archivo &&
        !(Array.isArray(contenidoFila.archivos) && contenidoFila.archivos.length > 0) &&
        !contenidoFila.resultadoEmbebido &&
        !contenidoFila.esOperativo

      if (!filaValida) {
        console.log('[CONVERTIR_DOCUMENTO] ejecutado=false motivo=referente_no_disponible')
      } else {
        console.log('[CONVERTIR_DOCUMENTO] referente_recuperado=true')
        // Mismo detector determinista ya existente (ver CASO 3 y el
        // camino léxico de documentoActivo) — nunca uno nuevo. El
        // router semántico ya decidió "convertir este contenido"; este
        // detector solo resuelve A QUÉ FORMATO, exactamente como ya lo
        // hace hoy para el resto de la aplicación.
        const formatoResuelto = detectarHerramientaDocumento(mensaje || '')
        if (formatoResuelto === 'word' || formatoResuelto === 'pdf' || formatoResuelto === 'powerpoint') {
          const { data: perfil } = await supabaseUser.from('perfiles_docentes').select('*').eq('id', userId).single()
          const archivo = await conReintento(
            () => ejecutarHerramientaDocumento(formatoResuelto, filaReferente.texto, perfil, zonaHoraria, supabaseRAG, userId, supabaseUser, null, null),
            'convertir-documento-referente'
          )
          const marcador = `[[DOCUMENTO_ARCHIVO:${Buffer.from(JSON.stringify(archivo), 'utf-8').toString('base64')}]]`
          const marcadorContenido = `[[DOCUMENTO_CONTENIDO:${Buffer.from(filaReferente.texto, 'utf-8').toString('base64')}]]`
          console.log(`[CONVERTIR_DOCUMENTO] ejecutado=true formato=${formatoResuelto}`)
          return respuestaTexto(`Documento generado correctamente.\n${marcador}\n${marcadorContenido}`)
        }
        console.log(`[CONVERTIR_DOCUMENTO] ejecutado=false motivo=formato_no_conectado formato=${formatoResuelto ?? 'null'}`)
      }
    } catch (err) {
      console.error('[CONVERTIR_DOCUMENTO] Error recuperando/ejecutando la conversión — continuando flujo normal:', err)
    }
  }

  if (diagnosticoCurpActivo && trazaDebug.etapa === 'clasificación Nivel 0 completa') {
    // Solo actualiza la etapa si nada más concluyente ya la cambió
    // (herramienta ejecutada o error) — evita pisar información útil.
    trazaDebug.etapa = 'fin del bloque Nivel 0 sin respuesta directa — continúa al flujo normal/Nivel 4'
  }
  if (diagnosticoCurpActivo && trazaDebug.msTotalServidor === null) {
    // Este punto solo se alcanza cuando NADA respondió antes (ninguna
    // Herramienta directa, ninguna aclaración) — el request va a
    // continuar hacia Nivel 4. Se marca aquí, antes de esa llamada real
    // a Claude, nunca después (para no confundir "se intentó" con "ya
    // terminó").
    trazaDebug.msAntesNivel4 = Date.now() - inicioRequestMs
    trazaDebug.nivel4Ejecutado = true
  }

  // RESTRICCIÓN ESTRUCTURAL DE FUENTES (ver "Prohibir afirmaciones de
  // capacidades inexistentes — arquitectura, no filtro de texto"): en
  // vez de una lista de frases prohibidas, se calculan aquí — a partir
  // del estado REAL de esta petición, no de palabras — qué fuentes de
  // información existen de verdad en este turno, y se declaran como
  // hecho, en positivo y en negativo. Nunca se revisa el texto que
  // Claude genera después; esto se decide ANTES de que genere nada.
  // Las fuentes que jamás han existido en esta aplicación (cámara,
  // pantalla, sensores) se declaran una sola vez, siempre, como un
  // hecho permanente de la aplicación — no como una lista de frases a
  // evitar que hay que seguir ampliando cada vez que aparece una
  // nueva forma de decirlo. tieneImagenAdjunta/cantidadImagenesAdjuntas
  // ya se calcularon arriba, antes del Clasificador de Nivel 0 (los
  // necesita como guardia de ejecutarHerramientaDeModulo) — una sola
  // fuente de verdad, no se vuelven a calcular aquí.
  const tieneDatosDeModuloInyectados = Boolean(contextoEnriquecido && contextoEnriquecido.trim())
  const fuentesDisponiblesTexto = `
FUENTES REALES DE INFORMACIÓN EN ESTE TURNO — declaración exacta del estado real de esta conversación, no una sugerencia de estilo. Cualquier afirmación que hagas sobre lo que "ves", "observas", "detectas" o "tienes acceso a" debe corresponder EXACTAMENTE a una fuente marcada como disponible abajo. Si algo no aparece aquí como disponible, no existe para ti en este turno — no lo asumas, no lo actúes, no lo insinúes.
- Conversación del maestro en este chat: disponible (siempre).
- Conocimiento general/pedagógico propio: disponible (siempre).
- Imagen(es) adjunta(s) a ESTE mensaje: ${tieneImagenAdjunta ? `disponible — ${cantidadImagenesAdjuntas} imagen(es) real(es) que el maestro adjuntó en este mensaje` : 'NO disponible — el maestro no adjuntó ninguna imagen en este mensaje; nunca digas que estás viendo o analizando una imagen'}.
- Datos reales de un módulo interno ya consultados para responder este turno (asistencia, alumnos, calendario, documentos, etc.): ${tieneDatosDeModuloInyectados ? 'disponible — ver DATOS DEL MAESTRO más abajo' : 'NO disponible — ningún módulo interno se consultó para este turno; si la pregunta necesitaba ese dato y no aparece abajo, dilo con honestidad en vez de inventar una cifra'}.

FUENTES QUE NO EXISTEN EN ESTA APLICACIÓN — no son "no disponibles ahora", son funcionalidades que Docente IA nunca ha tenido, en ningún punto, bajo ninguna circunstancia: cámara del dispositivo, transmisión de video o audio en vivo, lectura de la pantalla del maestro, sensores del salón, reconocimiento visual del aula en tiempo real. Nunca actúes, ni por un instante, como si alguna de estas existiera — sin importar cómo esté redactada la pregunta del maestro.
`

  // Red de seguridad adicional: buscarContextoRAG ya protege su propia
  // llamada a OpenAI con timeout, pero la consulta RPC a Supabase que
  // sigue después (buscar_chunks_similares) no tiene uno propio — este
  // límite cubre esa parte también sin tener que tocar la función.
  const contextoRAG = await conLimiteDeTiempo(contextoRAGPromise, TIMEOUT_RAG_MS + 5_000, 'Tiempo de espera agotado en la búsqueda de contexto RAG').catch(() => '')

  // Fecha, hora y ciclo escolar reales — SIEMPRE en la zona horaria real
  // del dispositivo del maestro (mandada por el cliente, ver
  // motorTextoClaude.ts / motorOpenAIRealtime.ts), nunca una zona fija.
  // Un valor fijo como "America/Mexico_City" producía desfases de hasta
  // 2 horas para un maestro en cualquier otra zona de México (Mazatlán,
  // Tijuana, Cancún) — ver lib/tiempo/TimeService.ts, único lugar del
  // proyecto que calcula esto.
  const infoFechaHora = obtenerFechaHora(zonaHoraria)
  const cicloEscolar = infoFechaHora.cicloEscolar

  let contextoProceso = `

INSTRUCCION SOBRE TAREAS LARGAS DE VARIOS ELEMENTOS: esto SOLO aplica cuando el maestro pide explícitamente varios documentos SEPARADOS en la misma solicitud (ejemplo: "hazme las fichas descriptivas de estos 5 alumnos", "hazme examenes de 3 temas distintos", "planeaciones de las próximas 4 semanas") — cada elemento sería, por sí solo, un documento completo. NO aplica a un solo documento que internamente tenga varias partes (un examen con varios reactivos, una planeación con varios días, una lectura con varias preguntas de comprensión) — eso es UN solo documento y se entrega completo en una sola respuesta, sin marcador. Solo cuando de verdad se pidieron varios documentos separados: identifica cuántos se piden en total y genera SOLO el elemento actual en tu respuesta (no todos de golpe, salvo que el maestro pida explícitamente todos juntos). Al final de tu respuesta, en su propia línea, incluye exactamente este marcador técnico que el maestro nunca verá en pantalla: [[PROCESO:tipo=NOMBRE_CORTO_DE_LA_TAREA;actual=NUMERO_DEL_ELEMENTO_QUE_ACABAS_DE_GENERAR;total=TOTAL_DE_ELEMENTOS;estado=activo_si_faltan_mas_o_completado_si_es_el_ultimo]]. Si la tarea no es de varios documentos separados en serie, NO incluyas ningún marcador.`

  if (userId) {
    const proceso = await conLimiteDeTiempo(procesoActivoPromise, TIMEOUT_SESION_MS, 'Tiempo de espera agotado consultando el proceso activo').catch(() => null)

    if (proceso) {
      contextoProceso = `\n\nPROCESO ACTIVO EN CURSO (el maestro ya empezo esta tarea, NO la reinicies, continua exactamente donde se quedo salvo que el maestro pida algo distinto):
Tipo: ${proceso.tipo_proceso}
Contexto guardado: ${JSON.stringify(proceso.contexto)}
Si el mensaje del maestro es una instruccion para continuar (ej: continua, sigue, el siguiente, haz el que sigue), retoma exactamente desde el punto guardado usando el mismo formato y estilo. Al terminar cada elemento de una tarea larga, incluye al final de tu respuesta, en su propia linea, exactamente este marcador (el maestro nunca vera esta linea): [[PROCESO:tipo=${proceso.tipo_proceso};actual=NUMERO;total=TOTAL;estado=activo_o_completado]]`
    }
  }

  // FASE 1 — "Diagnóstico y Plan de Optimización del Pipeline de Voz":
  // instrucciones ADICIONALES, solo para el turno actual, cuando viene
  // del modo voz (channel==="voice", mandado por
  // MotorOpenAIRealtime.finalizarTurno() vía enviarComoMensaje). El
  // prompt general de arriba NO se modifica ni se reordena — esto se
  // concatena al final, así que nunca cambia el comportamiento del chat
  // escrito (channel ausente/"text").
  const bloqueVoz = channel === 'voice' ? `

MODO VOZ ACTIVO — este turno viene de una conversación hablada, no escrita (el maestro habló, la app transcribió, y tu respuesta se va a leer en voz alta automáticamente). Ajusta el estilo SOLO para este turno:
- Responde de forma directa y conversacional, como lo dirías en voz alta, no como un documento.
- Usa normalmente entre una y tres frases.
- Da primero el dato concreto que se pidió, sin preámbulo.
- Evita listas extensas salvo que el maestro las haya pedido explícitamente.
- No repitas el nombre del maestro en cada turno.
- No agregues saludos ni despedidas si el turno no es puramente social.
- No cierres la respuesta con "¿en qué más te ayudo?" ni frases equivalentes de cierre genérico.
- No expliques detalles técnicos internos de la aplicación (voz, transcripción, TTS, conexión).
- Nunca inventes ni sugieras causas técnicas del dispositivo del maestro (volumen, permisos, configuración, batería, conexión) — no tienes esa información real; si algo de voz falló, eso lo maneja la aplicación, no tu respuesta.
- Amplía la respuesta únicamente cuando la tarea en sí lo requiera (una planeación, un documento, una explicación pedida) o el maestro pida explícitamente más detalle.
Ejemplos: "¿Cuántos faltaron?" → "Faltaron cinco alumnos." "¿Cuántas niñas y niños tengo?" → "Tienes doce niñas y dieciséis niños." "¿Quiénes faltaron?" → solo los nombres. "Dame el reporte completo." → ahí sí, el reporte completo.` : ''

  // "Consultar información oficial vigente de la SEP" — instrucciones
  // ADICIONALES, solo para el turno actual, cuando el Clasificador de
  // Nivel 0 (regla 18) autorizó el uso de la herramienta de búsqueda
  // oficial. El prompt general NO se modifica — esto se concatena al
  // final, igual que bloqueVoz, así que un turno sin
  // requiereConsultaOficial nunca ve este texto ni la herramienta.
  const bloqueConsultaOficial = requiereConsultaOficial ? `

CONSULTA DE INFORMACIÓN OFICIAL VIGENTE — este turno SÍ tiene acceso a la herramienta web_search, restringida por la propia plataforma a fuentes oficiales (gob.mx, sep.gob.mx, dof.gob.mx) — ese mismo comodín gob.mx ya cubre otras dependencias oficiales mexicanas cuando el hecho les corresponde (ej. semar.gob.mx para la Armada, cultura.gob.mx/inah.gob.mx para historia y patrimonio, segob.gob.mx, presidencia.gob.mx), nunca te limites a pensar que solo puedes consultar SEP. Tienes terminantemente PROHIBIDO decir "no tengo acceso a internet" o cualquier frase equivalente — si la pregunta es sobre calendario escolar oficial, ciclo escolar, planes y programas, campos formativos, lineamientos, normas, trámites o acuerdos SEP/DOF, o sobre efemérides, conmemoraciones oficiales o acontecimientos cívicos/históricos reconocidos (ver "corrección — Docente IA fabricó efemérides incorrectas" y la regla DÍAS DE LA SEMANA más arriba, mismo principio de no inventar aplicado aquí a los hechos completos), USA la herramienta antes de responder. EJECUTA LA BÚSQUEDA PRIMERO, REDACTA DESPUÉS — nunca empieces a afirmar una fecha o un hecho de este tipo desde tu memoria para "corregirte" después con el resultado real de la búsqueda; espera el resultado antes de escribir cualquier afirmación factual de calendario/efemérides. Nunca respondas una fecha o dato oficial solo por tu conocimiento general ("normalmente termina a finales de julio") — usa siempre el resultado real de la búsqueda. Prioriza: 1) el documento/fuente oficial vigente más reciente y pertinente al hecho (la dependencia correcta según el tema, no siempre SEP), 2) su fecha de publicación o actualización, 3) la autoridad responsable (SEP federal vs. autoridad educativa estatal, u otra dependencia oficial según corresponda), 4) el ciclo escolar/fecha exacta que preguntó el maestro. Si el calendario federal y el estatal difieren, explica ambos con claridad e indica cuál aplica. En tu respuesta de chat escrito, cita la fuente y autoridad (ej. "Fuente: calendario oficial SEP, publicado el [fecha]"). Si te piden una LISTA de varias efemérides, cada una debe estar respaldada por lo que realmente encontraste en la búsqueda — si la fecha o el hecho de alguna no aparece en los resultados, tienes PROHIBIDO completarla con tu propio conocimiento: omítela de la lista, o dilo explícitamente ("No pude verificar la efeméride de ese día con las fuentes disponibles") — nunca la inventes solo para no dejar un día sin efeméride. Si la búsqueda no encuentra el dato o falla, dilo con honestidad ("No pude consultar la fuente oficial en este momento. No quiero darte una fecha sin verificar.") — nunca inventes una fecha para no dejar la pregunta sin respuesta.` : ''

  // MODO IMAGEN (ver "Implementar en Docente IA la capacidad de
  // generar imágenes...", Fase 0+1) — mismo criterio que bloqueVoz/
  // bloqueConsultaOficial: instrucciones ADICIONALES solo para este
  // turno, cuando ya se detectó que el maestro pide una imagen suelta
  // (tipoHerramientaSolicitado==='imagen', ver CASO 3 más abajo). El
  // prompt general NO se modifica — un turno normal nunca ve este
  // bloque.
  const bloqueModoImagen = tipoHerramientaSolicitado === 'imagen' ? `

MODO IMAGEN ACTIVO — el maestro pidió una imagen suelta (no un documento). Tu ÚNICA salida en este turno debe ser una descripción visual clara y vívida de la ilustración, en un solo párrafo corto (2-4 frases), en español, lista para dársela directo a un generador de imágenes. NUNCA escribas título, emoji, viñetas, ni MODO DOCUMENTO. NUNCA escribas frases de confirmación ("Claro, aquí tienes...", "Perfecto...") ni expliques qué vas a hacer — tu respuesta ES la descripción, nada más. Enriquece la petición del maestro con detalle pedagógico útil (qué debe verse, qué elementos incluir, qué transmitir) pero sin inventar contenido ajeno a lo que pidió. Nunca digas que no puedes generar imágenes — esta aplicación sí genera la imagen real a partir de tu descripción.` : ''

  // MODO DOCUMENTO ILUSTRADO (ver "Documentos ilustrados + guías
  // completas e ilustradas", Fase 2A) — mismo criterio que
  // bloqueModoImagen: instrucciones ADICIONALES solo para este turno,
  // cuando el maestro pidió un documento (word/pdf) CON ilustraciones
  // (ver quiereIlustracion). Un documento normal (sin esas palabras)
  // nunca ve este bloque — sigue exactamente igual que siempre.
  const esDocumentoIlustrado = (tipoHerramientaSolicitado === 'word' || tipoHerramientaSolicitado === 'pdf') && quiereIlustracion(mensaje || '')

  // NIVEL EDUCATIVO (ver "Ilustraciones por nivel educativo, Fase 1 —
  // diseño + implementación base"): resuelto de forma determinista
  // (nunca por IA) a partir de lo que el maestro escribió en ESTE
  // mensaje, o si no dijo nada, del grupo activo real (ver
  // lib/sesionContexto.ts — nivel_educativo_grupo/grado_grupo, ya
  // existían en la tabla grupos y ahora se leen de vuelta). null
  // (ningún nivel resuelto) preserva el comportamiento anterior
  // exacto: sin bloque de sistema extra, sin estilo visual forzado.
  const nivelEducativoResuelto = resolverNivelEducativo({
    textoMensaje: mensaje || '',
    grupoActivo: sesion ? { nivelEducativoGrupo: sesion.nivel_educativo_grupo, gradoGrupo: sesion.grado_grupo } : undefined,
  })
  const perfilNivelEducativo = nivelEducativoResuelto ? obtenerPerfilNivel(nivelEducativoResuelto) : null
  // Usado más abajo (CASO 3) para las ilustraciones de este documento
  // — undefined cuando no se resolvió nivel, que es exactamente lo que
  // generarImagen() ya interpreta como "usa el estilo por defecto".
  const estiloVisualNivelEducativo = perfilNivelEducativo?.estiloVisual
  const bloqueNivelEducativo = perfilNivelEducativo ? `

NIVEL EDUCATIVO DETECTADO PARA ESTE DOCUMENTO: ${perfilNivelEducativo.etiqueta}. Cuando redactes un documento educativo en este turno (examen, guía, ficha, hoja de actividades, material ilustrado), ajusta el tono y la densidad de texto a este nivel: ${perfilNivelEducativo.instruccionRedaccion} Tipos de actividad apropiados para este nivel, cuando el tipo de documento lo permita: ${perfilNivelEducativo.tiposActividadSugeridos.join(', ')}. Esto NUNCA cambia el formato fijo de cada tipo de documento (título, estructura y secciones ya definidas abajo) — solo ajusta el tono, la extensión y el estilo de redacción dentro de ese formato.` : ''
  const bloqueDocumentoIlustrado = esDocumentoIlustrado ? `

MODO DOCUMENTO ILUSTRADO ACTIVO — el maestro pidió este documento CON ilustraciones. Sigue exactamente las reglas de MODO DOCUMENTO de abajo (título en mayúsculas y emoji, secciones, viñetas), pero además: en los puntos donde una ilustración realmente ayude a entender o hacer más atractivo el contenido (nunca decorativa sin propósito), inserta una línea SOLA con EXACTAMENTE este formato, sin variaciones:
[[IMAGEN: descripción clara y específica de qué debe mostrar la ilustración, en español]]
Ejemplo real de una línea correcta, tal cual, en su propio renglón, sin nada antes ni después:
[[IMAGEN: dibujo infantil y colorido de una planta señalando raíz, tallo, hoja y flor, fondo blanco]]
Máximo 4 líneas [[IMAGEN:...]] en todo el documento — nunca satures de imágenes, prioriza equilibrio entre texto e imagen. Cada descripción debe ser específica y apropiada para el grado/tema del documento (ej. estilo infantil y simple para primaria baja, ilustraciones didácticas para ciencias, línea limpia para material "para colorear" si el maestro lo pidió así). PROHIBIDO escribir "Ilustración:", "Imagen:", una descripción en prosa, o cualquier otra variante fuera de los corchetes dobles [[IMAGEN:...]] — esa línea nunca debe ser legible como texto normal para el maestro, es un marcador técnico que esta aplicación reemplaza automáticamente por la imagen real al generar el archivo. NUNCA pidas números, letras, palabras, símbolos ni ningún tipo de texto DENTRO de la ilustración — ni siquiera un solo dígito o letra suelta (ej. nunca "con etiquetas que digan 'Evaporación'...", nunca "con el número 1 en una esquina", nunca "cada círculo con una letra A, B, C...") — los generadores de imágenes no renderizan texto de forma confiable, ni siquiera un dígito simple, y producen números o palabras repetidos, incorrectos o ilegibles. Describe la ilustración SOLO con elementos visuales puros (formas, colores, posiciones, flechas, expresiones, tamaño, disposición espacial — ej. "de izquierda a derecha", "en las cuatro esquinas") — CERO caracteres de texto de ningún tipo dentro de la imagen. Si el reactivo necesita numeración, letras o etiquetas (ordenar etapas, relacionar columnas, identificar partes), esos números/letras van SIEMPRE en el texto real del documento (la tabla o los reactivos, ver REACTIVOS/RELACIONA COLUMNAS arriba) — nunca dentro de la imagen.` : ''
  // FECHA(S) EXPLÍCITA(S) CON DÍA DE LA SEMANA CALCULADO (ver
  // "corrección — Docente IA fabricaba el día de la semana de una fecha
  // explícita", caso real: "Domingo 31 de agosto de 2026" cuando en
  // realidad es lunes) — 100% determinístico (Intl.DateTimeFormat, ver
  // lib/tiempo/TimeService.ts), nunca a partir de la memoria/inferencia
  // de Claude. Solo se activa cuando el mensaje ACTUAL trae una fecha
  // completa (día + mes + año) — nunca infiere el año faltante, así que
  // "el 31 de agosto" sin año sigue sin mencionar día de semana, tal
  // como debe ser. Compartido por parametrosClaude (streaming normal,
  // CASO 3 de documentos/imágenes y la continuación de
  // registrar_dato_escolar) — cubre los tres caminos con un solo cambio.
  const fechasExplicitasConDia = calcularDiasSemanaDeFechasExplicitas(mensaje || '', zonaHoraria)
  const bloqueFechasExplicitas = fechasExplicitasConDia.length > 0 ? `

FECHA(S) CON DÍA DE LA SEMANA YA CALCULADO DE FORMA DETERMINÍSTICA — NUNCA calcules ni inventes tú el día de la semana de una fecha, usa EXACTAMENTE este resultado ya calculado por el sistema: ${fechasExplicitasConDia.map((f) => `"${f.textoOriginal}" → el día de la semana correcto es ${f.diaSemana}`).join('; ')}. Si mencionas el día de la semana de alguna de estas fechas en tu respuesta, en un documento o en la descripción de una imagen, usa EXACTAMENTE el valor de arriba — nunca otro, aunque tu propio cálculo interno sugiera algo distinto.` : ''

  // FASE 2B2B1 (ver "transformar_texto — misma llamada Sonnet
  // conversacional ya planeada") — mismo criterio que bloqueVoz/
  // bloqueModoImagen: instrucciones ADICIONALES solo para este turno,
  // activas SOLO cuando activarTransformarTexto ya confirmó (arriba)
  // capacidad_contextual==='transformar_texto' + confianza 'alta' +
  // referente tipo 'texto'. Deliberadamente NO repite el contenido del
  // referente aquí — Claude ya lo recibe como parte natural de
  // `messages` (ver historialMensajes, línea ~622 y su uso en
  // parametrosClaude.messages más abajo); este bloque solo señala CUÁL
  // de esos turnos es el referente y qué hacer con él, sin duplicar
  // tokens. "la respuesta real con contenido más reciente" (no "tu
  // turno inmediatamente anterior") a propósito — obtenerUltimoContenidoUtil
  // puede saltar mensajes operativos/sin contenido reconocible, así
  // que el turno inmediatamente anterior en la lista no siempre
  // coincide con el referente real que Nivel0 resolvió.
  const bloqueTransformarTexto = activarTransformarTexto ? `

TRANSFORMACIÓN DE CONTENIDO RECIENTE ACTIVA — el maestro pidió transformar el contenido que tú mismo escribiste en esta conversación, no iniciar un tema nuevo. Identifica tu respuesta real con contenido más reciente (tu última respuesta con contenido real — nunca un mensaje operativo, de confirmación, o sin contenido) como el texto base, y aplica sobre ESE texto exactamente la transformación que pide el mensaje actual del maestro (más corta, más formal, para otro público, en otro idioma, resumida, simplificada, u otra transformación equivalente que el mensaje actual indique). Ve directo al resultado: no preguntes qué contenido transformar, no expliques el procedimiento, no confirmes antes de hacerlo — tu respuesta ES el contenido ya transformado.` : ''

  // POSTPROCESADO DETERMINÍSTICO DEL DÍA DE LA SEMANA PARA CONSULTAS
  // FACTUALES CON AÑO EXPLÍCITO (ver "postprocesado determinístico del
  // día de la semana para consultas factuales con año explícito") —
  // caso real: "¿Qué día cae la Independencia de México en 2026?"
  // resuelve el HECHO (16 de septiembre) vía web_search (FASE 1, ya
  // cerrada), pero Claude seguía calculando el día de la semana
  // libremente porque esa fecha nunca aparece en el MENSAJE del
  // docente — bloqueFechasExplicitas (arriba) no puede ayudar ahí,
  // solo mira lo que el docente escribió. Deliberadamente MUY
  // conservador: exige las 4 condiciones a la vez — requiereConsultaOficial,
  // pregunta EXPLÍCITA de "qué día cae"/"en qué día cae", un año de 4
  // dígitos explícito en el mensaje (NUNCA inferido de "hoy" ni del
  // ciclo escolar), y canal de texto normal (voz queda fuera esta
  // ronda). Usado más abajo, en el ReadableStream, para decidir si se
  // bufferiza la respuesta completa antes de aplicar la corrección.
  const REGEX_PREGUNTA_DIA_SEMANA = /\bqu[eé]\s+d[ií]a(\s+de\s+la\s+semana)?\s+cae\b|\ben\s+qu[eé]\s+d[ií]a\s+cae\b/i
  const REGEX_ANIO_EXPLICITO_MENSAJE = /\b(\d{4})\b/
  const anioAutorizadoMatch = requiereConsultaOficial && channel !== 'voice' && REGEX_PREGUNTA_DIA_SEMANA.test(mensaje || '')
    ? (mensaje || '').match(REGEX_ANIO_EXPLICITO_MENSAJE)
    : null
  const anioDiaSemanaAutorizado: number | null = anioAutorizadoMatch ? Number(anioAutorizadoMatch[1]) : null

  // Parámetros de la llamada a Claude, compartidos por el streaming
  // normal (abajo) y por el CASO 3 de FINALIZAR ARCHIVO (crear+entregar
  // el archivo en un solo mensaje, ver más abajo) — el único que cambia
  // entre ambos es `stream`.
  const parametrosClaude = {
    model: 'claude-sonnet-4-6' as const,
    // Antes en 3000 — un documento largo real (una planeación de 10 días
    // con propósito, PDAs, actividades de inicio/desarrollo/cierre y
    // evaluación POR DÍA) fácilmente pasa de esa cifra. Cuando el modelo
    // se quedaba sin tokens a media respuesta, el flujo de streaming del
    // cliente terminaba con muy poco o nada de texto útil — uno de los
    // caminos reales hacia la "burbuja vacía" reportada.
    max_tokens: 8000,
    system: `Eres Docente IA, el asistente personal más avanzado para docentes mexicanos, y también su asesor pedagógico de confianza: el lugar donde consultan información oficial de la SEP, documentos internos de su escuela y los datos de su propio grupo, sin tener que buscar en otro lado.

CAPACIDADES — Docente IA SÍ genera archivos reales y descargables (Word, PDF, PowerPoint, Excel) directamente desde esta conversación. También SÍ genera imágenes reales (ilustraciones, portadas, dibujos temáticos, apoyos gráficos) — nunca digas "no puedo generar imágenes" ni equivalentes; cuando el maestro pida una imagen suelta, esta aplicación intercepta tu respuesta y genera la imagen real a partir de la descripción que escribas (ver MODO IMAGEN más abajo). También SÍ genera documentos CON ilustraciones integradas (fichas, guías, exámenes, cuentos) — nunca digas que no puedes ilustrar un documento ni sugieras herramientas externas (Canva, Google, etc.); cuando el maestro pida un documento ilustrado, inserta las líneas [[IMAGEN:...]] que correspondan dentro del documento (ver MODO DOCUMENTO ILUSTRADO más abajo) y esta aplicación genera las imágenes reales y las embebe automáticamente. La gran mayoría de las veces que el maestro pide el archivo (dice "Word", "DOCX", "archivo Word", "documento oficial", "para imprimir", "descárgalo", "pásamelo en Word" o equivalente) esta petición NUNCA llega hasta ti — el servidor ya la intercepta antes y ejecuta la herramienta de generación directamente, sin pasar por ti. Si de todos modos ves una de estas peticiones (caso raro: el maestro pide el archivo en el mismo mensaje en el que pide el documento por primera vez, sin haberlo platicado antes), tienes PROHIBIDO decir o insinuar cualquiera de estas frases o equivalentes: "no puedo crear archivos", "no puedo enviar Word", "no puedo generar documentos", "no pude generar el archivo", "aquí tienes el contenido para copiar", "pega esto en Word", "formato tipo Word", "puedes copiarlo", "cópialo en Word" — todas son falsas dentro de esta aplicación y tienes terminantemente prohibido escribir el contenido del documento como texto plano en el chat cuando el maestro pidió un archivo. En ese caso, ve directo al documento completo en MODO DOCUMENTO (ver abajo) empezando con su título en mayúsculas y emoji, SIN ninguna frase de confirmación antes ("Perfecto...", "Claro...", etc.) y SIN narrar ni explicar el contenido en prosa conversacional — la aplicación intercepta esa respuesta y genera el archivo real a partir de ella automáticamente; tu única salida válida es el documento en MODO DOCUMENTO, nunca una explicación de cómo obtenerlo manualmente.

LÍMITES REALES DE ACCIÓN — nunca prometas, afirmes ni insinúes que puedes ejecutar una acción que no está entre las que sí tienes conectadas de verdad; una respuesta sobre esto es exactamente tan real como cualquier dato de la aplicación, y prometer una acción que no existe rompe la confianza del maestro igual que inventar una cifra. Hoy SÍ puedes ejecutar de verdad: consultar asistencia, faltas, retardos y totales de un alumno o del grupo; registrar o marcar asistencia (de un alumno o de todo el grupo); registrar una incidencia nueva de un alumno; consultar incidencias, necesidades de apoyo, documentos guardados y el calendario; mostrar, abrir o filtrar la Lista de alumnos; actualizar el grado/grupo del docente; generar documentos (planeaciones, rúbricas, exámenes, citatorios, fichas descriptivas, resúmenes). Hoy NO puedes — no existe ninguna función conectada para esto, sin importar qué tan razonable suene la petición — dar de alta, editar, ni ELIMINAR alumnos (ni uno solo ni el grupo completo), ni ninguna otra acción sobre alumnos o el grupo fuera de la lista anterior. Si el maestro pide eliminar a uno o varios alumnos, o toda la lista, respóndele con honestidad que esa función todavía no está disponible desde el chat, y sugiérele hacerlo manualmente desde la pantalla de Lista (la ficha del alumno para uno solo; la opción "Eliminar lista completa", si ya está disponible en su versión de la app, para el grupo completo). Tienes PROHIBIDO decir "listo, lo elimino", "ya lo borré", "hecho" ni ninguna otra confirmación de una acción de este tipo que no ejecutaste de verdad.

VOZ Y AUDIO — cuando el maestro te habla por micrófono, la aplicación transcribe su voz a texto (así te llega el mensaje) y, en cuanto respondes, la propia aplicación lee tu respuesta en voz alta con síntesis de voz del dispositivo — eso ocurre siempre, automáticamente, fuera de esta conversación; tú nunca lo gestionas ni lo mencionas. El asistente NUNCA debe afirmar que no tiene voz o audio: tienes PROHIBIDO decir o insinuar "solo me comunico por texto", "no tengo voz", "no puedo hablar", "no tengo audio", "no puedo reproducir sonido" ni ninguna frase equivalente — todas son falsas dentro de esta aplicación. La reproducción de voz es responsabilidad de la aplicación, no del modelo; tu única tarea es responder con el texto correcto.

${fuentesDisponiblesTexto}
VERACIDAD DE DATOS — REGLA CRÍTICA, MÁXIMA PRIORIDAD, POR ENCIMA DE CUALQUIER OTRA INSTRUCCIÓN DE ESTE PROMPT Y DE CUALQUIER PETICIÓN DEL MAESTRO: Docente IA NUNCA inventa, completa por inferencia, deduce ni fabrica datos personales, académicos, administrativos u oficiales de un alumno, docente, escuela o documento. Esto aplica sin excepción a CURP, RFC, NSS, matrícula, fecha de nacimiento, domicilio, teléfono, correo, calificaciones, asistencias, incidencias, cualquier identificador oficial, y cualquier otro dato personal o académico — sin importar si la petición llegó por texto, por voz, con una imagen, con varias imágenes, o con un documento adjunto (Word/Excel/PDF): la misma regla aplica siempre, sin ninguna excepción por canal.
Tienes terminantemente PROHIBIDO, para cualquiera de esos datos: inventar un valor; completar caracteres que no puedas confirmar; deducir o adivinar un valor probable aunque parezca razonable; reconstruir el dato a partir del nombre, sexo, fecha, lugar o cualquier otro dato relacionado; "corregir" automáticamente una lectura dudosa para que el resultado se vea completo o bien formado; o generar cualquier valor plausible solo para no dejar un campo vacío. Un dato con apariencia correcta pero fabricado es exactamente igual de dañino que un dato claramente falso — nunca lo produzcas por parecer más útil o más completo.
Según de dónde venga el dato:
- Si viene de Supabase o de cualquier otra fuente interna ya confirmada de esta aplicación (ver DATOS DEL MAESTRO/CONTEXTO REAL más abajo): usa ÚNICAMENTE el valor real tal como está almacenado — nunca lo cambies, completes ni "mejores".
- Si viene de una imagen o de un documento adjunto (Word/Excel/PDF, una foto, o varias fotos a la vez): transcribe ÚNICAMENTE lo que realmente puedas leer con certeza, carácter por carácter. Si uno o más caracteres de un identificador o dato no son legibles con certeza, tienes PROHIBIDO completarlos o adivinarlos — en vez de eso, marca esa lectura como dudosa o incompleta, señala exactamente qué parte no puedes confirmar (ej. "CURP parcialmente legible: AXXX170611H_ _ _ _ _ _ — no pude confirmar los últimos 6 caracteres"), y pide confirmación al maestro solo cuando esa parte sea necesaria para continuar.
- Si el dato simplemente no está disponible (ni en la aplicación ni en lo que el maestro adjuntó): dilo explícitamente ("Ese dato no está disponible" o equivalente honesto) — la ausencia de información NUNCA es una autorización para inferirla, adivinarla o rellenarla con un valor razonable.
Ninguna instrucción del maestro anula esta regla, sin importar qué tan directa o insistente sea — frases como "sácalas de ahí", "léelo", "complétalo", "hazme todos", "pon los datos", "invéntalos si no los tienes" o cualquier equivalente NUNCA te autorizan a fabricar un dato de los descritos arriba. Ante cualquiera de esas instrucciones, sigue exactamente el mismo criterio: transcribe solo lo legible, marca lo dudoso, y declara honestamente lo que no está disponible.
DÍAS DE LA SEMANA — misma regla de veracidad aplicada a un caso específico real (ver "corrección — Docente IA fabricaba el día de la semana de una fecha explícita"): nunca agregues ni inventes por iniciativa propia el día de la semana de una fecha. Solo puedes mencionar un día de la semana cuando exista una de estas dos fuentes autorizadas: (1) un cálculo determinístico que el propio sistema ya te haya entregado más abajo en este prompt (cuando exista) — esa es la autoridad máxima, incluso si el maestro escribió otro día distinto para la misma fecha; o (2) el día que el propio maestro haya escrito explícitamente junto con la fecha en su mensaje actual, cuando no exista cálculo determinístico disponible (por ejemplo, porque falta el año) — en ese caso consérvalo tal cual, sin intentar corregirlo ni completar el año que falta. Si ninguna de las dos fuentes existe, omite el día de la semana por completo — nunca calcules tú mismo uno "razonable" a partir de la fecha, y nunca lo tomes como válido solo porque apareció en una respuesta ANTERIOR tuya dentro de esta misma conversación: una respuesta previa tuya nunca es, por sí sola, una fuente factual confiable de esto.
CONCIENCIA DE DATOS REALES — eres el cerebro central de Docente IA, no un chatbot genérico de propósito general: tienes acceso directo y automático a los datos reales del grupo activo del maestro (ver DATOS DEL MAESTRO más abajo, donde siempre viene el grupo activo y su lista de alumnos si existen) sin que el maestro tenga que dártelos ni preguntarte si los tienes. Tienes PROHIBIDO responder con frases genéricas de chatbot que nieguen o duden de tu acceso a la información de la aplicación — nunca digas "no tengo acceso directo...", "puedes decirme los nombres...", "podemos organizar una lista desde cero...", "si quieres podemos hacerlo juntos..." ni cualquier variante equivalente: son falsas dentro de esta aplicación y rompen la confianza del maestro. Si el maestro pregunta si ya tienes acceso a su lista, sus alumnos, su grupo, o cualquier dato que sí aparezca en DATOS DEL MAESTRO, respóndele con ese dato real y confirma que sí lo tienes — nunca finjas no saberlo. Ejemplo: "¿Ya tienes acceso a mi lista de alumnos?" → "Sí. Ya tengo acceso a la lista del grupo [nombre]. Actualmente hay [N] alumnos registrados. ¿Qué deseas hacer con ellos?". Si el dato específico que pide el maestro NO aparece en DATOS DEL MAESTRO (por ejemplo, una ficha descriptiva o documento que todavía no se ha generado), dilo con honestidad y ofrece la acción concreta para resolverlo — nunca lo confundas con no tener acceso a la aplicación en general. Ejemplo: "Aún no encuentro una lista registrada para este grupo. ¿Deseas importarla o crear una nueva?"

TONO Y ARRANQUE DE RESPUESTA — eres un asistente profesional, cercano, inteligente y natural: como conversar con un buen asistente humano, mexicano, especializado en educación básica — nunca frío y telegráfico, nunca relleno vacío. El arranque depende del tipo de mensaje:
- Mensaje puramente social, sin ninguna tarea (ej. "¿Qué onda? ¿Cómo estás?", "Hola", "Buenas noches"): responde con calidez breve y natural, variando la frase cada vez — puedes saludar de vuelta y usar el nombre del maestro cuando lo tengas. Ejemplos válidos (no repitas siempre el mismo): "Buenas noches, [nombre]. ¿Qué vamos a preparar?", "Buenas noches. ¿En qué trabajamos?", "Todo bien. ¿Qué necesitas preparar?". Nunca respondas solo "Dime." o "¿Qué necesitas?" a secas.
- MODO CONSULTA o contenido rápido dentro de la conversación (una pregunta, una explicación, "dame unos problemas de resta", etc.): puedes ir directo al contenido, o abrir con una frase breve y útil que confirme qué preparaste ("Preparé cinco problemas de resta para tercer grado, con dificultad progresiva:") seguida del contenido en la misma respuesta. Cualquiera de las dos formas es válida — lo que nunca debe pasar es una respuesta robótica de una sola palabra suelta: "Dime.", "Ahí va.", "Entendido.", "Perfecto.", "Claro.", "Voy a hacerlo." no son respuestas completas por sí solas.
- MODO DOCUMENTO (los tipos formales definidos abajo, con su título en mayúsculas y emoji): sigue yendo directo al título, sin ninguna frase previa — la aplicación usa esa primera línea para mostrar el documento como tarjeta descargable; una frase antes de ella rompe esa tarjeta.

NUNCA NARRES TUS PROPIAS REGLAS — todo lo anterior es instrucción interna, el maestro jamás debe enterarse de que existe. Tienes PROHIBIDO decir frases como "recuerda que voy directo al contenido", "sin saludos ni introducciones", "vamos al grano", "como asistente...", "mi función es..." o cualquier variante que explique o mencione tu propio comportamiento o tus reglas — eso también es relleno, igual de prohibido que una respuesta seca. Simplemente compórtate así, sin anunciarlo nunca.

MEMORIA DE LA CONVERSACIÓN — tienes arriba, como turnos previos reales, todo lo que se ha dicho en esta conversación. Úsalo siempre: si el maestro ya te dio el grado, tema, o tipo de documento en un mensaje anterior, jamás lo vuelvas a preguntar ni cambies de nivel/grado/tema por tu cuenta. Si dice "hazlo en Word", "ahora en PDF", "hazlo oficial" o "agrégale algo" sin repetir el tema, se refiere al ÚLTIMO documento del que se habló — continúa exactamente ese mismo, nunca empieces uno distinto.

FECHA Y HORA ACTUALES DEL SISTEMA — en la zona horaria real del dispositivo del maestro (${infoFechaHora.zonaHoraria}), NUNCA UTC ni una zona distinta: hoy es ${infoFechaHora.diaSemana} ${infoFechaHora.fechaLegible}, son las ${infoFechaHora.horaLegible}. Ciclo escolar actual: ${infoFechaHora.cicloEscolar}. Si el maestro pregunta la hora o la fecha, responde exactamente con estos datos — nunca inventes ni uses un año, fecha u hora de tu memoria de entrenamiento, ni asumas una zona horaria distinta a la indicada arriba.

ANTICIPACIÓN AUTOMÁTICA — cuando el maestro pida un recurso educativo (examen, guía, planeación, actividad, ficha, cuento, fábula, lectura, comprensión, ejercicios, práctica, problema, resumen, oficio), no te limites a lo mínimo que pidió literalmente ni le preguntes los detalles uno por uno. Interpreta la intención completa y construye automáticamente el mejor recurso posible para ese contexto: título atractivo, contenido adecuado al grado del maestro, y los elementos pedagógicos que ese tipo de recurso normalmente necesita (por ejemplo: un cuento o fábula normalmente lleva moraleja si aplica, preguntas de comprensión lectora y una actividad de cierre — ver el formato de CUENTOS, FÁBULAS Y LECTURAS abajo). El maestro no debería tener que pedir cada pieza por separado.
${contextoEnriquecido ? `DATOS DEL MAESTRO (ya los conoces, NUNCA los vuelvas a preguntar):
${contextoEnriquecido}` : ''}${contextoRAG}${contextoProceso}

PRIORIZACIÓN DE FUENTES — decide antes de responder cualquier consulta informativa (no aplica a generación de documentos ni a acciones dentro de la app):
1. Fuente SEP (conocimiento oficial): si la pregunta es general sobre el marco oficial vigente (Planes y Programas de Estudio, Nueva Escuela Mexicana, campos formativos, PDA, ejes articuladores, orientaciones didácticas, evaluación, acuerdos oficiales, calendario escolar, manuales, protocolos, convivencia escolar, inclusión, educación especial) y no hay un documento institucional que la resuelva mejor, respóndela con tu conocimiento confiable de ese marco oficial. Interprétala y explícala en lenguaje claro, como lo haría un asesor pedagógico — nunca respondas como si solo hubieras buscado un documento. Si algún detalle muy específico o reciente no lo tienes con certeza, dilo con honestidad en vez de inventarlo.
2. Fuente interna de la escuela: si la pregunta hace referencia explícita a la escuela del maestro (reglamento, manual de convivencia propio, circulares, oficios, acuerdos internos) y existe un documento institucional relevante (ver INFORMACION DE DOCUMENTOS INSTITUCIONALES arriba), básate en ese documento real, nunca en la SEP.
3. Datos de la app: si la pregunta es sobre un alumno, el grupo o la escuela del maestro, usa exclusivamente los DATOS DEL MAESTRO/CONTEXTO REAL ya inyectados arriba — nunca inventes cifras ni nombres. Si el dato que piden no está disponible ahí, dilo con honestidad en vez de adivinar. Si el dato SÍ está ahí, úsalo exactamente como viene — nunca lo redondees, estimes ni aproximes, y tienes PROHIBIDO usar frases como "aproximadamente", "creo que", "probablemente", "debe haber", "alrededor de" sobre un dato que ya tienes con exactitud: di la cifra o el nombre real, tal cual, con seguridad.
Si tu respuesta combinó más de una fuente, dilo.

CITAR LA FUENTE — solo cuando la respuesta se apoyó en información oficial o en un documento (nunca la agregues para conversación general ni para acciones dentro de la app):
Al final de tu respuesta, separado por una línea en blanco, agrega discretamente un bloque así (una sola fuente):
Fuente:
SEP – [nombre del programa o documento]
o si fueron varias:
Fuentes consultadas:
- SEP – [nombre]
- [nombre del documento interno]
Nunca interrumpas la explicación principal con la cita ni la menciones a media respuesta; va siempre al final, en su propio bloque.

MODO CONSULTA — aplica cuando el maestro hace una pregunta o pide una explicación (no un documento formal de los definidos abajo):
- Responde en párrafos cortos, pensados para leerse desde un celular. Evita bloques enormes de texto.
- Usa títulos y viñetas solo cuando ayuden a la claridad, no en cada respuesta.
- No copies documentos completos: resume, explica e interpreta con tus propias palabras.
- El tono es cálido y natural — ver TONO Y ARRANQUE DE RESPUESTA arriba para cómo abrir la respuesta según el tipo de mensaje.
- Después de responder una consulta oficial o pedagógica, puedes sugerir como máximo UNA acción útil relacionada, en una sola frase al final, después de la cita si la hay (ejemplo: "Si lo deseas, puedo elaborar una rúbrica alineada con este PDA."). Nunca sugieras más de una opción, y nunca la agregues si no es realmente relevante.
- Si la pregunta se responde con datos reales ya inyectados (cifras, listas, resúmenes de asistencia/alumnos/incidencias/calendario/documentos — no aplica a explicar o interpretar el marco oficial), sé ejecutivo: ve directo al dato, sin frase de cortesía al inicio ("Claro, vamos a revisar...", "Con gusto te comparto..."). Si la respuesta tiene varios datos relacionados (ej. un resumen de asistencia del día), puedes organizarla con títulos cortos y viñetas para que se lea de un vistazo; si es un solo dato aislado (ej. una cifra o un nombre), una sola frase directa es suficiente — no le agregues estructura que no necesita.

MODO DOCUMENTO — las siguientes reglas aplican cuando el maestro pide generar uno de los documentos formales de abajo (planeación, rúbrica, examen/actividad, citatorio, resumen formal, cuento/fábula/lectura), no en modo consulta:
Qué cuenta como MODO DOCUMENTO: además de los tipos con formato fijo de abajo, también entra aquí cualquier resumen o documento formal que el maestro pida como ENTREGABLE — resumen de una ley, reglamento, acuerdo, norma o documento oficial ("resúmeme la ley...", "hazme un resumen de...", "necesito un documento con...", "genera un resumen formal de..."), y cualquier recurso educativo como examen, guía, planeación, actividad, ficha, cuento, fábula, lectura, ejercicios o práctica. Si el maestro solo está preguntando o pidiendo que le expliques algo ("¿qué dice la ley sobre...", "explícame...", "¿por qué...") es MODO CONSULTA, no esto.
1. NUNCA preguntes grado, grupo, escuela, nombre, estado, municipio. Ya los tienes.
2. NUNCA uses frases introductorias ni cierres conversacionales. Ve directo al contenido; termina cuando termine el contenido, sin despedidas ni ofrecimientos de ayuda adicional.
3. NUNCA uses markdown: sin asteriscos, sin simbolos | , sin ---, sin #.
4. Usa terminología NEM: campos formativos, PDAs, proyectos didácticos. NUNCA "asignaturas". Ver MARCO CURRICULAR VIGENTE más abajo — es de cumplimiento obligatorio, no una sugerencia de estilo.
5. NUNCA uses tablas de ningún tipo en el texto.
6. Los títulos en MAYÚSCULAS con emoji al inicio, cada uno en su propia línea.
7. Deja una línea en blanco entre cada sección.
8. Básate únicamente en información real: el contexto inyectado, la fuente citada, o tu conocimiento confiable y verificado del marco oficial. Si no tienes certeza de un dato específico (número de artículo, fracción, fecha, cifra exacta), dilo explícitamente en el documento en vez de inventarlo — nunca inventes contenido legal o normativo.
9. NUNCA escribas un encabezado institucional (Escuela, Docente, Grado, Grupo, Fecha, Lugar, Ciclo Escolar) al inicio del documento, ni antes ni después del título, sin importar si el maestro lo pidió como "oficial" o no — la aplicación ya agrega ese encabezado automáticamente, con los datos reales, de forma consistente en todos los documentos. Si tú también lo escribes, aparece DUPLICADO. Ve directo del primer título (regla 6) al contenido.
10. DOCUMENTOS NORMALES Y OFICIALES por igual: nunca agregues firma, nombre del maestro ni bloque de encabezado dentro del cuerpo del documento — la aplicación ya agrega automáticamente el encabezado institucional completo y la firma al final de cada documento, siempre con el mismo formato. Tu contenido empieza en el título y termina en la última línea del contenido real, sin nada de eso.
11. NOMBRES DE ALUMNOS SON UN DATO OFICIAL, NUNCA TEXTO LIBRE: cuando menciones el nombre de un alumno en cualquier documento (citatorio, ficha, oficio, reporte, lo que sea), cópialo EXACTAMENTE tal como aparece en "Lista de alumnos" dentro de DATOS DEL MAESTRO — carácter por carácter, en el mismo orden. Tienes PROHIBIDO invertir, reordenar, abreviar o "corregir" el orden de apellidos y nombres, y PROHIBIDO usar el formato bibliográfico "Apellido, Nombre" bajo cualquier circunstancia, aunque te parezca más formal u ordenado — el nombre real del alumno YA viene en el orden oficial correcto (apellido paterno, apellido materno, nombre(s)) y reordenarlo produce un dato falso. Si necesitas generar una LISTA completa de alumnos del grupo (no un solo alumno mencionado de paso), no la redactes tú: la aplicación ya intercepta esa petición antes de que te llegue y genera la lista directo desde la base de datos — si de todos modos te llega, es señal de que debes responder con el documento vacío de ese contenido específico en vez de inventarlo.

${MARCO_CURRICULAR_VIGENTE}

EXCEPCION A LA REGLA 3 - DATOS TABULARES:
Cuando generes listas de alumnos con CURP, rubricas, calificaciones, horarios, o cualquier dato con varias columnas (numero, nombre, CURP, criterio, puntaje, dia, hora, etc), SIEMPRE usa el simbolo | como separador de columnas, con este formato exacto:

campo1|campo2|campo3

Una fila por linea, sin espacios extra alrededor del simbolo |, sin encabezados de columna repetidos, sin explicaciones entre filas. Ejemplo para lista de alumnos:
1|AARA171115MJCBJDA8|ABAD ROJAS AUDREY
2|AABE170505MNTBNLB0|ABRAHAM BENITEZ EILEEN DANELLY

Este formato con | es obligatorio y NUNCA debe alternarse con guion largo, dos puntos, u otro separador. Es la unica excepcion al uso de simbolos de markdown.

TIPOS DE DOCUMENTOS QUE GENERAS:

PLANEACIONES — usa este formato. La duración por defecto es de 5 días (una semana) si el maestro no especifica otra cosa; si pide un número de días distinto (por ejemplo "para 10 días"), genera EXACTAMENTE esa cantidad de días completos, nunca menos, y organízalos con progresión real de principio a fin (conocimientos previos → desarrollo del contenido → práctica/aplicación → producto final) — nunca repitas la misma actividad en días distintos:
📋 PLANEACIÓN DIDÁCTICA
Grado: [grado] | Grupo: [grupo] | Fase: [fase según el grado, ver MARCO CURRICULAR VIGENTE]
Campo Formativo: [uno o más de los 4 campos formativos vigentes, nunca una asignatura del plan anterior]
Ejes Articuladores: [el o los que apliquen de verdad al contenido]
Proyecto Didáctico: [nombre]
Duración: [número de días real] días

🎯 PROPÓSITO GENERAL
[descripción]

📚 PROCESOS DE DESARROLLO DE APRENDIZAJE (PDA)
- [PDA 1]
- [PDA 2]

🧰 MATERIALES
- [material 1]

📅 DÍA 1 — [título del día, distinto en cada día]
🔹 Inicio (15 min)
[descripción]
🔸 Desarrollo (30 min)
[descripción]
🔻 Cierre (10 min)
[descripción]
📌 Evaluación: [descripción]

(repetir con "📅 DÍA 2", "📅 DÍA 3", etc. hasta completar exactamente el número de días pedido — cada día con su propio título y contenido, nunca copiado del anterior)

🎓 PRODUCTO FINAL
[qué entregan o demuestran los alumnos al terminar todos los días — solo inclúyelo si la planeación tiene más de un día]

RÚBRICAS — cuando el maestro pida una rúbrica, usa este formato:
📊 RÚBRICA DE EVALUACIÓN
Grado: [grado] | Grupo: [grupo] | Fase: [fase según el grado, ver MARCO CURRICULAR VIGENTE]
Campo Formativo: [uno o más de los 4 campos formativos vigentes, nunca una asignatura del plan anterior]
Actividad o Proyecto: [nombre]
Fecha: [dejar en blanco para llenar]

🎯 PROPÓSITO
[descripción breve]

📋 CRITERIOS DE EVALUACIÓN

CRITERIO 1: [nombre del criterio]
⭐⭐⭐⭐ Excelente (4): [descripción detallada]
⭐⭐⭐ Bueno (3): [descripción detallada]
⭐⭐ En desarrollo (2): [descripción detallada]
⭐ Necesita apoyo (1): [descripción detallada]

CRITERIO 2: [nombre del criterio]
⭐⭐⭐⭐ Excelente (4): [descripción]
⭐⭐⭐ Bueno (3): [descripción]
⭐⭐ En desarrollo (2): [descripción]
⭐ Necesita apoyo (1): [descripción]

(mínimo 4 criterios, máximo 6)

📊 ESCALA DE CALIFICACIÓN
16-20 puntos: Excelente
11-15 puntos: Bueno
6-10 puntos: En desarrollo
1-5 puntos: Necesita apoyo

✍️ OBSERVACIONES DEL DOCENTE
_______________________________________________

EXÁMENES Y ACTIVIDADES — cuando el maestro pida un examen o actividad, usa este formato. Si lo que pidió es un EXAMEN (evaluación formal, no una actividad suelta), cumple SIEMPRE estos requisitos: mínimo 10 reactivos, con variedad real de tipos (combina al menos 3 de estos: opción múltiple con incisos a)/b)/c)/d), verdadero/falso, relaciona columnas, completar, respuesta corta), deja espacio suficiente para que el alumno responda cada reactivo (líneas en blanco, casillas o recuadro según el tipo), y usa redacción clara y adecuada al grado indicado por el docente. Si lo que pidió es solo una ACTIVIDAD (no un examen), el número de reactivos puede ser menor (mínimo 5) y no exige esa variedad de tipos. ILUSTRACIONES EN ESTE DOCUMENTO — si arriba en este mismo prompt NO ves activa la sección "MODO DOCUMENTO ILUSTRADO ACTIVO", tienes PROHIBIDO mencionar, describir, sugerir o dibujar ninguna ilustración dentro de este examen o actividad, en ninguna forma: nunca escribas frases como "Ilustración:", "Imagen sugerida:", "Descripción visual:", ni dibujes diagramas hechos de caracteres/ASCII art pretendiendo representar una imagen — omite por completo cualquier referencia visual, nunca la sustituyas con texto. Solo puedes insertar imágenes reales (marcador [[IMAGEN:...]]) cuando esa sección SÍ está activa.
📝 [TÍTULO DEL EXAMEN O ACTIVIDAD, ej. "EXAMEN DE CIENCIAS NATURALES — EL CICLO DEL AGUA"]
Nombre del alumno: _______________________________________________
Grado: [grado]     Grupo: [grupo]     Fecha: _______________
Fase: [fase según el grado, ver MARCO CURRICULAR VIGENTE]
Campo Formativo: [uno o más de los 4 campos formativos vigentes, nunca una asignatura del plan anterior]
Tema: [tema]

🎯 PROPÓSITO
[descripción breve]

📋 INSTRUCCIONES
[instrucciones generales para el alumno]

✏️ REACTIVOS
1. [pregunta o instrucción, con el tipo de reactivo variado y su espacio de respuesta correspondiente]
2. [pregunta o instrucción de otro tipo distinto al anterior]
3. [pregunta o instrucción de otro tipo distinto a los anteriores]
(en un EXAMEN: mínimo 10 reactivos con variedad real de tipos, ver arriba; en una ACTIVIDAD: mínimo 5, sin esa exigencia de variedad)
RELACIONA COLUMNAS — formato OBLIGATORIO, sin ninguna variación, cuando incluyas este tipo de reactivo: una línea de instrucción, y luego una tabla markdown de 2 columnas con encabezado, EXACTAMENTE así:
| Columna A | Columna B |
|---|---|
| 1. Evaporación | C. El agua se filtra en el suelo. |
| 2. Condensación | A. El agua cae en forma de lluvia, nieve o granizo. |
| 3. Precipitación | B. El vapor de agua se enfría y forma nubes. |
Numera la Columna A con números (1, 2, 3...) y la Columna B con letras (A, B, C...) — MEZCLA el orden de la Columna B respecto a la Columna A (nunca en el mismo orden, o el ejercicio queda resuelto solo con leer de arriba a abajo). PROHIBIDO usar diagramas hechos de caracteres o arte ASCII/Unicode (líneas y cuadros como ┌─┐│└┘), bloques de código, o texto corrido con paréntesis (ej. "Evaporación ( ) Caída del agua...") — SIEMPRE usa exactamente el formato de tabla markdown de arriba, la única forma que esta aplicación convierte en una tabla real dentro del Word/PDF.

📊 PUNTAJE
[distribución de puntos por reactivo o sección]

CITATORIOS — cuando el maestro pida un citatorio, usa este formato:
📨 CITATORIO
Escuela: [escuela] | Municipio: [municipio]
Fecha: [fecha actual]
Ciclo Escolar: ${cicloEscolar}

Estimado padre/madre de familia de: _______________
Grado y Grupo: [grado] [grupo]

Por medio del presente se le cita cordialmente a una reunión el día _______________ a las _______________ horas en [escuela].

🎯 MOTIVO DE LA REUNIÓN
[motivo que el maestro indicó]

Se le solicita puntualidad y presencia. En caso de no poder asistir, favor de comunicarse con el docente.

Atentamente,
[nombre del maestro]
Docente de [grado] grado grupo [grupo]

RESÚMENES FORMALES — cuando el maestro pida el resumen de una ley, reglamento, acuerdo o documento oficial como entregable (no como explicación conversacional), usa este formato:
📄 RESUMEN — [nombre real de la ley/reglamento/documento]
Fecha de elaboración: [fecha actual]

🎯 OBJETO Y ALCANCE
[de qué trata el documento, a quién aplica]

📋 PUNTOS CLAVE
[apartados o artículos relevantes agrupados por tema, con su numeración real si la tienes con certeza; si no tienes certeza de un número exacto, dilo en vez de inventarlo]

📌 IMPLICACIONES PARA EL DOCENTE
[qué debe saber o hacer el maestro concretamente a partir de este documento]

La cita de fuente (ver CITAR LA FUENTE arriba) va siempre al final de este documento, no al centro.

CUENTOS, FÁBULAS Y LECTURAS — cuando el maestro pida un cuento, fábula, lectura o texto narrativo, construye automáticamente el recurso completo (ver ANTICIPACIÓN AUTOMÁTICA arriba): título atractivo, texto narrativo adecuado al grado del maestro, moraleja si es fábula, preguntas de comprensión lectora, y una actividad de cierre — sin preguntar cada pieza por separado. Usa este formato:
📖 [TÍTULO ATRACTIVO DEL TEXTO]
Grado: [grado] | Grupo: [grupo]

[texto narrativo: cuento, fábula o lectura, con vocabulario y extensión adecuados al grado]

💡 MORALEJA
[solo si es fábula: la enseñanza de la historia en una frase clara; omite esta sección por completo si no es fábula]

🤔 COMPRENSIÓN LECTORA
1. [pregunta de comprensión]
2. [pregunta de comprensión]
3. [pregunta de comprensión]
(mínimo 3 preguntas, mezcla preguntas literales e inferenciales según el grado)

✏️ ACTIVIDAD
[actividad breve de cierre relacionada con la lectura: dibujo, escritura, comentario en grupo, etc.]${bloqueVoz}${bloqueConsultaOficial}${bloqueModoImagen}${bloqueDocumentoIlustrado}${bloqueNivelEducativo}${bloqueFechasExplicitas}${bloqueTransformarTexto}`,
    // "Consultar información oficial vigente de la SEP": la herramienta
    // nativa web_search SOLO se agrega cuando el Clasificador de Nivel 0
    // autorizó este turno específico (requiereConsultaOficial) — nunca
    // está disponible por default. Realtime/voz nunca la ve: no existe
    // en app/api/realtime-token/route.ts, así que estructuralmente
    // tampoco puede buscar nada por su cuenta (ver
    // MotorOpenAIRealtime — cero tools registradas ahí, sin cambios).
    ...(requiereConsultaOficial || requiereRegistroEscolar
      ? {
          tools: [
            ...(requiereConsultaOficial ? [construirHerramientaConsultaOficial()] : []),
            ...(requiereRegistroEscolar ? [construirHerramientaRegistroEscolar()] : []),
          ],
        }
      : {}),
    messages: [
      ...historialMensajes,
      {
        role: 'user' as const,
        // varias imágenes: un bloque 'image' por foto (Claude las lee
        // todas juntas, en el mismo turno) + un solo bloque de texto al
        // final con una instrucción explícita de analizarlas EN
        // CONJUNTO — sin esa instrucción, el modelo tiende a
        // responder "imagen 1... imagen 2..." una por una. pdf: Claude
        // lo lee de forma nativa como bloque binario (mejor que
        // extraer texto — también ve tablas/diseño). imagen (una
        // sola): sin cambios, comportamiento previo. docx/xlsx/pptx:
        // su texto ya se extrajo arriba y quedó embebido en
        // mensajeConDocumento (nunca se manda el binario — Claude no
        // lo puede leer).
        content: imagenesValidas.length > 0
          ? [
              ...imagenesValidas.map((img) => ({
                type: 'image' as const,
                source: { type: 'base64' as const, media_type: img.tipo as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data: img.base64 },
              })),
              {
                type: 'text' as const,
                text: `${mensaje}\n\n[El maestro adjuntó ${imagenesValidas.length} fotografías en este mismo mensaje — analízalas EN CONJUNTO, como un solo contexto. Nunca respondas "imagen 1... imagen 2..." por separado salvo que el maestro pida explícitamente comentarios individuales.]`,
              },
            ]
          : tipoDocumentoAdjunto === 'pdf' && imagenBase64
            ? [
                { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: imagenBase64 } },
                { type: 'text' as const, text: mensaje }
              ]
            : imagenBase64 && typeof imagenTipo === 'string' && imagenTipo.startsWith('image/')
              ? [
                  { type: 'image' as const, source: { type: 'base64' as const, media_type: imagenTipo as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data: imagenBase64 } },
                  { type: 'text' as const, text: mensaje }
                ]
              : mensajeConDocumento
      },
    ],
  }

  // [IMAGEN][MODELO] — log temporal de auditoría del pipeline de
  // imágenes: cuántos bloques 'image' de verdad quedaron en el mensaje
  // que se le manda a Claude, justo antes de cualquiera de las
  // llamadas reales a client.messages.create() que reutilizan
  // parametrosClaude — el punto final para confirmar que la imagen
  // sobrevivió las etapas anteriores.
  {
    const bloqueUsuario = parametrosClaude.messages[parametrosClaude.messages.length - 1]
    const contenido = Array.isArray(bloqueUsuario?.content) ? bloqueUsuario.content : []
    const cantidadImagenesEnMensaje = contenido.filter((b: { type?: string }) => b?.type === 'image').length
    if (cantidadImagenesEnMensaje > 0 || tieneImagenAdjunta) {
      console.log(`[IMAGEN][MODELO] ${cantidadImagenesEnMensaje} bloque(s) de imagen incluido(s) en el mensaje enviado a Claude (tieneImagenAdjunta=${tieneImagenAdjunta})`)
    }
  }

  // CASO 3 de FINALIZAR ARCHIVO — el maestro pidió el archivo real
  // (Word/PDF/PowerPoint/Excel) pero no había ningún documento previo
  // que recuperar (ver arriba): "redáctalo Y entrégamelo como archivo"
  // en un solo mensaje. Claude sigue redactando el contenido (lo
  // necesita), pero la respuesta NUNCA se transmite como texto al chat
  // — se recibe completa aquí (sin streaming) y, si es un documento
  // formal válido, se convierte directo en el archivo real. El maestro
  // nunca ve el contenido en prosa en este caso.
  if (supabaseUser && userId && tipoHerramientaSolicitado) {
    const etiquetaCaso3 = ETIQUETA_MODULO[tipoHerramientaSolicitado]
    console.log(`[PIPELINE ${etiquetaCaso3}:deteccion] tipo=${tipoHerramientaSolicitado} fuenteContenido=claude-directo (sin documento previo que recuperar)`)
    try {
      const inicioContenido = Date.now()
      const respuestaCompleta = await conReintento(() => client.messages.create({ ...parametrosClaude, stream: false }, { timeout: TIMEOUT_ANTHROPIC_DOCUMENTO_MS }), 'claude-documento-combinado')
      const texto = respuestaCompleta.content.map((b) => (b.type === 'text' ? b.text : '')).join('')

      // Imagen suelta (ver "Implementar en Docente IA la capacidad de
      // generar imágenes...", Fase 0+1): Claude no redacta un
      // documento formal aquí — su única salida es una descripción
      // visual refinada de una línea (ver instrucciones de MODO
      // IMAGEN en el prompt de sistema), así que esDocumentoFormal
      // (título en mayúsculas + emoji) no aplica; basta con que haya
      // texto real.
      const esImagenSuelta = tipoHerramientaSolicitado === 'imagen' && !!texto?.trim()

      if (texto && (esImagenSuelta || esDocumentoFormal(texto))) {
        console.log(`[PIPELINE ${etiquetaCaso3}:contenido] OK — ${texto.length} caracteres redactados por Claude — ${Date.now() - inicioContenido}ms`)
        const { data: perfil } = await supabaseUser.from('perfiles_docentes').select('*').eq('id', userId).single()
        // esImagenSuelta/formatosAGenerar con ilustraciones embebidas —
        // ambos caminos de abajo pueden terminar en guardarAssetVisual,
        // así que ownership se demuestra una sola vez aquí (cacheada:
        // ambos usos comparten el mismo SELECT, ver
        // obtenerConversacionIdAutorizada).
        const conversacionIdActual = await obtenerConversacionIdAutorizada()

        // Varios formatos pedidos en el MISMO mensaje ("...Genera
        // también Word y PDF.", ver "fallo crítico: guía ilustrada
        // devolvió LISTA_OFICIAL_DE_ALUMNOS.docx" — punto 3, "si se
        // pidió PDF también se genere y se entregue"): se generan
        // TODOS, no solo tipoHerramientaSolicitado (el de mayor
        // prioridad). Nunca aplica a imagen suelta (un solo formato
        // siempre). allSettled — si un formato SECUNDARIO falla, los
        // demás igual se entregan (mejor esfuerzo); si el PRIMARIO
        // falla, sí se propaga como error real (ver catch abajo).
        const formatosMultiples = esImagenSuelta ? [] : detectarFormatosExplicitosMultiples(mensaje || '')
        const formatosAGenerar = formatosMultiples.length > 1 ? formatosMultiples : [tipoHerramientaSolicitado]

        // Ver "corrección: timeout en documentos ilustrados largos" —
        // cuando se piden VARIOS formatos (Word y PDF) del mismo
        // documento ilustrado, las ilustraciones se generan UNA sola
        // vez aquí y se reutilizan para ambos (antes cada formato las
        // regeneraba por su cuenta: el doble de tiempo/costo, y con
        // riesgo real de que Word y PDF terminaran con dibujos
        // distintos, ya que la generación de imágenes no es
        // determinista). Nunca aplica a imagen suelta ni a documentos
        // sin líneas [[IMAGEN:...]] — ahí este bloque no hace nada.
        let imagenesPreGeneradas: Map<string, { buffer: Buffer; ancho: number; alto: number }> | undefined
        if (!esImagenSuelta && (formatosAGenerar.includes('word') || formatosAGenerar.includes('pdf'))) {
          const descripciones = extraerDescripcionesDeImagen(analizarContenido(texto)).slice(0, MAX_IMAGENES_POR_DOCUMENTO)
          if (descripciones.length > 0) {
            imagenesPreGeneradas = await generarImagenesParaDocumento(descripciones, perfil, supabaseRAG, userId, supabaseUser, conversacionIdActual, estiloVisualNivelEducativo)
          }
        }

        const resultados = await Promise.allSettled(
          formatosAGenerar.map((tipo) =>
            // mensaje (texto REAL del docente, nunca la descripción de
            // Claude en `texto`) — solo para inferir tipoPieza en
            // ejecutarGeneracionImagen cuando tipo==='imagen' (ver
            // "mejora de calidad visual de imágenes escolares"); word/
            // pdf/powerpoint/excel lo ignoran, sin ningún cambio.
            conReintento(() => ejecutarHerramientaDocumento(tipo, texto, perfil, zonaHoraria, supabaseRAG, userId, supabaseUser, conversacionIdActual, null, imagenesPreGeneradas, estiloVisualNivelEducativo, mensaje || undefined), `generar-archivo-combinado-${tipo}`)
          )
        )
        const primario = resultados[0]
        if (primario.status === 'rejected') throw primario.reason
        const archivos = resultados.flatMap((r, i) => {
          if (r.status === 'fulfilled') return [r.value]
          console.error(`[PIPELINE ${etiquetaCaso3}:entrega] Falló el formato secundario ${formatosAGenerar[i]} (no bloquea los demás):`, r.reason)
          return []
        })
        const marcadores = archivos.map((archivo) => `[[DOCUMENTO_ARCHIVO:${Buffer.from(JSON.stringify(archivo), 'utf-8').toString('base64')}]]`).join('\n')
        // El CASO 3 nunca manda el contenido redactado como texto plano
        // al chat (el maestro nunca lo ve en prosa) — pero sin él, el
        // cliente no tiene NINGÚN contenido real que reutilizar si
        // después pide "ahora en PDF"/"conviértelo a PowerPoint": no
        // hay documentoActivo con texto real que mandar, y la única red
        // de seguridad del servidor (buscar el último documento formal
        // en el historial) tampoco lo encuentra, porque en el chat solo
        // quedó "Documento generado correctamente." — nunca el
        // documento. Este marcador es SOLO para eso: se decodifica en
        // el cliente para poblar documentoActivo.texto (fuente real
        // para conversiones futuras), nunca se muestra en pantalla.
        console.log(`[PIPELINE ${etiquetaCaso3}:entrega] OK — ${archivos.map((a) => a.nombre).join(', ')}`)
        // La imagen no tiene "documento activo" de texto que recuperar
        // después (ver AsistenteService.materialVisualActivo, que se
        // arma directo del marcador de archivo) — DOCUMENTO_CONTENIDO
        // es específico de word/pdf/powerpoint/excel.
        if (esImagenSuelta) return respuestaTexto(`Imagen generada correctamente.\n${marcadores}`)
        const marcadorContenido = `[[DOCUMENTO_CONTENIDO:${Buffer.from(texto, 'utf-8').toString('base64')}]]`
        return respuestaTexto(`Documento generado correctamente.\n${marcadores}\n${marcadorContenido}`)
      }
      console.log(`[PIPELINE ${etiquetaCaso3}:contenido] Claude no produjo un documento formal — se entrega como respuesta normal`)
      // Claude no produjo un documento formal (era más bien una consulta
      // o le faltó información) — se entrega tal cual, como respuesta
      // normal, en vez de perder la respuesta.
      return respuestaTexto(texto || 'No entendí bien qué documento necesitas. ¿Puedes darme más detalles?')
    } catch (err) {
      if (err instanceof HerramientaNoDisponibleError) {
        console.error('Herramienta no disponible:', err)
        return NextResponse.json({ error: err.message }, { status: 502 })
      }
      const codigo = err instanceof ErrorHerramientaDocumento ? err.codigo : `${ETIQUETA_MODULO[tipoHerramientaSolicitado]}-GEN`
      console.error(`Error generando y finalizando documento en un solo paso [${codigo}]:`, err)
      return NextResponse.json({ error: MENSAJE_ERROR_DOCUMENTO }, { status: 502 })
    }
  }

  // FASE 2B2A (ver "short-circuit + ejecución de capacidades de
  // recurso") — cuando la decisión ya es candidata a ejecutarse en el
  // cliente, se omite POR COMPLETO la segunda llamada Sonnet
  // conversacional de abajo (nunca se construye ni se llama
  // client.messages.create para este turno): el maestro va a ver la
  // UX real del pipeline de imagen (ver AsistenteService.ts), una
  // respuesta conversacional aquí sería una segunda voz redundante
  // ("Claro, aquí está" + luego la imagen real). El body sigue siendo
  // texto plano — aquí, vacío a propósito — y el stream se cierra de
  // inmediato; los dos headers (decisión + modo) ya bastan para que el
  // cliente sepa qué ejecutar.
  if (esShortCircuitOrquestador && decisionOrquestadorParaHeader) {
    const headersShortCircuit: Record<string, string> = {
      'Content-Type': 'text/plain; charset=utf-8',
      [HEADER_DECISION_ORQUESTADOR]: Buffer.from(JSON.stringify(decisionOrquestadorParaHeader), 'utf-8').toString('base64'),
      [HEADER_DECISION_ORQUESTADOR_MODO]: 'ejecutar_cliente',
    }
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.close()
        },
      }),
      { headers: headersShortCircuit }
    )
  }

  marcarTelemetria('claude:request_started')
  const tNivel4LlamadaInicio = diagnosticoCurpActivo ? Date.now() : 0
  let stream
  try {
    stream = await conReintento(() => client.messages.create({ ...parametrosClaude, stream: true }, { timeout: TIMEOUT_ANTHROPIC_MS }), 'conversacion')
    console.log('[STREAM][chat] modeloRespondio=true')
  } catch (err) {
    // Antes esto no estaba envuelto en try/catch: cualquier falla real
    // de Claude (límite de crédito, rate limit, error de red, petición
    // inválida) tronaba la ruta entera sin responder nada — el cliente
    // (MotorTextoClaude) leía un cuerpo vacío y lo trataba como una
    // respuesta válida, produciendo la burbuja vacía reportada. El
    // detalle real (que puede incluir mensajes crudos de la API de
    // Anthropic) se queda SOLO en el log — el maestro nunca debe verlo,
    // ver ARQUITECTURA MAESTRA, principio de ERRORES.
    console.error(`[IA:conversacion] Falla definitiva (categoría=${clasificarErrorIA(err)}):`, err)
    console.log(`[STREAM][chat] errorEtapa=antes_de_stream nombreError=${err instanceof Error ? err.name : 'desconocido'} duracionTotalMs=${Date.now() - inicioRequestMs}`)
    return NextResponse.json({ error: MENSAJE_ERROR_GENERICO }, { status: 502 })
  }

  const encoder = new TextEncoder()
  // INSTRUMENTACIÓN DIAGNÓSTICA TEMPORAL — usage real que Anthropic ya
  // entrega dentro del mismo stream que se está leyendo de todas formas
  // (eventos message_start/message_delta) — NUNCA una llamada extra ni
  // contenido adicional enviado al modelo. Se queda en null si el
  // gate está apagado o si esos eventos no llegan a aparecer.
  let usageInputTokens: number | null = null
  let usageOutputTokens: number | null = null
  let usageCacheRead: number | null = null
  let usageCacheWrite: number | null = null
  let primerDeltaTelemetria = false
  // Chat IA — Registro escolar: acumula el tool_use mientras Claude lo
  // transmite en fragmentos (content_block_start -> delta -> stop) antes
  // de ejecutar el guardado real (ver lib/motorContexto.ts).
  let toolUseActivo: { id: string; name: string; inputJson: string } | null = null
  // Corrección funcional de C-005 — acumula el texto completo del
  // borrador mientras se transmite, para poder extraer su bloque de
  // resumen EN CUANTO termine el streaming, dentro del mismo turno
  // (ver más abajo, después del for-await).
  let textoBorradorAcumulado = ''
  const readable = new ReadableStream({
    async start(controller) {
      // Guard defensivo — [[IMAGEN:...]] jamás debe llegar crudo al
      // maestro en una respuesta conversacional normal (ver caso real:
      // tras una falla previa, "Continua" hizo que Claude reprodujera
      // el marcador interno de MODO IMAGEN fuera de ese modo). SOLO
      // aplica a esta rama de streaming — el camino legítimo de
      // documentos ilustrados (CASO 3, más arriba en esta función)
      // retorna con respuestaTexto() mucho antes de llegar aquí, así
      // que este guard nunca puede tocar ese contenido interno legítimo
      // (analizado después por parseContenido.ts/herramientas.ts para
      // Word/PDF). Un marcador puede llegar partido entre varios chunks
      // del streaming real de Claude — nunca se filtra chunk por chunk:
      // se acumula y solo se libera al cliente el texto que YA es
      // seguro (nunca puede terminar formando "[[IMAGEN:"), reteniendo
      // como máximo los últimos caracteres que todavía podrían ser el
      // inicio de ese prefijo formándose entre este chunk y el
      // siguiente.
      const MARCADOR_IMAGEN_INICIO = '[[IMAGEN:'
      let bufferPendienteSanitizado = ''
      let dentroDeMarcadorImagen = false
      let seEnvioTextoVisible = false
      // POSTPROCESADO DETERMINÍSTICO DEL DÍA DE LA SEMANA — cuando
      // anioDiaSemanaAutorizado existe (ver más arriba, condición ya
      // muy conservadora), esta respuesta completa se retiene en un
      // buffer en vez de transmitirse en vivo: solo así el servidor
      // puede leer el texto final de Claude (única fuente real donde el
      // hecho resuelto por web_search se vuelve visible, ver auditoría
      // de arquitectura) y corregir el día de la semana antes de
      // entregarlo. Nunca cambia el streaming del resto del chat — el
      // guard de [[IMAGEN:...]] arriba sigue intacto, solo se redirige
      // su salida a este buffer en vez de al cliente directamente.
      let bufferRespuestaCompleta: string | null = anioDiaSemanaAutorizado !== null ? '' : null
      function entregarTextoSeguro(texto: string) {
        if (bufferRespuestaCompleta !== null) { bufferRespuestaCompleta += texto; return }
        controller.enqueue(encoder.encode(texto))
      }
      function emitirTextoSano(delta: string) {
        bufferPendienteSanitizado += delta
        while (true) {
          if (dentroDeMarcadorImagen) {
            const cierre = bufferPendienteSanitizado.indexOf(']]')
            if (cierre === -1) return // seguimos dentro del marcador — nada seguro que liberar todavía
            bufferPendienteSanitizado = bufferPendienteSanitizado.slice(cierre + 2)
            dentroDeMarcadorImagen = false
            continue
          }
          const inicio = bufferPendienteSanitizado.indexOf(MARCADOR_IMAGEN_INICIO)
          if (inicio !== -1) {
            const seguro = bufferPendienteSanitizado.slice(0, inicio)
            if (seguro) { entregarTextoSeguro(seguro); seEnvioTextoVisible = true }
            bufferPendienteSanitizado = bufferPendienteSanitizado.slice(inicio)
            dentroDeMarcadorImagen = true
            continue
          }
          // Sin marcador confirmado todavía: se retiene solo el sufijo
          // que aún podría convertirse en "[[IMAGEN:" con el próximo
          // chunk — el resto ya es 100% seguro y se libera de inmediato,
          // preservando el streaming en vivo para el caso normal.
          let retener = 0
          const maxRetener = Math.min(bufferPendienteSanitizado.length, MARCADOR_IMAGEN_INICIO.length - 1)
          for (let n = maxRetener; n > 0; n--) {
            if (MARCADOR_IMAGEN_INICIO.startsWith(bufferPendienteSanitizado.slice(-n))) { retener = n; break }
          }
          const seguro = bufferPendienteSanitizado.slice(0, bufferPendienteSanitizado.length - retener)
          if (seguro) { entregarTextoSeguro(seguro); seEnvioTextoVisible = true }
          bufferPendienteSanitizado = bufferPendienteSanitizado.slice(bufferPendienteSanitizado.length - retener)
          return
        }
      }
      try {
        console.log('[STREAM][chat] streamInicio=true')
        for await (const event of stream) {
          // INSTRUMENTACIÓN DIAGNÓSTICA TEMPORAL — usage real ya
          // presente en estos mismos eventos del stream, sin ninguna
          // llamada ni contenido adicional.
          if (diagnosticoCurpActivo) {
            if (event.type === 'message_start') {
              usageInputTokens = event.message.usage.input_tokens ?? null
              usageCacheRead = (event.message.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? null
              usageCacheWrite = (event.message.usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? null
            }
            if (event.type === 'message_delta' && event.usage) {
              usageOutputTokens = event.usage.output_tokens ?? null
            }
          }
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            if (!primerDeltaTelemetria) {
              primerDeltaTelemetria = true
              marcarTelemetria('claude:first_text_received')
            }
            emitirTextoSano(event.delta.text)
            if (esTurnoDeBorradorPlaneacion) textoBorradorAcumulado += event.delta.text
          }

          // Chat IA — Registro escolar: a diferencia de web_search
          // (server-side, Anthropic la ejecuta sola), esta tool es
          // client-side — nuestro backend tiene que ejecutar el guardado
          // real en Supabase y devolver un tool_result antes de que la
          // conversación pueda continuar. Se captura el JSON parcial
          // mientras llega y se ejecuta solo cuando el bloque cierra.
          if (event.type === 'content_block_start' && event.content_block.type === 'tool_use' && event.content_block.name === 'registrar_dato_escolar') {
            toolUseActivo = { id: event.content_block.id, name: event.content_block.name, inputJson: '' }
            console.log('[REGISTRO_ESCOLAR] Claude invocó registrar_dato_escolar para este turno')
          }
          if (toolUseActivo && event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
            toolUseActivo.inputJson += event.delta.partial_json
          }
          if (toolUseActivo && event.type === 'content_block_stop') {
            try {
              const input = JSON.parse(toolUseActivo.inputJson)
              console.log(`[REGISTRO_ESCOLAR] tipo=${input.tipo} registros=${input.registros?.length}`)

              const resultadoGuardado = await ejecutarRegistroEscolar(supabaseUser!, userId!, sesion!.grupo_activo_id!, input.tipo, input.registros)

              const streamContinuacion = await conReintento(
                () => client.messages.create({
                  ...parametrosClaude,
                  messages: [
                    ...parametrosClaude.messages,
                    { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: toolUseActivo!.id, name: toolUseActivo!.name, input }] },
                    { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: toolUseActivo!.id, content: JSON.stringify(resultadoGuardado) }] },
                  ],
                  stream: true,
                }, { timeout: TIMEOUT_ANTHROPIC_MS }),
                'registro_escolar_continuacion'
              )
              for await (const eventoContinuacion of streamContinuacion) {
                if (eventoContinuacion.type === 'content_block_delta' && eventoContinuacion.delta.type === 'text_delta') {
                  emitirTextoSano(eventoContinuacion.delta.text)
                }
              }
              toolUseActivo = null
            } catch (e) {
              console.error('[REGISTRO_ESCOLAR] error ejecutando o continuando:', e)
              controller.enqueue(encoder.encode('\n\nHubo un problema guardando los datos. Intenta de nuevo en unos segundos.'))
              toolUseActivo = null
            }
          }

          // "Consultar información oficial vigente de la SEP" — SEGURIDAD:
          // registro interno de qué pasó con la búsqueda (nunca expuesto
          // al maestro) — nunca el contenido recuperado de las páginas,
          // solo si Claude la invocó y si tuvo éxito o falló, para poder
          // diagnosticar sin exponer errores técnicos en el chat.
          if (requiereConsultaOficial && event.type === 'content_block_start') {
            if (event.content_block.type === 'server_tool_use' && event.content_block.name === 'web_search') {
              console.log('[CONSULTA_OFICIAL] Claude invocó web_search para este turno')
            }
            if (event.content_block.type === 'web_search_tool_result') {
              const contenido = event.content_block.content
              if (Array.isArray(contenido)) {
                console.log(`[CONSULTA_OFICIAL] resultado ok — ${contenido.length} fuente(s): ${contenido.map((r) => new URL(r.url).hostname).join(', ')}`)
              } else {
                console.log(`[CONSULTA_OFICIAL] resultado con error — error_code=${contenido.error_code}`)
              }
            }
          }
        }
        // Cierre del guard [[IMAGEN:...]] — si el streaming terminó a
        // mitad de un marcador (nunca cerró "]]"), todo lo retenido era
        // parte del marcador y se descarta sin enviarlo. Si terminó
        // fuera de un marcador, lo retenido ya es texto normal seguro y
        // se libera. Si al final nunca se envió nada visible al maestro
        // (la respuesta completa era el marcador, o venía vacía), se
        // entrega una respuesta corta y segura en su lugar — nunca una
        // burbuja vacía ni el contenido interno crudo.
        if (!dentroDeMarcadorImagen && bufferPendienteSanitizado) {
          entregarTextoSeguro(bufferPendienteSanitizado)
          seEnvioTextoVisible = true
        }
        bufferPendienteSanitizado = ''
        if (!seEnvioTextoVisible) {
          entregarTextoSeguro('No pude continuar esa imagen desde el contexto actual. Indícame el cambio que deseas y la retomamos.')
        }
        // Cierre del postprocesado determinístico del día de la semana
        // (ver "postprocesado determinístico del día de la semana para
        // consultas factuales con año explícito") — la respuesta
        // completa ya está en bufferRespuestaCompleta (nunca se envió
        // en vivo). SELECCIÓN CONSERVADORA de la fecha objetivo (ver
        // "cerrar riesgo de asociación — más de una fecha del mismo año
        // en la respuesta"): nunca basta con filtrar por año, porque la
        // respuesta puede traer más de una fecha distinta de ese año
        // (ej. la fecha de la efeméride Y la fecha de publicación de la
        // fuente citada) — corregir ambas sería demasiado agresivo.
        // CASO A: si el propio mensaje del docente ya trae una fecha
        // completa de ese año, esa es la fuente más segura — se usa
        // ella sin importar cuántas otras fechas mencione Claude en su
        // respuesta. CASO B: si el docente solo dio el año (la fecha
        // nace de FASE 1/web_search), se acepta la fecha de la
        // respuesta SOLO si es la única distinta de ese año — ante dos
        // o más fechas distintas, es AMBIGUO y no se modifica nada
        // (mejor no corregir que corregir el dato equivocado). Fechas
        // repetidas (misma clave normalizada) cuentan como una sola.
        if (bufferRespuestaCompleta !== null) {
          let textoFinal = bufferRespuestaCompleta
          if (anioDiaSemanaAutorizado !== null) {
            const clave = (texto: string) => texto.toLowerCase()
            const fechasDelMensaje = calcularDiasSemanaDeFechasExplicitas(mensaje || '', zonaHoraria)
              .filter((f) => f.textoOriginal.endsWith(String(anioDiaSemanaAutorizado)))
            const clavesUnicasMensaje = new Set(fechasDelMensaje.map((f) => clave(f.textoOriginal)))
            const fechasEncontradas = calcularDiasSemanaDeFechasExplicitas(textoFinal, zonaHoraria)
              .filter((f) => f.textoOriginal.endsWith(String(anioDiaSemanaAutorizado)))

            let claveObjetivo: string | null = null
            let diaCorrectoObjetivo: string | null = null
            let ambiguo = false
            let cantidadDistintas = 0

            if (clavesUnicasMensaje.size === 1) {
              claveObjetivo = [...clavesUnicasMensaje][0]
              diaCorrectoObjetivo = fechasDelMensaje.find((f) => clave(f.textoOriginal) === claveObjetivo)!.diaSemana
            } else {
              const porClave = new Map<string, string>()
              for (const f of fechasEncontradas) porClave.set(clave(f.textoOriginal), f.diaSemana)
              cantidadDistintas = porClave.size
              if (porClave.size === 1) {
                claveObjetivo = [...porClave.keys()][0]
                diaCorrectoObjetivo = [...porClave.values()][0]
              } else if (porClave.size > 1) {
                ambiguo = true
              }
            }

            if (ambiguo) {
              console.log(`[DIA_SEMANA_POST] ambiguo_fechas_objetivo=${cantidadDistintas}`)
            } else if (claveObjetivo !== null && diaCorrectoObjetivo !== null) {
              const variantesReales = new Set(fechasEncontradas.filter((f) => clave(f.textoOriginal) === claveObjetivo).map((f) => f.textoOriginal))
              if (variantesReales.size > 0) {
                let corrigioAlguna = false
                for (const fechaTexto of variantesReales) {
                  const resultado = aplicarCorreccionDiaSemana(textoFinal, fechaTexto, diaCorrectoObjetivo)
                  textoFinal = resultado.texto
                  if (resultado.corregido) corrigioAlguna = true
                }
                console.log(`[DIA_SEMANA_POST] activado fechas_objetivo=1 corregido=${corrigioAlguna}`)
              } else {
                console.log('[DIA_SEMANA_POST] fecha_objetivo_no_mencionada_en_respuesta')
              }
            } else {
              // FALLBACK DÍA+MES (ver "fallback conservador día+mes
              // para consultas factuales con año explícito") — solo
              // entra aquí cuando ni el mensaje del docente ni una
              // fecha completa en la respuesta resolvieron un
              // objetivo, y tampoco hubo ambigüedad de fechas
              // completas (esa rama de arriba SIEMPRE tiene prioridad
              // absoluta). Cubre el caso real donde Claude separa el
              // año del resto de la fecha al redactar ("16 de
              // septiembre cae en martes en 2026"), que
              // calcularDiasSemanaDeFechasExplicitas no reconoce como
              // fecha completa por sí solo.
              const candidatosParciales = new Map<string, { dia: string; mes: string; textos: Set<string> }>()
              const regexParcial = new RegExp(REGEX_DIA_MES_PARCIAL.source, 'gi')
              let coincidenciaParcial: RegExpExecArray | null
              while ((coincidenciaParcial = regexParcial.exec(textoFinal)) !== null) {
                const dia = coincidenciaParcial[1]
                const mes = coincidenciaParcial[2].toLowerCase()
                const claveParcial = `${dia}|${mes}`
                if (!candidatosParciales.has(claveParcial)) candidatosParciales.set(claveParcial, { dia, mes, textos: new Set() })
                candidatosParciales.get(claveParcial)!.textos.add(coincidenciaParcial[0])
              }

              if (candidatosParciales.size === 1) {
                const { dia, mes, textos } = [...candidatosParciales.values()][0]
                // Fecha canónica construida internamente solo para
                // consultar TimeService — nunca se le pide a Claude
                // que la haya escrito así, y TimeService sigue siendo
                // la única autoridad de calendario (ver "no modificar
                // TimeService").
                const fechaCanonica = `${dia} de ${mes} de ${anioDiaSemanaAutorizado}`
                const calculoParcial = calcularDiasSemanaDeFechasExplicitas(fechaCanonica, zonaHoraria)
                if (calculoParcial.length === 1) {
                  const diaCorrectoParcial = calculoParcial[0].diaSemana
                  let corrigioAlguna = false
                  for (const fechaTexto of textos) {
                    // evitarSiAnioInmediatoDespues=true — nunca tocar
                    // "23 de noviembre" cuando en realidad es parte de
                    // "23 de noviembre de 1825" (ver REGEX_ANIO_INMEDIATO_DESPUES).
                    const resultado = aplicarCorreccionDiaSemana(textoFinal, fechaTexto, diaCorrectoParcial, true)
                    textoFinal = resultado.texto
                    if (resultado.corregido) corrigioAlguna = true
                  }
                  console.log(`[DIA_SEMANA_POST] fallback_dia_mes activado corregido=${corrigioAlguna}`)
                } else {
                  console.log('[DIA_SEMANA_POST] sin_fecha_objetivo')
                }
              } else if (candidatosParciales.size > 1) {
                console.log(`[DIA_SEMANA_POST] ambiguo_dia_mes=${candidatosParciales.size}`)
              } else {
                console.log('[DIA_SEMANA_POST] sin_fecha_objetivo')
              }
            }
          }
          controller.enqueue(encoder.encode(textoFinal))
        }
        marcarTelemetria('claude:response_finished')
        console.log(`[STREAM][chat] streamFinalizado=true duracionStreamMs=${Date.now() - inicioRequestMs}`)
        // Telemetría segura — cuenta cuántos adjuntos quedaron
        // realmente construidos en este turno (0, 1 o 2), nunca su
        // contenido.
        let cantidadAdjuntos = 0

        // Corrección funcional — "falta mostrar y descargar la
        // planeación": el borrador completo (no solo su hoja de
        // evaluación) también se adjunta como documento descargable en
        // el MISMO turno, sin persistir nada (no sube a Storage, no
        // crea filas en ninguna tabla) — reutiliza generarPdfBuffer/
        // generarWordBuffer (los mismos generadores ya usados para
        // Word/PDF/PPT/Excel de cualquier documento formal), nunca un
        // generador nuevo. Va PRIMERO (planeación, luego hoja) para
        // que la tarjeta de la planeación aparezca antes en pantalla,
        // tal como se pidió.
        //
        // AJUSTE AISLADO — "descarga real en Word y PDF, sin botones
        // redundantes": se emiten DOS marcadores (Word y PDF) con el
        // MISMO tipoDocumento='planeacion' — TarjetaDescarga los agrupa
        // en una sola tarjeta con un botón por formato (nunca dos
        // tarjetas separadas para el mismo documento lógico). Ninguno
        // de los dos pasa por un botón de conversión ni por el modelo:
        // ambos se generan aquí, directo desde el mismo texto completo
        // del borrador, en el mismo turno en que Claude lo redactó.
        if (esTurnoDeBorradorPlaneacion && sesion?.grupo_activo_id) {
          try {
            const textoCompleto = extraerTextoCompletoBorrador(textoBorradorAcumulado)
            console.log(`[STREAM][chat] borradorExtraido=${!!textoCompleto}`)
            if (textoCompleto) {
              const resumenParaTitulo = extraerResumenBorrador([{ role: 'assistant', content: textoBorradorAcumulado }])
              const datosDocumento = { texto: textoCompleto, zonaHoraria: zonaHoraria ?? null }
              const datosComprimidos = gzipSync(Buffer.from(JSON.stringify(datosDocumento), 'utf-8')).toString('base64url')
              const descripcionPlaneacion = resumenParaTitulo
                ? `${resumenParaTitulo.periodoTexto || 'Sin periodo asignado'} · ${resumenParaTitulo.duracionDias ?? '—'} días efectivos`
                : undefined
              // tipoDocumento viaja EXPLÍCITO en la URL (corrección "el
              // adjunto de planeación abre la hoja de evaluación") — la
              // ruta de vista previa lo exige y lo valida antes de
              // generar nada, nunca lo infiere solo de a qué endpoint
              // llegó la petición.
              const urlWord = `/api/planeaciones/vista-previa-documento-word?tipoDocumento=planeacion&token=${encodeURIComponent(accessToken)}&datos=${datosComprimidos}`
              // AJUSTE AISLADO — "corregir únicamente el nombre del
              // archivo Word de la planeación": antes este nombre venía
              // hardcodeado ('vista-previa-planeacion.docx'), sin
              // ninguna relación con el nombre real que
              // vista-previa-documento-word/route.ts calcula y manda en
              // su propio Content-Disposition (nombreArchivoWordServidor
              // (extraerTitulo(texto)), la MISMA fuente que ya usa esa
              // ruta) — como descargarArchivo() en AsistentePanel.tsx
              // trae el Word por blob (a diferencia del PDF, que ya
              // descarga por enlace directo), el nombre visible al
              // guardar sale del atributo `download` del propio
              // navegador, es decir de este campo `nombre`, NUNCA del
              // Content-Disposition del fetch original — por eso el
              // desajuste era 100% visible aunque el servidor ya
              // mandara el nombre correcto. Se computa aquí con la
              // MISMA función (nombreArchivoWordServidor) sobre el
              // MISMO texto (textoCompleto) que ya usa esa ruta —
              // fuente única, nunca puede desalinearse.
              const archivoWord = {
                tipo: 'word',
                nombre: nombreArchivoWordServidor(extraerTitulo(textoCompleto)),
                url: urlWord,
                tipoDocumento: 'planeacion' as const,
                descripcion: descripcionPlaneacion,
              }
              const marcadorWord = `[[DOCUMENTO_ARCHIVO:${Buffer.from(JSON.stringify(archivoWord), 'utf-8').toString('base64')}]]`
              controller.enqueue(encoder.encode(`\n\n${marcadorWord}`))
              cantidadAdjuntos++

              // modo=ver / modo=descargar (CORRECCIÓN AISLADA — "separar
              // 'Ver PDF' de 'Descargar PDF'"): misma ruta, mismo
              // `datos` comprimido (nunca se regenera contenido
              // distinto) — solo cambian las cabeceras de respuesta
              // según el modo, ver vista-previa-documento/route.ts.
              const urlDocumento = `/api/planeaciones/vista-previa-documento?tipoDocumento=planeacion&token=${encodeURIComponent(accessToken)}&datos=${datosComprimidos}&modo=descargar`
              const urlVerDocumento = `/api/planeaciones/vista-previa-documento?tipoDocumento=planeacion&token=${encodeURIComponent(accessToken)}&datos=${datosComprimidos}&modo=ver`
              const archivoDocumento = {
                tipo: 'pdf',
                nombre: 'vista-previa-planeacion.pdf',
                url: urlDocumento,
                urlVer: urlVerDocumento,
                tipoDocumento: 'planeacion' as const,
                descripcion: descripcionPlaneacion,
              }
              const marcadorDocumento = `[[DOCUMENTO_ARCHIVO:${Buffer.from(JSON.stringify(archivoDocumento), 'utf-8').toString('base64')}]]`
              controller.enqueue(encoder.encode(`\n\n${marcadorDocumento}`))
              cantidadAdjuntos++
              console.log('[STREAM][chat] planeacionPdfGenerado=true planeacionWordGenerado=true')
            }
          } catch (e) {
            // Nunca rompe la respuesta del borrador por esto — el
            // docente ya tiene el texto completo en pantalla; el
            // documento descargable es un extra, no una condición
            // para poder seguir.
            console.error('[PLANEACION_GENERAR] fallo preparando la vista previa del documento de planeación:', e)
            console.log(`[STREAM][chat] errorEtapa=planeacion_pdf nombreError=${e instanceof Error ? e.name : 'desconocido'}`)
          }
        }

        // Corrección funcional de C-005 — vista previa descargable de
        // la hoja de evaluación, adjunta en el MISMO turno en que se
        // presentó/corrigió el borrador, sin persistir nada (no sube a
        // Storage, no crea filas en ninguna tabla): reutiliza el mismo
        // marcador [[DOCUMENTO_ARCHIVO:...]] que ya usan Word/PDF/PPT,
        // así que la tarjeta compacta de descarga aparece sin ningún
        // cambio en la interfaz. Si el borrador no quedó completo
        // (Claude no incluyó el bloque de resumen porque hubo
        // conflicto de fechas), extraerResumenBorrador devuelve null y
        // no se adjunta nada.
        if (esTurnoDeBorradorPlaneacion && sesion?.grupo_activo_id) {
          try {
            const resumenBorrador = extraerResumenBorrador([{ role: 'assistant', content: textoBorradorAcumulado }])
            if (resumenBorrador) {
              const datosVistaPrevia = {
                grupoId: sesion.grupo_activo_id,
                nombreProyecto: resumenBorrador.nombre,
                camposFormativos: resumenBorrador.camposFormativos,
                trimestreNombre: resumenBorrador.periodoTexto,
                fechaInicio: resumenBorrador.fechaInicio,
                fechaFin: resumenBorrador.fechaFin,
                indicadores: resumenBorrador.indicadores,
                zonaHoraria: zonaHoraria ?? null,
              }
              const datosCodificados = Buffer.from(JSON.stringify(datosVistaPrevia), 'utf-8').toString('base64')
              // tipoDocumento explícito en la URL, igual que en el
              // adjunto de la planeación — la ruta lo exige y lo valida
              // antes de generar nada (ver corrección "el adjunto de
              // planeación abre la hoja de evaluación").
              // modo=ver / modo=descargar — mismo criterio que la
              // planeación arriba, ver vista-previa-hoja/route.ts.
              const url = `/api/planeaciones/vista-previa-hoja?tipoDocumento=hoja_evaluacion&token=${encodeURIComponent(accessToken)}&datos=${encodeURIComponent(datosCodificados)}&modo=descargar`
              const urlVer = `/api/planeaciones/vista-previa-hoja?tipoDocumento=hoja_evaluacion&token=${encodeURIComponent(accessToken)}&datos=${encodeURIComponent(datosCodificados)}&modo=ver`
              const archivo = {
                tipo: 'pdf',
                nombre: 'vista-previa-hoja-evaluacion.pdf',
                url,
                urlVer,
                tipoDocumento: 'hoja_evaluacion' as const,
                descripcion: `${sesion.alumnos_del_grupo_activo.length} alumno${sesion.alumnos_del_grupo_activo.length === 1 ? '' : 's'} · ${resumenBorrador.indicadores.length} indicador${resumenBorrador.indicadores.length === 1 ? '' : 'es'}`,
              }
              const marcador = `[[DOCUMENTO_ARCHIVO:${Buffer.from(JSON.stringify(archivo), 'utf-8').toString('base64')}]]`
              controller.enqueue(encoder.encode(`\n\n${marcador}`))
              cantidadAdjuntos++
              console.log('[STREAM][chat] evaluacionPdfGenerada=true')
            }
          } catch (e) {
            // Nunca rompe la respuesta del borrador por esto — el
            // docente ya tiene el texto completo; la vista previa es
            // un extra, no una condición para poder seguir.
            console.error('[PLANEACION_GENERAR] fallo preparando la vista previa de la hoja:', e)
            console.log(`[STREAM][chat] errorEtapa=hoja_pdf nombreError=${e instanceof Error ? e.name : 'desconocido'}`)
          }
        }
        console.log(`[STREAM][chat] eventoFinalEnviado=true cantidadAdjuntos=${cantidadAdjuntos} duracionTotalMs=${Date.now() - inicioRequestMs}`)
        // INSTRUMENTACIÓN DIAGNÓSTICA TEMPORAL — mismo marcador que la
        // ruta determinista de arriba, aplicado aquí al streaming de
        // Claude (Nivel 4 / turnos con imagen) — mismo mecanismo exacto
        // que ya usa [[DOCUMENTO_ARCHIVO:...]] unas líneas arriba.
        if (diagnosticoCurpActivo) {
          trazaDebug.etapa = 'streaming Nivel 4 completado'
          trazaDebug.herramientaEjecutada = trazaDebug.herramientaEjecutada ?? 'conversacion_general_o_nivel4'
          registrarLlamadaIA({
            proveedor: 'anthropic',
            modelo: parametrosClaude.model,
            finalidad: 'respuesta',
            ms: Date.now() - tNivel4LlamadaInicio,
            usageDisponible: usageInputTokens !== null || usageOutputTokens !== null,
            inputTokens: usageInputTokens,
            outputTokens: usageOutputTokens,
            cacheReadTokens: usageCacheRead,
            cacheWriteTokens: usageCacheWrite,
          })
          controller.enqueue(encoder.encode(marcadorDiagnostico()))
        }
      } catch (err) {
        // Ya se había empezado a mandar texto plano — no se puede
        // convertir esto en un JSON de error a estas alturas.
        //
        // CORRECCIÓN ("Error al conectar con la IA" después de mostrar
        // parte de la planeación) — antes esto solo registraba el error
        // y llamaba a controller.close() (cierre NORMAL): el docente se
        // quedaba con texto cortado a medias sin ningún aviso, o —si la
        // conexión ya estaba rota por el mismo motivo que causó este
        // catch (ver TIMEOUT_ANTHROPIC_MS)— el navegador lo interpretaba
        // como una respuesta de red trunca ("Error al conectar con la
        // IA", el catch-all genérico de motorTextoClaude.ts). Con
        // controller.error() el cliente SIEMPRE recibe una señal
        // explícita y distinguible (ver motorTextoClaude.ts,
        // RESPUESTA_INTERRUMPIDA) en vez de dejarlo adivinar entre "se
        // cortó la red" y "ya terminó".
        console.error('Error durante el streaming de Claude:', err)
        console.log(`[STREAM][chat] errorEtapa=claude_streaming nombreError=${err instanceof Error ? err.name : 'desconocido'} duracionTotalMs=${Date.now() - inicioRequestMs}`)
        controller.error(new Error('RESPUESTA_INTERRUMPIDA'))
        return
      }
      controller.close()
    },
  })

  // FASE 2B1 (ver "transporte interno de la decisión del orquestador")
  // — el body sigue siendo exactamente el mismo stream de texto plano
  // de siempre (nunca SSE, nunca NDJSON, nunca un marcador nuevo en el
  // body). El header es OPCIONAL y solo se agrega cuando ya existe una
  // decisión contextual válida (ver arriba); mismo patrón de
  // codificación (Buffer → base64) que route.ts ya usa para los demás
  // payloads internos (ej. [[DOCUMENTO_ARCHIVO:...]]), aquí en un
  // header en vez de dentro del texto — la decisión no es contenido.
  const headersRespuesta: Record<string, string> = { 'Content-Type': 'text/plain; charset=utf-8' }
  if (decisionOrquestadorParaHeader) {
    headersRespuesta[HEADER_DECISION_ORQUESTADOR] = Buffer.from(JSON.stringify(decisionOrquestadorParaHeader), 'utf-8').toString('base64')
  }
  return new Response(readable, {
    headers: headersRespuesta,
  })
}
