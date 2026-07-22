import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const supabaseAuth = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const MODELO_REALTIME = 'gpt-realtime'
const VOZ_DEFECTO = 'marin'

// Emite un client secret efímero de OpenAI Realtime — nunca la
// OPENAI_API_KEY real — para que el navegador pueda abrir una conexión
// WebRTC directa con el proveedor. Exige una sesión válida de Supabase
// para no dejar este endpoint abierto a cualquiera.
export async function POST(req: NextRequest) {
  const inicio = Date.now()
  // Nunca el accessToken/clientSecret reales — solo booleanos/metadatos
  // (ver "Capturar el error real de arranque de voz directamente desde
  // el iPhone", sección LOGS DEL BACKEND).
  console.log(`[VOZ][token-endpoint] POST /api/realtime-token recibido · OPENAI_API_KEY configurada=${Boolean(process.env.OPENAI_API_KEY)}`)
  try {
    const { accessToken, instrucciones, voz } = await req.json()

    if (!accessToken) {
      console.log(`[VOZ][token-endpoint] 401 sin accessToken · ${Date.now() - inicio}ms`)
      return NextResponse.json({ error: 'Sesión no encontrada.' }, { status: 401 })
    }
    const { data: { user }, error: errorAuth } = await supabaseAuth.auth.getUser(accessToken)
    if (errorAuth || !user) {
      console.log(`[VOZ][token-endpoint] 401 sesión inválida (${errorAuth?.message || 'sin usuario'}) · ${Date.now() - inicio}ms`)
      return NextResponse.json({ error: 'Sesión inválida.' }, { status: 401 })
    }
    console.log(`[VOZ][token-endpoint] sesión válida (${user.email || user.id}) · modelo=${MODELO_REALTIME} voz=${typeof voz === 'string' ? voz : VOZ_DEFECTO} instrucciones=${typeof instrucciones === 'string' ? `${instrucciones.length} chars` : 'ninguna'}`)

    // Garantía a nivel de arquitectura, no de convención (ver
    // "Rediseñar el modo voz como conversación continua"): Realtime
    // NUNCA debe poder ejecutar una Herramienta directamente. Antes se
    // aceptaba un arreglo de herramientas del cliente y se registraba
    // como function-calling de la sesión; ahora ni siquiera se acepta
    // ese parámetro — sin tools registradas, es imposible que el
    // modelo intente llamar una, sin importar qué mande el cliente.
    const tools: never[] = []

    const clientSecret = await openai.realtime.clientSecrets.create({
      session: {
        type: 'realtime',
        model: MODELO_REALTIME,
        instructions: typeof instrucciones === 'string' ? instrucciones : undefined,
        audio: {
          output: { voice: typeof voz === 'string' ? voz : VOZ_DEFECTO },
          input: {
            transcription: { model: 'whisper-1', language: 'es' },
            // Filtra ruido/eco antes de que llegue al VAD y al modelo —
            // "near_field" es para micrófono cercano (celular, audífonos),
            // el caso normal en una app móvil. Ayuda a que el propio audio
            // del asistente saliendo por la bocina no se interprete como
            // el docente interrumpiendo.
            noise_reduction: { type: 'near_field' },
            // create_response:false — el servidor de OpenAI nunca genera
            // una respuesta por su cuenta. El VAD (semantic_vad) segmenta
            // y transcribe cada fragmento de habla; es
            // MotorOpenAIRealtime (programarEvaluacionFinTurno, con la
            // heurística de lib/asistente/deteccionFinTurno.ts) quien
            // decide cuándo el turno del docente terminó y llama a
            // finalizarTurno() — que manda el texto reconocido al MISMO
            // pipeline que un mensaje escrito (Clasificador de Nivel 0,
            // Herramientas, /api/chat). Solo después, con la respuesta
            // real de Claude ya en mano, el cliente le pide
            // explícitamente a esta sesión que la lea en voz alta (ver
            // reproducirRespuestaEnVoz) — Realtime nunca decide qué
            // responder, solo cuándo el docente terminó de hablar.
            // interrupt_response sigue activo: si el docente habla
            // mientras se está leyendo una respuesta, la corta de
            // inmediato — eso es independiente de create_response.
            turn_detection: { type: 'semantic_vad', eagerness: 'low', interrupt_response: true, create_response: false },
          },
        },
        tools,
      },
    })

    const modelo = clientSecret.session?.type === 'realtime' ? clientSecret.session.model : undefined
    console.log(`[VOZ][token-endpoint] 200 OK · modelo=${modelo || MODELO_REALTIME} · client secret recibido de OpenAI (valor nunca logueado) · ${Date.now() - inicio}ms`)

    return NextResponse.json({
      value: clientSecret.value,
      model: modelo || MODELO_REALTIME,
    })
  } catch (error: any) {
    const detalle = error?.error?.message || error?.message || 'sin detalle'
    const codigo = error?.error?.code || error?.code || ''
    const tipo = error?.error?.type || error?.type || ''
    console.error(
      `[VOZ][token-endpoint] Error creando client secret · status=${error?.status ?? 'n/a'} tipo=${tipo || 'n/a'} codigo=${codigo || 'n/a'} detalle="${detalle}" · ${Date.now() - inicio}ms`,
      error
    )
    return NextResponse.json(
      { error: `OpenAI ${error?.status ? `HTTP ${error.status}` : ''} ${codigo ? `(${codigo})` : ''}: ${detalle}`.trim() },
      { status: 500 }
    )
  }
}
