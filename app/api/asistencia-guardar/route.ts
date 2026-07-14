import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    const { registros, grupo_id, access_token } = await req.json();
    // registros: [{ alumno_id, presente }]

    if (!Array.isArray(registros) || registros.length === 0) {
      return NextResponse.json({ error: 'Sin registros para guardar' }, { status: 400 });
    }

    if (!access_token) {
      return NextResponse.json({ error: 'Sesión no encontrada. Vuelve a iniciar sesión.' }, { status: 401 });
    }

    // Cliente por-request con el token del docente, para que auth.uid()
    // resuelva correctamente dentro de las políticas RLS.
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        global: {
          headers: { Authorization: `Bearer ${access_token}` },
        },
      }
    );

    const fecha = new Date().toISOString().slice(0, 10);

    const filas = registros.map((r: { alumno_id: string; presente: boolean }) => ({
      alumno_id: r.alumno_id,
      fecha,
      presente: r.presente,
      ...(grupo_id ? { grupo_id } : {}),
    }));

    const { data, error } = await supabase
      .from('asistencias')
      .upsert(filas, { onConflict: 'alumno_id,fecha' })
      .select();

    if (error) {
      console.error('Error al guardar asistencia:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, guardados: data?.length ?? 0 });
  } catch (err: any) {
    console.error(err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}