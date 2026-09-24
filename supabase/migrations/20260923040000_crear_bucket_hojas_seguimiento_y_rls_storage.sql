-- ============================================================
-- Migración: bucket hojas-seguimiento + políticas RLS mínimas de
-- Storage para el pipeline de aprobación de Planeación (C-005 /
-- PLN-1E-H).
--
-- Causa real demostrada (ver informes forenses PLN-1E-F/PLN-1E-G,
-- 100% READ-ONLY, sin código ni datos modificados en esas fases):
-- storage.buckets y storage.objects tienen RLS habilitado desde el
-- inicio del proyecto pero CERO políticas para el rol authenticated
-- (confirmado con pg_policies) — los GRANT de tabla SÍ existen
-- (confirmado con information_schema.role_table_grants), así que la
-- única capa faltante es RLS, nunca GRANT. Los 3 buckets existentes
-- (documentos-institucionales, documentos-generados-ia,
-- imagenes-generadas-ia) siempre se escribieron con
-- SUPABASE_SERVICE_ROLE_KEY (ver app/api/chat/route.ts, la constante
-- supabaseRAG) — service_role bypassea RLS por diseño de Postgres
-- (rolbypassrls=true), así que esta brecha nunca se había
-- manifestado hasta que aprobarBorradorPlaneacion
-- (lib/planeacion/aprobarBorrador.ts) — la PRIMERA ruta del proyecto
-- que escribe a Storage con el cliente RLS-scoped del propio docente,
-- nunca service_role, por diseño explícito de esa función — intentó
-- usarlo por primera vez.
--
-- Bucket hojas-seguimiento: no existía (confirmado con
-- select * from storage.buckets) — se crea aquí, privado, de forma
-- idempotente (ON CONFLICT DO NOTHING). documentos-generados-ia YA
-- EXISTE (56 objetos reales) y esta migración NO lo recrea ni
-- modifica su contenido — solo agrega políticas de acceso.
--
-- Alcance de las políticas — el mínimo real demostrado por el código,
-- verificado línea por línea antes de escribir esta migración
-- (lib/documentGen/almacenamiento.ts, lib/seguimiento/generarYGuardarHoja.ts,
-- lib/documentGen/herramientas.ts):
--   - rutaArchivo(userId, nombre) = `${userId}/${Date.now()}-${nombre}`
--     — userId es SIEMPRE sesion.docente_id, que a su vez es SIEMPRE
--     el userId ya resuelto por autenticarRequestApi()/auth.getUser()
--     sobre el token real de la sesión (nunca un valor enviado aparte
--     por el cliente) — el primer segmento de storage.objects.name es
--     por tanto SIEMPRE auth.uid() del docente dueño del archivo.
--   - SELECT: necesario — createSignedUrl() (usado para la hoja y
--     para Word/PDF) requiere poder leer la fila del objeto bajo RLS.
--   - INSERT: necesario — subirBuffer() hace .upload(..., {upsert:false}).
--   - UPDATE: NO se otorga — ningún llamador de este pipeline usa
--     upsert:true ni ninguna otra forma de UPDATE sobre
--     storage.objects (verificado: la única llamada real es
--     upsert:false).
--   - DELETE: se otorga ÚNICAMENTE para hojas-seguimiento — es el
--     único bucket donde este pipeline realmente llama a
--     eliminarArchivo() (generarYGuardarHoja.ts línea ~133, limpieza
--     de un archivo huérfano si el UPDATE de hojas_evaluacion falla
--     DESPUÉS de una subida exitosa). documentos-generados-ia nunca
--     llama eliminarArchivo() en este pipeline (herramientas.ts no la
--     importa) — no se otorga DELETE ahí.
--   - storage.buckets: SOLO SELECT, limitado a los 2 buckets de esta
--     microfase — necesario para que asegurarBucket()/getBucket()
--     encuentre el bucket sin necesitar createBucket() en runtime
--     normal. NO se otorga INSERT de buckets a authenticated — la
--     aplicación nunca debe necesitar privilegios para crear buckets
--     en runtime.
--
-- Aislamiento por docente: (storage.foldername(name))[1] = auth.uid()::text
-- — storage.foldername() es la función helper estándar de Supabase,
-- ya presente en este proyecto (storage.foldername(name) devuelve
-- todos los segmentos de la ruta excepto el último). Con
-- name = '<uuid-docente>/<timestamp>-<archivo>', el resultado es
-- exactamente ARRAY['<uuid-docente>'], así que [1] es ese uuid.
--
-- Explícitamente NO otorgado por esta migración (alcance cerrado a
-- propósito — "no ampliar permisos innecesariamente"):
--   - imagenes-generadas-ia, documentos-institucionales, o cualquier
--     otro bucket presente o futuro — las políticas filtran
--     bucket_id de forma explícita y cerrada (IN (...) / = '...'),
--     nunca con una condición abierta.
--   - anon — todas las políticas están limitadas a "to authenticated".
--   - USING (true) / WITH CHECK (true) — ninguna política de esta
--     migración es abierta; todas exigen bucket_id conocido Y
--     coincidencia exacta de auth.uid().
--   - No se desactiva RLS en ningún momento — RLS ya estaba
--     habilitado (rls_habilitado=true) desde antes de esta migración
--     y sigue habilitado después (esta migración nunca ejecuta
--     ALTER TABLE ... DISABLE ROW LEVEL SECURITY).
--
-- Idempotente: el INSERT del bucket usa ON CONFLICT DO NOTHING; cada
-- política se recrea con DROP POLICY IF EXISTS + CREATE POLICY (el
-- patrón ya usado en migraciones previas de este proyecto, ver
-- 20260922000000_publicador_programa_analitico.sql) — reejecutar esta
-- migración completa no falla ni duplica nada.
--
-- Rollback (si hiciera falta revertir por completo):
--   begin;
--   drop policy if exists "hojas_seguimiento_docs_generados_select_propio" on storage.objects;
--   drop policy if exists "hojas_seguimiento_docs_generados_insert_propio" on storage.objects;
--   drop policy if exists "hojas_seguimiento_delete_propio" on storage.objects;
--   drop policy if exists "buckets_select_planeacion_aprobacion" on storage.buckets;
--   -- el bucket hojas-seguimiento y sus objetos NO se eliminan por
--   -- rollback (podría haber archivos reales ya subidos) — un borrado
--   -- de bucket/objetos es una decisión operativa aparte, nunca
--   -- automática.
--   commit;
-- ============================================================

begin;

-- 1) Bucket hojas-seguimiento — privado, idempotente.
insert into storage.buckets (id, name, public)
values ('hojas-seguimiento', 'hojas-seguimiento', false)
on conflict (id) do nothing;

-- 2) storage.buckets — SELECT restringido a los 2 buckets de esta
--    microfase, para que getBucket() funcione sin necesitar
--    createBucket() en runtime normal. NUNCA se otorga INSERT.
drop policy if exists "buckets_select_planeacion_aprobacion" on storage.buckets;
create policy "buckets_select_planeacion_aprobacion"
  on storage.buckets
  for select
  to authenticated
  using (id in ('hojas-seguimiento', 'documentos-generados-ia'));

-- 3) storage.objects — SELECT (necesario para createSignedUrl).
drop policy if exists "hojas_seguimiento_docs_generados_select_propio" on storage.objects;
create policy "hojas_seguimiento_docs_generados_select_propio"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id in ('hojas-seguimiento', 'documentos-generados-ia')
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- 4) storage.objects — INSERT (necesario para subirBuffer/.upload).
drop policy if exists "hojas_seguimiento_docs_generados_insert_propio" on storage.objects;
create policy "hojas_seguimiento_docs_generados_insert_propio"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id in ('hojas-seguimiento', 'documentos-generados-ia')
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- 5) storage.objects — DELETE, ÚNICAMENTE hojas-seguimiento (el único
--    bucket donde este pipeline realmente llama a eliminarArchivo()).
drop policy if exists "hojas_seguimiento_delete_propio" on storage.objects;
create policy "hojas_seguimiento_delete_propio"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'hojas-seguimiento'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

commit;
