-- ============================================================
-- Políticas de Storage del bucket privado documentos-institucionales
-- (carga de documentos del docente, app/api/upload-documento/route.ts).
--
-- Mismo patrón ya vigente para hojas-seguimiento y documentos-generados-ia
-- (20260923040000_crear_bucket_hojas_seguimiento_y_rls_storage.sql), que
-- dejó fuera este bucket a propósito:
-- - solo el rol authenticated;
-- - bucket_id explícito y cerrado (= 'documentos-institucionales');
-- - aislamiento por docente: (storage.foldername(name))[1] = auth.uid()::text,
--   es decir, cada docente solo opera dentro de su carpeta <uid>/.
-- SELECT (lectura/verificación), INSERT (carga del original) y DELETE
-- (limpieza si la indexación falla). Nunca UPDATE ni acceso anónimo.
--
-- No crea ni modifica el bucket (ya existe, privado). No toca políticas de
-- ningún otro bucket ni de storage.buckets. Los objetos antiguos que no
-- están bajo una carpeta <uid>/ siguen inaccesibles para cualquier usuario.
--
-- Idempotente (drop policy if exists + create policy).
--
-- Reversión:
--   begin;
--   drop policy if exists "documentos_institucionales_select_propio" on storage.objects;
--   drop policy if exists "documentos_institucionales_insert_propio" on storage.objects;
--   drop policy if exists "documentos_institucionales_delete_propio" on storage.objects;
--   commit;
-- ============================================================

begin;

drop policy if exists "documentos_institucionales_select_propio" on storage.objects;
create policy "documentos_institucionales_select_propio"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'documentos-institucionales'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "documentos_institucionales_insert_propio" on storage.objects;
create policy "documentos_institucionales_insert_propio"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'documentos-institucionales'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "documentos_institucionales_delete_propio" on storage.objects;
create policy "documentos_institucionales_delete_propio"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'documentos-institucionales'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

commit;
