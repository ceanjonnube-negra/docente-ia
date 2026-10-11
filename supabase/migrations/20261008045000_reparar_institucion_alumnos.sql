-- V1-D2C1-B4D2 (reparación previa) — Reparación del dato real
-- alumnos.institucion_id = NULL para los 28 alumnos cuya institución
-- está determinada INEQUÍVOCAMENTE por sus inscripciones → grupos.
--
-- CAUSA (ver diagnóstico aprobado): la ruta ya eliminada
-- app/api/asistencia-foto/route.ts (retirada en d8d1d3a, 2026-07-19)
-- hacía upsert en `alumnos` con { nombre, docente_id, grupo_id } y
-- NUNCA enviaba institucion_id. Los 28 alumnos se crearon en un solo
-- lote (2026-07-14 00:08:59–00:09:01 UTC), 90 s después de e0198db.
-- Las vías de alta actuales (importar_alumnos_a_grupo,
-- alta_persona_con_inscripcion) ya derivan institucion_id del grupo.
-- La prevención estructural (CHECK/NOT NULL, permisos) queda para una
-- fase independiente — esta migración NO cambia el esquema.
--
-- ALCANCE EXACTO (mismo patrón de precondición exacta e IDs fijos que
-- 20260921000000_reparar_nivel_educativo_grupo.sql):
--   - Escribe ÚNICAMENTE alumnos.institucion_id, ÚNICAMENTE en los 28
--     ids listados en c_ids, ÚNICAMENTE si siguen en NULL.
--   - 0 INSERT, 0 DELETE, 0 DDL, 0 escritura en inscripciones, grupos
--     ni en ninguna tabla de historial.
--   - El alumno sin inscripciones ni grupo (c_excluido) queda
--     EXPRESAMENTE fuera: nunca se escribe, conserva institucion_id
--     NULL. No se infiere su institución por nombre, CURP, semejanza
--     ni pertenencia probable del docente.
--   - La institución NUNCA se toma de c_institucion: se DERIVA de
--     inscripciones → grupos para cada alumno, y c_institucion solo se
--     usa como comprobación cruzada del valor derivado.
--
-- VALIDACIONES PREVIAS (cualquier fallo aborta sin escribir nada):
--   A. Institución inequívoca: el alumno tiene ≥1 inscripción y TODOS
--      los grupos de sus inscripciones pertenecen a UNA sola
--      institución, igual a la esperada.
--   B. Grupo legado (alumnos.grupo_id), cuando existe: coincide en
--      institución Y en docente propietario (grupos.docente_id =
--      alumnos.docente_id).
--   C. Todos los grupos de sus inscripciones son del docente del
--      alumno (grupos.docente_id = alumnos.docente_id), y ese docente
--      es el esperado.
--   D. Cualquier otra ambigüedad aborta: alumno esperado inexistente,
--      con otra institución ya asignada, mezcla de estados
--      (reparados/pendientes), alumno NULL inesperado fuera de la lista,
--      o alumno excluido que haya adquirido una relación verificable.
--   E. 0 CURP duplicadas (upper(trim(curp))) dentro de la institución
--      resultante.
--
-- IDEMPOTENCIA Y DERIVA:
--   - Primera ejecución: los 28 en NULL → valida → actualiza los 28.
--   - Segunda ejecución: los 28 ya con la institución esperada → NO
--     escribe nada, pero NO se da por buena automáticamente: vuelve a
--     ejecutar las comprobaciones de deriva (D, E y coherencia); si
--     aparecieron registros inconsistentes nuevos, aborta.
--   - Cualquier estado intermedio o distinto (p. ej. 27 reparados + 1
--     pendiente, o un alumno de la lista con otra institución) aborta.
--   - Nota: en una base sin estos datos (p. ej. `supabase db reset`
--     local) la precondición falla y la migración aborta — mismo
--     comportamiento deliberado que reparar_nivel_educativo_grupo.
--
-- ATOMICIDAD: todo ocurre en UN solo bloque DO (una sola sentencia,
-- una sola transacción): cualquier `raise exception` revierte el UPDATE.
--
-- BLOQUEOS (mínimos suficientes, en este orden fijo):
--   - lock_timeout local de 5 s: si hay escrituras en curso, la
--     migración falla limpiamente en vez de quedarse esperando.
--   - alumnos: SHARE ROW EXCLUSIVE — bloquea INSERT/UPDATE/DELETE
--     concurrentes (y una segunda ejecución simultánea de esta misma
--     reparación) durante la validación y el UPDATE; NO bloquea SELECT
--     ni las lecturas de la aplicación.
--   - grupos, inscripciones: SHARE — impide que cambien las relaciones
--     usadas para inferir mientras se valida; NO bloquea lecturas.
--   Duración esperada: milisegundos (29 alumnos, 56 inscripciones).
--
-- VERIFICACIONES POSTERIORES (cualquier fallo revierte todo):
--   - Exactamente 28 filas actualizadas.
--   - Huella (md5) de TODAS las filas de inscripciones idéntica antes y
--     después.
--   - Huella (md5) de TODAS las filas de alumnos SIN la columna
--     institucion_id idéntica antes y después (ningún id, docente_id,
--     nombre, curp ni otro campo cambió; ninguna fila apareció ni
--     desapareció).
--   - Los 28 quedan con la institución esperada y coherentes con TODOS
--     los grupos de sus inscripciones.
--   - El único alumno que puede seguir en NULL es c_excluido.

do $$
declare
  c_institucion constant uuid := 'd725bde7-2952-41b0-ba4b-44ee6d8c31a4';
  c_docente constant uuid := 'c247d36f-2ecd-4896-ab16-253a92569611';
  c_excluido constant uuid := 'b13b45fc-0ddd-4a78-b188-0ce1342d0bdf';
  c_esperados constant integer := 28;
  c_ids constant uuid[] := array[
    '2379a369-936f-4c5a-9cc9-7f486f5e8785',
    '26a4b862-f6b5-43bc-8016-c59188dc13c2',
    '2ac8c631-2e61-4daa-8909-b674c4f693cb',
    '318edd0a-e5cb-461b-b64a-1ec83ded7086',
    '3714ca11-e047-4cce-a884-2b9e906d606f',
    '40de36d7-d049-48dc-8d16-47bebbc809af',
    '44306567-4a9f-40db-83d6-6cf964f246cb',
    '49882e14-9c30-491d-8a4e-256689661636',
    '4b6499aa-970a-4cbc-8f43-e0872fe81219',
    '5ce7569a-22e2-4633-8efb-2cc53247aea5',
    '6656f3fa-2bcd-43a1-8dc6-464e9885d0df',
    '77d8e3ba-01e0-4cdb-9a3b-7d781229957b',
    '7be3a4e7-4897-44d8-8f9d-eecc39ac2910',
    '961de99d-5129-4792-a096-c8b6d02a7570',
    '9ab152b9-7315-43de-aa6b-cb2cc9e1ddaa',
    'b33022a4-7189-4d97-a991-017dc2e11ace',
    'bf3b87d4-ed12-4b2b-944c-4a4ebea2449c',
    'c32b06ca-fe3b-436f-ad00-38cc199d188b',
    'c6a2f669-8a70-4c5b-8340-53c91814a261',
    'c7b03622-dec8-4bb4-85c1-19d6647c90ae',
    'd109f724-b736-4566-9338-3696c7feac01',
    'd8dcb807-a5ee-4795-b6fd-7be758f67c3f',
    'd9b0fe7a-f1c4-4bd4-bec5-c954aedc8485',
    'dd416e8e-992e-49f5-821f-65861cfd0a57',
    'df6e5339-4c08-4659-96d9-57cbe6848ae2',
    'e0808357-204d-4266-b154-7a0045ef1ed3',
    'e3e32fe6-e135-4d30-af5a-d85bc7fbb2d5',
    'ec16cb06-e3b5-4299-aa2e-7e9698d314a6'
  ]::uuid[];

  v_id uuid;
  v_docente_alumno uuid;
  v_institucion_actual uuid;
  v_grupo_legado uuid;
  v_inst_legado uuid;
  v_docente_legado uuid;
  v_n_inscripciones integer;
  v_n_instituciones integer;
  v_institucion_inferida uuid;
  v_grupos_del_docente boolean;
  v_pendientes integer := 0;
  v_reparados integer := 0;
  v_n integer;
  v_actualizados integer;
  v_huella_inscripciones_antes text;
  v_huella_inscripciones_despues text;
  v_huella_alumnos_antes text;
  v_huella_alumnos_despues text;
begin
  -- ============================================================
  -- 0. Integridad de las constantes.
  -- ============================================================
  if cardinality(c_ids) <> c_esperados
     or (select count(distinct x) from unnest(c_ids) x) <> c_esperados then
    raise exception 'PRECONDICION_FALLIDA: la lista de candidatos no contiene % ids distintos.', c_esperados;
  end if;
  if c_excluido = any(c_ids) then
    raise exception 'PRECONDICION_FALLIDA: el alumno excluido aparece en la lista de candidatos.';
  end if;

  -- ============================================================
  -- 1. Bloqueos — orden fijo, con tiempo de espera acotado.
  -- ============================================================
  perform set_config('lock_timeout', '5s', true);
  lock table public.alumnos in share row exclusive mode;
  lock table public.grupos in share mode;
  lock table public.inscripciones in share mode;

  -- Huellas previas (para verificar después que solo cambió
  -- alumnos.institucion_id).
  select md5(coalesce(string_agg(to_jsonb(i)::text, '|' order by i.id), ''))
    into v_huella_inscripciones_antes
  from public.inscripciones i;

  select md5(coalesce(string_agg((to_jsonb(a) - 'institucion_id')::text, '|' order by a.id), ''))
    into v_huella_alumnos_antes
  from public.alumnos a;

  -- ============================================================
  -- 2. Validación por alumno candidato (A, B, C, D).
  -- ============================================================
  foreach v_id in array c_ids
  loop
    select a.docente_id, a.institucion_id, a.grupo_id
      into v_docente_alumno, v_institucion_actual, v_grupo_legado
    from public.alumnos a
    where a.id = v_id;

    if not found then
      raise exception 'PRECONDICION_FALLIDA: el alumno esperado % no existe.', v_id;
    end if;

    -- C (docente esperado).
    if v_docente_alumno <> c_docente then
      raise exception 'PRECONDICION_FALLIDA: el alumno % no pertenece al docente esperado.', v_id;
    end if;

    -- A + C: institución inferida EXCLUSIVAMENTE vía inscripciones → grupos.
    select count(*),
           count(distinct g.institucion_id),
           min(g.institucion_id::text)::uuid,
           coalesce(bool_and(g.docente_id = v_docente_alumno), false)
      into v_n_inscripciones, v_n_instituciones, v_institucion_inferida, v_grupos_del_docente
    from public.inscripciones i
    join public.grupos g on g.id = i.grupo_id
    where i.alumno_id = v_id;

    if v_n_inscripciones = 0 then
      raise exception 'PRECONDICION_FALLIDA: el alumno % no tiene inscripciones — institución no verificable.', v_id;
    end if;
    if v_n_instituciones <> 1 then
      raise exception 'PRECONDICION_FALLIDA: el alumno % tiene grupos de % instituciones distintas.', v_id, v_n_instituciones;
    end if;
    if v_institucion_inferida <> c_institucion then
      raise exception 'PRECONDICION_FALLIDA: la institución inferida del alumno % no es la esperada.', v_id;
    end if;
    if not v_grupos_del_docente then
      raise exception 'PRECONDICION_FALLIDA: el alumno % tiene inscripciones en grupos de otro docente.', v_id;
    end if;

    -- B: grupo legado, cuando existe — institución Y docente.
    if v_grupo_legado is not null then
      select g.institucion_id, g.docente_id
        into v_inst_legado, v_docente_legado
      from public.grupos g
      where g.id = v_grupo_legado;

      if not found then
        raise exception 'PRECONDICION_FALLIDA: el grupo legado del alumno % no existe.', v_id;
      end if;
      if v_inst_legado <> v_institucion_inferida then
        raise exception 'PRECONDICION_FALLIDA: el grupo legado del alumno % es de otra institución.', v_id;
      end if;
      if v_docente_legado <> v_docente_alumno then
        raise exception 'PRECONDICION_FALLIDA: el grupo legado del alumno % es de otro docente.', v_id;
      end if;
    end if;

    -- D: estado del alumno — pendiente (NULL) o ya reparado (esperada).
    if v_institucion_actual is null then
      v_pendientes := v_pendientes + 1;
    elsif v_institucion_actual = c_institucion then
      v_reparados := v_reparados + 1;
    else
      raise exception 'PRECONDICION_FALLIDA: el alumno % ya tiene otra institución asignada.', v_id;
    end if;
  end loop;

  -- D: solo dos estados globales válidos — todo pendiente o todo reparado.
  if not ((v_pendientes = c_esperados and v_reparados = 0)
          or (v_pendientes = 0 and v_reparados = c_esperados)) then
    raise exception 'PRECONDICION_FALLIDA: estado mixto (% pendientes, % reparados) — requiere revisión.', v_pendientes, v_reparados;
  end if;

  -- ============================================================
  -- 3. Deriva fuera de la lista (D, H).
  -- ============================================================
  -- Ningún otro alumno puede tener institucion_id NULL salvo el
  -- excluido.
  select count(*) into v_n
  from public.alumnos a
  where a.institucion_id is null
    and a.id <> all(c_ids)
    and a.id <> c_excluido;
  if v_n > 0 then
    raise exception 'PRECONDICION_FALLIDA: % alumno(s) con institucion_id NULL fuera de la lista revisada.', v_n;
  end if;

  -- El excluido, si sigue en NULL, debe seguir sin relación
  -- verificable (si la adquirió, requiere una revisión nueva, nunca
  -- una reparación automática).
  select count(*) into v_n
  from public.alumnos a
  where a.id = c_excluido
    and a.institucion_id is null
    and (a.grupo_id is not null
         or exists (select 1 from public.inscripciones i where i.alumno_id = a.id));
  if v_n > 0 then
    raise exception 'PRECONDICION_FALLIDA: el alumno excluido adquirió una relación verificable — requiere revisión.';
  end if;

  -- ============================================================
  -- 4. E: 0 CURP duplicadas (upper(trim)) en la institución resultante.
  -- ============================================================
  select count(*) into v_n
  from (
    select upper(trim(a.curp))
    from public.alumnos a
    where (a.institucion_id = c_institucion
           or (a.institucion_id is null and a.id = any(c_ids)))
      and a.curp is not null
      and trim(a.curp) <> ''
    group by 1
    having count(*) > 1
  ) d;
  if v_n > 0 then
    raise exception 'PRECONDICION_FALLIDA: % CURP duplicada(s) en la institución resultante.', v_n;
  end if;

  -- ============================================================
  -- 5. Segunda ejecución: todo ya reparado y sin deriva → sin cambios.
  -- ============================================================
  if v_reparados = c_esperados then
    raise notice 'Reparación ya aplicada: 0 filas modificadas (comprobaciones de deriva superadas).';
    return;
  end if;

  -- ============================================================
  -- 6. ÚNICA escritura (F): solo alumnos.institucion_id.
  -- ============================================================
  update public.alumnos a
  set institucion_id = c_institucion
  where a.id = any(c_ids)
    and a.institucion_id is null
    and a.docente_id = c_docente;

  get diagnostics v_actualizados = row_count;
  if v_actualizados <> c_esperados then
    raise exception 'REPARACION_INESPERADA: se esperaban % filas actualizadas y fueron %.', c_esperados, v_actualizados;
  end if;

  -- ============================================================
  -- 7. Verificaciones posteriores.
  -- ============================================================
  select md5(coalesce(string_agg(to_jsonb(i)::text, '|' order by i.id), ''))
    into v_huella_inscripciones_despues
  from public.inscripciones i;
  if v_huella_inscripciones_despues <> v_huella_inscripciones_antes then
    raise exception 'POST_REPARACION_FALLIDA: inscripciones cambió.';
  end if;

  select md5(coalesce(string_agg((to_jsonb(a) - 'institucion_id')::text, '|' order by a.id), ''))
    into v_huella_alumnos_despues
  from public.alumnos a;
  if v_huella_alumnos_despues <> v_huella_alumnos_antes then
    raise exception 'POST_REPARACION_FALLIDA: cambió algo distinto de alumnos.institucion_id.';
  end if;

  select count(*) into v_n
  from public.alumnos a
  where a.id = any(c_ids)
    and a.institucion_id is distinct from c_institucion;
  if v_n > 0 then
    raise exception 'POST_REPARACION_FALLIDA: % candidato(s) sin la institución esperada.', v_n;
  end if;

  select count(*) into v_n
  from public.alumnos a
  join public.inscripciones i on i.alumno_id = a.id
  join public.grupos g on g.id = i.grupo_id
  where a.id = any(c_ids)
    and g.institucion_id <> a.institucion_id;
  if v_n > 0 then
    raise exception 'POST_REPARACION_FALLIDA: % inscripción(es) incoherentes con la institución reparada.', v_n;
  end if;

  select count(*) into v_n
  from public.alumnos a
  where a.institucion_id is null
    and a.id <> c_excluido;
  if v_n > 0 then
    raise exception 'POST_REPARACION_FALLIDA: % alumno(s) siguen en NULL además del excluido.', v_n;
  end if;

  raise notice 'Reparación aplicada: % alumnos con institucion_id asignado.', v_actualizados;
end;
$$;
