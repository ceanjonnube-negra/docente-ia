// scripts/verificar-autorizacion-origen-inscripciones.ts
//
// V1-D2C1-B4B — corrección de seguridad (revisión focalizada previa al
// commit): la consulta batch de inscripciones de ORIGEN, reutilizada
// por 'baja' y 'traslado' en app/api/importar-alumnos/aplicar-plan/
// route.ts, ya NO confía en inscripciones.docente_id para confirmar la
// propiedad del grupo de origen.
//
// Por qué: inscripciones.docente_id se ESTAMPA una sola vez al crear
// la fila (ver supabase/migrations/20260912200000_importar_alumnos_a_grupo.sql)
// y nunca se actualiza después — ninguna función del proyecto lo toca
// tras la inserción. grupos.docente_id es el ÚNICO dato en vivo sobre
// quién es el propietario ACTUAL de un grupo. Tampoco basta la
// visibilidad bajo RLS: la policy real de `inscripciones` también
// autoriza vía `docente_grupos`, cuyo trigger de sincronización
// (fn_sync_docente_grupo) solo AGREGA una fila 'titular' al cambiar
// grupos.docente_id — nunca retira la del propietario anterior.
//
// La corrección confirma la propiedad del grupo de origen aparte, en
// una consulta batch independiente contra grupos.docente_id — mismo
// criterio exacto que ya usan dar_de_baja_inscripcion/
// importar_alumnos_a_grupo en SQL real.
//
// Verificación ESTÁTICA (sin credenciales, sin red, sin Supabase,
// sin datos reales) — el repositorio no tiene un patrón de pruebas
// HTTP con mocks de Supabase, y esta corrección no introduce uno
// nuevo: se audita el CÓDIGO REAL de la ruta por texto, mismo criterio
// que scripts/verificar-baja-individual-inscripcion.ts.
//
// Se ejecuta con `npx tsx scripts/verificar-autorizacion-origen-inscripciones.ts`.

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
const route = readFileSync(raiz('app', 'api', 'importar-alumnos', 'aplicar-plan', 'route.ts'), 'utf-8')

// Quita líneas que son ÚNICAMENTE un comentario `//` antes de buscar
// patrones de código real — evita falsos positivos cuando el propio
// comentario menciona, en prosa, algo que el código ya NO hace (mismo
// criterio que sinComentariosSql en otros scripts de esta familia).
function sinComentariosDeLinea(contenido: string): string {
  return contenido
    .split('\n')
    .filter((linea) => !linea.trim().startsWith('//'))
    .join('\n')
}
const codigoReal = sinComentariosDeLinea(route)

function main() {
  // ============================================================
  // 1. La consulta batch de inscripciones (por id) ya NO filtra por
  //    inscripciones.docente_id — el bloque completo de esa consulta,
  //    aislado por su posición en el código real, no debe contener
  //    ningún .eq('docente_id', ...).
  // ============================================================
  const inicioInscripciones = codigoReal.indexOf(".from('inscripciones')\n        .select('id, alumno_id, grupo_id, ciclo_escolar_id, estatus')")
  verificar(inicioInscripciones !== -1, '0. Se localizó exactamente la consulta batch de inscripciones de origen en el código real')
  const finInscripciones = codigoReal.indexOf('if (errorInscripciones)', inicioInscripciones)
  const bloqueConsultaInscripciones = codigoReal.slice(inicioInscripciones, finInscripciones)
  verificar(
    !bloqueConsultaInscripciones.includes(".eq('docente_id'"),
    "1. La consulta batch de inscripciones ya NO filtra por .eq('docente_id', ...) — el estampado histórico ya no se usa como prueba de propiedad del grupo"
  )

  // ============================================================
  // 2. Existe una consulta batch independiente contra `grupos`,
  //    filtrada por docente_id = auth.user.id, DENTRO del mismo bloque
  //    que carga inscripcionesCargadas (no solo la validación inicial
  //    del grupo destino, que es un bloque distinto y anterior).
  // ============================================================
  const inicioCargaInscripciones = codigoReal.indexOf('const inscripcionesCargadas = new Map')
  const bloqueCargaCompleto = codigoReal.slice(inicioCargaInscripciones, codigoReal.indexOf('\n\n', codigoReal.indexOf('inscripcionesCargadas.set', inicioCargaInscripciones)))
  verificar(
    /\.from\('grupos'\)\s*\.select\('id'\)\s*\.in\('id', idsGruposDeOrigenReferenciados\)\s*\.eq\('docente_id', auth\.user\.id\)/.test(bloqueCargaCompleto),
    '2. Dentro del bloque que carga inscripcionesCargadas existe una consulta batch independiente a grupos, filtrada por docente_id=auth.user.id (propiedad ACTUAL, no el estampado histórico)'
  )

  // ============================================================
  // 3. El conjunto de grupos propios ACTUALES se usa para EXCLUIR
  //    explícitamente (continue) cualquier inscripción cuyo grupo no
  //    esté en él — nunca se incorpora al mapa "por si acaso".
  // ============================================================
  verificar(bloqueCargaCompleto.includes('gruposPropiosAhora'), '3. Existe un conjunto explícito de grupos propios ACTUALES (gruposPropiosAhora)')
  verificar(
    /if \(!gruposPropiosAhora\.has\(i\.grupo_id as string\)\) \{\s*continue\s*\}/.test(bloqueCargaCompleto),
    '3b. Cada fila de inscripciones se descarta explícitamente (continue) si su grupo no está entre los propios actuales, ANTES de incorporarla a inscripcionesCargadas'
  )

  // ============================================================
  // 4. El filtrado ocurre ANTES del .set() — nunca después (que
  //    permitiría una ventana en la que una fila no autorizada ya
  //    quedó en el mapa).
  // ============================================================
  const posicionContinue = bloqueCargaCompleto.indexOf('continue')
  const posicionSet = bloqueCargaCompleto.indexOf('inscripcionesCargadas.set')
  verificar(posicionContinue !== -1 && posicionSet !== -1 && posicionContinue < posicionSet, '4. La exclusión (continue) ocurre ANTES de inscripcionesCargadas.set — nunca se agrega primero y se filtra después')

  // ============================================================
  // 5. 0 escritura — esta corrección sigue siendo estrictamente
  //    read-only (mismo criterio que toda la ruta).
  // ============================================================
  verificar(!/\binsert\b|\bupdate\b|\bdelete\b|\bupsert\b|\.rpc\(/i.test(bloqueCargaCompleto), '5. El bloque corregido no contiene ninguna escritura (INSERT/UPDATE/DELETE/UPSERT/RPC) — sigue siendo estrictamente read-only')

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
