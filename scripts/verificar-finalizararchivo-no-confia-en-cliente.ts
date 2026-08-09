// scripts/verificar-finalizararchivo-no-confia-en-cliente.ts
//
// Prueba aislada de "fallo real confirmado otra vez en iPhone — Fase
// 2A no está aprobada". Causa raíz REAL, confirmada con evidencia de
// runtime (no una hipótesis): se descargó el .docx realmente entregado
// en el Preview después del despliegue anterior y su contenido, byte a
// byte, era la lista de 28 alumnos ("📋 LISTA OFICIAL DE ALUMNOS...
// RESUMEN Total de alumnos: 28..."), confirmado con
// `sb.storage.from('documentos-generados-ia').download(...)` +
// extracción real del texto de word/document.xml.
//
// La corrección anterior (commit 544a208) protegió la rama de
// "historial" en CASO 1/2 con pareceNuevoDocumento, pero dejó SIN
// PROTEGER la rama de `finalizarArchivo` (el cliente manda el texto
// del documento activo directo) — esa rama confiaba ciegamente en lo
// que mandara el cliente, sin ninguna validación del servidor. Esta
// prueba cubre ambas rutas bajo la MISMA guarda.
//
// LÍMITE HONESTO explícito (el mismo de siempre para route.ts, nunca
// se importa aquí — requiere Claude/Supabase reales): esta suite NO
// reemplaza la evidencia de runtime ya recogida (el .docx real
// descargado y leído) — es una verificación estructural COMPLEMENTARIA
// de que el código real tiene la forma exacta que cierra el hueco
// encontrado, más ejecución real de la función pura que decide todo
// esto (pareceNuevoDocumento).
// Se ejecuta con
// `npx tsx scripts/verificar-finalizararchivo-no-confia-en-cliente.ts`.

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
const cuerpoChatRoute = readFileSync(join(RAIZ, 'app/api/chat/route.ts'), 'utf-8')

const MENSAJE_PRUEBA_IPHONE_LARGO = `Hazme una guía completa, detallada e ilustrada sobre el ciclo del agua para 4° de primaria. Quiero que incluya: portada atractiva; explicación clara del ciclo del agua; evaporación, condensación, precipitación e infiltración; ilustraciones didácticas integradas en las secciones correspondientes; ejemplos sencillos; una actividad de observación; ejercicios de comprensión; preguntas de opción múltiple; una actividad para dibujar y colorear; espacio suficiente para que los alumnos respondan; una sección final de repaso. Debe estar diseñada para niños de primaria, visualmente atractiva, limpia y lista para imprimir. Genera también Word y PDF.`
const MENSAJE_PRUEBA_IPHONE_CORTO = 'Hazme una guía completa, detallada e ilustrada sobre el ciclo del agua para 4° de primaria... Genera también Word y PDF.'

async function main() {
  // ============================================================
  // 1. pareceNuevoDocumento — ejecución REAL contra ambas variantes
  //    exactas del mensaje reportado (corto y largo).
  // ============================================================
  verificar(pareceNuevoDocumento(MENSAJE_PRUEBA_IPHONE_LARGO), 'pareceNuevoDocumento detecta el mensaje largo real de iPhone')
  verificar(pareceNuevoDocumento(MENSAJE_PRUEBA_IPHONE_CORTO), 'pareceNuevoDocumento detecta el mensaje corto real de iPhone')

  // ============================================================
  // 2. CAUSA RAÍZ REAL — la rama finalizarArchivo (cliente) YA NO
  //    está desprotegida: ambas fuentes (cliente e historial) viven
  //    dentro del MISMO if (!pareceNuevoDocumento(...)).
  // ============================================================
  {
    const inicioBloque = cuerpoChatRoute.indexOf('if (supabaseUser && userId && tipoHerramientaSolicitado) {')
    const finBloque = cuerpoChatRoute.indexOf('// ETAPA 1 (detección de la intención)', inicioBloque)
    verificar(inicioBloque !== -1 && finBloque !== -1, 'Se localiza el bloque completo de CASO 1/2')
    const bloque = cuerpoChatRoute.slice(inicioBloque, finBloque)

    verificar(!bloque.includes("if (finalizarArchivo && typeof finalizarArchivo === 'object' && typeof finalizarArchivo.documentoTexto === 'string') {\n      documentoTexto"), 'La rama finalizarArchivo YA NO es la primera condición sin protección — vive dentro de la guarda pareceNuevoDocumento')

    const iGuardaExterior = bloque.indexOf("if (!pareceNuevoDocumento(mensaje || '')) {")
    const iFinalizarArchivo = bloque.indexOf("if (finalizarArchivo && typeof finalizarArchivo === 'object'")
    const iHistorial = bloque.indexOf('[...historialMensajes].reverse().find')
    verificar(iGuardaExterior !== -1 && iFinalizarArchivo !== -1 && iHistorial !== -1, 'Existen las 3 piezas: guarda exterior, rama finalizarArchivo, rama historial')
    verificar(iGuardaExterior < iFinalizarArchivo && iFinalizarArchivo < iHistorial, 'AMBAS ramas (finalizarArchivo E historial) están DENTRO de la guarda pareceNuevoDocumento — ninguna se ejecuta cuando el mensaje describe un documento nuevo, sin importar qué mande el cliente')
  }
  verificar(/nunca se conf[ií]a\s*\n?\s*\/\/\s*ciegamente en el cliente/.test(cuerpoChatRoute), 'El comentario documenta explícitamente que ya no se confía ciegamente en finalizarArchivo del cliente')

  // ============================================================
  // 3. No regresión — un finalizarArchivo LEGÍTIMO (docente pide
  //    "descárgalo"/"en Word" sobre el documento activo real, mensaje
  //    corto, sin describir nada nuevo) sigue funcionando: el gate
  //    exterior no debe bloquear ese caso.
  // ============================================================
  const INSTRUCCIONES_FINALIZAR_LEGITIMAS = [
    'Descárgalo en Word.',
    'Pásalo a PDF.',
    'Envíamelo.',
    'Ya está bien, dámelo en Word.',
    'En PDF por favor.',
  ]
  for (const instruccion of INSTRUCCIONES_FINALIZAR_LEGITIMAS) {
    verificar(!pareceNuevoDocumento(instruccion), `Instrucción de finalización legítima NO se bloquea por el gate: "${instruccion}"`)
  }

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
