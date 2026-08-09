-- Generación de imágenes y documentos ilustrados — Fase 0+1 (ver diseño
-- técnico aprobado: "Implementar en Docente IA la capacidad de generar
-- imágenes y documentos ilustrados"). Tabla nueva, 100% aditiva — no
-- toca ninguna tabla existente (documentos_generados sigue siendo el
-- historial de TEXTO puro que ya usa la pantalla Historial, sin
-- relación con esta).
--
-- documento_padre_id/proyecto_id/planeacion_id quedan listos para la
-- Fase 2 (documentos ilustrados componiendo texto+imágenes) — en esta
-- fase solo se usa tipo='imagen', imagen suelta, sin padre.
--
-- Versionado: "regenerar" nunca borra — inserta una fila nueva con
-- version+1 y version_anterior_id apuntando a la anterior, que se
-- marca vigente=false (mismo criterio que planeaciones.version).

create table if not exists public.assets_visuales (
  id uuid primary key default gen_random_uuid(),
  docente_id uuid not null references public.perfiles_docentes(id),
  conversacion_id text,
  documento_padre_id uuid references public.assets_visuales(id),
  proyecto_id uuid references public.proyectos_seguimiento(id),
  planeacion_id uuid references public.planeaciones(id),
  tipo text not null check (tipo in ('imagen', 'documento_ilustrado')),
  formato_archivo text not null,
  prompt_original text not null,
  storage_path text not null,
  tamano_bytes bigint,
  grado text,
  grupo text,
  version integer not null default 1,
  version_anterior_id uuid references public.assets_visuales(id),
  vigente boolean not null default true,
  creado_en timestamptz not null default now()
);

create index if not exists assets_visuales_docente_idx on public.assets_visuales(docente_id, creado_en desc);
create index if not exists assets_visuales_conversacion_idx on public.assets_visuales(conversacion_id);

alter table public.assets_visuales enable row level security;

create policy "assets_visuales_select_propio" on public.assets_visuales
  for select using (docente_id = auth.uid());

create policy "assets_visuales_insert_propio" on public.assets_visuales
  for insert with check (docente_id = auth.uid());

create policy "assets_visuales_update_propio" on public.assets_visuales
  for update using (docente_id = auth.uid());

-- Rollback documentado (nunca ejecutado automáticamente):
-- drop table if exists public.assets_visuales;
