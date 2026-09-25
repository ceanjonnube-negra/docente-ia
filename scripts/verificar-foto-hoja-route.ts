// scripts/verificar-foto-hoja-route.ts
//
// EVAL-1C — verificación estructural (sin credenciales, sin red, sin
// datos reales) de app/api/proyectos-seguimiento/[id]/foto-hoja/route.ts.
// Mismo criterio ya usado en el resto de este proyecto para endpoints
// Route Handler de Next.js: ninguno de ellos tiene un doble en memoria
// de SupabaseClient (autenticarRequestApi hace una llamada de red real
// a auth.getUser(), no puede inyectarse) — [id]/hoja/route.ts, el
// endpoint hermano, tampoco tiene una prueba propia por la misma razón
// (solo se prueba lib/seguimiento/generarYGuardarHoja.ts, la lógica
// pura que ese endpoint invoca). Esta prueba confirma por inspección
// del código fuente las propiedades de seguridad/diseño que si
// fallaran silenciosamente serían graves: nunca service_role, el
// docente siempre se resuelve del access_token (nunca de un valor que
// mande el cliente), fail-closed ante roster_congelado ausente,
// verificación de propiedad del proyecto, whitelist de formato/tamaño,
// y 0 llamadas a IA.
//
// Se ejecuta con `npx tsx scripts/verificar-foto-hoja-route.ts`.

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

const RUTA = join(__dirname, '..', 'app', 'api', 'proyectos-seguimiento', '[id]', 'foto-hoja', 'route.ts')
const contenido = readFileSync(RUTA, 'utf-8')

function main() {
  // Seguridad — nunca service_role, nunca cliente propio.
  verificar(!contenido.includes('SERVICE_ROLE'), '1. No referencia ninguna clave SERVICE_ROLE')
  verificar(!contenido.includes('createClient('), '2. No crea su propio cliente de Supabase (usa auth.supabase de autenticarRequestApi)')
  verificar(contenido.includes('autenticarRequestApi'), '3. Se autentica con el mismo helper real usado en el resto de app/api/proyectos-seguimiento/*')

  // El docente real se resuelve del token, nunca del cliente.
  verificar(contenido.includes('const docenteId = auth.user.id'), '4. docenteId se resuelve SIEMPRE de auth.user.id (nunca de un campo del formData)')
  verificar(!/docenteId\s*=\s*formData/.test(contenido), '5. docenteId nunca se lee de formData')

  // Verificación de propiedad — el proyecto debe pertenecer al docente real.
  verificar(/proyecto\.docente_id !== docenteId/.test(contenido), '6. Rechaza explícitamente un proyecto que no pertenece al docente real')

  // Fail-closed: sin roster_congelado, no se acepta la fotografía.
  verificar(/!hoja\.roster_congelado/.test(contenido), '7. Fail-closed: rechaza la carga si hoja.roster_congelado está ausente (hoja histórica sin congelar, ej. SG-VXKR)')

  // Bloqueo post-confirmación.
  verificar(contenido.includes('ESTADOS_POST_CONFIRMACION') && /confirmado[\s\S]*corregido[\s\S]*sustituido[\s\S]*cerrado/.test(contenido), '8. Rechaza cargar otra fotografía si el proyecto ya pasó por confirmación')

  // Validación de archivo.
  verificar(contenido.includes('MIME_POR_EXTENSION') && contenido.includes('heic:'), '9. Solo acepta un whitelist cerrado de formatos de imagen (jpg/jpeg/png/webp/heic)')
  verificar(/archivo\.size > TAMANO_MAXIMO_BYTES/.test(contenido), '10. Rechaza archivos por encima de un límite de tamaño explícito')

  // Storage — mismo bucket/patrón ya auditado (PLN-1E-H), nunca otro bucket.
  verificar(contenido.includes('BUCKET_HOJAS_SEGUIMIENTO') && !contenido.includes('BUCKET_DOCUMENTOS_GENERADOS') && !contenido.includes('BUCKET_IMAGENES_GENERADAS'), '11. Solo sube a hojas-seguimiento — nunca a otro bucket')
  verificar(contenido.includes('rutaArchivo(docenteId'), '12. La ruta de Storage se construye con el docente real como primer segmento (coincide con la política RLS ya activa: (storage.foldername(name))[1] = auth.uid())')

  // Reemplazo, no acumulación — limpieza de la foto anterior sin confirmar.
  verificar(contenido.includes('capturaPrevia') && contenido.includes('eliminarArchivo'), '13. Reemplaza (limpia) una captura pendiente anterior en vez de acumular fotografías huérfanas')

  // Persistencia mínima — solo lo que EVAL-1C/EVAL-1D.2 deben escribir, nada de extracción/resultados.
  verificar(contenido.includes("captura_pendiente:") && contenido.includes('fotos'), "14. Persiste captura_pendiente.fotos (arreglo ordenado, EVAL-1D.2) — evolución compatible del snapshot temporal diseñado en EVAL-1B")
  verificar(contenido.includes("estado: 'fotografia_cargada'"), "15. Transiciona el proyecto al estado 'fotografia_cargada' (valor ya válido en el CHECK real, nunca usado hasta ahora)")

  // ============================================================
  // EVAL-1D.2 — soporte multipágina.
  // ============================================================

  // Campo "pagina" opcional, con default 1 — una hoja de 1 sola página
  // sigue funcionando exactamente igual sin que el cliente lo envíe.
  verificar(contenido.includes("formData.get('pagina')"), "19. Lee un campo 'pagina' opcional del formData")
  verificar(/pagina\s*=\s*paginaBruta\s*===\s*null\s*\|\|\s*paginaBruta\s*===\s*''\s*\?\s*1\s*:/.test(contenido), "20. 'pagina' ausente/vacía siempre equivale a página 1 (compatibilidad con un cliente que nunca envía este campo)")
  verificar(/!Number\.isInteger\(pagina\)\s*\|\|\s*pagina\s*<\s*1/.test(contenido), "21. Rechaza un valor de página no entero o menor a 1")

  // El máximo de página aceptado se deriva de la geometría real del
  // PDF (roster_congelado.length), nunca de un número que el cliente
  // pueda inflar.
  verificar(contenido.includes('calcularCantidadPaginasHoja') && contenido.includes("from '@/lib/documentGen/generarHojaSeguimientoPdf'"), "22. Importa calcularCantidadPaginasHoja (misma fuente de verdad que el renderizador real del PDF) para acotar el número de página")
  verificar(/pagina > paginasEsperadas/.test(contenido), "23. Rechaza una página fuera del rango real de la hoja (pagina > paginasEsperadas) — nunca acepta 'página 37' de una hoja de 1 sola página")

  // Reemplaza SOLO la página cargada, conserva las demás — nunca
  // acumula fotografías arbitrariamente (el máximo real de entradas
  // queda acotado por paginasEsperadas, validado antes de subir nada).
  verificar(contenido.includes('extraerFotosCapturaPendiente'), "24. Lee las fotos previas con extraerFotosCapturaPendiente — misma función que analizar-hoja/route.ts, compatibilidad retroactiva total con la forma histórica de 1 sola foto")
  verificar(/fotosPrevias\.filter\(\(f\) => f\.pagina !== pagina\)/.test(contenido), "25. Al reemplazar, conserva las páginas DISTINTAS a la que se está subiendo — nunca las pierde ni las duplica")

  // Cualquier carga (nueva o de reemplazo) invalida una transcripción
  // previa — captura_pendiente se reescribe SOLO con el arreglo de
  // fotos actualizado, nunca conserva un extraidoBruto obsoleto.
  verificar(/captura_pendiente:\s*\{\s*fotos:\s*fotosActualizadas\s*\}/.test(contenido), "26. El UPDATE reescribe captura_pendiente completo con solo { fotos: fotosActualizadas } — cualquier extraidoBruto previo queda invalidado, nunca sobrevive a una foto nueva")
  // Búsqueda de un USO real (.from('seguimiento_resultados')), nunca
  // una simple mención en comentario (el propio archivo explica en
  // prosa, a propósito, que NO escribe ahí — esa frase no debe contar
  // como falso positivo de que sí lo hace).
  verificar(!contenido.includes(".from('seguimiento_resultados')"), '16. NUNCA escribe en seguimiento_resultados — esta fase no persiste resultados, solo la fotografía')

  // 0 IA, 0 visión — confirmación estática.
  verificar(!/anthropic\.messages|new Anthropic|openai\.|OpenAI\(/i.test(contenido), '17. 0 llamadas a IA/visión — esta fase es solo carga y validación determinista')

  // Nunca DELETE físico de filas (solo Storage, vía eliminarArchivo).
  verificar(!contenido.includes(".from('proyectos_seguimiento').delete(") && !contenido.includes(".from('hojas_evaluacion').delete("), '18. Nunca ejecuta DELETE sobre filas de base de datos')

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
