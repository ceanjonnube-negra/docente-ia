-- ============================================================
-- Migración: turnos duraderos del Chat IA (etapa del servidor).
--
-- Reutiliza public.turnos_chat (creada por 20260808000000, vacía en E2E y
-- Production) como la capa de turnos del chat: cada mensaje del docente
-- que /api/chat atiende es un turno con identidad persistente, adquirido
-- de forma atómica, cuya respuesta completa queda guardada en el servidor
-- antes de cerrar el stream. Una respuesta terminada se recupera sin
-- volver a llamar a la IA; un turno cuya ejecución murió vence solo (sin
-- turnos eternamente pendientes) y nunca se reintenta automáticamente.
--
-- Identidad exacta (nunca por coincidencia de texto):
--   - (docente_id, request_id) único: el mismo envío nunca se ejecuta dos
--     veces; huella_solicitud detecta un request_id reutilizado con otro
--     contenido.
--   - conversación del MISMO docente (FK compuesta a conversaciones_chat);
--     grupo = el de la conversación, resuelto aquí (nunca del cliente).
--   - mensaje_usuario_id: el mensaje del docente que originó el turno
--     ("<conversación>:<id>"); un solo turno vivo por mensaje.
--   - mensaje_asistente_id: "<conversación>:turno-<id>", único; solo se
--     materializa para clientes que lo adoptan (protocolo >= 1). El cliente
--     anterior guarda su propia copia: el servidor nunca crea otra.
--
-- Seguridad:
--   - RLS: el docente solo LEE sus turnos. Sin INSERT/UPDATE/DELETE
--     directos: adquirir/consultar (docente autenticado, auth.uid()) y
--     completar/fallar (SOLO service_role, la ejecución confiable de
--     /api/chat) son funciones SECURITY DEFINER con search_path vacío.
--   - Cada adquisición genera un ejecucion_id: completar/fallar lo exigen y
--     rechazan una finalización tardía (turno vencido, otra ejecución o ya
--     terminado).
--   - Completar es atómico: turno + mensaje del asistente + metadatos del
--     ajuste (planeacion_activa.ajustes) en una sola transacción; si algo no
--     es válido no se completa nada.
--
-- Aditiva sobre una tabla vacía: se detiene si turnos_chat tiene filas.
-- Rollback: revertir con la definición de 20260808000000 (tabla vacía).
-- ============================================================

begin;

-- Base: definición original de 20260808000000_crear_turnos_chat.sql (solo
-- versionada en test/images-v1). Ya existe en E2E y Production (verificado
-- en solo lectura); aquí solo se crea en una base nueva.
create table if not exists public.turnos_chat (
  id uuid primary key default gen_random_uuid(),
  docente_id uuid not null references public.perfiles_docentes(id),
  conversacion_id text,
  request_id text not null unique,
  estado text not null default 'queued'
    check (estado in ('queued', 'generating', 'completed', 'failed')),
  texto_parcial text not null default '',
  texto_final text,
  archivos jsonb not null default '[]',
  error text,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);
create index if not exists turnos_chat_docente_idx on public.turnos_chat (docente_id);
create index if not exists turnos_chat_conversacion_idx on public.turnos_chat (conversacion_id);
create index if not exists turnos_chat_estado_idx on public.turnos_chat (estado);
create index if not exists turnos_chat_creado_idx on public.turnos_chat (creado_en);
create index if not exists turnos_chat_docente_conversacion_creado_idx on public.turnos_chat (docente_id, conversacion_id, creado_en desc);
alter table public.turnos_chat enable row level security;
drop policy if exists "turnos_chat_select" on public.turnos_chat;
create policy "turnos_chat_select" on public.turnos_chat for select using (docente_id = auth.uid());

do $$
begin
  if exists (select 1 from public.turnos_chat) then
    raise exception 'turnos_chat tiene filas: revisar antes de migrar';
  end if;
end $$;

-- ------------------------------------------------------------
-- Columnas y restricciones
-- ------------------------------------------------------------
alter table public.turnos_chat drop constraint if exists turnos_chat_request_id_key;
alter table public.turnos_chat alter column conversacion_id type uuid using conversacion_id::uuid;
alter table public.turnos_chat alter column conversacion_id set not null;

alter table public.turnos_chat
  add column grupo_id uuid references public.grupos(id) on delete restrict,
  add column mensaje_usuario_id text,
  add column mensaje_asistente_id text,
  add column huella_solicitud text not null,
  add column protocolo smallint not null default 0,
  add column ejecucion_id uuid,
  add column vence_en timestamptz,
  add column codigo_error text,
  add column texto_crudo text,
  add column metadatos jsonb not null default '{}'::jsonb,
  add column reintento_de uuid references public.turnos_chat(id),
  add column completado_en timestamptz;

alter table public.turnos_chat
  add constraint turnos_chat_conversacion_docente_fkey
    foreign key (conversacion_id, docente_id) references public.conversaciones_chat(id, docente_id) on delete cascade,
  add constraint turnos_chat_docente_request_unico unique (docente_id, request_id),
  add constraint turnos_chat_mensaje_asistente_unico unique (mensaje_asistente_id),
  add constraint turnos_chat_request_id_formato check (char_length(request_id) between 8 and 200),
  add constraint turnos_chat_huella_formato check (huella_solicitud ~ '^[0-9a-f]{64}$'),
  add constraint turnos_chat_protocolo_valido check (protocolo between 0 and 1),
  add constraint turnos_chat_mensaje_usuario_de_conversacion check (mensaje_usuario_id is null or (starts_with(mensaje_usuario_id, conversacion_id::text || ':') and char_length(mensaje_usuario_id) <= 290)),
  add constraint turnos_chat_mensaje_asistente_formato check (mensaje_asistente_id is null or mensaje_asistente_id = conversacion_id::text || ':turno-' || id::text),
  add constraint turnos_chat_codigo_error_valido check (codigo_error is null or codigo_error in ('interrumpido', 'error_generacion', 'error_persistencia')),
  add constraint turnos_chat_en_curso_con_ejecucion check (estado not in ('queued', 'generating') or (ejecucion_id is not null and vence_en is not null)),
  add constraint turnos_chat_completado_con_resultado check (estado <> 'completed' or (texto_crudo is not null and completado_en is not null)),
  add constraint turnos_chat_fallido_con_codigo check (estado <> 'failed' or codigo_error is not null);

-- Un solo turno activo por conversación (orden de los efectos académicos)
-- y un solo turno vivo (en curso o terminado) por mensaje del docente.
create unique index turnos_chat_activo_por_conversacion on public.turnos_chat (conversacion_id) where estado in ('queued', 'generating');
create unique index turnos_chat_mensaje_usuario_vivo on public.turnos_chat (mensaje_usuario_id) where mensaje_usuario_id is not null and estado in ('queued', 'generating', 'completed');
create index turnos_chat_vence_idx on public.turnos_chat (vence_en) where estado in ('queued', 'generating');

-- ------------------------------------------------------------
-- RLS: solo lectura propia; escrituras exclusivamente por funciones.
-- ------------------------------------------------------------
drop policy if exists "turnos_chat_insert" on public.turnos_chat;
drop policy if exists "turnos_chat_update" on public.turnos_chat;
revoke insert, update, delete, truncate on public.turnos_chat from anon, authenticated;

-- ------------------------------------------------------------
-- Vista pública de un turno (nunca expone ejecucion_id)
-- ------------------------------------------------------------
create or replace function public.turno_chat_json(t public.turnos_chat)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', t.id,
    'request_id', t.request_id,
    'conversacion_id', t.conversacion_id,
    'grupo_id', t.grupo_id,
    'estado', t.estado,
    'codigo_error', t.codigo_error,
    'texto_crudo', case when t.estado = 'completed' then t.texto_crudo end,
    'texto_parcial', case when t.estado = 'failed' then t.texto_parcial end,
    'mensaje_usuario_id', t.mensaje_usuario_id,
    'mensaje_asistente_id', t.mensaje_asistente_id,
    'reintento_de', t.reintento_de,
    'reintentable', t.estado = 'failed',
    'creado_en', t.creado_en,
    'completado_en', t.completado_en
  )
$$;

-- Vencimiento perezoso: un turno en curso cuyo plazo pasó (la función de
-- Vercel murió: duración máxima, redespliegue, caída) se cierra como
-- interrumpido. Sin procesos programados.
create or replace function public.vencer_turnos_chat(p_conversacion_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.turnos_chat
     set estado = 'failed', codigo_error = 'interrumpido', actualizado_en = now()
   where conversacion_id = p_conversacion_id
     and estado in ('queued', 'generating')
     and vence_en < now();
$$;

-- ------------------------------------------------------------
-- adquirir_turno_chat — docente autenticado (auth.uid()).
-- resultado: adquirido | completado | en_proceso | fallido | conflicto |
--   ocupada | mensaje_en_curso | reintento_requerido | reintento_invalido |
--   conversacion_invalida | grupo_invalido | mensaje_invalido | parametros_invalidos
-- ------------------------------------------------------------
create or replace function public.adquirir_turno_chat(
  p_request_id text,
  p_conversacion_id uuid,
  p_mensaje_usuario_id text,
  p_huella text,
  p_protocolo smallint default 0,
  p_reintento_de text default null,
  p_plazo_segundos integer default 210
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_docente uuid := auth.uid();
  v_grupo uuid;
  v_existente public.turnos_chat;
  v_previo public.turnos_chat;
  v_nuevo public.turnos_chat;
begin
  if v_docente is null then
    raise exception 'no_autenticado' using errcode = '42501';
  end if;
  if p_request_id is null or char_length(p_request_id) not between 8 and 200
     or p_huella is null or p_huella !~ '^[0-9a-f]{64}$'
     or p_protocolo is null or p_protocolo not between 0 and 1
     or p_plazo_segundos is null or p_plazo_segundos not between 30 and 900 then
    return jsonb_build_object('resultado', 'parametros_invalidos');
  end if;

  -- Conversación propia y vigente; su grupo es el del turno.
  select c.grupo_id into v_grupo
    from public.conversaciones_chat c
   where c.id = p_conversacion_id and c.docente_id = v_docente and c.eliminada_en is null
   for key share;
  if not found then
    return jsonb_build_object('resultado', 'conversacion_invalida');
  end if;
  if v_grupo is not null and not exists (select 1 from public.grupos g where g.id = v_grupo and g.docente_id = v_docente) then
    return jsonb_build_object('resultado', 'grupo_invalido');
  end if;

  -- Mensaje del docente: de ESTA conversación; si ya está guardado, debe
  -- ser suyo y del docente (nunca un mensaje del asistente ni de otro).
  if p_mensaje_usuario_id is not null then
    if not starts_with(p_mensaje_usuario_id, p_conversacion_id::text || ':') or char_length(p_mensaje_usuario_id) > 290 then
      return jsonb_build_object('resultado', 'mensaje_invalido');
    end if;
    if exists (
      select 1 from public.mensajes_chat m
       where m.id = p_mensaje_usuario_id
         and (m.conversacion_id <> p_conversacion_id or m.docente_id <> v_docente or m.rol <> 'usuario')
    ) then
      return jsonb_build_object('resultado', 'mensaje_invalido');
    end if;
  end if;

  perform public.vencer_turnos_chat(p_conversacion_id);

  -- El mismo envío: se informa su estado, nunca se vuelve a ejecutar.
  select * into v_existente from public.turnos_chat t
   where t.docente_id = v_docente and t.request_id = p_request_id
   for update;
  if found then
    if v_existente.huella_solicitud <> p_huella or v_existente.conversacion_id <> p_conversacion_id then
      return jsonb_build_object('resultado', 'conflicto');
    end if;
    return jsonb_build_object(
      'resultado', case v_existente.estado when 'completed' then 'completado' when 'failed' then 'fallido' else 'en_proceso' end,
      'turno', public.turno_chat_json(v_existente));
  end if;

  -- Reintento: solo explícito, de un turno propio que falló, de la misma
  -- conversación y el mismo mensaje. Sin él, un mensaje cuyo turno falló no
  -- se vuelve a ejecutar.
  if p_reintento_de is not null then
    select * into v_previo from public.turnos_chat t
     where t.docente_id = v_docente and t.request_id = p_reintento_de
     for update;
    if not found or v_previo.estado <> 'failed' or v_previo.conversacion_id <> p_conversacion_id
       or v_previo.mensaje_usuario_id is distinct from p_mensaje_usuario_id then
      return jsonb_build_object('resultado', 'reintento_invalido');
    end if;
  elsif p_mensaje_usuario_id is not null and exists (
    select 1 from public.turnos_chat t
     where t.mensaje_usuario_id = p_mensaje_usuario_id and t.estado = 'failed'
  ) then
    return jsonb_build_object('resultado', 'reintento_requerido');
  end if;

  begin
    insert into public.turnos_chat (
      docente_id, conversacion_id, grupo_id, request_id, mensaje_usuario_id, huella_solicitud, protocolo,
      estado, ejecucion_id, vence_en, reintento_de
    ) values (
      v_docente, p_conversacion_id, v_grupo, p_request_id, p_mensaje_usuario_id, p_huella, p_protocolo,
      'generating', gen_random_uuid(), now() + make_interval(secs => p_plazo_segundos), v_previo.id
    )
    returning * into v_nuevo;
  exception when unique_violation then
    -- Carrera con otra adquisición: el mismo envío, otro turno activo en la
    -- conversación o un turno vivo del mismo mensaje.
    select * into v_existente from public.turnos_chat t
     where t.docente_id = v_docente and t.request_id = p_request_id;
    if found then
      return jsonb_build_object(
        'resultado', case when v_existente.huella_solicitud <> p_huella then 'conflicto' when v_existente.estado = 'completed' then 'completado' when v_existente.estado = 'failed' then 'fallido' else 'en_proceso' end,
        'turno', public.turno_chat_json(v_existente));
    end if;
    if exists (select 1 from public.turnos_chat t where t.conversacion_id = p_conversacion_id and t.estado in ('queued', 'generating')) then
      return jsonb_build_object('resultado', 'ocupada');
    end if;
    return jsonb_build_object('resultado', 'mensaje_en_curso');
  end;

  return jsonb_build_object('resultado', 'adquirido', 'turno', public.turno_chat_json(v_nuevo), 'ejecucion_id', v_nuevo.ejecucion_id);
end;
$$;

-- ------------------------------------------------------------
-- completar_turno_chat — SOLO service_role. Atómico: turno + mensaje del
-- asistente (si se materializa) + metadatos del ajuste. Cualquier dato
-- inválido aborta todo (el turno sigue en curso y el servidor lo falla).
-- resultado: completado | rechazado | vencido | no_encontrado
-- ------------------------------------------------------------
create or replace function public.completar_turno_chat(
  p_turno_id uuid,
  p_ejecucion_id uuid,
  p_texto_crudo text,
  p_texto_final text,
  p_materializar boolean,
  p_ajuste jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.turnos_chat;
  v_mensaje text;
  v_referencia jsonb;
  v_ajustes jsonb;
  v_entrada jsonb;
begin
  if p_texto_crudo is null then
    raise exception 'texto_crudo requerido';
  end if;
  select * into t from public.turnos_chat where id = p_turno_id for update;
  if not found then
    return jsonb_build_object('resultado', 'no_encontrado');
  end if;
  -- Finalización tardía u otra ejecución: nunca sobrescribe.
  if t.estado <> 'generating' or t.ejecucion_id is distinct from p_ejecucion_id then
    return jsonb_build_object('resultado', 'rechazado', 'turno', public.turno_chat_json(t));
  end if;
  if t.vence_en < now() then
    update public.turnos_chat set estado = 'failed', codigo_error = 'interrumpido', actualizado_en = now() where id = t.id returning * into t;
    return jsonb_build_object('resultado', 'vencido', 'turno', public.turno_chat_json(t));
  end if;

  -- Conversación vigente del mismo docente (se bloquea: ningún cambio de
  -- planeacion_activa se intercala).
  select c.planeacion_activa into v_referencia
    from public.conversaciones_chat c
   where c.id = t.conversacion_id and c.docente_id = t.docente_id and c.eliminada_en is null
   for update;
  if not found then
    raise exception 'conversacion_no_vigente';
  end if;

  if p_materializar then
    if t.protocolo < 1 or p_texto_final is null or btrim(p_texto_final) = '' then
      raise exception 'materializacion_invalida';
    end if;
    v_mensaje := t.conversacion_id::text || ':turno-' || t.id::text;
    insert into public.mensajes_chat (id, conversacion_id, docente_id, rol, texto, contenido)
    values (v_mensaje, t.conversacion_id, t.docente_id, 'asistente', p_texto_final,
            jsonb_build_object('turnoId', t.id, 'requestId', t.request_id, 'mensajeUsuarioId', t.mensaje_usuario_id));
  end if;

  -- Metadatos del borrador de ajuste: planeación del docente y de su grupo
  -- (el del turno, si lo tiene). Misma forma que registrarAjuste
  -- (lib/planeacion/modificarPlaneacion.ts), ligada al turno y al mensaje.
  if p_ajuste is not null then
    if jsonb_typeof(p_ajuste) <> 'object'
       or coalesce(p_ajuste->>'huella', '') !~ '^[0-9a-f]{64}$'
       or coalesce(p_ajuste->>'versionBase', '') !~ '^[1-9][0-9]{0,5}$'
       or coalesce(p_ajuste->>'planeacionId', '') !~ '^[0-9a-f-]{36}$'
       or coalesce(p_ajuste->>'grupoId', '') !~ '^[0-9a-f-]{36}$'
       or (t.grupo_id is not null and (p_ajuste->>'grupoId')::uuid <> t.grupo_id)
       or not exists (
         select 1 from public.planeaciones p
          where p.id = (p_ajuste->>'planeacionId')::uuid
            and p.docente_id = t.docente_id
            and p.grupo_id = (p_ajuste->>'grupoId')::uuid
       ) then
      raise exception 'ajuste_invalido';
    end if;
    v_entrada := jsonb_build_object(
      'planeacionId', p_ajuste->>'planeacionId',
      'versionBase', (p_ajuste->>'versionBase')::int,
      'grupoId', p_ajuste->>'grupoId',
      'huella', p_ajuste->>'huella',
      'formatoSolicitado', case when p_ajuste->>'formatoSolicitado' in ('word', 'pdf') then p_ajuste->>'formatoSolicitado' end,
      'creadoEn', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'turnoId', t.id,
      'mensajeId', v_mensaje);
    v_referencia := coalesce(v_referencia, '{}'::jsonb);
    select coalesce(jsonb_agg(a order by n), '[]'::jsonb) into v_ajustes
      from jsonb_array_elements(case when jsonb_typeof(v_referencia->'ajustes') = 'array' then v_referencia->'ajustes' else '[]'::jsonb end) with ordinality as x(a, n)
     where a->>'huella' is distinct from p_ajuste->>'huella';
    v_ajustes := v_ajustes || jsonb_build_array(v_entrada);
    -- Los 20 más recientes (MAXIMO_AJUSTES_REGISTRADOS).
    select coalesce(jsonb_agg(a order by n), '[]'::jsonb) into v_ajustes
      from jsonb_array_elements(v_ajustes) with ordinality as x(a, n)
     where n > jsonb_array_length(v_ajustes) - 20;
    update public.conversaciones_chat set planeacion_activa = v_referencia || jsonb_build_object('ajustes', v_ajustes)
     where id = t.conversacion_id;
  end if;

  update public.turnos_chat
     set estado = 'completed', texto_crudo = p_texto_crudo, texto_final = p_texto_final,
         mensaje_asistente_id = v_mensaje, codigo_error = null, error = null,
         metadatos = metadatos || case when p_ajuste is null then '{}'::jsonb else jsonb_build_object('ajuste', v_entrada) end,
         completado_en = now(), actualizado_en = now()
   where id = t.id
   returning * into t;
  return jsonb_build_object('resultado', 'completado', 'turno', public.turno_chat_json(t));
end;
$$;

-- ------------------------------------------------------------
-- fallar_turno_chat — SOLO service_role, misma ejecución.
-- ------------------------------------------------------------
create or replace function public.fallar_turno_chat(
  p_turno_id uuid,
  p_ejecucion_id uuid,
  p_codigo text,
  p_texto_parcial text default '',
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.turnos_chat;
begin
  if p_codigo is null or p_codigo not in ('interrumpido', 'error_generacion', 'error_persistencia') then
    raise exception 'codigo_invalido';
  end if;
  update public.turnos_chat
     set estado = 'failed', codigo_error = p_codigo, texto_parcial = coalesce(p_texto_parcial, ''),
         error = left(p_error, 500), actualizado_en = now()
   where id = p_turno_id and estado = 'generating' and ejecucion_id = p_ejecucion_id
   returning * into t;
  if not found then
    return jsonb_build_object('resultado', 'rechazado');
  end if;
  return jsonb_build_object('resultado', 'fallido', 'turno', public.turno_chat_json(t));
end;
$$;

-- ------------------------------------------------------------
-- consultar_turno_chat — docente autenticado: un turno por request_id, o
-- el más reciente de una conversación propia. Vence perezosamente.
-- ------------------------------------------------------------
create or replace function public.consultar_turno_chat(p_request_id text default null, p_conversacion_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_docente uuid := auth.uid();
  t public.turnos_chat;
begin
  if v_docente is null then
    raise exception 'no_autenticado' using errcode = '42501';
  end if;
  if p_request_id is not null then
    select * into t from public.turnos_chat x where x.docente_id = v_docente and x.request_id = p_request_id;
  elsif p_conversacion_id is not null then
    select * into t from public.turnos_chat x where x.docente_id = v_docente and x.conversacion_id = p_conversacion_id
     order by x.creado_en desc limit 1;
  end if;
  if t.id is null then
    return jsonb_build_object('resultado', 'no_encontrado');
  end if;
  perform public.vencer_turnos_chat(t.conversacion_id);
  select * into t from public.turnos_chat where id = t.id;
  return jsonb_build_object('resultado', 'encontrado', 'turno', public.turno_chat_json(t));
end;
$$;

-- ------------------------------------------------------------
-- Permisos de ejecución
-- ------------------------------------------------------------
revoke all on function public.turno_chat_json(public.turnos_chat) from public, anon, authenticated;
revoke all on function public.vencer_turnos_chat(uuid) from public, anon, authenticated;
revoke all on function public.adquirir_turno_chat(text, uuid, text, text, smallint, text, integer) from public, anon;
revoke all on function public.consultar_turno_chat(text, uuid) from public, anon;
revoke all on function public.completar_turno_chat(uuid, uuid, text, text, boolean, jsonb) from public, anon, authenticated;
revoke all on function public.fallar_turno_chat(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.adquirir_turno_chat(text, uuid, text, text, smallint, text, integer) to authenticated;
grant execute on function public.consultar_turno_chat(text, uuid) to authenticated;
grant execute on function public.completar_turno_chat(uuid, uuid, text, text, boolean, jsonb) to service_role;
grant execute on function public.fallar_turno_chat(uuid, uuid, text, text, text) to service_role;

commit;
