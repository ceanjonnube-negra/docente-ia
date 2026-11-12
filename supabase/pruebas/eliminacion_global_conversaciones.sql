-- Pruebas de la migración 20261112000000_eliminacion_global_conversaciones
-- (etapa 3B-1). TODO ocurre en una transacción que termina en ROLLBACK:
-- datos ficticios, ningún cambio persiste. Requiere la migración ya
-- aplicada y una sesión con permisos de propietario (postgres) para
-- sembrar los datos; las comprobaciones se hacen con el rol
-- authenticated y auth.uid() simulado por request.jwt.claim.sub.
--
-- psql -X -v ON_ERROR_STOP=1 -f supabase/pruebas/eliminacion_global_conversaciones.sql
-- Termina con "TODAS LAS PRUEBAS SQL PASARON" o se detiene en la primera falla.

\set ON_ERROR_STOP on
begin;

-- Docentes, grupo y conversaciones ficticias.
insert into auth.users (id) values
  ('a0000000-0000-4000-8000-00000000000a'), ('b0000000-0000-4000-8000-00000000000b');
insert into public.instituciones (id, nombre) values ('10000000-0000-4000-8000-000000000001', 'Escuela ficticia de prueba');
insert into public.perfiles_docentes (id) values
  ('a0000000-0000-4000-8000-00000000000a'), ('b0000000-0000-4000-8000-00000000000b');
insert into public.ciclos_escolares (id, institucion_id, nombre) values ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'Ciclo ficticio');
insert into public.grupos (id, institucion_id, docente_id, ciclo_escolar_id, grado, grupo, nivel_educativo) values
  ('30000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000000a', '20000000-0000-4000-8000-000000000002', '3', 'A', 'primaria');
insert into public.conversaciones_chat (id, docente_id, grupo_id, grupo_contexto_version) values
  ('c1000000-0000-4000-8000-0000000000c1', 'a0000000-0000-4000-8000-00000000000a', '30000000-0000-4000-8000-000000000003', 1),
  ('c2000000-0000-4000-8000-0000000000c2', 'a0000000-0000-4000-8000-00000000000a', '30000000-0000-4000-8000-000000000003', 1),
  ('c3000000-0000-4000-8000-0000000000c3', 'a0000000-0000-4000-8000-00000000000a', null, 1),
  ('cb000000-0000-4000-8000-0000000000cb', 'b0000000-0000-4000-8000-00000000000b', null, 1);
insert into public.mensajes_chat (id, conversacion_id, docente_id, rol, texto) values
  ('c1000000-0000-4000-8000-0000000000c1:m1', 'c1000000-0000-4000-8000-0000000000c1', 'a0000000-0000-4000-8000-00000000000a', 'usuario', 'ficticio 1'),
  ('c1000000-0000-4000-8000-0000000000c1:m2', 'c1000000-0000-4000-8000-0000000000c1', 'a0000000-0000-4000-8000-00000000000a', 'asistente', 'ficticio 2'),
  ('c2000000-0000-4000-8000-0000000000c2:m1', 'c2000000-0000-4000-8000-0000000000c2', 'a0000000-0000-4000-8000-00000000000a', 'usuario', 'otra conversación'),
  ('cb000000-0000-4000-8000-0000000000cb:m1', 'cb000000-0000-4000-8000-0000000000cb', 'b0000000-0000-4000-8000-00000000000b', 'usuario', 'de otro docente');
-- Registro canónico ligado a la conversación: propuesta de Lista Oficial.
insert into public.propuestas_lista_oficial (propuesta_id, docente_id, conversacion_id, grupo_id, expira_en, roster_snapshot) values
  ('40000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-00000000000a', 'c1000000-0000-4000-8000-0000000000c1', '30000000-0000-4000-8000-000000000003', now() + interval '1 hour', '[]');

create function pg_temp.comprobar(condicion boolean, mensaje text) returns void language plpgsql as $$
begin
  if condicion is not true then raise exception 'FALLA: %', mensaje; end if;
  raise notice 'ok: %', mensaje;
end $$;
-- Ejecuta una sentencia y devuelve su SQLSTATE ('OK' si no falla).
create function pg_temp.estado_de(sentencia text) returns text language plpgsql as $$
begin
  execute sentencia;
  return 'OK';
exception when others then
  return sqlstate;
end $$;
-- Filas afectadas por un UPDATE.
create function pg_temp.filas_de(sentencia text) returns integer language plpgsql as $$
declare n integer;
begin
  execute sentencia;
  get diagnostics n = row_count;
  return n;
end $$;
grant execute on all functions in schema pg_temp to authenticated;

-- ================= Docente A =================
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-4000-8000-00000000000a', true);

select pg_temp.comprobar(public.eliminar_conversacion('c1000000-0000-4000-8000-0000000000c1') = '{"estado": "eliminada", "mensajes": 2}'::jsonb, '1a. eliminar: borra sus 2 mensajes y la marca');
select pg_temp.comprobar(public.eliminar_conversacion('c1000000-0000-4000-8000-0000000000c1') = '{"estado": "ya_eliminada"}'::jsonb, '1b. eliminar de nuevo: ya_eliminada (repetible)');
select pg_temp.comprobar((select eliminada_en is not null and titulo = 'Conversación eliminada' and documento_activo is null from public.conversaciones_chat where id = 'c1000000-0000-4000-8000-0000000000c1'), '1c. la fila persiste como marca, visible para su dueño');
select pg_temp.comprobar((select count(*) from public.mensajes_chat where conversacion_id = 'c1000000-0000-4000-8000-0000000000c1') = 0, '1d. sin mensajes');
select pg_temp.comprobar(public.eliminar_conversacion('cb000000-0000-4000-8000-0000000000cb') = '{"estado": "no_encontrada"}'::jsonb, '2a. A no puede eliminar la conversación de B (no_encontrada)');
select pg_temp.comprobar(public.eliminar_conversacion('99999999-0000-4000-8000-000000000099') = '{"estado": "no_encontrada"}'::jsonb, '2b. inexistente: no_encontrada');

-- Ninguna ruta de escritura revive ni escribe en la eliminada.
select pg_temp.comprobar(pg_temp.estado_de($q$insert into public.conversaciones_chat (id, docente_id) values ('c1000000-0000-4000-8000-0000000000c1', 'a0000000-0000-4000-8000-00000000000a')$q$) = '23505', '3a. recrear con el mismo id: choca (23505)');
select pg_temp.comprobar(pg_temp.estado_de($q$delete from public.conversaciones_chat where id = 'c2000000-0000-4000-8000-0000000000c2'$q$) = '42501', '3b. borrar una conversación desde el cliente: sin permiso');
select pg_temp.comprobar(pg_temp.estado_de($q$delete from public.mensajes_chat where conversacion_id = 'c2000000-0000-4000-8000-0000000000c2'$q$) = '42501', '3c. borrar mensajes desde el cliente: sin permiso');
select pg_temp.comprobar(pg_temp.filas_de($q$update public.conversaciones_chat set titulo = 'revivida' where id = 'c1000000-0000-4000-8000-0000000000c1'$q$) = 0, '3d. editar título o fecha de una eliminada: 0 filas');
select pg_temp.comprobar(pg_temp.estado_de($q$update public.conversaciones_chat set eliminada_en = null where id = 'c1000000-0000-4000-8000-0000000000c1'$q$) = '42501', '3e. quitar la marca desde el cliente: sin permiso de columna');
select pg_temp.comprobar(pg_temp.estado_de($q$insert into public.mensajes_chat (id, conversacion_id, docente_id, rol, texto) values ('c1000000-0000-4000-8000-0000000000c1:m3', 'c1000000-0000-4000-8000-0000000000c1', 'a0000000-0000-4000-8000-00000000000a', 'usuario', 'cola pendiente')$q$) = '42501', '3f. insertar un mensaje en una eliminada (cola de la etapa 1): rechazado');
select pg_temp.comprobar(pg_temp.estado_de($q$insert into public.mensajes_chat (id, conversacion_id, docente_id, rol, texto) values ('c1000000-0000-4000-8000-0000000000c1:m3', 'c1000000-0000-4000-8000-0000000000c1', 'a0000000-0000-4000-8000-00000000000a', 'usuario', 'x') on conflict (id) do update set texto = excluded.texto$q$) = '42501', '3g. upsert (etapa 1) en una eliminada: rechazado');
select pg_temp.comprobar(pg_temp.estado_de($q$update public.mensajes_chat set conversacion_id = 'c1000000-0000-4000-8000-0000000000c1' where id = 'c2000000-0000-4000-8000-0000000000c2:m1'$q$) = '42501', '3h. mover un mensaje a una eliminada: rechazado');
select pg_temp.comprobar(pg_temp.estado_de($q$insert into public.mensajes_chat (id, conversacion_id, docente_id, rol, texto) values ('cb000000-0000-4000-8000-0000000000cb:intruso', 'cb000000-0000-4000-8000-0000000000cb', 'a0000000-0000-4000-8000-00000000000a', 'usuario', 'x')$q$) = '42501', '3i. insertar en la conversación de otro docente: rechazado');

-- Sin regresión en conversaciones vigentes (etapas 1, 2 y 3A).
select pg_temp.comprobar(pg_temp.estado_de($q$insert into public.mensajes_chat (id, conversacion_id, docente_id, rol, texto) values ('c2000000-0000-4000-8000-0000000000c2:m2', 'c2000000-0000-4000-8000-0000000000c2', 'a0000000-0000-4000-8000-00000000000a', 'asistente', 'respuesta')$q$) = 'OK', '4a. insertar en una conversación vigente: permitido');
select pg_temp.comprobar(pg_temp.estado_de($q$insert into public.mensajes_chat (id, conversacion_id, docente_id, rol, texto) values ('c2000000-0000-4000-8000-0000000000c2:m2', 'c2000000-0000-4000-8000-0000000000c2', 'a0000000-0000-4000-8000-00000000000a', 'asistente', 'respuesta final') on conflict (id) do update set texto = excluded.texto$q$) = 'OK', '4b. upsert (etapa 1) en una vigente: permitido');
select pg_temp.comprobar(pg_temp.filas_de($q$update public.conversaciones_chat set titulo = 'Título nuevo' where id = 'c2000000-0000-4000-8000-0000000000c2' and titulo = 'Nueva conversación'$q$) = 1, '4c. título condicional (etapa 3A) en una vigente: permitido');
select pg_temp.comprobar(pg_temp.estado_de($q$insert into public.conversaciones_chat (id, docente_id) values ('c4000000-0000-4000-8000-0000000000c4', 'a0000000-0000-4000-8000-00000000000a')$q$) = 'OK', '4d. crear una conversación nueva: permitido');

-- fijar_grupo_conversacion no toca una eliminada.
select public.eliminar_conversacion('c3000000-0000-4000-8000-0000000000c3');
select public.fijar_grupo_conversacion('c3000000-0000-4000-8000-0000000000c3');
select pg_temp.comprobar((select grupo_id is null from public.conversaciones_chat where id = 'c3000000-0000-4000-8000-0000000000c3'), '5a. fijar_grupo_conversacion: no fija grupo en una eliminada');

-- ================= Docente B =================
select set_config('request.jwt.claim.sub', 'b0000000-0000-4000-8000-00000000000b', true);
select pg_temp.comprobar((select count(*) from public.conversaciones_chat where docente_id = 'a0000000-0000-4000-8000-00000000000a') = 0, '6a. B no ve conversaciones (ni marcas) de A');
select pg_temp.comprobar((select count(*) from public.mensajes_chat where conversacion_id = 'cb000000-0000-4000-8000-0000000000cb') = 1, '6b. la conversación de B sigue intacta');

-- ================= Registros canónicos =================
reset role;
select pg_temp.comprobar((select count(*) from public.propuestas_lista_oficial where conversacion_id = 'c1000000-0000-4000-8000-0000000000c1') = 1, '7a. la propuesta de Lista Oficial de la conversación eliminada se conserva (sin cascada)');
select pg_temp.comprobar((select count(*) from public.mensajes_chat where conversacion_id = 'c2000000-0000-4000-8000-0000000000c2') = 2, '7b. los mensajes de otras conversaciones no se tocan');
select pg_temp.comprobar(position('eliminada_en is null' in (select prosrc from pg_proc where oid = 'public.registrar_propuesta_lista_oficial(uuid, jsonb)'::regprocedure)) > 0
  and position('eliminada_en is null' in (select prosrc from pg_proc where oid = 'public.aplicar_propuesta_lista_oficial(uuid, jsonb)'::regprocedure)) > 0, '7c. registrar/aplicar propuesta rechazan conversaciones eliminadas');

\echo 'TODAS LAS PRUEBAS SQL PASARON'
rollback;
