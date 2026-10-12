// scripts/verificar-cerrar-autovinculacion-docente-grupos.ts
//
// Seguridad — verificación ESTÁTICA (sin credenciales, sin red, sin
// DDL/DML remoto, sin datos reales) de la migración
// 20261011000000_cerrar_autovinculacion_docente_grupos.sql, mismo
// criterio que el resto de esta familia de scripts: se audita el TEXTO
// real de la migración y de sus consumidores en el código.
//
// El comportamiento real (RLS, trigger SECURITY INVOKER, roles sin/con
// BYPASSRLS, permisos efectivos) se validó aparte ejecutando la
// migración en PostgreSQL; este script fija que el texto siga siendo
// exactamente el validado.
//
// Se ejecuta con `npx tsx scripts/verificar-cerrar-autovinculacion-docente-grupos.ts`.

import { readFileSync, readdirSync, statSync } from 'node:fs'
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
const NOMBRE = '20261011000000_cerrar_autovinculacion_docente_grupos.sql'
const migracion = readFileSync(raiz('supabase', 'migrations', NOMBRE), 'utf-8')

const codigoReal = migracion
  .split('\n')
  .filter((linea) => !linea.trim().startsWith('--'))
  .map((linea) => linea.replace(/--.*$/, ''))
  .join('\n')

const posicion = (texto: string) => codigoReal.indexOf(texto)

const inicioPolicy = posicion('alter policy docente_grupos_insert_propio on public.docente_grupos')
const finPolicy = codigoReal.indexOf(';', inicioPolicy)
const sentenciaPolicy = codigoReal.slice(inicioPolicy, finPolicy)

function archivosTs(dir: string): string[] {
  return readdirSync(dir).flatMap((nombre) => {
    const ruta = join(dir, nombre)
    if (statSync(ruta).isDirectory()) return archivosTs(ruta)
    return /\.(ts|tsx)$/.test(nombre) ? [ruta] : []
  })
}
const fuentesApp = [...archivosTs(raiz('app')), ...archivosTs(raiz('lib'))].map((ruta) => ({ ruta, texto: readFileSync(ruta, 'utf-8') }))

function main() {
  // ============================================================
  // 1. Atomicidad y orden.
  // ============================================================
  verificar(/^begin;$/m.test(codigoReal) && /^commit;$/m.test(codigoReal), '1. Transacción explícita BEGIN … COMMIT (atómica)')
  verificar(posicion('begin;') < posicion('do $$') && posicion('do $$') < inicioPolicy && inicioPolicy < posicion('revoke execute') && posicion('revoke execute') < posicion('commit;'), '1b. Orden: BEGIN → precondición → ALTER POLICY → REVOKE → COMMIT')
  verificar(!/\bexception\s+when\b/i.test(codigoReal), '1c. Ningún error se absorbe (0 EXCEPTION WHEN)')

  // ============================================================
  // 2. Precondición sobre filas existentes y objetos.
  // ============================================================
  const bloquePre = codigoReal.slice(posicion('do $$'), inicioPolicy)
  verificar(/p\.policyname = 'docente_grupos_insert_propio'/.test(bloquePre) && /p\.cmd = 'INSERT'/.test(bloquePre), '2. Verifica que exista la policy INSERT a endurecer')
  verificar(/to_regprocedure\('public\.compartir_grupo_con_docente\(uuid, uuid, text\)'\) is null/.test(bloquePre), '2b. Verifica que exista compartir_grupo_con_docente con la firma exacta')
  verificar(/left join public\.grupos g on g\.id = dg\.grupo_id/.test(bloquePre), '2c. Contrasta cada fila con el propietario actual del grupo')
  verificar(/dg\.docente_id <> g\.docente_id/.test(bloquePre) && /dg\.rol <> 'titular'/.test(bloquePre) && /dg\.compartido_por is not null/.test(bloquePre) && /g\.id is null/.test(bloquePre), '2d. Aborta ante filas ajenas, no titulares, con compartido_por o huérfanas')
  verificar((bloquePre.match(/raise exception 'PRECONDICION_FALLIDA/g) || []).length === 3, '2e. 3 rechazos explícitos de precondición')

  // ============================================================
  // 3. Policy endurecida.
  // ============================================================
  verificar(inicioPolicy !== -1, '3. ALTER POLICY docente_grupos_insert_propio (conserva nombre, comando y roles)')
  verificar(/with check \(/.test(sentenciaPolicy) && !/\busing\b/.test(sentenciaPolicy) && !/\bto\b\s+\w/.test(sentenciaPolicy.replace(/auth\.uid\(\)/g, '')), '3b. Solo cambia WITH CHECK (no USING, no roles)')
  verificar(/docente_id = auth\.uid\(\)/.test(sentenciaPolicy), '3c. docente_id = auth.uid()')
  verificar(/and rol = 'titular'/.test(sentenciaPolicy), "3d. Solo rol = 'titular'")
  verificar(/and compartido_por is null/.test(sentenciaPolicy), '3e. compartido_por IS NULL')
  verificar(/from public\.grupos g\s*\n\s*where g\.id = docente_grupos\.grupo_id\s*\n\s*and g\.docente_id = auth\.uid\(\)/.test(sentenciaPolicy), '3f. Propiedad ACTUAL del grupo: public.grupos.docente_id = auth.uid()')
  verificar(!/docente_instituciones|perfiles_docentes|docente_grupos dg/.test(sentenciaPolicy), '3g. No depende de roles institucionales autodeclarados ni de otras filas de docente_grupos')

  // ============================================================
  // 4. REVOKE de compartir_grupo_con_docente; sin reabrir nada.
  // ============================================================
  for (const rol of ['public', 'anon', 'authenticated']) {
    verificar(codigoReal.includes(`revoke execute on function public.compartir_grupo_con_docente(uuid, uuid, text) from ${rol};`), `4. EXECUTE revocado de ${rol}`)
  }
  verificar(!/\bgrant\b/i.test(codigoReal), '4b. 0 GRANT (no se habilita compartir para nadie; service_role/propietario conservan lo que ya tenían)')
  verificar(!/service_role/.test(codigoReal), '4c. No toca los permisos de service_role')

  // ============================================================
  // 5. Conservación de datos e historial; alcance.
  // ============================================================
  verificar(!/\b(insert\s+into|update\s+public\.|delete\s+from|truncate)\b/i.test(codigoReal), '5. 0 INSERT/UPDATE/DELETE/TRUNCATE: las filas existentes se conservan')
  verificar(!/\b(create|drop)\s+(table|policy|function|trigger|index)\b/i.test(codigoReal) && !/\balter\s+(table|function)\b/i.test(codigoReal), '5b. 0 CREATE/DROP/ALTER TABLE o FUNCTION: trigger, fn_sync y demás objetos intactos')
  verificar(!/fn_sync_docente_grupo|trg_sync_docente_grupo/.test(codigoReal), '5c. fn_sync_docente_grupo y su trigger no se modifican')
  verificar(!/\b(docente_instituciones|perfiles_docentes|alumnos|inscripciones)\b/.test(codigoReal), '5d. No toca docente_instituciones, perfiles_docentes, alumnos ni inscripciones')
  verificar((codigoReal.match(/\balter policy\b/g) || []).length === 1, '5e. Exactamente 1 policy modificada; las 10 policies consumidoras quedan igual')

  // ============================================================
  // 6. Consumidores legítimos en el código.
  // ============================================================
  const nuevoGrupo = readFileSync(raiz('app', 'dashboard', 'grupos', 'nuevo', 'page.tsx'), 'utf-8')
  verificar(/\.from\('grupos'\)\s*\n\s*\.insert\(\{[\s\S]*?docente_id: docenteId,/.test(nuevoGrupo), '6. La creación de grupos inserta con docente_id del propio docente → el trigger crea su titular (caso permitido)')
  const escriturasDirectasDg = fuentesApp.filter(({ texto }) => /from\('docente_grupos'\)\s*\.\s*(insert|upsert|update|delete)/.test(texto.replace(/\s+/g, ' ')))
  verificar(escriturasDirectasDg.length === 0, '6b. Ninguna escritura directa a docente_grupos desde app/ o lib/ (solo el trigger)')
  const llamadasCompartir = fuentesApp.filter(({ texto }) => /compartirGrupoConDocente\(/.test(texto.replace(/export async function compartirGrupoConDocente\(/g, '')))
  verificar(llamadasCompartir.length === 0, '6c. compartirGrupoConDocente no tiene llamadores → el REVOKE no rompe ningún flujo')

  // ============================================================
  // 7. Rollback documentado y orden de migraciones.
  // ============================================================
  verificar(/alter policy docente_grupos_insert_propio on public\.docente_grupos\s*\n--\s+with check \(docente_id = auth\.uid\(\)\);/.test(migracion), '7. Rollback documentado en la cabecera')
  const migraciones = readdirSync(raiz('supabase', 'migrations')).filter((f) => /^\d{14}_[^ ]+\.sql$/.test(f)).sort()
  verificar(migraciones.indexOf(NOMBRE) > migraciones.indexOf('20261008050000_alta_inscripcion.sql'), '7b. Se ordena después de 20261008050000 (alta_inscripcion)')
  verificar(!/anthropic|openai/i.test(migracion), '7c. 0 referencias a IA')

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
