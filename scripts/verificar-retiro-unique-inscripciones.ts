// scripts/verificar-retiro-unique-inscripciones.ts
//
// V1-D2C1-B3 — preparación (NO aplicación) de la migración que retira
// EXCLUSIVAMENTE el UNIQUE total (alumno_id, ciclo_escolar_id) de
// `inscripciones`, conservando el índice parcial de inscripciones
// activas. Ver auditoría READ-ONLY "V1-D2C1-B2 — auditoría estructural
// de inscripciones" y su validación focalizada posterior.
//
// Verificación ESTÁTICA (sin credenciales, sin red, sin DDL/DML
// remoto, sin datos reales) — mismo criterio que el resto de esta
// familia de scripts (ver scripts/verificar-baja-individual-
// inscripcion.ts, scripts/verificar-correccion-contexto-alumno.ts).
// Esta migración es DDL puro de catálogo (DROP CONSTRAINT) — no hay
// lógica de negocio que simular en memoria como en la corrección de
// contexto_alumno; en cambio, esta suite confirma por TEXTO que el
// alcance de la migración es exactamente el autorizado, nada más.
//
// Se ejecuta con `npx tsx scripts/verificar-retiro-unique-inscripciones.ts`.

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
  raiz('supabase', 'migrations', '20261008010000_retirar_unique_total_inscripciones_alumno_ciclo.sql'),
  'utf-8'
)

// Mismo criterio que sinComentariosSql en verificar-baja-individual-
// inscripcion.ts — evita falsos positivos cuando el propio comentario
// menciona, en prosa, un nombre que explícitamente NO se toca.
function sinComentariosSql(contenido: string): string {
  return contenido
    .split('\n')
    .filter((linea) => !linea.trim().startsWith('--'))
    .join('\n')
}
const codigoReal = sinComentariosSql(migracion).trim()

function main() {
  // ============================================================
  // 1. Exactamente UN ALTER TABLE, sobre inscripciones, nada más.
  // ============================================================
  const ocurrenciasAlterTable = (codigoReal.match(/alter table/gi) || []).length
  verificar(ocurrenciasAlterTable === 1, '1. Exactamente 1 ALTER TABLE en el código real de la migración')
  verificar(/alter table public\.inscripciones/i.test(codigoReal), '1b. El ALTER TABLE es sobre public.inscripciones')

  // ============================================================
  // 2. El DROP CONSTRAINT es EXACTAMENTE el UNIQUE total autorizado —
  //    nombre exacto, sin IF EXISTS (fail-closed: si el constraint no
  //    existiera cuando esto se ejecute, debe fallar explícitamente,
  //    nunca un no-op silencioso que oculte un drift de esquema).
  // ============================================================
  verificar(
    /drop constraint inscripciones_alumno_id_ciclo_escolar_id_key\s*;/i.test(codigoReal),
    '2. DROP CONSTRAINT es exactamente inscripciones_alumno_id_ciclo_escolar_id_key, terminado en punto y coma'
  )
  verificar(!/drop constraint if exists/i.test(codigoReal), '2b. Sin "IF EXISTS" — fail-closed, nunca un no-op silencioso')
  const ocurrenciasDropConstraint = (codigoReal.match(/drop constraint/gi) || []).length
  verificar(ocurrenciasDropConstraint === 1, '2c. Exactamente 1 DROP CONSTRAINT en todo el código real')

  // ============================================================
  // 3. El índice parcial de inscripciones activas NUNCA se toca en
  //    código real — solo se menciona en comentarios (documentación
  //    legítima explicando que se conserva).
  // ============================================================
  verificar(!codigoReal.toLowerCase().includes('inscripciones_alumno_ciclo_activo_uk'), '3. El índice parcial de inscripciones activas no aparece en el código real (solo en comentarios)')
  verificar(migracion.toLowerCase().includes('inscripciones_alumno_ciclo_activo_uk'), '3b. El índice parcial SÍ se menciona en los comentarios, documentando explícitamente que se conserva')

  // ============================================================
  // 4. 0 otras restricciones, índices, tablas o columnas tocadas.
  // ============================================================
  verificar(!/drop\s+(table|index|column)/i.test(codigoReal), '4a. 0 DROP TABLE/INDEX/COLUMN en el código real')
  verificar(!/add constraint/i.test(codigoReal), '4b. 0 ADD CONSTRAINT — esta migración solo retira, nunca agrega')
  verificar(!/create\s+(table|index|unique index)/i.test(codigoReal), '4c. 0 CREATE TABLE/INDEX en el código real')

  // ============================================================
  // 5. 0 RLS tocado.
  // ============================================================
  verificar(!/(create|drop|alter)\s+policy/i.test(codigoReal), '5a. 0 CREATE/DROP/ALTER POLICY')
  verificar(!/row level security/i.test(codigoReal), '5b. 0 ENABLE/DISABLE ROW LEVEL SECURITY')

  // ============================================================
  // 6. 0 permisos tocados.
  // ============================================================
  verificar(!/grant\s|revoke\s/i.test(codigoReal), '6. 0 GRANT/REVOKE en el código real')

  // ============================================================
  // 7. 0 función SQL tocada (ni creada, ni reemplazada, ni eliminada).
  // ============================================================
  verificar(!/create\s+(or replace\s+)?function|drop function|alter function/i.test(codigoReal), '7. 0 CREATE/DROP/ALTER FUNCTION — ninguna función SQL se toca')

  // ============================================================
  // 8. 0 DML — no se altera ningún dato real.
  // ============================================================
  verificar(!/insert into|update\s+\S+\s+set|delete from/i.test(codigoReal), '8. 0 INSERT/UPDATE/DELETE — 0 dato real alterado')

  // ============================================================
  // 9. 0 IA.
  // ============================================================
  verificar(!/anthropic|openai/i.test(migracion), '9. La migración no referencia ningún cliente de IA')

  // ============================================================
  // 10. Documentación: las 7 tablas dependientes (FK a
  //     inscripciones.id, confirmadas por catálogo en la auditoría
  //     V1-D2C1-B2) están correctamente listadas en el comentario —
  //     sanity check de que la documentación no quedó desactualizada
  //     respecto a lo confirmado por catálogo.
  // ============================================================
  const TABLAS_DEPENDIENTES_CONFIRMADAS = [
    'asistencia_registro',
    'incidencias',
    'evaluaciones',
    'evidencias',
    'necesidades_apoyo',
    'fichas_descriptivas',
    'seguimiento_resultados',
  ]
  verificar(
    TABLAS_DEPENDIENTES_CONFIRMADAS.every((t) => migracion.includes(t)),
    '10. Las 7 tablas con FK real a inscripciones(id) (confirmadas por catálogo) están listadas en el comentario de la migración'
  )

  // ============================================================
  // 11. Consistencia lógica: el nombre REALMENTE extraído del DROP
  //     CONSTRAINT (no asumido) es distinto del índice que debe
  //     conservarse — evita el error trivial de retirar por accidente
  //     el que debía conservarse.
  // ============================================================
  const coincidenciaDrop = codigoReal.match(/drop constraint (\S+)\s*;/i)
  const nombreRealmenteRetirado: string | undefined = coincidenciaDrop?.[1]
  const indiceQueDebeConservarse = 'inscripciones_alumno_ciclo_activo_uk'
  verificar(
    nombreRealmenteRetirado !== undefined && nombreRealmenteRetirado !== indiceQueDebeConservarse,
    '11. El nombre extraído del DROP CONSTRAINT es distinto del índice que debe conservarse — verificado por extracción real, no asumido'
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
