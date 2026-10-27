-- CAL-1 — calendario_eventos: cada docente puede editar sus actividades
-- propias.
--
-- Causa: la tabla no tenía política UPDATE, así que RLS descartaba toda
-- edición sin error. El botón Editar del calendario
-- (app/dashboard/calendario/page.tsx, actualizarActividad) y las
-- correcciones del Chat IA (lib/motorContexto.ts,
-- aplicarCorreccionesCalendario) afectaban 0 filas y la actividad no
-- cambiaba.
--
-- Corrección mínima (sin código, funciones ni triggers nuevos):
--   1. Política UPDATE para authenticated, solo sobre actividades propias y
--      no oficiales (auth.uid() = user_id y es_sep = false), tanto en la fila
--      original como en la resultante. Los eventos oficiales (user_id nulo) y
--      las actividades de otros docentes quedan fuera.
--   2. Privilegios por columna: authenticated solo puede escribir titulo,
--      fecha, tipo, color y descripcion, las columnas que editan la pantalla
--      y el Chat. id, user_id, es_sep y created_at no se pueden modificar
--      aunque una política futura fuera más amplia.
--
-- anon conserva sus privilegios de tabla, pero ninguna política UPDATE le
-- aplica (se tratará en la reducción general de privilegios). Los datos no
-- cambian.

create policy "Editar eventos propios" on public.calendario_eventos
  for update to authenticated
  using (auth.uid() = user_id and es_sep = false)
  with check (auth.uid() = user_id and es_sep = false);

revoke update on table public.calendario_eventos from authenticated;
grant update (titulo, fecha, tipo, color, descripcion)
  on table public.calendario_eventos to authenticated;
