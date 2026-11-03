// lib/sesionContexto.ts
// Arma el bloque de contexto de sesión que el Clasificador de Nivel 0
// necesita: quién es el docente, qué institución/ciclo/grupo tiene
// activo, y la lista ligera de alumnos de ese grupo (para resolver
// nombres mencionados en el chat contra IDs reales).

import type { SupabaseClient } from '@supabase/supabase-js';
import { fechaISOHoy } from './tiempo/TimeService';
import { nombreOficialAlumno } from './rosterGrupo';
import { resolverGrupoActivo } from './grupoActivo';

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

  // Mismo grupo activo que Lista y Evaluación (lib/grupoActivo.ts).
  // docente_contexto_activo solo se escribe al crear un grupo, así que
  // puede quedar ausente o apuntar a un ciclo ya no activo: se usa como
  // preferencia revalidada (grupo del docente, ciclo activo) y, si no es
  // válida, cae al grupo más reciente del docente — nunca deja al Chat
  // sin grupo por un puntero desactualizado. Sin grupo autorizado (o
  // ante un error de lectura), la sesión sigue sin grupo, como siempre.
  // PENDIENTE: una conversación ya creada conserva el grupo que le fijó
  // fijar_grupo_conversacion, que puede diferir de este grupo activo si
  // después cambió (p. ej. al crear otro grupo); las herramientas del
  // Chat usan este grupo, no el fijado.
  const resolucion = await resolverGrupoActivo(sb, docenteId);
  if (!resolucion.ok) {
    console.log(`[ASISTENCIA][chat] ts=${new Date().toISOString()} fecha=${base.fecha_actual} grupo=(ninguno) motivo=${resolucion.motivo} origen=obtenerSesionContexto — sin grupo activo para docente ${docenteId}`);
    return base;
  }
  const grupoActivo = resolucion.grupo;

  base.institucion_id = grupoActivo.institucion_id;
  base.ciclo_escolar_id = grupoActivo.ciclo_escolar_id;
  base.grupo_activo_id = grupoActivo.id;

  // Log temporal de diagnóstico (ver "Corregir inconsistencia entre
  // Lista y Chat IA en el resumen de asistencia") — mismo formato que
  // el log equivalente de app/dashboard/lista/page.tsx (consola del
  // navegador). grupo_creado_en es la marca de tiempo REAL que
  // desempata "cuál grupo es el activo" cuando el docente tiene más de
  // una fila en `grupos`; si Lista y Chat alguna vez muestran un
  // grupo_id distinto para el mismo docente, este valor es lo primero
  // que hay que comparar. Quitar una vez confirmado en producción.
  console.log(
    `[ASISTENCIA][chat] ts=${new Date().toISOString()} fecha=${base.fecha_actual} grupo=${grupoActivo.id} grupo_creado_en=${grupoActivo.creado_en} ciclo=${grupoActivo.ciclo_escolar_id} resolucion=${resolucion.origen} origen=obtenerSesionContexto`
  );

  // sexo y numero_lista van aquí (no solo el nombre) para que el Chat
  // IA pueda contestar "¿cuántas niñas y niños hay?" o dar el número
  // de lista real de un alumno sin inventarlo — antes esos datos no
  // llegaban nunca al modelo y los adivinaba.
  const { data: inscritos } = await sb
    .from('inscripciones')
    .select('alumno_id, numero_lista, alumnos(nombre, sexo)')
    .eq('grupo_id', grupoActivo.id)
    .eq('estatus', 'activo');

  if (inscritos) {
    base.alumnos_del_grupo_activo = inscritos
      .map((row: any) => ({
        alumno_id: row.alumno_id,
        // Fuente única de verdad — ver nombreOficialAlumno en
        // lib/rosterGrupo.ts. Nunca se reconstruye ni reformatea aquí
        // ni en ningún otro lugar de la aplicación.
        nombre_completo: row.alumnos ? nombreOficialAlumno(row.alumnos) : '',
        sexo: row.alumnos?.sexo ?? null,
        numero_lista: row.numero_lista ?? null,
      }))
      .filter((a: AlumnoLigero) => a.nombre_completo);
  }

  return base;
}
