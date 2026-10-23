-- SEC-2C — perfiles_docentes: el docente no puede asignarse institución ni rol.
--
-- Causa: anon y authenticated tenían todos los privilegios de tabla y las
-- políticas INSERT/UPDATE solo validan `auth.uid() = id`, así que un docente
-- podía escribir en su perfil cualquier columna: institucion_id (que
-- usuarioPerteneceAInstitucion y la política de ciclos_escolares toman como
-- membresía), rol (p. ej. 'director') y creado_en.
--
-- Corrección mínima, solo de privilegios (políticas, funciones y código sin
-- cambios):
--   1. Retirar a anon y authenticated todos los privilegios de tabla.
--      Un GRANT de tabla prevalece sobre los de columna, por eso se retira
--      primero.
--   2. Devolver a authenticated SELECT de la tabla y INSERT/UPDATE solo en
--      las columnas que el docente puede editar. `id` se incluye porque el
--      upsert del onboarding (app/onboarding/page.tsx) se traduce en
--      INSERT … ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id, …; la RLS
--      (`auth.uid() = id`) impide que cambie a otro valor.
--
-- institucion_id, rol y creado_en quedan fuera: solo los gestiona la
-- administración (service_role, BYPASSRLS, y el dueño conservan todos sus
-- privilegios). Los perfiles existentes no cambian.

revoke all on table public.perfiles_docentes from anon, authenticated;

grant select on table public.perfiles_docentes to authenticated;

grant insert (id, nombre, escuela, nivel, grado, grupo, zona, municipio, estado)
  on table public.perfiles_docentes to authenticated;

grant update (id, nombre, escuela, nivel, grado, grupo, zona, municipio, estado)
  on table public.perfiles_docentes to authenticated;
