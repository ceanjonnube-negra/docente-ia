-- Historial de documentos — vínculo de cada documento NUEVO con su archivo
-- original (B2), para abrirlo o descargarlo desde Historial sin
-- regenerarlo, con la recuperación segura de POST /api/archivos/descargar.
-- Solo agrega estructura: no modifica ni vincula ningún registro existente.
--
-- documentos_generados:
--   archivo_id      — archivo en archivos_generados con el que nació el
--                     documento. NULL = registro anterior, documento
--                     textual o sin archivo registrado.
--   archivo_formato — 'word' | 'pdf' | 'powerpoint' | 'excel': decide qué
--                     acciones ofrece Historial (solo un PDF se ve en
--                     línea). El navegador no puede leer archivos_generados.
-- Integridad:
--   - FK compuesta (archivo_id, user_id) → archivos_generados (id,
--     docente_id): la base rechaza vincular el archivo de otro docente.
--     Requiere UNIQUE (id, docente_id) en archivos_generados (id ya es PK,
--     así que siempre se cumple).
--   - archivo_id y archivo_formato van juntos: los dos o ninguno (CHECK).
--   - ON DELETE NO ACTION: archivos_generados es un registro de auditoría
--     que nunca se borra (service_role no tiene DELETE). Si alguna vez se
--     borrara un archivo vinculado, la base lo rechaza en vez de dejar el
--     vínculo a medias; antes hay que desvincular el documento (archivo_id
--     y archivo_formato a NULL, en la misma transacción). Nunca se toca
--     user_id.
--
-- Permisos y RLS: sin cambios. archivos_generados sigue sin permisos para
-- anon/authenticated; documentos_generados conserva su política y sus
-- permisos de tabla (el cliente del docente escribe las columnas nuevas en
-- sus propias filas).
--
-- REVERSIÓN (no toca datos previos):
--   alter table public.documentos_generados
--     drop constraint documentos_generados_archivo_del_docente,
--     drop constraint documentos_generados_archivo_con_formato,
--     drop column archivo_formato,
--     drop column archivo_id;
--   alter table public.archivos_generados drop constraint archivos_generados_id_docente_unico;

begin;

-- ============================================================
-- PRECONDICIONES
-- ============================================================
do $$
begin
  if to_regclass('public.documentos_generados') is null or to_regclass('public.archivos_generados') is null then
    raise exception 'PRECONDICION_FALLIDA: faltan documentos_generados o archivos_generados.';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'documentos_generados' and column_name in ('archivo_id', 'archivo_formato')) then
    raise exception 'PRECONDICION_FALLIDA: archivo_id o archivo_formato ya existen.';
  end if;
  if exists (select 1 from pg_catalog.pg_constraint
              where conname in ('archivos_generados_id_docente_unico', 'documentos_generados_archivo_del_docente', 'documentos_generados_archivo_con_formato', 'documentos_generados_archivo_formato_check')) then
    raise exception 'PRECONDICION_FALLIDA: alguna restricción de esta migración ya existe.';
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint c
                  where c.conrelid = 'public.archivos_generados'::regclass and c.contype = 'p'
                    and c.conkey = array[(select attnum from pg_catalog.pg_attribute where attrelid = 'public.archivos_generados'::regclass and attname = 'id')]::int2[]) then
    raise exception 'PRECONDICION_FALLIDA: archivos_generados.id no es la clave primaria.';
  end if;
  if (select string_agg(table_name || '.' || column_name || ':' || data_type, ',' order by table_name, column_name) from information_schema.columns
       where table_schema = 'public' and ((table_name = 'documentos_generados' and column_name = 'user_id')
                                       or (table_name = 'archivos_generados' and column_name in ('id', 'docente_id'))))
     is distinct from 'archivos_generados.docente_id:uuid,archivos_generados.id:uuid,documentos_generados.user_id:uuid' then
    raise exception 'PRECONDICION_FALLIDA: tipos de columnas distintos de los esperados.';
  end if;
  if (select count(*) from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'documentos_generados') <> 1
     or not exists (select 1 from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'documentos_generados'
                     and policyname = 'Cada docente ve sus documentos' and cmd = 'ALL') then
    raise exception 'PRECONDICION_FALLIDA: las políticas de documentos_generados difieren de las esperadas.';
  end if;
end;
$$;

-- Conteos y privilegios para comprobar al final que no cambiaron.
create temporary table _antes on commit drop as
  select (select count(*) from public.documentos_generados) as documentos,
         (select count(*) from public.archivos_generados) as archivos,
         (select string_agg(grantee || '=' || privilege_type, ',' order by grantee, privilege_type) from information_schema.role_table_grants
           where table_schema = 'public' and table_name = 'documentos_generados' and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')) as permisos_documentos,
         (select string_agg(grantee || '=' || privilege_type, ',' order by grantee, privilege_type) from information_schema.role_table_grants
           where table_schema = 'public' and table_name = 'archivos_generados' and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')) as permisos_archivos,
         (select count(*) from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'archivos_generados') as politicas_archivos;

-- ============================================================
-- 1. Clave compuesta del archivo (id, docente)
-- ============================================================
alter table public.archivos_generados
  add constraint archivos_generados_id_docente_unico unique (id, docente_id);

-- ============================================================
-- 2. Vínculo del documento con su archivo original
-- ============================================================
alter table public.documentos_generados
  add column archivo_id uuid null,
  add column archivo_formato text null
    constraint documentos_generados_archivo_formato_check check (archivo_formato in ('word', 'pdf', 'powerpoint', 'excel')),
  add constraint documentos_generados_archivo_con_formato check ((archivo_id is null) = (archivo_formato is null)),
  add constraint documentos_generados_archivo_del_docente
    foreign key (archivo_id, user_id) references public.archivos_generados (id, docente_id)
    on delete no action;

-- ============================================================
-- POSCONDICIONES
-- ============================================================
do $$
declare
  t constant regclass := 'public.documentos_generados'::regclass;
  a constant regclass := 'public.archivos_generados'::regclass;
  att_archivo int2 := (select attnum from pg_catalog.pg_attribute where attrelid = t and attname = 'archivo_id');
  att_usuario int2 := (select attnum from pg_catalog.pg_attribute where attrelid = t and attname = 'user_id');
begin
  if (select string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '-'), ',' order by column_name)
        from information_schema.columns where table_schema = 'public' and table_name = 'documentos_generados' and column_name in ('archivo_id', 'archivo_formato'))
     is distinct from 'archivo_formato:text:YES:-,archivo_id:uuid:YES:-' then
    raise exception 'POSCONDICION_FALLIDA: columnas nuevas distintas de lo esperado.';
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = a and conname = 'archivos_generados_id_docente_unico' and contype = 'u'
                   and conkey = array[(select attnum from pg_catalog.pg_attribute where attrelid = a and attname = 'id'),
                                      (select attnum from pg_catalog.pg_attribute where attrelid = a and attname = 'docente_id')]::int2[]) then
    raise exception 'POSCONDICION_FALLIDA: falta UNIQUE (id, docente_id) en archivos_generados.';
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint c where c.conrelid = t and c.conname = 'documentos_generados_archivo_del_docente' and c.contype = 'f'
                   and c.conkey = array[att_archivo, att_usuario] and c.confrelid = a
                   and c.confkey = array[(select attnum from pg_catalog.pg_attribute where attrelid = a and attname = 'id'),
                                         (select attnum from pg_catalog.pg_attribute where attrelid = a and attname = 'docente_id')]::int2[]
                   and c.confdeltype = 'a' and c.confdelsetcols is null and c.convalidated) then
    raise exception 'POSCONDICION_FALLIDA: la FK compuesta (archivo_id, user_id) no quedó como se esperaba.';
  end if;
  if (select count(*) from pg_catalog.pg_constraint where conrelid = t and contype = 'c'
        and conname in ('documentos_generados_archivo_formato_check', 'documentos_generados_archivo_con_formato')) <> 2 then
    raise exception 'POSCONDICION_FALLIDA: faltan los CHECK del formato.';
  end if;
  if (select count(*) from public.documentos_generados) <> (select documentos from _antes)
     or (select count(*) from public.archivos_generados) <> (select archivos from _antes)
     or exists (select 1 from public.documentos_generados where archivo_id is not null or archivo_formato is not null) then
    raise exception 'POSCONDICION_FALLIDA: cambiaron los registros existentes.';
  end if;
  if (select string_agg(grantee || '=' || privilege_type, ',' order by grantee, privilege_type) from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'documentos_generados' and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC'))
       is distinct from (select permisos_documentos from _antes)
     or (select string_agg(grantee || '=' || privilege_type, ',' order by grantee, privilege_type) from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'archivos_generados' and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC'))
       is distinct from (select permisos_archivos from _antes)
     or (select count(*) from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'documentos_generados') <> 1
     or (select count(*) from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'archivos_generados') <> (select politicas_archivos from _antes) then
    raise exception 'POSCONDICION_FALLIDA: cambiaron los permisos o las políticas.';
  end if;
end;
$$;

commit;
