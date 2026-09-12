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
  // Ver "Ilustraciones por nivel educativo, Fase 1" — nivel_educativo
  // y grado YA existían en la tabla grupos (capturados al crear el
  // grupo, ver app/dashboard/grupos/nuevo/page.tsx) pero nunca se
  // leían de vuelta hacia el Chat/generación de documentos. Fuente de
  // verdad real para resolverNivelEducativo (lib/documentGen/
  // nivelEducativo.ts) — nunca perfiles_docentes.grado, que solo
  // admite primaria.
  nivel_educativo_grupo: string | null;
  grado_grupo: string | null;
  grupo_letra: string | null;
  fecha_actual: string;
  alumnos_del_grupo_activo: AlumnoLigero[];
};

// MG-B2 (ver diseño aprobado "snapshot de grupo por conversación") —
// permite a los llamadores pedir explícitamente uno de dos
// comportamientos distintos del heurístico MG-A por defecto, sin
// ambigüedad entre ellos:
//
// - modo 'snapshot': la conversación ya tiene un grupo_id fijado por
//   fijar_grupo_conversacion (RPC). Se usa EXCLUSIVAMENTE ese grupo —
//   nunca docente_contexto_activo, nunca el fallback "más reciente",
//   nunca se exige ciclos_escolares.activo=true (el snapshot es una
//   identidad histórica permanente, no debe apagarse porque el ciclo
//   activo cambie después). Se revalida igualmente id+docente_id
//   contra `grupos` — nunca se confía en el valor sin releerlo.
//
// - modo 'fail_closed': la conversación es MG-B (version=1) pero su
//   snapshot todavía no pudo resolverse (RPC no ejecutada, sin
//   candidato, o ambiguo). Deliberadamente NO se consulta
//   docente_contexto_activo ni `grupos`: la sesión de ese turno debe
//   quedar sin grupo y sin roster, nunca aproximada a otro grupo.
//
// Omitir `opciones` (todos los llamadores existentes) preserva
// exactamente el comportamiento MG-A de siempre.
export type OpcionesSesionContexto =
  | { modo: 'snapshot'; grupoIdForzado: string }
  | { modo: 'fail_closed' };

export async function obtenerSesionContexto(
  sb: SupabaseClient,
  docenteId: string,
  zonaHoraria?: string | null,
  opciones?: OpcionesSesionContexto
): Promise<SesionContexto> {
  const base: SesionContexto = {
    docente_id: docenteId,
    institucion_id: null,
    ciclo_escolar_id: null,
    grupo_activo_id: null,
    nivel_educativo_grupo: null,
    grado_grupo: null,
    grupo_letra: null,
    // Zona horaria real del dispositivo del docente — nunca la del
    // servidor (Vercel corre en UTC, que puede ya ser "mañana" respecto
    // al día real del docente en cualquier zona de México).
    fecha_actual: fechaISOHoy(zonaHoraria),
    alumnos_del_grupo_activo: [],
  };

  // MODO FAIL-CLOSED (MG-B2) — ninguna consulta de grupo en absoluto,
  // nunca aproximar. Se retorna antes de tocar docente_contexto_activo
  // o grupos.
  if (opciones?.modo === 'fail_closed') {
    return base;
  }

  type GrupoActivoResuelto = { id: string; institucion_id: string | null; ciclo_escolar_id: string | null; creado_en: string; nivel_educativo: string | null; grado: string | null; grupo: string | null };

  let grupoActivo: GrupoActivoResuelto | undefined;

  if (opciones?.modo === 'snapshot') {
    // MODO SNAPSHOT (MG-B2) — exclusivamente el grupo ya fijado por la
    // RPC. Revalida id+docente_id contra `grupos` (nunca se confía en
    // el valor recibido sin releerlo); deliberadamente SIN el join de
    // ciclos_escolares.activo — ver razón arriba.
    const { data: grupoSnapshot } = await sb
      .from('grupos')
      .select('id, institucion_id, ciclo_escolar_id, creado_en, nivel_educativo, grado, grupo')
      .eq('id', opciones.grupoIdForzado)
      .eq('docente_id', docenteId)
      .maybeSingle();
    grupoActivo = grupoSnapshot as GrupoActivoResuelto | undefined;
  } else {
    // MODO NORMAL (MG-A, sin cambios) — ver "fuente de verdad del
    // grupo activo — auditoría multigrupo": antes esta función iba
    // directo a la heurística de "más reciente" (ver abajo). Ahora
    // intenta PRIMERO el contexto que el propio docente ya seleccionó
    // explícitamente (docente_contexto_activo.grupo_id) — pero ese
    // valor es una PREFERENCIA, nunca una autorización: se vuelve a
    // consultar `grupos` filtrando por ESE id Y por docente_id/ciclo
    // activo. Si esa segunda consulta no encuentra nada (grupo ajeno,
    // inexistente, o de un ciclo ya no activo — incluso si alguien
    // lograra alterar grupo_id hacia un uuid que no le pertenece), el
    // contexto se descarta por completo y se cae exactamente al
    // fallback de siempre, sin ninguna heurística nueva. grupos.activo
    // deliberadamente NUNCA se usa aquí (ver auditoría "semántica real
    // de grupos.activo": sin ningún uso operativo demostrado en todo
    // el proyecto, ni lectura ni escritura — usarlo introduciría un
    // criterio de origen desconocido).
    const { data: contextoPersistido } = await sb
      .from('docente_contexto_activo')
      .select('grupo_id')
      .eq('docente_id', docenteId)
      .maybeSingle();

    if (contextoPersistido?.grupo_id) {
      const { data: grupoValidado } = await sb
        .from('grupos')
        .select('id, institucion_id, ciclo_escolar_id, creado_en, nivel_educativo, grado, grupo, ciclos_escolares!inner(activo)')
        .eq('id', contextoPersistido.grupo_id)
        .eq('docente_id', docenteId)
        .eq('ciclos_escolares.activo', true)
        .maybeSingle();
      if (grupoValidado) grupoActivo = grupoValidado as GrupoActivoResuelto;
    }

    // Fallback — CAUSA RAÍZ real de "el Chat IA dice que no tiene
    // acceso" en cualquier módulo (no solo asistencia), ya documentada
    // aquí desde antes de MG-A: heurística "más reciente con ciclo
    // activo", idéntica a la que ya usa app/dashboard/lista/page.tsx.
    // Ahora solo se ejecuta cuando el contexto persistido de arriba no
    // produjo un grupo válido (ausente, grupo_id null, grupo ajeno,
    // inexistente, o ciclo no activo) — sin cambios respecto al
    // comportamiento previo a MG-A en ese caso.
    if (!grupoActivo) {
      const { data: grupos } = await sb
        .from('grupos')
        .select('id, institucion_id, ciclo_escolar_id, creado_en, nivel_educativo, grado, grupo, ciclos_escolares!inner(activo)')
        .eq('docente_id', docenteId)
        .eq('ciclos_escolares.activo', true)
        .order('creado_en', { ascending: false })
        .limit(1);
      grupoActivo = grupos?.[0] as GrupoActivoResuelto | undefined;
    }
  }

  if (!grupoActivo) {
    console.log(`[ASISTENCIA][chat] ts=${new Date().toISOString()} fecha=${base.fecha_actual} grupo=(ninguno) origen=obtenerSesionContexto — sin grupo activo para docente ${docenteId}`);
    return base;
  }

  base.institucion_id = grupoActivo.institucion_id;
  base.ciclo_escolar_id = grupoActivo.ciclo_escolar_id;
  base.grupo_activo_id = grupoActivo.id;
  base.nivel_educativo_grupo = grupoActivo.nivel_educativo;
  base.grado_grupo = grupoActivo.grado;
  base.grupo_letra = grupoActivo.grupo;

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
