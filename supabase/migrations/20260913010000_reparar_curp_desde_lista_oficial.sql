-- Fase de implementación (RPC local, NO aplicada todavía) — "reparación
-- segura de CURP histórica desde lista oficial". Ver diseño exacto
-- aprobado en esta sesión (arquitectura: Lista → API Next.js autenticada
-- → RPC PostgreSQL SECURITY INVOKER → revalidación completa → UPDATE
-- atómico → INSERT en correcciones_alumno → misma transacción).
--
-- Esta migración es 100% ADITIVA: solo crea 2 funciones nuevas
-- (public.validar_estructura_curp_sql, public.reparar_curp_desde_lista_
-- oficial). NO modifica ninguna tabla, columna, constraint ni policy
-- existente. NO toca aplicarCorreccionAlumno (TypeScript) — esa función
-- sigue siendo una deuda técnica separada y documentada (ver comentario
-- de garantía de duplicados más abajo), deliberadamente fuera de
-- alcance de esta fase.
--
-- Fail-closed deliberado (no idempotente): CREATE FUNCTION sin CREATE OR
-- REPLACE en ambas funciones — si alguna ya existiera por un drift de
-- esquema no auditado, esta migración debe fallar explícitamente en vez
-- de sobrescribir silenciosamente una definición no revisada (mismo
-- criterio ya usado en importar_alumnos_a_grupo y
-- eliminar_alumno_definitivamente).

-- ============================================================
-- A) HELPER — validar_estructura_curp_sql
-- ============================================================
--
-- Réplica EXACTA (no una interpretación aproximada, no un
-- endurecimiento silencioso) de validarEstructuraCurp en
-- lib/motorContexto.ts (líneas ~363-409 al momento de escribir esta
-- migración). Mismo contrato de entrada que su contraparte TypeScript:
-- espera un valor YA normalizado por el CALLER (trim + mayúsculas) —
-- esta función, igual que la de TypeScript, NO normaliza nada por su
-- cuenta, solo valida estructura posición por posición.
--
-- *** COMENTARIO CRUZADO OBLIGATORIO ***
-- Si cambia lib/motorContexto.ts::validarEstructuraCurp (TypeScript),
-- esta función SQL debe revisarse y actualizarse en una migración
-- nueva. Si esta función SQL cambia, revisar también la versión
-- TypeScript. No existe (ni puede existir en esta arquitectura) una
-- única fuente de verdad compartida entre ambos lenguajes — PL/pgSQL no
-- puede invocar código TypeScript real. Mitigación: solo disciplina de
-- proceso, nunca garantía técnica automática.
--
-- Reglas replicadas, en el mismo orden que la versión TypeScript:
--   1. longitud exacta 18.
--   2. posiciones 1-4: [A-Z][AEIOUX][A-Z]{2}.
--   3. posiciones 5-10 (fecha): 6 dígitos.
--   4. mes codificado entre 01 y 12.
--   5. día codificado válido para ese mes — DIAS_POR_MES replicado
--      exactamente, incluyendo la misma decisión deliberada de permitir
--      SIEMPRE 29 de febrero (la CURP, sin siglo completo, nunca
--      permite saber con certeza si el año era bisiesto — nunca se
--      rechaza un 29/02 por esa ambigüedad, pero sí un 30 o 31 de
--      febrero, o un día imposible en cualquier mes de 30 días).
--   6. posición 11 (sexo): H o M.
--   7. posiciones 12-13 (entidad): whitelist ENTIDADES_CURP_VALIDAS
--      replicada carácter por carácter, mismas 33 claves.
--   8. posiciones 14-16 (consonantes internas): [B-DF-HJ-NP-TV-Z]{3}.
--   9. posición 17 (homoclave/diferenciador): [A-Z0-9].
--   10. posición 18 (dígito verificador): debe ser un dígito — NUNCA se
--       recalcula el algoritmo real de verificación de la CURP oficial
--       (la versión TypeScript tampoco lo hace), solo se exige que sea
--       numérico.
--
-- Función pura: no consulta ninguna tabla, no tiene efectos
-- secundarios, no necesita SECURITY DEFINER — se declara explícitamente
-- SECURITY INVOKER (el comportamiento por defecto de PostgreSQL para
-- funciones nuevas, pero se declara de forma explícita por auditabilidad,
-- mismo criterio ya usado en el resto de este proyecto) con
-- search_path vacío. pg_catalog permanece siempre implícitamente
-- disponible sin importar search_path, así que las funciones/operadores
-- nativos usados aquí (length, substring, upper, ~ ...) funcionan sin
-- necesitar calificación de esquema.

create function public.validar_estructura_curp_sql(p_curp text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_dias_por_mes integer[] := array[31,29,31,30,31,30,31,31,30,31,30,31];
  v_entidades_validas text[] := array[
    'AS','BC','BS','CC','CS','CH','CL','CM','DF','DG','GT','GR','HG','JC',
    'MC','MN','MS','NT','NL','OC','PL','QO','QR','SP','SL','SR','TC','TS',
    'TL','VZ','YN','ZS','NE'
  ];
  v_bloque_fecha text;
  v_mes integer;
  v_dia integer;
  v_sexo text;
  v_entidad text;
begin
  if p_curp is null then
    return false;
  end if;

  -- 1. Longitud exacta.
  if length(p_curp) <> 18 then
    return false;
  end if;

  -- 2. Posiciones 1-4 (iniciales).
  if p_curp !~ '^[A-Z][AEIOUX][A-Z]{2}' then
    return false;
  end if;

  -- 3. Posiciones 5-10 (fecha codificada) — 6 dígitos.
  v_bloque_fecha := substring(p_curp from 5 for 6);
  if v_bloque_fecha !~ '^[0-9]{6}$' then
    return false;
  end if;

  -- 4-5. Mes/día codificados — mismo criterio "29 de febrero siempre
  -- permitido" que la versión TypeScript, por la misma razón (sin siglo
  -- completo, nunca se sabe con certeza si el año era bisiesto).
  v_mes := substring(v_bloque_fecha from 3 for 2)::integer;
  if v_mes < 1 or v_mes > 12 then
    return false;
  end if;
  v_dia := substring(v_bloque_fecha from 5 for 2)::integer;
  if v_dia < 1 or v_dia > v_dias_por_mes[v_mes] then
    return false;
  end if;

  -- 6. Posición 11 (sexo codificado).
  v_sexo := substring(p_curp from 11 for 1);
  if v_sexo <> 'H' and v_sexo <> 'M' then
    return false;
  end if;

  -- 7. Posiciones 12-13 (entidad federativa codificada).
  v_entidad := substring(p_curp from 12 for 2);
  if not (v_entidad = any(v_entidades_validas)) then
    return false;
  end if;

  -- 8. Posiciones 14-16 (consonantes internas).
  if substring(p_curp from 14 for 3) !~ '^[B-DF-HJ-NP-TV-Z]{3}$' then
    return false;
  end if;

  -- 9. Posición 17 (diferenciador/homoclave).
  if substring(p_curp from 17 for 1) !~ '^[A-Z0-9]$' then
    return false;
  end if;

  -- 10. Posición 18 (dígito verificador) — solo se exige que sea un
  -- dígito, nunca se recalcula el algoritmo real de verificación.
  if substring(p_curp from 18 for 1) !~ '^[0-9]$' then
    return false;
  end if;

  return true;
end;
$$;

-- Privilegios del helper — mismo hardening ya aplicado en el resto del
-- proyecto: PostgreSQL concede EXECUTE sobre funciones nuevas a PUBLIC
-- por defecto, y este proyecto además tiene una regla ALTER DEFAULT
-- PRIVILEGES a nivel del esquema public que concede EXECUTE directo a
-- anon/authenticated (no vía PUBLIC) — se revocan ambos caminos
-- explícitamente. `authenticated` SÍ necesita EXECUTE aquí: la RPC
-- reparar_curp_desde_lista_oficial es SECURITY INVOKER, así que su
-- cuerpo se ejecuta con los privilegios del docente que llama — una
-- llamada anidada a este helper desde esa RPC se evalúa con los
-- privilegios reales del invocador, no con los del dueño de la función
-- (eso solo ocurriría con SECURITY DEFINER). Sin este GRANT, la RPC
-- fallaría en tiempo de ejecución para cualquier docente real.
revoke execute on function public.validar_estructura_curp_sql(text) from public;
revoke execute on function public.validar_estructura_curp_sql(text) from anon;
grant execute on function public.validar_estructura_curp_sql(text) to authenticated;

-- ============================================================
-- B) RPC — reparar_curp_desde_lista_oficial
-- ============================================================
--
-- Único camino de escritura de esta fase. Recibe una propuesta YA
-- identificada por la capa de solo lectura (V1-B + capa de propuestas,
-- origenMatch='nombre'|'formato' — nunca 'curp' ni 'fuzzy' como vía de
-- reparación) y la revalida POR COMPLETO desde cero: nunca confía en
-- que el cliente (ni siquiera el propio endpoint Next.js) le mande un
-- dato ya verificado. No repite matching aproximado de ningún tipo —
-- identidad ya resuelta, aquí solo se revalida propiedad/estado/CURP.
--
-- SECURITY INVOKER deliberado (nunca DEFINER): la policy RLS ya
-- existente de `alumnos` ("Docentes ven sus alumnos", FOR ALL,
-- docente_id=auth.uid()) ya autoriza al propio dueño a hacer UPDATE de
-- su propia fila, y la policy de INSERT de `correcciones_alumno` ya
-- autoriza exactamente la escritura de auditoría que esta función
-- necesita (docente_id=auth.uid() + EXISTS real de que el alumno le
-- pertenece) — no hace falta escapar RLS. Mismo razonamiento ya
-- aplicado y aprobado en eliminar_alumno_definitivamente esta sesión.
--
-- CAS (compare-and-set) sobre el valor RAW, nunca sobre una versión
-- normalizada — ver "PRECISIÓN 1" del diseño aprobado: la fila se
-- bloquea con SELECT...FOR UPDATE, se conserva su curp EXACTAMENTE como
-- está almacenado, y la comparación contra p_curp_esperada_actual (el
-- valor que la vista previa mostró al docente, también sin transformar)
-- usa IS NOT DISTINCT FROM — null-safe, sin normalizar ninguno de los
-- dos lados. Recién después de superar ese CAS se derivan copias
-- normalizadas (trim+mayúsculas) exclusivamente para las reglas de
-- estructura — esas copias normalizadas NUNCA participan en el CAS ni
-- en el WHERE del UPDATE final, evitando exactamente el bug descrito en
-- el diseño (normalizar expected y comparar contra un valor RAW
-- distinto en la base).
--
-- Advisory lock transaccional (pg_advisory_xact_lock) sobre la CURP
-- NUEVA normalizada, tomado ANTES del SELECT de duplicado — serializa
-- intentos concurrentes de asignar la MISMA CURP nueva a distintos
-- alumnos. Se libera automáticamente al terminar la transacción (commit
-- o rollback), sin necesitar liberación manual. Se usa
-- hashtextextended(text, bigint) — variante de 64 bits de hashtext,
-- disponible en las versiones de PostgreSQL soportadas por Supabase —
-- para minimizar el riesgo (ya de por sí solo teórico: una colisión de
-- hash aquí nunca compromete integridad, en el peor caso solo
-- bloquearía de más a dos CURPs distintas que colisionaran) frente a
-- hashtext() de 32 bits.
--
-- *** GARANTÍA REAL DE NO-DUPLICADOS — LÍMITE EXPLÍCITO ***
-- Este advisory lock protege ÚNICAMENTE las carreras ENTRE llamadas a
-- ESTA MISMA función. NO sustituye un UNIQUE real en base de datos (que
-- no existe hoy sobre alumnos.curp — confirmado en auditoría previa) y
-- NO protege contra escrituras concurrentes por OTRO camino que no tome
-- este mismo lock. En particular, aplicarCorreccionAlumno (el corrector
-- manual usado por el Chat IA, en lib/motorContexto.ts) puede escribir
-- alumnos.curp hoy sin verificar duplicados en absoluto y sin tomar
-- ningún advisory lock — sigue siendo una deuda técnica separada,
-- documentada y deliberadamente NO resuelta en esta fase (no se
-- modifica aplicarCorreccionAlumno aquí). La única garantía verdaderamente
-- absoluta de unicidad requeriría un UNIQUE real en base de datos, fuera
-- de alcance de esta migración.
--
-- Categorías de error ESTABLES, sin PII (nunca nombres/CURPs/ids en el
-- mensaje) — pensadas para que el futuro endpoint las mapee a texto de
-- UI seguro mediante un switch/comparación exacta de mensaje:
--   AUTH_REQUIRED             — auth.uid() nulo.
--   STUDENT_NOT_AUTHORIZED    — alumno inexistente O no pertenece al
--                                docente que llama (mismo mensaje para
--                                ambos casos, deliberado: nunca revelar
--                                cuál de los dos ocurrió).
--   GROUP_NOT_AUTHORIZED      — el grupo no pertenece al docente, O el
--                                alumno no tiene una inscripción activa
--                                en ESE grupo específico (mismo mensaje
--                                para ambos casos, mismo criterio).
--   STALE_CURRENT_VALUE       — la CURP real actual ya no coincide con
--                                p_curp_esperada_actual (alguien más ya
--                                la cambió, o la propuesta quedó vieja).
--   CURRENT_CURP_NOT_REPAIRABLE — la CURP real actual SÍ coincide con la
--                                esperada, pero ya es estructuralmente
--                                válida (ya no aplica esta reparación),
--                                O es NULL (pertenece conceptualmente a
--                                CURP_FALTANTE_EN_DB, un flujo distinto,
--                                fuera de este alcance — nunca se amplía
--                                silenciosamente esta operación para
--                                cubrirlo).
--   NEW_CURP_INVALID          — la CURP propuesta no pasa
--                                validar_estructura_curp_sql.
--   NEW_CURP_DUPLICATE        — la CURP propuesta ya pertenece a otro
--                                alumno de la misma institución.
--
-- Múltiples inscripciones activas simultáneas del mismo alumno en el
-- mismo grupo (anomalía de datos ajena a esta operación): el EXISTS de
-- validación de grupo solo exige >=1 fila calificada — no se intenta
-- detectar ni corregir esa anomalía aquí, deliberadamente fuera de
-- alcance.

create function public.reparar_curp_desde_lista_oficial(
  p_alumno_id uuid,
  p_grupo_id uuid,
  p_curp_esperada_actual text,
  p_curp_nueva text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
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
  perform pg_advisory_xact_lock(hashtextextended(v_curp_nueva_norm, 0::bigint));

  -- 11. Duplicado institucional — case-insensitive, excluye al propio
  -- alumno, mismo criterio ya usado en importar_alumnos_a_grupo.
  select exists (
    select 1
    from public.alumnos a2
    where a2.id <> v_alumno_id
      and a2.institucion_id = v_institucion_id
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
$$;

-- Privilegios de la RPC — mismo hardening ya aplicado en el resto del
-- proyecto.
revoke execute on function public.reparar_curp_desde_lista_oficial(uuid, uuid, text, text) from public;
revoke execute on function public.reparar_curp_desde_lista_oficial(uuid, uuid, text, text) from anon;
grant execute on function public.reparar_curp_desde_lista_oficial(uuid, uuid, text, text) to authenticated;
