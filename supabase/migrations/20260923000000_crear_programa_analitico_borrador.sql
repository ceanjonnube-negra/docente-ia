-- PA-4C — tabla dedicada para el borrador server-side del Programa
-- Analítico. Auditoría previa (ver informe PA-4C §B) descartó
-- reutilizar conversaciones_chat.planeacion_activa (mismo patrón JSONB
-- ya existente en el proyecto): esa columna es un snapshot POR
-- CONVERSACIÓN (sin ningún UNIQUE que limite cuántas conversaciones
-- simultáneas puede tener un docente), mientras que el borrador de PA
-- necesita "máximo 1 pendiente POR GRUPO", independiente de cuántas
-- conversaciones existan — mezclarlo con el historial conversacional
-- también rompería la separación explícita pedida entre historial y
-- estado canónico. Una tabla dedicada, con el mismo patrón real ya
-- usado en trabajos_documento (idempotency_key + RLS por docente_id),
-- es la única opción con semántica correcta.
--
-- No guarda el catálogo curricular completo ni los items base — la
-- propuesta siempre se reconstruye server-side desde: identidad
-- curricular fijada + catálogo canónico (recuperarCatalogoCurricularCerrado)
-- + deltas (esta tabla) + contexto confirmado (esta tabla).
begin;

create table public.programa_analitico_borrador (
  id uuid primary key default gen_random_uuid(),
  docente_id uuid not null references public.perfiles_docentes(id),
  grupo_id uuid not null references public.grupos(id),
  -- Solo para UX futura (que el Chat pueda recordar "el borrador de
  -- esta conversación") — NUNCA fuente de verdad: el borrador vive y
  -- se resuelve por grupo_id, no por conversación. Nullable porque
  -- PA-4C no conecta Chat todavía.
  conversacion_id uuid references public.conversaciones_chat(id) on delete set null,
  idempotency_key text not null check (btrim(idempotency_key) <> ''),
  -- Identidad curricular fijada SERVER-SIDE al crear el borrador (ver
  -- resolverContextoCurricularGrupo) — nunca proviene del cliente ni
  -- de la IA. FKs compuestas (mismo patrón "denormalize-ancestor-then-FK"
  -- ya usado en todo el proyecto) hacen estructuralmente imposible que
  -- fase/grado no correspondan a la versión fijada.
  curriculo_version_id uuid not null references public.curriculo_version(id),
  curriculo_fase_id uuid not null references public.curriculo_fase(id),
  curriculo_grado_id uuid not null references public.curriculo_grado(id),
  contexto_docente text,
  contexto_notas text,
  -- Deltas normalizados (DeltaBorrador[] — ver
  -- lib/programaAnalitico/borradorProgramaAnalitico.ts). Solo se
  -- valida la FORMA mínima aquí (array) — la semántica pedagógica
  -- completa (IDs cerrados, pertenencia, no fuzzy) vive en TypeScript
  -- y se revalida SIEMPRE al leer, nunca se asume válida solo porque
  -- vino de DB.
  deltas jsonb not null default '[]'::jsonb check (jsonb_typeof(deltas) = 'array'),
  estado text not null default 'pendiente' check (estado in ('pendiente', 'publicado', 'descartado')),
  -- Se rellena atómicamente al confirmar (ver
  -- 20260923010000_extender_publicar_borrador.sql) — nunca por un
  -- segundo UPDATE independiente desde TypeScript.
  programa_analitico_version_id uuid references public.programa_analitico_version(id),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  unique (docente_id, idempotency_key),
  foreign key (curriculo_fase_id, curriculo_version_id) references public.curriculo_fase(id, curriculo_version_id),
  foreign key (curriculo_fase_id, curriculo_grado_id) references public.curriculo_fase_grado(curriculo_fase_id, curriculo_grado_id)
);

-- Garantía SERVER-SIDE/DB (no solo de UI) del hueco detectado en
-- PA-4A: máximo 1 borrador pendiente por grupo. Un UNIQUE índice
-- parcial es más simple y más fuerte que cualquier comprobación en
-- TypeScript — un INSERT concurrente para el mismo grupo con estado
-- pendiente falla directamente por constraint, sin condición de
-- carrera posible.
create unique index programa_analitico_borrador_un_pendiente_por_grupo
  on public.programa_analitico_borrador (grupo_id)
  where estado = 'pendiente';

create index programa_analitico_borrador_docente_idx on public.programa_analitico_borrador (docente_id, creado_en desc);

alter table public.programa_analitico_borrador enable row level security;

-- Mismo patrón ya usado en toda la serie: ownership derivado de
-- auth.uid(), nunca de un docente_id enviado por el cliente. Sin
-- policy de DELETE — descartar es un UPDATE a estado='descartado'
-- (trazabilidad ligera, ver informe PA-4C §J), nunca borrado físico.
create policy "programa_analitico_borrador_select_propio" on public.programa_analitico_borrador
  for select using (docente_id = auth.uid());

create policy "programa_analitico_borrador_insert_propio" on public.programa_analitico_borrador
  for insert with check (docente_id = auth.uid());

create policy "programa_analitico_borrador_update_propio" on public.programa_analitico_borrador
  for update using (docente_id = auth.uid());

commit;
