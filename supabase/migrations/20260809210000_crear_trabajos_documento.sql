-- Fase 2A — corrección: timeout en documentos ilustrados largos (ver
-- "generar una guía ilustrada + Word + PDF puede tardar más que el
-- tiempo que Safari espera una sola respuesta bloqueante"). Tabla
-- nueva, 100% aditiva — no se toca ninguna tabla existente.
--
-- Deliberadamente NO se reutiliza turnos_chat (esa tabla pertenece a
-- la arquitectura durable de test/chat-durable-v1, rama que no se
-- mezcla con esta) — se crea una tabla propia, acotada a este uso
-- (generación de documentos, nunca todo el chat), con el mismo patrón
-- de idempotencia y RLS ya probado en este proyecto.
--
-- request_id UNIQUE + INSERT...ON CONFLICT (ver lib/trabajosDocumento.ts)
-- es la misma técnica de idempotencia real ya usada — nunca
-- "SELECT primero, INSERT después".

create table if not exists public.trabajos_documento (
  id uuid primary key default gen_random_uuid(),
  docente_id uuid not null references public.perfiles_docentes(id),
  conversacion_id text,
  request_id text not null unique,
  estado text not null default 'queued' check (estado in ('queued', 'generando', 'completado', 'fallido')),
  resultado jsonb,
  error text,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

create index if not exists trabajos_documento_docente_idx on public.trabajos_documento(docente_id, creado_en desc);

alter table public.trabajos_documento enable row level security;

create policy "trabajos_documento_select_propio" on public.trabajos_documento
  for select using (docente_id = auth.uid());

create policy "trabajos_documento_insert_propio" on public.trabajos_documento
  for insert with check (docente_id = auth.uid());

create policy "trabajos_documento_update_propio" on public.trabajos_documento
  for update using (docente_id = auth.uid());

-- Rollback documentado (nunca ejecutado automáticamente):
-- drop table if exists public.trabajos_documento;
