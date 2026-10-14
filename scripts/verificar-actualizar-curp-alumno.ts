// scripts/verificar-actualizar-curp-alumno.ts
//
// Verificación ESTÁTICA (sin credenciales, sin red, sin DDL/DML remoto,
// sin datos reales) de la migración 20261014000000_actualizar_curp_alumno.sql:
// primitiva canónica de corrección de CURP de un alumno propio. Todavía no
// la usa ningún consumidor (Chat y ficha se migrarán después).
//
// Incluye la PARIDAD TS/SQL del validador de CURP: CORPUS_DORADO contiene
// casos cuyos resultados esperados (validez y forma normalizada) se
// obtuvieron ejecutando la normalización de esta migración y
// public.validar_estructura_curp_sql real en PostgreSQL. Aquí se exige que
// el validador TypeScript del Chat (validarValorCampoAlumno) dé exactamente
// lo mismo; la versión SQL queda fijada por el md5 de la precondición.
//
// El comportamiento real (casos 1-10, concurrencia con T0, deadlocks) se
// validó aparte ejecutando la migración en PostgreSQL.
//
// Se ejecuta con `npx tsx scripts/verificar-actualizar-curp-alumno.ts`.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { validarValorCampoAlumno } from '../lib/motorContexto'

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
const NOMBRE = '20261014000000_actualizar_curp_alumno.sql'
const FIRMA = 'public.actualizar_curp_alumno(uuid, text, text, text, uuid)'
const migracion = readFileSync(raiz('supabase', 'migrations', NOMBRE), 'utf-8')
const migracionT0 = readFileSync(raiz('supabase', 'migrations', '20261013000000_cotejo_curp_por_docente.sql'), 'utf-8')

function sinComentarios(codigo: string): string {
  return codigo
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n')
}
const codigoReal = sinComentarios(migracion)
const inicioCuerpo = codigoReal.indexOf('create function public.actualizar_curp_alumno(')
const apertura = codigoReal.indexOf('as $$', inicioCuerpo) + 'as $$'.length
const cierre = codigoReal.indexOf('$$;', apertura)
const cabeceraFn = codigoReal.slice(inicioCuerpo, apertura)
const cuerpo = codigoReal.slice(apertura, cierre)
const exterior = codigoReal.slice(0, inicioCuerpo) + codigoReal.slice(cierre)
const pos = (t: string) => cuerpo.indexOf(t)

// [entrada, válida según SQL, forma normalizada según SQL]
const CORPUS_DORADO: [string, boolean, string | null][] = [
  ["GOMA800101HNTRRL09", true, "GOMA800101HNTRRL09"],
  ["GOMA800229HNERRL09", true, "GOMA800229HNERRL09"],
  ["GOMA800230HNTRRL09", false, null],
  ["GOMA800431HNTRRL09", false, null],
  ["GOMA801301HNTRRL09", false, null],
  ["GOMA800001HNTRRL09", false, null],
  ["GOMA800100HNTRRL09", false, null],
  ["GOMA800132HNTRRL09", false, null],
  ["GOMA800101XNTRRL09", false, null],
  ["GOMA800101HZZRRL09", false, null],
  ["GOMA800101HNTARL09", false, null],
  ["GOMA800101HNTRRL0A", false, null],
  ["GOMA800101HNTRRL\u00d19", false, null],
  ["G\u00d1MA800101HNTRRL09", false, null],
  ["G0MA800101HNTRRL09", false, null],
  ["GBMA800101HNTRRL09", false, null],
  ["GOMA800101HNTRRL0", false, null],
  ["GOMA800101HNTRRL091", false, null],
  ["", false, null],
  ["   ", false, null],
  ["goma800101hntrrl09", true, "GOMA800101HNTRRL09"],
  [" GOMA800101HNTRRL09 ", true, "GOMA800101HNTRRL09"],
  ["GOMA 800101 HNT RRL09", true, "GOMA800101HNTRRL09"],
  ["GOMA800101\tHNTRRL09", true, "GOMA800101HNTRRL09"],
  ["GOMA800101\nHNTRRL09", true, "GOMA800101HNTRRL09"],
  ["GOMA\u00a0800101HNTRRL09", true, "GOMA800101HNTRRL09"],
  ["GOMA\u2003800101HNTRRL09", true, "GOMA800101HNTRRL09"],
  ["GOMA\u3000800101HNTRRL09", true, "GOMA800101HNTRRL09"],
  ["\ufeffGOMA800101HNTRRL09", true, "GOMA800101HNTRRL09"],
  ["GOMA\u200b800101HNTRRL09", false, null],
  ["GOMA800101HNTRRL\u202f09", true, "GOMA800101HNTRRL09"],
  ["GOMA800101HNTRRL09\u2028", true, "GOMA800101HNTRRL09"],
  ["QXRR170810MSPWTK21", true, "QXRR170810MSPWTK21"],
  ["EAWN241019HZSCWC77", true, "EAWN241019HZSCWC77"],
  ["VXIM680508HOCBPBL8", true, "VXIM680508HOCBPBL8"],
  ["AIOT560114HZSPGG71", true, "AIOT560114HZSPGG71"],
  ["GXHK450530MNELXB72", true, "GXHK450530MNELXB72"],
  ["MXCG651020MTCFMJG9", true, "MXCG651020MTCFMJG9"],
  ["VUNO660601HJCVNM71", true, "VUNO660601HJCVNM71"],
  ["DENS190602HCMWQJ68", true, "DENS190602HCMWQJ68"],
  ["SUEU710719MJCJPT52", true, "SUEU710719MJCJPT52"],
  ["XXWK150420HCHGQX10", true, "XXWK150420HCHGQX10"],
  ["GIJE32022YHCMJHJH8", false, null],
  ["CEQC1J0522MPLMKNQ2", false, null],
  ["IEHP6405L1MASQDKL9", false, null],
  ["YUPJ66012*HPLNVTK9", false, null],
  ["PAAU521201HASHPJ44", true, "PAAU521201HASHPJ44"],
  ["RXA-810228HMCYVHQ3", false, null],
  ["SOEE8204215CMSLKG3", false, null],
  ["DEWE87112OHMNCDP70", false, null],
  ["QEOS640314H\u00d1GPKH58", false, null],
  ["RIHC830618MHGRXH7a", false, null],
  ["*EYK600315HPLSYY00", false, null],
  ["EAMVN90614MSRGMDH9", false, null],
  ["DEAR011110HCCNZLT3", true, "DEAR011110HCCNZLT3"],
  ["AEPY700423HGTRPSXA", false, null],
  ["VIHG2T0530MASYZR82", false, null],
  ["FIGS881L05HDGGFCE3", false, null],
  ["OIHT191226HDGMXQV9", true, "OIHT191226HDGMXQV9"],
  ["SUKI5U0223MTLHJLQ6", false, null],
  ["3URD980309MGRTZWF3", false, null],
  ["SXNS311209HCSFPTJJ", false, null],
  ["VXKG520812HB\ufeffslndp3", true, "VXKG520812HBSLNDP3"],
  ["BXBS170 328hchyhf67", true, "BXBS170328HCHYHF67"],
  ["OOZH42110 2mjcjtby1", true, "OOZH421102MJCJTBY1"],
  ["SE\u2003nj190702mqojklw2", true, "SENJ190702MQOJKLW2"],
  ["DXGJ60\u30000309hcmrmqk1", true, "DXGJ600309HCMRMQK1"],
  ["QEJZ\u2003460106hntqmm90", true, "QEJZ460106HNTQMM90"],
  ["VEAH150116HQRJD\u00a0w60", true, "VEAH150116HQRJDW60"],
  ["EUTK810\t614mdfysnz3", true, "EUTK810614MDFYSNZ3"],
  ["RABD21072\u20033hcsmtyt3", true, "RABD210723HCSMTYT3"],
  ["TETD280211M dffwpr8", true, "TETD280211MDFFWPR8"],
]

function main() {
  // 1. Atomicidad, alcance aditivo y fail-closed.
  verificar(/^begin;$/m.test(codigoReal) && /^commit;$/m.test(codigoReal), '1. BEGIN … COMMIT (atómica)')
  verificar((codigoReal.match(/\bcreate function\b/g) || []).length === 1 && !/create or replace/i.test(codigoReal), '1b. Exactamente 1 CREATE FUNCTION, sin OR REPLACE (fail-closed)')
  verificar(!/\b(alter|drop|truncate|create\s+(table|index|policy|trigger|view))\b/i.test(exterior), '1c. 0 ALTER/DROP/TRUNCATE/tablas/índices/políticas/triggers: puramente aditiva')
  verificar(!/\b(insert\s+into|update\s+public\.|delete\s+from)\b/i.test(exterior), '1d. 0 DML fuera del cuerpo de la función')
  verificar(!/\b(grant|revoke)\b[^;]*\bon\s+(table\s+)?public\.(alumnos|correcciones_alumno|conversaciones_chat)\b/i.test(exterior), '1e. No toca los permisos de alumnos, correcciones_alumno ni conversaciones_chat')

  // 2. Precondiciones.
  verificar(exterior.includes(`to_regprocedure('${FIRMA}') is not null`), '2. Precondición: la función no debe existir')
  verificar(exterior.includes("md5(pg_catalog.pg_get_functiondef('public.validar_estructura_curp_sql(text)'::regprocedure)) <> '920b06858384aa919dc84cc000007eb8'"), '2b. Precondición: validar_estructura_curp_sql con el md5 auditado (920b0685…)')
  verificar(exterior.includes("'CHECK ((fuente = ANY (ARRAY[''documento''::text, ''imagen''::text, ''texto''::text, ''voz''::text, ''manual''::text])))'"), '2c. Precondición: CHECK real de correcciones_alumno.fuente')
  verificar(/table_name = 'conversaciones_chat' and column_name = 'docente_id'/.test(exterior), '2d. Precondición: conversaciones_chat.docente_id')

  // 3. Contrato y seguridad de la función.
  verificar(/create function public\.actualizar_curp_alumno\(\s*p_alumno_id uuid,\s*p_curp_esperada_actual text,\s*p_curp_nueva text,\s*p_fuente text,\s*p_conversacion_id uuid\s*\)\s*returns jsonb\s*language plpgsql\s*security invoker\s*set search_path = ''/.test(cabeceraFn), '3. Firma exacta, returns jsonb, SECURITY INVOKER, search_path vacío')
  verificar(/v_docente_id uuid := auth\.uid\(\);/.test(cuerpo) && /if v_docente_id is null then\s*raise exception 'AUTH_REQUIRED';/.test(cuerpo), '3b. Identidad por auth.uid(); sin sesión → AUTH_REQUIRED')
  verificar(!/institucion_id/.test(cuerpo) && !/docente_grupos/.test(cuerpo), '3c. Sin institución ni docente_grupos: propiedad solo por docente')

  // 4. Orden exacto de pasos y bloqueos (compatible con T0).
  const orden = [
    "raise exception 'AUTH_REQUIRED'",
    "raise exception 'INVALID_SOURCE'",
    "raise exception 'CONVERSATION_NOT_AUTHORIZED'",
    "raise exception 'NEW_CURP_INVALID'",
    'for update of a;',
    "raise exception 'STALE_CURRENT_VALUE'",
    "'resultado', 'sin_cambios'",
    'perform pg_advisory_xact_lock(',
    "raise exception 'NEW_CURP_DUPLICATE'",
    'update public.alumnos',
    'insert into public.correcciones_alumno',
    "'resultado', 'actualizado'",
  ].map(pos)
  verificar(orden.every((p) => p !== -1) && orden.every((p, i) => i === 0 || orden[i - 1] < p), '4. Orden: sesión → fuente → conversación → CURP nueva → fila FOR UPDATE → compare-and-set → sin_cambios → advisory → duplicado → UPDATE → trazabilidad → respuesta')
  verificar((cuerpo.match(/pg_advisory_xact_lock\(/g) || []).length === 1 && cuerpo.includes("perform pg_advisory_xact_lock(hashtextextended(v_docente_id::text || ':' || v_curp_nueva, 0::bigint));"), '4b. Exactamente 1 advisory lock, con la clave docente_id + CURP normalizada')
  verificar(migracionT0.includes("hashtextextended(v_docente_id::text || ':' || v_curp_norm, 0::bigint)") && migracionT0.includes("hashtextextended(v_docente_id::text || ':' || v_curp_nueva_norm, 0::bigint)"), '4c. Misma forma de clave que las funciones de T0 (se serializan entre sí)')
  verificar(!/pg_advisory_lock\(|pg_advisory_unlock\(/.test(cuerpo) && !/\bexception\s+when\b/i.test(cuerpo), '4d. Solo locks transaccionales y ningún error absorbido: sin escrituras parciales')

  // 5. Alumno propio y mismo error para ajeno e inexistente.
  verificar(/where a\.id = p_alumno_id\s*and a\.docente_id = v_docente_id\s*for update of a;/.test(cuerpo), '5. El alumno se lee y bloquea solo si es del docente (FOR UPDATE)')
  verificar((cuerpo.match(/raise exception 'STUDENT_NOT_AUTHORIZED';/g) || []).length === 2 && /if p_alumno_id is null then\s*raise exception 'STUDENT_NOT_AUTHORIZED';/.test(cuerpo) && /if not found then\s*raise exception 'STUDENT_NOT_AUTHORIZED';/.test(cuerpo), '5b. Mismo STUDENT_NOT_AUTHORIZED para nulo, inexistente y ajeno')

  // 6. Compare-and-set NULL-seguro y sin_cambios estable.
  verificar(/if v_curp_actual is distinct from p_curp_esperada_actual then\s*raise exception 'STALE_CURRENT_VALUE';/.test(cuerpo), '6. Compare-and-set NULL-seguro (is distinct from)')
  verificar(/and curp is not distinct from p_curp_esperada_actual;\s*get diagnostics v_filas = row_count;\s*if v_filas <> 1 then\s*raise exception 'STALE_CURRENT_VALUE';/.test(cuerpo), '6b. El UPDATE repite el compare-and-set y exige 1 fila')
  verificar(/if v_curp_actual is not distinct from v_curp_nueva then\s*return jsonb_build_object\('resultado', 'sin_cambios', 'alumno_id', p_alumno_id, 'curp', v_curp_nueva\);/.test(cuerpo), '6c. sin_cambios: respuesta estable y sin escribir')

  // 7. CURP nueva: normalización y validación SQL canónica.
  const regex = (cuerpo.match(/regexp_replace\(coalesce\(p_curp_nueva, ''\),\s*'([^']+)', '', 'g'\)/) || [])[1] || ''
  verificar(regex === '[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]', '7. Elimina exactamente los espacios de \\s de JavaScript (misma regla que el Chat), escritos como escapes ASCII')
  verificar(/v_curp_nueva := upper\(regexp_replace\(/.test(cuerpo) && /if not public\.validar_estructura_curp_sql\(v_curp_nueva\) then\s*raise exception 'NEW_CURP_INVALID';/.test(cuerpo), '7b. Mayúsculas + validar_estructura_curp_sql')
  verificar(/where a2\.docente_id = v_docente_id\s*and a2\.id <> p_alumno_id\s*and a2\.curp is not null\s*and upper\(trim\(a2\.curp\)\) = v_curp_nueva/.test(cuerpo), '7c. Duplicado: solo alumnos propios, excluyendo al propio alumno')
  verificar(migracion.split('\n').filter((l) => !l.trim().startsWith('--') && /[^\x00-\x7f]/.test(l)).every((l) => /raise exception 'POSCONDICION_FALLIDA/.test(l)), '7d. Ningún carácter no ASCII en el código salvo el texto en español de la poscondición')

  // 8. Referencias del cliente controladas.
  verificar(/if p_fuente is null or p_fuente not in \('documento', 'imagen', 'texto', 'voz', 'manual'\) then\s*raise exception 'INVALID_SOURCE';/.test(cuerpo), '8. Fuente validada contra exactamente la lista del CHECK real')
  verificar(/if p_conversacion_id is not null and not exists \(\s*select 1 from public\.conversaciones_chat c\s*where c\.id = p_conversacion_id\s*and c\.docente_id = v_docente_id\s*\) then\s*raise exception 'CONVERSATION_NOT_AUTHORIZED';/.test(cuerpo), '8b. Conversación aceptada solo si es del docente (mismo error para ajena e inexistente)')
  verificar(/p_fuente, jsonb_build_object\('flujo', 'actualizar_curp_alumno'\),\s*p_conversacion_id, null,\s*'correccion', null/.test(cuerpo), '8c. fuente_detalle lo fija el servidor; mensaje_id NULL; accion correccion; sin corrección original')

  // 9. Permisos y poscondición.
  for (const rol of ['public', 'anon']) verificar(exterior.includes(`revoke execute on function ${FIRMA} from ${rol};`), `9. EXECUTE revocado de ${rol}`)
  for (const rol of ['authenticated', 'service_role']) verificar(exterior.includes(`grant execute on function ${FIRMA} to ${rol};`), `9b. EXECUTE para ${rol}`)
  const grants = exterior.match(/\bgrant\b[^;]*;/gi) || []
  verificar(grants.length === 2 && grants.every((g) => /to (authenticated|service_role);$/.test(g)) && !/\bgrant\b[^;]*\bto\s+(anon|public)\b/i.test(exterior), `9d. Los únicos GRANT son a authenticated y service_role (encontrados: ${grants.length}); ninguno a anon ni a PUBLIC`)
  verificar(exterior.lastIndexOf('commit;') > Math.max(...grants.map((g) => exterior.lastIndexOf(g))) && exterior.indexOf('POSCONDICION_FALLIDA') > Math.max(...grants.map((g) => exterior.lastIndexOf(g))), '9e. Todos los GRANT van antes de la poscondición y del COMMIT')
  verificar(/has_function_privilege\('public', c_firma, 'execute'\)/.test(exterior) && /not has_function_privilege\('authenticated', c_firma, 'execute'\)/.test(exterior) && /proconfig from pg_catalog\.pg_proc p where p\.oid = c_firma::regprocedure\) is distinct from array\['search_path=""'\]/.test(exterior), '9c. Poscondición: INVOKER, search_path y privilegios efectivos')

  // 10. Paridad TS/SQL (corpus dorado obtenido con el validador SQL real).
  let difValidez = 0, difNorma = 0
  for (const [entrada, validoSql, normaSql] of CORPUS_DORADO) {
    const r = validarValorCampoAlumno('curp', entrada)
    if (r.valido !== validoSql) difValidez++
    else if (r.valido && r.valorNormalizado !== normaSql) difNorma++
  }
  verificar(CORPUS_DORADO.length >= 70 && CORPUS_DORADO.some(([, v]) => v) && CORPUS_DORADO.some(([, v]) => !v), `10. Corpus dorado con casos válidos e inválidos (${CORPUS_DORADO.length})`)
  verificar(difValidez === 0, `10b. Validez TS idéntica a SQL en todo el corpus (diferencias: ${difValidez})`)
  verificar(difNorma === 0, `10c. Forma normalizada TS idéntica a SQL (diferencias: ${difNorma})`)

  // 11. Orden de migraciones; consumidores: el Chat ya usa la primitiva,
  // la ficha individual todavía no (fase posterior).
  const migraciones = readdirSync(raiz('supabase', 'migrations')).filter((f) => /^\d{14}_[^ ]+\.sql$/.test(f)).sort()
  verificar(migraciones.indexOf(NOMBRE) > migraciones.indexOf('20261013000000_cotejo_curp_por_docente.sql'), '11. Se ordena después de T0 (20261013000000)')
  const motor = readFileSync(raiz('lib', 'motorContexto.ts'), 'utf-8')
  const ficha = readFileSync(raiz('app', 'dashboard', 'lista', '[alumnoId]', 'page.tsx'), 'utf-8')
  const herramientas = readFileSync(raiz('lib', 'asistente', 'herramientasModulo.ts'), 'utf-8')
  const rutaCorreccion = readFileSync(raiz('app', 'api', 'alumnos', 'aplicar-correccion', 'route.ts'), 'utf-8')
  // Cuerpo de una función (desde su declaración hasta la llave que la cierra).
  const cuerpoFuncion = (fuente: string, declaracion: string) => {
    const inicio = fuente.indexOf(declaracion)
    if (inicio < 0) return ''
    const abre = fuente.indexOf('{', fuente.indexOf(')', fuente.indexOf('(', inicio + declaracion.length - 1)))
    let profundidad = 0
    for (let i = abre; i < fuente.length; i++) {
      if (fuente[i] === '{') profundidad++
      else if (fuente[i] === '}' && --profundidad === 0) return fuente.slice(abre, i + 1)
    }
    return ''
  }
  const fnCurp = cuerpoFuncion(motor, 'async function aplicarCorreccionCurp(')
  const fnAplicar = cuerpoFuncion(motor, 'export async function aplicarCorreccionAlumno(')
  const ramaCurp = fnAplicar.match(/^\{\s*if \(campo === 'curp'\) \{\s*if \(valorEsperado === undefined\) \{\s*return \{ exito: false,[^}]*\}\s*\}\s*return aplicarCorreccionCurp\(sb, alumnoId, valorNuevo, fuente, valorEsperado\)\s*\}/)
  const chequeos11b: [boolean, string][] = [
    [/sb\.rpc\('actualizar_curp_alumno', \{/.test(fnCurp), 'el Chat corrige CURP con sb.rpc(actualizar_curp_alumno)'],
    [!/\.update\(|\.insert\(|\.upsert\(|\.from\(/.test(fnCurp), 'la rama CURP no hace UPDATE/INSERT/lecturas propias'],
    [!!ramaCurp, 'aplicarCorreccionAlumno resuelve CURP (y retorna) antes de cualquier otra sentencia'],
    [fnAplicar.indexOf('.update(') > (ramaCurp?.[0].length ?? Infinity) && fnAplicar.indexOf("from('correcciones_alumno')") > (ramaCurp?.[0].length ?? Infinity), 'el UPDATE directo y el INSERT de trazabilidad quedan solo para sexo/fecha_nacimiento'],
    [(motor.match(/from\('correcciones_alumno'\)/g) ?? []).length === 1, 'un solo INSERT de trazabilidad en motorContexto (el de sexo/fecha); CURP lo hace la RPC'],
    [[herramientas, rutaCorreccion].every((f) => !/\.from\('(alumnos|correcciones_alumno)'\)/.test(f) && !/\.rpc\(/.test(f)), 'herramienta y endpoint del Chat no escriben alumnos ni trazabilidad por su cuenta'],
    [!ficha.includes('actualizar_curp_alumno'), 'la ficha individual todavía NO usa la primitiva (fase posterior)'],
  ]
  const fallidos11b = chequeos11b.filter(([ok]) => !ok).map(([, m]) => m)
  verificar(fallidos11b.length === 0, `11b. Chat usa actualizar_curp_alumno sin UPDATE directo de CURP ni INSERT duplicado; ficha individual aún no${fallidos11b.length ? ` — FALLA: ${fallidos11b.join('; ')}` : ''}`)

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
