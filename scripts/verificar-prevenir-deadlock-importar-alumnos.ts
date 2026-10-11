// scripts/verificar-prevenir-deadlock-importar-alumnos.ts
//
// V1-D2C1-B4D1 — corrección de concurrencia, continuación: cierra el
// gap dejado explícitamente pendiente en
// 20261008030000_alta_persona_con_inscripcion.sql. Verifica
// ESTÁTICAMENTE (sin credenciales, sin red, sin DDL/DML remoto, sin
// datos reales) la migración
// 20261008040000_prevenir_deadlock_importar_alumnos_a_grupo.sql, que
// reemplaza (CREATE OR REPLACE) el cuerpo de importar_alumnos_a_grupo
// para adquirir los advisory locks transaccionales de CURP en un
// orden determinista ANTES del bucle principal — mismo criterio que
// el resto de esta familia de scripts: se audita el TEXTO real de la
// migración.
//
// Se ejecuta con `npx tsx scripts/verificar-prevenir-deadlock-importar-alumnos.ts`.

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
  raiz('supabase', 'migrations', '20261008040000_prevenir_deadlock_importar_alumnos_a_grupo.sql'),
  'utf-8'
)
const migracionOriginal = readFileSync(
  raiz('supabase', 'migrations', '20260912200000_importar_alumnos_a_grupo.sql'),
  'utf-8'
)
const migracionAltaPersona = readFileSync(
  raiz('supabase', 'migrations', '20261008030000_alta_persona_con_inscripcion.sql'),
  'utf-8'
)

function sinComentariosSql(contenido: string): string {
  return contenido
    .split('\n')
    .filter((linea) => !linea.trim().startsWith('--'))
    .join('\n')
}
const codigoReal = sinComentariosSql(migracion)
const codigoRealOriginal = sinComentariosSql(migracionOriginal)

const inicioCuerpo = codigoReal.indexOf('create or replace function public.importar_alumnos_a_grupo')
const finCuerpo = codigoReal.indexOf('$$;', inicioCuerpo) + 3
const cuerpoFuncion = codigoReal.slice(inicioCuerpo, finCuerpo)

function main() {
  // ============================================================
  // 1. Firma exacta preservada — idéntica a la versión desplegada.
  // ============================================================
  verificar(
    /create or replace function public\.importar_alumnos_a_grupo\(p_grupo_id uuid, p_alumnos jsonb\)/.test(codigoReal),
    '1. Firma exacta preservada: importar_alumnos_a_grupo(p_grupo_id uuid, p_alumnos jsonb)'
  )
  verificar(/returns integer/.test(cuerpoFuncion), '1b. Retorna integer (conteo de creados) — sin cambio')
  verificar(/security definer/.test(cuerpoFuncion), '1c. SECURITY DEFINER — sin cambio')
  verificar(/set search_path = ''/.test(codigoReal), "1d. SET search_path = '' fijo — sin cambio")

  // ============================================================
  // 2. CREATE OR REPLACE deliberado (a diferencia del CREATE FUNCTION
  //    fail-closed de las primitivas nuevas) — esta función ya existe
  //    en producción y se reemplaza intencionalmente.
  // ============================================================
  verificar(/^create or replace function public\.importar_alumnos_a_grupo/m.test(codigoReal), '2. CREATE OR REPLACE FUNCTION explícito')

  // ============================================================
  // 3. Normalización de CURP preservada — misma semántica exacta que
  //    la versión original: se guarda tal cual (recortada), se compara
  //    en mayúsculas.
  // ============================================================
  verificar(
    codigoReal.includes("v_curp := nullif(trim(both from coalesce(v_elem->>'curp', '')), '')"),
    '3. La extracción/recorte de CURP por elemento es idéntica a la versión original'
  )
  verificar((cuerpoFuncion.match(/v_curp_norm := upper\(v_curp\)/g) || []).length === 2, '3b. v_curp_norm := upper(v_curp) aparece exactamente 2 veces (recolección previa + bucle principal) — misma normalización, nunca una nueva')

  // ============================================================
  // 4. Bloqueo transaccional — misma firma exacta que
  //    reparar_curp_desde_lista_oficial y alta_persona_con_inscripcion.
  // ============================================================
  verificar(
    /perform pg_advisory_xact_lock\(hashtextextended\(v_curp_lock, 0::bigint\)\);/.test(cuerpoFuncion),
    '4. Existe pg_advisory_xact_lock(hashtextextended(v_curp_lock, 0::bigint)) — misma firma que las otras dos funciones'
  )
  verificar(
    !/\bpg_advisory_lock\(/.test(cuerpoFuncion) && !/\bpg_advisory_unlock\(/.test(cuerpoFuncion),
    '4b. 0 uso del lock de SESIÓN (pg_advisory_lock/pg_advisory_unlock) — solo la variante transaccional'
  )
  verificar(
    (cuerpoFuncion.match(/pg_advisory_xact_lock\(/g) || []).length === 1,
    '4c. Exactamente 1 punto de adquisición de locks en todo el cuerpo (dentro de un bucle de recolección, no repetido por fila del bucle principal)'
  )

  // ============================================================
  // 5. Orden determinista de adquisición: se recolectan las CURP
  //    distintas del lote ANTES del bucle principal, se ordenan
  //    (order by 1) y se adquiere un lock por cada una, EN ESE ORDEN,
  //    antes de cualquier EXISTS/INSERT.
  // ============================================================
  verificar(cuerpoFuncion.includes('v_curps_lote'), '5. Existe una recolección explícita de las CURP distintas del lote (v_curps_lote)')
  verificar(
    /for v_curp_lock in select unnest\(v_curps_lote\) order by 1\s*\n\s*loop/.test(cuerpoFuncion),
    '5b. La adquisición recorre v_curps_lote ordenado ascendentemente (order by 1) — orden determinista, no el orden de aparición en el archivo'
  )

  const posicionDeclaracionCurpsLote = cuerpoFuncion.indexOf('v_curps_lote text[]')
  const posicionRecoleccion = cuerpoFuncion.indexOf("v_curp_norm := upper(v_curp);\n      if not (v_curp_norm = any(v_curps_lote))")
  const posicionBucleLocks = cuerpoFuncion.indexOf('for v_curp_lock in select unnest(v_curps_lote) order by 1')
  const posicionBuclePrincipal = cuerpoFuncion.indexOf("if jsonb_typeof(v_elem) is distinct from 'object' then")
  const posicionExistsDuplicado = cuerpoFuncion.indexOf('where a.institucion_id = v_institucion_id')
  const posicionInsertAlumno = cuerpoFuncion.indexOf('insert into public.alumnos')

  verificar(
    posicionDeclaracionCurpsLote !== -1 &&
      posicionRecoleccion !== -1 &&
      posicionBucleLocks !== -1 &&
      posicionBuclePrincipal !== -1 &&
      posicionExistsDuplicado !== -1 &&
      posicionInsertAlumno !== -1 &&
      posicionRecoleccion < posicionBucleLocks &&
      posicionBucleLocks < posicionBuclePrincipal &&
      posicionBuclePrincipal < posicionExistsDuplicado &&
      posicionExistsDuplicado < posicionInsertAlumno,
    '6. Orden real correcto: recolección de CURP del lote → adquisición ordenada de locks → bucle principal → EXISTS de duplicado → INSERT (los locks SIEMPRE se adquieren antes de cualquier comprobación de duplicado o escritura)'
  )

  // ============================================================
  // 7. El recorrido de recolección es de solo lectura — no contiene
  //    ningún raise exception ni escritura (nunca duplica la
  //    validación estricta del bucle principal).
  // ============================================================
  const bloqueRecoleccion = cuerpoFuncion.slice(posicionRecoleccion - 200, posicionBucleLocks)
  verificar(!/raise exception/i.test(bloqueRecoleccion), '7. El recorrido de recolección de CURP no lanza ninguna excepción por sí mismo')
  verificar(!/insert into|update\s+public\.|delete from/i.test(bloqueRecoleccion), '7b. El recorrido de recolección es estrictamente de solo lectura')

  // ============================================================
  // 8. El bucle principal, las validaciones, los mensajes y el INSERT
  //    quedan textualmente IDÉNTICOS a la versión original desplegada
  //    (excepto el comentario explicativo agregado sobre el lock).
  // ============================================================
  const mensajesOriginales = [
    'No autenticado.',
    'Falta el grupo.',
    'Grupo no encontrado o no pertenece al docente.',
    'Formato de alumnos inválido.',
    'No hay alumnos para importar.',
    'Demasiados alumnos en una sola importación.',
    'Formato de alumno inválido.',
    'Un alumno no tiene nombre válido.',
    'Valor de sexo no reconocido.',
    'CURP duplicada dentro del mismo archivo.',
    'Esa CURP ya está registrada.',
  ]
  verificar(
    mensajesOriginales.every((m) => codigoRealOriginal.includes(m)) && mensajesOriginales.every((m) => cuerpoFuncion.includes(m)),
    '8. Los 11 mensajes de error de la versión original siguen presentes, textualmente idénticos, en la nueva versión'
  )
  verificar(
    codigoReal.includes("insert into public.alumnos (institucion_id, docente_id, nombre, curp, sexo)\n    values (v_institucion_id, v_docente_id, v_nombre, v_curp, v_sexo)"),
    '8b. El INSERT de alumnos usa exactamente las mismas columnas (incluye sexo) — sin cambio'
  )
  verificar(
    codigoReal.includes('insert into public.inscripciones (alumno_id, grupo_id, ciclo_escolar_id, docente_id, estatus)\n    values (v_alumno_id, p_grupo_id, v_ciclo_escolar_id, v_docente_id, \'activo\')'),
    '8c. El INSERT de inscripciones usa exactamente las mismas columnas — sin cambio'
  )
  verificar(/return v_creados;/.test(cuerpoFuncion), '8d. El retorno (v_creados) es idéntico — sin cambio')
  verificar((cuerpoFuncion.match(/insert into public\.alumnos/g) || []).length === 1, '8e. Exactamente 1 INSERT en alumnos — el recorrido de recolección no inserta nada')
  verificar((cuerpoFuncion.match(/insert into public\.inscripciones/g) || []).length === 1, '8f. Exactamente 1 INSERT en inscripciones')

  // ============================================================
  // 9. 0 GRANT/REVOKE en esta migración — CREATE OR REPLACE preserva
  //    los permisos EXECUTE ya existentes sobre el objeto; tocarlos
  //    aquí sería un cambio de alcance no solicitado.
  // ============================================================
  verificar(!/\bgrant\b/i.test(codigoReal), '9. 0 GRANT en el código real (sin comentarios) de la migración — los permisos EXECUTE actuales se preservan sin tocarlos')
  verificar(!/\brevoke\b/i.test(codigoReal), '9b. 0 REVOKE en el código real (sin comentarios) de la migración')

  // ============================================================
  // 10. 0 cambio de esquema — 0 restricción UNIQUE nueva, 0 ALTER
  //     TABLE, 0 CREATE INDEX. 0 modificación de alumnos existentes
  //     (0 UPDATE/DELETE en toda la función).
  // ============================================================
  verificar(!/add constraint/i.test(migracion), '10a. 0 "ADD CONSTRAINT" en toda la migración')
  verificar(!/create\s+(unique\s+)?index/i.test(migracion), '10b. 0 "CREATE INDEX" en toda la migración')
  verificar(!/alter table/i.test(migracion), '10c. 0 "ALTER TABLE" en toda la migración')
  verificar(!/\bupdate\s+public\./i.test(cuerpoFuncion), '10d. 0 UPDATE en toda la función — nunca modifica alumnos existentes')
  verificar(!/\bdelete\s+from\b/i.test(cuerpoFuncion), '10e. 0 DELETE en toda la función')

  // ============================================================
  // 11. Compatibilidad con las otras dos funciones ya corregidas —
  //     misma función de lock, misma firma de hash, mismo criterio de
  //     normalización (upper), confirmado comparando el texto real de
  //     los 3 archivos entre sí.
  // ============================================================
  verificar(
    migracionAltaPersona.includes('perform pg_advisory_xact_lock(hashtextextended(v_curp_norm, 0::bigint));') &&
      cuerpoFuncion.includes('pg_advisory_xact_lock(hashtextextended(v_curp_lock, 0::bigint));'),
    '11. alta_persona_con_inscripcion y esta migración usan la misma función de bloqueo (pg_advisory_xact_lock) con la misma firma de hash (hashtextextended(<curp_norm>, 0::bigint)) — compiten por la misma clave ante la misma CURP'
  )

  // ============================================================
  // 12. 0 referencia a UI, Chat IA, roster_congelado ni tablas de
  //     historial — mismo criterio que el resto de esta familia.
  // ============================================================
  verificar(!/anthropic|openai/i.test(migracion), '12a. La migración no referencia ningún cliente de IA')
  verificar(!migracion.toLowerCase().includes('roster_congelado'), '12b. 0 referencia a roster_congelado')
  const TABLAS_HISTORIAL = ['asistencia_registro', 'incidencias', 'evaluaciones', 'evidencias', 'necesidades_apoyo', 'fichas_descriptivas', 'seguimiento_resultados']
  verificar(TABLAS_HISTORIAL.every((t) => !codigoReal.includes(t)), '12c. 0 referencia en código real a ninguna de las 7 tablas de historial')

  // ============================================================
  // 13. Esta migración no toca los 2 archivos de B4D1 (confirmación
  //     cruzada: alta_persona_con_inscripcion sigue usando CREATE
  //     FUNCTION fail-closed, nunca OR REPLACE).
  // ============================================================
  verificar(
    /^create function public\.alta_persona_con_inscripcion/m.test(migracionAltaPersona),
    '13. alta_persona_con_inscripcion (B4D1) conserva su CREATE FUNCTION fail-closed — no fue tocada por esta corrección'
  )

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
