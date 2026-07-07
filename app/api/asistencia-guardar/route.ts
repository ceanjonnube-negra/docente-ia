import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: Request) {
  try {
    const { registros } = await req.json();
    // registros: [{ alumno_id, presente }]

    if (!Array.isArray(registros) || registros.length === 0) {
      return NextResponse.json({ error: 'Sin registros para guardar' }, { status: 400 });
    }

    const fecha = new Date().toISOString().slice(0, 10);

    for (const r of registros) {
      await supabase
        .from('asistencias')
        .upsert(
          { alumno_id: r.alumno_id, fecha, presente: r.presente },
          { onConflict: 'alumno_id,fecha' }
        );
    }

    return NextResponse.json({ success: true, guardados: registros.length });
  } catch (err: any) {
    console.error(err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
