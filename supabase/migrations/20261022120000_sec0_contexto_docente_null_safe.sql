-- SEC-0 — contexto_docente: validación de identidad segura ante NULL.
--
-- Causa: la guarda anterior era `if p_docente_id <> auth.uid() then raise`.
-- Sin sesión, auth.uid() es NULL y `p_docente_id <> NULL` evalúa a NULL
-- (no a true), así que la excepción nunca se lanzaba y la función —que es
-- SECURITY DEFINER y por tanto omite RLS— devolvía perfil, resumen de
-- preferencias y grupos de cualquier p_docente_id. Además PUBLIC y anon
-- tenían EXECUTE, por lo que bastaba la clave pública para invocarla.
--
-- Corrección mínima:
--   1. Rechazar explícitamente si no hay sesión, si p_docente_id es NULL o si
--      no coincide estrictamente con el usuario autenticado (IS DISTINCT FROM).
--      SQLSTATE 42501 (insufficient_privilege): el rechazo no devuelve datos.
--   2. search_path fijo, como corresponde a una función SECURITY DEFINER.
--   3. Retirar EXECUTE a PUBLIC y anon; conservarlo solo para authenticated
--      (wrapper contextoDocente en lib/motorContexto.ts, que llama sin
--      argumentos y usa el valor predeterminado auth.uid()) y service_role.
--
-- El cuerpo de la consulta no cambia.

create or replace function public.contexto_docente(p_docente_id uuid default auth.uid())
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_result jsonb;
  v_uid uuid := auth.uid();
begin
  if v_uid is null or p_docente_id is null or p_docente_id is distinct from v_uid then
    raise exception 'Solo puedes consultar tu propio contexto de docente'
      using errcode = '42501';
  end if;

  select jsonb_build_object(
    'perfil', (select to_jsonb(pd) from perfiles_docentes pd where pd.id = p_docente_id),
    'preferencias_resumen', (select resumen from docente_preferencias_resumen where docente_id = p_docente_id),
    'grupos_activos', (select coalesce(jsonb_agg(to_jsonb(dg)), '[]'::jsonb) from docente_grupos dg where dg.docente_id = p_docente_id)
  ) into v_result;

  return v_result;
end;
$function$;

revoke all on function public.contexto_docente(uuid) from public, anon;
grant execute on function public.contexto_docente(uuid) to authenticated, service_role;
