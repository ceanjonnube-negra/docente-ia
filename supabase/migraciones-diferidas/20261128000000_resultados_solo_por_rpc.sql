-- MIGRACIÓN DIFERIDA — paso OBLIGATORIO del despliegue seguro del Hito 2,
-- etapa 3. NO se aplica junto con 20261127000000_hojas_por_version.sql.
--
-- Orden en cada entorno (E2E y después Production):
--   1. Aplicar 20261127000000_hojas_por_version.sql (compatible con el
--      código anterior: la escritura directa sigue permitida).
--   2. Publicar el código que confirma resultados con
--      confirmar_resultados_hoja (rutas de captura condicionadas a la hoja).
--   3. Verificar que ese código está activo en el entorno.
--   4. Aplicar ESTA migración: cierra la escritura directa de resultados.
-- Aplicarla antes del paso 2 rompería la confirmación del código anterior
-- (escribe seguimiento_resultados por REST).
--
-- Efecto:
--   - authenticated/anon ya no pueden insertar, actualizar ni borrar
--     seguimiento_resultados directamente (se retiran sus políticas de
--     escritura y los privilegios). Lectura: sin cambios (RLS por docente).
--   - confirmar_resultados_hoja pasa a SECURITY DEFINER para poder escribir,
--     con search_path vacío y EXECUTE solo para authenticated: sigue
--     verificando en el servidor el docente (auth.uid()) y su grupo, el
--     proyecto bloqueado, la hoja vigente, el estado y todos los datos.
--
-- REVERSIÓN:
--   alter function public.confirmar_resultados_hoja(uuid, uuid, jsonb) security invoker;
--   grant insert, update on public.seguimiento_resultados to authenticated;
--   (recrear las políticas seguimiento_resultados_insert y _update tal como
--    estaban: EXISTS proyecto del docente, auth.uid())

begin;

do $$
begin
  if to_regprocedure('public.confirmar_resultados_hoja(uuid, uuid, jsonb)') is null
     or (select prosecdef from pg_proc where oid = to_regprocedure('public.confirmar_resultados_hoja(uuid, uuid, jsonb)')) then
    raise exception 'PRECONDICION_FALLIDA: falta 20261127000000_hojas_por_version o esta migración ya se aplicó.';
  end if;
end;
$$;

create temporary table _antes on commit drop as
  select (select md5(coalesce(string_agg(r::text, '|' order by r.id), '')) from public.seguimiento_resultados r) as resultados;

drop policy if exists seguimiento_resultados_insert on public.seguimiento_resultados;
drop policy if exists seguimiento_resultados_update on public.seguimiento_resultados;
drop policy if exists seguimiento_resultados_delete on public.seguimiento_resultados;
revoke insert, update, delete, truncate on public.seguimiento_resultados from anon, authenticated;

alter function public.confirmar_resultados_hoja(uuid, uuid, jsonb) security definer;
revoke all on function public.confirmar_resultados_hoja(uuid, uuid, jsonb) from public, anon, service_role;
grant execute on function public.confirmar_resultados_hoja(uuid, uuid, jsonb) to authenticated;

do $$
begin
  if (select md5(coalesce(string_agg(r::text, '|' order by r.id), '')) from public.seguimiento_resultados r) is distinct from (select resultados from _antes) then
    raise exception 'POSCONDICION_FALLIDA: cambiaron resultados existentes.';
  end if;
  if has_table_privilege('authenticated', 'public.seguimiento_resultados', 'insert, update, delete, truncate')
     or has_table_privilege('anon', 'public.seguimiento_resultados', 'insert, update, delete, truncate')
     or exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'seguimiento_resultados' and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL'))
     or not has_table_privilege('authenticated', 'public.seguimiento_resultados', 'select')
     or not (select prosecdef from pg_proc where oid = to_regprocedure('public.confirmar_resultados_hoja(uuid, uuid, jsonb)'))
     or not has_function_privilege('authenticated', 'public.confirmar_resultados_hoja(uuid, uuid, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.confirmar_resultados_hoja(uuid, uuid, jsonb)', 'execute')
     or has_function_privilege('service_role', 'public.confirmar_resultados_hoja(uuid, uuid, jsonb)', 'execute')
     or (select array_to_string(proconfig, ',') from pg_proc where oid = to_regprocedure('public.confirmar_resultados_hoja(uuid, uuid, jsonb)')) is distinct from 'search_path=""' then
    raise exception 'POSCONDICION_FALLIDA: permisos distintos de lo esperado.';
  end if;
end;
$$;

commit;
