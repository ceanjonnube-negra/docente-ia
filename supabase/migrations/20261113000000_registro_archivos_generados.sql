-- ETAPA 3B-2A — registro confiable de archivos NUEVOS generados por la
-- aplicación (bucket documentos-generados-ia). Solo registra: no borra
-- ni modifica ningún objeto de Storage. Los archivos anteriores a esta
-- migración (sin registro) quedan fuera para siempre: nada los clasifica
-- ni los puede marcar para eliminar.
--
-- archivos_generados — un registro por archivo, escrito SOLO por el
--   servidor (service_role) ANTES de subirlo (estado 'subiendo') y
--   confirmado DESPUÉS de verificarlo ('activo'); un archivo nunca se
--   entrega sin estar 'activo'. 'fallido' = nunca entregado.
--   clase:
--     'conservar' — por defecto: documentos académicos, listas, sus
--                   derivados y todo archivo de origen incierto.
--     'efimero'   — documento exclusivo del Chat, ligado a una
--                   conversación del MISMO docente (FK compuesta
--                   (conversacion_id, docente_id)). Solo estos podrán ser
--                   candidatos a eliminación física (etapa 3B-2B), y solo
--                   si su conversación fue eliminada.
--
-- Permisos: ninguno para anon/authenticated (RLS activa sin políticas).
-- service_role sin DELETE/TRUNCATE: los registros son auditoría y nunca
-- se borran.
--
-- REVERSIÓN (no toca Storage):
--   drop table public.archivos_generados;
--   alter table public.conversaciones_chat drop constraint conversaciones_chat_id_docente_unico;

begin;

-- ============================================================
-- PRECONDICIONES
-- ============================================================
do $$
begin
  if to_regclass('public.archivos_generados') is not null then
    raise exception 'PRECONDICION_FALLIDA: la tabla archivos_generados ya existe.';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'conversaciones_chat' and column_name = 'eliminada_en') then
    raise exception 'PRECONDICION_FALLIDA: falta la etapa 3B-1 (conversaciones_chat.eliminada_en).';
  end if;
  if exists (select 1 from pg_catalog.pg_constraint where conname = 'conversaciones_chat_id_docente_unico') then
    raise exception 'PRECONDICION_FALLIDA: la restricción conversaciones_chat_id_docente_unico ya existe.';
  end if;
end;
$$;

-- Conteo de Storage para comprobar al final que no se tocó ningún objeto.
create temporary table _conteo_storage on commit drop as
  select count(*) as objetos from storage.objects;

-- ============================================================
-- 1. Clave compuesta para la FK (conversación del MISMO docente)
-- ============================================================
alter table public.conversaciones_chat
  add constraint conversaciones_chat_id_docente_unico unique (id, docente_id);

-- ============================================================
-- 2. Registro de archivos
-- ============================================================
create table public.archivos_generados (
  id uuid primary key default gen_random_uuid(),
  docente_id uuid not null references public.perfiles_docentes(id),
  bucket text not null check (bucket = 'documentos-generados-ia'),
  ruta text not null,
  nombre text not null,
  tipo_mime text not null,
  tamano_bytes bigint not null check (tamano_bytes >= 0),
  clase text not null default 'conservar' check (clase in ('conservar', 'efimero')),
  conversacion_id uuid null,
  estado text not null default 'subiendo' check (estado in ('subiendo', 'activo', 'fallido')),
  creado_en timestamptz not null default now(),
  activado_en timestamptz null,
  ultimo_error text null,
  constraint archivos_generados_bucket_ruta_unica unique (bucket, ruta),
  -- La ruta vive bajo la carpeta del propio docente, sin segmentos raros.
  constraint archivos_generados_ruta_del_docente check (
    split_part(ruta, '/', 1) = docente_id::text and ruta !~ '(^/|//|\.\.)' and length(ruta) <= 1024
  ),
  -- Solo 'efimero' lleva conversación, y 'efimero' siempre la lleva.
  constraint archivos_generados_efimero_con_conversacion check ((clase = 'efimero') = (conversacion_id is not null)),
  constraint archivos_generados_activo_con_fecha check ((estado = 'activo') = (activado_en is not null)),
  constraint archivos_generados_conversacion_del_docente
    foreign key (conversacion_id, docente_id) references public.conversaciones_chat (id, docente_id)
);

create index archivos_generados_conversacion_idx on public.archivos_generados (conversacion_id) where conversacion_id is not null;
create index archivos_generados_docente_idx on public.archivos_generados (docente_id, creado_en desc);

-- ============================================================
-- 3. Permisos y RLS
-- ============================================================
alter table public.archivos_generados enable row level security;
revoke all on public.archivos_generados from public, anon, authenticated, service_role;
grant select, insert, update on public.archivos_generados to service_role;

-- ============================================================
-- POSCONDICIONES
-- ============================================================
do $$
begin
  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'public.archivos_generados'::regclass)
     or pg_catalog.pg_get_userbyid((select c.relowner from pg_catalog.pg_class c where c.oid = 'public.archivos_generados'::regclass)) <> 'postgres'
     or exists (select 1 from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'archivos_generados')
     or has_table_privilege('anon', 'public.archivos_generados', 'select, insert, update, delete, truncate, references, trigger')
     or has_table_privilege('authenticated', 'public.archivos_generados', 'select, insert, update, delete, truncate, references, trigger')
     or has_table_privilege('service_role', 'public.archivos_generados', 'delete, truncate')
     or not has_table_privilege('service_role', 'public.archivos_generados', 'select, insert, update') then
    raise exception 'POSCONDICION_FALLIDA: archivos_generados no quedó con RLS sin políticas y permisos mínimos.';
  end if;

  if (select count(*) from pg_catalog.pg_constraint where conrelid = 'public.archivos_generados'::regclass
        and conname in ('archivos_generados_ruta_del_docente', 'archivos_generados_efimero_con_conversacion',
                        'archivos_generados_activo_con_fecha', 'archivos_generados_conversacion_del_docente',
                        'archivos_generados_bucket_ruta_unica')) <> 5 then
    raise exception 'POSCONDICION_FALLIDA: faltan restricciones de integridad en archivos_generados.';
  end if;

  if (select count(*) from storage.objects) <> (select objetos from _conteo_storage) then
    raise exception 'POSCONDICION_FALLIDA: cambió el número de objetos de Storage.';
  end if;
end;
$$;

commit;
