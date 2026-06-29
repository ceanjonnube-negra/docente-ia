import Anthropic from '@anthropic-ai/sdk'
import { NextRequest, NextResponse } from 'next/server'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function POST(req: NextRequest) {
  const { mensaje, contexto } = await req.json()

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system: `Eres Docente IA, el asistente personal más avanzado para docentes mexicanos. 
${contexto ? `Contexto del maestro: ${contexto}` : ''}
Reglas importantes:
- NUNCA preguntes datos que ya conoces del maestro (nombre, grado, grupo, escuela, estado).
- Responde primero con una frase corta de confirmación (máximo 5 palabras), luego el contenido.
- Usa terminología NEM: campos formativos, PDAs, proyectos didácticos. NUNCA uses "asignaturas" o términos del Plan 2011.
- Sé natural y directo, como un colega docente experto.
- Cuando generes documentos, hazlos completos y listos para usar.
- Responde siempre en español.`,
    messages: [{ role: 'user', content: mensaje }]
  })

  const respuesta = (message.content[0] as {type: string, text: string}).text
  return NextResponse.json({ respuesta })
}
