// scripts/verificar-lista-suelta-no-confunde-adjetivo.ts
//
// Prueba aislada de "sigue fallando la prueba en iPhone" — causa raíz
// REAL definitiva, confirmada con evidencia de runtime (se descargó y
// leyó el .docx entregado en el Preview, byte a byte era la lista de
// 28 alumnos, timestamp posterior a los dos despliegues anteriores):
// NINGUNA corrección a CASO 1/2 podía arreglar esto porque el problema
// vive en un interceptor TOTALMENTE DISTINTO que corre ANTES — LISTA
// DE ALUMNOS (app/api/chat/route.ts, pideListaAlumnos).
//
// "lista" en español es tanto sustantivo ("una lista de alumnos")
// como ADJETIVO común ("ready" — "...limpia y lista para imprimir").
// El patrón suelto de esa rama (pensado para mensajes cortos como "el
// listado en Word") no distinguía los dos usos: CUALQUIER mensaje que
// nombrara un formato (Word/PDF) y contuviera la palabra "lista" EN
// CUALQUIER SENTIDO disparaba la generación de la lista real de
// alumnos — exactamente lo que pasó con "...guía... limpia y lista
// para imprimir. Genera también Word y PDF."
//
// Ejecución REAL (regex puro, sin red) contra el mensaje EXACTO
// reportado + una batería de casos legítimos de "pide la lista" que
// deben seguir funcionando sin cambios.
// Se ejecuta con
// `npx tsx scripts/verificar-lista-suelta-no-confunde-adjetivo.ts`.

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

const MENSAJE_PRUEBA_IPHONE = `Hazme una guía completa, detallada e ilustrada sobre el ciclo del agua para 4° de primaria. Quiero que incluya: portada atractiva; explicación clara del ciclo del agua; evaporación, condensación, precipitación e infiltración; ilustraciones didácticas integradas en las secciones correspondientes; ejemplos sencillos; una actividad de observación; ejercicios de comprensión; preguntas de opción múltiple; una actividad para dibujar y colorear; espacio suficiente para que los alumnos respondan; una sección final de repaso. Debe estar diseñada para niños de primaria, visualmente atractiva, limpia y lista para imprimir. Genera también Word y PDF.`

// Réplica EXACTA de PATRON_LISTA_SUELTA (route.ts) — se prueba aparte
// (route.ts nunca se importa, requiere Claude/Supabase reales) para
// tener ejecución REAL del regex, no solo inspección de texto.
const PATRON_LISTA_SUELTA = /\b(lista(do)?|padr[oó]n)\b(?!\s+para\b)/i

async function main() {
  // ============================================================
  // 1. El mensaje EXACTO reportado contiene "lista" (de "lista para
  //    imprimir") — confirmación real de la causa raíz.
  // ============================================================
  verificar(/\blista\b/i.test(MENSAJE_PRUEBA_IPHONE), 'Confirmación de causa raíz: el mensaje real SÍ contiene la palabra suelta "lista" (de "...limpia y lista para imprimir")')
  verificar(!PATRON_LISTA_SUELTA.test(MENSAJE_PRUEBA_IPHONE), 'PATRON_LISTA_SUELTA corregido YA NO dispara con el mensaje real completo — "lista para" queda excluido')
  verificar(pareceNuevoDocumento(MENSAJE_PRUEBA_IPHONE), 'pareceNuevoDocumento(mensaje) es verdadero para este mensaje — defensa adicional independiente del regex')

  // ============================================================
  // 2. Uso ADJETIVO de "lista"/"listo" ("ready") — NUNCA debe
  //    disparar la rama de lista de alumnos, sin importar el resto
  //    del mensaje.
  // ============================================================
  const USOS_ADJETIVO = [
    '...limpia y lista para imprimir. Genera también Word y PDF.',
    'Hazme una guía lista para colorear en Word.',
    'Hágalo en formato lista para imprimir, en PDF por favor.',
    'Necesito la planeación lista para el lunes, en Word.',
    'Que quede lista para repartirla en PDF.',
  ]
  for (const texto of USOS_ADJETIVO) {
    verificar(!PATRON_LISTA_SUELTA.test(texto), `Uso adjetivo de "lista" NO dispara la rama: "${texto}"`)
  }

  // ============================================================
  // 3. No regresión — el uso SUSTANTIVO real ("una lista de
  //    alumnos"/"el listado"/"el padrón") sigue funcionando
  //    exactamente igual.
  // ============================================================
  const USOS_SUSTANTIVO_REALES = [
    'Hazme la lista de mis alumnos en Word.',
    'Quiero el listado del grupo en PDF.',
    'Descárgame el padrón en Word.',
    'Mándame la lista en Word.',
    'dame el listado en pdf',
    'Pásame la lista de alumnos a PDF.',
  ]
  for (const texto of USOS_SUSTANTIVO_REALES) {
    verificar(PATRON_LISTA_SUELTA.test(texto), `Uso sustantivo real de "lista"/"listado"/"padrón" SIGUE disparando: "${texto}"`)
  }

  // ============================================================
  // 4. Verificación estructural del punto exacto de la corrección en
  //    route.ts.
  // ============================================================
  verificar(cuerpoChatRoute.includes('const PATRON_LISTA_SUELTA = /\\b(lista(do)?|padr[oó]n)\\b(?!\\s+para\\b)/i'), 'route.ts usa el patrón corregido (excluye "lista para")')
  verificar(cuerpoChatRoute.includes('!pareceNuevoDocumento(mensaje || \'\') &&\n    !PARECE_CONSULTA_DE_ASISTENCIA'), 'pideListaAlumnos también exige !pareceNuevoDocumento — defensa adicional, mismo criterio que CASO 1/2')
  verificar(!cuerpoChatRoute.includes("/\\blista(do)?\\b|\\bpadr[oó]n\\b/i.test(mensaje || '')))"), 'El patrón viejo sin excepción para "lista para" ya no existe en el archivo')

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
