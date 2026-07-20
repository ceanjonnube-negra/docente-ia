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
import type {
  AdjuntoImagen,
  ArchivoGeneradoInfo,
  ContextoAplicacion,
  DesuscribirFn,
  EventoMotor,
  FinalizarArchivoInfo,
  Herramienta,
  MotorConversacional,
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
// Fetch de FINALIZAR ARCHIVO (finalizarArchivo presente): puede incluir
// una redacción completa de Claude sin streaming de hasta 8000 tokens
// (CASO 3, hasta TIMEOUT_ANTHROPIC_DOCUMENTO_MS=55s en el servidor) más
// la conversión/subida/verificación real del archivo — un documento
// grande tardando 40-90s es NORMAL, no un cuelgue, y no debe mostrar
// "Tardó demasiado en responder" (ver RFC "generación de documentos
// tolerante a tiempos largos"). 130s deja margen real de sobra incluso
// con un reintento interno del servidor de por medio.
const TIMEOUT_FETCH_DOCUMENTO_MS = 130_000

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
  establecerHistorial(mensajes: { rol: 'usuario' | 'asistente' | 'herramienta'; texto: string }[]) {
    this.historial = mensajes
      .filter(m => m.rol === 'usuario' || m.rol === 'asistente')
      .map(m => ({ role: m.rol === 'usuario' ? 'user' as const : 'assistant' as const, content: m.texto }))
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

  async enviarTexto(texto: string, adjunto?: AdjuntoImagen, finalizarArchivo?: FinalizarArchivoInfo, esEdicionDocumento?: boolean) {
    this.controlador = new AbortController()
    this.interrumpidoManualmente = false

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
    try {
      const { user, session, perfil } = await conLimiteDeTiempo(
        obtenerPerfilYSesion(),
        TIMEOUT_SESION_MS,
        'Tiempo de espera agotado obteniendo la sesión del docente'
      )
      const contextoTexto = construirInstrucciones(perfil, this.contexto)

      temporizadorFetch = setTimeout(() => this.controlador?.abort(), finalizarArchivo ? TIMEOUT_FETCH_DOCUMENTO_MS : TIMEOUT_FETCH_MS)

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mensaje: texto,
          historial: this.historial,
          contexto: contextoTexto,
          institucionId: perfil?.institucion_id || null,
          imagenBase64: adjunto?.base64 || null,
          imagenTipo: adjunto?.tipo || null,
          userId: user?.id || null,
          accessToken: session?.access_token || null,
          zonaHoraria: obtenerZonaHorariaDispositivo(),
          finalizarArchivo: finalizarArchivo || null,
          esEdicionDocumento: esEdicionDocumento || false,
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
        this.emitir({ tipo: 'error', mensaje: mensajeError })
        return
      }

      const reader = res.body?.getReader()
      const decoder = new TextDecoder()
      let respuesta = ''

      if (reader) {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          respuesta += decoder.decode(value, { stream: true })
          this.emitir({ tipo: 'respuesta-parcial', texto: respuesta })
        }
      }

      const respuestaSinProceso = await this.procesarMarcadorDeProceso(respuesta, texto, user?.id)
      const { texto: respuestaLimpia, archivo } = this.procesarMarcadorDeArchivo(respuestaSinProceso)
      this.emitir({ tipo: 'respuesta-parcial', texto: respuestaLimpia })
      this.emitir({ tipo: 'respuesta-final', texto: respuestaLimpia, archivo })

      if (user) await this.guardarEnHistorial(respuestaLimpia, perfil, user.id)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        if (this.interrumpidoManualmente) return // interrupción intencional real, en silencio
        console.error('[CHAT] /api/chat no respondió dentro del tiempo límite — abortado automáticamente')
        this.emitir({ tipo: 'error', mensaje: 'Tardó demasiado en responder. Toca para reintentar.' })
        return
      }
      if (err instanceof ErrorLimiteDeTiempo) {
        console.error('[CHAT]', err.message)
        this.emitir({ tipo: 'error', mensaje: 'Tardó demasiado en responder. Toca para reintentar.' })
        return
      }
      this.emitir({ tipo: 'error', mensaje: 'Error al conectar con la IA.' })
    } finally {
      if (temporizadorFetch) clearTimeout(temporizadorFetch)
    }
  }

  // Marcador técnico con el archivo real ya generado y subido (ver
  // FINALIZAR ARCHIVO en app/api/chat/route.ts) — mismo patrón que
  // procesarMarcadorDeProceso: el docente nunca ve esta línea, se
  // extrae y se quita del texto visible antes de mostrarlo.
  private procesarMarcadorDeArchivo(respuesta: string): { texto: string; archivo?: ArchivoGeneradoInfo } {
    const match = respuesta.match(/\[\[DOCUMENTO_ARCHIVO:([^\]]+)\]\]/)
    if (!match) return { texto: respuesta }
    try {
      const binario = atob(match[1])
      const bytes = Uint8Array.from(binario, (c) => c.charCodeAt(0))
      const archivo = JSON.parse(new TextDecoder('utf-8').decode(bytes)) as ArchivoGeneradoInfo
      return { texto: respuesta.replace(match[0], '').trim(), archivo }
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
