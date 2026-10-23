-- SEC-1A — permisos de invocación de cuatro funciones SECURITY DEFINER.
--
-- Causa: consultar_asistencia_alumno, contexto_alumno, contexto_grupo y
-- registrar_asistencia_masiva conservaban el EXECUTE que PostgreSQL concede a
-- PUBLIC y el que los privilegios predeterminados de Supabase conceden a anon,
-- y no fijaban search_path pese a ser SECURITY DEFINER con tablas sin calificar.
-- Sus guardas ya rechazan llamadas sin sesión (auth.uid() NULL nunca satisface
-- el EXISTS sobre docente_grupos), pero no deben ser invocables con la clave
-- pública.
--
-- Corrección mínima:
--   1. search_path fijo, como corresponde a una función SECURITY DEFINER.
--   2. Retirar EXECUTE a PUBLIC y anon; conservarlo para authenticated
--      (wrappers contextoAlumno, contextoGrupo, registrarAsistenciaMasiva y
--      consultarAsistenciaAlumno en lib/motorContexto.ts, todos con el cliente
--      del docente) y service_role.
--
-- Los cuerpos, firmas y resultados no cambian. contexto_alumno invoca
-- consultar_asistencia_alumno como su dueño (postgres), que conserva EXECUTE.
-- El alcance de los datos entre grupos y docentes se corregirá aparte.

alter function public.consultar_asistencia_alumno(uuid, uuid) set search_path = public, pg_temp;
alter function public.contexto_alumno(uuid, uuid) set search_path = public, pg_temp;
alter function public.contexto_grupo(uuid) set search_path = public, pg_temp;
alter function public.registrar_asistencia_masiva(uuid, date, jsonb) set search_path = public, pg_temp;

revoke all on function public.consultar_asistencia_alumno(uuid, uuid) from public, anon;
revoke all on function public.contexto_alumno(uuid, uuid) from public, anon;
revoke all on function public.contexto_grupo(uuid) from public, anon;
revoke all on function public.registrar_asistencia_masiva(uuid, date, jsonb) from public, anon;

grant execute on function public.consultar_asistencia_alumno(uuid, uuid) to authenticated, service_role;
grant execute on function public.contexto_alumno(uuid, uuid) to authenticated, service_role;
grant execute on function public.contexto_grupo(uuid) to authenticated, service_role;
grant execute on function public.registrar_asistencia_masiva(uuid, date, jsonb) to authenticated, service_role;
