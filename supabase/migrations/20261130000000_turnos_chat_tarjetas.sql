-- ============================================================
-- Migración: turnos duraderos — mensajes con tarjetas.
--
-- completar_turno_chat (20261129000000) materializaba solo respuestas de
-- texto. Ahora también guarda, en la MISMA transacción, las tarjetas que
-- son datos puros del mensaje (lib/asistente/textoFinalChat.ts,
-- mensajeDeRespuesta): archivo/archivos (referencias a archivos YA
-- generados: nada se vuelve a generar ni a subir) y contenidoDocumento.
-- Solo esas claves; cualquier otra aborta todo. Lo que depende del estado
-- del cliente (navegación, propuesta de lista, perfil) sigue sin
-- materializarse.
--
-- El mensaje se crea con la hora del servidor (la misma que completado_en):
-- el cliente la adopta y la conserva al agregar sus metadatos.
--
-- Mismo contrato de seguridad: SECURITY DEFINER, search_path vacío,
-- EXECUTE solo para service_role. Sin cambios de datos (solo la función).
-- Rollback: volver a crear la versión de 20261129000000.
-- ============================================================

begin;

drop function if exists public.completar_turno_chat(uuid, uuid, text, text, boolean, jsonb);

create function public.completar_turno_chat(
  p_turno_id uuid,
  p_ejecucion_id uuid,
  p_texto_crudo text,
  p_texto_final text,
  p_materializar boolean,
  p_ajuste jsonb default null,
  p_contenido jsonb default null
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
  -- Tarjetas del mensaje: solo datos puros conocidos.
  if p_contenido is not null and (
       jsonb_typeof(p_contenido) <> 'object'
       or exists (select 1 from jsonb_object_keys(p_contenido) k where k not in ('archivo', 'archivos', 'contenidoDocumento'))
       or (p_contenido ? 'archivo' and jsonb_typeof(p_contenido->'archivo') <> 'object')
       or (p_contenido ? 'archivos' and jsonb_typeof(p_contenido->'archivos') <> 'array')
       or (p_contenido ? 'contenidoDocumento' and jsonb_typeof(p_contenido->'contenidoDocumento') <> 'string')
     ) then
    raise exception 'contenido_invalido';
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
    insert into public.mensajes_chat (id, conversacion_id, docente_id, rol, texto, contenido, creado_en)
    values (v_mensaje, t.conversacion_id, t.docente_id, 'asistente', p_texto_final,
            coalesce(p_contenido, '{}'::jsonb) || jsonb_build_object('turnoId', t.id, 'requestId', t.request_id, 'mensajeUsuarioId', t.mensaje_usuario_id),
            now());
  elsif p_contenido is not null then
    raise exception 'contenido_sin_mensaje';
  end if;

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

revoke all on function public.completar_turno_chat(uuid, uuid, text, text, boolean, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.completar_turno_chat(uuid, uuid, text, text, boolean, jsonb, jsonb) to service_role;

commit;
