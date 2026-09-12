-- Corrección aislada de privilegios sobre MG-B1
-- (20260912180000_snapshot_grupo_conversaciones.sql) — NO modifica esa
-- migración, que ya forma parte del historial remoto aplicado y queda
-- inmutable. Este es un ajuste posterior y separado.
--
-- Hallazgo confirmado en la validación post-migración de MG-B1 (lectura
-- directa de pg_proc.proacl / pg_default_acl): este proyecto Supabase
-- tiene una regla ALTER DEFAULT PRIVILEGES a nivel del esquema public
-- que concede EXECUTE sobre TODA función nueva directamente a los
-- roles anon/authenticated/service_role/postgres — no a través del
-- pseudo-rol PUBLIC. Por eso el `revoke execute ... from public` de
-- MG-B1 no tuvo ningún efecto sobre `anon` (nunca tuvo el privilegio
-- vía PUBLIC; lo tiene por un grant directo, independiente).
--
-- Riesgo funcional real: NINGUNO — la función ya retorna de inmediato
-- sin tocar ninguna fila cuando auth.uid() es null (ver su propio
-- guard "fail-safe"), así que una llamada de `anon` siempre fue un
-- no-op. Este cambio cierra el acceso también de forma estructural,
-- como ya se hace con PUBLIC.
--
-- `authenticated` conserva su EXECUTE existente — no se toca aquí.
--
-- Deliberadamente NO se modifican los default privileges globales del
-- esquema public (ALTER DEFAULT PRIVILEGES): esta migración corrige
-- únicamente el grant ya existente sobre ESTA función, no el
-- comportamiento futuro de funciones nuevas — eso queda fuera de
-- alcance de esta fase.
revoke execute
  on function public.fijar_grupo_conversacion(uuid)
  from anon;
