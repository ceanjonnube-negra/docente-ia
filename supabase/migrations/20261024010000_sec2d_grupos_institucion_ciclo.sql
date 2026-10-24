-- SEC-2D — grupos: solo en instituciones del docente y con un ciclo de esa
-- misma institución; ciclos visibles en todas las escuelas del docente.
--
-- Causa: la única política de grupos era `ALL` con `docente_id = auth.uid()`
-- y anon/authenticated tenían todos los privilegios de tabla. Un docente
-- podía crear o mover sus grupos a cualquier institución, asociarlos a un
-- ciclo de otra escuela y apuntar grupo_anterior_id a un grupo ajeno. Además,
-- la política de ciclos_escolares solo miraba la institución principal del
-- perfil, así que las escuelas adicionales (docente_instituciones) quedaban
-- inutilizables: sin ciclos visibles no se podía crear ni ver un grupo ahí.
--
-- Corrección mínima (sin código nuevo, sin funciones nuevas):
--   1. Integridad: el ciclo del grupo debe pertenecer a la misma institución
--      (FK compuesta). Las FK no dependen de RLS, así que también obligan a
--      service_role y a las funciones SECURITY DEFINER. La FK compuesta
--      sustituye a grupos_ciclo_escolar_id_fkey: con ambas columnas NOT NULL
--      también garantiza que el ciclo exista, y conservar las dos haría
--      ambiguo el embebido de PostgREST `ciclos_escolares!inner(...)` que usan
--      Lista, Evaluación y la sesión del Chat IA (error PGRST201).
--   2. Políticas de grupos separadas por operación. El INSERT exige que la
--      institución sea la principal del docente o una de sus vínculos (ambas
--      fuentes las escribe solo la administración desde SEC-2B y SEC-2C).
--      UPDATE no exige membresía: un cambio de institución hecho por la
--      administración no impide editar los grupos anteriores.
--   3. Privilegios por columna (nombre_grupo es generada y no se escribe):
--      authenticated no puede escribir id,
--      docente_id, institucion_id, ciclo_escolar_id, creado_en ni
--      grupo_anterior_id en UPDATE, ni grupo_anterior_id en INSERT, así que
--      un grupo no puede trasladarse ni enlazarse a uno ajeno. Los valores
--      históricos de grupo_anterior_id no se tocan. anon queda sin
--      privilegios: sin sesión no hay grupos propios.
--   4. ciclos_escolares: SELECT de los ciclos de la institución principal y
--      de las instituciones vinculadas.
--
-- Los datos existentes no cambian y ya cumplen la nueva restricción.

alter table public.ciclos_escolares
  add constraint ciclos_escolares_id_institucion_key unique (id, institucion_id);

alter table public.grupos
  add constraint grupos_ciclo_misma_institucion_fkey
  foreign key (ciclo_escolar_id, institucion_id)
  references public.ciclos_escolares (id, institucion_id) not valid;
alter table public.grupos validate constraint grupos_ciclo_misma_institucion_fkey;
alter table public.grupos drop constraint grupos_ciclo_escolar_id_fkey;

drop policy "docentes gestionan sus propios grupos" on public.grupos;

create policy grupos_select_propio on public.grupos
  for select to authenticated
  using (docente_id = auth.uid());

create policy grupos_insert_institucion_propia on public.grupos
  for insert to authenticated
  with check (
    docente_id = auth.uid()
    and (
      exists (select 1 from public.perfiles_docentes p
              where p.id = auth.uid() and p.institucion_id = grupos.institucion_id)
      or exists (select 1 from public.docente_instituciones d
                 where d.docente_id = auth.uid() and d.institucion_id = grupos.institucion_id)
    )
  );

create policy grupos_update_propio on public.grupos
  for update to authenticated
  using (docente_id = auth.uid())
  with check (docente_id = auth.uid());

create policy grupos_delete_propio on public.grupos
  for delete to authenticated
  using (docente_id = auth.uid());

revoke all on table public.grupos from anon, authenticated;
grant select, delete on table public.grupos to authenticated;
grant insert (institucion_id, docente_id, ciclo_escolar_id, nivel_educativo, grado, grupo, campo_formativo_principal)
  on table public.grupos to authenticated;
grant update (grado, grupo, nivel_educativo, campo_formativo_principal, activo)
  on table public.grupos to authenticated;

drop policy "docentes ven ciclos de su institucion" on public.ciclos_escolares;

create policy "docentes ven ciclos de su institucion" on public.ciclos_escolares
  for select to authenticated
  using (
    institucion_id in (select p.institucion_id from public.perfiles_docentes p where p.id = auth.uid())
    or institucion_id in (select d.institucion_id from public.docente_instituciones d where d.docente_id = auth.uid())
  );
