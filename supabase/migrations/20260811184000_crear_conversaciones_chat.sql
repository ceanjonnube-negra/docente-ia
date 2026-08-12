-- Historial persistente del Chat IA — conversaciones_chat + mensajes_chat.
--
-- Ver diagnóstico "Nueva prueba real en iPhone — historial de
-- conversaciones no persiste": el Chat IA guardaba TODO el historial
-- en localStorage del navegador, aislado por origen — cada Preview de
-- Vercel usa un subdominio nuevo, así que el historial quedaba
-- inaccesible en cuanto cambiaba el deployment. Esta migración crea
-- SOLO las tablas necesarias para que Supabase sea la fuente de
-- verdad real del historial (ver plan de diseño autorizado — PASO 1
-- únicamente: solo esquema + RLS, sin tocar persistencia.ts ni
-- AsistenteService.ts todavía).
--
-- 100% ADITIVA: solo CREATE TABLE nuevas (conversaciones_chat,
-- mensajes_chat). No modifica, no renombra ni borra ninguna columna
-- de ninguna tabla existente (perfiles_docentes, alumnos, grupos,
-- planeaciones, trabajos_documento, turnos_chat, assets_visuales,
-- etc.) — cero riesgo para datos reales ya guardados.
--
-- Deliberadamente NO reutiliza turnos_chat (esa tabla pertenece a la
-- arquitectura durable de otra rama, ver su propia migración) ni
-- trabajos_documento (esa es solo para la generación asíncrona de UN
-- documento, no para el historial completo de mensajes del chat).
--
-- Mismo patrón real ya probado en este proyecto (ver
-- 20260809210000_crear_trabajos_documento.sql): docente_id
-- referenciando perfiles_docentes(id), RLS explícito por operación
-- (sin FOR ALL) con docente_id = auth.uid(), sin triggers (este
-- proyecto no usa triggers en ningún lado — actualizado_en se
-- escribe siempre explícito desde la aplicación).
--
-- id como uuid SIN default: el cliente ya genera el id de la
-- conversación/mensaje antes de guardar (mismo patrón que
-- persistencia.ts usa hoy con localStorage) — esto permite
-- `insert ... on conflict (id) do nothing` real al migrar más
-- adelante las conversaciones que ya existen en localStorage, sin
-- duplicarlas (ver plan de diseño, paso 4 — todavía NO se ejecuta en
-- esta migración).
--
-- Idempotente: create table/index if not exists, drop policy if
-- exists antes de cada create policy — puede reejecutarse sin fallar
-- y sin destruir datos ya insertados.
--
-- Rollback (si hace falta revertir por completo — esto SÍ es
-- destructivo, no confundir con volver a correr esta migración, que
-- no lo es):
--   begin;
--   drop table if exists public.mensajes_chat;
--   drop table if exists public.conversaciones_chat;
--   commit;

create table if not exists public.conversaciones_chat (
  id uuid primary key,
  docente_id uuid not null references public.perfiles_docentes(id),
  titulo text not null default 'Nueva conversación',
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  -- Documento/imagen activos de la conversación (ver
  -- DocumentoActivoGuardado/MaterialVisualActivoGuardado en
  -- lib/asistente/persistencia.ts) — necesarios para no perder la
  -- función real ya existente de seguir editando el último documento
  -- al reabrir una conversación.
  documento_activo jsonb,
  material_visual_activo jsonb
);

create index if not exists conversaciones_chat_docente_idx
  on public.conversaciones_chat (docente_id, actualizado_en desc);

alter table public.conversaciones_chat enable row level security;

drop policy if exists "conversaciones_chat_select_propio" on public.conversaciones_chat;
create policy "conversaciones_chat_select_propio" on public.conversaciones_chat
  for select using (docente_id = auth.uid());

drop policy if exists "conversaciones_chat_insert_propio" on public.conversaciones_chat;
create policy "conversaciones_chat_insert_propio" on public.conversaciones_chat
  for insert with check (docente_id = auth.uid());

drop policy if exists "conversaciones_chat_update_propio" on public.conversaciones_chat;
create policy "conversaciones_chat_update_propio" on public.conversaciones_chat
  for update using (docente_id = auth.uid()) with check (docente_id = auth.uid());

drop policy if exists "conversaciones_chat_delete_propio" on public.conversaciones_chat;
create policy "conversaciones_chat_delete_propio" on public.conversaciones_chat
  for delete using (docente_id = auth.uid());

create table if not exists public.mensajes_chat (
  id uuid primary key,
  conversacion_id uuid not null references public.conversaciones_chat(id) on delete cascade,
  -- Denormalizado a propósito (mismo patrón que trabajos_documento):
  -- así la política RLS de mensajes_chat nunca necesita un JOIN
  -- contra conversaciones_chat para resolver el dueño.
  docente_id uuid not null references public.perfiles_docentes(id),
  rol text not null check (rol in ('usuario', 'asistente', 'herramienta')),
  texto text not null default '',
  -- Resto de MensajeConversacion (archivo, archivos, imagen, imagenes,
  -- acciones, accionElegida, datosAccionCalendario,
  -- datosAccionNavegacion — ver lib/asistente/tipos.ts) — ya son
  -- campos reales en producción hoy, no especulativos. jsonb en vez
  -- de una columna por campo para no requerir una migración cada vez
  -- que se agregue uno nuevo (mismo criterio que
  -- trabajos_documento.resultado jsonb).
  contenido jsonb not null default '{}'::jsonb,
  creado_en timestamptz not null default now()
);

create index if not exists mensajes_chat_conversacion_idx
  on public.mensajes_chat (conversacion_id, creado_en);
create index if not exists mensajes_chat_docente_idx
  on public.mensajes_chat (docente_id);

alter table public.mensajes_chat enable row level security;

drop policy if exists "mensajes_chat_select_propio" on public.mensajes_chat;
create policy "mensajes_chat_select_propio" on public.mensajes_chat
  for select using (docente_id = auth.uid());

drop policy if exists "mensajes_chat_insert_propio" on public.mensajes_chat;
create policy "mensajes_chat_insert_propio" on public.mensajes_chat
  for insert with check (docente_id = auth.uid());

drop policy if exists "mensajes_chat_update_propio" on public.mensajes_chat;
create policy "mensajes_chat_update_propio" on public.mensajes_chat
  for update using (docente_id = auth.uid()) with check (docente_id = auth.uid());
