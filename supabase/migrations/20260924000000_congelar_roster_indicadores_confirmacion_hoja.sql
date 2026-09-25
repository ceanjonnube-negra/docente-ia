-- ============================================================
-- Migración: base canónica de captura de Evaluación (EVAL-1B).
--
-- Precheck (ver informe READ-ONLY EVAL-1B aceptado antes de esta
-- migración): seguimiento_resultados tiene 0 filas en todo el
-- proyecto, hojas_evaluacion tiene exactamente 1 fila (SG-VXKR,
-- generada 2026-09-23, sin ninguna alta/baja posterior en el grupo) —
-- 100% aditiva, sin riesgo de violar ningún dato existente.
--
-- Objetivo — dejar preparada la base estructural para que futuras
-- fases (EVAL-1C en adelante) puedan hacer foto → análisis → matching
-- → revisión → confirmación → seguimiento_resultados. Esta migración
-- NO implementa fotografía, visión, matching, UI ni confirmación
-- real — solo esquema.
--
-- 1) hojas_evaluacion.roster_congelado (jsonb, null) — el roster
--    EXACTO (alumno_id, inscripcion_id, nombre, posicion) usado para
--    construir el PDF de una hoja NUEVA, escrito una sola vez en el
--    mismo INSERT que crea la fila (ver
--    lib/seguimiento/generarYGuardarHoja.ts). Nunca se recalcula,
--    actualiza ni sustituye después. SG-VXKR (única hoja histórica,
--    creada antes de esta columna) queda con roster_congelado=NULL —
--    fail-closed, sin backfill ni aproximación (no hay forma
--    determinista de reconstruir el roster exacto que existía al
--    momento de su generación).
--
-- 2) proyectos_seguimiento: confirmado_en / confirmado_por /
--    origen_resultados / captura_pendiente — la confirmación es un
--    evento del LOTE completo (toda la hoja, no celda por celda), así
--    que vive una sola vez aquí en vez de repetirse hasta 140 veces en
--    seguimiento_resultados (28 alumnos × 5 indicadores). Ninguna
--    columna se escribe todavía — quedan en NULL hasta que una fase
--    futura implemente el flujo real de confirmación.
--
-- 3) seguimiento_resultados.indicador_numero (smallint, 1-5) — la
--    identidad estable de "qué indicador de la hoja" que sobrevive
--    aunque en el futuro cambie solo la redacción del indicador.
--    Coincide con el mismo numero_indicador que a partir de ahora se
--    congela dentro de hojas_evaluacion.indicadores (index + 1 en el
--    momento de crear la hoja, nunca reordenado después).
--    indicador_especifico se conserva sin cambios — sigue siendo el
--    texto legible del resultado, nunca la identidad.
--
-- 4) UNIQUE (proyecto_id, inscripcion_id, indicador_numero) en
--    seguimiento_resultados — 0 filas existentes hoy, sin riesgo de
--    violación. inscripcion_id (no alumno_id) porque un alumno puede
--    tener varias inscripciones a lo largo de distintos ciclos/grupos
--    — la identidad de un resultado debe acotarse al periodo/grupo
--    real en que ocurrió el proyecto, nunca al alumno en abstracto.
--    Deja lista la clave natural para un futuro
--    .upsert(..., { onConflict: 'proyecto_id,inscripcion_id,indicador_numero' })
--    — ese upsert NO se implementa en esta migración.
--
-- Explícitamente NO incluido en esta migración (alcance cerrado a
-- propósito):
--   - seguimiento_resultados.confianza_final — ya existe `confianza`;
--     no se crea esquema especulativo antes de que EVAL-1E (matching
--     real) demuestre que hace falta una segunda confianza.
--   - Ningún backfill de roster_congelado/indicador_numero para
--     SG-VXKR ni ninguna otra hoja histórica.
--   - Ninguna política RLS nueva ni modificada — las políticas ya
--     existentes de hojas_evaluacion/proyectos_seguimiento/
--     seguimiento_resultados (auditadas en EVAL-1A/1B, todas
--     docente_id = auth.uid() vía join) ya cubren las columnas nuevas
--     sin cambios, porque son policies a nivel de FILA, no de columna.
--   - Ningún cambio al CHECK existente de seguimiento_resultados.nivel
--     (sigue siendo 'destacado'|'logrado'|'en_proceso'|'requiere_apoyo'|
--     'no_evaluado' — la escala 1-4 queda solo como representación de
--     captura/lectura, convertida por una función pura en código,
--     nunca en el esquema).
--
-- Idempotente: cada ALTER TABLE usa "IF NOT EXISTS" en la columna;
-- el UNIQUE usa un nombre de constraint fijo — reejecutar esta
-- migración completa no falla ni duplica nada si ya se aplicó.
--
-- Rollback (si hiciera falta revertir por completo, sin pérdida de
-- datos preexistentes — ninguna de estas columnas tiene datos reales
-- todavía):
--   begin;
--   alter table seguimiento_resultados drop constraint if exists seguimiento_resultados_proyecto_inscripcion_indicador_key;
--   alter table seguimiento_resultados drop column if exists indicador_numero;
--   alter table proyectos_seguimiento drop column if exists captura_pendiente;
--   alter table proyectos_seguimiento drop column if exists origen_resultados;
--   alter table proyectos_seguimiento drop column if exists confirmado_por;
--   alter table proyectos_seguimiento drop column if exists confirmado_en;
--   alter table hojas_evaluacion drop column if exists roster_congelado;
--   commit;
-- ============================================================

begin;

-- 1) Roster congelado (nullable, sin backfill).
alter table hojas_evaluacion
  add column if not exists roster_congelado jsonb;

-- 2) Confirmación y origen a nivel de lote/proyecto.
alter table proyectos_seguimiento
  add column if not exists confirmado_en timestamptz,
  add column if not exists confirmado_por uuid references perfiles_docentes(id),
  add column if not exists origen_resultados text,
  add column if not exists captura_pendiente jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'proyectos_seguimiento_origen_resultados_check'
      and conrelid = 'proyectos_seguimiento'::regclass
  ) then
    alter table proyectos_seguimiento
      add constraint proyectos_seguimiento_origen_resultados_check
      check (origen_resultados is null or origen_resultados in ('fotografia', 'manual'));
  end if;
end $$;

-- 3) Identidad estable del indicador dentro de un resultado.
alter table seguimiento_resultados
  add column if not exists indicador_numero smallint;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'seguimiento_resultados_indicador_numero_check'
      and conrelid = 'seguimiento_resultados'::regclass
  ) then
    alter table seguimiento_resultados
      add constraint seguimiento_resultados_indicador_numero_check
      check (indicador_numero is null or indicador_numero between 1 and 5);
  end if;
end $$;

-- 4) Idempotencia real a nivel de base de datos.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'seguimiento_resultados_proyecto_inscripcion_indicador_key'
      and conrelid = 'seguimiento_resultados'::regclass
  ) then
    alter table seguimiento_resultados
      add constraint seguimiento_resultados_proyecto_inscripcion_indicador_key
      unique (proyecto_id, inscripcion_id, indicador_numero);
  end if;
end $$;

commit;
