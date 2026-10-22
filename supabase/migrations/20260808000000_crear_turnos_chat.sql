-- ============================================================
-- Migración: turnos_chat (arquitectura durable del Chat IA — Vercel
-- Workflow + Supabase turnos_chat).
--
-- Objetivo: la generación del Chat IA deja de depender de que la
-- pestaña de Safari/iPhone siga conectada — el turno persiste en esta
-- tabla y un Workflow durable de Vercel lo completa
-- independientemente de si el docente sigue viendo la pantalla.
--
-- 100% ADITIVA: solo CREATE TABLE nueva (turnos_chat). No modifica,
-- no renombra ni borra ninguna columna de ninguna tabla existente
-- (alumnos, grupos, planeaciones, planeacion_proyectos,
-- proyectos_seguimiento, hojas_evaluacion, asistencias, perfiles_docentes,
-- etc.) — cero riesgo para datos reales ya guardados.
--
-- Idempotente: create table/index if not exists, drop policy if
-- exists antes de cada create policy — puede reejecutarse sin fallar
-- y sin destruir datos ya insertados.
--
-- RLS: SELECT/INSERT/UPDATE explícitos por operación, sin FOR ALL —
-- mismo criterio ya usado en planeaciones/planeacion_proyectos (ver
-- migrations/planeacion_fase1.sql). Sin política DELETE a propósito:
-- ningún flujo de esta arquitectura borra turnos.
--
-- Idempotencia de negocio: request_id UNIQUE es la protección real
-- contra doble ejecución (doble tap, reconexión que reenvía el mismo
-- POST) — un INSERT ... ON CONFLICT (request_id) DO NOTHING desde la
-- aplicación nunca crea una segunda fila para el mismo request_id.
--
-- Cómo probar: correr primero con `rollback;` en vez de `commit;` al
-- final, revisar que no haya errores, y volver a correrlo completo con
-- `commit;` para la corrida real.
--
-- Rollback (si ya se corrió con commit y hay que revertir por
-- completo — esto SÍ es destructivo, no confundir con volver a
-- correr esta migración, que no lo es):
--   begin;
--   drop table if exists public.turnos_chat;
--   commit;
-- ============================================================

begin;

create table if not exists public.turnos_chat (
  id uuid primary key default gen_random_uuid(),
  docente_id uuid not null references public.perfiles_docentes(id),
  conversacion_id text,
  request_id text not null unique,
  estado text not null default 'queued'
    check (estado in ('queued', 'generating', 'completed', 'failed')),
  texto_parcial text not null default '',
  texto_final text,
  archivos jsonb not null default '[]',
  error text,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

-- Índices mínimos: el docente autenticado buscando "¿tengo un turno
-- activo en esta conversación?" al reconectar es la consulta real más
-- frecuente (índice combinado); el resto son de apoyo puntual, sin
-- sobreindexar.
create index if not exists turnos_chat_docente_idx
  on public.turnos_chat (docente_id);
create index if not exists turnos_chat_conversacion_idx
  on public.turnos_chat (conversacion_id);
create index if not exists turnos_chat_estado_idx
  on public.turnos_chat (estado);
create index if not exists turnos_chat_creado_idx
  on public.turnos_chat (creado_en);
create index if not exists turnos_chat_docente_conversacion_creado_idx
  on public.turnos_chat (docente_id, conversacion_id, creado_en desc);

alter table public.turnos_chat enable row level security;

-- SELECT — el docente solo ve sus propios turnos.
drop policy if exists "turnos_chat_select" on public.turnos_chat;
create policy "turnos_chat_select" on public.turnos_chat
  for select
  using (docente_id = auth.uid());

-- INSERT — la fila nueva debe pertenecer al docente autenticado (nunca
-- se puede crear un turno "propio" en nombre de otro docente_id).
drop policy if exists "turnos_chat_insert" on public.turnos_chat;
create policy "turnos_chat_insert" on public.turnos_chat
  for insert
  with check (docente_id = auth.uid());

-- UPDATE — el Workflow (usando el access_token del propio docente,
-- nunca service_role) solo puede actualizar turnos que ya le
-- pertenecen a ese mismo docente.
drop policy if exists "turnos_chat_update" on public.turnos_chat;
create policy "turnos_chat_update" on public.turnos_chat
  for update
  using (docente_id = auth.uid())
  with check (docente_id = auth.uid());

-- Sin política DELETE a propósito — ningún flujo de esta arquitectura
-- borra turnos; conservarlos es lo que permite auditar/depurar.

commit;
