// scripts/verificar-documentos-ilustrados.ts
//
// Prueba aislada de "Documentos ilustrados + guías completas e
// ilustradas" — Fase 2A (orquestación mínima: detectar intención,
// generar N ilustraciones reales, embeberlas en Word/PDF, entregar
// documento + tarjeta). NO cubre Fase 2B (edición contextual de un
// documento ilustrado ya generado) ni Fase 2C (plantillas de guía,
// versión docente, presets de estilo) — esas quedan para su propio
// checkpoint.
//
// Mismo límite honesto que el resto de esta serie: no se puede
// fabricar una llamada real al proveedor de imágenes ni una sesión de
// Supabase en un script aislado, así que combina (a) ejecución REAL de
// lo que sí es puro (analizarContenido, extraerDescripcionesDeImagen,
// quiereIlustracion — todas funciones puras, sin red) y (b)
// verificación ESTRUCTURAL de los invariantes en el código real
// (herramientas.ts, construirDocumentoWord.ts, generarPdfServidor.ts,
// route.ts).
// Se ejecuta con `npx tsx scripts/verificar-documentos-ilustrados.ts`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// parseContenido.ts y lib/asistente/documentos.ts son seguros de
// importar directo: puros, sin imports de red/Supabase/OpenAI.
// construirDocumentoWord.ts SÍ es seguro (solo depende de `docx`, una
// librería pura, sin red) — se usa para una prueba real de extremo a
// extremo del documento Word con una imagen embebida.
// NUNCA se importa herramientas.ts/generarPdfServidor.ts (pdf-lib con
// embedPng necesita bytes reales) ni route.ts aquí.
import { analizarContenido, extraerDescripcionesDeImagen, type LineaDocumento } from '../lib/documentGen/parseContenido'
import { quiereIlustracion } from '../lib/asistente/documentos'
import { construirDocumentoWord } from '../lib/documentGen/construirDocumentoWord'
import { Packer } from 'docx'

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
const cuerpoHerramientas = readFileSync(join(RAIZ, 'lib/documentGen/herramientas.ts'), 'utf-8')
const cuerpoParseContenido = readFileSync(join(RAIZ, 'lib/documentGen/parseContenido.ts'), 'utf-8')
const cuerpoConstruirWord = readFileSync(join(RAIZ, 'lib/documentGen/construirDocumentoWord.ts'), 'utf-8')
const cuerpoGenerarPdf = readFileSync(join(RAIZ, 'lib/documentGen/generarPdfServidor.ts'), 'utf-8')
const cuerpoGenerarWordServidor = readFileSync(join(RAIZ, 'lib/documentGen/generarWordServidor.ts'), 'utf-8')
const cuerpoXlsx = readFileSync(join(RAIZ, 'lib/documentGen/generarXlsxServidor.ts'), 'utf-8')
const cuerpoChatRoute = readFileSync(join(RAIZ, 'app/api/chat/route.ts'), 'utf-8')
const cuerpoPanel = readFileSync(join(RAIZ, 'components/Asistente/AsistentePanel.tsx'), 'utf-8')
const cuerpoMigracion = readFileSync(join(RAIZ, 'supabase/migrations/20260809000000_extender_assets_visuales_tipo_uso.sql'), 'utf-8')

function sinComentarios(codigo: string): string {
  return codigo.split('\n').filter((l) => !l.trim().startsWith('--') && !l.trim().startsWith('//')).join('\n')
}

async function main() {
  // ============================================================
  // 1. analizarContenido reconoce [[IMAGEN:...]] como su propio tipo
  //    de línea — ejecución REAL, función pura.
  // ============================================================
  {
    const texto = `📋 FICHA SOBRE LAS PARTES DE LA PLANTA

Introducción breve sobre el tema.

[[IMAGEN: dibujo infantil de una planta señalando raíz, tallo, hoja y flor]]

- Actividad 1: colorea las partes
- Actividad 2: escribe el nombre de cada parte

[[IMAGEN: niños regando una planta en el salón de clases]]`
    const lineas = analizarContenido(texto)
    const imagenes = lineas.filter((l) => l.tipo === 'imagen')
    verificar(imagenes.length === 2, 'analizarContenido detecta las 2 líneas [[IMAGEN:...]] reales')
    verificar(imagenes[0].tipo === 'imagen' && imagenes[0].descripcion === 'dibujo infantil de una planta señalando raíz, tallo, hoja y flor', 'La descripción se extrae completa, sin corromper acentos ni comas')
    verificar(lineas.some((l) => l.tipo === 'titulo'), 'El título del documento se sigue detectando normalmente junto a las imágenes')
    verificar(lineas.filter((l) => l.tipo === 'bullet').length === 2, 'Los bullets alrededor de las imágenes se siguen detectando normalmente')

    const descripciones = extraerDescripcionesDeImagen(lineas)
    verificar(descripciones.length === 2 && descripciones.includes('niños regando una planta en el salón de clases'), 'extraerDescripcionesDeImagen devuelve las descripciones reales en orden')
  }
  {
    // Deduplicación real — dos líneas con la MISMA descripción exacta
    // nunca generan la imagen dos veces.
    const lineas: LineaDocumento[] = [
      { tipo: 'imagen', descripcion: 'sol sonriente' },
      { tipo: 'parrafo', texto: 'texto' },
      { tipo: 'imagen', descripcion: 'sol sonriente' },
    ]
    verificar(extraerDescripcionesDeImagen(lineas).length === 1, 'extraerDescripcionesDeImagen deduplica descripciones idénticas')
  }
  {
    // Un documento SIN líneas de imagen se comporta exactamente igual
    // que siempre — cero imágenes detectadas, cero cambio de
    // comportamiento.
    const lineas = analizarContenido('📋 PLANEACIÓN NORMAL\n\nSin ninguna ilustración pedida.\n- punto 1')
    verificar(extraerDescripcionesDeImagen(lineas).length === 0, 'Un documento normal (sin [[IMAGEN:...]]) no produce ninguna descripción — cero cambio de comportamiento')
  }

  // ============================================================
  // 2. quiereIlustracion — detección determinista, real.
  // ============================================================
  verificar(quiereIlustracion('Hazme una ficha ilustrada sobre las partes de la planta para 4°.'), 'quiereIlustracion detecta "ilustrada"')
  verificar(quiereIlustracion('Crea un examen con dibujos bonitos para niños.'), 'quiereIlustracion detecta "con dibujos"')
  verificar(quiereIlustracion('Hazme una actividad imprimible con imágenes para colorear.'), 'quiereIlustracion detecta "con imágenes"/"para colorear"')
  verificar(quiereIlustracion('Hazme una guía completa, bien detallada e ilustrada sobre el ciclo del agua.'), 'quiereIlustracion detecta el escenario exacto de la Prueba 2')
  verificar(!quiereIlustracion('Hazme una planeación para la próxima semana.'), 'quiereIlustracion NO se activa en una petición normal sin mención de ilustración — no regresión')
  verificar(!quiereIlustracion('Hazme un examen de matemáticas.'), 'quiereIlustracion NO se activa por defecto en documentos comunes (examen, planeación, citatorio) — Prueba 7 (no regresión)')

  // ============================================================
  // 3. herramientas.ts — orquestación: solo word/pdf, tope duro,
  //    nunca bloquea el documento si una ilustración falla.
  // ============================================================
  verificar(cuerpoHerramientas.includes('const MAX_IMAGENES_POR_DOCUMENTO = 4'), 'Existe un tope duro de imágenes por documento (principio "NO SATURAR" del diseño aprobado)')
  verificar(/tipo === 'word' \|\| tipo === 'pdf'/.test(cuerpoHerramientas), 'La generación de ilustraciones de documento SOLO se activa para word/pdf — powerpoint/excel quedan fuera de alcance de esta fase')
  verificar(cuerpoHerramientas.includes('.slice(0, MAX_IMAGENES_POR_DOCUMENTO)'), 'Las descripciones se recortan al tope ANTES de generar nada — nunca se generan más de las permitidas aunque Claude escriba más líneas')
  verificar(cuerpoHerramientas.includes('if (descripciones.length > 0)'), 'Si el texto no trae ninguna línea [[IMAGEN:...]], NO se llama a generarImagenesParaDocumento — cero llamadas extra para un documento normal')
  verificar(cuerpoHerramientas.includes('generarWordBuffer(texto, perfil, zonaHoraria, imagenesPorDescripcion)') && cuerpoHerramientas.includes('generarPdfBuffer(texto, perfil, zonaHoraria, imagenesPorDescripcion)'), 'El mapa de imágenes generadas se pasa a los generadores reales de Word/PDF')
  {
    const inicioFn = cuerpoHerramientas.indexOf('async function generarUnaIlustracion(')
    const finFn = cuerpoHerramientas.indexOf('\n// Genera todas las ilustraciones', inicioFn)
    const cuerpoFn = cuerpoHerramientas.slice(inicioFn, finFn)
    verificar(cuerpoFn.includes('return null') && (cuerpoFn.match(/return null/g) ?? []).length >= 2, 'generarUnaIlustracion regresa null (nunca lanza) si falla generación o subida — una ilustración fallida no debe tumbar el documento completo')
  }
  verificar(cuerpoHerramientas.includes('await Promise.all(') && cuerpoHerramientas.includes('descripciones.map((descripcion, orden) => generarUnaIlustracion('), 'Las ilustraciones de un mismo documento se generan en PARALELO (Promise.all), no una por una en serie')
  verificar(cuerpoHerramientas.includes("tipo: 'imagen',") && cuerpoHerramientas.includes('promptOriginal: imagen.promptUsado,') && cuerpoHerramientas.includes('storagePath: ruta,'), 'Cada ilustración se persiste en assets_visuales con su prompt y ruta real (relación documento↔imagen recuperable)')

  // ============================================================
  // 4. construirDocumentoWord.ts / generarPdfServidor.ts — embeben la
  //    imagen real cuando existe en el mapa, omiten en silencio
  //    cuando no (nunca lanzan por una descripción sin imagen).
  // ============================================================
  verificar(cuerpoConstruirWord.includes("import { Document, Paragraph, TextRun, Header, AlignmentType, ShadingType, BorderStyle, Table, TableRow, TableCell, WidthType, ImageRun } from 'docx'"), 'construirDocumentoWord.ts importa ImageRun de docx (embebido real, no un placeholder de texto)')
  verificar(cuerpoConstruirWord.includes('const descripcionImagen = esImagen(linea)') && cuerpoConstruirWord.includes('if (imagen) {'), 'construirDocumentoWord.ts solo embebe si la descripción tiene imagen real en el mapa')
  verificar(cuerpoConstruirWord.includes('continue') && /descripcionImagen[\s\S]{0,20}if \(descripcionImagen\)/.test(cuerpoConstruirWord) === false, 'construirDocumentoWord.ts salta (continue) la línea de imagen sin caer en el resto de la clasificación (título/bullet/párrafo)')
  verificar(cuerpoGenerarPdf.includes('await pdfDoc.embedPng(imagen.buffer)') && cuerpoGenerarPdf.includes('pagina.drawImage(png,'), 'generarPdfServidor.ts embebe la imagen real con pdf-lib (embedPng + drawImage)')
  verificar(cuerpoGenerarPdf.includes('if (!imagen) return'), 'generarPdfServidor.ts omite en silencio una descripción sin imagen en el mapa — nunca rompe el resto del PDF')
  verificar(cuerpoGenerarWordServidor.includes('imagenesPorDescripcion?: Map<string, ImagenParaDocumentoWord>'), 'generarWordServidor.ts expone el parámetro opcional — los llamadores existentes (sin imágenes) no cambian')

  // ============================================================
  // 5. Prueba de extremo a extremo REAL: construirDocumentoWord con
  //    una imagen real embebida produce un .docx válido de verdad
  //    (ejecución real, no solo texto — un PNG mínimo de 1x1, sin red).
  // ============================================================
  {
    // PNG 1x1 transparente real (bytes válidos, el más pequeño posible)
    // — suficiente para probar el embebido real sin generar nada por
    // red.
    const png1x1 = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    )
    const texto = '📋 FICHA DE PRUEBA\n\n[[IMAGEN: sol sonriente]]\n\n- punto final'
    const mapa = new Map([['sol sonriente', { buffer: png1x1, ancho: 1, alto: 1 }]])
    const doc = construirDocumentoWord(texto, { nombre: 'Docente', grado: '4°', grupo: 'A' }, null, mapa)
    const buffer = await Packer.toBuffer(doc)
    verificar(buffer.length > 0 && buffer.subarray(0, 2).toString('latin1') === 'PK', 'construirDocumentoWord + Packer produce un .docx real y válido (firma ZIP/PK) con una imagen realmente embebida — extremo a extremo, sin red')

    // Sin imagen en el mapa (descripción no encontrada) — el documento
    // se sigue generando completo, nunca lanza.
    const docSinImagen = construirDocumentoWord(texto, { nombre: 'Docente', grado: '4°', grupo: 'A' }, null, new Map())
    const bufferSinImagen = await Packer.toBuffer(docSinImagen)
    verificar(bufferSinImagen.length > 0, 'Con una descripción de imagen que NO está en el mapa, el documento se genera completo igual (nunca lanza, la ilustración simplemente se omite)')
  }

  // ============================================================
  // 6. parseContenido.ts — PPTX/Excel (fuera de alcance) filtran las
  //    líneas de imagen en vez de romper con ellas.
  // ============================================================
  verificar(cuerpoParseContenido.includes("lineas.filter((l) => l.tipo !== 'imagen')"), 'agruparEnDiapositivas (PowerPoint) filtra las líneas de imagen — fuera de alcance de esta fase, nunca rompe la generación de PPTX')
  verificar(/analizarContenido\(texto\)\.filter\(\(l\) => l\.tipo !== 'imagen'[^)]*\)/.test(cuerpoXlsx), 'generarXlsxServidor.ts filtra las líneas de imagen — fuera de alcance de esta fase, nunca rompe la generación de Excel')

  // ============================================================
  // 7. app/api/chat/route.ts — MODO DOCUMENTO ILUSTRADO solo se activa
  //    cuando corresponde (word/pdf + quiereIlustracion), tope de 4
  //    imágenes también instruido al modelo, CAPACIDADES actualizado.
  // ============================================================
  verificar(cuerpoChatRoute.includes("const esDocumentoIlustrado = (tipoHerramientaSolicitado === 'word' || tipoHerramientaSolicitado === 'pdf') && quiereIlustracion(mensaje || '')"), 'El bloque MODO DOCUMENTO ILUSTRADO se gatea exactamente por word/pdf + quiereIlustracion — un documento normal nunca lo activa')
  verificar(cuerpoChatRoute.includes('MODO DOCUMENTO ILUSTRADO ACTIVO'), 'Existe el bloque de sistema con instrucciones para insertar [[IMAGEN:...]]')
  verificar(cuerpoChatRoute.includes('Máximo 4 líneas [[IMAGEN:...]] en todo el documento'), 'El prompt de sistema también instruye el tope de 4 imágenes — coincide con MAX_IMAGENES_POR_DOCUMENTO en herramientas.ts')
  verificar(cuerpoChatRoute.includes('${bloqueDocumentoIlustrado}'), 'bloqueDocumentoIlustrado se concatena al prompt de sistema (mismo patrón condicional que bloqueVoz/bloqueModoImagen — nunca cambia el prompt general)')
  verificar(cuerpoChatRoute.includes('También SÍ genera documentos CON ilustraciones integradas'), 'CAPACIDADES ya declara que la app SÍ genera documentos ilustrados — Claude nunca debe sugerir herramientas externas (Canva, Google, etc.)')
  verificar(cuerpoChatRoute.includes('ejecutarHerramientaDocumento(tipoHerramientaSolicitado, documentoTexto, perfil, zonaHoraria, supabaseRAG, userId, supabaseUser,'), 'CASO 1/2 (documento recuperable) también recibe supabaseUser/conversacionId — consistente con CASO 3 y con la regeneración de imagen')

  // ============================================================
  // 8. Migración — 100% aditiva, RLS ya heredado (misma tabla), sin
  //    service_role, sin tocar ninguna columna existente.
  // ============================================================
  verificar(cuerpoMigracion.includes('add column if not exists tipo_uso text not null default') && cuerpoMigracion.includes("add column if not exists orden_en_documento integer"), 'Migración aditiva: solo agrega tipo_uso/orden_en_documento, ambas con default seguro para filas existentes')
  {
    const migracionSinComentarios = sinComentarios(cuerpoMigracion)
    verificar(!/service_role/i.test(migracionSinComentarios), 'Migración: no usa service_role')
    verificar(!/\bdrop table\b|\bdrop column\b|\bcreate table\b/i.test(migracionSinComentarios), 'Migración: no crea tabla nueva ni elimina nada — extensión pura de assets_visuales')
  }

  // ============================================================
  // 9. No regresión — TarjetaDescarga (imagen suelta, Fase 0+1/
  //    corrección) sigue intacta, no se tocó en esta fase.
  // ============================================================
  verificar(cuerpoPanel.includes("principal.tipo === 'imagen' ? 'Imagen activa' : 'Documento activo'"), 'El indicador de imagen activa (corrección previa) sigue intacto — no se tocó en esta fase')
  verificar(cuerpoPanel.includes('🖼️ Ilustración: {l.descripcion}'), 'La vista previa en vivo del chat muestra un aviso ligero mientras se redacta un documento ilustrado (no dobla la fila vacía ni rompe la vista previa)')

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
