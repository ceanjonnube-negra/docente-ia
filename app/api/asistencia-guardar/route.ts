import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { fechaISOHoy } from '@/lib/tiempo/TimeService';

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

    // La tabla legada `asistencias` solo tiene una columna booleana `presente`
    // (no distingue retardo). Un retardo cuenta como presente para ese modelo.
    const filas = registrosNormalizados.map((r) => ({
      alumno_id: r.alumno_id,
      fecha,
      presente: r.estado !== 'falta',
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

    // Escritura adicional en asistencia_registro (modelo nuevo del CORE, vía inscripcion_id).
    // Aquí sí se guarda el estatus completo (presente/falta/retardo), ya que
    // esa columna soporta el enum completo. Es de mejor esfuerzo: si falla,
    // no afecta la respuesta al usuario porque el guardado en asistencias
    // (arriba) ya se completó correctamente.
    const alumnoIds = registrosNormalizados.map((r) => r.alumno_id);

    const { data: inscripcionesActivas } = await supabase
      .from('inscripciones')
      .select('id, alumno_id')
      .in('alumno_id', alumnoIds)
      .eq('estatus', 'activo');

    const inscripcionPorAlumno = new Map(
      (inscripcionesActivas || []).map((i: { id: string; alumno_id: string }) => [i.alumno_id, i.id])
    );

    const filasRegistro = registrosNormalizados
      .filter((r) => inscripcionPorAlumno.has(r.alumno_id))
      .map((r) => ({
        inscripcion_id: inscripcionPorAlumno.get(r.alumno_id) as string,
        fecha,
        estatus: r.estado,
      }));

    if (filasRegistro.length > 0) {
      const { error: errorRegistro } = await supabase
        .from('asistencia_registro')
        .upsert(filasRegistro, { onConflict: 'inscripcion_id,fecha' });

      if (errorRegistro) {
        console.error('Error al guardar asistencia_registro (no bloqueante):', errorRegistro);
      }
    }

    return NextResponse.json({ success: true, guardados: data?.length ?? 0 });
  } catch (err: any) {
    console.error(err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}