// lib/sesionContexto.ts
// Arma el bloque de contexto de sesión que el Clasificador de Nivel 0
// necesita: quién es el docente, qué institución/ciclo/grupo tiene
// activo, y la lista ligera de alumnos de ese grupo (para resolver
// nombres mencionados en el chat contra IDs reales).

import type { SupabaseClient } from '@supabase/supabase-js';

export type AlumnoLigero = { alumno_id: string; nombre_completo: string };

export type SesionContexto = {
  docente_id: string;
  institucion_id: string | null;
  ciclo_escolar_id: string | null;
  grupo_activo_id: string | null;
  fecha_actual: string;
  alumnos_del_grupo_activo: AlumnoLigero[];
};

export async function obtenerSesionContexto(
  sb: SupabaseClient,
  docenteId: string
): Promise<SesionContexto> {
  const base: SesionContexto = {
    docente_id: docenteId,
    institucion_id: null,
    ciclo_escolar_id: null,
    grupo_activo_id: null,
    fecha_actual: new Date().toISOString().slice(0, 10),
    alumnos_del_grupo_activo: [],
  };

  const { data: activo } = await sb
    .from('docente_contexto_activo')
    .select('institucion_id, ciclo_escolar_id, grupo_id')
    .eq('docente_id', docenteId)
    .maybeSingle();

  if (!activo) return base;

  base.institucion_id = activo.institucion_id;
  base.ciclo_escolar_id = activo.ciclo_escolar_id;
  base.grupo_activo_id = activo.grupo_id;

  if (activo.grupo_id) {
    const { data: inscritos } = await sb
      .from('inscripciones')
      .select('alumno_id, alumnos(nombre)')
      .eq('grupo_id', activo.grupo_id)
      .eq('estatus', 'activo');

    if (inscritos) {
      base.alumnos_del_grupo_activo = inscritos
        .map((row: any) => ({
          alumno_id: row.alumno_id,
          nombre_completo: row.alumnos?.nombre ?? '',
        }))
        .filter((a: AlumnoLigero) => a.nombre_completo);
    }
  }

  return base;
}
