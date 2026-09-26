-- Baja académica individual de UNA inscripción vigente — "Dar de baja
-- del grupo" en la ficha individual (app/dashboard/lista/[alumnoId]/
-- page.tsx), semánticamente distinta de "Eliminar alumno"
-- (eliminar_alumno_definitivamente, migración 20260913000000): esta
-- operación NUNCA borra nada. Solo transiciona
-- inscripciones.estatus de 'activo' a 'baja' y fija fecha_baja=now(),
-- preservando intactos alumnos, la propia fila de inscripciones y
-- todo el historial real (asistencias, asistencia_registro,
-- incidencias, evaluaciones, evidencias, fichas_descriptivas,
-- necesidades_apoyo, correcciones_alumno, seguimiento_resultados,
-- seguimiento_versiones) — ninguna de esas tablas se toca aquí.
--
-- Origen (ver auditoría READ-ONLY "flujo real de baja/eliminación de
-- alumnos" — caso real: Renata, grupo 4°B): eliminar_alumno_
-- definitivamente es un DELETE físico, deliberadamente bloqueado si
-- el alumno tiene cualquier historial real o más de 1 inscripción
-- total — por diseño, NUNCA puede usarse como "baja" para un alumno
-- con trayectoria académica real. darDeBajaGrupoCompleto (lib/
-- motorContexto.ts) ya hace un UPDATE estatus='baja' correcto, pero
-- solo a nivel de TODO el grupo, vía un .update() directo del cliente
-- que además nunca tuvo una policy RLS de UPDATE que lo respalde
-- (inscripciones solo tiene una policy de SELECT — ver esa misma
-- auditoría) — queda fuera de esta migración, sin modificarse.
--
-- Mismo motivo estructural que importar_alumnos_a_grupo
-- (20260912200000): `inscripciones` NO tiene, deliberadamente,
-- ninguna policy RLS de escritura — esta función SECURITY DEFINER es
-- el único camino de baja individual, exactamente como esa migración
-- ya dejó a la importación como el único camino de alta. No se crea
-- ninguna policy UPDATE nueva sobre inscripciones.
--
-- Ownership: se verifica que el GRUPO de la inscripción pertenece
-- real y directamente al docente que llama (grupos.docente_id =
-- auth.uid()) — mismo criterio que importar_alumnos_a_grupo. Grupos
-- compartidos (docente_grupos) quedan fuera de esta fase, igual que
-- en esa migración — nunca se acepta un docente_id que mande el
-- cliente.
--
-- Fail-closed (las 3 condiciones deben cumplirse TODAS):
--   1. auth.uid() no nulo.
--   2. La inscripción existe Y su grupo pertenece al docente que
--      llama.
--   3. La inscripción está actualmente 'activo' — nunca se
--      re-procesa una baja ya hecha. El UPDATE final filtra por el
--      MISMO id ya validado/bloqueado arriba, así que nunca puede
--      afectar otra inscripción (ni histórica del mismo alumno, ni de
--      otro grupo/ciclo).
--
-- fecha_baja se fija con now() dentro de la función — nunca se acepta
-- como parámetro del cliente (un timestamp de auditoría no debe
-- poder falsificarse desde el navegador).
--
-- Concurrencia: mismo patrón que eliminar_alumno_definitivamente —
-- SELECT ... FOR UPDATE OF antes de cualquier UPDATE, nunca un SELECT
-- sin lock seguido de una escritura aparte.
--
-- Fail-closed deliberado (no idempotente): CREATE FUNCTION sin
-- CREATE OR REPLACE — si la función ya existiera por un drift de
-- esquema no auditado, esta migración debe fallar explícitamente en
-- vez de sobrescribir silenciosamente una definición no revisada.

create function public.dar_de_baja_inscripcion(p_inscripcion_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_docente_id uuid := auth.uid();
  v_estatus text;
begin
  if v_docente_id is null then
    raise exception 'No autenticado.';
  end if;

  if p_inscripcion_id is null then
    raise exception 'Falta la inscripción.';
  end if;

  select i.estatus into v_estatus
  from public.inscripciones i
  join public.grupos g on g.id = i.grupo_id
  where i.id = p_inscripcion_id
    and g.docente_id = v_docente_id
  for update of i;

  if not found then
    raise exception 'Inscripción no encontrada o no autorizada.';
  end if;

  if v_estatus <> 'activo' then
    raise exception 'Esta inscripción ya no está activa.';
  end if;

  update public.inscripciones
  set estatus = 'baja', fecha_baja = now()
  where id = p_inscripcion_id;
end;
$$;

-- Privilegios — mismo hardening ya aplicado en eliminar_alumno_
-- definitivamente/importar_alumnos_a_grupo: PostgreSQL concede EXECUTE
-- sobre funciones nuevas a PUBLIC por defecto, y este proyecto además
-- tiene una regla ALTER DEFAULT PRIVILEGES a nivel del esquema public
-- que concede EXECUTE directo a anon/authenticated (no vía PUBLIC) —
-- por eso se revocan ambos caminos explícitamente en esta misma
-- migración.
revoke execute on function public.dar_de_baja_inscripcion(uuid) from public;
revoke execute on function public.dar_de_baja_inscripcion(uuid) from anon;
grant execute on function public.dar_de_baja_inscripcion(uuid) to authenticated;
