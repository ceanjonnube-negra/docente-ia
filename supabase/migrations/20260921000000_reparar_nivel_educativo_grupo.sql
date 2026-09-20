-- PA-2C — Reparación del dato real grupos.nivel_educativo=NULL +
-- endurecimiento estructural NOT NULL.
--
-- CONTEXTO (ver informe PA-2C): existe una única fila en `grupos` con
-- nivel_educativo NULL — el grupo 4°B real (id
-- 054a8348-c310-4c3b-8c0e-da450b62a9e5), creado fuera del único flujo
-- de la aplicación que inserta en `grupos`
-- (app/dashboard/grupos/nuevo/page.tsx, que siempre exige
-- nivel_educativo antes de permitir el envío del formulario). Su
-- grupo_anterior_id apunta al grupo 3°B real (nivel_educativo=
-- 'primaria', confirmado), y el único perfil docente real
-- (perfiles_docentes.nivel='primaria') converge en el mismo valor —
-- sin ningún indicio de otro nivel en ningún dato real del proyecto
-- (1 solo docente, 1 sola institución, 0 filas con nivel distinto de
-- 'primaria' en todo el sistema).
--
-- PRECONDICIÓN EXACTA que esta migración exige antes de escribir
-- nada (si no se cumple exactamente, aborta sin tocar ninguna fila):
--   1. existe EXACTAMENTE 1 fila en `grupos` con nivel_educativo IS NULL;
--   2. esa fila es la esperada (id fijo, grado='4');
--   3. su grupo_anterior_id apunta a una fila con nivel_educativo='primaria'.
--
-- Solo repara ESA fila puntual (WHERE por id, no por condición
-- genérica) — no toca ninguna otra fila de `grupos`.
begin;

do $$
declare
  v_null_count integer;
  v_target_id constant uuid := '054a8348-c310-4c3b-8c0e-da450b62a9e5';
  v_grado text;
  v_anterior_nivel text;
begin
  select count(*) into v_null_count from public.grupos where nivel_educativo is null;
  if v_null_count <> 1 then
    raise exception 'PRECONDICION_FALLIDA: se esperaba exactamente 1 fila con nivel_educativo NULL en grupos, se encontraron %', v_null_count;
  end if;

  select grado into v_grado from public.grupos where id = v_target_id and nivel_educativo is null;
  if v_grado is null then
    raise exception 'PRECONDICION_FALLIDA: la fila NULL encontrada no es la esperada (id=%)', v_target_id;
  end if;
  if v_grado <> '4' then
    raise exception 'PRECONDICION_FALLIDA: se esperaba grado=4 en la fila objetivo, se encontró %', v_grado;
  end if;

  select g2.nivel_educativo into v_anterior_nivel
  from public.grupos g1
  join public.grupos g2 on g2.id = g1.grupo_anterior_id
  where g1.id = v_target_id;

  if v_anterior_nivel is distinct from 'primaria' then
    raise exception 'PRECONDICION_FALLIDA: grupo_anterior_id no confirma nivel_educativo=primaria (encontrado %)', v_anterior_nivel;
  end if;
end $$;

do $$
declare
  v_filas_afectadas integer;
begin
  update public.grupos
  set nivel_educativo = 'primaria'
  where id = '054a8348-c310-4c3b-8c0e-da450b62a9e5'
    and nivel_educativo is null
    and grado = '4';

  get diagnostics v_filas_afectadas = row_count;
  if v_filas_afectadas <> 1 then
    raise exception 'REPARACION_INESPERADA: se esperaba actualizar exactamente 1 fila, se actualizaron %', v_filas_afectadas;
  end if;
end $$;

-- Endurecimiento estructural: seguro porque (a) la única fila NULL
-- real ya quedó reparada arriba, en la MISMA transacción, y (b) el
-- único camino de escritura en todo el código actual
-- (app/dashboard/grupos/nuevo/page.tsx) ya exige nivel_educativo antes
-- de insertar — NOT NULL no bloquea ningún flujo existente, solo hace
-- explícita una garantía que el código ya respeta.
do $$
begin
  if (select count(*) from public.grupos where nivel_educativo is null) <> 0 then
    raise exception 'POST_REPARACION_FALLIDA: aún quedan filas con nivel_educativo NULL, no se aplica NOT NULL';
  end if;
end $$;

alter table public.grupos
  alter column nivel_educativo set not null;

-- Resincroniza docente_contexto_activo para que apunte al grupo real
-- actual (4°B) en vez del grupo anterior (3°B) — la semántica
-- confirmada de esta tabla es "último grupo creado/seleccionado por
-- el docente" (se actualiza vía upsert exactamente en
-- app/dashboard/grupos/nuevo/page.tsx al crear un grupo); el 4°B nunca
-- disparó ese upsert por haberse insertado fuera de ese flujo. Solo se
-- toca si la fila real del único docente sigue apuntando exactamente
-- al grupo anterior conocido — si alguien ya la cambió a otra cosa
-- entretanto, no se pisa nada.
update public.docente_contexto_activo
set grupo_id = '054a8348-c310-4c3b-8c0e-da450b62a9e5',
    ciclo_escolar_id = '5bc149fa-a198-4a2b-af94-9f3457f120dd',
    actualizado_en = now()
where docente_id = 'c247d36f-2ecd-4896-ab16-253a92569611'
  and grupo_id = 'cf835154-52cc-4c30-8689-4f39d8b0adbd';

commit;
