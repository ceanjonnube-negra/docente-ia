import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import OpenAI from 'openai';

export const runtime = 'nodejs';
export const maxDuration = 60;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function chunkText(text: string, chunkSize = 1000, overlap = 150) {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));
    start += chunkSize - overlap;
  }
  return chunks;
}

async function extractText(buffer: Buffer, mimeType: string, filename: string): Promise<string> {
  if (mimeType === 'application/pdf' || filename.endsWith('.pdf')) {
    const pdfParse = (await import('pdf-parse')).default;
    const data = await pdfParse(buffer);
    return data.text;
  }
  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    filename.endsWith('.docx')
  ) {
    const mammoth = (await import('mammoth')).default;
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  return buffer.toString('utf-8');
}

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;
    const categoria = (formData.get('categoria') as string) || 'General';
    const descripcion = (formData.get('descripcion') as string) || '';
    const institucionId = (formData.get('institucion_id') as string) || null;

    if (!file) {
      return NextResponse.json({ error: 'No se envio archivo' }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');

    const { data: existente } = await supabase
      .from('documentos_institucionales')
      .select('id, nombre_archivo, version')
      .eq('hash_archivo', hash)
      .maybeSingle();

    if (existente) {
      return NextResponse.json(
        { error: 'Este documento ya existe', documento: existente },
        { status: 409 }
      );
    }

    const storagePath = Date.now() + '-' + file.name;
    const { error: storageError } = await supabase.storage
      .from('documentos-institucionales')
      .upload(storagePath, buffer, { contentType: file.type });

    if (storageError) {
      return NextResponse.json({ error: storageError.message }, { status: 500 });
    }

    const texto = await extractText(buffer, file.type, file.name);

    const { data: documento, error: docError } = await supabase
      .from('documentos_institucionales')
      .insert({
        nombre_archivo: file.name,
        tipo: file.type,
        contenido_texto: texto.slice(0, 5000),
        categoria,
        descripcion,
        institucion_id: institucionId,
        estado: 'activo',
        tamano_bytes: buffer.length,
        hash_archivo: hash,
        storage_path: storagePath,
        version: 1,
      })
      .select()
      .single();

    if (docError || !documento) {
      return NextResponse.json({ error: docError?.message }, { status: 500 });
    }

    const chunks = chunkText(texto);
    let numEmbeddings = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunkTexto = chunks[i];
      if (!chunkTexto.trim()) continue;

      const embeddingResponse = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: chunkTexto,
      });

      const embedding = embeddingResponse.data[0].embedding;

      await supabase.from('documento_chunks').insert({
        documento_id: documento.id,
        chunk_index: i,
        chunk_texto: chunkTexto,
        embedding,
      });

      numEmbeddings++;
    }

    await supabase
      .from('documentos_institucionales')
      .update({ num_embeddings: numEmbeddings })
      .eq('id', documento.id);

    return NextResponse.json({
      success: true,
      documento_id: documento.id,
      chunks_creados: numEmbeddings,
    });
  } catch (err: any) {
    console.error(err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
