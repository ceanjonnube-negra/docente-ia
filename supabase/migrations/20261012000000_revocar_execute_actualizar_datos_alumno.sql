-- Seguridad — reducir la superficie de exposición de
-- public.actualizar_datos_alumno(uuid, text, text, text, date).
--
-- HALLAZGO (auditoría aprobada): la función es SECURITY DEFINER, sin
-- search_path fijo, con EXECUTE para PUBLIC, anon, authenticated y
-- service_role, y autoriza vía `docente_grupos` (no vía
-- alumnos.docente_id). Permite cambiar nombre/CURP/sexo/fecha de
-- nacimiento sin cotejo de CURP duplicada ni bloqueo por CURP. No está
-- versionada en ninguna migración anterior (creada desde el dashboard).
--
-- DECISIÓN APROBADA: como NO tiene consumidores activos, se reduce su
-- exposición en lugar de reescribirla:
--   - Su envoltura TS `actualizarDatosAlumno` (lib/motorContexto.ts) no
--     se importa en ningún archivo de ninguna rama ni de la historia.
--   - 0 funciones, vistas, policies o triggers la referencian.
--   - pg_stat_statements no registra ninguna ejecución desde su último
--     reinicio de estadísticas (solo la sentencia DDL que la creó).
--   - Los flujos reales de edición de alumnos usan otros mecanismos:
--     UPDATE directo bajo RLS (app/dashboard/lista/[alumnoId]/page.tsx,
--     lib/motorContexto.ts), reparar_curp_desde_lista_oficial,
--     importar_alumnos_a_grupo y eliminar_alumno_definitivamente.
--
-- QUÉ HACE (atómica: BEGIN … COMMIT):
--   a. Precondición: aborta si la función no existe con la firma exacta
--      o si su definición cambió respecto de la auditada (md5 de
--      pg_get_functiondef) — nunca se revocan permisos sobre una versión
--      no revisada.
--   b. REVOKE EXECUTE para PUBLIC, anon y authenticated.
--
-- QUÉ NO HACE: no modifica el cuerpo, la firma, el propietario ni el
-- SECURITY DEFINER de la función; no toca tablas, policies RLS ni datos;
-- no otorga ningún permiso. postgres (propietario) y service_role
-- conservan EXECUTE como vía administrativa.
--
-- EFECTO EN LA ENVOLTURA TS: si en el futuro alguien llamara a
-- actualizarDatosAlumno con la sesión de un docente, recibiría
-- "permission denied" (42501) — fail-closed. Reabrir esta RPC exige
-- antes su endurecimiento (propiedad por alumnos.docente_id,
-- search_path fijo, cotejo de CURP), ya auditado.
--
-- ROLLBACK (si hiciera falta):
--   grant execute on function public.actualizar_datos_alumno(uuid, text, text, text, date)
--     to public, anon, authenticated;

begin;

do $$
begin
  if to_regprocedure('public.actualizar_datos_alumno(uuid, text, text, text, date)') is null then
    raise exception 'PRECONDICION_FALLIDA: no existe public.actualizar_datos_alumno(uuid, text, text, text, date).';
  end if;

  if md5(pg_catalog.pg_get_functiondef('public.actualizar_datos_alumno(uuid, text, text, text, date)'::regprocedure))
     <> '7c0ce1f39e62fdf91ec875d5a1ab5d6f' then
    raise exception 'PRECONDICION_FALLIDA: la definición de actualizar_datos_alumno cambió respecto de la auditada; revisar antes de continuar.';
  end if;
end;
$$;

revoke execute on function public.actualizar_datos_alumno(uuid, text, text, text, date) from public;
revoke execute on function public.actualizar_datos_alumno(uuid, text, text, text, date) from anon;
revoke execute on function public.actualizar_datos_alumno(uuid, text, text, text, date) from authenticated;

commit;
