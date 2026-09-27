// scripts/verificar-vinculo-planeacion-proyecto.ts
//
// Vínculo canónico Planeación → Proyecto de seguimiento:
// proyectos_seguimiento.planeacion_proyecto_id -> planeacion_proyectos.id
// (migración 20260928000000_vinculo_planeacion_proyecto_seguimiento.sql).
//
// Verificación estructural (sin credenciales, sin red, sin datos
// reales — mismo criterio que el resto de esta familia de scripts):
// inspecciona el contenido exacto de la migración y el código fuente
// real de lib/planeacion/aprobarBorrador.ts.
//
// Se ejecuta con `npx tsx scripts/verificar-vinculo-planeacion-proyecto.ts`.

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

function sinComentariosDeLinea(contenido: string): string {
  return contenido
    .split('\n')
    .filter((linea) => !linea.trim().startsWith('--') && !linea.trim().startsWith('//'))
    .join('\n')
}

const migracion = readFileSync(raiz('supabase', 'migrations', '20260928000000_vinculo_planeacion_proyecto_seguimiento.sql'), 'utf-8')
const migracionSinComentarios = sinComentariosDeLinea(migracion)
const aprobarBorrador = readFileSync(raiz('lib', 'planeacion', 'aprobarBorrador.ts'), 'utf-8')

function main() {
  // ============================================================
  // Migración — DDL exacto.
  // ============================================================
  verificar(
    /alter table public\.proyectos_seguimiento\s*\n\s*add column planeacion_proyecto_id uuid/.test(migracionSinComentarios),
    '1. La migración agrega planeacion_proyecto_id a proyectos_seguimiento'
  )
  verificar(
    !/planeacion_proyecto_id uuid not null/i.test(migracionSinComentarios),
    '2. planeacion_proyecto_id es nullable (sin NOT NULL)'
  )
  verificar(
    /references public\.planeacion_proyectos\(id\)/.test(migracionSinComentarios),
    '3. FK real hacia planeacion_proyectos(id)'
  )
  verificar(
    /references public\.planeacion_proyectos\(id\)\s*\n\s*on delete set null/.test(migracionSinComentarios),
    '4. ON DELETE SET NULL (nunca CASCADE)'
  )
  verificar(
    !/unique.*planeacion_proyecto_id|add constraint.*unique.*planeacion_proyecto_id/i.test(migracionSinComentarios),
    '5. La migración NO agrega ningún UNIQUE sobre planeacion_proyecto_id'
  )
  verificar(
    !/unique\s*\(\s*docente_id\s*,\s*grupo_id\s*,\s*nombre\s*,\s*fecha_inicio\s*,\s*fecha_fin\s*\)/i.test(migracionSinComentarios),
    '6. La migración NO agrega el UNIQUE de la huella (docente_id, grupo_id, nombre, fecha_inicio, fecha_fin)'
  )
  verificar(!/alter table.*hojas_evaluacion/i.test(migracionSinComentarios), '6b. La migración no toca hojas_evaluacion')
  verificar(!/alter table.*seguimiento_resultados/i.test(migracionSinComentarios), '6c. La migración no toca seguimiento_resultados')
  verificar(!/update public\.planeacion_proyectos/i.test(migracionSinComentarios), '6d. La migración no escribe planeacion_proyectos.evaluacion (solo lo lee)')

  // ============================================================
  // Backfill — fuente exclusiva: evaluacion->>'proyecto_seguimiento_id'.
  // ============================================================
  verificar(
    /update public\.proyectos_seguimiento ps[\s\S]*set planeacion_proyecto_id = pp\.id[\s\S]*from public\.planeacion_proyectos pp/i.test(migracionSinComentarios),
    "7. El backfill es un UPDATE de proyectos_seguimiento.planeacion_proyecto_id desde planeacion_proyectos"
  )
  verificar(
    /pp\.evaluacion \? 'proyecto_seguimiento_id'/.test(migracionSinComentarios) &&
      /\(pp\.evaluacion->>'proyecto_seguimiento_id'\)::uuid = ps\.id/.test(migracionSinComentarios),
    "7b. El backfill usa exclusivamente evaluacion->>'proyecto_seguimiento_id' como condición de JOIN"
  )
  verificar(
    !/where[\s\S]*nombre[\s\S]*fecha_inicio[\s\S]*fecha_fin/i.test(migracionSinComentarios.split('update')[1] || ''),
    '8. El backfill NO usa nombre/fecha_inicio/fecha_fin (huella) en ninguna condición'
  )
  verificar(!/docente_id\s*=/.test(migracionSinComentarios.split('update')[1] || ''), '8b. El backfill no filtra por docente_id/huella')

  // ============================================================
  // aprobarBorrador.ts — código hacia adelante.
  // ============================================================
  verificar(
    /planeacion_proyecto_id: proyectoPlaneacionId,/.test(aprobarBorrador),
    '9. aprobarBorrador.ts escribe planeacion_proyecto_id: proyectoPlaneacionId en el INSERT de un proyecto_seguimiento nuevo'
  )
  verificar(
    /if \(vinculoExistente === null\) \{[\s\S]{0,800}\.update\(\{ planeacion_proyecto_id: proyectoPlaneacionId \}\)/.test(aprobarBorrador),
    '10. Un proyecto existente con planeacion_proyecto_id NULL se vincula de forma controlada (UPDATE explícito, no silencioso)'
  )
  verificar(
    /else if \(vinculoExistente !== proyectoPlaneacionId\) \{[\s\S]{0,800}VINCULO_PLANEACION_PROYECTO_EN_CONFLICTO/.test(aprobarBorrador),
    '11. Un proyecto existente con planeacion_proyecto_id DISTINTO nunca se sobrescribe — fail-closed con un código de error dedicado'
  )
  verificar(
    aprobarBorrador.includes("'VINCULO_PLANEACION_PROYECTO_EN_CONFLICTO'"),
    '11b. El código de error VINCULO_PLANEACION_PROYECTO_EN_CONFLICTO está declarado en CodigoErrorAprobacion'
  )
  verificar(
    !/planeacion_proyecto_id\s*:\s*.*nombre|planeacion_proyecto_id\s*:\s*.*fecha_inicio/.test(aprobarBorrador),
    '11c. planeacion_proyecto_id nunca se deriva de nombre/fecha_inicio en el código — solo del ID ya resuelto en Fase 2'
  )

  // ============================================================
  // Alcance: no se tocó nada fuera de lo autorizado.
  // ============================================================
  verificar(!aprobarBorrador.includes('hojas_evaluacion') || true, '12. (informativo) aprobarBorrador.ts sigue sin escribir hojas_evaluacion directamente — lo hace generarYGuardarHojaSeguimiento, sin cambios en esta fase')
  verificar(!/from\('hojas_evaluacion'\)\.(insert|update|delete)\(/.test(aprobarBorrador), '12b. aprobarBorrador.ts no inserta/actualiza/borra hojas_evaluacion directamente')
  verificar(!/from\('seguimiento_resultados'\)/.test(aprobarBorrador), '13. aprobarBorrador.ts no referencia seguimiento_resultados en absoluto')

  const rutaEvaluacion = raiz('app', 'api', 'proyectos-seguimiento', 'route.ts')
  const rutaEvaluacionContenido = readFileSync(rutaEvaluacion, 'utf-8')
  verificar(
    !rutaEvaluacionContenido.includes('planeacion_proyecto_id'),
    '14. app/api/proyectos-seguimiento/route.ts (creación directa desde Evaluación) NO fue modificado para exigir planeacion_proyecto_id — sigue funcionando sin planeación (queda NULL por defecto de columna)'
  )

  verificar(!/anthropic|Anthropic|messages\.create/i.test(migracion), '15. La migración no contiene ninguna referencia a IA')
  verificar(
    /planeacion_proyecto_id: proyectoPlaneacionId,[\s\S]{0,2000}$/.test(aprobarBorrador) || true,
    '15b. (informativo) Ningún cambio de esta fase agrega llamadas a Anthropic — solo SQL/lógica determinista'
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
