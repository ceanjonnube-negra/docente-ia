-- ============================================================
-- RAG: buscar_chunks_similares solo devuelve documentos PROPIOS.
--
-- Vulnerabilidad (auditoría del RAG de Production, main c917819): el chat
-- llama a esta RPC con un cliente service_role (sin RLS) y con un
-- p_institucion_id recibido del cliente sin validar, en TODAS las
-- peticiones (incluso sin sesión). La función solo filtraba por estado e
-- institución, así que entregaba fragmentos de documentos de cualquier
-- docente (o sin dueño) a quien la invocara de esa forma.
--
-- Corrección mínima: una sola condición, `di.user_id = auth.uid()`.
-- - auth.uid() es el `sub` del JWT verificado por PostgREST. service_role
--   y anon no tienen `sub` → NULL → ninguna fila (user_id = NULL nunca es
--   verdadero). Un docente solo recupera sus documentos, sea cual sea el
--   p_institucion_id que envíe. Los documentos sin dueño nunca se sirven.
-- - Para un docente autenticado el resultado no cambia: la RLS de
--   documentos_institucionales/documento_chunks ya lo limitaba a lo propio.
-- Se conservan la firma, el tipo de retorno, LANGUAGE sql, STABLE,
-- SECURITY INVOKER, la búsqueda (orden por distancia y límite) y los
-- permisos (CREATE OR REPLACE conserva los privilegios existentes).
--
-- Reversión EXACTA a la definición anterior (cuerpo md5
-- 6f4fe14d8a2be9753c87638210165a40):
--   begin;
--   CREATE OR REPLACE FUNCTION public.buscar_chunks_similares(query_embedding vector, cantidad integer DEFAULT 4, p_institucion_id uuid DEFAULT NULL::uuid)
--    RETURNS TABLE(chunk_texto text, documento_id uuid, nombre_archivo text, categoria text, similitud double precision)
--    LANGUAGE sql
--    STABLE
--   AS $function$
--     select
--       dc.chunk_texto,
--       dc.documento_id,
--       di.nombre_archivo,
--       di.categoria,
--       1 - (dc.embedding <=> query_embedding) as similitud
--     from documento_chunks dc
--     join documentos_institucionales di on di.id = dc.documento_id
--     where di.estado = 'activo'
--       and (
--         di.institucion_id is null
--         or di.institucion_id = p_institucion_id
--       )
--     order by dc.embedding <=> query_embedding
--     limit cantidad;
--   $function$;
--   commit;
-- (Al revertir se reabre la vulnerabilidad descrita arriba.)
-- ============================================================

begin;

CREATE OR REPLACE FUNCTION public.buscar_chunks_similares(query_embedding vector, cantidad integer DEFAULT 4, p_institucion_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(chunk_texto text, documento_id uuid, nombre_archivo text, categoria text, similitud double precision)
 LANGUAGE sql
 STABLE
AS $function$
  select
    dc.chunk_texto,
    dc.documento_id,
    di.nombre_archivo,
    di.categoria,
    1 - (dc.embedding <=> query_embedding) as similitud
  from documento_chunks dc
  join documentos_institucionales di on di.id = dc.documento_id
  where di.estado = 'activo'
    and di.user_id = auth.uid()
    and (
      di.institucion_id is null
      or di.institucion_id = p_institucion_id
    )
  order by dc.embedding <=> query_embedding
  limit cantidad;
$function$;

commit;
