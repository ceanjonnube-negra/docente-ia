// scripts/verificar-trasladar-inscripcion.ts
//
// V1-D2C1-B4C — preparación (NO aplicación) de la función SQL
// trasladar_inscripcion (migración 20261008020000). Verificación
// ESTÁTICA (sin credenciales, sin red, sin DDL/DML remoto, sin datos
// reales) — mismo criterio que el resto de esta familia de scripts
// (ver scripts/verificar-baja-individual-inscripcion.ts,
// scripts/verificar-retiro-unique-inscripciones.ts): se audita el
// TEXTO real de la migración para confirmar que el alcance, la
// autorización y la semántica son exactamente los diseñados — no hay
// conexión a Supabase en ningún punto de este archivo.
//
// Se ejecuta con `npx tsx scripts/verificar-trasladar-inscripcion.ts`.

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
const migracion = readFileSync(raiz('supabase', 'migrations', '20261008020000_trasladar_inscripcion.sql'), 'utf-8')

// Mismo criterio que sinComentariosSql en otros scripts de esta
// familia — evita falsos positivos cuando el propio comentario
// menciona, en prosa, algo que el código NO hace.
function sinComentariosSql(contenido: string): string {
  return contenido
    .split('\n')
    .filter((linea) => !linea.trim().startsWith('--'))
    .join('\n')
}
const codigoReal = sinComentariosSql(migracion)

// Cuerpo de la función (entre CREATE FUNCTION y el primer `$$;`) —
// para acotar algunas comprobaciones exclusivamente al PL/pgSQL real,
// nunca a los GRANT/REVOKE que vienen después.
const inicioCuerpo = codigoReal.indexOf('create function public.trasladar_inscripcion')
const finCuerpo = codigoReal.indexOf('$$;', inicioCuerpo) + 3
const cuerpoFuncion = codigoReal.slice(inicioCuerpo, finCuerpo)

function main() {
  // ============================================================
  // 1. Firma exacta y tipo de retorno.
  // ============================================================
  verificar(
    /create function public\.trasladar_inscripcion\(\s*p_alumno_id uuid,\s*p_inscripcion_id_origen uuid,\s*p_grupo_id_destino uuid\s*\)/.test(codigoReal),
    '1. Firma exacta: trasladar_inscripcion(p_alumno_id uuid, p_inscripcion_id_origen uuid, p_grupo_id_destino uuid)'
  )
  verificar(/returns uuid/.test(codigoReal), '1b. Retorna uuid (el id de la inscripción nueva creada en el destino)')

  // ============================================================
  // 2. SECURITY DEFINER + search_path fijo — igual que
  //    dar_de_baja_inscripcion/importar_alumnos_a_grupo.
  // ============================================================
  verificar(/security definer/.test(codigoReal), '2. SECURITY DEFINER — inscripciones/grupos no tienen policy RLS de escritura suficiente para esto')
  verificar(/set search_path = ''/.test(codigoReal), "2b. SET search_path = '' fijo — mismo hardening que dar_de_baja_inscripcion/importar_alumnos_a_grupo")

  // ============================================================
  // 3. Todas las referencias a tablas dentro del cuerpo están
  //    calificadas con el esquema (public.inscripciones/public.grupos)
  //    — con search_path vacío, una referencia sin calificar fallaría
  //    en tiempo real; se confirma aquí que nunca ocurre.
  // ============================================================
  verificar(!/[^.]\bfrom inscripciones\b/.test(cuerpoFuncion), "3a. 0 referencia sin calificar 'from inscripciones' — siempre public.inscripciones")
  verificar(!/[^.]\bfrom grupos\b/.test(cuerpoFuncion), "3b. 0 referencia sin calificar 'from grupos' — siempre public.grupos")
  verificar(!/\bupdate inscripciones\b/.test(cuerpoFuncion), "3c. 0 UPDATE sin calificar sobre inscripciones")
  verificar(!/\binsert into inscripciones\b/.test(cuerpoFuncion), "3d. 0 INSERT sin calificar sobre inscripciones")
  verificar((cuerpoFuncion.match(/public\.inscripciones/g) || []).length >= 4, '3e. public.inscripciones (calificado) aparece múltiples veces en el cuerpo real')
  verificar((cuerpoFuncion.match(/public\.grupos/g) || []).length >= 2, '3f. public.grupos (calificado) aparece múltiples veces en el cuerpo real')

  // ============================================================
  // 4. Autenticación real — fail fast, mismo patrón que las demás
  //    funciones SECURITY DEFINER del proyecto.
  // ============================================================
  verificar(/v_docente_id uuid := auth\.uid\(\)/.test(cuerpoFuncion), '4. v_docente_id se deriva de auth.uid() real, nunca de un parámetro')
  verificar(/if v_docente_id is null then\s*\n\s*raise exception/.test(cuerpoFuncion), '4b. Sin auth.uid() real, la función falla explícitamente (fail-closed)')

  // ============================================================
  // 5. Bloqueo de la fila de origen (FOR UPDATE) ANTES de cualquier
  //    escritura — previene condiciones de carrera.
  // ============================================================
  verificar(/for update of i;/.test(cuerpoFuncion), '5. La fila de origen se bloquea explícitamente (FOR UPDATE OF i) antes de cualquier decisión')

  // ============================================================
  // 6. Propiedad REAL del grupo — NUNCA inscripciones.docente_id,
  //    SIEMPRE grupos.docente_id (join/where), para origen Y destino.
  //    Esta es la comprobación de seguridad más crítica de todo el
  //    archivo.
  // ============================================================
  verificar(!/\binscripciones\.docente_id\b/.test(cuerpoFuncion) && !/\bi\.docente_id\b/.test(cuerpoFuncion), '6. La función NUNCA referencia inscripciones.docente_id (el estampado histórico) para decidir autorización')
  const ocurrenciasOwnershipGrupo = (cuerpoFuncion.match(/g\.docente_id = v_docente_id/g) || []).length
  verificar(ocurrenciasOwnershipGrupo === 2, '6b. g.docente_id = v_docente_id se comprueba exactamente 2 veces — una para el grupo de ORIGEN y otra para el DESTINO, ambas contra el dato en vivo')

  // ============================================================
  // 7. Defensa en profundidad: el alumno de la fila real de origen
  //    debe coincidir con el alumnoId recibido — identidad derivada
  //    de la fila real, nunca confiada ciegamente al parámetro.
  // ============================================================
  verificar(/if v_alumno_id_real <> p_alumno_id then/.test(cuerpoFuncion), '7. Se compara el alumno_id REAL de la inscripción de origen contra p_alumno_id — nunca se asume que coinciden')

  // ============================================================
  // 8. Inscripción de origen debe estar activa.
  // ============================================================
  verificar(/if v_estatus_origen <> 'activo' then/.test(cuerpoFuncion), "8. La inscripción de origen debe tener estatus='activo' — fail-closed ante reintentos")

  // ============================================================
  // 9. Grupos distintos, mismo ciclo, misma institución — las 3
  //    validaciones de FORMA de la solicitud.
  // ============================================================
  verificar(/if v_grupo_id_origen = p_grupo_id_destino then/.test(cuerpoFuncion), '9a. Rechaza explícitamente origen=destino (mismo grupo)')
  verificar(/if v_ciclo_escolar_id_origen <> v_ciclo_escolar_id_destino then/.test(cuerpoFuncion), '9b. Rechaza explícitamente ciclos escolares distintos')
  verificar(/if v_institucion_id_origen <> v_institucion_id_destino then/.test(cuerpoFuncion), '9c. Rechaza explícitamente instituciones distintas')

  // ============================================================
  // 10. Verificación anticipada de "ya activo en destino" — excluye
  //     explícitamente la propia fila de origen (nunca se confunde
  //     consigo misma).
  // ============================================================
  verificar(/i\.id <> p_inscripcion_id_origen/.test(cuerpoFuncion), '10. La comprobación de actividad en destino excluye explícitamente la propia inscripción de origen')
  verificar(/if v_ya_activo_en_destino then/.test(cuerpoFuncion), '10b. Si el alumno ya tiene otra inscripción activa en el ciclo destino, se rechaza con un mensaje claro')

  // ============================================================
  // 11. UPDATE de la fila de origen — EXACTAMENTE el mismo patrón que
  //     dar_de_baja_inscripcion, filtrado únicamente por su propio id.
  // ============================================================
  verificar(
    /update public\.inscripciones\s*\n\s*set estatus = 'baja', fecha_baja = now\(\)\s*\n\s*where id = p_inscripcion_id_origen;/.test(cuerpoFuncion),
    "11. El UPDATE de cierre es exactamente SET estatus='baja', fecha_baja=now() WHERE id=p_inscripcion_id_origen — idéntico a dar_de_baja_inscripcion"
  )
  verificar((cuerpoFuncion.match(/update public\.inscripciones/g) || []).length === 1, '11b. Exactamente 1 UPDATE en toda la función — nunca afecta más de una fila por su cuenta')

  // ============================================================
  // 12. INSERT de la fila nueva — alumno_id preservado de la variable
  //     REAL (nunca del parámetro sin verificar), estatus='activo',
  //     numero_lista NUNCA se escribe (igual que importar_alumnos_a_grupo).
  // ============================================================
  verificar(
    /insert into public\.inscripciones \(alumno_id, grupo_id, ciclo_escolar_id, docente_id, estatus\)\s*\n\s*values \(v_alumno_id_real, p_grupo_id_destino, v_ciclo_escolar_id_destino, v_docente_id, 'activo'\)/.test(cuerpoFuncion),
    "12. El INSERT usa v_alumno_id_real (verificado), p_grupo_id_destino, el ciclo derivado, v_docente_id y estatus='activo'"
  )
  verificar(!/numero_lista/.test(cuerpoFuncion), '12b. numero_lista nunca se escribe — mismo criterio que importar_alumnos_a_grupo')
  verificar((cuerpoFuncion.match(/insert into public\.inscripciones/g) || []).length === 1, '12c. Exactamente 1 INSERT en toda la función')
  verificar(/returning id into v_inscripcion_id_nueva/.test(cuerpoFuncion), '12d. El id de la fila nueva se captura explícitamente (returning ... into)')
  verificar(/return v_inscripcion_id_nueva;/.test(cuerpoFuncion), '12e. La función devuelve el id de la inscripción nueva')

  // ============================================================
  // 13. 0 DELETE en toda la función — nunca se elimina ninguna fila.
  // ============================================================
  verificar(!/\bdelete\s+from\b/i.test(cuerpoFuncion), '13. 0 DELETE en toda la función — la inscripción de origen se conserva siempre, solo cambia su estatus')

  // ============================================================
  // 14. Las 7 tablas de historial NUNCA se referencian — esta función
  //     no las lee ni las escribe, confirmando que el historial queda
  //     intacto por construcción (nunca se tocan sus filas).
  // ============================================================
  const TABLAS_HISTORIAL = ['asistencia_registro', 'incidencias', 'evaluaciones', 'evidencias', 'necesidades_apoyo', 'fichas_descriptivas', 'seguimiento_resultados']
  verificar(TABLAS_HISTORIAL.every((t) => !codigoReal.includes(t)), '14. 0 referencia en código real a ninguna de las 7 tablas de historial (solo se mencionan en comentarios explicando que se preservan)')

  // ============================================================
  // 15. roster_congelado nunca se menciona ni se toca.
  // ============================================================
  verificar(!codigoReal.toLowerCase().includes('roster_congelado'), '15. 0 referencia en código real a roster_congelado')

  // ============================================================
  // 16. Identidad — 0 columna de nombre, 0 comparación de similitud;
  //     esta función solo opera con IDs ya resueltos.
  // ============================================================
  verificar(!/\bnombre\b/.test(cuerpoFuncion), '16. La función nunca referencia ninguna columna "nombre" — 0 resolución de identidad por nombre o similitud')

  // ============================================================
  // 17. GRANT/REVOKE — PUBLIC, anon Y authenticated quedan SIN
  //     EXECUTE; 0 GRANT a ningún rol (service_role conserva su acceso
  //     por defecto, sin tocarlo aquí).
  // ============================================================
  verificar(codigoReal.includes('revoke execute on function public.trasladar_inscripcion(uuid, uuid, uuid) from public;'), '17a. EXECUTE revocado explícitamente de PUBLIC')
  verificar(codigoReal.includes('revoke execute on function public.trasladar_inscripcion(uuid, uuid, uuid) from anon;'), '17b. EXECUTE revocado explícitamente de anon')
  verificar(codigoReal.includes('revoke execute on function public.trasladar_inscripcion(uuid, uuid, uuid) from authenticated;'), '17c. EXECUTE revocado explícitamente de authenticated — NO invocable todavía por ningún docente real')
  verificar(!/grant execute/i.test(codigoReal), '17d. 0 GRANT EXECUTE en toda la migración — ningún rol recibe acceso nuevo; service_role conserva únicamente lo que ya tenía por defecto')

  // ============================================================
  // 18. Fail-closed no idempotente — CREATE FUNCTION, nunca CREATE OR
  //     REPLACE (mismo criterio que dar_de_baja_inscripcion): si la
  //     función ya existiera por un drift no auditado, debe fallar al
  //     aplicarse, nunca sobrescribir en silencio.
  // ============================================================
  verificar(/^create function public\.trasladar_inscripcion/m.test(codigoReal), '18. CREATE FUNCTION (sin OR REPLACE) — fail-closed ante un drift de esquema no auditado')
  verificar(!/create or replace function public\.trasladar_inscripcion/.test(codigoReal), '18b. Confirmación negativa explícita: 0 "CREATE OR REPLACE" para esta función')

  // ============================================================
  // 19. 0 IA en toda la migración.
  // ============================================================
  verificar(!/anthropic|openai/i.test(migracion), '19. La migración no referencia ningún cliente de IA')

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
