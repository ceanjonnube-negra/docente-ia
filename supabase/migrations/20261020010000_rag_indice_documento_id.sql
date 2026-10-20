-- ============================================================
-- RAG: búsqueda vectorial EXACTA acotada al docente.
--
-- Problema (auditoría y banco sintético de la recuperación RAG):
-- documento_chunks_embedding_idx es un ivfflat (lists=100, probes=1) que,
-- en cuanto el planificador lo elige, entrega muy pocos candidatos y los
-- filtros por docente/estado/institución se aplican DESPUÉS: recall@4 de
-- 0–5 % con consultas realistas. Sin él, la búsqueda era un escaneo de
-- todo el corpus (de todos los docentes).
--
-- Corrección:
-- - Se elimina el ivfflat de documento_chunks.
-- - Se crea un btree en documento_chunks(documento_id) (llave de la unión
--   y de la política RLS de fragmentos): PostgreSQL filtra primero los
--   documentos del docente (índice (user_id, hash_archivo)) y calcula la
--   distancia solo sobre SUS fragmentos — resultado exacto.
-- - buscar_chunks_similares NO cambia (firma, cuerpo, permisos).
-- - No se toca ningún otro índice (incluido
--   documentos_institucionales_embedding_idx) ni ninguna tabla.
--
-- Estricta a propósito (sin IF EXISTS / IF NOT EXISTS): si el índice
-- anterior no existe o tiene otra definición, o si el nuevo ya existe, la
-- migración falla con un mensaje claro y no cambia nada (transacción).
-- lock_timeout evita esperar indefinidamente detrás de otra transacción.
-- ANALYZE se ejecuta APARTE, después (no forma parte del esquema).
--
-- Reversión (restaura exactamente el estado anterior):
--   begin;
--   set local lock_timeout = '5s';
--   drop index public.documento_chunks_documento_id_idx;
--   create index documento_chunks_embedding_idx on public.documento_chunks using ivfflat (embedding vector_cosine_ops) with (lists='100');
--   commit;
-- ============================================================

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.documento_chunks_embedding_idx') is null then
    raise exception 'precondición: no existe public.documento_chunks_embedding_idx';
  end if;
  if pg_get_indexdef('public.documento_chunks_embedding_idx'::regclass)
     <> 'CREATE INDEX documento_chunks_embedding_idx ON public.documento_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists=''100'')' then
    raise exception 'precondición: public.documento_chunks_embedding_idx tiene una definición distinta de la esperada';
  end if;
  if to_regclass('public.documento_chunks_documento_id_idx') is not null then
    raise exception 'precondición: ya existe public.documento_chunks_documento_id_idx';
  end if;
end;
$$;

drop index public.documento_chunks_embedding_idx;

create index documento_chunks_documento_id_idx on public.documento_chunks (documento_id);

commit;
