-- PA-4C — corrección de un hallazgo real: CREATE OR REPLACE FUNCTION
-- con un parámetro nuevo (aunque tenga DEFAULT) NO reemplaza la
-- función existente en PostgreSQL — la identidad de una función la
-- determina la lista de tipos de sus argumentos, y agregar un
-- argumento cambia esa lista. La migración anterior
-- (20260923010000) terminó creando un SEGUNDO overload
-- (programa_analitico_publicar de 8 argumentos) en vez de reemplazar
-- el de 7 — confirmado leyendo pg_proc tras aplicarla: ambas firmas
-- coexistían. Se elimina la firma vieja de 7 argumentos, dejando una
-- única función real (8 argumentos, p_borrador_id con default null).
--
-- Mismo hallazgo de PA-3A se repite: crear una función nueva dispara
-- pg_default_acl, que vuelve a otorgar EXECUTE a anon/service_role de
-- forma explícita (confirmado con has_function_privilege tras aplicar
-- la migración anterior). Se revoca de nuevo, igual que en PA-3A.
begin;

drop function if exists public.programa_analitico_publicar(uuid, text, uuid, uuid, uuid, text, jsonb);

revoke execute on function public.programa_analitico_publicar(uuid, text, uuid, uuid, uuid, text, jsonb, uuid) from anon;
revoke execute on function public.programa_analitico_publicar(uuid, text, uuid, uuid, uuid, text, jsonb, uuid) from service_role;

commit;
