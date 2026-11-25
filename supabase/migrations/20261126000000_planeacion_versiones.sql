-- Hito 2, etapa 1 — versiones canónicas de las planeaciones.
--
-- planeaciones sigue siendo la IDENTIDAD permanente (id, docente, grupo);
-- planeaciones.version pasa a ser el número de su versión VIGENTE.
-- planeacion_versiones guarda cada versión publicada, inmutable:
--   numero              — 1, 2, 3… único por planeación.
--   origen              — 'aprobacion' (primera aprobación, escrita por
--                         publicar_version_planeacion), 'modificacion'
--                         (versión N+1, misma función) o 'derivada'
--                         (reconstruida de forma determinista a partir de
--                         lo ya guardado: planeaciones anteriores y
--                         confirmaciones hechas por código sin versiones).
--   borrador_clave      — mensaje persistido del borrador que la originó
--                         ("msg:<mensajes_chat.id>"), único por docente:
--                         idempotencia de la publicación.
--   contenido           — texto canónico. Solo una versión 'derivada'
--                         puede no tenerlo: nunca se inventa.
--   estructura          — { planeacion: {...}, proyecto: {...} } con los
--                         campos estructurados de esa versión.
--   trazabilidad_curricular — esquema planeacion-curricular-v1 o null.
--   documento_word_archivo_id / documento_pdf_archivo_id — archivos
--                         ORIGINALES de esa versión (archivos_generados del
--                         mismo docente, 'activo'). Se llenan una sola vez
--                         (bajo demanda en versiones posteriores).
-- planeacion_proyectos queda como PROYECCIÓN de la versión vigente
-- (Evaluación y Seguimiento la siguen leyendo igual).
--
-- Escritura SOLO por funciones SECURITY DEFINER que verifican auth.uid():
--   publicar_version_planeacion — en una transacción, con la planeación
--     bloqueada: versión base 0 = primera aprobación (exige la concesión
--     propia del Hito 1, crea la versión 1 y confirma); base N ≥ 1 =
--     versión N+1 si la vigente sigue siendo N (si no: 'conflicto'), y
--     actualiza la proyección. Repetida con el mismo borrador:
--     'ya_publicada' (idempotente).
--   Disparadores:
--     - una confirmación 0→1 hecha sin la función (código anterior) deriva
--       su versión 1 en la misma transacción: nunca hay planeación
--       confirmada sin versión;
--     - planeaciones.version solo avanza a una versión existente (nunca
--       retrocede ni salta);
--     - una versión no cambia, salvo completar UNA vez un dato que faltaba
--       (texto de una derivada, Word/PDF);
--     - el registro de Historial de un Word completa el texto de su
--       versión derivada (mismo archivo, mismo docente).
-- Recuperación histórica determinista: texto SOLO del registro de
-- Historial ligado al Word de la planeación por archivo_id (índice único)
-- y del mismo docente; archivos solo si existen, son del docente y están
-- 'activo'; trazabilidad solo con el esquema canónico. Nunca por nombre,
-- fechas ni texto.
--
-- Permisos: authenticated solo lee sus versiones (RLS). Nadie escribe la
-- tabla directamente. anon sin acceso.
--
-- REQUISITO DE LA ETAPA 3: la recuperación de aprobaciones y de archivos
-- originales debe leer la versión correspondiente (borrador_clave), nunca
-- la proyección vigente; no se habilitan modificaciones conversacionales
-- (versiones N+1 desde el Chat) hasta cumplirlo.
--
-- REVERSIÓN (no toca planeaciones ni proyectos; elimina las versiones):
--   drop trigger documentos_generados_completa_version on public.documentos_generados;
--   drop trigger planeaciones_deriva_version_al_crear on public.planeaciones;
--   drop trigger planeaciones_deriva_version on public.planeaciones;
--   drop trigger planeaciones_version_existente on public.planeaciones;
--   drop table public.planeacion_versiones;
--   drop function public.publicar_version_planeacion(uuid, integer, text, text, jsonb, jsonb, uuid, uuid, uuid);
--   drop function public._derivar_version_planeacion(uuid);
--   drop function public._trg_planeaciones_deriva_version();
--   drop function public._trg_planeaciones_version_existente();
--   drop function public._trg_planeacion_versiones_inmutable();
--   drop function public._trg_documentos_generados_completa_version();
--   alter table public.planeaciones drop constraint planeaciones_id_docente_grupo_unico;

begin;

-- ============================================================
-- PRECONDICIONES
-- ============================================================
do $$
begin
  if to_regclass('public.planeacion_versiones') is not null
     or to_regprocedure('public.publicar_version_planeacion(uuid, integer, text, text, jsonb, jsonb, uuid, uuid, uuid)') is not null
     or exists (select 1 from pg_constraint where conname = 'planeaciones_id_docente_grupo_unico') then
    raise exception 'PRECONDICION_FALLIDA: la migración ya se aplicó (total o parcialmente).';
  end if;
  -- Depende del Hito 1 (identidad y concesión) y del registro de archivos.
  if (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'planeaciones'
        and column_name in ('borrador_clave', 'aprobacion_token', 'aprobacion_expira_en', 'version', 'grupo_id', 'docente_id', 'nombre', 'proposito', 'fecha_inicio', 'fecha_fin', 'campo_formativo', 'estado')) <> 12
     or to_regprocedure('public.consolidar_aprobacion_planeacion(uuid, uuid, jsonb, jsonb)') is null
     or not exists (select 1 from pg_constraint where conname = 'archivos_generados_id_docente_unico')
     or to_regclass('public.documentos_generados_archivo_unico') is null
     or to_regclass('public.planeacion_proyectos_planeacion_orden_unico') is null
     or to_regprocedure('auth.uid()') is null
     or (select count(*) from information_schema.columns where table_schema = 'public'
          and ((table_name = 'mensajes_chat' and column_name in ('id', 'conversacion_id', 'docente_id', 'rol'))
            or (table_name = 'conversaciones_chat' and column_name in ('id', 'docente_id', 'grupo_id', 'eliminada_en'))
            or (table_name = 'grupos' and column_name in ('id', 'docente_id')))) <> 10 then
    raise exception 'PRECONDICION_FALLIDA: faltan el Hito 1, el registro de archivos, auth.uid() o las tablas de mensajes, conversaciones y grupos.';
  end if;
  if exists (select 1 from public.planeaciones where version is null or version < 0) then
    raise exception 'PRECONDICION_FALLIDA: hay planeaciones con version nula o negativa.';
  end if;
end;
$$;

create temporary table _antes on commit drop as
  select (select count(*) from public.planeaciones) as planeaciones,
         (select count(*) from public.planeacion_proyectos) as proyectos,
         (select count(*) from public.documentos_generados) as documentos,
         (select count(*) from public.archivos_generados) as archivos,
         (select count(*) from public.planeaciones where version >= 1) as confirmadas,
         (select md5(string_agg(p::text, '|' order by p.id)) from public.planeaciones p) as huella_planeaciones,
         (select md5(string_agg(x::text, '|' order by x.id)) from public.planeacion_proyectos x) as huella_proyectos;

-- ============================================================
-- 1. Tabla de versiones
-- ============================================================
alter table public.planeaciones
  add constraint planeaciones_id_docente_grupo_unico unique (id, docente_id, grupo_id);

create table public.planeacion_versiones (
  id uuid primary key default gen_random_uuid(),
  planeacion_id uuid not null,
  docente_id uuid not null,
  grupo_id uuid not null,
  numero integer not null check (numero >= 1),
  origen text not null check (origen in ('aprobacion', 'modificacion', 'derivada')),
  borrador_clave text null check (borrador_clave ~ '^msg:.+$' and char_length(borrador_clave) <= 300),
  contenido text null,
  estructura jsonb not null check (jsonb_typeof(estructura) = 'object'),
  trazabilidad_curricular jsonb null check (trazabilidad_curricular is null or trazabilidad_curricular->>'esquema' = 'planeacion-curricular-v1'),
  documento_word_archivo_id uuid null,
  documento_pdf_archivo_id uuid null,
  creada_en timestamptz not null default now(),
  constraint planeacion_versiones_numero_unico unique (planeacion_id, numero),
  -- La versión pertenece a la planeación, a su docente y a su grupo.
  constraint planeacion_versiones_de_la_planeacion foreign key (planeacion_id, docente_id, grupo_id)
    references public.planeaciones (id, docente_id, grupo_id) on delete cascade,
  constraint planeacion_versiones_word_del_docente foreign key (documento_word_archivo_id, docente_id)
    references public.archivos_generados (id, docente_id),
  constraint planeacion_versiones_pdf_del_docente foreign key (documento_pdf_archivo_id, docente_id)
    references public.archivos_generados (id, docente_id),
  constraint planeacion_versiones_contenido_canonico check (contenido is not null or origen = 'derivada'),
  constraint planeacion_versiones_contenido_no_vacio check (contenido is null or length(btrim(contenido)) > 0),
  constraint planeacion_versiones_archivos_distintos check (documento_word_archivo_id is null or documento_word_archivo_id is distinct from documento_pdf_archivo_id)
);
create unique index planeacion_versiones_docente_borrador_unico
  on public.planeacion_versiones (docente_id, borrador_clave) where borrador_clave is not null;
create index planeacion_versiones_docente_grupo_idx on public.planeacion_versiones (docente_id, grupo_id, planeacion_id, numero desc);
create index planeacion_versiones_word_idx on public.planeacion_versiones (documento_word_archivo_id) where documento_word_archivo_id is not null;

alter table public.planeacion_versiones enable row level security;
revoke all on public.planeacion_versiones from public, anon, authenticated, service_role;
grant select on public.planeacion_versiones to authenticated, service_role;
create policy planeacion_versiones_select on public.planeacion_versiones
  for select to authenticated using (docente_id = auth.uid());

-- ============================================================
-- 2. Inmutabilidad: solo completar UNA vez un dato faltante
-- ============================================================
create function public._trg_planeacion_versiones_inmutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.id, new.planeacion_id, new.docente_id, new.grupo_id, new.numero, new.origen, new.borrador_clave, new.estructura, new.trazabilidad_curricular, new.creada_en)
     is distinct from (old.id, old.planeacion_id, old.docente_id, old.grupo_id, old.numero, old.origen, old.borrador_clave, old.estructura, old.trazabilidad_curricular, old.creada_en)
     or (old.contenido is not null and new.contenido is distinct from old.contenido)
     or (old.documento_word_archivo_id is not null and new.documento_word_archivo_id is distinct from old.documento_word_archivo_id)
     or (old.documento_pdf_archivo_id is not null and new.documento_pdf_archivo_id is distinct from old.documento_pdf_archivo_id) then
    raise exception 'VERSION_INMUTABLE: una versión publicada no se modifica.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger planeacion_versiones_inmutable before update on public.planeacion_versiones
  for each row execute function public._trg_planeacion_versiones_inmutable();

-- ============================================================
-- 3. Derivación determinista (planeaciones anteriores / confirmación sin versión)
-- ============================================================
create function public._derivar_version_planeacion(p_planeacion_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_pl public.planeaciones%rowtype;
  v_proy public.planeacion_proyectos%rowtype;
  v_n_proy integer;
  v_word uuid;
  v_pdf uuid;
  v_contenido text;
  v_traz jsonb;
  v_ref text;
begin
  select * into v_pl from public.planeaciones where id = p_planeacion_id;
  if not found or v_pl.version < 1 then return; end if;
  if exists (select 1 from public.planeacion_versiones where planeacion_id = p_planeacion_id) then return; end if;

  select count(*) into v_n_proy from public.planeacion_proyectos where planeacion_id = p_planeacion_id;
  -- Solo con UN proyecto la estructura es inequívoca.
  if v_n_proy = 1 then
    select * into v_proy from public.planeacion_proyectos where planeacion_id = p_planeacion_id;
    v_traz := case when v_proy.evaluacion->'trazabilidad_curricular'->>'esquema' = 'planeacion-curricular-v1' then v_proy.evaluacion->'trazabilidad_curricular' end;
    -- Archivos: solo identificadores válidos, del mismo docente y entregables.
    v_ref := v_proy.evaluacion->'documento_word'->>'archivo_id';
    if v_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select a.id into v_word from public.archivos_generados a where a.id = v_ref::uuid and a.docente_id = v_pl.docente_id and a.estado = 'activo';
    end if;
    v_ref := v_proy.evaluacion->'documento_pdf'->>'archivo_id';
    if v_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select a.id into v_pdf from public.archivos_generados a where a.id = v_ref::uuid and a.docente_id = v_pl.docente_id and a.estado = 'activo';
    end if;
    if v_pdf = v_word then v_pdf := null; end if;
    -- Texto: SOLO el registro de Historial de ese Word (único por archivo).
    if v_word is not null then
      select d.contenido into v_contenido from public.documentos_generados d
       where d.archivo_id = v_word and d.user_id = v_pl.docente_id and d.archivo_formato = 'word' and length(btrim(coalesce(d.contenido, ''))) > 0;
    end if;
  end if;

  insert into public.planeacion_versiones (planeacion_id, docente_id, grupo_id, numero, origen, borrador_clave, contenido, estructura, trazabilidad_curricular, documento_word_archivo_id, documento_pdf_archivo_id)
  values (
    v_pl.id, v_pl.docente_id, v_pl.grupo_id, v_pl.version, 'derivada', v_pl.borrador_clave, v_contenido,
    jsonb_build_object(
      'planeacion', jsonb_build_object('nombre', v_pl.nombre, 'proposito', v_pl.proposito, 'fecha_inicio', v_pl.fecha_inicio, 'fecha_fin', v_pl.fecha_fin, 'campo_formativo', v_pl.campo_formativo),
      'proyecto', case when v_n_proy = 1 then jsonb_build_object(
        'nombre', v_proy.nombre, 'campos_formativos', to_jsonb(v_proy.campos_formativos), 'contenidos', to_jsonb(v_proy.contenidos), 'pda', to_jsonb(v_proy.pda),
        'ejes_articuladores', to_jsonb(v_proy.ejes_articuladores), 'metodologia', v_proy.metodologia, 'duracion_dias', v_proy.duracion_dias,
        'actividades', v_proy.actividades, 'recursos', v_proy.recursos,
        'indicadores', v_proy.evaluacion->'indicadores', 'producto_final', v_proy.evaluacion->'producto_final', 'evidencias', v_proy.evaluacion->'evidencias') end
    ),
    v_traz, v_word, v_pdf);
end;
$$;

-- ============================================================
-- 4. Publicación atómica
-- ============================================================
-- Pertenencia verificada en la base (no se confía en el cliente): la
-- planeación y su grupo son del docente (auth.uid()), y el borrador es un
-- mensaje PERSISTIDO del asistente, del mismo docente, dentro de una
-- conversación suya no eliminada (su id empieza con el de la conversación)
-- y vinculada al grupo de la planeación (o sin grupo fijado, conversaciones
-- anteriores al vínculo de grupo).
-- Resultado: { "estado": "publicada" | "ya_publicada" | "conflicto" | "no_encontrada" | "datos_invalidos" | "archivo_invalido" | "borrador_no_valido",
--              "numero": n, "version_id": uuid }
create function public.publicar_version_planeacion(
  p_planeacion_id uuid,
  p_version_base integer,
  p_borrador_clave text,
  p_contenido text,
  p_estructura jsonb,
  p_trazabilidad jsonb,
  p_documento_word uuid default null,
  p_documento_pdf uuid default null,
  p_token uuid default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_pl public.planeaciones%rowtype;
  v_existente public.planeacion_versiones%rowtype;
  v_id uuid;
  v_numero integer;
  v_proy jsonb;
  v_n_proy integer;
begin
  if v_uid is null or p_planeacion_id is null or p_version_base is null or p_version_base < 0 then
    return jsonb_build_object('estado', 'no_encontrada');
  end if;
  -- Bloquea la planeación del docente: serializa publicaciones y aprobaciones.
  select * into v_pl from public.planeaciones where id = p_planeacion_id and docente_id = v_uid for update;
  if not found or not exists (select 1 from public.grupos g where g.id = v_pl.grupo_id and g.docente_id = v_uid) then
    return jsonb_build_object('estado', 'no_encontrada');
  end if;

  -- Idempotencia: el mismo borrador ya publicó una versión.
  if p_borrador_clave is not null then
    select * into v_existente from public.planeacion_versiones where docente_id = v_uid and borrador_clave = p_borrador_clave;
    if found then
      if v_existente.planeacion_id = p_planeacion_id then
        return jsonb_build_object('estado', 'ya_publicada', 'numero', v_existente.numero, 'version_id', v_existente.id);
      end if;
      return jsonb_build_object('estado', 'conflicto', 'numero', v_pl.version);
    end if;
  end if;

  if p_borrador_clave is null or p_borrador_clave !~ '^msg:.+$' or char_length(p_borrador_clave) > 300
     or p_contenido is null or length(btrim(p_contenido)) = 0
     or p_estructura is null or jsonb_typeof(p_estructura) <> 'object' or jsonb_typeof(p_estructura->'planeacion') is distinct from 'object'
     or (p_trazabilidad is not null and p_trazabilidad->>'esquema' is distinct from 'planeacion-curricular-v1')
     or (p_documento_word is not null and p_documento_word = p_documento_pdf) then
    return jsonb_build_object('estado', 'datos_invalidos');
  end if;
  if not exists (
       select 1 from public.mensajes_chat m join public.conversaciones_chat c on c.id = m.conversacion_id
        where m.id = substr(p_borrador_clave, 5) and m.docente_id = v_uid and m.rol = 'asistente'
          and c.docente_id = v_uid and c.eliminada_en is null and m.id like c.id::text || ':%'
          and (c.grupo_id is null or c.grupo_id = v_pl.grupo_id)) then
    return jsonb_build_object('estado', 'borrador_no_valido');
  end if;
  if (p_documento_word is not null and not exists (select 1 from public.archivos_generados where id = p_documento_word and docente_id = v_uid and estado = 'activo'))
     or (p_documento_pdf is not null and not exists (select 1 from public.archivos_generados where id = p_documento_pdf and docente_id = v_uid and estado = 'activo')) then
    return jsonb_build_object('estado', 'archivo_invalido');
  end if;

  if p_version_base = 0 then
    -- Primera aprobación (Hito 1): concesión propia y aún sin confirmar.
    if v_pl.version <> 0 or p_token is null or v_pl.aprobacion_token is distinct from p_token
       or v_pl.borrador_clave is distinct from p_borrador_clave then
      return jsonb_build_object('estado', 'conflicto', 'numero', v_pl.version);
    end if;
    insert into public.planeacion_versiones (planeacion_id, docente_id, grupo_id, numero, origen, borrador_clave, contenido, estructura, trazabilidad_curricular, documento_word_archivo_id, documento_pdf_archivo_id)
    values (v_pl.id, v_pl.docente_id, v_pl.grupo_id, 1, 'aprobacion', p_borrador_clave, p_contenido, p_estructura, p_trazabilidad, p_documento_word, p_documento_pdf)
    returning id into v_id;
    update public.planeaciones
       set version = 1, estado = 'publicada', aprobacion_token = null, aprobacion_expira_en = null, actualizado_en = now()
     where id = v_pl.id;
    return jsonb_build_object('estado', 'publicada', 'numero', 1, 'version_id', v_id);
  end if;

  -- Versión N+1 sobre la vigente N (optimista: si cambió, conflicto).
  if v_pl.version <> p_version_base then
    return jsonb_build_object('estado', 'conflicto', 'numero', v_pl.version);
  end if;
  select count(*) into v_n_proy from public.planeacion_proyectos where planeacion_id = v_pl.id;
  v_proy := p_estructura->'proyecto';
  if v_n_proy <> 1 or jsonb_typeof(v_proy) is distinct from 'object' then
    return jsonb_build_object('estado', 'datos_invalidos');
  end if;
  v_numero := p_version_base + 1;
  insert into public.planeacion_versiones (planeacion_id, docente_id, grupo_id, numero, origen, borrador_clave, contenido, estructura, trazabilidad_curricular, documento_word_archivo_id, documento_pdf_archivo_id)
  values (v_pl.id, v_pl.docente_id, v_pl.grupo_id, v_numero, 'modificacion', p_borrador_clave, p_contenido, p_estructura, p_trazabilidad, p_documento_word, p_documento_pdf)
  returning id into v_id;
  -- Proyección de la versión vigente: hoja, seguimiento y periodo se
  -- conservan; los archivos de la versión anterior dejan de ser vigentes.
  update public.planeacion_proyectos
     set nombre = coalesce(v_proy->>'nombre', nombre),
         campos_formativos = case when jsonb_typeof(v_proy->'campos_formativos') = 'array' then array(select jsonb_array_elements_text(v_proy->'campos_formativos')) else campos_formativos end,
         contenidos = case when jsonb_typeof(v_proy->'contenidos') = 'array' then array(select jsonb_array_elements_text(v_proy->'contenidos')) else contenidos end,
         pda = case when jsonb_typeof(v_proy->'pda') = 'array' then array(select jsonb_array_elements_text(v_proy->'pda')) else pda end,
         ejes_articuladores = case when jsonb_typeof(v_proy->'ejes_articuladores') = 'array' then array(select jsonb_array_elements_text(v_proy->'ejes_articuladores')) else ejes_articuladores end,
         metodologia = v_proy->>'metodologia',
         duracion_dias = (v_proy->>'duracion_dias')::integer,
         actividades = coalesce(v_proy->'actividades', '[]'::jsonb),
         recursos = coalesce(v_proy->'recursos', '[]'::jsonb),
         evaluacion = (evaluacion - 'documento_word' - 'documento_pdf' - 'trazabilidad_curricular' - 'indicadores' - 'producto_final' - 'evidencias')
                      || jsonb_strip_nulls(jsonb_build_object('indicadores', v_proy->'indicadores', 'producto_final', v_proy->'producto_final', 'evidencias', v_proy->'evidencias', 'trazabilidad_curricular', p_trazabilidad)),
         actualizado_en = now()
   where planeacion_id = v_pl.id;
  update public.planeaciones
     set version = v_numero,
         nombre = coalesce(p_estructura->'planeacion'->>'nombre', nombre),
         proposito = p_estructura->'planeacion'->>'proposito',
         fecha_inicio = coalesce((p_estructura->'planeacion'->>'fecha_inicio')::date, fecha_inicio),
         fecha_fin = coalesce((p_estructura->'planeacion'->>'fecha_fin')::date, fecha_fin),
         actualizado_en = now()
   where id = v_pl.id;
  return jsonb_build_object('estado', 'publicada', 'numero', v_numero, 'version_id', v_id);
end;
$$;

-- ============================================================
-- 5. Disparadores de integridad y compatibilidad
-- ============================================================
-- planeaciones.version solo avanza a una versión existente (0→1 lo cubre
-- la derivación; nunca retrocede ni salta).
create function public._trg_planeaciones_version_existente() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.version is distinct from old.version then
    if new.version is null or new.version < old.version or (old.version = 0 and new.version <> 1) then
      raise exception 'VERSION_INVALIDA: la versión de una planeación solo avanza a una versión publicada.' using errcode = 'P0001';
    end if;
    if old.version >= 1 and not exists (select 1 from public.planeacion_versiones where planeacion_id = new.id and numero = new.version) then
      raise exception 'VERSION_INVALIDA: la versión de una planeación solo avanza a una versión publicada.' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
create trigger planeaciones_version_existente before update of version on public.planeaciones
  for each row execute function public._trg_planeaciones_version_existente();

-- Confirmación 0→1 sin publicar_version_planeacion (código anterior), o
-- planeación creada ya confirmada (POST /api/planeaciones, version por
-- omisión 1): deriva su versión en la misma transacción.
create function public._trg_planeaciones_deriva_version() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public._derivar_version_planeacion(new.id);
  return null;
end;
$$;
create trigger planeaciones_deriva_version after update of version on public.planeaciones
  for each row when (old.version = 0 and new.version = 1) execute function public._trg_planeaciones_deriva_version();
create trigger planeaciones_deriva_version_al_crear after insert on public.planeaciones
  for each row when (new.version >= 1) execute function public._trg_planeaciones_deriva_version();

-- El Historial de un Word completa el texto de su versión derivada.
create function public._trg_documentos_generados_completa_version() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.planeacion_versiones
     set contenido = new.contenido
   where documento_word_archivo_id = new.archivo_id and docente_id = new.user_id
     and origen = 'derivada' and contenido is null;
  return null;
end;
$$;
create trigger documentos_generados_completa_version after insert on public.documentos_generados
  for each row when (new.archivo_id is not null and new.archivo_formato = 'word' and length(btrim(coalesce(new.contenido, ''))) > 0)
  execute function public._trg_documentos_generados_completa_version();

-- Funciones internas: nadie las invoca directamente.
revoke all on function public._derivar_version_planeacion(uuid) from public, anon, authenticated, service_role;
revoke all on function public._trg_planeacion_versiones_inmutable() from public, anon, authenticated, service_role;
revoke all on function public._trg_planeaciones_version_existente() from public, anon, authenticated, service_role;
revoke all on function public._trg_planeaciones_deriva_version() from public, anon, authenticated, service_role;
revoke all on function public._trg_documentos_generados_completa_version() from public, anon, authenticated, service_role;
revoke all on function public.publicar_version_planeacion(uuid, integer, text, text, jsonb, jsonb, uuid, uuid, uuid) from public, anon, service_role;
grant execute on function public.publicar_version_planeacion(uuid, integer, text, text, jsonb, jsonb, uuid, uuid, uuid) to authenticated;

-- ============================================================
-- 6. Recuperación histórica: versión vigente de cada planeación confirmada
-- ============================================================
do $$
declare r record;
begin
  for r in select id from public.planeaciones where version >= 1 order by creado_en, id loop
    perform public._derivar_version_planeacion(r.id);
  end loop;
end;
$$;

-- ============================================================
-- POSCONDICIONES
-- ============================================================
do $$
begin
  if (select count(*) from public.planeaciones) <> (select planeaciones from _antes)
     or (select count(*) from public.planeacion_proyectos) <> (select proyectos from _antes)
     or (select count(*) from public.documentos_generados) <> (select documentos from _antes)
     or (select count(*) from public.archivos_generados) <> (select archivos from _antes)
     or (select md5(string_agg(p::text, '|' order by p.id)) from public.planeaciones p) is distinct from (select huella_planeaciones from _antes)
     or (select md5(string_agg(x::text, '|' order by x.id)) from public.planeacion_proyectos x) is distinct from (select huella_proyectos from _antes) then
    raise exception 'POSCONDICION_FALLIDA: cambiaron registros existentes.';
  end if;
  -- Exactamente una versión por planeación confirmada, con su número vigente.
  if (select count(*) from public.planeacion_versiones) <> (select confirmadas from _antes)
     or exists (select 1 from public.planeaciones p where p.version >= 1 and not exists (select 1 from public.planeacion_versiones v where v.planeacion_id = p.id and v.numero = p.version and v.origen = 'derivada'))
     or exists (select 1 from public.planeacion_versiones v join public.planeaciones p on p.id = v.planeacion_id where p.version = 0) then
    raise exception 'POSCONDICION_FALLIDA: versiones históricas incompletas o de más.';
  end if;
  if not exists (select 1 from pg_proc where oid = to_regprocedure('public.publicar_version_planeacion(uuid, integer, text, text, jsonb, jsonb, uuid, uuid, uuid)') and prosecdef)
     or has_function_privilege('anon', 'public.publicar_version_planeacion(uuid, integer, text, text, jsonb, jsonb, uuid, uuid, uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.publicar_version_planeacion(uuid, integer, text, text, jsonb, jsonb, uuid, uuid, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public._derivar_version_planeacion(uuid)', 'execute')
     or has_table_privilege('authenticated', 'public.planeacion_versiones', 'insert, update, delete, truncate')
     or has_table_privilege('anon', 'public.planeacion_versiones', 'select, insert, update, delete')
     or has_table_privilege('service_role', 'public.planeacion_versiones', 'insert, update, delete, truncate')
     or not (select relrowsecurity from pg_class where oid = 'public.planeacion_versiones'::regclass) then
    raise exception 'POSCONDICION_FALLIDA: permisos o RLS distintos de lo esperado.';
  end if;
end;
$$;

commit;
