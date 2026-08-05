// scripts/verificar-documento-planeacion.ts
//
// Prueba aislada (sin credenciales, sin red, sin escrituras reales) de
// la corrección funcional "falta mostrar y descargar la planeación":
// confirma que el borrador de planeación ahora se adjunta como
// documento descargable completo (no solo su hoja de evaluación),
// que ambos adjuntos viajan en el MISMO turno sin persistir nada, y
// que el pipeline cliente (marcador → mensaje → tarjetas) soporta más
// de un adjunto por turno. La generación real del PDF (pdf-lib) y la
// clasificación real de Claude no se pueden probar de forma
// determinista sin red/credenciales — misma limitación ya documentada
// en el resto de la serie C-005 — se verifica en su lugar lo que SÍ es
// código real y determinista: el texto extraído, el código fuente de
// la ruta nueva (sin persistencia) y del pipeline de adjuntos.
// Se ejecuta con `npx tsx scripts/verificar-documento-planeacion.ts`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { extraerTextoCompletoBorrador } from '../lib/planeacion/extraerBorrador'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

const BORRADOR_EJEMPLO = `Preparé la planeación diagnóstica para las primeras dos semanas efectivas de clase de tu grupo, considerando el calendario escolar.

Nombre contextual: Diagnóstico de inicio de ciclo
Grupo: 4°B
Periodo de evaluación: Primer trimestre
Fecha de inicio: 2026-08-03
Fecha de fin: 2026-08-18
Propósito: Identificar el nivel de logro inicial del grupo.
Campos formativos: Lenguajes, Saberes y pensamiento científico
Contenidos: Comprensión lectora, Conteo y estimación
Secuencia didáctica:
Día 1: Evaluación de lectura — inicio, desarrollo y cierre completos.
Día 2: Evaluación de matemáticas — inicio, desarrollo y cierre completos.

📎 RESUMEN PARA GUARDAR
Nombre: Diagnóstico de inicio de ciclo
Grupo: 4°B
Periodo de evaluación: Primer trimestre
Fecha de inicio: 2026-08-03
Fecha de fin: 2026-08-18
Duración: 10 días efectivos
Propósito: Identificar el nivel de logro inicial del grupo
Campos formativos: Lenguajes; Saberes y pensamiento científico
Contenidos: Comprensión lectora; Conteo y estimación
PDA: Identifica ideas principales; Resuelve problemas de conteo
Ejes articuladores: Pensamiento crítico; Inclusión
Metodología: Trabajo por estaciones
Producto final: Reporte diagnóstico individual
Secuencia didáctica: Día 1: Evaluación de lectura; Día 2: Evaluación de matemáticas
Recursos: Fichas de lectura; Material manipulable
Evidencias: Registros de observación; Productos escritos
Indicadores de evaluación: Identifica ideas principales; Cuenta colecciones; Sigue instrucciones

¿Deseas corregir algo o aprobarla para guardarla?`

async function main() {
  const rutaChat = readFileSync(join(__dirname, '..', 'app', 'api', 'chat', 'route.ts'), 'utf-8')
  const rutaDocumento = readFileSync(join(__dirname, '..', 'app', 'api', 'planeaciones', 'vista-previa-documento', 'route.ts'), 'utf-8')
  const rutaMotor = readFileSync(join(__dirname, '..', 'lib', 'asistente', 'motores', 'motorTextoClaude.ts'), 'utf-8')
  const rutaPanel = readFileSync(join(__dirname, '..', 'components', 'Asistente', 'AsistentePanel.tsx'), 'utf-8')
  const rutaTipos = readFileSync(join(__dirname, '..', 'lib', 'asistente', 'tipos.ts'), 'utf-8')

  // ============================================================
  // 1. El documento usa la información COMPLETA ya producida por
  //    planeacion_generar (secuencia didáctica completa día por día,
  //    no el resumen reducido) — nunca un resumen reducido.
  // ============================================================
  {
    const texto = extraerTextoCompletoBorrador(BORRADOR_EJEMPLO)
    verificar(texto.includes('Día 1: Evaluación de lectura — inicio, desarrollo y cierre completos.'), '1a. El documento conserva la secuencia didáctica COMPLETA (inicio/desarrollo/cierre), no el resumen de una línea del bloque de guardado')
    verificar(texto.includes('Propósito: Identificar el nivel de logro inicial del grupo.'), '1b. Conserva el propósito y demás secciones redactadas por Claude')
    verificar(!texto.includes('📎 RESUMEN PARA GUARDAR'), '1c. Nunca incluye el bloque interno "RESUMEN PARA GUARDAR" (artefacto de guardado, no contenido del documento)')
    verificar(!texto.includes('¿Deseas corregir algo o aprobarla'), '1d. El bloque de resumen y todo lo que sigue queda excluido del documento')
    verificar(texto.startsWith('Preparé la planeación diagnóstica'), '1e. Conserva el resto del borrador tal cual Claude lo redactó, sin recortar contenido anterior al bloque de resumen')
  }

  // 2. Si no hay bloque de resumen (borrador incompleto / conflicto de
  //    fechas), se conserva el texto completo tal cual, sin romper.
  {
    const sinBloque = 'Explico el conflicto de fechas y pido el dato que falta.'
    verificar(extraerTextoCompletoBorrador(sinBloque) === sinBloque, '2. Sin bloque de resumen, el texto se devuelve intacto (nunca lanza, nunca corta de más)')
  }

  // ============================================================
  // 3. La ruta nueva de vista previa NUNCA persiste nada — mismo
  //    criterio que vista-previa-hoja/route.ts.
  // ============================================================
  {
    verificar(!rutaDocumento.includes('.insert(') && !rutaDocumento.includes('.update(') && !rutaDocumento.includes('.delete('), '3a. vista-previa-documento/route.ts no ejecuta ningún INSERT/UPDATE/DELETE')
    verificar(!rutaDocumento.includes('subirBuffer') && !rutaDocumento.includes('crearUrlFirmada') && !rutaDocumento.includes('.storage.'), '3b. vista-previa-documento/route.ts nunca sube nada a Supabase Storage')
    verificar(!rutaDocumento.includes('SERVICE_ROLE'), '3c. vista-previa-documento/route.ts nunca usa service_role')
    verificar(rutaDocumento.includes('autenticarRequestApi(token)'), '3d. La identidad se valida contra Supabase Auth con el token recibido, igual que el resto de C-005')
    verificar(rutaDocumento.includes("IDENTIFICADOR_VISTA_PREVIA = 'VISTA PREVIA — PENDIENTE DE APROBACIÓN'"), '3e. El documento provisional incluye discretamente "VISTA PREVIA — PENDIENTE DE APROBACIÓN"')
    verificar(rutaDocumento.includes('generarPdfBuffer'), '3f. Reutiliza el generador de PDF ya existente (generarPdfServidor.ts) — no crea un generador nuevo')
    verificar(rutaDocumento.includes("runtime = 'nodejs'"), '3g. Corre en runtime Node.js (igual que el resto de los endpoints reales)')
  }

  // ============================================================
  // 4. La compresión gzip+base64url usada para la URL es reversible
  //    (la misma técnica exacta que usan route.ts al construir la URL
  //    y vista-previa-documento/route.ts al leerla).
  // ============================================================
  {
    const original = { texto: BORRADOR_EJEMPLO, zonaHoraria: 'America/Mexico_City' }
    const comprimido = gzipSync(Buffer.from(JSON.stringify(original), 'utf-8')).toString('base64url')
    const recuperado = JSON.parse(gunzipSync(Buffer.from(comprimido, 'base64url')).toString('utf-8'))
    verificar(recuperado.texto === BORRADOR_EJEMPLO && recuperado.zonaHoraria === 'America/Mexico_City', '4a. La compresión gzip+base64url del texto completo es reversible sin pérdida')
    verificar(/^[A-Za-z0-9_-]+$/.test(comprimido), '4b. base64url no produce caracteres que necesiten codificarse de nuevo en la URL (sin "+"/"/"/"=")')
  }

  // ============================================================
  // 5. app/api/chat/route.ts adjunta EXACTAMENTE dos documentos en el
  //    mismo turno de borrador — planeación primero, hoja después —
  //    cada uno en su propio bloque independiente (una falla en uno
  //    nunca impide el otro).
  // ============================================================
  {
    const iPlaneacion = rutaChat.indexOf('vista-previa-documento?token=')
    const iHoja = rutaChat.indexOf('vista-previa-hoja?token=')
    verificar(iPlaneacion !== -1 && iHoja !== -1, '5a. route.ts construye una URL de vista previa para AMBOS documentos (planeación y hoja)')
    verificar(iPlaneacion < iHoja, '5b. El adjunto de la planeación se construye ANTES que el de la hoja (aparece primero en pantalla)')

    // Cada adjunto vive en su propio try/catch independiente — se
    // cuentan los bloques "if (esTurnoDeBorradorPlaneacion && sesion?.grupo_activo_id)"
    // en la zona de adjuntos (después del streaming), deben ser 2.
    const zonaAdjuntos = rutaChat.slice(rutaChat.indexOf('marcarTelemetria(\'claude:response_finished\')'), rutaChat.indexOf('} catch (err) {\n        // Ya se había empezado'))
    const bloques = (zonaAdjuntos.match(/if \(esTurnoDeBorradorPlaneacion && sesion\?\.grupo_activo_id\) \{/g) || []).length
    verificar(bloques === 2, '5c. Existen exactamente dos bloques independientes de adjunto (planeación y hoja) — una falla en uno no debe impedir el otro')
    verificar((zonaAdjuntos.match(/catch \(e\) \{/g) || []).length >= 2, '5d. Cada bloque de adjunto tiene su propio catch — un fallo en la vista previa nunca rompe la respuesta del borrador')
  }

  // ============================================================
  // 6. El pipeline de adjuntos soporta más de uno por turno sin
  //    romper el caso de un solo documento (Word/PDF/PPT/Excel,
  //    ficha_descriptiva...), que sigue usando exactamente el mismo
  //    campo `archivo`.
  // ============================================================
  {
    verificar(rutaTipos.includes('archivos?: ArchivoGeneradoInfo[]'), '6a. El tipo de mensaje admite varios archivos por turno (campo nuevo y aditivo)')
    verificar(rutaTipos.includes("archivo?: ArchivoGeneradoInfo; archivos?: ArchivoGeneradoInfo[]"), '6b. El evento respuesta-final expone tanto el archivo singular (compatibilidad) como el arreglo completo')

    verificar(/\[\[DOCUMENTO_ARCHIVO:\(\[\^\\\]\]\+\)\\\]\\\]\/g/.test(rutaMotor) || rutaMotor.includes('DOCUMENTO_ARCHIVO:([^\\]]+)\\]\\]/g'), '6c. motorTextoClaude.ts extrae TODOS los marcadores de archivo del mensaje (regex global), no solo el primero')
    verificar(rutaMotor.includes('while ((match = regex.exec(respuesta)) !== null)'), '6d. La extracción de marcadores recorre el texto completo en un bucle, nunca se detiene en el primer adjunto encontrado')
    verificar(rutaMotor.includes('return { texto, archivo: archivos[0], archivos }'), '6e. El primer archivo sigue viajando también en el campo singular `archivo`, para no romper ningún flujo existente de un solo documento')

    verificar(rutaPanel.includes('m.archivos && m.archivos.length > 0 ? m.archivos : m.archivo ? [m.archivo] : []'), '6f. AsistentePanel.tsx renderiza una tarjeta por cada adjunto del turno, sin dejar de soportar el caso de un solo archivo')
    verificar(rutaPanel.includes('key={`${m.id}-archivo-${idxArchivo}`}'), '6g. Cada tarjeta de adjunto tiene una key única y estable (evita advertencias de React y renders incorrectos con 2+ adjuntos)')
  }

  // ============================================================
  // 7. No se creó ningún módulo de Documentos separado, ni un
  //    generador de PDF nuevo, ni un componente de descarga nuevo —
  //    todo reutiliza infraestructura ya existente.
  // ============================================================
  {
    verificar(!rutaDocumento.includes('new PDFDocument') && !rutaDocumento.includes('pdf-lib'), '7a. vista-previa-documento/route.ts no reimplementa generación de PDF — delega en generarPdfBuffer')
    verificar(rutaPanel.includes('function TarjetaDescarga'), '7b. Sigue existiendo un único componente de tarjeta de descarga — no se creó una tarjeta paralela para la planeación')
    const definicionesTarjeta = (rutaPanel.match(/function TarjetaDescarga/g) || []).length
    verificar(definicionesTarjeta === 1, '7c. TarjetaDescarga sigue siendo un componente único (no se duplicó una variante "TarjetaPlaneacion")')
  }

  // ============================================================
  // 12. Ninguna tarjeta (planeación, hoja de evaluación o cualquier
  //     otro documento) ofrece conversión de formato — ver "CONTENCIÓN
  //     DEFINITIVA — retirar temporalmente Convertir de todas las
  //     tarjetas de documentos" y scripts/verificar-tarjetas-sin-conversion.ts,
  //     que cubre en detalle la retirada completa del menú (sin
  //     eliminar Descargar/Abrir/Compartir).
  // ============================================================
  {
    const iTarjeta = rutaPanel.indexOf('function TarjetaDescarga(')
    const iFinTarjeta = rutaPanel.indexOf('\n// Vista previa de solo lectura del documento activo', iTarjeta)
    const cuerpoTarjeta = rutaPanel.slice(iTarjeta, iFinTarjeta)
    const codigoRealTarjeta = cuerpoTarjeta.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    verificar(!codigoRealTarjeta.includes('Convertir'), '12a. Ninguna tarjeta (planeación, hoja de evaluación o cualquier otro documento) muestra el menú "Convertir"')
    verificar(!/Word|PDF como formato|PowerPoint|Excel como/.test(codigoRealTarjeta) && !cuerpoTarjeta.includes('onConvertir'), '12b. Ninguna tarjeta ofrece Word/PDF/PowerPoint/Excel como conversión — no queda ningún callback de conversión que reintroducir por accidente')
    verificar(cuerpoTarjeta.includes('⬇️ Descargar') && cuerpoTarjeta.includes('🔗 Abrir') && cuerpoTarjeta.includes('📤 Compartir'), '12b2. Descargar, Abrir y Compartir permanecen disponibles en la tarjeta')
    verificar(!codigoRealTarjeta.includes('sendMessage') && !codigoRealTarjeta.includes('handleSend') && !codigoRealTarjeta.includes('enviarMensaje'), '12b3. No existe ningún fallback conversacional (sendMessage/handleSend/enviarMensaje) dentro de la tarjeta')
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
