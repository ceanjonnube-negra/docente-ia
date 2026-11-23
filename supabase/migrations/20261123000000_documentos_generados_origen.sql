-- Historial de documentos — origen de cada documento NUEVO en
-- documentos_generados, para reconocerlo sin depender del prefijo del
-- título. Solo agrega una columna: no modifica ni reclasifica ningún
-- registro existente.
--
-- origen:
--   'archivo' — documento nuevo entregado como archivo, reconocido por los
--               metadatos de entrega del servidor ([[DOCUMENTO_ARCHIVO]] +
--               [[DOCUMENTO_CONTENIDO]]).
--   'texto'   — documento formal entregado como respuesta textual.
--   NULL      — registro anterior a esta migración (o de un cliente sin
--               actualizar): solo es documento si su contenido tiene el
--               prefijo canónico (esDocumentoFormal).
--
-- Permisos: sin cambios. La columna hereda los permisos de tabla actuales
-- de authenticated (el cliente del docente la escribe al guardar) y la
-- política "Cada docente ve sus documentos" sigue igual.
--
-- REVERSIÓN (no toca datos previos):
--   alter table public.documentos_generados drop column origen;

begin;

-- ============================================================
-- PRECONDICIONES
-- ============================================================
do $$
begin
  if to_regclass('public.documentos_generados') is null then
    raise exception 'PRECONDICION_FALLIDA: no existe documentos_generados.';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'documentos_generados' and column_name = 'origen') then
    raise exception 'PRECONDICION_FALLIDA: documentos_generados.origen ya existe.';
  end if;
  if (select count(*) from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'documentos_generados') <> 1
     or not exists (select 1 from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'documentos_generados'
                     and policyname = 'Cada docente ve sus documentos' and cmd = 'ALL') then
    raise exception 'PRECONDICION_FALLIDA: las políticas de documentos_generados difieren de las esperadas.';
  end if;
end;
$$;

-- Conteo y privilegios para comprobar al final que no cambiaron.
create temporary table _antes on commit drop as
  select (select count(*) from public.documentos_generados) as filas,
         has_table_privilege('anon', 'public.documentos_generados', 'select, insert, update, delete') as anon_tabla,
         has_table_privilege('authenticated', 'public.documentos_generados', 'select') as auth_select,
         has_table_privilege('authenticated', 'public.documentos_generados', 'insert') as auth_insert,
         has_table_privilege('authenticated', 'public.documentos_generados', 'update') as auth_update,
         has_table_privilege('authenticated', 'public.documentos_generados', 'delete') as auth_delete;

-- ============================================================
-- 1. Columna origen (nula para todo lo existente)
-- ============================================================
alter table public.documentos_generados
  add column origen text null
  constraint documentos_generados_origen_check check (origen in ('archivo', 'texto'));

-- ============================================================
-- POSCONDICIONES
-- ============================================================
do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'documentos_generados' and column_name = 'origen'
                    and data_type = 'text' and is_nullable = 'YES' and column_default is null) then
    raise exception 'POSCONDICION_FALLIDA: origen no quedó como text nulo sin valor por defecto.';
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint c
                  where c.conrelid = 'public.documentos_generados'::regclass and c.contype = 'c'
                    and c.conname = 'documentos_generados_origen_check'
                    and c.conkey = array[(select attnum from pg_catalog.pg_attribute
                                           where attrelid = 'public.documentos_generados'::regclass and attname = 'origen')]::int2[]) then
    raise exception 'POSCONDICION_FALLIDA: falta el CHECK de origen.';
  end if;
  if (select count(*) from public.documentos_generados) <> (select filas from _antes)
     or exists (select 1 from public.documentos_generados where origen is not null) then
    raise exception 'POSCONDICION_FALLIDA: cambiaron los registros existentes.';
  end if;
  if (select (anon_tabla, auth_select, auth_insert, auth_update, auth_delete) from _antes)
     is distinct from (has_table_privilege('anon', 'public.documentos_generados', 'select, insert, update, delete'),
                       has_table_privilege('authenticated', 'public.documentos_generados', 'select'),
                       has_table_privilege('authenticated', 'public.documentos_generados', 'insert'),
                       has_table_privilege('authenticated', 'public.documentos_generados', 'update'),
                       has_table_privilege('authenticated', 'public.documentos_generados', 'delete'))
     or (select count(*) from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'documentos_generados') <> 1 then
    raise exception 'POSCONDICION_FALLIDA: cambiaron los permisos o las políticas de documentos_generados.';
  end if;
end;
$$;

commit;
