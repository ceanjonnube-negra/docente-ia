// scripts/verificar-alta-persona-con-inscripcion.ts
//
// V1-D2C1-B4D1 — preparación (NO aplicación) de la función SQL
// alta_persona_con_inscripcion (migración 20261008030000). Verificación
// ESTÁTICA (sin credenciales, sin red, sin DDL/DML remoto, sin datos
// reales, sin insertar ningún alumno de prueba) — mismo criterio que
// el resto de esta familia de scripts (ver
// scripts/verificar-trasladar-inscripcion.ts,
// scripts/verificar-baja-individual-inscripcion.ts): se audita el
// TEXTO real de la migración.
//
// Se ejecuta con `npx tsx scripts/verificar-alta-persona-con-inscripcion.ts`.

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
const migracion = readFileSync(raiz('supabase', 'migrations', '20261008030000_alta_persona_con_inscripcion.sql'), 'utf-8')

function sinComentariosSql(contenido: string): string {
  return contenido
    .split('\n')
    .filter((linea) => !linea.trim().startsWith('--'))
    .join('\n')
}
const codigoReal = sinComentariosSql(migracion)

const inicioCuerpo = codigoReal.indexOf('create function public.alta_persona_con_inscripcion')
const finCuerpo = codigoReal.indexOf('$$;', inicioCuerpo) + 3
const cuerpoFuncion = codigoReal.slice(inicioCuerpo, finCuerpo)

function main() {
  // ============================================================
  // 1. Firma exacta y tipo de retorno.
  // ============================================================
  verificar(
    /create function public\.alta_persona_con_inscripcion\(\s*p_grupo_id uuid,\s*p_nombre text,\s*p_curp text\s*\)/.test(codigoReal),
    '1. Firma exacta: alta_persona_con_inscripcion(p_grupo_id uuid, p_nombre text, p_curp text)'
  )
  verificar(/returns uuid/.test(codigoReal), '1b. Retorna uuid (el id del alumno nuevo creado)')

  // ============================================================
  // 2. SECURITY DEFINER + search_path fijo.
  // ============================================================
  verificar(/security definer/.test(codigoReal), '2. SECURITY DEFINER — alumnos/inscripciones no tienen policy RLS de escritura suficiente para esto')
  verificar(/set search_path = ''/.test(codigoReal), "2b. SET search_path = '' fijo — mismo hardening que trasladar_inscripcion/dar_de_baja_inscripcion")

  // ============================================================
  // 3. Todas las referencias a tablas están calificadas con esquema.
  // ============================================================
  verificar(!/[^.]\bfrom grupos\b/.test(cuerpoFuncion), "3a. 0 referencia sin calificar 'from grupos'")
  verificar(!/[^.]\bfrom alumnos\b/.test(cuerpoFuncion), "3b. 0 referencia sin calificar 'from alumnos'")
  verificar(!/\binsert into alumnos\b/.test(cuerpoFuncion), '3c. 0 INSERT sin calificar sobre alumnos')
  verificar(!/\binsert into inscripciones\b/.test(cuerpoFuncion), '3d. 0 INSERT sin calificar sobre inscripciones')
  verificar((cuerpoFuncion.match(/public\.alumnos/g) || []).length >= 2, '3e. public.alumnos (calificado) aparece múltiples veces')
  verificar((cuerpoFuncion.match(/public\.inscripciones/g) || []).length >= 1, '3f. public.inscripciones (calificado) aparece en el cuerpo real')
  verificar((cuerpoFuncion.match(/public\.grupos/g) || []).length >= 1, '3g. public.grupos (calificado) aparece en el cuerpo real')

  // ============================================================
  // 4. Autenticación real.
  // ============================================================
  verificar(/v_docente_id uuid := auth\.uid\(\)/.test(cuerpoFuncion), '4. v_docente_id se deriva de auth.uid() real')
  verificar(/if v_docente_id is null then\s*\n\s*raise exception/.test(cuerpoFuncion), '4b. Sin auth.uid() real, falla explícitamente (fail-closed)')

  // ============================================================
  // 5. Propiedad REAL del grupo — grupos.docente_id, nunca otra cosa.
  //    institucion_id/ciclo_escolar_id derivados ÚNICAMENTE de ahí.
  // ============================================================
  verificar(/where g\.id = p_grupo_id\s*\n\s*and g\.docente_id = v_docente_id/.test(cuerpoFuncion), '5. Ownership del grupo verificado contra grupos.docente_id (dato en vivo)')
  verificar(/if not found then\s*\n\s*raise exception 'Grupo no encontrado/.test(cuerpoFuncion), '5b. Grupo no encontrado/no autorizado se rechaza explícitamente')

  // ============================================================
  // 6. Validación de nombre — trim, rechazo si vacío.
  // ============================================================
  verificar(/v_nombre := trim\(both from coalesce\(p_nombre, ''\)\)/.test(cuerpoFuncion), '6. Nombre recortado (trim), nunca inventado')
  verificar(/if v_nombre = '' then\s*\n\s*raise exception 'Falta un nombre válido/.test(cuerpoFuncion), '6b. Nombre vacío se rechaza explícitamente')

  // ============================================================
  // 7. CURP opcional — NULL válido, normalización SOLO para comparar.
  // ============================================================
  verificar(/v_curp := nullif\(trim\(both from coalesce\(p_curp, ''\)\), ''\)/.test(cuerpoFuncion), '7. CURP se recorta pero nunca cambia de mayúsculas/minúsculas al guardarse')
  verificar(/v_curp_norm := upper\(v_curp\)/.test(cuerpoFuncion), '7b. La normalización a mayúsculas existe SOLO para comparar duplicados (v_curp_norm), nunca sobrescribe v_curp')

  // ============================================================
  // 8. Duplicado INSTITUCIONAL real — EXISTS contra TODA la
  //    institución (nunca solo el propio docente) — solo posible
  //    porque es SECURITY DEFINER.
  // ============================================================
  verificar(
    /where a\.institucion_id = v_institucion_id\s*\n\s*and upper\(a\.curp\) = v_curp_norm/.test(cuerpoFuncion),
    '8. El chequeo de CURP duplicada es institucional real (institucion_id), sin filtro adicional de docente_id — ve TODA la institución'
  )
  verificar(!/a\.docente_id = v_docente_id/.test(cuerpoFuncion), '8b. El chequeo de duplicado de CURP NO se limita al propio docente (confirmación negativa)')

  // ============================================================
  // 9. INSERT de alumnos — columnas exactas, sin sexo/fecha_nacimiento
  //    (el contrato HMAC no los transporta para alta_persona).
  // ============================================================
  verificar(
    /insert into public\.alumnos \(institucion_id, docente_id, nombre, curp\)\s*\n\s*values \(v_institucion_id, v_docente_id, v_nombre, v_curp\)/.test(cuerpoFuncion),
    '9. INSERT de alumnos usa exactamente (institucion_id, docente_id, nombre, curp) — derivados/validados, nunca del payload crudo'
  )
  verificar(!/\bsexo\b/.test(cuerpoFuncion), '9b. 0 columna sexo escrita — el contrato HMAC de alta_persona no la transporta')
  verificar(!/fecha_nacimiento/.test(cuerpoFuncion), '9c. 0 columna fecha_nacimiento escrita — mismo criterio')
  verificar(/returning id into v_alumno_id/.test(cuerpoFuncion), '9d. El id del alumno nuevo se captura explícitamente')

  // ============================================================
  // 10. INSERT de inscripciones — columnas exactas, numero_lista
  //     NUNCA se escribe, estatus='activo'.
  // ============================================================
  verificar(
    /insert into public\.inscripciones \(alumno_id, grupo_id, ciclo_escolar_id, docente_id, estatus\)\s*\n\s*values \(v_alumno_id, p_grupo_id, v_ciclo_escolar_id, v_docente_id, 'activo'\)/.test(cuerpoFuncion),
    "10. INSERT de inscripciones usa exactamente (alumno_id, grupo_id, ciclo_escolar_id, docente_id, estatus='activo')"
  )
  verificar(!/numero_lista/.test(cuerpoFuncion), '10b. numero_lista nunca se escribe')
  verificar((cuerpoFuncion.match(/insert into public\.alumnos/g) || []).length === 1, '10c. Exactamente 1 INSERT en alumnos')
  verificar((cuerpoFuncion.match(/insert into public\.inscripciones/g) || []).length === 1, '10d. Exactamente 1 INSERT en inscripciones')

  // ============================================================
  // 11. Retorno — el id del alumno creado.
  // ============================================================
  verificar(/return v_alumno_id;/.test(cuerpoFuncion), '11. La función devuelve el id del alumno recién creado')

  // ============================================================
  // 12. 0 UPDATE/DELETE en toda la función — nunca modifica alumnos ni
  //     inscripciones existentes, nunca toca otro grupo.
  // ============================================================
  verificar(!/\bupdate\s+public\./i.test(cuerpoFuncion), '12a. 0 UPDATE en toda la función — nunca modifica alumnos ni inscripciones existentes')
  verificar(!/\bdelete\s+from\b/i.test(cuerpoFuncion), '12b. 0 DELETE en toda la función')

  // ============================================================
  // 13. 0 referencia a otro grupo distinto del parámetro — la
  //     operación nunca afecta otros grupos.
  // ============================================================
  verificar(!/p_grupo_id_destino|p_grupo_id_origen/.test(cuerpoFuncion), '13. 0 referencia a un segundo grupo — esta operación solo toca p_grupo_id')

  // ============================================================
  // 14. 0 identidad inferida por nombre/similitud — nunca se compara
  //     v_nombre contra nombres existentes para decidir identidad.
  // ============================================================
  verificar(!/calcularSimilitud|normalizarNombre|similitud/i.test(cuerpoFuncion), '14. 0 referencia a lógica de similitud/coincidencia de nombre en el código real — la identidad nunca se infiere aquí (la ausencia se documenta en comentarios, que no cuentan como código)')

  // ============================================================
  // 15. roster_congelado y las 7 tablas de historial nunca se tocan.
  // ============================================================
  verificar(!migracion.toLowerCase().includes('roster_congelado'), '15a. 0 referencia a roster_congelado')
  const TABLAS_HISTORIAL = ['asistencia_registro', 'incidencias', 'evaluaciones', 'evidencias', 'necesidades_apoyo', 'fichas_descriptivas', 'seguimiento_resultados']
  verificar(TABLAS_HISTORIAL.every((t) => !codigoReal.includes(t)), '15b. 0 referencia en código real a ninguna de las 7 tablas de historial')

  // ============================================================
  // 16. GRANT/REVOKE — PUBLIC, anon Y authenticated quedan SIN
  //     EXECUTE; 0 GRANT a ningún rol.
  // ============================================================
  verificar(codigoReal.includes('revoke execute on function public.alta_persona_con_inscripcion(uuid, text, text) from public;'), '16a. EXECUTE revocado explícitamente de PUBLIC')
  verificar(codigoReal.includes('revoke execute on function public.alta_persona_con_inscripcion(uuid, text, text) from anon;'), '16b. EXECUTE revocado explícitamente de anon')
  verificar(codigoReal.includes('revoke execute on function public.alta_persona_con_inscripcion(uuid, text, text) from authenticated;'), '16c. EXECUTE revocado explícitamente de authenticated — NO invocable todavía por ningún docente real')
  verificar(!/grant execute/i.test(codigoReal), '16d. 0 GRANT EXECUTE en toda la migración')

  // ============================================================
  // 17. Fail-closed no idempotente — CREATE FUNCTION, nunca CREATE OR
  //     REPLACE.
  // ============================================================
  verificar(/^create function public\.alta_persona_con_inscripcion/m.test(codigoReal), '17. CREATE FUNCTION (sin OR REPLACE) — fail-closed ante un drift de esquema no auditado')
  verificar(!/create or replace function public\.alta_persona_con_inscripcion/.test(codigoReal), '17b. Confirmación negativa: 0 "CREATE OR REPLACE" para esta función')

  // ============================================================
  // 18. 0 IA en toda la migración.
  // ============================================================
  verificar(!/anthropic|openai/i.test(migracion), '18. La migración no referencia ningún cliente de IA')

  // ============================================================
  // 19. Corrección de la condición de carrera (TOCTOU) sobre CURP:
  //     advisory lock TRANSACCIONAL, misma firma exacta que
  //     reparar_curp_desde_lista_oficial, posicionado ANTES del EXISTS
  //     de duplicado — nunca después.
  // ============================================================
  verificar(
    /perform pg_advisory_xact_lock\(hashtextextended\(v_curp_norm, 0::bigint\)\);/.test(cuerpoFuncion),
    '19. Existe exactamente el lock pg_advisory_xact_lock(hashtextextended(v_curp_norm, 0::bigint)) — misma firma que reparar_curp_desde_lista_oficial'
  )
  verificar(
    !/\bpg_advisory_lock\(/.test(cuerpoFuncion) && !/\bpg_advisory_unlock\(/.test(cuerpoFuncion),
    '19b. 0 uso del lock de SESIÓN (pg_advisory_lock/pg_advisory_unlock) — solo la variante transaccional (_xact_), que se libera sola sin importar cómo termine la transacción'
  )
  const posicionLock = cuerpoFuncion.indexOf('pg_advisory_xact_lock(')
  const posicionNormCurp = cuerpoFuncion.indexOf("v_curp_norm := upper(v_curp)")
  const posicionExistsCurp = cuerpoFuncion.indexOf('where a.institucion_id = v_institucion_id')
  const posicionInsertAlumno = cuerpoFuncion.indexOf('insert into public.alumnos')
  verificar(
    posicionLock !== -1 && posicionNormCurp !== -1 && posicionExistsCurp !== -1 && posicionInsertAlumno !== -1 &&
      posicionNormCurp < posicionLock && posicionLock < posicionExistsCurp && posicionExistsCurp < posicionInsertAlumno,
    '19c. Orden real correcto: se normaliza la CURP, LUEGO se adquiere el lock, LUEGO se comprueba el duplicado (EXISTS), LUEGO se inserta — nunca se bloquea después de ya haber comprobado'
  )
  // El lock debe quedar DENTRO del bloque `if v_curp is not null` (nunca
  // incondicional) — aislamos ese bloque exacto por posición y
  // confirmamos que el lock está contenido en él.
  const inicioBloqueCurp = cuerpoFuncion.indexOf('if v_curp is not null then')
  const finBloqueCurp = cuerpoFuncion.indexOf("raise exception 'Esa CURP ya está registrada.';", inicioBloqueCurp)
  verificar(
    inicioBloqueCurp !== -1 && finBloqueCurp !== -1 && posicionLock > inicioBloqueCurp && posicionLock < finBloqueCurp,
    '19d. El lock está contenido dentro del bloque "if v_curp is not null" — nunca se adquiere incondicionalmente cuando no hay CURP que proteger'
  )

  // ============================================================
  // 20. La corrección NO introduce ninguna restricción UNIQUE nueva ni
  //     ningún cambio de esquema sobre alumnos — el mecanismo elegido
  //     es puramente transaccional (requisito explícito: no anticipar
  //     una unicidad global de CURP que la arquitectura no contempla).
  // ============================================================
  verificar(!/add constraint/i.test(migracion), '20a. 0 "ADD CONSTRAINT" en toda la migración — ningún cambio de esquema')
  verificar(!/create\s+(unique\s+)?index/i.test(migracion), '20b. 0 "CREATE INDEX" en toda la migración — ningún índice nuevo')
  verificar(!/alter table/i.test(migracion), '20c. 0 "ALTER TABLE" en toda la migración — ninguna tabla se modifica')

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
