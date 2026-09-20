-- PA-4C — extiende public.programa_analitico_publicar (PA-3A) para
-- cerrar atómicamente el borrador que originó la publicación, en la
-- MISMA transacción que crea la versión/items/item_pda y mueve el
-- puntero vigente.
--
-- Por qué así y no 2 escrituras independientes desde TypeScript (ver
-- informe PA-4C §L): una RPC de publicación + un UPDATE de borrador
-- por separado dejaría una ventana real de inconsistencia si el
-- segundo paso falla después de que el primero ya comiteó (PA
-- publicado con el borrador todavía "pendiente", o viceversa). Una
-- función PL/pgSQL que invoca a otra dentro del mismo cuerpo comparte
-- la transacción implícita de la llamada — si CUALQUIER paso posterior
-- falla (incluido el cierre del borrador), PostgreSQL revierte TODO,
-- incluyendo lo que ya se había insertado en programa_analitico*.
--
-- CREATE OR REPLACE con un parámetro NUEVO al final con DEFAULT no
-- crea un overload duplicado (comportamiento documentado de
-- PostgreSQL: permitido agregar parámetros con default, prohibido
-- quitarlos o cambiar tipos existentes) — sigue siendo la MISMA
-- función, mismo oid, mismos grants ya otorgados en PA-3A. Se
-- reverifica igualmente por auditoría explícita (ver informe PA-4C §E
-- — PA-3A ya demostró que pg_default_acl puede sorprender).
begin;

create or replace function public.programa_analitico_publicar(
  p_grupo_id uuid,
  p_idempotency_key text,
  p_curriculo_version_id uuid,
  p_curriculo_fase_id uuid,
  p_curriculo_grado_id uuid,
  p_contexto_notas text,
  p_items jsonb,
  p_borrador_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_docente_id uuid;
  v_operacion_id uuid;
  v_operacion_grupo_id uuid;
  v_pa_id uuid;
  v_version_id uuid;
  v_numero_version integer;
  v_item jsonb;
  v_item_id uuid;
  v_pda_grado_id uuid;
  v_filas_borrador integer;
begin
  v_docente_id := auth.uid();
  if v_docente_id is null then
    raise exception 'NO_AUTENTICADO';
  end if;

  if p_grupo_id is null then
    raise exception 'FALTA_GRUPO_ID';
  end if;

  if p_idempotency_key is null or btrim(p_idempotency_key) = '' then
    raise exception 'FALTA_IDEMPOTENCY_KEY';
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'PROPUESTA_SIN_ITEMS';
  end if;

  -- Mensaje de error explícito antes que dejar que RLS lo rechace de
  -- forma genérica más abajo — la propiedad real ya la exige también
  -- el with_check de programa_analitico_insert.
  if not exists (select 1 from public.grupos g where g.id = p_grupo_id and g.docente_id = v_docente_id) then
    raise exception 'GRUPO_NO_ENCONTRADO';
  end if;

  -- Serializa cualquier llamada concurrente para este grupo — se
  -- libera automáticamente al terminar la transacción de esta
  -- llamada (COMMIT o ROLLBACK), funciona igual si el contenedor aún
  -- no existe.
  perform pg_advisory_xact_lock(hashtextextended(p_grupo_id::text, 0));

  -- Idempotencia: INSERT...ON CONFLICT, nunca SELECT-then-INSERT.
  insert into public.programa_analitico_operacion (docente_id, grupo_id, idempotency_key)
  values (v_docente_id, p_grupo_id, p_idempotency_key)
  on conflict (docente_id, idempotency_key) do nothing
  returning id into v_operacion_id;

  if v_operacion_id is null then
    select o.grupo_id, o.programa_analitico_id, o.programa_analitico_version_id, o.numero_version
      into v_operacion_grupo_id, v_pa_id, v_version_id, v_numero_version
    from public.programa_analitico_operacion o
    where o.docente_id = v_docente_id and o.idempotency_key = p_idempotency_key;

    if v_operacion_grupo_id is distinct from p_grupo_id then
      raise exception 'IDEMPOTENCY_KEY_REUTILIZADA_OTRO_GRUPO';
    end if;

    -- Retry: el borrador (si existía) ya quedó cerrado atómicamente en
    -- el intento original que sí publicó — nunca se vuelve a tocar
    -- aquí, evita un segundo UPDATE innecesario.
    return jsonb_build_object(
      'programaAnaliticoId', v_pa_id,
      'programaAnaliticoVersionId', v_version_id,
      'numeroVersion', v_numero_version,
      'reutilizadaPorIdempotencia', true
    );
  end if;

  -- Obtener contenedor o crearlo (CASO A vs CASO B, ver PA-3A §10).
  select id into v_pa_id from public.programa_analitico where grupo_id = p_grupo_id;

  if v_pa_id is null then
    insert into public.programa_analitico (grupo_id) values (p_grupo_id) returning id into v_pa_id;
    v_numero_version := 1;
  else
    select coalesce(max(numero_version), 0) + 1 into v_numero_version
    from public.programa_analitico_version
    where programa_analitico_id = v_pa_id;
  end if;

  -- Versión SIEMPRE nueva y completa — nunca UPDATE de una versión
  -- anterior, nunca copia parcial implícita.
  insert into public.programa_analitico_version (
    programa_analitico_id, numero_version, curriculo_version_id, curriculo_fase_id, curriculo_grado_id, contexto_notas, creado_por
  ) values (
    v_pa_id, v_numero_version, p_curriculo_version_id, p_curriculo_fase_id, p_curriculo_grado_id, p_contexto_notas, v_docente_id
  ) returning id into v_version_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    insert into public.programa_analitico_item (
      programa_analitico_version_id, curriculo_version_id, curriculo_grado_id,
      curriculo_contenido_id, tipo_decision, texto_contextualizado, texto_local,
      resultado_esperado_local, periodo_evaluacion_id, orden
    ) values (
      v_version_id, p_curriculo_version_id, p_curriculo_grado_id,
      nullif(v_item->>'curriculoContenidoId', '')::uuid,
      v_item->>'tipoDecision',
      v_item->>'textoContextualizado',
      v_item->>'textoLocal',
      v_item->>'resultadoEsperadoLocal',
      nullif(v_item->>'periodoEvaluacionId', '')::uuid,
      (v_item->>'orden')::integer
    ) returning id into v_item_id;

    for v_pda_grado_id in select (jsonb_array_elements_text(v_item->'curriculoPdaGradoIds'))::uuid
    loop
      insert into public.programa_analitico_item_pda (
        programa_analitico_item_id, curriculo_contenido_id, curriculo_version_id, curriculo_grado_id, curriculo_pda_grado_id
      ) values (
        v_item_id, nullif(v_item->>'curriculoContenidoId', '')::uuid, p_curriculo_version_id, p_curriculo_grado_id, v_pda_grado_id
      );
    end loop;
  end loop;

  update public.programa_analitico set version_vigente_id = v_version_id where id = v_pa_id;

  update public.programa_analitico_operacion
  set programa_analitico_id = v_pa_id, programa_analitico_version_id = v_version_id, numero_version = v_numero_version
  where id = v_operacion_id;

  -- Cierre atómico del borrador, en la MISMA transacción que la
  -- publicación real. Exige exactamente 1 fila afectada (docente
  -- dueño + todavía pendiente) — si el borrador ya no coincide (p.ej.
  -- fue descartado por una carrera justo antes), aborta TODA la
  -- transacción, incluyendo lo ya insertado arriba: nunca queda un PA
  -- publicado cuyo borrador no se pudo cerrar coherentemente.
  if p_borrador_id is not null then
    update public.programa_analitico_borrador
    set estado = 'publicado', programa_analitico_version_id = v_version_id, actualizado_en = now()
    where id = p_borrador_id and docente_id = v_docente_id and estado = 'pendiente';

    get diagnostics v_filas_borrador = row_count;
    if v_filas_borrador <> 1 then
      raise exception 'BORRADOR_NO_PENDIENTE_AL_CONFIRMAR';
    end if;
  end if;

  return jsonb_build_object(
    'programaAnaliticoId', v_pa_id,
    'programaAnaliticoVersionId', v_version_id,
    'numeroVersion', v_numero_version,
    'reutilizadaPorIdempotencia', false
  );
end;
$function$;

commit;
