-- Corrección mínima y aislada de contexto_alumno (función ya
-- existente, SECURITY DEFINER) — ver auditoría READ-ONLY
-- "V1-D2C1-B2 — validación focalizada de compatibilidad" (hallazgo
-- bloqueante confirmado): el campo 'inscripcion_activa' del JSON que
-- devuelve esta función se construía con
--
--   (select to_jsonb(i) from inscripciones i
--    where i.alumno_id = p_alumno_id and i.ciclo_escolar_id = p_ciclo_escolar_id
--    limit 1)
--
-- sin filtrar por estatus ni ordenar explícitamente. Hoy es inofensivo
-- porque el UNIQUE total (alumno_id, ciclo_escolar_id) garantiza que a
-- lo sumo existe 1 fila para ese par — pero esa restricción está
-- planeada para retirarse en una fase futura (V1-D2C1-B2, propuesta de
-- esquema aprobada conceptualmente, NO aplicada todavía) precisamente
-- para permitir conservar inscripciones HISTÓRICAS adicionales del
-- mismo alumno en el mismo ciclo (p. ej. tras un cambio de grupo). En
-- cuanto eso exista, un LIMIT 1 sin filtro de estatus devolvería una
-- fila ARBITRARIA (sin ORDER BY, Postgres no garantiza cuál), pudiendo
-- presentar una inscripción de baja/cambio_escuela como si fuera la
-- activa.
--
-- Esta migración NO retira el UNIQUE total (sigue vigente, sin
-- cambios) — es exclusivamente la corrección preparatoria de
-- contexto_alumno, aislada y aplicable con independencia de cuándo se
-- decida retirar esa restricción. El índice parcial
-- inscripciones_alumno_ciclo_activo_uk (único real que debe seguir
-- garantizando "a lo sumo 1 activa por alumno+ciclo") no se toca.
--
-- Único cambio funcional: se agrega "and i.estatus = 'activo'" a la
-- subconsulta de 'inscripcion_activa' — ninguna otra condición, ningún
-- otro campo del JSON, se modifica. Con el índice parcial vigente esto
-- hace que, cuando exista una fila activa, sea la única que puede
-- coincidir (el LIMIT 1 pasa a ser redundante pero inofensivo); cuando
-- no exista ninguna activa (0 o solo históricas), el campo devuelve
-- null — un valor que la función YA podía producir hoy (alumno sin
-- ninguna inscripción en ese ciclo) y que ningún consumidor de
-- TypeScript destructura por nombre (confirmado: 0 referencia a
-- "inscripcion_activa" en todo el repo — todos los consumidores de
-- contextoAlumno() en lib/motorContexto.ts, app/api/chat/route.ts,
-- app/api/generar-ficha-descriptiva/route.ts y
-- lib/asistente/herramientasModulo.ts solo leen "datos_personales" o
-- serializan el objeto completo con JSON.stringify, que tolera null
-- sin ningún cambio de comportamiento).
--
-- CREATE OR REPLACE FUNCTION conserva, deliberadamente sin tocar:
-- firma (p_alumno_id uuid, p_ciclo_escolar_id uuid), tipo de retorno
-- (jsonb), LANGUAGE plpgsql, SECURITY DEFINER, la validación de
-- autorización vía docente_grupos (idéntica), y la AUSENCIA de
-- "SET search_path" que ya tenía la definición vigente (no se agrega
-- aquí — no es objeto de esta corrección). CREATE OR REPLACE FUNCTION
-- nunca modifica privilegios EXECUTE ya otorgados — esta migración no
-- incluye ningún GRANT/REVOKE, así que los privilegios existentes
-- (service_role, authenticated, anon, postgres, PUBLIC — confirmados
-- por catálogo antes de esta migración) permanecen exactamente
-- iguales, sin ampliarse ni reducirse.

create or replace function public.contexto_alumno(p_alumno_id uuid, p_ciclo_escolar_id uuid)
 returns jsonb
 language plpgsql
 security definer
as $function$
declare
  v_docente_id uuid := auth.uid();
  v_result jsonb;
begin
  if not exists (select 1 from inscripciones i join docente_grupos dg on dg.grupo_id = i.grupo_id
                 where i.alumno_id = p_alumno_id and dg.docente_id = v_docente_id) then
    raise exception 'No tienes permiso sobre este alumno';
  end if;

  select jsonb_build_object(
    'datos_personales', (select to_jsonb(a) from alumnos a where a.id = p_alumno_id),
    'inscripcion_activa', (select to_jsonb(i) from inscripciones i
                            where i.alumno_id = p_alumno_id and i.ciclo_escolar_id = p_ciclo_escolar_id
                              and i.estatus = 'activo' limit 1),
    'asistencia_resumen', consultar_asistencia_alumno(p_alumno_id, p_ciclo_escolar_id),
    'perfil_resumen', (select resumen from perfil_alumno_resumen where alumno_id = p_alumno_id),
    'notas_recientes', (
      select coalesce(jsonb_agg(to_jsonb(n) order by n.fecha desc), '[]'::jsonb)
      from (select * from perfil_alumno_notas where alumno_id = p_alumno_id and estado = 'confirmado'
            order by fecha desc limit 15) n
    )
    -- TODO Etapa 2/3: agregar 'evaluaciones' e 'incidencias' cuando esas tablas existan
  ) into v_result;

  return v_result;
end; $function$
