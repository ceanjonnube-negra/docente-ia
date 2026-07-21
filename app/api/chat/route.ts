import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'
import { clasificarNivel0 } from '@/lib/clasificadorNivel0'
import { obtenerSesionContexto } from '@/lib/sesionContexto'
import {
  calendarioCicloCompleto,
  categoriaEventoCalendario,
  construirTextoListaAlumnos,
  contextoAlumno,
  contextoGrupo,
  escribirAsistencia,
  registrarAsistenciaMasiva,
} from '@/lib/motorContexto'
import { ejecutarHerramientaDeModulo } from '@/lib/asistente/herramientasModulo'
import { obtenerFechaHora } from '@/lib/tiempo/TimeService'
import { MARCO_CURRICULAR_VIGENTE } from '@/lib/asistente/marcoCurricular'
import { detectarHerramientaDocumento, esDocumentoFormal, type TipoHerramienta } from '@/lib/asistente/documentos'
import type { AccionNavegacion } from '@/lib/asistente/tipos'
import { ejecutarHerramientaDocumento, ErrorHerramientaDocumento, HerramientaNoDisponibleError, ETIQUETA_MODULO } from '@/lib/documentGen/herramientas'
import { clasificarTipoDocumento, extraerTextoDocumento } from '@/lib/documentGen/extraerTextoDocumento'

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

// El maestro nunca debe ver detalle técnico (HTTP, JSON, mensajes crudos
// de la API de Anthropic/OpenAI, stack traces) — ver ARQUITECTURA
// MAESTRA, principio de ERRORES. El detalle real siempre se registra con
// console.error para diagnóstico; esto es lo único que llega al chat.
const MENSAJE_ERROR_GENERICO = 'No fue posible completar la solicitud en este momento. Intenta de nuevo en unos segundos.'
const MENSAJE_ERROR_DOCUMENTO = 'No fue posible generar el documento en este momento. Toca para intentar de nuevo.'

// Tiempo máximo que se espera la respuesta de Anthropic antes de darla
// por colgada — sin esto, una llamada que nunca resuelve (no rechaza, no
// responde) deja al maestro viendo "Generando..." indefinidamente, sin
// que ningún catch se dispare nunca. 25s es generoso para el primer byte
// de un stream real, pero corta una conexión realmente muerta.
const TIMEOUT_ANTHROPIC_MS = 25_000
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
  const { mensaje, historial, contexto, institucionId, imagenBase64, imagenTipo, nombreArchivo, imagenesBase64, userId, accessToken, zonaHoraria, finalizarArchivo, esEdicionDocumento } = await req.json()

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
  const supabaseUser = accessToken
    ? createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
        global: { headers: { Authorization: `Bearer ${accessToken}` } },
      })
    : null

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

    if (finalizarArchivo && typeof finalizarArchivo === 'object' && typeof finalizarArchivo.documentoTexto === 'string') {
      documentoTexto = finalizarArchivo.documentoTexto
      fuenteContenido = 'cliente'
    } else {
      const ultimoDocumento = [...historialMensajes].reverse().find((h) => h.role === 'assistant' && esDocumentoFormal(h.content))
      if (ultimoDocumento) {
        documentoTexto = ultimoDocumento.content
        fuenteContenido = 'historial'
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
        const archivo = await conReintento(() => ejecutarHerramientaDocumento(tipoHerramientaSolicitado, documentoTexto, perfil, zonaHoraria, supabaseRAG, userId), 'generar-archivo')
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
  const pideListaAlumnos =
    !esEdicionDocumento &&
    (SOLICITA_LISTA_ALUMNOS.test(mensaje || '') ||
      (Boolean(tipoHerramientaSolicitado) && /\blista(do)?\b|\bpadr[oó]n\b/i.test(mensaje || '')))

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

  // --- Clasificador de Nivel 0 — se llama SIEMPRE que hay sesión real,
  // sin ningún filtro de palabras clave delante (ver la nota de
  // arquitectura junto a los imports: ningún filtro local puede
  // garantizar que cubre cada forma de preguntar algo). Si el mensaje
  // no tiene nada que clasificar, el propio clasificador devuelve
  // "conversacion_general" y el flujo sigue exactamente igual. ---
  let contextoEnriquecido = [contexto || '', resumenGrupoTexto || ''].filter(Boolean).join('\n\n')
  if (supabaseUser && userId && sesion) {
    try {
      // Últimos turnos reales — solo para que el clasificador pueda
      // resolver una confirmación breve ("sí") como continuación de su
      // propia pregunta "¿Te refieres a...?" del turno anterior (ver
      // regla 13 en clasificadorNivel0.ts). No es historial "de
      // edición" (esEdicionDocumento), así que no aplica ese riesgo.
      const clasificacion = await clasificarNivel0(mensaje, sesion, historialMensajes.slice(-4))
      // Diagnóstico — nunca visible al maestro. Con esto se puede ver en
      // vercel logs EXACTAMENTE por qué una consulta como "¿cuántas
      // faltas tiene Audrey?" no llegó a responder con el dato real: si
      // el clasificador no resolvió al alumno, si sesion.ciclo_escolar_id
      // viene null (el contexto activo del docente no tiene ciclo
      // escolar configurado), o si consultarAsistenciaAlumno falló.
      console.log(
        `[NIVEL0] intencion=${clasificacion.intencion_principal} nivel=${clasificacion.nivel_ejecucion} alumno_id=${clasificacion.entidades_resueltas.alumno_id} alumno_detectado=${clasificacion.entidades_resueltas.alumno_nombre_detectado} datos_faltantes=${JSON.stringify(clasificacion.datos_faltantes)} ciclo_escolar_id=${sesion.ciclo_escolar_id}`
      )

      // Caso: falta un dato esencial o hay ambigüedad → no se ejecuta
      // nada todavía, se le pide al docente que aclare.
      if (clasificacion.datos_faltantes.length > 0 || clasificacion.entidades_resueltas.alumno_ambiguo) {
        if (clasificacion.entidades_resueltas.alumno_ambiguo) {
          const opciones = clasificacion.entidades_resueltas.opciones_alumno_ambiguo.join(', ')
          return respuestaTexto(`Tengo más de un alumno que coincide con ese nombre: ${opciones}. ¿A cuál te refieres?`)
        }
        if (clasificacion.datos_faltantes.includes('alumno')) {
          return respuestaTexto('¿De qué alumno se trata?')
        }
      }

      // Separación estricta entre conversación libre y consultas de
      // módulos internos (ver lib/asistente/herramientasModulo.ts): si
      // la intención clasificada pertenece a un módulo con Herramienta
      // registrada (Asistencias, Incidencias, Apoyo, Documentos, y
      // cualquier futura que se registre ahí), la respuesta sale
      // ÚNICAMENTE de esa Herramienta — nunca del modelo grande. Único
      // punto de entrada para todas ellas; ver ese archivo para la
      // lista completa y por qué ficha_descriptiva/planeacion_nueva/
      // consultar_calendario NO están ahí (generación/razonamiento
      // real, no una cifra fija).
      const respuestaDeModulo = await ejecutarHerramientaDeModulo(clasificacion, {
        sb: supabaseUser,
        sesion,
        userId,
        zonaHoraria,
      })
      if (respuestaDeModulo !== null) return respuestaTexto(respuestaDeModulo)

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
          automatica: true,
        }
        const marcador = `[[NAVEGACION:${Buffer.from(JSON.stringify(accionNavegacion), 'utf-8').toString('base64')}]]`
        const etiquetaFiltro: Record<string, string> = { ausentes: 'los ausentes', presentes: 'los presentes', ninas: 'las niñas', ninos: 'los niños', todos: 'toda la lista' }
        console.log(`[NIVEL0] navegar_lista_filtrada OK — filtro=${filtro}`)
        return respuestaTexto(`Mostrando ${etiquetaFiltro[filtro] ?? 'la lista'}.\n${marcador}`)
      }

      // Nivel 4: ficha_descriptiva / planeacion_nueva / consultar_calendario
      // — estos tres siguen pasando por Claude a propósito (generación
      // real de un documento, o razonamiento sobre un rango de fechas
      // en lenguaje natural), pero SIEMPRE con datos reales ya
      // inyectados, nunca a ciegas. Las consultas de cifra fija
      // (asistencia, incidencias, apoyo, documentos) ya NO viven aquí
      // — se resuelven arriba, en ejecutarHerramientaDeModulo, sin
      // pasar nunca por el modelo grande (ver
      // lib/asistente/herramientasModulo.ts).
      if (clasificacion.nivel_ejecucion === 4 && clasificacion.requiere_contexto_memoria) {
        try {
          if (clasificacion.intencion_principal === 'ficha_descriptiva' && clasificacion.entidades_resueltas.alumno_id && sesion.ciclo_escolar_id) {
            const ctxAlumno = await contextoAlumno(supabaseUser, clasificacion.entidades_resueltas.alumno_id, sesion.ciclo_escolar_id)
            contextoEnriquecido += `\n\nCONTEXTO REAL DEL ALUMNO (usa estos datos, no inventes otros):\n${JSON.stringify(ctxAlumno)}`
          } else if (clasificacion.intencion_principal === 'planeacion_nueva' && sesion.grupo_activo_id) {
            const ctxGrupo = await contextoGrupo(supabaseUser, sesion.grupo_activo_id)
            contextoEnriquecido += `\n\nCONTEXTO REAL DEL GRUPO (usa estos datos, no inventes otros):\n${JSON.stringify(ctxGrupo)}`
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
    }
  }
  // --- Fin Clasificador de Nivel 0 ---

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

CAPACIDADES — Docente IA SÍ genera archivos reales y descargables (Word, PDF, PowerPoint, Excel) directamente desde esta conversación. La gran mayoría de las veces que el maestro pide el archivo (dice "Word", "DOCX", "archivo Word", "documento oficial", "para imprimir", "descárgalo", "pásamelo en Word" o equivalente) esta petición NUNCA llega hasta ti — el servidor ya la intercepta antes y ejecuta la herramienta de generación directamente, sin pasar por ti. Si de todos modos ves una de estas peticiones (caso raro: el maestro pide el archivo en el mismo mensaje en el que pide el documento por primera vez, sin haberlo platicado antes), tienes PROHIBIDO decir o insinuar cualquiera de estas frases o equivalentes: "no puedo crear archivos", "no puedo enviar Word", "no puedo generar documentos", "no pude generar el archivo", "aquí tienes el contenido para copiar", "pega esto en Word", "formato tipo Word", "puedes copiarlo", "cópialo en Word" — todas son falsas dentro de esta aplicación y tienes terminantemente prohibido escribir el contenido del documento como texto plano en el chat cuando el maestro pidió un archivo. En ese caso, ve directo al documento completo en MODO DOCUMENTO (ver abajo) empezando con su título en mayúsculas y emoji, SIN ninguna frase de confirmación antes ("Perfecto...", "Claro...", etc.) y SIN narrar ni explicar el contenido en prosa conversacional — la aplicación intercepta esa respuesta y genera el archivo real a partir de ella automáticamente; tu única salida válida es el documento en MODO DOCUMENTO, nunca una explicación de cómo obtenerlo manualmente.

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

EXÁMENES Y ACTIVIDADES — cuando el maestro pida un examen o actividad, usa este formato:
📝 EXAMEN / ACTIVIDAD
Grado: [grado] | Grupo: [grupo] | Fase: [fase según el grado, ver MARCO CURRICULAR VIGENTE]
Campo Formativo: [uno o más de los 4 campos formativos vigentes, nunca una asignatura del plan anterior]
Tema: [tema]
Fecha: [dejar en blanco para llenar]

🎯 PROPÓSITO
[descripción breve]

📋 INSTRUCCIONES
[instrucciones generales para el alumno]

✏️ REACTIVOS
1. [pregunta o instrucción de actividad]
2. [pregunta o instrucción de actividad]
3. [pregunta o instrucción de actividad]
(número de reactivos según lo solicitado por el docente, mínimo 5)

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
[actividad breve de cierre relacionada con la lectura: dibujo, escritura, comentario en grupo, etc.]`,
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

      if (texto && esDocumentoFormal(texto)) {
        console.log(`[PIPELINE ${etiquetaCaso3}:contenido] OK — ${texto.length} caracteres redactados por Claude — ${Date.now() - inicioContenido}ms`)
        const { data: perfil } = await supabaseUser.from('perfiles_docentes').select('*').eq('id', userId).single()
        // Ver nota en el CASO 1/2 arriba: Storage necesita service role.
        const archivo = await conReintento(() => ejecutarHerramientaDocumento(tipoHerramientaSolicitado, texto, perfil, zonaHoraria, supabaseRAG, userId), 'generar-archivo-combinado')
        const marcador = `[[DOCUMENTO_ARCHIVO:${Buffer.from(JSON.stringify(archivo), 'utf-8').toString('base64')}]]`
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
        const marcadorContenido = `[[DOCUMENTO_CONTENIDO:${Buffer.from(texto, 'utf-8').toString('base64')}]]`
        console.log(`[PIPELINE ${etiquetaCaso3}:entrega] OK — ${archivo.nombre}`)
        return respuestaTexto(`Documento generado correctamente.\n${marcador}\n${marcadorContenido}`)
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

  let stream
  try {
    stream = await conReintento(() => client.messages.create({ ...parametrosClaude, stream: true }, { timeout: TIMEOUT_ANTHROPIC_MS }), 'conversacion')
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
    return NextResponse.json({ error: MENSAJE_ERROR_GENERICO }, { status: 502 })
  }

  const encoder = new TextEncoder()
  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            controller.enqueue(encoder.encode(event.delta.text))
          }
        }
      } catch (err) {
        // Ya se había empezado a mandar texto plano — no se puede
        // convertir esto en un JSON de error a estas alturas. Se registra
        // para diagnóstico; el cliente ve la conexión cortarse, que ya
        // maneja como error (ver motorTextoClaude.ts).
        console.error('Error durante el streaming de Claude:', err)
      }
      controller.close()
    },
  })

  return new Response(readable, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
