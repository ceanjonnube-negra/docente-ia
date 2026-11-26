-- Base mínima para probar 20261202000000 (Word y PDF por versión) en
-- PostgreSQL local, sobre base-supabase-turnos.sql. Reproduce de E2E
-- (verificado en solo lectura): planeacion_versiones con sus FK y su
-- disparador de inmutabilidad real, y archivos_generados con sus
-- restricciones reales.
alter table public.planeaciones add constraint planeaciones_id_docente_grupo unique (id, docente_id, grupo_id);

create table public.archivos_generados (
  id uuid primary key default gen_random_uuid(),
  docente_id uuid not null references public.perfiles_docentes(id),
  bucket text not null check (bucket = 'documentos-generados-ia'),
  ruta text not null,
  nombre text not null,
  tipo_mime text not null,
  tamano_bytes bigint not null default 0 check (tamano_bytes >= 0),
  clase text not null default 'conservar' check (clase in ('conservar', 'efimero')),
  conversacion_id uuid,
  estado text not null default 'subiendo' check (estado in ('subiendo', 'activo', 'fallido')),
  creado_en timestamptz not null default now(),
  activado_en timestamptz,
  ultimo_error text,
  unique (bucket, ruta),
  unique (id, docente_id),
  check ((estado = 'activo') = (activado_en is not null)),
  check (split_part(ruta, '/', 1) = docente_id::text and ruta !~ '(^/|//|\.\.)' and length(ruta) <= 1024)
);

create table public.planeacion_versiones (
  id uuid primary key default gen_random_uuid(),
  planeacion_id uuid not null,
  docente_id uuid not null,
  grupo_id uuid not null,
  numero integer not null,
  origen text not null default 'modificacion',
  borrador_clave text,
  contenido text,
  estructura jsonb not null default '{}',
  trazabilidad_curricular jsonb,
  documento_word_archivo_id uuid,
  documento_pdf_archivo_id uuid,
  hoja_id uuid,
  creada_en timestamptz not null default now(),
  constraint planeacion_versiones_numero_unico unique (planeacion_id, numero),
  constraint planeacion_versiones_de_la_planeacion foreign key (planeacion_id, docente_id, grupo_id) references public.planeaciones(id, docente_id, grupo_id) on delete cascade,
  constraint planeacion_versiones_word_del_docente foreign key (documento_word_archivo_id, docente_id) references public.archivos_generados(id, docente_id),
  constraint planeacion_versiones_pdf_del_docente foreign key (documento_pdf_archivo_id, docente_id) references public.archivos_generados(id, docente_id),
  constraint planeacion_versiones_archivos_distintos check (documento_word_archivo_id is null or documento_word_archivo_id is distinct from documento_pdf_archivo_id)
);
alter table public.planeacion_versiones enable row level security;
create policy planeacion_versiones_select on public.planeacion_versiones for select using (docente_id = auth.uid());
revoke insert, update, delete on public.planeacion_versiones from anon, authenticated;

create function public._trg_planeacion_versiones_inmutable() returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.id, new.planeacion_id, new.docente_id, new.grupo_id, new.numero, new.origen, new.borrador_clave, new.estructura, new.trazabilidad_curricular, new.creada_en)
     is distinct from (old.id, old.planeacion_id, old.docente_id, old.grupo_id, old.numero, old.origen, old.borrador_clave, old.estructura, old.trazabilidad_curricular, old.creada_en)
     or (old.contenido is not null and new.contenido is distinct from old.contenido)
     or (old.documento_word_archivo_id is not null and new.documento_word_archivo_id is distinct from old.documento_word_archivo_id)
     or (old.documento_pdf_archivo_id is not null and new.documento_pdf_archivo_id is distinct from old.documento_pdf_archivo_id)
     or (old.hoja_id is not null and new.hoja_id is distinct from old.hoja_id) then
    raise exception 'VERSION_INMUTABLE: una versión publicada no se modifica.' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger planeacion_versiones_inmutable before update on public.planeacion_versiones for each row execute function public._trg_planeacion_versiones_inmutable();
