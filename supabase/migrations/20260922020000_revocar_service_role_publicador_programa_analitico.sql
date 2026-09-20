-- PA-3A — cumplimiento estricto de "EXECUTE solo para authenticated":
-- el mismo default ACL de pg_default_acl (ver migración
-- 20260922010000) también otorgó EXECUTE a `service_role` de forma
-- explícita. Esta función nunca debe ejecutarse como service_role
-- (depende de auth.uid(), que no existe bajo ese rol) — se revoca por
-- privilegio mínimo, no porque se haya detectado un uso real.
begin;

revoke execute on function public.programa_analitico_publicar(uuid, text, uuid, uuid, uuid, text, jsonb) from service_role;

commit;
