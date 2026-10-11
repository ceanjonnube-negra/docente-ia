-- Corrección de concurrencia en importar_alumnos_a_grupo (20260912200000)
-- — cierre del gap explícitamente dejado pendiente en
-- 20261008030000_alta_persona_con_inscripcion.sql ("GAP CONOCIDO").
-- V1-D2C1-B4D1, ronda de corrección de concurrencia, continuación.
--
-- HALLAZGO (confirmado por catálogo, pg_get_functiondef, en esta misma
-- ronda): importar_alumnos_a_grupo recorre el arreglo jsonb recibido
-- en UN SOLO bucle y, por cada elemento con CURP no nula, hace
-- EXISTS-luego-INSERT sin ningún advisory lock — la misma condición de
-- carrera (TOCTOU) ya corregida en alta_persona_con_inscripcion y ya
-- prevenida en reparar_curp_desde_lista_oficial.
--
-- POR QUÉ NO BASTA CON AGREGAR EL LOCK DENTRO DEL BUCLE PRINCIPAL,
-- COMO EN LAS OTRAS DOS FUNCIONES: esta función puede procesar hasta
-- 200 alumnos en una sola llamada (límite ya existente, sin cambios).
-- Si el advisory lock se adquiriera uno por uno, EN EL ORDEN en que
-- cada CURP aparece en el archivo importado — un orden que depende
-- ÚNICAMENTE del cliente/archivo, nunca de este servidor — dos
-- importaciones concurrentes que compartan dos o más CURP en ORDEN
-- INVERSO podrían quedar esperando cada una el lock que la otra ya
-- sostiene: un deadlock real. PostgreSQL lo detecta automáticamente y
-- aborta una de las dos transacciones, pero con un error de
-- "deadlock_detected" genérico — nunca con los mensajes de negocio
-- reales de esta función, y de forma no determinista (cuál de las dos
-- importaciones falla depende del instante exacto de cada solicitud).
--
-- CORRECCIÓN — orden total de adquisición (patrón estándar de
-- prevención, no solo detección, de deadlocks por bloqueos múltiples):
-- ANTES del bucle principal (que no cambia en ningún otro aspecto), se
-- hace un recorrido adicional, de SOLO LECTURA, que extrae las CURP
-- normalizadas distintas presentes en el lote; ese conjunto se ordena
-- de forma determinista (ascendente, misma colación en todas las
-- llamadas) y se adquiere, EN ESE ORDEN, un
-- pg_advisory_xact_lock(hashtextextended(<curp_norm>, 0::bigint)) por
-- cada una — EXACTAMENTE la misma función de bloqueo, con la misma
-- clave de hash, que ya usan reparar_curp_desde_lista_oficial y
-- alta_persona_con_inscripcion. Como esas otras dos funciones nunca
-- sostienen más de UN lock a la vez (procesan una sola persona), nunca
-- pueden formar parte de un ciclo de espera — son compatibles con este
-- cambio sin ninguna modificación. Y como esta función ahora adquiere
-- TODOS los locks que va a necesitar, de una sola vez y en orden
-- creciente, antes de retener o solicitar cualquier otro recurso, se
-- cumple la condición estándar que elimina el deadlock por
-- construcción (no solo lo detecta): ninguna transacción puede estar
-- esperando un recurso "menor" en el orden mientras sostiene uno
-- "mayor", así que no puede existir un ciclo. Los locks son
-- transaccionales (_xact_): se liberan solos al terminar la
-- transacción, sin importar si termina en COMMIT o en ROLLBACK.
--
-- QUÉ NO CAMBIA EN ESTA MIGRACIÓN (requisito explícito de esta ronda):
--   - Firma: importar_alumnos_a_grupo(p_grupo_id uuid, p_alumnos jsonb)
--     returns integer — idéntica.
--   - Autorización (auth.uid real, propiedad de grupos.docente_id),
--     validaciones de nombre/sexo/tamaño de lote, duplicado intra-lote
--     (v_curps_vistos) y duplicado institucional (EXISTS) — idénticos,
--     mismo texto de mensajes, mismo orden relativo entre sí.
--   - Columnas e INSERT de alumnos/inscripciones — idénticos (incluye
--     sexo, que SÍ transporta esta función a diferencia de
--     alta_persona_con_inscripcion).
--   - Retorno (v_creados) y manejo de errores (0 excepción capturada,
--     reversión completa de la transacción) — idénticos.
--   - 0 restricción UNIQUE nueva, 0 modificación de alumnos existentes,
--     0 cambio de UI/Chat IA.
--   - Permisos EXECUTE: CREATE OR REPLACE FUNCTION, sobre la MISMA
--     firma, preserva automáticamente los GRANT/REVOKE ya existentes
--     sobre el objeto (PostgreSQL no los toca al reemplazar el cuerpo
--     de una función existente) — por eso esta migración, deliberada-
--     mente, no contiene ningún GRANT ni REVOKE: tocar los permisos
--     aquí sería un cambio de alcance no solicitado en esta ronda.
--
-- CREATE OR REPLACE (a diferencia del CREATE FUNCTION fail-closed de
-- trasladar_inscripcion/alta_persona_con_inscripcion): aquí es
-- deliberado y explícitamente solicitado — esta función YA existe en
-- producción con esta firma exacta; el objetivo es reemplazar
-- únicamente su cuerpo, preservando firma, permisos y comportamiento
-- externo observable.

create or replace function public.importar_alumnos_a_grupo(p_grupo_id uuid, p_alumnos jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
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
  -- alta_persona_con_inscripcion — misma clave ante la misma CURP, así
  -- que las tres funciones se serializan correctamente entre sí.
  for v_curp_lock in select unnest(v_curps_lote) order by 1
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_curp_lock, 0::bigint));
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
    -- existentes de la MISMA institución — cualquier conflicto aborta
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
        where a.institucion_id = v_institucion_id
          and upper(a.curp) = v_curp_norm
      ) then
        raise exception 'Esa CURP ya está registrada.';
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
$$;
