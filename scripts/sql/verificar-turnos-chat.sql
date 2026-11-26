-- Pruebas de la migración 20261129000000 (turnos duraderos del Chat IA) en
-- PostgreSQL local, actuando como cada rol real (authenticated con su JWT,
-- service_role). La concurrencia se prueba aparte, con dos sesiones
-- simultáneas (scripts/verificar-turnos-chat-sql.sh).
\set ON_ERROR_STOP on
\set A 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
\set B 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
\set GA 'a1000000-0000-4000-8000-000000000001'
\set GB 'b1000000-0000-4000-8000-000000000001'
\set CA 'ca000000-0000-4000-8000-000000000001'
\set CA2 'ca000000-0000-4000-8000-000000000002'
\set CA0 'ca000000-0000-4000-8000-000000000003'
\set CAX 'ca000000-0000-4000-8000-000000000004'
\set CB 'cb000000-0000-4000-8000-000000000001'
\set PA 'da000000-0000-4000-8000-000000000001'
\set PB 'db000000-0000-4000-8000-000000000001'

create table public.resultados (n serial primary key, nombre text not null, ok boolean not null);
grant all on public.resultados to public;
grant usage on sequence public.resultados_n_seq to public;
create function public.intentar(p_sql text) returns text language plpgsql as $$ begin execute p_sql; return 'ok'; exception when others then return sqlstate; end $$;
grant execute on function public.intentar(text) to public;

insert into public.perfiles_docentes values (:'A'), (:'B');
insert into public.grupos values (:'GA', :'A'), (:'GB', :'B');
insert into public.conversaciones_chat (id, docente_id, grupo_id, planeacion_activa) values
  (:'CA', :'A', :'GA', '{"esquema":"referencia-planeacion-v1","planeacionId":"da000000-0000-4000-8000-000000000001","numero":2,"opciones":[]}'),
  (:'CA2', :'A', :'GA', null), (:'CA0', :'A', null, null), (:'CAX', :'A', :'GB', null), (:'CB', :'B', :'GB', null);
insert into public.planeaciones values (:'PA', :'A', :'GA'), (:'PB', :'B', :'GB');
insert into public.mensajes_chat (id, conversacion_id, docente_id, rol, texto) values
  (:'CA' || ':m1', :'CA', :'A', 'usuario', 'Reemplaza el quinto indicador'),
  (:'CA' || ':r1', :'CA', :'A', 'asistente', 'respuesta'),
  (:'CB' || ':m1', :'CB', :'B', 'usuario', 'hola');

\echo == Docente A
set role authenticated;
select set_config('request.jwt.claim.sub', :'A', false) \gset
select public.adquirir_turno_chat('req-a-0001', :'CA', :'CA' || ':m1', repeat('1', 64), 0::smallint, null, 210) as r1 \gset
insert into resultados (nombre, ok) values ('1a. Turno nuevo: adquirido con su ejecución y el grupo de la conversación', (:'r1'::jsonb->>'resultado') = 'adquirido' and (:'r1'::jsonb->>'ejecucion_id') is not null and (:'r1'::jsonb->'turno'->>'grupo_id') = :'GA' and (:'r1'::jsonb->'turno'->>'estado') = 'generating');
select public.adquirir_turno_chat('req-a-0001', :'CA', :'CA' || ':m1', repeat('1', 64), 0::smallint, null, 210) as r1b \gset
insert into resultados (nombre, ok) values ('1b. El mismo envío otra vez: en_proceso, sin otra ejecución ni ejecucion_id', (:'r1b'::jsonb->>'resultado') = 'en_proceso' and (:'r1b'::jsonb ? 'ejecucion_id') = false and not (:'r1b'::jsonb->'turno' ? 'ejecucion_id'));
select public.adquirir_turno_chat('req-a-0001', :'CA', :'CA' || ':m1', repeat('2', 64), 0::smallint, null, 210) as r1c \gset
insert into resultados (nombre, ok) values ('1c. Mismo request_id con otro contenido: conflicto', (:'r1c'::jsonb->>'resultado') = 'conflicto');
select public.adquirir_turno_chat('req-a-0002', :'CA', null, repeat('3', 64), 0::smallint, null, 210) as r2 \gset
insert into resultados (nombre, ok) values ('1d. Otro mensaje con un turno activo en la conversación: ocupada', (:'r2'::jsonb->>'resultado') = 'ocupada');
select public.adquirir_turno_chat('req-a-0003', :'CA2', null, repeat('3', 64), 0::smallint, null, 210) as r3 \gset
select :'r3'::jsonb->>'ejecucion_id' as e3, :'r3'::jsonb->'turno'->>'id' as t3 \gset
insert into resultados (nombre, ok) values ('1e. Otra conversación del mismo docente: adquirido', (:'r3'::jsonb->>'resultado') = 'adquirido');
insert into resultados (nombre, ok) values ('1f. Mensaje de otra conversación o del asistente: mensaje_invalido',
  (public.adquirir_turno_chat('req-a-0004', :'CA2', :'CA' || ':m1', repeat('4', 64), 0::smallint, null, 210)->>'resultado') = 'mensaje_invalido'
  and (public.adquirir_turno_chat('req-a-0005', :'CA', :'CA' || ':r1', repeat('4', 64), 0::smallint, null, 210)->>'resultado') = 'mensaje_invalido');
insert into resultados (nombre, ok) values ('1g. Conversación ligada al grupo de otro docente: grupo_invalido',
  (public.adquirir_turno_chat('req-a-0006', :'CAX', null, repeat('4', 64), 0::smallint, null, 210)->>'resultado') = 'grupo_invalido');
insert into resultados (nombre, ok) values ('1h. Conversación de otro docente: conversacion_invalida',
  (public.adquirir_turno_chat('req-a-0007', :'CB', null, repeat('4', 64), 0::smallint, null, 210)->>'resultado') = 'conversacion_invalida');
insert into resultados (nombre, ok) values ('1i. Parámetros fuera de rango: parametros_invalidos',
  (public.adquirir_turno_chat('corto', :'CA0', null, repeat('4', 64), 0::smallint, null, 210)->>'resultado') = 'parametros_invalidos'
  and (public.adquirir_turno_chat('req-a-0008', :'CA0', null, 'no-es-huella', 0::smallint, null, 210)->>'resultado') = 'parametros_invalidos');
insert into resultados (nombre, ok) values ('2a. El docente lee sus turnos, pero no puede insertarlos, cambiarlos ni borrarlos',
  (select count(*) from public.turnos_chat) = 2
  and public.intentar(format('insert into public.turnos_chat (docente_id, conversacion_id, request_id, huella_solicitud) values (%L, %L, %L, %L)', :'A', :'CA0', 'req-directo', repeat('5', 64))) = '42501'
  and public.intentar('update public.turnos_chat set estado = ''completed''') = '42501'
  and public.intentar('delete from public.turnos_chat') = '42501');
insert into resultados (nombre, ok) values ('2b. completar y fallar están reservados al servidor (service_role)',
  public.intentar(format('select public.completar_turno_chat(%L, %L, %L, %L, false, null)', :'t3', :'e3', 'x', 'x')) = '42501'
  and public.intentar(format('select public.fallar_turno_chat(%L, %L, %L)', :'t3', :'e3', 'error_generacion')) = '42501');
select :'r1'::jsonb->>'ejecucion_id' as e1, :'r1'::jsonb->'turno'->>'id' as t1 \gset

\echo == Docente B
select set_config('request.jwt.claim.sub', :'B', false) \gset
insert into resultados (nombre, ok) values ('2c. Otro docente no ve ni consulta los turnos de A', (select count(*) from public.turnos_chat) = 0 and (public.consultar_turno_chat('req-a-0001', null)->>'resultado') = 'no_encontrado' and (public.consultar_turno_chat(null, :'CA')->>'resultado') = 'no_encontrado');
insert into resultados (nombre, ok) values ('2d. Otro docente puede usar el mismo request_id en lo suyo (unicidad por docente)', (public.adquirir_turno_chat('req-a-0001', :'CB', :'CB' || ':m1', repeat('1', 64), 0::smallint, null, 210)->>'resultado') = 'adquirido');

\echo == Servidor
reset role;
set role service_role;
select set_config('request.jwt.claim.sub', '', false) \gset
insert into resultados (nombre, ok) values ('3a. Completar con otra ejecución: rechazado', (public.completar_turno_chat(:'t1', gen_random_uuid(), 'crudo', 'final', false, null)->>'resultado') = 'rechazado');
select public.completar_turno_chat(:'t1', :'e1', 'crudo [[TEXTO_FINAL:x]]', 'Borrador final', false,
  jsonb_build_object('planeacionId', :'PA', 'versionBase', 2, 'grupoId', :'GA', 'huella', repeat('a', 64), 'formatoSolicitado', null)) as c1 \gset
reset role;
insert into resultados (nombre, ok) values ('3b. Cliente anterior (protocolo 0): completado sin crear mensaje (el cliente guarda el suyo)',
  (:'c1'::jsonb->>'resultado') = 'completado' and (select mensaje_asistente_id is null and estado = 'completed' and texto_crudo like 'crudo%' from public.turnos_chat where id = :'t1')
  and (select count(*) from public.mensajes_chat where conversacion_id = :'CA') = 2);
insert into resultados (nombre, ok) values ('3c. Metadatos del ajuste ligados al turno en la misma transacción (y la referencia se conserva)',
  (select planeacion_activa->'ajustes'->0->>'turnoId' = :'t1' and planeacion_activa->'ajustes'->0->>'huella' = repeat('a', 64) and (planeacion_activa->'ajustes'->0->>'versionBase')::int = 2
     and planeacion_activa->>'numero' = '2' and planeacion_activa->>'planeacionId' = :'PA' from public.conversaciones_chat where id = :'CA'));
set role service_role;
insert into resultados (nombre, ok) values ('3d. Completar otra vez el mismo turno: rechazado (nunca se sobrescribe)', (public.completar_turno_chat(:'t1', :'e1', 'otro', 'otro', false, null)->>'resultado') = 'rechazado');
reset role;

\echo == Recuperación sin IA
set role authenticated;
select set_config('request.jwt.claim.sub', :'A', false) \gset
select public.adquirir_turno_chat('req-a-0001', :'CA', :'CA' || ':m1', repeat('1', 64), 0::smallint, null, 210) as r1d \gset
insert into resultados (nombre, ok) values ('4a. Reenviar un turno terminado: completado con su respuesta guardada (sin ejecutar)', (:'r1d'::jsonb->>'resultado') = 'completado' and (:'r1d'::jsonb->'turno'->>'texto_crudo') like 'crudo%' and not (:'r1d'::jsonb ? 'ejecucion_id'));
insert into resultados (nombre, ok) values ('4b. Consultar por request_id o por conversación', (public.consultar_turno_chat('req-a-0001', null)->'turno'->>'estado') = 'completed' and (public.consultar_turno_chat(null, :'CA')->'turno'->>'request_id') = 'req-a-0001');

\echo == Protocolo 1: mensaje del asistente atómico
insert into public.mensajes_chat (id, conversacion_id, docente_id, rol, texto) values (:'CA' || ':m2', :'CA', :'A', 'usuario', 'Otro cambio');
select public.adquirir_turno_chat('req-a-0010', :'CA', :'CA' || ':m2', repeat('6', 64), 1::smallint, null, 210) as r10 \gset
select :'r10'::jsonb->>'ejecucion_id' as e10, :'r10'::jsonb->'turno'->>'id' as t10 \gset
reset role;
set role service_role;
select public.completar_turno_chat(:'t10', :'e10', 'crudo10', 'Borrador 10', true,
  jsonb_build_object('planeacionId', :'PA', 'versionBase', 2, 'grupoId', :'GA', 'huella', repeat('b', 64))) as c10 \gset
reset role;
insert into resultados (nombre, ok) values ('5a. Turno, mensaje del asistente (id <conversación>:turno-<id>) y ajuste en una sola transacción',
  (:'c10'::jsonb->>'resultado') = 'completado'
  and exists (select 1 from public.mensajes_chat m where m.id = :'CA' || ':turno-' || :'t10' and m.rol = 'asistente' and m.texto = 'Borrador 10' and m.docente_id = :'A' and m.contenido->>'turnoId' = :'t10' and m.contenido->>'mensajeUsuarioId' = :'CA' || ':m2')
  and (select mensaje_asistente_id from public.turnos_chat where id = :'t10') = :'CA' || ':turno-' || :'t10'
  and (select a->>'mensajeId' from public.conversaciones_chat, jsonb_array_elements(planeacion_activa->'ajustes') a where id = :'CA' and a->>'huella' = repeat('b', 64)) = :'CA' || ':turno-' || :'t10'
  and (select jsonb_array_length(planeacion_activa->'ajustes') from public.conversaciones_chat where id = :'CA') = 2);
set role authenticated;
select set_config('request.jwt.claim.sub', :'A', false) \gset
insert into resultados (nombre, ok) values ('5b. Un turno vivo por mensaje del docente: el mismo mensaje con otro request_id no se vuelve a ejecutar',
  (public.adquirir_turno_chat('req-a-0011', :'CA', :'CA' || ':m2', repeat('6', 64), 1::smallint, null, 210)->>'resultado') = 'mensaje_en_curso');
select public.adquirir_turno_chat('req-a-0012', :'CA0', null, repeat('7', 64), 1::smallint, null, 210) as r12 \gset
select :'r12'::jsonb->>'ejecucion_id' as e12, :'r12'::jsonb->'turno'->>'id' as t12 \gset
reset role;
set role service_role;
insert into resultados (nombre, ok) values ('5c. Ajuste de una planeación ajena: se aborta TODO (ni turno completado, ni mensaje, ni metadatos)',
  public.intentar(format('select public.completar_turno_chat(%L, %L, %L, %L, true, %L)', :'t12', :'e12', 'crudo', 'final',
    jsonb_build_object('planeacionId', :'PB', 'versionBase', 1, 'grupoId', :'GB', 'huella', repeat('c', 64)))) = 'P0001');
insert into resultados (nombre, ok) values ('5d. Materializar para un cliente anterior (protocolo 0) o sin texto final: se aborta',
  public.intentar(format('select public.completar_turno_chat(%L, %L, %L, null, true, null)', :'t12', :'e12', 'crudo')) = 'P0001');
reset role;
insert into resultados (nombre, ok) values ('5e. Tras el aborto, el turno sigue en curso y no quedó nada parcial',
  (select estado from public.turnos_chat where id = :'t12') = 'generating'
  and not exists (select 1 from public.mensajes_chat where conversacion_id = :'CA0')
  and (select planeacion_activa from public.conversaciones_chat where id = :'CA0') is null);
set role service_role;
select public.fallar_turno_chat(:'t12', :'e12', 'error_persistencia', 'crudo parcial', 'ajuste_invalido') as f12 \gset
insert into resultados (nombre, ok) values ('5f. El servidor lo marca fallido (error_persistencia) con su texto parcial', (:'f12'::jsonb->>'resultado') = 'fallido' and (:'f12'::jsonb->'turno'->>'codigo_error') = 'error_persistencia' and (:'f12'::jsonb->'turno'->>'texto_parcial') = 'crudo parcial');
insert into resultados (nombre, ok) values ('5g. Fallar otra vez o con otra ejecución: rechazado', (public.fallar_turno_chat(:'t12', :'e12', 'error_generacion')->>'resultado') = 'rechazado' and (public.fallar_turno_chat(:'t3', gen_random_uuid(), 'error_generacion')->>'resultado') = 'rechazado');
reset role;

\echo == Vencimiento y finalización tardía
set role service_role;
select public.fallar_turno_chat(:'t3', :'e3', 'error_generacion') as f3 \gset
reset role;
insert into public.mensajes_chat (id, conversacion_id, docente_id, rol, texto) values (:'CA2' || ':m7', :'CA2', :'A', 'usuario', 'Hazlo más corto');
set role authenticated;
select set_config('request.jwt.claim.sub', :'A', false) \gset
select public.adquirir_turno_chat('req-a-0020', :'CA2', :'CA2' || ':m7', repeat('8', 64), 0::smallint, null, 30) as r20 \gset
select :'r20'::jsonb->>'ejecucion_id' as e20, :'r20'::jsonb->'turno'->>'id' as t20 \gset
reset role;
update public.turnos_chat set vence_en = now() - interval '1 second' where id = :'t20';
set role service_role;
select public.completar_turno_chat(:'t20', :'e20', 'tarde', 'tarde', false, null) as c20 \gset
reset role;
insert into resultados (nombre, ok) values ('6a. Finalización tardía de una ejecución vencida: rechazada y el turno queda interrumpido',
  (:'c20'::jsonb->>'resultado') = 'vencido' and (select estado = 'failed' and codigo_error = 'interrumpido' and texto_crudo is null from public.turnos_chat where id = :'t20'));
set role authenticated;
select set_config('request.jwt.claim.sub', :'A', false) \gset
insert into resultados (nombre, ok) values ('6b. Un mensaje cuyo turno falló no se vuelve a ejecutar sin reintento explícito',
  (public.adquirir_turno_chat('req-a-0021', :'CA2', :'CA2' || ':m7', repeat('8', 64), 0::smallint, null, 210)->>'resultado') = 'reintento_requerido');
insert into resultados (nombre, ok) values ('6c. Reintentar un turno terminado o de otro mensaje: reintento_invalido',
  (public.adquirir_turno_chat('req-a-0022', :'CA2', :'CA2' || ':m7', repeat('8', 64), 0::smallint, 'req-a-0001', 210)->>'resultado') = 'reintento_invalido'
  and (public.adquirir_turno_chat('req-a-0023', :'CA2', null, repeat('8', 64), 0::smallint, 'req-a-0020', 210)->>'resultado') = 'reintento_invalido');
select public.adquirir_turno_chat('req-a-0024', :'CA2', :'CA2' || ':m7', repeat('8', 64), 0::smallint, 'req-a-0020', 210) as r24 \gset
insert into resultados (nombre, ok) values ('6d. Reintento explícito del turno fallido: adquirido y ligado al anterior', (:'r24'::jsonb->>'resultado') = 'adquirido' and (:'r24'::jsonb->'turno'->>'reintento_de') = :'t20');
reset role;
update public.turnos_chat set vence_en = now() - interval '1 second' where request_id = 'req-a-0024';
set role authenticated;
select set_config('request.jwt.claim.sub', :'A', false) \gset
select public.consultar_turno_chat('req-a-0024', null) as q24 \gset
insert into resultados (nombre, ok) values ('6e. Consultar un turno cuya función murió: se cierra como interrumpido y reintentable (sin turnos eternos)',
  (:'q24'::jsonb->'turno'->>'estado') = 'failed' and (:'q24'::jsonb->'turno'->>'codigo_error') = 'interrumpido' and (:'q24'::jsonb->'turno'->>'reintentable')::boolean);
insert into resultados (nombre, ok) values ('6f. Con el vencido cerrado, la conversación ya no está ocupada', (public.adquirir_turno_chat('req-a-0025', :'CA2', null, repeat('9', 64), 0::smallint, null, 210)->>'resultado') = 'adquirido');
insert into resultados (nombre, ok) values ('6g. Ninguna respuesta expone ejecucion_id fuera de la adquisición', not (public.consultar_turno_chat('req-a-0025', null)->'turno' ? 'ejecucion_id'));
reset role;
update public.conversaciones_chat set eliminada_en = now() where id = :'CA0';
set role authenticated;
select set_config('request.jwt.claim.sub', :'A', false) \gset
insert into resultados (nombre, ok) values ('6h. Conversación eliminada: conversacion_invalida', (public.adquirir_turno_chat('req-a-0030', :'CA0', null, repeat('9', 64), 0::smallint, null, 210)->>'resultado') = 'conversacion_invalida');
reset role;
