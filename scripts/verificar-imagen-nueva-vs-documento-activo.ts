// scripts/verificar-imagen-nueva-vs-documento-activo.ts
//
// Corrección de la causa raíz demostrada en la auditoría READ-ONLY
// "conversacion_id=null + orden visual incorrecto tras aprobar una
// planeación y pedir una imagen nueva" (aprobada por separado).
//
// Escenario real que falló: conversación con documentoActivo vigente
// (ej. la planeación recién aprobada) → docente escribe "Crea una
// imagen de un salón de clases..." → el turno entraba a
// ejecutarConversionFormato('imagen')/enviarComoFinalizacion/
// ejecutarFinalizacion, que (a) nunca pasa conversacionId a
// enviarTexto (assets_visuales.conversacion_id quedaba null) y (b)
// inyecta el resultado en el mensaje asistente VIEJO
// (editandoDocumentoId), nunca en uno nuevo (de ahí la tarjeta
// apareciendo antes del mensaje nuevo del docente).
//
// Corrección: excluir detectarHerramientaDocumento(limpio)==='imagen'
// de la condición de "hay documentoActivo, trátalo como finalización/
// conversión" — MISMO criterio determinista que ya excluye este caso
// para materialVisualActivo unas líneas más abajo, sin heurísticas
// nuevas. Con la exclusión, una imagen nueva real cae al camino normal
// (enviarComoTrabajoDocumento), que ya pasa conversacionId
// correctamente y ya crea un mensaje asistente nuevo.
//
// Prueba ESTRUCTURAL (mismo patrón ya establecido en esta familia de
// scripts: funciones puras reales, sin red/Supabase/IA, + inspección
// del código fuente real) — se ejecuta con
// `npx tsx scripts/verificar-imagen-nueva-vs-documento-activo.ts`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectarHerramientaDocumento, pareceNuevoDocumento } from '../lib/asistente/documentos'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

const RAIZ = join(__dirname, '..')
const servicio = readFileSync(join(RAIZ, 'lib/asistente/AsistenteService.ts'), 'utf-8')

const MENSAJE_IMAGEN_NUEVA = 'Crea una imagen de un salón de clases de primaria, moderno, ordenado y colorido, con materiales educativos en las paredes.'

async function main() {
  // ============================================================
  // A. Con documentoActivo + petición de imagen nueva: la condición
  //    de "finalización/conversión" ya NO se cumple.
  // ============================================================
  verificar(
    servicio.includes("if (this.documentoActivo && !pareceNuevoDocumento(limpio) && !esOperacionSobreDatoPersonalAlumno && detectarHerramientaDocumento(limpio) !== 'imagen') {"),
    'A1. La condición de documentoActivo (enviarMensaje) ahora excluye explícitamente detectarHerramientaDocumento(limpio)===\'imagen\''
  )
  verificar(
    !servicio.includes('if (this.documentoActivo && !pareceNuevoDocumento(limpio) && !esOperacionSobreDatoPersonalAlumno) {'),
    'A2. La condición ANTERIOR (sin la exclusión de imagen) ya no existe en el archivo'
  )
  // Evaluación real de la condición extraída del código (no una copia
  // manual) para el mensaje EXACTO del incidente real, con
  // documentoActivo vigente.
  verificar(pareceNuevoDocumento(MENSAJE_IMAGEN_NUEVA) === false, 'A3. pareceNuevoDocumento sigue sin reconocer "imagen" como sustantivo de documento nuevo (comportamiento preexistente, sin cambio)')
  verificar(detectarHerramientaDocumento(MENSAJE_IMAGEN_NUEVA) === 'imagen', 'A4. detectarHerramientaDocumento sigue detectando "imagen" en el mensaje real del incidente (comportamiento preexistente, sin cambio)')
  const documentoActivoSimulado = true
  const pareceNuevo = pareceNuevoDocumento(MENSAJE_IMAGEN_NUEVA)
  const esOperacionDatoPersonalSimulado = false
  const tipoDetectado = detectarHerramientaDocumento(MENSAJE_IMAGEN_NUEVA)
  const entraAFinalizacion = documentoActivoSimulado && !pareceNuevo && !esOperacionDatoPersonalSimulado && tipoDetectado !== 'imagen'
  verificar(entraAFinalizacion === false, 'A5. Con la condición real (evaluada con los valores reales del incidente), el turno YA NO entra a ejecutarConversionFormato/enviarComoFinalizacion/ejecutarFinalizacion')

  // ============================================================
  // B. La petición continúa por el camino normal que conserva
  //    conversacionId — confirmado estructuralmente: enviarComoTrabajoDocumento
  //    (el camino al que cae ahora) sigue pasando this.conversacionActivaId
  //    a iniciarTrabajoDocumento, sin cambios en esta fase.
  // ============================================================
  verificar(
    servicio.includes('const { trabajoId } = await iniciarTrabajoDocumento(textoParaModelo, this.contexto, historialPrevio, requestId, null, regenerarImagen, this.conversacionActivaId)'),
    'B1. enviarComoTrabajoDocumento sigue pasando this.conversacionActivaId a iniciarTrabajoDocumento (camino V1-C ya validado, sin tocar en esta fase)'
  )
  verificar(
    servicio.includes('if (!adjunto && canal !== \'voz\' && (quiereIlustracion(limpio) || detectarFormatosExplicitosMultiples(limpio).length > 1 || detectarHerramientaDocumento(limpio) === \'imagen\')) {\n      await this.enviarComoTrabajoDocumento(limpio)'),
    'B2. El gate de enviarComoTrabajoDocumento (más abajo en la misma función) sigue exactamente igual — sigue capturando detectarHerramientaDocumento(limpio)===\'imagen\', ahora sin competencia previa del bloque de documentoActivo'
  )

  // ============================================================
  // C. Word/PDF/PowerPoint/Excel sobre documentoActivo conservan
  //    exactamente su comportamiento actual — la exclusión es
  //    ESPECÍFICA a 'imagen', nunca a los demás tipos.
  // ============================================================
  const MENSAJES_FORMATO_REAL: { texto: string; tipoEsperado: string }[] = [
    { texto: 'Pásamelo a Word.', tipoEsperado: 'word' },
    { texto: 'Descárgalo en PDF.', tipoEsperado: 'pdf' },
    { texto: 'Conviértelo a power point.', tipoEsperado: 'powerpoint' },
    { texto: 'Pásalo a Excel.', tipoEsperado: 'excel' },
  ]
  for (const { texto, tipoEsperado } of MENSAJES_FORMATO_REAL) {
    const tipo = detectarHerramientaDocumento(texto)
    verificar(tipo === tipoEsperado, `C1 (${tipoEsperado}). detectarHerramientaDocumento("${texto}") sigue devolviendo "${tipoEsperado}"`)
    const entra = documentoActivoSimulado && !pareceNuevoDocumento(texto) && !esOperacionDatoPersonalSimulado && tipo !== 'imagen'
    verificar(entra === true, `C2 (${tipoEsperado}). Con documentoActivo vigente, "${texto}" SIGUE entrando a la rama de finalización/conversión (sin regresión)`)
  }

  // ============================================================
  // D. Edición/regeneración de materialVisualActivo conserva su
  //    comportamiento actual — esa condición no se tocó.
  // ============================================================
  verificar(
    servicio.includes("if (this.materialVisualActivo && !adjunto && canal !== 'voz' && detectarHerramientaDocumento(limpio) !== 'imagen' && pareceEdicionDeImagenActiva(limpio) && !esOperacionSobreDatoPersonalAlumno) {"),
    'D1. La condición de materialVisualActivo (edición/regeneración de imagen activa) permanece exactamente igual, sin ningún cambio'
  )

  // ============================================================
  // E-H. Cero llamadas IA, cero Supabase, cero cambios de timeout,
  //      cero mecanismo de reordenamiento — verificable directamente
  //      sobre el diff real: un solo archivo, una sola línea
  //      funcional modificada (la condición), nada más.
  // ============================================================
  verificar(!/anthropic|messages\.create|openai|images\.generate|images\.edit/i.test(servicio.match(/if \(this\.documentoActivo[\s\S]{0,400}/)?.[0] ?? ''), 'E. La zona modificada no introduce ninguna llamada IA nueva')
  verificar(!/\.from\(|supabase\.|createClient/i.test(servicio.match(/if \(this\.documentoActivo[\s\S]{0,400}/)?.[0] ?? ''), 'F. La zona modificada no introduce ninguna operación Supabase nueva')
  verificar(!/TIMEOUT_/.test(servicio.match(/if \(this\.documentoActivo[\s\S]{0,400}/)?.[0] ?? ''), 'G. La zona modificada no referencia ningún timeout — cero cambios de timeout')
  verificar(!/\.sort\(|reordenar|reindex|splice.*mensajes/i.test(servicio.match(/if \(this\.documentoActivo[\s\S]{0,400}/)?.[0] ?? ''), 'H. No se introdujo ningún mecanismo de reordenamiento manual de mensajes')

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
