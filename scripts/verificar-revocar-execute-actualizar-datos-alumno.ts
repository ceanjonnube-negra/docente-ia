// scripts/verificar-revocar-execute-actualizar-datos-alumno.ts
//
// Seguridad — verificación ESTÁTICA (sin credenciales, sin red, sin
// DDL/DML remoto, sin datos reales) de la migración
// 20261012000000_revocar_execute_actualizar_datos_alumno.sql y de la
// ausencia de consumidores de la RPC en el código. Mismo criterio que
// el resto de esta familia de scripts: se audita el TEXTO real.
//
// El comportamiento real (permisos efectivos por rol, precondición por
// md5, atomicidad) se validó aparte ejecutando la migración en
// PostgreSQL; este script fija que el texto siga siendo el validado.
//
// Se ejecuta con `npx tsx scripts/verificar-revocar-execute-actualizar-datos-alumno.ts`.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

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
const NOMBRE = '20261012000000_revocar_execute_actualizar_datos_alumno.sql'
const FIRMA = 'public.actualizar_datos_alumno(uuid, text, text, text, date)'
const migracion = readFileSync(raiz('supabase', 'migrations', NOMBRE), 'utf-8')

const codigoReal = migracion
  .split('\n')
  .filter((linea) => !linea.trim().startsWith('--'))
  .map((linea) => linea.replace(/--.*$/, ''))
  .join('\n')

const posicion = (texto: string) => codigoReal.indexOf(texto)

function archivosTs(dir: string): string[] {
  return readdirSync(dir).flatMap((nombre) => {
    const ruta = join(dir, nombre)
    if (statSync(ruta).isDirectory()) return archivosTs(ruta)
    return /\.(ts|tsx)$/.test(nombre) ? [ruta] : []
  })
}
const fuentes = ['app', 'lib', 'components']
  .filter((d) => {
    try {
      return statSync(raiz(d)).isDirectory()
    } catch {
      return false
    }
  })
  .flatMap((d) => archivosTs(raiz(d)))
  .map((ruta) => ({ ruta: relative(raiz(), ruta), texto: readFileSync(ruta, 'utf-8') }))

function main() {
  // ============================================================
  // 1. Atomicidad, orden y precondición.
  // ============================================================
  verificar(/^begin;$/m.test(codigoReal) && /^commit;$/m.test(codigoReal), '1. Transacción explícita BEGIN … COMMIT (atómica)')
  verificar(posicion('begin;') < posicion('do $$') && posicion('do $$') < posicion('revoke execute') && posicion('revoke execute') < posicion('commit;'), '1b. Orden: BEGIN → precondición → REVOKE → COMMIT')
  verificar(codigoReal.includes(`to_regprocedure('${FIRMA}') is null`), '1c. Aborta si no existe la función con la firma exacta')
  verificar(/md5\(pg_catalog\.pg_get_functiondef\('public\.actualizar_datos_alumno\(uuid, text, text, text, date\)'::regprocedure\)\)\s*\n\s*<> '7c0ce1f39e62fdf91ec875d5a1ab5d6f'/.test(codigoReal), '1d. Aborta si la definición difiere de la auditada (md5 7c0ce1f3…)')
  verificar((codigoReal.match(/raise exception 'PRECONDICION_FALLIDA/g) || []).length === 2, '1e. 2 rechazos explícitos de precondición')
  verificar(!/\bexception\s+when\b/i.test(codigoReal), '1f. Ningún error se absorbe')

  // ============================================================
  // 2. Exclusivamente REVOKE, a los tres roles.
  // ============================================================
  for (const rol of ['public', 'anon', 'authenticated']) {
    verificar(codigoReal.includes(`revoke execute on function ${FIRMA} from ${rol};`), `2. EXECUTE revocado de ${rol}`)
  }
  verificar((codigoReal.match(/\brevoke\b/gi) || []).length === 3, '2b. Exactamente 3 REVOKE, todos sobre esta función')
  verificar(!/\bgrant\b/i.test(codigoReal), '2c. 0 GRANT (no se otorga nada a nadie)')
  verificar(!/service_role|postgres\b/.test(codigoReal.replace(/pg_catalog/g, '')), '2d. No toca los permisos de postgres ni de service_role (conservan EXECUTE)')

  // ============================================================
  // 3. Sin cambios de definición, tablas, policies ni datos.
  // ============================================================
  verificar(!/\b(create|drop)\s+(or\s+replace\s+)?(function|table|policy|trigger|view|index)\b/i.test(codigoReal), '3. 0 CREATE/DROP: cuerpo y firma de la función intactos')
  verificar(!/\balter\s+(function|table|policy)\b/i.test(codigoReal), '3b. 0 ALTER (ni SECURITY DEFINER, ni propietario, ni tablas, ni policies)')
  verificar(!/\b(insert\s+into|update\s+public\.|delete\s+from|truncate)\b/i.test(codigoReal), '3c. 0 DML')
  verificar(!/\b(alumnos|inscripciones|docente_grupos)\b/.test(codigoReal), '3d. No referencia tablas')

  // ============================================================
  // 4. Ausencia de consumidores activos.
  // ============================================================
  const llamadasRpc = fuentes.filter(({ texto }) => /rpc\(\s*['"]actualizar_datos_alumno['"]/.test(texto))
  verificar(llamadasRpc.length === 1 && llamadasRpc[0].ruta === join('lib', 'motorContexto.ts'), '4. La única llamada a la RPC es la envoltura en lib/motorContexto.ts')
  const usosEnvoltura = fuentes.filter(({ texto }) =>
    /\bactualizarDatosAlumno\b/.test(texto.replace(/export async function actualizarDatosAlumno\(/g, ''))
  )
  verificar(usosEnvoltura.length === 0, '4b. La envoltura actualizarDatosAlumno no se importa ni se llama en ningún archivo')

  // ============================================================
  // 5. Los flujos reales de edición usan otros mecanismos.
  // ============================================================
  const ficha = readFileSync(raiz('app', 'dashboard', 'lista', '[alumnoId]', 'page.tsx'), 'utf-8')
  verificar(/\.from\('alumnos'\)\s*\n\s*\.update\(\{/.test(ficha), '5. Ficha individual: UPDATE directo bajo RLS (sin esta RPC)')
  const motor = readFileSync(raiz('lib', 'motorContexto.ts'), 'utf-8')
  verificar(/sb\.rpc\('confirmar_correccion_alumno', \{/.test(motor) && !/actualizar_datos_alumno/.test(motor.replace(/export async function actualizarDatosAlumno\([\s\S]*?\n\}/, '')), '5b. Chat IA: corrección de campo vía confirmar_correccion_alumno (C4, sin esta RPC)')
  const corregirCurp = readFileSync(raiz('app', 'api', 'importar-alumnos', 'corregir-curp', 'route.ts'), 'utf-8')
  verificar(/rpc\('reparar_curp_desde_lista_oficial'/.test(corregirCurp), '5c. Lista oficial: reparar_curp_desde_lista_oficial (sin esta RPC)')

  // ============================================================
  // 6. Rollback documentado y orden de migraciones.
  // ============================================================
  verificar(/--\s+grant execute on function public\.actualizar_datos_alumno\(uuid, text, text, text, date\)\s*\n--\s+to public, anon, authenticated;/.test(migracion), '6. Rollback documentado en la cabecera')
  const migraciones = readdirSync(raiz('supabase', 'migrations')).filter((f) => /^\d{14}_[^ ]+\.sql$/.test(f)).sort()
  verificar(migraciones.indexOf(NOMBRE) > migraciones.indexOf('20261011000000_cerrar_autovinculacion_docente_grupos.sql'), '6b. Se ordena después de 20261011000000 (cierre de autovinculación)')
  verificar(!/anthropic|openai/i.test(migracion), '6c. 0 referencias a IA')

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
