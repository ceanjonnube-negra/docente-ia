-- ============================================================
-- Migración: planeacion_activa en conversaciones_chat (C-005 —
-- arquitectura de "planeación en edición", Fase 1).
--
-- Objetivo: reservar el espacio de almacenamiento para el snapshot
-- estructurado de la planeación que el docente está editando por
-- conversación (contrato PlaneacionActiva — diseño aprobado por
-- separado). Esta migración NO implementa ese contrato: solo agrega la
-- columna. Ningún código de la aplicación la lee ni la escribe todavía
-- — permanece NULL para toda conversación, existente o nueva, hasta
-- que una fase posterior (no autorizada aquí) empiece a poblarla.
--
-- Mismo rol arquitectónico que documento_activo/material_visual_activo
-- (ya existentes en esta misma tabla, ver
-- 20260811184000_crear_conversaciones_chat.sql): "el X actualmente
-- activo en esta conversación", jsonb, nullable, sin DEFAULT
-- estructurado.
--
-- 100% ADITIVA: solo ALTER TABLE ... ADD COLUMN IF NOT EXISTS sobre
-- una tabla ya existente. No modifica, no renombra ni borra ninguna
-- columna existente de conversaciones_chat ni de ninguna otra tabla.
-- Sin backfill: las filas existentes quedan con planeacion_activa =
-- NULL, que es exactamente el estado esperado ("no hay planeación en
-- edición todavía" para cualquier conversación ya existente).
--
-- Sin tabla nueva, sin índice, sin trigger, sin función, sin RPC, sin
-- cambios de RLS ni de policies — la columna nueva hereda las políticas
-- ya existentes de conversaciones_chat (RLS ya activo en esa tabla
-- desde su migración original).
--
-- Idempotente: ADD COLUMN IF NOT EXISTS — puede reejecutarse sin
-- fallar y sin alterar datos ya presentes.
--
-- Cómo probar: correr primero con `rollback;` en vez de `commit;` al
-- final, revisar que no haya errores, y volver a correrlo completo con
-- `commit;` para la corrida real.
--
-- Rollback (si ya se corrió con commit y hay que revertir por
-- completo — esto SÍ es destructivo si la columna ya tiene datos
-- reales; en el momento de esta migración no debería tener ninguno):
--   begin;
--   alter table public.conversaciones_chat drop column if exists planeacion_activa;
--   commit;
-- ============================================================

begin;

alter table public.conversaciones_chat
  add column if not exists planeacion_activa jsonb;

commit;
