import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

export const runtime = 'nodejs';
export const maxDuration = 60;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;
    const docenteId = formData.get('docente_id') as string;
    const grupo = (formData.get('grupo') as string) || '';

    if (!file || !docenteId) {
      return NextResponse.json({ error: 'Falta la foto o el docente_id' }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const base64 = buffer.toString('base64');

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Esta imagen es una lista de asistencia escolar. Extrae SOLO los nombres completos de los alumnos que aparecen escritos. Responde ÚNICAMENTE con un JSON válido en este formato exacto, sin texto adicional: {"nombres": ["Nombre Apellido", "Nombre Apellido"]}. Si un nombre no se distingue con claridad, ignóralo.',
            },
            {
              type: 'image_url',
              image_url: { url: `data:${file.type};base64,${base64}` },
            },
          ],
        },
      ],
      max_tokens: 2000,
    });

    const contenido = response.choices[0]?.message?.content || '{"nombres":[]}';
    const jsonLimpio = contenido.replace(/```json|```/g, '').trim();
    let nombresExtraidos: string[] = [];
    try {
      nombresExtraidos = JSON.parse(jsonLimpio).nombres || [];
    } catch {
      return NextResponse.json({ error: 'No se pudo leer la lista con claridad' }, { status: 422 });
    }

    for (const nombre of nombresExtraidos) {
      const nombreLimpio = nombre.trim();
      if (!nombreLimpio) continue;
      await supabase
        .from('alumnos')
        .upsert(
          { nombre: nombreLimpio, docente_id: docenteId, grupo },
          { onConflict: 'nombre,docente_id', ignoreDuplicates: true }
        );
    }

    const { data: alumnos, error } = await supabase
      .from('alumnos')
      .select('id, nombre')
      .eq('docente_id', docenteId)
      .order('nombre', { ascending: true });

    if (error) throw error;

    return NextResponse.json({
      success: true,
      nuevos_detectados: nombresExtraidos.length,
      alumnos,
    });
  } catch (err: any) {
    console.error(err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
