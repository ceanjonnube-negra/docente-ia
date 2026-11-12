-- Pruebas de la migración 20261113000000_registro_archivos_generados
-- (etapa 3B-2A). Todo ocurre en una transacción que termina en ROLLBACK,
-- con datos ficticios: ningún cambio persiste y Storage no se toca.
-- Requiere la migración aplicada y una sesión de propietario (postgres)
-- para sembrar datos; las comprobaciones se hacen con service_role,
-- authenticated y anon.
--
-- psql -X -v ON_ERROR_STOP=1 -f supabase/pruebas/registro_archivos_generados.sql
-- Termina con "TODAS LAS PRUEBAS SQL PASARON" o se detiene en la primera falla.

\set ON_ERROR_STOP on
begin;

create temporary table _storage_antes as select count(*) as objetos from storage.objects;

insert into auth.users (id) values
  ('a1000000-0000-4000-8000-0000000000a1'), ('b1000000-0000-4000-8000-0000000000b1');
insert into public.perfiles_docentes (id) values
  ('a1000000-0000-4000-8000-0000000000a1'), ('b1000000-0000-4000-8000-0000000000b1');
insert into public.conversaciones_chat (id, docente_id) values
  ('ca000000-0000-4000-8000-0000000000ca', 'a1000000-0000-4000-8000-0000000000a1'),
  ('cb000000-0000-4000-8000-0000000000cb', 'b1000000-0000-4000-8000-0000000000b1');

create function pg_temp.comprobar(condicion boolean, mensaje text) returns void language plpgsql as $$
begin
  if condicion is not true then raise exception 'FALLA: %', mensaje; end if;
  raise notice 'ok: %', mensaje;
end $$;
create function pg_temp.estado_de(sentencia text) returns text language plpgsql as $$
begin
  execute sentencia;
  return 'OK';
exception when others then
  return sqlstate;
end $$;
grant execute on all functions in schema pg_temp to service_role, authenticated, anon;

-- Inserción típica del servidor (ruta bajo la carpeta del docente).
create function pg_temp.archivo(id text, docente text, ruta text, clase text, conversacion text) returns text language sql as $$
  select format($f$insert into public.archivos_generados (id, docente_id, bucket, ruta, nombre, tipo_mime, tamano_bytes, clase, conversacion_id)
                   values (%L, %L, 'documentos-generados-ia', %L, 'X.pdf', 'application/pdf', 10, %L, %L)$f$, id, docente, ruta, clase, conversacion)
$$;
grant execute on function pg_temp.archivo(text, text, text, text, text) to service_role;

-- ================= service_role (el servidor) =================
set local role service_role;

select pg_temp.comprobar(pg_temp.estado_de(pg_temp.archivo('f1000000-0000-4000-8000-0000000000f1', 'a1000000-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-0000000000a1/1-CITATORIO.pdf', 'efimero', 'ca000000-0000-4000-8000-0000000000ca')) = 'OK', '1a. archivo efímero con conversación propia: registrado');
select pg_temp.comprobar((select estado = 'subiendo' and activado_en is null from public.archivos_generados where id = 'f1000000-0000-4000-8000-0000000000f1'), '1b. empieza en estado subiendo');
select pg_temp.comprobar(pg_temp.estado_de(pg_temp.archivo('f2000000-0000-4000-8000-0000000000f2', 'a1000000-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-0000000000a1/2-PLAN.pdf', 'conservar', null)) = 'OK', '1c. conservar sin conversación: registrado (protegido)');
-- (dos sentencias: la consulta exterior no ve lo que inserta la función en la misma sentencia)
select pg_temp.comprobar(pg_temp.estado_de($q$insert into public.archivos_generados (docente_id, bucket, ruta, nombre, tipo_mime, tamano_bytes) values ('a1000000-0000-4000-8000-0000000000a1', 'documentos-generados-ia', 'a1000000-0000-4000-8000-0000000000a1/3-x.pdf', 'x', 'application/pdf', 1)$q$) = 'OK', '1d. registro sin clase explícita: aceptado');
select pg_temp.comprobar((select clase from public.archivos_generados where ruta = 'a1000000-0000-4000-8000-0000000000a1/3-x.pdf') = 'conservar', '1e. sin clase explícita queda como conservar');

select pg_temp.comprobar(pg_temp.estado_de(pg_temp.archivo('f4000000-0000-4000-8000-0000000000f4', 'a1000000-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-0000000000a1/4.pdf', 'efimero', null)) = '23514', '2a. efímero sin conversación: rechazado');
select pg_temp.comprobar(pg_temp.estado_de(pg_temp.archivo('f5000000-0000-4000-8000-0000000000f5', 'a1000000-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-0000000000a1/5.pdf', 'conservar', 'ca000000-0000-4000-8000-0000000000ca')) = '23514', '2b. conservar con conversación: rechazado');
select pg_temp.comprobar(pg_temp.estado_de(pg_temp.archivo('f6000000-0000-4000-8000-0000000000f6', 'a1000000-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-0000000000a1/6.pdf', 'efimero', 'cb000000-0000-4000-8000-0000000000cb')) = '23503', '2c. efímero con la conversación de OTRO docente: rechazado (FK compuesta)');
select pg_temp.comprobar(pg_temp.estado_de(pg_temp.archivo('f7000000-0000-4000-8000-0000000000f7', 'a1000000-0000-4000-8000-0000000000a1', 'b1000000-0000-4000-8000-0000000000b1/7.pdf', 'conservar', null)) = '23514', '2d. ruta en la carpeta de otro docente: rechazada');
select pg_temp.comprobar(pg_temp.estado_de(pg_temp.archivo('f8000000-0000-4000-8000-0000000000f8', 'a1000000-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-0000000000a1/../x.pdf', 'conservar', null)) = '23514', '2e. ruta con ..: rechazada');
select pg_temp.comprobar(pg_temp.estado_de($q$insert into public.archivos_generados (docente_id, bucket, ruta, nombre, tipo_mime, tamano_bytes) values ('a1000000-0000-4000-8000-0000000000a1', 'hojas-seguimiento', 'a1000000-0000-4000-8000-0000000000a1/9.pdf', 'x', 'application/pdf', 1)$q$) = '23514', '2f. otro bucket: rechazado');
select pg_temp.comprobar(pg_temp.estado_de(pg_temp.archivo('f9000000-0000-4000-8000-0000000000f9', 'a1000000-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-0000000000a1/1-CITATORIO.pdf', 'conservar', null)) = '23505', '2g. misma ruta dos veces: rechazada (única)');
select pg_temp.comprobar(pg_temp.estado_de(pg_temp.archivo('f1000000-0000-4000-8000-0000000000f1', 'a1000000-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-0000000000a1/otra.pdf', 'conservar', null)) = '23505', '2h. mismo id dos veces (reintento): choca y no duplica');

select pg_temp.comprobar(pg_temp.estado_de($q$update public.archivos_generados set estado = 'activo' where id = 'f1000000-0000-4000-8000-0000000000f1'$q$) = '23514', '3a. activo sin fecha de activación: rechazado');
select pg_temp.comprobar(pg_temp.estado_de($q$update public.archivos_generados set estado = 'activo', activado_en = now() where id = 'f1000000-0000-4000-8000-0000000000f1' and estado = 'subiendo'$q$) = 'OK', '3b. confirmación: subiendo → activo');
select pg_temp.comprobar(pg_temp.estado_de($q$update public.archivos_generados set estado = 'fallido', ultimo_error = 'x' where id = 'f2000000-0000-4000-8000-0000000000f2'$q$) = 'OK', '3c. fallo: subiendo → fallido');
select pg_temp.comprobar(pg_temp.estado_de($q$delete from public.archivos_generados where id = 'f2000000-0000-4000-8000-0000000000f2'$q$) = '42501', '3d. el servidor no puede borrar registros (auditoría)');
select pg_temp.comprobar(pg_temp.estado_de($q$truncate public.archivos_generados cascade$q$) = '42501', '3e. ni truncar la tabla');

select pg_temp.comprobar(to_regclass('public.archivos_retenciones') is null, '4a. sin tabla de retenciones (pospuesta)');

-- ================= Cliente (authenticated / anon) =================
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-0000000000a1', true);
select pg_temp.comprobar(pg_temp.estado_de($q$select * from public.archivos_generados$q$) = '42501', '5a. el docente no puede leer el registro');
select pg_temp.comprobar(pg_temp.estado_de(pg_temp.archivo('fa000000-0000-4000-8000-0000000000fa', 'a1000000-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-0000000000a1/10.pdf', 'conservar', null)) = '42501', '5b. el docente no puede registrar archivos');
select pg_temp.comprobar(pg_temp.estado_de($q$update public.archivos_generados set estado = 'activo', activado_en = now()$q$) = '42501', '5c. el docente no puede cambiar estados');
reset role;
set local role anon;
select pg_temp.comprobar(pg_temp.estado_de($q$select * from public.archivos_generados$q$) = '42501', '5d. anon sin acceso');
reset role;

-- ================= Storage intacto =================
select pg_temp.comprobar((select count(*) from storage.objects) = (select objetos from _storage_antes), '6a. Storage sin cambios (mismo número de objetos)');

\echo 'TODAS LAS PRUEBAS SQL PASARON'
rollback;
