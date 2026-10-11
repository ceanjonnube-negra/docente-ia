// scripts/verificar-reparar-institucion-alumnos.ts
//
// V1-D2C1-B4D2 (reparación previa) — preparación (NO aplicación) de la
// reparación de datos 20261008045000_reparar_institucion_alumnos.sql.
// Verificación ESTÁTICA (sin credenciales, sin red, sin DDL/DML
// remoto, sin datos reales) — mismo criterio que el resto de esta
// familia de scripts: se audita el TEXTO real de la migración.
//
// Se ejecuta con `npx tsx scripts/verificar-reparar-institucion-alumnos.ts`.

import { readFileSync, readdirSync } from 'node:fs'
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
const NOMBRE_MIGRACION = '20261008045000_reparar_institucion_alumnos.sql'
const migracion = readFileSync(raiz('supabase', 'migrations', NOMBRE_MIGRACION), 'utf-8')

// Código real: sin líneas de comentario ni comentarios al final de línea.
const codigoReal = migracion
  .split('\n')
  .filter((linea) => !linea.trim().startsWith('--'))
  .map((linea) => linea.replace(/--.*$/, ''))
  .join('\n')

const INSTITUCION = 'd725bde7-2952-41b0-ba4b-44ee6d8c31a4'
const EXCLUIDO = 'b13b45fc-0ddd-4a78-b188-0ce1342d0bdf'
const UUID = /'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'/g

const inicioIds = codigoReal.indexOf('c_ids constant uuid[] := array[')
const finIds = codigoReal.indexOf(']::uuid[];', inicioIds)
const bloqueIds = codigoReal.slice(inicioIds, finIds)
const idsCandidatos = Array.from(bloqueIds.matchAll(UUID), (m) => m[1])

const posicion = (texto: string) => codigoReal.indexOf(texto)

function main() {
  // ============================================================
  // 1. Una única operación UPDATE, sobre alumnos, solo institucion_id.
  // ============================================================
  const updates = codigoReal.match(/\bupdate\s+[a-z_.]+/gi) || []
  verificar(updates.length === 1, `1. Exactamente 1 UPDATE en todo el código (encontrados: ${updates.length})`)
  verificar(/^\s*update public\.alumnos a\s*$/m.test(codigoReal), '1b. El único UPDATE es sobre public.alumnos')
  const sentenciaUpdate = codigoReal.slice(posicion('update public.alumnos a'), codigoReal.indexOf(';', posicion('update public.alumnos a')))
  verificar(/set institucion_id = c_institucion\s*\n\s*where/.test(sentenciaUpdate), '1c. El SET asigna EXCLUSIVAMENTE institucion_id')
  verificar((sentenciaUpdate.match(/=/g) || []).length === 3, '1d. El UPDATE tiene 1 asignación y 2 igualdades (+ is null) — ninguna columna adicional')
  verificar(!/\bset\b[^;]*\b(id|docente_id|grupo_id|nombre|curp)\s*=/.test(sentenciaUpdate.replace(/where[\s\S]*$/, '')), '1e. Ningún identificador ni otro campo aparece en el SET')

  // ============================================================
  // 2. Ningún INSERT, DELETE ni DDL.
  // ============================================================
  verificar(!/\binsert\s+into\b/i.test(codigoReal), '2. 0 INSERT')
  verificar(!/\bdelete\s+from\b/i.test(codigoReal) && !/\btruncate\b/i.test(codigoReal), '2b. 0 DELETE / TRUNCATE')
  verificar(!/\b(create|alter|drop)\s+(table|index|function|trigger|policy|view|temporary|temp)\b/i.test(codigoReal), '2c. 0 DDL (sin tablas temporales, índices, funciones ni constraints)')
  verificar(!/\b(grant|revoke)\b/i.test(codigoReal), '2d. 0 GRANT / REVOKE')
  verificar(!/\bon conflict\b|\bmerge\b|\bupsert\b/i.test(codigoReal), '2e. 0 UPSERT / MERGE')

  // ============================================================
  // 3. Ninguna modificación de inscripciones ni de otras tablas.
  // ============================================================
  verificar(!/update\s+public\.(inscripciones|grupos|instituciones)/i.test(codigoReal), '3. 0 UPDATE sobre inscripciones, grupos o instituciones')
  verificar(codigoReal.includes('v_huella_inscripciones_antes') && /v_huella_inscripciones_despues <> v_huella_inscripciones_antes/.test(codigoReal), '3b. Huella md5 de TODAS las inscripciones comparada antes/después')
  verificar((codigoReal.match(/string_agg\(to_jsonb\(i\)::text, '\|' order by i\.id\)/g) || []).length === 2, '3c. La huella de inscripciones cubre la fila completa (to_jsonb), ordenada por id')

  // ============================================================
  // 4. Ninguna modificación de identificadores.
  // ============================================================
  verificar((codigoReal.match(/string_agg\(\(to_jsonb\(a\) - 'institucion_id'\)::text, '\|' order by a\.id\)/g) || []).length === 2, '4. Huella de alumnos SIN institucion_id calculada antes y después')
  verificar(/v_huella_alumnos_despues <> v_huella_alumnos_antes/.test(codigoReal), '4b. Si cambió cualquier campo distinto de institucion_id (id, docente_id…) o alguna fila, aborta')

  // ============================================================
  // 5. Validaciones previas (A–E).
  // ============================================================
  verificar(/from public\.inscripciones i\s*\n\s*join public\.grupos g on g\.id = i\.grupo_id\s*\n\s*where i\.alumno_id = v_id;/.test(codigoReal), '5A. Institución inferida vía inscripciones → grupos, por alumno')
  verificar(/if v_n_inscripciones = 0 then/.test(codigoReal), '5A2. Sin inscripciones → institución no verificable → aborta')
  verificar(/if v_n_instituciones <> 1 then/.test(codigoReal), '5A3. Más de una institución → aborta')
  verificar(/if v_institucion_inferida <> c_institucion then/.test(codigoReal), '5A4. La institución inferida se compara contra la esperada (c_institucion solo es comprobación cruzada)')
  verificar(/if v_inst_legado <> v_institucion_inferida then/.test(codigoReal), '5B. Grupo legado: misma institución')
  verificar(/if v_docente_legado <> v_docente_alumno then/.test(codigoReal), '5B2. Grupo legado: mismo docente propietario')
  verificar(/if v_grupo_legado is not null then/.test(codigoReal), '5B3. El grupo legado solo se exige cuando existe')
  verificar(/coalesce\(bool_and\(g\.docente_id = v_docente_alumno\), false\)/.test(codigoReal) && /if not v_grupos_del_docente then/.test(codigoReal), '5C. Todos los grupos de las inscripciones son del docente del alumno')
  verificar(/if v_docente_alumno <> c_docente then/.test(codigoReal), '5C2. El docente del alumno es el esperado')
  verificar(/raise exception 'PRECONDICION_FALLIDA: el alumno esperado % no existe\.'/.test(codigoReal), '5D. Alumno esperado inexistente → aborta')
  verificar(/ya tiene otra institución asignada/.test(codigoReal), '5D2. Alumno con otra institución → aborta')
  verificar(/estado mixto/.test(codigoReal), '5D3. Estado mixto pendientes/reparados → aborta')
  verificar(/group by 1\s*\n\s*having count\(\*\) > 1/.test(codigoReal) && /select upper\(trim\(a\.curp\)\)/.test(codigoReal), '5E. CURP normalizada upper(trim) sin duplicados en la institución resultante')
  verificar(/a\.institucion_id = c_institucion\s*\n\s*or \(a\.institucion_id is null and a\.id = any\(c_ids\)\)/.test(codigoReal), '5E2. El cotejo de CURP abarca la institución completa más los candidatos aún NULL')

  // ============================================================
  // 6. Validaciones posteriores.
  // ============================================================
  verificar(/get diagnostics v_actualizados = row_count;\s*\n\s*if v_actualizados <> c_esperados then/.test(codigoReal), '6. Exactamente 28 filas actualizadas o aborta')
  verificar(/a\.institucion_id is distinct from c_institucion/.test(codigoReal), '6b. Los 28 quedan con la institución esperada')
  verificar(/g\.institucion_id <> a\.institucion_id/.test(codigoReal), '6c. Coherencia con TODOS los grupos de sus inscripciones')
  verificar(/where a\.institucion_id is null\s*\n\s*and a\.id <> c_excluido;/.test(codigoReal), '6d. El único NULL permitido después es el excluido')

  // ============================================================
  // 7. Exclusión del alumno sin grupo.
  // ============================================================
  verificar(codigoReal.includes(`c_excluido constant uuid := '${EXCLUIDO}'`), '7. El alumno excluido está declarado explícitamente')
  verificar(!idsCandidatos.includes(EXCLUIDO), '7b. El excluido NO figura en la lista de candidatos')
  verificar(/if c_excluido = any\(c_ids\) then/.test(codigoReal), '7c. La propia migración rechaza que el excluido entre en la lista')
  verificar(/where a\.id = any\(c_ids\)\s*\n\s*and a\.institucion_id is null\s*\n\s*and a\.docente_id = c_docente;/.test(sentenciaUpdate + ';'), '7d. El UPDATE solo alcanza ids de la lista (nunca por condición genérica)')
  verificar(/el alumno excluido adquirió una relación verificable/.test(codigoReal), '7e. Si el excluido adquiere una relación, aborta para revisión (nunca reparación automática)')

  // ============================================================
  // 8. Idempotencia y deriva.
  // ============================================================
  const posRetornoIdempotente = posicion("raise notice 'Reparación ya aplicada")
  const posUpdate = posicion('update public.alumnos a')
  const posDeriva = posicion('fuera de la lista revisada')
  const posCurp = posicion('CURP duplicada(s) en la institución resultante')
  verificar(/if v_reparados = c_esperados then/.test(codigoReal) && posRetornoIdempotente !== -1, '8. Segunda ejecución (todo reparado) termina sin escribir')
  verificar(posDeriva < posRetornoIdempotente && posCurp < posRetornoIdempotente, '8b. La segunda ejecución NO se da por buena: las comprobaciones de deriva y CURP corren antes del retorno')
  verificar(posRetornoIdempotente < posUpdate, '8c. El retorno idempotente ocurre antes del UPDATE')
  verificar(/and a\.institucion_id is null/.test(sentenciaUpdate), '8d. El UPDATE solo toca filas aún NULL')
  verificar(/\(v_pendientes = c_esperados and v_reparados = 0\)\s*\n\s*or \(v_pendientes = 0 and v_reparados = c_esperados\)/.test(codigoReal), '8e. Solo dos estados válidos: todo pendiente o todo reparado')

  // ============================================================
  // 9. Rechazo ante inconsistencias + atomicidad.
  // ============================================================
  const excepciones = (codigoReal.match(/raise exception/g) || []).length
  verificar(excepciones >= 20, `9. Rechazo explícito ante cada inconsistencia (${excepciones} raise exception)`)
  verificar(!/\bexception\s+when\b/i.test(codigoReal), '9b. 0 EXCEPTION WHEN — ningún error se absorbe')
  verificar((codigoReal.match(/\bdo \$\$/g) || []).length === 1 && /end;\s*\n\$\$;\s*$/.test(codigoReal.trimEnd() + '\n'), '9c. Un solo bloque DO: atómico (cualquier excepción revierte el UPDATE)')
  verificar(!/\bcommit\b|\brollback\b|\bsavepoint\b/i.test(codigoReal), '9d. Sin COMMIT/ROLLBACK/SAVEPOINT parciales')

  // ============================================================
  // 10. Bloqueos.
  // ============================================================
  verificar(/perform set_config\('lock_timeout', '5s', true\);/.test(codigoReal), '10. lock_timeout local acotado (5 s)')
  const posLockAlumnos = posicion('lock table public.alumnos in share row exclusive mode;')
  const posLockGrupos = posicion('lock table public.grupos in share mode;')
  const posLockInsc = posicion('lock table public.inscripciones in share mode;')
  verificar(posLockAlumnos !== -1 && posLockGrupos !== -1 && posLockInsc !== -1, '10b. alumnos SHARE ROW EXCLUSIVE; grupos e inscripciones SHARE')
  verificar(posLockAlumnos < posLockGrupos && posLockGrupos < posLockInsc && posLockInsc < posicion('v_huella_inscripciones_antes\n'), '10c. Bloqueos en orden fijo y antes de cualquier lectura de validación')
  verificar(!/access exclusive|in exclusive mode/i.test(codigoReal), '10d. Sin bloqueos ACCESS EXCLUSIVE/EXCLUSIVE (las lecturas no se bloquean)')

  // ============================================================
  // 11. Sin inferencia por nombre ni CURP.
  // ============================================================
  verificar(!/\bnombre\b/.test(codigoReal), '11. 0 referencia a nombre')
  const usosCurp = codigoReal.match(/\bcurp\b/g) || []
  verificar(usosCurp.length === 3 && posicion('a.curp') > posLockInsc && posicion('a.curp') < posRetornoIdempotente, '11b. curp solo aparece en el cotejo de duplicados, nunca para inferir')
  verificar(!/\bsimilarity\b|\blevenshtein\b|\bilike\b|\blike\b/i.test(codigoReal), '11c. 0 comparación por semejanza')
  verificar(!/perfiles_docentes|docente_contexto_activo/.test(codigoReal), '11d. No infiere por la institución "probable" del docente')

  // ============================================================
  // 12. Constantes y orden de migraciones.
  // ============================================================
  verificar(idsCandidatos.length === 28 && new Set(idsCandidatos).size === 28, '12. 28 ids candidatos distintos y bien formados')
  verificar(/c_esperados constant integer := 28;/.test(codigoReal), '12b. Comprobación de 28 candidatos')
  verificar(codigoReal.includes(`c_institucion constant uuid := '${INSTITUCION}'`), '12c. Institución esperada declarada')
  verificar(/if cardinality\(c_ids\) <> c_esperados/.test(codigoReal), '12d. La migración valida sus propias constantes')
  const migraciones = readdirSync(raiz('supabase', 'migrations')).filter((f) => /^\d{14}_.+\.sql$/.test(f)).sort()
  verificar(migraciones.indexOf(NOMBRE_MIGRACION) < migraciones.indexOf('20261008050000_alta_inscripcion.sql'), '12e. Se ordena antes de B4D2 (alta_inscripcion)')
  verificar(!/anthropic|openai/i.test(migracion), '12f. 0 referencia a IA')

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
