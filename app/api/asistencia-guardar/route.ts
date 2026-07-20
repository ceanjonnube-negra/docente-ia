import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { fechaISOHoy } from '@/lib/tiempo/TimeService';
import { escribirAsistencia } from '@/lib/motorContexto';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    const { registros, grupo_id, access_token, zonaHoraria } = await req.json();
    // registros: [{ alumno_id, estado: 'presente' | 'falta' | 'retardo' }]

    if (!Array.isArray(registros) || registros.length === 0) {
      return NextResponse.json({ error: 'Sin registros para guardar' }, { status: 400 });
    }

    // Frontera del sistema: se normaliza el estado recibido en vez de
    // confiar en él directamente. Si un cliente desactualizado envía un
    // payload sin `estado` (por ejemplo el formato booleano anterior), esto
    // evita mandar un valor nulo/ inválido a la columna NOT NULL
    // asistencia_registro.estatus.
    const ESTADOS_VALIDOS = new Set(['presente', 'falta', 'retardo']);
    const registrosNormalizados: { alumno_id: string; estado: 'presente' | 'falta' | 'retardo' }[] = registros.map(
      (r: { alumno_id: string; estado?: string }) => ({
        alumno_id: r.alumno_id,
        estado: (ESTADOS_VALIDOS.has(r.estado as string) ? r.estado : 'presente') as 'presente' | 'falta' | 'retardo',
      })
    );

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

    // "Hoy" en la zona horaria REAL del dispositivo del docente, no la
    // del servidor (Vercel corre en UTC) — cerca de medianoche en
    // cualquier zona de México, new Date() en el servidor podía marcar
    // la asistencia en el día equivocado.
    const fecha = fechaISOHoy(zonaHoraria);

    // Escritura real — ver lib/motorContexto.ts (escribirAsistencia):
    // misma función que usa el Chat IA para marcar la asistencia de un
    // solo alumno por nombre, así Lista y Chat IA nunca pueden divergir
    // en cómo se guarda un registro de asistencia.
    const resultado = await escribirAsistencia(supabase, registrosNormalizados, fecha, grupo_id || null);

    if (!resultado.exito) {
      console.error('Error al guardar asistencia:', resultado.error);
      return NextResponse.json({ error: resultado.error }, { status: 500 });
    }

    return NextResponse.json({ success: true, guardados: resultado.guardados });
  } catch (err: any) {
    console.error(err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
