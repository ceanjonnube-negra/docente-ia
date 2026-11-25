-- Hito 2, etapa 3 (parte 1) — protección de evaluaciones al publicar una
-- versión N+1 de una planeación.
--
-- Hojas de evaluación con historial:
--   hojas_evaluacion.reemplazada_por / reemplazada_en — una hoja
--     reemplazada se conserva tal cual (código, indicadores, roster y PDF
--     originales). UNA sola hoja vigente por proyecto (índice parcial; antes
--     UNIQUE(proyecto_id)). proyectos_seguimiento.hoja_id apunta siempre a
--     la vigente (disparador).
--   planeacion_versiones.hoja_id — la hoja que correspondía a esa versión al
--     publicarse. Versiones existentes: la hoja del proyecto de seguimiento
--     vinculado EXPLÍCITAMENTE a su proyecto de planeación
--     (proyectos_seguimiento.planeacion_proyecto_id); sin ese vínculo, null.
--
-- publicar_version_planeacion (versión N+1), en la MISMA transacción, con
-- la planeación y el proyecto de seguimiento bloqueados:
--   - indicadores iguales a los congelados en la hoja vigente → se conserva;
--   - distintos, sin capturas ni resultados → hoja NUEVA (código nuevo,
--     indicadores congelados, sin PDF aún), la anterior queda reemplazada y
--     el proyecto apunta a la nueva (estado 'planeado' hasta tener PDF);
--   - distintos, con capturas, resultados o correcciones → nada de la
--     evaluación cambia; la versión queda ligada a la hoja original y el
--     resultado lo indica ('evaluacion_protegida').
--   En los tres casos, el nombre y las fechas VIGENTES del proyecto de
--   seguimiento se sincronizan con la versión (metadatos, no evaluación).
--   El PDF de la hoja nueva se genera después, fuera de la transacción, con
--   el generador idempotente de siempre (completa la hoja vigente sin PDF;
--   nunca crea otra).
-- confirmar_resultados_hoja — confirmación ATÓMICA (resultados + estado)
--   solo sobre la hoja vigente esperada y en 'requiere_revision', con todos
--   los datos validados en el servidor.
--
-- OBLIGATORIO ANTES DE PRODUCTION: tras publicar el código que confirma con
-- esta RPC, aplicar supabase/migraciones-diferidas/
-- 20261128000000_resultados_solo_por_rpc.sql (cierra la escritura directa de
-- resultados por REST; la RPC queda como única vía).
--
-- Integridad (disparadores; las políticas RLS no cambian):
--   - una hoja no cambia su proyecto, código, fecha, indicadores ni (una
--     vez congelado) su roster; una reemplazada no cambia nada; solo la
--     publicación puede marcarla como reemplazada;
--   - proyectos_seguimiento.hoja_id solo apunta a la hoja vigente de ESE
--     proyecto.
--
-- Compatible con el código publicado: mientras no se publique una versión
-- N+1 (que solo hace el código nuevo), cada proyecto conserva una única
-- hoja y todas las consultas existentes siguen igual.
--
-- REVERSIÓN (solo si no hay hojas reemplazadas):
--   drop function public.confirmar_resultados_hoja(uuid, uuid, jsonb);
--   drop trigger proyectos_seguimiento_hoja_vigente on public.proyectos_seguimiento;
--   drop trigger hojas_evaluacion_conservada on public.hojas_evaluacion;
--   drop function public._trg_proyectos_seguimiento_hoja_vigente();
--   drop function public._trg_hojas_evaluacion_conservada();
--   (y restaurar publicar_version_planeacion, _derivar_version_planeacion y
--    _trg_planeacion_versiones_inmutable de 20261126000000)
--   alter table public.planeacion_versiones drop column hoja_id;
--   drop index public.hojas_evaluacion_vigente_por_proyecto;
--   alter table public.hojas_evaluacion add constraint hojas_evaluacion_proyecto_id_key unique (proyecto_id);
--   alter table public.hojas_evaluacion drop column reemplazada_en, drop column reemplazada_por;

begin;

-- ============================================================
-- PRECONDICIONES
-- ============================================================
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'hojas_evaluacion' and column_name in ('reemplazada_por', 'reemplazada_en'))
     or exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'planeacion_versiones' and column_name = 'hoja_id')
     or to_regprocedure('public.confirmar_resultados_hoja(uuid, uuid, jsonb)') is not null then
    raise exception 'PRECONDICION_FALLIDA: la migración ya se aplicó (total o parcialmente).';
  end if;
  if to_regprocedure('public.publicar_version_planeacion(uuid, integer, text, text, jsonb, jsonb, uuid, uuid, uuid)') is null
     or to_regclass('public.planeacion_versiones') is null then
    raise exception 'PRECONDICION_FALLIDA: falta la etapa 1 (20261126000000_planeacion_versiones).';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'hojas_evaluacion_proyecto_id_key')
     or (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'proyectos_seguimiento'
          and column_name in ('hoja_id', 'estado', 'captura_pendiente', 'confirmado_en', 'confirmado_por', 'origen_resultados', 'planeacion_proyecto_id', 'nombre', 'fecha_inicio', 'fecha_fin')) <> 10
     or (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'seguimiento_resultados'
          and column_name in ('proyecto_id', 'alumno_id', 'inscripcion_id', 'indicador_especifico', 'aspecto_general', 'nivel', 'confianza', 'corregido_manualmente', 'fuente_correccion', 'observacion', 'indicador_numero', 'actualizado_en')) <> 12
     or to_regclass('public.seguimiento_versiones') is null
     or not exists (select 1 from pg_constraint where conname = 'seguimiento_resultados_proyecto_inscripcion_indicador_key') then
    raise exception 'PRECONDICION_FALLIDA: el esquema de evaluación no es el esperado.';
  end if;
  if exists (select 1 from public.proyectos_seguimiento ps where ps.hoja_id is not null
              and not exists (select 1 from public.hojas_evaluacion h where h.id = ps.hoja_id and h.proyecto_id = ps.id)) then
    raise exception 'PRECONDICION_FALLIDA: algún proyecto apunta a una hoja de otro proyecto.';
  end if;
end;
$$;

create temporary table _antes on commit drop as
  select (select md5(coalesce(string_agg(h::text, '|' order by h.id), '')) from public.hojas_evaluacion h) as hojas,
         (select md5(coalesce(string_agg(p::text, '|' order by p.id), '')) from public.proyectos_seguimiento p) as seguimientos,
         (select md5(coalesce(string_agg(r::text, '|' order by r.id), '')) from public.seguimiento_resultados r) as resultados,
         (select md5(coalesce(string_agg(v::text, '|' order by v.id), '')) from public.seguimiento_versiones v) as correcciones,
         (select count(*) from public.planeacion_versiones) as versiones;

-- ============================================================
-- 1. Hojas con historial: una vigente por proyecto
-- ============================================================
alter table public.hojas_evaluacion
  add column reemplazada_por uuid null,
  add column reemplazada_en timestamptz null,
  add constraint hojas_evaluacion_reemplazo_completo check ((reemplazada_por is null) = (reemplazada_en is null)),
  add constraint hojas_evaluacion_reemplazada_por_fkey foreign key (reemplazada_por) references public.hojas_evaluacion (id) deferrable initially deferred;
alter table public.hojas_evaluacion drop constraint hojas_evaluacion_proyecto_id_key;
create unique index hojas_evaluacion_vigente_por_proyecto on public.hojas_evaluacion (proyecto_id) where reemplazada_por is null;
create index hojas_evaluacion_proyecto_idx on public.hojas_evaluacion (proyecto_id);

-- Una hoja conserva su identidad y sus criterios; una reemplazada no cambia
-- nada; solo la publicación (marca de transacción) la reemplaza.
create function public._trg_hojas_evaluacion_conservada() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.id is distinct from old.id or new.proyecto_id is distinct from old.proyecto_id
     or new.identificador_visible is distinct from old.identificador_visible or new.generado_en is distinct from old.generado_en
     or (old.indicadores is not null and new.indicadores is distinct from old.indicadores)
     or (old.roster_congelado is not null and new.roster_congelado is distinct from old.roster_congelado)
     or (old.reemplazada_por is not null and (row(new.*) is distinct from row(old.*)))
     or (old.reemplazada_por is null and new.reemplazada_por is not null
         and current_setting('docente_ia.reemplazo_hoja', true) is distinct from old.id::text) then
    raise exception 'HOJA_CONSERVADA: una hoja de evaluación no cambia su identidad ni sus criterios.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger hojas_evaluacion_conservada before update on public.hojas_evaluacion
  for each row execute function public._trg_hojas_evaluacion_conservada();

-- El proyecto solo apunta a SU hoja vigente.
create function public._trg_proyectos_seguimiento_hoja_vigente() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.hoja_id is not null and not exists (
       select 1 from public.hojas_evaluacion h where h.id = new.hoja_id and h.proyecto_id = new.id and h.reemplazada_por is null) then
    raise exception 'HOJA_NO_VIGENTE: el proyecto solo puede usar su hoja de evaluación vigente.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger proyectos_seguimiento_hoja_vigente before insert or update of hoja_id on public.proyectos_seguimiento
  for each row execute function public._trg_proyectos_seguimiento_hoja_vigente();

-- ============================================================
-- 2. Hoja de cada versión
-- ============================================================
alter table public.planeacion_versiones
  add column hoja_id uuid null references public.hojas_evaluacion (id);
create index planeacion_versiones_hoja_idx on public.planeacion_versiones (hoja_id) where hoja_id is not null;

-- Inmutable, salvo completar UNA vez un dato faltante (texto de una
-- derivada, Word/PDF, hoja).
create or replace function public._trg_planeacion_versiones_inmutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.id, new.planeacion_id, new.docente_id, new.grupo_id, new.numero, new.origen, new.borrador_clave, new.estructura, new.trazabilidad_curricular, new.creada_en)
     is distinct from (old.id, old.planeacion_id, old.docente_id, old.grupo_id, old.numero, old.origen, old.borrador_clave, old.estructura, old.trazabilidad_curricular, old.creada_en)
     or (old.contenido is not null and new.contenido is distinct from old.contenido)
     or (old.documento_word_archivo_id is not null and new.documento_word_archivo_id is distinct from old.documento_word_archivo_id)
     or (old.documento_pdf_archivo_id is not null and new.documento_pdf_archivo_id is distinct from old.documento_pdf_archivo_id)
     or (old.hoja_id is not null and new.hoja_id is distinct from old.hoja_id) then
    raise exception 'VERSION_INMUTABLE: una versión publicada no se modifica.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- Hoja del proyecto de seguimiento vinculado explícitamente a la planeación
-- (un solo proyecto de planeación). null si no hay vínculo inequívoco.
create function public._hoja_de_planeacion(p_planeacion_id uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select ps.hoja_id
    from public.planeacion_proyectos pp
    join public.proyectos_seguimiento ps on ps.planeacion_proyecto_id = pp.id
   where pp.planeacion_id = p_planeacion_id
     and (select count(*) from public.planeacion_proyectos x where x.planeacion_id = p_planeacion_id) = 1
     and (select count(*) from public.proyectos_seguimiento y where y.planeacion_proyecto_id = pp.id) = 1
$$;

-- Versiones existentes (todas son la vigente de su planeación, de la etapa 1).
update public.planeacion_versiones v
   set hoja_id = public._hoja_de_planeacion(v.planeacion_id)
 where v.hoja_id is null
   and v.numero = (select p.version from public.planeaciones p where p.id = v.planeacion_id);

-- La derivación (confirmación sin la función) también liga la hoja.
create or replace function public._derivar_version_planeacion(p_planeacion_id uuid) returns void
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
  if v_n_proy = 1 then
    select * into v_proy from public.planeacion_proyectos where planeacion_id = p_planeacion_id;
    v_traz := case when v_proy.evaluacion->'trazabilidad_curricular'->>'esquema' = 'planeacion-curricular-v1' then v_proy.evaluacion->'trazabilidad_curricular' end;
    v_ref := v_proy.evaluacion->'documento_word'->>'archivo_id';
    if v_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select a.id into v_word from public.archivos_generados a where a.id = v_ref::uuid and a.docente_id = v_pl.docente_id and a.estado = 'activo';
    end if;
    v_ref := v_proy.evaluacion->'documento_pdf'->>'archivo_id';
    if v_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select a.id into v_pdf from public.archivos_generados a where a.id = v_ref::uuid and a.docente_id = v_pl.docente_id and a.estado = 'activo';
    end if;
    if v_pdf = v_word then v_pdf := null; end if;
    if v_word is not null then
      select d.contenido into v_contenido from public.documentos_generados d
       where d.archivo_id = v_word and d.user_id = v_pl.docente_id and d.archivo_formato = 'word' and length(btrim(coalesce(d.contenido, ''))) > 0;
    end if;
  end if;

  insert into public.planeacion_versiones (planeacion_id, docente_id, grupo_id, numero, origen, borrador_clave, contenido, estructura, trazabilidad_curricular, documento_word_archivo_id, documento_pdf_archivo_id, hoja_id)
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
    v_traz, v_word, v_pdf, public._hoja_de_planeacion(v_pl.id));
end;
$$;

-- ============================================================
-- 3. Publicación con protección de la evaluación
-- ============================================================
drop function public.publicar_version_planeacion(uuid, integer, text, text, jsonb, jsonb, uuid, uuid, uuid);

-- Resultado: { "estado": ..., "numero", "version_id",
--              "hoja": { "estado": "conservada" | "reemplazada" | "evaluacion_protegida" | "sin_hoja", "id", "anterior_id" } }
-- p_indicadores_hoja: indicadores congelados de la hoja para la versión N+1
--   ([{numero_indicador, indicador_especifico, aspecto_general}], 1..5);
--   p_identificador_hoja: código nuevo por si la hoja se reemplaza
--   ('identificador_ocupado' → el llamador reintenta con otro).
create function public.publicar_version_planeacion(
  p_planeacion_id uuid,
  p_version_base integer,
  p_borrador_clave text,
  p_contenido text,
  p_estructura jsonb,
  p_trazabilidad jsonb,
  p_documento_word uuid default null,
  p_documento_pdf uuid default null,
  p_token uuid default null,
  p_indicadores_hoja jsonb default null,
  p_identificador_hoja text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_pl public.planeaciones%rowtype;
  v_existente public.planeacion_versiones%rowtype;
  v_ps public.proyectos_seguimiento%rowtype;
  v_hoja public.hojas_evaluacion%rowtype;
  v_id uuid;
  v_numero integer;
  v_proy jsonb;
  v_n_proy integer;
  v_pp uuid;
  v_hoja_version uuid;
  v_estado_hoja text := 'sin_hoja';
  v_nueva uuid;
  v_iguales boolean;
  v_protegida boolean;
begin
  if v_uid is null or p_planeacion_id is null or p_version_base is null or p_version_base < 0 then
    return jsonb_build_object('estado', 'no_encontrada');
  end if;
  select * into v_pl from public.planeaciones where id = p_planeacion_id and docente_id = v_uid for update;
  if not found or not exists (select 1 from public.grupos g where g.id = v_pl.grupo_id and g.docente_id = v_uid) then
    return jsonb_build_object('estado', 'no_encontrada');
  end if;

  if p_borrador_clave is not null then
    select * into v_existente from public.planeacion_versiones where docente_id = v_uid and borrador_clave = p_borrador_clave;
    if found then
      if v_existente.planeacion_id = p_planeacion_id then
        return jsonb_build_object('estado', 'ya_publicada', 'numero', v_existente.numero, 'version_id', v_existente.id, 'hoja', jsonb_build_object('estado', 'ya_publicada', 'id', v_existente.hoja_id));
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
    if v_pl.version <> 0 or p_token is null or v_pl.aprobacion_token is distinct from p_token
       or v_pl.borrador_clave is distinct from p_borrador_clave then
      return jsonb_build_object('estado', 'conflicto', 'numero', v_pl.version);
    end if;
    v_hoja_version := public._hoja_de_planeacion(v_pl.id);
    insert into public.planeacion_versiones (planeacion_id, docente_id, grupo_id, numero, origen, borrador_clave, contenido, estructura, trazabilidad_curricular, documento_word_archivo_id, documento_pdf_archivo_id, hoja_id)
    values (v_pl.id, v_pl.docente_id, v_pl.grupo_id, 1, 'aprobacion', p_borrador_clave, p_contenido, p_estructura, p_trazabilidad, p_documento_word, p_documento_pdf, v_hoja_version)
    returning id into v_id;
    update public.planeaciones
       set version = 1, estado = 'publicada', aprobacion_token = null, aprobacion_expira_en = null, actualizado_en = now()
     where id = v_pl.id;
    return jsonb_build_object('estado', 'publicada', 'numero', 1, 'version_id', v_id, 'hoja', jsonb_build_object('estado', case when v_hoja_version is null then 'sin_hoja' else 'conservada' end, 'id', v_hoja_version));
  end if;

  if v_pl.version <> p_version_base then
    return jsonb_build_object('estado', 'conflicto', 'numero', v_pl.version);
  end if;
  select count(*) into v_n_proy from public.planeacion_proyectos where planeacion_id = v_pl.id;
  v_proy := p_estructura->'proyecto';
  if v_n_proy <> 1 or jsonb_typeof(v_proy) is distinct from 'object' then
    return jsonb_build_object('estado', 'datos_invalidos');
  end if;
  select id into v_pp from public.planeacion_proyectos where planeacion_id = v_pl.id;
  v_numero := p_version_base + 1;

  -- Evaluación: el proyecto de seguimiento vinculado, bloqueado (la captura
  -- también lo bloquea: nunca se intercalan).
  select * into v_ps from public.proyectos_seguimiento where planeacion_proyecto_id = v_pp and docente_id = v_uid for update;
  if found and v_ps.hoja_id is not null then
    select * into v_hoja from public.hojas_evaluacion where id = v_ps.hoja_id for update;
    if p_indicadores_hoja is null or jsonb_typeof(p_indicadores_hoja) <> 'array'
       or jsonb_array_length(p_indicadores_hoja) not between 1 and 5
       or exists (select 1 from jsonb_array_elements(p_indicadores_hoja) with ordinality as e(x, i)
                   where jsonb_typeof(e.x) <> 'object'
                      or (e.x->>'numero_indicador') is distinct from e.i::text
                      or length(btrim(coalesce(e.x->>'indicador_especifico', ''))) = 0
                      or coalesce(e.x->>'aspecto_general', '') not in ('logro_aprendizaje', 'aplicacion_aprendizajes', 'participacion_colaboracion')) then
      return jsonb_build_object('estado', 'datos_invalidos');
    end if;
    -- Mismos criterios: mismo número, texto (normalizado) y aspecto.
    v_iguales := coalesce((select array_agg(lower(btrim(x->>'indicador_especifico')) || '|' || (x->>'aspecto_general') order by (x->>'numero_indicador')::int) from jsonb_array_elements(v_hoja.indicadores) x), '{}')
               = (select array_agg(lower(btrim(x->>'indicador_especifico')) || '|' || (x->>'aspecto_general') order by (x->>'numero_indicador')::int) from jsonb_array_elements(p_indicadores_hoja) x);
    v_protegida := v_ps.estado not in ('planeado', 'hoja_generada') or v_ps.captura_pendiente is not null or v_ps.confirmado_en is not null
                   or exists (select 1 from public.seguimiento_resultados r where r.proyecto_id = v_ps.id)
                   or exists (select 1 from public.seguimiento_versiones sv where sv.proyecto_id = v_ps.id);
    if v_iguales then
      v_hoja_version := v_hoja.id; v_estado_hoja := 'conservada';
    elsif v_protegida then
      v_hoja_version := v_hoja.id; v_estado_hoja := 'evaluacion_protegida';
    else
      if p_identificador_hoja is null or p_identificador_hoja !~ '^SG-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$' then
        return jsonb_build_object('estado', 'datos_invalidos');
      end if;
      if exists (select 1 from public.hojas_evaluacion where identificador_visible = p_identificador_hoja) then
        return jsonb_build_object('estado', 'identificador_ocupado');
      end if;
      v_nueva := gen_random_uuid();
      perform set_config('docente_ia.reemplazo_hoja', v_hoja.id::text, true);
      update public.hojas_evaluacion set reemplazada_por = v_nueva, reemplazada_en = now() where id = v_hoja.id;
      perform set_config('docente_ia.reemplazo_hoja', '', true);
      insert into public.hojas_evaluacion (id, proyecto_id, identificador_visible, indicadores)
      values (v_nueva, v_ps.id, p_identificador_hoja, p_indicadores_hoja);
      update public.proyectos_seguimiento set hoja_id = v_nueva, estado = 'planeado', actualizado_en = now() where id = v_ps.id;
      v_hoja_version := v_nueva; v_estado_hoja := 'reemplazada';
    end if;
  end if;
  -- Metadatos VIGENTES del proyecto de seguimiento (nombre y fechas): siempre
  -- los de la versión publicada, se conserve, reemplace o proteja la hoja.
  -- Nunca se tocan los datos congelados de la evaluación (hojas, sus
  -- indicadores, roster y PDF, capturas, resultados ni correcciones).
  if v_ps.id is not null then
    update public.proyectos_seguimiento
       set nombre = coalesce(v_proy->>'nombre', nombre),
           fecha_inicio = coalesce((p_estructura->'planeacion'->>'fecha_inicio')::date, fecha_inicio),
           fecha_fin = coalesce((p_estructura->'planeacion'->>'fecha_fin')::date, fecha_fin),
           actualizado_en = now()
     where id = v_ps.id;
  end if;

  insert into public.planeacion_versiones (planeacion_id, docente_id, grupo_id, numero, origen, borrador_clave, contenido, estructura, trazabilidad_curricular, documento_word_archivo_id, documento_pdf_archivo_id, hoja_id)
  values (v_pl.id, v_pl.docente_id, v_pl.grupo_id, v_numero, 'modificacion', p_borrador_clave, p_contenido, p_estructura, p_trazabilidad, p_documento_word, p_documento_pdf, v_hoja_version)
  returning id into v_id;
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
                      || jsonb_strip_nulls(jsonb_build_object('indicadores', v_proy->'indicadores', 'producto_final', v_proy->'producto_final', 'evidencias', v_proy->'evidencias', 'trazabilidad_curricular', p_trazabilidad))
                      || case when v_estado_hoja = 'reemplazada' then jsonb_build_object('hoja_id', v_nueva, 'hoja_identificador_visible', p_identificador_hoja) else '{}'::jsonb end,
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
  return jsonb_build_object('estado', 'publicada', 'numero', v_numero, 'version_id', v_id,
    'hoja', jsonb_build_object('estado', v_estado_hoja, 'id', v_hoja_version, 'anterior_id', case when v_estado_hoja = 'reemplazada' then v_hoja.id end));
end;
$$;

-- ============================================================
-- 4. Confirmación atómica de resultados
-- ============================================================
-- SECURITY INVOKER: RLS del docente. Solo sobre la hoja vigente esperada,
-- en 'requiere_revision'; resultados y estado en una transacción.
create function public.confirmar_resultados_hoja(p_proyecto_id uuid, p_hoja_id uuid, p_filas jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_ps public.proyectos_seguimiento%rowtype;
  v_hoja public.hojas_evaluacion%rowtype;
  v_n integer;
begin
  if v_uid is null then return jsonb_build_object('estado', 'no_encontrado'); end if;
  -- Pertenencia explícita (también como SECURITY DEFINER, tras la migración
  -- diferida): el proyecto es del docente y su grupo también.
  select * into v_ps from public.proyectos_seguimiento where id = p_proyecto_id and docente_id = v_uid for update;
  if not found or not exists (select 1 from public.grupos g where g.id = v_ps.grupo_id and g.docente_id = v_uid) then
    return jsonb_build_object('estado', 'no_encontrado');
  end if;
  if v_ps.hoja_id is distinct from p_hoja_id then return jsonb_build_object('estado', 'hoja_cambiada'); end if;
  select * into v_hoja from public.hojas_evaluacion where id = p_hoja_id and proyecto_id = p_proyecto_id and reemplazada_por is null;
  if not found then return jsonb_build_object('estado', 'hoja_cambiada'); end if;
  if v_ps.estado <> 'requiere_revision' then return jsonb_build_object('estado', 'estado_invalido', 'estado_actual', v_ps.estado); end if;
  -- Validación en el servidor (nunca solo la del cliente):
  --   - cada fila es de ESTE proyecto, de un alumno del roster congelado
  --     (inscripción y alumno) y de un indicador de la hoja;
  --   - nivel del catálogo, confianza 0..1, origen de corrección conocido;
  --   - cobertura EXACTA: cada alumno × cada indicador, una sola vez.
  -- El texto y el aspecto de cada indicador se toman de la hoja congelada,
  -- nunca de lo que mande el cliente.
  if p_filas is null or jsonb_typeof(p_filas) <> 'array' or jsonb_array_length(p_filas) = 0
     or jsonb_typeof(v_hoja.roster_congelado) is distinct from 'array' or jsonb_typeof(v_hoja.indicadores) is distinct from 'array'
     or exists (select 1 from jsonb_array_elements(p_filas) f
                 where jsonb_typeof(f) <> 'object'
                    or (f->>'proyecto_id') is distinct from p_proyecto_id::text
                    or not exists (select 1 from jsonb_array_elements(v_hoja.roster_congelado) a
                                    where a->>'inscripcion_id' = f->>'inscripcion_id' and a->>'alumno_id' = f->>'alumno_id')
                    or not exists (select 1 from jsonb_array_elements(v_hoja.indicadores) i
                                    where i->>'numero_indicador' = f->>'indicador_numero')
                    or coalesce(f->>'nivel', '') not in ('destacado', 'logrado', 'en_proceso', 'requiere_apoyo', 'no_evaluado')
                    or (f->>'confianza' is not null and (jsonb_typeof(f->'confianza') <> 'number' or (f->>'confianza')::numeric not between 0 and 1))
                    or (f->'corregido_manualmente' is not null and jsonb_typeof(f->'corregido_manualmente') <> 'boolean')
                    or (f->>'fuente_correccion' is not null and f->>'fuente_correccion' <> 'docente'))
     or (select count(*) from jsonb_array_elements(p_filas)) <> jsonb_array_length(v_hoja.roster_congelado) * jsonb_array_length(v_hoja.indicadores)
     or (select count(distinct (f->>'inscripcion_id', f->>'indicador_numero')) from jsonb_array_elements(p_filas) f) <> jsonb_array_length(p_filas) then
    return jsonb_build_object('estado', 'datos_invalidos');
  end if;
  insert into public.seguimiento_resultados (proyecto_id, alumno_id, inscripcion_id, indicador_especifico, aspecto_general, nivel, confianza, corregido_manualmente, fuente_correccion, observacion, indicador_numero)
  select p_proyecto_id, (f->>'alumno_id')::uuid, (f->>'inscripcion_id')::uuid, i->>'indicador_especifico', i->>'aspecto_general', f->>'nivel',
         (f->>'confianza')::numeric, coalesce((f->>'corregido_manualmente')::boolean, false), f->>'fuente_correccion', f->>'observacion', (f->>'indicador_numero')::smallint
    from jsonb_array_elements(p_filas) f
    join jsonb_array_elements(v_hoja.indicadores) i on i->>'numero_indicador' = f->>'indicador_numero'
  on conflict (proyecto_id, inscripcion_id, indicador_numero) do update
     set alumno_id = excluded.alumno_id, indicador_especifico = excluded.indicador_especifico, aspecto_general = excluded.aspecto_general,
         nivel = excluded.nivel, confianza = excluded.confianza, corregido_manualmente = excluded.corregido_manualmente,
         fuente_correccion = excluded.fuente_correccion, observacion = excluded.observacion, actualizado_en = now();
  get diagnostics v_n = row_count;
  update public.proyectos_seguimiento
     set estado = 'confirmado', confirmado_en = now(), confirmado_por = v_uid, origen_resultados = 'fotografia', actualizado_en = now()
   where id = p_proyecto_id;
  return jsonb_build_object('estado', 'confirmado', 'resultados', v_n);
end;
$$;

revoke all on function public._trg_hojas_evaluacion_conservada() from public, anon, authenticated, service_role;
revoke all on function public._trg_proyectos_seguimiento_hoja_vigente() from public, anon, authenticated, service_role;
revoke all on function public._hoja_de_planeacion(uuid) from public, anon, authenticated, service_role;
revoke all on function public._derivar_version_planeacion(uuid) from public, anon, authenticated, service_role;
revoke all on function public._trg_planeacion_versiones_inmutable() from public, anon, authenticated, service_role;
revoke all on function public.publicar_version_planeacion(uuid, integer, text, text, jsonb, jsonb, uuid, uuid, uuid, jsonb, text) from public, anon, service_role;
grant execute on function public.publicar_version_planeacion(uuid, integer, text, text, jsonb, jsonb, uuid, uuid, uuid, jsonb, text) to authenticated;
revoke all on function public.confirmar_resultados_hoja(uuid, uuid, jsonb) from public, anon, service_role;
grant execute on function public.confirmar_resultados_hoja(uuid, uuid, jsonb) to authenticated;

-- ============================================================
-- POSCONDICIONES
-- ============================================================
do $$
begin
  if (select md5(coalesce(string_agg(r::text, '|' order by r.id), '')) from public.seguimiento_resultados r) is distinct from (select resultados from _antes)
     or (select md5(coalesce(string_agg(v::text, '|' order by v.id), '')) from public.seguimiento_versiones v) is distinct from (select correcciones from _antes)
     or (select md5(coalesce(string_agg(p::text, '|' order by p.id), '')) from public.proyectos_seguimiento p) is distinct from (select seguimientos from _antes)
     or (select count(*) from public.planeacion_versiones) <> (select versiones from _antes) then
    raise exception 'POSCONDICION_FALLIDA: cambiaron seguimientos, resultados, correcciones o versiones.';
  end if;
  -- Hojas existentes: mismas filas y datos (solo columnas nuevas, nulas).
  if exists (select 1 from public.hojas_evaluacion where reemplazada_por is not null)
     or (select count(*) from public.hojas_evaluacion) <> (select count(distinct proyecto_id) from public.hojas_evaluacion) then
    raise exception 'POSCONDICION_FALLIDA: hojas existentes alteradas.';
  end if;
  if exists (select 1 from public.planeacion_versiones v where v.hoja_id is not null
              and not exists (select 1 from public.hojas_evaluacion h join public.proyectos_seguimiento ps on ps.id = h.proyecto_id
                               join public.planeacion_proyectos pp on pp.id = ps.planeacion_proyecto_id
                              where h.id = v.hoja_id and pp.planeacion_id = v.planeacion_id)) then
    raise exception 'POSCONDICION_FALLIDA: una versión quedó ligada a una hoja ajena.';
  end if;
  if has_function_privilege('anon', 'public.publicar_version_planeacion(uuid, integer, text, text, jsonb, jsonb, uuid, uuid, uuid, jsonb, text)', 'execute')
     or has_function_privilege('anon', 'public.confirmar_resultados_hoja(uuid, uuid, jsonb)', 'execute')
     or not has_function_privilege('authenticated', 'public.confirmar_resultados_hoja(uuid, uuid, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public._hoja_de_planeacion(uuid)', 'execute')
     or (select prosecdef from pg_proc where oid = to_regprocedure('public.confirmar_resultados_hoja(uuid, uuid, jsonb)')) then
    raise exception 'POSCONDICION_FALLIDA: permisos de las funciones distintos de lo esperado.';
  end if;
end;
$$;

commit;
