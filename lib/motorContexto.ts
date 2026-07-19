// lib/motorContexto.ts
// CAMBIO respecto a la versión anterior: ahora recibe el cliente de
// Supabase como parámetro en vez de importar el singleton directamente.
// Esto permite usarlo tanto desde componentes de cliente (pasando el
// singleton de lib/supabaseClient.ts) como desde rutas de servidor
// (pasando un cliente con el token de sesión del usuario, necesario
// para que auth.uid() funcione dentro de las RPC con SECURITY DEFINER).

import type { SupabaseClient } from '@supabase/supabase-js';

export type ExcepcionAsistencia = {
  alumno_id: string;
  estatus: 'presente' | 'falta' | 'retardo' | 'justificada';
};

// --- Funciones agregadas a nivel de grupo (no hay RPC para esto — se
// arma con consultas directas a las tablas, respetando RLS vía el
// cliente de sesión del docente que se recibe como parámetro). Todas
// alimentan al Clasificador de Nivel 0 para que el Chat IA conteste con
// datos reales ("¿quién faltó hoy?", "¿quién tiene más faltas?", "¿qué
// alumnos requieren apoyo?", etc.) en vez de decir que no tiene acceso.

export type AsistenciaGrupoResumen = {
  fecha: string;
  presentes: string[];
  faltas: string[];
  retardos: string[];
  sinRegistrarHoy: string[];
  rankingFaltas: { nombre: string; faltas: number }[];
  ultimaFechaRegistrada: string | null;
};

export async function asistenciaGrupoResumen(
  sb: SupabaseClient,
  grupoId: string,
  fecha: string
): Promise<AsistenciaGrupoResumen> {
  const vacio: AsistenciaGrupoResumen = {
    fecha,
    presentes: [],
    faltas: [],
    retardos: [],
    sinRegistrarHoy: [],
    rankingFaltas: [],
    ultimaFechaRegistrada: null,
  };

  const { data: inscripciones } = await sb
    .from('inscripciones')
    .select('id, alumno_id, alumnos(nombre)')
    .eq('grupo_id', grupoId)
    .eq('estatus', 'activo');
  if (!inscripciones || inscripciones.length === 0) return vacio;

  type FilaInscripcion = { id: string; alumno_id: string; alumnos: { nombre: string | null } | { nombre: string | null }[] | null };
  const nombrePorInscripcion = new Map(
    (inscripciones as FilaInscripcion[]).map((i) => {
      const rel = Array.isArray(i.alumnos) ? i.alumnos[0] : i.alumnos;
      return [i.id, rel?.nombre || 'Alumno'];
    })
  );
  const inscripcionIds = Array.from(nombrePorInscripcion.keys());

  // Registros de HOY — quién está presente/falta/retardo, y quién de
  // plano no tiene registro todavía.
  const { data: registrosHoy } = await sb
    .from('asistencia_registro')
    .select('inscripcion_id, estatus')
    .eq('fecha', fecha)
    .in('inscripcion_id', inscripcionIds);

  const estatusHoyPorInscripcion = new Map(
    (registrosHoy || []).map((r: { inscripcion_id: string; estatus: string }) => [r.inscripcion_id, r.estatus])
  );
  for (const [inscripcionId, nombre] of nombrePorInscripcion) {
    const estatus = estatusHoyPorInscripcion.get(inscripcionId);
    if (estatus === 'presente') vacio.presentes.push(nombre);
    else if (estatus === 'falta') vacio.faltas.push(nombre);
    else if (estatus === 'retardo') vacio.retardos.push(nombre);
    else vacio.sinRegistrarHoy.push(nombre);
  }

  // Ranking de faltas en todo el ciclo (no solo hoy) — para "¿quién
  // tiene más faltas?". Se cuenta en memoria (grupos normalmente son
  // ~20-35 alumnos, no vale la pena una RPC nueva para esto).
  const { data: todosLosRegistros } = await sb
    .from('asistencia_registro')
    .select('inscripcion_id, estatus, fecha')
    .in('inscripcion_id', inscripcionIds);

  const faltasPorInscripcion = new Map<string, number>();
  let ultimaFecha: string | null = null;
  for (const r of (todosLosRegistros || []) as { inscripcion_id: string; estatus: string; fecha: string }[]) {
    if (r.estatus === 'falta') faltasPorInscripcion.set(r.inscripcion_id, (faltasPorInscripcion.get(r.inscripcion_id) || 0) + 1);
    if (!ultimaFecha || r.fecha > ultimaFecha) ultimaFecha = r.fecha;
  }
  vacio.ultimaFechaRegistrada = ultimaFecha;
  vacio.rankingFaltas = Array.from(faltasPorInscripcion.entries())
    .map(([inscripcionId, faltas]) => ({ nombre: nombrePorInscripcion.get(inscripcionId) || 'Alumno', faltas }))
    .filter((f) => f.faltas > 0)
    .sort((a, b) => b.faltas - a.faltas)
    .slice(0, 10);

  return vacio;
}

export type ApoyoAlumno = { nombre: string; tipo: string | null; descripcion: string | null };

export async function necesidadesApoyoGrupo(sb: SupabaseClient, grupoId: string): Promise<ApoyoAlumno[]> {
  const { data: inscripciones } = await sb
    .from('inscripciones')
    .select('alumno_id, alumnos(nombre)')
    .eq('grupo_id', grupoId)
    .eq('estatus', 'activo');
  if (!inscripciones || inscripciones.length === 0) return [];

  type FilaInscripcion = { alumno_id: string; alumnos: { nombre: string | null } | { nombre: string | null }[] | null };
  const nombrePorAlumno = new Map(
    (inscripciones as FilaInscripcion[]).map((i) => {
      const rel = Array.isArray(i.alumnos) ? i.alumnos[0] : i.alumnos;
      return [i.alumno_id, rel?.nombre || 'Alumno'];
    })
  );
  const alumnoIds = Array.from(nombrePorAlumno.keys());

  const { data: necesidades } = await sb
    .from('necesidades_apoyo')
    .select('alumno_id, tipo, descripcion')
    .in('alumno_id', alumnoIds)
    .eq('activa', true);

  return ((necesidades || []) as { alumno_id: string; tipo: string | null; descripcion: string | null }[]).map((n) => ({
    nombre: nombrePorAlumno.get(n.alumno_id) || 'Alumno',
    tipo: n.tipo,
    descripcion: n.descripcion,
  }));
}

export type DocumentoResumen = { titulo: string; tipo: string; fecha: string };

export async function documentosDelDocente(sb: SupabaseClient, userId: string, limite = 15): Promise<{ total: number; recientes: DocumentoResumen[] }> {
  const { data, count } = await sb
    .from('documentos_generados')
    .select('titulo, tipo, created_at', { count: 'exact' })
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limite);

  return {
    total: count ?? (data?.length || 0),
    recientes: ((data || []) as { titulo: string; tipo: string; created_at: string }[]).map((d) => ({
      titulo: d.titulo,
      tipo: d.tipo,
      fecha: d.created_at,
    })),
  };
}

export type EventoCalendario = { titulo: string; fecha: string; tipo: string };

export async function calendarioProximo(sb: SupabaseClient, userId: string, fechaDesde: string, limite = 10): Promise<EventoCalendario[]> {
  // user_id null = evento del calendario oficial SEP (compartido para
  // todos); user_id propio = actividad que el docente agregó.
  const { data } = await sb
    .from('calendario_eventos')
    .select('titulo, fecha, tipo, user_id')
    .gte('fecha', fechaDesde)
    .or(`user_id.eq.${userId},user_id.is.null`)
    .order('fecha', { ascending: true })
    .limit(limite);

  return ((data || []) as { titulo: string; fecha: string; tipo: string }[]).map((e) => ({
    titulo: e.titulo,
    fecha: e.fecha,
    tipo: e.tipo,
  }));
}

export async function contextoAlumno(sb: SupabaseClient, alumnoId: string, cicloEscolarId: string) {
  const { data, error } = await sb.rpc('contexto_alumno', {
    p_alumno_id: alumnoId,
    p_ciclo_escolar_id: cicloEscolarId,
  });
  if (error) throw error;
  return data;
}

export async function contextoGrupo(sb: SupabaseClient, grupoId: string) {
  const { data, error } = await sb.rpc('contexto_grupo', { p_grupo_id: grupoId });
  if (error) throw error;
  return data;
}

export async function contextoDocente(sb: SupabaseClient) {
  const { data, error } = await sb.rpc('contexto_docente');
  if (error) throw error;
  return data;
}

export async function registrarAsistenciaMasiva(
  sb: SupabaseClient,
  grupoId: string,
  fecha: string,
  excepciones: ExcepcionAsistencia[] = []
) {
  const { data, error } = await sb.rpc('registrar_asistencia_masiva', {
    p_grupo_id: grupoId,
    p_fecha: fecha,
    p_excepciones: excepciones,
  });
  if (error) throw error;
  return data;
}

export async function consultarAsistenciaAlumno(sb: SupabaseClient, alumnoId: string, cicloEscolarId: string) {
  const { data, error } = await sb.rpc('consultar_asistencia_alumno', {
    p_alumno_id: alumnoId,
    p_ciclo_escolar_id: cicloEscolarId,
  });
  if (error) throw error;
  return data as { faltas: number; retardos: number; justificadas: number; dias_registrados: number };
}

export async function actualizarDatosAlumno(
  sb: SupabaseClient,
  alumnoId: string,
  cambios: Partial<{
    nombre_completo: string;
    curp: string;
    sexo: string;
    fecha_nacimiento: string;
  }>
) {
  const { data, error } = await sb.rpc('actualizar_datos_alumno', {
    p_alumno_id: alumnoId,
    p_nombre_completo: cambios.nombre_completo ?? null,
    p_curp: cambios.curp ?? null,
    p_sexo: cambios.sexo ?? null,
    p_fecha_nacimiento: cambios.fecha_nacimiento ?? null,
  });
  if (error) throw error;
  return data;
}

export async function eliminarAlumnoDefinitivamente(sb: SupabaseClient, alumnoId: string) {
  const { error } = await sb.rpc('eliminar_alumno_definitivamente', { p_alumno_id: alumnoId });
  if (error) throw error;
}

export async function compartirGrupoConDocente(
  sb: SupabaseClient,
  grupoId: string,
  docenteDestinoId: string,
  rol: 'titular' | 'apoyo' = 'apoyo'
) {
  const { data, error } = await sb.rpc('compartir_grupo_con_docente', {
    p_grupo_id: grupoId,
    p_docente_destino_id: docenteDestinoId,
    p_rol: rol,
  });
  if (error) throw error;
  return data;
}
