-- Traslado atómico de UNA inscripción activa de un grupo de ORIGEN a
-- un grupo DESTINO, dentro del MISMO ciclo escolar — ver auditoría
-- READ-ONLY "V1-D2C1-B4 — revisión técnica de traslado/reinscripción"
-- y su preparación "V1-D2C1-B4B — incorporación de 'traslado' al
-- contrato firmado". Esta migración es EXCLUSIVAMENTE la función SQL
-- primitiva — NO el productor del sobre, NO la RPC transaccional que
-- consume SobreAplicacionListaOficial (esa pieza, todavía inexistente,
-- es la única que debe llamar a esta función en producción real — ver
-- "ACCESO" más abajo).
--
-- Jamás sobrescribe ni reutiliza la inscripción de ORIGEN: la deja
-- intacta (mismo id, mismo grupo_id histórico), solo cambia su
-- estatus a 'baja' — exactamente el mismo UPDATE que ya hace
-- dar_de_baja_inscripcion (20260926000000), nunca una segunda
-- implementación de esa semántica. La inscripción NUEVA del destino
-- recibe su propio id — exactamente el mismo patrón de INSERT que ya
-- usa importar_alumnos_a_grupo (20260912200000) para crear
-- inscripciones. Las 7 tablas de historial con FK a inscripciones(id)
-- (asistencia_registro, incidencias, evaluaciones, evidencias,
-- necesidades_apoyo, fichas_descriptivas, seguimiento_resultados,
-- confirmadas por catálogo en V1-D2C1-B2) permanecen ancladas a la
-- fila de ORIGEN sin ningún cambio — esta función nunca las toca, ni
-- de lectura ni de escritura.
--
-- IDENTIDAD: alumno_id SIEMPRE se deriva de la fila real de
-- inscripciones (nunca se confía ciegamente en el parámetro
-- p_alumno_id) — ese parámetro solo sirve de defensa en profundidad
-- (ver PASO 2 abajo), exactamente el mismo criterio que
-- OperacionTrasladoAplicable/prevalidarTraslado (V1-D2C1-B4B) ya usan
-- a nivel de aplicación. Esta función NUNCA decide identidad por
-- nombre, similitud ni inferencia — recibe únicamente IDs ya
-- resueltos e inequívocos.
--
-- PROPIEDAD REAL — ver revisión de seguridad aprobada previa a
-- V1-D2C1-B4B (commit bf74bbd): inscripciones.docente_id es un
-- ESTAMPADO que se fija una sola vez al crear la fila y NUNCA se
-- actualiza después — no refleja con certeza quién es el propietario
-- ACTUAL de un grupo si su propiedad alguna vez cambiara.
-- grupos.docente_id es el ÚNICO dato en vivo. Esta función JAMÁS
-- consulta ni confía en inscripciones.docente_id para autorizar —
-- toda comprobación de propiedad (origen Y destino) se hace mediante
-- JOIN/WHERE contra grupos.docente_id, exactamente igual que
-- dar_de_baja_inscripcion/importar_alumnos_a_grupo ya hacen. Tampoco
-- se confía únicamente en la visibilidad bajo RLS (esta función es
-- SECURITY DEFINER y la bypassa por completo de todas formas — la
-- propiedad se verifica explícitamente en el cuerpo, nunca delegada a
-- una policy).
--
-- CONCURRENCIA — SELECT ... FOR UPDATE sobre la fila de ORIGEN antes
-- de cualquier escritura (mismo patrón que dar_de_baja_inscripcion y
-- eliminar_alumno_definitivamente). Dado que el índice parcial
-- inscripciones_alumno_ciclo_activo_uk garantiza que, en todo
-- momento, a lo sumo UNA fila de un alumno puede estar 'activo' en un
-- ciclo dado, bloquear esa ÚNICA fila de origen basta para serializar
-- cualquier traslado concurrente del MISMO alumno — un segundo
-- traslado simultáneo del mismo origen espera el lock, y al
-- continuar encuentra estatus ya en 'baja', fallando limpiamente (ver
-- PASO 2). El índice parcial sigue siendo, además, la barrera
-- DEFINITIVA de la base de datos — esta función nunca reemplaza esa
-- garantía, solo la respeta y la anticipa con un mensaje claro.
--
-- ACCESO — esta función se crea SECURITY DEFINER, pero se revoca
-- EXECUTE de PUBLIC, anon Y authenticated explícitamente (ver GRANT/
-- REVOKE al final). A diferencia de dar_de_baja_inscripcion (que SÍ
-- otorga a authenticated porque ya se invoca directamente desde el
-- cliente), esta función NO debe ser invocable todavía por ningún
-- docente real: el flujo de aplicación firmado (SobreAplicacionListaOficial
-- + verificación HMAC + revalidación transaccional) todavía no existe
-- como RPC completa — otorgar aquí a authenticated abriría una vía
-- alterna para trasladar alumnos SIN pasar por esa validación futura,
-- exactamente lo que esta fase debe evitar. service_role conserva el
-- EXECUTE que ya recibe por defecto (ALTER DEFAULT PRIVILEGES del
-- proyecto, confirmado por catálogo — no se otorga aquí explícitamente,
-- tampoco se revoca) para permitir pruebas controladas server-side
-- antes de integrar esta función a la RPC real. Una fase posterior,
-- al construir esa RPC, deberá otorgar EXECUTE a authenticated
-- ÚNICAMENTE si decide exponer esta función directamente (o mantenerla
-- revocada si la RPC la invoca internamente desde otra función
-- SECURITY DEFINER ya autorizada) — esa decisión queda fuera de
-- alcance de esta migración.
--
-- Fail-closed deliberado (no idempotente): CREATE FUNCTION sin CREATE
-- OR REPLACE — mismo criterio que dar_de_baja_inscripcion: si la
-- función ya existiera por un drift de esquema no auditado, esta
-- migración debe fallar explícitamente en vez de sobrescribir
-- silenciosamente una definición no revisada.

create function public.trasladar_inscripcion(
  p_alumno_id uuid,
  p_inscripcion_id_origen uuid,
  p_grupo_id_destino uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_docente_id uuid := auth.uid();
  v_alumno_id_real uuid;
  v_grupo_id_origen uuid;
  v_ciclo_escolar_id_origen uuid;
  v_estatus_origen text;
  v_institucion_id_origen uuid;
  v_ciclo_escolar_id_destino uuid;
  v_institucion_id_destino uuid;
  v_ya_activo_en_destino boolean;
  v_inscripcion_id_nueva uuid;
begin
  -- PASO 0 — autenticación y parámetros mínimos, fail fast antes de
  -- tocar cualquier tabla.
  if v_docente_id is null then
    raise exception 'No autenticado.';
  end if;

  if p_alumno_id is null or p_inscripcion_id_origen is null or p_grupo_id_destino is null then
    raise exception 'Faltan datos obligatorios para el traslado.';
  end if;

  -- PASO 1-2-3(origen)-6 — localiza y BLOQUEA la fila de origen,
  -- exigiendo en la MISMA condición que su grupo pertenezca REALMENTE
  -- al docente que llama (join contra grupos.docente_id, nunca contra
  -- inscripciones.docente_id ni únicamente RLS). Mensaje único, sin
  -- distinguir "no existe" de "es ajena".
  select i.alumno_id, i.grupo_id, i.ciclo_escolar_id, i.estatus, g.institucion_id
    into v_alumno_id_real, v_grupo_id_origen, v_ciclo_escolar_id_origen, v_estatus_origen, v_institucion_id_origen
  from public.inscripciones i
  join public.grupos g on g.id = i.grupo_id
  where i.id = p_inscripcion_id_origen
    and g.docente_id = v_docente_id
  for update of i;

  if not found then
    raise exception 'Inscripción de origen no encontrada o no autorizada.';
  end if;

  -- PASO 2 — defensa en profundidad: el alumnoId firmado debe
  -- corresponder EXACTAMENTE al alumno real de la inscripción de
  -- origen (identidad derivada de la fila real, nunca del parámetro
  -- por sí solo).
  if v_alumno_id_real <> p_alumno_id then
    raise exception 'La inscripción de origen no corresponde al alumno indicado.';
  end if;

  -- PASO 2 (continuación) — la inscripción de origen debe seguir
  -- activa AHORA (fail-closed ante reintentos/concurrencia: un
  -- segundo traslado del mismo origen, tras esperar el lock de
  -- arriba, encuentra esto y falla limpiamente).
  if v_estatus_origen <> 'activo' then
    raise exception 'Esta inscripción ya no está activa.';
  end if;

  -- PASO 3(destino) — propiedad REAL del grupo destino, mismo
  -- criterio exacto que el origen.
  select g.ciclo_escolar_id, g.institucion_id
    into v_ciclo_escolar_id_destino, v_institucion_id_destino
  from public.grupos g
  where g.id = p_grupo_id_destino
    and g.docente_id = v_docente_id;

  if not found then
    raise exception 'Grupo destino no encontrado o no autorizado.';
  end if;

  -- PASO 4 — grupos distintos (un traslado real nunca es al mismo
  -- grupo del que ya proviene).
  if v_grupo_id_origen = p_grupo_id_destino then
    raise exception 'El grupo de origen y el grupo destino no pueden ser el mismo.';
  end if;

  -- PASO 4 (continuación) — mismo ciclo escolar (un traslado entre
  -- ciclos distintos queda fuera de alcance de esta función, por
  -- diseño).
  if v_ciclo_escolar_id_origen <> v_ciclo_escolar_id_destino then
    raise exception 'El traslado solo es posible dentro del mismo ciclo escolar.';
  end if;

  -- PASO 5 — misma institución autorizada.
  if v_institucion_id_origen <> v_institucion_id_destino then
    raise exception 'El grupo destino no pertenece a la misma institución.';
  end if;

  -- PASO 6 (continuación)/11 — anticipa, con un mensaje claro, lo que
  -- el índice parcial inscripciones_alumno_ciclo_activo_uk haría
  -- cumplir de todas formas: el alumno no debe tener YA otra
  -- inscripción activa en el ciclo destino. Se excluye explícitamente
  -- la propia fila de origen (todavía 'activo' en este punto, antes
  -- del UPDATE de abajo) — nunca se confunde consigo misma como un
  -- conflicto. No requiere un FOR UPDATE adicional: al haber a lo
  -- sumo una fila activa por alumno+ciclo (garantía del índice
  -- parcial), la única candidata posible es la propia fila de origen,
  -- ya bloqueada arriba.
  select exists (
    select 1 from public.inscripciones i
    where i.alumno_id = v_alumno_id_real
      and i.ciclo_escolar_id = v_ciclo_escolar_id_destino
      and i.estatus = 'activo'
      and i.id <> p_inscripcion_id_origen
  ) into v_ya_activo_en_destino;

  if v_ya_activo_en_destino then
    raise exception 'El alumno ya tiene otra inscripción activa en este ciclo escolar.';
  end if;

  -- PASO 7/9 — cierra la inscripción de ORIGEN. Mismo UPDATE exacto
  -- que dar_de_baja_inscripcion — mismo id, mismo grupo_id histórico,
  -- nunca se sobrescribe ni se reutiliza. Dentro de la MISMA
  -- transacción que el INSERT de abajo: si cualquiera de los dos
  -- pasos fallara, PostgreSQL revierte ambos — nunca queda un estado
  -- intermedio con 0 o 2 inscripciones activas.
  update public.inscripciones
  set estatus = 'baja', fecha_baja = now()
  where id = p_inscripcion_id_origen;

  -- PASO 8/9 — crea la inscripción NUEVA y activa en el grupo
  -- destino, con un id nuevo. alumno_id preservado de la fila real de
  -- origen (v_alumno_id_real, nunca del parámetro sin verificar).
  -- numero_lista NULL a propósito — mismo criterio que
  -- importar_alumnos_a_grupo (el orden real y visible de Lista no
  -- depende de esta columna).
  insert into public.inscripciones (alumno_id, grupo_id, ciclo_escolar_id, docente_id, estatus)
  values (v_alumno_id_real, p_grupo_id_destino, v_ciclo_escolar_id_destino, v_docente_id, 'activo')
  returning id into v_inscripcion_id_nueva;

  return v_inscripcion_id_nueva;
end;
$$;

-- Privilegios — ver "ACCESO" en el comentario de cabecera: se revoca
-- EXECUTE de PUBLIC, anon Y authenticated explícitamente (a
-- diferencia de dar_de_baja_inscripcion, que sí otorga a authenticated).
-- service_role conserva el EXECUTE que ya recibe por defecto a nivel
-- de proyecto (ALTER DEFAULT PRIVILEGES, confirmado por catálogo) —
-- no se toca aquí, ni para otorgarlo ni para revocarlo.
revoke execute on function public.trasladar_inscripcion(uuid, uuid, uuid) from public;
revoke execute on function public.trasladar_inscripcion(uuid, uuid, uuid) from anon;
revoke execute on function public.trasladar_inscripcion(uuid, uuid, uuid) from authenticated;
