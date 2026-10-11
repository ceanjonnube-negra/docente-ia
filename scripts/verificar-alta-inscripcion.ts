// scripts/verificar-alta-inscripcion.ts
//
// V1-D2C1-B4D2 — preparación (NO aplicación) de la función SQL
// alta_inscripcion (migración 20261008050000). Verificación ESTÁTICA
// (sin credenciales, sin red, sin DDL/DML remoto, sin datos reales) —
// mismo criterio que scripts/verificar-trasladar-inscripcion.ts y
// scripts/verificar-alta-persona-con-inscripcion.ts: se audita el TEXTO
// real de la migración y su compatibilidad con el contrato HMAC y la
// prevalidación existentes.
//
// Se ejecuta con `npx tsx scripts/verificar-alta-inscripcion.ts`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { esOperacionAplicableListaOficialValida } from '../lib/listaOficial/aplicacionFirmada'

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
const migracion = readFileSync(raiz('supabase', 'migrations', '20261008050000_alta_inscripcion.sql'), 'utf-8')
const rutaAplicarPlan = readFileSync(raiz('app', 'api', 'importar-alumnos', 'aplicar-plan', 'route.ts'), 'utf-8')

function sinComentariosSql(contenido: string): string {
  return contenido
    .split('\n')
    .filter((linea) => !linea.trim().startsWith('--'))
    .join('\n')
}
// Quita también los comentarios al final de línea dentro del cuerpo.
function sinComentariosEnLinea(contenido: string): string {
  return contenido
    .split('\n')
    .map((linea) => linea.replace(/--.*$/, ''))
    .join('\n')
}
const codigoReal = sinComentariosSql(migracion)

const inicioCuerpo = codigoReal.indexOf('create function public.alta_inscripcion')
const finCuerpo = codigoReal.indexOf('$$;', inicioCuerpo) + 3
const cuerpoFuncion = sinComentariosEnLinea(codigoReal.slice(inicioCuerpo, finCuerpo))

function main() {
  // ============================================================
  // 1. Firma exacta y tipo de retorno.
  // ============================================================
  verificar(
    /create function public\.alta_inscripcion\(\s*p_alumno_id uuid,\s*p_grupo_id_destino uuid\s*\)/.test(codigoReal),
    '1. Firma exacta: alta_inscripcion(p_alumno_id uuid, p_grupo_id_destino uuid)'
  )
  verificar(/returns uuid/.test(cuerpoFuncion), '1b. Retorna uuid (el id de la inscripción nueva)')
  verificar((codigoReal.match(/create function/g) || []).length === 1, '1c. La migración crea exactamente 1 función')

  // ============================================================
  // 2. SECURITY DEFINER + search_path seguro + referencias calificadas.
  // ============================================================
  verificar(/security definer/.test(cuerpoFuncion), '2. SECURITY DEFINER')
  verificar(/set search_path = ''/.test(cuerpoFuncion), "2b. SET search_path = '' fijo")
  verificar(!/[^.]\b(from|join|into|update)\s+(inscripciones|grupos|alumnos)\b/.test(cuerpoFuncion), '2c. 0 referencia sin calificar a inscripciones/grupos/alumnos')
  verificar(/from public\.grupos g/.test(cuerpoFuncion), '2d. public.grupos calificado')
  verificar(/from public\.alumnos a/.test(cuerpoFuncion), '2e. public.alumnos calificado')
  verificar(/from public\.inscripciones i/.test(cuerpoFuncion), '2f. public.inscripciones calificado en la comprobación de actividad')

  // ============================================================
  // 3. Autenticación real, fail-closed.
  // ============================================================
  verificar(/v_docente_id uuid := auth\.uid\(\)/.test(cuerpoFuncion), '3. v_docente_id se deriva de auth.uid(), nunca de un parámetro')
  verificar(/if v_docente_id is null then\s*\n\s*raise exception/.test(cuerpoFuncion), '3b. Sin auth.uid() la función falla explícitamente')
  verificar(/if p_alumno_id is null or p_grupo_id_destino is null then\s*\n\s*raise exception/.test(cuerpoFuncion), '3c. Parámetros nulos se rechazan explícitamente')
  verificar(!/\bp_docente_id\b/.test(cuerpoFuncion) && !/\bp_ciclo/.test(cuerpoFuncion) && !/\bp_institucion/.test(cuerpoFuncion), '3d. 0 parámetro de docente/ciclo/institución — todo se deriva server-side')

  // ============================================================
  // 4. Propiedad vigente del grupo destino vía grupos.docente_id;
  //    nunca vía inscripciones.docente_id.
  // ============================================================
  verificar(/where g\.id = p_grupo_id_destino\s*\n\s*and g\.docente_id = v_docente_id;/.test(cuerpoFuncion), '4. Propiedad del grupo destino comprobada contra grupos.docente_id (dato en vivo)')
  verificar((cuerpoFuncion.match(/g\.docente_id = v_docente_id/g) || []).length === 1, '4b. g.docente_id = v_docente_id aparece exactamente 1 vez (solo existe grupo destino)')
  verificar(!/\bi\.docente_id\b/.test(cuerpoFuncion) && !/inscripciones\.docente_id/.test(cuerpoFuncion), '4c. NUNCA se usa inscripciones.docente_id para autorizar')
  verificar(!/docente_grupos/.test(cuerpoFuncion), '4d. docente_grupos no amplía el acceso (grupos compartidos fuera de alcance)')

  // ============================================================
  // 5. Alumno existente, propio del docente y de la misma institución.
  // ============================================================
  verificar(/where a\.id = p_alumno_id\s*\n\s*and a\.docente_id = v_docente_id/.test(cuerpoFuncion), '5. El alumno se carga solo si alumnos.docente_id = auth.uid() (misma regla que RLS y la prevalidación)')
  verificar(/raise exception 'Alumno no encontrado o no autorizado\.'/.test(cuerpoFuncion), '5b. Alumno inexistente o ajeno → rechazo explícito')
  verificar(/if v_institucion_id_alumno is distinct from v_institucion_id_destino then/.test(cuerpoFuncion), '5c. Institución del alumno debe coincidir con la del grupo destino')
  verificar(
    /\.from\('alumnos'\)\s*\n\s*\.select\('id, curp, institucion_id'\)\s*\n\s*\.in\('id', idsAlumnosRelevantes\)\s*\n\s*\.eq\('docente_id', auth\.user\.id\)/.test(rutaAplicarPlan),
    '5d. Paridad con la prevalidación real: aplicar-plan también exige alumnos.docente_id = auth.user.id'
  )
  verificar(!/select 1 from public\.alumnos/.test(cuerpoFuncion) && !/where a\.institucion_id = v_institucion_id_destino/.test(cuerpoFuncion), '5e. No existe una vía "solo por institución" que ignore alumnos.docente_id')

  // ============================================================
  // 6. Ciclo escolar derivado del grupo destino.
  // ============================================================
  verificar(/select g\.institucion_id, g\.ciclo_escolar_id\s*\n\s*into v_institucion_id_destino, v_ciclo_escolar_id_destino/.test(cuerpoFuncion), '6. ciclo_escolar_id e institucion_id se derivan del grupo destino validado')

  // ============================================================
  // 7. Rechazo de cualquier inscripción activa en el mismo ciclo,
  //    independientemente del grupo.
  // ============================================================
  const bloqueActividad = cuerpoFuncion.slice(cuerpoFuncion.indexOf('select exists ('), cuerpoFuncion.indexOf('into v_ya_activo_en_ciclo'))
  verificar(/i\.alumno_id = p_alumno_id/.test(bloqueActividad), '7. La comprobación filtra por el alumno')
  verificar(/i\.ciclo_escolar_id = v_ciclo_escolar_id_destino/.test(bloqueActividad), '7b. …por el ciclo del grupo destino')
  verificar(/i\.estatus = 'activo'/.test(bloqueActividad), "7c. …y solo por estatus='activo' (las históricas no bloquean)")
  verificar(!/grupo_id/.test(bloqueActividad), '7d. …sin filtrar por grupo (cualquier grupo del ciclo cuenta)')
  verificar(/if v_ya_activo_en_ciclo then\s*\n\s*raise exception/.test(cuerpoFuncion), '7e. Inscripción activa en el ciclo → rechazo con mensaje claro')

  // ============================================================
  // 8. Inscripción nueva, sin tocar las anteriores; no es traslado.
  // ============================================================
  verificar((cuerpoFuncion.match(/insert into public\.inscripciones/g) || []).length === 1, '8. Exactamente 1 INSERT en inscripciones')
  verificar(
    /insert into public\.inscripciones \(alumno_id, grupo_id, ciclo_escolar_id, docente_id, estatus\)\s*\n\s*values \(p_alumno_id, p_grupo_id_destino, v_ciclo_escolar_id_destino, v_docente_id, 'activo'\)/.test(cuerpoFuncion),
    '8b. Columnas exactas de la familia; id generado por la tabla (UUID nuevo)'
  )
  verificar(!/\binsert into public\.inscripciones \(id\b/.test(cuerpoFuncion), '8c. Nunca se fija el id manualmente')
  verificar(!/\bupdate\b/i.test(cuerpoFuncion.replace(/for update of a/g, '')), '8d. 0 UPDATE — ninguna inscripción anterior se modifica ni se da de baja')
  verificar(!/\bdelete\b/i.test(cuerpoFuncion), '8e. 0 DELETE')
  verificar(!/'baja'|fecha_baja/.test(cuerpoFuncion), "8f. 0 referencia a 'baja'/fecha_baja — nunca se convierte en traslado")
  verificar(!/insert into public\.alumnos/.test(cuerpoFuncion), '8g. Nunca crea un alumno (identidad intacta)')
  verificar(!/numero_lista/.test(cuerpoFuncion), '8h. numero_lista nunca se escribe')
  verificar(/returning id into v_inscripcion_id_nueva;/.test(cuerpoFuncion) && /return v_inscripcion_id_nueva;/.test(cuerpoFuncion), '8i. Devuelve el id de la inscripción nueva')
  verificar(!/trasladar_inscripcion|dar_de_baja_inscripcion/.test(cuerpoFuncion), '8j. No invoca traslado ni baja')

  // ============================================================
  // 9. Concurrencia: bloqueo del alumno + índice parcial como barrera
  //    final (sin capturar su excepción).
  // ============================================================
  verificar(/for update of a;/.test(cuerpoFuncion), '9. La fila del alumno se bloquea (FOR UPDATE OF a) antes de decidir')
  const posLock = cuerpoFuncion.indexOf('for update of a;')
  const posExists = cuerpoFuncion.indexOf('select exists (')
  const posInsert = cuerpoFuncion.indexOf('insert into public.inscripciones')
  verificar(posLock !== -1 && posLock < posExists && posExists < posInsert, '9b. Orden: bloqueo → comprobación de actividad → INSERT')
  verificar(!/\bexception\s+when\b/i.test(cuerpoFuncion), '9c. 0 bloque EXCEPTION WHEN — una violación del índice parcial propaga y revierte todo')
  verificar(!/pg_advisory/.test(cuerpoFuncion), '9d. 0 advisory lock (no aplica: no hay CURP en juego)')
  verificar(/inscripciones_alumno_ciclo_activo_uk/.test(migracion), '9e. El índice parcial existente se documenta como barrera definitiva')
  verificar(!/create (unique )?index|alter table|drop /i.test(codigoReal), '9f. 0 cambio de esquema (índices/tablas intactos)')

  // ============================================================
  // 10. Identidad: nunca por nombre/CURP.
  // ============================================================
  verificar(!/\bnombre\b/.test(cuerpoFuncion) && !/\bcurp\b/.test(cuerpoFuncion), '10. 0 referencia a nombre/curp — identidad solo por UUID')

  // ============================================================
  // 11. Privilegios.
  // ============================================================
  verificar(codigoReal.includes('revoke execute on function public.alta_inscripcion(uuid, uuid) from public;'), '11a. EXECUTE revocado de PUBLIC')
  verificar(codigoReal.includes('revoke execute on function public.alta_inscripcion(uuid, uuid) from anon;'), '11b. EXECUTE revocado de anon')
  verificar(codigoReal.includes('revoke execute on function public.alta_inscripcion(uuid, uuid) from authenticated;'), '11c. EXECUTE revocado de authenticated')
  verificar(!/grant /i.test(codigoReal), '11d. 0 GRANT en toda la migración')

  // ============================================================
  // 12. Fail-closed ante drift.
  // ============================================================
  verificar(/^create function public\.alta_inscripcion/m.test(codigoReal), '12. CREATE FUNCTION (sin OR REPLACE)')
  verificar(!/create or replace/i.test(codigoReal), '12b. 0 CREATE OR REPLACE')

  // ============================================================
  // 13. Compatibilidad con el contrato HMAC actual (sin modificarlo).
  // ============================================================
  verificar(esOperacionAplicableListaOficialValida({ tipo: 'alta_inscripcion', alumnoId: 'a1' }), '13. El contrato vigente {tipo, alumnoId} sigue siendo válido → mapea a p_alumno_id (+ grupoId firmado → p_grupo_id_destino)')
  verificar(!esOperacionAplicableListaOficialValida({ tipo: 'alta_inscripcion', alumnoId: 'a1', grupoIdDestino: 'g2' }), '13b. El contrato no transporta un grupo destino propio — la función no requiere ninguno adicional')
  verificar(!esOperacionAplicableListaOficialValida({ tipo: 'alta_inscripcion', alumnoId: 'a1', cicloEscolarId: 'c1' }), '13c. El contrato no transporta ciclo — la función lo deriva del grupo')

  // ============================================================
  // 14. 0 IA, 0 datos.
  // ============================================================
  verificar(!/anthropic|openai/i.test(migracion), '14. La migración no referencia ningún cliente de IA')
  verificar(!/\binsert into public\.(alumnos|grupos|ciclos_escolares)\b/.test(codigoReal), '14b. 0 escritura de datos fuera del INSERT de la función')

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
