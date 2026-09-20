-- PA-4C — segunda corrección de grants sobre la misma función. El
-- proacl real tras 20260923020000 mostraba `{=X/postgres,
-- postgres=X/postgres, authenticated=X/postgres}` — el `=X` (sin
-- nombre de rol antes del signo igual) es PUBLIC, y todo rol
-- (incluidos anon/service_role) pertenece implícitamente a PUBLIC, así
-- que heredaban EXECUTE de ahí, no de un grant individual (por eso el
-- revoke puntual a anon/service_role de la migración anterior no tuvo
-- efecto real — confirmado con has_function_privilege). La migración
-- 20260923010000 (el CREATE OR REPLACE con el nuevo parámetro) nunca
-- incluyó el `revoke ... from public` que sí tenía la migración
-- original de PA-3A (20260922000000) — se corrige aquí, replicando
-- exactamente ese mismo patrón.
begin;

revoke all on function public.programa_analitico_publicar(uuid, text, uuid, uuid, uuid, text, jsonb, uuid) from public;
grant execute on function public.programa_analitico_publicar(uuid, text, uuid, uuid, uuid, text, jsonb, uuid) to authenticated;

commit;
