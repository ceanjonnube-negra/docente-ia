// lib/sesionContexto.ts
// Arma el bloque de contexto de sesión que el Clasificador de Nivel 0
// necesita: quién es el docente, qué institución/ciclo/grupo tiene
// activo, y la lista ligera de alumnos de ese grupo (para resolver
// nombres mencionados en el chat contra IDs reales).

import type { SupabaseClient } from '@supabase/supabase-js';
import { fechaISOHoy } from './tiempo/TimeService';
import { nombreOficialAlumno } from './rosterGrupo';

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

  // CAUSA RAÍZ real de "el Chat IA dice que no tiene acceso" en
  // cualquier módulo (no solo asistencia): esta función resolvía el
  // "grupo activo" leyendo un puntero aparte, docente_contexto_activo,
  // que SOLO se escribe una vez al crear un grupo nuevo (ver
  // app/dashboard/grupos/nuevo/page.tsx) y nunca se vuelve a actualizar
  // después — ni hay ninguna pantalla para cambiarlo. Si ese puntero
  // quedaba ausente o apuntando a un ciclo escolar ya no activo,
  // grupo_activo_id salía null (o apuntaba al grupo equivocado) para
  // el Chat, mientras que app/dashboard/lista/page.tsx (cargarTodo)
  // sigue mostrando datos reales porque calcula el grupo activo DE
  // CERO cada vez, sin depender de ningún puntero guardado. Fuente
  // única de verdad real: la misma consulta que ya usa Lista, no un
  // caché aparte que puede desincronizarse en silencio.
  const { data: grupos } = await sb
    .from('grupos')
    .select('id, institucion_id, ciclo_escolar_id, creado_en, ciclos_escolares!inner(activo)')
    .eq('docente_id', docenteId)
    .eq('ciclos_escolares.activo', true)
    .order('creado_en', { ascending: false })
    .limit(1);

  const grupoActivo = grupos?.[0] as { id: string; institucion_id: string | null; ciclo_escolar_id: string | null; creado_en: string } | undefined;
  if (!grupoActivo) {
    console.log(`[ASISTENCIA][chat] ts=${new Date().toISOString()} fecha=${base.fecha_actual} grupo=(ninguno) origen=obtenerSesionContexto — sin grupo activo para docente ${docenteId}`);
    return base;
  }

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
    `[ASISTENCIA][chat] ts=${new Date().toISOString()} fecha=${base.fecha_actual} grupo=${grupoActivo.id} grupo_creado_en=${grupoActivo.creado_en} ciclo=${grupoActivo.ciclo_escolar_id} origen=obtenerSesionContexto`
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
