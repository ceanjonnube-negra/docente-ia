-- LISTA-P4B — registro canónico y aplicación atómica de propuestas de
-- actualización de listas oficiales (contrato de
-- lib/listaOficial/propuestaActualizacionLista.ts).
--
-- MODELO DE AUTORIZACIÓN (sustituye, solo para este flujo, la DECISIÓN 3
-- de V1-D2C1-B4D):
--   1. registrar_propuesta_lista_oficial — SOLO service_role. La llama el
--      backend al generar la propuesta, con el docente de la sesión ya
--      verificada. Revalida TODO contra la base: conversación, grupo,
--      alumnos, inscripciones, valores actuales, duplicados. Toma la foto
--      del grupo de la base, nunca del payload. Solo registra operaciones
--      aplicables.
--   2. aplicar_propuesta_lista_oficial — SOLO authenticated (auth.uid()).
--      Recibe únicamente el id de la propuesta y las confirmaciones
--      (llaveOperacion + eco de los datos que el docente autoriza). Las
--      operaciones se leen exclusivamente del registro: el cliente no
--      puede agregar, sustituir ni cambiar nada.
--
-- ATOMICIDAD Y CONCURRENCIA (una sola transacción):
--   - fila de la propuesta FOR UPDATE → uso único persistente (estado);
--   - locks consultivos ordenados docente:CURP y docente:nombre — misma
--     clave docente:CURP que importar_alumnos_a_grupo,
--     alta_persona_con_inscripcion y actualizar_curp_alumno;
--   - grupos FOR UPDATE → bloquea toda inserción de inscripciones en el
--     grupo (inscripciones_grupo_id_fkey toma FOR KEY SHARE sobre grupos);
--   - inscripciones del grupo y alumnos activos FOR UPDATE;
--   - recomparación de la foto bajo esos locks → ROSTER_CHANGED;
--   - cualquier error revierte todo, incluido el consumo.
--
-- HISTORIAL: ninguna operación borra. La baja es lógica
-- (dar_de_baja_inscripcion). Las correcciones conservan alumnos.id y dejan
-- trazabilidad en correcciones_alumno.
--
-- ÚNICO CAMBIO A OBJETOS EXISTENTES: los CHECK de campo de
-- correcciones_alumno y propuestas_correccion_consumidas admiten además
-- 'nombre'. confirmar_correccion_alumno NO se modifica: sigue aceptando
-- solo curp/sexo/fecha_nacimiento (INVALID_FIELD para lo demás). La
-- corrección de nombre vive solo dentro de aplicar_propuesta_lista_oficial.
-- No se amplía el EXECUTE de ninguna función existente.
--
-- Fail-closed: CREATE sin OR REPLACE; precondiciones y postcondiciones
-- revierten todo ante cualquier diferencia.

begin;

-- ============================================================
-- PRECONDICIONES
-- ============================================================
do $$
declare
  v_firma text;
begin
  -- Funciones existentes que se reutilizan: firma, propietario, seguridad
  -- y search_path vacío (evidencia E0 del catálogo E2E).
  foreach v_firma in array array[
    'public.alta_persona_con_inscripcion(uuid, text, text)|t',
    'public.dar_de_baja_inscripcion(uuid)|t',
    'public.confirmar_correccion_alumno(uuid, uuid, text, text, text, text, uuid)|f',
    'public.actualizar_curp_alumno(uuid, text, text, text, uuid)|f',
    'public.validar_estructura_curp_sql(text)|f'
  ] loop
    if pg_catalog.to_regprocedure(split_part(v_firma, '|', 1)) is null then
      raise exception 'PRECONDICION_FALLIDA: no existe %.', split_part(v_firma, '|', 1);
    end if;
    if (select pg_catalog.pg_get_userbyid(p.proowner) from pg_catalog.pg_proc p where p.oid = split_part(v_firma, '|', 1)::regprocedure) <> 'postgres'
       or (select p.prosecdef from pg_catalog.pg_proc p where p.oid = split_part(v_firma, '|', 1)::regprocedure) <> (split_part(v_firma, '|', 2) = 't')
       or (select p.proconfig from pg_catalog.pg_proc p where p.oid = split_part(v_firma, '|', 1)::regprocedure) is distinct from array['search_path=""'] then
      raise exception 'PRECONDICION_FALLIDA: % no tiene el propietario, la seguridad o el search_path esperados.', split_part(v_firma, '|', 1);
    end if;
  end loop;

  -- Huellas de las definiciones reutilizadas. alta_persona y
  -- actualizar_curp son las auditadas por cotejo_curp_por_docente y
  -- confirmar_correccion_alumno; las de confirmar_correccion_alumno y
  -- dar_de_baja_inscripcion corresponden a sus migraciones versionadas
  -- (mismo método pg_get_functiondef, verificado contra las auditadas).
  if md5(pg_catalog.pg_get_functiondef('public.alta_persona_con_inscripcion(uuid, text, text)'::regprocedure)) <> 'b5c0d54d931c27d25c473934cedf1bc2'
     or md5(pg_catalog.pg_get_functiondef('public.actualizar_curp_alumno(uuid, text, text, text, uuid)'::regprocedure)) <> '95726742cc5533ae1678c554bb9d49d8'
     or md5(pg_catalog.pg_get_functiondef('public.confirmar_correccion_alumno(uuid, uuid, text, text, text, text, uuid)'::regprocedure)) <> 'e2cc7ecc1ba3f582448857377de37391'
     or md5(pg_catalog.pg_get_functiondef('public.dar_de_baja_inscripcion(uuid)'::regprocedure)) <> 'f75cf23e9e277e72c5f50245bdcd90ee' then
    raise exception 'PRECONDICION_FALLIDA: una función reutilizada difiere de la definición auditada.';
  end if;

  if pg_catalog.to_regprocedure('auth.uid()') is null then
    raise exception 'PRECONDICION_FALLIDA: no existe auth.uid().';
  end if;

  -- Garantía de bloqueo del grupo: la FK debe existir y estar validada.
  if not exists (
    select 1 from pg_catalog.pg_constraint c
     where c.conname = 'inscripciones_grupo_id_fkey'
       and c.conrelid = 'public.inscripciones'::regclass
       and c.confrelid = 'public.grupos'::regclass
       and c.contype = 'f' and c.convalidated
  ) then
    raise exception 'PRECONDICION_FALLIDA: falta inscripciones_grupo_id_fkey validada hacia grupos.';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint c
     where c.conname = 'alumnos_nombre_docente_id_key'
       and c.conrelid = 'public.alumnos'::regclass and c.contype = 'u'
  ) then
    raise exception 'PRECONDICION_FALLIDA: falta alumnos_nombre_docente_id_key.';
  end if;

  if (select count(*) from information_schema.columns
       where table_schema = 'public'
         and ((table_name = 'conversaciones_chat' and column_name in ('id', 'docente_id', 'grupo_id', 'grupo_contexto_version'))
           or (table_name = 'grupos' and column_name in ('id', 'docente_id'))
           or (table_name = 'inscripciones' and column_name in ('id', 'alumno_id', 'grupo_id', 'estatus'))
           or (table_name = 'alumnos' and column_name in ('id', 'docente_id', 'nombre', 'curp')))) <> 14 then
    raise exception 'PRECONDICION_FALLIDA: faltan columnas esperadas.';
  end if;

  if (select pg_catalog.pg_get_constraintdef(c.oid) from pg_catalog.pg_constraint c
       where c.conrelid = 'public.correcciones_alumno'::regclass and c.conname = 'correcciones_alumno_campo_check')
     is distinct from 'CHECK ((campo = ANY (ARRAY[''curp''::text, ''sexo''::text, ''fecha_nacimiento''::text])))' then
    raise exception 'PRECONDICION_FALLIDA: el CHECK de correcciones_alumno.campo difiere del auditado.';
  end if;
  if (select pg_catalog.pg_get_constraintdef(c.oid) from pg_catalog.pg_constraint c
       where c.conrelid = 'public.propuestas_correccion_consumidas'::regclass and c.conname = 'propuestas_correccion_consumidas_campo_check')
     is distinct from 'CHECK ((campo = ANY (ARRAY[''curp''::text, ''sexo''::text, ''fecha_nacimiento''::text])))' then
    raise exception 'PRECONDICION_FALLIDA: el CHECK de propuestas_correccion_consumidas.campo difiere del auditado.';
  end if;

  if pg_catalog.to_regclass('public.propuestas_lista_oficial') is not null
     or pg_catalog.to_regclass('public.operaciones_propuesta_lista') is not null then
    raise exception 'PRECONDICION_FALLIDA: las tablas de propuestas de lista oficial ya existen.';
  end if;
end;
$$;

-- ============================================================
-- CHECK de campo: se agrega 'nombre' (superconjunto: las filas existentes
-- siguen siendo válidas).
-- ============================================================
alter table public.correcciones_alumno drop constraint correcciones_alumno_campo_check;
alter table public.correcciones_alumno add constraint correcciones_alumno_campo_check
  check (campo in ('curp', 'sexo', 'fecha_nacimiento', 'nombre'));

alter table public.propuestas_correccion_consumidas drop constraint propuestas_correccion_consumidas_campo_check;
alter table public.propuestas_correccion_consumidas add constraint propuestas_correccion_consumidas_campo_check
  check (campo in ('curp', 'sexo', 'fecha_nacimiento', 'nombre'));

-- ============================================================
-- Normalización de nombre — equivalente SQL de normalizarNombre
-- (lib/emparejarAlumno.ts): sin acentos, minúsculas, solo a-z y espacios
-- colapsados. Uso interno: sin EXECUTE para ningún rol de la API.
-- ============================================================
create function public.normalizar_nombre_sql(p_nombre text)
returns text
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  select pg_catalog.btrim(
    pg_catalog.regexp_replace(
      pg_catalog.regexp_replace(
        pg_catalog.lower(pg_catalog.translate(p_nombre,
          'ÁÀÄÂÉÈËÊÍÌÏÎÓÒÖÔÚÙÜÛÑáàäâéèëêíìïîóòöôúùüûñÇç',
          'AAAAEEEEIIIIOOOOUUUUNaaaaeeeeiiiioooouuuunCc')),
        '[^a-z[:space:]]', ' ', 'g'),
      '[[:space:]]+', ' ', 'g'))
$$;

-- ============================================================
-- Registro
-- ============================================================
create table public.propuestas_lista_oficial (
  propuesta_id uuid primary key,
  docente_id uuid not null references public.perfiles_docentes(id),
  conversacion_id uuid not null references public.conversaciones_chat(id) on delete cascade,
  grupo_id uuid not null references public.grupos(id) on delete cascade,
  generado_en timestamptz not null default now(),
  expira_en timestamptz not null,
  -- Foto del grupo tomada por la base al registrar:
  -- [{inscripcion_id, alumno_id, curp, nombre}] de las inscripciones
  -- activas, ordenada por inscripcion_id.
  roster_snapshot jsonb not null,
  estado text not null default 'pendiente' check (estado in ('pendiente', 'aplicada')),
  aplicada_en timestamptz,
  resultado jsonb,
  check (expira_en > generado_en and expira_en <= generado_en + interval '120 minutes'),
  check ((estado = 'aplicada') = (aplicada_en is not null))
);

create table public.operaciones_propuesta_lista (
  -- llaveOperacion del contrato: uso único (también p_propuesta_id de
  -- confirmar_correccion_alumno y PK de propuestas_correccion_consumidas).
  llave_operacion uuid primary key,
  propuesta_id uuid not null references public.propuestas_lista_oficial(propuesta_id) on delete cascade,
  operacion_id text not null check (operacion_id <> ''),
  orden integer not null,
  tipo text not null check (tipo in ('alta', 'correccion_curp', 'correccion_nombre', 'baja')),
  modo text not null check (modo in ('lote', 'individual')),
  alumno_id uuid,
  inscripcion_id uuid,
  nombre_actual text,
  nombre_nuevo text,
  curp_actual text,
  curp_nueva text,
  unique (propuesta_id, operacion_id),
  check (llave_operacion <> propuesta_id),
  check (
    (tipo = 'alta' and alumno_id is null and inscripcion_id is null and nombre_actual is null
       and nombre_nuevo is not null and curp_actual is null
       and modo = case when curp_nueva is null then 'individual' else 'lote' end)
    or (tipo = 'correccion_curp' and alumno_id is not null and inscripcion_id is not null
       and nombre_actual is null and nombre_nuevo is null and curp_nueva is not null and modo = 'lote')
    or (tipo = 'correccion_nombre' and alumno_id is not null and inscripcion_id is not null
       and nombre_actual is not null and nombre_nuevo is not null and curp_actual is null and curp_nueva is null
       and modo = 'individual')
    or (tipo = 'baja' and alumno_id is not null and inscripcion_id is not null
       and nombre_actual is null and nombre_nuevo is null and curp_actual is null and curp_nueva is null
       and modo = 'individual')
  )
);

-- Solo las funciones (propietario postgres) leen y escriben estas tablas.
alter table public.propuestas_lista_oficial enable row level security;
alter table public.operaciones_propuesta_lista enable row level security;
revoke all on table public.propuestas_lista_oficial from public, anon, authenticated, service_role;
revoke all on table public.operaciones_propuesta_lista from public, anon, authenticated, service_role;

-- Foto del grupo — una sola definición para registro y aplicación.
create function public.snapshot_roster_lista_oficial(p_grupo_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object('inscripcion_id', i.id, 'alumno_id', a.id, 'curp', a.curp, 'nombre', a.nombre)
      order by i.id),
    '[]'::jsonb)
  from public.inscripciones i
  join public.alumnos a on a.id = i.alumno_id
  where i.grupo_id = p_grupo_id and i.estatus = 'activo'
$$;

create function public.registrar_propuesta_lista_oficial(p_docente_id uuid, p_propuesta jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_propuesta_id uuid;
  v_conversacion_id uuid;
  v_grupo_id uuid;
  v_generado timestamptz;
  v_expira timestamptz;
  v_op jsonb;
  v_orden integer := 0;
  v_tipo text;
  v_llave uuid;
  v_alumno uuid;
  v_inscripcion uuid;
  v_nombre_actual text;
  v_nombre_nuevo text;
  v_curp_actual text;
  v_curp_nueva text;
  v_modo text;
  v_bd_curp text;
  v_bd_nombre text;
begin
  -- Solo el backend con service_role: un JWT de docente trae sub.
  if auth.uid() is not null then
    raise exception 'REGISTRATION_NOT_ALLOWED';
  end if;
  if p_docente_id is null or p_propuesta is null or pg_catalog.jsonb_typeof(p_propuesta) <> 'object'
     or (p_propuesta ->> 'version') is distinct from '1'
     or (p_propuesta ->> 'docenteId') is distinct from p_docente_id::text
     or pg_catalog.jsonb_typeof(p_propuesta -> 'operaciones') is distinct from 'array'
     or pg_catalog.jsonb_array_length(p_propuesta -> 'operaciones') = 0 then
    raise exception 'INVALID_PROPOSAL';
  end if;
  begin
    v_propuesta_id := (p_propuesta ->> 'propuestaId')::uuid;
    v_conversacion_id := (p_propuesta ->> 'conversacionId')::uuid;
    v_grupo_id := (p_propuesta ->> 'grupoId')::uuid;
    v_generado := (p_propuesta ->> 'generadoEn')::timestamptz;
    v_expira := (p_propuesta ->> 'expiraEn')::timestamptz;
  exception when others then
    raise exception 'INVALID_PROPOSAL';
  end;
  if v_propuesta_id is null or v_conversacion_id is null or v_grupo_id is null or v_generado is null or v_expira is null
     or abs(extract(epoch from (now() - v_generado))) > 120 then
    raise exception 'INVALID_PROPOSAL';
  end if;
  -- La vigencia la acota la base, nunca el payload.
  v_expira := least(v_expira, now() + interval '120 minutes');
  if v_expira <= now() then
    raise exception 'PROPOSAL_EXPIRED';
  end if;

  perform 1 from public.conversaciones_chat c
   where c.id = v_conversacion_id and c.docente_id = p_docente_id
     and c.grupo_id = v_grupo_id and c.grupo_contexto_version = 1
   for share;
  if not found then
    raise exception 'CONVERSATION_NOT_AUTHORIZED';
  end if;

  perform 1 from public.grupos g where g.id = v_grupo_id and g.docente_id = p_docente_id for update;
  if not found then
    raise exception 'GROUP_NOT_AUTHORIZED';
  end if;

  begin
    insert into public.propuestas_lista_oficial (propuesta_id, docente_id, conversacion_id, grupo_id, expira_en, roster_snapshot)
    values (v_propuesta_id, p_docente_id, v_conversacion_id, v_grupo_id, v_expira, public.snapshot_roster_lista_oficial(v_grupo_id));
  exception when unique_violation then
    raise exception 'PROPOSAL_ALREADY_REGISTERED';
  end;

  for v_op in select e.value from pg_catalog.jsonb_array_elements(p_propuesta -> 'operaciones') e loop
    v_orden := v_orden + 1;
    v_tipo := v_op ->> 'tipo';
    v_alumno := null; v_inscripcion := null;
    v_nombre_actual := null; v_nombre_nuevo := null; v_curp_actual := null; v_curp_nueva := null;
    begin
      v_llave := (v_op ->> 'llaveOperacion')::uuid;
      v_alumno := (v_op ->> 'alumnoId')::uuid;
      v_inscripcion := (v_op ->> 'inscripcionId')::uuid;
    exception when others then
      raise exception 'INVALID_OPERATION';
    end;
    if v_llave is null or v_llave = v_propuesta_id or coalesce(v_op ->> 'operacionId', '') = '' then
      raise exception 'INVALID_OPERATION';
    end if;

    -- Solo operaciones aplicables: seguras, o alta sin CURP cuyo único
    -- motivo es no tener CURP verificable.
    if not (
      ((v_op ->> 'clasificacion') = 'seguro' and (v_op -> 'motivos') = '[]'::jsonb)
      or (v_tipo = 'alta' and (v_op ->> 'clasificacion') = 'requiere_revision'
          and (v_op -> 'motivos') = '["ALTA_SIN_CURP_VERIFICABLE"]'::jsonb
          and (v_op -> 'valorPropuesto' -> 'curp') = 'null'::jsonb)
    ) then
      raise exception 'INVALID_OPERATION';
    end if;
    -- Una baja solo nace de una solicitud del docente; nada del documento
    -- puede proponer una baja.
    if (v_tipo = 'baja') is distinct from ((v_op -> 'evidencia' ->> 'fuente') = 'solicitud_docente') then
      raise exception 'INVALID_OPERATION';
    end if;

    if v_tipo = 'alta' then
      v_nombre_nuevo := pg_catalog.btrim(v_op -> 'valorPropuesto' ->> 'nombre');
      v_curp_nueva := nullif(pg_catalog.upper(pg_catalog.btrim(coalesce(v_op -> 'valorPropuesto' ->> 'curp', ''))), '');
      if v_alumno is not null or v_inscripcion is not null or coalesce(v_nombre_nuevo, '') = ''
         or public.normalizar_nombre_sql(v_nombre_nuevo) = '' then
        raise exception 'INVALID_OPERATION';
      end if;
      if v_curp_nueva is not null then
        if not public.validar_estructura_curp_sql(v_curp_nueva) then
          raise exception 'INVALID_OPERATION';
        end if;
        if exists (select 1 from public.alumnos a where a.docente_id = p_docente_id and pg_catalog.upper(pg_catalog.btrim(a.curp)) = v_curp_nueva) then
          raise exception 'CURP_DUPLICATE';
        end if;
      end if;
      if exists (select 1 from public.alumnos a where a.docente_id = p_docente_id
                  and public.normalizar_nombre_sql(a.nombre) = public.normalizar_nombre_sql(v_nombre_nuevo)) then
        raise exception 'NAME_DUPLICATE';
      end if;
      v_modo := case when v_curp_nueva is null then 'individual' else 'lote' end;

    elsif v_tipo in ('correccion_curp', 'correccion_nombre', 'baja') then
      -- Alumno con inscripción ACTIVA en este grupo y de este docente.
      select a.curp, a.nombre into v_bd_curp, v_bd_nombre
        from public.inscripciones i
        join public.alumnos a on a.id = i.alumno_id
       where i.id = v_inscripcion and i.alumno_id = v_alumno and i.grupo_id = v_grupo_id
         and i.estatus = 'activo' and a.docente_id = p_docente_id;
      if not found then
        raise exception 'INVALID_OPERATION';
      end if;

      if v_tipo = 'correccion_curp' then
        if not ((v_op -> 'valorActual') ? 'curp') then
          raise exception 'INVALID_OPERATION';
        end if;
        v_curp_actual := v_op -> 'valorActual' ->> 'curp';
        v_curp_nueva := nullif(pg_catalog.upper(pg_catalog.btrim(coalesce(v_op -> 'valorPropuesto' ->> 'curp', ''))), '');
        if v_curp_nueva is null or not public.validar_estructura_curp_sql(v_curp_nueva) then
          raise exception 'INVALID_OPERATION';
        end if;
        if v_bd_curp is distinct from v_curp_actual then
          raise exception 'STALE_CURRENT_VALUE';
        end if;
        -- Nunca se sobrescribe una CURP válida con otra distinta.
        if v_bd_curp is not null and public.validar_estructura_curp_sql(pg_catalog.upper(pg_catalog.btrim(v_bd_curp))) then
          raise exception 'CURP_CONTRADICTORY';
        end if;
        if exists (select 1 from public.alumnos a where a.docente_id = p_docente_id and a.id <> v_alumno
                    and pg_catalog.upper(pg_catalog.btrim(a.curp)) = v_curp_nueva) then
          raise exception 'CURP_DUPLICATE';
        end if;
        v_modo := 'lote';

      elsif v_tipo = 'correccion_nombre' then
        v_nombre_actual := v_op -> 'valorActual' ->> 'nombre';
        v_nombre_nuevo := pg_catalog.btrim(v_op -> 'valorPropuesto' ->> 'nombre');
        if v_nombre_actual is null or coalesce(v_nombre_nuevo, '') = '' or public.normalizar_nombre_sql(v_nombre_nuevo) = ''
           or v_nombre_nuevo = v_nombre_actual then
          raise exception 'INVALID_OPERATION';
        end if;
        if v_bd_nombre is distinct from v_nombre_actual then
          raise exception 'STALE_CURRENT_VALUE';
        end if;
        if exists (select 1 from public.alumnos a where a.docente_id = p_docente_id and a.id <> v_alumno
                    and public.normalizar_nombre_sql(a.nombre) = public.normalizar_nombre_sql(v_nombre_nuevo)) then
          raise exception 'NAME_DUPLICATE';
        end if;
        v_modo := 'individual';

      else -- baja
        if (v_op -> 'valorActual') is distinct from '{"estatus": "activo"}'::jsonb
           or (v_op -> 'valorPropuesto') is distinct from '{"estatus": "baja"}'::jsonb then
          raise exception 'INVALID_OPERATION';
        end if;
        v_modo := 'individual';
      end if;
    else
      raise exception 'INVALID_OPERATION';
    end if;

    begin
      insert into public.operaciones_propuesta_lista (
        llave_operacion, propuesta_id, operacion_id, orden, tipo, modo,
        alumno_id, inscripcion_id, nombre_actual, nombre_nuevo, curp_actual, curp_nueva
      ) values (
        v_llave, v_propuesta_id, v_op ->> 'operacionId', v_orden, v_tipo, v_modo,
        v_alumno, v_inscripcion, v_nombre_actual, v_nombre_nuevo, v_curp_actual, v_curp_nueva
      );
    exception when unique_violation or check_violation then
      raise exception 'INVALID_OPERATION';
    end;
  end loop;

  -- Combinaciones dentro de la propuesta.
  if exists (select 1 from public.operaciones_propuesta_lista o where o.propuesta_id = v_propuesta_id and o.alumno_id is not null
              group by o.alumno_id, o.tipo having count(*) > 1)
     or exists (select 1 from public.operaciones_propuesta_lista b
                 join public.operaciones_propuesta_lista o on o.propuesta_id = b.propuesta_id and o.alumno_id = b.alumno_id and o.llave_operacion <> b.llave_operacion
                where b.propuesta_id = v_propuesta_id and b.tipo = 'baja') then
    raise exception 'INVALID_OPERATION';
  end if;
  if exists (select 1 from public.operaciones_propuesta_lista o where o.propuesta_id = v_propuesta_id and o.curp_nueva is not null
              group by o.curp_nueva having count(*) > 1) then
    raise exception 'CURP_DUPLICATE';
  end if;
  if exists (select 1 from public.operaciones_propuesta_lista o where o.propuesta_id = v_propuesta_id and o.nombre_nuevo is not null
              group by public.normalizar_nombre_sql(o.nombre_nuevo) having count(*) > 1) then
    raise exception 'NAME_DUPLICATE';
  end if;

  return v_propuesta_id;
end;
$$;

-- ============================================================
-- Aplicación
-- ============================================================
create function public.aplicar_propuesta_lista_oficial(p_propuesta_id uuid, p_confirmaciones jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_docente uuid := auth.uid();
  v_prop public.propuestas_lista_oficial%rowtype;
  v_opr public.operaciones_propuesta_lista%rowtype;
  v_conf jsonb;
  v_llave uuid;
  v_llaves uuid[] := '{}';
  v_eco_esperado jsonb;
  v_claves text[];
  v_clave text;
  v_res jsonb;
  v_nombre_bd text;
  v_correccion_id uuid;
  v_alumno_nuevo uuid;
  v_altas jsonb := '[]'::jsonb;
begin
  if v_docente is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  -- 1. Propuesta: lock de fila → uso único (otra aplicación espera y luego
  -- la encuentra aplicada).
  select * into v_prop from public.propuestas_lista_oficial p
   where p.propuesta_id = p_propuesta_id and p.docente_id = v_docente
   for update;
  if not found then
    raise exception 'PROPOSAL_NOT_FOUND';
  end if;
  if v_prop.estado <> 'pendiente' then
    raise exception 'PROPOSAL_ALREADY_USED';
  end if;
  if now() >= v_prop.expira_en then
    raise exception 'PROPOSAL_EXPIRED';
  end if;

  -- 2. Confirmaciones: solo llaves registradas, sin repetir, con el eco
  -- exacto de los datos autorizados.
  if p_confirmaciones is null or pg_catalog.jsonb_typeof(p_confirmaciones) <> 'array'
     or pg_catalog.jsonb_array_length(p_confirmaciones) = 0 then
    raise exception 'INVALID_CONFIRMATION';
  end if;
  for v_conf in select e.value from pg_catalog.jsonb_array_elements(p_confirmaciones) e loop
    if pg_catalog.jsonb_typeof(v_conf) <> 'object'
       or (select count(*) from pg_catalog.jsonb_object_keys(v_conf)) <> 2
       or not (v_conf ? 'llaveOperacion' and v_conf ? 'eco') then
      raise exception 'INVALID_CONFIRMATION';
    end if;
    begin
      v_llave := (v_conf ->> 'llaveOperacion')::uuid;
    exception when others then
      raise exception 'INVALID_CONFIRMATION';
    end;
    if v_llave is null or v_llave = any(v_llaves) then
      raise exception 'INVALID_CONFIRMATION';
    end if;
    select * into v_opr from public.operaciones_propuesta_lista o
     where o.llave_operacion = v_llave and o.propuesta_id = p_propuesta_id;
    if not found then
      raise exception 'INVALID_CONFIRMATION';
    end if;
    v_eco_esperado := case
      when v_opr.tipo = 'alta' and v_opr.curp_nueva is not null then
        pg_catalog.jsonb_build_object('nombre', v_opr.nombre_nuevo, 'curp', v_opr.curp_nueva)
      when v_opr.tipo = 'alta' then
        pg_catalog.jsonb_build_object('nombre', v_opr.nombre_nuevo, 'curp', null, 'sinCurp', true)
      when v_opr.tipo = 'correccion_curp' then
        pg_catalog.jsonb_build_object('alumnoId', v_opr.alumno_id, 'curpActual', v_opr.curp_actual, 'curpNueva', v_opr.curp_nueva)
      when v_opr.tipo = 'correccion_nombre' then
        pg_catalog.jsonb_build_object('alumnoId', v_opr.alumno_id, 'nombreActual', v_opr.nombre_actual, 'nombreNuevo', v_opr.nombre_nuevo)
      else
        pg_catalog.jsonb_build_object('alumnoId', v_opr.alumno_id, 'inscripcionId', v_opr.inscripcion_id, 'autorizaBaja', true)
    end;
    if (v_conf -> 'eco') is distinct from v_eco_esperado then
      raise exception 'INVALID_CONFIRMATION';
    end if;
    v_llaves := v_llaves || v_llave;
  end loop;

  -- 3. Conversación y grupo vigentes del mismo docente.
  perform 1 from public.conversaciones_chat c
   where c.id = v_prop.conversacion_id and c.docente_id = v_docente
     and c.grupo_id = v_prop.grupo_id and c.grupo_contexto_version = 1
   for share;
  if not found then
    raise exception 'CONVERSATION_NOT_AUTHORIZED';
  end if;

  -- 4. Locks consultivos ordenados (antes que los de filas).
  select pg_catalog.array_agg(k order by k) into v_claves from (
    select distinct v_docente::text || ':' || o.curp_nueva as k
      from public.operaciones_propuesta_lista o
     where o.propuesta_id = p_propuesta_id and o.llave_operacion = any(v_llaves) and o.curp_nueva is not null
    union
    select distinct v_docente::text || ':nombre:' || public.normalizar_nombre_sql(o.nombre_nuevo)
      from public.operaciones_propuesta_lista o
     where o.propuesta_id = p_propuesta_id and o.llave_operacion = any(v_llaves) and o.nombre_nuevo is not null
  ) s;
  foreach v_clave in array coalesce(v_claves, '{}') loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_clave, 0::bigint));
  end loop;

  -- 5. Grupo FOR UPDATE: ninguna inscripción nueva puede entrar al grupo
  -- (la FK toma FOR KEY SHARE sobre grupos) hasta terminar.
  perform 1 from public.grupos g where g.id = v_prop.grupo_id and g.docente_id = v_docente for update;
  if not found then
    raise exception 'GROUP_NOT_AUTHORIZED';
  end if;

  -- 6. Inscripciones del grupo (cualquier estatus) y alumnos activos.
  perform 1 from public.inscripciones i where i.grupo_id = v_prop.grupo_id order by i.id for update;
  perform 1 from public.alumnos a
   where a.id in (select i.alumno_id from public.inscripciones i where i.grupo_id = v_prop.grupo_id and i.estatus = 'activo')
   order by a.id for update;

  -- 7. Recomparación bajo locks.
  if public.snapshot_roster_lista_oficial(v_prop.grupo_id) is distinct from v_prop.roster_snapshot then
    raise exception 'ROSTER_CHANGED';
  end if;

  -- 8. Operaciones confirmadas, en orden fijo.
  for v_opr in
    select * from public.operaciones_propuesta_lista o
     where o.propuesta_id = p_propuesta_id and o.llave_operacion = any(v_llaves)
     order by case o.tipo when 'correccion_curp' then 1 when 'correccion_nombre' then 2 when 'alta' then 3 else 4 end, o.orden
  loop
    if v_opr.tipo = 'correccion_curp' then
      -- CAS, deduplicación, trazabilidad y uso único de la llave.
      v_res := public.confirmar_correccion_alumno(
        v_opr.llave_operacion, v_opr.alumno_id, 'curp', v_opr.curp_actual, v_opr.curp_nueva, 'imagen', v_prop.conversacion_id);
      if (v_res ->> 'resultado') is distinct from 'actualizado' then
        raise exception 'STALE_CURRENT_VALUE';
      end if;

    elsif v_opr.tipo = 'correccion_nombre' then
      select a.nombre into v_nombre_bd from public.alumnos a
       where a.id = v_opr.alumno_id and a.docente_id = v_docente for update;
      if not found then
        raise exception 'STUDENT_NOT_AUTHORIZED';
      end if;
      if v_nombre_bd is distinct from v_opr.nombre_actual then
        raise exception 'STALE_CURRENT_VALUE';
      end if;
      if exists (select 1 from public.alumnos a where a.docente_id = v_docente and a.id <> v_opr.alumno_id
                  and public.normalizar_nombre_sql(a.nombre) = public.normalizar_nombre_sql(v_opr.nombre_nuevo)) then
        raise exception 'NAME_DUPLICATE';
      end if;
      begin
        update public.alumnos set nombre = v_opr.nombre_nuevo where id = v_opr.alumno_id;
      exception when unique_violation then
        raise exception 'NAME_DUPLICATE';
      end;
      insert into public.correcciones_alumno (
        alumno_id, docente_id, campo, valor_anterior, valor_nuevo,
        fuente, fuente_detalle, conversacion_id, mensaje_id, accion, correccion_original_id
      ) values (
        v_opr.alumno_id, v_docente, 'nombre', pg_catalog.to_jsonb(v_nombre_bd), pg_catalog.to_jsonb(v_opr.nombre_nuevo),
        'imagen', pg_catalog.jsonb_build_object('flujo', 'aplicar_propuesta_lista_oficial', 'propuesta_id', p_propuesta_id),
        v_prop.conversacion_id, null, 'correccion', null
      )
      returning id into v_correccion_id;
      begin
        insert into public.propuestas_correccion_consumidas (propuesta_id, docente_id, alumno_id, campo, conversacion_id, correccion_id)
        values (v_opr.llave_operacion, v_docente, v_opr.alumno_id, 'nombre', v_prop.conversacion_id, v_correccion_id);
      exception when unique_violation then
        raise exception 'PROPOSAL_ALREADY_USED';
      end;

    elsif v_opr.tipo = 'alta' then
      if exists (select 1 from public.alumnos a where a.docente_id = v_docente
                  and public.normalizar_nombre_sql(a.nombre) = public.normalizar_nombre_sql(v_opr.nombre_nuevo)) then
        raise exception 'NAME_DUPLICATE';
      end if;
      begin
        v_alumno_nuevo := public.alta_persona_con_inscripcion(v_prop.grupo_id, v_opr.nombre_nuevo, v_opr.curp_nueva);
      exception
        when unique_violation then
          raise exception 'NAME_DUPLICATE';
        when raise_exception then
          if sqlerrm = 'Ya tienes un alumno registrado con esa CURP.' then
            raise exception 'CURP_DUPLICATE';
          end if;
          raise;
      end;
      v_altas := v_altas || pg_catalog.jsonb_build_object('llaveOperacion', v_opr.llave_operacion, 'alumnoId', v_alumno_nuevo);

    else -- baja lógica
      perform 1 from public.inscripciones i
       where i.id = v_opr.inscripcion_id and i.alumno_id = v_opr.alumno_id
         and i.grupo_id = v_prop.grupo_id and i.estatus = 'activo';
      if not found then
        raise exception 'STALE_CURRENT_VALUE';
      end if;
      begin
        perform public.dar_de_baja_inscripcion(v_opr.inscripcion_id);
      exception when raise_exception then
        if sqlerrm = 'Esta inscripción ya no está activa.' then
          raise exception 'STALE_CURRENT_VALUE';
        end if;
        raise;
      end;
    end if;
  end loop;

  -- 9. Consumo en la misma transacción. Las operaciones no confirmadas
  -- quedan descartadas: requieren una propuesta nueva.
  update public.propuestas_lista_oficial
     set estado = 'aplicada', aplicada_en = now(),
         resultado = pg_catalog.jsonb_build_object('aplicadas', pg_catalog.to_jsonb(v_llaves), 'altas', v_altas)
   where propuesta_id = p_propuesta_id;

  return pg_catalog.jsonb_build_object(
    'resultado', 'aplicada', 'propuesta_id', p_propuesta_id,
    'aplicadas', pg_catalog.cardinality(v_llaves), 'altas', v_altas);
end;
$$;

-- ============================================================
-- Permisos mínimos (Supabase otorga EXECUTE por defecto a anon,
-- authenticated y service_role: se revoca explícitamente).
-- ============================================================
revoke execute on function public.normalizar_nombre_sql(text) from public, anon, authenticated, service_role;
revoke execute on function public.snapshot_roster_lista_oficial(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.registrar_propuesta_lista_oficial(uuid, jsonb) from public, anon, authenticated, service_role;
revoke execute on function public.aplicar_propuesta_lista_oficial(uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.registrar_propuesta_lista_oficial(uuid, jsonb) to service_role;
grant execute on function public.aplicar_propuesta_lista_oficial(uuid, jsonb) to authenticated;

-- ============================================================
-- POSCONDICIONES
-- ============================================================
do $$
declare
  v_item text;
  v_firma text;
begin
  foreach v_item in array array[
    'public.normalizar_nombre_sql(text)|f|',
    'public.snapshot_roster_lista_oficial(uuid)|f|',
    'public.registrar_propuesta_lista_oficial(uuid, jsonb)|t|service_role',
    'public.aplicar_propuesta_lista_oficial(uuid, jsonb)|t|authenticated'
  ] loop
    v_firma := split_part(v_item, '|', 1);
    if (select pg_catalog.pg_get_userbyid(p.proowner) from pg_catalog.pg_proc p where p.oid = v_firma::regprocedure) <> 'postgres'
       or (select p.prosecdef from pg_catalog.pg_proc p where p.oid = v_firma::regprocedure) <> (split_part(v_item, '|', 2) = 't')
       or (select p.proconfig from pg_catalog.pg_proc p where p.oid = v_firma::regprocedure) is distinct from array['search_path=""']
       or has_function_privilege('public', v_firma, 'execute')
       or has_function_privilege('anon', v_firma, 'execute')
       or has_function_privilege('authenticated', v_firma, 'execute') <> (split_part(v_item, '|', 3) = 'authenticated')
       or has_function_privilege('service_role', v_firma, 'execute') <> (split_part(v_item, '|', 3) = 'service_role') then
      raise exception 'POSCONDICION_FALLIDA: % no quedó con propietario, seguridad, search_path o EXECUTE mínimos.', v_firma;
    end if;
  end loop;

  foreach v_firma in array array['public.propuestas_lista_oficial', 'public.operaciones_propuesta_lista'] loop
    if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = v_firma::regclass)
       or pg_catalog.pg_get_userbyid((select c.relowner from pg_catalog.pg_class c where c.oid = v_firma::regclass)) <> 'postgres'
       or has_table_privilege('anon', v_firma, 'select, insert, update, delete, truncate')
       or has_table_privilege('authenticated', v_firma, 'select, insert, update, delete, truncate')
       or has_table_privilege('service_role', v_firma, 'select, insert, update, delete, truncate') then
      raise exception 'POSCONDICION_FALLIDA: % no quedó con RLS y sin permisos para los roles de la API.', v_firma;
    end if;
  end loop;

  -- Las funciones existentes no cambian.
  if md5(pg_catalog.pg_get_functiondef('public.alta_persona_con_inscripcion(uuid, text, text)'::regprocedure)) <> 'b5c0d54d931c27d25c473934cedf1bc2'
     or md5(pg_catalog.pg_get_functiondef('public.actualizar_curp_alumno(uuid, text, text, text, uuid)'::regprocedure)) <> '95726742cc5533ae1678c554bb9d49d8'
     or md5(pg_catalog.pg_get_functiondef('public.confirmar_correccion_alumno(uuid, uuid, text, text, text, text, uuid)'::regprocedure)) <> 'e2cc7ecc1ba3f582448857377de37391'
     or md5(pg_catalog.pg_get_functiondef('public.dar_de_baja_inscripcion(uuid)'::regprocedure)) <> 'f75cf23e9e277e72c5f50245bdcd90ee'
     or has_function_privilege('authenticated', 'public.alta_persona_con_inscripcion(uuid, text, text)', 'execute') then
    raise exception 'POSCONDICION_FALLIDA: cambió una función existente o sus permisos.';
  end if;
end;
$$;

commit;
