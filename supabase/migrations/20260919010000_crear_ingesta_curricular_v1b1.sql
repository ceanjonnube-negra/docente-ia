-- CURRÍCULO V1-B-1 — STAGING MÍNIMO DE INGESTA + COBERTURA CURRICULAR
--
-- Ver diseño aprobado "Currículo V1-B — pipeline de ingesta inteligente,
-- reutilizable y seguro" + su rediseño (staging mínimo: ejecución +
-- candidatos JSONB, en vez de 11 tablas espejo de V1-A). Esta migración
-- crea EXCLUSIVAMENTE 3 tablas: ingesta_curricular,
-- ingesta_curricular_candidato, curriculo_cobertura. Estructura
-- únicamente. Cero datos, cero RPC, cero funciones, cero triggers (este
-- proyecto no usa triggers en ningún lado), cero cambios a las 11 tablas
-- de V1-A (20260919000000_crear_curriculo_v1a_esquema.sql), que
-- permanece intacta.
--
-- ALCANCE FUNCIONAL V1 (producto, no del esquema): Preescolar (Fase 2) y
-- Primaria (Fases 3, 4, 5). Secundaria/Fase 6 queda fuera de la ingesta
-- V1 por decisión de producto — ni aquí ni en V1-A el esquema la
-- bloquea estructuralmente a propósito, para conservar compatibilidad
-- futura sin invertir tiempo ahora en su ingesta/validación.
--
-- STAGING ES DESECHABLE, NUNCA FUENTE DE VERDAD: ingesta_curricular e
-- ingesta_curricular_candidato son infraestructura operacional temporal
-- del pipeline. Su JSONB (payload/evidencia/scope_solicitado) representa
-- candidatos, nunca currículo oficial. La única fuente de verdad
-- publicada sigue siendo, exclusivamente, las 11 tablas de V1-A. Por
-- eso staging NO tiene FK hacia las tablas canónicas de V1-A — la
-- integridad fuerte ocurre en los validadores del pipeline (código
-- futuro) y, finalmente, en las FK/CHECK/UNIQUE de V1-A al publicar.
--
-- IDENTIDAD DE EJECUCIÓN Y SCOPE_HASH: scope_solicitado (jsonb) guarda
-- el scope legible/estructurado que pidió la ejecución. scope_hash
-- (text) es la identidad determinista de ese mismo scope, calculada por
-- el pipeline (fuera de PostgreSQL, no en esta microfase) sobre una
-- representación canónica (nivel + fase + grados ordenados sin
-- duplicados + campos ordenados sin duplicados) — nunca se deriva aquí
-- de scope_solicitado directamente, evitando depender de que la
-- igualdad de jsonb sea estable ante reordenamientos accidentales de
-- claves/arrays.
--
-- PROTECCIÓN DE EJECUCIÓN ACTIVA DUPLICADA: el índice único parcial
-- sobre (fuente_hash, perfil_extractor, version_pipeline, scope_hash)
-- WHERE estado='en_progreso' evita arrancar dos ejecuciones activas
-- idénticas por doble disparo/reintento accidental. Incluye
-- perfil_extractor y version_pipeline a propósito: una versión nueva del
-- pipeline/extractor debe poder reprocesar legítimamente la misma
-- fuente y el mismo scope sin chocar con una ejecución antigua ya
-- terminada. NO es la protección real contra duplicar currículo
-- publicado — esa es curriculo_cobertura (ver abajo); este índice es
-- solo una guardia operacional contra ejecuciones activas simultáneas.
--
-- COBERTURA — EXISTENCIA = ESTADO (sin columna estado_cobertura): en V1
-- la sola presencia de una fila en curriculo_cobertura para
-- (curriculo_version_id, fase_id, grado_id, campo_formativo_id) SIGNIFICA
-- "ese scope está cargado y validado localmente". Su ausencia significa
-- "sin cobertura local para ese scope" — sin importar si
-- curriculo_version.estado='vigente' o no. VIGENCIA OFICIAL
-- (curriculo_version.estado) y COBERTURA LOCAL (esta tabla) son hechos
-- distintos y deliberadamente independientes: una versión puede estar
-- oficialmente vigente con cobertura solo parcial, y eso es válido.
-- Planeación NUNCA debe usar curriculo_version.estado='vigente' como
-- evidencia de currículo completo — siempre debe comprobar cobertura
-- para el scope exacto que necesita. No se agrega ninguna columna de
-- estado adicional aquí porque, en V1, el único valor posible sería
-- siempre el mismo — si aparece una necesidad real de más estados, se
-- hará una migración específica entonces, nunca especulativamente.
--
-- 1 CAMPO EXTRAÍDO → N GRADOS CUBIERTOS: el UNIQUE de cobertura es por
-- combinación (versión, fase, grado, campo), no "una cobertura por
-- campo" — una sola operación de publicación de un campo completo
-- puede insertar, en una misma transacción, una fila de cobertura por
-- cada grado que quedó realmente validado (p. ej. Fase 4 + 3° + campo X
-- y Fase 4 + 4° + campo X a la vez), sin necesitar corridas separadas
-- por grado. curriculo_contenido (en V1-A) nunca se duplica por grado —
-- un contenido pertenece a versión+fase+campo; son curriculo_pda /
-- curriculo_pda_grado los que se diferencian por grado, y es sobre esa
-- diferenciación real que se decide cuántas filas de cobertura generar.
--
-- BLOQUEO DE SEGUNDA PUBLICACIÓN DEL MISMO SCOPE: doble barrera,
-- deliberadamente redundante. (1) Aplicación (código futuro, no aquí):
-- antes de escribir, consulta cobertura para cada combinación
-- (fase,grado,campo) que va a escribir; si TODAS ya existen, no escribe
-- nada y responde SCOPE_YA_PUBLICADO; si hay solape PARCIAL, aborta
-- completo sin escribir nada — nunca "rellena lo que falta"
-- silenciosamente. Una republicación deliberada de un scope ya cubierto
-- (corregir/reemplazar) es una operación explícita futura, distinta de
-- la ingesta normal. (2) Base de datos: el UNIQUE de cobertura es el
-- backstop real ante condiciones de carrera — si dos publicaciones
-- corrieran simultáneamente, la segunda violaría el UNIQUE dentro de su
-- transacción y provocaría ROLLBACK completo, nunca una fila duplicada
-- ni un estado a medias.
--
-- FK RESTRICT en curriculo_cobertura, sin FK compuestas: nivel_educativo
-- está denormalizado a propósito para consulta directa sin join; su
-- consistencia contra fase_id/grado_id la verifica el VALIDADOR de
-- publicación (fase pertenece a versión; grado pertenece a fase; campo
-- pertenece a versión), no una FK compuesta — cobertura es una tabla
-- derivada/resumen sin identidad curricular propia, no le aplicamos el
-- mismo nivel de rigor declarativo que a las 11 tablas de V1-A (evita
-- repetir la "cadena absurda de columnas duplicadas" ya descartada en
-- V1-A).
--
-- CANONICAL_ID uuid simple (no canonical_ref jsonb): las 11 tablas
-- canónicas de V1-A comparten `id uuid primary key` de forma
-- homogénea. La columna `tipo` de cada candidato ya identifica sin
-- ambigüedad a qué tabla canónica corresponde (incluidos los tipos
-- relacionales/join: fase_grado, pda_grado), así que un
-- canonical_ref{tabla,id} sería redundante con tipo, sin aportar
-- información nueva.
--
-- RLS: ingesta_curricular e ingesta_curricular_candidato tienen RLS
-- habilitado y CERO policies — infraestructura operacional del
-- pipeline, exclusivamente accesible vía service_role (bypasea RLS por
-- diseño); ningún docente autenticado tiene ningún camino de lectura ni
-- escritura, ni siquiera de candidatos ya confirmados, evitando que se
-- exponga texto todavía no validado. curriculo_cobertura sigue el mismo
-- criterio que las 11 tablas de V1-A: lectura para cualquier docente
-- autenticado (currículo oficial nacional, no aislado por
-- institución/grupo), cero política de insert/update/delete para
-- authenticated bajo ningún caso — la única vía de escritura es un
-- proceso administrativo con service_role.
--
-- Idempotente en el sentido real que ya usa el resto del proyecto:
-- `create table if not exists`, `create index if not exists`, `drop
-- policy if exists` antes de la única `create policy` — protege una
-- re-ejecución benigna en el mismo entorno, no es (ni pretende ser) un
-- sistema de reconciliación de schema.
--
-- Rollback (destructivo — solo si hace falta revertir por completo,
-- nunca confundir con volver a correr esta migración, que no lo es):
--   begin;
--   drop table if exists public.curriculo_cobertura;
--   drop table if exists public.ingesta_curricular_candidato;
--   drop table if exists public.ingesta_curricular;
--   commit;

-- ========== INGESTA CURRICULAR (identidad de ejecución) ==========

create table if not exists public.ingesta_curricular (
  id uuid primary key default gen_random_uuid(),
  fuente_hash text not null,
  fuente_url text,
  perfil_extractor text not null,
  version_pipeline text not null,
  -- Scope legible/estructurado de esta ejecución. Ver scope_hash abajo
  -- para la identidad determinista equivalente.
  scope_solicitado jsonb not null,
  -- Identidad determinista del scope, calculada por el pipeline sobre
  -- una representación canónica (nivel + fase + grados ordenados sin
  -- duplicados + campos ordenados sin duplicados). NO se genera dentro
  -- de PostgreSQL en esta microfase — el pipeline la calcula antes del
  -- INSERT.
  scope_hash text not null,
  estado text not null default 'en_progreso'
    check (estado in ('en_progreso', 'completado', 'fallido', 'descartado')),
  iniciado_en timestamptz not null default now(),
  finalizado_en timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

-- Evita arrancar dos ejecuciones ACTIVAS idénticas (misma fuente, mismo
-- perfil de extracción, misma versión de pipeline, mismo scope) por
-- doble disparo/reintento accidental. Parcial: solo aplica mientras
-- estado='en_progreso'. Reintentar con la misma identidad una vez que
-- la ejecución anterior ya terminó es el caso normal que resuelve
-- curriculo_cobertura en la publicación (SCOPE_YA_PUBLICADO), no este
-- índice.
create unique index if not exists ingesta_curricular_activa_unica_idx
  on public.ingesta_curricular (fuente_hash, perfil_extractor, version_pipeline, scope_hash)
  where estado = 'en_progreso';

create index if not exists ingesta_curricular_estado_idx
  on public.ingesta_curricular (estado);

alter table public.ingesta_curricular enable row level security;
-- Sin ninguna policy — ver nota RLS de cabecera. RLS habilitado sin
-- policies deja la tabla invisible para `authenticated`; solo
-- `service_role` puede operarla.

-- ========== CANDIDATOS DE INGESTA ==========

create table if not exists public.ingesta_curricular_candidato (
  id uuid primary key default gen_random_uuid(),
  -- CASCADE: un candidato no tiene ninguna identidad propia fuera de su
  -- ejecución de ingesta — staging es desechable por diseño.
  ingesta_id uuid not null references public.ingesta_curricular(id) on delete cascade,
  tipo text not null check (tipo in (
    'fuente', 'fragmento', 'version', 'fase', 'grado', 'fase_grado',
    'campo', 'contenido', 'pda', 'pda_grado', 'eje'
  )),
  -- Identidad DENTRO de esta ejecución (ej. "contenido#3" o un slug
  -- determinista) — no es identidad canónica.
  clave_local text not null,
  -- Referencia a otro clave_local del mismo ingesta_id (árbol lógico
  -- del candidato dentro de la ejecución).
  parent_local text,
  -- Forma estructurada correspondiente a las columnas de negocio de la
  -- tabla canónica destino (según `tipo`). Nunca es fuente de verdad
  -- curricular por sí sola — solo candidato.
  payload jsonb not null,
  -- Hash del contenido normalizado + scope padre, usado por el
  -- pipeline para detectar candidatos equivalentes dentro/entre
  -- ejecuciones. Vive solo aquí, nunca se traslada a las tablas
  -- canónicas de V1-A.
  fingerprint text,
  -- {pagina, top, bottom, fragmento_local, texto_original,
  -- texto_normalizado, normalizacion_aplicada} — estructura definida a
  -- nivel de aplicación, no de constraint SQL.
  evidencia jsonb not null default '{}'::jsonb,
  estado_validacion text not null default 'candidato'
    check (estado_validacion in ('candidato', 'normalizado', 'confirmado', 'dudoso', 'invalido')),
  origen text not null check (origen in ('regla', 'ia', 'mixto')),
  errores jsonb not null default '[]'::jsonb,
  -- Se llena SOLO tras publicar exitosamente en la tabla canónica que
  -- corresponda según `tipo`; null = aún no publicado.
  canonical_id uuid,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  unique (ingesta_id, clave_local)
);

create index if not exists ingesta_curricular_candidato_ingesta_idx
  on public.ingesta_curricular_candidato (ingesta_id);
create index if not exists ingesta_curricular_candidato_tipo_idx
  on public.ingesta_curricular_candidato (tipo);
create index if not exists ingesta_curricular_candidato_estado_idx
  on public.ingesta_curricular_candidato (estado_validacion);
create index if not exists ingesta_curricular_candidato_fingerprint_idx
  on public.ingesta_curricular_candidato (fingerprint);

alter table public.ingesta_curricular_candidato enable row level security;
-- Sin ninguna policy — mismo criterio que ingesta_curricular.

-- ========== COBERTURA CURRICULAR ==========

create table if not exists public.curriculo_cobertura (
  id uuid primary key default gen_random_uuid(),
  -- RESTRICT: mismo criterio de inmutabilidad que V1-A — nunca perder
  -- cobertura por un borrado accidental del lado de la versión/fase/
  -- grado/campo.
  curriculo_version_id uuid not null references public.curriculo_version(id) on delete restrict,
  -- Denormalizado a propósito para consulta directa sin join. Ver nota
  -- de cabecera sobre por qué esto NO usa FK compuestas.
  nivel_educativo text not null check (nivel_educativo in ('preescolar', 'primaria', 'secundaria')),
  fase_id uuid not null references public.curriculo_fase(id) on delete restrict,
  grado_id uuid not null references public.curriculo_grado(id) on delete restrict,
  campo_formativo_id uuid not null references public.curriculo_campo_formativo(id) on delete restrict,
  publicado_en timestamptz not null default now(),
  -- Existencia de la fila = scope cargado y validado. Ausencia = sin
  -- cobertura local. Frontera fuerte de idempotencia de publicación.
  unique (curriculo_version_id, fase_id, grado_id, campo_formativo_id)
);

create index if not exists curriculo_cobertura_version_idx
  on public.curriculo_cobertura (curriculo_version_id);
create index if not exists curriculo_cobertura_fase_grado_idx
  on public.curriculo_cobertura (fase_id, grado_id);
create index if not exists curriculo_cobertura_campo_idx
  on public.curriculo_cobertura (campo_formativo_id);

alter table public.curriculo_cobertura enable row level security;

drop policy if exists "curriculo_cobertura_select_autenticado" on public.curriculo_cobertura;
create policy "curriculo_cobertura_select_autenticado" on public.curriculo_cobertura
  for select to authenticated using (true);
