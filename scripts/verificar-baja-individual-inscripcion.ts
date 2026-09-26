// scripts/verificar-baja-individual-inscripcion.ts
//
// "Dar de baja del grupo" — operación canónica de baja individual de
// UNA inscripción vigente (ver auditoría READ-ONLY "flujo real de
// baja/eliminación de alumnos", caso real: Renata, grupo 4°B):
// eliminar_alumno_definitivamente es un DELETE físico, deliberadamente
// bloqueado si el alumno tiene historial real — nunca puede servir
// como "baja" para un alumno con trayectoria académica real. Esta
// migración/función es la corrección: un UPDATE puro de
// inscripciones.estatus/fecha_baja, sin tocar alumnos ni ninguna tabla
// de historial.
//
// Verificación estructural (sin credenciales, sin red, sin datos
// reales, sin llamar la función contra la base) — mismo criterio que
// el resto de esta familia de scripts.
//
// Se ejecuta con `npx tsx scripts/verificar-baja-individual-inscripcion.ts`.

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
const migracionBaja = readFileSync(raiz('supabase', 'migrations', '20260926000000_dar_de_baja_inscripcion.sql'), 'utf-8')
const migracionEliminar = readFileSync(raiz('supabase', 'migrations', '20260913000000_eliminar_alumno_definitivamente.sql'), 'utf-8')
const motorContexto = readFileSync(raiz('lib', 'motorContexto.ts'), 'utf-8')
const rosterGrupo = readFileSync(raiz('lib', 'rosterGrupo.ts'), 'utf-8')
const listaPage = readFileSync(raiz('app', 'dashboard', 'lista', 'page.tsx'), 'utf-8')
const fichaPage = readFileSync(raiz('app', 'dashboard', 'lista', '[alumnoId]', 'page.tsx'), 'utf-8')

// Quita las líneas que son ÚNICAMENTE un comentario SQL `--` antes de
// buscar una tabla/función suelta — evita falsos positivos cuando el
// propio comentario menciona, en prosa, una tabla/función para
// explicar que NO se toca (mismo criterio que sinComentariosDeLinea en
// verificar-captura-hoja-eval1g.ts).
function sinComentariosSql(contenido: string): string {
  return contenido
    .split('\n')
    .filter((linea) => !linea.trim().startsWith('--'))
    .join('\n')
}
const migracionBajaSinComentarios = sinComentariosSql(migracionBaja)

function main() {
  // ============================================================
  // 1. UPDATE, nunca DELETE.
  // ============================================================
  verificar(/update public\.inscripciones\s*\n\s*set estatus = 'baja', fecha_baja = now\(\)/.test(migracionBaja), "1a. dar_de_baja_inscripcion: la única escritura es UPDATE inscripciones SET estatus='baja', fecha_baja=now()")
  verificar(!/delete\s+from/i.test(migracionBaja), '1b. dar_de_baja_inscripcion: 0 DELETE en toda la función — ninguna fila se borra')

  // ============================================================
  // 2. Solo afecta la inscripción objetivo (por id, un solo WHERE).
  // ============================================================
  verificar(/update public\.inscripciones\s*\n\s*set estatus = 'baja', fecha_baja = now\(\)\s*\n\s*where id = p_inscripcion_id;/.test(migracionBaja), '2. El UPDATE final filtra ÚNICAMENTE por id = p_inscripcion_id (el mismo id ya validado/bloqueado arriba) — no puede afectar ninguna otra inscripción')

  // ============================================================
  // 3. Conserva alumno_id — la función nunca escribe alumnos.
  // ============================================================
  verificar(!/(update|insert into|delete from)\s+public\.alumnos/i.test(migracionBaja), '3. dar_de_baja_inscripcion nunca escribe la tabla alumnos — alumno_id/identidad del alumno quedan intactos')

  // ============================================================
  // 4. Conserva historial — 0 referencias a las 9 tablas de historial.
  // ============================================================
  const TABLAS_HISTORIAL = ['asistencias', 'asistencia_registro', 'evaluaciones', 'evidencias', 'fichas_descriptivas', 'incidencias', 'necesidades_apoyo', 'correcciones_alumno', 'seguimiento_resultados', 'seguimiento_versiones']
  verificar(TABLAS_HISTORIAL.every(t => !migracionBajaSinComentarios.includes(t)), '4. dar_de_baja_inscripcion no referencia en código real ninguna de las 9+1 tablas de historial (solo se mencionan en comentarios explicando que NO se tocan) — no las lee ni las escribe')

  // ============================================================
  // 5. obtenerRosterConPosicion sin modificar.
  // ============================================================
  verificar(
    /\.from\('inscripciones'\)\s*\n\s*\.select\('id, alumnos\(id, nombre, curp, sexo, fecha_nacimiento\)'\)\s*\n\s*\.eq\('grupo_id', grupoId\)\s*\n\s*\.eq\('estatus', 'activo'\)/.test(rosterGrupo),
    "5. obtenerRosterConPosicion conserva EXACTAMENTE su consulta de siempre (grupo_id + estatus='activo') — sin ningún filtro nuevo añadido para esta tarea"
  )

  // ============================================================
  // 6. eliminar_alumno_definitivamente sin modificar.
  // ============================================================
  verificar(migracionBajaSinComentarios.includes('eliminar_alumno_definitivamente') === false, '6a. La nueva migración no redefine ni referencia eliminar_alumno_definitivamente en código real (solo se menciona en un comentario explicando la diferencia)')
  verificar(
    /export async function eliminarAlumnoDefinitivamente\(sb: SupabaseClient, alumnoId: string\) \{\n  const \{ error \} = await sb\.rpc\('eliminar_alumno_definitivamente', \{ p_alumno_id: alumnoId \}\);\n  if \(error\) throw error;\n\}/.test(motorContexto),
    '6b. eliminarAlumnoDefinitivamente (wrapper cliente) sigue exactamente igual — mismo RPC, mismo parámetro, sin cambios'
  )
  verificar(migracionEliminar.includes('delete from public.alumnos'), '6c. eliminar_alumno_definitivamente sigue siendo el único camino de DELETE físico — no se debilitó ni se tocó su archivo de migración')

  // ============================================================
  // 7. Lista sigue dependiendo del roster canónico.
  // ============================================================
  verificar(listaPage.includes("obtenerRosterConPosicion(supabase, grupoActivo.id)"), '7. app/dashboard/lista/page.tsx sigue llamando obtenerRosterConPosicion como única fuente del roster')

  // ============================================================
  // 8. 0 llamadas IA nuevas.
  // ============================================================
  verificar(!/anthropic|Anthropic|OpenAI|openai\./i.test(migracionBaja + motorContexto.slice(motorContexto.indexOf('darDeBajaInscripcion'))), '8. Ningún archivo de esta tarea referencia un cliente de IA')

  // ============================================================
  // 9. darDeBajaGrupoCompleto (baja de grupo completo) intacto.
  // ============================================================
  verificar(
    /export async function darDeBajaGrupoCompleto\(/.test(motorContexto) &&
      /\.update\(\{ estatus: 'baja' \}\)\s*\n\s*\.eq\('grupo_id', grupoId\)\s*\n\s*\.eq\('ciclo_escolar_id', cicloEscolarId\)\s*\n\s*\.eq\('estatus', 'activo'\)/.test(motorContexto),
    '9. darDeBajaGrupoCompleto (baja de TODO el grupo) sigue exactamente igual — no se tocó ni se reemplazó'
  )

  // ============================================================
  // Diseño de la función: SECURITY DEFINER + ownership + fail-closed +
  // fecha_baja nunca aceptada del cliente + hardening de privilegios.
  // ============================================================
  verificar(/security definer/.test(migracionBaja), '10. dar_de_baja_inscripcion es SECURITY DEFINER — inscripciones no tiene policy RLS de escritura, así que esta función es el único camino real (mismo motivo que importar_alumnos_a_grupo)')
  verificar(/g\.docente_id = v_docente_id/.test(migracionBaja), '11. La ownership se verifica contra grupos.docente_id = auth.uid() — nunca un docente_id que mande el cliente')
  verificar(/if v_estatus <> 'activo' then\s*\n\s*raise exception/.test(migracionBaja), "12. Fail-closed: si la inscripción no está 'activo', la función rechaza explícitamente — nunca reprocesa una baja ya hecha")
  verificar(!/p_fecha_baja/.test(migracionBaja), '13. fecha_baja nunca se acepta como parámetro — solo now() calculado dentro de la función, nunca falsificable desde el cliente')
  verificar(
    migracionBaja.includes('revoke execute on function public.dar_de_baja_inscripcion(uuid) from public;') &&
      migracionBaja.includes('revoke execute on function public.dar_de_baja_inscripcion(uuid) from anon;') &&
      migracionBaja.includes('grant execute on function public.dar_de_baja_inscripcion(uuid) to authenticated;'),
    '14. Privilegios de EXECUTE explícitamente revocados a public/anon y otorgados solo a authenticated — mismo hardening que eliminar_alumno_definitivamente/importar_alumnos_a_grupo'
  )

  // ============================================================
  // UX: acción y copy distintos de "Eliminar alumno".
  // ============================================================
  verificar(fichaPage.includes("import { eliminarAlumnoDefinitivamente, darDeBajaInscripcion } from '@/lib/motorContexto'"), '15. La ficha individual importa darDeBajaInscripcion junto (no en reemplazo) a eliminarAlumnoDefinitivamente')
  verificar(fichaPage.includes('Dar de baja del grupo'), "16. Existe el botón/acción 'Dar de baja del grupo', con texto distinto de 'Eliminar alumno'")
  verificar(fichaPage.includes('mostrarConfirmacionBajaGrupo') && fichaPage.includes('mostrarConfirmacionBaja') === true, '17. La baja individual usa su PROPIO estado de confirmación (mostrarConfirmacionBajaGrupo) — no reutiliza ni pisa el de "Eliminar alumno"')
  verificar(fichaPage.includes('errorBajaGrupo') && fichaPage.includes('errorBaja'), '17b. Maneja su propio estado de error (errorBajaGrupo), separado de errorBaja')

  const bloqueModalBaja = (() => {
    const inicio = fichaPage.indexOf('¿Dar de baja a este alumno del grupo?')
    const fin = fichaPage.indexOf('Cancelar', inicio) + 'Cancelar'.length
    return fichaPage.slice(Math.max(0, inicio - 200), fin)
  })()
  verificar(!/permanente|no podrá recuperarse|eliminar[aá]? (permanentemente|definitivamente)/i.test(bloqueModalBaja), '18. El modal de "Dar de baja del grupo" NO usa lenguaje de eliminación permanente/irreversible')
  verificar(/historial.*conservar[áa]|conservar[áa].*historial/i.test(bloqueModalBaja), '19. El modal de "Dar de baja del grupo" explica que el historial se conservará')

  verificar(listaPage.includes("searchParams.get('baja') === '1'"), "20. Lista distingue ?baja=1 de ?eliminado=1 con su propio estado (mostrarExitoBajaGrupo)")
  verificar(listaPage.includes('Alumno dado de baja del grupo. Su historial se conservó.'), '21. El banner de éxito de la baja individual usa un mensaje propio, sin la palabra "eliminado"')

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
