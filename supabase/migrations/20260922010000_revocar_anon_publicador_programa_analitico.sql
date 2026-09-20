-- PA-3A — corrección: el REVOKE de la migración anterior
-- (20260922000000) fue `revoke all ... from public`, pero
-- pg_default_acl del schema public otorga EXECUTE a anon/authenticated/
-- service_role de forma EXPLÍCITA por rol (no vía PUBLIC) a cada
-- función nueva — confirmado leyendo pg_default_acl y el proacl real
-- de la función tras aplicar esa migración (anon seguía con EXECUTE).
-- Revocar de PUBLIC no quita un grant explícito ya otorgado a un rol
-- nombrado. Se revoca aquí explícitamente de `anon`.
begin;

revoke execute on function public.programa_analitico_publicar(uuid, text, uuid, uuid, uuid, text, jsonb) from anon;

commit;
