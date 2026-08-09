// scripts/verificar-creacion-nueva-vs-documento-activo.ts
//
// Prueba aislada de "fallo crítico: guía ilustrada devolvió
// LISTA_OFICIAL_DE_ALUMNOS.docx" — REGLA FUNCIONAL OBLIGATORIA: si el
// docente pide un material NUEVO ("Hazme una guía... sobre X"), el
// sistema debe tratarlo como creación nueva, nunca como edición ni
// reutilización de un documentoActivo previo no relacionado, aunque
// ese documento activo exista.
//
// Causa raíz real (confirmada leyendo el código, no supuesta):
// mientras existía documentoActivo, CUALQUIER mensaje que nombrara un
// formato real ("...Genera también Word y PDF.") se trataba como
// "finaliza EL documento activo en ese formato" — sin importar que el
// mensaje describiera un tema completamente distinto y nuevo. Además,
// detectarFormatoExplicito solo devuelve UN formato (por diseño, para
// "un archivo a la vez"), así que aunque se hubiera generado el
// documento correcto, pedir "Word y PDF" en el mismo mensaje solo
// habría producido uno de los dos.
//
// Ejecución REAL (funciones puras, sin red) de pareceNuevoDocumento y
// detectarFormatosExplicitosMultiples contra el escenario EXACTO
// reportado + verificación ESTRUCTURAL de cómo se usan en
// AsistenteService.ts / app/api/chat/route.ts.
// Se ejecuta con
// `npx tsx scripts/verificar-creacion-nueva-vs-documento-activo.ts`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pareceNuevoDocumento, detectarFormatosExplicitosMultiples } from '../lib/asistente/documentos'

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
const cuerpoAsistenteService = readFileSync(join(RAIZ, 'lib/asistente/AsistenteService.ts'), 'utf-8')
const cuerpoChatRoute = readFileSync(join(RAIZ, 'app/api/chat/route.ts'), 'utf-8')

async function main() {
  // ============================================================
  // 1. pareceNuevoDocumento — el escenario EXACTO reportado.
  // ============================================================
  const MENSAJE_REPORTADO = 'Hazme una guía completa, detallada e ilustrada sobre el ciclo del agua para 4° de primaria... Genera también Word y PDF.'
  verificar(pareceNuevoDocumento(MENSAJE_REPORTADO), 'pareceNuevoDocumento detecta el mensaje EXACTO del fallo reportado como creación nueva')

  // ============================================================
  // 2. pareceNuevoDocumento — NUNCA debe activarse con instrucciones
  //    de edición reales del documento YA activo (no regresión: estas
  //    deben seguir editando, nunca reiniciar como documento nuevo).
  // ============================================================
  const INSTRUCCIONES_EDICION_REAL = [
    'Cambia solamente la portada.',
    'Agrega una sección final con ejercicios.',
    'Hazlo más detallado.',
    'Hazla para 3° B.',
    'Ponle una ilustración del ciclo completo.',
    'Que tenga actividades al final.',
    'Hazme el examen en blanco y negro para imprimir.', // artículo DEFINIDO "el" — sigue siendo el mismo examen activo
    'Ahora conviértela en blanco y negro para imprimir.',
    'Corrige la ortografía.',
    'Descárgalo en PDF.',
  ]
  for (const instruccion of INSTRUCCIONES_EDICION_REAL) {
    verificar(!pareceNuevoDocumento(instruccion), `pareceNuevoDocumento NO se activa con instrucción de edición real: "${instruccion}"`)
  }

  // ============================================================
  // 3. pareceNuevoDocumento — sí debe activarse con otras peticiones
  //    de creación nueva razonables (no solo el caso reportado).
  // ============================================================
  verificar(pareceNuevoDocumento('Hazme una ficha ilustrada sobre las partes de la planta para 4°.'), 'pareceNuevoDocumento detecta "Hazme una ficha..." como creación nueva')
  verificar(pareceNuevoDocumento('Genera un examen de matemáticas para 5° grado.'), 'pareceNuevoDocumento detecta "Genera un examen..." como creación nueva')
  verificar(pareceNuevoDocumento('Necesito una planeación sobre los ecosistemas.'), 'pareceNuevoDocumento detecta "Necesito una planeación..." como creación nueva')

  // ============================================================
  // 4. detectarFormatosExplicitosMultiples — real, sin red.
  // ============================================================
  verificar(
    JSON.stringify(detectarFormatosExplicitosMultiples(MENSAJE_REPORTADO)) === JSON.stringify(['word', 'pdf']),
    'detectarFormatosExplicitosMultiples detecta AMBOS formatos (word y pdf) en el mensaje reportado, en el orden de prioridad establecido'
  )
  verificar(
    JSON.stringify(detectarFormatosExplicitosMultiples('Hazme una guía sobre el agua, en Word.')) === JSON.stringify(['word']),
    'detectarFormatosExplicitosMultiples devuelve solo UN formato cuando solo se pidió uno'
  )
  verificar(
    detectarFormatosExplicitosMultiples('Hazme una guía sobre el agua.').length === 0,
    'detectarFormatosExplicitosMultiples no detecta ningún formato si el mensaje no nombra ninguno'
  )
  verificar(
    detectarFormatosExplicitosMultiples('Hazme una guía ilustrada sobre el ciclo del agua.').length === 0,
    'detectarFormatosExplicitosMultiples NO confunde "ilustrada" con un formato real (imagen/audio/video quedan excluidos a propósito)'
  )

  // ============================================================
  // 5. AsistenteService.ts — el gate real usa pareceNuevoDocumento
  //    ANTES de decidir editar/finalizar el documento activo.
  // ============================================================
  verificar(cuerpoAsistenteService.includes('if (this.documentoActivo && !pareceNuevoDocumento(limpio)) {'), 'enviarMensaje() excluye explícitamente los mensajes de creación nueva del bloque de documento activo — nunca los trata como edición/finalización del documento viejo')
  verificar(cuerpoAsistenteService.includes("pareceNuevoDocumento, type TipoHerramienta } from './documentos'"), 'pareceNuevoDocumento se importa realmente desde lib/asistente/documentos.ts (no una copia local)')

  // ============================================================
  // 6. app/api/chat/route.ts — CASO 3 genera TODOS los formatos
  //    pedidos explícitamente, nunca solo el primero; un formato
  //    secundario que falla no bloquea los demás; si falla el
  //    primario, sí se propaga como error real.
  // ============================================================
  verificar(cuerpoChatRoute.includes('const formatosMultiples = esImagenSuelta ? [] : detectarFormatosExplicitosMultiples(mensaje || \'\')'), 'CASO 3 detecta formatos múltiples reales del mensaje (nunca para imagen suelta)')
  verificar(cuerpoChatRoute.includes('const formatosAGenerar = formatosMultiples.length > 1 ? formatosMultiples : [tipoHerramientaSolicitado]'), 'CASO 3 genera TODOS los formatos detectados cuando hay más de uno — nunca solo tipoHerramientaSolicitado')
  verificar(cuerpoChatRoute.includes('await Promise.allSettled(') && cuerpoChatRoute.includes('formatosAGenerar.map((tipo) =>'), 'Los formatos múltiples se generan con Promise.allSettled — uno no bloquea a los demás')
  verificar(cuerpoChatRoute.includes("if (primario.status === 'rejected') throw primario.reason"), 'Si el formato PRIMARIO falla, sí se propaga como error real (comportamiento anterior preservado para el caso de un solo formato)')
  verificar(cuerpoChatRoute.includes('Falló el formato secundario') && cuerpoChatRoute.includes('no bloquea los demás'), 'Un formato SECUNDARIO que falla se registra pero nunca bloquea la entrega de los demás formatos ya generados')
  verificar(cuerpoChatRoute.includes('const marcadores = archivos.map((archivo) => `[[DOCUMENTO_ARCHIVO:'), 'Se emite un marcador [[DOCUMENTO_ARCHIVO:...]] POR CADA formato entregado — el mecanismo de marcadores múltiples ya existente (procesarMarcadorDeArchivo) los recibe todos, sin cambios ahí')

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
