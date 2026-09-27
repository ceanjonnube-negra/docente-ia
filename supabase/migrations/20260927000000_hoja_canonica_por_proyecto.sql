-- Blindaje a nivel de BD de una regla que ya existe en el código: un
-- proyectos_seguimiento tiene como máximo UNA hojas_evaluacion
-- canónica.
--
-- Origen (ver auditoría READ-ONLY "diseño del contexto histórico
-- canónico del proyecto" — sección 3, versionado/inmutabilidad de la
-- hoja): lib/seguimiento/generarYGuardarHoja.ts es la ÚNICA función en
-- todo el repositorio que hace INSERT en hojas_evaluacion (verificado
-- por grep exhaustivo — el resto de rutas que tocan hojas_evaluacion
-- solo hacen SELECT). Esa función ya busca por proyecto_id con
-- .maybeSingle() antes de insertar y, si ya existe una hoja completa
-- para ese proyecto, jamás crea otra ni la reemplaza — es un no-op
-- idempotente por diseño. Ese comportamiento hoy depende ENTERAMENTE
-- de la lógica de aplicación: hojas_evaluacion.proyecto_id no tenía
-- ningún UNIQUE que lo respaldara a nivel de base de datos, dejando
-- abierta una condición de carrera teórica (dos invocaciones casi
-- simultáneas para el mismo proyecto nuevo, antes de que la primera
-- termine de insertar).
--
-- Precheck READ-ONLY realizado antes de esta migración (SELECT
-- proyecto_id, count(*) FROM hojas_evaluacion GROUP BY proyecto_id
-- HAVING count(*) > 1): 0 filas — no existe ningún duplicado real en
-- los datos actuales. total_hojas=2, proyecto_ids distintos=2.
--
-- Deliberadamente NO incluye (fuera de alcance de esta fase, ver la
-- misma auditoría):
--   - UNIQUE de proyectos_seguimiento por huella (docente+grupo+
--     nombre+fechas) — esa huella es hoy solo un mecanismo provisional
--     de deduplicación de aplicación; consolidarla como constraint
--     permanente se pospone hasta resolver la relación explícita
--     planeacion_proyecto -> proyecto_seguimiento.
--   - planeacion_proyecto_id, hoja_id en seguimiento_resultados,
--     periodo_evaluacion_id automático, ni ningún otro cambio.
--
-- Puramente aditivo: no modifica ninguna fila existente, no borra
-- nada, no cambia RLS ni privilegios.

alter table public.hojas_evaluacion
  add constraint hojas_evaluacion_proyecto_id_key
  unique (proyecto_id);
