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

export class MotorTextoClaude implements MotorConversacional {
  readonly id = 'claude-texto'

  private listeners = new Set<(evento: EventoMotor) => void>()
  private contexto: ContextoAplicacion = { pantalla: 'inicio' }
  private herramientas: Herramienta[] = []
  private controlador: AbortController | null = null
  private historial: TurnoHistorial[] = []

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
    this.controlador?.abort()
    this.emitir({ tipo: 'estado', estado: 'inactivo' })
  }

  actualizarContexto(contexto: ContextoAplicacion) {
    this.contexto = contexto
  }

  interrumpir() {
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

    const { user, session, perfil } = await obtenerPerfilYSesion()
    const contextoTexto = construirInstrucciones(perfil, this.contexto)

    try {
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
      if (err instanceof DOMException && err.name === 'AbortError') return // interrupción intencional
      this.emitir({ tipo: 'error', mensaje: 'Error al conectar con la IA.' })
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
