import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { contextoAlumno } from '@/lib/motorContexto';

export const runtime = 'nodejs';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const INSTRUCCIONES = `Eres un asistente que ayuda a un docente mexicano de educación básica a redactar el borrador de una ficha descriptiva de un alumno, a partir de su información real registrada en el sistema. Regresa SOLO un JSON válido (sin explicación, sin markdown, sin backticks) con este formato exacto:

{
  "fortalezas": "texto",
  "areas_oportunidad": "texto",
  "apoyos_requeridos": "texto",
  "observaciones_generales": "texto",
  "recomendaciones": "texto"
}

Reglas:
- Basa cada sección únicamente en la información real que se te proporciona; no inventes datos que no estén presentes.
- Si la información disponible es insuficiente para alguna sección, escribe un texto breve indicándolo (por ejemplo "Sin información suficiente para esta sección todavía"), no la dejes vacía ni inventes contenido.
- Usa un tono profesional, claro y breve (2 a 4 oraciones por sección), apropiado para un documento oficial de educación básica en México.
- Regresa únicamente el objeto JSON, nada más.`;

function extraerJsonDeRespuesta(respuesta: Anthropic.Message): any {
  const bloqueTexto = respuesta.content.find((b) => b.type === 'text');
  const textoRespuesta = bloqueTexto && 'text' in bloqueTexto ? bloqueTexto.text : '';
  const jsonLimpio = textoRespuesta
    .replace(/```json/g, '')
    .replace(/```/g, '')
    .trim();
  return JSON.parse(jsonLimpio);
}

export async function POST(req: NextRequest) {
  try {
    const { alumno_id, ciclo_escolar_id, access_token } = await req.json();

    if (!alumno_id || !ciclo_escolar_id) {
      return NextResponse.json({ error: 'Faltan datos del alumno o del ciclo escolar.' }, { status: 400 });
    }
    if (!access_token) {
      return NextResponse.json({ error: 'Sesión no encontrada. Vuelve a iniciar sesión.' }, { status: 401 });
    }

    // Cliente por-request con el token del docente, para que auth.uid()
    // resuelva correctamente dentro de la RPC del Motor de Contexto.
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        global: {
          headers: { Authorization: `Bearer ${access_token}` },
        },
      }
    );

    const contexto = await contextoAlumno(supabase, alumno_id, ciclo_escolar_id);

    const respuesta = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: `${INSTRUCCIONES}\n\nInformación real del alumno registrada en el sistema:\n"""\n${JSON.stringify(contexto)}\n"""`,
        },
      ],
    });

    const borrador = extraerJsonDeRespuesta(respuesta);
    return NextResponse.json({ borrador });
  } catch (error: any) {
    console.error('Error en generar-ficha-descriptiva:', error);
    if (error instanceof SyntaxError) {
      return NextResponse.json(
        { error: 'La IA no devolvió un formato válido. Intenta de nuevo.' },
        { status: 500 }
      );
    }
    return NextResponse.json(
      { error: error.message || 'Ocurrió un error al generar el borrador.' },
      { status: 500 }
    );
  }
}
