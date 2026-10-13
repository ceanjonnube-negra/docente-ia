-- Seguridad — T0: eliminar el oráculo de CURP entre cuentas docentes
-- (ver auditoría aprobada "T0").
--
-- HALLAZGO: no existe ninguna restricción UNIQUE ni índice sobre
-- alumnos.curp; la "unicidad institucional" vivía solo en 3 EXISTS que
-- cotejaban la CURP contra TODOS los alumnos de la institución, de
-- cualquier docente, con un mensaje distinguible. Como
-- grupos.institucion_id lo elige el docente, eso permitía a una cuenta
-- descubrir si una CURP existía en otra (importar_alumnos_a_grupo:
-- SECURITY DEFINER con EXECUTE para authenticated — explotable hoy;
-- alta_persona_con_inscripcion y reparar_curp_desde_lista_oficial:
-- latentes, en cuanto las invocara una RPC SECURITY DEFINER).
--
-- PRINCIPIO: no revelar nada ⇔ el resultado para un docente no depende
-- de datos de otras cuentas. Por eso el cotejo de duplicados pasa a ser
-- POR DOCENTE (alumnos.docente_id = auth.uid(), en todas sus escuelas),
-- coherente con la identidad del alumno ya propia de cada cuenta
-- (UNIQUE(nombre, docente_id)). Se permiten expedientes independientes
-- con la misma CURP en cuentas distintas; se conserva el rechazo de
-- duplicados dentro de la misma cuenta.
--
-- QUÉ CAMBIA, EXCLUSIVAMENTE (en las 3 funciones):
--   1. EXISTS de duplicado: institucion_id = v_institucion_id →
--      docente_id = v_docente_id.
--   2. Clave del advisory lock: hashtextextended(curp) →
--      hashtextextended(docente_id || ':' || curp). Misma clave en las
--      3 funciones (siguen serializándose entre sí dentro de una cuenta);
--      cuentas distintas nunca compiten por el mismo lock (sin señal de
--      espera entre cuentas). Orden de adquisición sin cambios:
--      importar = locks ordenados antes del bucle; alta_persona = 1 lock
--      antes del EXISTS; reparar_curp = fila del alumno → lock de CURP.
--   3. Mensaje de importar/alta_persona: "Esa CURP ya está registrada."
--      → "Ya tienes un alumno registrado con esa CURP." (reparar_curp
--      conserva su código NEW_CURP_DUPLICATE).
--   4. Comentarios internos que describían el alcance institucional.
-- Cada definición nueva se generó a partir de la definición REAL del
-- catálogo (pg_get_functiondef) con reemplazos exactos; todo lo demás
-- (validaciones, CAS, correcciones_alumno, inserciones) es idéntico.
--
-- QUÉ NO CAMBIA: firmas, tipos de retorno, SECURITY DEFINER/INVOKER,
-- propietario, search_path, permisos (CREATE OR REPLACE conserva el
-- ACL; se verifica al final), tablas, restricciones y datos.
--
-- PRECONDICIÓN: cada función debe existir con su firma exacta y su md5
-- debe ser el auditado (o ya el nuevo: re-ejecución idempotente).
-- POSCONDICIÓN: md5 nuevo, mismo SECURITY, mismo search_path, mismo
-- propietario y mismo ACL; cualquier diferencia revierte todo.
--
-- ROLLBACK: re-crear las 3 definiciones anteriores (md5 indicados abajo).

begin;

do $$
begin
  if to_regprocedure('public.importar_alumnos_a_grupo(uuid, jsonb)') is null then
    raise exception 'PRECONDICION_FALLIDA: no existe public.importar_alumnos_a_grupo(uuid, jsonb).';
  end if;
  if md5(pg_catalog.pg_get_functiondef('public.importar_alumnos_a_grupo(uuid, jsonb)'::regprocedure)) not in ('5c27b03a6a8ac887e464f0b454d6fb3b', 'c905b378d0fdbeeab701e75311ff13e6') then
    raise exception 'PRECONDICION_FALLIDA: la definición de importar_alumnos_a_grupo difiere de la auditada.';
  end if;
  if to_regprocedure('public.alta_persona_con_inscripcion(uuid, text, text)') is null then
    raise exception 'PRECONDICION_FALLIDA: no existe public.alta_persona_con_inscripcion(uuid, text, text).';
  end if;
  if md5(pg_catalog.pg_get_functiondef('public.alta_persona_con_inscripcion(uuid, text, text)'::regprocedure)) not in ('aaf0d713ab9cdb2d3f42cfaf8ece26a8', 'b5c0d54d931c27d25c473934cedf1bc2') then
    raise exception 'PRECONDICION_FALLIDA: la definición de alta_persona_con_inscripcion difiere de la auditada.';
  end if;
  if to_regprocedure('public.reparar_curp_desde_lista_oficial(uuid, uuid, text, text)') is null then
    raise exception 'PRECONDICION_FALLIDA: no existe public.reparar_curp_desde_lista_oficial(uuid, uuid, text, text).';
  end if;
  if md5(pg_catalog.pg_get_functiondef('public.reparar_curp_desde_lista_oficial(uuid, uuid, text, text)'::regprocedure)) not in ('f110053ba76eb08e3fdd9f9443fffd01', '6e8ac91f1e8a3dfa42e38dcf8deae53c') then
    raise exception 'PRECONDICION_FALLIDA: la definición de reparar_curp_desde_lista_oficial difiere de la auditada.';
  end if;
end;
$$;

CREATE OR REPLACE FUNCTION public.importar_alumnos_a_grupo(p_grupo_id uuid, p_alumnos jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_docente_id uuid;
  v_institucion_id uuid;
  v_ciclo_escolar_id uuid;
  v_total integer;
  v_creados integer := 0;
  v_elem jsonb;
  v_nombre text;
  v_curp text;
  v_sexo text;
  v_alumno_id uuid;
  v_curp_norm text;
  v_curps_vistos text[] := '{}';
  v_curps_lote text[] := '{}';
  v_curp_lock text;
begin
  v_docente_id := auth.uid();
  if v_docente_id is null then
    raise exception 'No autenticado.';
  end if;

  if p_grupo_id is null then
    raise exception 'Falta el grupo.';
  end if;

  -- Propiedad real del grupo, comprobada explícitamente dentro de la
  -- función — nunca delegada a RLS: una función SECURITY DEFINER omite
  -- por defecto las policies de la tabla (grupos no tiene FORCE ROW
  -- LEVEL SECURITY). Solo propietario directo — grupos compartidos
  -- fuera de alcance (ver comentario de cabecera). institucion_id y
  -- ciclo_escolar_id se derivan AQUÍ, del grupo ya validado — nunca se
  -- aceptan como parámetro ni se leen del payload por alumno.
  select g.institucion_id, g.ciclo_escolar_id
    into v_institucion_id, v_ciclo_escolar_id
  from public.grupos g
  where g.id = p_grupo_id
    and g.docente_id = v_docente_id;

  if not found then
    raise exception 'Grupo no encontrado o no pertenece al docente.';
  end if;

  if jsonb_typeof(p_alumnos) is distinct from 'array' then
    raise exception 'Formato de alumnos inválido.';
  end if;

  v_total := jsonb_array_length(p_alumnos);
  if v_total = 0 then
    raise exception 'No hay alumnos para importar.';
  end if;
  -- Límite defensivo de tamaño de lote — muy por encima de cualquier
  -- grupo real, solo para acotar el costo de una llamada abusiva; no
  -- introduce ninguna semántica de producto nueva.
  if v_total > 200 then
    raise exception 'Demasiados alumnos en una sola importación.';
  end if;

  -- Prevención de deadlock (ver cabecera): recorrido adicional, de
  -- SOLO LECTURA, que recolecta las CURP normalizadas DISTINTAS
  -- presentes en el lote. Nunca lanza una excepción por sí mismo — un
  -- elemento mal formado o sin CURP simplemente no aporta ninguna
  -- clave aquí; el bucle principal de abajo, sin cambios, sigue siendo
  -- el único que valida y rechaza cada elemento con su mensaje real.
  for v_elem in select * from jsonb_array_elements(p_alumnos)
  loop
    v_curp := nullif(trim(both from coalesce(v_elem->>'curp', '')), '');
    if v_curp is not null then
      v_curp_norm := upper(v_curp);
      if not (v_curp_norm = any(v_curps_lote)) then
        v_curps_lote := array_append(v_curps_lote, v_curp_norm);
      end if;
    end if;
  end loop;

  -- Adquiere un advisory lock transaccional por cada CURP distinta del
  -- lote, EN ORDEN DETERMINISTA ascendente — nunca en el orden de
  -- aparición del archivo importado (ver "CORRECCIÓN" en la cabecera).
  -- Mismo mecanismo exacto (pg_advisory_xact_lock sobre
  -- hashtextextended) que reparar_curp_desde_lista_oficial y
  -- alta_persona_con_inscripcion — misma clave (docente_id + CURP) ante la misma CURP del mismo docente, así
  -- que las tres funciones se serializan correctamente entre sí.
  for v_curp_lock in select unnest(v_curps_lote) order by 1
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_docente_id::text || ':' || v_curp_lock, 0::bigint));
  end loop;

  for v_elem in select * from jsonb_array_elements(p_alumnos)
  loop
    -- Cada elemento debe ser un objeto JSON — un elemento que sea
    -- string/number/boolean/array/null ya terminaría fallando de forma
    -- indirecta (el operador ->> devuelve NULL sobre un valor que no es
    -- objeto, así que v_nombre quedaría vacío y se rechazaría más
    -- abajo), pero se rechaza aquí de forma EXPLÍCITA en vez de
    -- depender de ese efecto incidental de los operadores jsonb.
    if jsonb_typeof(v_elem) is distinct from 'object' then
      raise exception 'Formato de alumno inválido.';
    end if;

    -- Extracción EXPLÍCITA de solo 3 campos — nombre/curp/sexo, los
    -- únicos que ImportacionInteligente soporta hoy. Cualquier otra
    -- clave del elemento (docente_id, institucion_id, grupo_id,
    -- ciclo_escolar_id, numero_lista, estatus, id, creado_en o
    -- cualquier otra) nunca se lee: no existe ningún acceso a esas
    -- claves en esta función, así que no pueden volverse autoritativas
    -- sin importar lo que el cliente envíe en el JSON.
    v_nombre := trim(both from coalesce(v_elem->>'nombre', ''));
    v_curp := nullif(trim(both from coalesce(v_elem->>'curp', '')), '');
    v_sexo := nullif(trim(both from coalesce(v_elem->>'sexo', '')), '');

    if v_nombre = '' then
      raise exception 'Un alumno no tiene nombre válido.';
    end if;

    -- Mismo conjunto de valores que ya exige alumnos_sexo_check — se
    -- valida aquí también, explícitamente, para fallar con un mensaje
    -- claro antes de intentar el INSERT (nunca se infiere sexo del
    -- nombre ni de ningún otro dato).
    if v_sexo is not null and v_sexo not in ('H', 'M') then
      raise exception 'Valor de sexo no reconocido.';
    end if;

    -- CURP: nunca se inventa ni se aproxima — lo que se GUARDA
    -- (v_curp) es exactamente lo que entregó la extracción/revisión del
    -- docente, solo recortado de espacios, sin cambiar mayúsculas/
    -- minúsculas. La COMPARACIÓN de duplicados, en cambio, se hace en
    -- mayúsculas (v_curp_norm) — misma semántica exacta que ya usaba el
    -- filtro de duplicados del cliente en analizarArchivos
    -- (curpsExistentes = Set(...toUpperCase()), comparado contra
    -- c.curp.trim().toUpperCase()); comparar aquí de forma
    -- case-sensitive habría sido una regresión real frente a ese
    -- comportamiento ya aprobado, no una equivalencia. No hay UNIQUE de
    -- base de datos sobre alumnos.curp, así que esta función no puede
    -- depender únicamente de un constraint: valida explícitamente,
    -- primero dentro del propio lote y después contra los alumnos ya
    -- existentes del MISMO docente, en todas sus escuelas (cotejo por
    -- cuenta: nunca consulta ni revela CURP de otras cuentas) — cualquier conflicto aborta
    -- el lote completo (fail closed), nunca fusiona ni reutiliza un
    -- alumno existente. El advisory lock adquirido arriba, antes de
    -- este bucle, es lo que ahora hace que este EXISTS sea seguro
    -- frente a otra transacción concurrente que reclame la misma CURP.
    if v_curp is not null then
      v_curp_norm := upper(v_curp);

      if v_curp_norm = any(v_curps_vistos) then
        raise exception 'CURP duplicada dentro del mismo archivo.';
      end if;
      v_curps_vistos := array_append(v_curps_vistos, v_curp_norm);

      if exists (
        select 1 from public.alumnos a
        where a.docente_id = v_docente_id
          and upper(a.curp) = v_curp_norm
      ) then
        raise exception 'Ya tienes un alumno registrado con esa CURP.';
      end if;
    end if;

    -- alumnos: identidad permanente. docente_id/institucion_id salen
    -- ÚNICAMENTE de las variables ya derivadas arriba del grupo
    -- validado — nunca del payload. alumnos_nombre_docente_id_key
    -- (UNIQUE nombre+docente_id) sigue actuando como respaldo adicional
    -- ante un nombre duplicado no detectado por el cliente.
    insert into public.alumnos (institucion_id, docente_id, nombre, curp, sexo)
    values (v_institucion_id, v_docente_id, v_nombre, v_curp, v_sexo)
    returning id into v_alumno_id;

    -- inscripciones: numero_lista se deja NULL a propósito — nunca se
    -- confía en el numero_lista que traiga el documento/cliente, y el
    -- orden real y visible de Lista ya lo calcula
    -- obtenerRosterConPosicion sin depender de esta columna (ver
    -- auditoría "numero_lista"). No se introduce ninguna semántica de
    -- orden nueva.
    insert into public.inscripciones (alumno_id, grupo_id, ciclo_escolar_id, docente_id, estatus)
    values (v_alumno_id, p_grupo_id, v_ciclo_escolar_id, v_docente_id, 'activo');

    v_creados := v_creados + 1;
  end loop;

  -- Ninguna excepción se captura en ningún punto de este bucle: un
  -- error en cualquier registro (nombre vacío, sexo inválido, CURP en
  -- conflicto, violación de una restricción de base de datos) propaga
  -- la excepción hacia afuera sin excepción alguna atrapada a medio
  -- camino, y PostgreSQL revierte TODA la transacción de la llamada —
  -- ningún alumno ni inscripción parcial puede quedar guardado. Los
  -- advisory locks adquiridos arriba se liberan automáticamente junto
  -- con la reversión.
  return v_creados;
end;
$function$;

CREATE OR REPLACE FUNCTION public.alta_persona_con_inscripcion(p_grupo_id uuid, p_nombre text, p_curp text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_docente_id uuid := auth.uid();
  v_institucion_id uuid;
  v_ciclo_escolar_id uuid;
  v_nombre text;
  v_curp text;
  v_curp_norm text;
  v_alumno_id uuid;
begin
  -- Autenticación real, fail fast.
  if v_docente_id is null then
    raise exception 'No autenticado.';
  end if;

  if p_grupo_id is null then
    raise exception 'Falta el grupo.';
  end if;

  -- Propiedad REAL del grupo — contra grupos.docente_id (dato en
  -- vivo), nunca delegada a RLS (esta función la bypassa por ser
  -- SECURITY DEFINER). institucion_id/ciclo_escolar_id se derivan
  -- ÚNICAMENTE de aquí, nunca de un parámetro.
  select g.institucion_id, g.ciclo_escolar_id
    into v_institucion_id, v_ciclo_escolar_id
  from public.grupos g
  where g.id = p_grupo_id
    and g.docente_id = v_docente_id;

  if not found then
    raise exception 'Grupo no encontrado o no pertenece al docente.';
  end if;

  -- Nombre — recortado, nunca inventado; vacío se rechaza.
  v_nombre := trim(both from coalesce(p_nombre, ''));
  if v_nombre = '' then
    raise exception 'Falta un nombre válido.';
  end if;

  -- CURP — opcional (NULL es una lectura real y válida). Se guarda
  -- EXACTAMENTE como se recibió, solo recortada de espacios — nunca
  -- cambiada de mayúsculas/minúsculas. La comparación de duplicado SÍ
  -- normaliza a mayúsculas (v_curp_norm), misma semántica exacta que
  -- importar_alumnos_a_grupo.
  v_curp := nullif(trim(both from coalesce(p_curp, '')), '');

  if v_curp is not null then
    v_curp_norm := upper(v_curp);

    -- Lock transaccional por CURP normalizada — ANTES del EXISTS de
    -- duplicado, nunca después (mismo criterio exacto, misma firma,
    -- que reparar_curp_desde_lista_oficial, PASO 10). Cierra la
    -- condición de carrera TOCTOU documentada en la cabecera: serializa
    -- cualquier otra transacción que intente reclamar esta MISMA CURP
    -- (incluida reparar_curp_desde_lista_oficial, misma clave exacta);
    -- se libera solo automáticamente al terminar esta transacción
    -- (COMMIT o ROLLBACK) — nunca requiere liberación manual y nunca
    -- bloquea una CURP distinta.
    perform pg_advisory_xact_lock(hashtextextended(v_docente_id::text || ':' || v_curp_norm, 0::bigint));

    -- Duplicado POR DOCENTE — EXISTS contra los alumnos del propio
    -- docente, en todas sus escuelas; nunca contra otras cuentas, para
    -- no revelar la existencia de CURP ajenas. Cualquier
    -- conflicto aborta el alta completa — nunca fusiona ni reutiliza
    -- un alumno existente.
    if exists (
      select 1 from public.alumnos a
      where a.docente_id = v_docente_id
        and upper(a.curp) = v_curp_norm
    ) then
      raise exception 'Ya tienes un alumno registrado con esa CURP.';
    end if;
  end if;

  -- alumnos: identidad permanente. docente_id/institucion_id salen
  -- ÚNICAMENTE de las variables ya derivadas arriba del grupo
  -- validado. alumnos_nombre_docente_id_key (UNIQUE nombre+docente_id)
  -- sigue actuando como respaldo real de la base de datos ante un
  -- nombre duplicado — no se preverifica aquí, mismo criterio exacto
  -- que importar_alumnos_a_grupo.
  insert into public.alumnos (institucion_id, docente_id, nombre, curp)
  values (v_institucion_id, v_docente_id, v_nombre, v_curp)
  returning id into v_alumno_id;

  -- inscripciones: numero_lista NUNCA se escribe (el orden real y
  -- visible de Lista no depende de esta columna). Misma transacción
  -- que el INSERT de arriba — si esto fallara, PostgreSQL revierte
  -- también el alumno recién creado: nunca puede quedar un alumno
  -- huérfano sin su inscripción.
  insert into public.inscripciones (alumno_id, grupo_id, ciclo_escolar_id, docente_id, estatus)
  values (v_alumno_id, p_grupo_id, v_ciclo_escolar_id, v_docente_id, 'activo');

  return v_alumno_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.reparar_curp_desde_lista_oficial(p_alumno_id uuid, p_grupo_id uuid, p_curp_esperada_actual text, p_curp_nueva text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_docente_id uuid := auth.uid();
  v_alumno_id uuid;
  v_institucion_id uuid;
  v_curp_actual_raw text;
  v_curp_actual_norm text;
  v_curp_nueva_norm text;
  v_grupo_autorizado boolean;
  v_duplicado boolean;
  v_filas_afectadas integer;
begin
  -- 1. Autenticación real.
  if v_docente_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  -- 2. Parámetros mínimos — fail fast antes de tocar cualquier tabla.
  if p_alumno_id is null or p_grupo_id is null then
    raise exception 'STUDENT_NOT_AUTHORIZED';
  end if;
  if p_curp_nueva is null or length(trim(p_curp_nueva)) = 0 then
    raise exception 'NEW_CURP_INVALID';
  end if;

  -- 3-4. Bloquear y releer la fila real del alumno — ownership +
  -- obtención del valor RAW real y de la institución real en un mismo
  -- paso, mensaje genérico sin distinguir "no existe" de "es de otro
  -- docente". institucion_id se conserva aquí mismo (nunca se vuelve a
  -- consultar por separado) para el chequeo de duplicado del paso 11.
  select a.id, a.curp, a.institucion_id
    into v_alumno_id, v_curp_actual_raw, v_institucion_id
  from public.alumnos a
  where a.id = p_alumno_id
    and a.docente_id = v_docente_id
  for update;

  if not found then
    raise exception 'STUDENT_NOT_AUTHORIZED';
  end if;

  -- 5. Grupo — inscripción activa en ESE grupo específico Y grupo
  -- perteneciente al mismo docente (defensa en profundidad: la
  -- pertenencia del alumno al docente ya se confirmó arriba, pero se
  -- revalida también aquí sin costo significativo). Mismo mensaje
  -- genérico sin distinguir el motivo exacto.
  select exists (
    select 1
    from public.inscripciones i
    join public.grupos g on g.id = i.grupo_id
    where i.alumno_id = v_alumno_id
      and i.grupo_id = p_grupo_id
      and i.estatus = 'activo'
      and g.docente_id = v_docente_id
  ) into v_grupo_autorizado;

  if not v_grupo_autorizado then
    raise exception 'GROUP_NOT_AUTHORIZED';
  end if;

  -- 6. CAS sobre el valor RAW — null-safe, SIN normalizar ninguno de
  -- los dos lados (ver "PRECISIÓN 1" en el comentario de cabecera).
  if v_curp_actual_raw is distinct from p_curp_esperada_actual then
    raise exception 'STALE_CURRENT_VALUE';
  end if;

  -- CURP actual NULL — fail-closed explícito (ver "CURP ACTUAL NULL"
  -- del diseño aprobado): nunca se amplía esta operación para cubrir el
  -- caso CURP_FALTANTE_EN_DB, aunque el CAS de arriba ya haya
  -- coincidido (ambos lados NULL).
  if v_curp_actual_raw is null then
    raise exception 'CURRENT_CURP_NOT_REPAIRABLE';
  end if;

  -- 7. Derivar normalizaciones aparte — SOLO para las reglas de
  -- estructura, nunca para el CAS ni para el WHERE del UPDATE final.
  v_curp_actual_norm := upper(trim(v_curp_actual_raw));
  v_curp_nueva_norm := upper(trim(p_curp_nueva));

  -- 8. La CURP actual debe seguir siendo estructuralmente inválida.
  if public.validar_estructura_curp_sql(v_curp_actual_norm) then
    raise exception 'CURRENT_CURP_NOT_REPAIRABLE';
  end if;

  -- 9. La CURP nueva debe ser estructuralmente válida.
  if not public.validar_estructura_curp_sql(v_curp_nueva_norm) then
    raise exception 'NEW_CURP_INVALID';
  end if;

  -- 10. Lock transaccional por CURP nueva normalizada — ANTES del
  -- SELECT de duplicado, nunca después.
  perform pg_advisory_xact_lock(hashtextextended(v_docente_id::text || ':' || v_curp_nueva_norm, 0::bigint));

  -- 11. Duplicado por docente (todas sus escuelas; nunca otras cuentas)
  -- — case-insensitive, excluye al propio
  -- alumno, mismo criterio ya usado en importar_alumnos_a_grupo.
  select exists (
    select 1
    from public.alumnos a2
    where a2.id <> v_alumno_id
      and a2.docente_id = v_docente_id
      and a2.curp is not null
      and upper(trim(a2.curp)) = v_curp_nueva_norm
  ) into v_duplicado;

  if v_duplicado then
    raise exception 'NEW_CURP_DUPLICATE';
  end if;

  -- 12. UPDATE — compare-and-set explícito y redundante con el FOR
  -- UPDATE de arriba (cinturón y tirantes, auto-documentado), usando el
  -- mismo valor RAW esperado del paso 6, nunca una versión normalizada.
  update public.alumnos
  set curp = v_curp_nueva_norm
  where id = v_alumno_id
    and docente_id = v_docente_id
    and curp is not distinct from p_curp_esperada_actual;

  get diagnostics v_filas_afectadas = row_count;
  if v_filas_afectadas <> 1 then
    raise exception 'STALE_CURRENT_VALUE';
  end if;

  -- 13. Historial — misma transacción, sin capturar excepción: si esto
  -- falla, TODA la operación (incluido el UPDATE de arriba) revierte.
  -- Solo los 3 campos mínimos necesarios, sin nombre/imagen/score/
  -- origenMatch/grupo — ver "HISTORIAL" del diseño aprobado.
  insert into public.correcciones_alumno (
    alumno_id, docente_id, campo,
    valor_anterior, valor_nuevo,
    fuente, fuente_detalle,
    conversacion_id, mensaje_id,
    accion, correccion_original_id
  ) values (
    v_alumno_id, v_docente_id, 'curp',
    to_jsonb(v_curp_actual_raw), to_jsonb(v_curp_nueva_norm),
    'imagen', jsonb_build_object('flujo', 'reparacion_curp_lista_oficial'),
    null, null,
    'correccion', null
  );

  -- 14. Fin — returns void, sin PII, sin ecoar CURP anterior/nueva.
end;
$function$;

do $$
begin
  if md5(pg_catalog.pg_get_functiondef('public.importar_alumnos_a_grupo(uuid, jsonb)'::regprocedure)) <> 'c905b378d0fdbeeab701e75311ff13e6'
     or (select p.prosecdef from pg_catalog.pg_proc p where p.oid = 'public.importar_alumnos_a_grupo(uuid, jsonb)'::regprocedure) is distinct from true
     or (select p.proconfig from pg_catalog.pg_proc p where p.oid = 'public.importar_alumnos_a_grupo(uuid, jsonb)'::regprocedure) is distinct from array['search_path=""']
     or (select pg_catalog.pg_get_userbyid(p.proowner) from pg_catalog.pg_proc p where p.oid = 'public.importar_alumnos_a_grupo(uuid, jsonb)'::regprocedure) <> 'postgres'
     or (select p.proacl::text from pg_catalog.pg_proc p where p.oid = 'public.importar_alumnos_a_grupo(uuid, jsonb)'::regprocedure) <> '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' then
    raise exception 'POSCONDICION_FALLIDA: importar_alumnos_a_grupo no quedó con la definición, SECURITY, search_path, propietario o permisos esperados.';
  end if;
  if md5(pg_catalog.pg_get_functiondef('public.alta_persona_con_inscripcion(uuid, text, text)'::regprocedure)) <> 'b5c0d54d931c27d25c473934cedf1bc2'
     or (select p.prosecdef from pg_catalog.pg_proc p where p.oid = 'public.alta_persona_con_inscripcion(uuid, text, text)'::regprocedure) is distinct from true
     or (select p.proconfig from pg_catalog.pg_proc p where p.oid = 'public.alta_persona_con_inscripcion(uuid, text, text)'::regprocedure) is distinct from array['search_path=""']
     or (select pg_catalog.pg_get_userbyid(p.proowner) from pg_catalog.pg_proc p where p.oid = 'public.alta_persona_con_inscripcion(uuid, text, text)'::regprocedure) <> 'postgres'
     or (select p.proacl::text from pg_catalog.pg_proc p where p.oid = 'public.alta_persona_con_inscripcion(uuid, text, text)'::regprocedure) <> '{postgres=X/postgres,service_role=X/postgres}' then
    raise exception 'POSCONDICION_FALLIDA: alta_persona_con_inscripcion no quedó con la definición, SECURITY, search_path, propietario o permisos esperados.';
  end if;
  if md5(pg_catalog.pg_get_functiondef('public.reparar_curp_desde_lista_oficial(uuid, uuid, text, text)'::regprocedure)) <> '6e8ac91f1e8a3dfa42e38dcf8deae53c'
     or (select p.prosecdef from pg_catalog.pg_proc p where p.oid = 'public.reparar_curp_desde_lista_oficial(uuid, uuid, text, text)'::regprocedure) is distinct from false
     or (select p.proconfig from pg_catalog.pg_proc p where p.oid = 'public.reparar_curp_desde_lista_oficial(uuid, uuid, text, text)'::regprocedure) is distinct from array['search_path=""']
     or (select pg_catalog.pg_get_userbyid(p.proowner) from pg_catalog.pg_proc p where p.oid = 'public.reparar_curp_desde_lista_oficial(uuid, uuid, text, text)'::regprocedure) <> 'postgres'
     or (select p.proacl::text from pg_catalog.pg_proc p where p.oid = 'public.reparar_curp_desde_lista_oficial(uuid, uuid, text, text)'::regprocedure) <> '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' then
    raise exception 'POSCONDICION_FALLIDA: reparar_curp_desde_lista_oficial no quedó con la definición, SECURITY, search_path, propietario o permisos esperados.';
  end if;
end;
$$;

commit;
