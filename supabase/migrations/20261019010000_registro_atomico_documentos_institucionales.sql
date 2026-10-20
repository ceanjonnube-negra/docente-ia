-- ============================================================
-- Registro ATÓMICO de documentos institucionales
-- (app/api/upload-documento/route.ts).
--
-- 1. Índice único (user_id, hash_archivo): exclusividad real por docente
--    y archivo. Dos cargas simultáneas del mismo archivo ya no pueden
--    quedar ambas: la segunda transacción recibe 23505 y se revierte.
--    Compatible con los datos existentes: hoy no hay documentos con dueño
--    ni duplicados por (user_id, hash_archivo); los documentos antiguos
--    tienen user_id NULL y los NULL no chocan entre sí en un índice único.
--
-- 2. public.registrar_documento_institucional(p_documento, p_fragmentos):
--    inserta el documento y TODOS sus fragmentos en una sola transacción.
--    Si cualquier paso falla (23505, RLS, un fragmento inválido, el
--    statement_timeout...), no queda nada: nunca existe un documento sin
--    sus fragmentos.
--    - SECURITY INVOKER: se ejecuta con los permisos y la RLS del docente
--      (las mismas políticas vigentes de documentos_institucionales y
--      documento_chunks); no amplía ningún permiso.
--    - user_id se toma EXCLUSIVAMENTE de auth.uid(); nunca del parámetro.
--    - storage_path debe estar en la carpeta del propio docente (<uid>/).
--    - search_path vacío: todo con nombre calificado.
--    - EXECUTE solo para authenticated (los privilegios por defecto del
--      esquema public lo conceden también a anon; aquí se revoca).
--
-- No modifica tablas, columnas ni políticas existentes, ni la RPC
-- buscar_chunks_similares.
--
-- Reversión:
--   begin;
--   drop function if exists public.registrar_documento_institucional(jsonb, jsonb);
--   drop index if exists public.documentos_institucionales_user_hash_uidx;
--   commit;
-- ============================================================

begin;

create unique index if not exists documentos_institucionales_user_hash_uidx
  on public.documentos_institucionales (user_id, hash_archivo);

create or replace function public.registrar_documento_institucional(p_documento jsonb, p_fragmentos jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_usuario uuid := auth.uid();
  v_documento uuid;
  v_total integer;
  v_insertados integer;
begin
  if v_usuario is null then
    raise exception 'sesión requerida' using errcode = '42501';
  end if;
  if jsonb_typeof(p_documento) is distinct from 'object'
     or coalesce(p_documento->>'hash_archivo', '') = ''
     or coalesce(p_documento->>'storage_path', '') = '' then
    raise exception 'documento incompleto' using errcode = '22023';
  end if;
  if split_part(p_documento->>'storage_path', '/', 1) <> v_usuario::text then
    raise exception 'ruta fuera de la carpeta del docente' using errcode = '42501';
  end if;
  if jsonb_typeof(p_fragmentos) is distinct from 'array' or jsonb_array_length(p_fragmentos) = 0 then
    raise exception 'fragmentos requeridos' using errcode = '22023';
  end if;
  v_total := jsonb_array_length(p_fragmentos);

  insert into public.documentos_institucionales (
    user_id, nombre_archivo, tipo, contenido_texto, categoria, descripcion, institucion_id,
    estado, tamano_bytes, hash_archivo, storage_path, version, num_embeddings
  ) values (
    v_usuario,
    p_documento->>'nombre_archivo',
    p_documento->>'tipo',
    p_documento->>'contenido_texto',
    p_documento->>'categoria',
    p_documento->>'descripcion',
    nullif(p_documento->>'institucion_id', '')::uuid,
    'activo',
    (p_documento->>'tamano_bytes')::bigint,
    p_documento->>'hash_archivo',
    p_documento->>'storage_path',
    1,
    v_total
  )
  returning id into v_documento;

  insert into public.documento_chunks (documento_id, chunk_index, chunk_texto, embedding)
  select v_documento, (f->>'chunk_index')::integer, f->>'chunk_texto', (f->>'embedding')::public.vector
  from jsonb_array_elements(p_fragmentos) as f;
  get diagnostics v_insertados = row_count;

  if v_insertados <> v_total then
    raise exception 'fragmentos incompletos' using errcode = '22023';
  end if;

  return v_documento;
end;
$$;

revoke all on function public.registrar_documento_institucional(jsonb, jsonb) from public;
revoke all on function public.registrar_documento_institucional(jsonb, jsonb) from anon;
grant execute on function public.registrar_documento_institucional(jsonb, jsonb) to authenticated;

commit;
