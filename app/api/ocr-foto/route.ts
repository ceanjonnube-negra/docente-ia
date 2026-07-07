import { NextResponse } from 'next/server';
import OpenAI from 'openai';

export const runtime = 'nodejs';
export const maxDuration = 60;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return NextResponse.json({ error: 'No se envió foto' }, { status: 400 });
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
              text: 'Extrae todo el texto visible en esta imagen de forma literal y completa. No agregues comentarios ni interpretaciones, solo el texto tal como aparece.',
            },
            {
              type: 'image_url',
              image_url: { url: `data:${file.type};base64,${base64}` },
            },
          ],
        },
      ],
      max_tokens: 4000,
    });

    const texto = response.choices[0]?.message?.content || '';
    return NextResponse.json({ success: true, texto });
  } catch (err: any) {
    console.error(err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
