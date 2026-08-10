-- Ver "Auditoría Fase 0 — hallazgo urgente: calendario_eventos e
-- instituciones legibles sin sesión". Ambas políticas ya tenían RLS
-- habilitado (rowsecurity=true) — el hueco era el rol de la política
-- SELECT (`public`, que incluye anon), no la lógica de la condición.
-- Corrección mínima autorizada: cambiar el rol de `public` a
-- `authenticated`, sin tocar la condición interna de cada política.
-- Verificado contra el código real (grep) que ningún caller consulta
-- estas tablas antes de autenticarse — no hay regresión funcional.

alter policy "Ver eventos propios y SEP"
  on public.calendario_eventos
  to authenticated;

alter policy "docentes pueden ver instituciones"
  on public.instituciones
  to authenticated;
