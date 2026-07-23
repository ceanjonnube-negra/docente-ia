import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

// FASE 1A — "Protección de endpoints críticos": este endpoint quedó
// deshabilitado a propósito. Confirmado dos veces (auditoría técnica
// completa + verificación fresca con grep antes de esta implementación)
// que no tiene NINGÚN consumidor real en app/, components/ ni lib/ —
// la funcionalidad de OCR de imagen ya vive, duplicada, dentro de
// app/api/upload-documento/route.ts (extractTextFromImage). No se
// elimina el archivo (podría reactivarse con autenticación real si
// alguna vez se conecta a un flujo real), pero no debe volver a llamar
// a OpenAI ni procesar ningún archivo mientras siga sin consumidores —
// mantenerlo "vivo" solo aumentaba la superficie de ataque de un
// endpoint que nadie usa.
export async function POST() {
  return NextResponse.json(
    { error: 'Este endpoint fue descontinuado por no tener consumidores activos.' },
    { status: 410 }
  );
}
