-- SEC-2E2 — calendario_eventos: un docente no puede publicar eventos
-- como oficiales de la SEP.
--
-- Causa: la política INSERT solo exige `auth.uid() = user_id`, así que un
-- docente podía insertar un evento propio con es_sep = true; la política
-- SELECT muestra a todos los docentes cualquier fila con es_sep = true, de
-- modo que ese evento aparecía como oficial en el calendario de toda la
-- plataforma (app/dashboard/calendario) y en el contexto del Programa
-- analítico (lib/programaAnalitico/contextoInterno.ts).
--
-- Los eventos oficiales legítimos tienen es_sep = true y user_id nulo y
-- solo los crea la administración (ninguna política admite user_id nulo).
--
-- Corrección mínima, solo RLS (sin funciones, triggers ni código nuevo):
--   1. INSERT: además de ser propio, el evento debe tener es_sep = false.
--      El código ya envía siempre es_sep: false (calendario y
--      aplicarCorreccionesCalendario), por eso no se restringe la columna
--      por privilegios: un INSERT con es_sep: false explícito seguiría
--      necesitando el privilegio.
--   2. SELECT: solo se comparten los eventos oficiales (es_sep = true y
--      user_id nulo), el mismo criterio que usa motorContexto. Un evento
--      con es_sep = true creado antes de esta corrección por un docente
--      deja de verse en las cuentas de los demás; su dueño lo sigue viendo
--      y puede eliminarlo.
--
-- UPDATE no tiene política, así que RLS impide cualquier modificación y
-- nadie puede convertir un evento en oficial. DELETE solo admite eventos
-- propios, nunca los oficiales (user_id nulo). Los datos no cambian.

alter policy "Insertar eventos propios" on public.calendario_eventos
  with check (auth.uid() = user_id and es_sep = false);

alter policy "Ver eventos propios y SEP" on public.calendario_eventos
  using (auth.uid() = user_id or (es_sep = true and user_id is null));
