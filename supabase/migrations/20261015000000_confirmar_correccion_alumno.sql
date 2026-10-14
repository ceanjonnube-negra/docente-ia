-- Confirmación transaccional y de uso único de correcciones de datos de
-- alumno (CURP, sexo, fecha de nacimiento) desde el Chat IA — fase C4
-- (propuestas firmadas con HMAC en la aplicación).
--
-- MOTIVO: la escritura de sexo/fecha del Chat era un UPDATE directo sin
-- compare-and-set ni trazabilidad atómica, y ninguna propuesta era de uso
-- único (el compare-and-set solo no cubre el caso ABA: el valor vuelve al
-- anterior y la misma propuesta podría aplicarse otra vez).
--
-- ESTA MIGRACIÓN ES PURAMENTE ADITIVA: crea una tabla de consumos, una
-- función y sus permisos. No modifica ninguna tabla, política, función ni
-- permiso existente. public.actualizar_curp_alumno queda INTACTA (se
-- verifica por huella) y se reutiliza desde aquí para CURP.
--
-- USO ÚNICO: cada propuesta firmada por la aplicación lleva un
-- propuesta_id (uuid aleatorio generado por el servidor, dentro de la
-- firma). Al aplicarse, en la MISMA transacción que la escritura y la
-- trazabilidad, se inserta su fila en propuestas_correccion_consumidas
-- (PK = propuesta_id). Una segunda ejecución —repetición, concurrencia o
-- ABA— viola la PK y revierte TODO. Un intento fallido no consume nada.
-- No se usa correcciones_alumno.mensaje_id: es texto generado por el
-- cliente, con FK a mensajes_chat y ON DELETE SET NULL (borrar la
-- conversación lo anularía y la propuesta volvería a ser utilizable).
--
-- CONTRATO
--   public.confirmar_correccion_alumno(
--     p_propuesta_id uuid,         -- id firmado de la propuesta (uso único)
--     p_alumno_id uuid,
--     p_campo text,                -- 'curp' | 'sexo' | 'fecha_nacimiento'
--     p_valor_esperado text,       -- valor anterior EXACTO de la propuesta (NULL si no había)
--     p_valor_nuevo text,
--     p_fuente text,               -- 'documento' | 'imagen' | 'texto' | 'voz' | 'manual'
--     p_conversacion_id uuid       -- obligatoria; del docente autenticado
--   ) returns jsonb
--   Éxito:
--     {"resultado":"actualizado","alumno_id","campo","valor_anterior","valor_nuevo","correccion_id","propuesta_id"}
--     {"resultado":"sin_cambios","alumno_id","campo","valor"}   (no escribe ni consume)
--   Errores (SQLSTATE P0001, MESSAGE = código estable):
--     AUTH_REQUIRED, INVALID_SOURCE, INVALID_FIELD, INVALID_PROPOSAL,
--     CONVERSATION_NOT_AUTHORIZED, PROPOSAL_ALREADY_USED,
--     STUDENT_NOT_AUTHORIZED, STUDENT_NOT_IN_GROUP, NEW_VALUE_INVALID,
--     STALE_CURRENT_VALUE y, para CURP, los de actualizar_curp_alumno
--     (NEW_CURP_INVALID, NEW_CURP_DUPLICATE…).
--
-- SEGURIDAD
--   - SECURITY INVOKER con search_path vacío: corre con la sesión del
--     docente; RLS de alumnos, conversaciones_chat, inscripciones,
--     correcciones_alumno y de la tabla nueva se aplica además de las
--     comprobaciones explícitas por auth.uid().
--   - Grupo: si la conversación tiene grupo fijado (grupo_contexto_version
--     = 1), el alumno debe tener inscripción ACTIVA en ese grupo, dentro de
--     la misma transacción. Conversaciones anteriores a los snapshots: la
--     aplicación valida el grupo activo del docente (no hay snapshot que
--     consultar aquí).
--   - La firma HMAC se verifica en la aplicación ANTES de llamar aquí. Esta
--     función NO verifica firmas: invocada directamente vía PostgREST por la
--     misma cuenta, aplica las mismas garantías (propiedad, grupo,
--     compare-and-set, uso único por id, trazabilidad) pero no prueba que la
--     propuesta haya sido mostrada por el Chat. No otorga capacidades nuevas:
--     la política "Docentes ven sus alumnos" (ALL) ya permite a esa cuenta
--     modificar a sus alumnos directamente.
--
-- CONCURRENCIA: fila del alumno (SELECT … FOR UPDATE, el mismo primer
-- bloqueo que actualizar_curp_alumno) → [CURP: advisory lock de T0 dentro de
-- actualizar_curp_alumno] → compare-and-set → UPDATE → INSERT de
-- trazabilidad → INSERT de consumo. Mismo orden en todos los flujos: sin
-- deadlocks nuevos.
--
-- PERMISOS: EXECUTE solo para authenticated y service_role. Tabla de
-- consumos: SELECT/INSERT propios para authenticated (sin UPDATE ni DELETE),
-- nada para anon/PUBLIC.
--
-- Fail-closed: CREATE sin OR REPLACE/IF NOT EXISTS, precondiciones y
-- poscondiciones explícitas.
--
-- ROLLBACK:
--   drop function public.confirmar_correccion_alumno(uuid, uuid, text, text, text, text, uuid);
--   drop table public.propuestas_correccion_consumidas;

begin;
SET LOCAL lock_timeout = '5s';

do $$
begin
  if to_regclass('public.propuestas_correccion_consumidas') is not null then
    raise exception 'PRECONDICION_FALLIDA: public.propuestas_correccion_consumidas ya existe.';
  end if;

  if to_regprocedure('public.confirmar_correccion_alumno(uuid, uuid, text, text, text, text, uuid)') is not null then
    raise exception 'PRECONDICION_FALLIDA: public.confirmar_correccion_alumno ya existe.';
  end if;

  if to_regprocedure('public.actualizar_curp_alumno(uuid, text, text, text, uuid)') is null
     or md5(pg_catalog.pg_get_functiondef('public.actualizar_curp_alumno(uuid, text, text, text, uuid)'::regprocedure)) <> '95726742cc5533ae1678c554bb9d49d8' then
    raise exception 'PRECONDICION_FALLIDA: actualizar_curp_alumno no existe o difiere de la auditada.';
  end if;

  if (select count(*) from information_schema.columns
       where table_schema = 'public'
         and ((table_name = 'alumnos' and column_name in ('id', 'docente_id', 'sexo', 'fecha_nacimiento'))
           or (table_name = 'conversaciones_chat' and column_name in ('id', 'docente_id', 'grupo_contexto_version', 'grupo_id'))
           or (table_name = 'inscripciones' and column_name in ('alumno_id', 'grupo_id', 'estatus')))) <> 11 then
    raise exception 'PRECONDICION_FALLIDA: faltan columnas esperadas en alumnos, conversaciones_chat o inscripciones.';
  end if;

  if (select data_type from information_schema.columns
       where table_schema = 'public' and table_name = 'alumnos' and column_name = 'fecha_nacimiento') <> 'date' then
    raise exception 'PRECONDICION_FALLIDA: alumnos.fecha_nacimiento no es de tipo date.';
  end if;

  if (select pg_catalog.pg_get_constraintdef(c.oid)
        from pg_catalog.pg_constraint c
       where c.conrelid = 'public.correcciones_alumno'::regclass
         and c.conname = 'correcciones_alumno_fuente_check')
     is distinct from 'CHECK ((fuente = ANY (ARRAY[''documento''::text, ''imagen''::text, ''texto''::text, ''voz''::text, ''manual''::text])))' then
    raise exception 'PRECONDICION_FALLIDA: el CHECK de correcciones_alumno.fuente difiere del auditado.';
  end if;
end;
$$;

-- Registro de propuestas consumidas: una fila por propuesta aplicada.
create table public.propuestas_correccion_consumidas (
  propuesta_id uuid primary key,
  docente_id uuid not null references public.perfiles_docentes(id),
  alumno_id uuid not null references public.alumnos(id) on delete restrict,
  campo text not null check (campo in ('curp', 'sexo', 'fecha_nacimiento')),
  conversacion_id uuid references public.conversaciones_chat(id) on delete set null,
  correccion_id uuid not null unique references public.correcciones_alumno(id) on delete restrict,
  consumida_en timestamptz not null default now()
);

alter table public.propuestas_correccion_consumidas enable row level security;

create policy propuestas_correccion_consumidas_select_propio on public.propuestas_correccion_consumidas
  for select to authenticated
  using (docente_id = auth.uid());

create policy propuestas_correccion_consumidas_insert_propio on public.propuestas_correccion_consumidas
  for insert to authenticated
  with check (
    docente_id = auth.uid()
    and exists (select 1 from public.alumnos a where a.id = alumno_id and a.docente_id = auth.uid())
  );

revoke all on table public.propuestas_correccion_consumidas from public;
revoke all on table public.propuestas_correccion_consumidas from anon;
revoke all on table public.propuestas_correccion_consumidas from authenticated;
grant select, insert on table public.propuestas_correccion_consumidas to authenticated;
grant all on table public.propuestas_correccion_consumidas to service_role;

create function public.confirmar_correccion_alumno(
  p_propuesta_id uuid,
  p_alumno_id uuid,
  p_campo text,
  p_valor_esperado text,
  p_valor_nuevo text,
  p_fuente text,
  p_conversacion_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_docente_id uuid := auth.uid();
  v_grupo_version integer;
  v_grupo_id uuid;
  v_resultado jsonb;
  v_correccion_id uuid;
  v_filas integer;
  v_sexo_actual text;
  v_sexo_nuevo text;
  v_fecha_actual date;
  v_fecha_esperada date;
  v_fecha_nueva date;
begin
  -- 1. Identidad real y forma de la petición.
  if v_docente_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if p_fuente is null or p_fuente not in ('documento', 'imagen', 'texto', 'voz', 'manual') then
    raise exception 'INVALID_SOURCE';
  end if;
  if p_campo is null or p_campo not in ('curp', 'sexo', 'fecha_nacimiento') then
    raise exception 'INVALID_FIELD';
  end if;
  if p_propuesta_id is null or p_alumno_id is null or p_valor_nuevo is null then
    raise exception 'INVALID_PROPOSAL';
  end if;

  -- 2. Conversación obligatoria y del docente (mismo error para inexistente y ajena).
  if p_conversacion_id is null then
    raise exception 'CONVERSATION_NOT_AUTHORIZED';
  end if;
  select c.grupo_contexto_version, c.grupo_id
    into v_grupo_version, v_grupo_id
  from public.conversaciones_chat c
  where c.id = p_conversacion_id
    and c.docente_id = v_docente_id;
  if not found then
    raise exception 'CONVERSATION_NOT_AUTHORIZED';
  end if;

  -- 3. Uso único — comprobación temprana con mensaje claro. La garantía
  -- real es la PK del INSERT final (también bajo concurrencia).
  if exists (select 1 from public.propuestas_correccion_consumidas pc where pc.propuesta_id = p_propuesta_id) then
    raise exception 'PROPOSAL_ALREADY_USED';
  end if;

  -- 4. Alumno propio, bloqueado (mismo error para inexistente y ajeno).
  perform 1
  from public.alumnos a
  where a.id = p_alumno_id
    and a.docente_id = v_docente_id
  for update of a;
  if not found then
    raise exception 'STUDENT_NOT_AUTHORIZED';
  end if;

  -- 5. Grupo de la conversación (snapshot MG-B): inscripción activa.
  if v_grupo_version = 1 then
    if v_grupo_id is null or not exists (
      select 1 from public.inscripciones i
       where i.alumno_id = p_alumno_id
         and i.grupo_id = v_grupo_id
         and i.estatus = 'activo'
    ) then
      raise exception 'STUDENT_NOT_IN_GROUP';
    end if;
  end if;

  -- 6. Escritura con compare-and-set y trazabilidad, por campo.
  if p_campo = 'curp' then
    -- RPC canónica intacta: valida, compara contra el valor esperado,
    -- coteja duplicados bajo advisory lock e inserta su trazabilidad.
    v_resultado := public.actualizar_curp_alumno(p_alumno_id, p_valor_esperado, p_valor_nuevo, p_fuente, p_conversacion_id);
    if v_resultado ->> 'resultado' = 'sin_cambios' then
      return jsonb_build_object('resultado', 'sin_cambios', 'alumno_id', p_alumno_id, 'campo', 'curp', 'valor', v_resultado ->> 'curp');
    end if;
    v_correccion_id := (v_resultado ->> 'correccion_id')::uuid;
    v_resultado := jsonb_build_object(
      'resultado', 'actualizado', 'alumno_id', p_alumno_id, 'campo', 'curp',
      'valor_anterior', v_resultado -> 'curp_anterior', 'valor_nuevo', v_resultado -> 'curp_nueva',
      'correccion_id', v_correccion_id, 'propuesta_id', p_propuesta_id
    );

  elsif p_campo = 'sexo' then
    v_sexo_nuevo := upper(btrim(p_valor_nuevo));
    if v_sexo_nuevo not in ('H', 'M') then
      raise exception 'NEW_VALUE_INVALID';
    end if;
    select a.sexo into v_sexo_actual from public.alumnos a where a.id = p_alumno_id;
    if v_sexo_actual is distinct from p_valor_esperado then
      raise exception 'STALE_CURRENT_VALUE';
    end if;
    if v_sexo_actual is not distinct from v_sexo_nuevo then
      return jsonb_build_object('resultado', 'sin_cambios', 'alumno_id', p_alumno_id, 'campo', 'sexo', 'valor', v_sexo_actual);
    end if;
    update public.alumnos
       set sexo = v_sexo_nuevo
     where id = p_alumno_id
       and docente_id = v_docente_id
       and sexo is not distinct from p_valor_esperado;
    get diagnostics v_filas = row_count;
    if v_filas <> 1 then
      raise exception 'STALE_CURRENT_VALUE';
    end if;
    insert into public.correcciones_alumno (
      alumno_id, docente_id, campo, valor_anterior, valor_nuevo,
      fuente, fuente_detalle, conversacion_id, mensaje_id, accion, correccion_original_id
    ) values (
      p_alumno_id, v_docente_id, 'sexo', to_jsonb(v_sexo_actual), to_jsonb(v_sexo_nuevo),
      p_fuente, jsonb_build_object('flujo', 'confirmar_correccion_alumno'), p_conversacion_id, null, 'correccion', null
    )
    returning id into v_correccion_id;
    v_resultado := jsonb_build_object(
      'resultado', 'actualizado', 'alumno_id', p_alumno_id, 'campo', 'sexo',
      'valor_anterior', v_sexo_actual, 'valor_nuevo', v_sexo_nuevo,
      'correccion_id', v_correccion_id, 'propuesta_id', p_propuesta_id
    );

  else -- fecha_nacimiento
    if p_valor_nuevo !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'NEW_VALUE_INVALID';
    end if;
    begin
      v_fecha_nueva := p_valor_nuevo::date;
    exception when datetime_field_overflow or invalid_datetime_format then
      raise exception 'NEW_VALUE_INVALID';
    end;
    if p_valor_esperado is not null then
      if p_valor_esperado !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        raise exception 'INVALID_PROPOSAL';
      end if;
      begin
        v_fecha_esperada := p_valor_esperado::date;
      exception when datetime_field_overflow or invalid_datetime_format then
        raise exception 'INVALID_PROPOSAL';
      end;
    end if;
    select a.fecha_nacimiento into v_fecha_actual from public.alumnos a where a.id = p_alumno_id;
    if v_fecha_actual is distinct from v_fecha_esperada then
      raise exception 'STALE_CURRENT_VALUE';
    end if;
    if v_fecha_actual is not distinct from v_fecha_nueva then
      return jsonb_build_object('resultado', 'sin_cambios', 'alumno_id', p_alumno_id, 'campo', 'fecha_nacimiento', 'valor', to_char(v_fecha_actual, 'YYYY-MM-DD'));
    end if;
    update public.alumnos
       set fecha_nacimiento = v_fecha_nueva
     where id = p_alumno_id
       and docente_id = v_docente_id
       and fecha_nacimiento is not distinct from v_fecha_esperada;
    get diagnostics v_filas = row_count;
    if v_filas <> 1 then
      raise exception 'STALE_CURRENT_VALUE';
    end if;
    insert into public.correcciones_alumno (
      alumno_id, docente_id, campo, valor_anterior, valor_nuevo,
      fuente, fuente_detalle, conversacion_id, mensaje_id, accion, correccion_original_id
    ) values (
      p_alumno_id, v_docente_id, 'fecha_nacimiento',
      to_jsonb(to_char(v_fecha_actual, 'YYYY-MM-DD')), to_jsonb(to_char(v_fecha_nueva, 'YYYY-MM-DD')),
      p_fuente, jsonb_build_object('flujo', 'confirmar_correccion_alumno'), p_conversacion_id, null, 'correccion', null
    )
    returning id into v_correccion_id;
    v_resultado := jsonb_build_object(
      'resultado', 'actualizado', 'alumno_id', p_alumno_id, 'campo', 'fecha_nacimiento',
      'valor_anterior', to_char(v_fecha_actual, 'YYYY-MM-DD'), 'valor_nuevo', to_char(v_fecha_nueva, 'YYYY-MM-DD'),
      'correccion_id', v_correccion_id, 'propuesta_id', p_propuesta_id
    );
  end if;

  -- 7. Consumo de la propuesta en la MISMA transacción. Si ya se consumió
  -- (repetición, concurrencia o ABA), se revierte todo lo anterior.
  begin
    insert into public.propuestas_correccion_consumidas (
      propuesta_id, docente_id, alumno_id, campo, conversacion_id, correccion_id
    ) values (
      p_propuesta_id, v_docente_id, p_alumno_id, p_campo, p_conversacion_id, v_correccion_id
    );
  exception when unique_violation then
    raise exception 'PROPOSAL_ALREADY_USED';
  end;

  return v_resultado;
end;
$$;

revoke execute on function public.confirmar_correccion_alumno(uuid, uuid, text, text, text, text, uuid) from public;
revoke execute on function public.confirmar_correccion_alumno(uuid, uuid, text, text, text, text, uuid) from anon;
grant execute on function public.confirmar_correccion_alumno(uuid, uuid, text, text, text, text, uuid) to authenticated;
grant execute on function public.confirmar_correccion_alumno(uuid, uuid, text, text, text, text, uuid) to service_role;

do $$
declare
  c_firma constant text := 'public.confirmar_correccion_alumno(uuid, uuid, text, text, text, text, uuid)';
  c_tabla constant text := 'public.propuestas_correccion_consumidas';
begin
  if (select p.prosecdef from pg_catalog.pg_proc p where p.oid = c_firma::regprocedure)
     or (select p.proconfig from pg_catalog.pg_proc p where p.oid = c_firma::regprocedure) is distinct from array['search_path=""']
     or has_function_privilege('public', c_firma, 'execute')
     or has_function_privilege('anon', c_firma, 'execute')
     or not has_function_privilege('authenticated', c_firma, 'execute')
     or not has_function_privilege('service_role', c_firma, 'execute') then
    raise exception 'POSCONDICION_FALLIDA: confirmar_correccion_alumno no quedó SECURITY INVOKER, con search_path vacío y con EXECUTE solo para authenticated y service_role.';
  end if;

  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = c_tabla::regclass)
     or has_table_privilege('anon', c_tabla, 'select')
     or has_table_privilege('anon', c_tabla, 'insert')
     or not has_table_privilege('authenticated', c_tabla, 'select')
     or not has_table_privilege('authenticated', c_tabla, 'insert')
     or has_table_privilege('authenticated', c_tabla, 'update')
     or has_table_privilege('authenticated', c_tabla, 'delete')
     or has_table_privilege('authenticated', c_tabla, 'truncate')
     or (select count(*) from pg_catalog.pg_policy p where p.polrelid = c_tabla::regclass) <> 2 then
    raise exception 'POSCONDICION_FALLIDA: propuestas_correccion_consumidas no quedó con RLS y permisos mínimos (SELECT/INSERT propios).';
  end if;

  if md5(pg_catalog.pg_get_functiondef('public.actualizar_curp_alumno(uuid, text, text, text, uuid)'::regprocedure)) <> '95726742cc5533ae1678c554bb9d49d8' then
    raise exception 'POSCONDICION_FALLIDA: actualizar_curp_alumno cambió.';
  end if;
end;
$$;

commit;
