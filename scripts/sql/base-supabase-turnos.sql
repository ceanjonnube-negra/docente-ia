-- Base mínima tipo Supabase para probar turnos_chat en PostgreSQL local
-- (scripts/verificar-turnos-chat-sql.sh). Reproduce lo que la migración
-- 20261129000000 necesita, con las mismas restricciones y políticas que
-- E2E/Production (verificadas en solo lectura): roles, auth.uid() desde el
-- JWT, privilegios por omisión de Supabase (anon/authenticated/service_role
-- reciben ALL en tablas y EXECUTE en funciones nuevas).
-- Los roles son del servidor (no de la base): se crean una sola vez.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema auth;
-- Publicación de Realtime (en Supabase existe siempre, vacía por omisión).
create publication supabase_realtime;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth, public to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create table public.perfiles_docentes (id uuid primary key);
create table public.grupos (id uuid primary key, docente_id uuid not null references public.perfiles_docentes(id));
create table public.conversaciones_chat (
  id uuid primary key, docente_id uuid not null references public.perfiles_docentes(id),
  grupo_id uuid references public.grupos(id) on delete restrict, planeacion_activa jsonb, eliminada_en timestamptz,
  actualizado_en timestamptz not null default now(),
  constraint conversaciones_chat_id_docente_unico unique (id, docente_id));
create table public.mensajes_chat (
  id text primary key, conversacion_id uuid not null references public.conversaciones_chat(id) on delete cascade,
  docente_id uuid not null references public.perfiles_docentes(id),
  rol text not null check (rol in ('usuario', 'asistente', 'herramienta')),
  texto text not null default '', contenido jsonb not null default '{}', creado_en timestamptz not null default now());
create table public.planeaciones (id uuid primary key, docente_id uuid not null references public.perfiles_docentes(id), grupo_id uuid not null references public.grupos(id));

create function public.conversacion_escribible(p_conversacion_id uuid) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or p_conversacion_id is null then return false; end if;
  perform 1 from public.conversaciones_chat c where c.id = p_conversacion_id and c.docente_id = auth.uid() and c.eliminada_en is null for key share;
  return found;
end $$;

alter table public.grupos enable row level security;
alter table public.conversaciones_chat enable row level security;
alter table public.mensajes_chat enable row level security;
alter table public.planeaciones enable row level security;
create policy grupos_select_propio on public.grupos for select using (docente_id = auth.uid());
create policy conversaciones_chat_select_propio on public.conversaciones_chat for select using (docente_id = auth.uid());
create policy conversaciones_chat_update_propio on public.conversaciones_chat for update using (docente_id = auth.uid() and eliminada_en is null) with check (docente_id = auth.uid() and eliminada_en is null);
create policy mensajes_chat_select_propio on public.mensajes_chat for select using (docente_id = auth.uid());
create policy mensajes_chat_insert_propio on public.mensajes_chat for insert with check (docente_id = auth.uid() and public.conversacion_escribible(conversacion_id));
create policy planeaciones_select_propio on public.planeaciones for select using (docente_id = auth.uid());
