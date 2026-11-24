-- Identidad e idempotencia de la aprobación de planeaciones (Hito 1).
--
-- Problema: la aprobación reconocía una planeación por docente + grupo +
-- nombre + fechas. Dos borradores independientes con el mismo nombre y
-- fechas se confundían ("Esta planeación ya está guardada"), y dos
-- solicitudes simultáneas del mismo borrador podían duplicar filas.
--
-- Solución (solo estructura; ningún registro existente cambia):
--   planeaciones.borrador_clave       — identidad del BORRADOR que originó
--     la planeación: "msg:<id persistido del mensaje>" (mensajes_chat.id,
--     validado por RLS y por su conversación). Nunca el texto: dos
--     borradores idénticos son dos mensajes distintos. Única por docente:
--     una aprobación concurrente o repetida del mismo borrador encuentra
--     la fila en vez de crear otra.
--   planeaciones.aprobacion_token / aprobacion_expira_en — concesión
--     (lease) de la aprobación en curso, adquirida con una actualización
--     condicional atómica; si el proceso se interrumpe, la concesión
--     vence y otra solicitud reanuda la aprobación desde donde quedó.
--   public.consolidar_aprobacion_planeacion(planeación, token, evaluación,
--     historial) — ÚNICA vía para consolidar resultados de una aprobación
--     en curso. En UNA transacción: renueva la concesión SOLO si el token
--     sigue siendo el del llamador (la fila queda bloqueada hasta el fin:
--     nadie puede tomar la concesión entre la comprobación y la escritura),
--     escribe la evaluación del proyecto y, si se pide, el registro de
--     Historial. Una ejecución que perdió la concesión recibe false y no
--     escribe nada. SECURITY INVOKER: RLS del docente; Historial siempre a
--     nombre de auth.uid().
--   Unicidad de los hijos: un proyecto por (planeación, orden), un
--   proyecto de seguimiento por proyecto de planeación y un registro de
--   Historial por archivo original — cada fase es idempotente.
-- Compatibilidad con el Hito 2 (versiones): la clave identifica al
-- borrador que creó la planeación, no a la planeación; varias versiones
-- de una planeación podrán vivir en otra tabla sin tocar estas reglas.
-- Las filas anteriores quedan con borrador_clave NULL y no participan.
--
-- Permisos y RLS: sin cambios (las políticas existentes por docente
-- cubren las columnas nuevas).
--
-- REVERSIÓN (no toca datos previos):
--   drop function public.consolidar_aprobacion_planeacion(uuid, uuid, jsonb, jsonb);
--   drop index public.documentos_generados_archivo_unico;
--   drop index public.proyectos_seguimiento_planeacion_proyecto_unico;
--   drop index public.planeacion_proyectos_planeacion_orden_unico;
--   drop index public.planeaciones_docente_borrador_unico;
--   alter table public.planeaciones drop column aprobacion_expira_en,
--     drop column aprobacion_token, drop column borrador_clave;

begin;

-- ============================================================
-- PRECONDICIONES
-- ============================================================
do $$
begin
  if to_regclass('public.planeaciones') is null or to_regclass('public.planeacion_proyectos') is null
     or to_regclass('public.proyectos_seguimiento') is null or to_regclass('public.documentos_generados') is null then
    raise exception 'PRECONDICION_FALLIDA: faltan tablas esperadas.';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'planeaciones'
              and column_name in ('borrador_clave', 'aprobacion_token', 'aprobacion_expira_en')) then
    raise exception 'PRECONDICION_FALLIDA: alguna columna nueva ya existe.';
  end if;
  if to_regclass('public.planeaciones_docente_borrador_unico') is not null or to_regclass('public.planeacion_proyectos_planeacion_orden_unico') is not null
     or to_regclass('public.proyectos_seguimiento_planeacion_proyecto_unico') is not null or to_regclass('public.documentos_generados_archivo_unico') is not null
     or to_regprocedure('public.consolidar_aprobacion_planeacion(uuid, uuid, jsonb, jsonb)') is not null then
    raise exception 'PRECONDICION_FALLIDA: algún índice nuevo ya existe.';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'proyectos_seguimiento' and column_name = 'planeacion_proyecto_id') is not true
     or exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'documentos_generados' and column_name = 'archivo_id') is not true
     or exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'planeacion_proyectos' and column_name = 'orden') is not true
     or (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'planeacion_proyectos' and column_name in ('evaluacion', 'actualizado_en')) <> 2
     or (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'documentos_generados'
          and column_name in ('user_id', 'tipo', 'titulo', 'contenido', 'campo_formativo', 'grado', 'grupo', 'origen', 'archivo_id', 'archivo_formato')) <> 10
     or to_regprocedure('auth.uid()') is null then
    raise exception 'PRECONDICION_FALLIDA: faltan columnas de las que dependen los índices.';
  end if;
  -- Los datos existentes deben cumplir ya las nuevas reglas de unicidad.
  if exists (select 1 from public.planeacion_proyectos group by planeacion_id, orden having count(*) > 1)
     or exists (select 1 from public.proyectos_seguimiento where planeacion_proyecto_id is not null group by planeacion_proyecto_id having count(*) > 1)
     or exists (select 1 from public.documentos_generados where archivo_id is not null group by archivo_id having count(*) > 1) then
    raise exception 'PRECONDICION_FALLIDA: hay registros duplicados que impedirían los índices únicos.';
  end if;
end;
$$;

create temporary table _antes on commit drop as
  select (select count(*) from public.planeaciones) as planeaciones,
         (select count(*) from public.planeacion_proyectos) as proyectos,
         (select count(*) from public.proyectos_seguimiento) as seguimientos,
         (select count(*) from public.documentos_generados) as documentos;

-- ============================================================
-- 1. Identidad del borrador y concesión de la aprobación
-- ============================================================
alter table public.planeaciones
  add column borrador_clave text null
    constraint planeaciones_borrador_clave_formato check (borrador_clave ~ '^msg:.+$' and char_length(borrador_clave) <= 300),
  add column aprobacion_token uuid null,
  add column aprobacion_expira_en timestamptz null,
  add constraint planeaciones_aprobacion_concesion_completa check ((aprobacion_token is null) = (aprobacion_expira_en is null));

create unique index planeaciones_docente_borrador_unico
  on public.planeaciones (docente_id, borrador_clave) where borrador_clave is not null;

-- ============================================================
-- 2. Unicidad de los registros que crea la aprobación
-- ============================================================
create unique index planeacion_proyectos_planeacion_orden_unico
  on public.planeacion_proyectos (planeacion_id, orden);
create unique index proyectos_seguimiento_planeacion_proyecto_unico
  on public.proyectos_seguimiento (planeacion_proyecto_id) where planeacion_proyecto_id is not null;
create unique index documentos_generados_archivo_unico
  on public.documentos_generados (archivo_id) where archivo_id is not null;

-- ============================================================
-- 3. Consolidación protegida por la concesión (atómica)
-- ============================================================
create function public.consolidar_aprobacion_planeacion(
  p_planeacion_id uuid,
  p_token uuid,
  p_evaluacion jsonb,
  p_historial jsonb default null
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- Comprobar y renovar la concesión bloquea la fila hasta el final de la
  -- transacción: ninguna otra solicitud la adquiere mientras se escribe.
  update public.planeaciones
     set aprobacion_expira_en = now() + interval '2 minutes'
   where id = p_planeacion_id and version = 0 and aprobacion_token = p_token;
  if not found then
    return false;
  end if;
  update public.planeacion_proyectos
     set evaluacion = p_evaluacion, actualizado_en = now()
   where planeacion_id = p_planeacion_id;
  if p_historial is not null then
    insert into public.documentos_generados (user_id, tipo, titulo, contenido, campo_formativo, grado, grupo, origen, archivo_id, archivo_formato)
    select auth.uid(), r.tipo, r.titulo, r.contenido, r.campo_formativo, r.grado, r.grupo, r.origen, r.archivo_id, r.archivo_formato
      from jsonb_populate_record(null::public.documentos_generados, p_historial) as r
    on conflict (archivo_id) where archivo_id is not null do nothing;
  end if;
  return true;
end;
$$;
revoke all on function public.consolidar_aprobacion_planeacion(uuid, uuid, jsonb, jsonb) from public, anon;
grant execute on function public.consolidar_aprobacion_planeacion(uuid, uuid, jsonb, jsonb) to authenticated;

-- ============================================================
-- POSCONDICIONES
-- ============================================================
do $$
begin
  if (select string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' order by column_name)
        from information_schema.columns where table_schema = 'public' and table_name = 'planeaciones'
         and column_name in ('borrador_clave', 'aprobacion_token', 'aprobacion_expira_en'))
     is distinct from 'aprobacion_expira_en:timestamp with time zone:YES,aprobacion_token:uuid:YES,borrador_clave:text:YES' then
    raise exception 'POSCONDICION_FALLIDA: columnas nuevas distintas de lo esperado.';
  end if;
  if (select count(*) from pg_catalog.pg_indexes where schemaname = 'public' and indexname in (
        'planeaciones_docente_borrador_unico', 'planeacion_proyectos_planeacion_orden_unico',
        'proyectos_seguimiento_planeacion_proyecto_unico', 'documentos_generados_archivo_unico')
        and indexdef ilike 'create unique index%') <> 4 then
    raise exception 'POSCONDICION_FALLIDA: faltan índices únicos.';
  end if;
  if not exists (select 1 from pg_catalog.pg_proc where oid = to_regprocedure('public.consolidar_aprobacion_planeacion(uuid, uuid, jsonb, jsonb)') and not prosecdef)
     or has_function_privilege('anon', 'public.consolidar_aprobacion_planeacion(uuid, uuid, jsonb, jsonb)', 'execute')
     or not has_function_privilege('authenticated', 'public.consolidar_aprobacion_planeacion(uuid, uuid, jsonb, jsonb)', 'execute') then
    raise exception 'POSCONDICION_FALLIDA: función de consolidación ausente, con SECURITY DEFINER o con permisos distintos de lo esperado.';
  end if;
  if (select count(*) from public.planeaciones) <> (select planeaciones from _antes)
     or (select count(*) from public.planeacion_proyectos) <> (select proyectos from _antes)
     or (select count(*) from public.proyectos_seguimiento) <> (select seguimientos from _antes)
     or (select count(*) from public.documentos_generados) <> (select documentos from _antes)
     or exists (select 1 from public.planeaciones where borrador_clave is not null or aprobacion_token is not null or aprobacion_expira_en is not null) then
    raise exception 'POSCONDICION_FALLIDA: cambiaron registros existentes.';
  end if;
end;
$$;

commit;
