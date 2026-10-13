// scripts/verificar-cotejo-curp-por-docente.ts
//
// Seguridad — T0: verificación ESTÁTICA (sin credenciales, sin red, sin
// DDL/DML remoto, sin datos reales) de la migración
// 20261013000000_cotejo_curp_por_docente.sql, que reemplaza las 3
// funciones que cotejaban CURP contra toda la institución (oráculo de
// existencia de CURP entre cuentas) por un cotejo por docente.
//
// Además de la estructura, demuestra que en cada función cambiaron
// EXCLUSIVAMENTE las líneas previstas: al revertir los reemplazos sobre
// el cuerpo nuevo se obtiene, byte a byte, el cuerpo de la migración
// histórica vigente hasta ahora.
//
// El comportamiento real (dos docentes, misma institución, concurrencia
// y deadlocks) se validó aparte ejecutando las definiciones en
// PostgreSQL; este script fija que el texto siga siendo el validado.
//
// Se ejecuta con `npx tsx scripts/verificar-cotejo-curp-por-docente.ts`.

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
const NOMBRE = '20261013000000_cotejo_curp_por_docente.sql'
const migracion = readFileSync(raiz('supabase', 'migrations', NOMBRE), 'utf-8')

type Funcion = {
  nombre: string
  firma: string
  cabecera: RegExp
  definer: boolean
  md5Antes: string
  md5Despues: string
  acl: string
  historica: string
  // [texto original, texto nuevo] — exactamente los reemplazos auditados.
  reemplazos: [string, string][]
}

const FUNCIONES: Funcion[] = [
  {
    nombre: 'importar_alumnos_a_grupo',
    firma: 'public.importar_alumnos_a_grupo(uuid, jsonb)',
    cabecera: /CREATE OR REPLACE FUNCTION public\.importar_alumnos_a_grupo\(p_grupo_id uuid, p_alumnos jsonb\)\n RETURNS integer\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO ''\nAS \$function\$/,
    definer: true,
    md5Antes: '5c27b03a6a8ac887e464f0b454d6fb3b',
    md5Despues: 'c905b378d0fdbeeab701e75311ff13e6',
    acl: '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}',
    historica: '20261008040000_prevenir_deadlock_importar_alumnos_a_grupo.sql',
    reemplazos: [
      ["perform pg_advisory_xact_lock(hashtextextended(v_curp_lock, 0::bigint));", "perform pg_advisory_xact_lock(hashtextextended(v_docente_id::text || ':' || v_curp_lock, 0::bigint));"],
      ['alta_persona_con_inscripcion — misma clave ante la misma CURP, así', 'alta_persona_con_inscripcion — misma clave (docente_id + CURP) ante la misma CURP del mismo docente, así'],
      ['    -- existentes de la MISMA institución — cualquier conflicto aborta', '    -- existentes del MISMO docente, en todas sus escuelas (cotejo por\n    -- cuenta: nunca consulta ni revela CURP de otras cuentas) — cualquier conflicto aborta'],
      ['        where a.institucion_id = v_institucion_id\n          and upper(a.curp) = v_curp_norm', '        where a.docente_id = v_docente_id\n          and upper(a.curp) = v_curp_norm'],
      ["raise exception 'Esa CURP ya está registrada.';", "raise exception 'Ya tienes un alumno registrado con esa CURP.';"],
    ],
  },
  {
    nombre: 'alta_persona_con_inscripcion',
    firma: 'public.alta_persona_con_inscripcion(uuid, text, text)',
    cabecera: /CREATE OR REPLACE FUNCTION public\.alta_persona_con_inscripcion\(p_grupo_id uuid, p_nombre text, p_curp text\)\n RETURNS uuid\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO ''\nAS \$function\$/,
    definer: true,
    md5Antes: 'aaf0d713ab9cdb2d3f42cfaf8ece26a8',
    md5Despues: 'b5c0d54d931c27d25c473934cedf1bc2',
    acl: '{postgres=X/postgres,service_role=X/postgres}',
    historica: '20261008030000_alta_persona_con_inscripcion.sql',
    reemplazos: [
      ["perform pg_advisory_xact_lock(hashtextextended(v_curp_norm, 0::bigint));", "perform pg_advisory_xact_lock(hashtextextended(v_docente_id::text || ':' || v_curp_norm, 0::bigint));"],
      ['    -- Duplicado INSTITUCIONAL real — EXISTS contra TODOS los alumnos\n    -- de la institución (nunca solo los del propio docente), posible\n    -- únicamente porque esta función es SECURITY DEFINER. Cualquier', '    -- Duplicado POR DOCENTE — EXISTS contra los alumnos del propio\n    -- docente, en todas sus escuelas; nunca contra otras cuentas, para\n    -- no revelar la existencia de CURP ajenas. Cualquier'],
      ['      where a.institucion_id = v_institucion_id\n        and upper(a.curp) = v_curp_norm', '      where a.docente_id = v_docente_id\n        and upper(a.curp) = v_curp_norm'],
      ["raise exception 'Esa CURP ya está registrada.';", "raise exception 'Ya tienes un alumno registrado con esa CURP.';"],
    ],
  },
  {
    nombre: 'reparar_curp_desde_lista_oficial',
    firma: 'public.reparar_curp_desde_lista_oficial(uuid, uuid, text, text)',
    cabecera: /CREATE OR REPLACE FUNCTION public\.reparar_curp_desde_lista_oficial\(p_alumno_id uuid, p_grupo_id uuid, p_curp_esperada_actual text, p_curp_nueva text\)\n RETURNS void\n LANGUAGE plpgsql\n SET search_path TO ''\nAS \$function\$/,
    definer: false,
    md5Antes: 'f110053ba76eb08e3fdd9f9443fffd01',
    md5Despues: '6e8ac91f1e8a3dfa42e38dcf8deae53c',
    acl: '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}',
    historica: '20260913010000_reparar_curp_desde_lista_oficial.sql',
    reemplazos: [
      ["perform pg_advisory_xact_lock(hashtextextended(v_curp_nueva_norm, 0::bigint));", "perform pg_advisory_xact_lock(hashtextextended(v_docente_id::text || ':' || v_curp_nueva_norm, 0::bigint));"],
      ['  -- 11. Duplicado institucional — case-insensitive, excluye al propio', '  -- 11. Duplicado por docente (todas sus escuelas; nunca otras cuentas)\n  -- — case-insensitive, excluye al propio'],
      ['      and a2.institucion_id = v_institucion_id\n', '      and a2.docente_id = v_docente_id\n'],
    ],
  },
]

// Cuerpo PL/pgSQL de una función dentro de la migración T0.
function cuerpoNuevo(nombre: string): string {
  const inicio = migracion.indexOf(`CREATE OR REPLACE FUNCTION public.${nombre}(`)
  const apertura = migracion.indexOf('AS $function$', inicio) + 'AS $function$'.length
  const cierre = migracion.indexOf('$function$;', apertura)
  return migracion.slice(apertura, cierre)
}

// Cuerpo de la función en su migración histórica (`as $$ … $$;`).
function cuerpoHistorico(archivo: string, nombre: string): string {
  const texto = readFileSync(raiz('supabase', 'migrations', archivo), 'utf-8')
  const inicio = texto.search(new RegExp(`create (or replace )?function public\\.${nombre}\\(`))
  const apertura = texto.indexOf('as $$', inicio) + 'as $$'.length
  const cierre = texto.indexOf('$$;', apertura)
  return texto.slice(apertura, cierre)
}

function sinComentarios(codigo: string): string {
  return codigo
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n')
}

// Texto de la migración fuera de los cuerpos de las funciones.
function fueraDeCuerpos(): string {
  let t = migracion
  for (const f of FUNCIONES) t = t.replace(cuerpoNuevo(f.nombre), '')
  return sinComentarios(t)
}

function main() {
  const exterior = fueraDeCuerpos()

  // ============================================================
  // 1. Atomicidad, orden y alcance de la migración.
  // ============================================================
  verificar(/^begin;$/m.test(exterior) && /^commit;$/m.test(exterior), '1. Transacción explícita BEGIN … COMMIT (atómica)')
  verificar((exterior.match(/CREATE OR REPLACE FUNCTION/g) || []).length === 3, '1b. Exactamente 3 CREATE OR REPLACE FUNCTION')
  verificar(!/\b(grant|revoke|alter|drop|truncate)\b/i.test(exterior), '1c. 0 GRANT/REVOKE/ALTER/DROP/TRUNCATE (permisos y esquema intactos)')
  verificar(!/\b(insert\s+into|update\s+public\.|delete\s+from)\b/i.test(exterior), '1d. 0 DML fuera de los cuerpos de las funciones (datos intactos)')
  verificar(!/\bcreate\s+(table|index|unique|policy|trigger)\b/i.test(exterior), '1e. 0 tablas, índices, restricciones, policies o triggers nuevos')

  const posBegin = exterior.indexOf('begin;')
  const posPre = exterior.indexOf('PRECONDICION_FALLIDA')
  const posCreate = exterior.indexOf('CREATE OR REPLACE FUNCTION')
  const posPost = exterior.indexOf('POSCONDICION_FALLIDA')
  const posCommit = exterior.indexOf('commit;')
  verificar(posBegin < posPre && posPre < posCreate && posCreate < posPost && posPost < posCommit, '1f. Orden: BEGIN → precondición → CREATE OR REPLACE → poscondición → COMMIT')

  for (const f of FUNCIONES) {
    const cuerpo = cuerpoNuevo(f.nombre)
    const codigo = sinComentarios(cuerpo)

    // ============================================================
    // 2. Precondición y poscondición por firma y md5.
    // ============================================================
    verificar(exterior.includes(`to_regprocedure('${f.firma}') is null`), `2. [${f.nombre}] precondición: existe con la firma exacta`)
    verificar(exterior.includes(`md5(pg_catalog.pg_get_functiondef('${f.firma}'::regprocedure)) not in ('${f.md5Antes}', '${f.md5Despues}')`), `2b. [${f.nombre}] precondición: md5 auditado (${f.md5Antes.slice(0, 8)}…) o ya el nuevo (idempotente)`)
    verificar(exterior.includes(`md5(pg_catalog.pg_get_functiondef('${f.firma}'::regprocedure)) <> '${f.md5Despues}'`), `2c. [${f.nombre}] poscondición: md5 nuevo (${f.md5Despues.slice(0, 8)}…)`)
    verificar(exterior.includes(`is distinct from ${f.definer}`) && exterior.includes(`proacl::text from pg_catalog.pg_proc p where p.oid = '${f.firma}'::regprocedure) <> '${f.acl}'`), `2d. [${f.nombre}] poscondición: mismo SECURITY, search_path, propietario y ACL ${f.acl}`)

    // ============================================================
    // 3. Firma, SECURITY y search_path conservados.
    // ============================================================
    verificar(f.cabecera.test(migracion), `3. [${f.nombre}] misma firma, retorno, ${f.definer ? 'SECURITY DEFINER' : 'SECURITY INVOKER'} y search_path ''`)

    // ============================================================
    // 4. Cotejo por docente y lock por docente + CURP.
    // ============================================================
    verificar(/(a|a2)\.docente_id = v_docente_id/.test(codigo), `4. [${f.nombre}] el duplicado se coteja por docente_id`)
    verificar(!/(a|a2)\.institucion_id = v_institucion_id/.test(codigo), `4b. [${f.nombre}] ningún cotejo por institución`)
    const locks = codigo.match(/pg_advisory_xact_lock\(([^;]*)\);/g) || []
    verificar(locks.length === 1 && /hashtextextended\(v_docente_id::text \|\| ':' \|\| v_curp[a-z_]*, 0::bigint\)/.test(locks[0]), `4c. [${f.nombre}] exactamente 1 punto de lock, con clave docente_id + ':' + CURP normalizada`)
    verificar(!/pg_advisory_lock\(|pg_advisory_unlock\(/.test(codigo), `4d. [${f.nombre}] solo locks transaccionales`)

    // ============================================================
    // 5. Nada más cambió respecto de la definición histórica.
    // ============================================================
    let revertido = cuerpo
    for (const [original, nuevo] of f.reemplazos) {
      verificar(revertido.split(nuevo).length - 1 === 1, `5. [${f.nombre}] reemplazo presente exactamente una vez: ${nuevo.split('\n')[0].trim().slice(0, 60)}…`)
      revertido = revertido.replace(nuevo, original)
    }
    verificar(revertido === cuerpoHistorico(f.historica, f.nombre), `5b. [${f.nombre}] revertidos los reemplazos, el cuerpo es idéntico al de ${f.historica}`)
  }

  // ============================================================
  // 6. Orden de adquisición de locks preservado.
  // ============================================================
  const imp = sinComentarios(cuerpoNuevo('importar_alumnos_a_grupo'))
  const pLoopLocks = imp.indexOf('for v_curp_lock in select unnest(v_curps_lote) order by 1')
  const pBucle = imp.indexOf("if jsonb_typeof(v_elem) is distinct from 'object' then")
  const pExists = imp.indexOf('where a.docente_id = v_docente_id')
  const pDocente = imp.indexOf('v_docente_id := auth.uid();')
  verificar(pDocente !== -1 && pDocente < pLoopLocks && pLoopLocks < pBucle && pBucle < pExists, '6. importar: v_docente_id asignado → locks ordenados (order by 1) → bucle → EXISTS')
  const alta = sinComentarios(cuerpoNuevo('alta_persona_con_inscripcion'))
  verificar(alta.indexOf('pg_advisory_xact_lock') < alta.indexOf('where a.docente_id = v_docente_id') && alta.indexOf('pg_advisory_xact_lock') < alta.indexOf('insert into public.alumnos'), '6b. alta_persona: lock → EXISTS → INSERT')
  const rep = sinComentarios(cuerpoNuevo('reparar_curp_desde_lista_oficial'))
  verificar(rep.indexOf('for update') < rep.indexOf('pg_advisory_xact_lock') && rep.indexOf('pg_advisory_xact_lock') < rep.indexOf('and a2.docente_id = v_docente_id') && rep.indexOf('and a2.docente_id = v_docente_id') < rep.indexOf('update public.alumnos'), '6c. reparar_curp: fila del alumno (FOR UPDATE) → lock → duplicado → UPDATE')

  // ============================================================
  // 7. Contratos de error.
  // ============================================================
  verificar((migracion.match(/raise exception 'Ya tienes un alumno registrado con esa CURP\.';/g) || []).length === 2, '7. importar y alta_persona: "Ya tienes un alumno registrado con esa CURP."')
  verificar(!/Esa CURP ya está registrada/.test(sinComentarios(migracion)), '7b. Ya no queda el mensaje anterior en el código')
  verificar(/raise exception 'NEW_CURP_DUPLICATE';/.test(rep) && /raise exception 'STUDENT_NOT_AUTHORIZED';/.test(rep), '7c. reparar_curp conserva sus códigos (NEW_CURP_DUPLICATE, STUDENT_NOT_AUTHORIZED…)')
  verificar(/raise exception 'CURP duplicada dentro del mismo archivo\.';/.test(imp), '7d. importar conserva el rechazo de CURP duplicada dentro del mismo archivo')

  // ============================================================
  // 8. Mensajes de la aplicación.
  // ============================================================
  const aplicarPlan = readFileSync(raiz('app', 'api', 'importar-alumnos', 'aplicar-plan', 'route.ts'), 'utf-8')
  const corregirCurp = readFileSync(raiz('app', 'api', 'importar-alumnos', 'corregir-curp', 'route.ts'), 'utf-8')
  verificar(aplicarPlan.includes("DUPLICATE_CURP: { status: 409, mensaje: 'Esa CURP ya está registrada en otro de tus alumnos.' },"), '8. aplicar-plan: DUPLICATE_CURP habla solo de alumnos propios')
  verificar(/codigo: 'NEW_CURP_DUPLICATE',\s*\n\s*mensaje: 'La CURP propuesta ya está registrada en otro de tus alumnos\.',/.test(corregirCurp), '8b. corregir-curp: NEW_CURP_DUPLICATE habla solo de alumnos propios')

  // ============================================================
  // 9. Orden de migraciones.
  // ============================================================
  const migraciones = readdirSync(raiz('supabase', 'migrations')).filter((f) => /^\d{14}_[^ ]+\.sql$/.test(f)).sort()
  verificar(migraciones.indexOf(NOMBRE) > migraciones.indexOf('20261012000000_revocar_execute_actualizar_datos_alumno.sql'), '9. Se ordena después de 20261012000000')
  verificar(FUNCIONES.every((f) => migraciones.indexOf(f.historica) !== -1 && migraciones.indexOf(f.historica) < migraciones.indexOf(NOMBRE)), '9b. Reemplaza a las 3 migraciones históricas, todas anteriores')

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
