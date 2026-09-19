-- CURRÍCULO V1-A — ESQUEMA CANÓNICO MÍNIMO
--
-- Ver diseño aprobado "Arquitectura curricular multinivel/multigrado/
-- multigrupo — Contrato Canónico V1" + su refinamiento (Diseño B:
-- currículo estructurado con entidades explícitas y FK reales, en vez
-- de un nodo genérico). Esta migración crea EXCLUSIVAMENTE estructura:
-- tablas + FK + UNIQUE + CHECK + índices + RLS. Cero datos, cero RPC,
-- cero funciones, cero triggers (este proyecto no usa triggers en
-- ningún lado — toda la integridad de esta migración es declarativa:
-- FK simples y compuestas, UNIQUE, CHECK), cero embeddings, cero
-- Storage.
--
-- ALCANCE DE PRODUCTO (no del esquema, que nace universal): Docente IA
-- V1 curricular cubre Preescolar Fase 2, Primaria Fases 3-5 y
-- Secundaria Fase 6. Fase 1 / Educación Inicial queda fuera del
-- alcance actual — el esquema no la bloquea estructuralmente (ningún
-- CHECK la prohíbe), simplemente no se ingesta todavía. La ingesta
-- real (fuentes SEP, fases, grados, campos, contenidos, PDA, ejes) es
-- una microfase POSTERIOR, separada de esta.
--
-- FILOSOFÍA DE INMUTABILIDAD: una fuente oficial o una versión
-- curricular publicada/histórica NUNCA se borra — se historiza
-- cambiando `estado`. Por eso casi todas las FK de esta migración usan
-- ON DELETE RESTRICT (impide borrar accidentalmente algo que todavía
-- tiene referencias reales) en vez de CASCADE. CASCADE se reserva
-- exclusivamente para las 2 tablas puramente relacionales
-- (curriculo_fase_grado → curriculo_fase, curriculo_pda_grado →
-- curriculo_pda) que no tienen ninguna identidad histórica propia sin
-- su fila padre — ver justificación línea por línea abajo.
--
-- ESTADOS: solo curriculo_version tiene `estado` (borrador/vigente/
-- historico) — la versión completa es la unidad de publicación; fase/
-- contenido/pda/eje NO tienen estado propio (sin caso funcional real
-- hoy que lo requiera — evita el escenario "versión vigente + PDA
-- histórico" sin ninguna razón real detrás).
--
-- CLAVES: clave_oficial es SIEMPRE nullable — nunca se presupone que
-- SEP publica una clave estable para cada Contenido/PDA. NO se agrega
-- ninguna "clave_interna" técnica todavía (sin caso funcional
-- concreto por ahora, ver ajuste aprobado) — el UUID de cada fila ES
-- la identidad interna estable; si la ingesta demuestra después una
-- necesidad real de clave técnica propia, se diseñará en esa
-- microfase, nunca confundida con una clave oficial.
--
-- RLS: lectura para cualquier docente autenticado (currículo oficial
-- nacional, no aislado por institución/grupo — mismo criterio que
-- "instituciones" ya usa con `to authenticated`, ver
-- 20260809230000_restringir_lectura_publica_calendario_e_instituciones.sql).
-- CERO política de insert/update/delete para `authenticated` en
-- ninguna de las 11 tablas — la única vía de escritura es un proceso
-- administrativo con `service_role`, que bypasea RLS por diseño de
-- Postgres/Supabase sin necesitar ninguna política adicional. Ningún
-- docente puede alterar la fuente curricular canónica bajo ningún
-- caso.
--
-- Idempotente en el sentido real que ya usa el resto del proyecto:
-- `create table if not exists`, `create index if not exists`, `drop
-- policy if exists` antes de cada `create policy` — protege una
-- re-ejecución benigna en el mismo entorno, no es (ni pretende ser)
-- un sistema de reconciliación de schema.
--
-- Rollback (destructivo — solo si hace falta revertir por completo,
-- nunca confundir con volver a correr esta migración, que no lo es):
--   begin;
--   drop table if exists public.curriculo_eje_articulador;
--   drop table if exists public.curriculo_pda_grado;
--   drop table if exists public.curriculo_pda;
--   drop table if exists public.curriculo_contenido;
--   drop table if exists public.curriculo_campo_formativo;
--   drop table if exists public.curriculo_fase_grado;
--   drop table if exists public.curriculo_fase;
--   drop table if exists public.curriculo_grado;
--   drop table if exists public.curriculo_version;
--   drop table if exists public.fuente_oficial_fragmento;
--   drop table if exists public.fuente_oficial;
--   commit;

-- ========== FUENTES OFICIALES ==========

create table if not exists public.fuente_oficial (
  id uuid primary key default gen_random_uuid(),
  organismo text not null,
  titulo text not null,
  tipo_documento text not null
    check (tipo_documento in ('acuerdo', 'programa_sintetico', 'plan_de_estudio', 'libro_texto', 'otro')),
  version_edicion text not null,
  fecha_publicacion date,
  vigente_desde date,
  vigente_hasta date,
  -- Conserva la URL oficial exacta de origen cuando exista — NO es
  -- obligatorio descargar/copiar el documento completo a Storage:
  -- url_fuente + hash_archivo pueden ser, por sí solos, el mecanismo
  -- real de conservación/trazabilidad.
  url_fuente text,
  hash_archivo text,
  storage_path text,
  estado text not null default 'vigente' check (estado in ('vigente', 'historico', 'borrador')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists fuente_oficial_estado_idx
  on public.fuente_oficial (estado);

alter table public.fuente_oficial enable row level security;

drop policy if exists "fuente_oficial_select_autenticado" on public.fuente_oficial;
create policy "fuente_oficial_select_autenticado" on public.fuente_oficial
  for select to authenticated using (true);

create table if not exists public.fuente_oficial_fragmento (
  id uuid primary key default gen_random_uuid(),
  -- RESTRICT (ajuste aprobado — NO CASCADE): un fragmento nunca debe
  -- desaparecer por accidente mientras exista contenido/PDA que lo
  -- cite para trazabilidad. La limpieza explícita de una fuente mal
  -- cargada en borrador (sin nada todavía citándola) es una operación
  -- deliberada futura, nunca un efecto secundario de borrar la fuente.
  fuente_oficial_id uuid not null references public.fuente_oficial(id) on delete restrict,
  pagina int,
  seccion text,
  texto text not null,
  orden int not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (fuente_oficial_id, orden)
);

create index if not exists fuente_oficial_fragmento_fuente_idx
  on public.fuente_oficial_fragmento (fuente_oficial_id);

alter table public.fuente_oficial_fragmento enable row level security;

drop policy if exists "fuente_oficial_fragmento_select_autenticado" on public.fuente_oficial_fragmento;
create policy "fuente_oficial_fragmento_select_autenticado" on public.fuente_oficial_fragmento
  for select to authenticated using (true);

-- ========== CURRÍCULO CANÓNICO ==========

create table if not exists public.curriculo_version (
  id uuid primary key default gen_random_uuid(),
  organismo text not null,
  nombre text not null,
  acuerdo_oficial text,
  -- RESTRICT: la fuente raíz de una versión no puede desaparecer
  -- mientras la versión la cite.
  fuente_oficial_id uuid references public.fuente_oficial(id) on delete restrict,
  vigente_desde date,
  vigente_hasta date,
  -- Único estado real del árbol curricular — ver comentario de
  -- cabecera. fase/contenido/pda/eje heredan conceptualmente el estado
  -- de su versión, sin columna propia.
  estado text not null default 'borrador' check (estado in ('borrador', 'vigente', 'historico')),
  created_at timestamptz not null default now()
);

create index if not exists curriculo_version_estado_idx
  on public.curriculo_version (estado);

alter table public.curriculo_version enable row level security;

drop policy if exists "curriculo_version_select_autenticado" on public.curriculo_version;
create policy "curriculo_version_select_autenticado" on public.curriculo_version
  for select to authenticated using (true);

create table if not exists public.curriculo_grado (
  id uuid primary key default gen_random_uuid(),
  nivel_educativo text not null check (nivel_educativo in ('preescolar', 'primaria', 'secundaria')),
  -- Catálogo pequeño y estable — resuelve la ambigüedad real de que
  -- "grado='1'" significa cosas distintas en cada nivel_educativo
  -- (preescolar+1, primaria+1, secundaria+1 son identidades
  -- inequívocamente distintas gracias al UNIQUE compuesto de abajo).
  clave text not null,
  nombre text not null,
  orden int not null,
  unique (nivel_educativo, clave),
  -- Requerido para la FK compuesta de curriculo_fase_grado más abajo.
  unique (id, nivel_educativo)
);

alter table public.curriculo_grado enable row level security;

drop policy if exists "curriculo_grado_select_autenticado" on public.curriculo_grado;
create policy "curriculo_grado_select_autenticado" on public.curriculo_grado
  for select to authenticated using (true);

create table if not exists public.curriculo_fase (
  id uuid primary key default gen_random_uuid(),
  curriculo_version_id uuid not null references public.curriculo_version(id) on delete restrict,
  nivel_educativo text not null check (nivel_educativo in ('preescolar', 'primaria', 'secundaria')),
  clave text not null,
  nombre text not null,
  unique (curriculo_version_id, nivel_educativo, clave),
  -- Requerido por la FK compuesta de curriculo_contenido (integridad
  -- de versión) y por la de curriculo_fase_grado (integridad de nivel).
  unique (id, curriculo_version_id),
  unique (id, nivel_educativo)
);

create index if not exists curriculo_fase_version_idx
  on public.curriculo_fase (curriculo_version_id);

alter table public.curriculo_fase enable row level security;

drop policy if exists "curriculo_fase_select_autenticado" on public.curriculo_fase;
create policy "curriculo_fase_select_autenticado" on public.curriculo_fase
  for select to authenticated using (true);

-- Fase↔Grado — relación estructurada (reemplaza el text[] descartado).
-- nivel_educativo denormalizado a propósito: habilita las 2 FK
-- compuestas de abajo, que impiden emparejar una fase con un grado de
-- OTRO nivel_educativo (p. ej. fase de primaria + grado de
-- secundaria) — barato porque son solo 2 saltos sobre columnas que ya
-- existían, a diferencia de la cadena completa hasta PDA (descartada
-- explícitamente por sobre-normalización, ver diseño aprobado — esa
-- comprobación cruzada queda para el pipeline de ingesta).
create table if not exists public.curriculo_fase_grado (
  id uuid primary key default gen_random_uuid(),
  curriculo_fase_id uuid not null,
  curriculo_grado_id uuid not null,
  nivel_educativo text not null,
  unique (curriculo_fase_id, curriculo_grado_id),
  -- CASCADE: fila puramente relacional, sin identidad histórica propia
  -- — si la fase se elimina deliberadamente (ya bloqueada por RESTRICT
  -- en curriculo_contenido mientras tenga contenido real), esta liga
  -- no tiene ningún sentido sin ella.
  foreign key (curriculo_fase_id, nivel_educativo)
    references public.curriculo_fase (id, nivel_educativo) on delete cascade,
  -- RESTRICT: curriculo_grado es catálogo estable — nunca perder
  -- ligas fase↔grado por un borrado accidental del lado del grado.
  foreign key (curriculo_grado_id, nivel_educativo)
    references public.curriculo_grado (id, nivel_educativo) on delete restrict
);

create index if not exists curriculo_fase_grado_fase_idx
  on public.curriculo_fase_grado (curriculo_fase_id);
create index if not exists curriculo_fase_grado_grado_idx
  on public.curriculo_fase_grado (curriculo_grado_id);

alter table public.curriculo_fase_grado enable row level security;

drop policy if exists "curriculo_fase_grado_select_autenticado" on public.curriculo_fase_grado;
create policy "curriculo_fase_grado_select_autenticado" on public.curriculo_fase_grado
  for select to authenticated using (true);

create table if not exists public.curriculo_campo_formativo (
  id uuid primary key default gen_random_uuid(),
  curriculo_version_id uuid not null references public.curriculo_version(id) on delete restrict,
  clave text not null,
  nombre text not null,
  unique (curriculo_version_id, clave),
  unique (id, curriculo_version_id)
);

create index if not exists curriculo_campo_formativo_version_idx
  on public.curriculo_campo_formativo (curriculo_version_id);

alter table public.curriculo_campo_formativo enable row level security;

drop policy if exists "curriculo_campo_formativo_select_autenticado" on public.curriculo_campo_formativo;
create policy "curriculo_campo_formativo_select_autenticado" on public.curriculo_campo_formativo
  for select to authenticated using (true);

create table if not exists public.curriculo_contenido (
  id uuid primary key default gen_random_uuid(),
  curriculo_version_id uuid not null references public.curriculo_version(id) on delete restrict,
  fase_id uuid not null,
  campo_formativo_id uuid not null,
  -- NUNCA se presupone que SEP da una clave oficial estable para cada
  -- contenido — nullable a propósito. El UUID de esta fila es la
  -- identidad interna real y estable.
  clave_oficial text,
  titulo text not null,
  -- RESTRICT: nunca perder la cita a la fuente mientras el contenido exista.
  fuente_oficial_fragmento_id uuid references public.fuente_oficial_fragmento(id) on delete restrict,
  -- Integridad de versión, declarativa (sin trigger): fase_id y
  -- campo_formativo_id DEBEN pertenecer a la MISMA curriculo_version_id
  -- que este contenido — imposible mezclar nodos de versiones
  -- distintas. RESTRICT: nunca perder contenido por borrar
  -- accidentalmente su fase/campo.
  foreign key (fase_id, curriculo_version_id)
    references public.curriculo_fase (id, curriculo_version_id) on delete restrict,
  foreign key (campo_formativo_id, curriculo_version_id)
    references public.curriculo_campo_formativo (id, curriculo_version_id) on delete restrict,
  -- Requerido por la FK compuesta de curriculo_pda (integridad de versión).
  unique (id, curriculo_version_id)
);

create index if not exists curriculo_contenido_version_idx
  on public.curriculo_contenido (curriculo_version_id);
create index if not exists curriculo_contenido_fase_idx
  on public.curriculo_contenido (fase_id);
create index if not exists curriculo_contenido_campo_idx
  on public.curriculo_contenido (campo_formativo_id);

alter table public.curriculo_contenido enable row level security;

drop policy if exists "curriculo_contenido_select_autenticado" on public.curriculo_contenido;
create policy "curriculo_contenido_select_autenticado" on public.curriculo_contenido
  for select to authenticated using (true);

create table if not exists public.curriculo_pda (
  id uuid primary key default gen_random_uuid(),
  curriculo_version_id uuid not null references public.curriculo_version(id) on delete restrict,
  contenido_id uuid not null,
  -- Igual que contenido: nullable, nunca se presupone clave oficial.
  clave_oficial text,
  texto text not null,
  fuente_oficial_fragmento_id uuid references public.fuente_oficial_fragmento(id) on delete restrict,
  -- El PDA no puede apuntar a un contenido de otra versión.
  foreign key (contenido_id, curriculo_version_id)
    references public.curriculo_contenido (id, curriculo_version_id) on delete restrict
);

create index if not exists curriculo_pda_version_idx
  on public.curriculo_pda (curriculo_version_id);
create index if not exists curriculo_pda_contenido_idx
  on public.curriculo_pda (contenido_id);

alter table public.curriculo_pda enable row level security;

drop policy if exists "curriculo_pda_select_autenticado" on public.curriculo_pda;
create policy "curriculo_pda_select_autenticado" on public.curriculo_pda
  for select to authenticated using (true);

-- PDA↔Grado — relación estructurada (aprobada; NO text[]). Esto es lo
-- que representa el hecho curricular verificado: un mismo contenido de
-- Fase 4 puede tener PDA distintos para 3er y 4to grado — cada fila
-- aquí es una aplicabilidad real, nunca inferida por Claude.
create table if not exists public.curriculo_pda_grado (
  id uuid primary key default gen_random_uuid(),
  -- CASCADE: fila puramente relacional, sin identidad propia sin su PDA.
  curriculo_pda_id uuid not null references public.curriculo_pda(id) on delete cascade,
  -- RESTRICT: catálogo estable, nunca perder aplicabilidad por un
  -- borrado accidental del lado del grado.
  curriculo_grado_id uuid not null references public.curriculo_grado(id) on delete restrict,
  unique (curriculo_pda_id, curriculo_grado_id)
);

create index if not exists curriculo_pda_grado_pda_idx
  on public.curriculo_pda_grado (curriculo_pda_id);
create index if not exists curriculo_pda_grado_grado_idx
  on public.curriculo_pda_grado (curriculo_grado_id);

alter table public.curriculo_pda_grado enable row level security;

drop policy if exists "curriculo_pda_grado_select_autenticado" on public.curriculo_pda_grado;
create policy "curriculo_pda_grado_select_autenticado" on public.curriculo_pda_grado
  for select to authenticated using (true);

-- Ejes articuladores — SOLO catálogo versionado, transversal. NO se
-- modela como hijo de contenido/PDA (sería una jerarquía falsa — el
-- mismo eje toca muchos contenidos de muchos campos). NO se crea
-- todavía curriculo_contenido_eje — sin evidencia documental explícita
-- de que SEP ate ejes a contenidos específicos; esa relación, si
-- llega a hacer falta, se resuelve más adelante vía Programa
-- Analítico/Planeación, nunca aquí sin evidencia real.
create table if not exists public.curriculo_eje_articulador (
  id uuid primary key default gen_random_uuid(),
  curriculo_version_id uuid not null references public.curriculo_version(id) on delete restrict,
  clave text not null,
  nombre text not null,
  unique (curriculo_version_id, clave)
);

create index if not exists curriculo_eje_articulador_version_idx
  on public.curriculo_eje_articulador (curriculo_version_id);

alter table public.curriculo_eje_articulador enable row level security;

drop policy if exists "curriculo_eje_articulador_select_autenticado" on public.curriculo_eje_articulador;
create policy "curriculo_eje_articulador_select_autenticado" on public.curriculo_eje_articulador
  for select to authenticated using (true);
