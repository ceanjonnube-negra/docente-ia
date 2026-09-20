-- PROGRAMA ANALÍTICO V1 — ESQUEMA CANÓNICO + ADDENDUM CURRICULAR (PA-2A)
--
-- Ver diseño aprobado PA-1A (auditoría) → PA-1B (contrato canónico) →
-- PA-1C (cierre de integridad referencial). Esta migración crea
-- EXCLUSIVAMENTE estructura: addendum aditivo sobre curriculo_pda/
-- curriculo_pda_grado (V1-A, ya cerrada) + las 4 tablas de Programa
-- Analítico. Cero datos de Programa Analítico, cero cambios a datos
-- curriculares ya publicados (textos, fuente, fragmentos, versión,
-- cobertura, estado — todo intacto), cero RPC, cero funciones
-- persistentes, cero triggers persistentes (el único bloque PL/pgSQL de
-- esta migración es un `do $$ ... end $$` EFÍMERO que valida el
-- backfill y desaparece al terminar la migración — no crea ninguna
-- función ni trigger que quede en el esquema).
--
-- Migración transaccional completa (BEGIN...COMMIT explícito): el
-- addendum curricular y las tablas de Programa Analítico se aplican
-- como una sola unidad porque la segunda parte depende
-- estructuralmente de la primera (FK compuestas de Programa Analítico
-- referencian columnas que este addendum crea) — todo o nada.
--
-- ========== PARTE A — ADDENDUM CURRÍCULO (aditivo, sin alterar datos) ==========
--
-- Habilita, con dos columnas denormalizadas + 3 constraints nuevas
-- sobre curriculo_pda/curriculo_pda_grado, la integridad declarativa
-- PDA↔grado↔contenido↔versión que Programa Analítico necesita (PA-1C
-- §1) — sin tocar ningún texto oficial, ID, fuente, fragmento, versión,
-- cobertura ni estado curricular ya publicado.

begin;

alter table public.curriculo_pda
  add constraint curriculo_pda_id_contenido_version_key
  unique (id, contenido_id, curriculo_version_id);

alter table public.curriculo_pda_grado
  add column contenido_id uuid,
  add column curriculo_version_id uuid;

-- Backfill determinista: cada curriculo_pda_grado.curriculo_pda_id ya
-- apunta a exactamente un curriculo_pda real (FK existente desde
-- V1-A) — esto solo copia valores que ya estaban implícitos por esa
-- relación, nunca infiere ni aproxima nada.
update public.curriculo_pda_grado pg
set contenido_id = p.contenido_id,
    curriculo_version_id = p.curriculo_version_id
from public.curriculo_pda p
where p.id = pg.curriculo_pda_id;

-- Guarda fail-closed: aborta TODA la migración (revierte también la
-- parte A ya ejecutada) si el backfill no completó absolutamente todas
-- las filas o si algún ancestro no coincide exactamente con el
-- curriculo_pda real. Bloque PL/pgSQL efímero -- no persiste como
-- función ni trigger.
do $$
declare
  filas_sin_backfill integer;
  filas_con_ancestro_incorrecto integer;
begin
  select count(*) into filas_sin_backfill
  from public.curriculo_pda_grado
  where contenido_id is null or curriculo_version_id is null;

  if filas_sin_backfill > 0 then
    raise exception 'ADDENDUM_CURRICULO_BACKFILL_INCOMPLETO: % filas de curriculo_pda_grado sin contenido_id/curriculo_version_id', filas_sin_backfill;
  end if;

  select count(*) into filas_con_ancestro_incorrecto
  from public.curriculo_pda_grado pg
  join public.curriculo_pda p on p.id = pg.curriculo_pda_id
  where pg.contenido_id is distinct from p.contenido_id
     or pg.curriculo_version_id is distinct from p.curriculo_version_id;

  if filas_con_ancestro_incorrecto > 0 then
    raise exception 'ADDENDUM_CURRICULO_ANCESTRO_INCONSISTENTE: % filas de curriculo_pda_grado con ancestro que no coincide con curriculo_pda real', filas_con_ancestro_incorrecto;
  end if;
end $$;

alter table public.curriculo_pda_grado
  alter column contenido_id set not null,
  alter column curriculo_version_id set not null;

alter table public.curriculo_pda_grado
  add constraint curriculo_pda_grado_ancestros_reales_fkey
  foreign key (curriculo_pda_id, contenido_id, curriculo_version_id)
  references public.curriculo_pda (id, contenido_id, curriculo_version_id),
  add constraint curriculo_pda_grado_id_ancestros_key
  unique (id, curriculo_grado_id, contenido_id, curriculo_version_id);

-- ========== PARTE B — PROGRAMA ANALÍTICO (4 tablas, cero datos) ==========
--
-- Diseño B de PA-1C: FK compuestas encadenadas (denormalizar ancestro +
-- UNIQUE + FK compuesta), mismo idioma ya usado en toda V1-A — cero
-- triggers persistentes. Filosofía de inmutabilidad de versión: una
-- versión de Programa Analítico NUNCA se edita — un ajuste crea la
-- siguiente versión completa (mismo principio que curriculo_version,
-- aplicado aquí sin ninguna columna de estado, ver Parte B más abajo).

create table if not exists public.programa_analitico (
  id uuid primary key default gen_random_uuid(),
  -- 1 Programa Analítico por grupo. grupos.ciclo_escolar_id ya es
  -- NOT NULL y fijo por fila de grupos (cada ciclo tiene su propia fila
  -- de grupos) -- UNIQUE(grupo_id) es identidad completa, agregar
  -- ciclo_escolar_id aquí sería redundante (PA-1C §12).
  grupo_id uuid not null references public.grupos(id) on delete restrict,
  -- FK compuesta agregada más abajo, tras crear programa_analitico_version
  -- (evita referencia circular en la definición de tabla).
  version_vigente_id uuid,
  creado_en timestamptz not null default now(),
  unique (grupo_id)
);

create table if not exists public.programa_analitico_version (
  id uuid primary key default gen_random_uuid(),
  programa_analitico_id uuid not null references public.programa_analitico(id) on delete restrict,
  numero_version integer not null check (numero_version > 0),
  -- Fija inequívocamente qué currículo oficial se usó -- PA-1B §1.
  curriculo_version_id uuid not null references public.curriculo_version(id) on delete restrict,
  curriculo_fase_id uuid not null,
  curriculo_grado_id uuid not null references public.curriculo_grado(id) on delete restrict,
  -- Único lugar para lo que el docente aportó explícitamente al crear/
  -- ajustar esta versión (PA-1B §3) -- nunca obligatorio, nunca inventado.
  contexto_notas text check (contexto_notas is null or btrim(contexto_notas) <> ''),
  -- PA-1C §7: mismo patrón real ya usado en proyectos_seguimiento.docente_id
  -- (FK a perfiles_docentes, no a auth.users directamente).
  creado_por uuid not null references public.perfiles_docentes(id),
  creado_en timestamptz not null default now(),
  -- PA-1C §3-A / §4: la fase declarada pertenece realmente a esta
  -- curriculo_version, y el grado declarado pertenece realmente a esa
  -- fase -- ambas ya posibles con constraints existentes de V1-A, sin
  -- necesitar ningún addendum adicional.
  foreign key (curriculo_fase_id, curriculo_version_id)
    references public.curriculo_fase (id, curriculo_version_id),
  foreign key (curriculo_fase_id, curriculo_grado_id)
    references public.curriculo_fase_grado (curriculo_fase_id, curriculo_grado_id),
  unique (programa_analitico_id, numero_version),
  -- Habilita la FK compuesta de programa_analitico.version_vigente_id
  -- (garantiza que el puntero pertenezca siempre al mismo contenedor).
  unique (id, programa_analitico_id),
  -- Habilita la FK compuesta de programa_analitico_item (garantiza que
  -- un item herede exactamente la curriculo_version/grado de SU propia
  -- versión, nunca un valor independientemente fabricado).
  unique (id, curriculo_version_id, curriculo_grado_id)
);

alter table public.programa_analitico
  add constraint programa_analitico_version_vigente_fkey
  foreign key (version_vigente_id, id)
  references public.programa_analitico_version (id, programa_analitico_id);

create index if not exists programa_analitico_version_padre_idx
  on public.programa_analitico_version (programa_analitico_id);

create table if not exists public.programa_analitico_item (
  id uuid primary key default gen_random_uuid(),
  programa_analitico_version_id uuid not null,
  -- Denormalizado desde la versión -- PA-1C §1/§5.
  curriculo_version_id uuid not null,
  curriculo_grado_id uuid not null,
  curriculo_contenido_id uuid,
  tipo_decision text not null check (tipo_decision in ('sin_ajuste','contextualizado','nuevo')),
  texto_contextualizado text,
  texto_local text,
  resultado_esperado_local text,
  periodo_evaluacion_id uuid references public.periodos_evaluacion(id) on delete set null,
  orden integer not null check (orden > 0),
  creado_en timestamptz not null default now(),
  -- El item pertenece exactamente a SU versión -- nunca a una
  -- curriculo_version/grado independientemente fabricados.
  foreign key (programa_analitico_version_id, curriculo_version_id, curriculo_grado_id)
    references public.programa_analitico_version (id, curriculo_version_id, curriculo_grado_id),
  -- El contenido oficial (cuando existe) pertenece a la curriculo_version
  -- correcta -- ya posible con el UNIQUE existente de V1-A.
  foreign key (curriculo_contenido_id, curriculo_version_id)
    references public.curriculo_contenido (id, curriculo_version_id),
  check (
    (tipo_decision = 'sin_ajuste' and curriculo_contenido_id is not null
      and texto_contextualizado is null and texto_local is null) or
    (tipo_decision = 'contextualizado' and curriculo_contenido_id is not null
      and texto_contextualizado is not null and btrim(texto_contextualizado) <> ''
      and texto_local is null) or
    (tipo_decision = 'nuevo' and curriculo_contenido_id is null
      and texto_contextualizado is null
      and texto_local is not null and btrim(texto_local) <> '')
  ),
  -- resultado_esperado_local: solo para 'nuevo', nunca "PDA local" ni
  -- "aprendizaje oficial" -- PA-1C §6.
  check (tipo_decision = 'nuevo' or resultado_esperado_local is null),
  check (resultado_esperado_local is null or btrim(resultado_esperado_local) <> ''),
  unique (programa_analitico_version_id, orden),
  -- Habilita la FK compuesta de programa_analitico_item_pda -- incluye
  -- curriculo_contenido_id NOT NULL implícito vía la propia FK: un item
  -- 'nuevo' (contenido_id NULL) nunca podrá tener una fila hija en
  -- item_pda porque esa FK exige un contenido_id NOT NULL que coincida
  -- -- ver Parte B, programa_analitico_item_pda (PA-1C §5).
  unique (id, curriculo_contenido_id, curriculo_version_id, curriculo_grado_id)
);

create index if not exists programa_analitico_item_version_idx
  on public.programa_analitico_item (programa_analitico_version_id);
create index if not exists programa_analitico_item_contenido_idx
  on public.programa_analitico_item (curriculo_contenido_id);
create index if not exists programa_analitico_item_periodo_idx
  on public.programa_analitico_item (periodo_evaluacion_id);

create table if not exists public.programa_analitico_item_pda (
  id uuid primary key default gen_random_uuid(),
  programa_analitico_item_id uuid not null,
  -- Denormalizado desde el item -- ver comentario de arriba.
  curriculo_contenido_id uuid not null,
  curriculo_version_id uuid not null,
  curriculo_grado_id uuid not null,
  curriculo_pda_grado_id uuid not null,
  -- item_pda pertenece exactamente al item correcto, al contenido
  -- correcto, a la curriculo_version correcta y al grado correcto --
  -- estructuralmente imposible para un item 'nuevo' (curriculo_contenido_id
  -- NULL en el item real, nunca puede igualar el NOT NULL exigido aquí).
  foreign key (programa_analitico_item_id, curriculo_contenido_id, curriculo_version_id, curriculo_grado_id)
    references public.programa_analitico_item (id, curriculo_contenido_id, curriculo_version_id, curriculo_grado_id),
  -- curriculo_pda_grado elegido pertenece exactamente al contenido,
  -- versión y grado del item -- vía el addendum de la Parte A.
  foreign key (curriculo_pda_grado_id, curriculo_grado_id, curriculo_contenido_id, curriculo_version_id)
    references public.curriculo_pda_grado (id, curriculo_grado_id, contenido_id, curriculo_version_id),
  unique (programa_analitico_item_id, curriculo_pda_grado_id)
);

create index if not exists programa_analitico_item_pda_item_idx
  on public.programa_analitico_item_pda (programa_analitico_item_id);
create index if not exists programa_analitico_item_pda_pdagrado_idx
  on public.programa_analitico_item_pda (curriculo_pda_grado_id);

-- ========== RLS ==========
--
-- Mismo patrón real ya usado en planeaciones/proyectos_seguimiento
-- (verificado): propiedad vía grupos.docente_id = auth.uid(). GRANT de
-- tabla NO se toca -- confirmado que anon/authenticated ya heredan
-- privilegios amplios por defecto en todo el esquema (igual que
-- curriculo_contenido/grupos/planeaciones, ninguna de las cuales tiene
-- GRANT explícito en su propia migración) -- RLS es la única barrera
-- real, igual que en el resto del proyecto.

alter table public.programa_analitico enable row level security;

create policy "programa_analitico_select" on public.programa_analitico
  for select
  using (exists (select 1 from public.grupos g where g.id = grupo_id and g.docente_id = auth.uid()));

create policy "programa_analitico_insert" on public.programa_analitico
  for insert
  with check (exists (select 1 from public.grupos g where g.id = grupo_id and g.docente_id = auth.uid()));

-- UPDATE necesario únicamente para mantener el puntero version_vigente_id.
create policy "programa_analitico_update" on public.programa_analitico
  for update
  using (exists (select 1 from public.grupos g where g.id = grupo_id and g.docente_id = auth.uid()))
  with check (exists (select 1 from public.grupos g where g.id = grupo_id and g.docente_id = auth.uid()));

-- Sin policy DELETE -- ninguna razón preexistente que la justifique.

alter table public.programa_analitico_version enable row level security;

create policy "programa_analitico_version_select" on public.programa_analitico_version
  for select
  using (exists (
    select 1 from public.programa_analitico pa
    join public.grupos g on g.id = pa.grupo_id
    where pa.id = programa_analitico_id and g.docente_id = auth.uid()
  ));

create policy "programa_analitico_version_insert" on public.programa_analitico_version
  for insert
  with check (exists (
    select 1 from public.programa_analitico pa
    join public.grupos g on g.id = pa.grupo_id
    where pa.id = programa_analitico_id and g.docente_id = auth.uid()
  ));

-- Sin UPDATE ni DELETE -- inmutabilidad real de versión (PA-1C §13):
-- RLS deniega por defecto sin política, sin necesitar ningún trigger.

alter table public.programa_analitico_item enable row level security;

create policy "programa_analitico_item_select" on public.programa_analitico_item
  for select
  using (exists (
    select 1 from public.programa_analitico_version v
    join public.programa_analitico pa on pa.id = v.programa_analitico_id
    join public.grupos g on g.id = pa.grupo_id
    where v.id = programa_analitico_version_id and g.docente_id = auth.uid()
  ));

create policy "programa_analitico_item_insert" on public.programa_analitico_item
  for insert
  with check (exists (
    select 1 from public.programa_analitico_version v
    join public.programa_analitico pa on pa.id = v.programa_analitico_id
    join public.grupos g on g.id = pa.grupo_id
    where v.id = programa_analitico_version_id and g.docente_id = auth.uid()
  ));

-- Sin UPDATE ni DELETE.

alter table public.programa_analitico_item_pda enable row level security;

create policy "programa_analitico_item_pda_select" on public.programa_analitico_item_pda
  for select
  using (exists (
    select 1 from public.programa_analitico_item i
    join public.programa_analitico_version v on v.id = i.programa_analitico_version_id
    join public.programa_analitico pa on pa.id = v.programa_analitico_id
    join public.grupos g on g.id = pa.grupo_id
    where i.id = programa_analitico_item_id and g.docente_id = auth.uid()
  ));

create policy "programa_analitico_item_pda_insert" on public.programa_analitico_item_pda
  for insert
  with check (exists (
    select 1 from public.programa_analitico_item i
    join public.programa_analitico_version v on v.id = i.programa_analitico_version_id
    join public.programa_analitico pa on pa.id = v.programa_analitico_id
    join public.grupos g on g.id = pa.grupo_id
    where i.id = programa_analitico_item_id and g.docente_id = auth.uid()
  ));

-- Sin UPDATE ni DELETE.

commit;
