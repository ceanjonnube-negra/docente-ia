-- ============================================================
-- Migración: otorgar UPDATE (planeacion_activa) a authenticated
-- (C-005 — arquitectura de planeación activa, corrección de Fase 2).
--
-- Causa real demostrada (ver diagnóstico read-only previo): la
-- migración 20260914000000_agregar_planeacion_activa_conversaciones_chat.sql
-- agregó la columna planeacion_activa, pero los GRANT de esta tabla
-- están definidos por columna (no por tabla completa) para el rol
-- authenticated — una columna nueva NUNCA hereda automáticamente el
-- UPDATE que sí tienen las columnas originales (documento_activo,
-- material_visual_activo, titulo). RLS ya estaba correctamente
-- configurado desde el inicio (política conversaciones_chat_update_propio,
-- docente_id = auth.uid()) y NUNCA fue la causa — GRANT y RLS son dos
-- capas de autorización independientes, y esta migración corrige
-- exclusivamente la que faltaba.
--
-- 100% ADITIVA y MÍNIMA: un solo GRANT, columna específica, rol
-- específico. No toca RLS, no toca ninguna policy, no otorga UPDATE de
-- tabla completa, no otorga permisos sobre ninguna otra columna, no usa
-- service_role.
--
-- Idempotente: GRANT es una operación declarativa — reejecutarla no
-- falla ni duplica nada.
--
-- Cómo probar: correr primero con `rollback;` en vez de `commit;` al
-- final, revisar que no haya errores, y volver a correrlo completo con
-- `commit;` para la corrida real.
--
-- Rollback (si hiciera falta revertir por completo):
--   begin;
--   revoke update (planeacion_activa) on public.conversaciones_chat from authenticated;
--   commit;
-- ============================================================

begin;

grant update (planeacion_activa)
  on public.conversaciones_chat
  to authenticated;

commit;
