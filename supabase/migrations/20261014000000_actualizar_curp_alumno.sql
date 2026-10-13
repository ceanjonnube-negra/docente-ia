-- Primitiva canónica de corrección de CURP de un alumno propio
-- (auditoría aprobada "corrección de CURP desde el Chat").
--
-- MOTIVO: la corrección de CURP del Chat (lib/motorContexto.ts,
-- aplicarCorreccionAlumno) y la ficha individual escriben alumnos.curp
-- con UPDATE directo bajo RLS, sin compare-and-set contra el valor que
-- vio el docente, sin cotejo de duplicados propios, sin advisory lock y
-- sin trazabilidad atómica. reparar_curp_desde_lista_oficial no es
-- reutilizable tal cual: solo repara CURP ESTRUCTURALMENTE INVÁLIDAS y
-- exige contexto de grupo, mientras el Chat corrige también CURP
-- válidas pero incorrectas, o asigna una a un alumno sin CURP. Esta
-- función es el núcleo general que ambos flujos deberán usar.
--
-- ESTA MIGRACIÓN ES PURAMENTE ADITIVA: crea la función y sus permisos.
-- No modifica ninguna tabla, política, función existente ni permiso
-- existente (el UPDATE directo sobre alumnos sigue igual; su cierre es
-- una fase posterior, obligatoria, después de migrar los consumidores).
-- Todavía no la usa ningún consumidor.
--
-- CONTRATO
--   public.actualizar_curp_alumno(
--     p_alumno_id uuid,
--     p_curp_esperada_actual text,   -- valor CRUDO mostrado en la propuesta (NULL si no tenía)
--     p_curp_nueva text,             -- se normaliza: mayúsculas, sin ningún espacio
--     p_fuente text,                 -- 'documento' | 'imagen' | 'texto' | 'voz' | 'manual'
--     p_conversacion_id uuid         -- opcional; debe ser del docente autenticado
--   ) returns jsonb
--   Éxito:
--     {"resultado":"actualizado","alumno_id":…,"curp_anterior":…,"curp_nueva":…,"correccion_id":…}
--     {"resultado":"sin_cambios","alumno_id":…,"curp":…}   (no escribe nada)
--   Errores (SQLSTATE P0001, MESSAGE = código estable, en este orden):
--     AUTH_REQUIRED, INVALID_SOURCE, CONVERSATION_NOT_AUTHORIZED,
--     NEW_CURP_INVALID, STUDENT_NOT_AUTHORIZED, STALE_CURRENT_VALUE,
--     NEW_CURP_DUPLICATE.
--   STUDENT_NOT_AUTHORIZED y CONVERSATION_NOT_AUTHORIZED son idénticos
--   para "no existe" y "es de otra cuenta" (sin oráculo).
--
-- SEGURIDAD
--   - SECURITY INVOKER con search_path vacío: corre con la sesión del
--     docente; RLS de alumnos, conversaciones_chat y correcciones_alumno
--     se aplica además de las comprobaciones explícitas por auth.uid().
--   - El cotejo de duplicados es POR DOCENTE (mismo alcance que T0); no
--     consulta ni revela CURP de otras cuentas.
--   - Ninguna referencia arbitraria del cliente llega al historial:
--     p_fuente se valida contra la lista del CHECK real; p_conversacion_id
--     solo se acepta si es una conversación del docente autenticado;
--     fuente_detalle lo fija el servidor; mensaje_id no se acepta.
--
-- CONCURRENCIA (compatible con T0, 20261013000000):
--   fila del alumno (SELECT … FOR UPDATE) → advisory lock con la MISMA
--   clave que importar/alta_persona/reparar_curp:
--   hashtextextended(docente_id || ':' || CURP normalizada) → cotejo de
--   duplicado → UPDATE (con compare-and-set) → INSERT en
--   correcciones_alumno. Todo en una sola sentencia/transacción: un
--   error en cualquier paso, incluida la trazabilidad, revierte todo.
--
-- PERMISOS: EXECUTE solo para authenticated y service_role (se revoca
-- de PUBLIC y de anon, que lo recibirían por los privilegios por
-- defecto de Supabase).
--
-- Fail-closed: CREATE FUNCTION sin OR REPLACE, más precondiciones y
-- poscondiciones explícitas.
--
-- ROLLBACK: drop function public.actualizar_curp_alumno(uuid, text, text, text, uuid);

begin;

do $$
begin
  if to_regprocedure('public.actualizar_curp_alumno(uuid, text, text, text, uuid)') is not null then
    raise exception 'PRECONDICION_FALLIDA: public.actualizar_curp_alumno ya existe.';
  end if;

  if to_regprocedure('public.validar_estructura_curp_sql(text)') is null
     or md5(pg_catalog.pg_get_functiondef('public.validar_estructura_curp_sql(text)'::regprocedure)) <> '920b06858384aa919dc84cc000007eb8' then
    raise exception 'PRECONDICION_FALLIDA: validar_estructura_curp_sql no existe o difiere de la auditada.';
  end if;

  if (select pg_catalog.pg_get_constraintdef(c.oid)
        from pg_catalog.pg_constraint c
       where c.conrelid = 'public.correcciones_alumno'::regclass
         and c.conname = 'correcciones_alumno_fuente_check')
     is distinct from 'CHECK ((fuente = ANY (ARRAY[''documento''::text, ''imagen''::text, ''texto''::text, ''voz''::text, ''manual''::text])))' then
    raise exception 'PRECONDICION_FALLIDA: el CHECK de correcciones_alumno.fuente difiere del auditado.';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'conversaciones_chat' and column_name = 'docente_id'
  ) then
    raise exception 'PRECONDICION_FALLIDA: conversaciones_chat.docente_id no existe.';
  end if;
end;
$$;

create function public.actualizar_curp_alumno(
  p_alumno_id uuid,
  p_curp_esperada_actual text,
  p_curp_nueva text,
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
  v_curp_actual text;
  v_curp_nueva text;
  v_filas integer;
  v_correccion_id uuid;
begin
  -- 1. Identidad real.
  if v_docente_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  -- 2. Fuente: exactamente la lista del CHECK real de correcciones_alumno.
  if p_fuente is null or p_fuente not in ('documento', 'imagen', 'texto', 'voz', 'manual') then
    raise exception 'INVALID_SOURCE';
  end if;

  -- 3. Conversación opcional: solo una del propio docente. Mismo error
  -- para inexistente y ajena.
  if p_conversacion_id is not null and not exists (
    select 1 from public.conversaciones_chat c
     where c.id = p_conversacion_id
       and c.docente_id = v_docente_id
  ) then
    raise exception 'CONVERSATION_NOT_AUTHORIZED';
  end if;

  -- 4. CURP nueva: mayúsculas y sin NINGÚN espacio (misma regla que el
  -- Chat: toUpperCase().replace(/\s+/g, '')), validada con la función
  -- SQL canónica.
  v_curp_nueva := upper(regexp_replace(coalesce(p_curp_nueva, ''),
    '[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]', '', 'g'));
  if not public.validar_estructura_curp_sql(v_curp_nueva) then
    raise exception 'NEW_CURP_INVALID';
  end if;

  -- 5. Alumno propio, bloqueado. Mismo error para inexistente y ajeno.
  if p_alumno_id is null then
    raise exception 'STUDENT_NOT_AUTHORIZED';
  end if;
  select a.curp
    into v_curp_actual
  from public.alumnos a
  where a.id = p_alumno_id
    and a.docente_id = v_docente_id
  for update of a;
  if not found then
    raise exception 'STUDENT_NOT_AUTHORIZED';
  end if;

  -- 6. Compare-and-set contra el valor CRUDO de la propuesta (NULL seguro).
  if v_curp_actual is distinct from p_curp_esperada_actual then
    raise exception 'STALE_CURRENT_VALUE';
  end if;

  -- 7. Sin cambios: respuesta estable, sin escribir nada.
  if v_curp_actual is not distinct from v_curp_nueva then
    return jsonb_build_object('resultado', 'sin_cambios', 'alumno_id', p_alumno_id, 'curp', v_curp_nueva);
  end if;

  -- 8. Lock con la MISMA clave que T0 (importar/alta_persona/reparar_curp).
  perform pg_advisory_xact_lock(hashtextextended(v_docente_id::text || ':' || v_curp_nueva, 0::bigint));

  -- 9. Duplicado propio (todas las escuelas del docente; nunca otras cuentas).
  if exists (
    select 1 from public.alumnos a2
     where a2.docente_id = v_docente_id
       and a2.id <> p_alumno_id
       and a2.curp is not null
       and upper(trim(a2.curp)) = v_curp_nueva
  ) then
    raise exception 'NEW_CURP_DUPLICATE';
  end if;

  -- 10. UPDATE con el mismo compare-and-set (cinturón y tirantes).
  update public.alumnos
     set curp = v_curp_nueva
   where id = p_alumno_id
     and docente_id = v_docente_id
     and curp is not distinct from p_curp_esperada_actual;
  get diagnostics v_filas = row_count;
  if v_filas <> 1 then
    raise exception 'STALE_CURRENT_VALUE';
  end if;

  -- 11. Trazabilidad en la MISMA transacción: si falla, se revierte el UPDATE.
  insert into public.correcciones_alumno (
    alumno_id, docente_id, campo,
    valor_anterior, valor_nuevo,
    fuente, fuente_detalle,
    conversacion_id, mensaje_id,
    accion, correccion_original_id
  ) values (
    p_alumno_id, v_docente_id, 'curp',
    to_jsonb(v_curp_actual), to_jsonb(v_curp_nueva),
    p_fuente, jsonb_build_object('flujo', 'actualizar_curp_alumno'),
    p_conversacion_id, null,
    'correccion', null
  )
  returning id into v_correccion_id;

  return jsonb_build_object(
    'resultado', 'actualizado',
    'alumno_id', p_alumno_id,
    'curp_anterior', v_curp_actual,
    'curp_nueva', v_curp_nueva,
    'correccion_id', v_correccion_id
  );
end;
$$;

revoke execute on function public.actualizar_curp_alumno(uuid, text, text, text, uuid) from public;
revoke execute on function public.actualizar_curp_alumno(uuid, text, text, text, uuid) from anon;
grant execute on function public.actualizar_curp_alumno(uuid, text, text, text, uuid) to authenticated;
grant execute on function public.actualizar_curp_alumno(uuid, text, text, text, uuid) to service_role;

do $$
declare
  c_firma constant text := 'public.actualizar_curp_alumno(uuid, text, text, text, uuid)';
begin
  if (select p.prosecdef from pg_catalog.pg_proc p where p.oid = c_firma::regprocedure)
     or (select p.proconfig from pg_catalog.pg_proc p where p.oid = c_firma::regprocedure) is distinct from array['search_path=""']
     or has_function_privilege('public', c_firma, 'execute')
     or has_function_privilege('anon', c_firma, 'execute')
     or not has_function_privilege('authenticated', c_firma, 'execute')
     or not has_function_privilege('service_role', c_firma, 'execute') then
    raise exception 'POSCONDICION_FALLIDA: actualizar_curp_alumno no quedó SECURITY INVOKER, con search_path vacío y con EXECUTE solo para authenticated y service_role.';
  end if;
end;
$$;

commit;
