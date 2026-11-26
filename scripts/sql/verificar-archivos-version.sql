-- Pruebas de 20261202000000 (Word y PDF por versión) por rol real.
\set ON_ERROR_STOP on
\set A 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
\set B 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
\set GA 'a1000000-0000-4000-8000-000000000001'
\set GB 'b1000000-0000-4000-8000-000000000001'
\set PA 'da000000-0000-4000-8000-000000000001'
\set PB 'db000000-0000-4000-8000-000000000001'
\set PC 'dc000000-0000-4000-8000-000000000001'
\set V3 'e3000000-0000-4000-8000-000000000003'
\set V4 'e4000000-0000-4000-8000-000000000004'
\set VC 'ec000000-0000-4000-8000-000000000003'
\set VB 'eb000000-0000-4000-8000-000000000001'
\set WORD 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

create table public.resultados (n serial primary key, nombre text not null, ok boolean not null);
grant all on public.resultados to public;
grant usage on sequence public.resultados_n_seq to public;
create function public.intentar(p_sql text) returns text language plpgsql as $$ begin execute p_sql; return 'ok'; exception when others then return sqlstate; end $$;
grant execute on function public.intentar(text) to public;
-- Archivo como lo deja ejecutarHerramientaDocumento: registrado (con su
-- origen, si es de una versión) y confirmado.
create function public.archivo(p_docente uuid, p_mime text, p_version uuid default null, p_formato text default null, p_ejecucion uuid default null, p_estado text default 'activo', p_clase text default 'conservar') returns uuid language sql as $$
  insert into public.archivos_generados (docente_id, bucket, ruta, nombre, tipo_mime, estado, activado_en, clase, version_id, version_formato, version_ejecucion_id)
  values (p_docente, 'documentos-generados-ia', p_docente::text || '/' || gen_random_uuid()::text || '-PLANEACION.x', 'PLANEACION.x', p_mime, p_estado,
          case when p_estado = 'activo' then now() end, p_clase, p_version, p_formato, p_ejecucion) returning id $$;
create function public.ejecucion(p_version uuid, p_formato text) returns uuid language sql as $$
  select ejecucion_id from public.planeacion_version_archivos where version_id = p_version and formato = p_formato $$;

insert into public.perfiles_docentes values (:'A'), (:'B');
insert into public.grupos values (:'GA', :'A'), (:'GB', :'B');
insert into public.planeaciones values (:'PA', :'A', :'GA'), (:'PB', :'B', :'GB'), (:'PC', :'A', :'GA');
insert into public.planeacion_versiones (id, planeacion_id, docente_id, grupo_id, numero, contenido) values
  (:'V3', :'PA', :'A', :'GA', 3, 'texto v3'), (:'V4', :'PA', :'A', :'GA', 4, 'texto v4'), (:'VC', :'PC', :'A', :'GA', 3, 'otra planeación'), (:'VB', :'PB', :'B', :'GB', 1, 'texto de B');

\echo == 0. Retrocompatibilidad
select public.archivo(:'A', :'WORD') as historico \gset
insert into resultados (nombre, ok) values ('0a. Archivos históricos y de otros generadores: se registran sin origen, como siempre',
  (select version_id is null and version_formato is null and version_ejecucion_id is null from public.archivos_generados where id = :'historico'));
insert into resultados (nombre, ok) values ('0b. El origen va completo o no va, y su formato coincide con el tipo MIME',
  public.intentar(format('insert into public.archivos_generados (docente_id, bucket, ruta, nombre, tipo_mime, version_id) values (%L, %L, %L, %L, %L, %L)', :'A', 'documentos-generados-ia', :'A' || '/p1', 'x', :'WORD', :'V4')) = '23514'
  and public.intentar(format('insert into public.archivos_generados (docente_id, bucket, ruta, nombre, tipo_mime, version_id, version_formato, version_ejecucion_id) values (%L, %L, %L, %L, %L, %L, %L, %L)', :'A', 'documentos-generados-ia', :'A' || '/p2', 'x', 'application/pdf', :'V4', 'word', gen_random_uuid())) = '23514');

\echo == 1. Reservar
set role service_role;
select public.reservar_archivo_version(:'A', :'V4', 'word') as r1 \gset
select :'r1'::jsonb->>'ejecucion_id' as e1 \gset
insert into resultados (nombre, ok) values ('1a. Reserva por versión y formato', (:'r1'::jsonb->>'resultado') = 'reservado' and :'e1' <> '');
insert into resultados (nombre, ok) values ('1b. Una segunda solicitud mientras se genera: en_proceso (una sola generación)', (public.reservar_archivo_version(:'A', :'V4', 'word')->>'resultado') = 'en_proceso');
insert into resultados (nombre, ok) values ('1c. Otro formato de la misma versión se reserva aparte', (public.reservar_archivo_version(:'A', :'V4', 'pdf')->>'resultado') = 'reservado');
insert into resultados (nombre, ok) values ('1d. Versión de otro docente o formato inválido: rechazados',
  (public.reservar_archivo_version(:'A', :'VB', 'word')->>'resultado') = 'version_invalida' and (public.reservar_archivo_version(:'A', :'V4', 'excel')->>'resultado') = 'parametros_invalidos');
reset role;

\echo == 2. Procedencia exacta
select public.archivo(:'A', :'WORD') as sin_origen,
       public.archivo(:'A', :'WORD', :'V3', 'word', :'e1') as otra_version,
       public.archivo(:'A', 'application/pdf', :'V4', 'pdf', :'e1') as otro_formato,
       public.archivo(:'A', :'WORD', :'V4', 'word', gen_random_uuid()) as otra_ejecucion,
       public.archivo(:'B', :'WORD', :'V4', 'word', :'e1') as ajeno,
       public.archivo(:'A', :'WORD', :'V4', 'word', :'e1', 'subiendo') as subiendo,
       public.archivo(:'A', :'WORD', :'V4', 'word', :'e1') as bueno \gset
set role service_role;
insert into resultados (nombre, ok) values ('2a. Sin origen (histórico o de otro generador): archivo_invalido', (public.vincular_archivo_version(:'A', :'V4', 'word', :'e1', :'sin_origen')->>'resultado') = 'archivo_invalido');
insert into resultados (nombre, ok) values ('2b. Origen de otra versión, otro formato u otra ejecución: archivo_invalido',
  (public.vincular_archivo_version(:'A', :'V4', 'word', :'e1', :'otra_version')->>'resultado') = 'archivo_invalido'
  and (public.vincular_archivo_version(:'A', :'V4', 'word', :'e1', :'otro_formato')->>'resultado') = 'archivo_invalido'
  and (public.vincular_archivo_version(:'A', :'V4', 'word', :'e1', :'otra_ejecucion')->>'resultado') = 'archivo_invalido');
insert into resultados (nombre, ok) values ('2c. Mismo origen pero de otro docente, o sin confirmar: archivo_invalido',
  (public.vincular_archivo_version(:'A', :'V4', 'word', :'e1', :'ajeno')->>'resultado') = 'archivo_invalido'
  and (public.vincular_archivo_version(:'A', :'V4', 'word', :'e1', :'subiendo')->>'resultado') = 'archivo_invalido');
insert into resultados (nombre, ok) values ('2d. Quien no tiene la reserva no vincula ni con un archivo válido', (public.vincular_archivo_version(:'A', :'V4', 'word', gen_random_uuid(), :'bueno')->>'resultado') = 'rechazado');
reset role;
insert into resultados (nombre, ok) values ('2e. El origen no se puede reescribir después del registro (ni el propietario de la base)',
  public.intentar(format('update public.archivos_generados set version_ejecucion_id = %L where id = %L', :'e1', :'otra_ejecucion')) = 'P0001'
  and public.intentar(format('update public.archivos_generados set version_id = %L, version_formato = %L, version_ejecucion_id = %L where id = %L', :'V4', 'word', :'e1', :'sin_origen')) = 'P0001'
  and public.intentar(format('update public.archivos_generados set estado = %L, activado_en = null where id = %L', 'fallido', :'sin_origen')) = 'ok');

\echo == 3. Vincular
set role service_role;
select public.vincular_archivo_version(:'A', :'V4', 'word', :'e1', :'bueno') as v1 \gset
reset role;
insert into resultados (nombre, ok) values ('3a. El archivo de esta versión, formato y ejecución queda ligado',
  (:'v1'::jsonb->>'resultado') = 'vinculado' and (select documento_word_archivo_id from public.planeacion_versiones where id = :'V4') = :'bueno'
  and (select estado = 'vinculado' and archivo_id = :'bueno' from public.planeacion_version_archivos where version_id = :'V4' and formato = 'word'));
set role service_role;
insert into resultados (nombre, ok) values ('3b. Pedirlo otra vez: existente (se recupera el original, sin generar)', (public.reservar_archivo_version(:'A', :'V4', 'word')->>'resultado') = 'existente' and (public.reservar_archivo_version(:'A', :'V4', 'word')->>'archivo_id') = :'bueno');
reset role;
insert into resultados (nombre, ok) values ('3c. Referencia inmutable: ni siquiera el propietario de la base la sustituye',
  public.intentar(format('update public.planeacion_versiones set documento_word_archivo_id = %L where id = %L', :'otra_version', :'V4')) = 'P0001');

\echo == 4. Ejecución vencida o sustituida
-- PDF de v4 (reservado en 1c): su plazo vence antes de vincular.
select public.ejecucion(:'V4', 'pdf') as e_pdf \gset
select public.archivo(:'A', 'application/pdf', :'V4', 'pdf', :'e_pdf') as pdf_vencido \gset
update public.planeacion_version_archivos set vence_en = now() - interval '1 second' where version_id = :'V4' and formato = 'pdf';
set role service_role;
insert into resultados (nombre, ok) values ('4a. Ejecución vencida (aún sin sustituir): no vincula su archivo',
  (public.vincular_archivo_version(:'A', :'V4', 'pdf', :'e_pdf', :'pdf_vencido')->>'resultado') = 'vencido');
reset role;
insert into resultados (nombre, ok) values ('4b. …la reserva queda fallida y la versión sin archivo',
  (select estado = 'fallido' from public.planeacion_version_archivos where version_id = :'V4' and formato = 'pdf')
  and (select documento_pdf_archivo_id is null from public.planeacion_versiones where id = :'V4'));
set role service_role;
select public.reservar_archivo_version(:'A', :'V4', 'pdf') as r2 \gset
reset role;
select public.archivo(:'A', 'application/pdf', :'V4', 'pdf', (:'r2'::jsonb->>'ejecucion_id')::uuid) as pdf_nuevo \gset
set role service_role;
insert into resultados (nombre, ok) values ('4c. Ejecución sustituida por un nuevo intento: rechazada aunque su archivo sea válido para ella',
  (public.vincular_archivo_version(:'A', :'V4', 'pdf', :'e_pdf', :'pdf_vencido')->>'resultado') = 'rechazado');
insert into resultados (nombre, ok) values ('4d. Su archivo tampoco sirve a la ejecución vigente (otra identidad)',
  (public.vincular_archivo_version(:'A', :'V4', 'pdf', (:'r2'::jsonb->>'ejecucion_id')::uuid, :'pdf_vencido')->>'resultado') = 'archivo_invalido');
insert into resultados (nombre, ok) values ('4e. La ejecución vigente vincula el suyo', (public.vincular_archivo_version(:'A', :'V4', 'pdf', (:'r2'::jsonb->>'ejecucion_id')::uuid, :'pdf_nuevo')->>'resultado') = 'vinculado');
-- Falla de generación y reintento posterior (sin aprobar de nuevo).
select public.reservar_archivo_version(:'A', :'VC', 'word') as rc \gset
insert into resultados (nombre, ok) values ('4f. Generación fallida: se marca', (public.fallar_archivo_version(:'A', :'VC', 'word', (:'rc'::jsonb->>'ejecucion_id')::uuid, 'fallo de prueba')->>'resultado') = 'fallido');
select public.reservar_archivo_version(:'A', :'VC', 'word') as rc2 \gset
insert into resultados (nombre, ok) values ('4g. …y se vuelve a reservar con otra ejecución y un intento más',
  (:'rc2'::jsonb->>'resultado') = 'reservado' and (:'rc2'::jsonb->>'ejecucion_id') <> (:'rc'::jsonb->>'ejecucion_id')
  and (select intentos from public.planeacion_version_archivos where version_id = :'VC' and formato = 'word') = 2);
reset role;
set role service_role;
select public.reservar_archivo_version(:'A', :'V3', 'word') as r3 \gset
insert into resultados (nombre, ok) values ('4h. Un archivo ya ligado a una versión no puede ligarse a otra (ni con su reserva vigente)',
  (public.vincular_archivo_version(:'A', :'V3', 'word', (:'r3'::jsonb->>'ejecucion_id')::uuid, :'bueno')->>'resultado') = 'archivo_invalido');
reset role;

\echo == 5. Permisos y aislamiento
set role authenticated;
select set_config('request.jwt.claim.sub', :'A', false) \gset
insert into resultados (nombre, ok) values ('5a. El docente no puede reservar, vincular ni fallar (solo la ejecución del servidor)',
  public.intentar(format('select public.reservar_archivo_version(%L, %L, %L)', :'A', :'V3', 'pdf')) = '42501'
  and public.intentar(format('select public.vincular_archivo_version(%L, %L, %L, %L, %L)', :'A', :'V3', 'word', gen_random_uuid(), :'bueno')) = '42501'
  and public.intentar(format('select public.fallar_archivo_version(%L, %L, %L, %L)', :'A', :'V3', 'word', gen_random_uuid())) = '42501'
  and public.intentar(format('insert into public.planeacion_version_archivos (version_id, formato, docente_id, estado) values (%L, %L, %L, %L)', :'V3', 'pdf', :'A', 'fallido')) = '42501');
insert into resultados (nombre, ok) values ('5b. El docente ve solo sus reservas', (select count(*) from public.planeacion_version_archivos) = 4);
select set_config('request.jwt.claim.sub', :'B', false) \gset
insert into resultados (nombre, ok) values ('5c. Otro docente no ve las reservas ajenas', (select count(*) from public.planeacion_version_archivos) = 0);
reset role;
