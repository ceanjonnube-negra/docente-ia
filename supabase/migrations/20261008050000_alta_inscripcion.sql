-- Alta individual de inscripción para un alumno YA EXISTENTE — ver
-- fase "V1-D2C1-B4D2". Crea ÚNICAMENTE una fila nueva en
-- `inscripciones` para una persona cuya identidad ya fue resuelta con
-- certeza antes de firmar (contrato OperacionAltaInscripcionAplicable,
-- lib/listaOficial/aplicacionFirmada.ts). Nunca crea ni modifica
-- ninguna fila de `alumnos`, nunca reactiva ni modifica ninguna
-- inscripción anterior. Esta migración es EXCLUSIVAMENTE la función SQL
-- primitiva — NO la RPC transaccional que recorrerá el lote completo
-- (todavía inexistente), mismo criterio que trasladar_inscripcion y
-- alta_persona_con_inscripcion.
--
-- REGLAS DE PROPIEDAD REALES (verificadas antes de escribir esta
-- función, ver reporte de la fase):
--   - Grupo destino: propiedad comprobada contra grupos.docente_id (el
--     único dato en vivo) — nunca contra inscripciones.docente_id (que
--     es un estampado histórico, nunca actualizado tras el INSERT) ni
--     delegada a RLS (esta función es SECURITY DEFINER y la bypassa).
--     Grupos compartidos (docente_grupos) quedan fuera de alcance,
--     mismo criterio que el resto de esta familia.
--   - Alumno: la propiedad de la IDENTIDAD es POR DOCENTE, no por
--     institución — alumnos.docente_id es la clave de la policy RLS
--     real "Docentes ven sus alumnos" (FOR ALL, docente_id =
--     auth.uid()), ningún código del proyecto la modifica tras el
--     INSERT, y la prevalidación de aplicar-plan ya carga el alumno con
--     .eq('docente_id', auth.user.id) ANTES de comparar institucion_id.
--     Por tanto "ámbito institucional autorizado" se interpreta aquí
--     como: alumnos.docente_id = auth.uid() Y alumnos.institucion_id =
--     institución del grupo destino. Validar SOLO la institución sería
--     una ampliación de privilegios: al ser SECURITY DEFINER, permitiría
--     a un docente inscribir en su grupo, por UUID, a un alumno de OTRO
--     docente de la misma institución — algo que hoy ni RLS ni la
--     prevalidación permiten.
--
-- CICLO ESCOLAR: derivado ÚNICAMENTE del grupo destino ya validado,
-- nunca aceptado como parámetro (mismo criterio que
-- alta_persona_con_inscripcion/trasladar_inscripcion).
--
-- INSCRIPCIÓN ACTIVA: se rechaza CUALQUIER inscripción 'activo' del
-- alumno en ese mismo ciclo, sin importar el grupo (el mismo destino u
-- otro). Esta función NUNCA da de baja otra inscripción ni la convierte
-- en traslado — ese caso es la operación distinta 'traslado'
-- (trasladar_inscripcion). Si el alumno solo tiene inscripciones
-- históricas (estatus <> 'activo'), se crea una fila NUEVA con un UUID
-- nuevo y las anteriores se conservan íntegramente (0 UPDATE, 0 DELETE)
-- junto con todo el historial anclado a sus inscripciones.id.
--
-- CONCURRENCIA:
--   - La fila del alumno se bloquea (SELECT ... FOR UPDATE OF a) antes
--     de cualquier decisión: dos alta_inscripcion simultáneas del MISMO
--     alumno se serializan, y la segunda ve la fila activa que dejó la
--     primera y falla con el mensaje claro.
--   - El índice parcial UNIQUE existente inscripciones_alumno_ciclo_activo_uk
--     (alumno_id, ciclo_escolar_id) WHERE estatus = 'activo' sigue
--     siendo la barrera DEFINITIVA — cubre también la carrera con
--     trasladar_inscripcion (que bloquea la inscripción de origen, no
--     el alumno). Esta función no captura esa excepción: si el índice
--     la rechaza, el error propaga y PostgreSQL revierte la transacción
--     completa (nunca queda una segunda inscripción activa).
--
-- COMPATIBILIDAD CON EL CONTRATO HMAC (verificada, sin modificarlo):
-- OperacionAltaInscripcionAplicable = { tipo: 'alta_inscripcion',
-- alumnoId: string } más el grupoId ya firmado a nivel de
-- PayloadAplicacionListaOficial — mapea 1:1 sobre (p_alumno_id,
-- p_grupo_id_destino). 0 campo adicional, 0 cambio de contrato.
--
-- IDENTIDAD: 0 inferencia por nombre, similitud ni CURP — el alumno se
-- identifica exclusivamente por su UUID ya firmado.
--
-- ACCESO — igual que trasladar_inscripcion/alta_persona_con_inscripcion:
-- SECURITY DEFINER, pero se revoca EXECUTE de PUBLIC, anon Y
-- authenticated explícitamente. Solo la futura RPC transaccional del
-- lote podrá invocarla. service_role conserva el EXECUTE que ya recibe
-- por defecto (ALTER DEFAULT PRIVILEGES del proyecto) — no se otorga ni
-- se revoca aquí.
--
-- Fail-closed deliberado (no idempotente): CREATE FUNCTION sin CREATE
-- OR REPLACE — si la función ya existiera por un drift de esquema no
-- auditado, esta migración debe fallar explícitamente.

create function public.alta_inscripcion(
  p_alumno_id uuid,
  p_grupo_id_destino uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_docente_id uuid := auth.uid();
  v_institucion_id_destino uuid;
  v_ciclo_escolar_id_destino uuid;
  v_institucion_id_alumno uuid;
  v_ya_activo_en_ciclo boolean;
  v_inscripcion_id_nueva uuid;
begin
  -- Autenticación real, fail fast.
  if v_docente_id is null then
    raise exception 'No autenticado.';
  end if;

  if p_alumno_id is null or p_grupo_id_destino is null then
    raise exception 'Faltan datos obligatorios para la inscripción.';
  end if;

  -- Propiedad REAL del grupo destino — contra grupos.docente_id (dato
  -- en vivo). institucion_id/ciclo_escolar_id se derivan ÚNICAMENTE de
  -- aquí, nunca de un parámetro.
  select g.institucion_id, g.ciclo_escolar_id
    into v_institucion_id_destino, v_ciclo_escolar_id_destino
  from public.grupos g
  where g.id = p_grupo_id_destino
    and g.docente_id = v_docente_id;

  if not found then
    raise exception 'Grupo destino no encontrado o no autorizado.';
  end if;

  -- Alumno existente y propio del docente — contra alumnos.docente_id
  -- (clave real de la policy RLS de alumnos). Se bloquea la fila para
  -- serializar altas concurrentes del mismo alumno.
  select a.institucion_id
    into v_institucion_id_alumno
  from public.alumnos a
  where a.id = p_alumno_id
    and a.docente_id = v_docente_id
  for update of a;

  if not found then
    raise exception 'Alumno no encontrado o no autorizado.';
  end if;

  -- Misma institución que el grupo destino.
  if v_institucion_id_alumno is distinct from v_institucion_id_destino then
    raise exception 'El alumno no pertenece a la misma institución del grupo destino.';
  end if;

  -- Cualquier inscripción ACTIVA del alumno en el ciclo destino, en
  -- CUALQUIER grupo, se rechaza — anticipa con un mensaje claro lo que
  -- el índice parcial inscripciones_alumno_ciclo_activo_uk haría
  -- cumplir de todas formas. Nunca se da de baja ni se traslada nada.
  select exists (
    select 1 from public.inscripciones i
    where i.alumno_id = p_alumno_id
      and i.ciclo_escolar_id = v_ciclo_escolar_id_destino
      and i.estatus = 'activo'
  ) into v_ya_activo_en_ciclo;

  if v_ya_activo_en_ciclo then
    raise exception 'El alumno ya tiene una inscripción activa en este ciclo escolar.';
  end if;

  -- Fila NUEVA (UUID nuevo por default de la tabla) — las inscripciones
  -- anteriores se conservan intactas. numero_lista NUNCA se escribe
  -- (mismo criterio que importar_alumnos_a_grupo). docente_id solo se
  -- estampa, igual que el resto de esta familia — nunca se usa para
  -- autorizar.
  insert into public.inscripciones (alumno_id, grupo_id, ciclo_escolar_id, docente_id, estatus)
  values (p_alumno_id, p_grupo_id_destino, v_ciclo_escolar_id_destino, v_docente_id, 'activo')
  returning id into v_inscripcion_id_nueva;

  return v_inscripcion_id_nueva;
end;
$$;

-- Privilegios — ver "ACCESO" en la cabecera.
revoke execute on function public.alta_inscripcion(uuid, uuid) from public;
revoke execute on function public.alta_inscripcion(uuid, uuid) from anon;
revoke execute on function public.alta_inscripcion(uuid, uuid) from authenticated;
