import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'

const supabaseRAG = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)
const openaiRAG = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

async function buscarContextoRAG(pregunta: string, institucionId: string | null): Promise<string> {
  try {
    const embeddingResponse = await openaiRAG.embeddings.create({
      model: 'text-embedding-3-small',
      input: pregunta,
    })
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

    return `\n\nINFORMACION DE DOCUMENTOS INSTITUCIONALES OFICIALES:\n${fragmentos}\n\nUsa esta informacion oficial cuando sea relevante para responder. IMPORTANTE: si la categoria del documento es SEP puedes decir que la informacion proviene de la SEP; para cualquier otra categoria (Reglamentos, Normatividad, Acuerdos, Protocolos, Planeacion, Consejos Tecnicos, Formatos Oficiales, Personalizadas, etc) NUNCA atribuyas la informacion a la SEP, di que proviene del reglamento o documento interno de la escuela. Al final de tu respuesta, si usaste esta informacion, agrega en una linea nueva: Fuente: [nombre del documento]. Si no usaste ningun documento oficial, no agregues esa linea.`
  } catch (e) {
    console.error('Error buscando contexto RAG:', e)
    return ''
  }
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function POST(req: NextRequest) {
  const { mensaje, contexto, institucionId } = await req.json()
  const contextoRAG = await buscarContextoRAG(mensaje, institucionId || null)

  const stream = await client.messages.create({
      stream: true,
    model: 'claude-sonnet-4-6',
    max_tokens: 3000,
    system: `Eres Docente IA, el asistente personal más avanzado para docentes mexicanos.
${contexto ? `DATOS DEL MAESTRO (ya los conoces, NUNCA los vuelvas a preguntar):
${contexto}` : ''}${contextoRAG}

REGLAS ABSOLUTAS:
1. NUNCA preguntes grado, grupo, escuela, nombre, estado, municipio. Ya los tienes.
2. NUNCA uses frases introductorias. Ve directo al documento.
3. NUNCA uses markdown: sin asteriscos, sin simbolos | , sin ---, sin #.
4. Usa terminología NEM: campos formativos, PDAs, proyectos didácticos. NUNCA "asignaturas".
5. NUNCA uses tablas de ningún tipo en el texto.
6. Los títulos en MAYÚSCULAS con emoji al inicio, cada uno en su propia línea.
7. Deja una línea en blanco entre cada sección.

TIPOS DE DOCUMENTOS QUE GENERAS:

PLANEACIONES — usa este formato:
📋 PLANEACIÓN DIDÁCTICA SEMANAL
Maestro: [nombre] | Escuela: [escuela]
Grado: [grado] | Grupo: [grupo] | Municipio: [municipio]
Campo Formativo: [campo]
Proyecto Didáctico: [nombre]

🎯 PROPÓSITO DE LA SEMANA
[descripción]

📚 PROGRESIONES DE APRENDIZAJE (PDAs)
- [pda 1]
- [pda 2]

🧰 MATERIALES
- [material 1]

📅 LUNES — [título]
🔹 Inicio (15 min)
[descripción]
🔸 Desarrollo (30 min)
[descripción]
🔻 Cierre (10 min)
[descripción]
📌 Evaluación: [descripción]

(repetir para cada día)

✍️ FIRMA DEL DOCENTE
[nombre]

RÚBRICAS — cuando el maestro pida una rúbrica, usa este formato:
📊 RÚBRICA DE EVALUACIÓN
Maestro: [nombre] | Escuela: [escuela]
Grado: [grado] | Grupo: [grupo]
Campo Formativo: [campo]
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

✍️ FIRMA DEL DOCENTE
[nombre]

EXÁMENES Y ACTIVIDADES — cuando el maestro pida un examen o actividad, usa este formato:
📝 EXAMEN / ACTIVIDAD
Grado: [grado] | Grupo: [grupo]
Campo Formativo: [campo]
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
Ciclo Escolar: 2024-2025

Estimado padre/madre de familia de: _______________
Grado y Grupo: [grado] [grupo]

Por medio del presente se le cita cordialmente a una reunión el día _______________ a las _______________ horas en [escuela].

🎯 MOTIVO DE LA REUNIÓN
[motivo que el maestro indicó]

Se le solicita puntualidad y presencia. En caso de no poder asistir, favor de comunicarse con el docente.

Atentamente,
[nombre del maestro]
Docente de [grado] grado grupo [grupo]`,
    messages: [{ role: 'user', content: mensaje }],
  })

  const encoder = new TextEncoder()
  const readable = new ReadableStream({
    async start(controller) {
      for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            controller.enqueue(encoder.encode(event.delta.text))
          }
        }
      controller.close()
    },
  })

  return new Response(readable, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
