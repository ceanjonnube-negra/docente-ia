-- Reparación de un defecto preexistente de producto: la ficha del
-- alumno (app/dashboard/lista/[alumnoId]/page.tsx, botón "Dar de baja"
-- → modal "Eliminar definitivamente") ya invoca
-- supabase.rpc('eliminar_alumno_definitivamente', ...) desde
-- lib/motorContexto.ts, pero esa función nunca existió en la base de
-- datos real — cualquier intento fallaba con "función no encontrada",
-- confirmado exhaustivamente contra el catálogo real antes de esta
-- migración. Esta migración únicamente crea la función faltante; no
-- toca UI, RLS, columnas ni triggers existentes.
--
-- Diseño (ver auditoría aprobada "especificación eliminar_alumno_
-- definitivamente"): SECURITY INVOKER deliberado — a diferencia de
-- importar_alumnos_a_grupo, aquí NO hace falta escapar de RLS: la
-- policy ya existente de alumnos ("Docentes ven sus alumnos",
-- docente_id = auth.uid(), FOR ALL) ya autoriza al propio dueño a leer
-- y borrar su propia fila, y las 9 tablas de historial bloqueante
-- (ver abajo) usan policies que ya son igualmente visibles al mismo
-- docente dueño del alumno — verificado exhaustivamente antes de esta
-- migración. Usar SECURITY DEFINER aquí sería una elevación de
-- privilegios innecesaria.
--
-- Regla de negocio (fail-closed, las 3 condiciones deben cumplirse
-- TODAS antes de borrar):
--   1. El alumno debe pertenecer real y actualmente al docente que
--      llama (auth.uid(), nunca un docente_id recibido del cliente).
--   2. Cero filas para ese alumno en las 9 tablas de historial
--      académico real: asistencias, evaluaciones, evidencias,
--      fichas_descriptivas, incidencias, necesidades_apoyo,
--      correcciones_alumno, seguimiento_resultados,
--      seguimiento_versiones.
--   3. Como máximo 1 fila en inscripciones (2+ indica trayectoria
--      multiciclo real, sin importar el estatus de cada una).
-- perfil_alumno_notas y perfil_alumno_resumen son datos derivados/
-- cache — se permite que desaparezcan junto con el alumno vía su
-- propia FK ON DELETE CASCADE, igual que la única inscripción
-- permitida. Ningún DELETE manual sobre tablas relacionadas: solo la
-- integridad referencial declarada actúa, y solo después de que las
-- tres condiciones ya garantizaron que no hay nada real que perder.
--
-- Concurrencia: el SELECT ... FOR UPDATE sobre alumnos no solo
-- verifica ownership, también bloquea la fila hasta el final de la
-- transacción. Por semántica de PostgreSQL, cualquier INSERT
-- concurrente en una tabla con FK hacia alumnos(id) — las 9 de
-- historial y también inscripciones — necesita adquirir como mínimo
-- un lock FOR KEY SHARE sobre la fila referenciada para verificar la
-- integridad referencial, y FOR KEY SHARE conflictúa con FOR UPDATE.
-- Mientras esta función mantenga el lock, ninguna otra transacción
-- puede crear una referencia nueva hacia este alumno: su intento
-- queda bloqueado hasta que esta transacción termine (commit o
-- rollback) — momento en el que o bien el alumno ya no existe (el
-- INSERT concurrente falla correctamente por violación de FK) o bien
-- la validación de aquí falló y el alumno sigue intacto (el INSERT
-- concurrente procede con normalidad). No hace falta ningún mecanismo
-- adicional de bloqueo.
--
-- Fail-closed deliberado (no idempotente): CREATE FUNCTION sin
-- CREATE OR REPLACE — si la función ya existiera por un drift de
-- esquema no auditado, esta migración debe fallar explícitamente en
-- vez de sobrescribir silenciosamente una definición no revisada.

create function public.eliminar_alumno_definitivamente(p_alumno_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_docente_id uuid := auth.uid();
  v_alumno_id uuid;
  v_tiene_historial boolean;
  v_num_inscripciones integer;
  v_filas_eliminadas integer;
begin
  if v_docente_id is null then
    raise exception 'No autenticado.';
  end if;

  if p_alumno_id is null then
    raise exception 'Falta el alumno.';
  end if;

  -- Ownership + lock en un mismo paso — nunca un SELECT sin lock
  -- seguido de un lock aparte. Mensaje único, sin distinguir
  -- "inexistente" de "ajeno".
  select a.id into v_alumno_id
  from public.alumnos a
  where a.id = p_alumno_id
    and a.docente_id = v_docente_id
  for update;

  if not found then
    raise exception 'Alumno no encontrado o no autorizado.';
  end if;

  -- Historial académico real — 9 tablas, cualquier fila bloquea todo.
  select exists (
    select 1 from public.asistencias where alumno_id = v_alumno_id
    union all
    select 1 from public.evaluaciones where alumno_id = v_alumno_id
    union all
    select 1 from public.evidencias where alumno_id = v_alumno_id
    union all
    select 1 from public.fichas_descriptivas where alumno_id = v_alumno_id
    union all
    select 1 from public.incidencias where alumno_id = v_alumno_id
    union all
    select 1 from public.necesidades_apoyo where alumno_id = v_alumno_id
    union all
    select 1 from public.correcciones_alumno where alumno_id = v_alumno_id
    union all
    select 1 from public.seguimiento_resultados where alumno_id = v_alumno_id
    union all
    select 1 from public.seguimiento_versiones where alumno_id = v_alumno_id
  ) into v_tiene_historial;

  if v_tiene_historial then
    raise exception 'El alumno tiene historial académico y no puede eliminarse definitivamente.';
  end if;

  -- Multiciclo: la CANTIDAD total de inscripciones es la regla, sin
  -- importar su estatus ni a qué ciclo pertenezcan.
  select count(*) into v_num_inscripciones
  from public.inscripciones
  where alumno_id = v_alumno_id;

  if v_num_inscripciones > 1 then
    raise exception 'El alumno tiene historial de inscripciones y no puede eliminarse definitivamente.';
  end if;

  -- DELETE final — únicamente ahora, tras superar todas las
  -- validaciones. perfil_alumno_notas/perfil_alumno_resumen
  -- (derivados) y la única inscripción permitida (si existe)
  -- desaparecen solo por su propia FK ON DELETE CASCADE ya auditada.
  delete from public.alumnos
  where id = v_alumno_id
    and docente_id = v_docente_id;

  get diagnostics v_filas_eliminadas = row_count;
  if v_filas_eliminadas <> 1 then
    raise exception 'No se pudo eliminar al alumno.';
  end if;
end;
$$;

-- Privilegios — mismo hardening ya aplicado y verificado en MG-B e
-- importar_alumnos_a_grupo: PostgreSQL concede EXECUTE sobre funciones
-- nuevas a PUBLIC por defecto, y este proyecto además tiene una regla
-- ALTER DEFAULT PRIVILEGES a nivel del esquema public que concede
-- EXECUTE directo a anon/authenticated (no vía PUBLIC) — por eso se
-- revocan ambos caminos explícitamente en esta misma migración.
revoke execute on function public.eliminar_alumno_definitivamente(uuid) from public;
revoke execute on function public.eliminar_alumno_definitivamente(uuid) from anon;
grant execute on function public.eliminar_alumno_definitivamente(uuid) to authenticated;
