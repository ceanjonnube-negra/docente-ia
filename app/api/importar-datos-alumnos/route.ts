import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

export const runtime = 'nodejs';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;
    const docenteId = formData.get('docente_id') as string;
    const accessToken = formData.get('access_token') as string;

    if (!file || !docenteId || !accessToken) {
      return NextResponse.json({ error: 'Falta la foto, el docente_id o la sesión.' }, { status: 400 });
    }

    const supabaseUser = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { global: { headers: { Authorization: `Bearer ${accessToken}` } } }
    );

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const base64 = buffer.toString('base64');

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 3000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Analiza esta lista oficial de alumnos (probablemente de la SEP) y extrae, para cada alumno, exactamente estos campos si están visibles: nombre completo, CURP, sexo (responde únicamente "H" para hombre o "M" para mujer, según lo indicado en el documento), y fecha de nacimiento en formato YYYY-MM-DD.

Responde ÚNICAMENTE en este formato JSON, sin texto adicional ni backticks:
{"alumnos": [{"nombre": "...", "curp": "...", "sexo": "H", "fecha_nacimiento": "2015-03-20"}]}

Si algún campo no es legible o no aparece para un alumno, usa null en ese campo (nunca inventes datos).`,
            },
            {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${base64}` },
            },
          ],
        },
      ],
    });

    const contenido = response.choices[0]?.message?.content || '{"alumnos":[]}';
    const jsonLimpio = contenido.replace(/```json|```/g, '').trim();

    let alumnosDetectados: Array<{
      nombre: string;
      curp: string | null;
      sexo: string | null;
      fecha_nacimiento: string | null;
    }> = [];

    try {
      alumnosDetectados = JSON.parse(jsonLimpio).alumnos || [];
    } catch {
      return NextResponse.json({ error: 'No se pudo leer la lista con claridad.' }, { status: 422 });
    }

    const { data: alumnosExistentes, error: errorAlumnos } = await supabaseUser
      .from('alumnos')
      .select('id, nombre, curp, sexo, fecha_nacimiento')
      .eq('docente_id', docenteId);

    if (errorAlumnos || !alumnosExistentes) {
      return NextResponse.json({ error: 'No se pudo consultar tu lista de alumnos.' }, { status: 500 });
    }

    const normalizar = (s: string) =>
      s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

    const resultados: Array<{
      nombre_detectado: string;
      alumno_emparejado: string | null;
      actualizado: boolean;
      motivo?: string;
    }> = [];

    for (const detectado of alumnosDetectados) {
      const nombreDetectadoNorm = normalizar(detectado.nombre || '');

      let match = alumnosExistentes.find(a => normalizar(a.nombre) === nombreDetectadoNorm);

      if (!match) {
        const palabrasDetectado = nombreDetectadoNorm.split(/\s+/);
        match = alumnosExistentes.find(a => {
          const palabrasExistente = normalizar(a.nombre).split(/\s+/);
          const coincidencias = palabrasDetectado.filter(p => palabrasExistente.includes(p));
          return coincidencias.length >= Math.min(2, palabrasDetectado.length);
        });
      }

      if (!match) {
        resultados.push({
          nombre_detectado: detectado.nombre,
          alumno_emparejado: null,
          actualizado: false,
          motivo: 'No se encontró un alumno existente con nombre parecido.',
        });
        continue;
      }

      const { error: updateError } = await supabaseUser
        .from('alumnos')
        .update({
          curp: detectado.curp || match.curp,
          sexo: detectado.sexo || match.sexo,
          fecha_nacimiento: detectado.fecha_nacimiento || match.fecha_nacimiento,
        })
        .eq('id', match.id);

      resultados.push({
        nombre_detectado: detectado.nombre,
        alumno_emparejado: match.nombre,
        actualizado: !updateError,
        motivo: updateError ? updateError.message : undefined,
      });
    }

    const actualizados = resultados.filter(r => r.actualizado).length;
    const sinEmparejar = resultados.filter(r => !r.alumno_emparejado).length;

    return NextResponse.json({
      success: true,
      total_detectados: alumnosDetectados.length,
      actualizados,
      sin_emparejar: sinEmparejar,
      detalle: resultados,
    });
  } catch (err: any) {
    console.error(err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
