// lib/sesionContexto.ts
// Arma el bloque de contexto de sesión que el Clasificador de Nivel 0
// necesita: quién es el docente, qué institución/ciclo/grupo tiene
// activo, y la lista ligera de alumnos de ese grupo (para resolver
// nombres mencionados en el chat contra IDs reales).

import type { SupabaseClient } from '@supabase/supabase-js';
import { fechaISOHoy } from './tiempo/TimeService';
import { nombreOficialAlumno } from './rosterGrupo';
import { resolverGrupoActivo, rotuloGrupo } from './grupoActivo';
import type { VinculoConversacion } from './vinculoConversacion';

export type AlumnoLigero = {
  alumno_id: string;
  nombre_completo: string;
  // 'M' = mujer, 'H' = hombre (valores reales de la columna alumnos.sexo).
  sexo: string | null;
  numero_lista: number | null;
};

// Por qué la sesión quedó SIN grupo a propósito (fail-closed), aunque el
// docente tenga otros grupos: nunca se sustituye el grupo de la
// conversación por otro.
export type MotivoGrupoNoDisponible = 'grupo_fijado_no_valido' | 'conversacion_no_autorizada' | 'error_vinculo';

export type SesionContexto = {
  docente_id: string;
  institucion_id: string | null;
  ciclo_escolar_id: string | null;
  grupo_activo_id: string | null;
  fecha_actual: string;
  alumnos_del_grupo_activo: AlumnoLigero[];
  grupo_no_disponible?: MotivoGrupoNoDisponible;
  // Rótulo del grupo efectivo de la sesión (rotuloGrupo: "4°" y "B", o
  // nombre_grupo si no tiene grado) para encabezados — nunca el perfil.
  grupo_activo_grado?: string | null;
  grupo_activo_letra?: string | null;
  // Grado y letra tal como están en el grupo efectivo (grupos.grado /
  // grupos.grupo), para el encabezado de documentos de ese grupo
  // (perfilConGrupoAcademico). Sin grupo en la sesión: ausente.
  grupo_activo_datos?: { grado: string | null; grupo: string | null };
};

// Respuesta breve para el docente cuando la sesión quedó sin grupo por
// la conversación; null si no aplica (sin grupo "normal").
export function mensajeGrupoNoDisponible(sesion: Pick<SesionContexto, 'grupo_no_disponible'> | null | undefined): string | null {
  switch (sesion?.grupo_no_disponible) {
    case 'grupo_fijado_no_valido':
      return 'Esta conversación pertenece a un grupo que ya no está disponible (por ejemplo, de un ciclo escolar que ya terminó), así que aquí no puedo consultar ni registrar datos de alumnos. Inicia una conversación nueva para trabajar con tu grupo actual.';
    case 'conversacion_no_autorizada':
      return 'No pude confirmar que esta conversación sea tuya, así que aquí no voy a usar datos de ningún grupo. Inicia una conversación nueva.';
    case 'error_vinculo':
      return 'No pude verificar a qué grupo pertenece esta conversación, así que no usé datos de ningún grupo. Intenta de nuevo en unos segundos.';
    default:
      return null;
  }
}

export async function obtenerSesionContexto(
  sb: SupabaseClient,
  docenteId: string,
  zonaHoraria?: string | null,
  // Grupo de la conversación del Chat (lib/vinculoConversacion.ts, leído
  // una sola vez por turno en /api/chat). Ausente = sin conversación.
  vinculo?: VinculoConversacion
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

  // Grupo de la sesión — único punto para todas las herramientas del Chat
  // (asistencia, planeación, aprobación, resolución de alumnos):
  // - Conversación con grupo fijado: ESE grupo, si sigue siendo del
  //   docente y de un ciclo activo; si no, sin grupo (nunca otro).
  // - Conversación no autorizada o error al leer el vínculo: sin grupo.
  // - Sin conversación, sin grupo fijado o antigua: el mismo grupo activo
  //   que Lista y Evaluación (lib/grupoActivo.ts: contexto revalidado y,
  //   si no es válido, el grupo más reciente del docente).
  if (vinculo?.estado === 'no_autorizada' || vinculo?.estado === 'error') {
    base.grupo_no_disponible = vinculo.estado === 'error' ? 'error_vinculo' : 'conversacion_no_autorizada';
    console.log(`[ASISTENCIA][chat] ts=${new Date().toISOString()} fecha=${base.fecha_actual} grupo=(ninguno) motivo=${base.grupo_no_disponible} origen=obtenerSesionContexto`);
    return base;
  }
  const resolucion = await resolverGrupoActivo(sb, docenteId, { grupoFijadoId: vinculo?.estado === 'con_grupo' ? vinculo.grupoId : null });
  if (!resolucion.ok) {
    if (vinculo?.estado === 'con_grupo') base.grupo_no_disponible = resolucion.motivo === 'error' ? 'error_vinculo' : 'grupo_fijado_no_valido';
    console.log(`[ASISTENCIA][chat] ts=${new Date().toISOString()} fecha=${base.fecha_actual} grupo=(ninguno) motivo=${base.grupo_no_disponible ?? resolucion.motivo} origen=obtenerSesionContexto — sin grupo activo para docente ${docenteId}`);
    return base;
  }
  const grupoActivo = resolucion.grupo;

  base.institucion_id = grupoActivo.institucion_id;
  base.ciclo_escolar_id = grupoActivo.ciclo_escolar_id;
  base.grupo_activo_id = grupoActivo.id;
  const rotulo = rotuloGrupo(grupoActivo);
  base.grupo_activo_grado = rotulo.grado;
  base.grupo_activo_letra = rotulo.letra;
  base.grupo_activo_datos = { grado: grupoActivo.grado, grupo: grupoActivo.grupo };

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
