-- SEC-2B — docente_instituciones: el docente solo puede leer sus vínculos.
--
-- Causa: la única política era `ALL` para {public} con USING y CHECK
-- `docente_id = auth.uid()`, y anon/authenticated tenían todos los
-- privilegios de tabla. Un docente autenticado podía insertarse en
-- cualquier institución, cambiar su rol a 'director' o la institución de
-- su vínculo, y eliminarlo. Ningún flujo de la aplicación escribe en esta
-- tabla (app/dashboard/grupos/nuevo/page.tsx y lib/server/authApi.ts solo
-- leen); los vínculos los crea la administración.
--
-- Corrección mínima, en dos capas independientes:
--   1. Privilegios (mínimo privilegio): retirar a anon y authenticated
--      todos los privilegios de tabla —incluidos REFERENCES, TRIGGER y
--      MAINTAIN (PostgreSQL 17), que la aplicación no usa— y devolver a
--      authenticated únicamente SELECT. anon queda sin privilegios: sin
--      sesión no hay vínculos que leer. Una política permisiva futura no
--      puede reabrir escrituras sin un GRANT explícito.
--   2. RLS: sustituir la política ALL por una de solo SELECT para
--      authenticated, limitada a los vínculos propios.
--
-- service_role (BYPASSRLS) y el dueño conservan sus privilegios para las
-- operaciones administrativas. Los vínculos existentes no cambian.

revoke all on table public.docente_instituciones from anon, authenticated;
grant select on table public.docente_instituciones to authenticated;

drop policy "docentes ven sus propias instituciones" on public.docente_instituciones;

create policy "docentes ven sus propias instituciones"
  on public.docente_instituciones
  for select
  to authenticated
  using (docente_id = auth.uid());
