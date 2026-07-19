// lib/sesionContexto.ts
// Arma el bloque de contexto de sesión que el Clasificador de Nivel 0
// necesita: quién es el docente, qué institución/ciclo/grupo tiene
// activo, y la lista ligera de alumnos de ese grupo (para resolver
// nombres mencionados en el chat contra IDs reales).

import type { SupabaseClient } from '@supabase/supabase-js';
import { fechaISOHoy } from './tiempo/TimeService';

export type AlumnoLigero = {
  alumno_id: string;
  nombre_completo: string;
  // 'M' = mujer, 'H' = hombre (valores reales de la columna alumnos.sexo).
  sexo: string | null;
  numero_lista: number | null;
};

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
  docenteId: string,
  zonaHoraria?: string | null
): Promise<SesionContexto> {
  const base: SesionContexto = {
    docente_id: docenteId,
    institucion_id: null,
    ciclo_escolar_id: null,
    grupo_activo_id: null,
    // Zona horaria real del dispositivo del docente — nunca la del
    // servidor (Vercel corre en UTC, que puede ya ser "mañana" respecto
    // al día real del docente en cualquier zona de México).
    fecha_actual: fechaISOHoy(zonaHoraria),
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
    // sexo y numero_lista van aquí (no solo el nombre) para que el Chat
    // IA pueda contestar "¿cuántas niñas y niños hay?" o dar el número
    // de lista real de un alumno sin inventarlo — antes esos datos no
    // llegaban nunca al modelo y los adivinaba.
    const { data: inscritos } = await sb
      .from('inscripciones')
      .select('alumno_id, numero_lista, alumnos(nombre, sexo)')
      .eq('grupo_id', activo.grupo_id)
      .eq('estatus', 'activo');

    if (inscritos) {
      base.alumnos_del_grupo_activo = inscritos
        .map((row: any) => ({
          alumno_id: row.alumno_id,
          nombre_completo: row.alumnos?.nombre ?? '',
          sexo: row.alumnos?.sexo ?? null,
          numero_lista: row.numero_lista ?? null,
        }))
        .filter((a: AlumnoLigero) => a.nombre_completo);
    }
  }

  return base;
}
