-- Reparación del ALTA existente de ImportacionInteligente.
--
-- Objetivo (ver diseño aprobado "OPCIÓN B — RPC atómica para primera
-- importación/alta"): el flujo actual (browser → INSERT alumnos →
-- INSERT inscripciones, ambos directos vía PostgREST) está roto por
-- evidencia de esquema ya auditada: alumnos.docente_id es NOT NULL sin
-- default/trigger y guardarAlumnosImportados nunca lo envía, e
-- inscripciones no tiene ninguna policy RLS de INSERT. Esta migración
-- reemplaza ese camino por UNA sola función SECURITY DEFINER que hace
-- ambas escrituras de forma atómica, derivando docente_id/
-- institucion_id/ciclo_escolar_id exclusivamente del grupo ya validado
-- server-side — nunca de un valor que mande el cliente.
--
-- Deliberadamente NO se crea ninguna policy INSERT nueva sobre
-- inscripciones: la ausencia de esa policy se conserva a propósito como
-- barrera adicional contra un segundo camino de escritura directo desde
-- el navegador — esta función pasa a ser el ÚNICO camino de alta.
-- Tampoco se modifica la policy existente de `alumnos` ("Docentes ven
-- sus alumnos"), usada hoy por SELECT/UPDATE/DELETE en varias pantallas
-- ajenas a esta tarea.
--
-- Grupos compartidos (docente_grupos) quedan deliberadamente fuera de
-- esta fase — ver auditoría "grupos compartidos" (el propio esquema de
-- `grupos` restringe hoy el acceso a docente_id=auth.uid() únicamente;
-- docente_grupos no está conectado a ninguna policy de grupos todavía).
-- Esta función solo acepta al propietario real y directo del grupo.
--
-- Fail-closed deliberado (no idempotente): CREATE FUNCTION sin
-- CREATE OR REPLACE — si la función ya existiera por un drift de
-- esquema no auditado, esta migración debe fallar explícitamente en
-- vez de sobrescribir silenciosamente una definición no revisada.

create function public.importar_alumnos_a_grupo(p_grupo_id uuid, p_alumnos jsonb)
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
    -- alumno existente.
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
  -- ningún alumno ni inscripción parcial puede quedar guardado.
  return v_creados;
end;
$$;

-- Privilegios — mismo hardening ya aplicado y verificado en MG-B
-- (fijar_grupo_conversacion + su corrección de anon): PostgreSQL
-- concede EXECUTE sobre funciones nuevas a PUBLIC por defecto, y este
-- proyecto además tiene una regla ALTER DEFAULT PRIVILEGES a nivel del
-- esquema public que concede EXECUTE directo a anon/authenticated (no
-- vía PUBLIC) — por eso se revocan ambos caminos explícitamente en esta
-- misma migración, sin esperar a una corrección posterior.
revoke execute on function public.importar_alumnos_a_grupo(uuid, jsonb) from public;
revoke execute on function public.importar_alumnos_a_grupo(uuid, jsonb) from anon;
grant execute on function public.importar_alumnos_a_grupo(uuid, jsonb) to authenticated;
