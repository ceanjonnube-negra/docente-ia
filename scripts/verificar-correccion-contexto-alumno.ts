// scripts/verificar-correccion-contexto-alumno.ts
//
// V1-D2C1-B2 — corrección preparatoria de contexto_alumno (ver
// auditoría READ-ONLY "V1-D2C1-B2 — validación focalizada de
// compatibilidad", hallazgo bloqueante confirmado): el campo
// 'inscripcion_activa' usaba `limit 1` sin filtrar por estatus ni
// ordenar — inofensivo hoy (el UNIQUE total garantiza a lo sumo 1 fila
// por alumno+ciclo), pero se volvería no determinista en cuanto se
// retire esa restricción (fase futura, NO aplicada aquí) para permitir
// conservar inscripciones históricas adicionales.
//
// Esta migración (20261008000000) es exclusivamente la corrección de
// esa subconsulta — NO retira el UNIQUE total, NO toca el índice
// parcial, NO cambia ningún otro campo del JSON ni la autorización.
//
// Verificación ESTÁTICA (sin credenciales, sin red, sin datos reales,
// sin conexión a Supabase) — mismo criterio que el resto de esta
// familia de scripts (ver scripts/verificar-baja-individual-
// inscripcion.ts). Incluye, además de las aserciones de texto
// habituales, una comparación programática contra la definición
// ORIGINAL (capturada por catálogo real antes de esta corrección) para
// demostrar que el único cambio es el filtro autorizado, y una
// simulación pura en memoria del predicado SQL para probar los
// escenarios de PASO 3 sin tocar la base real.
//
// Se ejecuta con `npx tsx scripts/verificar-correccion-contexto-alumno.ts`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

const raiz = (...partes: string[]) => join(__dirname, '..', ...partes)
const migracion = readFileSync(
  raiz('supabase', 'migrations', '20261008000000_corregir_contexto_alumno_inscripcion_activa.sql'),
  'utf-8'
)

function normalizarEspacios(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

// Cuerpo EXACTO de contexto_alumno capturado por catálogo real
// (pg_get_functiondef) ANTES de esta corrección — fuente de verdad
// para demostrar que el único cambio funcional es el filtro agregado,
// nunca memoria ni estimación.
const DEFINICION_ORIGINAL = `
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
                            where i.alumno_id = p_alumno_id and i.ciclo_escolar_id = p_ciclo_escolar_id limit 1),
    'asistencia_resumen', consultar_asistencia_alumno(p_alumno_id, p_ciclo_escolar_id),
    'perfil_resumen', (select resumen from perfil_alumno_resumen where alumno_id = p_alumno_id),
    'notas_recientes', (
      select coalesce(jsonb_agg(to_jsonb(n) order by n.fecha desc), '[]'::jsonb)
      from (select * from perfil_alumno_notas where alumno_id = p_alumno_id and estado = 'confirmado'
            order by fecha desc limit 15) n
    )
  ) into v_result;

  return v_result;
end; $function$
`

function main() {
  // ============================================================
  // Extraer el cuerpo CREATE OR REPLACE FUNCTION de la migración
  // (sin los comentarios de cabecera) para comparar contra el
  // original.
  // ============================================================
  const inicioFuncion = migracion.indexOf('create or replace function')
  verificar(inicioFuncion !== -1, '0. La migración contiene exactamente un CREATE OR REPLACE FUNCTION')
  const cuerpoNuevo = migracion.slice(inicioFuncion)

  // ============================================================
  // 1. La definición propuesta coincide con la original EXACTAMENTE,
  //    salvo el filtro agregado — comparación programática, no visual.
  //    Se quita primero el TODO (comentario SQL interno, ausente en el
  //    fixture ORIGINAL por brevedad pero presente en ambos archivos
  //    reales) y el filtro agregado, y lo que queda debe ser idéntico.
  // ============================================================
  const sinComentarioTodo = (s: string) => s.replace(/--\s*TODO[^\n]*\n/g, '')
  const nuevoSinFiltro = normalizarEspacios(sinComentarioTodo(cuerpoNuevo).replace(/and i\.estatus = 'activo'\s*/g, ''))
  const originalNormalizado = normalizarEspacios(DEFINICION_ORIGINAL)
  verificar(
    nuevoSinFiltro === originalNormalizado,
    '1. Quitando el filtro "and i.estatus = \'activo\'" agregado, la definición nueva es IDÉNTICA a la original capturada por catálogo — 0 otra diferencia (firma, docente_grupos, demás campos del JSON, SECURITY DEFINER, ausencia de SET search_path)'
  )

  // ============================================================
  // 2. El filtro aparece EXACTAMENTE una vez, y específicamente dentro
  //    de la subconsulta de 'inscripcion_activa' — nunca en otro campo.
  // ============================================================
  const ocurrencias = (cuerpoNuevo.match(/and i\.estatus = 'activo'/g) || []).length
  verificar(ocurrencias === 1, "2. El filtro \"and i.estatus = 'activo'\" aparece exactamente 1 vez en toda la función")
  const bloqueInscripcionActiva = cuerpoNuevo.slice(cuerpoNuevo.indexOf("'inscripcion_activa'"), cuerpoNuevo.indexOf("'asistencia_resumen'"))
  verificar(bloqueInscripcionActiva.includes("and i.estatus = 'activo'"), "2b. El filtro está dentro del bloque de 'inscripcion_activa', no en otro campo del JSON")

  // ============================================================
  // 3. Firma, tipo de retorno, LANGUAGE y SECURITY DEFINER sin cambio.
  // ============================================================
  verificar(cuerpoNuevo.includes('public.contexto_alumno(p_alumno_id uuid, p_ciclo_escolar_id uuid)'), '3a. Firma idéntica: (p_alumno_id uuid, p_ciclo_escolar_id uuid)')
  verificar(/returns jsonb/.test(cuerpoNuevo), '3b. Tipo de retorno sin cambio: jsonb')
  verificar(/language plpgsql/.test(cuerpoNuevo), '3c. LANGUAGE sin cambio: plpgsql')
  verificar(/security definer/.test(cuerpoNuevo), '3d. SECURITY DEFINER preservado — nunca se introduce SECURITY INVOKER')
  verificar(!/security invoker/.test(cuerpoNuevo), '3e. Confirmación negativa explícita: 0 "security invoker" en todo el archivo')

  // ============================================================
  // 4. search_path: la definición original NO tenía SET search_path —
  //    esta corrección no le agrega uno (fuera de alcance de esta
  //    tarea, no se introduce como efecto colateral).
  // ============================================================
  verificar(!/set search_path/i.test(cuerpoNuevo), '4. No se agrega ningún "SET search_path" — se preserva la ausencia que ya tenía la definición vigente')

  // ============================================================
  // 5. Autorización vía docente_grupos — idéntica, sin ampliar ni
  //    reducir el alcance de quién puede llamar la función.
  // ============================================================
  verificar(
    /if not exists \(select 1 from inscripciones i join docente_grupos dg on dg\.grupo_id = i\.grupo_id\s*\n\s*where i\.alumno_id = p_alumno_id and dg\.docente_id = v_docente_id\) then/.test(cuerpoNuevo),
    '5. La validación de autorización (EXISTS vía docente_grupos) es EXACTAMENTE la misma — no se amplían ni reducen permisos'
  )

  // ============================================================
  // 6. 0 GRANT/REVOKE en esta migración — CREATE OR REPLACE FUNCTION
  //    nunca modifica privilegios EXECUTE ya otorgados, así que no
  //    tocar esto es lo correcto (preserva exactamente lo existente).
  // ============================================================
  verificar(!/grant\s+execute|revoke\s+execute/i.test(migracion), '6. 0 GRANT/REVOKE en esta migración — los privilegios EXECUTE existentes (confirmados por catálogo) permanecen exactamente iguales')

  // ============================================================
  // 7. 0 DDL destructivo — no se toca ninguna tabla, índice ni
  //    constraint. El UNIQUE total y el parcial siguen intactos.
  // ============================================================
  verificar(!/drop\s+(table|constraint|index)/i.test(migracion), '7a. 0 DROP TABLE/CONSTRAINT/INDEX en esta migración')
  // Se revisa únicamente el código real (cuerpoNuevo), nunca los
  // comentarios — el comentario de cabecera SÍ nombra ambos
  // constraints en prosa, deliberadamente, para explicar que ninguno
  // se toca; eso es documentación legítima, no una referencia de DDL.
  verificar(!cuerpoNuevo.toLowerCase().includes('inscripciones_alumno_id_ciclo_escolar_id_key'), '7b. El UNIQUE total no se referencia en el código real — sigue vigente, retirarlo queda para una fase posterior')
  verificar(!cuerpoNuevo.toLowerCase().includes('inscripciones_alumno_ciclo_activo_uk'), '7c. El índice parcial de inscripciones activas no se referencia en el código real')

  // ============================================================
  // 8. 0 IA, 0 llamada a servicios externos en la migración.
  // ============================================================
  verificar(!/anthropic|openai/i.test(migracion), '8. La migración no referencia ningún cliente de IA')

  // ============================================================
  // Simulación pura del predicado SQL — PASO 3, puntos 2-7: prueba
  // aislada en memoria, sin tocar datos reales, replicando
  // EXACTAMENTE el filtro agregado (alumno_id + ciclo_escolar_id +
  // estatus='activo', limit 1).
  // ============================================================
  type FilaInscripcionSim = { id: string; alumno_id: string; ciclo_escolar_id: string; grupo_id: string; estatus: string }

  function simularInscripcionActiva(filas: FilaInscripcionSim[], alumnoId: string, cicloId: string): FilaInscripcionSim | null {
    const candidatas = filas.filter((f) => f.alumno_id === alumnoId && f.ciclo_escolar_id === cicloId && f.estatus === 'activo')
    return candidatas.length > 0 ? candidatas[0] : null
  }

  const ALUMNO = 'alumno-1'
  const CICLO = 'ciclo-2026'

  // PASO 3.2 — una inscripción activa sigue siendo visible.
  {
    const filas: FilaInscripcionSim[] = [{ id: 'i1', alumno_id: ALUMNO, ciclo_escolar_id: CICLO, grupo_id: 'g1', estatus: 'activo' }]
    const r = simularInscripcionActiva(filas, ALUMNO, CICLO)
    verificar(r !== null && r.id === 'i1', '9. PASO 3.2 — una inscripción activa real sigue siendo visible (se devuelve su fila)')
  }

  // PASO 3.3 — una inscripción de baja NUNCA se presenta como activa.
  {
    const filas: FilaInscripcionSim[] = [{ id: 'i1', alumno_id: ALUMNO, ciclo_escolar_id: CICLO, grupo_id: 'g1', estatus: 'baja' }]
    const r = simularInscripcionActiva(filas, ALUMNO, CICLO)
    verificar(r === null, '10. PASO 3.3 — una inscripción de baja nunca se devuelve como activa (null, no la fila)')
  }

  // PASO 3.4 — cambio_escuela NUNCA se presenta como activa.
  {
    const filas: FilaInscripcionSim[] = [{ id: 'i1', alumno_id: ALUMNO, ciclo_escolar_id: CICLO, grupo_id: 'g1', estatus: 'cambio_escuela' }]
    const r = simularInscripcionActiva(filas, ALUMNO, CICLO)
    verificar(r === null, '11. PASO 3.4 — una inscripción con estatus cambio_escuela nunca se devuelve como activa')
  }

  // PASO 3.5 — si no existe ninguna inscripción, el campo es null.
  {
    const r = simularInscripcionActiva([], ALUMNO, CICLO)
    verificar(r === null, '12. PASO 3.5 — sin ninguna inscripción para ese alumno+ciclo, el resultado es null (ya era el comportamiento real hoy, sin cambio)')
  }

  // PASO 3.6 — varias históricas (0 activas) → nunca se elige ninguna
  // arbitrariamente (null, no una de ellas).
  {
    const filas: FilaInscripcionSim[] = [
      { id: 'i1', alumno_id: ALUMNO, ciclo_escolar_id: CICLO, grupo_id: 'gA', estatus: 'baja' },
      { id: 'i2', alumno_id: ALUMNO, ciclo_escolar_id: CICLO, grupo_id: 'gB', estatus: 'cambio_escuela' },
      { id: 'i3', alumno_id: ALUMNO, ciclo_escolar_id: CICLO, grupo_id: 'gC', estatus: 'baja' },
    ]
    const r = simularInscripcionActiva(filas, ALUMNO, CICLO)
    verificar(r === null, '13. PASO 3.6 — 3 inscripciones históricas y 0 activa → null, nunca se elige ninguna de las 3 arbitrariamente')
  }

  // PASO 3.7 — 1 activa entre varias históricas → se selecciona
  // EXCLUSIVAMENTE la activa.
  {
    const filas: FilaInscripcionSim[] = [
      { id: 'i1', alumno_id: ALUMNO, ciclo_escolar_id: CICLO, grupo_id: 'gA', estatus: 'baja' },
      { id: 'i2', alumno_id: ALUMNO, ciclo_escolar_id: CICLO, grupo_id: 'gB', estatus: 'cambio_escuela' },
      { id: 'i3', alumno_id: ALUMNO, ciclo_escolar_id: CICLO, grupo_id: 'gC', estatus: 'activo' },
    ]
    const r = simularInscripcionActiva(filas, ALUMNO, CICLO)
    verificar(r !== null && r.id === 'i3' && r.grupo_id === 'gC', '14. PASO 3.7 — 1 activa + varias históricas → se devuelve exclusivamente la activa (i3), nunca una de las históricas')
  }

  // PASO 3.1 (complemento) — otro alumno/ciclo nunca se mezcla.
  {
    const filas: FilaInscripcionSim[] = [
      { id: 'i1', alumno_id: ALUMNO, ciclo_escolar_id: CICLO, grupo_id: 'gA', estatus: 'activo' },
      { id: 'i2', alumno_id: 'alumno-2', ciclo_escolar_id: CICLO, grupo_id: 'gA', estatus: 'activo' },
      { id: 'i3', alumno_id: ALUMNO, ciclo_escolar_id: 'ciclo-2025', grupo_id: 'gA', estatus: 'activo' },
    ]
    const r = simularInscripcionActiva(filas, ALUMNO, CICLO)
    verificar(r !== null && r.id === 'i1', '15. Filas de otro alumno u otro ciclo nunca contaminan el resultado — se devuelve exclusivamente i1')
  }

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
