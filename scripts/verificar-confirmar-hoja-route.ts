// scripts/verificar-confirmar-hoja-route.ts
//
// EVAL-1E — verificación estructural (sin credenciales, sin red, sin
// datos reales) de
// app/api/proyectos-seguimiento/[id]/confirmar-hoja/route.ts. Mismo
// criterio ya usado en foto-hoja/route.ts y analizar-hoja/route.ts:
// autenticarRequestApi hace una llamada de red real a auth.getUser(),
// no puede inyectarse — esta prueba confirma por inspección del código
// fuente las propiedades de seguridad/diseño que si fallaran
// silenciosamente serían graves: nunca service_role, el docente
// siempre se resuelve del access_token, gate de estado exacto, las 2
// reglas fail-closed cerradas en EVAL-1E, upsert (no insert plano)
// para retry-seguridad, y 0 llamadas IA.
//
// Se ejecuta con `npx tsx scripts/verificar-confirmar-hoja-route.ts`.

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

const RUTA = join(__dirname, '..', 'app', 'api', 'proyectos-seguimiento', '[id]', 'confirmar-hoja', 'route.ts')
const contenido = readFileSync(RUTA, 'utf-8')

function main() {
  // Seguridad — nunca service_role, nunca cliente propio.
  verificar(!contenido.includes('SERVICE_ROLE'), '1. No referencia ninguna clave SERVICE_ROLE')
  verificar(!contenido.includes('createClient('), '2. No crea su propio cliente de Supabase (usa auth.supabase de autenticarRequestApi)')
  verificar(contenido.includes('autenticarRequestApi'), '3. Se autentica con el mismo helper real usado en el resto de app/api/proyectos-seguimiento/*')
  verificar(contenido.includes('const docenteId = auth.user.id'), '4. docenteId se resuelve SIEMPRE de auth.user.id (nunca de un campo del body)')

  // Verificación de propiedad.
  verificar(/proyecto\.docente_id !== docenteId/.test(contenido), '5. Rechaza explícitamente un proyecto que no pertenece al docente real')

  // Gate de estado exacto — único estado del que se puede confirmar.
  verificar(/proyecto\.estado !== 'requiere_revision'/.test(contenido), "6. Solo permite confirmar desde estado exactamente 'requiere_revision' (rechaza tanto 'no analizado todavía' como 'ya confirmado')")

  // extraidoBruto fail-closed.
  verificar(/!extraidoBruto \|\| !Array\.isArray\(extraidoBruto\.filas\) \|\| extraidoBruto\.filas\.length === 0/.test(contenido), '7. Fail-closed si no existe ningún extraidoBruto (o está vacío) para confirmar')

  // roster_congelado fail-closed — misma regla que foto-hoja/analizar-hoja.
  verificar(/!rosterCongelado \|\| rosterCongelado\.length === 0/.test(contenido), '8. Fail-closed: rechaza la confirmación si hoja.roster_congelado está ausente (hoja histórica sin congelar)')

  // Las 2 reglas fail-closed viven en la lógica pura, nunca reimplementadas inline en la ruta.
  verificar(contenido.includes('prepararResultadosConfirmacion') && contenido.includes("from '@/lib/seguimiento/confirmarResultadosHoja'"), '9. Usa prepararResultadosConfirmacion (lógica pura) en vez de reimplementar las reglas de negocio dentro de la ruta')
  {
    const idxLlamada = contenido.indexOf('prepararResultadosConfirmacion(proyectoId')
    const bloqueSiguiente = idxLlamada > -1 ? contenido.slice(idxLlamada, idxLlamada + 600) : ''
    verificar(idxLlamada > -1 && /catch \(e\)/.test(bloqueSiguiente) && /status: 409/.test(bloqueSiguiente), '9b. Un error de prepararResultadosConfirmacion (cualquiera de las 2 reglas) se traduce a 409, nunca a una confirmación parcial')
  }

  // Persistencia real — upsert (no insert plano) por retry-seguridad, onConflict correcto.
  verificar(contenido.includes(".from('seguimiento_resultados')") && contenido.includes('.upsert('), '10. Escribe en seguimiento_resultados con upsert (nunca insert plano) — un reintento tras un fallo parcial no choca con la UNIQUE real')
  verificar(contenido.includes("onConflict: 'proyecto_id,inscripcion_id,indicador_numero'"), '10b. El onConflict coincide EXACTAMENTE con la UNIQUE real de la tabla (proyecto_id, inscripcion_id, indicador_numero)')

  // Transición de estado real al confirmar.
  verificar(contenido.includes("estado: 'confirmado'"), "11. Transiciona el proyecto a estado 'confirmado' tras guardar los resultados"
  )
  verificar(contenido.includes('confirmado_por: docenteId') && contenido.includes("origen_resultados: 'fotografia'"), "11b. Registra confirmado_por (el docente real, nunca uno que mande el cliente) y origen_resultados='fotografia' (columnas ya preparadas en EVAL-1B, nunca escritas hasta ahora)")

  // Orden real: primero se guardan los resultados, luego se marca confirmado — nunca al revés.
  const idxUpsert = contenido.indexOf(".from('seguimiento_resultados')\n      .upsert(")
  const idxUpdateConfirmado = contenido.indexOf("estado: 'confirmado'")
  verificar(idxUpsert > -1 && idxUpdateConfirmado > -1 && idxUpsert < idxUpdateConfirmado, '12. Los resultados se guardan (upsert) ANTES de marcar el proyecto como confirmado — nunca al revés')

  // 0 IA — este endpoint es 100% determinista sobre datos ya extraídos.
  verificar(!/anthropic\.messages|new Anthropic|openai\.|OpenAI\(/i.test(contenido), '13. 0 llamadas a IA/visión — toda la lógica es determinista sobre extraidoBruto ya existente')

  // Nunca toca Storage — esta fase no sube/descarga ninguna fotografía.
  verificar(!contenido.includes('subirBuffer') && !contenido.includes('descargarBuffer') && !contenido.includes('eliminarArchivo'), '14. Nunca sube/descarga/elimina archivos de Storage — solo lee datos ya persistidos')

  // Nunca DELETE físico de filas.
  verificar(!contenido.includes(".delete("), '15. Nunca ejecuta DELETE sobre filas de base de datos')

  // hoja_id requerido.
  verificar(/!proyecto\.hoja_id/.test(contenido), '16. Rechaza si el proyecto todavía no tiene una hoja de evaluación generada')

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
