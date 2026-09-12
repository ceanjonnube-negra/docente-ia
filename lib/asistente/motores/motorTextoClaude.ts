// lib/asistente/motores/motorTextoClaude.ts
//
// Motor de conversación por texto: envuelve el flujo de /api/chat que ya
// existía (streaming de texto vía Claude). Es el motor por defecto y el
// respaldo cuando MotorOpenAIRealtime (voz en tiempo real, ver
// motores/motorOpenAIRealtime.ts) no está disponible — AsistenteService
// decide cuál usar; ninguno de los dos sabe que el otro existe.

import { supabase } from '@/lib/supabaseClient'
import { construirInstrucciones, obtenerPerfilYSesion } from '../perfilDocente'
import { obtenerZonaHorariaDispositivo } from '@/lib/tiempo/TimeService'
import { detectarHerramientaDocumento } from '../documentos'
import type { ReferenteContextualMetadata } from '../contextoConversacional'
import { validarDecisionOrquestador, HEADER_DECISION_ORQUESTADOR, HEADER_DECISION_ORQUESTADOR_MODO, type DecisionOrquestador } from '../decisionOrquestador'
import type {
  AccionNavegacion,
  AdjuntoImagen,
  ArchivoGeneradoInfo,
  ContextoAplicacion,
  DesuscribirFn,
  DiferenciaAlumno,
  EventoMotor,
  FinalizarArchivoInfo,
  Herramienta,
  MotorConversacional,
  PropuestaListaOficialFirmada,
  TrazaDiagnosticoCurp,
} from '../tipos'

const detectarTipoDocumento = (texto: string): string => {
  if (texto.includes('RÚBRICA')) return 'rubrica'
  if (texto.includes('CITATORIO')) return 'citatorio'
  if (texto.includes('PLANEACIÓN')) return 'planeacion'
  if (texto.includes('COMPRENSIÓN LECTORA')) return 'lectura'
  return 'documento'
}

// El flag /u es obligatorio aquí: sin él, una clase de caracteres con
// varios emoji (pares de "surrogate" UTF-16) no compara cada emoji
// completo, sino cada mitad por separado. Como varios de estos emoji
// comparten el mismo surrogate alto, eso corrompía 📝/📄 (que ni
// siquiera estaban en la lista) dejando un surrogate bajo suelto —
// texto inválido que rompía el insert a documentos_generados.
const detectarTitulo = (texto: string): string => {
  const lineas = texto.split('\n').filter(l => l.trim())
  for (const linea of lineas) {
    const limpia = linea.replace(/[📋📊📨🎯📚🧰📅✍️📝📄📖💡🤔✏️]/gu, '').trim()
    if (limpia.length > 5) return limpia.substring(0, 80)
  }
  return 'Documento generado'
}

const detectarCampoFormativo = (texto: string): string | null => {
  const match = texto.match(/Campo Formativo:\s*([^\n]+)/i)
  return match ? match[1].trim() : null
}

type TurnoHistorial = { role: 'user' | 'assistant'; content: string }

// CAUSA RAÍZ del chat "colgado" tras generar/descargar un documento:
// ver el comentario grande dentro de enviarTexto(). Estos límites
// garantizan que CUALQUIER await de esta función SIEMPRE termina —
// con éxito o con un error real — en vez de quedar pendiente para
// siempre. obtenerPerfilYSesion() (auth de Supabase) rara vez tarda
// más de 1-2s; 12s ya es generoso.
const TIMEOUT_SESION_MS = 12_000
// Fetch normal (conversación, sin generar archivo): el servidor nunca
// deja pasar más de TIMEOUT_ANTHROPIC_MS (25s, ver app/api/chat/
// route.ts) antes de responder algo — 35s deja margen de sobra.
const TIMEOUT_FETCH_MS = 35_000
// INSTRUMENTACIÓN DIAGNÓSTICA TEMPORAL — timeout ampliado EXCLUSIVO de
// Preview con el gate activo (ver "instrumentación temporal de tiempos
// y consumo"), para dejar que una petición diagnóstica termine de
// verdad y así medir dónde se va el tiempo real. NUNCA se usa fuera de
// NEXT_PUBLIC_DIAGNOSTICO_CURP_ACTIVO==='1' — el timeout normal
// (TIMEOUT_FETCH_MS, 35s) queda exactamente igual en cualquier otro
// caso, incluida Production. Elegido con el techo real de la función
// serverless como referencia (maxDuration=180s, ver app/api/chat/
// route.ts): 90s deja margen suficiente para observar un ciclo
// completo de clasificarNivel0 (hasta 12s, sin reintento) seguido de un
// intento real de Nivel 4 (hasta 120s, con 1 reintento) sin acercarse
// al límite duro del servidor, evitando esperar en vano una función que
// Vercel ya habría terminado por su cuenta. Retirar junto con el resto
// del diagnóstico.
const TIMEOUT_FETCH_DIAGNOSTICO_MS = 90_000
// Fetch de FINALIZAR ARCHIVO (finalizarArchivo presente): puede incluir
// una redacción completa de Claude sin streaming de hasta 8000 tokens
// (CASO 3, hasta TIMEOUT_ANTHROPIC_DOCUMENTO_MS=55s en el servidor) más
// la conversión/subida/verificación real del archivo — un documento
// grande tardando 40-90s es NORMAL, no un cuelgue, y no debe mostrar
// "Tardó demasiado en responder" (ver RFC "generación de documentos
// tolerante a tiempos largos"). 130s deja margen real de sobra incluso
// con un reintento interno del servidor de por medio.
const TIMEOUT_FETCH_DOCUMENTO_MS = 130_000
// CORRECCIÓN — evidencia real: dbg_1787065556208_ai557w ("Crea una
// imagen para anunciar el regreso a clases..."). El cliente abortó a
// los ~90.4s (TIMEOUT_FETCH_DIAGNOSTICO_MS, el único timeout que
// aplicaba a una generación de imagen estándar con diagnóstico
// activo; SIN diagnóstico habría sido TIMEOUT_FETCH_MS, 35s — peor
// aún) pero el servidor terminó de generar y persistir la imagen real
// en Supabase/Storage hasta los ~111.4s — el pipeline SÍ funcionó,
// solo llegó tarde para el timeout que tenía asignado. La migración a
// gpt-image-2 (con su paso de razonamiento antes de generar, según
// documentación oficial) explica de forma plausible ese tiempo mayor.
// 150s deja margen real sobre esos ~111.4s observados, sin acercarse
// al techo duro del servidor (maxDuration=180s, ver app/api/chat/
// route.ts).
const TIMEOUT_FETCH_IMAGEN_MS = 150_000

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

export class MotorTextoClaude implements MotorConversacional {
  readonly id = 'claude-texto'

  private listeners = new Set<(evento: EventoMotor) => void>()
  private contexto: ContextoAplicacion = { pantalla: 'inicio' }
  private herramientas: Herramienta[] = []
  private controlador: AbortController | null = null
  private historial: TurnoHistorial[] = []
  // Distingue una interrupción real (el docente tocó "detener" o cambió
  // de turno) de un abort automático por timeout — ambos producen el
  // mismo AbortError del lado de fetch(), pero solo el primero debe
  // quedar en silencio; el segundo SIEMPRE debe emitir un error real,
  // o el docente se queda viendo que "no pasa nada" sin explicación.
  private interrumpidoManualmente = false

  // AsistenteService llama esto con los mensajes previos de la
  // conversación (nunca el que se está por enviar) justo antes de cada
  // enviarTexto — así Claude ve la conversación completa como turnos
  // reales (messages[]), no solo el mensaje suelto de este momento. Esto
  // es lo que evita que "hazlo en Word" olvide de qué se estaba hablando.
  //
  // CORRECCIÓN — "historial con turno de usuario vacío tras imagen sin
  // texto": un turno histórico de imagen sin texto (ver "imagen sin
  // texto", V2) tiene texto='' — válido y correcto en mensajes_chat,
  // pero Anthropic RECHAZA con 400 cualquier mensaje de usuario cuyo
  // content sea el string vacío (confirmado en pruebas runtime propias:
  // "user messages must have non-empty content"). Ese turno visual no
  // puede representarse fielmente aquí (la imagen real no viaja en el
  // historial — solo texto, ver V3/reconstrucción, fuera de alcance).
  // Nunca se inventa un texto sustituto ("[imagen adjunta]" u
  // equivalente) — eso sería contenido sintético. En vez de eso, se
  // omite el turno completo E, junto con él, la respuesta del asistente
  // que le corresponde inmediatamente después: dejar esa respuesta sola
  // produciría dos turnos 'assistant' consecutivos en el arreglo final
  // (el mismo tipo de historial mal formado que este cambio busca
  // evitar), así que se retiran como par, nunca uno solo.
  establecerHistorial(mensajes: { rol: 'usuario' | 'asistente' | 'herramienta'; texto: string }[]) {
    const mapeado = mensajes
      .filter(m => m.rol === 'usuario' || m.rol === 'asistente')
      .map(m => ({ role: m.rol === 'usuario' ? 'user' as const : 'assistant' as const, content: m.texto }))

    const historialValido: TurnoHistorial[] = []
    for (let i = 0; i < mapeado.length; i++) {
      const turno = mapeado[i]
      if (turno.role === 'user' && turno.content === '') {
        if (mapeado[i + 1]?.role === 'assistant') i++
        continue
      }
      historialValido.push(turno)
    }
    this.historial = historialValido
  }

  async iniciar(contexto: ContextoAplicacion, herramientas: Herramienta[]) {
    this.contexto = contexto
    this.herramientas = herramientas
    this.emitir({ tipo: 'estado', estado: 'activo' })
  }

  async detener() {
    this.interrumpidoManualmente = true
    this.controlador?.abort()
    this.emitir({ tipo: 'estado', estado: 'inactivo' })
  }

  actualizarContexto(contexto: ContextoAplicacion) {
    this.contexto = contexto
  }

  interrumpir() {
    this.interrumpidoManualmente = true
    this.controlador?.abort()
  }

  suscribir(callback: (evento: EventoMotor) => void): DesuscribirFn {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }

  private emitir(evento: EventoMotor) {
    this.listeners.forEach(l => l(evento))
  }

  async enviarTexto(texto: string, adjunto?: AdjuntoImagen, finalizarArchivo?: FinalizarArchivoInfo, esEdicionDocumento?: boolean, adjuntos?: AdjuntoImagen[], canal?: 'texto' | 'voz', turnId?: string, voiceDebug?: boolean, regenerarImagen?: { assetIdAnterior: string }, debugRequestId?: string, referentesContextuales?: ReferenteContextualMetadata[], conversacionId?: string | null, mensajeUsuarioId?: string | null) {
    this.controlador = new AbortController()
    this.interrumpidoManualmente = false
    // INSTRUMENTACIÓN DIAGNÓSTICA TEMPORAL — referencia para msTotalCliente
    // y msClienteAntesFetch (ver "instrumentación temporal de tiempos y
    // consumo"). Nunca afecta el comportamiento real, solo mide.
    const tInicioEnviarTexto = Date.now()

    // CAUSA RAÍZ del chat "colgado" después de generar o descargar un
    // documento: obtenerPerfilYSesion() (3 llamadas reales a Supabase
    // Auth/DB) vivía FUERA de este try/catch, sin ningún límite de
    // tiempo. El cliente de Supabase puede quedar esperando un candado
    // interno de refresh de sesión (más probable justo después de una
    // operación larga como generar un Word/PDF, y más probable todavía
    // en una red móvil inestable) — si eso pasaba, la función nunca
    // terminaba, nunca emitía NINGÚN evento (ni respuesta-final ni
    // error), y generando/documentoFinalizandoId se quedaban activos
    // para siempre: el docente veía que la app "dejó de responder" sin
    // ningún mensaje de error, y cualquier mensaje siguiente parecía
    // ignorado. Con conLimiteDeTiempo, esa espera SIEMPRE termina —con
    // éxito o con un error real y accionable— y con el timeout del
    // fetch de abajo, lo mismo aplica a la llamada a /api/chat en sí.
    let temporizadorFetch: ReturnType<typeof setTimeout> | null = null

    // INSTRUMENTACIÓN DIAGNÓSTICA TEMPORAL — ROUNDTRIP (ver "diagnóstico
    // roundtrip de comparación de CURP sin depender de vercel logs") —
    // declarados ANTES del try para que el catch también pueda emitir la
    // traza de fallo (debugRequestId/etapa/status/tipo de error) cuando
    // la petición nunca llega a obtener respuesta del servidor. Gate
    // FAIL-CLOSED: solo activo si NEXT_PUBLIC_DIAGNOSTICO_CURP_ACTIVO
    // === '1' exactamente (ausente/undefined/vacío/'0'/cualquier otro
    // valor = INACTIVO). Los 5 indicadores del pipeline visual que sí
    // puede ver este archivo colapsan al mismo booleano (!!adjunto) — la
    // selección y preparación reales del archivo ocurren en la pantalla
    // de chat, fuera del alcance autorizado de este diagnóstico; aquí
    // solo se confirma que el adjunto sigue presente en cada punto de
    // paso. Retirar todo este bloque junto con el resto del diagnóstico.
    const diagnosticoActivo = !!debugRequestId && process.env.NEXT_PUBLIC_DIAGNOSTICO_CURP_ACTIVO === '1'
    const camposClientePrevios: Pick<TrazaDiagnosticoCurp, 'imagenSeleccionada' | 'imagenPreparada' | 'imagenEnAsistente' | 'imagenEnMotor' | 'imagenEnFetch'> = {
      imagenSeleccionada: !!adjunto,
      imagenPreparada: !!adjunto,
      imagenEnAsistente: !!adjunto,
      imagenEnMotor: !!adjunto,
      imagenEnFetch: !!adjunto,
    }
    function trazaFallo(etapa: string, extra: Partial<TrazaDiagnosticoCurp> = {}): TrazaDiagnosticoCurp {
      const ahora = Date.now()
      return {
        debugRequestId: debugRequestId || '',
        resultado: 'error',
        etapa,
        mensajeLongitud: texto.length,
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
        ...camposClientePrevios,
        imagenRecibidaServidor: null,
        imagenEntregadaVision: null,
        statusHttp: null,
        tipoError: null,
        mensajeError: null,
        // TIEMPOS — msFetchHastaRespuesta queda null aquí a propósito:
        // en ningún caso de fallo hubo una respuesta real que medir
        // hasta ese punto (el que sí aplica se sobreescribe abajo con
        // extra cuando corresponde). msTotalCliente sí es real: cuánto
        // pasó desde que entró el turno hasta que se dio por vencido.
        msClienteAntesFetch: null,
        msFetchHastaRespuesta: null,
        msTotalCliente: ahora - tInicioEnviarTexto,
        clasificacionEjecutada: false,
        msClasificacion: null,
        consultaDatosEjecutada: false,
        msConsultaDatos: null,
        msHerramienta: null,
        msAntesNivel4: null,
        nivel4Ejecutado: false,
        msTotalServidor: null,
        llamadasIA: [],
        numeroLlamadasIA: 0,
        numeroLlamadasAnthropic: 0,
        numeroLlamadasOpenAI: 0,
        // CANCELACIÓN — ver limitación documentada en tipos.ts: si el
        // cliente se rinde antes de que el servidor conteste, nunca
        // puede saber qué pasó después en el servidor/proveedor — esos
        // 3 campos quedan null (desconocido), nunca inventados como
        // true o false.
        clienteAbortado: null,
        servidorRecibioRequest: null,
        servidorInicioProveedor: null,
        servidorTerminoProveedor: null,
        respuestaServidorTerminada: null,
        ...extra,
      }
    }
    try {
      const { user, session, perfil } = await conLimiteDeTiempo(
        obtenerPerfilYSesion(),
        TIMEOUT_SESION_MS,
        'Tiempo de espera agotado obteniendo la sesión del docente'
      )
      const contextoTexto = construirInstrucciones(perfil, this.contexto)

      // Varias imágenes también necesitan el margen largo de un
      // documento: el servidor procesa varios MB y Claude analiza
      // varias fotos a la vez, más lento que un turno de solo texto.
      const esVariasImagenes = !!adjuntos && adjuntos.length > 1
      // regenerarImagen (Fase 0+1) también necesita el margen largo —
      // generar una imagen real con el proveedor puede tardar tanto
      // como un documento, nunca menos.
      // CORRECCIÓN — "timeout cliente para generación de imagen desde
      // texto" (ver dbg_1787065556208_ai557w): reutiliza el MISMO
      // detector determinista que ya usa AsistenteService.enviarMensaje
      // para decidir el enrutamiento real (IMAGE_CREATE), nunca una
      // regex nueva — si `texto` pide una imagen nueva y no viene con
      // fotos adjuntas (eso es análisis de foto, no generación), el
      // turno recibe TIMEOUT_FETCH_IMAGEN_MS sin importar si el
      // diagnóstico está activo o no. Evaluado ANTES del gate de
      // diagnóstico a propósito: antes, una generación de imagen
      // estándar solo llegaba a 90s con diagnóstico activo, o 35s sin
      // él — ambos insuficientes frente a los ~111.4s reales medidos.
      const esImagenNuevaDesdeTexto = !finalizarArchivo && !esVariasImagenes && !regenerarImagen && !adjunto && !adjuntos?.length && detectarHerramientaDocumento(texto) === 'imagen'
      // INSTRUMENTACIÓN DIAGNÓSTICA TEMPORAL — el timeout normal
      // (TIMEOUT_FETCH_MS) SOLO se amplía cuando diagnosticoActivo es
      // true (gate fail-closed ya calculado arriba); ausente/'0'/
      // cualquier otro valor conserva exactamente el timeout de
      // siempre, sin excepción — incluida Production.
      temporizadorFetch = setTimeout(
        () => this.controlador?.abort(),
        finalizarArchivo || esVariasImagenes || regenerarImagen
          ? TIMEOUT_FETCH_DOCUMENTO_MS
          : esImagenNuevaDesdeTexto
            ? TIMEOUT_FETCH_IMAGEN_MS
            : (diagnosticoActivo ? TIMEOUT_FETCH_DIAGNOSTICO_MS : TIMEOUT_FETCH_MS)
      )

      // INSTRUMENTACIÓN DIAGNÓSTICA TEMPORAL — msClienteAntesFetch
      // (cuánto tardó todo lo previo, sobre todo obtenerPerfilYSesion)
      // y tFetchInicio (referencia para msFetchHastaRespuesta más abajo).
      const msClienteAntesFetch = diagnosticoActivo ? Date.now() - tInicioEnviarTexto : null
      const tFetchInicio = Date.now()

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mensaje: texto,
          historial: this.historial,
          contexto: contextoTexto,
          institucionId: perfil?.institucion_id || null,
          debugRequestId: debugRequestId || undefined,
          imagenBase64: adjunto?.base64 || null,
          imagenTipo: adjunto?.tipo || null,
          nombreArchivo: adjunto?.nombreArchivo || null,
          imagenesBase64: esVariasImagenes ? adjuntos!.map((a) => ({ base64: a.base64, tipo: a.tipo })) : null,
          userId: user?.id || null,
          accessToken: session?.access_token || null,
          zonaHoraria: obtenerZonaHorariaDispositivo(),
          finalizarArchivo: finalizarArchivo || null,
          esEdicionDocumento: esEdicionDocumento || false,
          // Ver "Diagnóstico y Plan de Optimización del Pipeline de Voz"
          // — Fase 1: le dice a /api/chat que ajuste SOLO el estilo de
          // esta respuesta para lectura en voz alta, sin tocar el
          // Motor de intención, el Tool Registry ni ninguna herramienta.
          channel: canal === 'voz' ? 'voice' : undefined,
          // Telemetría temporal (ver "Medir con precisión el pipeline de
          // voz antes de optimizar") — turnId solo correlaciona logs,
          // voiceDebug es la bandera que activa el console.log detallado
          // en el servidor; ambos undefined en el chat escrito.
          turnId: turnId || undefined,
          voiceDebug: voiceDebug === true ? true : undefined,
          // Ver "Implementar en Docente IA la capacidad de generar
          // imágenes...", Fase 0+1 — solo presente cuando
          // AsistenteService.enviarRegeneracionImagen arma este turno.
          regenerarImagen: regenerarImagen || undefined,
          // FASE 2A (ver "contrato del router semántico unificado +
          // transporte de referentes contextuales") — SOLO metadata
          // ligera (id/tipo/origen/formato, nunca contenido completo,
          // ver ReferenteContextualMetadata) del contenido reciente
          // reutilizable de esta conversación. Opcional: ausente en
          // cualquier llamada que no lo arme (edición de documento,
          // trabajo async, voz sin candidatos) — mismo comportamiento
          // de siempre para esas rutas.
          referentesContextuales: referentesContextuales?.length ? referentesContextuales : undefined,
          // VINCULACIÓN DE ASSETS VISUALES A SU CONVERSACIÓN (V1-C) —
          // metadata estructural top-level, nunca dentro de `contexto`
          // (ese sigue siendo el string de construirInstrucciones). El
          // servidor demuestra ownership antes de usarlo — ver
          // obtenerConversacionIdAutorizada en app/api/chat/route.ts.
          conversacionId: conversacionId || null,
          // V2 (adjuntos de imagen durables) — metadata estructural
          // top-level, igual criterio que conversacionId: nunca dentro
          // de `contexto`/prompt/historial/referentes, cero tokens
          // adicionales. null cuando no hay adjunto o cuando el
          // guardado remoto confirmado del mensaje falló (ver
          // AsistenteService.persistirMensajeRemotoConfirmado) — en
          // ese caso el servidor, cuando exista el pipeline V2, no
          // debe intentar crear ningún asset.
          mensajeUsuarioId: mensajeUsuarioId || null,
        }),
        signal: this.controlador.signal,
      })

      // El límite de arriba solo protege contra una conexión que nunca
      // llega a responder nada — una vez que hay respuesta (aunque sea
      // un error HTTP), se libera de inmediato. NO debe seguir corriendo
      // durante la lectura del stream: un documento largo redactado por
      // Claude puede tardar bastante más de TIMEOUT_FETCH_MS en
      // transmitirse completo, y eso es tráfico real, no un cuelgue.
      if (temporizadorFetch) { clearTimeout(temporizadorFetch); temporizadorFetch = null }

      // CLAVE de la "burbuja vacía": fetch() solo rechaza por fallas de
      // RED, nunca por un código de estado de error — un 500/502 de
      // /api/chat llega aquí como una respuesta "exitosa" a los ojos de
      // fetch(). Sin este chequeo, el código seguía de largo, intentaba
      // leer un cuerpo de error como si fuera el streaming de texto
      // normal, y terminaba emitiendo una respuesta vacía en vez de un
      // error real.
      if (!res.ok) {
        const detalle = await res.text().catch(() => '')
        console.error('[CHAT] /api/chat respondió con error:', res.status, detalle)
        // El servidor manda un mensaje específico y accionable (ej. "Error
        // detectado en el módulo DOCX") en vez del genérico de abajo —
        // se usa tal cual cuando existe.
        let mensajeError = 'No pude generar la respuesta. Toca para reintentar.'
        try {
          const cuerpo = JSON.parse(detalle)
          if (typeof cuerpo?.error === 'string' && cuerpo.error.trim()) mensajeError = cuerpo.error
        } catch {
          // el cuerpo no era JSON — se usa el mensaje genérico
        }
        if (diagnosticoActivo) {
          this.emitir({ tipo: 'diagnostico-curp', datos: trazaFallo('respuesta HTTP no exitosa', { statusHttp: res.status }) })
        }
        this.emitir({ tipo: 'error', mensaje: mensajeError })
        return
      }

      // FASE 2B1 (ver "transporte interno de la decisión del
      // orquestador") — se lee ANTES de leer el body (que sí llega en
      // streaming), porque los headers de fetch() ya están completos
      // desde que la promesa de fetch resuelve, sin esperar al body.
      // Nunca se confía en el header crudo: decode + JSON.parse
      // envueltos en try/catch (mismo patrón atob() que ya usan los
      // demás marcadores de este archivo) y validarDecisionOrquestador
      // como última palabra sobre si el valor es realmente utilizable.
      // Cualquier fallo en cualquier paso → null, nunca rompe el chat.
      let decisionOrquestador: DecisionOrquestador | null = null
      const headerDecision = res.headers.get(HEADER_DECISION_ORQUESTADOR)
      if (headerDecision) {
        try {
          decisionOrquestador = validarDecisionOrquestador(JSON.parse(atob(headerDecision)))
        } catch {
          decisionOrquestador = null
        }
      }
      // FASE 2B2A (ver "short-circuit + ejecución de capacidades de
      // recurso") — el modo SOLO cuenta si decisionOrquestador también
      // validó correctamente (defense in depth: un header de modo
      // corrupto/manipulado nunca activa esto por sí solo, ver
      // AsistenteService.ts para la re-validación completa contra
      // datos locales antes de ejecutar nada). Cuando es true, el
      // body viene vacío a propósito (ver route.ts) — nunca se emite
      // respuesta-parcial para este turno (ver más abajo): la UX real
      // la da el pipeline que AsistenteService dispare, no el chat.
      const esShortCircuitOrquestador = res.headers.get(HEADER_DECISION_ORQUESTADOR_MODO) === 'ejecutar_cliente' && decisionOrquestador !== null

      const reader = res.body?.getReader()
      const decoder = new TextDecoder()
      let respuesta = ''

      if (reader) {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          respuesta += decoder.decode(value, { stream: true })
          if (!esShortCircuitOrquestador) this.emitir({ tipo: 'respuesta-parcial', texto: respuesta })
        }
      }

      const respuestaSinProceso = await this.procesarMarcadorDeProceso(respuesta, texto, user?.id)
      const { texto: sinArchivo, archivo, archivos } = this.procesarMarcadorDeArchivo(respuestaSinProceso)
      const { texto: sinContenido, contenidoOriginal } = this.procesarMarcadorDeContenido(sinArchivo)
      const { texto: sinNavegacion, accionNavegacion } = this.procesarMarcadorDeNavegacion(sinContenido)
      const { texto: sinCorreccionAlumno, datosAccionAlumno } = this.procesarMarcadorDeCorreccionAlumno(sinNavegacion)
      const { texto: sinPropuestaListaOficial, propuestaListaOficialFirmada } = this.procesarMarcadorDePropuestaListaOficial(sinCorreccionAlumno)
      const { texto: sinPerfilActualizado, perfilActualizado } = this.procesarMarcadorDePerfilActualizado(sinPropuestaListaOficial)
      // INSTRUMENTACIÓN DIAGNÓSTICA TEMPORAL — se extrae y se retira del
      // texto ANTES de guardarEnHistorial, exactamente igual que los
      // demás marcadores de arriba — nunca llega a Supabase ni al texto
      // que ve el docente. Retirar junto con el resto del diagnóstico.
      const { texto: respuestaLimpia, diagnosticoCurp } = this.procesarMarcadorDeDiagnosticoCurp(sinPerfilActualizado)
      if (!esShortCircuitOrquestador) this.emitir({ tipo: 'respuesta-parcial', texto: respuestaLimpia })
      this.emitir({
        tipo: 'respuesta-final',
        texto: respuestaLimpia,
        archivo,
        archivos,
        contenidoOriginal,
        accionNavegacion,
        datosAccionAlumno,
        propuestaListaOficialFirmada,
        perfilActualizado,
        decisionOrquestador: decisionOrquestador ?? undefined,
        shortCircuitOrquestador: esShortCircuitOrquestador || undefined,
      })
      if (diagnosticoActivo && diagnosticoCurp) {
        this.emitir({
          tipo: 'diagnostico-curp',
          datos: {
            ...diagnosticoCurp,
            ...camposClientePrevios,
            msClienteAntesFetch,
            msFetchHastaRespuesta: Date.now() - tFetchInicio,
            msTotalCliente: Date.now() - tInicioEnviarTexto,
            clienteAbortado: false,
          },
        })
      }

      // FASE 2B2A — nunca indexa una fila vacía para un turno short-circuit
      // (respuestaLimpia siempre '' en ese caso); guardarEnHistorial es
      // un mecanismo no relacionado (documentos_generados) que no tiene
      // nada real que registrar aquí.
      if (user && !esShortCircuitOrquestador) await this.guardarEnHistorial(respuestaLimpia, perfil, user.id)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        if (this.interrumpidoManualmente) return // interrupción intencional real, en silencio
        console.error('[CHAT] /api/chat no respondió dentro del tiempo límite — abortado automáticamente')
        if (diagnosticoActivo) {
          this.emitir({ tipo: 'diagnostico-curp', datos: trazaFallo('timeout de fetch — abortado automáticamente', { tipoError: 'AbortError', clienteAbortado: true }) })
        }
        this.emitir({ tipo: 'error', mensaje: 'Tardó demasiado en responder. Toca para reintentar.' })
        return
      }
      if (err instanceof ErrorLimiteDeTiempo) {
        console.error('[CHAT]', err.message)
        if (diagnosticoActivo) {
          this.emitir({ tipo: 'diagnostico-curp', datos: trazaFallo('timeout obteniendo la sesión del docente', { tipoError: 'ErrorLimiteDeTiempo' }) })
        }
        this.emitir({ tipo: 'error', mensaje: 'Tardó demasiado en responder. Toca para reintentar.' })
        return
      }
      // Señal explícita del servidor (ver app/api/chat/route.ts,
      // controller.error()) cuando el streaming se interrumpe A MITAD
      // de una respuesta ya empezada (ej. una planeación larga) — antes
      // esto caía en el genérico de abajo, indistinguible de un
      // problema real de red ("Error al conectar con la IA" cuando en
      // realidad la conexión sí conectó y ya venía transmitiendo texto
      // real). El docente ya tiene el texto parcial en pantalla — el
      // mensaje debe decir con honestidad que se cortó, no sugerir un
      // problema de conexión que no existió.
      if (err instanceof Error && err.message === 'RESPUESTA_INTERRUMPIDA') {
        console.error('[CHAT] La respuesta se interrumpió a mitad de la transmisión')
        if (diagnosticoActivo) {
          this.emitir({ tipo: 'diagnostico-curp', datos: trazaFallo('streaming interrumpido a mitad de transmisión', { tipoError: 'RESPUESTA_INTERRUMPIDA' }) })
        }
        this.emitir({ tipo: 'error', mensaje: 'La respuesta se interrumpió antes de terminar. Vuelve a pedir la planeación.' })
        return
      }
      if (diagnosticoActivo) {
        // CORRECCIÓN — "auditoría de falla de generación de imagen"
        // (dbg_1787016902092_659gia): tipoError (err.name, ej.
        // "TypeError") por sí solo no distingue un fallo real de red
        // de cualquier otra excepción de programación — se agrega el
        // mensaje real, truncado a un largo seguro. err.message es
        // texto que el propio motor de JavaScript adjunta a la
        // excepción — nunca contiene tokens/cookies/Authorization/
        // claves (esos nunca viajan como texto de un Error en este
        // archivo) ni el contenido del mensaje del docente. Se omite
        // deliberadamente err.stack: puede incluir rutas de archivo
        // internas sin aportar nada que mensajeError ya no diga para
        // este diagnóstico puntual.
        const mensajeError = err instanceof Error && err.message ? err.message.slice(0, 300) : null
        this.emitir({ tipo: 'diagnostico-curp', datos: trazaFallo('excepción no clasificada en enviarTexto', { tipoError: err instanceof Error ? err.name : 'desconocido', mensajeError }) })
      }
      this.emitir({ tipo: 'error', mensaje: 'Error al conectar con la IA.' })
    } finally {
      if (temporizadorFetch) clearTimeout(temporizadorFetch)
    }
  }

  // Genera un documento existente en OTRO formato de forma mecánica
  // (nunca pasa por Claude — reutiliza el mismo endpoint/mecanismo de
  // FINALIZAR ARCHIVO que ya usa enviarTexto, ver app/api/chat/route.ts).
  // NUNCA emite eventos de chat (ni respuesta-parcial, ni
  // respuesta-final) y usa su PROPIO AbortController (nunca
  // this.controlador) para no interferir con una conversación de texto
  // en curso. Ver "CONTENCIÓN DEFINITIVA — retirar temporalmente
  // Convertir de todas las tarjetas de documentos": el botón que
  // llamaba a este método fue retirado de la interfaz; el método se
  // conserva como infraestructura para la conversión directa real que
  // se implementará más adelante, pero hoy ningún camino del
  // renderizado actual lo invoca.
  async generarArchivoDirecto(tipo: string, documentoTexto: string): Promise<ArchivoGeneradoInfo> {
    const controlador = new AbortController()
    const temporizador = setTimeout(() => controlador.abort(), TIMEOUT_FETCH_DOCUMENTO_MS)
    try {
      const { user, session, perfil } = await conLimiteDeTiempo(
        obtenerPerfilYSesion(),
        TIMEOUT_SESION_MS,
        'Tiempo de espera agotado obteniendo la sesión del docente'
      )
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mensaje: '',
          historial: [],
          contexto: '',
          institucionId: perfil?.institucion_id || null,
          userId: user?.id || null,
          accessToken: session?.access_token || null,
          zonaHoraria: obtenerZonaHorariaDispositivo(),
          finalizarArchivo: { tipo, documentoTexto },
        }),
        signal: controlador.signal,
      })
      if (!res.ok) {
        const detalle = await res.text().catch(() => '')
        let mensajeError = 'No fue posible generar el archivo.'
        try {
          const cuerpo = JSON.parse(detalle)
          if (typeof cuerpo?.error === 'string' && cuerpo.error.trim()) mensajeError = cuerpo.error
        } catch {
          // el cuerpo no era JSON — se usa el mensaje genérico
        }
        throw new Error(mensajeError)
      }
      const reader = res.body?.getReader()
      const decoder = new TextDecoder()
      let respuesta = ''
      if (reader) {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          respuesta += decoder.decode(value, { stream: true })
        }
      }
      const { archivo } = this.procesarMarcadorDeArchivo(respuesta)
      if (!archivo) throw new Error('El servidor no devolvió un archivo válido.')
      return archivo
    } finally {
      clearTimeout(temporizador)
    }
  }

  // Marcador técnico con el archivo real ya generado y subido (ver
  // FINALIZAR ARCHIVO en app/api/chat/route.ts) — mismo patrón que
  // procesarMarcadorDeProceso: el docente nunca ve esta línea, se
  // extrae y se quita del texto visible antes de mostrarlo.
  // Un turno puede traer más de un adjunto (ej. planeación + hoja de
  // evaluación en la misma respuesta, ver "corrección funcional — falta
  // mostrar y descargar la planeación") — se extraen TODOS los
  // marcadores presentes, no solo el primero. `archivo` (singular) se
  // sigue devolviendo con el primero para que ningún flujo existente
  // de un solo documento (Word/PDF/PPT/Excel, ficha_descriptiva...)
  // tenga que cambiar.
  private procesarMarcadorDeArchivo(respuesta: string): { texto: string; archivo?: ArchivoGeneradoInfo; archivos?: ArchivoGeneradoInfo[] } {
    const regex = /\[\[DOCUMENTO_ARCHIVO:([^\]]+)\]\]/g
    const archivos: ArchivoGeneradoInfo[] = []
    let texto = respuesta
    let match: RegExpExecArray | null
    while ((match = regex.exec(respuesta)) !== null) {
      try {
        const binario = atob(match[1])
        const bytes = Uint8Array.from(binario, (c) => c.charCodeAt(0))
        archivos.push(JSON.parse(new TextDecoder('utf-8').decode(bytes)) as ArchivoGeneradoInfo)
      } catch {
        // marcador corrupto — se quita del texto igual, sin adjuntar nada por él
      }
      texto = texto.replace(match[0], '')
    }
    texto = texto.trim()
    if (archivos.length === 0) return { texto }
    return { texto, archivo: archivos[0], archivos }
  }

  // Marcador técnico con el contenido REAL redactado por Claude cuando
  // CASO 3 (ver app/api/chat/route.ts) generó contenido y archivo en el
  // mismo turno, sin documento previo que recuperar — nunca se muestra
  // en pantalla, solo permite que AsistenteService guarde un
  // documentoActivo con texto real, para que "ahora en PDF" después no
  // se quede sin fuente que reutilizar.
  private procesarMarcadorDeContenido(respuesta: string): { texto: string; contenidoOriginal?: string } {
    const match = respuesta.match(/\[\[DOCUMENTO_CONTENIDO:([^\]]+)\]\]/)
    if (!match) return { texto: respuesta }
    try {
      const binario = atob(match[1])
      const bytes = Uint8Array.from(binario, (c) => c.charCodeAt(0))
      const contenidoOriginal = new TextDecoder('utf-8').decode(bytes)
      return { texto: respuesta.replace(match[0], '').trim(), contenidoOriginal }
    } catch {
      return { texto: respuesta.replace(match[0], '').trim() }
    }
  }

  // Marcador técnico con la acción de navegación resuelta por el
  // Clasificador de Nivel 0 (ver "consultar_alumno_lista" /
  // "navegar_alumno_lista" en app/api/chat/route.ts) — mismo patrón
  // que procesarMarcadorDeArchivo: el docente nunca ve esta línea.
  private procesarMarcadorDeNavegacion(respuesta: string): { texto: string; accionNavegacion?: AccionNavegacion } {
    const match = respuesta.match(/\[\[NAVEGACION:([^\]]+)\]\]/)
    if (!match) return { texto: respuesta }
    try {
      const binario = atob(match[1])
      const bytes = Uint8Array.from(binario, (c) => c.charCodeAt(0))
      const accionNavegacion = JSON.parse(new TextDecoder('utf-8').decode(bytes)) as AccionNavegacion
      return { texto: respuesta.replace(match[0], '').trim(), accionNavegacion }
    } catch {
      return { texto: respuesta.replace(match[0], '').trim() }
    }
  }

  // Marcador técnico con la propuesta de corrección de dato de alumno
  // (ver "corregir_dato_alumno" en lib/asistente/herramientasModulo.ts)
  // — mismo patrón exacto que procesarMarcadorDeNavegacion: el docente
  // nunca ve esta línea, solo el texto legible (Alumno/Campo/Actual/
  // Nuevo/Fuente) que la precede.
  private procesarMarcadorDeCorreccionAlumno(respuesta: string): { texto: string; datosAccionAlumno?: DiferenciaAlumno } {
    const match = respuesta.match(/\[\[CORRECCION_ALUMNO:([^\]]+)\]\]/)
    if (!match) return { texto: respuesta }
    try {
      const binario = atob(match[1])
      const bytes = Uint8Array.from(binario, (c) => c.charCodeAt(0))
      const datosAccionAlumno = JSON.parse(new TextDecoder('utf-8').decode(bytes)) as DiferenciaAlumno
      return { texto: respuesta.replace(match[0], '').trim(), datosAccionAlumno }
    } catch {
      return { texto: respuesta.replace(match[0], '').trim() }
    }
  }

  // Marcador técnico con el sobre firmado de la propuesta de
  // actualización de lista oficial (ver "V1-C2 — contrato HMAC +
  // transporte + persistencia", futuro V1-C3) — mismo patrón exacto
  // que procesarMarcadorDeCorreccionAlumno: el docente NUNCA ve esta
  // línea. A diferencia de CORRECCION_ALUMNO, esta fase no adjunta
  // ninguna acción/botón — solo transporta el sobre para que se
  // persista pegado al mensaje (ver AsistenteService.manejarEventoMotor)
  // y una fase posterior (V1-D) lo recupere server-side.
  //
  // Validación de forma DELIBERADAMENTE duplicada en este archivo (en
  // vez de importar lib/listaOficial/propuestaFirmada.ts, que usa
  // node:crypto): este módulo corre en el navegador, y ese helper es
  // server-only por diseño — nunca debe entrar al bundle del cliente.
  // Esta función solo verifica FORMA (nunca la firma HMAC — el cliente
  // no tiene el secreto y no le corresponde verificar nada aquí).
  //
  // V1-C2.1 (hardening) — mismo criterio de whitelist EXACTA que ya
  // aplica el servidor (ver lib/listaOficial/propuestaFirmada.ts): un
  // objeto con una propiedad extra (top-level, en el payload, o en un
  // cambio) se rechaza por completo — nunca se persiste en
  // mensajes_chat.contenido metadata que ni siquiera pertenece al
  // contrato firmado, aunque el cliente no pueda verificar la firma.
  private esSobrePropuestaListaOficialConFormaMinima(valor: unknown): valor is PropuestaListaOficialFirmada {
    const tieneExactamenteLasClaves = (obj: Record<string, unknown>, clavesPermitidas: readonly string[]): boolean => {
      const claves = Object.keys(obj)
      return claves.length === clavesPermitidas.length && clavesPermitidas.every((clave) => Object.prototype.hasOwnProperty.call(obj, clave))
    }

    if (typeof valor !== 'object' || valor === null) return false
    const sobre = valor as Record<string, unknown>
    if (!tieneExactamenteLasClaves(sobre, ['payload', 'firma'])) return false
    if (typeof sobre.firma !== 'string' || sobre.firma.length === 0) return false
    if (typeof sobre.payload !== 'object' || sobre.payload === null) return false

    const payload = sobre.payload as Record<string, unknown>
    if (!tieneExactamenteLasClaves(payload, ['docenteId', 'conversacionId', 'generadoEn', 'propuesta'])) return false
    if (typeof payload.docenteId !== 'string' || !payload.docenteId) return false
    if (typeof payload.conversacionId !== 'string' || !payload.conversacionId) return false
    if (typeof payload.generadoEn !== 'string' || !payload.generadoEn) return false
    if (!Array.isArray(payload.propuesta) || payload.propuesta.length === 0) return false

    return payload.propuesta.every((c) => {
      if (typeof c !== 'object' || c === null) return false
      const cambio = c as Record<string, unknown>
      if (!tieneExactamenteLasClaves(cambio, ['alumnoId', 'campo', 'valorPropuesto'])) return false
      return typeof cambio.alumnoId === 'string' && !!cambio.alumnoId && cambio.campo === 'curp' && typeof cambio.valorPropuesto === 'string' && !!cambio.valorPropuesto
    })
  }

  private procesarMarcadorDePropuestaListaOficial(respuesta: string): { texto: string; propuestaListaOficialFirmada?: PropuestaListaOficialFirmada } {
    const match = respuesta.match(/\[\[PROPUESTA_LISTA_OFICIAL:([^\]]+)\]\]/)
    if (!match) return { texto: respuesta }
    const textoSinMarcador = respuesta.replace(match[0], '').trim()
    try {
      const binario = atob(match[1])
      const bytes = Uint8Array.from(binario, (c) => c.charCodeAt(0))
      const parseado: unknown = JSON.parse(new TextDecoder('utf-8').decode(bytes))
      if (!this.esSobrePropuestaListaOficialConFormaMinima(parseado)) {
        // Forma inválida — nunca se adjunta metadata a medias; el
        // texto humano legítimo sigue intacto de todas formas.
        return { texto: textoSinMarcador }
      }
      return { texto: textoSinMarcador, propuestaListaOficialFirmada: parseado }
    } catch {
      // Marcador corrupto (base64/JSON inválido) — mismo criterio que
      // el resto de los marcadores: nunca se muestra el blob crudo,
      // nunca se lanza, solo se retira del texto visible.
      return { texto: textoSinMarcador }
    }
  }

  // Marcador técnico sin datos propios (ver actualizar_perfil_docente en
  // app/api/chat/route.ts) — su sola presencia es la señal de que
  // perfiles_docentes cambió. El valor real nunca viaja en el marcador:
  // AsistenteService vuelve a leer la MISMA fuente única
  // (obtenerPerfilYSesion, ver lib/asistente/perfilDocente.ts) en vez de
  // confiar en una copia serializada aquí, para que nunca puedan
  // divergir dos representaciones del mismo perfil.
  private procesarMarcadorDePerfilActualizado(respuesta: string): { texto: string; perfilActualizado: boolean } {
    const match = respuesta.match(/\[\[PERFIL_ACTUALIZADO\]\]/)
    if (!match) return { texto: respuesta, perfilActualizado: false }
    return { texto: respuesta.replace(match[0], '').trim(), perfilActualizado: true }
  }

  // INSTRUMENTACIÓN DIAGNÓSTICA TEMPORAL — ROUNDTRIP (ver "diagnóstico
  // roundtrip de comparación de CURP sin depender de vercel logs") —
  // mismo patrón exacto que los demás marcadores de arriba: el docente
  // NUNCA ve esta línea ni queda persistida (se extrae antes de
  // guardarEnHistorial, ver enviarTexto). Quitar este método junto con
  // el resto del diagnóstico.
  private procesarMarcadorDeDiagnosticoCurp(respuesta: string): { texto: string; diagnosticoCurp?: TrazaDiagnosticoCurp } {
    const match = respuesta.match(/\[\[DIAGNOSTICO_CURP:([^\]]+)\]\]/)
    if (!match) return { texto: respuesta }
    try {
      const binario = atob(match[1])
      const bytes = Uint8Array.from(binario, (c) => c.charCodeAt(0))
      const diagnosticoCurp = JSON.parse(new TextDecoder('utf-8').decode(bytes)) as TrazaDiagnosticoCurp
      return { texto: respuesta.replace(match[0], '').trim(), diagnosticoCurp }
    } catch {
      return { texto: respuesta.replace(match[0], '').trim() }
    }
  }

  // El modelo grande puede pedir continuar una tarea larga (varias fichas,
  // varios exámenes...) con un marcador técnico al final de su respuesta.
  // Esto es específico de cómo este motor conversa con Claude — otro
  // motor/proveedor podría no necesitar nada equivalente.
  private async procesarMarcadorDeProceso(respuesta: string, mensajeOriginal: string, userId: string | undefined): Promise<string> {
    const match = respuesta.match(/\[\[PROCESO:tipo=([^;]+);actual=(\d+);total=(\d+);estado=([^\]]+)\]\]/)
    if (!match || !userId) return respuesta

    const [marcadorCompleto, tipo, actual, total, estadoProceso] = match
    const nuevoEstado = estadoProceso.includes('completado') ? 'completado' : 'activo'
    const { data: existente } = await supabase
      .from('procesos_activos')
      .select('id, contexto')
      .eq('user_id', userId)
      .eq('tipo_proceso', tipo)
      .eq('estado', 'activo')
      .maybeSingle()

    if (existente) {
      const mensajeGuardado = existente.contexto?.mensajeOriginal || mensajeOriginal
      await supabase.from('procesos_activos').update({
        contexto: { actual: parseInt(actual), total: parseInt(total), mensajeOriginal: mensajeGuardado },
        estado: nuevoEstado,
        updated_at: new Date().toISOString(),
      }).eq('id', existente.id)
    } else {
      await supabase.from('procesos_activos').insert({
        user_id: userId,
        tipo_proceso: tipo,
        contexto: { actual: parseInt(actual), total: parseInt(total), mensajeOriginal },
        estado: nuevoEstado,
      })
    }
    return respuesta.replace(marcadorCompleto, '').trim()
  }

  private async guardarEnHistorial(texto: string, perfil: any, userId: string) {
    await supabase.from('documentos_generados').insert({
      user_id: userId,
      tipo: detectarTipoDocumento(texto),
      titulo: detectarTitulo(texto),
      contenido: texto,
      campo_formativo: detectarCampoFormativo(texto) || perfil?.campo_formativo || null,
      grado: perfil?.grado || null,
      grupo: perfil?.grupo || null,
    })
  }
}
