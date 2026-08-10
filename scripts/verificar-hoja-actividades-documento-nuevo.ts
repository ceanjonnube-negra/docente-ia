// scripts/verificar-hoja-actividades-documento-nuevo.ts
//
// Prueba aislada de "bug real: hoja de actividades ilustrada mostró
// el examen anterior" — causa raíz real (no supuesta, ver diagnóstico
// entregado): SUSTANTIVOS_DOCUMENTO (lib/asistente/documentos.ts) no
// incluía "hoja", así que pareceNuevoDocumento() nunca reconocía
// "Hazme una hoja de actividades..." como creación de un documento
// nuevo — el mensaje caía en el bloque de "documento activo" de
// AsistenteService.ts (enviarMensaje, línea ~1243) y, como ya existía
// un Word cacheado del examen anterior (documentoActivo.
// archivosGenerados['word']), ejecutarConversionFormato() lo volvía a
// mostrar tal cual (reutilizarArchivoExistente) sin llamar nunca a
// Claude ni generar contenido nuevo.
//
// Corrección: agregar "hoja(s)?" a SUSTANTIVOS_DOCUMENTO — un token
// más en una lista de alternancia regex ya existente.
//
// Ejecución REAL (función pura, sin red) de pareceNuevoDocumento
// contra el mensaje EXACTO reportado + los 10 casos de edición real
// que ya cubría scripts/verificar-creacion-nueva-vs-documento-activo.ts
// (deben seguir en false — sin regresión) + verificación ESTRUCTURAL
// de dónde vive el hueco original.
// Se ejecuta con
// `npx tsx scripts/verificar-hoja-actividades-documento-nuevo.ts`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pareceNuevoDocumento } from '../lib/asistente/documentos'

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
const cuerpoDocumentos = readFileSync(join(RAIZ, 'lib/asistente/documentos.ts'), 'utf-8')

const MENSAJE_REPORTADO =
  'Hazme una hoja de actividades ilustrada sobre el ciclo del agua para 4° de primaria. Quiero título, nombre del alumno, instrucciones claras, ilustraciones bonitas integradas, 5 actividades variadas y espacio suficiente para responder. Genera Word y PDF.'

const INSTRUCCIONES_EDICION_REAL = [
  'Cambia solamente la portada.',
  'Agrega una sección final con ejercicios.',
  'Hazlo más detallado.',
  'Hazla para 3° B.',
  'Ponle una ilustración del ciclo completo.',
  'Que tenga actividades al final.',
  'Hazme el examen en blanco y negro para imprimir.',
  'Ahora conviértela en blanco y negro para imprimir.',
  'Corrige la ortografía.',
  'Descárgalo en PDF.',
  // Caso nuevo específico de esta corrección — artículo DEFINIDO "la"
  // sobre "hoja": sigue siendo edición del documento activo, nunca
  // creación nueva (mismo criterio que "cámbiale el título a LA
  // guía" ya documentado).
  'Cambia el título de la hoja.',
  'Agrégale más espacio a la hoja.',
]

async function main() {
  // ============================================================
  // 1. El mensaje EXACTO reportado ahora se detecta como creación
  //    NUEVA.
  // ============================================================
  verificar(pareceNuevoDocumento(MENSAJE_REPORTADO), 'pareceNuevoDocumento detecta el mensaje EXACTO del bug reportado ("Hazme una hoja de actividades ilustrada...") como creación nueva')

  // ============================================================
  // 2. Otras formas razonables de pedir una hoja de actividades como
  //    documento nuevo.
  // ============================================================
  verificar(pareceNuevoDocumento('Hazme una hoja de trabajo sobre fracciones para 5°.'), 'pareceNuevoDocumento detecta "Hazme una hoja de trabajo..." como creación nueva')
  verificar(pareceNuevoDocumento('Necesito una hoja de ejercicios de sumas.'), 'pareceNuevoDocumento detecta "Necesito una hoja de ejercicios..." como creación nueva')

  // ============================================================
  // 3. Sin regresión — ninguna instrucción de edición real (incluidas
  //    las nuevas con artículo definido "la hoja") se confunde con
  //    creación nueva.
  // ============================================================
  for (const instruccion of INSTRUCCIONES_EDICION_REAL) {
    verificar(!pareceNuevoDocumento(instruccion), `pareceNuevoDocumento NO se activa con instrucción de edición real: "${instruccion}"`)
  }

  // ============================================================
  // 4. Verificación estructural — el fix real vive donde dice el
  //    diagnóstico, cambio aditivo de una palabra.
  // ============================================================
  verificar(/SUSTANTIVOS_DOCUMENTO = '[^']*\bhoja\(s\)\?/.test(cuerpoDocumentos), 'SUSTANTIVOS_DOCUMENTO incluye "hoja(s)?" en lib/asistente/documentos.ts')

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
