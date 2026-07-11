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
