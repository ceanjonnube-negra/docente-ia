-- ETAPA 3B-1 — eliminación global de conversaciones del Chat IA con una
-- marca persistente (tombstone). Sin borrar archivos de Storage.
--
-- QUÉ HACE:
--   1. conversaciones_chat.eliminada_en: la fila de una conversación
--      eliminada NO se borra nunca; queda como marca. Así ningún
--      dispositivo ni cola pendiente puede recrearla (el INSERT con el
--      mismo id choca con la fila existente) y no se dispara el
--      ON DELETE CASCADE de propuestas_lista_oficial (ni el SET NULL de
--      correcciones_alumno, programa_analitico_borrador y
--      propuestas_correccion_consumidas): esos registros se conservan.
--   2. eliminar_conversacion(id) — SOLO authenticated (auth.uid()). En una
--      transacción: bloquea la conversación propia (FOR UPDATE), borra
--      sus mensajes, la marca y limpia su contexto. Repetible: una ya
--      eliminada responde 'ya_eliminada'; una ajena o inexistente,
--      'no_encontrada' (sin revelar cuál).
--   3. conversacion_escribible(id) — la usan las políticas de
--      mensajes_chat. Toma FOR KEY SHARE sobre la conversación, que choca
--      con el FOR UPDATE de eliminar_conversacion: un INSERT/UPDATE de
--      mensaje simultáneo ESPERA a que termine la eliminación, relee la
--      fila ya marcada y se rechaza (sin triggers).
--   4. Cliente sin DELETE: se retiran el permiso y la política de borrado
--      de conversaciones_chat (hoy permitía borrar en cascada) y el
--      permiso DELETE de mensajes_chat (sin política, ya denegado).
--   5. UPDATE de conversaciones_chat solo sobre filas no eliminadas;
--      eliminada_en no se puede escribir desde el cliente.
--   6. fijar_grupo_conversacion, registrar_propuesta_lista_oficial y
--      aplicar_propuesta_lista_oficial: ÚNICO cambio, "eliminada_en is
--      null" en su validación de la conversación (mismos locks, misma
--      firma, mismos permisos). Sus cuerpos actuales se verifican por md5
--      antes de reemplazarlos.
--
-- NO borra archivos de Storage ni toca documentos, planeaciones, hojas de
-- evaluación ni registros académicos.
--
-- REVERSIÓN (deja de impedir escrituras; las marcas y los mensajes ya
-- borrados no vuelven): recrear las políticas y funciones anteriores
-- (definiciones auditadas por md5 abajo), re-otorgar los DELETE retirados
-- solo si se decide expresamente, y
--   drop function public.eliminar_conversacion(uuid);
--   drop function public.conversacion_escribible(uuid);
-- La columna eliminada_en puede conservarse sin efecto.

begin;

-- ============================================================
-- PRECONDICIONES
-- ============================================================
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'conversaciones_chat' and column_name = 'eliminada_en') then
    raise exception 'PRECONDICION_FALLIDA: conversaciones_chat.eliminada_en ya existe.';
  end if;

  if (select md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.fijar_grupo_conversacion(uuid)'::regprocedure) <> '4ceb779ac8c36e7ad6d3cb66ea81e127'
     or (select md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.registrar_propuesta_lista_oficial(uuid, jsonb)'::regprocedure) <> 'a114c2dbab61973488b6f4ef6c6091e6'
     or (select md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.aplicar_propuesta_lista_oficial(uuid, jsonb)'::regprocedure) <> '7b19442325d37fb883851e29c441aa7a' then
    raise exception 'PRECONDICION_FALLIDA: una función a reemplazar difiere de la definición auditada.';
  end if;

  if (select count(*) from pg_catalog.pg_policies
       where schemaname = 'public'
         and ((tablename = 'conversaciones_chat' and policyname in ('conversaciones_chat_delete_propio', 'conversaciones_chat_update_propio'))
           or (tablename = 'mensajes_chat' and policyname in ('mensajes_chat_insert_propio', 'mensajes_chat_update_propio')))) <> 4 then
    raise exception 'PRECONDICION_FALLIDA: faltan políticas esperadas en conversaciones_chat/mensajes_chat.';
  end if;

  if exists (select 1 from information_schema.triggers
              where event_object_schema = 'public' and event_object_table in ('conversaciones_chat', 'mensajes_chat')) then
    raise exception 'PRECONDICION_FALLIDA: hay triggers inesperados en las tablas del chat.';
  end if;
end;
$$;

-- ============================================================
-- 1. Marca persistente
-- ============================================================
alter table public.conversaciones_chat add column eliminada_en timestamptz null;
-- SELECT es por columna en esta tabla: sin esto el cliente no la vería.
grant select (eliminada_en) on public.conversaciones_chat to authenticated;

-- ============================================================
-- 2. Escritura permitida solo en conversaciones propias no eliminadas
-- ============================================================
create function public.conversacion_escribible(p_conversacion_id uuid) returns boolean
    language plpgsql volatile security definer
    set search_path to ''
    as $fn$
begin
  if auth.uid() is null or p_conversacion_id is null then
    return false;
  end if;
  -- FOR KEY SHARE choca con el FOR UPDATE de eliminar_conversacion: si
  -- hay una eliminación en curso se espera y se relee la fila ya marcada.
  perform 1 from public.conversaciones_chat c
   where c.id = p_conversacion_id
     and c.docente_id = auth.uid()
     and c.eliminada_en is null
   for key share;
  return found;
end;
$fn$;
revoke all on function public.conversacion_escribible(uuid) from public, anon, service_role;
grant execute on function public.conversacion_escribible(uuid) to authenticated;

-- ============================================================
-- 3. Eliminación transaccional
-- ============================================================
create function public.eliminar_conversacion(p_conversacion_id uuid) returns jsonb
    language plpgsql security definer
    set search_path to ''
    as $fn$
declare
  v_docente uuid := auth.uid();
  v_eliminada timestamptz;
  v_mensajes integer;
begin
  if v_docente is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '42501';
  end if;

  select c.eliminada_en into v_eliminada
    from public.conversaciones_chat c
   where c.id = p_conversacion_id and c.docente_id = v_docente
   for update;
  if not found then
    return jsonb_build_object('estado', 'no_encontrada');
  end if;
  if v_eliminada is not null then
    return jsonb_build_object('estado', 'ya_eliminada');
  end if;

  delete from public.mensajes_chat m where m.conversacion_id = p_conversacion_id;
  get diagnostics v_mensajes = row_count;

  update public.conversaciones_chat
     set eliminada_en = now(),
         actualizado_en = now(),
         titulo = 'Conversación eliminada',
         documento_activo = null,
         material_visual_activo = null,
         planeacion_activa = null
   where id = p_conversacion_id;

  return jsonb_build_object('estado', 'eliminada', 'mensajes', v_mensajes);
end;
$fn$;
revoke all on function public.eliminar_conversacion(uuid) from public, anon, service_role;
grant execute on function public.eliminar_conversacion(uuid) to authenticated;

-- ============================================================
-- 4. Reglas de acceso
-- ============================================================
drop policy conversaciones_chat_delete_propio on public.conversaciones_chat;
revoke delete on public.conversaciones_chat from anon, authenticated;

drop policy conversaciones_chat_update_propio on public.conversaciones_chat;
create policy conversaciones_chat_update_propio on public.conversaciones_chat
  for update
  using (docente_id = auth.uid() and eliminada_en is null)
  with check (docente_id = auth.uid() and eliminada_en is null);

revoke delete on public.mensajes_chat from anon, authenticated;

drop policy mensajes_chat_insert_propio on public.mensajes_chat;
create policy mensajes_chat_insert_propio on public.mensajes_chat
  for insert
  with check (docente_id = auth.uid() and public.conversacion_escribible(conversacion_id));

drop policy mensajes_chat_update_propio on public.mensajes_chat;
create policy mensajes_chat_update_propio on public.mensajes_chat
  for update
  using (docente_id = auth.uid() and public.conversacion_escribible(conversacion_id))
  with check (docente_id = auth.uid() and public.conversacion_escribible(conversacion_id));

-- ============================================================
-- 5. Funciones existentes: solo "eliminada_en is null"
-- ============================================================
create or replace function public.fijar_grupo_conversacion(p_conversacion_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_docente_id uuid;
  v_grupo_resuelto uuid;
  v_candidatos uuid[];
begin
  v_docente_id := auth.uid();
  if v_docente_id is null then
    return; -- fail-safe: sin identidad real del llamador, no se hace nada
  end if;

  -- Localiza y BLOQUEA la fila exigiendo, en la misma condición, TODO
  -- lo que hace válida la operación: que la conversación sea del
  -- llamador, que de verdad haya nacido bajo MG-B (version=1, nunca
  -- una legacy con version NULL), y que el snapshot no se haya fijado
  -- ya antes. `for update` toma un lock de fila — una segunda llamada
  -- concurrente sobre la MISMA conversación espera a que esta
  -- transacción termine y entonces ya no encuentra la fila (grupo_id
  -- dejó de ser null), terminando en no-op sin ninguna condición de
  -- carrera.
  perform 1
  from public.conversaciones_chat
  where id = p_conversacion_id
    and docente_id = v_docente_id
    and grupo_contexto_version = 1
    and grupo_id is null
    and eliminada_en is null
  for update;

  if not found then
    return; -- no coincide: ya fijado, legacy, ajena, o inexistente — no-op seguro
  end if;

  -- PASO A — contexto persistido (docente_contexto_activo.grupo_id),
  -- revalidado por completo: debe existir, pertenecer al mismo
  -- docente, y su ciclo escolar debe estar activo. grupos.activo
  -- NUNCA se usa (ver auditoría "semántica real de grupos.activo" —
  -- sin ningún uso operativo demostrado en el proyecto).
  --
  -- NUNCA se usa LIMIT 1 para elegir arbitrariamente entre varias
  -- filas: no se pudo demostrar estructuralmente (sin acceso a
  -- information_schema/pg_catalog en las auditorías anteriores) que
  -- docente_contexto_activo tenga exactamente una fila por docente
  -- vía PK/UNIQUE. Por eso se trae hasta 2 IDs de grupo DISTINCT (una
  -- fila duplicada que apunte al MISMO grupo nunca cuenta como un
  -- segundo candidato) y solo se acepta el contexto persistido si el
  -- resultado es inequívoco:
  --   0 grupos distintos → cae al fallback de "exactamente un grupo" (PASO B)
  --   exactamente 1 grupo distinto → se usa ese grupo
  --   2 o más grupos distintos → contexto ambiguo, también cae al
  --     fallback (que por su propia naturaleza vuelve a exigir
  --     "exactamente un grupo autorizado" a nivel global — si de
  --     verdad hay más de un grupo posible, el fallback lo rechazará
  --     igual, sin elegir ninguno arbitrariamente).
  select array_agg(c.id) into v_candidatos
  from (
    select distinct g.id
    from public.docente_contexto_activo dca
    join public.grupos g on g.id = dca.grupo_id
    join public.ciclos_escolares ce on ce.id = g.ciclo_escolar_id
    where dca.docente_id = v_docente_id
      and g.docente_id = v_docente_id
      and ce.activo = true
    limit 2
  ) c;

  if array_length(v_candidatos, 1) = 1 then
    v_grupo_resuelto := v_candidatos[1];
  end if;

  -- PASO B — solo si el contexto persistido no resolvió nada: exigir
  -- EXACTAMENTE un grupo válido del docente en ciclo activo. Nunca
  -- "más reciente" (MG-B es una identidad histórica permanente, un
  -- error aquí no se autocorrige nunca) — se comprueba con un límite
  -- de 2 para detectar ambigüedad sin traer la lista completa: si el
  -- arreglo resultante tiene más de un elemento, hay ambigüedad real y
  -- deliberadamente NO se resuelve nada.
  if v_grupo_resuelto is null then
    select array_agg(c.id) into v_candidatos
    from (
      select g.id
      from public.grupos g
      join public.ciclos_escolares ce on ce.id = g.ciclo_escolar_id
      where g.docente_id = v_docente_id
        and ce.activo = true
      limit 2
    ) c;

    if array_length(v_candidatos, 1) = 1 then
      v_grupo_resuelto := v_candidatos[1];
    end if;
  end if;

  if v_grupo_resuelto is null then
    return; -- 0 candidatos, o 2+ ambiguos: nunca inferir, dejar sin snapshot
  end if;

  -- Escritura final, atómica y condicionada de nuevo (defensa en
  -- profundidad además del lock ya tomado arriba): jamás sobrescribe
  -- un grupo_id ya fijado, jamás toca una fila legacy o ajena.
  update public.conversaciones_chat
  set grupo_id = v_grupo_resuelto
  where id = p_conversacion_id
    and docente_id = v_docente_id
    and grupo_contexto_version = 1
    and grupo_id is null
    and eliminada_en is null;
end;
$$;

create or replace function public.registrar_propuesta_lista_oficial(p_docente_id uuid, p_propuesta jsonb) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
     and c.eliminada_en is null
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

create or replace function public.aplicar_propuesta_lista_oficial(p_propuesta_id uuid, p_confirmaciones jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
     and c.eliminada_en is null
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
-- POSCONDICIONES
-- ============================================================
do $$
declare
  v_item text;
  v_firma text;
begin
  if has_table_privilege('authenticated', 'public.conversaciones_chat', 'delete')
     or has_table_privilege('anon', 'public.conversaciones_chat', 'delete')
     or has_table_privilege('authenticated', 'public.mensajes_chat', 'delete')
     or has_table_privilege('anon', 'public.mensajes_chat', 'delete')
     or has_column_privilege('authenticated', 'public.conversaciones_chat', 'eliminada_en', 'update')
     or has_column_privilege('authenticated', 'public.conversaciones_chat', 'eliminada_en', 'insert')
     or not has_column_privilege('authenticated', 'public.conversaciones_chat', 'eliminada_en', 'select') then
    raise exception 'POSCONDICION_FALLIDA: permisos de tabla o columna inesperados.';
  end if;

  if exists (select 1 from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'conversaciones_chat' and cmd = 'DELETE') then
    raise exception 'POSCONDICION_FALLIDA: sigue existiendo una política de borrado de conversaciones.';
  end if;

  -- firma | debe tener eliminada_en | quién ejecuta (authenticated, service_role o ambos)
  foreach v_item in array array[
    'public.eliminar_conversacion(uuid)|authenticated',
    'public.conversacion_escribible(uuid)|authenticated',
    'public.fijar_grupo_conversacion(uuid)|authenticated,service_role',
    'public.registrar_propuesta_lista_oficial(uuid, jsonb)|service_role',
    'public.aplicar_propuesta_lista_oficial(uuid, jsonb)|authenticated'
  ] loop
    v_firma := split_part(v_item, '|', 1);
    if not (select p.prosecdef from pg_catalog.pg_proc p where p.oid = v_firma::regprocedure)
       or (select p.proconfig from pg_catalog.pg_proc p where p.oid = v_firma::regprocedure) is distinct from array['search_path=""']
       or ((select p.prosrc from pg_catalog.pg_proc p where p.oid = v_firma::regprocedure) not like '%eliminada_en is null%'
           and v_firma not like 'public.eliminar_conversacion%')
       or has_function_privilege('anon', v_firma, 'execute')
       or has_function_privilege('authenticated', v_firma, 'execute') <> (position('authenticated' in split_part(v_item, '|', 2)) > 0)
       or has_function_privilege('service_role', v_firma, 'execute') <> (position('service_role' in split_part(v_item, '|', 2)) > 0) then
      raise exception 'POSCONDICION_FALLIDA: % no quedó con seguridad, search_path, condición o EXECUTE esperados.', v_firma;
    end if;
  end loop;
end;
$$;

commit;
