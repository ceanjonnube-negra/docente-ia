import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import * as XLSX from 'xlsx';
import mammoth from 'mammoth';

export const runtime = 'nodejs';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const INSTRUCCIONES = `Eres un asistente que ayuda a un docente mexicano a digitalizar la lista oficial de alumnos de su grupo. Identifica cada alumno y regresa SOLO un JSON válido (sin explicación, sin markdown, sin backticks) con este formato exacto:

[
  {"numero_lista": 1, "nombre": "Nombre completo del alumno", "curp": "CURP si está disponible o null", "sexo": "H o M si está disponible o null"}
]

Reglas:
- "nombre" debe incluir nombre(s) y apellidos juntos, con formato de nombre propio (primera letra mayúscula, resto minúsculas), corrigiendo espacios extra o mayúsculas sueltas.
- Si no hay número de lista explícito, asígnalo tú en el orden en que aparecen los alumnos, empezando en 1.
- Si no encuentras CURP o sexo para un alumno, pon null en ese campo, no inventes datos.
- Ignora encabezados, títulos, pies de página, o cualquier fila que no sea un alumno real.
- Regresa únicamente el arreglo JSON, nada más.`;

const EXTENSIONES_IMAGEN = ['jpg', 'jpeg', 'png', 'webp', 'heic'];

function mimeDeExtension(extension: string): string {
  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  return 'image/jpeg';
}

async function extraerTextoDeArchivo(
  buffer: Buffer,
  nombreArchivo: string
): Promise<string> {
  const extension = nombreArchivo.split('.').pop()?.toLowerCase() || '';

  if (extension === 'xlsx' || extension === 'xls') {
    const libro = XLSX.read(buffer, { type: 'buffer' });
    const nombreHoja = libro.SheetNames[0];
    const hoja = libro.Sheets[nombreHoja];
    return XLSX.utils.sheet_to_csv(hoja);
  }

  if (extension === 'docx' || extension === 'doc') {
    const resultado = await mammoth.extractRawText({ buffer });
    return resultado.value;
  }

  if (extension === 'pdf') {
    const pdfParse = (await import('pdf-parse')).default;
    const resultado = await pdfParse(buffer);
    return resultado.text;
  }

  throw new Error('Formato de archivo no soportado');
}

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
    const formData = await req.formData();
    const archivo = formData.get('archivo') as File | null;

    if (!archivo) {
      return NextResponse.json(
        { error: 'No se recibió ningún archivo' },
        { status: 400 }
      );
    }

    const arrayBuffer = await archivo.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const extension = archivo.name.split('.').pop()?.toLowerCase() || '';
    const esImagen = EXTENSIONES_IMAGEN.includes(extension);

    let alumnos;

    if (esImagen) {
      // Foto de la lista: se manda directo a Claude Vision, sin extracción de texto previa
      const base64 = buffer.toString('base64');
      const respuesta = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mimeDeExtension(extension) as any,
                  data: base64,
                },
              },
              {
                type: 'text',
                text: `Esta imagen es una foto de una lista oficial de alumnos (puede estar impresa o escrita a mano). ${INSTRUCCIONES}`,
              },
            ],
          },
        ],
      });
      alumnos = extraerJsonDeRespuesta(respuesta);
    } else {
      const textoExtraido = await extraerTextoDeArchivo(buffer, archivo.name);

      if (!textoExtraido || textoExtraido.trim().length === 0) {
        return NextResponse.json(
          { error: 'No se pudo extraer contenido del archivo' },
          { status: 422 }
        );
      }

      const respuesta = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        messages: [
          {
            role: 'user',
            content: `${INSTRUCCIONES}\n\nContenido extraído del archivo:\n"""\n${textoExtraido.slice(0, 15000)}\n"""`,
          },
        ],
      });
      alumnos = extraerJsonDeRespuesta(respuesta);
    }

    return NextResponse.json({ alumnos });
  } catch (error: any) {
    console.error('Error en importar-alumnos:', error);
    if (error instanceof SyntaxError) {
      return NextResponse.json(
        { error: 'La IA no devolvió un formato válido. Intenta de nuevo.' },
        { status: 500 }
      );
    }
    return NextResponse.json(
      { error: error.message || 'Ocurrió un error al procesar el archivo' },
      { status: 500 }
    );
  }
}
