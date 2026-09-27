-- Vínculo estructural estable Planeación -> Proyecto de seguimiento,
-- vía IDs (nunca vía la huella docente+grupo+nombre+fechas).
--
-- Origen (ver auditoría READ-ONLY "vínculo canónico Planeación →
-- Proyecto de seguimiento"): planeacion_proyectos.evaluacion (jsonb)
-- ya guarda, desde que existe (lib/planeacion/aprobarBorrador.ts, Fase
-- 5), un `proyecto_seguimiento_id` real que hoy es la ÚNICA forma de
-- ir de una planeación aprobada a su proyecto de seguimiento — sin
-- FK, sin índice, sin ON DELETE. proyectos_seguimiento nunca tuvo
-- columna de regreso hacia planeacion_proyectos (confirmado: no
-- existe en el esquema hasta esta migración).
--
-- Dirección y cardinalidad (demostradas en la auditoría, no asumidas):
-- N proyectos_seguimiento -> 1 planeacion_proyecto. La FK vive en
-- proyectos_seguimiento (el hijo conceptual) apuntando hacia
-- planeacion_proyectos — nunca al revés. Deliberadamente SIN UNIQUE:
-- permitir que más de un proyecto_seguimiento apunte al mismo
-- planeacion_proyecto es un caso legítimo (p. ej. un proyecto de
-- reforzamiento adicional sobre la misma actividad), no un error a
-- impedir.
--
-- ON DELETE SET NULL (nunca CASCADE): un proyecto de seguimiento con
-- resultados confirmados no debe desaparecer porque se borre la
-- planeación/actividad que lo originó — mismo criterio ya aplicado a
-- proyectos_seguimiento.hoja_id en esta misma tabla.
--
-- Nullable: obligatorio — cubre tanto el histórico previo a esta
-- migración como los proyectos creados directamente desde Evaluación
-- (POST /api/proyectos-seguimiento), que nunca tienen planeación.
--
-- Deliberadamente NO incluye (fuera de alcance de esta fase, ver la
-- misma auditoría):
--   - UNIQUE sobre planeacion_proyecto_id.
--   - UNIQUE de la huella (docente_id, grupo_id, nombre, fecha_inicio,
--     fecha_fin) en proyectos_seguimiento — sigue sin consolidarse.
--   - Ningún cambio en hojas_evaluacion, seguimiento_resultados, ni en
--     el contenido de planeacion_proyectos.evaluacion.
--
-- Backfill: EXCLUSIVAMENTE a partir del ID explícito ya existente en
-- planeacion_proyectos.evaluacion->>'proyecto_seguimiento_id' —
-- nunca por huella. Precheck (SELECT, ver auditoría e informe de esta
-- fase) confirmó exactamente 2 vínculos explícitos, cada uno
-- apuntando a un proyecto_seguimiento real y distinto, sin ninguna
-- ambigüedad. Cualquier proyecto sin un vínculo explícito válido
-- permanece NULL — nunca se infiere por nombre/fechas.

alter table public.proyectos_seguimiento
  add column planeacion_proyecto_id uuid
  references public.planeacion_proyectos(id)
  on delete set null;

update public.proyectos_seguimiento ps
set planeacion_proyecto_id = pp.id
from public.planeacion_proyectos pp
where pp.evaluacion ? 'proyecto_seguimiento_id'
  and (pp.evaluacion->>'proyecto_seguimiento_id')::uuid = ps.id;
