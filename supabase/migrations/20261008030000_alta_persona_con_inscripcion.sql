-- Alta atómica de UNA persona nueva y su inscripción inicial — ver
-- diseño aprobado "V1-D2C1-B4D — aplicación real del plan de lista
-- oficial" (DECISIÓN 1: alta_persona crea alumno E inscripción en una
-- misma operación atómica) y su primera fase, "V1-D2C1-B4D1". Esta
-- migración es EXCLUSIVAMENTE la función SQL primitiva — NO la RPC
-- transaccional que recorre el lote completo (todavía inexistente),
-- que es la única que debe llamarla en producción real (ver "ACCESO"
-- más abajo, mismo criterio ya aplicado a trasladar_inscripcion en
-- V1-D2C1-B4C).
--
-- Reutiliza, REGLA POR REGLA, la lógica ya probada en producción de
-- importar_alumnos_a_grupo (20260912200000) — esta función es,
-- deliberadamente, la misma lógica de UNA sola iteración de aquel
-- bucle, extraída para poder invocarse de forma aislada dentro de un
-- lote mixto (junto a actualizar_dato/alta_inscripcion/baja/traslado),
-- nunca una segunda implementación divergente de esas reglas:
--   - Autorización del docente: auth.uid() real, fail-closed si nulo.
--   - Propiedad del grupo: comprobada explícitamente contra
--     grupos.docente_id (SECURITY DEFINER bypassa RLS, nunca se
--     delega a una policy) — grupos compartidos (docente_grupos)
--     fuera de alcance, mismo criterio exacto.
--   - institucion_id/ciclo_escolar_id: derivados ÚNICAMENTE del grupo
--     ya validado, nunca aceptados como parámetro.
--   - Validación de nombre: trim + rechazo si queda vacío.
--   - Validación de CURP: opcional (puede ser NULL — "CURP no
--     legible/ausente" es una lectura real y válida, ver V1-A); si
--     existe, se guarda EXACTAMENTE como se recibió (solo recortada de
--     espacios, nunca cambiada de mayúsculas/minúsculas) — la
--     comparación de duplicados sí normaliza a mayúsculas, misma
--     semántica exacta.
--   - Duplicados institucionales de CURP: EXISTS contra TODOS los
--     alumnos de la MISMA institución (nunca solo los del propio
--     docente — alcance real solo posible porque esta función es
--     SECURITY DEFINER) — cualquier conflicto aborta, nunca fusiona
--     ni reutiliza un alumno existente.
--
-- CONDICIÓN DE CARRERA CORREGIDA EN ESTA MISMA MIGRACIÓN (revisión
-- posterior a la primera versión de este archivo): `alumnos` NO tiene
-- ninguna restricción UNIQUE sobre `curp` (confirmado exhaustivamente
-- por catálogo, pg_indexes/pg_constraint) — la unicidad institucional
-- de CURP se hacía cumplir ÚNICAMENTE mediante el EXISTS de arriba,
-- que es un patrón "comprobar-luego-actuar" (TOCTOU): dos llamadas
-- concurrentes con la MISMA CURP podían superar ambas el EXISTS antes
-- de que cualquiera confirmara su INSERT, creando dos personas con la
-- misma CURP. La corrección añade un advisory lock TRANSACCIONAL
-- (pg_advisory_xact_lock), con clave derivada de la CURP normalizada
-- (hashtextextended(v_curp_norm, 0::bigint)) — EXACTAMENTE el mismo
-- mecanismo, con la misma firma, que ya usa en producción
-- reparar_curp_desde_lista_oficial (20260822..., PASO 10) para este
-- mismo problema. No es un mecanismo nuevo: es la reutilización
-- deliberada de un patrón ya auditado y ya aprobado en este proyecto.
-- Por qué un advisory lock y no un UNIQUE real: un UNIQUE sobre
-- alumnos.curp no está contemplado por la arquitectura actual (CURP es
-- NULL-able y la unicidad es POR INSTITUCIÓN, no global — un índice
-- UNIQUE parcial equivalente sería un cambio de esquema nuevo, fuera
-- del alcance autorizado de esta ronda, que solo permite tocar esta
-- función y su script de pruebas). El advisory lock no requiere ningún
-- cambio de esquema, es transaccional (se libera automáticamente al
-- terminar la transacción, por COMMIT o por ROLLBACK — nunca puede
-- quedar un lock huérfano si esta función lanza una excepción) y solo
-- serializa a quien reclame la MISMA CURP (vía el hash de su valor
-- normalizado) — nunca bloquea ninguna operación sobre alumnos con una
-- CURP distinta.
--
-- GAP CONOCIDO, EXPLÍCITAMENTE FUERA DE ALCANCE DE ESTA RONDA:
-- importar_alumnos_a_grupo (20260912200000) inserta en alumnos con el
-- MISMO patrón EXISTS-luego-INSERT, por fila, dentro de su bucle — y
-- HOY NO adquiere ningún advisory lock. El lock que esta función
-- adquiere la protege completamente a SÍ MISMA y también se serializa
-- correctamente contra reparar_curp_desde_lista_oficial (misma clave
-- exacta), pero NO bloquea a importar_alumnos_a_grupo: una llamada
-- concurrente a esa función con la misma CURP podría seguir colarse
-- por esa vía sin pasar por este lock. Confirmado por catálogo
-- (pg_proc.prosrc) en esta misma ronda: son, EXACTAMENTE, las únicas
-- dos funciones del esquema que hacen `insert into ... alumnos`.
-- Cerrar el gap por completo requeriría añadir el mismo
-- pg_advisory_xact_lock(hashtextextended(<curp_norm_de_la_fila>,
-- 0::bigint)) dentro del bucle de importar_alumnos_a_grupo, antes de
-- su EXISTS por fila — eso es una modificación a OTRA función SQL ya
-- desplegada, fuera de los 2 archivos autorizados para esta fase. Se
-- deja explícitamente propuesto, no implementado, para una fase futura
-- dedicada.
--   - alumnos_nombre_docente_id_key (UNIQUE nombre+docente_id, ya
--     confirmada por catálogo en V1-D2C1-B0) sigue actuando como
--     respaldo real de la base de datos ante un nombre duplicado no
--     detectado aquí — mismo criterio exacto: no se preverifica por
--     nombre, se confía en el constraint real.
--   - Inserción de alumnos: mismas columnas exactas
--     (institucion_id, docente_id, nombre, curp) — sexo/fecha_nacimiento
--     nunca se escriben aquí porque el contrato de aplicación firmado
--     (OperacionAltaPersonaAplicable = {nombre, curp}) no los
--     transporta — igual que importar_alumnos_a_grupo nunca inventa un
--     dato que el llamador no proporcionó.
--   - Inserción de inscripciones: mismas columnas exactas
--     (alumno_id, grupo_id, ciclo_escolar_id, docente_id, estatus),
--     numero_lista NUNCA se escribe (el orden real y visible de Lista
--     lo calcula obtenerRosterConPosicion sin depender de esta
--     columna).
--   - Manejo de errores: 0 excepción capturada en ningún punto — un
--     error en cualquier paso (nombre vacío, CURP duplicada, violación
--     de un constraint real) propaga hacia afuera y PostgreSQL revierte
--     TODA la transacción — nunca puede quedar un alumno huérfano
--     (creado sin su inscripción) ni una inscripción sin alumno.
--
-- COMPATIBILIDAD CON EL CONTRATO HMAC (verificada, sin modificarlo):
-- OperacionAltaPersonaAplicable = { tipo: 'alta_persona', nombre:
-- string, curp: string | null } (lib/listaOficial/aplicacionFirmada.ts)
-- más el grupoId ya firmado a nivel de PayloadAplicacionListaOficial
-- — mapea 1:1 sobre (p_grupo_id, p_nombre, p_curp). 0 campo adicional
-- necesario, 0 cambio de contrato requerido para esta fase.
--
-- IDENTIDAD: 0 inferencia por nombre, similitud ni coincidencia
-- parcial — el nombre se guarda tal cual, nunca se compara contra
-- nombres existentes para decidir si "ya es" otra persona (esa
-- decisión, cuando corresponde, es 'alta_inscripcion' o 'traslado',
-- operaciones estructuralmente distintas, nunca esta).
--
-- ACCESO — igual que trasladar_inscripcion (V1-D2C1-B4C): SECURITY
-- DEFINER, pero se revoca EXECUTE de PUBLIC, anon Y authenticated
-- explícitamente (DECISIÓN 3 de V1-D2C1-B4D: la futura RPC de
-- aplicación tampoco tendrá EXECUTE para esos roles — solo el backend
-- autorizado podrá invocar la cadena completa). A diferencia de
-- importar_alumnos_a_grupo (que SÍ otorga a authenticated porque ya se
-- invoca directamente desde /api/importar-alumnos para el alta masiva
-- original), esta función NO debe ser invocable todavía por ningún
-- docente real: es una primitiva de uso exclusivamente interno para la
-- futura RPC transaccional del lote completo, que todavía no existe.
-- service_role conserva el EXECUTE que ya recibe por defecto (ALTER
-- DEFAULT PRIVILEGES del proyecto) — no se otorga ni se revoca aquí.
--
-- Fail-closed deliberado (no idempotente): CREATE FUNCTION sin CREATE
-- OR REPLACE — mismo criterio que dar_de_baja_inscripcion/
-- trasladar_inscripcion: si la función ya existiera por un drift de
-- esquema no auditado, esta migración debe fallar explícitamente en
-- vez de sobrescribir silenciosamente una definición no revisada.

create function public.alta_persona_con_inscripcion(
  p_grupo_id uuid,
  p_nombre text,
  p_curp text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
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
    perform pg_advisory_xact_lock(hashtextextended(v_curp_norm, 0::bigint));

    -- Duplicado INSTITUCIONAL real — EXISTS contra TODOS los alumnos
    -- de la institución (nunca solo los del propio docente), posible
    -- únicamente porque esta función es SECURITY DEFINER. Cualquier
    -- conflicto aborta el alta completa — nunca fusiona ni reutiliza
    -- un alumno existente.
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
$$;

-- Privilegios — ver "ACCESO" en el comentario de cabecera: se revoca
-- EXECUTE de PUBLIC, anon Y authenticated explícitamente. service_role
-- conserva el EXECUTE que ya recibe por defecto a nivel de proyecto —
-- no se toca aquí.
revoke execute on function public.alta_persona_con_inscripcion(uuid, text, text) from public;
revoke execute on function public.alta_persona_con_inscripcion(uuid, text, text) from anon;
revoke execute on function public.alta_persona_con_inscripcion(uuid, text, text) from authenticated;
