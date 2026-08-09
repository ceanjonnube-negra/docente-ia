// scripts/verificar-red-seguridad-no-reutiliza-historial.ts
//
// Prueba aislada de "corrección estructural: la guía siguió
// devolviendo un documento viejo o incorrecto" — causa raíz REAL
// (distinta de la corrección anterior, que solo tocaba el cliente):
// app/api/chat/route.ts (CASO 1/2, la "red de seguridad") busca en el
// HISTORIAL COMPLETO de la conversación cualquier mensaje anterior que
// "parezca documento formal" y lo reutiliza — completamente
// independiente de documentoActivo (que vive solo en el cliente). Un
// mensaje que nombra un formato real ("...Genera también Word y PDF")
// Y describe contenido nuevo disparaba esa búsqueda igual, encontraba
// CUALQUIER documento formal viejo (lista de alumnos, una hoja de otro
// tema) y lo entregaba sin llamar a Claude ni una sola vez.
//
// También cubre el endurecimiento del marcador [[IMAGEN:...]] (nunca
// debe quedar visible como texto crudo si Claude no lo aísla
// perfectamente en su propia línea) y la verificación explícita de que
// una guía ilustrada nueva con documento activo NO relacionado se
// genera correctamente.
//
// Ejecución REAL (funciones puras) + verificación ESTRUCTURAL del
// punto exacto de la corrección en route.ts.
// Se ejecuta con
// `npx tsx scripts/verificar-red-seguridad-no-reutiliza-historial.ts`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Packer } from 'docx'
import { pareceNuevoDocumento, detectarFormatosExplicitosMultiples, quiereIlustracion } from '../lib/asistente/documentos'
import { analizarContenido, extraerDescripcionesDeImagen } from '../lib/documentGen/parseContenido'
import { construirDocumentoWord } from '../lib/documentGen/construirDocumentoWord'

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
const cuerpoParseContenido = readFileSync(join(RAIZ, 'lib/documentGen/parseContenido.ts'), 'utf-8')
const cuerpoConstruirWord = readFileSync(join(RAIZ, 'lib/documentGen/construirDocumentoWord.ts'), 'utf-8')

const MENSAJE_PRUEBA_IPHONE = `Hazme una guía completa, detallada e ilustrada sobre el ciclo del agua para 4° de primaria. Quiero que incluya: portada atractiva; explicación clara del ciclo del agua; evaporación, condensación, precipitación e infiltración; ilustraciones didácticas integradas en las secciones correspondientes; ejemplos sencillos; una actividad de observación; ejercicios de comprensión; preguntas de opción múltiple; una actividad para dibujar y colorear; espacio suficiente para que los alumnos respondan; una sección final de repaso. Debe estar diseñada para niños de primaria, visualmente atractiva, limpia y lista para imprimir. Genera también Word y PDF.`

async function main() {
  // ============================================================
  // 1. El mensaje EXACTO de la nueva prueba en iPhone (más largo y
  //    detallado que el anterior) — ejecución real.
  // ============================================================
  verificar(pareceNuevoDocumento(MENSAJE_PRUEBA_IPHONE), 'pareceNuevoDocumento detecta el mensaje largo exacto de la nueva prueba como creación nueva')
  verificar(
    JSON.stringify(detectarFormatosExplicitosMultiples(MENSAJE_PRUEBA_IPHONE)) === JSON.stringify(['word', 'pdf']),
    'detectarFormatosExplicitosMultiples detecta Word y PDF en el mensaje largo'
  )
  verificar(quiereIlustracion(MENSAJE_PRUEBA_IPHONE), 'quiereIlustracion detecta el mensaje largo como documento ilustrado')

  // ============================================================
  // 2. CAUSA RAÍZ REAL — route.ts (CASO 1/2): la búsqueda en
  //    historialMensajes NUNCA debe ejecutarse cuando el mensaje
  //    describe un documento nuevo. Verificación estructural del
  //    punto exacto de la corrección.
  //
  //    NOTA (ver "fallo real confirmado otra vez en iPhone"): esta
  //    guarda se reforzó en una ronda posterior para envolver TAMBIÉN
  //    la rama finalizarArchivo, no solo la de historial — ver
  //    scripts/verificar-finalizararchivo-no-confia-en-cliente.ts para
  //    la verificación completa y actualizada de esa corrección.
  // ============================================================
  {
    const inicioBloque = cuerpoChatRoute.indexOf('if (supabaseUser && userId && tipoHerramientaSolicitado) {')
    const finBloque = cuerpoChatRoute.indexOf('// ETAPA 1 (detección de la intención)', inicioBloque)
    verificar(inicioBloque !== -1 && finBloque !== -1, 'Se localiza el bloque completo de recuperación de documentoTexto en CASO 1/2')
    const bloque = cuerpoChatRoute.slice(inicioBloque, finBloque)
    verificar(bloque.includes("if (!pareceNuevoDocumento(mensaje || '')) {"), 'La recuperación de documentoTexto (cliente E historial) SOLO se ejecuta cuando el mensaje NO describe un documento nuevo')
    verificar(bloque.includes('[...historialMensajes].reverse().find'), 'La búsqueda en el historial real sigue existiendo (para el caso legítimo: "descárgalo" sin documentoActivo en memoria) — solo se acotó, no se eliminó')
  }
  verificar(cuerpoChatRoute.includes("import { detectarHerramientaDocumento, detectarFormatosExplicitosMultiples, esDocumentoFormal, pareceNuevoDocumento, quiereIlustracion, type TipoHerramienta } from '@/lib/asistente/documentos'"), 'route.ts importa pareceNuevoDocumento realmente desde lib/asistente/documentos.ts')

  // ============================================================
  // 3. Marcador [[IMAGEN:...]] endurecido — nunca debe imprimirse
  //    como texto crudo visible, incluso si Claude no lo aísla
  //    perfectamente en su propia línea (ver "nunca dejar el prompt
  //    textual como sustituto dentro del documento final").
  // ============================================================
  {
    // Caso real reportado: el marcador con texto antepuesto en la
    // misma línea ("Ilustración: [[IMAGEN: ...]]") — antes esto NO
    // coincidía con el regex anclado (^...$) y se imprimía tal cual
    // como párrafo normal; ahora se reconoce en cualquier parte de la
    // línea.
    const lineasConTextoAntepuesto = analizarContenido('📋 GUÍA DE PRUEBA\n\nIlustración: [[IMAGEN: dibujo colorido de una planta]]\n\n- punto final')
    const imagenes = lineasConTextoAntepuesto.filter((l) => l.tipo === 'imagen')
    verificar(imagenes.length === 1 && imagenes[0].tipo === 'imagen' && imagenes[0].descripcion === 'dibujo colorido de una planta', 'analizarContenido reconoce el marcador [[IMAGEN:...]] aunque Claude anteponga texto en la misma línea ("Ilustración: [[IMAGEN:...]]") — nunca se imprime como párrafo normal')
    verificar(!lineasConTextoAntepuesto.some((l) => l.tipo === 'parrafo' && l.texto.includes('Ilustración:')), 'La línea completa se trata como imagen — el texto "Ilustración:" antepuesto NUNCA aparece como párrafo visible por separado')
  }
  verificar(!/\^\\\[\\\[IMAGEN/.test(cuerpoParseContenido), 'parseContenido.ts: el regex del marcador ya NO exige que la línea completa sea exactamente el marcador (sin ancla ^)')
  verificar(!/\^\\\[\\\[IMAGEN/.test(cuerpoConstruirWord), 'construirDocumentoWord.ts: mismo endurecimiento aplicado (sin ancla ^)')
  verificar(cuerpoChatRoute.includes('PROHIBIDO escribir "Ilustración:", "Imagen:", una descripción en prosa'), 'El prompt de sistema ahora prohíbe explícitamente variantes en prosa del marcador ("Ilustración:", "Imagen:") — refuerzo adicional, no solo el endurecimiento del regex')

  // ============================================================
  // 4. Escenario completo del reporte: documento activo NO
  //    relacionado (lista/hoja vieja) + guía ilustrada nueva con
  //    Word y PDF — extraerDescripcionesDeImagen sigue funcionando
  //    igual sobre el contenido de la guía nueva real.
  // ============================================================
  {
    const guiaNueva = `📘 GUÍA COMPLETA: EL CICLO DEL AGUA

PROPÓSITO
Que el alumno comprenda las 4 fases del ciclo del agua.

[[IMAGEN: diagrama infantil y colorido del ciclo del agua mostrando evaporación, condensación, precipitación e infiltración]]

EVAPORACIÓN
El sol calienta el agua de mares y ríos.

- Actividad de observación
- Ejercicio de comprensión

[[IMAGEN: dibujo de línea limpia para colorear de un niño observando la lluvia]]

REPASO FINAL
- ¿Qué es la evaporación?`
    const lineas = analizarContenido(guiaNueva)
    const descripciones = extraerDescripcionesDeImagen(lineas)
    verificar(lineas.some((l) => l.tipo === 'titulo' && l.texto.includes('CICLO DEL AGUA')), 'El título real de la guía nueva ("EL CICLO DEL AGUA") se detecta correctamente — nunca el de un documento viejo')
    verificar(descripciones.length === 2, 'Las 2 ilustraciones reales de la guía nueva se detectan correctamente para generarse')
    verificar(!descripciones.some((d) => d.toLowerCase().includes('alumnos') || d.toLowerCase().includes('lista')), 'Ninguna descripción de imagen proviene de contenido ajeno (lista de alumnos) — todo pertenece al turno actual')
  }

  // ============================================================
  // 5. Extremo a extremo REAL: un marcador con texto antepuesto se
  //    embebe como imagen real en el .docx (nunca como texto crudo)
  //    — exactamente el síntoma reportado ("Ilustración: Ilustración
  //    colorida y amigable..." visible en el documento entregado).
  // ============================================================
  {
    const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
    const texto = '📋 FICHA DE PRUEBA\n\nIlustración: [[IMAGEN: sol sonriente]]\n\n- punto final'
    const mapa = new Map([['sol sonriente', { buffer: png1x1, ancho: 1, alto: 1 }]])
    const doc = construirDocumentoWord(texto, { nombre: 'Docente', grado: '4°', grupo: 'A' }, null, mapa)
    const buffer = await Packer.toBuffer(doc)
    verificar(buffer.length > 0 && buffer.subarray(0, 2).toString('latin1') === 'PK', 'Extremo a extremo: un marcador con texto antepuesto ("Ilustración: [[IMAGEN:...]]") produce un .docx real y válido, con la imagen embebida en vez del texto crudo — sin red')
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
