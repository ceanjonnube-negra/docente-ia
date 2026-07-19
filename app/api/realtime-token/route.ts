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

type HerramientaEntrante = { nombre: string; descripcion: string; parametros: unknown }

// Emite un client secret efímero de OpenAI Realtime — nunca la
// OPENAI_API_KEY real — para que el navegador pueda abrir una conexión
// WebRTC directa con el proveedor. Exige una sesión válida de Supabase
// para no dejar este endpoint abierto a cualquiera.
export async function POST(req: NextRequest) {
  try {
    const { accessToken, instrucciones, herramientas, voz } = await req.json()

    if (!accessToken) {
      return NextResponse.json({ error: 'Sesión no encontrada.' }, { status: 401 })
    }
    const { data: { user }, error: errorAuth } = await supabaseAuth.auth.getUser(accessToken)
    if (errorAuth || !user) {
      return NextResponse.json({ error: 'Sesión inválida.' }, { status: 401 })
    }

    const tools = Array.isArray(herramientas)
      ? (herramientas as HerramientaEntrante[]).map(h => ({
          type: 'function' as const,
          name: h.nombre,
          description: h.descripcion,
          parameters: h.parametros,
        }))
      : []

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
            // create_response:false — el servidor YA NO dispara una
            // respuesta solo con detectar una pausa. El VAD (semantic_vad)
            // sigue activo para segmentar y transcribir cada fragmento de
            // habla, pero es MotorOpenAIRealtime.finalizarTurno() (el
            // segundo toque del botón, ver motorOpenAIRealtime.ts) quien
            // decide cuándo el turno del docente realmente terminó y pide
            // la respuesta — así una instrucción larga con pausas
            // naturales para pensar nunca se corta en varios mensajes.
            // interrupt_response sigue activo: si el docente habla
            // mientras el asistente responde, lo corta de inmediato — eso
            // es independiente de create_response.
            turn_detection: { type: 'semantic_vad', eagerness: 'low', interrupt_response: true, create_response: false },
          },
        },
        tools,
      },
    })

    const modelo = clientSecret.session?.type === 'realtime' ? clientSecret.session.model : undefined

    return NextResponse.json({
      value: clientSecret.value,
      model: modelo || MODELO_REALTIME,
    })
  } catch (error: any) {
    const detalle = error?.error?.message || error?.message || 'sin detalle'
    const codigo = error?.error?.code || error?.code || ''
    console.error('[VOZ][5-token-efimero][servidor] Error creando client secret:', error?.status, codigo, detalle, error)
    return NextResponse.json(
      { error: `OpenAI ${error?.status ? `HTTP ${error.status}` : ''} ${codigo ? `(${codigo})` : ''}: ${detalle}`.trim() },
      { status: 500 }
    )
  }
}
