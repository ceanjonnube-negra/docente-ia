// scripts/verificar-examen-completo.ts
//
// Prueba aislada de "generación de exámenes completos desde el Chat
// IA" (fase enfocada exclusivamente en exámenes, pausando guías
// ilustradas largas). Verifica, con ejecución REAL de las funciones
// deterministas (sin red) contra los 3 casos de prueba exactos que
// pidió el docente, y verificación ESTRUCTURAL del formato de examen
// en app/api/chat/route.ts:
//
// 1. Los 3 casos se detectan como creación NUEVA (pareceNuevoDocumento)
//    — nunca reutilizan un documento activo previo.
// 2. Ninguno activa el flujo asíncrono de guías ilustradas
//    (quiereIlustracion=false, un solo formato) — el examen se genera
//    siempre por el camino síncrono normal, sin depender de esa
//    arquitectura (ver "corrección: timeout en documentos ilustrados
//    largos").
// 3. El formato de examen en el system prompt exige mínimo 10
//    reactivos con variedad real de tipos y datos del alumno (Nombre,
//    Grado, Grupo, Fecha) cuando lo pedido es un EXAMEN — la actividad
//    suelta conserva el criterio anterior (mínimo 5, sin esa
//    exigencia de variedad).
// 4. El título del examen ahora es dinámico por tema (antes era el
//    literal fijo "EXAMEN / ACTIVIDAD" para CUALQUIER examen, lo que
//    producía siempre el mismo nombre de archivo genérico
//    "EXAMEN_ACTIVIDAD.docx" sin importar el tema pedido) — verificado
//    con ejecución real de extraerTitulo + nombreArchivoWordServidor.
//
// Se ejecuta con `npx tsx scripts/verificar-examen-completo.ts`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pareceNuevoDocumento, quiereIlustracion, detectarFormatosExplicitosMultiples, detectarHerramientaDocumento } from '../lib/asistente/documentos'
import { extraerTitulo } from '../lib/documentGen/parseContenido'
import { nombreArchivoWordServidor } from '../lib/documentGen/generarWordServidor'

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

const CASOS_DE_PRUEBA = [
  'Hazme un examen completo de ciencias naturales sobre el ciclo del agua para 4° de primaria.',
  'Hazme un examen completo de matemáticas sobre multiplicaciones y divisiones para 4° de primaria.',
  'Hazme un examen completo de español sobre sustantivos, adjetivos y verbos para 4° de primaria.',
]

async function main() {
  // ============================================================
  // 1-2. Ejecución real de los detectores contra los 3 casos exactos.
  // ============================================================
  for (const caso of CASOS_DE_PRUEBA) {
    verificar(pareceNuevoDocumento(caso), `"${caso}" se detecta como creación NUEVA (nunca reutiliza documento activo)`)
    verificar(!quiereIlustracion(caso), `"${caso}" NO activa el flujo de documento ilustrado`)
    verificar(detectarFormatosExplicitosMultiples(caso).length <= 1, `"${caso}" no pide más de un formato — no depende del flujo asíncrono de guías largas`)
  }

  // ============================================================
  // 3. Formato de examen — verificación estructural del bloque real
  //    del system prompt.
  // ============================================================
  const inicioBloque = cuerpoChatRoute.indexOf('EXÁMENES Y ACTIVIDADES')
  const finBloque = cuerpoChatRoute.indexOf('CITATORIOS —')
  const bloqueExamen = cuerpoChatRoute.slice(inicioBloque, finBloque)
  verificar(inicioBloque !== -1 && finBloque !== -1, 'El bloque EXÁMENES Y ACTIVIDADES existe en el system prompt real')
  verificar(bloqueExamen.includes('mínimo 10 reactivos'), 'El formato exige mínimo 10 reactivos cuando lo pedido es un EXAMEN')
  verificar(bloqueExamen.includes('variedad real de tipos'), 'El formato exige variedad real de tipos de reactivo (no solo un tipo repetido)')
  verificar(
    ['opción múltiple', 'verdadero/falso', 'relaciona columnas', 'completar', 'respuesta corta'].every((tipo) => bloqueExamen.includes(tipo)),
    'Los 5 tipos de reactivo pedidos por el docente están explícitos en las instrucciones (opción múltiple, verdadero/falso, relaciona columnas, completar, respuesta corta)'
  )
  verificar(bloqueExamen.includes('Nombre del alumno:'), 'El formato incluye el campo "Nombre del alumno" en blanco')
  verificar(/Grado:.*Grupo:.*Fecha:/.test(bloqueExamen), 'El formato incluye Grado, Grupo y Fecha en los datos del encabezado')
  verificar(bloqueExamen.includes('espacio suficiente para que el alumno responda'), 'El formato exige dejar espacio suficiente para responder cada reactivo')
  verificar(bloqueExamen.includes('redacción clara y adecuada al grado'), 'El formato exige redacción adecuada al grado (primaria)')
  verificar(bloqueExamen.includes('mínimo 5, sin esa exigencia de variedad'), 'Una ACTIVIDAD suelta (no examen) conserva el criterio anterior — sin regresión')

  // ============================================================
  // 4. Título dinámico por tema — antes SIEMPRE el mismo literal fijo
  //    "EXAMEN / ACTIVIDAD" para cualquier examen (mismo nombre de
  //    archivo genérico sin importar el tema). Ejecución real de
  //    extraerTitulo + nombreArchivoWordServidor con 2 temas
  //    distintos, confirmando que ahora producen nombres DISTINTOS.
  // ============================================================
  verificar(!bloqueExamen.includes('📝 EXAMEN / ACTIVIDAD\n'), 'El título del examen ya NO es el literal fijo "EXAMEN / ACTIVIDAD" para todos los temas')
  {
    const tituloAgua = extraerTitulo('📝 EXAMEN DE CIENCIAS NATURALES — EL CICLO DEL AGUA\nNombre del alumno: ___')
    const tituloMate = extraerTitulo('📝 EXAMEN DE MATEMÁTICAS — MULTIPLICACIONES Y DIVISIONES\nNombre del alumno: ___')
    const nombreAgua = nombreArchivoWordServidor(tituloAgua)
    const nombreMate = nombreArchivoWordServidor(tituloMate)
    verificar(nombreAgua !== nombreMate, `Dos exámenes de temas distintos producen nombres de archivo DISTINTOS (obtenido: "${nombreAgua}" vs "${nombreMate}")`)
    verificar(nombreAgua.includes('CICLO') && nombreAgua.includes('AGUA'), `El nombre de archivo real refleja el tema pedido (obtenido: "${nombreAgua}")`)
  }

  // ============================================================
  // No regresión — el resto de formatos (citatorio, resumen formal,
  // cuento/fábula/lectura, rúbrica) no se tocaron en este ajuste.
  // ============================================================
  verificar(cuerpoChatRoute.includes('CITATORIOS — cuando el maestro pida un citatorio'), 'El formato de CITATORIOS sigue intacto')
  verificar(cuerpoChatRoute.includes('RESÚMENES FORMALES — cuando el maestro pida el resumen'), 'El formato de RESÚMENES FORMALES sigue intacto')
  verificar(cuerpoChatRoute.includes('CUENTOS, FÁBULAS Y LECTURAS — cuando el maestro pida un cuento'), 'El formato de CUENTOS/FÁBULAS/LECTURAS sigue intacto')

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
